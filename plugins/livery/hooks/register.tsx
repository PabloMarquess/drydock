import type { EngineInterface, PromptOrigin, Register, RenderSurface } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Palette } from '../types'

type Tone = { bg: string; accent: string }

const tone = (rgb: string, alpha: number, accent: string): Tone => ({ bg: `rgba(${rgb}, ${alpha})`, accent })

const TONES = {
  user: tone('56, 189, 248', 0.14, 'suggestion'),
  code: tone('100, 116, 139', 0.16, 'inactive'),
  bash: tone('245, 158, 11', 0.14, 'warning'),
  edit: tone('16, 185, 129', 0.14, 'success'),
  mcp: tone('217, 70, 239', 0.12, 'remember'),
  other: tone('56, 189, 248', 0.12, 'suggestion'),
  error: tone('244, 63, 94', 0.16, 'error'),
}

type Swatch = { id: Palette; name: string; note: string; bg?: string; accent: string }

const SWATCHES: Record<Palette, Swatch> = {
  plain: { id: 'plain', name: 'Plain', note: 'No background, the accent strip alone', accent: 'claude' },
  areia: {
    id: 'areia',
    name: 'Areia',
    note: 'Warm sand, from the same family as the app cream',
    bg: 'rgba(176, 148, 104, 0.09)',
    accent: 'claude',
  },
  argila: {
    id: 'argila',
    name: 'Argila',
    note: 'Clay: the Claude orange, well diluted',
    bg: 'rgba(217, 119, 87, 0.07)',
    accent: 'claude',
  },
  manteiga: {
    id: 'manteiga',
    name: 'Manteiga',
    note: 'Butter sage',
    bg: 'rgba(150, 156, 112, 0.11)',
    accent: '#a3a88a',
  },
  gelo: { id: 'gelo', name: 'Gelo', note: 'Ice: a pale baby blue', bg: 'rgba(140, 195, 230, 0.10)', accent: '#8cc3e6' },
  cinza: { id: 'cinza', name: 'Cinza', note: 'Neutral gray', bg: 'rgba(120, 124, 135, 0.07)', accent: 'permission' },
}

const PALETTES = Object.values(SWATCHES)

const DEFAULT: Palette = 'manteiga'
const NAMES = PALETTES.map((p) => p.id).join(', ')
const PANE = 'livery'
const PERSON: readonly PromptOrigin['kind'][] = ['composer', 'bridge', 'sdk']
const COMMAND = /^\s*\/[\w:.-]+(\s|$)/
const SAMPLE =
  'A sample reply with **bold**, *italic*, `inline code` and a [link](https://example.com).\n\n- an item with `pnpm run check`\n- another with `plugins/gauge`'

const override = atom({ plugin: 'livery', key: 'palette' } as const, null)
const isOff = atom({ plugin: 'livery', key: 'isOff' } as const, false)

const isPalette = (value: unknown): value is Palette => PALETTES.some((p) => p.id === value)

const toolTone = (tool: string, isErrored: boolean): Tone => {
  if (isErrored) return TONES.error
  if (tool === 'Bash') return TONES.bash
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return TONES.edit
  if (tool.startsWith('mcp__')) return TONES.mcp
  return TONES.other
}

type Part = { kind: 'text'; text: string } | { kind: 'code'; language: string; source: string }

const FENCE = /^(([`~])\2{2,})(?!\2)([\w+-]*)[^\n]*\n([\s\S]*?)^\1\2*[ \t]*$/gm
const OPEN = /^ {0,3}(`{3,}|~{3,})/m

const split = (text: string): Part[] => {
  const parts: Part[] = []
  let at = 0
  for (const m of text.matchAll(FENCE)) {
    const before = text.slice(at, m.index).trim()
    if (before) parts.push({ kind: 'text', text: before })
    parts.push({ kind: 'code', language: m[3] ?? '', source: (m[4] ?? '').replace(/\n$/, '') })
    at = (m.index ?? 0) + m[0].length
  }
  const rest = text.slice(at).trim()
  if (rest) parts.push({ kind: 'text', text: rest })
  return parts
}

const isSplit = (parts: Part[]) =>
  parts.some((part) => part.kind === 'code') && !parts.some((part) => part.kind === 'text' && OPEN.test(part.text))

const togglePane = async ($: EngineInterface): Promise<boolean> => {
  if ((await $.ui.panes()).some((p) => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'Livery' })
  return true
}

const use = async ($: EngineInterface, id: Palette) => {
  await update($, override, () => id)
  await update($, isOff, () => false)
}

const current = async ($: EngineInterface, configured: Palette): Promise<Palette> =>
  (await read($, override)) ?? configured

const isDrawn = async ($: EngineInterface, surface: RenderSurface) => surface === 'desktop' && !(await read($, isOff))

const status = async ($: EngineInterface, configured: Palette) => {
  const chosen = await read($, override)
  const source = chosen === null ? 'from config' : 'this session'
  const state = (await read($, isOff)) ? 'off' : 'on'
  return `Livery ${state} · palette ${chosen ?? configured} (${source}) · palettes: ${NAMES}. Colors draw in the desktop app.`
}

export const register: Register = (on, options) => {
  const configured: Palette = isPalette(options.palette) ? options.palette : DEFAULT

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'livery',
      description: 'Conversation colors: status, on, off, preview or a palette',
      argumentHint: '[on|off|preview|<palette>]',
      immediate: true,
    })
    return result
  })

  on('command.run', { command: 'livery' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') return { text: await status($, configured) }
    if (arg === 'off') {
      await update($, isOff, () => true)
      return { text: 'Livery off for this session.' }
    }
    if (arg === 'on') {
      await update($, isOff, () => false)
      return { text: `Livery on · palette ${await current($, configured)}.` }
    }
    if (arg === 'preview')
      return { text: (await togglePane($)) ? 'Palette preview opened.' : 'Palette preview closed.' }
    if (isPalette(arg)) {
      await use($, arg)
      return { text: `Livery on · palette ${arg} for this session.` }
    }
    return { text: `Usage: /livery [on | off | preview | <palette>]. Palettes: ${NAMES}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const active = await current($, configured)
    const off = await read($, isOff)
    const isDesktop = e.surface === 'desktop'
    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        <Text dimColor>
          {isDesktop
            ? 'Switch the app theme (light or dark) with this pane open to compare.'
            : 'These colors draw in the desktop app; the terminal keeps its own.'}
        </Text>
        {PALETTES.map((p) => (
          <Box key={p.id} flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text bold>
                {p.name}
                {p.id === active ? (off ? ' (selected, off)' : ' (in use)') : ''}
              </Text>
              <Button key={`use-${p.id}`} label="use" plain onPress={() => use($, p.id)} />
            </Box>
            <Text dimColor>{p.note}</Text>
            {isDesktop ? (
              <Box flexDirection="row" backgroundColor={p.bg}>
                <Box width={1} flexShrink={0} backgroundColor={p.accent} />
                <Box flexDirection="column" flexGrow={1} paddingX={1}>
                  <Markdown text={SAMPLE} />
                </Box>
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { origin, task, from } = e.props
    if (!PERSON.includes(origin.kind) || task !== undefined || from !== undefined) return next(e)
    if (COMMAND.test(e.props.text) || !(await isDrawn($, e.surface))) return next(e)
    const drawn = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={TONES.user.accent}
        backgroundColor={TONES.user.bg}
        paddingX={1}
      >
        {drawn}
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !(await isDrawn($, e.surface))) return next(e)
    const p = SWATCHES[await current($, configured)]
    const parts = split(e.props.text)
    const drawn = isSplit(parts) ? null : await next(e)
    const { Box, Markdown, Code } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" backgroundColor={p.bg}>
        <Box width={1} flexShrink={0} backgroundColor={p.accent} />
        <Box flexDirection="column" flexGrow={1} paddingX={1} rowGap={1}>
          {drawn ??
            parts.map((part, i) =>
              part.kind === 'text' ? (
                <Markdown key={`t${i}`} text={part.text} />
              ) : (
                <Box
                  key={`c${i}`}
                  borderStyle="round"
                  borderColor={TONES.code.accent}
                  backgroundColor={TONES.code.bg}
                  paddingX={1}
                >
                  <Code source={part.source} language={part.language || undefined} />
                </Box>
              ),
            )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isDrawn($, e.surface))) return next(e)
    const t = toolTone(e.props.tool, e.props.isErrored)
    const drawn = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" backgroundColor={t.bg} borderStyle="round" borderColor={t.accent}>
        <Box width={1} flexShrink={0} backgroundColor={t.accent} />
        <Box flexGrow={1} paddingX={1}>
          {drawn}
        </Box>
      </Box>
    )
  })
}
