import type { Elements, RenderElement } from 'claude-code'

import type { Entry, Expanded, SourceKind, Turn } from '../types'
import { isOpen } from './expanded'
import { clean } from './sources'
import { type Group, groupsOf, type Item, itemsText, KIND_WORD, plural, sumTokens, tokensText } from './summary'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** What the pane draws: the drawn turns newest first, the sources waiting for a turn, what is expanded. */
export type PaneView = {
  turns: readonly Turn[]
  kept: number
  hidden: number
  waiting: readonly Entry[]
  total: number
  isOff: boolean
  isCard: boolean
  expanded: Readonly<Expanded>
}

/** What a press does: it writes only what is expanded, never the log. */
export type PaneActions = {
  toggle: (key: string, scope: string) => unknown
  setAll: (scope: string, open: boolean) => unknown
}

/** The most rows an open group lists, items or subagents, and the most subagents a turn's foot shows; a row counts the rest. */
export const MAX_ITEMS = 30

/** The most items a folded group's row names; `+n` counts the rest. */
export const MAX_PREVIEW = 8

/**
 * What the rows under the turns' own rows draw in all, newest turn first. Past either bound a turn draws one
 * row that says so; each turn's own row, with `expand all` or `collapse all`, always draws.
 */
export const MAX_ROWS = 400
export const MAX_CHARS = 50_000

const MAX_PREVIEW_CHARS = 200
const MAX_INDENT = 24
const WORD_WIDTH = 6
const FULL = 'more than the pane draws: collapse a group or a turn to see the rest'

const PANE_WORD: Record<SourceKind, string> = { ...KIND_WORD, instructions: 'instr' }

const KIND_COLOR: Record<SourceKind, string> = {
  skill: 'claude',
  mcp: 'permission',
  file: 'ide',
  web: 'suggestion',
  agent: 'merged',
  shell: 'bashBorder',
  instructions: 'remember',
  other: 'inactive',
}

// Kinds whose `detail` says what the label does not: a skill's source, an instruction file's tier.
const WITH_DETAIL: ReadonlySet<SourceKind> = new Set(['skill', 'instructions'])

const pad = (n: number): string => String(n).padStart(2, '0')

const clockOf = (at: number): string => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const isSpawn = (e: Entry): boolean => e.kind === 'agent'

const agentLabel = (spawn: Entry): string =>
  spawn.detail && spawn.detail !== spawn.label ? `${spawn.label} (${spawn.detail})` : spawn.label

const cut = (text: string, max: number): string => {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

const previewOf = (g: Group): string => {
  const rest = g.items.length - MAX_PREVIEW
  return `${cut(itemsText(g.items.slice(0, MAX_PREVIEW)), MAX_PREVIEW_CHARS)}${rest > 0 ? ` +${rest}` : ''}`
}

const tokensOf = (n: number): string => (n > 0 ? ` ≈${tokensText(n)}` : '')

// Keys a subagent's id cannot make equal to another's: the main loop is `main`, a subagent's loop `a:<id>`,
// its own row `agent:<id>`.
const groupKey = (scope: string, loop: string | null, kind: SourceKind): string =>
  `${scope}-${loop === null ? 'main' : `a:${loop}`}-${kind}`

const agentKey = (scope: string, id: string): string => `${scope}-agent:${id}`

/**
 * A turn's sources, or the waiting ones, by the loop that used them (`null`, the main conversation), with each
 * subagent placed once: under the first loop, walking from the main one, whose spawn names it. At the foot go
 * the agents no walk reaches: those no spawn in the scope names (resumed, or the spawn dropped) first, then
 * any whose spawns name each other.
 */
type Scope = {
  key: string
  own: Map<string | null, Entry[]>
  groups: Map<string | null, Group[]>
  children: Map<string | null, string[]>
  spawns: Map<string, Entry>
  foot: string[]
}

const scopeOf = (key: string, entries: readonly Entry[]): Scope => {
  const own = new Map<string | null, Entry[]>()
  const spawns = new Map<string, Entry>()
  for (const e of entries) {
    const list = own.get(e.agentId)
    if (list) list.push(e)
    else own.set(e.agentId, [e])
    if (isSpawn(e) && e.ref !== null && !spawns.has(e.ref)) spawns.set(e.ref, e)
  }
  const children = new Map<string | null, string[]>()
  const placed = new Set<string>()
  const walk = (root: string | null) => {
    const queue = [root]
    for (let i = 0; i < queue.length; i++) {
      const loop = queue[i] ?? null
      for (const e of own.get(loop) ?? []) {
        if (!isSpawn(e) || e.ref === null || placed.has(e.ref)) continue
        placed.add(e.ref)
        const list = children.get(loop)
        if (list) list.push(e.ref)
        else children.set(loop, [e.ref])
        queue.push(e.ref)
      }
    }
  }
  walk(null)
  const loops = [...own.keys()].filter((id): id is string => id !== null)
  const foot: string[] = []
  for (const id of [...loops.filter((x) => !spawns.has(x)), ...loops]) {
    if (placed.has(id)) continue
    placed.add(id)
    foot.push(id)
    walk(id)
  }
  const groups = new Map([...own].map(([loop, list]) => [loop, groupsOf(list)] as const))
  return { key, own, groups, children, spawns, foot }
}

/**
 * The timeline: one block per turn, its sources grouped by kind, each row of it flat under the turn, indented.
 * Each group is a Button that shows or hides its items; the agents group lists each subagent with its own
 * groups, expandable the same way. Rows are drawn newest turn first while the pane's bounds allow.
 */
export const drawPane = (ui: Ui, v: PaneView, act: PaneActions) => {
  const { Box, Text, Button } = ui
  const card = v.isCard ? ({ borderStyle: 'round', borderDimColor: true, paddingX: 1 } as const) : {}
  const used = { rows: 0, chars: 0 }

  // Once a row does not fit, none after it does either, so the rows drawn are always the first ones.
  const fits = (chars: number): boolean => {
    if (used.rows >= MAX_ROWS || used.chars + chars > MAX_CHARS) {
      used.rows = MAX_ROWS
      return false
    }
    used.rows += 1
    used.chars += chars
    return true
  }

  const at = (indent: number) => Math.min(indent, MAX_INDENT)

  const note = (key: string, text: string, indent = 2) => (
    <Box key={key} paddingLeft={indent}>
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )

  // A scope's rows in order, until the pane's bounds; `isFull` when some were left out.
  const rowsOf = (scope: Scope) => {
    const rows: RenderElement[] = []
    const add = (chars: number, draw: () => RenderElement): boolean => {
      if (!fits(chars)) return false
      rows.push(draw())
      return true
    }
    const isGroupOpen = (key: string) => isOpen(v.expanded, key, scope.key)

    const item = (key: string, i: Item, kind: SourceKind, indent: number) => {
      const label = itemsText([i])
      const detail = WITH_DETAIL.has(kind) && i.detail ? ` ${i.detail}` : ''
      const tokens = tokensOf(i.tokens)
      return add(label.length + detail.length + tokens.length, () => (
        <Box key={key} paddingLeft={at(indent)}>
          <Text wrap="truncate-end">
            {label}
            {detail ? <Text dimColor>{detail}</Text> : null}
            {tokens ? <Text dimColor>{tokens}</Text> : null}
          </Text>
        </Box>
      ))
    }

    const more = (key: string, n: number, indent: number) => {
      const text = `+${n} more`
      return add(text.length, () => note(key, text, at(indent)))
    }

    // A subagent: its name and type, what it read for itself and handed back, then its own groups.
    const agent = (id: string, indent: number): boolean => {
      const spawn = scope.spawns.get(id)
      const own = scope.own.get(id) ?? []
      const label = spawn ? agentLabel(spawn) : `agent ${clean(id, 8)}`
      const inside = sumTokens(own)
      const insideText = inside > 0 ? ` ≈${tokensText(inside)} inside` : ''
      const tokens = tokensOf(spawn?.tokens ?? 0)
      const none = own.length === 0 ? ' no sources' : ''
      const drawn = add(2 + label.length + insideText.length + tokens.length + none.length, () => (
        <Box key={agentKey(scope.key, id)} paddingLeft={at(indent)}>
          <Text wrap="truncate-end">
            <Text color={KIND_COLOR.agent}>{'↳ '}</Text>
            {label}
            {insideText ? <Text dimColor>{insideText}</Text> : null}
            {tokens ? <Text dimColor>{tokens}</Text> : null}
            {none ? <Text dimColor>{none}</Text> : null}
          </Text>
        </Box>
      ))
      return drawn && groups(id, indent + 2)
    }

    const agents = (ids: readonly string[], moreKey: string, indent: number): boolean => {
      for (const id of ids.slice(0, MAX_ITEMS)) if (!agent(id, indent)) return false
      return ids.length > MAX_ITEMS ? more(moreKey, ids.length - MAX_ITEMS, indent) : true
    }

    const group = (loop: string | null, g: Group, indent: number): boolean => {
      const key = groupKey(scope.key, loop, g.kind)
      const open = isGroupOpen(key)
      const mark = open ? '▾ ' : '▸ '
      const word = PANE_WORD[g.kind].padEnd(WORD_WIDTH)
      const count = ` ${g.count}`
      const preview = open ? '' : ` ${previewOf(g)}`
      const tokens = tokensOf(g.tokens)
      // The Button's label counts twice: drawn, and as the control's name.
      const chars = 2 * (mark.length + word.length) + count.length + preview.length + tokens.length
      const drawn = add(chars, () => (
        <Box key={key} flexDirection="row" paddingLeft={at(indent)}>
          <Button key={`toggle-${key}`} plain onPress={() => act.toggle(key, scope.key)}>
            {mark}
            <Text color={KIND_COLOR[g.kind]}>{word}</Text>
          </Button>
          <Text wrap="truncate-end">
            <Text dimColor>{count}</Text>
            {preview}
            {tokens ? <Text dimColor>{tokens}</Text> : null}
          </Text>
        </Box>
      ))
      if (!drawn || !open) return drawn
      if (g.kind === 'agent') return agents(scope.children.get(loop) ?? [], `${key}.more`, indent + 4)
      for (const [n, i] of g.items.slice(0, MAX_ITEMS).entries())
        if (!item(`${key}.${n}`, i, g.kind, indent + 4)) return false
      return g.items.length > MAX_ITEMS ? more(`${key}.more`, g.items.length - MAX_ITEMS, indent + 4) : true
    }

    const groups = (loop: string | null, indent: number): boolean => {
      for (const g of scope.groups.get(loop) ?? []) if (!group(loop, g, indent)) return false
      return true
    }

    const isFull = !(groups(null, 2) && agents(scope.foot, `${scope.key}-foot.more`, 2))
    return { rows, isFull }
  }

  // What `collapse all` folds: a group in view, the main loop's or a foot agent's; those under a folded
  // agents group are out of view.
  const anyOpen = (scope: Scope) =>
    [null, ...scope.foot.slice(0, MAX_ITEMS)].some((loop) =>
      (scope.groups.get(loop) ?? []).some((g) => isOpen(v.expanded, groupKey(scope.key, loop, g.kind), scope.key)),
    )

  const tokens = (n: number) =>
    n > 0 ? (
      <Box flexShrink={0}>
        <Text dimColor>{`≈${tokensText(n)}`}</Text>
      </Box>
    ) : null

  const block = (t: Turn) => {
    const scope = scopeOf(`t${t.index}`, t.entries)
    const isAnyOpen = anyOpen(scope)
    const { rows, isFull } = rowsOf(scope)
    return (
      <Box key={`turn-${t.index}`} flexDirection="column" marginBottom={1} {...card}>
        <Box flexDirection="row" columnGap={1}>
          <Text color="claude" bold>{`#${t.index}`}</Text>
          <Text dimColor>{clockOf(t.startedAt)}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold wrap="truncate-end">
              {t.title}
            </Text>
          </Box>
          {tokens(sumTokens(t.entries.filter((x) => x.agentId === null)))}
          {t.entries.length > 0 ? (
            <Box flexShrink={0}>
              <Button
                key={`all-${scope.key}`}
                label={isAnyOpen ? 'collapse all' : 'expand all'}
                plain
                dimColor
                onPress={() => act.setAll(scope.key, !isAnyOpen)}
              />
            </Box>
          ) : null}
        </Box>
        {t.entries.length === 0 ? note(`${scope.key}-none`, 'no new sources') : null}
        {rows}
        {isFull ? note(`${scope.key}-full`, FULL) : null}
        {t.dropped > 0
          ? note(`${scope.key}-dropped`, `${plural(t.dropped, 'older entry', 'older entries')} dropped`)
          : null}
      </Box>
    )
  }

  const waiting = () => {
    const scope = scopeOf('pending', v.waiting)
    const { rows, isFull } = rowsOf(scope)
    return (
      <Box key="pending" flexDirection="column" marginBottom={1} {...card}>
        <Text bold>Before the next prompt</Text>
        {rows}
        {isFull ? note('pending-full', FULL) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box key="header" marginBottom={1}>
        <Text bold wrap="truncate-end">
          {`${plural(v.kept, 'turn')} · ${plural(v.total, 'entry', 'entries')}${v.isOff ? ' · recording off' : ''}`}
        </Text>
      </Box>
      {v.kept === 0 && v.waiting.length === 0 ? (
        <Box key="empty">
          <Text dimColor>
            No sources yet. Skills, MCP calls, files, web, shell, subagents and instruction files show up here, turn by
            turn.
          </Text>
        </Box>
      ) : null}
      {v.waiting.length > 0 ? waiting() : null}
      {v.turns.map(block)}
      {v.hidden > 0 ? (
        <Box key="more">
          <Text dimColor>{`${plural(v.hidden, 'earlier turn')} not shown`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
