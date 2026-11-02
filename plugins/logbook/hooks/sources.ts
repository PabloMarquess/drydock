import type { SourceKind } from '../types'

export type Source = { kind: SourceKind; label: string; detail: string }

const MAX_LABEL = 80
const MAX_PATH = 60
const MAX_SERVER = 32
const MAX_TOOL = 48

// Control and format characters (bidi overrides, zero-width marks), lone surrogates and U+FFFE/U+FFFF.
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\uFFFE\uFFFF]/gu

// Cut before cleaning, so a huge input costs no more than a short one.
export const clean = (value: unknown, max = MAX_LABEL): string => {
  if (typeof value !== 'string') return ''
  const flat = value
    .slice(0, max * 4)
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

const SEGMENT = /[A-Za-z0-9_+=-]+/g
const TOKEN_PREFIX = /^(?:AKIA|ASIA|AIza|eyJ|gh[pousr]_|sk-|xox[a-z]-)[A-Za-z0-9_+=-]{4,}/

const isSecret = (segment: string): boolean =>
  TOKEN_PREFIX.test(segment) || (segment.length >= 16 && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment))

/** Turns every segment that looks like a key or token into `…`: 16+ characters mixing letters and digits, or a known token prefix. */
export const redact = (text: string): string => text.replace(SEGMENT, (s) => (isSecret(s) ? '…' : s))

/** What a label keeps of free text: cleaned, redacted, then cut, so a cut never leaves part of a token. */
export const safe = (value: unknown, max = MAX_LABEL): string => clean(redact(clean(value, 1000)), max)

/** The tokens a text brings into the context, roughly: its length / 4. */
export const tokensOf = (text: unknown): number => (typeof text === 'string' ? Math.round(text.length / 4) : 0)

/** The last two segments of a path: `hooks/register.tsx`. */
export const shortPath = (path: unknown): string => {
  const parts = clean(typeof path === 'string' ? path.slice(-1000) : '', 1000)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return safe(parts.slice(-2).join('/'), MAX_PATH)
}

const within = (name: string, path: unknown): string => {
  const p = shortPath(path)
  return p ? `${name} in ${p}` : name
}

/** An http(s) URL's host and first path segment; any other URL's protocol alone. */
export const webLabel = (url: unknown): string => {
  if (typeof url !== 'string') return 'web'
  try {
    const u = new URL(url.slice(0, 4000))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return clean(u.protocol, 20) || 'web'
    const first = u.pathname.split('/').find(Boolean)
    return safe(first ? `${u.host}/${first}` : u.host, MAX_PATH) || 'web'
  } catch {
    return 'web'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const serverName = (server: unknown): string => {
  const name = typeof server === 'string' ? server.replace(/^plugin_/, '') : ''
  return UUID.test(name) ? 'connector' : clean(name, MAX_SERVER) || 'mcp'
}

/** `mcp__datadog__search_logs` → `datadog`, `search_logs`; a plugin's server loses its `plugin_` prefix. */
export const mcpOf = (tool: string): { server: string; name: string } => {
  const [, server = '', ...rest] = tool.split('__')
  return { server: serverName(server), name: clean(rest.join('__'), MAX_TOOL) || 'tool' }
}

const PROGRAM = /^[A-Za-z0-9._+-]{1,32}$/
const MOVES = new Set(['cd', 'pushd', 'popd'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Each wrapper's options that take the next word as their value.
const WRAPPERS = new Map<string, ReadonlySet<string>>([
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host'])],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '-S', '-a', '--unset', '--chdir', '--split-string', '--argv0'])],
  ['time', new Set(['-f', '-o', '--format', '--output'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set()],
  ['exec', new Set(['-a'])],
  ['command', new Set()],
])

// `-u root` takes the next word; `-uroot` and `-Eu root` are read as getopt reads them.
const takesValue = (option: string, valued: ReadonlySet<string>): boolean => {
  if (option.startsWith('--')) return valued.has(option)
  for (let k = 1; k < option.length; k++) if (valued.has(`-${option[k]}`)) return k === option.length - 1
  return false
}

const afterWrappers = (words: readonly string[]): number => {
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i] ?? '')) i++
  for (let valued = WRAPPERS.get(words[i] ?? ''); valued !== undefined; valued = WRAPPERS.get(words[i] ?? '')) {
    i++
    while (i < words.length) {
      const word = words[i] ?? ''
      if (word === '--') {
        i++
        break
      }
      if (ASSIGNMENT.test(word)) i++
      else if (word.startsWith('-')) i += takesValue(word, valued) ? 2 : 1
      else break
    }
  }
  return i
}

/**
 * The program a shell command runs, never its arguments: the first word of the first part that is not a
 * `cd`, after any `NAME=value` and wrappers such as `sudo -u user`. A word that is not a plain program name,
 * or looks like a key, reads `shell`.
 */
export const programOf = (command: unknown): string => {
  if (typeof command !== 'string') return 'shell'
  let moved = false
  for (const part of command.slice(0, 4000).split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean)
    const word = (words[afterWrappers(words)] ?? '').replace(/^[("']+|[)"']+$/g, '')
    if (word === '') continue
    const program = word.split(/[\\/]/).pop() ?? ''
    if (MOVES.has(program)) {
      moved = true
      continue
    }
    return PROGRAM.test(program) && redact(program) === program ? program : 'shell'
  }
  return moved ? 'cd' : 'shell'
}

/** A skill's name as the Skill tool or a slash command spells it, without its slash. */
export const skillName = (name: unknown): string => safe(typeof name === 'string' ? name.replace(/^\//, '') : '', 60)

/** `commit` and `my-plugin:commit` name the same skill. */
export const isSameSkill = (a: string, b: string): boolean => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.endsWith(`:${y}`) || y.endsWith(`:${x}`)
}

const SKILL_SOURCES = new Map([
  ['userSettings', 'user'],
  ['projectSettings', 'project'],
  ['policySettings', 'managed'],
  ['syncedSkills', 'synced'],
])

export const skillSource = (source: unknown, pluginName: unknown): string => {
  const plugin = clean(pluginName, 40)
  if (plugin) return `plugin ${plugin}`
  const s = clean(source, 40)
  return SKILL_SOURCES.get(s) ?? s
}

/**
 * What a tool call brought in, with only what its label needs from the input: never a pattern, a query or
 * a command line. `null` for the Agent tool, whose spawn `agent.spawn` records.
 */
export const classify = (tool: string, input: Record<string, unknown>): Source | null => {
  if (tool === 'Agent' || tool === 'Task') return null
  if (tool.startsWith('mcp__')) {
    const { server, name } = mcpOf(tool)
    return { kind: 'mcp', label: `${server} · ${name}`, detail: 'MCP' }
  }
  switch (tool) {
    case 'Skill':
      return { kind: 'skill', label: skillName(input.skill) || 'skill', detail: 'Skill' }
    case 'Read':
      return { kind: 'file', label: shortPath(input.file_path) || 'file', detail: tool }
    case 'NotebookRead':
      return { kind: 'file', label: shortPath(input.notebook_path) || 'notebook', detail: tool }
    case 'Grep':
      return { kind: 'file', label: within('grep', input.path), detail: tool }
    case 'Glob':
      return { kind: 'file', label: within('glob', input.path), detail: tool }
    case 'WebFetch':
      return { kind: 'web', label: webLabel(input.url), detail: tool }
    case 'WebSearch':
      return { kind: 'web', label: 'web search', detail: tool }
    case 'Bash':
    case 'PowerShell':
      return { kind: 'shell', label: programOf(input.command), detail: tool }
    case 'ReadMcpResourceTool':
      return { kind: 'mcp', label: `${serverName(input.server)} · resource`, detail: tool }
    case 'ReadMcpResourceDirTool':
    case 'ListMcpResourcesTool':
      return { kind: 'mcp', label: `${serverName(input.server)} · resources`, detail: tool }
  }
  return { kind: 'other', label: clean(tool, MAX_TOOL) || 'tool', detail: '' }
}
