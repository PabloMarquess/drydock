/** `unknown`: a task whose end the deck never saw; it counts as finished, never as failed. */
export type AgentStatus = 'running' | 'done' | 'failed' | 'unknown'

/** What Kiro's row adds: its `--agent` and `--effort`, and the usage it printed after its answer. */
export type KiroInfo = {
  /** `--agent` and `--effort`, redacted; empty when not given. */
  agent: string
  effort: string
  /** Credits, Kiro's own time and tokens, as Kiro printed them; empty when it did not say. */
  credits: string
  time: string
  tokens: string
}

/**
 * A command a row follows: a `kiro-cli chat` the Bash tool ran (in the foreground or the background), a
 * Bash command run in the background, or a Monitor. Its row never keeps the command itself.
 */
export type ShellRun = {
  /** The tool that started it. */
  tool: 'Bash' | 'Monitor'
  /** The program the command runs, never its arguments (`node`, `psql`); empty for a Monitor. */
  program: string
  /** The tool call's id, which a background task's notification names. */
  toolUseId: string
  /** The loop that ran the call: a subagent's id, or null for the main conversation. */
  owner: string | null
  /** The background task's id, once the call returned with it still running; empty until then. */
  shellId: string
  isBackground: boolean
  /**
   * Asked to run in the background, its call has not returned yet: the command has not started (a
   * permission dialog, usually), so its time does not run.
   */
  isWaiting: boolean
  /** A Monitor's: it ends with the session, has no deadline and never counts in the band. */
  isPersistent: boolean
  /** A Monitor's timeout, when it has one: past it, and a minute of grace, its row closes. */
  deadline: number | null
  /** The command ends with its owner's final response, and no notification follows (the Bash result said so). */
  endsWithOwner: boolean
  /** When the command went to the background. */
  backgroundAt: number | null
  /** Why it ended as it did (`exit 2`, `stopped`, `interrupted`); empty for a plain finish. */
  note: string
  /** Set on a Kiro run's row; null on a background task's. */
  kiro: KiroInfo | null
}

export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  status: AgentStatus
  workflow: string | null
  /** The start of the agent's latest run. */
  startedAt: number
  endedAt: number | null
  /** Earlier runs of an agent that ran again, `[start, end]` each: the waits between them do not count. */
  runs: [number, number][]
  requests: number
  /** Tokens processed: every request's whole prompt plus its output, summed over the requests. */
  tokens: number
  /** The last request's prompt plus output: the agent's memory, over the model's window. */
  context: number
  usd: number
  isPriced: boolean
  /** Set on a Kiro run's row (type `Kiro`, never priced: Kiro bills its own credits) and a background task's (type `Task`). */
  shell?: ShellRun
}

export type Costume = 'fable' | 'heavy' | 'careful' | 'medium' | 'light' | 'explore' | 'other'

/** The figure a row draws: Pixel Clawd, Kiro's ghost, or a background task's submarine. */
export type Species = 'crab' | 'ghost' | 'sub'

/** Which costume each target wears: `all`, an agent type (`explore`, `plan`, `kiro`) or a model family. */
export type Wardrobe = Record<string, Costume>

/**
 * A member keeps its status in the batch whether or not the deck still lists its row. A background task
 * (`isTask`) joins a batch agents started, and never keeps it running.
 */
export type BatchMember = Pick<AgentRow, 'id' | 'status'> & { isTask?: true }

/** Agents (Kiro runs included) started since the last moment none was running, with the tasks started meanwhile: the band's n/m. */
export type Batch = {
  members: BatchMember[]
  /** Finished members dropped to keep the list short; they still count as finished. */
  folded: number
  /** The band's × hid this batch; the next batch shows the band again. */
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    deck: {
      agents: AgentRow[]
      now: number
      autoOpened: boolean
      batch: Batch
      /** `/deck band`: hides the band for the session. */
      isBandHidden: boolean
      /** `/deck details`: the header adds cost and time, each row its type, workflow, cost, requests, tokens processed and memory. */
      isDetails: boolean
      /** `/deck costume`: costumes chosen for the session, over the `costumes` option. */
      wardrobe: Wardrobe
      /** `/deck costume random on|off` for the session; null leaves it to the `randomCostumes` option. */
      isRandom: boolean | null
      /** `/deck tasks on|off` for the session; null leaves it to the `showTasks` option. */
      isTasks: boolean | null
    }
  }
}
