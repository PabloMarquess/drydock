import type { Entry, SourceKind } from '../types'

const KINDS: readonly SourceKind[] = ['skill', 'mcp', 'file', 'web', 'agent', 'shell', 'instructions', 'other']

const PREFIX = '⚓ logbook'
const MAX_LINE = 1500
const MAX_SKILLS = 3
const MAX_SERVERS = 4

type Item = { label: string; count: number; failed: number; tokens: number }
export type Group = { kind: SourceKind; count: number; tokens: number; items: Item[] }

// Thresholds sit where rounding would carry into the next unit: 999_600 reads 1.0M, never 1000k.
export const tokensText = (n: number): string =>
  n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : n >= 999.5 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const times = (label: string, n: number): string => (n > 1 ? `${label} ×${n}` : label)

export const sumTokens = (entries: readonly Entry[]): number => entries.reduce((s, e) => s + e.tokens, 0)

const itemLabel = (e: Entry): string =>
  e.kind === 'agent' && e.detail && e.detail !== e.label ? `${e.label} (${e.detail})` : e.label

export const groupsOf = (entries: readonly Entry[]): Group[] => {
  const groups = new Map<SourceKind, Group>()
  for (const e of entries) {
    const group = groups.get(e.kind) ?? { kind: e.kind, count: 0, tokens: 0, items: [] }
    groups.set(e.kind, group)
    group.count += 1
    group.tokens += e.tokens
    const label = itemLabel(e)
    const item = group.items.find((i) => i.label === label)
    if (item) {
      item.count += 1
      item.failed += e.isFailed ? 1 : 0
      item.tokens += e.tokens
    } else group.items.push({ label, count: 1, failed: e.isFailed ? 1 : 0, tokens: e.tokens })
  }
  return KINDS.flatMap((k) => groups.get(k) ?? [])
}

export const itemsText = (items: readonly Item[]): string =>
  items.map((i) => `${times(i.label, i.count)}${i.failed ? ` (${i.failed} failed)` : ''}`).join(', ')

const serverOf = (label: string): string => label.split(' · ')[0] ?? label
const toolOf = (label: string): string => label.split(' · ').slice(1).join(' · ') || label

// MCP calls by server, in the order each server was first used.
const byServer = (items: readonly Item[]): { server: string; count: number; tools: Item[] }[] => {
  const servers: { server: string; count: number; tools: Item[] }[] = []
  for (const i of items) {
    const name = serverOf(i.label)
    const found = servers.find((s) => s.server === name)
    const tool = { ...i, label: toolOf(i.label) }
    if (found) {
      found.count += i.count
      found.tools.push(tool)
    } else servers.push({ server: name, count: i.count, tools: [tool] })
  }
  return servers
}

const capped = (list: readonly string[], max: number): string =>
  list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max}`

const COUNTED: Record<Exclude<SourceKind, 'skill' | 'mcp'>, [string, string]> = {
  file: ['file', 'files'],
  web: ['web', 'web'],
  agent: ['agent', 'agents'],
  shell: ['shell', 'shell'],
  instructions: ['instruction file', 'instruction files'],
  other: ['other', 'other'],
}

export const KIND_WORD: Record<SourceKind, string> = {
  skill: 'skill',
  mcp: 'mcp',
  file: 'files',
  web: 'web',
  agent: 'agents',
  shell: 'shell',
  instructions: 'instructions',
  other: 'other',
}

const countParts = (g: Group): string[] => {
  if (g.kind === 'skill') {
    const names = g.items.map((i) => i.label)
    return [`${names.length === 1 ? 'skill' : 'skills'} ${capped(names, MAX_SKILLS)}`]
  }
  if (g.kind === 'mcp') {
    const servers = byServer(g.items)
    const shown = servers.slice(0, MAX_SERVERS).map((s) => times(s.server, s.count))
    const rest = servers.length - shown.length
    return rest > 0 ? [...shown, `+${rest} mcp`] : shown
  }
  const [one, many] = COUNTED[g.kind]
  return [plural(g.count, one, many)]
}

const detailParts = (g: Group): string[] => {
  if (g.kind === 'mcp') return byServer(g.items).map((s) => `${s.server} ${itemsText(s.tools)}`)
  return [`${KIND_WORD[g.kind]} ${itemsText(g.items)}`]
}

const bounded = (line: string): string => {
  const chars = [...line]
  return chars.length <= MAX_LINE ? line : `${chars.slice(0, MAX_LINE - 1).join('')}…`
}

/**
 * One line for a turn: its sources by kind (or every source, with details), then the tokens they brought
 * into the main conversation and, apart, the tokens the subagents read for themselves.
 */
export const summaryOf = (entries: readonly Entry[], isDetails: boolean): string => {
  if (entries.length === 0) return `${PREFIX} · no new sources`
  const parts = groupsOf(entries).flatMap((g) => (isDetails ? detailParts(g) : countParts(g)))
  const main = sumTokens(entries.filter((e) => e.agentId === null))
  const inside = sumTokens(entries.filter((e) => e.agentId !== null))
  if (main > 0) parts.push(`≈${tokensText(main)} tokens in`)
  if (inside > 0) parts.push(`≈${tokensText(inside)} inside agents`)
  return bounded([PREFIX, ...parts].join(' · '))
}

const topKey = (e: Entry): string => {
  switch (e.kind) {
    case 'skill':
      return `skill ${e.label}`
    case 'mcp':
      return serverOf(e.label)
    case 'agent':
      return `agent ${e.label}`
    case 'other':
      return e.label
    default:
      return KIND_WORD[e.kind]
  }
}

/** The sources that brought the most tokens: skills and agents by name, MCP by server, the rest by kind. */
export const topOf = (entries: readonly Entry[], max = 3): [string, number][] => {
  const sums = new Map<string, number>()
  for (const e of entries) if (e.tokens > 0) sums.set(topKey(e), (sums.get(topKey(e)) ?? 0) + e.tokens)
  return [...sums].sort((a, b) => b[1] - a[1]).slice(0, max)
}
