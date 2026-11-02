import type {
  EngineInterface,
  Register,
  RenderElement,
  Timer,
  ToolCallResult,
  TurnCompleteInput,
  TurnUsage,
} from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { AgentRow, AgentStatus, Batch, BatchMember, ShellRun, Wardrobe } from '../types'
import {
  ACCENT,
  agentSvg,
  BAND_H,
  type BandArt,
  bandRatio,
  bandSvg,
  barText,
  CLAY,
  ctxBar,
  FIGURE_GLYPH,
  gridSvg,
  gridTiles,
  HEADER_H,
  headerSvg,
  isPurple,
  LINE_H,
  markColorOf,
  type RowArt,
  rowHeight,
  STATUS_GLYPH,
} from './art'
import { COSTUME_NAMES, costumeNamed, type Dress, describeDress, parseWardrobe, TARGETS, wear } from './costumes'
import { costOf, modelName, promptTokens, windowOf } from './pricing'
import {
  endOf,
  exitCodeOf,
  getTaskEndOf,
  type KiroCall,
  type KiroUsage,
  kiroCalls,
  kiroUsage,
  noticeOf,
  programOf,
  safe,
  type TaskEnd,
  taskIdOf,
} from './shell'

const PANE = 'deck'
const TITLE = 'Deck'
const MAX_ROWS = 200
const MAX_DRAWN = 30
const MAX_RUNS = 20
const MAX_TEXT = 300
const MAX_ID = 100
const WARN_AT = 70
const KIRO = 'Kiro'
const TASK = 'Task'
// A Kiro run or a background command the deck never heard end closes after this long in the background.
const SHELL_LIMIT = 6 * 60 * 60 * 1000
// A Monitor past its timeout has this long for its own end to arrive.
const GRACE = 60 * 1000
const LOST: TaskEnd = { status: 'unknown', note: 'end not seen in 6h' }
const ORPHAN: TaskEnd = { status: 'unknown', note: 'end not seen' }
const TIMED_OUT: TaskEnd = { status: 'unknown', note: 'timed out' }
const USAGE = 'Usage: /deck [on|off|pane|band|details|clear|costume|tasks|help]. /deck help lists each in a notice.'
const HELP_TEXT = 'The /deck controls are listed in a notice.'
const UNKNOWN_COSTUME = 'Unknown costume or target; the costumes and targets are listed in a notice.'
const HELP = [
  '/deck: status on one line.',
  '/deck on | off: show or hide the pane and the band for this session.',
  '/deck pane: show or hide the pane. /deck band: show or hide the band.',
  '/deck details: add cost, time, requests, tokens processed and memory.',
  '/deck clear: drop finished and failed agents.',
  '/deck costume [<target>] <costume>: dress the agents for this session; /deck costume random on | off draws one per agent; /deck costume help lists them.',
  '/deck tasks on | off: show or hide background tasks (Bash run in the background, Monitor) for this session.',
]
const COSTUME_HELP = [
  `Costumes: ${COSTUME_NAMES.join(', ')}.`,
  `Targets: ${TARGETS.join(', ')} (agent types explore, plan and kiro, model families fable, opus, sonnet and haiku).`,
  '/deck costume astronaut dresses every agent; /deck costume opus pirate dresses one target; /deck costume reset goes back to the default.',
  '/deck costume random on | off: each agent draws a costume from its id when it starts; a chosen costume still wins. The randomCostumes option sets it for every session.',
  'The costumes option sets them for every session, e.g. "opus=astronaut, haiku=pirate". Background tasks are submarines and wear no costume.',
]

const COST_NOTE =
  'Cost is an estimate at API list prices. Agent time is how long at least one listed agent or Kiro run was running, background tasks left out: parallel runs count once, idle gaps not at all.'
const KIRO_NOTE =
  'Kiro rows are not priced: Kiro bills its own credits, so the cost ends in +. /deck details shows the credits Kiro printed, when it did.'
const DETAILS_NOTE =
  "Tokens processed adds up every request's whole prompt plus its output: each request sends the agent's conversation again, so it grows much faster than the conversation and is what the cost follows. Memory is the last request's size over the model's window."
const WARN_NOTE =
  'From 70% memory each call resends a large prompt, so it costs more, and near the limit the agent compacts or fails. If it is nearly done, let it finish; if it keeps going, stop it and split the work into narrower tasks.'

const EMPTY_BATCH: Batch = { members: [], folded: 0, isDismissed: false }

const agents = atom({ plugin: 'deck', key: 'agents' } as const, [])
const now = atom({ plugin: 'deck', key: 'now' } as const, 0)
const autoOpened = atom({ plugin: 'deck', key: 'autoOpened' } as const, false)
const batch = atom({ plugin: 'deck', key: 'batch' } as const, EMPTY_BATCH)
const isBandHidden = atom({ plugin: 'deck', key: 'isBandHidden' } as const, false)
const isDetails = atom({ plugin: 'deck', key: 'isDetails' } as const, false)
const wardrobe = atom({ plugin: 'deck', key: 'wardrobe' } as const, {})
const isRandom = atom({ plugin: 'deck', key: 'isRandom' } as const, null)
const isTasks = atom({ plugin: 'deck', key: 'isTasks' } as const, null)

// Control characters, lone surrogates and U+FFFE/U+FFFF (which XML forbids, so the desktop's image of
// the row would not draw), and the bidi overrides that could reorder what a row shows.
const CONTROL = /[\p{Cc}\p{Cs}‪-‮⁦-⁩￾￿]/gu

const clean = (s: string, max = MAX_TEXT): string => {
  let out = ''
  let n = 0
  for (const ch of s) {
    if (n++ === max) break
    out += ch
  }
  return out.replace(CONTROL, ' ').trim()
}

const isRunning = (a: { status: AgentStatus }): boolean => a.status === 'running'

const isTask = (a: AgentRow): boolean => a.type === TASK && a.shell !== undefined

// Drops the oldest items `isKept` does not hold until the list fits `max`.
const trim = <T,>(list: T[], max: number, isKept: (x: T) => boolean): T[] => {
  let extra = list.length - max
  return extra <= 0 ? list : list.filter((x) => isKept(x) || extra-- <= 0)
}

// Past MAX_ROWS the oldest finished rows go first, then the oldest running tasks: a running agent or
// Kiro run keeps its row.
const fitRows = (list: AgentRow[]): AgentRow[] =>
  trim(trim(list, MAX_ROWS, isRunning), MAX_ROWS, (a) => isRunning(a) && !isTask(a))

const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

const tokens = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(Math.round(n))

const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const cost = (list: AgentRow[]): string =>
  `≈${usd(list.reduce((s, a) => s + a.usd, 0))}${list.every((a) => a.isPriced) ? '' : '+'}`

const endOfRow = (a: AgentRow, at: number): number => a.endedAt ?? Math.max(at, a.startedAt)

const spansOf = (a: AgentRow, at: number): [number, number][] => [...a.runs, [a.startedAt, endOfRow(a, at)]]

const runTime = (a: AgentRow, at: number): number => spansOf(a, at).reduce((s, [from, to]) => s + to - from, 0)

// Past MAX_RUNS the two oldest runs merge, the wait between them counted.
const withRun = (runs: [number, number][], run: [number, number]): [number, number][] => {
  const [first, second, ...rest] = [...runs, run]
  if (runs.length < MAX_RUNS || !first || !second) return [...runs, run]
  return [[first[0], second[1]], ...rest]
}

// Wall time during which at least one listed agent was running: overlapping runs count once and the
// gaps between them not at all.
const busyTime = (list: AgentRow[], at: number): number => {
  const spans = list.flatMap((a) => spansOf(a, at)).sort((p, q) => p[0] - q[0])
  let total = 0
  let from = 0
  let to = Number.NEGATIVE_INFINITY
  for (const [start, end] of spans) {
    if (start > to) {
      if (to > from) total += to - from
      from = start
      to = end
    } else if (end > to) to = end
  }
  return to > from ? total + to - from : total
}

// Agent time leaves background tasks out: a dev server left running is no agent at work.
const totalsOf = (list: AgentRow[], at: number) => {
  const running = list.filter(isRunning).length
  const failed = list.filter((a) => a.status === 'failed').length
  return {
    cost: cost(list),
    time: duration(
      busyTime(
        list.filter((a) => !isTask(a)),
        at,
      ),
    ),
    running,
    finished: list.length - running - failed,
    failed,
  }
}

type Totals = ReturnType<typeof totalsOf>

const agentsText = (t: Totals): string =>
  `${t.running} running · ${t.finished} finished${t.failed ? ` · ${t.failed} failed` : ''}`

const memoryOf = (a: AgentRow) => {
  const window = windowOf(a.model)
  return { window, pct: Math.min(100, Math.floor((a.context * 100) / window)) }
}

// Only a running agent warns: a finished one makes no more calls. A Kiro run or a task has no memory to show.
const isWarned = (a: AgentRow): boolean => isRunning(a) && !a.shell && memoryOf(a).pct >= WARN_AT

type View = { id: string; art: RowArt; pct: number; alt: string }

// What follows the model on a Kiro run's or a task's second line: not started yet, still in the
// background, or why it ended.
const shellMeta = (a: AgentRow, s: ShellRun, at: number): string => {
  if (isRunning(a) && s.isWaiting) return ' · waiting to start'
  const state = isRunning(a) ? (s.isBackground ? 'in background' : '') : s.note
  return `${state ? ` · ${state}` : ''} · ${duration(runTime(a, at))}`
}

const kiroDetails = (s: ShellRun): string[] => {
  const k = s.kiro
  return [
    [KIRO, k?.agent && `agent ${k.agent}`, k?.effort && `effort ${k.effort}`, s.isBackground && 'background']
      .filter(Boolean)
      .join(' · '),
    [
      'unpriced: Kiro bills its own credits',
      k?.credits && `${k.credits} credits`,
      k?.time && `Kiro time ${k.time}`,
      k?.tokens && `${k.tokens} tokens`,
    ]
      .filter(Boolean)
      .join(' · '),
  ]
}

const shellArt = (a: AgentRow, s: ShellRun, at: number, withDetails: boolean, dress: Dress): RowArt =>
  s.kiro
    ? {
        title: a.description || 'Kiro chat',
        costume: wear(dress, a.id, a.type, a.model),
        species: 'ghost',
        status: a.status,
        model: a.model ? `${KIRO} · ${a.model}` : KIRO,
        meta: shellMeta(a, s, at),
        warning: '',
        details: withDetails ? kiroDetails(s) : [],
      }
    : {
        title: a.description || s.program || s.tool,
        costume: 'other',
        species: 'sub',
        status: a.status,
        model: s.tool,
        meta: shellMeta(a, s, at),
        warning: '',
        details: withDetails ? [[TASK, s.tool, s.program].filter(Boolean).join(' · ')] : [],
      }

const viewOf = (a: AgentRow, at: number, withDetails: boolean, dress: Dress): View => {
  const { window, pct } = memoryOf(a)
  const art: RowArt = a.shell
    ? shellArt(a, a.shell, at, withDetails, dress)
    : {
        title: a.description || a.type,
        costume: wear(dress, a.id, a.type, a.model),
        status: a.status,
        model: modelName(a.model),
        meta: ` · ${duration(runTime(a, at))}`,
        warning: isWarned(a) ? `memory ${pct}% · large and costly per call` : '',
        details: withDetails
          ? [
              `${a.type}${a.workflow ? ` · workflow ${a.workflow}` : ''}`,
              `${cost([a])} · ${a.requests} ${a.requests === 1 ? 'request' : 'requests'} · ${tokens(a.tokens)} tokens processed`,
              `memory ${tokens(a.context)} / ${tokens(window)} (${pct}%)`,
            ]
          : [],
      }
  const alt = [`${art.title}: ${a.status}`, `${art.model}${art.meta}`, art.warning, ...art.details]
    .filter(Boolean)
    .join(' · ')
  return { id: a.id, art, pct, alt }
}

const batchOf = (b: Batch): BandArt => {
  const running = b.members.filter(isRunning).length
  const total = b.members.length + b.folded
  return { total, finished: total - running, running }
}

const paneState = async ($: EngineInterface): Promise<'open' | 'waiting' | 'closed'> => {
  const pane = (await $.ui.panes()).find((p) => p.id === PANE)
  return pane === undefined ? 'closed' : pane.isPlaced ? 'open' : 'waiting'
}

const openPane = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)
  return $.ui.open({ id: PANE, title: TITLE })
}

// A pane opened by itself on a narrow terminal is listed but not drawn: the person's press shows it.
const togglePane = async ($: EngineInterface): Promise<string> => {
  if ((await paneState($)) === 'open') {
    await $.ui.close({ id: PANE })
    return 'Deck closed.'
  }
  return (await openPane($)).isPlaced ? 'Deck opened.' : 'Deck opened; it shows when there is room.'
}

// A batch runs while one of its agents (a Kiro run is one) runs: a background task in it never keeps it
// running.
const isLive = (b: Batch): boolean => b.members.some((m) => isRunning(m) && !m.isTask)

const withMember = (b: Batch, members: BatchMember[]): Batch => {
  const kept = trim(members, MAX_ROWS, isRunning)
  return { ...b, members: kept, folded: b.folded + members.length - kept.length }
}

// One update decides both whether the deck was idle and the membership, so agents that start at the
// same moment all land in the same batch.
const join = ($: EngineInterface, id: string) =>
  update($, batch, (b) => {
    const member: BatchMember = { id, status: 'running' }
    if (b.members.some((m) => m.id === id && isRunning(m))) return b
    if (!isLive(b)) return { ...EMPTY_BATCH, members: [member] }
    return withMember(
      b,
      b.members.some((m) => m.id === id) ? b.members.map((m) => (m.id === id ? member : m)) : [...b.members, member],
    )
  })

// A background task joins the batch its agents are running, and never starts one.
const joinTask = ($: EngineInterface, id: string) =>
  update($, batch, (b) =>
    !isLive(b) || b.members.some((m) => m.id === id)
      ? b
      : withMember(b, [...b.members, { id, status: 'running', isTask: true }]),
  )

const settle = async ($: EngineInterface, id: string, status: AgentStatus) => {
  if (!(await read($, batch)).members.some((m) => m.id === id)) return
  await update($, batch, (b) => ({ ...b, members: b.members.map((m) => (m.id === id ? { ...m, status } : m)) }))
}

// Adds or replaces rows. A running task trimmed off the list leaves the batch too: nothing would end it there.
const store = async ($: EngineInterface, rows: AgentRow[]) => {
  const ids = rows.map((r) => r.id)
  const list = await update($, agents, (l) => fitRows([...l.filter((a) => !ids.includes(a.id)), ...rows]))
  const listed = new Set(list.map((a) => a.id))
  const isGone = (m: BatchMember) => m.isTask === true && isRunning(m) && !listed.has(m.id)
  if ((await read($, batch)).members.some(isGone))
    await update($, batch, (b) => ({ ...b, members: b.members.filter((m) => !isGone(m)) }))
}

const clearFinished = ($: EngineInterface) => update($, agents, (list) => list.filter(isRunning))

// Rows that leave the deck as if they never ran: out of the list and out of the batch.
const drop = async ($: EngineInterface, ids: readonly string[]) => {
  await update($, agents, (list) => list.filter((a) => !ids.includes(a.id)))
  if ((await read($, batch)).members.some((m) => ids.includes(m.id)))
    await update($, batch, (b) => ({ ...b, members: b.members.filter((m) => !ids.includes(m.id)) }))
}

const runningShells = async ($: EngineInterface, isIt: (s: ShellRun, a: AgentRow) => boolean): Promise<string[]> =>
  (await read($, agents)).filter((a) => a.shell && isRunning(a) && isIt(a.shell, a)).map((a) => a.id)

// Ends the rows still running among `ids`; a row another path already ended keeps how it ended. A row
// whose command never started counts no time.
const closeShells = async (
  $: EngineInterface,
  ids: readonly string[],
  end: TaskEnd,
  usage: KiroUsage | null = null,
) => {
  const open = await runningShells($, (_s, a) => ids.includes(a.id))
  if (open.length === 0) return
  const at = await $.clock.now()
  await update($, agents, (list) =>
    list.map((a) => {
      if (!open.includes(a.id) || !a.shell || !isRunning(a)) return a
      const kiro = a.shell.kiro && usage ? { ...a.shell.kiro, ...usage } : a.shell.kiro
      return {
        ...a,
        status: end.status,
        startedAt: a.shell.isWaiting ? at : a.startedAt,
        endedAt: at,
        shell: { ...a.shell, isWaiting: false, note: end.note, kiro },
      }
    }),
  )
  for (const id of open) await settle($, id, end.status)
  await update($, now, () => at)
}

// A command asked to run in the background starts when its call returns; one moved there keeps its start.
const toBackground = async ($: EngineInterface, ids: readonly string[], shellId: string, endsWithOwner: boolean) => {
  const at = await $.clock.now()
  await update($, agents, (list) =>
    list.map((a) =>
      ids.includes(a.id) && a.shell && isRunning(a)
        ? {
            ...a,
            startedAt: a.shell.isWaiting ? at : a.startedAt,
            shell: { ...a.shell, isWaiting: false, isBackground: true, shellId, endsWithOwner, backgroundAt: at },
          }
        : a,
    ),
  )
  await update($, now, () => at)
}

const recordOf = (result: ToolCallResult): Record<string, unknown> =>
  typeof result.result === 'object' && result.result !== null ? (result.result as Record<string, unknown>) : {}

// What the tool call came to: refused by a hook or rejected at the permission prompt (the rows go: the
// command never ran), left running in the background, or ended, failed on an error, a non-zero exit or
// an interruption. A rejection is an error with no exit code and no record of output, only its text.
const endShells = async ($: EngineInterface, ids: readonly string[], result: ToolCallResult) => {
  if (result.deny !== undefined) return drop($, ids)
  const record = recordOf(result)
  const text = typeof result.text === 'string' ? result.text : ''
  const isError = result.isError === true
  const code = isError ? exitCodeOf(text) : null
  const hasRecord = typeof result.result === 'object' && result.result !== null
  if (isError && code === null && !hasRecord) return drop($, ids)
  if (!isError) {
    const shellId = taskIdOf(record.backgroundTaskId)
    if (shellId) return toBackground($, ids, shellId, record.backgroundEndsWithFinalResponse === true)
  }
  const output = text || [record.stdout, record.stderr].filter((s) => typeof s === 'string').join('\n')
  const isInterrupted = record.interrupted === true
  const note = isInterrupted ? 'interrupted' : code ? `exit ${code}` : ''
  await closeShells(
    $,
    ids,
    { status: isError || isInterrupted ? 'failed' : 'done', note },
    ids.length === 1 ? kiroUsage(output) : null,
  )
}

const textsOf = (blocks: readonly { type: string; [field: string]: unknown }[]): string[] =>
  blocks.slice(0, 50).flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))

// A task notification ends the background rows it names, by task id or by the call that started it.
const onNotice = async ($: EngineInterface, text: unknown) => {
  const n = noticeOf(text)
  if (n === null) return
  const ids = await runningShells(
    $,
    (s) => (n.taskId !== '' && s.shellId === n.taskId) || (n.toolUseId !== '' && s.toolUseId === n.toolUseId),
  )
  if (ids.length) await closeShells($, ids, endOf(n.status, n.exitCode))
}

// A GetTask that reads a task as completed, failed or cancelled ends its row.
const onGetTask = async ($: EngineInterface, taskId: unknown, result: ToolCallResult) => {
  if (typeof taskId !== 'string' || taskId === '' || result.deny !== undefined || result.isError === true) return
  const got = getTaskEndOf(recordOf(result))
  if (got === null) return
  const ids = await runningShells($, (s) => s.shellId === taskId)
  if (ids.length) await closeShells($, ids, got.end, ids.length === 1 ? kiroUsage(got.output) : null)
}

const onTaskStop = async ($: EngineInterface, input: Record<string, unknown>, result: ToolCallResult) => {
  if (result.deny !== undefined || result.isError === true) return
  const id = [input.task_id, input.shell_id].find((v): v is string => typeof v === 'string' && v !== '')
  if (id === undefined) return
  const ids = await runningShells($, (s) => s.shellId === id)
  if (ids.length) await closeShells($, ids, { status: 'failed', note: 'stopped' })
}

// A command that ends with its owner's final response sends no notification: it ends here.
const onOwnerDone = async ($: EngineInterface, owner: string | null) => {
  const ids = await runningShells($, (s) => s.isBackground && s.endsWithOwner && s.owner === owner)
  if (ids.length)
    await closeShells($, ids, {
      status: 'failed',
      note: owner ? 'stopped with its agent' : 'stopped at the final answer',
    })
}

/** What this load of the deck knows beyond its state: the calls it is following, and when it loaded. */
type Live = { inFlight: Set<string>; loadedAt: number }

// How a row whose end never came ends now, if it does: its call returned but the deck lost its end, a
// Monitor is past its timeout, or a command has run six hours in the background. A call still under way,
// one waiting at the permission prompt included, never ends here, nor does a persistent Monitor.
const overdue = (a: AgentRow, s: ShellRun, at: number, live: Live): TaskEnd | null => {
  if (live.inFlight.has(s.toolUseId) || s.isPersistent) return null
  if (s.deadline !== null) return at >= s.deadline + GRACE ? TIMED_OUT : null
  if (!s.isBackground && a.startedAt >= live.loadedAt) return ORPHAN
  return at - (s.backgroundAt ?? a.startedAt) >= SHELL_LIMIT ? LOST : null
}

const tick = async ($: EngineInterface, live: Live) => {
  const list = await read($, agents)
  if (!list.some(isRunning)) return
  const at = await $.clock.now()
  const ends = new Map<TaskEnd, string[]>()
  for (const a of list) {
    const end = a.shell && isRunning(a) ? overdue(a, a.shell, at, live) : null
    if (end) ends.set(end, [...(ends.get(end) ?? []), a.id])
  }
  for (const [end, ids] of ends) await closeShells($, ids, end)
  await update($, now, () => at)
}

// A finished agent asked again (a background agent, a teammate) starts a new run.
const resume = async ($: EngineInterface, agentId: string) => {
  const row = (await read($, agents)).find((a) => a.id === agentId)
  if (!row || isRunning(row) || row.shell) return
  const at = await $.clock.now()
  await update($, agents, (list) =>
    list.map((a) =>
      a.id !== agentId || isRunning(a)
        ? a
        : {
            ...a,
            status: 'running',
            runs: withRun(a.runs, [a.startedAt, endOfRow(a, at)]),
            startedAt: at,
            endedAt: null,
          },
    ),
  )
  await join($, agentId)
  await update($, now, () => at)
}

const recordStep = async ($: EngineInterface, agentId: string, usage: TurnUsage, writeMultiplier: number) => {
  if (!(await read($, agents)).some((a) => a.id === agentId && !a.shell)) return
  const model = clean(usage.model, MAX_ID)
  const cost = costOf(model, usage, writeMultiplier)
  const prompt = promptTokens(usage)
  await update($, agents, (list) =>
    list.map((a) =>
      a.id !== agentId
        ? a
        : {
            ...a,
            model: model || a.model,
            requests: a.requests + 1,
            tokens: a.tokens + prompt + usage.output_tokens,
            context: prompt + usage.output_tokens,
            usd: a.usd + (cost ?? 0),
            isPriced: a.isPriced && cost !== null,
          },
    ),
  )
}

const finish = async ($: EngineInterface, e: TurnCompleteInput, agentId: string, writeMultiplier: number) => {
  const at = await $.clock.now()
  const status: AgentStatus = e.reason === 'answer' ? 'done' : 'failed'
  await update($, agents, (list) =>
    list.map((a) => {
      if (a.id !== agentId) return a
      const ended: AgentRow = { ...a, status, endedAt: at }
      if (a.requests > 0 || !e.usage) return ended
      const model = clean(e.usage.model, MAX_ID) || a.model
      const cost = costOf(model, e.usage, writeMultiplier)
      return {
        ...ended,
        model,
        tokens: promptTokens(e.usage) + e.usage.output_tokens,
        usd: cost ?? 0,
        isPriced: cost !== null,
      }
    }),
  )
  await settle($, agentId, status)
  await update($, now, () => at)
}

// `/deck band` hides the band for the session; its × hides it for the running batch alone.
const bandState = async ($: EngineInterface): Promise<'hidden' | 'dismissed' | 'on'> => {
  if (await read($, isBandHidden)) return 'hidden'
  const b = await read($, batch)
  return b.isDismissed && isLive(b) ? 'dismissed' : 'on'
}

const rowOf = (
  id: string,
  type: string,
  description: string,
  model: string,
  shell: ShellRun,
  at: number,
  isPriced: boolean,
): AgentRow => ({
  id,
  type,
  description,
  model,
  status: 'running',
  workflow: null,
  startedAt: at,
  endedAt: null,
  runs: [],
  requests: 0,
  tokens: 0,
  context: 0,
  usd: 0,
  isPriced,
  shell,
})

const shellOf = (tool: ShellRun['tool'], program: string, toolUseId: string, owner: string | null): ShellRun => ({
  tool,
  program,
  toolUseId,
  owner,
  shellId: '',
  isBackground: false,
  isWaiting: false,
  isPersistent: false,
  deadline: null,
  endsWithOwner: false,
  backgroundAt: null,
  note: '',
  kiro: null,
})

const kiroRows = (calls: KiroCall[], shell: ShellRun, at: number): AgentRow[] =>
  calls.map((call, i) =>
    rowOf(
      calls.length === 1 ? `kiro-${shell.toolUseId}` : `kiro-${shell.toolUseId}-${i + 1}`,
      KIRO,
      call.title,
      call.model,
      { ...shell, kiro: { agent: call.agent, effort: call.effort, credits: '', time: '', tokens: '' } },
      at,
      false,
    ),
  )

// A task's title: the Bash call's description, redacted, else the program alone; never the command.
const taskTitle = (description: unknown, program: string): string => safe(description) || program

/** The options as the hooks read them. */
type Config = { autoOpen: boolean; costumes: Wardrobe; isRandom: boolean; showTasks: boolean }

const dressOf = async ($: EngineInterface, cfg: Config): Promise<Dress> => ({
  session: await read($, wardrobe),
  option: cfg.costumes,
  isRandom: (await read($, isRandom)) ?? cfg.isRandom,
})

const showsTasks = async ($: EngineInterface, cfg: Config): Promise<boolean> =>
  (await read($, isTasks)) ?? cfg.showTasks

const openOnce = async ($: EngineInterface, cfg: Config) => {
  if (!cfg.autoOpen || (await read($, autoOpened))) return
  await update($, autoOpened, () => true)
  await openPane($).catch(() => undefined)
}

// Kiro runs start as agents do: in the band's batch, and the pane opens once.
const startRows = async ($: EngineInterface, cfg: Config, rows: AgentRow[]): Promise<string[]> => {
  const ids = rows.map((r) => r.id)
  await store($, rows)
  for (const id of ids) await join($, id)
  const at = await $.clock.now()
  await update($, now, () => at)
  await openOnce($, cfg).catch(() => undefined)
  return ids
}

// A background task shows in the pane: it joins a batch only while agents run one, a persistent Monitor
// never, and it never opens the pane.
const startTask = async ($: EngineInterface, row: AgentRow) => {
  await store($, [row])
  if (!row.shell?.isPersistent) await joinTask($, row.id)
  const at = await $.clock.now()
  await update($, now, () => at)
}

// The one-line status is the command's text, which the model also reads; the notes explaining it are
// notices the model never reads.
const statusOf = async ($: EngineInterface, cfg: Config): Promise<{ text: string; notes: string[] }> => {
  const list = await read($, agents)
  const t = totalsOf(list, await $.clock.now())
  const pane = await paneState($)
  const band = await bandState($)
  const withDetails = await read($, isDetails)
  const tasks = await showsTasks($, cfg)
  const warned = list.filter(isWarned).length
  const text = [
    `${agentsText(t)} · ${t.cost} · ${t.time} agent time.`,
    `Pane ${pane === 'waiting' ? 'waiting for room (/deck pane shows it)' : pane}, band ${band === 'dismissed' ? 'dismissed for this batch' : band}, details ${withDetails ? 'on' : 'off'}, tasks ${tasks ? 'on' : 'off'}.`,
    warned ? `${warned} running ${warned === 1 ? 'agent is' : 'agents are'} at 70% memory or more.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const hasKiro = list.some((a) => a.shell?.kiro)
  return {
    text,
    notes: [COST_NOTE, hasKiro ? KIRO_NOTE : '', withDetails ? DETAILS_NOTE : '', warned ? WARN_NOTE : ''].filter(
      Boolean,
    ),
  }
}

const randomText = async ($: EngineInterface, cfg: Config): Promise<string> => {
  const session = await read($, isRandom)
  const isOn = session ?? cfg.isRandom
  return `Random costumes ${isOn ? 'on' : 'off'} (${session === null ? 'the randomCostumes option' : 'this session'}).`
}

const costumeStatus = async ($: EngineInterface, cfg: Config): Promise<string> =>
  `Wearing: ${describeDress(await dressOf($, cfg))}. ${await randomText($, cfg)}`

// The long texts go to notices, which the model never reads; the command's text stays one line.
const notice = ($: EngineInterface, lines: readonly string[]) => {
  for (const line of lines) $.ui.log(line)
}

/** What a task row reads off the tool call that started it. */
type TaskCall = { description: unknown; command?: unknown; toolUseId: string; owner: string | null }

// A Bash call that left its command running in the background, asked to or moved there at its timeout
// or by the person: a task from then. It started when the call returned, unless the engine says it ran
// before: its timeout ago, or since the call began for one the person sent there (Ctrl+B), any
// permission dialog included.
const bashTask = async ($: EngineInterface, cfg: Config, call: TaskCall, result: ToolCallResult, calledAt: number) => {
  if (result.deny !== undefined || result.isError === true || !(await showsTasks($, cfg))) return
  const record = recordOf(result)
  const shellId = taskIdOf(record.backgroundTaskId)
  if (!shellId) return
  const at = await $.clock.now()
  const ran = typeof record.timedOutAfterMs === 'number' && record.timedOutAfterMs > 0 ? record.timedOutAfterMs : 0
  const startedAt = ran ? at - ran : record.backgroundedByUser === true ? calledAt : at
  const program = programOf(call.command)
  const shell: ShellRun = {
    ...shellOf('Bash', program, call.toolUseId, call.owner),
    shellId,
    isBackground: true,
    endsWithOwner: record.backgroundEndsWithFinalResponse === true,
    backgroundAt: at,
  }
  await startTask(
    $,
    rowOf(`task-${call.toolUseId}`, TASK, taskTitle(call.description, program), '', shell, startedAt, true),
  )
}

// A Monitor that started watching: a task until its notification, a GetTask or a TaskStop ends it, or
// its timeout and a minute of grace pass. A persistent one ends with the session.
const monitorTask = async ($: EngineInterface, cfg: Config, call: TaskCall, result: ToolCallResult) => {
  if (result.deny !== undefined || result.isError === true || !(await showsTasks($, cfg))) return
  const record = recordOf(result)
  const shellId = taskIdOf(record.taskId)
  if (!shellId) return
  const at = await $.clock.now()
  const isPersistent = record.persistent === true
  const timeout = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? record.timeoutMs : 0
  // The record calls it a deadline: a time since the epoch is taken as one, anything shorter as a duration.
  const deadline = isPersistent || timeout === 0 ? null : timeout > 1e12 ? timeout : at + timeout
  const toolUseId = call.toolUseId || String(at)
  const shell: ShellRun = {
    ...shellOf('Monitor', '', toolUseId, call.owner),
    shellId,
    isBackground: true,
    isPersistent,
    deadline,
    backgroundAt: at,
  }
  await startTask($, rowOf(`task-${toolUseId}`, TASK, taskTitle(call.description, 'Monitor'), '', shell, at, true))
}

export const register: Register = (on, options) => {
  const writeMultiplier = options.subagentCacheTtl === '1h' ? 2 : 1.25
  const cfg: Config = {
    autoOpen: options.autoOpen !== false,
    costumes: parseWardrobe(options.costumes),
    isRandom: options.randomCostumes !== false,
    showTasks: options.showTasks !== false,
  }
  let timer: Timer | undefined
  const live: Live = { inFlight: new Set(), loadedAt: Number.POSITIVE_INFINITY }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    live.loadedAt = await $.clock.now()
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($, live).catch(() => undefined))
    await $.command.register({
      name: 'deck',
      description:
        'Agents deck status; `on` and `off` show or hide pane and band for this session, `pane` the pane alone, `band` the band, `details` the extra numbers, `clear` drops finished agents, `tasks` shows or hides background tasks',
      argumentHint: '[on|off|pane|band|details|clear|costume|tasks|help]',
      immediate: true,
    })
    return result
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      const status = await statusOf($, cfg)
      for (const note of status.notes) $.ui.log(note)
      return { text: status.text }
    }
    if (arg === 'off') {
      if ((await paneState($)) !== 'closed') await $.ui.close({ id: PANE })
      await update($, isBandHidden, () => true)
      await update($, autoOpened, () => true)
      return { text: 'Deck off for this session: pane closed, band hidden.' }
    }
    if (arg === 'on') {
      await update($, isBandHidden, () => false)
      await update($, batch, (b) => ({ ...b, isDismissed: false }))
      return { text: (await openPane($)).isPlaced ? 'Deck on.' : 'Deck on; the pane shows when there is room.' }
    }
    if (arg === 'pane') return { text: await togglePane($) }
    if (arg === 'band') {
      const isShown = (await bandState($)) === 'on'
      await update($, isBandHidden, () => isShown)
      if (!isShown) await update($, batch, (b) => ({ ...b, isDismissed: false }))
      return { text: isShown ? 'Band hidden.' : 'Band shown.' }
    }
    if (arg === 'details') {
      const shown = await update($, isDetails, (d) => !d)
      if (shown) $.ui.log(DETAILS_NOTE)
      return {
        text: shown
          ? 'Details on: the header adds cost and time, each row its type, workflow, cost, requests, tokens processed and memory.'
          : 'Details off.',
      }
    }
    if (arg === 'clear') {
      await clearFinished($)
      return { text: 'Finished and failed agents cleared.' }
    }
    if (arg === 'help') {
      notice($, HELP)
      return { text: HELP_TEXT }
    }
    const words = arg.split(/\s+/)
    if (words[0] === 'tasks') {
      if (words.length === 1)
        return {
          text: `Background tasks ${(await showsTasks($, cfg)) ? 'on' : 'off'}. /deck tasks on | off changes it.`,
        }
      if (words.length !== 2 || (words[1] !== 'on' && words[1] !== 'off')) return { text: USAGE }
      const isOn = words[1] === 'on'
      await update($, isTasks, () => isOn)
      if (isOn)
        return { text: 'Background tasks on for this session: Bash run in the background and Monitor get a row.' }
      await drop(
        $,
        (await read($, agents)).filter(isTask).map((a) => a.id),
      )
      return { text: 'Background tasks off for this session: their rows are gone and new ones are not added.' }
    }
    const dress = words[0] === 'costume' ? words.slice(1) : words
    if (words[0] === 'costume' || dress.some((w) => costumeNamed(w))) {
      if (dress.length === 0 || dress[0] === 'help') {
        notice($, COSTUME_HELP)
        return { text: await costumeStatus($, cfg) }
      }
      if (dress.length === 1 && dress[0] === 'reset') {
        await update($, wardrobe, () => ({}))
        await update($, isRandom, () => null)
        return { text: `Costumes back to ${describeDress(await dressOf($, cfg))}.` }
      }
      if (dress[0] === 'random') {
        if (dress.length === 1) return { text: await randomText($, cfg) }
        if (dress.length !== 2 || (dress[1] !== 'on' && dress[1] !== 'off')) {
          notice($, COSTUME_HELP)
          return { text: UNKNOWN_COSTUME }
        }
        const isOn = dress[1] === 'on'
        await update($, isRandom, () => isOn)
        return {
          text: isOn
            ? 'Random costumes on for this session: each agent draws one from its id; a chosen costume still wins.'
            : 'Random costumes off for this session: agents dress by type, then model, unless one is chosen.',
        }
      }
      const chosen = parseWardrobe(dress.join(' '))
      if (Object.keys(chosen).length === 0) {
        notice($, COSTUME_HELP)
        return { text: UNKNOWN_COSTUME }
      }
      await update($, wardrobe, (w) => ({ ...w, ...chosen }))
      return { text: `Wearing: ${describeDress(await dressOf($, cfg))}.` }
    }
    return { text: USAGE }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    const at = await $.clock.now()
    const row: AgentRow = {
      id,
      type: clean(e.subagentType, MAX_ID),
      description: clean(e.description),
      model: clean(started.model, MAX_ID),
      status: 'running',
      workflow: e.workflow ? clean(e.workflow.runId, 8) : null,
      startedAt: at,
      endedAt: null,
      runs: [],
      requests: 0,
      tokens: 0,
      context: 0,
      usd: 0,
      isPriced: true,
    }
    await store($, [row])
    await join($, id)
    await update($, now, () => at)
    await openOnce($, cfg)
    return started
  }).catch(($, e, next) => next(e))

  // Observe only: the call goes on as made and its result comes back as it was. A Kiro run gets its row
  // before the command runs; a background task gets one when the result says it runs on. A failure here
  // falls through to the call. A call is followed while it runs, so a row whose end the deck lost once
  // its call returned can close.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const calledAt = await $.clock.now()
    const call: TaskCall = {
      description: e.description,
      command: e.command,
      toolUseId: clean(e.tool_use_id, MAX_ID) || String(calledAt),
      owner: e.agentId === undefined ? null : clean(e.agentId, MAX_ID),
    }
    const calls = kiroCalls(e.command)
    if (calls.length === 0) {
      const result = await next(e)
      await bashTask($, cfg, call, result, calledAt).catch(() => undefined)
      return result
    }
    live.inFlight.add(call.toolUseId)
    try {
      const shell = {
        ...shellOf('Bash', programOf(e.command), call.toolUseId, call.owner),
        isWaiting: e.run_in_background === true,
      }
      const ids = await startRows($, cfg, kiroRows(calls, shell, calledAt))
      const result = await next(e)
      await endShells($, ids, result)
      return result
    } finally {
      live.inFlight.delete(call.toolUseId)
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const result = await next(e)
    const call: TaskCall = {
      description: e.description,
      toolUseId: clean(e.tool_use_id, MAX_ID),
      owner: e.agentId === undefined ? null : clean(e.agentId, MAX_ID),
    }
    await monitorTask($, cfg, call, result).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'GetTask' }, async ($, e, next) => {
    const result = await next(e)
    await onGetTask($, e.taskId, result).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const result = await next(e)
    await onTaskStop($, { task_id: e.task_id, shell_id: e.shell_id }, result).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  // A background task's end reaches the conversation that owns it as a notification row, the main one's
  // as a prompt too; either ends its row, whichever comes first.
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'task-notification')
      for (const text of textsOf(e.message.content)) await onNotice($, text).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'task-notification') await onNotice($, e.text).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    await resume($, e.agentId).catch(() => undefined)
    const result = yield* next(e)
    if (result.usage) await recordStep($, e.agentId, result.usage, writeMultiplier).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) await finish($, e, e.agentId, writeMultiplier).catch(() => undefined)
    await onOwnerDone($, e.agentId ?? null).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, agents, () => [])
      await update($, batch, () => EMPTY_BATCH)
      await update($, autoOpened, () => false)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const withDetails = await read($, isDetails)
    const at = Math.max(await read($, now), ...list.map((a) => a.startedAt))
    const running = list.filter(isRunning).reverse()
    const finished = list.filter((a) => !isRunning(a)).reverse()
    // Every redraw sends every drawn row, and a running one changes each second: the oldest finished
    // rows past MAX_DRAWN wait behind a count.
    const ordered = [...running, ...finished]
    const dress = await dressOf($, cfg)
    const views = ordered.slice(0, MAX_DRAWN).map((a) => viewOf(a, at, withDetails, dress))
    const hidden = ordered.length - views.length
    const t = totalsOf(list, at)
    const summary = withDetails ? `${agentsText(t)} · Cost ${t.cost} · Time ${t.time}` : agentsText(t)
    const header = withDetails ? t : { running: t.running, finished: t.finished, failed: t.failed }
    const clear =
      finished.length > 0 ? (
        <Button key="clear" label="Clear finished" plain dimColor onPress={() => clearFinished($)} />
      ) : null
    const empty =
      list.length === 0 ? (
        <Box key="empty">
          <Text dimColor>
            No agents yet. Subagents, workflow agents, Kiro runs and background tasks show up here as they start.
          </Text>
        </Box>
      ) : null
    const more =
      hidden > 0 ? (
        <Box key="more">
          <Text dimColor>{`${hidden} more ${hidden === 1 ? 'agent' : 'agents'} not shown`}</Text>
        </Box>
      ) : null

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const w = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const lines = [clear, empty, more].filter(Boolean).length
      const gridH = HEADER_H + lines * LINE_H + views.reduce((s, v) => s + rowHeight(v.art), 0)
      // The grid sizes the pane; the content is placed over it, as an absolute Box paints over the
      // siblings before it.
      return (
        <Box flexDirection="column">
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(w, tileH)} alt="dotted grid" width={w} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
            <Box key="summary">
              <Svg source={headerSvg(w, header)} alt={summary} width={w} height={HEADER_H} />
            </Box>
            {clear}
            {empty}
            {views.map((v) => (
              <Box key={v.id}>
                <Svg source={agentSvg(w, v.art)} alt={v.alt} width={w} height={rowHeight(v.art)} />
              </Box>
            ))}
            {more}
          </Box>
        </Box>
      )
    }

    const barW = Math.max(6, Math.min(16, (e.props.bodyColumns || 40) - 34))
    const row = (v: View) => {
      const r = v.art
      const species = r.species ?? 'crab'
      const color = markColorOf(r.costume, species)
      // The theme's purple and teal: each reads on the terminal's light and dark themes.
      const modelColor = species === 'sub' ? 'planMode' : isPurple(r.costume, species) ? 'merged' : color
      const isFailed = r.status === 'failed'
      const [kind, requests, memory] = r.details
      const line = (text: string | undefined) =>
        text === undefined ? null : (
          <Text dimColor wrap="truncate-end">
            {`  ${text}`}
          </Text>
        )
      return (
        <Box key={v.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={color} dimColor={isFailed}>
              {FIGURE_GLYPH[species]}
            </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold dimColor={isFailed} wrap="truncate-end">
                {r.title}
              </Text>
            </Box>
            {r.status === 'unknown' ? (
              <Text dimColor>{STATUS_GLYPH.unknown}</Text>
            ) : (
              <Text color={r.status === 'done' ? 'success' : isFailed ? 'error' : color}>{STATUS_GLYPH[r.status]}</Text>
            )}
          </Box>
          <Box flexDirection="row" paddingLeft={2}>
            <Box flexShrink={1}>
              <Text color={modelColor} wrap="truncate-end">
                {r.model}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{r.meta}</Text>
            </Box>
          </Box>
          {r.warning ? (
            <Text color="warning" wrap="truncate-end">
              {`  ${r.warning}`}
            </Text>
          ) : null}
          {line(kind)}
          {line(requests)}
          {line(memory === undefined ? undefined : `${ctxBar(v.pct, barW)} ${memory}`)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box key="summary">
          <Text bold wrap="truncate-end">
            {summary}
          </Text>
        </Box>
        {clear}
        {empty}
        <Box flexDirection="column" marginTop={1}>
          {views.map(row)}
        </Box>
        {more}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const b = await read($, batch)
    if (!isLive(b) || b.isDismissed) return next(e)
    const view = batchOf(b)

    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const buttons = [
      <Button key="deck" label="Deck" plain dimColor onPress={() => togglePane($)} />,
      <Button
        key="hide"
        label="×"
        role="dismiss"
        plain
        dimColor
        onPress={() => update($, batch, (cur) => ({ ...cur, isDismissed: true }))}
      />,
    ]
    const count = `${view.finished}/${view.total}`
    const percent = `${Math.round(bandRatio(view) * 100)}%`

    let band: RenderElement
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const w = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      band = (
        <Box key="band" flexShrink={1}>
          <Svg
            source={bandSvg(w, view)}
            alt={`Agents ${count} · ${percent} · ${view.running} running`}
            width={w}
            height={BAND_H}
          />
        </Box>
      )
    } else {
      const width = Math.max(6, Math.min(40, (e.props.bodyColumns || 80) - 40))
      band = (
        <Box key="band" flexDirection="row" columnGap={1} flexShrink={1}>
          <Text color={ACCENT}>●</Text>
          <Text bold>Agents</Text>
          <Text color={ACCENT}>{barText(bandRatio(view), width)}</Text>
          <Text bold>{count}</Text>
          <Text dimColor>{percent}</Text>
          <Text color={CLAY}>▣</Text>
        </Box>
      )
    }

    const row = (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="nowrap" overflow="hidden">
        {band}
        {buttons}
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    ) : (
      row
    )
  })
}
