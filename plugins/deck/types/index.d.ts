export type AgentStatus = 'running' | 'done' | 'failed'

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
}

/** A member keeps its status in the batch whether or not the deck still lists its row. */
export type BatchMember = Pick<AgentRow, 'id' | 'status'>

/** Agents started since the last moment none was running: the band's n/m. */
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
    }
  }
}
