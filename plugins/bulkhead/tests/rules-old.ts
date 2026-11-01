export type Level = 'block' | 'confirm'

export type Rule = { id: string; level: Level; pattern: RegExp; why: string }

export type Verdict = { id: string; level: Level; why: string }

export type Decision = { kind: 'pass' } | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string }

const TF = String.raw`\b(?:terraform|tofu|terragrunt)\b`

export const RULES: readonly Rule[] = [
  {
    id: 'terraform-auto-destroy',
    level: 'block',
    pattern: new RegExp(`${TF}(?=.*\\bdestroy\\b|.*\\bapply\\b.*\\s-destroy\\b)(?=.*\\s-auto-approve\\b)`),
    why: 'destroys infrastructure with no plan to review',
  },
  {
    id: 'terraform-change',
    level: 'confirm',
    pattern: new RegExp(`${TF}.*\\b(?:apply|destroy|import|taint|untaint|force-unlock)\\b`),
    why: 'changes real infrastructure or its state',
  },
  {
    id: 'terraform-state',
    level: 'confirm',
    pattern: new RegExp(`${TF}.*\\b(?:state\\s+(?:rm|mv|push|replace-provider)|workspace\\s+delete)\\b`),
    why: 'rewrites Terraform state',
  },
  {
    id: 'kubectl-mass-delete',
    level: 'block',
    pattern:
      /\bkubectl\b(?=.*\bdelete\b)(?=.*\s(?:--all|--all-namespaces|-A)(?:\s|=|$)|.*\bdelete\s+(?:-\S+\s+)*(?:namespaces?|ns|nodes?|no|pv|persistentvolumes?|crds?|customresourcedefinitions?|clusterroles?|clusterrolebindings?)\b)/,
    why: 'deletes cluster-wide or namespace-wide resources',
  },
  {
    id: 'kubectl-change',
    level: 'confirm',
    pattern: /\bkubectl\b.*\b(?:delete|drain|cordon|rollout\s+undo|replace\b.*\s--force)\b/,
    why: 'removes or disrupts workloads',
  },
  {
    id: 'kubectl-scale-zero',
    level: 'confirm',
    pattern: /\bkubectl\b.*\bscale\b.*--replicas[=\s]0\b/,
    why: 'scales a workload to zero',
  },
  {
    id: 'helm-remove',
    level: 'confirm',
    pattern: /\bhelm\b.*\b(?:uninstall|delete|rollback)\b/,
    why: 'removes or rolls back a release',
  },
  {
    id: 'aws-mass-delete',
    level: 'block',
    pattern:
      /\baws\b.*\b(?:s3\s+rb\b.*\s--force\b|s3\s+rm\b.*\s--recursive\b|rds\s+delete-db-(?:instance|cluster)\b.*\s--skip-final-snapshot\b|cloudformation\s+delete-stack\b|eks\s+delete-cluster\b)/,
    why: 'deletes data or a whole stack with no way back',
  },
  {
    id: 'aws-delete',
    level: 'confirm',
    pattern:
      /\baws\b.*\s(?:delete|terminate|deregister|remove|revoke|detach|disable|purge|cancel|stop|reset|disassociate)-[a-z0-9-]+\b/,
    why: 'deletes or stops AWS resources',
  },
  {
    id: 'aws-iam',
    level: 'confirm',
    pattern: /\baws\b.*\biam\s+(?:put|attach|create|update)-[a-z-]*(?:policy|role|user|access-key|login-profile)\b/,
    why: 'changes IAM permissions',
  },
  {
    id: 'aws-s3-write',
    level: 'confirm',
    pattern: /\baws\b.*\bs3\s+(?:rm|mv)\b|\baws\b.*\bs3\s+sync\b.*\s--delete\b/,
    why: 'removes or moves S3 objects',
  },
  {
    id: 'git-force-push-main',
    level: 'block',
    pattern: /\bgit\b.*\bpush\b(?=.*\s(?:--force(?:-with-lease)?\b|-f\b|\+\S))(?=.*\b(?:main|master)\b)/,
    why: 'rewrites the history of the main branch',
  },
  {
    id: 'git-force-push',
    level: 'confirm',
    pattern: /\bgit\b.*\bpush\b.*\s(?:--force(?:-with-lease)?\b|-f\b|\+\S)/,
    why: 'rewrites remote history',
  },
  {
    id: 'git-delete-remote',
    level: 'confirm',
    pattern: /\bgit\b.*\bpush\b.*\s(?:--delete\b|-d\b|:\S)/,
    why: 'deletes a remote branch or tag',
  },
  {
    id: 'git-discard',
    level: 'confirm',
    pattern:
      /\bgit\b.*\b(?:reset\b.*--hard\b|branch\b.*\s-D\b|clean\b.*\s-[a-zA-Z]*f|(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)|filter-(?:branch|repo)\b)/,
    why: 'discards local work or rewrites history',
  },
]

const SEGMENT = /;|&&|\|\||\||&|\n|\$\(|`|\(|\)/

export const segments = (command: string): string[] =>
  command
    .replace(/\\\n/g, ' ')
    .split(SEGMENT)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

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

const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/, '$2')

const UNRESOLVED: Verdict = {
  id: 'rm-unresolved',
  level: 'confirm',
  why: 'recursively deletes paths known only when it runs',
}

export const rmVerdict = (segment: string, cwd: string, root: string, home: string): Verdict | null => {
  const words = segment.split(' ').map(unquote)
  const at = words.findIndex((w) => /(?:^|\/)rm$/.test(w))
  if (at === -1) return null
  const args = words.slice(at + 1)
  const isRecursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
  if (!isRecursive) return null

  const paths = args.filter((a) => !a.startsWith('-'))
  if (paths.length === 0) return UNRESOLVED
  const projectRoot = normalize(root)
  let worst: Verdict | null = null
  for (const raw of paths) {
    if (/[$`]/.test(raw)) {
      worst = UNRESOLVED
      continue
    }
    const expanded = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw
    const abs = normalize(expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`)
    if (!inside(abs, projectRoot) || abs === '/' || abs === normalize(home)) {
      return { id: 'rm-outside-project', level: 'block', why: 'recursively deletes files outside the project' }
    }
    if (abs === projectRoot || abs === `${projectRoot}/.git`) {
      worst = { id: 'rm-project', level: 'confirm', why: 'recursively deletes the project itself or its git history' }
    }
  }
  return worst
}

export type Extra = { block: RegExp[]; confirm: RegExp[]; disabled: ReadonlySet<string> }

export const judge = (command: string, cwd: string, root: string, home: string, extra: Extra): Verdict | null => {
  let found: Verdict | null = null
  const take = (v: Verdict) => {
    if (extra.disabled.has(v.id)) return
    if (v.level === 'block') found = v
    else if (found === null) found = v
  }
  for (const seg of segments(command)) {
    const rm = rmVerdict(seg, cwd, root, home)
    if (rm) take(rm)
    for (const rule of RULES) if (rule.pattern.test(seg)) take(rule)
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
