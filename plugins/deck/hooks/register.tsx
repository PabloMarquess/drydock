import type { EngineInterface, Register, RenderElement, Timer, TurnCompleteInput, TurnUsage } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { AgentRow, AgentStatus, Batch, BatchMember } from '../types'
import {
  ACCENT,
  agentSvg,
  BAND_H,
  type BandArt,
  bandRatio,
  bandSvg,
  barText,
  CLAY,
  colorOf,
  costumeOf,
  ctxBar,
  gridSvg,
  gridTiles,
  HEADER_H,
  headerSvg,
  LINE_H,
  type RowArt,
  rowHeight,
  STATUS_GLYPH,
} from './art'
import { costOf, modelName, promptTokens, windowOf } from './pricing'

const PANE = 'deck'
const TITLE = 'Deck'
const MAX_ROWS = 200
const MAX_DRAWN = 30
const MAX_RUNS = 20
const MAX_TEXT = 300
const MAX_ID = 100
const WARN_AT = 70
const USAGE = 'Usage: /deck [pane|band|details|clear]'

const COST_NOTE =
  'Cost is an estimate at API list prices. Agent time is how long at least one listed agent was running: parallel agents count once, idle gaps not at all.'
const DETAILS_NOTE =
  "Tokens processed adds up every request's whole prompt plus its output: each request sends the agent's conversation again, so it grows much faster than the conversation and is what the cost follows. Memory is the last request's size over the model's window."
const WARN_NOTE =
  'From 70% memory each call resends a large prompt, so it costs more, and near the limit the agent compacts or fails. If it is nearly done, let it finish; if it keeps going, stop it and split the work into narrower tasks.'

const EMPTY_BATCH: Batch = { members: [], folded: 0, isDismissed: false }

const agents = atom({ plugin: 'deck', key: 'agents' } as const, [])
const now = atom({ plugin: 'deck', key: 'now' } as const, 0)
const autoOpened = atom({ plugin: 'deck', key: 'autoOpened' } as const, false)
const batch = atom({ plugin: 'deck', key: 'batch' } as const, EMPTY_BATCH)
const isBandHidden = atom({ plugin: 'deck', key: 'isBandHidden' } as const, false)
const isDetails = atom({ plugin: 'deck', key: 'isDetails' } as const, false)

// Control characters, lone surrogates and U+FFFE/U+FFFF (which XML forbids, so the desktop's image of
// the row would not draw), and the bidi overrides that could reorder what a row shows.
const CONTROL = /[\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069\uFFFE\uFFFF]/gu

const clean = (s: string, max = MAX_TEXT): string => {
  let out = ''
  let n = 0
  for (const ch of s) {
    if (n++ === max) break
    out += ch
  }
  return out.replace(CONTROL, ' ').trim()
}

const isRunning = (a: { status: AgentStatus }): boolean => a.status === 'running'

// Drops the oldest items `isKept` does not hold until the list fits `max`.
const trim = <T,>(list: T[], max: number, isKept: (x: T) => boolean): T[] => {
  let extra = list.length - max
  return extra <= 0 ? list : list.filter((x) => isKept(x) || extra-- <= 0)
}

const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

const tokens = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(Math.round(n))

const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const cost = (list: AgentRow[]): string =>
  `≈${usd(list.reduce((s, a) => s + a.usd, 0))}${list.every((a) => a.isPriced) ? '' : '+'}`

const endOf = (a: AgentRow, at: number): number => a.endedAt ?? Math.max(at, a.startedAt)

const spansOf = (a: AgentRow, at: number): [number, number][] => [...a.runs, [a.startedAt, endOf(a, at)]]

const runTime = (a: AgentRow, at: number): number => spansOf(a, at).reduce((s, [from, to]) => s + to - from, 0)

// Past MAX_RUNS the two oldest runs merge, the wait between them counted.
const withRun = (runs: [number, number][], run: [number, number]): [number, number][] => {
  const [first, second, ...rest] = [...runs, run]
  if (runs.length < MAX_RUNS || !first || !second) return [...runs, run]
  return [[first[0], second[1]], ...rest]
}

// Wall time during which at least one listed agent was running: overlapping runs count once and the
// gaps between them not at all.
const busyTime = (list: AgentRow[], at: number): number => {
  const spans = list.flatMap((a) => spansOf(a, at)).sort((p, q) => p[0] - q[0])
  let total = 0
  let from = 0
  let to = Number.NEGATIVE_INFINITY
  for (const [start, end] of spans) {
    if (start > to) {
      if (to > from) total += to - from
      from = start
      to = end
    } else if (end > to) to = end
  }
  return to > from ? total + to - from : total
}

const totalsOf = (list: AgentRow[], at: number) => {
  const running = list.filter(isRunning).length
  const failed = list.filter((a) => a.status === 'failed').length
  return {
    cost: cost(list),
    time: duration(busyTime(list, at)),
    running,
    finished: list.length - running - failed,
    failed,
  }
}

type Totals = ReturnType<typeof totalsOf>

const agentsText = (t: Totals): string =>
  `${t.running} running · ${t.finished} finished${t.failed ? ` · ${t.failed} failed` : ''}`

const memoryOf = (a: AgentRow) => {
  const window = windowOf(a.model)
  return { window, pct: Math.min(100, Math.floor((a.context * 100) / window)) }
}

// Only a running agent warns: a finished one makes no more calls.
const isWarned = (a: AgentRow): boolean => isRunning(a) && memoryOf(a).pct >= WARN_AT

type View = { id: string; art: RowArt; pct: number; alt: string }

const viewOf = (a: AgentRow, at: number, withDetails: boolean): View => {
  const { window, pct } = memoryOf(a)
  const art: RowArt = {
    title: a.description || a.type,
    costume: costumeOf(a.type, a.model),
    status: a.status,
    model: modelName(a.model),
    meta: ` · ${duration(runTime(a, at))}`,
    warning: isWarned(a) ? `memory ${pct}% · large and costly per call` : '',
    details: withDetails
      ? [
          `${a.type}${a.workflow ? ` · workflow ${a.workflow}` : ''}`,
          `${cost([a])} · ${a.requests} ${a.requests === 1 ? 'request' : 'requests'} · ${tokens(a.tokens)} tokens processed`,
          `memory ${tokens(a.context)} / ${tokens(window)} (${pct}%)`,
        ]
      : [],
  }
  const alt = [`${art.title}: ${a.status}`, `${art.model}${art.meta}`, art.warning, ...art.details]
    .filter(Boolean)
    .join(' · ')
  return { id: a.id, art, pct, alt }
}

const batchOf = (b: Batch): BandArt => {
  const running = b.members.filter(isRunning).length
  const total = b.members.length + b.folded
  return { total, finished: total - running, running }
}

const paneState = async ($: EngineInterface): Promise<'open' | 'waiting' | 'closed'> => {
  const pane = (await $.ui.panes()).find((p) => p.id === PANE)
  return pane === undefined ? 'closed' : pane.isPlaced ? 'open' : 'waiting'
}

const openPane = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)
  return $.ui.open({ id: PANE, title: TITLE })
}

// A pane opened by itself on a narrow terminal is listed but not drawn: the person's press shows it.
const togglePane = async ($: EngineInterface): Promise<string> => {
  if ((await paneState($)) === 'open') {
    await $.ui.close({ id: PANE })
    return 'Deck closed.'
  }
  return (await openPane($)).isPlaced ? 'Deck opened.' : 'Deck opened; it shows when there is room.'
}

// One update decides both whether the deck was idle and the membership, so agents that start at the
// same moment all land in the same batch.
const join = ($: EngineInterface, id: string) =>
  update($, batch, (b) => {
    const member: BatchMember = { id, status: 'running' }
    if (b.members.some((m) => m.id === id && isRunning(m))) return b
    if (!b.members.some(isRunning)) return { ...EMPTY_BATCH, members: [member] }
    const members = b.members.some((m) => m.id === id)
      ? b.members.map((m) => (m.id === id ? member : m))
      : [...b.members, member]
    const kept = trim(members, MAX_ROWS, isRunning)
    return { ...b, members: kept, folded: b.folded + members.length - kept.length }
  })

const settle = async ($: EngineInterface, id: string, status: AgentStatus) => {
  if (!(await read($, batch)).members.some((m) => m.id === id)) return
  await update($, batch, (b) => ({ ...b, members: b.members.map((m) => (m.id === id ? { id, status } : m)) }))
}

const clearFinished = ($: EngineInterface) => update($, agents, (list) => list.filter(isRunning))

const tick = async ($: EngineInterface) => {
  if (!(await read($, agents)).some(isRunning)) return
  const at = await $.clock.now()
  await update($, now, () => at)
}

// A finished agent asked again (a background agent, a teammate) starts a new run.
const resume = async ($: EngineInterface, agentId: string) => {
  const row = (await read($, agents)).find((a) => a.id === agentId)
  if (!row || isRunning(row)) return
  const at = await $.clock.now()
  await update($, agents, (list) =>
    list.map((a) =>
      a.id !== agentId || isRunning(a)
        ? a
        : {
            ...a,
            status: 'running',
            runs: withRun(a.runs, [a.startedAt, endOf(a, at)]),
            startedAt: at,
            endedAt: null,
          },
    ),
  )
  await join($, agentId)
  await update($, now, () => at)
}

const recordStep = async ($: EngineInterface, agentId: string, usage: TurnUsage, writeMultiplier: number) => {
  if (!(await read($, agents)).some((a) => a.id === agentId)) return
  const model = clean(usage.model, MAX_ID)
  const cost = costOf(model, usage, writeMultiplier)
  const prompt = promptTokens(usage)
  await update($, agents, (list) =>
    list.map((a) =>
      a.id !== agentId
        ? a
        : {
            ...a,
            model: model || a.model,
            requests: a.requests + 1,
            tokens: a.tokens + prompt + usage.output_tokens,
            context: prompt + usage.output_tokens,
            usd: a.usd + (cost ?? 0),
            isPriced: a.isPriced && cost !== null,
          },
    ),
  )
}

const finish = async ($: EngineInterface, e: TurnCompleteInput, agentId: string, writeMultiplier: number) => {
  const at = await $.clock.now()
  const status: AgentStatus = e.reason === 'answer' ? 'done' : 'failed'
  await update($, agents, (list) =>
    list.map((a) => {
      if (a.id !== agentId) return a
      const ended: AgentRow = { ...a, status, endedAt: at }
      if (a.requests > 0 || !e.usage) return ended
      const model = clean(e.usage.model, MAX_ID) || a.model
      const cost = costOf(model, e.usage, writeMultiplier)
      return {
        ...ended,
        model,
        tokens: promptTokens(e.usage) + e.usage.output_tokens,
        usd: cost ?? 0,
        isPriced: cost !== null,
      }
    }),
  )
  await settle($, agentId, status)
  await update($, now, () => at)
}

// `/deck band` hides the band for the session; its × hides it for the running batch alone.
const bandState = async ($: EngineInterface): Promise<'hidden' | 'dismissed' | 'on'> => {
  if (await read($, isBandHidden)) return 'hidden'
  const b = await read($, batch)
  return b.isDismissed && b.members.some(isRunning) ? 'dismissed' : 'on'
}

// The one-line status is the command's text, which the model also reads; the notes explaining it are
// notices the model never reads.
const statusOf = async ($: EngineInterface): Promise<{ text: string; notes: string[] }> => {
  const list = await read($, agents)
  const t = totalsOf(list, await $.clock.now())
  const pane = await paneState($)
  const band = await bandState($)
  const withDetails = await read($, isDetails)
  const warned = list.filter(isWarned).length
  const text = [
    `${agentsText(t)} · ${t.cost} · ${t.time} agent time.`,
    `Pane ${pane === 'waiting' ? 'waiting for room (/deck pane shows it)' : pane}, band ${band === 'dismissed' ? 'dismissed for this batch' : band}, details ${withDetails ? 'on' : 'off'}.`,
    warned ? `${warned} running ${warned === 1 ? 'agent is' : 'agents are'} at 70% memory or more.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { text, notes: [COST_NOTE, withDetails ? DETAILS_NOTE : '', warned ? WARN_NOTE : ''].filter(Boolean) }
}

export const register: Register = (on, options) => {
  const writeMultiplier = options.subagentCacheTtl === '1h' ? 2 : 1.25
  const autoOpen = options.autoOpen !== false
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($).catch(() => undefined))
    await $.command.register({
      name: 'deck',
      description:
        'Agents deck status; `pane` shows or hides it, `band` the band, `details` the extra numbers, `clear` drops finished agents',
      argumentHint: '[pane|band|details|clear]',
      immediate: true,
    })
    return result
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      const status = await statusOf($)
      for (const note of status.notes) $.ui.log(note)
      return { text: status.text }
    }
    if (arg === 'pane') return { text: await togglePane($) }
    if (arg === 'band') {
      const isShown = (await bandState($)) === 'on'
      await update($, isBandHidden, () => isShown)
      if (!isShown) await update($, batch, (b) => ({ ...b, isDismissed: false }))
      return { text: isShown ? 'Band hidden.' : 'Band shown.' }
    }
    if (arg === 'details') {
      const shown = await update($, isDetails, (d) => !d)
      if (shown) $.ui.log(DETAILS_NOTE)
      return {
        text: shown
          ? 'Details on: the header adds cost and time, each row its type, workflow, cost, requests, tokens processed and memory.'
          : 'Details off.',
      }
    }
    if (arg === 'clear') {
      await clearFinished($)
      return { text: 'Finished and failed agents cleared.' }
    }
    return { text: USAGE }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    const at = await $.clock.now()
    const row: AgentRow = {
      id,
      type: clean(e.subagentType, MAX_ID),
      description: clean(e.description),
      model: clean(started.model, MAX_ID),
      status: 'running',
      workflow: e.workflow ? clean(e.workflow.runId, 8) : null,
      startedAt: at,
      endedAt: null,
      runs: [],
      requests: 0,
      tokens: 0,
      context: 0,
      usd: 0,
      isPriced: true,
    }
    await update($, agents, (list) => trim([...list.filter((a) => a.id !== id), row], MAX_ROWS, isRunning))
    await join($, id)
    await update($, now, () => at)
    if (autoOpen && !(await read($, autoOpened))) {
      await update($, autoOpened, () => true)
      await openPane($).catch(() => undefined)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    await resume($, e.agentId).catch(() => undefined)
    const result = yield* next(e)
    if (result.usage) await recordStep($, e.agentId, result.usage, writeMultiplier).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) await finish($, e, e.agentId, writeMultiplier).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, agents, () => [])
      await update($, batch, () => EMPTY_BATCH)
      await update($, autoOpened, () => false)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const withDetails = await read($, isDetails)
    const at = Math.max(await read($, now), ...list.map((a) => a.startedAt))
    const running = list.filter(isRunning).reverse()
    const finished = list.filter((a) => !isRunning(a)).reverse()
    // Every redraw sends every drawn row, and a running one changes each second: the oldest finished
    // rows past MAX_DRAWN wait behind a count.
    const ordered = [...running, ...finished]
    const views = ordered.slice(0, MAX_DRAWN).map((a) => viewOf(a, at, withDetails))
    const hidden = ordered.length - views.length
    const t = totalsOf(list, at)
    const summary = withDetails ? `${agentsText(t)} · Cost ${t.cost} · Time ${t.time}` : agentsText(t)
    const header = withDetails ? t : { running: t.running, finished: t.finished, failed: t.failed }
    const clear =
      finished.length > 0 ? (
        <Button key="clear" label="Clear finished" plain dimColor onPress={() => clearFinished($)} />
      ) : null
    const empty =
      list.length === 0 ? (
        <Box key="empty">
          <Text dimColor>No agents yet. Subagents and workflow agents show up here as they start.</Text>
        </Box>
      ) : null
    const more =
      hidden > 0 ? (
        <Box key="more">
          <Text dimColor>{`${hidden} more ${hidden === 1 ? 'agent' : 'agents'} not shown`}</Text>
        </Box>
      ) : null

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const w = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const lines = [clear, empty, more].filter(Boolean).length
      const gridH = HEADER_H + lines * LINE_H + views.reduce((s, v) => s + rowHeight(v.art), 0)
      // The grid sizes the pane; the content is placed over it, as an absolute Box paints over the
      // siblings before it.
      return (
        <Box flexDirection="column">
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(w, tileH)} alt="dotted grid" width={w} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
            <Box key="summary">
              <Svg source={headerSvg(w, header)} alt={summary} width={w} height={HEADER_H} />
            </Box>
            {clear}
            {empty}
            {views.map((v) => (
              <Box key={v.id}>
                <Svg source={agentSvg(w, v.art)} alt={v.alt} width={w} height={rowHeight(v.art)} />
              </Box>
            ))}
            {more}
          </Box>
        </Box>
      )
    }

    const barW = Math.max(6, Math.min(16, (e.props.bodyColumns || 40) - 34))
    const row = (v: View) => {
      const r = v.art
      const color = colorOf(r.costume)
      const isFailed = r.status === 'failed'
      const [kind, requests, memory] = r.details
      const line = (text: string | undefined) =>
        text === undefined ? null : (
          <Text dimColor wrap="truncate-end">
            {`  ${text}`}
          </Text>
        )
      return (
        <Box key={v.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={color} dimColor={isFailed}>
              ▣
            </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold dimColor={isFailed} wrap="truncate-end">
                {r.title}
              </Text>
            </Box>
            <Text color={r.status === 'done' ? 'success' : isFailed ? 'error' : color}>{STATUS_GLYPH[r.status]}</Text>
          </Box>
          <Box flexDirection="row" paddingLeft={2}>
            <Box flexShrink={1}>
              <Text color={color} wrap="truncate-end">
                {r.model}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{r.meta}</Text>
            </Box>
          </Box>
          {r.warning ? (
            <Text color="warning" wrap="truncate-end">
              {`  ${r.warning}`}
            </Text>
          ) : null}
          {line(kind)}
          {line(requests)}
          {line(memory === undefined ? undefined : `${ctxBar(v.pct, barW)} ${memory}`)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box key="summary">
          <Text bold wrap="truncate-end">
            {summary}
          </Text>
        </Box>
        {clear}
        {empty}
        <Box flexDirection="column" marginTop={1}>
          {views.map(row)}
        </Box>
        {more}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const b = await read($, batch)
    const view = batchOf(b)
    if (view.running === 0 || b.isDismissed) return next(e)

    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const buttons = [
      <Button key="deck" label="Deck" plain dimColor onPress={() => togglePane($)} />,
      <Button
        key="hide"
        label="×"
        role="dismiss"
        plain
        dimColor
        onPress={() => update($, batch, (cur) => ({ ...cur, isDismissed: true }))}
      />,
    ]
    const count = `${view.finished}/${view.total}`
    const percent = `${Math.round(bandRatio(view) * 100)}%`

    let band: RenderElement
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const w = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      band = (
        <Box key="band" flexShrink={1}>
          <Svg
            source={bandSvg(w, view)}
            alt={`Agents ${count} · ${percent} · ${view.running} running`}
            width={w}
            height={BAND_H}
          />
        </Box>
      )
    } else {
      const width = Math.max(6, Math.min(40, (e.props.bodyColumns || 80) - 40))
      band = (
        <Box key="band" flexDirection="row" columnGap={1} flexShrink={1}>
          <Text color={ACCENT}>●</Text>
          <Text bold>Agents</Text>
          <Text color={ACCENT}>{barText(bandRatio(view), width)}</Text>
          <Text bold>{count}</Text>
          <Text dimColor>{percent}</Text>
          <Text color={CLAY}>▣</Text>
        </Box>
      )
    }

    const row = (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="nowrap" overflow="hidden">
        {band}
        {buttons}
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    ) : (
      row
    )
  })
}
