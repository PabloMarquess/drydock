export type Level = 'block' | 'confirm'

export type Rule = { id: string; level: Level; pattern: RegExp; why: string }

export type Verdict = { id: string; level: Level; why: string }

export type Decision = { kind: 'pass' } | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string }

// Every pattern is anchored with ^ and reaches each command through first(): a lookahead finds its FIRST occurrence
// and the back-reference consumes it atomically, so a failed match never retries a later one. That keeps each test
// linear in the segment's length (the plain `X.*Y.*Z` form is cubic: 32 KB of "terraform apply " took 18 s). What
// follows a first() is `.*` or a lookahead, so the first occurrence matches whenever a later one would.
let groups = 0
const first = (p: string): string => {
  const g = `g${groups++}`
  return String.raw`(?=(?<${g}>.*?${p}))\k<${g}>`
}
const re = (s: string, flags = ''): RegExp => new RegExp(`^${s}`, flags)

// a word ends here: not followed by more of a name, path, file name or flag value
const END = String.raw`(?![\w./:=-])`
const start = (name: string): string => String.raw`\b${name}(?:\.exe|-[\d.]+)?`
// Flags between a tool and its subcommand, each with an optional value, fewest first: kubectl -n app delete. A flag or
// value never holds another start of the tool (git -c user.name=git push is matched from the second git), so no part
// of the segment is scanned from two starts.
const flags = (name: string): string => {
  const c = String.raw`(?:(?!${start(name)}\s)\S)`
  return String.raw`(?:\s+-${c}+(?:\s+(?!-)${c}+)??)*?`
}
const tool = (name: string): string => String.raw`${start(name)}${flags(name)}\s+`
const run = (name: string, sub: string): string => first(`${tool(name)}(?:${sub})${END}`)
// kubectl --dry-run=client|server changes nothing, and the last --dry-run wins
const dry = (): string => {
  const g = `g${groups++}`
  return String.raw`(?!(?=(?<${g}>.*\s--dry-run\b))\k<${g}>=(?:client|server)\b)`
}

const TF = String.raw`\b(?:terraform|tofu|terragrunt)\b`
const AUTO = String.raw`(?:\s|=)--?auto-approve\b`
const KINDS =
  '(?:namespaces?|ns|nodes?|no|pv|persistentvolumes?|crds?|customresourcedefinitions?|clusterroles?|clusterrolebindings?)'
const AWS = String.raw`\baws\b`
const FORCE = String.raw`\s(?:--force(?:-with-lease)?\b|-[a-eg-zA-Z]*f[a-zA-Z]*\b|\+\S)`
const MAIN = String.raw`[\s:+]["']?(?:refs/heads/)?(?:main|master)${END}`

const AUTO_DESTROY: Rule = {
  id: 'terraform-auto-destroy',
  level: 'block',
  pattern: re(
    `(?:${[
      String.raw`${first(TF)}(?=.*\sdestroy${END}|${first(String.raw`\sapply${END}`)}.*\s--?destroy\b)(?=.*${AUTO}|.*<<<\s*yes\b)`,
      String.raw`${first(String.raw`(?:^|\s)TF_CLI_ARGS\w*=\S*?auto-approve\b`)}${first(TF)}.*\sdestroy${END}`,
      // terragrunt run-all adds -auto-approve itself, and non-interactive skips its only prompt
      String.raw`(?=.*\bterragrunt\b)(?=.*\s(?:run-all|--all)${END})(?=.*\sdestroy${END})(?=.*(?:\s--(?:terragrunt-)?non-interactive\b|_NON_INTERACTIVE=(?:true|1)\b))`,
    ].join('|')})`,
  ),
  why: 'destroys infrastructure with no plan to review',
}

export const RULES: readonly Rule[] = [
  AUTO_DESTROY,
  {
    id: 'terraform-change',
    level: 'confirm',
    pattern: re(String.raw`${first(TF)}.*\s(?:apply|destroy|import|taint|untaint|force-unlock)${END}`),
    why: 'changes real infrastructure or its state',
  },
  {
    id: 'terraform-state',
    level: 'confirm',
    pattern: re(String.raw`${first(TF)}.*\b(?:state\s+(?:rm|mv|push|replace-provider)|workspace\s+delete)\b`),
    why: 'rewrites Terraform state',
  },
  {
    id: 'kubectl-mass-delete',
    level: 'block',
    // kubectl reads resource kinds in any case
    pattern: re(
      String.raw`${dry()}(?:(?=.*\s(?:--all|--all-namespaces|-A)(?:\s|=|$))${run('kubectl', 'delete')}|${first(
        String.raw`${tool('kubectl')}delete${flags('kubectl')}\s+(?:[\w.-]+,)*${KINDS}(?:\.v1)?(?![\w.:=-])`,
      )})`,
      'i',
    ),
    why: 'deletes cluster-wide or namespace-wide resources',
  },
  {
    id: 'kubectl-change',
    level: 'confirm',
    pattern: re(
      String.raw`${dry()}(?:${run('kubectl', String.raw`delete|drain|cordon|rollout\s+undo`)}|${run('kubectl', 'replace')}.*\s--force\b|${run('kubectl', 'apply')}.*\s--prune\b|${run('kubectl', 'taint')}.*:NoExecute\b)`,
    ),
    why: 'removes or disrupts workloads',
  },
  {
    id: 'kubectl-scale-zero',
    level: 'confirm',
    pattern: re(String.raw`${run('kubectl', 'scale')}.*--replicas[=\s]0\b`),
    why: 'scales a workload to zero',
  },
  {
    id: 'helm-remove',
    level: 'confirm',
    pattern: re(`(?:${run('helm', 'uninstall|delete|del|un|rollback')}|${run('helmfile', 'destroy|delete')})`),
    why: 'removes or rolls back a release',
  },
  {
    id: 'aws-mass-delete',
    level: 'block',
    pattern: re(
      String.raw`${first(AWS)}(?:${first(String.raw`\bs3\s+rb\b`)}.*\s--force\b|${first(String.raw`\bs3\s+rm\b`)}.*\s--recursive\b|${first(
        String.raw`\brds\s+delete-db-(?:instance|cluster)\b`,
      )}.*(?:\s--skip-final-snapshot\b|SkipFinalSnapshot\W*:\s*true\b)|.*\b(?:cloudformation\s+delete-stack|eks\s+delete-cluster)\b)`,
    ),
    why: 'deletes data or a whole stack with no way back',
  },
  {
    id: 'aws-delete',
    level: 'confirm',
    // the lookbehind skips a value right after an option: --function-name stop-dev is a name, not an operation
    pattern: re(
      String.raw`${first(AWS)}.*\s(?<!\s--?[\w-]+\s+)(?:(?:batch-)?(?:delete|terminate|deregister|remove|revoke|detach|disable|purge|cancel|stop|reset|disassociate)-[a-z0-9-]+|schedule-key-deletion|leave-organization)${END}`,
    ),
    why: 'deletes or stops AWS resources',
  },
  {
    id: 'aws-iam',
    level: 'confirm',
    pattern: re(
      String.raw`${first(AWS)}.*\biam\s+(?:put|attach|create|update)-[a-z-]*(?:policy|role|user|access-key|login-profile)\b`,
    ),
    why: 'changes IAM permissions',
  },
  {
    id: 'aws-s3-write',
    level: 'confirm',
    pattern: re(String.raw`${first(AWS)}(?:.*\bs3\s+(?:rm|mv)\b|${first(String.raw`\bs3\s+sync\b`)}.*\s--delete\b)`),
    why: 'removes or moves S3 objects',
  },
  {
    id: 'git-force-push-main',
    level: 'block',
    // --mirror force-updates and prunes every ref
    pattern: re(String.raw`${run('git', 'push')}(?:(?=.*${FORCE})(?=.*${MAIN})|(?=.*\s--mirror\b))`),
    why: 'rewrites the history of the main branch',
  },
  {
    id: 'git-force-push',
    level: 'confirm',
    pattern: re(`${run('git', 'push')}.*${FORCE}`),
    why: 'rewrites remote history',
  },
  {
    id: 'git-delete-remote',
    level: 'confirm',
    pattern: re(String.raw`${run('git', 'push')}.*\s(?:--delete\b|-d\b|--prune\b|:\S)`),
    why: 'deletes a remote branch or tag',
  },
  {
    id: 'git-discard',
    level: 'confirm',
    pattern: re(
      `(?:${[
        String.raw`${run('git', 'reset')}(?=.*\s--hard\b)`,
        String.raw`${run('git', 'branch')}(?=.*\s(?:--delete\b|-[a-zA-Z]*[dD]))(?=.*\s(?:--force\b|-[a-zA-Z]*[fD]))`,
        String.raw`${run('git', 'clean')}.*\s(?:-[a-zA-Z]*f|--force\b)`,
        String.raw`${run('git', 'checkout')}.*\s(?:\.|:/)(?:\s|$)`,
        // --staged and -S only unstage
        String.raw`(?!.*\s(?:--staged|-S)\b)${run('git', 'restore')}.*\s(?:\.|:/)(?:\s|$)`,
        String.raw`${run('git', 'restore')}(?=.*\s(?:--worktree\b|-[a-zA-Z]*W))(?=.*\s(?:\.|:/)(?:\s|$))`,
        String.raw`${run('git', 'checkout|switch')}.*\s(?:-f|--force|--discard-changes)\b`,
        run('git', String.raw`stash\s+(?:clear|drop)|update-ref\s+-d|reflog\s+expire|filter-branch|filter-repo`),
      ].join('|')})`,
    ),
    why: 'discards local work or rewrites history',
  },
]

// Aliases from oh-my-zsh's git and kubectl plugins, plus common short names. The Bash tool sources the user's shell
// snapshot, so these expand before the command runs.
const ALIASES: Readonly<Record<string, string>> = {
  k: 'kubectl',
  kubecolor: 'kubectl',
  tf: 'terraform',
  tg: 'terragrunt',
  kdel: 'kubectl delete',
  kdelf: 'kubectl delete -f',
  kdelk: 'kubectl delete -k',
  kdelns: 'kubectl delete namespace',
  kdelno: 'kubectl delete node',
  kdelp: 'kubectl delete pods',
  kdelpvc: 'kubectl delete pvc',
  kdeld: 'kubectl delete deployment',
  kdelss: 'kubectl delete statefulset',
  kdelds: 'kubectl delete daemonset',
  kdelsec: 'kubectl delete secret',
  kdelcm: 'kubectl delete configmap',
  kdels: 'kubectl delete svc',
  kdeli: 'kubectl delete ingress',
  kdelj: 'kubectl delete job',
  kdelcj: 'kubectl delete cronjob',
  kdelsa: 'kubectl delete sa',
  ksd: 'kubectl scale deployment',
  ksss: 'kubectl scale statefulset',
  gpf: 'git push --force-with-lease --force-if-includes',
  'gpf!': 'git push --force',
  gpsupf: 'git push --set-upstream origin --force-with-lease',
  gpod: 'git push origin --delete',
  grhh: 'git reset --hard',
  gpristine: 'git reset --hard && git clean --force -dfx',
  gwipe: 'git reset --hard && git clean --force -df',
  gbD: 'git branch --delete --force',
}

const expandAlias = (segment: string): string => {
  const m = /^((?:\w+=\S*\s+)*)(\S+)(.*)$/.exec(segment)
  const to = m === null ? undefined : ALIASES[(m[2] ?? '').replace(/^\\/, '')]
  return m === null || to === undefined ? segment : `${m[1]}${to}${m[3]}`
}

// The $ of $( stays with the segment on its left, so cd "$(...)" moves somewhere unknown instead of home.
const SEGMENT = /;|&&|\|\||\||&|\n|`|\(|\)/

export const segments = (command: string): string[] =>
  command
    .replace(/\\\n/g, ' ')
    .split(SEGMENT)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

const parts = (command: string): string[] => segments(command).flatMap((s) => segments(expandAlias(s)))

export const compile = (lines: string): RegExp[] =>
  lines
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [new RegExp(l)]
      } catch {
        return []
      }
    })

const normalize = (path: string): string => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)

// Quotes and backslashes anywhere in a word (r'm', \rm, "rm") are shell syntax, not text. Dropping them all also
// flattens the string that bash -c, sh -c or eval run into its own words.
const dequote = (s: string): string => s.replace(/["'\\]/g, '')

// An unquoted redirection is joined to its target (2> /dev/null reads as 2>/dev/null), so the target is never taken
// for an argument. A quoted '>' is not joined: the word after it is still an argument.
const argv = (segment: string): string[] =>
  segment
    .replace(/(?<=^| )(\d*[<>]+) (?=\S)/g, '$1')
    .split(' ')
    .map(dequote)
    .filter(Boolean)

// The segment as the shell splits it into words: quotes and escapes removed, spaces inside one word kept as \x01.
const unquoted = (seg: string): string => {
  let out = ''
  let quote = ''
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string
    if (c === '\\' && quote !== "'" && i + 1 < seg.length) out += (seg[++i] as string).replace(/\s/, '\x01')
    else if (quote ? c === quote : c === "'" || c === '"') quote = quote ? '' : c
    else out += quote && /\s/.test(c) ? '\x01' : c
  }
  return out
}

const UNRESOLVED: Verdict = {
  id: 'rm-unresolved',
  level: 'confirm',
  why: 'recursively deletes paths known only when it runs',
}

const OUTSIDE: Verdict = {
  id: 'rm-outside-project',
  level: 'block',
  why: 'recursively deletes files outside the project',
}

const PROJECT: Verdict = {
  id: 'rm-project',
  level: 'confirm',
  why: 'recursively deletes the project itself or its git history',
}

const BRACE = /^(.*?)\{([^{},]*(?:,[^{},]*)+)\}(.*)$/

// bash brace expansion, or null when it grows past what a person would type
const braces = (raw: string): string[] | null => {
  const done: string[] = []
  const todo = [raw]
  for (let w = todo.pop(); w !== undefined; w = todo.pop()) {
    const m = BRACE.exec(w)
    if (m === null) {
      done.push(w)
      continue
    }
    const alts = (m[2] ?? '').split(',')
    if (done.length + todo.length + alts.length > 64) return null
    for (const alt of alts) todo.push(`${m[1]}${alt}${m[3]}`)
  }
  return done
}

// Absolute path for a shell word, or null when only the shell at run time knows it.
const resolve = (raw: string, cwd: string | null, home: string): string | null => {
  if (/[$`]/.test(raw)) return null
  let expanded = raw
  if (raw === '~' || raw.startsWith('~/')) expanded = home + raw.slice(1)
  else if (raw === '~+' || raw.startsWith('~+/')) {
    if (cwd === null) return null
    expanded = cwd + raw.slice(2)
  } else if (raw === '~-' || raw.startsWith('~-/')) return null
  else if (raw.startsWith('~')) {
    const [name, ...rest] = raw.slice(1).split('/')
    const base = home.slice(0, home.lastIndexOf('/'))
    expanded = [name === 'root' ? '/root' : `${base}/${name}`, ...rest].join('/')
  }
  if (!expanded.startsWith('/') && cwd === null) return null
  const abs = normalize(expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`)
  // a bare glob as the last part (*, .*, ?) empties the whole directory above it
  const last = expanded.split('/').filter(Boolean).pop() ?? ''
  return /^\.?[*?]+$/.test(last) ? normalize(`${abs}/..`) : abs
}

const scratch = (abs: string, home: string): boolean =>
  /^\/(?:var\/)?tmp\/./.test(abs) || abs.startsWith(`${normalize(home)}/.cache/`)

// A glob or brace part that may become . or .. could climb out of the scratch dir: * and ? never match a leading dot.
const DOT_GLOB = /(?:^|\/)(?:\.[^/]*[*?[{]|[[{])/

// below: only the entries under each path are deleted, not the path itself
const classify = (
  raws: string[],
  cwd: string | null,
  root: string,
  home: string,
  insideToo: boolean,
  below = false,
) => {
  const projectRoot = normalize(root)
  let worst: Verdict | null = null
  for (const raw of raws) {
    const alts = braces(raw)
    if (alts === null) {
      worst = UNRESOLVED
      continue
    }
    for (const alt of alts) {
      const abs = resolve(alt, cwd, home)
      if (abs === null) {
        worst = UNRESOLVED
        continue
      }
      if (!DOT_GLOB.test(alt) && scratch(below ? `${abs}/_` : abs, home)) continue
      if (!inside(abs, projectRoot) || abs === '/' || abs === normalize(home)) return OUTSIDE
      if (insideToo && (abs === projectRoot || abs === `${projectRoot}/.git`)) worst = PROJECT
    }
  }
  return worst
}

const isRecursive = (a: string): boolean =>
  /^-[a-zA-Z]*[rR]/.test(a) || (a.length >= 3 && a.startsWith('--') && '--recursive'.startsWith(a))

const rmVerdict = (ws: string[], cwd: string | null, root: string, home: string): Verdict | null => {
  // git -c alias.x='!rm -rf ~' and core.editor=rm run their value
  const at = ws.findIndex((w) => /(?:^|[/=!])rm$/.test(w))
  if (at === -1) return null
  const args = ws.slice(at + 1)
  if (!args.some(isRecursive)) return null
  if (/(?:^|\/)git$/.test(ws[at - 1] ?? '') && args.includes('--cached')) return null
  if (ws.slice(0, at).some((w) => /(?:^|\/)(?:xargs|parallel)$/.test(w))) return UNRESOLVED
  const paths = args.filter((a) => !a.startsWith('-') && !/^\d*[<>]/.test(a))
  if (paths.length === 0) return UNRESOLVED
  return classify(paths, cwd, root, home, true)
}

// find -delete and find -exec rm delete recursively from their start paths
const findVerdict = (ws: string[], cwd: string | null, root: string, home: string): Verdict | null => {
  let at = ws.findIndex((w) => /(?:^|\/)find$/.test(w))
  if (at === -1) return null
  // -H, -L, -P, -O<n> and -D <opts> come before the start paths
  for (at++; at < ws.length; at++) {
    if (ws[at] === '-D') at++
    else if (!/^-(?:[HLP]|O\d*)$/.test(ws[at] ?? '')) break
  }
  const rest = ws.slice(at)
  const execs = rest.some(
    (w, i) => /^-(?:exec|ok)(?:dir)?$/.test(w) && /(?:^|\/)(?:rm|shred|unlink)$/.test(rest[i + 1] ?? ''),
  )
  if (!execs && !rest.includes('-delete')) return null
  const end = rest.findIndex((w) => /^[-(!]/.test(w))
  const starts = rest.slice(0, end === -1 ? rest.length : end)
  // A filter limits the deletion to entries below a start path, but the start path is tested too (-name 'tmp*' matches
  // /tmp): -delete cannot remove it while it holds anything, rm -rf can unless -mindepth skips it.
  const below =
    rest.some((w) => /^-(?:i?(?:name|path|wholename|regex)|[acm](?:time|min)|newer\w*)$/.test(w)) &&
    (!execs || rest.some((w, i) => w === '-mindepth' && Number(rest[i + 1]) >= 1))
  return classify(starts.length === 0 ? ['.'] : starts, cwd, root, home, false, below)
}

// where a cd or pushd in the segment moves, null when unknown, undefined when there is none
const cdTarget = (ws: string[], cwd: string | null, home: string): string | null | undefined => {
  const at = ws.findIndex((w) => w === 'cd' || w === 'pushd')
  if (at === -1) return undefined
  const to = ws.slice(at + 1).find((w) => !w.startsWith('-') || w === '-')
  if (to === undefined) return home
  if (to === '-') return null
  return resolve(to, cwd, home)
}

// Commands whose quoted arguments and heredoc bodies are only text: a commit message or a search pattern is not run.
const TEXT_HEAD = /^(?:echo|printf|grep|egrep|fgrep|rg|cat|tee)$/
const TEXT_SUB: Readonly<Record<string, RegExp>> = {
  git: /^(?:commit|tag|log|show|notes|stash)$/,
  gh: /^(?:pr|issue|release)$/,
}
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
// Every command of a line whose text is scrubbed must be one of these: none of them runs its input or arguments.
const SAFE_HEAD = /^(?:echo|printf|grep|egrep|fgrep|rg|cat|tee|git|gh|cd|ls|head|tail|wc|true|mkdir|chmod|touch)$/
const KEYWORD = /^(?:if|then|else|elif|fi|do|done|while|until|!|\{|\}|time)$/
// words read to find a command's name and subcommand; past this the command is treated as code
const LOOKAHEAD = 64

const commandAt = (words: readonly string[]): number => {
  let i = 0
  while (i < LOOKAHEAD && (/^\w+=/.test(words[i] ?? '') || KEYWORD.test(words[i] ?? ''))) i++
  return i
}

const textual = (words: readonly string[]): boolean => {
  let i = commandAt(words)
  const name = words[i] ?? ''
  if (TEXT_HEAD.test(name)) return true
  i++
  if (name === 'git') while (i < LOOKAHEAD && words[i]?.startsWith('-')) i += GIT_VALUED.has(words[i] ?? '') ? 2 : 1
  return TEXT_SUB[name]?.test(words[i] ?? '') ?? false
}

const scrub = (text: string): string => text.replace(/\W/g, '_')
const RUNS_TEXT = /\$\(|`/

// The heredoc body that starts at `from` (after the newline), as bash reads it: up to the first line equal to the
// delimiter. Returns the body and the index just past the delimiter line, or null when it never ends.
const heredoc = (src: string, from: number, delim: string, tabs: boolean): { body: string; end: number } | null => {
  let at = from
  while (at <= src.length) {
    const nl = src.indexOf('\n', at)
    const line = src.slice(at, nl === -1 ? src.length : nl)
    if ((tabs ? line.replace(/^\t+/, '') : line) === delim) return { body: src.slice(from, at), end: at + line.length }
    if (nl === -1) return null
    at = nl + 1
  }
  return null
}

const DELIM = /<<(-?)[ \t]*(?:(['"])([\w.-]+)\2|\\?([\w.-]+))(?![^\s;&|<>()])/y
// Claude's commit and PR form: -m "$(cat <<'EOF' ... EOF )"
const SUBST = /"\$\(cat <<(-?)[ \t]*(?:(['"])([\w.-]+)\2|([\w.-]+))[ \t]*\n/y
const SUBST_END = /\n[ \t]*\)"/y
const COMMENT = /[^\n`)]*(?:\n|$)/y

const sticky = (re: RegExp, src: string, at: number): RegExpExecArray | null => {
  re.lastIndex = at
  return re.exec(src)
}

// The command with text that is never run scrubbed into one opaque word: quoted arguments and heredoc bodies of the
// TEXT commands above, and comments. Returns the command unchanged when the line holds anything else that could run
// that text (a shell, an interpreter, a variable as a command, arithmetic) or when it cannot be read with certainty.
export const literal = (src: string): string => {
  // (( )), ${...} and $[...] keep spaces, #, << and nested quotes inside one word, which the scan below misreads
  if (/\(\(|\$[{[]/.test(src)) return src
  let out = ''
  let current: string[] = []
  let word = ''
  let safe = true
  let dollar = -1 // index of the last unescaped $ outside quotes: $'...' takes backslash escapes
  const pending: { delim: string; tabs: boolean; quoted: boolean; text: boolean }[] = []
  const push = () => {
    if (word) current.push(word)
    word = ''
  }
  const close = () => {
    push()
    const name = current[commandAt(current)]
    if (name !== undefined && !SAFE_HEAD.test(name)) safe = false
    current = []
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string
    if (c === '\\') {
      out += src.slice(i, i + 2)
      word += src.slice(i, i + 2)
      i++
    } else if (c === '"' && sticky(SUBST, src, i)) {
      const m = sticky(SUBST, src, i) as RegExpExecArray
      const doc = heredoc(src, SUBST.lastIndex, (m[3] ?? m[4]) as string, m[1] === '-')
      const after = doc && sticky(SUBST_END, src, doc.end)
      if (!doc || !after || !textual(current) || (!m[2] && RUNS_TEXT.test(doc.body))) return src
      const kept = `"${scrub(doc.body)}"`
      out += kept
      word += kept
      i = doc.end + after[0].length - 1
    } else if (c === "'" || c === '"') {
      const ansi = c === "'" && dollar === i - 1
      // bash reads $$'...' as $$ and a plain quote
      if (ansi && src[i - 2] === '$') return src
      let j = i + 1
      while (j < src.length && src[j] !== c) j += (c === '"' || ansi) && src[j] === '\\' ? 2 : 1
      if (j >= src.length) return src
      const body = src.slice(i + 1, j)
      // quotes nest inside "$(...)" and "`...`", so this quote may not end where the scan stopped; \` is plain text
      if (c === '"' && RUNS_TEXT.test(body.replace(/\\./g, ''))) return src
      const kept = `${c}${textual(current) ? scrub(body) : body}${c}`
      out += kept
      word += kept
      i = j
    } else if (c === '#' && word === '') {
      if (!sticky(COMMENT, src, i)) return src
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<' && src[i - 1] !== '<') {
      DELIM.lastIndex = i
      const m = DELIM.exec(src)
      if (!m) return src
      pending.push({
        delim: (m[3] ?? m[4]) as string,
        tabs: m[1] === '-',
        quoted: !!m[2] || m[0].includes('\\'),
        text: textual(current),
      })
      out += m[0]
      i = DELIM.lastIndex - 1
    } else if (c === '\n') {
      close()
      out += c
      for (const h of pending.splice(0)) {
        const doc = heredoc(src, i + 1, h.delim, h.tabs)
        if (!doc || !h.text || (!h.quoted && RUNS_TEXT.test(doc.body))) return src
        out += `${scrub(doc.body)}\n${h.delim}`
        i = doc.end - 1
      }
    } else if (/[^\S\n]/.test(c)) {
      push()
      out += c
    } else if (/[;|()`]/.test(c) || (c === '&' && !/[<>]/.test(src[i - 1] ?? '') && src[i + 1] !== '>')) {
      close()
      out += c
    } else {
      if (c === '$') dollar = i
      out += c
      word += c
    }
  }
  close()
  if (pending.length > 0) return src
  return safe ? out : src
}

const YES_TF = re(String.raw`${first(TF)}.*\sdestroy${END}`)

// `yes | terraform destroy` and `echo yes | terraform destroy` answer its only prompt
const answered = (command: string): boolean =>
  command.split(/;|&&|\|\||&|\n/).some((part) => {
    const stages = part.split('|')
    return stages.some(
      (stage, i) =>
        i > 0 && /\byes\b/.test(unquoted(stages[i - 1] ?? '')) && YES_TF.test(expandAlias(unquoted(stage.trim()))),
    )
  })

// cd targets kept per command; past this, relative paths count as unknown
const MAX_HERES = 16

export type Extra = { block: RegExp[]; confirm: RegExp[]; disabled: ReadonlySet<string> }

export const judge = (command: string, cwd: string, root: string, home: string, extra: Extra): Verdict | null => {
  let found: Verdict | null = null
  const take = (v: Verdict) => {
    if (extra.disabled.has(v.id)) return
    if (v.level === 'block') found = v
    else if (found === null) found = v
  }
  const text = literal(command)
  if (answered(text)) take(AUTO_DESTROY)
  // A cd can fail or sit inside a subshell or an echo, so relative paths are judged against the session cwd and
  // against every directory a cd may have moved to.
  const heres: (string | null)[] = [cwd]
  for (const seg of parts(text)) {
    const ws = argv(seg)
    const moved = cdTarget(ws, heres[heres.length - 1] ?? null, home)
    if (moved !== undefined) {
      const here = heres.length < MAX_HERES ? moved : null
      if (!heres.includes(here)) heres.push(here)
    }
    for (const at of heres) {
      const rm = rmVerdict(ws, at, root, home)
      if (rm) take(rm)
      const find = findVerdict(ws, at, root, home)
      if (find) take(find)
    }
    const forms = [...new Set([seg, unquoted(seg), dequote(seg)])]
    for (const rule of RULES) if (forms.some((f) => rule.pattern.test(f))) take(rule)
    if (found !== null && (found as Verdict).level === 'block') return found
  }
  for (const seg of parts(command)) {
    for (const re of extra.block)
      if (re.test(seg)) take({ id: `custom:${re.source}`, level: 'block', why: 'matches a custom block rule' })
    for (const re of extra.confirm)
      if (re.test(seg)) take({ id: `custom:${re.source}`, level: 'confirm', why: 'matches a custom confirm rule' })
    if (found !== null && (found as Verdict).level === 'block') return found
  }
  return found
}

export type ConfirmStyle = 'block' | 'ask'

const quote = (command: string): string => {
  const one = command.replace(/\s+/g, ' ').trim()
  return one.length > 80 ? `${one.slice(0, 79)}…` : one
}

export const decide = (verdict: Verdict | null, command: string, style: ConfirmStyle): Decision => {
  if (verdict === null) return { kind: 'pass' }
  const what = `"${quote(command)}" ${verdict.why} (bulkhead rule ${verdict.id})`
  if (verdict.level === 'block') {
    return {
      kind: 'deny',
      reason: `Blocked: ${what}. This needs a person: ask the user to run it in their own terminal. Do not rewrite the command to get around the rule.`,
    }
  }
  if (style === 'block') {
    return {
      kind: 'deny',
      reason: `Needs a person: ${what}. Ask the user to run it in their own terminal. Do not rewrite the command to get around the rule.`,
    }
  }
  return { kind: 'ask', reason: `${what}. Allow it?` }
}
