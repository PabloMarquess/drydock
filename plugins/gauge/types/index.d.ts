export type Stats = {
  turn: number
  speed: number | null
  turnUsd: number | null
  totalUsd: number | null
  context: number | null
  usdAtTurnStart: number
}

export type Cache = {
  lastAt: number | null
  secondsLeft: number | null
  warned: boolean
}

declare module 'claude-code' {
  interface PluginState {
    gauge: {
      stats: Stats
      cache: Cache
      isHidden: boolean
      isBusy: boolean
    }
  }
}
