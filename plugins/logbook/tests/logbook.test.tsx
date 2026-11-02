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

const lines = (world: World) => world.logs.filter((l) => l.text.startsWith('⚓ logbook')).map((l) => l.text)

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
      expect(await text(ui, 't1-main-skill')).toBe('skill1finops-custos≈1k')
      expect(await text(ui, 't1-main-mcp')).toBe('mcp3datadog · search_logs ×2, datadog · get_metric≈6k')
      expect(await text(ui, 't1-main-file')).toBe('files1hooks/report.ts≈1k')
      expect(await text(ui, 't1-main-web')).toBe('web1docs.example.com/billing≈500')
      expect(await text(ui, 't1-main-shell')).toBe('shell1aws≈4')
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

      expect(await text(ui, 't1-main-agent')).toBe('agents1scan (Explore)≈200')
      const scan = (await text(ui, 't1-agent-a-scan')) ?? ''
      expect(scan).toContain('↳scan (Explore)')
      expect(await text(ui, 't1-a-scan-file')).toBe('files2src/a.ts, grep in r/src≈1k')
      expect(await text(ui, 't1-a-scan-agent')).toBe('agents1deep (general-purpose)')
      expect(await text(ui, 't1-a-scan-shell')).toBe('shell1ls≈4')
      expect(await text(ui, 't1-a-deep-mcp')).toBe('mcp1github · search_code≈100')
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
    expect(await text(ui, 't1-main-file')).toContain('files199')
    expect(await text(ui, 'turn-1')).toContain('51 older entries dropped')
    expect(await text(ui, 'header')).toBe('1 turn · 251 entries')
  })

  test('past 200 agents in a turn the oldest agents give way too', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'swarm')
    for (let i = 0; i < 210; i++) await spawn($, `w${i}`)
    expect(await text(ui, 't1-main-agent')).toContain('agents200w10 (Explore)')
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
    expect(await text(ui, 't1-main-file')).toContain('files5')
    expect(await text(ui, 't1-a-quiet-file')).toContain('files10')
    expect(await text(ui, 't1-a-mate-file')).toContain('files183')
    expect(await text(ui, 'turn-1')).toContain('67 older entries dropped')
  })

  test('sources waiting for a turn are bounded to 200', async ($, on) => {
    const { ui } = await start($, on)
    for (let i = 0; i < 205; i++) await $.skill.prompt({ skill: `s${i}`, text: 'x', source: 'userSettings' })
    expect(await text(ui, 'pending')).toContain('skill200s5,')
    await prompt($, 'go')
    expect(await text(ui, 't1-main-skill')).toContain('skill200s5,')
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
    expect(await text(ui, 't1-main-skill')).toBe('skill1finops-custos≈1k')
  })

  test('a skill typed before the turn opens joins that turn, and lists its source', async ($, on) => {
    const { world, ui } = await start($, on)
    await $.skill.prompt({ skill: 'commit', text: 'c'.repeat(800), source: 'plugin', pluginName: 'tools' })
    expect(await text(ui, 'pending')).toContain('commit')
    await prompt($, '/commit')
    await answer($)
    expect(await text(ui, 'pending')).toBeUndefined()
    expect(await text(ui, 't1-main-skill')).toBe('skill1commit≈200')
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
    expect(await text(ui, 't1-main-instructions')).toBe('instr2.claude/CLAUDE.md, repo/CLAUDE.md≈300')
    expect(await text(ui, 't2-main-instructions')).toBe('instr1repo/CLAUDE.md≈300')
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
    expect(await text(ui, 't1-main-file')).toBe('files1r/missing.ts (1 failed)≈5')
  })

  test('other tools are classified as other, by name', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'edit')
    await call($, { tool: 'Edit', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })
    await call($, { tool: 'TodoWrite', todos: [] })
    await call($, { tool: 'Edit', file_path: '/r/b.ts', old_string: 'a', new_string: 'b' })
    expect(await text(ui, 't1-main-other')).toBe('other3Edit ×2, TodoWrite≈300')
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
    expect(await text(ui, 't1-main-shell')).toBe('shell2aws, shell≈8')
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
    expect(await text(ui, 't1-agent-resumed-1234567890')).toContain('↳agent resumed')
  })
})

describe('subagents and parallel calls', () => {
  test('parallel calls in one turn all land', async ($, on) => {
    const { ui } = await start($, on)
    await prompt($, 'par')
    await Promise.all(Array.from({ length: 12 }, (_, i) => call($, { tool: 'Read', file_path: `/r/p${i}.ts` })))
    expect(await text(ui, 't1-main-file')).toContain('files12')
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
    expect(await text(ui, 't1-main-file')).toContain('files8')
    expect(await text(ui, 't1-a-bg-file')).toContain('files8')
    expect(await text(ui, 't1-main-agent')).toBe('agents1bg (Explore)≈1k')
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
    expect(await text(ui, 't2-main-agent')).toBe('agents1scan (Explore)≈1k')
    expect(await text(ui, 't2-agent-a-scan')).toContain('↳scan (Explore)')
    expect(await text(ui, 't2-a-scan-file')).toBe('files2r/x.ts, r/y.ts≈2k')
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
    expect(await text(ui, 't1-main-agent')).toBe('agents1w1 (Explore · workflow)')
    expect(await text(ui, 't1-main-other')).toBe('other1Workflow≈100')
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
    expect(await text(ui, 't1-main-agent')).toBe('agents1mate (Explore · teammate)≈200')
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
    expect(await text(ui, 't1-main-file')).toBe('files1r/during-a.ts≈1k')
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
    expect(await text(ui, 't2-main-file')).toBe('files1r/b.ts≈1k')
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
