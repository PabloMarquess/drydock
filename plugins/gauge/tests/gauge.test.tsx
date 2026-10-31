import type { On, RenderPropsOf, SessionUsage, TurnUsage } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

const TTFT = 5_000
const LONG = { timeoutMs: 60_000 }

type Step = { tokens: number; ms: number; read?: number; write?: number; silent?: boolean }
type World = {
  usd: number
  percent: number | undefined
  turns: number
  toasts: string[]
  pushes: string[]
  steps: Step[]
  pending: number[]
  reached: () => void
  gate: Promise<void>
}

const usageOf = (s: Step): TurnUsage => ({
  input_tokens: 10,
  output_tokens: s.tokens,
  cache_read_input_tokens: s.read ?? 5000,
  cache_creation_input_tokens: s.write ?? 0,
  model: 'claude-test',
})

const engine = (on: On, world: World) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/dev/drydock' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', (_$, e) => ({ text: `unhandled ${e.command}` }))
  on('session.turns', () => ({ value: world.turns }))
  on('session.usage', () => {
    const usage: SessionUsage = {
      startedAt: 0,
      context: { window: 1_000_000, percent: world.percent },
      rateLimits: [],
      cost: { usd: world.usd },
    }
    return { value: usage }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_$, e) => (e.instructions === 'skip' ? { skip: 'no' } : { messages: e.messages }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => {
    world.pushes.push(String(e.message))
    return { result: { message: String(e.message), localSent: true } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    const s = world.steps.shift() ?? { tokens: 200, ms: 2_000 }
    const usage = usageOf(s)
    world.reached()
    await world.gate
    if (!s.silent) yield { kind: 'text', index: 0, text: 'hello' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
}

const step = async ($: Engine, clock: MockClock, world: World, id: string, index: number, agentId?: string) => {
  const stream = $.turn.step({ turnId: id, index, model: 'claude-test', messageCount: 1, agentId })
  let release = () => {}
  world.gate = new Promise((r) => {
    release = r
  })
  const reached = new Promise<void>((r) => {
    world.reached = r
  })
  const first = stream.next()
  await reached
  await clock.advance(TTFT)
  release()
  let next = await first
  while (!next.done) {
    if (next.value.kind === 'text') await clock.advance(world.pending.shift() ?? 0)
    next = await stream.next()
  }
}

const turn = async (
  $: Engine,
  clock: MockClock,
  world: World,
  id: string,
  steps: Step[] = [{ tokens: 200, ms: 2_000 }],
  agentId?: string,
) => {
  if (agentId === undefined) {
    world.turns += 1
    await $.turn.start({ text: 'hi', turnId: id })
  }
  world.usd += 0.12
  world.steps.push(...steps)
  world.pending.push(...steps.filter((s) => !s.silent).map((s) => s.ms))
  for (let i = 0; i < steps.length; i++) await step($, clock, world, id, i, agentId)
  await $.turn.complete({ answer: 'hello', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', agentId })
}

type Finder = {
  find: (q: { key: string }) => Promise<{ text: string; children: unknown[] } | undefined>
}

const text = async (ui: Finder, key: string) => {
  const found = await ui.find({ key })
  if (found === undefined || found.text !== '') return found?.text
  const svg = found.children.find((c) => (c as { type?: string }).type === 'Svg') as
    | { props?: { alt?: unknown } }
    | undefined
  return typeof svg?.props?.alt === 'string' ? svg.props.alt : ''
}

const fresh = (): World => ({
  usd: 0,
  percent: 12,
  turns: 0,
  toasts: [],
  pushes: [],
  steps: [],
  pending: [],
  reached: () => {},
  gate: Promise.resolve(),
})

const start = async ($: Engine, on: On, surface: 'terminal' | 'desktop' = 'terminal', props = BAND) => {
  const world = fresh()
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on, world)
  await $.session.start({ cwd: '/home/dev/drydock', surface, isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'gauge', surface, component: 'AbovePrompt', props })
  return { world, clock, ui }
}

const gaugeCommand = ($: Engine) =>
  $.command.run({
    command: 'gauge',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

describe('readings', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: turn, speed, cost, cache and context`, async ($, on) => {
      const { world, clock, ui } = await start($, on, surface)
      expect(await text(ui, 'turn')).toBeUndefined()

      await turn($, clock, world, 't1')

      expect(await text(ui, 'turn')).toBe('Turn 1')
      expect(await text(ui, 'speed')).toBe('100 tok/s')
      expect(await text(ui, 'cost')).toBe('$0.12 turn · $0.12 total')
      expect(await text(ui, 'cache')).toBe('cache 60:00')
      expect(await text(ui, 'context')).toContain('ctx 12%')
    })

    test(`${surface}: context bar only on desktop`, async ($, on) => {
      const { world, clock, ui } = await start($, on, surface)
      await turn($, clock, world, 't1')
      const bar = await ui.find({ type: 'Svg' })
      if (surface === 'desktop') expect(bar).toBeDefined()
      else expect(bar).toBeUndefined()
    })
  }

  test('speed sums main steps from the first token and keeps the last good reading', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1', [
      { tokens: 300, ms: 1_000 },
      { tokens: 100, ms: 3_000 },
      { tokens: 1_000, ms: 0, silent: true },
    ])
    expect(await text(ui, 'speed')).toBe('100 tok/s')
    await turn($, clock, world, 't2', [{ tokens: 300, ms: 1_000 }])
    expect(await text(ui, 'speed')).toBe('300 tok/s')
    await turn($, clock, world, 't3', [{ tokens: 10, ms: 100 }])
    expect(await text(ui, 'speed')).toBe('300 tok/s')
  })

  test('turn cost is the delta since the turn started', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1')
    await turn($, clock, world, 't2')
    expect(await text(ui, 'cost')).toBe('$0.12 turn · $0.24 total')
  })

  test('session.measure moves total, turn cost and context together', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1')
    await $.session.measure({
      context: { window: 1_000_000, percent: 40 },
      rateLimits: [],
      cost: { usd: 1.5 },
      changed: ['context', 'cost'],
    })
    expect(await text(ui, 'context')).toContain('ctx 40%')
    expect(await text(ui, 'cost')).toBe('$1.50 turn · $1.50 total')
  })

  test('subagent requests move neither the turn nor the cache', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1')
    await clock.advance(30_000)
    expect(await text(ui, 'cache')).toBe('cache 59:30')

    await turn($, clock, world, 'sub', [{ tokens: 200, ms: 0 }], 'agent-1')
    expect(await text(ui, 'turn')).toBe('Turn 1')
    expect(await text(ui, 'cache')).toBe('cache 59:25')
  })
})

describe('cache', () => {
  test(
    'anchors on a read or a write, not on an uncached request',
    { options: { cacheTtlMinutes: 10 } },
    async ($, on) => {
      const { world, clock, ui } = await start($, on)
      await turn($, clock, world, 't1', [{ tokens: 200, ms: 0, read: 0, write: 100 }])
      expect(await text(ui, 'cache')).toBe('cache 10:00')
      await clock.advance(55_000)
      await turn($, clock, world, 't2', [{ tokens: 200, ms: 0, read: 0, write: 0 }])
      expect(await text(ui, 'cache')).toBe('cache 9:00')
    },
  )

  test(
    'counts down, warns once and expires',
    { ...LONG, options: { cacheTtlMinutes: 10, warnMinutes: 5 } },
    async ($, on) => {
      const { world, clock, ui } = await start($, on)
      await turn($, clock, world, 't1')
      expect(await text(ui, 'cache')).toBe('cache 10:00')

      await clock.advance(4 * 60_000)
      expect(await text(ui, 'cache')).toBe('cache 6:00')
      expect(world.toasts).toHaveLength(0)

      await clock.advance(61_000)
      expect(world.toasts).toEqual(['⏳ drydock: prompt cache expires in 5 min'])
      expect(world.pushes).toEqual(['drydock: prompt cache expires in 5 min'])

      await clock.advance(60_000)
      expect(world.toasts).toHaveLength(1)

      await clock.advance(5 * 60_000)
      expect(await text(ui, 'cache')).toBe('cache expired')
    },
  )

  test(
    'a short lifetime warns at half of it, not after every turn',
    { ...LONG, options: { cacheTtlMinutes: 5, warnMinutes: 5 } },
    async ($, on) => {
      const { world, clock, ui } = await start($, on)
      await turn($, clock, world, 't1')
      await clock.advance(1_000)
      await turn($, clock, world, 't2')
      await clock.advance(1_000)
      expect(world.toasts).toHaveLength(0)
      expect((await ui.find({ type: 'Text', text: 'cache 4:59' }))?.props.color).toBeUndefined()

      await clock.advance(149_000)
      expect(world.toasts).toEqual(['⏳ drydock: prompt cache expires in 3 min'])
    },
  )

  test(
    'no warning while a main turn runs, through a subagent',
    { ...LONG, options: { cacheTtlMinutes: 10, warnMinutes: 5 } },
    async ($, on) => {
      const { world, clock } = await start($, on)
      await turn($, clock, world, 't1')
      world.turns += 1
      await $.turn.start({ text: 'hi', turnId: 't2' })
      await turn($, clock, world, 'sub', [{ tokens: 200, ms: 0 }], 'agent-1')
      await clock.advance(6 * 60_000)
      expect(world.toasts).toHaveLength(0)
    },
  )

  test(
    'warnMinutes 0 turns the warning off',
    { ...LONG, options: { cacheTtlMinutes: 10, warnMinutes: 0 } },
    async ($, on) => {
      const { world, clock, ui } = await start($, on)
      await turn($, clock, world, 't1')
      await clock.advance(9 * 60_000 + 30_000)
      expect(await text(ui, 'cache')).toBe('cache 0:30')
      expect(world.toasts).toHaveLength(0)
    },
  )

  test(
    'cache and context colors, working placeholder',
    { ...LONG, options: { cacheTtlMinutes: 10, warnMinutes: 2 } },
    async ($, on) => {
      const { world, clock, ui } = await start($, on)
      world.percent = 70
      await turn($, clock, world, 't1')
      expect((await ui.find({ type: 'Text', text: 'cache 10:00' }))?.props.color).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: 'ctx 70%' }))?.props.color).toBe('warning')
      await clock.advance(6 * 60_000)
      expect((await ui.find({ type: 'Text', text: 'cache 4:00' }))?.props.color).toBe('warning')
      await clock.advance(2 * 60_000)
      expect((await ui.find({ type: 'Text', text: 'cache 2:00' }))?.props.color).toBe('error')
      const working = await $.ui.mount({
        plugin: 'gauge',
        surface: 'terminal',
        component: 'AbovePrompt',
        props: { ...BAND, isWorking: true },
      })
      expect(await text(working, 'cache')).toBe('cache …')
    },
  )
})

describe('band', () => {
  test('a narrow band drops speed first and uses short forms', async ($, on) => {
    const { world, clock, ui } = await start($, on, 'terminal', { ...BAND, bodyColumns: 30 })
    await turn($, clock, world, 't1')
    expect(await text(ui, 'speed')).toBeUndefined()
    expect(await text(ui, 'turn')).toBe('#1')
    expect(await text(ui, 'cost')).toBe('$0.12')
    expect(await text(ui, 'cache')).toBe('60:00')
    expect(await text(ui, 'context')).toBe('12%')
  })

  test('narrow desktop chips drop speed, then turn, then the session total', async ($, on) => {
    const { world, clock, ui } = await start($, on, 'desktop', { ...BAND, bodyColumns: 40 })
    await turn($, clock, world, 't1')
    expect(await text(ui, 'speed')).toBeUndefined()
    expect(await text(ui, 'turn')).toBeUndefined()
    expect(await text(ui, 'cache')).toBe('cache 60:00')
    expect(await text(ui, 'context')).toBe('ctx 12%')
    const cost = (await ui.find({ key: 'cost' }))?.children.find((c) => (c as { type?: string }).type === 'Svg') as
      | { props: { source: string } }
      | undefined
    expect(cost?.props.source).toContain('$0.12')
    expect(cost?.props.source).not.toContain('/ $0.12')
  })

  test('the dismiss button hides and /gauge toggles', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1')

    await ui.press({ key: 'hide' })
    expect(await text(ui, 'turn')).toBeUndefined()
    expect(await gaugeCommand($)).toMatchObject({ text: 'Gauge shown.' })
    expect(await text(ui, 'turn')).toBe('Turn 1')
    expect(await gaugeCommand($)).toMatchObject({ text: 'Gauge hidden.' })
    expect(await text(ui, 'turn')).toBeUndefined()
  })

  test('a survey takes the band', async ($, on) => {
    const { world, clock, ui } = await start($, on, 'terminal', { ...BAND, hasSurvey: true })
    await turn($, clock, world, 't1')
    expect(await text(ui, 'turn')).toBeUndefined()
  })
})

describe('resets', () => {
  test('a main compaction blanks context and cache', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect(await text(ui, 'context')).toBe('ctx -')
    expect(await text(ui, 'cache')).toBe('cache -')
  })

  test('subagent, precompute and skipped compactions keep the readings', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1')
    const messages = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
    await $.session.compact({ trigger: 'manual', agentId: 'agent-1', messages })
    await $.session.compact({ trigger: 'precompute', messages })
    await $.session.compact({ trigger: 'manual', instructions: 'skip', messages })
    expect(await text(ui, 'context')).toBe('ctx 12%')
    expect(await text(ui, 'cache')).toBe('cache 60:00')
  })

  for (const reason of ['clear', 'resume'] as const) {
    test(
      `/${reason} resets the band and stops the warning`,
      { ...LONG, options: { cacheTtlMinutes: 10, warnMinutes: 5 } },
      async ($, on) => {
        const { world, clock, ui } = await start($, on)
        await turn($, clock, world, 't1')
        await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
        expect(await text(ui, 'turn')).toBeUndefined()
        await clock.advance(6 * 60_000)
        expect(world.toasts).toHaveLength(0)
      },
    )
  }

  test('other session ends keep the readings', async ($, on) => {
    const { world, clock, ui } = await start($, on)
    await turn($, clock, world, 't1')
    await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
    expect(await text(ui, 'turn')).toBe('Turn 1')
  })
})
