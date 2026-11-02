export type SourceKind = 'skill' | 'mcp' | 'file' | 'web' | 'agent' | 'shell' | 'instructions' | 'other'

/** One source of context: a skill, an MCP call, a file read, a fetch, a subagent, a shell command, an instruction file or another tool. */
export type Entry = {
  kind: SourceKind
  /** What it was, shortened and redacted: `finops-custos`, `datadog · search_logs`, `hooks/register.tsx`, `git`. */
  label: string
  /** How it came in: the tool, the skill's source, the agent type, the instruction file's tier. */
  detail: string
  /** The loop it was used in: null on the main loop. */
  agentId: string | null
  /** Its result's length / 4: the tokens it brought into the context, roughly; 0 when unknown. */
  tokens: number
  isFailed: boolean
  /** On an `agent` entry, the spawned agent's id; null on every other. */
  ref: string | null
}

export type Turn = {
  index: number
  /** The prompt's first words, redacted. */
  title: string
  startedAt: number
  entries: Entry[]
  /** Entries dropped past the per-turn bound. */
  dropped: number
}

export type Log = {
  /** The kept turns' numbers, oldest first; each turn lives in the `turn` slot `index % 50`. */
  turns: number[]
  /** The turn the main loop records into; null between turns and while a turn started with the logbook off. */
  open: number | null
  /** The last turn number given. */
  last: number
  /** A main-loop turn is running, recorded or not. */
  inTurn: boolean
}

export type Agent = {
  /** The turn its sources go to: the one it was spawned in; null while that turn has not opened. */
  turn: number | null
  label: string
  detail: string
  /** The loop that spawned it: null for the main loop. */
  parent: string | null
  /** Its next answer is credited to its spawn entry: true until the first one, never for a workflow's agent. */
  isAwaited: boolean
}

/**
 * What the pane draws expanded, by key: a group by its turn, loop and kind (`t3-main-shell`, a subagent's
 * `t3-a:<id>-file`), a whole turn by its own (`t3`, from `expand all`). A group's own choice wins over its
 * turn's; absent, it draws as its turn says, else collapsed. A choice equal to that is not kept.
 */
export type Expanded = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    logbook: {
      log: Log
      /** One slot per kept turn, `index % 50`; a slot whose turn has a different index is free. */
      turn: StateFamily<Turn | null>
      /** Sources used while no turn was open (a typed skill, the instruction files); the next turn takes them. */
      pending: Entry[]
      /** The subagents the conversation started, by id, the latest 300. */
      agents: Record<string, Agent>
      /** Entries recorded this session, dropped ones included. */
      recorded: number
      /** The instruction files seen, by path, with their length: each is recorded once, and again when it changes. */
      instructions: Record<string, number>
      /** Agents a plugin spawned: their calls feed that plugin, not the conversation. */
      foreign: string[]
      /** `/logbook off`: nothing is recorded and no line is shown, for the session. */
      isOff: boolean
      /** `/logbook details`: the per-turn line lists every source instead of counts. */
      isDetails: boolean
      /** The pane's groups the person expanded or collapsed, the latest 100 choices; a press, a turn taking the waiting sources, and a clear write it. */
      expanded: Expanded
    }
  }
}
