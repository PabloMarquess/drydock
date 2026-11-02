import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Cache, Stats } from '../types'

const MIN_TOKENS = 20
const MIN_MS = 500
const CONTEXT_WARN = 65
const CONTEXT_ALERT = 85
const GAP = 2
const BUTTON_COLUMNS = GAP * 2 + 1

const EMPTY_STATS: Stats = { turn: 0, speed: null, turnUsd: null, totalUsd: null, context: null, usdAtTurnStart: 0 }
const EMPTY_CACHE: Cache = { lastAt: null, secondsLeft: null, warned: false }

const stats = atom({ plugin: 'gauge', key: 'stats' } as const, EMPTY_STATS)
const cache = atom({ plugin: 'gauge', key: 'cache' } as const, EMPTY_CACHE)
const isHidden = atom({ plugin: 'gauge', key: 'isHidden' } as const, false)
const isBusy = atom({ plugin: 'gauge', key: 'isBusy' } as const, false)

type Segment = { key: string; full: string; short: string; color?: string; dim?: boolean; dropOrder?: number }

const minutes = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const usd = (n: number | null): string => (n === null ? '-' : `$${n.toFixed(2)}`)

const mmss = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

type Tone = 'warning' | 'error' | undefined

const contextTone = (percent: number): Tone =>
  percent >= CONTEXT_ALERT ? 'error' : percent >= CONTEXT_WARN ? 'warning' : undefined

const ICONS = {
  turn: '<path d="M4 4h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>',
  speed: '<path d="M11 2 4 11h5l-1 7 7-9h-5l1-7z"/>',
  cost: '<circle cx="10" cy="10" r="7.5"/><path d="M12.4 7.6c-.5-.6-1.3-.9-2.4-.9-1.3 0-2.3.6-2.3 1.6 0 2.2 4.8 1.2 4.8 3.4 0 1-1 1.7-2.5 1.7-1.1 0-2-.4-2.5-1M10 5.2v1.5M10 13.4v1.4"/>',
  cache: '<path d="M5 2.5h10M5 17.5h10M6 2.5c0 4.2 8 4.2 8 7.5s-8 3.3-8 7.5M14 2.5c0 4.2-8 4.2-8 7.5s8 3.3 8 7.5"/>',
  context: '<path d="M6 2h6l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M8 10h5M8 13.5h5"/>',
} as const

type Chip = {
  key: string
  icon: keyof typeof ICONS
  main: string
  extra?: string
  tone?: Tone
  bar?: number
  alt: string
  dropOrder?: number
}

const PX_PER_COLUMN = 8
const BUTTON_PX = 32
const CHIP_PAD = 10
const ICON_PX = 16
const BAR_PX = 40
const CHIP_GAP = 8

const CHIP_STYLE =
  '<style>.bg{fill:#fff;stroke:#e2e1dc}.ic{stroke:#6f6e69}.t{fill:#1f1e1d}.m{fill:#8a8984}.w{fill:#a35f00}.e{fill:#b3261e}.tr{fill:#e3e2de}.ok{fill:#1d9e75}.wb{fill:#e0a33a}.eb{fill:#d9534f}' +
  '@media (prefers-color-scheme: dark){.bg{fill:#2a2a28;stroke:#3b3b39}.ic{stroke:#a6a5a0}.t{fill:#ecebe8}.m{fill:#8f8e8a}.w{fill:#f0a640}.e{fill:#f28b82}.tr{fill:#454543}}</style>'

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const charWidth = (ch: string): number =>
  /[0-9$]/.test(ch) ? 0.6 : /[.:\s/·]/.test(ch) ? 0.32 : /[A-Z]/.test(ch) ? 0.68 : 0.55

const textWidth = (s: string): number => Math.ceil([...s].reduce((w, ch) => w + charWidth(ch) * 13, 0))

const chipWidth = (c: Chip): number =>
  CHIP_PAD +
  ICON_PX +
  6 +
  textWidth(c.main) +
  (c.extra ? 4 + textWidth(c.extra) : 0) +
  (c.bar !== undefined ? 8 + BAR_PX : 0) +
  CHIP_PAD

const chipSvg = (c: Chip): string => {
  const w = chipWidth(c)
  const tone = c.tone === 'error' ? 'e' : c.tone === 'warning' ? 'w' : 't'
  let x = CHIP_PAD + ICON_PX + 6
  const parts = [`<text x="${x}" y="16.5" class="${tone}" font-weight="600">${xml(c.main)}</text>`]
  x += textWidth(c.main)
  if (c.extra) {
    parts.push(`<text x="${x + 4}" y="16.5" class="m">${xml(c.extra)}</text>`)
    x += 4 + textWidth(c.extra)
  }
  if (c.bar !== undefined) {
    const fill = c.bar >= CONTEXT_ALERT ? 'eb' : c.bar >= CONTEXT_WARN ? 'wb' : 'ok'
    const filled = Math.round((Math.min(100, Math.max(0, c.bar)) / 100) * BAR_PX)
    parts.push(
      `<rect x="${x + 8}" y="9.5" width="${BAR_PX}" height="5" rx="2.5" class="tr"/><rect x="${x + 8}" y="9.5" width="${filled}" height="5" rx="2.5" class="${fill}"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" viewBox="0 0 ${w} 24">${CHIP_STYLE}<rect class="bg" x="0.5" y="0.5" width="${w - 1}" height="23" rx="11.5"/><g class="ic" transform="translate(${CHIP_PAD},4) scale(0.8)" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[c.icon]}</g><g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Ubuntu,sans-serif" font-size="13">${parts.join('')}</g></svg>`
}

const fitChips = (chips: Chip[], px: number): Chip[] => {
  const size = (list: Chip[]) => list.reduce((w, c) => w + chipWidth(c), 0) + CHIP_GAP * Math.max(0, list.length - 1)
  let list = chips
  while (size(list) > px) {
    const droppable = list.filter((c) => c.dropOrder !== undefined)
    if (droppable.length > 0) {
      const first = droppable.reduce((a, b) => ((b.dropOrder ?? 0) < (a.dropOrder ?? 0) ? b : a))
      list = list.filter((c) => c !== first)
      continue
    }
    const wide = list.find((c) => c.extra !== undefined || c.bar !== undefined)
    if (!wide) break
    list = list.map((c) => (c === wide ? { ...c, extra: undefined, bar: undefined } : c))
  }
  return list
}

const layout = (segments: Segment[], columns: number): (Segment & { text: string })[] => {
  const size = (list: Segment[], isShort: boolean) =>
    list.reduce((w, s) => w + (isShort ? s.short : s.full).length, 0) + GAP * Math.max(0, list.length - 1)

  if (size(segments, false) <= columns) return segments.map((s) => ({ ...s, text: s.full }))

  let list = segments
  while (size(list, true) > columns) {
    const droppable = list.filter((s) => s.dropOrder !== undefined)
    if (droppable.length === 0) break
    const first = droppable.reduce((a, b) => ((b.dropOrder ?? 0) < (a.dropOrder ?? 0) ? b : a))
    list = list.filter((s) => s !== first)
  }
  return list.map((s) => ({ ...s, text: s.short }))
}

const refresh = async ($: EngineInterface) => {
  const [usage, turns] = await Promise.all([$.session.usage(), $.session.turns()])
  const total = usage.cost?.usd ?? null
  await update($, stats, (s) => ({
    ...s,
    turn: turns,
    totalUsd: total,
    turnUsd: total === null ? null : Math.max(0, total - s.usdAtTurnStart),
    context: usage.context.percent ?? s.context,
  }))
}

const warn = async ($: EngineInterface, minutesLeft: number) => {
  const cwd = await $.session.cwd().catch(() => '')
  const project = cwd.split('/').filter(Boolean).pop() ?? 'session'
  const text = `${project}: prompt cache expires in ${minutesLeft} min`
  $.ui.toast(`⏳ ${text}`, { timeoutMs: 30_000 })
  await $.tool.call({ tool: 'PushNotification', message: text, status: 'proactive' }).catch(() => undefined)
}

const countdown = async ($: EngineInterface, ttlMs: number, warnSeconds: number) => {
  const c = await read($, cache)
  const anchor = c.lastAt
  if (anchor === null) return
  const left = Math.max(0, Math.ceil((anchor + ttlMs - (await $.clock.now())) / 1000))
  if (left !== c.secondsLeft) await update($, cache, (v) => (v.lastAt === anchor ? { ...v, secondsLeft: left } : v))
  if (warnSeconds === 0 || c.warned || left === 0 || left > warnSeconds || (await read($, isBusy))) return
  let fire = false
  await update($, cache, (v) => {
    fire = v.lastAt === anchor && !v.warned
    return fire ? { ...v, warned: true } : v
  })
  if (fire) await warn($, Math.ceil(left / 60))
}

const startTick = ($: EngineInterface, ttlMs: number, warnSeconds: number): Timer =>
  $.clock.every(1000, () => void countdown($, ttlMs, warnSeconds).catch(() => undefined))

export const register: Register = (on, options) => {
  const ttlMs = (minutes(options.cacheTtlMinutes, 60) || 60) * 60_000
  const warnSeconds = Math.min(minutes(options.warnMinutes, 5) * 60, ttlMs / 2000)
  const alertSeconds = Math.min(warnSeconds || 300, ttlMs / 4000)

  let tick: Timer | undefined
  let turnTokens = 0
  let turnMs = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    tick?.cancel()
    tick = startTick($, ttlMs, warnSeconds)
    await $.command.register({
      name: 'gauge',
      description: 'Show the gauge status; `on` and `off` show or hide the band for this session',
      argumentHint: '[on|off]',
      immediate: true,
    })
    return result
  })

  on('command.run', { command: 'gauge' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, isHidden, () => arg === 'off')
      return { text: arg === 'on' ? 'Gauge on.' : 'Gauge off for this session.' }
    }
    if (arg !== '') return { text: 'Usage: /gauge [on | off]' }
    const state = (await read($, isHidden)) ? 'off' : 'on'
    const warn = warnSeconds === 0 ? 'cache warning off' : `cache warning ${Math.round(warnSeconds / 60)} min before`
    return { text: `Gauge ${state} · cache lifetime ${ttlMs / 60_000} min · ${warn}.` }
  })

  on('turn.start', async ($, e, next) => {
    turnTokens = 0
    turnMs = 0
    const total = (await $.session.usage()).cost?.usd ?? null
    await update($, stats, (s) => ({
      ...s,
      usdAtTurnStart: total ?? 0,
      totalUsd: total,
      turnUsd: total === null ? null : 0,
    }))
    await update($, isBusy, () => true)
    tick?.cancel()
    tick = startTick($, ttlMs, warnSeconds)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const stream = next(e)
    let startedAt: number | null = null
    for await (const chunk of stream) {
      if (chunk.kind === 'stop' && chunk.usage !== null) {
        try {
          const now = await $.clock.now()
          const u = chunk.usage
          if (startedAt !== null) {
            turnMs += now - startedAt
            turnTokens += u.output_tokens
          }
          if (turnTokens >= MIN_TOKENS && turnMs >= MIN_MS) {
            const speed = Math.round(turnTokens / (turnMs / 1000))
            await update($, stats, (s) => ({ ...s, speed }))
          }
          if (u.cache_read_input_tokens > 0 || u.cache_creation_input_tokens > 0) {
            await update($, cache, () => ({ lastAt: now, secondsLeft: Math.round(ttlMs / 1000), warned: false }))
          }
          await refresh($)
        } catch {}
      } else if (startedAt === null && chunk.kind !== 'engine' && chunk.kind !== 'stop') {
        startedAt = await $.clock.now()
      }
      yield chunk
    }
    return await stream.result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await update($, isBusy, () => false)
    await refresh($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await update($, stats, (s) => {
      const total = e.cost?.usd ?? s.totalUsd
      return {
        ...s,
        totalUsd: total,
        turnUsd: total === null || s.turnUsd === null ? s.turnUsd : Math.max(0, total - s.usdAtTurnStart),
        context: e.context.percent ?? s.context,
      }
    })
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await update($, cache, () => EMPTY_CACHE)
      await update($, stats, (s) => ({ ...s, context: null }))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, stats, () => EMPTY_STATS)
      await update($, cache, () => EMPTY_CACHE)
      await update($, isBusy, () => false)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const s = await read($, stats)
    const c = await read($, cache)
    if (s.turn === 0 && s.totalUsd === null) return next(e)

    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const isWorking = e.props.isWorking
    const left = c.secondsLeft
    const cacheColor =
      isWorking || left === null
        ? undefined
        : left <= alertSeconds
          ? 'error'
          : left <= alertSeconds * 2
            ? 'warning'
            : undefined
    const cacheText = isWorking ? '…' : left === null ? '-' : left === 0 ? 'expired' : mmss(left)
    const context = s.context === null ? '-' : `${s.context}%`
    const speed = s.speed === null ? '-' : String(s.speed)

    const contextTo = s.context === null ? undefined : contextTone(s.context)
    const costFull = `${usd(s.turnUsd)} turn · ${usd(s.totalUsd)} total`

    const { Box, Text, Button } = $.ui.resolve(e)
    const hide = (
      <Button key="hide" label="×" role="dismiss" plain dimColor onPress={() => update($, isHidden, () => true)} />
    )

    let band: RenderElement
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const chips = fitChips(
        [
          { key: 'turn', icon: 'turn', main: String(s.turn), alt: `Turn ${s.turn}`, dropOrder: 2 },
          { key: 'speed', icon: 'speed', main: `${speed} tok/s`, alt: `${speed} tok/s`, dropOrder: 1 },
          { key: 'cost', icon: 'cost', main: usd(s.turnUsd), extra: `/ ${usd(s.totalUsd)}`, alt: costFull },
          { key: 'cache', icon: 'cache', main: cacheText, tone: cacheColor, alt: `cache ${cacheText}` },
          {
            key: 'context',
            icon: 'context',
            main: context,
            tone: contextTo,
            bar: s.context ?? undefined,
            alt: `ctx ${context}`,
          },
        ],
        e.props.bodyColumns * PX_PER_COLUMN - BUTTON_PX,
      )
      band = (
        <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="nowrap" overflow="hidden">
          {chips.map((c) => (
            <Box key={c.key} flexShrink={0}>
              <Svg source={chipSvg(c)} alt={c.alt} width={chipWidth(c)} height={24} />
            </Box>
          ))}
          <Box flexGrow={1} flexShrink={1} />
          {hide}
        </Box>
      )
    } else {
      const shown = layout(
        [
          { key: 'turn', full: `Turn ${s.turn}`, short: `#${s.turn}`, dim: true, dropOrder: 2 },
          { key: 'speed', full: `${speed} tok/s`, short: `${speed}/s`, dim: true, dropOrder: 1 },
          { key: 'cost', full: costFull, short: usd(s.turnUsd) },
          { key: 'cache', full: `cache ${cacheText}`, short: cacheText, color: cacheColor },
          { key: 'context', full: `ctx ${context}`, short: context, color: contextTo },
        ],
        e.props.bodyColumns - BUTTON_COLUMNS,
      )
      band = (
        <Box flexDirection="row" alignItems="center" columnGap={GAP} flexWrap="nowrap" overflow="hidden">
          {shown.map((seg) => (
            <Box key={seg.key} flexShrink={0}>
              <Text color={seg.color} dimColor={seg.dim} bold={!seg.dim}>
                {seg.text}
              </Text>
            </Box>
          ))}
          <Box flexGrow={1} flexShrink={1} />
          {hide}
        </Box>
      )
    }

    return below ? (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    ) : (
      band
    )
  })
}
