export type Palette = 'manteiga' | 'areia' | 'argila' | 'gelo' | 'cinza' | 'plain'

declare module 'claude-code' {
  interface PluginState {
    livery: {
      palette: Palette | null
      isOff: boolean
    }
  }
}
