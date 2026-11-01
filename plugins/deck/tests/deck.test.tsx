import type { On, RenderPropsOf, TurnUsage, UiPane } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Deck',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const usage = (output: number, write = 1_000): TurnUsage => ({
  input_tokens: 1_000,
  output_tokens: output,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: write,
  model: 'claude-opus-5-5',
})

type World = { panes: UiPane[]; opens: number; write: number }

const engine = (on: On, world: World) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', (_$, e) => ({ text: `unhandled ${e.command}` }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-opus-5-5', agentId: `a-${e.description}` }))
  on('ui.open', (_$, e) => {
    world.opens += 1
    if (!world.panes.some((p) => p.id === e.id)) {
      world.panes.push({ id: e.id, title: e.title ?? '', isShown: true, isFocused: false, isPlaced: true })
    }
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    world.panes = world.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: world.panes }))
  on('turn.step', async function* (_$, e) {
    const u = usage(2_000, world.write)
    yield { kind: 'text', index: 0, text: 'x' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: u }
    return { turnId: e.turnId, index: e.index, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: u }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
}

const spawn = (
  $: Engine,
  description: string,
  extra: Partial<{ workflow: { runId: string; agentIndex: number } }> = {},
) => $.agent.spawn({ prompt: 'p', description, subagentType: 'Explore', ...extra } as never)

const step = async ($: Engine, agentId: string | undefined) => {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId })
  let n = await s.next()
  while (!n.done) n = await s.next()
}

const complete = ($: Engine, agentId: string, reason: 'answer' | 'error') =>
  $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', agentId, reason })

const text = async (ui: { find: (q: { key: string }) => Promise<{ text: string } | undefined> }, key: string) =>
  (await ui.find({ key }))?.text

const start = async ($: Engine, on: On, surface: 'terminal' | 'desktop' = 'terminal') => {
  const world: World = { panes: [], opens: 0, write: 1_000 }
  const clock: MockClock = mock.clock(on, { now: 1_000_000 })
  engine(on, world)
  await $.session.start({ cwd: '/x', surface, isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'deck', surface, component: 'Pane', requestId: 'deck', props: PANE })
  return { world, clock, ui }
}

describe('deck', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: a subagent runs, spends and finishes`, async ($, on) => {
      const { clock, ui } = await start($, on, surface)
      expect(await text(ui, 'empty')).toContain('No agents yet')

      await spawn($, 'scan')
      await step($, 'a-scan')
      await clock.advance(65_000)
      expect(await text(ui, 'a-scan')).toContain('●scan')
      expect(await text(ui, 'a-scan')).toContain('Opus 5.5 · 1:05')
      expect(await text(ui, 'a-scan')).toContain('Explore · 1 req · 14k tok · ctx 1% · ≈$0.05')

      await complete($, 'a-scan', 'answer')
      expect(await text(ui, 'a-scan')).toContain('✓scan')
      expect(await text(ui, 'summary')).toBe('0 running · 1 finished · ≈$0.05 · 14k tokens')
    })
  }

  test('failed runs, workflow agents and running-first order', async ($, on) => {
    const { ui } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two', { workflow: { runId: 'wf_d854d9d3-008', agentIndex: 0 } })
    await complete($, 'a-one', 'error')
    expect(await text(ui, 'a-one')).toContain('✗one')
    expect(await text(ui, 'a-two')).toContain('workflow wf_d854d')
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('a-two')).toBeLessThan(drawn.indexOf('a-one'))
  })

  test('main thread and unknown agents are ignored', async ($, on) => {
    const { ui } = await start($, on)
    await spawn($, 'scan')
    await step($, undefined)
    await step($, 'fork-123')
    expect(await text(ui, 'a-scan')).toContain('0 req')
    expect(await text(ui, 'fork-123')).toBeUndefined()
  })

  test('a finished background agent runs again on a new request', async ($, on) => {
    const { ui } = await start($, on)
    await spawn($, 'scan')
    await complete($, 'a-scan', 'answer')
    await step($, 'a-scan')
    expect(await text(ui, 'a-scan')).toContain('●scan')
  })

  test('opens once on the first agent and /deck toggles', async ($, on) => {
    const { world } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two')
    expect(world.opens).toBe(1)
    const run = (args: string) =>
      $.command.run({
        command: 'deck',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      })
    expect(await run('')).toMatchObject({ text: 'Deck closed.' })
    expect(await run('')).toMatchObject({ text: 'Deck opened.' })
  })

  test('autoOpen false never opens by itself', { options: { autoOpen: false } }, async ($, on) => {
    const { world } = await start($, on)
    await spawn($, 'one')
    expect(world.opens).toBe(0)
  })

  test('clear finished keeps running agents', async ($, on) => {
    const { ui } = await start($, on)
    await spawn($, 'one')
    await spawn($, 'two')
    await complete($, 'a-one', 'answer')
    await ui.press({ key: 'clear' })
    expect(await text(ui, 'a-one')).toBeUndefined()
    expect(await text(ui, 'a-two')).toContain('two')
  })

  test('/clear empties the deck', async ($, on) => {
    const { ui } = await start($, on)
    await spawn($, 'one')
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
    expect(await text(ui, 'a-one')).toBeUndefined()
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
        world.write = 1_000_000
        await spawn($, 'scan')
        await step($, 'a-scan')
        expect(await text(ui, 'a-scan')).toContain(expected)
      },
    )
  }
})
