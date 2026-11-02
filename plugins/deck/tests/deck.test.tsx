import type { On, RenderPropsOf, TurnUsage, UiPane } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { type Costume, TIER_COLOR } from '../hooks/art'

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

type World = {
  panes: UiPane[]
  opens: number
  usage: Usage
  tools: number
  prompts: string[]
  logs: string[]
  /** A terminal under 144 columns: the deck's own first open waits undrawn. */
  isNarrow: boolean
}

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
  const world: World = { panes: [], opens: 0, usage: usage(2_000), tools: 0, prompts: [], logs: [], isNarrow }
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

    test(`${surface}: each agent wears the costume of its type or model`, async ($, on) => {
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

    test(`${surface}: only a running crab walks; done stands with ✓, failed is dimmed with ✗`, async ($, on) => {
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
      '1 running · 0 finished · 1 failed · ≈$0.00 · 0:05 agent time. Pane open, band on, details off.',
    )
    expect(world.logs).toHaveLength(1)
    expect(world.logs[0]).toContain('Agent time is how long at least one listed agent was running')
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
    expect(await deck($, 'nope')).toMatchObject({ text: 'Usage: /deck [on|off|pane|band|details|clear]' })
  })
})
