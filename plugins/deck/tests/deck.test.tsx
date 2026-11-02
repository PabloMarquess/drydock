import type { On, RenderPropsOf, TurnUsage, UiPane } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { type Costume, KIRO, SUB, TIER_COLOR } from '../hooks/art'
import { randomCostume } from '../hooks/costumes'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Deck',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

// The terminal draws text; the remote surfaces draw the same rows as SVG.
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
type Surface = (typeof SURFACES)[number]

type Usage = Omit<TurnUsage, 'model'>

// Costumes by type and model, as before random costumes became the default.
const FIXED = { options: { randomCostumes: false } }

const usage = (output: number, write = 1_000): Usage => ({
  input_tokens: 1_000,
  output_tokens: output,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: write,
})

// A last request of `n` tokens: all of it read from the cache.
const sized = (n: number): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: n,
  cache_creation_input_tokens: 0,
})

type Call = { tool: string; input: Record<string, unknown> }

type World = {
  panes: UiPane[]
  opens: number
  usage: Usage
  tools: number
  prompts: string[]
  logs: string[]
  /** A terminal under 144 columns: the deck's own first open waits undrawn. */
  isNarrow: boolean
  /** Every tool call that reached the engine, its input as it arrived. */
  calls: Call[]
  /** What the engine answers a tool call with. */
  answer: (call: Call) => unknown
  /** Holds every tool call until it resolves. */
  gate: Promise<void> | null
  /** A state key whose `$.state.set` fails for the plugin while set; `failOnCall` sets it as a tool runs. */
  failSet: string | null
  failOnCall: string | null
}

const ok = (stdout = 'ok') => ({ result: { stdout, stderr: '', interrupted: false }, text: stdout })

const engine = (on: On, world: World) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', (_$, e) => ({ text: `unhandled ${e.command}` }))
  on('tool.register', (_$, e) => {
    world.tools += 1
    return { value: { tool: e.name } }
  })
  on('agent.spawn', (_$, e) => {
    world.prompts.push(e.prompt)
    return { model: e.model ?? 'claude-opus-5-5', agentId: `a-${e.description.replace(/\p{Cc}/gu, '?')}` }
  })
  on('ui.open', (_$, e) => {
    world.opens += 1
    const isPlaced = !(world.isNarrow && world.opens === 1)
    world.panes = [
      ...world.panes.filter((p) => p.id !== e.id),
      { id: e.id, title: e.title ?? '', isShown: isPlaced, isFocused: false, isPlaced },
    ]
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.close', (_$, e) => {
    world.panes = world.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: world.panes }))
  on('ui.log', (_$, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* (_$, e) {
    const u: TurnUsage = { ...world.usage, model: e.model }
    yield { kind: 'text', index: 0, text: 'x' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: u }
    return { turnId: e.turnId, index: e.index, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: u }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('tool.call', async (_$, e) => {
    const call = { tool: String(e.tool), input: { ...(e as unknown as Record<string, unknown>) } }
    world.calls.push(call)
    if (world.failOnCall) world.failSet = world.failOnCall
    if (world.gate) await world.gate
    return world.answer(call) as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  // A `{ value: null }` answer makes the plugin's own `$.state` call fail, as a broken host would.
  on('state.set', (_$, e, next) => (world.failSet === e.key ? ({ value: null } as never) : next(e)))
}

const spawn = (
  $: Engine,
  description: string,
  extra: Partial<{ workflow: { runId: string; agentIndex: number }; subagentType: string; model: string }> = {},
) => $.agent.spawn({ prompt: 'p', description, subagentType: 'Explore', ...extra } as never)

const step = async ($: Engine, agentId: string | undefined, model = 'claude-opus-5-5') => {
  const s = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1, agentId })
  let n = await s.next()
  while (!n.done) n = await s.next()
}

const complete = ($: Engine, agentId: string, reason: 'answer' | 'error') =>
  $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', agentId, reason })

type Node = { type?: string; text: string; children: unknown[]; props?: Record<string, unknown> }
type Finder = { find: (q: { key: string }) => Promise<Node | undefined> }

const svgOf = async (ui: Finder, key: string) =>
  (await ui.find({ key }))?.children.find((c) => (c as Node).type === 'Svg') as
    | { props: { source: string; alt: string; height: number } }
    | undefined

const source = async (ui: Finder, key: string) => (await svgOf(ui, key))?.props.source ?? ''

// The header's tiles as [label, value].
const tiles = (svg: string): [string, string][] =>
  [...svg.matchAll(/<text class="s"[^>]*>([^<]*)<\/text>\n<text class="\w"[^>]*>([^<]*)<\/text>/g)].map((m) => [
    m[1] ?? '',
    m[2] ?? '',
  ])

// What a person reads: the text of a terminal Box, or the alt of a remote surface's drawing.
const text = async (ui: Finder, key: string) => {
  const found = await ui.find({ key })
  if (found === undefined || found.text !== '') return found?.text
  return (await svgOf(ui, key))?.props.alt ?? ''
}

const start = async ($: Engine, on: On, surface: Surface = 'terminal', isNarrow = false) => {
  const world: World = {
    panes: [],
    opens: 0,
    usage: usage(2_000),
    tools: 0,
    prompts: [],
    logs: [],
    isNarrow,
    calls: [],
    answer: () => ok(),
    gate: null,
    failSet: null,
    failOnCall: null,
  }
  const clock: MockClock = mock.clock(on, { now: 1_000_000 })
  engine(on, world)
  await $.session.start({ cwd: '/x', surface, isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'deck', surface, component: 'Pane', requestId: 'deck', props: PANE })
  const band = await $.ui.mount({ plugin: 'deck', surface, component: 'AbovePrompt', props: BAND })
  return { world, clock, ui, band }
}

const deck = ($: Engine, args: string) =>
  $.command.run({
    command: 'deck',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

describe('pane', () => {
  for (const surface of SURFACES) {
    const isDrawn = surface !== 'terminal'

    test(`${surface}: a row runs, spends and finishes`, async ($, on) => {
      const { clock, ui } = await start($, on, surface)
      expect(await text(ui, 'empty')).toContain('No agents yet')

      await spawn($, 'scan')
      await step($, 'a-scan')
      await clock.advance(65_000)
      const row = (await text(ui, 'a-scan')) ?? ''
      expect(row).toContain('scan')
      expect(row).toContain('Opus 5.5 · 1:05')
      expect(row).not.toContain('≈$')
      expect(row).not.toContain('memory')
      expect(row).not.toContain('tokens processed')
      if (isDrawn) {
        const drawn = await source(ui, 'a-scan')
        expect(drawn).toContain('>scan</text>')
        expect(drawn).toContain('>Opus 5.5</tspan>')
        expect(drawn).toContain('> · 1:05</tspan>')
        expect(drawn).not.toContain('≈$')
      }

      await complete($, 'a-scan', 'answer')
      expect(await text(ui, 'a-scan')).toContain(isDrawn ? 'scan: done' : '✓')
      expect(await text(ui, 'a-scan')).not.toContain('≈$')
      if (isDrawn) expect(await source(ui, 'a-scan')).not.toContain('≈$')
      expect(await text(ui, 'summary')).toBe('0 running · 1 finished')
      if (isDrawn) {
        expect(tiles(await source(ui, 'summary'))).toEqual([
          ['Running', '0'],
          ['Finished', '1'],
        ])
      }
    })

    test(`${surface}: a failed agent adds the Failed count, and only then`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await spawn($, 'one')
      await spawn($, 'two')
      await complete($, 'a-one', 'answer')
      expect(await text(ui, 'summary')).toBe('1 running · 1 finished')
      await complete($, 'a-two', 'error')
      expect(await text(ui, 'summary')).toBe('0 running · 1 finished · 1 failed')
      expect(await text(ui, 'a-two')).not.toContain('≈$')
      if (isDrawn) expect(await source(ui, 'a-two')).not.toContain('≈$')
      if (isDrawn) {
        expect(tiles(await source(ui, 'summary'))).toEqual([
          ['Running', '0'],
          ['Finished', '1'],
          ['Failed', '1'],
        ])
      }
    })

    test(`${surface}: each agent wears the costume of its type or model`, FIXED, async ($, on) => {
      const { ui } = await start($, on, surface)
      const cases: [string, string, string, Costume][] = [
        ['x1', 'Explore', 'claude-opus-5-5', 'explore'],
        ['x2', 'Plan', 'claude-opus-5-5', 'careful'],
        ['x3', 'general-purpose', 'claude-fable-5', 'fable'],
        ['x4', 'general-purpose', 'claude-mythos-5', 'fable'],
        ['x5', 'general-purpose', 'claude-opus-5-5', 'heavy'],
        ['x6', 'general-purpose', 'claude-sonnet-5-5', 'medium'],
        ['x7', 'general-purpose', 'claude-haiku-5-5', 'light'],
        ['x8', 'general-purpose', 'gpt-x', 'other'],
      ]
      for (const [name, subagentType, model] of cases) await spawn($, name, { subagentType, model })
      const colour = (c: Costume) => TIER_COLOR[c] ?? '#888780'
      if (isDrawn) {
        for (const [name, , , costume] of cases) {
          const drawn = await source(ui, `a-${name}`)
          expect(drawn, name).toContain(`<g class="c-${costume} run">`)
          expect(drawn, name).toContain(`<tspan fill="${colour(costume)}">`)
        }
      } else {
        const marks = await ui.findAll({ type: 'Text', text: '▣' })
        expect(marks.map((m) => m.props?.color)).toEqual(cases.map(([, , , c]) => colour(c)).reverse())
      }
    })

    test(`${surface}: only a running crab walks; done stands with ✓, failed is dimmed with ✗`, FIXED, async ($, on) => {
      const { ui } = await start($, on, surface)
      await spawn($, 'one', { subagentType: 'general-purpose' })
      await spawn($, 'two', { subagentType: 'general-purpose' })
      await spawn($, 'three', { subagentType: 'general-purpose' })
      await complete($, 'a-two', 'answer')
      await complete($, 'a-three', 'error')
      if (isDrawn) {
        const running = await source(ui, 'a-one')
        const done = await source(ui, 'a-two')
        const failed = await source(ui, 'a-three')
        expect(running).toContain('<g class="c-heavy run">')
        expect(running).toContain('class="live"')
        expect(done).toContain('<g class="c-heavy">')
        expect(done).not.toContain(' run"')
        expect(done).toContain('opacity="1"')
        expect(done).toContain('stroke="#3B9C5F"')
        expect(failed).toContain('<g class="c-heavy">')
        expect(failed).toContain('opacity="0.45"')
        expect(failed).toContain('stroke="#D0453F"')
        expect(await text(ui, 'a-three')).toContain('three: failed')
      } else {
        const glyph = async (g: string) => (await ui.find({ type: 'Text', text: g }))?.props?.color
        expect(await glyph('●')).toBe(TIER_COLOR.heavy)
        expect(await glyph('✓')).toBe('success')
        expect(await glyph('✗')).toBe('error')
        const marks = await ui.findAll({ type: 'Text', text: '▣' })
        expect(marks.map((m) => m.props?.dimColor)).toEqual([false, true, false])
      }
    })

    test(`${surface}: memory warns from 70% while the agent runs`, async ($, on) => {
      const { world, ui } = await start($, on, surface)
      await spawn($, 'big')
      world.usage = sized(690_000)
      await step($, 'a-big')
      expect(await text(ui, 'a-big')).not.toContain('memory')

      world.usage = sized(700_000)
      await step($, 'a-big')
      expect(await text(ui, 'a-big')).toContain('memory 70% · large and costly per call')
      if (isDrawn) {
        const drawn = await source(ui, 'a-big')
        expect(drawn).toContain('>memory 70% · large and costly per call</text>')
        expect(drawn).toContain('<text class="w"')
        expect(drawn).toContain('.w{fill:#a3540c}')
        expect((await svgOf(ui, 'a-big'))?.props.height).toBe(61)
      } else {
        expect((await ui.find({ type: 'Text', text: 'memory 70%' }))?.props?.color).toBe('warning')
      }

      await complete($, 'a-big', 'answer')
      expect(await text(ui, 'a-big')).not.toContain('memory')
    })

    test(`${surface}: /deck details adds type, workflow, requests, tokens processed and memory`, async ($, on) => {
      const { world, ui } = await start($, on, surface)
      await spawn($, 'scan', { workflow: { runId: 'wf_d854d9d3-008', agentIndex: 0 } })
      await step($, 'a-scan')
      const reply = (await deck($, 'details')) as { text: string }
      expect(reply.text).toBe(
        'Details on: the header adds cost and time, each row its type, workflow, cost, requests, tokens processed and memory.',
      )
      expect(world.logs.join('\n')).toContain("every request's whole prompt")
      expect(world.logs.join('\n')).toContain("the last request's size over the model's window")
      const row = (await text(ui, 'a-scan')) ?? ''
      expect(row).toContain('Explore · workflow wf_d854d')
      expect(row).toMatch(/≈\$\d+\.\d\d · 1 request · 14k tokens processed/)
      expect(row).toContain('memory 14k / 1M (1%)')
      expect(await text(ui, 'summary')).toMatch(/^1 running · 0 finished · Cost ≈\$\d+\.\d\d · Time \d+:\d\d$/)
      if (isDrawn) {
        const drawn = await source(ui, 'a-scan')
        expect(drawn).toContain('>Explore · workflow wf_d854d</text>')
        expect(drawn).toMatch(/>≈\$\d+\.\d\d · 1 request · 14k tokens processed<\/text>/)
        expect(drawn).toContain('>memory 14k / 1M (1%)</text>')
        expect((await svgOf(ui, 'a-scan'))?.props.height).toBe(91)
        expect(tiles(await source(ui, 'summary')).map(([label]) => label)).toEqual([
          'Running',
          'Finished',
          'Cost',
          'Time',
        ])
      } else expect(row).toContain('░ memory 14k')

      expect(await deck($, 'details')).toMatchObject({ text: 'Details off.' })
      expect(await text(ui, 'a-scan')).not.toContain('tokens processed')
      expect(await text(ui, 'a-scan')).not.toContain('≈$')
      expect(await source(ui, 'a-scan')).not.toContain('tokens processed')
      expect(await text(ui, 'summary')).toBe('1 running · 0 finished')
    })

    test(`${surface}: Time counts while any agent runs, once for parallel agents`, async ($, on) => {
      const { clock, ui } = await start($, on, surface)
      await spawn($, 'one')
      await spawn($, 'two')
      await clock.advance(60_000)
      await complete($, 'a-one', 'answer')
      await complete($, 'a-two', 'answer')
      await clock.advance(60_000)
      await spawn($, 'three')
      await clock.advance(30_000)
      await deck($, 'details')
      expect(await text(ui, 'summary')).toBe('1 running · 2 finished · Cost ≈$0.00 · Time 1:30')
      if (isDrawn) {
        expect(tiles(await source(ui, 'summary'))).toEqual([
          ['Running', '1'],
          ['Finished', '2'],
          ['Cost', '≈$0.00'],
          ['Time', '1:30'],
        ])
      }
    })

    test(`${surface}: an agent that runs again adds its new run, not the wait`, async ($, on) => {
      const { clock, ui } = await start($, on, surface)
      await spawn($, 'bg')
      await clock.advance(10_000)
      await complete($, 'a-bg', 'answer')
      await clock.advance(60_000)
      await step($, 'a-bg')
      await clock.advance(10_000)
      await deck($, 'details')
      expect(await text(ui, 'summary')).toBe('1 running · 0 finished · Cost ≈$0.05 · Time 0:20')
      expect(await text(ui, 'a-bg')).toContain('Opus 5.5 · 0:20')
      await complete($, 'a-bg', 'answer')
      await clock.advance(30_000)
      expect(await text(ui, 'summary')).toBe('0 running · 1 finished · Cost ≈$0.05 · Time 0:20')
    })

    test(`${surface}: control characters, bidi overrides and XML-forbidden characters are drawn as spaces`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await deck($, 'details')
      await spawn($, 'scan\u0001x\nnext\u202E\u009by\uFFFFz\uFFFE', { subagentType: 'Exp\tlo\uD800re' })
      const key = 'a-scan?x?next\u202E?y\uFFFFz\uFFFE'
      const row = (await text(ui, key)) ?? ''
      const drawn = isDrawn ? await source(ui, key) : ''
      expect(row).toContain('scan x next  y z')
      expect(row).toContain('Exp lo re')
      if (isDrawn) expect(drawn).toContain('>scan x next  y z</text>')
      for (const ch of ['\u0001', '\t', '\u009b', '\u202E', '\uFFFE', '\uFFFF', '\uD800']) {
        expect(row).not.toContain(ch)
        expect(drawn).not.toContain(ch)
      }
    })

    test(`${surface}: a description of control characters alone falls back to the agent type`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await spawn($, '\u0001\u0002\u0003', { subagentType: 'general-purpose' })
      const row = (await text(ui, 'a-???')) ?? ''
      expect(row).toContain('general-purpose')
      if (isDrawn) expect(await source(ui, 'a-???')).toContain('>general-purpose</text>')
    })

    test(`${surface}: descriptions are cut to 300 characters at spawn, and five long rows redraw within a second`, async ($, on) => {
      const { clock, ui } = await start($, on, surface)
      const long = (i: number) => `${i}${'long title '.repeat(400)}`
      for (let i = 0; i < 5; i++) await spawn($, long(i))
      const t0 = performance.now()
      await clock.advance(1_000)
      expect(await text(ui, 'summary')).toContain('5 running')
      expect(performance.now() - t0).toBeLessThan(1_000)
      const row = (await text(ui, `a-${long(0)}`)) ?? ''
      expect(row).toContain(`0${'long title '.repeat(27)}lo`)
      expect(row).not.toContain('long title '.repeat(28))
    })

    test(`${surface}: an unknown model's long id leaves room for the time; details price it as unknown`, async ($, on) => {
      const { ui } = await start($, on, surface)
      const model = 'arn:aws:bedrock:us-east-1:000000000000:application-inference-profile/abcd1234efgh'
      await spawn($, 'third', { subagentType: 'general-purpose', model })
      await step($, 'a-third', model)
      expect(await text(ui, 'a-third')).toContain('abcd1234efgh · 0:00')
      if (isDrawn) expect(await source(ui, 'a-third')).toContain('> · 0:00</tspan>')
      await deck($, 'details')
      expect(await text(ui, 'a-third')).toContain('≈$0.00+ · 1 request')
    })

    test(`${surface}: past 30 rows the oldest wait behind a count`, async ($, on) => {
      const { ui } = await start($, on, surface)
      for (let i = 0; i < 35; i++) await spawn($, `n${i}`)
      expect(await text(ui, 'summary')).toContain('35 running')
      expect(await text(ui, 'a-n34')).toContain('n34')
      expect(await text(ui, 'a-n5')).toContain('n5')
      expect(await text(ui, 'a-n4')).toBeUndefined()
      expect(await text(ui, 'more')).toBe('5 more agents not shown')
      if (isDrawn) expect(await ui.findAll({ type: 'Svg' })).toHaveLength(32)
    })
  }

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    test(`${surface}: the rows lie over the dotted grid, as tall as what is drawn`, async ($, on) => {
      const { ui } = await start($, on, surface)
      const grid = async () =>
        (await ui.findAll({ type: 'Svg' })).filter((s) => s.props?.alt === 'dotted grid').map((s) => s.props?.height)
      expect(await grid()).toEqual([44 + 24])
      await spawn($, 'one')
      await spawn($, 'two')
      await complete($, 'a-one', 'answer')
      expect(await grid()).toEqual([44 + 24 + 46 + 46])
      const tile = (await ui.findAll({ type: 'Svg' })).find((s) => s.props?.alt === 'dotted grid')
      expect(String(tile?.props?.source)).toContain('<pattern id="g" width="16" height="16"')
    })
  }

  test('desktop: a long title is cut to the row and escaped', async ($, on) => {
    const { ui } = await start($, on, 'desktop')
    await spawn($, `<b>${'x'.repeat(300)}`)
    const drawn = await source(ui, `a-<b>${'x'.repeat(300)}`)
    expect(drawn).toContain('&lt;b&gt;')
    expect(drawn).toContain('…</text>')
    expect(drawn).not.toContain('<b>')
  })

  test('desktop: < > & " in titles and types are escaped', async ($, on) => {
    const { ui } = await start($, on, 'desktop')
    await deck($, 'details')
    await spawn($, 'R&D "fast" <x>', { subagentType: 'a<b>&"c"' })
    const svg = await svgOf(ui, 'a-R&D "fast" <x>')
    expect(svg?.props.source).toContain('R&amp;D &quot;fast&quot; &lt;x&gt;')
    expect(svg?.props.source).toContain('a&lt;b&gt;&amp;&quot;c&quot;')
    expect(svg?.props.source).not.toContain('<x>')
    expect(svg?.props.alt).toContain('R&D "fast" <x>: running')
  })

  test('desktop: a wide CJK title is cut before the status mark', async ($, on) => {
    const { ui } = await start($, on, 'desktop')
    const title = '漢'.repeat(60)
    await spawn($, title)
    const drawn = (await source(ui, `a-${title}`)).match(/>(漢+)…<\/text>/)?.[1] ?? ''
    expect(drawn.length).toBeGreaterThan(20)
    expect(drawn.length).toBeLessThan(60)
  })

  test('failed runs, workflow agents and running-first order', async ($, on) => {
    const { ui } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two', { workflow: { runId: 'wf_d854d9d3-008', agentIndex: 0 } })
    await complete($, 'a-one', 'error')
    expect(await text(ui, 'a-one')).toContain('✗')
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('a-two')).toBeLessThan(drawn.indexOf('a-one'))
  })

  test('main thread and unknown agents are ignored', async ($, on) => {
    const { ui, band } = await start($, on)
    await spawn($, 'scan')
    await complete($, 'a-scan', 'answer')
    await step($, undefined)
    await step($, 'fork-123')
    await complete($, 'fork-123', 'answer')
    expect(await text(ui, 'a-scan')).toContain('✓')
    expect(await text(ui, 'summary')).toBe('0 running · 1 finished')
    expect(await text(ui, 'fork-123')).toBeUndefined()
    expect(await text(band, 'band')).toBeUndefined()
  })

  test('a finished background agent runs again on a new request', async ($, on) => {
    const { ui, band } = await start($, on)
    await spawn($, 'scan')
    await complete($, 'a-scan', 'answer')
    await step($, 'a-scan')
    expect(await text(ui, 'a-scan')).toContain('●')
    expect(await text(band, 'band')).toContain('0/1')
  })

  test('past 200 rows the oldest finished go first; a running agent keeps its row and its place in the band', async ($, on) => {
    const { clock, ui, band } = await start($, on)
    await spawn($, 'bg')
    await complete($, 'a-bg', 'answer')
    for (let i = 0; i < 199; i++) {
      await spawn($, `o${i}`)
      await complete($, `a-o${i}`, 'answer')
    }
    await step($, 'a-bg')
    expect(await text(band, 'band')).toContain('0/1')
    await spawn($, 'y')
    expect(await text(band, 'band')).toContain('0/2')
    const status = (await deck($, '')) as { text: string }
    expect(status.text).toContain('2 running · 198 finished')
    await complete($, 'a-bg', 'answer')
    expect(await text(band, 'band')).toContain('1/2')
    await complete($, 'a-y', 'answer')
    await clock.advance(60_000)
    expect(await text(band, 'band')).toBeUndefined()
    expect(await text(ui, 'summary')).toContain('0 running · 200 finished')
  })

  test('autoOpen false never opens by itself', { options: { autoOpen: false } }, async ($, on) => {
    const { world } = await start($, on)
    await spawn($, 'one')
    expect(world.opens).toBe(0)
  })

  for (const surface of SURFACES) {
    test(`${surface}: the clear button keeps running agents`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await spawn($, 'one')
      await spawn($, 'two')
      await complete($, 'a-one', 'answer')
      await ui.press({ key: 'clear' })
      expect(await text(ui, 'a-one')).toBeUndefined()
      expect(await text(ui, 'a-two')).toContain('two')
      expect(await ui.find({ key: 'clear' })).toBeUndefined()
    })
  }

  test('/clear empties the deck and the band', async ($, on) => {
    const { ui, band } = await start($, on)
    await spawn($, 'one')
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
    expect(await text(ui, 'a-one')).toBeUndefined()
    expect(await text(band, 'band')).toBeUndefined()
  })

  for (const [ttl, expected] of [
    ['5m', '≈$5.05'],
    ['1h', '≈$8.05'],
  ] as const) {
    test(
      `${ttl} cache writes follow the subagentCacheTtl option`,
      { options: { subagentCacheTtl: ttl } },
      async ($, on) => {
        const { world, ui } = await start($, on)
        world.usage = usage(2_000, 1_000_000)
        await spawn($, 'scan')
        await step($, 'a-scan')
        await deck($, 'details')
        expect(await text(ui, 'a-scan')).toContain(expected)
      },
    )
  }

  test('no tool is registered and the agent prompt is passed on untouched', async ($, on) => {
    const { world } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two', { subagentType: 'Plan' })
    await step($, 'a-one')
    expect(world.tools).toBe(0)
    expect(world.prompts).toEqual(['p', 'p'])
  })
})

describe('band', () => {
  for (const surface of SURFACES) {
    const isDrawn = surface !== 'terminal'

    test(`${surface}: the bar fills as the batch finishes`, async ($, on) => {
      const { band } = await start($, on, surface)
      expect(await text(band, 'band')).toBeUndefined()

      await spawn($, 'one')
      await spawn($, 'two')
      await step($, 'a-one')
      expect(await text(band, 'band')).toContain('0/2')

      await complete($, 'a-one', 'answer')
      const shown = (await text(band, 'band')) ?? ''
      expect(shown).toContain('1/2')
      expect(shown).toContain('50%')
      if (isDrawn) {
        expect(shown).toBe('Agents 1/2 · 50% · 1 running')
        const drawn = await source(band, 'band')
        expect(drawn).toContain('>Agents</text>')
        expect(drawn).toContain('<g fill="#8f8cf4"><rect class="t')
        expect(drawn).toContain('<g fill="#8f8cf4" opacity="0.45"><rect class="t')
        expect(drawn).toContain('>1/2</text>')
        expect(drawn).toContain('>50%</text>')
        expect(drawn).toContain('<g class="c-other run">')
        expect(drawn).toContain('@keyframes tw')
      } else {
        expect(shown).toMatch(/^●Agents█+░+1\/250%▣$/)
        expect(shown.match(/[█░]/g)).toHaveLength(40)
        expect(await band.find({ type: 'Svg' })).toBeUndefined()
      }

      await complete($, 'a-two', 'error')
      expect(await text(band, 'band')).toBeUndefined()
    })

    test(`${surface}: agents that start at the same moment join one batch`, async ($, on) => {
      const { band } = await start($, on, surface)
      await Promise.all([spawn($, 'p1'), spawn($, 'p2'), spawn($, 'p3')])
      expect(await text(band, 'band')).toContain('0/3')
      await complete($, 'a-p3', 'answer')
      expect(await text(band, 'band')).toContain('1/3')
      await complete($, 'a-p1', 'answer')
      expect(await text(band, 'band')).toContain('2/3')
      await complete($, 'a-p2', 'answer')
      expect(await text(band, 'band')).toBeUndefined()
    })

    test(`${surface}: a failed agent counts as finished while the batch runs`, async ($, on) => {
      const { band } = await start($, on, surface)
      await spawn($, 'one')
      await spawn($, 'two')
      await spawn($, 'three')
      await complete($, 'a-one', 'answer')
      await complete($, 'a-two', 'error')
      expect(await text(band, 'band')).toContain('2/3')
      expect(await text(band, 'band')).toContain('67%')
    })

    for (const how of ['command', 'button'] as const) {
      test(`${surface}: clearing by ${how} mid-batch keeps the cleared agents in the band`, async ($, on) => {
        const { ui, band } = await start($, on, surface)
        await spawn($, 'one')
        await spawn($, 'two')
        await spawn($, 'three')
        await step($, 'a-one')
        await complete($, 'a-one', 'error')
        await complete($, 'a-two', 'answer')
        const before = await text(band, 'band')
        expect(before).toContain('2/3')
        const drawnBefore = isDrawn ? await source(band, 'band') : ''
        if (how === 'command') await deck($, 'clear')
        else await ui.press({ key: 'clear' })
        expect(await text(ui, 'a-one')).toBeUndefined()
        expect(await text(ui, 'a-two')).toBeUndefined()
        expect(await text(band, 'band')).toBe(before)
        if (isDrawn) expect(await source(band, 'band')).toBe(drawnBefore)
      })
    }

    test(`${surface}: the Deck button toggles the pane`, async ($, on) => {
      const { world, band } = await start($, on, surface)
      await spawn($, 'one')
      expect(world.panes).toHaveLength(1)
      await band.press({ key: 'deck' })
      expect(world.panes).toHaveLength(0)
      await band.press({ key: 'deck' })
      expect(world.panes).toHaveLength(1)
    })

    test(`${surface}: × hides the band for this batch only; /deck band toggles it for the session`, async ($, on) => {
      const { band } = await start($, on, surface)
      await spawn($, 'one')
      await band.press({ key: 'hide' })
      expect(await text(band, 'band')).toBeUndefined()
      expect(await deck($, '')).toMatchObject({ text: expect.stringContaining('band dismissed for this batch') })
      await spawn($, 'two')
      expect(await text(band, 'band')).toBeUndefined()
      await complete($, 'a-one', 'answer')
      await complete($, 'a-two', 'answer')
      await spawn($, 'three')
      expect(await text(band, 'band')).toContain('0/1')

      await band.press({ key: 'hide' })
      expect(await deck($, 'band')).toMatchObject({ text: 'Band shown.' })
      expect(await text(band, 'band')).toContain('0/1')
      expect(await deck($, 'band')).toMatchObject({ text: 'Band hidden.' })
      expect(await text(band, 'band')).toBeUndefined()
      await complete($, 'a-three', 'answer')
      await spawn($, 'four')
      expect(await text(band, 'band')).toBeUndefined()
      expect(await deck($, 'band')).toMatchObject({ text: 'Band shown.' })
      expect(await text(band, 'band')).toContain('0/1')
    })
  }

  test('a new batch starts when an agent starts with none running', async ($, on) => {
    const { band } = await start($, on)
    await spawn($, 'one')
    await complete($, 'a-one', 'answer')
    await spawn($, 'two')
    expect(await text(band, 'band')).toContain('0/1')
    await spawn($, 'three')
    expect(await text(band, 'band')).toContain('0/2')
  })

  test('a batch of more than 200 agents keeps counting them all', async ($, on) => {
    const { band } = await start($, on)
    await spawn($, 'keep')
    for (let i = 0; i < 250; i++) {
      await spawn($, `o${i}`)
      await complete($, `a-o${i}`, 'answer')
    }
    expect(await text(band, 'band')).toContain('250/251')
    await complete($, 'a-keep', 'answer')
    expect(await text(band, 'band')).toBeUndefined()
  })

  test('a survey takes the band', async ($, on) => {
    await start($, on)
    await spawn($, 'one')
    const survey = await $.ui.mount({
      plugin: 'deck',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...BAND, hasSurvey: true },
    })
    expect(await text(survey, 'band')).toBeUndefined()
  })
})

describe('/deck', () => {
  test('off closes the pane, hides the band and keeps the pane closed for the session; on brings both back', async ($, on) => {
    const { world, band } = await start($, on)
    await spawn($, 'one')
    expect(world.panes.map((p) => p.id)).toContain('deck')
    expect(await text(band, 'band')).toContain('0/1')

    expect(await deck($, 'off')).toMatchObject({ text: 'Deck off for this session: pane closed, band hidden.' })
    expect(world.panes.map((p) => p.id)).not.toContain('deck')
    expect(await text(band, 'band')).toBeUndefined()
    const opens = world.opens
    await spawn($, 'two')
    expect(world.opens).toBe(opens)
    expect(await text(band, 'band')).toBeUndefined()
    expect(((await deck($, '')) as { text: string }).text).toContain('Pane closed, band hidden')

    expect(await deck($, 'ON')).toMatchObject({ text: 'Deck on.' })
    expect(world.panes.map((p) => p.id)).toContain('deck')
    expect(await text(band, 'band')).toContain('0/2')
  })

  test('no argument shows the status on one line; what the numbers mean is a notice', async ($, on) => {
    const { clock, world } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two')
    await clock.advance(5_000)
    await complete($, 'a-one', 'error')
    const reply = (await deck($, '')) as { text: string }
    expect(reply.text).toBe(
      '1 running · 0 finished · 1 failed · ≈$0.00 · 0:05 agent time. Pane open, band on, details off, tasks on.',
    )
    expect(world.logs).toHaveLength(1)
    expect(world.logs[0]).toContain('Agent time is how long at least one listed agent or Kiro run was running')
  })

  test('the memory warning and the details explain themselves in notices, never in the model-read text', async ($, on) => {
    const { world } = await start($, on)
    await spawn($, 'big')
    world.usage = sized(800_000)
    await step($, 'a-big')
    await deck($, 'details')
    world.logs = []
    const reply = (await deck($, '')) as { text: string }
    expect(reply.text).toContain('details on')
    expect(reply.text).toContain('1 running agent is at 70% memory or more.')
    expect(reply.text).not.toContain('\n')
    expect(reply.text).not.toContain('stop it')
    const notes = world.logs.join('\n')
    expect(notes).toContain("Tokens processed adds up every request's whole prompt")
    expect(notes).toContain('stop it and split the work')
  })

  test('pane opens once on the first agent and toggles', async ($, on) => {
    const { world } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two')
    expect(world.opens).toBe(1)
    expect(await deck($, 'pane')).toMatchObject({ text: 'Deck closed.' })
    expect(await deck($, '')).toMatchObject({ text: expect.stringContaining('Pane closed') })
    expect(await deck($, 'pane')).toMatchObject({ text: 'Deck opened.' })
  })

  test('on a narrow terminal the waiting pane is reported, and the first press shows it', async ($, on) => {
    const { world, band } = await start($, on, 'terminal', true)
    await spawn($, 'one')
    expect(world.panes).toMatchObject([{ id: 'deck', isPlaced: false }])
    expect(await deck($, '')).toMatchObject({ text: expect.stringContaining('Pane waiting for room') })
    await band.press({ key: 'deck' })
    expect(world.panes).toMatchObject([{ id: 'deck', isPlaced: true }])
    expect(await deck($, '')).toMatchObject({ text: expect.stringContaining('Pane open') })
  })

  test('clear drops finished agents', async ($, on) => {
    const { ui } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two')
    await complete($, 'a-one', 'answer')
    expect(await deck($, 'clear')).toMatchObject({ text: 'Finished and failed agents cleared.' })
    expect(await text(ui, 'a-one')).toBeUndefined()
    expect(await text(ui, 'a-two')).toContain('two')
  })

  test('an unknown argument shows the usage', async ($, on) => {
    await start($, on)
    expect(await deck($, 'nope')).toMatchObject({
      text: 'Usage: /deck [on|off|pane|band|details|clear|costume|tasks|help]. /deck help lists each in a notice.',
    })
  })

  test('help lists every control, and costume help lists costumes and targets, in notices the model never reads', async ($, on) => {
    const { world } = await start($, on)
    expect(await deck($, 'help')).toEqual({ text: 'The /deck controls are listed in a notice.' })
    const help = world.logs.join('\n')
    for (const word of [
      '/deck on | off',
      '/deck pane',
      '/deck details',
      '/deck clear',
      '/deck costume',
      '/deck costume random on | off',
      '/deck tasks on | off',
    ]) {
      expect(help).toContain(word)
    }
    world.logs = []
    const wearing = 'Wearing: a random costume per agent. Random costumes on (the randomCostumes option).'
    expect(await deck($, 'costume help')).toEqual({ text: wearing })
    const costumes = world.logs.join('\n')
    expect(costumes).toContain('Background tasks are submarines and wear no costume.')
    expect(costumes).toContain('astronaut, detective, engineer, chef, racer, pirate, crab')
    expect(costumes).toContain('explore, plan, fable, opus, sonnet, haiku')
    expect(await deck($, 'costume')).toEqual({ text: wearing })
    for (const arg of ['', 'help', 'costume', 'costume help', 'costume zzz', 'tasks', 'nope']) {
      const reply = ((await deck($, arg)) as { text: string }).text
      expect(reply, arg).not.toContain('\n')
      expect(reply.length, arg).toBeLessThan(160)
    }
  })

  for (const surface of SURFACES) {
    test(
      `${surface}: /deck astronaut dresses every agent, a target wins over all, reset goes back`,
      FIXED,
      async ($, on) => {
        const { ui } = await start($, on, surface)
        await spawn($, 'scan')
        await spawn($, 'plan', { subagentType: 'Plan' })
        const look = async (key: string) =>
          surface === 'terminal' ? ((await text(ui, key)) ?? '') : await source(ui, key)
        expect(await look('a-scan')).toContain(surface === 'terminal' ? 'Opus' : 'c-explore')

        expect(await deck($, 'Astronaut')).toMatchObject({ text: 'Wearing: all astronaut.' })
        if (surface !== 'terminal') {
          expect(await look('a-scan')).toContain('c-fable')
          expect(await look('a-plan')).toContain('c-fable')
        }
        expect(await deck($, 'costume plan pirate')).toMatchObject({ text: 'Wearing: all astronaut, plan pirate.' })
        if (surface !== 'terminal') {
          expect(await look('a-plan')).toContain('c-explore')
          expect(await look('a-scan')).toContain('c-fable')
        }
        expect(await deck($, 'costume reset')).toMatchObject({
          text: 'Costumes back to the default (by type, then model).',
        })
        if (surface !== 'terminal') {
          expect(await look('a-scan')).toContain('c-explore')
          expect(await look('a-plan')).toContain('c-careful')
        }
      },
    )
  }

  test('an unknown costume or target answers with the costume help', async ($, on) => {
    const { world } = await start($, on)
    const reply = ((await deck($, 'costume opus wizard')) as { text: string }).text
    expect(reply).toBe('Unknown costume or target; the costumes and targets are listed in a notice.')
    expect(world.logs.join('\n')).toContain('Costumes: astronaut')
  })

  test(
    'the costumes option dresses every session; a session choice wins over it',
    { options: { costumes: 'opus=racer', randomCostumes: false } },
    async ($, on) => {
      const { ui } = await start($, on, 'desktop')
      await spawn($, 'one', { subagentType: 'general-purpose' })
      expect(await source(ui, 'a-one')).toContain('c-light')
      await deck($, 'opus chef')
      expect(await source(ui, 'a-one')).toContain('c-medium')
      expect(await deck($, 'costume reset')).toMatchObject({ text: 'Costumes back to opus racer.' })
      expect(await source(ui, 'a-one')).toContain('c-light')
    },
  )
})

// Fake key, built from parts: shaped like a real one for the redactor, never one a scanner takes for real.
const FAKE_KEY = ['AKIA', 'FAKEFAKEFAKE0000'].join('')
const ESC = String.fromCharCode(27)

const KIRO_CMD =
  'cd /srv/coleta && timeout 900 kiro-cli chat --agent coleta-aws --model claude-opus-5.5 --effort max --no-interactive "Collect the AWS inventory for us-east-1"'
const KIRO_TITLE = 'Collect the AWS inventory for us-east-1'

const bash = ($: Engine, command: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Bash', command, ...extra } as never)

// The id of the latest tool call that reached the engine: a Kiro row is `kiro-<id>`, a task's `task-<id>`.
const callId = (world: World) => String(world.calls.at(-1)?.input.tool_use_id)

const backgrounded = (id: string, extra: Record<string, unknown> = {}) => ({
  result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id, ...extra },
  text: `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output`,
})

const failedWith = (code: number) => ({
  isError: true,
  result: `Exit code ${code}\nerror: not logged in`,
  text: `Exit code ${code}\nerror: not logged in`,
})

const envelope = (fields: Record<string, string>) =>
  `<task-notification>\n${Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('\n')}\n</task-notification>\nRead the output file to retrieve the result.`

let appended = 0
// A background task's notification as the engine stores it in the conversation that owns the task.
const notify = ($: Engine, fields: Record<string, string>, agentId?: string) =>
  $.session.append({
    message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: envelope(fields) }] },
    door: 'prompt',
    origin: { kind: 'task-notification' },
    uuid: `row-${++appended}`,
    ...(agentId === undefined ? {} : { agentId }),
  } as never)

const notifyByPrompt = ($: Engine, fields: Record<string, string>) =>
  $.prompt.submit({ text: envelope(fields), origin: { kind: 'task-notification' }, wait: false } as never)

const drawnText = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

const colourOf = (c: Costume) => TIER_COLOR[c] ?? '#888780'

const relay = ($: Engine, text: string, kind: string) =>
  $.prompt.submit({ text, origin: { kind }, wait: false } as never)

describe('kiro', () => {
  for (const surface of SURFACES) {
    const isDrawn = surface !== 'terminal'

    test(`${surface}: a kiro-cli chat is a Kiro row: the task's words, Kiro · model, then done with its usage`, async ($, on) => {
      const { world, clock, ui } = await start($, on, surface)
      let release = () => {}
      world.gate = new Promise((resolve) => {
        release = resolve
      })
      world.answer = () => ok(`inventory written\n${ESC}[38;5;8m\n ▸ Credits: 0.63 • Time: 3s\n\n${ESC}[0m`)
      const pending = bash($, KIRO_CMD)
      await clock.settle()
      const key = `kiro-${callId(world)}`
      await clock.advance(5_000)
      const running = (await text(ui, key)) ?? ''
      expect(running).toContain(KIRO_TITLE)
      expect(running).toContain('Kiro · claude-opus-5.5 · 0:05')
      if (isDrawn) expect(await source(ui, key)).toMatch(/<g class="c-\w+ ghost run">/)
      expect(await text(ui, 'summary')).toBe('1 running · 0 finished')

      release()
      await pending
      expect(await text(ui, key)).toContain(isDrawn ? `${KIRO_TITLE}: done` : '✓')
      if (isDrawn) expect(await source(ui, key)).toMatch(/<g class="c-\w+ ghost">/)
      await deck($, 'details')
      const details = (await text(ui, key)) ?? ''
      expect(details).toContain('Kiro · agent coleta-aws · effort max')
      expect(details).toContain('unpriced: Kiro bills its own credits · 0.63 credits · Kiro time 3s')
      expect(details).not.toContain('memory')
      expect(await text(ui, 'summary')).toBe('0 running · 1 finished · Cost ≈$0.00+ · Time 0:05')
      const drawn = await drawnText(ui)
      for (const part of ['kiro-cli', '--no-interactive', 'timeout 900', 'inventory written']) {
        expect(drawn).not.toContain(part)
      }
    })

    test(`${surface}: a kiro-cli that fails is a failed row with its exit code`, async ($, on) => {
      const { world, ui } = await start($, on, surface)
      world.answer = () => failedWith(2)
      await bash($, KIRO_CMD)
      const key = `kiro-${callId(world)}`
      expect(await text(ui, key)).toContain('Kiro · claude-opus-5.5 · exit 2 · 0:00')
      expect(await text(ui, key)).toContain(isDrawn ? `${KIRO_TITLE}: failed` : '✗')
      expect(await text(ui, 'summary')).toBe('0 running · 0 finished · 1 failed')
      if (isDrawn) expect(await source(ui, key)).toContain('opacity="0.45"')
    })

    test(`${surface}: a kiro-cli in the background runs until its notification, which ends it`, async ($, on) => {
      const { world, clock, ui, band } = await start($, on, surface)
      world.answer = () => backgrounded('bk1')
      await bash($, KIRO_CMD, { run_in_background: true })
      const id = callId(world)
      const key = `kiro-${id}`
      await clock.advance(90_000)
      expect(await text(ui, key)).toContain('Kiro · claude-opus-5.5 · in background · 1:30')
      expect(await text(band, 'band')).toContain('0/1')
      await notify($, { 'task-id': 'bk1', summary: 'Background command "Collect" is still running after 1m' })
      expect(await text(ui, key)).toContain('in background')
      await notify($, {
        'task-id': 'bk1',
        'tool-use-id': id,
        status: 'completed',
        summary: 'Background command "Collect" completed (exit code 0)',
      })
      expect(await text(ui, key)).toContain(isDrawn ? `${KIRO_TITLE}: done` : '✓')
      expect(await text(ui, key)).toContain('Kiro · claude-opus-5.5 · 1:30')
      expect(await text(band, 'band')).toBeUndefined()
      expect(await text(ui, `task-${id}`)).toBeUndefined()
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(
      `${surface}: with no costume a Kiro row is the plain ghost in purple; a costume brings its colour`,
      FIXED,
      async ($, on) => {
        const { world, ui } = await start($, on, surface)
        world.answer = () => backgrounded('bk9')
        await bash($, KIRO_CMD, { run_in_background: true })
        const key = `kiro-${callId(world)}`
        if (surface === 'desktop') {
          const drawn = await source(ui, key)
          expect(drawn).toContain('<g class="c-other ghost run">')
          expect(drawn).toContain('<tspan class="kv">Kiro · claude-opus-5.5</tspan>')
          expect(drawn).toContain(`<circle class="live" cx="784" cy="16" r="3.5" fill="${KIRO.body}"/>`)
        } else {
          expect((await ui.find({ type: 'Text', text: '▣' }))?.props?.color).toBe(KIRO.body)
          expect((await ui.find({ type: 'Text', text: '●' }))?.props?.color).toBe(KIRO.body)
          expect((await ui.find({ type: 'Text', text: 'Kiro · claude-opus-5.5' }))?.props?.color).toBe('merged')
        }
        await deck($, 'costume kiro chef')
        if (surface === 'desktop') {
          expect(await source(ui, key)).toContain('<g class="c-medium ghost run">')
          expect(await source(ui, key)).toContain(`<tspan fill="${TIER_COLOR.medium}">Kiro · claude-opus-5.5</tspan>`)
        } else {
          expect((await ui.find({ type: 'Text', text: '▣' }))?.props?.color).toBe(TIER_COLOR.medium)
          expect((await ui.find({ type: 'Text', text: 'Kiro · claude-opus-5.5' }))?.props?.color).toBe(
            TIER_COLOR.medium,
          )
        }
      },
    )
  }

  test('a notification that comes as a prompt ends the row too, failed with its exit code', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('bk2')
    await bash($, KIRO_CMD, { run_in_background: true })
    const key = `kiro-${callId(world)}`
    await notifyByPrompt($, {
      'task-id': 'bk2',
      status: 'failed',
      summary: 'Background command "Collect" failed with exit code 3',
    })
    expect(await text(ui, key)).toContain('Kiro · claude-opus-5.5 · exit 3 · 0:00')
    expect(await text(ui, key)).toContain('✗')
  })

  test('GetTask on a finished run ends its row, with the usage in its output; TaskStop stops one', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('bk3')
    await bash($, KIRO_CMD, { run_in_background: true })
    const first = `kiro-${callId(world)}`
    world.answer = () => backgrounded('bk4')
    await bash($, KIRO_CMD, { run_in_background: true })
    const second = `kiro-${callId(world)}`
    const task = (status: string, extra: Record<string, unknown> = {}) => ({
      result: { taskId: 'bk3', status, statusMessage: 'x', createdAt: 'a', lastUpdatedAt: 'b', ...extra },
      text: 'x',
    })
    world.answer = () => task('working')
    await $.tool.call({ tool: 'GetTask', taskId: 'bk3' } as never)
    expect(await text(ui, first)).toContain('●')
    world.answer = () =>
      task('completed', {
        statusMessage: 'Exited with code 0. Full output: /tmp/tasks/bk3.output',
        result: { content: [{ type: 'text', text: 'done\n ▸ Credits: 2.5 • Time: 1m 4s' }], isError: false },
      })
    await $.tool.call({ tool: 'GetTask', taskId: 'bk3' } as never)
    expect(await text(ui, first)).toContain('✓')
    await deck($, 'details')
    expect(await text(ui, first)).toContain('2.5 credits · Kiro time 1m 4s')
    expect(await text(ui, second)).toContain('●')
    world.answer = () => ({ result: { message: 'Stopped', task_id: 'bk4' }, text: 'Stopped' })
    await $.tool.call({ tool: 'TaskStop', task_id: 'bk4' } as never)
    expect(await text(ui, second)).toContain('stopped')
    expect(await text(ui, second)).toContain('✗')
  })

  test("a subagent's run that ends with the subagent's final answer ends with it", async ($, on) => {
    const { world, ui } = await start($, on)
    await spawn($, 'sub')
    world.answer = () => backgrounded('bk5', { backgroundEndsWithFinalResponse: true })
    await bash($, KIRO_CMD, { run_in_background: true, agentId: 'a-sub' })
    const key = `kiro-${callId(world)}`
    await complete($, 'a-other', 'answer')
    expect(await text(ui, key)).toContain('in background')
    await complete($, 'a-sub', 'answer')
    expect(await text(ui, key)).toContain('Kiro · claude-opus-5.5 · stopped with its agent')
    expect(await text(ui, 'summary')).toBe('0 running · 1 finished · 1 failed')
  })

  test(
    'a background run whose end never arrives closes after six hours, neither done nor failed',
    { timeoutMs: 120_000 },
    async ($, on) => {
      const { world, clock, ui, band } = await start($, on)
      world.answer = () => backgrounded('bk6')
      await bash($, KIRO_CMD, { run_in_background: true })
      const key = `kiro-${callId(world)}`
      expect(await text(band, 'band')).toContain('0/1')
      // The deck's clock ticks each second: the six hours go by in steps the mock clock takes, with no
      // drawing to redraw on each tick.
      await ui.unmount()
      await band.unmount()
      for (let h = 0; h < 6; h++) await clock.advance(60 * 60 * 1000 - (h === 5 ? 2_000 : 0))
      const pane = () =>
        $.ui.mount({ plugin: 'deck', surface: 'terminal', component: 'Pane', requestId: 'deck', props: PANE })
      let mounted = await pane()
      expect(await text(mounted, key)).toContain('●')
      await mounted.unmount()
      await clock.advance(3_000)
      mounted = await pane()
      expect(await text(mounted, key)).toContain('end not seen in 6h')
      expect(await text(mounted, key)).toContain('○')
      expect(await text(mounted, key)).not.toContain('✗')
      expect(await text(mounted, 'summary')).toBe('0 running · 1 finished')
      const after = await $.ui.mount({ plugin: 'deck', surface: 'terminal', component: 'AbovePrompt', props: BAND })
      expect(await text(after, 'band')).toBeUndefined()
    },
  )

  test('Kiro runs and tasks count in the band beside the agents', async ($, on) => {
    const { world, band } = await start($, on)
    await spawn($, 'one')
    world.answer = () => backgrounded('bk7')
    await bash($, KIRO_CMD, { run_in_background: true })
    world.answer = () => backgrounded('bt7')
    await bash($, 'node scripts/recollect.mjs', { run_in_background: true, description: 'Re-collect' })
    expect(await text(band, 'band')).toContain('0/3')
    await notify($, { 'task-id': 'bt7', status: 'completed', summary: 'Background command "Re-collect" completed' })
    expect(await text(band, 'band')).toContain('1/3')
    await notify($, { 'task-id': 'bk7', status: 'killed', summary: 'Background command "Collect" was stopped' })
    expect(await text(band, 'band')).toContain('2/3')
    await complete($, 'a-one', 'answer')
    expect(await text(band, 'band')).toBeUndefined()
  })

  test('two runs in one command are two rows', async ($, on) => {
    const { world, ui } = await start($, on)
    await bash($, `${KIRO_CMD} > a.txt & kiro-cli chat --agent repo --no-interactive "Read the repo" > b.txt & wait`)
    const id = callId(world)
    expect(await text(ui, `kiro-${id}-1`)).toContain(KIRO_TITLE)
    expect(await text(ui, `kiro-${id}-2`)).toContain('Read the repo')
    expect(await text(ui, 'summary')).toBe('0 running · 2 finished')
  })

  test('the deck only watches: the command, its result and the prompts pass untouched, and each call runs once', async ($, on) => {
    const { world } = await start($, on)
    const answer = ok('x\n ▸ Credits: 0.63 • Time: 3s')
    world.answer = () => answer
    expect(await bash($, KIRO_CMD, { run_in_background: false, description: 'Collect inventory' })).toEqual(answer)
    expect(world.calls).toHaveLength(1)
    expect(world.calls[0]?.input).toMatchObject({
      tool: 'Bash',
      command: KIRO_CMD,
      run_in_background: false,
      description: 'Collect inventory',
    })
    const bg = backgrounded('bk8')
    world.answer = () => bg
    expect(await bash($, KIRO_CMD, { run_in_background: true })).toEqual(bg)
    expect(await bash($, 'node x.js', { run_in_background: true })).toEqual(bg)
    expect(world.calls.map((c) => c.input.command)).toEqual([KIRO_CMD, KIRO_CMD, 'node x.js'])
    await spawn($, 'one')
    expect(world.tools).toBe(0)
    expect(world.prompts).toEqual(['p'])
    const fields = { 'task-id': 'bk8', status: 'completed', summary: 'Background command "x" completed (exit code 0)' }
    expect(await notifyByPrompt($, fields)).toEqual({ text: envelope(fields) })
    expect(await relay($, 'a plain prompt', 'composer')).toEqual({ text: 'a plain prompt' })
  })

  test("a failure inside the deck's Bash hook never breaks the call, before or after it ran, nor leaves a row running", async ($, on) => {
    const { world, clock, ui } = await start($, on)
    const answer = ok('fine')
    world.answer = () => answer
    world.failSet = 'agents'
    expect(await bash($, KIRO_CMD)).toEqual(answer)
    expect(world.calls).toHaveLength(1)
    expect(await text(ui, `kiro-${callId(world)}`)).toBeUndefined()
    expect(await bash($, 'node x.js', { run_in_background: true, description: 'X' })).toEqual(answer)
    expect(await bash($, 'ls -la')).toEqual(answer)
    expect(world.calls).toHaveLength(3)

    world.failSet = null
    world.failOnCall = 'agents'
    expect(await bash($, KIRO_CMD)).toEqual(answer)
    expect(world.calls).toHaveLength(4)
    const lost = `kiro-${callId(world)}`
    expect(await text(ui, lost)).toContain('●')
    world.failOnCall = null
    world.failSet = null
    await clock.advance(1_000)
    expect(await text(ui, lost)).toContain('end not seen')
    expect(await text(ui, lost)).toContain('○')
    expect(await bash($, KIRO_CMD)).toEqual(answer)
    expect(await text(ui, `kiro-${callId(world)}`)).toContain('✓')
    expect(world.calls).toHaveLength(5)
  })
})

describe('tasks', () => {
  for (const surface of SURFACES) {
    const isDrawn = surface !== 'terminal'

    test(`${surface}: a Bash run in the background is a task row: its description, a submarine, then done`, async ($, on) => {
      const { world, clock, ui, band } = await start($, on, surface)
      world.answer = () => backgrounded('bt1')
      await bash($, `cd /data && API_KEY=${FAKE_KEY} node scripts/recollect.mjs --day 2026-11-02`, {
        run_in_background: true,
        description: 'Run full base re-collection for 2026-11-02 in background',
      })
      const key = `task-${callId(world)}`
      await clock.advance(38 * 60_000)
      const row = (await text(ui, key)) ?? ''
      expect(row).toContain('Run full base re-collection for 2026-11-02 in background')
      expect(row).toContain('Bash · in background · 38:00')
      expect(await text(band, 'band')).toBeUndefined()
      expect(world.opens).toBe(0)
      expect(await text(ui, 'summary')).toBe('1 running · 0 finished')
      if (isDrawn) {
        const drawn = await source(ui, key)
        expect(drawn).toContain('<g class="sub run">')
        expect(drawn).toContain('<tspan class="tv">Bash</tspan>')
        expect(drawn).toContain(`fill="${SUB.hull}"/>`)
      } else {
        expect((await ui.find({ type: 'Text', text: '◒' }))?.props?.color).toBe(SUB.hull)
        expect(await ui.find({ type: 'Text', text: '▣' })).toBeUndefined()
        expect((await ui.find({ type: 'Text', text: 'Bash' }))?.props?.color).toBe('planMode')
      }
      await notify($, {
        'task-id': 'bt1',
        status: 'completed',
        summary: 'Background command "Run full base re-collection" completed (exit code 0)',
      })
      expect(await text(ui, key)).toContain(isDrawn ? 'in background: done' : '✓')
      expect(await text(ui, key)).toContain('Bash · 38:00')
      if (isDrawn) expect(await source(ui, key)).toContain('<g class="sub">')
      expect(await text(band, 'band')).toBeUndefined()
      const drawn = await drawnText(ui)
      for (const part of [FAKE_KEY, 'recollect', '--day', 'cd /data']) expect(drawn).not.toContain(part)
    })

    test(`${surface}: a background command that fails ends failed and dimmed, with its exit code`, async ($, on) => {
      const { world, ui } = await start($, on, surface)
      world.answer = () => backgrounded('bt2')
      await bash($, 'make deploy', { run_in_background: true, description: 'Deploy' })
      const key = `task-${callId(world)}`
      await notify($, {
        'task-id': 'bt2',
        status: 'failed',
        summary: 'Background command "Deploy" failed with exit code 1',
      })
      expect(await text(ui, key)).toContain('Bash · exit 1 · 0:00')
      expect(await text(ui, key)).toContain(isDrawn ? 'Deploy: failed' : '✗')
      if (isDrawn) expect(await source(ui, key)).toContain('opacity="0.45"')
    })
  }

  test('with no description a task is titled by its program alone; a description is redacted', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('bt3')
    await bash($, `API_KEY=${FAKE_KEY} timeout 3600 psql -c "select count(*) from visits"`, { run_in_background: true })
    const key = `task-${callId(world)}`
    expect(await text(ui, key)).toContain('psql')
    await deck($, 'details')
    expect(await text(ui, key)).toContain('Task · Bash · psql')
    world.answer = () => backgrounded('bt4')
    await bash($, 'make upload', { run_in_background: true, description: `Upload with ${FAKE_KEY}` })
    expect(await text(ui, `task-${callId(world)}`)).toContain('Upload with …')
    const drawn = await drawnText(ui)
    for (const part of [FAKE_KEY, 'select', 'visits', 'timeout']) expect(drawn).not.toContain(part)
  })

  test('a foreground command the engine moved to the background is a task from its start', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => ({
      ...backgrounded('bt5', { timedOutAfterMs: 600_000 }),
      text: 'Command did not complete within its 600s timeout and was moved to the background (ID: bt5).',
    })
    await bash($, 'make build', { description: 'Build the images' })
    const key = `task-${callId(world)}`
    expect(await text(ui, key)).toContain('Build the images')
    expect(await text(ui, key)).toContain('Bash · in background · 10:00')
    world.answer = () => ok()
    await bash($, 'ls')
    world.answer = () => failedWith(1)
    await bash($, 'false')
    expect(await text(ui, 'summary')).toBe('1 running · 0 finished')
  })

  test('a Monitor is a task row until its watch ends; its events leave it running', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => ({ result: { taskId: 'm1', timeoutMs: 300_000 }, text: 'Monitor started.' })
    await $.tool.call({
      tool: 'Monitor',
      description: 'Watch the CI run',
      timeout_ms: 300_000,
      command: 'gh run watch 42',
    } as never)
    const key = `task-${callId(world)}`
    expect(await text(ui, key)).toContain('Watch the CI run')
    expect(await text(ui, key)).toContain('Monitor · in background')
    await notify($, { 'task-id': 'm1', summary: 'Monitor event: "Watch the CI run"' })
    expect(await text(ui, key)).toContain('●')
    await notify($, { 'task-id': 'm1', status: 'completed', summary: 'Monitor "Watch the CI run" stream ended' })
    expect(await text(ui, key)).toContain('✓')
    expect(await drawnText(ui)).not.toContain('gh run watch')
  })

  test('a kiro-cli in the background is one Kiro row, with no task beside it', async ($, on) => {
    const { world, ui, band } = await start($, on)
    world.answer = () => backgrounded('bk10')
    await bash($, KIRO_CMD, { run_in_background: true, description: 'Collect inventory' })
    const id = callId(world)
    expect(await text(ui, `kiro-${id}`)).toContain(KIRO_TITLE)
    expect(await text(ui, `task-${id}`)).toBeUndefined()
    expect(await text(band, 'band')).toContain('0/1')
    expect(await text(ui, 'summary')).toBe('1 running · 0 finished')
  })

  test('/deck tasks off drops the task rows and adds none; on adds them again', async ($, on) => {
    const { world, ui, band } = await start($, on)
    world.answer = () => backgrounded('bt6')
    await bash($, 'node a.js', { run_in_background: true, description: 'Task A' })
    const first = `task-${callId(world)}`
    expect(await text(ui, first)).toContain('Task A')
    expect(await deck($, 'tasks')).toMatchObject({ text: 'Background tasks on. /deck tasks on | off changes it.' })
    expect(await deck($, 'tasks off')).toMatchObject({
      text: 'Background tasks off for this session: their rows are gone and new ones are not added.',
    })
    expect(await text(ui, first)).toBeUndefined()
    expect(await text(band, 'band')).toBeUndefined()
    world.answer = () => backgrounded('bt7')
    await bash($, 'node b.js', { run_in_background: true, description: 'Task B' })
    expect(await text(ui, `task-${callId(world)}`)).toBeUndefined()
    expect(((await deck($, '')) as { text: string }).text).toContain('details off, tasks off.')
    world.answer = () => backgrounded('bk11')
    await bash($, KIRO_CMD, { run_in_background: true })
    expect(await text(ui, `kiro-${callId(world)}`)).toContain(KIRO_TITLE)
    expect(await deck($, 'tasks on')).toMatchObject({
      text: 'Background tasks on for this session: Bash run in the background and Monitor get a row.',
    })
    world.answer = () => backgrounded('bt8')
    await bash($, 'node c.js', { run_in_background: true, description: 'Task C' })
    expect(await text(ui, `task-${callId(world)}`)).toContain('Task C')
    expect(await deck($, 'tasks maybe')).toMatchObject({ text: expect.stringContaining('Usage: /deck') })
  })

  test(
    'the showTasks option off adds no task rows; /deck tasks on wins for the session',
    { options: { showTasks: false } },
    async ($, on) => {
      const { world, ui } = await start($, on)
      world.answer = () => backgrounded('bt9')
      await bash($, 'node a.js', { run_in_background: true, description: 'Task A' })
      expect(await text(ui, `task-${callId(world)}`)).toBeUndefined()
      expect(await text(ui, 'empty')).toContain('No agents yet')
      expect(((await deck($, '')) as { text: string }).text).toContain('tasks off')
      await deck($, 'tasks on')
      world.answer = () => backgrounded('bt10')
      await bash($, 'node b.js', { run_in_background: true, description: 'Task B' })
      expect(await text(ui, `task-${callId(world)}`)).toContain('Task B')
    },
  )

  test('costumes never dress a task: it stays a submarine', async ($, on) => {
    const { world, ui } = await start($, on, 'desktop')
    world.answer = () => backgrounded('bt11')
    await bash($, 'node a.js', { run_in_background: true, description: 'Task A' })
    const key = `task-${callId(world)}`
    await deck($, 'astronaut')
    await deck($, 'costume random off')
    const drawn = await source(ui, key)
    expect(drawn).toContain('<g class="sub run">')
    expect(drawn).not.toContain('<g class="c-')
  })
})

describe('random costumes', () => {
  const names = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']

  test('desktop: by default each agent draws its costume from its id, the same on every redraw and reload', async ($, on) => {
    const { clock, ui } = await start($, on, 'desktop')
    for (const n of names) await spawn($, n, { subagentType: 'general-purpose' })
    const classes = async (mounted: Finder) =>
      Promise.all(names.map(async (n) => (await source(mounted, `a-${n}`)).match(/<g class="(c-\w+) run">/)?.[1]))
    const drawn = await classes(ui)
    expect(drawn).toEqual(names.map((n) => `c-${randomCostume(`a-${n}`)}`))
    expect(new Set(drawn).size).toBeGreaterThan(2)
    await clock.advance(3_000)
    expect(await classes(ui)).toEqual(drawn)
    await ui.unmount()
    const again = await $.ui.mount({
      plugin: 'deck',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'deck',
      props: PANE,
    })
    expect(await classes(again)).toEqual(drawn)
  })

  test('terminal: the mark takes the drawn costume colour', async ($, on) => {
    const { ui } = await start($, on)
    for (const n of names) await spawn($, n, { subagentType: 'general-purpose' })
    const marks = await ui.findAll({ type: 'Text', text: '▣' })
    expect(marks.map((m) => m.props?.color)).toEqual(names.map((n) => colourOf(randomCostume(`a-${n}`))).reverse())
  })

  test('/deck costume random off dresses by type and model; on draws again; reset follows the option', async ($, on) => {
    const { ui } = await start($, on, 'desktop')
    await spawn($, 'r1', { subagentType: 'general-purpose' })
    await spawn($, 'p1', { subagentType: 'Plan' })
    expect(await deck($, 'costume random off')).toMatchObject({
      text: 'Random costumes off for this session: agents dress by type, then model, unless one is chosen.',
    })
    expect(await source(ui, 'a-r1')).toContain('<g class="c-heavy run">')
    expect(await source(ui, 'a-p1')).toContain('<g class="c-careful run">')
    expect(((await deck($, 'costume')) as { text: string }).text).toContain(
      'Wearing: the default (by type, then model). Random costumes off (this session).',
    )
    await deck($, 'costume random on')
    expect(await source(ui, 'a-r1')).toContain(`<g class="c-${randomCostume('a-r1')} run">`)
    expect(await deck($, 'costume random')).toMatchObject({ text: 'Random costumes on (this session).' })
    expect(await deck($, 'costume random maybe')).toMatchObject({
      text: expect.stringContaining('Unknown costume or target'),
    })
    await deck($, 'costume random off')
    expect(await deck($, 'costume reset')).toMatchObject({ text: 'Costumes back to a random costume per agent.' })
    expect(await deck($, 'costume random')).toMatchObject({ text: 'Random costumes on (the randomCostumes option).' })
  })

  test('the randomCostumes option off dresses by type and model; the session can turn it on', FIXED, async ($, on) => {
    const { ui } = await start($, on, 'desktop')
    await spawn($, 'r1', { subagentType: 'general-purpose' })
    expect(await source(ui, 'a-r1')).toContain('<g class="c-heavy run">')
    expect(((await deck($, 'costume')) as { text: string }).text).toContain(
      'Wearing: the default (by type, then model). Random costumes off (the randomCostumes option).',
    )
    await deck($, 'costume random on')
    expect(await source(ui, 'a-r1')).toContain(`<g class="c-${randomCostume('a-r1')} run">`)
  })

  test(
    'a chosen costume wins over the draw: the session first, then the option',
    { options: { costumes: 'opus=racer' } },
    async ($, on) => {
      const { world, ui } = await start($, on, 'desktop')
      await spawn($, 'o1', { subagentType: 'general-purpose' })
      await spawn($, 's1', { subagentType: 'general-purpose', model: 'claude-sonnet-5-5' })
      world.answer = () => backgrounded('bk12')
      await bash($, KIRO_CMD, { run_in_background: true })
      const kiro = `kiro-${callId(world)}`
      expect(await source(ui, 'a-o1')).toContain('<g class="c-light run">')
      expect(await source(ui, 'a-s1')).toContain(`<g class="c-${randomCostume('a-s1')} run">`)
      expect(await source(ui, kiro)).toContain('<g class="c-light ghost run">')
      expect(((await deck($, 'costume')) as { text: string }).text).toContain(
        'Wearing: opus racer, a random costume for the rest. Random costumes on (the randomCostumes option).',
      )
      expect(await deck($, 'astronaut')).toMatchObject({ text: 'Wearing: all astronaut.' })
      for (const key of ['a-o1', 'a-s1']) expect(await source(ui, key)).toContain('<g class="c-fable run">')
      expect(await source(ui, kiro)).toContain('<g class="c-fable ghost run">')
    },
  )
})

// Fixture secrets built from parts: shaped like real ones for the redactor, never one a scanner takes for real.
const part = (...p: string[]) => p.join('')
const GH = part('ghp', '_fake0123', 'fake4567fake')
const SK = part('sk', '-ant-fake-', '0123456789abcdef')
const URLPASS = part('postgres://admin:', 'Hunter', '2pass', '@db.internal/app')
const AWS_SECRET = part('wJalrXUtnFEMI', '/', 'K7MDENG', '/', 'bPxRfiCY', 'EXAMPLEKEY')
const BIDI = '‮'
const OSC = `${ESC}]8;;http://x${String.fromCharCode(7)}`
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected."

describe('review: privacy', () => {
  test('tokens in a Kiro task and in a task description never reach the pane, alt text, band or /deck', async ($, on) => {
    const { world, ui, band } = await start($, on, 'desktop')
    world.answer = () => backgrounded('bkp1')
    await bash($, `kiro-cli chat --agent x --no-interactive "use ${FAKE_KEY} / ${GH} / ${SK} now"`, {
      run_in_background: true,
    })
    world.answer = () => backgrounded('btp1')
    await bash($, 'node x.js', {
      run_in_background: true,
      description: `Upload with ${GH} then ${OSC}link ${BIDI}evil ${'w '.repeat(5000)}`,
    })
    await deck($, 'details')
    const drawn = (await drawnText(ui)) + (await drawnText(band))
    const status = JSON.stringify(await deck($, '')) + JSON.stringify(world.logs)
    for (const secret of [FAKE_KEY, GH, SK]) {
      expect(drawn).not.toContain(secret)
      expect(status).not.toContain(secret)
    }
    expect(drawn).not.toContain(ESC)
    expect(drawn).not.toContain(BIDI)
    expect(drawn).toContain('use … / … / … now')
  })

  test('a password in a URL and a slashed AWS secret are redacted in the title', async ($, on) => {
    const { world, ui } = await start($, on, 'desktop')
    world.answer = () => backgrounded('bkp2')
    await bash($, `kiro-cli chat --agent x "check ${URLPASS}"`, { run_in_background: true })
    world.answer = () => backgrounded('bkp3')
    await bash($, `kiro-cli chat --agent x "use ${AWS_SECRET}"`, { run_in_background: true })
    const drawn = await drawnText(ui)
    expect(drawn).not.toContain('Hunter2pass')
    expect(drawn).not.toContain('bPxRfiCYEXAMPLEKEY')
    expect(drawn).toContain('check postgres://admin:…@db.internal/app')
  })

  test('markup in a description or a --model value is escaped in the SVG', async ($, on) => {
    const { world, ui } = await start($, on, 'desktop')
    world.answer = () => backgrounded('bkx')
    await bash($, 'kiro-cli chat --model "m</tspan><script>x</script>" "a</text><g onload=1>&amp;"', {
      run_in_background: true,
    })
    const kiro = `kiro-${callId(world)}`
    world.answer = () => backgrounded('btx')
    await bash($, 'node a.js', { run_in_background: true, description: '"/><script>y</script>' })
    await deck($, 'details')
    const sources = (await source(ui, kiro)) + (await source(ui, `task-${callId(world)}`))
    expect(sources).not.toContain('<script>')
    expect(sources).not.toContain('<g onload')
    expect(sources).toContain('&lt;script&gt;')
  })
})

describe('review: tasks stay out of the way', () => {
  test('past 200 rows the oldest running tasks go: 210 never-ending tasks keep 200 rows', async ($, on) => {
    const { world, ui } = await start($, on)
    for (let i = 0; i < 210; i++) {
      world.answer = () => backgrounded(`bm${i}`)
      await bash($, 'sleep 1000', { run_in_background: true, description: `T${i}` })
    }
    expect(await text(ui, 'summary')).toBe('200 running · 0 finished')
  })

  test('running agents and Kiro runs keep their rows past 200; tasks give way', async ($, on) => {
    const { world, ui } = await start($, on)
    await spawn($, 'keep')
    for (let i = 0; i < 205; i++) {
      world.answer = () => backgrounded(`bk${i}`)
      await bash($, 'sleep 1000', { run_in_background: true, description: `T${i}` })
    }
    expect(await text(ui, 'summary')).toBe('200 running · 0 finished')
    await complete($, 'a-keep', 'answer')
    expect(await text(ui, 'summary')).toBe('199 running · 1 finished')
  })

  test('a long-lived background task (dev server) neither holds the band nor swallows later batches', async ($, on) => {
    const { world, clock, band } = await start($, on)
    world.answer = () => backgrounded('btdev')
    await bash($, 'pnpm dev', { run_in_background: true, description: 'Start the dev server' })
    expect(await text(band, 'band')).toBeUndefined()
    await clock.advance(30 * 60_000)
    await spawn($, 'one')
    expect(await text(band, 'band')).toContain('0/1')
    await complete($, 'a-one', 'answer')
    expect(await text(band, 'band')).toBeUndefined()
    await spawn($, 'two')
    expect(await text(band, 'band')).toContain('0/1')
    await complete($, 'a-two', 'answer')
    expect(await text(band, 'band')).toBeUndefined()
  })

  test('a task started while agents run joins their batch, and never keeps it running', async ($, on) => {
    const { world, band } = await start($, on)
    await spawn($, 'one')
    world.answer = () => backgrounded('btj')
    await bash($, 'make long', { run_in_background: true, description: 'Long' })
    expect(await text(band, 'band')).toContain('0/2')
    await complete($, 'a-one', 'answer')
    expect(await text(band, 'band')).toBeUndefined()
    await spawn($, 'two')
    expect(await text(band, 'band')).toContain('0/1')
  })

  test('a task never opens the pane; an agent still does', async ($, on) => {
    const { world } = await start($, on)
    world.answer = () => backgrounded('bto')
    await bash($, 'make long', { run_in_background: true, description: 'Long' })
    world.answer = () => ({ result: { taskId: 'mo', timeoutMs: 300_000 }, text: 'Monitor started.' })
    await $.tool.call({ tool: 'Monitor', description: 'Watch', timeout_ms: 300_000, command: 'x' } as never)
    expect(world.opens).toBe(0)
    await spawn($, 'one')
    expect(world.opens).toBe(1)
  })

  test('agent time leaves background tasks out; Kiro runs count', async ($, on) => {
    const { world, clock } = await start($, on)
    world.answer = () => backgrounded('btt')
    await bash($, 'pnpm dev', { run_in_background: true, description: 'Dev server' })
    await clock.advance(60_000)
    expect(await deck($, '')).toMatchObject({ text: expect.stringContaining('0:00 agent time') })
    world.answer = () => backgrounded('bkt2')
    await bash($, KIRO_CMD, { run_in_background: true })
    await clock.advance(30_000)
    expect(await deck($, '')).toMatchObject({ text: expect.stringContaining('0:30 agent time') })
  })

  test('a persistent Monitor has no safety net and never counts in the band', { timeoutMs: 180_000 }, async ($, on) => {
    const { world, clock, ui, band } = await start($, on)
    await spawn($, 'one')
    world.answer = () => ({ result: { taskId: 'mp', timeoutMs: 0, persistent: true }, text: 'Monitor started.' })
    await $.tool.call({ tool: 'Monitor', description: 'Watch', timeout_ms: 0, command: 'tail -f x' } as never)
    const key = `task-${callId(world)}`
    expect(await text(band, 'band')).toContain('0/1')
    await complete($, 'a-one', 'answer')
    await ui.unmount()
    await band.unmount()
    for (let h = 0; h < 7; h++) await clock.advance(60 * 60 * 1000)
    const pane = await $.ui.mount({
      plugin: 'deck',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'deck',
      props: PANE,
    })
    expect(await text(pane, key)).toContain('●')
  })

  test('a Monitor whose end never comes closes at its timeout and a minute of grace, neither done nor failed', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    world.answer = () => ({ result: { taskId: 'mt1', timeoutMs: 120_000 }, text: 'Monitor started.' })
    await $.tool.call({ tool: 'Monitor', description: 'Watch CI', timeout_ms: 120_000, command: 'x' } as never)
    const key = `task-${callId(world)}`
    await clock.advance(170_000)
    expect(await text(ui, key)).toContain('●')
    await clock.advance(11_000)
    expect(await text(ui, key)).toContain('timed out')
    expect(await text(ui, key)).toContain('○')
    expect(await text(ui, 'summary')).toBe('0 running · 1 finished')
  })

  test('a command the person sent to the background (Ctrl+B) starts when its call did', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    let release = () => {}
    world.gate = new Promise((resolve) => {
      release = resolve
    })
    world.answer = () => ({
      ...backgrounded('btb', { backgroundedByUser: true }),
      text: 'Command was manually backgrounded by user with ID: btb.',
    })
    const pending = bash($, 'make build', { description: 'Build' })
    await clock.settle()
    await clock.advance(45_000)
    release()
    await pending
    expect(await text(ui, `task-${callId(world)}`)).toContain('Bash · in background · 0:45')
  })
})

describe('review: ends', () => {
  test('a foreground kiro-cli whose answer mentions "with ID:" or "(ID: x)" ends normally', async ($, on) => {
    const { world, ui, band } = await start($, on)
    world.answer = () => ok('Created the stack with ID: arn-stack-1 (ID: i-0abc)\n ▸ Credits: 0.4 • Time: 2s')
    await bash($, KIRO_CMD)
    const key = `kiro-${callId(world)}`
    expect(await text(ui, key)).not.toContain('in background')
    expect(await text(ui, key)).toContain('✓')
    expect(await text(band, 'band')).toBeUndefined()
  })

  test('"exit code 2" in a description does not fail a task that completed with exit code 0', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('btq1')
    await bash($, 'make fix', { run_in_background: true, description: 'Fix exit code 2 handling' })
    const key = `task-${callId(world)}`
    await notify($, {
      'task-id': 'btq1',
      status: 'completed',
      summary: 'Background command "Fix exit code 2 handling" completed (exit code 0)',
    })
    expect(await text(ui, key)).not.toContain('exit 2')
    expect(await text(ui, key)).toContain('✓')
    expect(await text(ui, 'summary')).toBe('0 running · 1 finished')
  })

  test('completed with exit code 1 is done, the exit only a detail', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('btg')
    await bash($, 'grep -r x .', { run_in_background: true, description: 'Search' })
    const key = `task-${callId(world)}`
    await notify($, {
      'task-id': 'btg',
      status: 'completed',
      summary: 'Background command "Search" completed (exit code 1: No matches found)',
    })
    expect(await text(ui, key)).toContain('Bash · exit 1')
    expect(await text(ui, key)).toContain('✓')
  })

  test('a call the person rejects at the permission prompt leaves no row, nor a failure', async ($, on) => {
    const { world, clock, ui, band } = await start($, on)
    let release = () => {}
    world.gate = new Promise((resolve) => {
      release = resolve
    })
    world.answer = () => ({ isError: true, result: REJECTED, text: REJECTED })
    const pending = bash($, KIRO_CMD)
    await clock.settle()
    const key = `kiro-${callId(world)}`
    expect(await text(ui, key)).toContain('●')
    release()
    await pending
    expect(await text(ui, key)).toBeUndefined()
    expect(await text(ui, 'empty')).toContain('No agents yet')
    expect(await text(band, 'band')).toBeUndefined()
  })

  test('a background Kiro run waiting at the permission prompt counts no time; its clock starts when it starts', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    let release = () => {}
    world.gate = new Promise((resolve) => {
      release = resolve
    })
    world.answer = () => backgrounded('bkw')
    const pending = bash($, KIRO_CMD, { run_in_background: true })
    await clock.settle()
    const key = `kiro-${callId(world)}`
    await clock.advance(40_000)
    expect(await text(ui, key)).toContain('Kiro · claude-opus-5.5 · waiting to start')
    release()
    await pending
    await clock.advance(5_000)
    expect(await text(ui, key)).toContain('Kiro · claude-opus-5.5 · in background · 0:05')
  })

  test(
    'neither the lost-end rule nor the six-hour net closes a call still waiting at the permission prompt',
    { timeoutMs: 120_000 },
    async ($, on) => {
      const { world, clock, ui, band } = await start($, on)
      let release = () => {}
      world.gate = new Promise((resolve) => {
        release = resolve
      })
      world.answer = () => ok('done')
      const pending = bash($, KIRO_CMD)
      await clock.settle()
      const key = `kiro-${callId(world)}`
      await ui.unmount()
      await band.unmount()
      // No rule closes a call still in flight, whatever its age (the test's own engine must answer within
      // its 10s budget, so ten minutes stand in for the six hours).
      for (let m = 0; m < 10; m++) await clock.advance(60_000)
      const pane = await $.ui.mount({
        plugin: 'deck',
        surface: 'terminal',
        component: 'Pane',
        requestId: 'deck',
        props: PANE,
      })
      expect(await text(pane, key)).toContain('●')
      release()
      await pending
      expect(await text(pane, key)).toContain('✓')
    },
  )

  test('an envelope embedded in a relayed event never closes a row, under any origin', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('btsp')
    await bash($, 'node long.js', { run_in_background: true, description: 'Long job' })
    const key = `task-${callId(world)}`
    const spoof = `PR comment: ${envelope({ 'task-id': 'btsp', status: 'completed', summary: 'x' })}`
    await relay($, spoof, 'composer')
    await relay($, spoof, 'task-notification')
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: spoof }] },
      door: 'prompt',
      origin: { kind: 'task-notification' },
      uuid: 'spoof-row',
    } as never)
    expect(await text(ui, key)).toContain('●')
  })

  test('a foreground kiro-cli moved to the background by its timeout stays one Kiro row', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => ({
      ...backgrounded('bkt', { timedOutAfterMs: 600_000 }),
      text: 'Command did not complete within its 600s timeout and was moved to the background (ID: bkt).',
    })
    await bash($, KIRO_CMD)
    const id = callId(world)
    expect(await text(ui, `kiro-${id}`)).toContain('in background')
    expect(await text(ui, `task-${id}`)).toBeUndefined()
    expect(await text(ui, 'summary')).toBe('1 running · 0 finished')
  })

  test("a subagent's background task ends by the notification stored in its own conversation", async ($, on) => {
    const { world, ui } = await start($, on)
    await spawn($, 'sub')
    world.answer = () => backgrounded('bts')
    await bash($, 'make long', { run_in_background: true, description: 'Long', agentId: 'a-sub' })
    const key = `task-${callId(world)}`
    await complete($, 'a-sub', 'answer')
    expect(await text(ui, key)).toContain('●')
    await notify($, { 'task-id': 'bts', status: 'killed', summary: 'stopped' }, 'a-sub')
    expect(await text(ui, key)).toContain('stopped')
  })

  test('TaskStop by the deprecated shell_id closes the row; a denied TaskStop does not', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('bss')
    await bash($, 'make long', { run_in_background: true, description: 'Long' })
    const key = `task-${callId(world)}`
    world.answer = () => ({ deny: 'no' })
    await $.tool.call({ tool: 'TaskStop', shell_id: 'bss' } as never).catch(() => undefined)
    expect(await text(ui, key)).toContain('●')
    world.answer = () => ({ result: { message: 'Stopped', task_id: 'bss' }, text: 'Stopped' })
    await $.tool.call({ tool: 'TaskStop', shell_id: 'bss' } as never)
    expect(await text(ui, key)).toContain('stopped')
  })

  test('a GetTask that failed shows its error code; an unknown shape changes nothing', async ($, on) => {
    const { world, ui } = await start($, on)
    world.answer = () => backgrounded('bgf')
    await bash($, 'make long', { run_in_background: true, description: 'Long' })
    const key = `task-${callId(world)}`
    world.answer = () => ({ result: { taskId: 'bgf', status: 'completed', result: 'odd' }, text: 'x' })
    await $.tool.call({ tool: 'GetTask', taskId: 'bgf' } as never)
    expect(await text(ui, key)).toContain('●')
    world.answer = () => ({
      result: {
        taskId: 'bgf',
        statusMessage: 'x',
        createdAt: 'a',
        lastUpdatedAt: 'b',
        status: 'failed',
        error: { code: 2, message: 'boom' },
      },
      text: 'x',
    })
    await $.tool.call({ tool: 'GetTask', taskId: 'bgf' } as never)
    expect(await text(ui, key)).toContain('Bash · error 2')
    expect(await text(ui, key)).toContain('✗')
  })

  test('/clear empties the deck; a later notification and a late Bash result change nothing', async ($, on) => {
    const { world, clock, ui, band } = await start($, on)
    let release = () => {}
    world.gate = new Promise((resolve) => {
      release = resolve
    })
    const pending = bash($, KIRO_CMD)
    await clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    expect(await text(ui, 'empty')).toContain('No agents yet')
    release()
    await pending
    await notify($, { 'task-id': 'zzz', status: 'completed', summary: 'x' })
    expect(await text(ui, 'empty')).toContain('No agents yet')
    expect(await text(band, 'band')).toBeUndefined()
  })
})

describe('review: pass-through', () => {
  test('the Bash result object is returned as the engine gave it and the input reaches the engine unchanged', async ($, on) => {
    const { world } = await start($, on)
    const answer = { ...ok(`x\n ▸ Credits: 0.63 • Time: 3s\n${ESC}[0m`), extra: { nested: [1, 2] } }
    world.answer = () => answer
    const got = await bash($, KIRO_CMD, { description: 'Collect', timeout: 1000 })
    expect(JSON.stringify(got)).toBe(JSON.stringify(answer))
    const input = { ...world.calls[0]?.input }
    delete input.tool_use_id
    expect(input).toEqual({ tool: 'Bash', command: KIRO_CMD, description: 'Collect', timeout: 1000 })
    world.answer = () => backgrounded('bpt')
    const bg = await bash($, 'node a.js', { run_in_background: true })
    expect(JSON.stringify(bg)).toBe(JSON.stringify(backgrounded('bpt')))
    expect(world.tools).toBe(0)
  })

  test('a throw after the Monitor and GetTask calls ran never re-runs them', async ($, on) => {
    const { world } = await start($, on)
    world.answer = () => ({ result: { taskId: 'mt', timeoutMs: 1000 }, text: 'ok' })
    world.failOnCall = 'agents'
    await $.tool.call({ tool: 'Monitor', description: 'W', timeout_ms: 1000, command: 'x' } as never)
    world.answer = () => ({
      result: {
        taskId: 'mt',
        status: 'completed',
        statusMessage: 'x',
        createdAt: 'a',
        lastUpdatedAt: 'b',
        result: { content: [], isError: false },
      },
      text: 'x',
    })
    await $.tool.call({ tool: 'GetTask', taskId: 'mt' } as never)
    expect(world.calls.map((c) => c.tool)).toEqual(['Monitor', 'GetTask'])
  })
})

describe('review: costumes', () => {
  test('a session `all` beats an option target', { options: { costumes: 'opus=racer' } }, async ($, on) => {
    const { ui } = await start($, on, 'desktop')
    await spawn($, 'o1', { subagentType: 'general-purpose' })
    await deck($, 'pirate')
    expect(await source(ui, 'a-o1')).toContain('<g class="c-explore run">')
  })

  test('a Kiro row draws its random costume from its id, stable across redraws', async ($, on) => {
    const { world, ui, clock } = await start($, on, 'desktop')
    world.answer = () => backgrounded('bkr')
    await bash($, KIRO_CMD, { run_in_background: true })
    const key = `kiro-${callId(world)}`
    const want = `<g class="c-${randomCostume(key)} ghost run">`
    expect(await source(ui, key)).toContain(want)
    await clock.advance(5_000)
    expect(await source(ui, key)).toContain(want)
  })
})
