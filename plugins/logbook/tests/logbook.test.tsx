import type { On, PromptContextResult, PromptOrigin, RenderPropsOf, UiPane } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Logbook',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
type Surface = (typeof SURFACES)[number]

const NOW = 1_000_000

// Fake keys, built from parts: shaped like real ones for the redactor, never one a scanner takes for real.
const FAKE = {
  aws: ['AKIA', 'FAKEFAKEFAKE0000'].join(''),
  github: ['ghp', '_fake0123fake'].join(''),
  openai: ['sk', '-live-0123456789abcdef'].join(''),
  slack: ['xoxb', '-0000-fake'].join(''),
  google: ['AIza', 'FakeFakeFake'].join(''),
  jwt: ['eyJ', 'hbGciOiJub25lIn0'].join(''),
  hex: '0123456789abcdef'.repeat(2),
}

// What each tool answers, as the model reads it: its length / 4 is the entry's tokens.
const OUT: Record<string, string> = {
  Skill: 'Launching skill: finops-custos',
  mcp__datadog__search_logs: 'y'.repeat(8_000),
  mcp__datadog__get_metric: 'y'.repeat(8_000),
  Read: 'r'.repeat(4_000),
  WebFetch: 'w'.repeat(2_000),
  Bash: 'On branch main',
}
const SKILL_TEXT = 'k'.repeat(4_000)

type World = {
  panes: UiPane[]
  opens: number
  tools: number
  /** Tool calls that reached the engine. */
  runs: number
  logs: { text: string; to: string }[]
  prompts: string[]
  context: PromptContextResult[]
  /** Every value the logbook wrote to its state, by key, as JSON. */
  writes: { key: string; json: string }[]
  /** A key whose `$.state.get`, or `$.state.set`, fails for the plugin while set. */
  failGet: string | null
  failSet: string | null
  /** Holds every tool call until it resolves. */
  gate: Promise<void> | null
  /** Raises the skill's prompt through the plugins, as the engine does while the Skill tool runs. */
  loadSkill: (skill: string) => Promise<unknown>
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
    return { model: 'claude-opus-5-5', agentId: `a-${(e.description.split(' ')[0] ?? '').replace(/\p{Cc}/gu, '?')}` }
  })
  on('ui.open', (_$, e) => {
    world.opens += 1
    world.panes = [
      ...world.panes.filter((p) => p.id !== e.id),
      { id: e.id, title: e.title ?? '', isShown: true, isFocused: false, isPlaced: true },
    ]
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    world.panes = world.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: world.panes }))
  on('ui.log', (_$, e) => {
    world.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', async (_$, e) => {
    world.runs += 1
    if (world.gate) await world.gate
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (tool === 'Skill') await world.loadSkill(String(input.skill))
    if (String(input.file_path).includes('denied')) return { deny: 'not allowed' }
    if (String(input.file_path).includes('missing'))
      return { isError: true as const, result: undefined, text: 'File does not exist.' }
    return { result: { ok: true }, text: OUT[tool] ?? 'x'.repeat(400) } as never
  })
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('prompt.context', (_$, e) => {
    const answer: PromptContextResult = { blocks: e.blocks, instructionFiles: e.instructionFiles }
    world.context.push(answer)
    return answer
  })
  // A `{ value: null }` answer makes the plugin's own `$.state` call fail, as a broken host would.
  on('state.get', (_$, e, next) => (world.failGet === e.key ? ({ value: null } as never) : next(e)))
  on('state.set', (_$, e, next) => {
    if (world.failSet === e.key) return { value: null } as never
    world.writes.push({ key: e.key, json: JSON.stringify(e.value) })
    return next(e)
  })
}

const start = async ($: Engine, on: On, surface: Surface = 'terminal') => {
  const world: World = {
    panes: [],
    opens: 0,
    tools: 0,
    runs: 0,
    logs: [],
    prompts: [],
    context: [],
    writes: [],
    failGet: null,
    failSet: null,
    gate: null,
    loadSkill: (skill) => $.skill.prompt({ skill, text: SKILL_TEXT, source: 'userSettings' }),
  }
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  engine(on, world)
  await $.session.start({ cwd: '/x', surface, isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'logbook', surface, component: 'Pane', requestId: 'logbook', props: PANE })
  return { world, clock, ui, session }
}

const mount = ($: Engine, surface: Surface = 'terminal') =>
  $.ui.mount({ plugin: 'logbook', surface, component: 'Pane', requestId: 'logbook', props: PANE })

type Drawn = { type?: string; props?: Record<string, unknown>; children?: readonly unknown[] }

// What a drawing costs the engine: its elements, the characters of its texts and labels, its depth, its keys.
const costOf = (tree: unknown) => {
  const cost = { nodes: 0, chars: 0, depth: 0, keys: [] as string[] }
  const walk = (node: unknown, depth: number) => {
    if (typeof node === 'string') {
      cost.chars += node.length
      return
    }
    if (node === null || typeof node !== 'object') return
    const { type, props, children } = node as Drawn
    cost.nodes += 1
    cost.depth = Math.max(cost.depth, depth)
    if (type === 'Button' && typeof props?.label === 'string') cost.chars += props.label.length
    if (typeof props?.key === 'string') cost.keys.push(props.key)
    for (const child of children ?? []) walk(child, depth + 1)
  }
  walk(tree, 1)
  return cost
}

// Well under what the engine refuses (20,000 nodes, 32 deep) or cuts (100,000 characters).
const BOUND = { nodes: 3_000, chars: 60_000, depth: 8 }

const FULL = 'more than the pane draws: collapse a group or a turn to see the rest'

const prompt = ($: Engine, text: string) => $.turn.start({ text, turnId: `t-${text.length}` })

const answer = ($: Engine, agentId?: string, text = 'done') =>
  $.turn.complete({ answer: text, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId })

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

const spawn = ($: Engine, description: string, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ prompt: 'p', description, subagentType: 'Explore', ...extra } as never)

const PERSON: PromptOrigin = { kind: 'composer' }

const logbook = ($: Engine, args: string, origin: PromptOrigin = PERSON) =>
  $.command.run({ command: 'logbook', args, origin, presentation: { isFullscreen: false, columns: 120 } })

const reply = async ($: Engine, args: string, origin: PromptOrigin = PERSON) =>
  ((await logbook($, args, origin)) as { text: string }).text

type Finder = { find: (q: { key: string }) => Promise<{ text: string; props: Record<string, unknown> } | undefined> }

const text = async (ui: Finder, key: string) => (await ui.find({ key }))?.text

const HINT = ' · /logbook pane'
const NONE = '⚓ logbook · no new sources'

// The per-turn lines, each checked to end with the pointer to the pane but one with nothing to list there,
// and read without it.
const lines = (world: World) =>
  world.logs
    .filter((l) => l.text.startsWith('⚓ logbook'))
    .map((l) => {
      if (l.text === NONE) return l.text
      expect(l.text.endsWith(HINT), l.text).toBe(true)
      return l.text.slice(0, -HINT.length)
    })

const stored = (world: World) => world.writes.map((w) => w.json).join('\n')

const pad = (n: number) => String(n).padStart(2, '0')
const clockOf = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`

// One turn of each main-loop kind: a skill, three MCP calls, a file, a page and a command.
const busyTurn = async ($: Engine) => {
  await prompt($, 'investigate the cost spike in production since Friday please')
  await call($, { tool: 'Skill', skill: 'finops-custos' })
  await call($, { tool: 'mcp__datadog__search_logs', query: 'service:api' })
  await call($, { tool: 'mcp__datadog__search_logs', query: 'service:web' })
  await call($, { tool: 'mcp__datadog__get_metric', query: 'cost' })
  await call($, { tool: 'Read', file_path: '/repo/finops/hooks/report.ts' })
  await call($, { tool: 'WebFetch', url: 'https://docs.example.com/billing/?key=1', prompt: 'p' })
  await call($, { tool: 'Bash', command: `TOKEN=${FAKE.openai} aws ce get-cost-and-usage` })
}

const BUSY_LINE = '⚓ logbook · skill finops-custos · datadog ×3 · 1 file · 1 web · 1 shell · ≈9k tokens in'

describe('pane', () => {
  for (const surface of SURFACES) {
    test(`${surface}: one block per turn, its sources grouped by kind with counts and tokens`, async ($, on) => {
      const { ui } = await start($, on, surface)
      expect(await text(ui, 'empty')).toContain('No sources yet')
      await busyTurn($)
      await answer($)
      const block = (await text(ui, 'turn-1')) ?? ''
      expect(block).toContain('#1')
      expect(block).toContain(clockOf(NOW))
      expect(block).toContain('investigate the cost spike in production since Friday')
      expect(block).not.toContain('please')
      expect(await text(ui, 't1-main-skill')).toBe('▸ skill  1 finops-custos ≈1k')
      expect(await text(ui, 't1-main-mcp')).toBe('▸ mcp    3 datadog · search_logs ×2, datadog · get_metric ≈6k')
      expect(await text(ui, 't1-main-file')).toBe('▸ files  1 hooks/report.ts ≈1k')
      expect(await text(ui, 't1-main-web')).toBe('▸ web    1 docs.example.com/billing ≈500')
      expect(await text(ui, 't1-main-shell')).toBe('▸ shell  1 aws ≈4')
      expect(await text(ui, 'header')).toBe('1 turn · 7 entries')
      expect(await text(ui, 'empty')).toBeUndefined()
    })

    test(`${surface}: subagents nest under the turn that spawned them, with their own sources`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await prompt($, 'scan the repo')
      await spawn($, 'scan')
      await call($, { tool: 'Read', file_path: '/r/src/a.ts', agentId: 'a-scan' })
      await call($, { tool: 'Grep', pattern: 'TODO', path: '/r/src', agentId: 'a-scan' })
      await spawn($, 'deep', { parentAgentId: 'a-scan', subagentType: 'general-purpose' })
      await call($, { tool: 'mcp__github__search_code', agentId: 'a-deep' })
      await answer($)
      await prompt($, 'next question')
      await call($, { tool: 'Bash', command: 'ls -la', agentId: 'a-scan' })
      await answer($, 'a-scan', 'r'.repeat(800))
      await answer($)

      expect(await text(ui, 't1-main-agent')).toBe('▸ agents 1 scan (Explore) ≈200')
      expect(await text(ui, 't1-agent:a-scan')).toBeUndefined()
      await ui.press({ key: 'toggle-t1-main-agent' })
      const scan = (await text(ui, 't1-agent:a-scan')) ?? ''
      expect(scan).toContain('↳ scan (Explore)')
      expect(await text(ui, 't1-a:a-scan-file')).toBe('▸ files  2 src/a.ts, grep in r/src ≈1k')
      expect(await text(ui, 't1-a:a-scan-agent')).toBe('▸ agents 1 deep (general-purpose)')
      expect(await text(ui, 't1-a:a-scan-shell')).toBe('▸ shell  1 ls ≈4')
      await ui.press({ key: 'toggle-t1-a:a-scan-agent' })
      expect(await text(ui, 't1-a:a-deep-mcp')).toBe('▸ mcp    1 github · search_code ≈100')
      expect(await text(ui, 'turn-2')).not.toContain('scan')
      expect(await text(ui, 'turn-2')).toContain('no new sources')
    })

    test(`${surface}: control characters in prompts, descriptions and paths are drawn as spaces`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await prompt($, 'hi\u0001there\u202Eyou\u009b')
      await spawn($, 'sc\u0007an')
      await call($, { tool: 'Read', file_path: '/r/a\u0000b/c\nd.ts' })
      const block = (await text(ui, 'turn-1')) ?? ''
      expect(block).toContain('hi there you')
      expect(block).toContain('sc an (Explore)')
      expect(block).toContain('a b/c d.ts')
      for (const ch of ['\u0000', '\u0001', '\u0007', '\n', '\u202E', '\u009b']) expect(block).not.toContain(ch)
    })

    test(`${surface}: past 20 turns the oldest wait behind a count; past 50 they are gone`, async ($, on) => {
      const { ui } = await start($, on, surface)
      for (let i = 1; i <= 55; i++) {
        await prompt($, `question ${i}`)
        await call($, { tool: 'Read', file_path: `/r/f${i}.ts` })
        await answer($)
      }
      expect(await text(ui, 'header')).toBe('50 turns · 55 entries')
      expect(await text(ui, 'turn-55')).toContain('question 55')
      expect(await text(ui, 'turn-36')).toContain('question 36')
      expect(await text(ui, 'turn-35')).toBeUndefined()
      expect(await text(ui, 'more')).toBe('30 earlier turns not shown')
    })
  }

  for (const surface of SURFACES) {
    const isCard = surface !== 'terminal'
    test(`${surface}: ${isCard ? 'each turn is a card' : 'turns are plain rows'}`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await prompt($, 'one')
      const turn = await ui.find({ key: 'turn-1' })
      expect(turn?.props.borderStyle).toBe(isCard ? 'round' : undefined)
      const kind = (await ui.find({ key: 'turn-1' }))?.text ?? ''
      expect(kind).toContain('no new sources')
    })
  }

  test('a turn keeps its latest 200 entries and every agent', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'big')
    await spawn($, 'early')
    for (let i = 0; i < 250; i++) await call($, { tool: 'Read', file_path: `/r/f${i}.ts` })
    expect(await text(ui, 't1-main-agent')).toContain('early (Explore)')
    expect(await text(ui, 't1-main-file')).toContain('files  199 ')
    expect(await text(ui, 'turn-1')).toContain('51 older entries dropped')
    expect(await text(ui, 'header')).toBe('1 turn · 251 entries')
  })

  test('past 200 agents in a turn the oldest agents give way too', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'swarm')
    for (let i = 0; i < 210; i++) await spawn($, `w${i}`)
    expect(await text(ui, 't1-main-agent')).toContain('agents 200 w10 (Explore)')
    expect(await text(ui, 'turn-1')).toContain('10 older entries dropped')
  })

  test("a busy subagent gives way before the conversation's own sources and a quieter agent's", async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'one')
    for (let i = 0; i < 5; i++) await call($, { tool: 'Read', file_path: `/r/main${i}.ts` })
    await spawn($, 'mate', { isTeammate: true })
    await spawn($, 'quiet')
    for (let i = 0; i < 10; i++) await call($, { tool: 'Read', file_path: `/r/q${i}.ts`, agentId: 'a-quiet' })
    await answer($)
    await prompt($, 'two')
    await answer($)
    for (let i = 0; i < 250; i++) await call($, { tool: 'Read', file_path: `/r/t${i}.ts`, agentId: 'a-mate' })
    expect(await text(ui, 't1-main-file')).toContain('files  5 ')
    await ui.press({ key: 'toggle-t1-main-agent' })
    expect(await text(ui, 't1-a:a-quiet-file')).toContain('files  10 ')
    expect(await text(ui, 't1-a:a-mate-file')).toContain('files  183 ')
    expect(await text(ui, 'turn-1')).toContain('67 older entries dropped')
  })

  test('sources waiting for a turn are bounded to 200', async ($, on) => {
    const { ui } = await start($, on)
    for (let i = 0; i < 205; i++) await $.skill.prompt({ skill: `s${i}`, text: 'x', source: 'userSettings' })
    expect(await text(ui, 'pending')).toContain('skill  200 s5,')
    await prompt($, 'go')
    expect(await text(ui, 't1-main-skill')).toContain('skill  200 s5,')
    expect(await text(ui, 'header')).toBe('1 turn · 205 entries')
  })

  test('the title keeps text between < and >, drops markup and stops at eight words', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, '<command-name>/review</command-name> is a < b and c > d here or not')
    expect(await text(ui, 'turn-1')).toContain('/review is a < b and c >')
    expect(await text(ui, 'turn-1')).not.toContain('command-name')
    expect(await text(ui, 'turn-1')).not.toContain('d here')
  })
})

describe('expandable groups', () => {
  const TERMINAL_AND_DESKTOP = ['terminal', 'desktop'] as const

  for (const surface of SURFACES) {
    test(`${surface}: pressing a group lists its items; pressing it again folds it`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await busyTurn($)
      await call($, { tool: 'Bash', command: 'git status' })
      await call($, { tool: 'Bash', command: 'git log' })
      await call($, { tool: 'Read', file_path: '/r/missing.ts' })
      await answer($)
      expect((await ui.find({ key: 'toggle-t1-main-shell' }))?.type).toBe('Button')
      expect(await text(ui, 't1-main-shell')).toBe('▸ shell  3 aws, git ×2 ≈12')
      expect(await text(ui, 't1-main-shell.0')).toBeUndefined()

      await ui.press({ key: 'toggle-t1-main-shell' })
      expect(await text(ui, 't1-main-shell')).toBe('▾ shell  3 ≈12')
      expect(await text(ui, 't1-main-shell.0')).toBe('aws ≈4')
      expect(await text(ui, 't1-main-shell.1')).toBe('git ×2 ≈8')

      for (const kind of ['mcp', 'file', 'web', 'skill']) await ui.press({ key: `toggle-t1-main-${kind}` })
      expect(await text(ui, 't1-main-mcp.0')).toBe('datadog · search_logs ×2 ≈4k')
      expect(await text(ui, 't1-main-mcp.1')).toBe('datadog · get_metric ≈2k')
      expect(await text(ui, 't1-main-file.0')).toBe('hooks/report.ts ≈1k')
      expect(await text(ui, 't1-main-file.1')).toBe('r/missing.ts (1 failed) ≈5')
      expect(await text(ui, 't1-main-web.0')).toBe('docs.example.com/billing ≈500')
      expect(await text(ui, 't1-main-skill.0')).toBe('finops-custos user ≈1k')

      await ui.press({ key: 'toggle-t1-main-shell' })
      expect(await text(ui, 't1-main-shell')).toBe('▸ shell  3 aws, git ×2 ≈12')
      expect(await text(ui, 't1-main-shell.0')).toBeUndefined()
      expect(await text(ui, 't1-main-file.0')).toBe('hooks/report.ts ≈1k')
    })
  }

  for (const surface of TERMINAL_AND_DESKTOP) {
    test(`${surface}: the agents group opens into each subagent and its own groups, nested`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await prompt($, 'scan the repo')
      await spawn($, 'scan')
      await call($, { tool: 'Read', file_path: '/r/src/a.ts', agentId: 'a-scan' })
      await call($, { tool: 'Bash', command: 'rg TODO', agentId: 'a-scan' })
      await call($, { tool: 'Bash', command: 'rg FIXME', agentId: 'a-scan' })
      await spawn($, 'deep', { parentAgentId: 'a-scan', subagentType: 'general-purpose' })
      await call($, { tool: 'mcp__github__search_code', agentId: 'a-deep' })
      await spawn($, 'idle')
      await answer($, 'a-scan', 'r'.repeat(800))
      await answer($)
      expect(await text(ui, 't1-main-agent')).toBe('▸ agents 2 scan (Explore), idle (Explore) ≈200')
      expect(await text(ui, 't1-agent:a-scan')).toBeUndefined()

      await ui.press({ key: 'toggle-t1-main-agent' })
      expect(await text(ui, 't1-agent:a-scan')).toBe('↳ scan (Explore) ≈1k inside ≈200')
      expect(await text(ui, 't1-agent:a-idle')).toBe('↳ idle (Explore) no sources')
      expect(await text(ui, 't1-a:a-scan-file')).toBe('▸ files  1 src/a.ts ≈1k')
      expect(await text(ui, 't1-a:a-scan-shell')).toBe('▸ shell  2 rg ×2 ≈8')
      expect(await text(ui, 't1-a:a-scan-agent')).toBe('▸ agents 1 deep (general-purpose)')
      expect(await text(ui, 't1-agent:a-deep')).toBeUndefined()

      await ui.press({ key: 'toggle-t1-a:a-scan-shell' })
      expect(await text(ui, 't1-a:a-scan-shell.0')).toBe('rg ×2 ≈8')
      await ui.press({ key: 'toggle-t1-a:a-scan-agent' })
      expect(await text(ui, 't1-agent:a-deep')).toBe('↳ deep (general-purpose) ≈100 inside')
      expect(await text(ui, 't1-a:a-deep-mcp')).toBe('▸ mcp    1 github · search_code ≈100')
      await ui.press({ key: 'toggle-t1-a:a-deep-mcp' })
      expect(await text(ui, 't1-a:a-deep-mcp.0')).toBe('github · search_code ≈100')

      await ui.press({ key: 'toggle-t1-main-agent' })
      expect(await text(ui, 't1-agent:a-scan')).toBeUndefined()
      expect(await text(ui, 't1-a:a-deep-mcp')).toBeUndefined()
      await ui.press({ key: 'toggle-t1-main-agent' })
      expect(await text(ui, 't1-a:a-deep-mcp.0')).toBe('github · search_code ≈100')
    })

    test(`${surface}: expand all opens every group of a turn, nested ones too; collapse all folds them`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await prompt($, 'first')
      await call($, { tool: 'Read', file_path: '/r/one.ts' })
      await answer($)
      await busyTurn($)
      await spawn($, 'scan')
      await call($, { tool: 'Read', file_path: '/r/src/a.ts', agentId: 'a-scan' })
      await answer($)
      await ui.press({ key: 'toggle-t1-main-file' })
      expect((await ui.find({ key: 'all-t2' }))?.text).toBe('expand all')

      await ui.press({ key: 'all-t2' })
      expect((await ui.find({ key: 'all-t2' }))?.text).toBe('collapse all')
      expect(await text(ui, 't2-main-mcp.0')).toBe('datadog · search_logs ×2 ≈4k')
      expect(await text(ui, 't2-agent:a-scan')).toContain('↳ scan (Explore)')
      expect(await text(ui, 't2-a:a-scan-file.0')).toBe('src/a.ts ≈1k')

      await ui.press({ key: 'toggle-t2-main-mcp' })
      expect(await text(ui, 't2-main-mcp.0')).toBeUndefined()
      expect(await text(ui, 't2-main-file.0')).toBe('hooks/report.ts ≈1k')
      expect((await ui.find({ key: 'all-t2' }))?.text).toBe('collapse all')

      await ui.press({ key: 'all-t2' })
      expect((await ui.find({ key: 'all-t2' }))?.text).toBe('expand all')
      for (const kind of ['skill', 'mcp', 'file', 'web', 'agent', 'shell'])
        expect(await text(ui, `t2-main-${kind}`), kind).toMatch(/^▸ /)
      expect(await text(ui, 't2-agent:a-scan')).toBeUndefined()
      expect(await text(ui, 't1-main-file.0')).toBe('r/one.ts ≈1k')
      expect((await ui.find({ key: 'all-t1' }))?.text).toBe('collapse all')
    })

    test(`${surface}: what is expanded survives redraws, remounts and new sources`, async ($, on) => {
      const { ui } = await start($, on, surface)
      await busyTurn($)
      await ui.press({ key: 'toggle-t1-main-file' })
      await call($, { tool: 'Read', file_path: '/r/later.ts' })
      expect(await text(ui, 't1-main-file.1')).toBe('r/later.ts ≈1k')
      await ui.redraw()
      expect(await text(ui, 't1-main-file.0')).toBe('hooks/report.ts ≈1k')
      await ui.unmount()
      const again = await $.ui.mount({
        plugin: 'logbook',
        surface,
        component: 'Pane',
        requestId: 'logbook',
        props: PANE,
      })
      expect(await text(again, 't1-main-file.1')).toBe('r/later.ts ≈1k')
      expect(await text(again, 't1-main-mcp.0')).toBeUndefined()
    })

    test(`${surface}: the latest 100 choices are kept, the oldest fold back`, { timeoutMs: 60_000 }, async ($, on) => {
      const { world, ui } = await start($, on, surface)
      await ui.unmount()
      for (let t = 1; t <= 20; t++) {
        await prompt($, `turn ${t}`)
        await call($, { tool: 'mcp__datadog__get_metric' })
        await call($, { tool: 'Read', file_path: `/r/f${t}.ts` })
        await call($, { tool: 'WebSearch', query: 'q' })
        await spawn($, `w${t}`)
        await call($, { tool: 'Bash', command: 'ls' })
        await call($, { tool: 'Edit', file_path: `/r/f${t}.ts` })
        await answer($)
      }
      const pane = await $.ui.mount({
        plugin: 'logbook',
        surface,
        component: 'Pane',
        requestId: 'logbook',
        props: PANE,
      })
      for (let t = 1; t <= 20; t++)
        for (const kind of ['mcp', 'file', 'web', 'agent', 'shell', 'other'])
          await pane.press({ key: `toggle-t${t}-main-${kind}` })
      // 120 choices: the oldest 20 (turns 1 to 3, then turn 4's mcp and file) went.
      const last = world.writes.filter((w) => w.key === 'expanded').at(-1)?.json ?? '{}'
      expect(Object.keys(JSON.parse(last) as object)).toHaveLength(100)
      expect(await text(pane, 't1-main-mcp')).toMatch(/^▸ /)
      expect(await text(pane, 't3-main-other')).toMatch(/^▸ /)
      expect(await text(pane, 't4-main-file')).toMatch(/^▸ /)
      expect(await text(pane, 't4-main-web')).toMatch(/^▾ /)
      expect(await text(pane, 't20-main-other')).toMatch(/^▾ /)
    })
  }

  test('a tool call writes only its turn and the count, with groups expanded; a press writes only what is expanded', async ($, on) => {
    const { world, ui } = await start($, on)
    await busyTurn($)
    await ui.press({ key: 'toggle-t1-main-file' })
    await ui.press({ key: 'all-t1' })
    world.writes = []
    await call($, { tool: 'Read', file_path: '/r/a.ts' })
    await call($, { tool: 'Bash', command: 'git status' })
    expect([...new Set(world.writes.map((w) => w.key))].sort()).toEqual(['recorded', 'turn'])
    world.writes = []
    await ui.press({ key: 'toggle-t1-main-shell' })
    await ui.press({ key: 'all-t1' })
    expect(world.writes.map((w) => w.key)).toEqual(['expanded', 'expanded'])
    expect(stored(world)).not.toContain('git')
  })

  test('expanded rows keep labels only: no pattern, query, command line, output or key', async ($, on) => {
    const { world, ui } = await start($, on)
    await busyTurn($)
    await call($, { tool: 'WebSearch', query: `error ${FAKE.github} invalid`, mode: 'standard' })
    await call($, { tool: 'Bash', command: `cd /a\n${FAKE.aws}` })
    await spawn($, `rotate ${FAKE.google}`)
    await call($, { tool: 'Read', file_path: `/home/dev/${FAKE.hex}/notes.md`, agentId: 'a-rotate' })
    await $.skill.prompt({ skill: 'commit', text: 'c', source: 'plugin', pluginName: `tools ${FAKE.slack}` })
    await ui.press({ key: 'all-t1' })
    expect(await text(ui, 't1-main-skill.1')).toBe('commit plugin tools …')
    const shown = [(await text(ui, 'turn-1')) ?? '', stored(world)].join('\n')
    expect(shown).toContain('rotate …')
    expect(shown).toContain('…/notes.md')
    expect(await text(ui, 't1-main-shell.1')).toBe('shell ≈4')
    for (const secret of Object.values(FAKE)) expect(shown, secret).not.toContain(secret)
    for (const input of ['get-cost-and-usage', 'service:api', 'key=1', 'invalid', 'rrrr', 'yyyy'])
      expect(shown, input).not.toContain(input)
  })

  test('the line points to the pane; a new session and clear fold every group', async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'x')
    await call($, { tool: 'Read', file_path: '/r/a.ts' })
    await answer($)
    expect(world.logs.at(-1)?.text).toBe('⚓ logbook · 1 file · ≈1k tokens in · /logbook pane')
    expect(await reply($, 'help')).toContain('press a group to list its sources')
    await ui.press({ key: 'toggle-t1-main-file' })
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
    await prompt($, 'y')
    await call($, { tool: 'Read', file_path: '/r/b.ts' })
    expect(await text(ui, 't1-main-file')).toBe('▸ files  1 r/b.ts ≈1k')
    await ui.press({ key: 'toggle-t1-main-file' })
    expect(await text(ui, 't1-main-file')).toMatch(/^▾ /)
    expect(await reply($, 'clear')).toBe('Logbook cleared.')
    expect(world.writes.filter((w) => w.key === 'expanded').at(-1)?.json).toBe('{}')
    await call($, { tool: 'Read', file_path: '/r/c.ts' })
    expect(await text(ui, 't1-main-file')).toBe('▸ files  1 r/c.ts ≈1k')
  })
})

describe('drawing cost', () => {
  const word = (n: number) => [...String(n)].map((d) => 'abcdefghij'[Number(d)]).join('')
  const path = (t: number, i: number) =>
    `/repo/shared-components-library/widget-${word(t)}-${word(i)}-component-file.tsx`

  // Turns of 200 reads each, every path a label of its own of about 55 characters.
  const busy = async ($: Engine, turns: number) => {
    for (let t = 1; t <= turns; t++) {
      await prompt($, `turn ${t}`)
      for (let i = 0; i < 200; i++) await call($, { tool: 'Read', file_path: path(t, i) })
      await answer($)
    }
  }

  test(
    '20 folded turns of 200 long labels: each row names 8 items, every turn keeps its buttons',
    { timeoutMs: 300_000 },
    async ($, on) => {
      const { ui: first } = await start($, on)
      await first.unmount()
      await busy($, 20)
      const ui = await mount($)
      const cost = costOf(await ui.drawn())
      expect(cost.nodes).toBeLessThan(BOUND.nodes)
      expect(cost.chars).toBeLessThan(BOUND.chars)
      const row = (await text(ui, 't1-main-file')) ?? ''
      expect(row.startsWith('▸ files  200 shared-components-library/widget-b-a-component-file.tsx, ')).toBe(true)
      expect(row.endsWith(' +192 ≈200k')).toBe(true)
      for (let t = 1; t <= 20; t++) expect((await ui.find({ key: `toggle-t${t}-main-file` }))?.type).toBe('Button')
      await ui.press({ key: 'toggle-t1-main-file' })
      expect(await text(ui, 't1-main-file.0')).toBe('shared-components-library/widget-b-a-component-file.tsx ≈1k')
      expect(await text(ui, 't1-main-file.29')).toBeDefined()
      expect(await text(ui, 't1-main-file.30')).toBeUndefined()
      expect(await text(ui, 't1-main-file.more')).toBe('+170 more')
    },
  )

  test(
    '20 turns of 200 sources, every one expanded: the pane draws within its bounds and every turn keeps its control',
    { timeoutMs: 300_000 },
    async ($, on) => {
      const { ui: first } = await start($, on)
      await first.unmount()
      await busy($, 20)
      const ui = await mount($)
      const folded = costOf(await ui.drawn())
      for (let t = 1; t <= 20; t++) await ui.press({ key: `all-t${t}` })
      const open = costOf(await ui.drawn())
      expect(open.nodes).toBeLessThan(BOUND.nodes)
      expect(open.chars).toBeLessThan(BOUND.chars)
      expect(open.depth).toBeLessThanOrEqual(BOUND.depth)
      expect(open.nodes).toBeGreaterThan(folded.nodes)
      expect(await text(ui, 't20-main-file.29')).toBeDefined()
      expect(await text(ui, 't20-main-file.more')).toBe('+170 more')
      expect(await text(ui, 't1-full')).toBe(FULL)
      expect(await text(ui, 't1-main-file')).toBeUndefined()
      for (let t = 1; t <= 20; t++) expect((await ui.find({ key: `all-t${t}` }))?.text, `t${t}`).toBe('collapse all')

      await ui.unmount()
      const again = await mount($)
      expect(costOf(await again.drawn()).nodes).toBeLessThan(BOUND.nodes)
      for (let t = 2; t <= 20; t++) await again.press({ key: `all-t${t}` })
      expect(await text(again, 't1-full')).toBeUndefined()
      expect(await text(again, 't1-main-file.0')).toBe('shared-components-library/widget-b-a-component-file.tsx ≈1k')
      await again.press({ key: 'all-t1' })
      expect((await again.find({ key: 'all-t1' }))?.text).toBe('expand all')
      expect(await text(again, 't1-main-file')).toMatch(/^▸ /)
    },
  )

  test('an open agents group lists 30 subagents and counts the rest; so does the foot of the turn', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'swarm')
    for (let i = 0; i < 40; i++) await spawn($, `w${i}`)
    for (let i = 0; i < 35; i++) await call($, { tool: 'Read', file_path: `/r/f${i}.ts`, agentId: `resumed-${i}` })
    expect(await text(ui, 't1-agent:resumed-29')).toBe('↳ agent resumed… ≈1k inside')
    expect(await text(ui, 't1-agent:resumed-30')).toBeUndefined()
    expect(await text(ui, 't1-foot.more')).toBe('+5 more')
    await ui.press({ key: 'all-t1' })
    expect(await text(ui, 't1-agent:a-w29')).toBe('↳ w29 (Explore) no sources')
    expect(await text(ui, 't1-agent:a-w30')).toBeUndefined()
    expect(await text(ui, 't1-main-agent.more')).toBe('+10 more')
    expect(await text(ui, 't1-a:resumed-29-file.0')).toBe('r/f29.ts ≈1k')
    const cost = costOf(await ui.drawn())
    expect(cost.nodes).toBeLessThan(BOUND.nodes)
    expect(cost.chars).toBeLessThan(BOUND.chars)
  })

  test('a chain of 40 nested subagents draws flat, indented no further than the bound', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'deep')
    await spawn($, 'd0')
    for (let i = 1; i < 40; i++) await spawn($, `d${i}`, { parentAgentId: `a-d${i - 1}` })
    await call($, { tool: 'Read', file_path: '/r/bottom.ts', agentId: 'a-d39' })
    await ui.press({ key: 'all-t1' })
    const cost = costOf(await ui.drawn())
    expect(cost.depth).toBeLessThanOrEqual(BOUND.depth)
    expect(await text(ui, 't1-agent:a-d39')).toBe('↳ d39 (Explore) ≈1k inside')
    expect(await text(ui, 't1-a:a-d39-file.0')).toBe('r/bottom.ts ≈1k')
    expect((await ui.find({ key: 't1-agent:a-d39' }))?.props.paddingLeft).toBe(24)
    expect((await ui.find({ key: 't1-agent:a-d0' }))?.props.paddingLeft).toBe(6)
  })
})

describe('pane keys and groups', () => {
  test('subagents whose ids read main, agent or a kind keep rows and groups of their own', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'ids')
    await call($, { tool: 'Read', file_path: '/r/own.ts' })
    for (const id of ['main', 'agent', 'file']) await call($, { tool: 'Read', file_path: `/r/${id}.ts`, agentId: id })
    const keys = costOf(await ui.drawn()).keys
    expect(new Set(keys).size).toBe(keys.length)
    await ui.press({ key: 'toggle-t1-main-file' })
    expect(await text(ui, 't1-main-file.0')).toBe('r/own.ts ≈1k')
    expect(await text(ui, 't1-agent:main')).toBe('↳ agent main ≈1k inside')
    expect(await text(ui, 't1-a:main-file')).toBe('▸ files  1 r/main.ts ≈1k')
    await ui.press({ key: 'toggle-t1-a:agent-file' })
    expect(await text(ui, 't1-a:agent-file.0')).toBe('r/agent.ts ≈1k')
    expect(await text(ui, 't1-agent:file')).toBe('↳ agent file ≈1k inside')
    expect(await text(ui, 't1-a:file-file')).toMatch(/^▸ /)
    const after = costOf(await ui.drawn()).keys
    expect(new Set(after).size).toBe(after.length)
  })

  test('subagents whose spawns name each other show at the foot of the turn', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'loop')
    await spawn($, 'x', { parentAgentId: 'a-y' })
    await spawn($, 'y', { parentAgentId: 'a-x' })
    await spawn($, 'z', { parentAgentId: 'a-z' })
    await call($, { tool: 'Read', file_path: '/r/x.ts', agentId: 'a-x' })
    expect(await text(ui, 't1-agent:a-y')).toBe('↳ y (Explore)')
    expect(await text(ui, 't1-agent:a-z')).toBe('↳ z (Explore)')
    expect(await text(ui, 't1-agent:a-x')).toBeUndefined()
    await ui.press({ key: 'toggle-t1-a:a-y-agent' })
    expect(await text(ui, 't1-agent:a-x')).toBe('↳ x (Explore) ≈1k inside')
    expect(await text(ui, 'header')).toBe('1 turn · 4 entries')
  })

  test('collapse all counts only the groups in view', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'scan')
    await spawn($, 'scan')
    await call($, { tool: 'Read', file_path: '/r/a.ts', agentId: 'a-scan' })
    await ui.press({ key: 'toggle-t1-main-agent' })
    await ui.press({ key: 'toggle-t1-a:a-scan-file' })
    expect((await ui.find({ key: 'all-t1' }))?.text).toBe('collapse all')
    await ui.press({ key: 'toggle-t1-main-agent' })
    expect(await text(ui, 't1-a:a-scan-file')).toBeUndefined()
    expect((await ui.find({ key: 'all-t1' }))?.text).toBe('expand all')
  })

  test('folding a group back to how its turn draws it forgets the choice', async ($, on) => {
    const { world, ui } = await start($, on)
    await busyTurn($)
    const last = () => world.writes.filter((w) => w.key === 'expanded').at(-1)?.json
    await ui.press({ key: 'toggle-t1-main-file' })
    expect(last()).toBe('{"t1-main-file":true}')
    await ui.press({ key: 'toggle-t1-main-file' })
    expect(last()).toBe('{}')
    await ui.press({ key: 'all-t1' })
    await ui.press({ key: 'toggle-t1-main-file' })
    expect(last()).toBe('{"t1":true,"t1-main-file":false}')
    await ui.press({ key: 'toggle-t1-main-file' })
    expect(last()).toBe('{"t1":true}')
  })

  test('what was expanded among the waiting sources is forgotten once a turn takes them', async ($, on) => {
    const { world, ui } = await start($, on)
    await $.skill.prompt({ skill: 'commit', text: 'c'.repeat(800), source: 'userSettings' })
    await ui.press({ key: 'toggle-pending-main-skill' })
    expect(await text(ui, 'pending-main-skill')).toMatch(/^▾ /)
    await prompt($, '/commit')
    expect(world.writes.filter((w) => w.key === 'expanded').at(-1)?.json).toBe('{}')
    await answer($)
    await $.skill.prompt({ skill: 'review', text: 'r', source: 'userSettings' })
    expect(await text(ui, 'pending-main-skill')).toMatch(/^▸ /)
  })
})

describe('per-turn line', () => {
  test('one line under each main turn, in the transcript; tool calls and subagents add none', async ($, on) => {
    const { world } = await start($, on)
    await busyTurn($)
    await spawn($, 'helper')
    await answer($, 'a-helper')
    expect(lines(world)).toEqual([])
    const done = (await answer($)) as { text: string }
    expect(done.text).toBe('done')
    expect(lines(world)).toEqual([
      '⚓ logbook · skill finops-custos · datadog ×3 · 1 file · 1 web · 1 agent · 1 shell · ≈9k tokens in',
    ])
    expect(world.logs.filter((l) => l.text.startsWith('⚓')).map((l) => l.to)).toEqual(['transcript'])
  })

  test('each line covers its own turn only; a turn with no new sources says so', async ($, on) => {
    const { world } = await start($, on)
    await busyTurn($)
    await answer($)
    await prompt($, 'thanks')
    await answer($)
    await prompt($, 'one more file')
    await call($, { tool: 'Read', file_path: '/r/x.ts' })
    await answer($)
    expect(lines(world)).toEqual([BUSY_LINE, '⚓ logbook · no new sources', '⚓ logbook · 1 file · ≈1k tokens in'])
  })

  test('an interrupted turn still logs its line', async ($, on) => {
    const { world } = await start($, on)
    await prompt($, 'x')
    await call($, { tool: 'Read', file_path: '/r/a.ts' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't', reason: 'aborted' })
    expect(lines(world)).toEqual(['⚓ logbook · 1 file · ≈1k tokens in'])
  })

  test('/logbook details lists every source on the line', async ($, on) => {
    const { world } = await start($, on)
    expect(await reply($, 'details')).toBe('Details on: the per-turn line lists every source.')
    await busyTurn($)
    await answer($)
    expect(lines(world)).toEqual([
      '⚓ logbook · skill finops-custos · datadog search_logs ×2, get_metric · files hooks/report.ts · web docs.example.com/billing · shell aws · ≈9k tokens in',
    ])
    expect(await reply($, 'details')).toBe('Details off: the per-turn line counts sources.')
  })

  test(
    'with summary off no line is shown, and the pane still records',
    { options: { summary: false } },
    async ($, on) => {
      const { world, ui } = await start($, on)
      await busyTurn($)
      await answer($)
      expect(lines(world)).toEqual([])
      expect(await text(ui, 'header')).toBe('1 turn · 7 entries')
      expect(await reply($, '')).toContain('per-turn line off (option)')
      expect(await reply($, 'on')).toBe('Logbook on: recording resumes.')
    },
  )

  test('what subagents read for themselves is counted apart from what the conversation took in', async ($, on) => {
    const { world } = await start($, on)
    await prompt($, 'scan')
    await spawn($, 'scan')
    await call($, { tool: 'Read', file_path: '/r/a.ts', agentId: 'a-scan' })
    await answer($, 'a-scan', 'r'.repeat(2_000))
    await answer($)
    expect(lines(world)).toEqual(['⚓ logbook · 1 file · 1 agent · ≈500 tokens in · ≈1k inside agents'])
  })
})

describe('sources', () => {
  test("a Skill call and the prompt it loads are one entry, with the prompt's tokens", async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'costs')
    await call($, { tool: 'Skill', skill: 'finops-custos' })
    expect(await text(ui, 't1-main-skill')).toBe('▸ skill  1 finops-custos ≈1k')
  })

  test('a skill typed before the turn opens joins that turn, and lists its source', async ($, on) => {
    const { world, ui } = await start($, on)
    await $.skill.prompt({ skill: 'commit', text: 'c'.repeat(800), source: 'plugin', pluginName: 'tools' })
    expect(await text(ui, 'pending')).toContain('commit')
    await prompt($, '/commit')
    await answer($)
    expect(await text(ui, 'pending')).toBeUndefined()
    expect(await text(ui, 't1-main-skill')).toBe('▸ skill  1 commit ≈200')
    expect(lines(world)).toEqual(['⚓ logbook · skill commit · ≈200 tokens in'])
    expect(stored(world)).toContain('"label":"commit","detail":"plugin tools"')
  })

  test('instruction files are recorded once, and again when one changes', async ($, on) => {
    const { world, ui } = await start($, on)
    const files = (project: string) => [
      { path: '/home/dev/.claude/CLAUDE.md', kind: 'user' as const, content: 'u'.repeat(400) },
      { path: '/repo/CLAUDE.md', kind: 'project' as const, content: project },
    ]
    await $.prompt.context({ blocks: [], instructionFiles: files('p'.repeat(800)) })
    await prompt($, 'first')
    await $.prompt.context({ blocks: [], instructionFiles: files('p'.repeat(800)) })
    await answer($)
    await prompt($, 'second')
    await $.prompt.context({ blocks: [], instructionFiles: files('q'.repeat(1_200)) })
    await answer($)
    expect(await text(ui, 't1-main-instructions')).toBe('▸ instr  2 .claude/CLAUDE.md, repo/CLAUDE.md ≈300')
    expect(await text(ui, 't2-main-instructions')).toBe('▸ instr  1 repo/CLAUDE.md ≈300')
    expect(lines(world)).toEqual([
      '⚓ logbook · 2 instruction files · ≈300 tokens in',
      '⚓ logbook · 1 instruction file · ≈300 tokens in',
    ])
  })

  test('instruction files from sets that alternate are each recorded once', async ($, on) => {
    const { world } = await start($, on)
    const user = { path: '/u/.claude/CLAUDE.md', kind: 'user' as const, content: 'u'.repeat(400) }
    const repo = { path: '/repo/CLAUDE.md', kind: 'project' as const, content: 'p'.repeat(400) }
    const tree = { path: '/wt/CLAUDE.md', kind: 'project' as const, content: 'w'.repeat(400) }
    await prompt($, 'one')
    await $.prompt.context({ blocks: [], instructionFiles: [user, repo] })
    await $.prompt.context({ blocks: [], instructionFiles: [user, tree] })
    await $.prompt.context({ blocks: [], instructionFiles: [user, repo] })
    await answer($)
    expect(lines(world)).toEqual(['⚓ logbook · 3 instruction files · ≈300 tokens in'])
  })

  test('denied calls are not recorded; failed ones are, marked', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'read')
    await call($, { tool: 'Read', file_path: '/r/denied.ts' })
    await call($, { tool: 'Read', file_path: '/r/missing.ts' })
    expect(await text(ui, 't1-main-file')).toBe('▸ files  1 r/missing.ts (1 failed) ≈5')
  })

  test('other tools are classified as other, by name', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'edit')
    await call($, { tool: 'Edit', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })
    await call($, { tool: 'TodoWrite', todos: [] })
    await call($, { tool: 'Edit', file_path: '/r/b.ts', old_string: 'a', new_string: 'b' })
    expect(await text(ui, 't1-main-other')).toBe('▸ other  3 Edit ×2, TodoWrite ≈300')
  })

  test('the log keeps labels only: no pattern, query, URL path, command line, output or key', async ($, on) => {
    const { world, ui } = await start($, on)
    await reply($, 'details')
    await busyTurn($)
    await call($, { tool: 'Grep', pattern: FAKE.aws, path: `/repo/${FAKE.hex}` })
    await call($, { tool: 'Glob', pattern: `**/${FAKE.openai}*`, path: '/repo/src' })
    await call($, { tool: 'WebSearch', query: `error ${FAKE.github} invalid`, mode: 'standard' })
    await call($, { tool: 'WebFetch', url: `https://mainnet.infura.io/v3/${FAKE.hex}`, prompt: 'p' })
    await call($, { tool: 'WebFetch', url: `data:text/plain,${FAKE.jwt}`, prompt: 'p' })
    await call($, { tool: 'Bash', command: `cd /a\n${FAKE.aws}` })
    await call($, { tool: 'mcp__datadog__search_logs', query: `token:${FAKE.slack}` })
    await spawn($, `rotate ${FAKE.google}`)
    await call($, { tool: 'Read', file_path: `/home/dev/${FAKE.hex}/notes.md`, agentId: 'a-rotate' })
    await answer($)
    await prompt($, `use ${FAKE.openai} and ${FAKE.aws} to call the api`)
    const shown = [
      stored(world),
      ...lines(world),
      await reply($, ''),
      (await text(ui, 'turn-1')) ?? '',
      (await text(ui, 'turn-2')) ?? '',
    ].join('\n')
    expect(shown).toContain('"label":"aws"')
    expect(shown).toContain('grep in repo/…')
    expect(shown).toContain('glob in repo/src')
    expect(shown).toContain('web search')
    expect(shown).toContain('mainnet.infura.io/v3')
    expect(shown).toContain('data:')
    expect(shown).toContain('rotate …')
    expect(shown).toContain('…/notes.md')
    expect(shown).toContain('use … and … to call the api')
    for (const secret of Object.values(FAKE)) expect(shown, secret).not.toContain(secret)
    for (const input of ['get-cost-and-usage', 'service:api', 'key=1', 'invalid', 'rrrr', 'yyyy'])
      expect(shown, input).not.toContain(input)
    expect(await text(ui, 't1-main-shell')).toBe('▸ shell  2 aws, shell ≈8')
  })

  const helper: Plugin = {
    name: 'helper',
    register: (on) => {
      on('session.start', async ($, e, next) => {
        const result = await next(e)
        await $.command.register({ name: 'helper', description: 'Reads a file and starts an agent of its own' })
        return result
      })
      on('command.run', { command: 'helper' }, async ($) => {
        await $.tool.call({ tool: 'Read', file_path: '/helper/notes.md' })
        await $.agent.spawn({ prompt: 'p', description: 'helper agent' })
        return { text: 'ok' }
      })
    },
  }

  test(
    "a plugin's own tool calls and agents are not the conversation's sources",
    { plugins: [helper] },
    async ($, on) => {
      const { ui } = await start($, on)
      await prompt($, 'go')
      await $.command.run({
        command: 'helper',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      })
      await call($, { tool: 'Read', file_path: '/r/by-helper-agent.ts', agentId: 'a-helper' })
      await spawn($, 'child', { parentAgentId: 'a-helper' })
      await call($, { tool: 'Read', file_path: '/r/by-child.ts', agentId: 'a-child' })
      expect(await text(ui, 'turn-1')).toContain('no new sources')
      expect(await text(ui, 'header')).toBe('1 turn · 0 entries')
    },
  )

  test('an agent no spawn announced files its sources under the open turn', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'resume')
    await call($, { tool: 'Read', file_path: '/r/a.ts', agentId: 'resumed-1234567890' })
    expect(await text(ui, 't1-agent:resumed-1234567890')).toContain('↳ agent resumed…')
  })
})

describe('subagents and parallel calls', () => {
  test('parallel calls in one turn all land', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'par')
    await Promise.all(Array.from({ length: 12 }, (_, i) => call($, { tool: 'Read', file_path: `/r/p${i}.ts` })))
    expect(await text(ui, 't1-main-file')).toContain('files  12 ')
    expect(await text(ui, 'header')).toBe('1 turn · 12 entries')
  })

  test("parallel calls of the main loop and a subagent, and the subagent's answer, all land", async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'mix')
    await spawn($, 'bg')
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => call($, { tool: 'Read', file_path: `/r/m${i}.ts` })),
      ...Array.from({ length: 8 }, (_, i) => call($, { tool: 'Read', file_path: `/r/a${i}.ts`, agentId: 'a-bg' })),
      answer($, 'a-bg', 'r'.repeat(4_000)),
    ])
    expect(await text(ui, 't1-main-file')).toContain('files  8 ')
    expect(await text(ui, 't1-main-agent')).toBe('▸ agents 1 bg (Explore) ≈1k')
    await ui.press({ key: 'toggle-t1-main-agent' })
    expect(await text(ui, 't1-a:a-bg-file')).toContain('files  8 ')
    expect(await text(ui, 'header')).toBe('1 turn · 17 entries')
  })

  test('a main call that settles after its turn ended files under the turn it started in', async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'one')
    let release = () => {}
    world.gate = new Promise<void>((r) => {
      release = r
    })
    const slow = call($, { tool: 'Read', file_path: '/r/slow.ts' })
    world.gate = null
    await answer($)
    await prompt($, 'two')
    release()
    await slow
    expect(await text(ui, 't1-main-file')).toContain('slow.ts')
    expect(await text(ui, 'turn-2')).toContain('no new sources')
    expect(lines(world)).toEqual(['⚓ logbook · no new sources'])
  })

  test('/logbook clear keeps running agents: their name, later sources and answer land in the open turn', async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'one')
    await spawn($, 'scan')
    await answer($)
    expect(await reply($, 'clear')).toBe('Logbook cleared.')
    await prompt($, 'two')
    await call($, { tool: 'Read', file_path: '/r/x.ts', agentId: 'a-scan' })
    await call($, { tool: 'Read', file_path: '/r/y.ts', agentId: 'a-scan' })
    await answer($, 'a-scan', 'r'.repeat(4_000))
    await answer($)
    expect(await text(ui, 't2-main-agent')).toBe('▸ agents 1 scan (Explore) ≈1k')
    await ui.press({ key: 'toggle-t2-main-agent' })
    expect(await text(ui, 't2-agent:a-scan')).toContain('↳ scan (Explore)')
    expect(await text(ui, 't2-a:a-scan-file')).toBe('▸ files  2 r/x.ts, r/y.ts ≈2k')
    expect(await text(ui, 'header')).toBe('1 turn · 3 entries')
    expect(lines(world)).toEqual([
      '⚓ logbook · 1 agent',
      '⚓ logbook · 2 files · 1 agent · ≈1k tokens in · ≈2k inside agents',
    ])
  })

  test("a workflow's agents answer its script: their answers are not tokens in", async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'wf')
    await call($, { tool: 'Workflow', script: 'export const meta = {}' })
    await spawn($, 'w1', { workflow: { runId: 'wf_1', agentIndex: 1 } })
    await call($, { tool: 'Read', file_path: '/r/a.ts', agentId: 'a-w1' })
    await answer($, 'a-w1', 'r'.repeat(40_000))
    await answer($)
    expect(await text(ui, 't1-main-agent')).toBe('▸ agents 1 w1 (Explore · workflow)')
    expect(await text(ui, 't1-main-other')).toBe('▸ other  1 Workflow ≈100')
    expect(lines(world)).toEqual(['⚓ logbook · 1 file · 1 agent · 1 other · ≈100 tokens in · ≈1k inside agents'])
  })

  test("a teammate's later wakes are not credited to the turn that spawned it", async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'team')
    await spawn($, 'mate', { isTeammate: true })
    await answer($, 'a-mate', 'r'.repeat(800))
    await answer($)
    await prompt($, 'later')
    await answer($, 'a-mate', 'r'.repeat(40_000))
    await answer($)
    expect(await text(ui, 't1-main-agent')).toBe('▸ agents 1 mate (Explore · teammate) ≈200')
    expect(lines(world)).toEqual(['⚓ logbook · 1 agent · ≈200 tokens in', '⚓ logbook · no new sources'])
  })
})

describe('no model tokens', () => {
  test('no tool is registered; prompts, skills, context and results pass through untouched', async ($, on) => {
    const { world, session } = await start($, on)
    await prompt($, 'go')
    await spawn($, 'scan')
    const skill = await $.skill.prompt({ skill: 'commit', text: 'the skill body', source: 'userSettings' })
    expect(skill).toEqual({ text: 'the skill body' })
    const files = [{ path: '/repo/CLAUDE.md', kind: 'project' as const, content: 'rules' }]
    const context = await $.prompt.context({
      blocks: [{ name: 'currentDate', text: 'today' }],
      instructionFiles: files,
    })
    expect(context).toEqual(world.context[0])
    const read = await call($, { tool: 'Read', file_path: '/r/a.ts' })
    expect(read).toEqual({ result: { ok: true }, text: OUT.Read })
    await answer($)
    await logbook($, '')
    expect(world.tools).toBe(0)
    expect(world.prompts).toEqual(['p'])
    expect(session.appended()).toEqual([])
  })

  test('no /logbook answer carries context for the model', async ($, on) => {
    await start($, on)
    await prompt($, 'x')
    for (const args of ['', 'help', 'details', 'pane', 'off', 'on', 'clear', 'nope']) {
      expect((await logbook($, args)) as { context?: unknown }, args).not.toHaveProperty('context')
    }
  })
})

describe('/logbook', () => {
  test('no argument: the status on one line, what it records as a notice', async ($, on) => {
    const { world } = await start($, on)
    await busyTurn($)
    world.logs = []
    const status = await reply($, '')
    expect(status).toBe(
      'Logbook on · 7 entries this session · top datadog ≈6k, skill finops-custos ≈1k, files ≈1k · per-turn line counts.',
    )
    expect(status).not.toContain('\n')
    expect(world.logs).toHaveLength(1)
    expect(world.logs[0]?.text).toContain('cannot see why the model chose a source')
  })

  test('help lists every control; an unknown argument points to it', async ($, on) => {
    await start($, on)
    const help = await reply($, 'help')
    for (const control of ['/logbook:', 'on | off', 'pane', 'details', 'clear']) expect(help).toContain(control)
    expect(await reply($, 'nope')).toBe(
      'Usage: /logbook [on|off|pane|details|clear|help]. /logbook help explains each.',
    )
  })

  test('off stops recording and the line for the session; on resumes both', async ($, on) => {
    const { world, ui } = await start($, on)
    expect(await reply($, 'OFF')).toBe('Logbook off for this session: nothing is recorded and no per-turn line shows.')
    await busyTurn($)
    await answer($)
    expect(lines(world)).toEqual([])
    expect(await text(ui, 'header')).toBe('0 turns · 0 entries · recording off')
    expect(await reply($, '')).toContain('Logbook off for this session · 0 entries this session')
    expect(await reply($, 'on')).toBe('Logbook on: recording and the per-turn line resume.')
    await busyTurn($)
    await answer($)
    expect(lines(world)).toEqual([BUSY_LINE])
    expect(await text(ui, 'header')).toBe('1 turn · 7 entries')
    expect(await text(ui, 'turn-1')).toContain('investigate the cost spike')
  })

  test('off mid-turn closes the turn without a line', async ($, on) => {
    const { world, ui } = await start($, on)
    await busyTurn($)
    await logbook($, 'off')
    await call($, { tool: 'Read', file_path: '/r/late.ts' })
    await answer($)
    expect(lines(world)).toEqual([])
    expect(await text(ui, 'header')).toBe('1 turn · 7 entries · recording off')
  })

  test('on in a turn that started off records the rest of that turn, with its line', async ($, on) => {
    const { world, ui } = await start($, on)
    await reply($, 'off')
    await prompt($, 'a')
    await call($, { tool: 'Read', file_path: '/r/before-on.ts' })
    await reply($, 'on')
    await call($, { tool: 'Read', file_path: '/r/during-a.ts' })
    await answer($)
    expect(lines(world)).toEqual(['⚓ logbook · 1 file · ≈1k tokens in'])
    expect(await text(ui, 'turn-1')).toContain('(recording resumed)')
    expect(await text(ui, 't1-main-file')).toBe('▸ files  1 r/during-a.ts ≈1k')
    await prompt($, 'b')
    await answer($)
    expect(await text(ui, 'turn-2')).toContain('no new sources')
    expect(lines(world).at(-1)).toBe('⚓ logbook · no new sources')
  })

  test('off and clear take only what the person typed; on comes from anywhere', async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'x')
    await call($, { tool: 'Read', file_path: '/r/a.ts' })
    const others: PromptOrigin[] = [
      { kind: 'channel', server: 'slack' },
      { kind: 'plugin', name: 'other' },
      { kind: 'peer' },
      { kind: 'scheduled-trigger' },
    ]
    for (const origin of others) {
      expect(await reply($, 'clear', origin)).toBe(
        'Only a /logbook clear the person types clears the log. Nothing changed.',
      )
      expect(await reply($, 'off', origin)).toBe(
        'Only a /logbook off the person types turns the logbook off. Nothing changed.',
      )
    }
    expect(await text(ui, 'header')).toBe('1 turn · 1 entry')
    expect(await reply($, 'off', { kind: 'sdk' })).toContain('Logbook off for this session')
    expect(await reply($, 'on', { kind: 'channel', server: 'slack' })).toContain('Logbook on')
    expect(await reply($, 'clear', { kind: 'bridge' })).toBe('Logbook cleared.')
    await call($, { tool: 'Read', file_path: '/r/b.ts' })
    await answer($)
    expect(lines(world)).toEqual(['⚓ logbook · 1 file · ≈1k tokens in'])
  })

  test('pane opens and closes the timeline', async ($, on) => {
    const { world } = await start($, on)
    expect(await reply($, 'pane')).toBe('Logbook pane opened.')
    expect(world.panes.map((p) => p.id)).toEqual(['logbook'])
    expect(await reply($, 'pane')).toBe('Logbook pane closed.')
    expect(world.panes).toEqual([])
  })

  test('clear empties the log; the open turn keeps recording', async ($, on) => {
    const { world, ui } = await start($, on)
    await busyTurn($)
    await answer($)
    await prompt($, 'second')
    await call($, { tool: 'Read', file_path: '/r/a.ts' })
    expect(await reply($, 'clear')).toBe('Logbook cleared.')
    expect(await text(ui, 'turn-1')).toBeUndefined()
    expect(await text(ui, 'header')).toBe('1 turn · 0 entries')
    expect(world.writes.filter((w) => w.key === 'turn').some((w) => w.json === 'null')).toBe(true)
    await call($, { tool: 'Read', file_path: '/r/b.ts' })
    await answer($)
    expect(await text(ui, 't2-main-file')).toBe('▸ files  1 r/b.ts ≈1k')
    expect(lines(world).at(-1)).toBe('⚓ logbook · 1 file · ≈1k tokens in')
  })

  for (const reason of ['clear', 'resume'] as const) {
    test(`a session that ends by ${reason} starts the log over, with plain writes`, async ($, on) => {
      const { world, ui } = await start($, on)
      await busyTurn($)
      world.writes = []
      await $.session.end({ reason, sessionId: 's', resume: { id: 's' } } as never)
      expect(world.writes.filter((w) => w.key === 'turn')).toHaveLength(50)
      expect(await text(ui, 'turn-1')).toBeUndefined()
      expect(await text(ui, 'empty')).toContain('No sources yet')
      await prompt($, 'fresh')
      expect(await text(ui, 'turn-1')).toContain('fresh')
      expect(await text(ui, 'header')).toBe('1 turn · 0 entries')
    })
  }
})

describe('when the host fails', () => {
  test('a state write failing under a press: the press settles and the pane still draws', async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'x')
    await call($, { tool: 'Read', file_path: '/r/a.ts' })
    world.failSet = 'expanded'
    await ui.press({ key: 'toggle-t1-main-file' })
    await ui.press({ key: 'all-t1' })
    expect(await text(ui, 't1-main-file')).toBe('▸ files  1 r/a.ts ≈1k')
    world.failSet = null
    await ui.press({ key: 'toggle-t1-main-file' })
    expect(await text(ui, 't1-main-file.0')).toBe('r/a.ts ≈1k')
  })

  test('a state read failing before a call: the tool runs once and its result passes', async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'x')
    world.failGet = 'log'
    expect(await call($, { tool: 'Read', file_path: '/r/a.ts' })).toEqual({ result: { ok: true }, text: OUT.Read })
    world.failGet = null
    expect(world.runs).toBe(1)
    expect(await text(ui, 'header')).toBe('1 turn · 0 entries')
  })

  test('a state write failing after a call: the tool runs once and its result passes', async ($, on) => {
    const { world, ui } = await start($, on)
    await prompt($, 'x')
    world.failSet = 'turn'
    expect(await call($, { tool: 'Read', file_path: '/r/a.ts' })).toEqual({ result: { ok: true }, text: OUT.Read })
    world.failSet = null
    expect(world.runs).toBe(1)
    expect(await text(ui, 'header')).toBe('1 turn · 0 entries')
  })

  test('state failing at the start and end of a turn: both still answer', async ($, on) => {
    const { world } = await start($, on)
    world.failGet = 'isOff'
    world.failSet = 'log'
    expect(await prompt($, 'x')).toEqual({ turnId: 't-1' })
    expect(await answer($)).toEqual({ text: 'done' })
    expect(await answer($, 'a-none', 'r'.repeat(400))).toEqual({ text: 'r'.repeat(400) })
    expect(lines(world)).toEqual([])
  })

  test('state failing around a spawn still starts the agent once', async ($, on) => {
    const { world } = await start($, on)
    await prompt($, 'x')
    world.failGet = 'agents'
    expect(await spawn($, 'z')).toEqual({ model: 'claude-opus-5-5', agentId: 'a-z' })
    world.failGet = null
    world.failSet = 'agents'
    expect(await spawn($, 'y')).toEqual({ model: 'claude-opus-5-5', agentId: 'a-y' })
    expect(world.prompts).toEqual(['p', 'p'])
  })

  test('state failing under a skill, the context and the command: each still answers', async ($, on) => {
    const { world } = await start($, on)
    world.failGet = 'isOff'
    expect(await $.skill.prompt({ skill: 'commit', text: 'body', source: 'userSettings' })).toEqual({ text: 'body' })
    const files = [{ path: '/repo/CLAUDE.md', kind: 'project' as const, content: 'rules' }]
    expect(await $.prompt.context({ blocks: [], instructionFiles: files })).toEqual(world.context[0])
    world.failGet = null
    world.failSet = 'log'
    expect(await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)).toEqual({
      sessionId: 's',
    })
  })
})
