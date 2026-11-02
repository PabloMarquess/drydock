import type { Expanded } from '../types'

/** The most choices kept: past it the oldest is forgotten, a group's draws as its turn says and a turn's collapsed. */
export const MAX_EXPANDED = 100

const bounded = (entries: [string, boolean][]): Expanded => Object.fromEntries(entries.slice(-MAX_EXPANDED))

/** A group's own choice wins, then its turn's (`expand all`); collapsed by default. */
export const isOpen = (map: Readonly<Expanded>, key: string, scope: string): boolean => map[key] ?? map[scope] ?? false

/**
 * Flips one group; its choice moves to the newest end, so the bound drops the oldest. A group flipped back to
 * how its turn draws it keeps no choice.
 */
export const toggled = (map: Readonly<Expanded>, key: string, scope: string): Expanded => {
  const rest = Object.entries(map).filter(([k]) => k !== key)
  const open = !isOpen(map, key, scope)
  return bounded(open === (map[scope] ?? false) ? rest : [...rest, [key, open]])
}

/** Expands or collapses every group of a turn: the turn keeps the choice and its groups' own are dropped. */
export const allSet = (map: Readonly<Expanded>, scope: string, open: boolean): Expanded => {
  const rest = Object.entries(map).filter(([k]) => k !== scope && !k.startsWith(`${scope}-`))
  return bounded(open ? [...rest, [scope, true]] : rest)
}
