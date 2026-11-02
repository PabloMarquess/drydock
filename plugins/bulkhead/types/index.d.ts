export type Paused = string

declare module 'claude-code' {
  interface PluginState {
    bulkhead: {
      paused: Paused
    }
  }
}
