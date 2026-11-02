// Reading a Bash command's program and any `kiro-cli chat` it runs, Kiro's usage out of its last output
// lines, and a background command's end out of the engine's task notification or a GetTask answer.
// Nothing here keeps a command or an output: only the fields a row shows, cleaned and redacted. The
// segment redactor and the wrapper rules are logbook's (plugins/logbook/hooks/sources.ts), with
// `timeout` added and the shapes the segment rule misses (a URL's password, a named secret's value, a
// bearer token, a slashed base64 run, a long digit run) redacted first.

import type { AgentStatus } from '../types'

export type KiroCall = {
  /** The task's first words, redacted; a stand-in when the task is not a plain word list. */
  title: string
  agent: string
  model: string
  effort: string
}

export type KiroUsage = { credits: string; time: string; tokens: string }

export type TaskNotice = { taskId: string; toolUseId: string; status: string; exitCode: number | null }

export type TaskEnd = { status: Exclude<AgentStatus, 'running'>; note: string }

const MAX_COMMAND = 16_000
const MAX_CALLS = 8
const MAX_DEPTH = 3
const MAX_WORDS = 12
const MAX_TITLE = 80
const MAX_FIELD = 60

// Control and format characters (bidi overrides, zero-width marks), lone surrogates and U+FFFE/U+FFFF.
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\uFFFE\uFFFF]/gu

// Cut before cleaning, so a huge input costs no more than a short one.
const clean = (value: unknown, max: number): string => {
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

const URL_PASSWORD = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@/]+@/g
const NAMED = /\b([A-Za-z0-9_.-]+)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&;,]+)/g
const SECRET_NAME = /password|passwd|pwd|secret|token|key/i
const BEARER = /\b([Bb]earer)\s+[^\s"',;]+/g
const BASE64 = /[A-Za-z0-9+/]{20,}={0,2}/g
const DIGITS = /\d(?:[ -]?\d){11,}/g

// A slashed run of base64 as a key draws it: digits, lower case, and capitals for a quarter of its
// letters or more, where a path or a URL's (`/PabloMarquess/drydock/pull/12`) has a few at most.
const isBase64Secret = (run: string): boolean => {
  if (!/[/+]/.test(run) || !/\d/.test(run) || !/[a-z]/.test(run)) return false
  const capitals = run.replace(/[^A-Z]/g, '').length
  return capitals * 4 >= run.replace(/[^A-Za-z]/g, '').length
}

/**
 * Turns what looks like a key or token into `…`: a URL's password, the value after a name holding
 * password, passwd, pwd, secret, token or key, a bearer token, a slashed base64 run of 20+, a run of 12+
 * digits, and every segment of 16+ characters mixing letters and digits or with a known token prefix.
 */
export const redact = (text: string): string =>
  text
    .replace(URL_PASSWORD, '$1:…@')
    .replace(NAMED, (all, name: string, sep: string) => (SECRET_NAME.test(name) ? `${name}${sep}…` : all))
    .replace(BEARER, '$1 …')
    .replace(BASE64, (run) => (isBase64Secret(run) ? '…' : run))
    .replace(DIGITS, '…')
    .replace(SEGMENT, (s) => (isSecret(s) ? '…' : s))

/** Cleaned, redacted, then cut, so a cut never leaves part of a token. */
export const safe = (value: unknown, max = MAX_TITLE): string => clean(redact(clean(value, 1000)), max)

type Word = { text: string; isQuoted: boolean }

/** A simple command's words; `isNested` when it runs inside a `$(...)` or backticks of another. */
type Part = { words: Word[]; isNested: boolean }

// Where a construct opened just before `from` ends: just past the `)`, `"` or backtick that closes it.
// Quotes, escapes and the substitutions nested inside are skipped. One never closed runs to the end: one
// past it, so the text inside is `s.slice(from, end - 1)` either way.
const skip = (s: string, from: number, closer: ')' | '"' | '`'): number => {
  const stack: string[] = [closer]
  for (let i = from; i < s.length; i++) {
    const c = s[i] ?? ''
    const top = stack[stack.length - 1]
    if (c === '\\') i++
    else if (top === '"') {
      if (c === '"') stack.pop()
      else if (c === '$' && s[i + 1] === '(') {
        stack.push(')')
        i++
      } else if (c === '`') stack.push('`')
    } else if (c === top) stack.pop()
    else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      i = end < 0 ? s.length : end
    } else if (c === '"' || c === '`') stack.push(c)
    else if (c === '(') stack.push(')')
    if (stack.length === 0) return i + 1
  }
  return s.length + 1
}

// Splits a command into simple commands at the unquoted `&&`, `||`, `;`, `|`, `&`, newlines and parentheses,
// each a list of words with quotes and line continuations undone; redirections and comments are left out.
// The commands a `$(...)` or backticks run, in double quotes too, come before the one that holds them, as
// they run first; `$((...))` and `((...))` are arithmetic. A here-document ends the reading at its line:
// what follows is its body, data.
const partsOf = (command: string, depth = 0): Part[] => {
  const s = command.slice(0, MAX_COMMAND)
  const parts: Part[] = []
  let words: Word[] = []
  let word = ''
  let inWord = false
  let isQuoted = false
  let isTarget = false
  let isHeredoc = false
  const endWord = () => {
    if (inWord && !isTarget) words.push({ text: word, isQuoted })
    if (inWord) isTarget = false
    word = ''
    inWord = false
    isQuoted = false
  }
  const endPart = () => {
    endWord()
    isTarget = false
    if (words.length > 0) parts.push({ words, isNested: depth > 0 })
    words = []
  }
  // A substitution whose text is s[open, end): its commands read as parts of their own, its text joins the word.
  const substitute = (open: number, end: number, inner: string) => {
    if (depth < MAX_DEPTH && !inner.startsWith('(')) parts.push(...partsOf(inner, depth + 1))
    word += s.slice(open, end)
    inWord = true
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ''
    const after = s[i + 1] ?? ''
    if (c === '\\') {
      if (after !== '\n' && after !== '') {
        word += after
        inWord = true
      }
      i++
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      const stop = end < 0 ? s.length : end
      word += s.slice(i + 1, stop)
      inWord = true
      isQuoted = true
      i = stop
    } else if (c === '"') {
      let j = i + 1
      for (; j < s.length && s[j] !== '"'; j++) {
        const ch = s[j] ?? ''
        const next = s[j + 1] ?? ''
        if (ch === '\\' && '"\\$`\n'.includes(next) && next !== '') {
          if (next !== '\n') word += next
          j++
        } else if (ch === '$' && next === '(') {
          const end = skip(s, j + 2, ')')
          substitute(j, end, s.slice(j + 2, end - 1))
          j = end - 1
        } else if (ch === '`') {
          const end = skip(s, j + 1, '`')
          substitute(j, end, s.slice(j + 1, end - 1))
          j = end - 1
        } else word += ch
      }
      inWord = true
      isQuoted = true
      i = j
    } else if (c === '$' && after === '(') {
      const end = skip(s, i + 2, ')')
      substitute(i, end, s.slice(i + 2, end - 1))
      i = end - 1
    } else if (c === '`') {
      const end = skip(s, i + 1, '`')
      substitute(i, end, s.slice(i + 1, end - 1))
      i = end - 1
    } else if (c === '#' && !inWord) {
      const nl = s.indexOf('\n', i)
      i = (nl < 0 ? s.length : nl) - 1
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else if (c === '\n') {
      endPart()
      if (isHeredoc) break
    } else if (c === '(' && after === '(' && !inWord) {
      endPart()
      i = skip(s, i + 1, ')') - 1
    } else if (c === ';' || c === '(' || c === ')') {
      endPart()
    } else if (c === '|') {
      endPart()
      if (after === '|' || after === '&') i++
    } else if (c === '&' && after === '>') {
      endWord()
      i += s[i + 2] === '>' ? 2 : 1
      isTarget = true
    } else if (c === '&') {
      endPart()
      if (after === '&') i++
    } else if (c === '>' || c === '<') {
      // `2>` and `2>&1`: a number right before the operator names a descriptor, not an argument.
      if (inWord && !isQuoted && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      endWord()
      let op = c
      while (op.length < 3 && '<>&|'.includes(s[i + 1] ?? '.')) op += s[++i]
      if (op.startsWith('<<') && op !== '<<<') isHeredoc = true
      isTarget = true
    } else {
      word += c
      inWord = true
    }
  }
  endPart()
  return parts
}

const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Each wrapper's options that take the next word as their value, and how many plain words it reads before
// the command it runs (`timeout 600 cmd`).
const WRAPPERS = new Map<string, { valued: ReadonlySet<string>; positional: number }>([
  [
    'sudo',
    {
      valued: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host']),
      positional: 0,
    },
  ],
  ['doas', { valued: new Set(['-u', '-C']), positional: 0 }],
  [
    'env',
    { valued: new Set(['-u', '-C', '-S', '-a', '--unset', '--chdir', '--split-string', '--argv0']), positional: 0 },
  ],
  ['time', { valued: new Set(['-f', '-o', '--format', '--output']), positional: 0 }],
  ['nice', { valued: new Set(['-n', '--adjustment']), positional: 0 }],
  ['nohup', { valued: new Set(), positional: 0 }],
  ['exec', { valued: new Set(['-a']), positional: 0 }],
  ['command', { valued: new Set(), positional: 0 }],
  ['timeout', { valued: new Set(['-s', '-k', '--signal', '--kill-after']), positional: 1 }],
])

// `-u root` takes the next word; `-uroot` and `-Eu root` are read as getopt reads them.
const takesValue = (option: string, valued: ReadonlySet<string>): boolean => {
  if (option.startsWith('--')) return valued.has(option)
  for (let k = 1; k < option.length; k++) if (valued.has(`-${option[k]}`)) return k === option.length - 1
  return false
}

const programAt = (words: readonly string[]): number => {
  let i = 0
  while (i < words.length && (RESERVED.has(words[i] ?? '') || ASSIGNMENT.test(words[i] ?? ''))) i++
  for (let wrapper = WRAPPERS.get(words[i] ?? ''); wrapper !== undefined; wrapper = WRAPPERS.get(words[i] ?? '')) {
    i++
    let plain = wrapper.positional
    while (i < words.length) {
      const word = words[i] ?? ''
      if (word === '--') {
        i++
        break
      }
      if (ASSIGNMENT.test(word)) i++
      else if (word.startsWith('-') && word.length > 1) i += takesValue(word, wrapper.valued) ? 2 : 1
      else if (plain > 0) {
        plain--
        i++
      } else break
    }
  }
  return i
}

const VALUED = new Set(['--agent', '--model', '--effort', '--trust-tools', '--wrap', '--resume-id'])
// Options that list, delete or explain instead of running an agent.
const NOT_A_RUN = new Set(['-h', '--help', '-V', '--version', '--list-sessions', '--list-models', '--delete-session'])

// A quoted word is an argument, whatever it starts with: `"-list the buckets"` is a task.
const isOption = (w: Word | undefined): boolean =>
  w !== undefined && !w.isQuoted && w.text.startsWith('-') && w.text.length > 1

const optionName = (w: Word): string => {
  const eq = w.text.indexOf('=')
  return eq < 0 ? w.text : w.text.slice(0, eq)
}

const titleOf = (task: string, agent: string): string => {
  const words = task.trim().split(/\s+/).filter(Boolean)
  const title = words[0]?.startsWith('$') ? '' : safe(words.slice(0, MAX_WORDS).join(' '), MAX_TITLE)
  return title || (agent ? `Kiro agent ${agent}` : 'Kiro chat')
}

// The task is the word after `--`, else the last quoted argument, else the last plain one: an option the
// deck does not know may take a value (`--profile prod`), and that value is never the task.
const chatOf = (words: readonly Word[]): KiroCall | null => {
  const texts = words.map((w) => w.text)
  const at = programAt(texts)
  if ((texts[at] ?? '').split(/[\\/]/).pop() !== 'kiro-cli') return null
  // Options before `chat`, each perhaps with its value: `kiro-cli --profile prod chat`.
  let i = at + 1
  for (; i < words.length && texts[i] !== 'chat'; i++) {
    const w = words[i]
    const before = words[i - 1]
    if (isOption(w)) {
      if (w && NOT_A_RUN.has(optionName(w))) return null
    } else if (i === at + 1 || !isOption(before) || before?.text.includes('=')) return null
  }
  if (texts[i] !== 'chat') return null
  const fields: Record<string, string> = {}
  let quoted = ''
  let last = ''
  let afterDashes = ''
  for (i++; i < words.length; i++) {
    const w = words[i] as Word
    if (w.text === '--' && !w.isQuoted) {
      afterDashes = texts[i + 1] ?? ''
      break
    }
    if (isOption(w)) {
      const name = optionName(w)
      if (NOT_A_RUN.has(name)) return null
      fields[name] = name !== w.text ? w.text.slice(name.length + 1) : VALUED.has(name) ? (texts[++i] ?? '') : ''
    } else {
      last = w.text
      if (w.isQuoted) quoted = w.text
    }
  }
  const agent = safe(fields['--agent'], MAX_FIELD)
  return {
    title: titleOf(afterDashes || quoted || last, agent),
    agent,
    model: safe(fields['--model'], MAX_FIELD),
    effort: safe(fields['--effort'], MAX_FIELD),
  }
}

const PROGRAM = /^[A-Za-z0-9._+-]{1,32}$/
const MOVES = new Set(['cd', 'pushd', 'popd'])

/**
 * The program a shell command runs, never its arguments: the first word of the first part that is not a
 * `cd`, after any `NAME=value` and wrappers such as `timeout 600`. A word that is not a plain program name,
 * or looks like a key, reads `shell`.
 */
export const programOf = (command: unknown): string => {
  if (typeof command !== 'string') return 'shell'
  let moved = false
  for (const part of partsOf(command)) {
    if (part.isNested) continue
    const texts = part.words.map((w) => w.text)
    const program = (texts[programAt(texts)] ?? '').split(/[\\/]/).pop() ?? ''
    if (program === '') continue
    if (MOVES.has(program)) {
      moved = true
      continue
    }
    return PROGRAM.test(program) && redact(program) === program ? program : 'shell'
  }
  return moved ? 'cd' : 'shell'
}

/** Every `kiro-cli chat` the command runs, in order, at most eight; none for a command that only names it. */
export const kiroCalls = (command: unknown): KiroCall[] => {
  if (typeof command !== 'string' || !command.includes('kiro-cli')) return []
  const calls: KiroCall[] = []
  for (const part of partsOf(command)) {
    const call = chatOf(part.words)
    if (call) calls.push(call)
    if (calls.length === MAX_CALLS) break
  }
  return calls
}

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}${ESC}]*|[@-_])`, 'g')
// What is left of an escape sequence whose ESC was already taken out.
const BARE_CSI = /\[[0-9;?]*[A-Za-z]/g

const CREDITS = /(?:^|[^A-Za-z])Credits?:\s*(\d{1,9}(?:[.,]\d{1,6})?)(?![\d.,]*\s*%)/i
const TIME = /\bTime:\s*((?:\d{1,4}\s*h\s*)?(?:\d{1,4}\s*m\s*)?(?:\d{1,5}(?:\.\d{1,3})?\s*s)?)/i
const TOKENS = /\bTokens?(?:\s+used)?:\s*(\d[\d.,]{0,12}\s*[kKmM]?)(?![A-Za-z])|(\d[\d.,]{0,12}\s*[kKmM]?)\s+tokens\b/i

const EMPTY_USAGE: KiroUsage = { credits: '', time: '', tokens: '' }

/** The usage Kiro prints after its answer (`▸ Credits: 0.63 • Time: 3s`), read from the output's last lines only. */
export const kiroUsage = (output: unknown): KiroUsage => {
  if (typeof output !== 'string' || output === '') return EMPTY_USAGE
  const lines = output
    .slice(-2000)
    .replace(ANSI, '')
    .replace(BARE_CSI, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
  const usage = { ...EMPTY_USAGE }
  for (const line of lines) {
    const credits = CREDITS.exec(line)?.[1]
    if (credits) {
      usage.credits = credits
      usage.time = (TIME.exec(line)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    }
    const tokens = TOKENS.exec(line)
    if (tokens) usage.tokens = (tokens[1] ?? tokens[2] ?? '').replace(/\s+/g, '')
  }
  return usage
}

const ID = /^[A-Za-z0-9_-]{1,100}$/

/** A background task's id as a result's record carries it (Bash `backgroundTaskId`, Monitor `taskId`); never read from text. */
export const taskIdOf = (value: unknown): string => (typeof value === 'string' && ID.test(value) ? value : '')

/** A failed Bash call's exit code, from the text the model reads (`Exit code 2`). */
export const exitCodeOf = (text: unknown): number | null => {
  const code = typeof text === 'string' ? /(?:^|\n)Exit code (\d{1,3})\b/.exec(text.slice(0, 400))?.[1] : undefined
  return code === undefined ? null : Number(code)
}

// Words that report a task still under way, never its end.
const STILL = new Set(['running', 'pending', 'working', 'paused'])
const STOPPED = new Set(['killed', 'cancelled', 'stopped'])

const ENVELOPE = '<task-notification>'
const SUMMARY = '<summary>'

// The engine's own end of a summary: `completed (exit code 0)`, `(exit code 1: No matches found)`,
// `failed with exit code 3`. A description quoted earlier in the summary is never read for one.
const TRAILING_EXIT = /(?:\(exit code (-?\d{1,4})(?::[^()]*)?\)|\bexit code (-?\d{1,4}))\.?\s*$/i

const field = (body: string, name: string): string =>
  new RegExp(`<${name}>([^<]{1,200})</${name}>`).exec(body)?.[1]?.trim() ?? ''

/**
 * The background command a notification reports ended, from the `<task-notification>` envelope the text
 * starts with; an envelope anywhere else in the text (quoted in a relayed comment, a description) is not
 * the engine's and is ignored. A still-running or waiting-for-input notice has no status: null.
 */
export const noticeOf = (text: unknown): TaskNotice | null => {
  if (typeof text !== 'string' || !text.startsWith(ENVELOPE)) return null
  const head = text.slice(ENVELOPE.length, 6000)
  const close = head.indexOf('</task-notification>')
  const body = close < 0 ? head : head.slice(0, close)
  const at = body.indexOf(SUMMARY)
  // The fields the engine writes before its summary; a summary holds the model's description.
  const fields = at < 0 ? body : body.slice(0, at)
  const status = (field(fields, 'status') || field(body, 'status')).toLowerCase()
  if (status === '' || STILL.has(status)) return null
  const rest = at < 0 ? '' : body.slice(at + SUMMARY.length)
  const end = rest.indexOf('</summary>')
  const exit = TRAILING_EXIT.exec(end < 0 ? rest : rest.slice(0, end))
  const code = exit?.[1] ?? exit?.[2]
  return {
    taskId: field(fields, 'task-id') || field(body, 'task-id'),
    toolUseId: field(fields, 'tool-use-id') || field(body, 'tool-use-id'),
    status,
    exitCode: code === undefined ? null : Number(code),
  }
}

/**
 * How a background command's status reads on its row: `completed` is done (a non-zero exit only a
 * note), `failed` failed, `killed` or `cancelled` stopped; any other word ends it neither done nor failed.
 */
export const endOf = (status: string, exitCode: number | null): TaskEnd => {
  const exit = exitCode ? `exit ${exitCode}` : ''
  if (status === 'completed') return { status: 'done', note: exit }
  if (status === 'failed') return { status: 'failed', note: exit }
  if (STOPPED.has(status)) return { status: 'failed', note: 'stopped' }
  return { status: 'unknown', note: clean(status, 20) }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * How a GetTask answer ends a task, read from its documented shape alone: `completed` with its result's
 * content and `isError`, `failed` with its error's code, `cancelled`. Null while the task works, and for
 * any shape it does not document.
 */
export const getTaskEndOf = (record: unknown): { end: TaskEnd; output: string } | null => {
  if (!isRecord(record)) return null
  if (record.status === 'cancelled') return { end: { status: 'failed', note: 'stopped' }, output: '' }
  if (record.status === 'failed') {
    if (!isRecord(record.error)) return null
    const code = record.error.code
    return {
      end: { status: 'failed', note: Number.isInteger(code) ? `error ${String(code).slice(0, 12)}` : '' },
      output: '',
    }
  }
  if (record.status !== 'completed' || !isRecord(record.result)) return null
  const { content, isError } = record.result
  if (!Array.isArray(content) || typeof isError !== 'boolean') return null
  const output = content
    .slice(-20)
    .map((c: unknown) => (isRecord(c) && typeof c.text === 'string' ? c.text : ''))
    .join('\n')
  return { end: { status: isError ? 'failed' : 'done', note: '' }, output }
}
