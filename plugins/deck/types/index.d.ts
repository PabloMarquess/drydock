export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  status: AgentStatus
  workflow: string | null
  startedAt: number
  endedAt: number | null
  requests: number
  tokens: number
  context: number
  usd: number
  isPriced: boolean
}

declare module 'claude-code' {
  interface PluginState {
    deck: {
      agents: AgentRow[]
      now: number
      autoOpened: boolean
    }
  }
}
