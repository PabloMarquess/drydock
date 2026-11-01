// The rules of hooks/rules.ts written plainly, unanchored and without first(): slow on long input, but the reference
// for what each anchored pattern must match. The order follows RULES.

const END = String.raw`(?![\w./:=-])`
const FLAGS = String.raw`(?:\s+-\S+(?:\s+[^-\s]\S*)?)*`
const tool = (name: string): string => String.raw`\b${name}(?:\.exe|-[\d.]+)?${FLAGS}\s+`
const run = (name: string, sub: string): string => `${tool(name)}(?:${sub})${END}`
const DRY = String.raw`(?!.*\s--dry-run=(?:client|server)\b(?!.*\s--dry-run\b))`
const TF = String.raw`\b(?:terraform|tofu|terragrunt)\b`
const AUTO = String.raw`(?:\s|=)--?auto-approve\b`
const KINDS =
  '(?:namespaces?|ns|nodes?|no|pv|persistentvolumes?|crds?|customresourcedefinitions?|clusterroles?|clusterrolebindings?)'
const AWS = String.raw`\baws\b`
const FORCE = String.raw`\s(?:--force(?:-with-lease)?\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+\S)`
const MAIN = String.raw`[\s:+]["']?(?:refs/heads/)?(?:main|master)${END}`

export const RULES: readonly { id: string; pattern: RegExp }[] = [
  {
    id: 'terraform-auto-destroy',
    pattern: new RegExp(
      [
        String.raw`${TF}(?=.*\sdestroy${END}|.*\sapply${END}.*\s--?destroy\b)(?=.*${AUTO}|.*<<<\s*yes\b)`,
        String.raw`(?:^|\s)TF_CLI_ARGS\w*=\S*auto-approve\b.*${TF}.*\sdestroy${END}`,
        String.raw`^(?=.*\bterragrunt\b)(?=.*\s(?:run-all|--all)${END})(?=.*\sdestroy${END})(?=.*(?:\s--(?:terragrunt-)?non-interactive\b|_NON_INTERACTIVE=(?:true|1)\b))`,
      ].join('|'),
    ),
  },
  {
    id: 'terraform-change',
    pattern: new RegExp(String.raw`${TF}.*\s(?:apply|destroy|import|taint|untaint|force-unlock)${END}`),
  },
  {
    id: 'terraform-state',
    pattern: new RegExp(String.raw`${TF}.*\b(?:state\s+(?:rm|mv|push|replace-provider)|workspace\s+delete)\b`),
  },
  {
    id: 'kubectl-mass-delete',
    pattern: new RegExp(
      String.raw`^${DRY}(?:(?=.*\s(?:--all|--all-namespaces|-A)(?:\s|=|$)).*${run('kubectl', 'delete')}|.*${tool('kubectl')}delete${FLAGS}\s+(?:[\w.-]+,)*${KINDS}(?:\.v1)?(?![\w.:=-]))`,
      'i',
    ),
  },
  {
    id: 'kubectl-change',
    pattern: new RegExp(
      String.raw`^${DRY}.*(?:${run('kubectl', String.raw`delete|drain|cordon|rollout\s+undo`)}|${run('kubectl', 'replace')}.*\s--force\b|${run('kubectl', 'apply')}.*\s--prune\b|${run('kubectl', 'taint')}.*:NoExecute\b)`,
    ),
  },
  {
    id: 'kubectl-scale-zero',
    pattern: new RegExp(String.raw`${run('kubectl', 'scale')}.*--replicas[=\s]0\b`),
  },
  {
    id: 'helm-remove',
    pattern: new RegExp(`${run('helm', 'uninstall|delete|del|un|rollback')}|${run('helmfile', 'destroy|delete')}`),
  },
  {
    id: 'aws-mass-delete',
    pattern: new RegExp(
      String.raw`${AWS}.*\b(?:s3\s+rb\b.*\s--force\b|s3\s+rm\b.*\s--recursive\b|rds\s+delete-db-(?:instance|cluster)\b.*(?:\s--skip-final-snapshot\b|SkipFinalSnapshot\W*:\s*true\b)|cloudformation\s+delete-stack\b|eks\s+delete-cluster\b)`,
    ),
  },
  {
    id: 'aws-delete',
    pattern: new RegExp(
      String.raw`${AWS}.*\s(?<!\s--?[\w-]+\s+)(?:(?:batch-)?(?:delete|terminate|deregister|remove|revoke|detach|disable|purge|cancel|stop|reset|disassociate)-[a-z0-9-]+|schedule-key-deletion|leave-organization)${END}`,
    ),
  },
  {
    id: 'aws-iam',
    pattern: new RegExp(
      String.raw`${AWS}.*\biam\s+(?:put|attach|create|update)-[a-z-]*(?:policy|role|user|access-key|login-profile)\b`,
    ),
  },
  {
    id: 'aws-s3-write',
    pattern: new RegExp(String.raw`${AWS}.*\bs3\s+(?:rm|mv)\b|${AWS}.*\bs3\s+sync\b.*\s--delete\b`),
  },
  {
    id: 'git-force-push-main',
    pattern: new RegExp(String.raw`${run('git', 'push')}(?:(?=.*${FORCE})(?=.*${MAIN})|(?=.*\s--mirror\b))`),
  },
  {
    id: 'git-force-push',
    pattern: new RegExp(`${run('git', 'push')}.*${FORCE}`),
  },
  {
    id: 'git-delete-remote',
    pattern: new RegExp(String.raw`${run('git', 'push')}.*\s(?:--delete\b|-d\b|--prune\b|:\S)`),
  },
  {
    id: 'git-discard',
    pattern: new RegExp(
      [
        String.raw`${run('git', 'reset')}(?=.*\s--hard\b)`,
        String.raw`${run('git', 'branch')}(?=.*\s(?:--delete\b|-[a-zA-Z]*[dD]))(?=.*\s(?:--force\b|-[a-zA-Z]*[fD]))`,
        String.raw`${run('git', 'clean')}.*\s(?:-[a-zA-Z]*f|--force\b)`,
        String.raw`${run('git', 'checkout')}.*\s(?:\.|:/)(?:\s|$)`,
        String.raw`^(?!.*\s(?:--staged|-S)\b).*${run('git', 'restore')}.*\s(?:\.|:/)(?:\s|$)`,
        String.raw`${run('git', 'restore')}(?=.*\s(?:--worktree\b|-[a-zA-Z]*W))(?=.*\s(?:\.|:/)(?:\s|$))`,
        String.raw`${run('git', 'checkout|switch')}.*\s(?:-f|--force|--discard-changes)\b`,
        run('git', String.raw`stash\s+(?:clear|drop)|update-ref\s+-d|reflog\s+expire|filter-branch|filter-repo`),
      ].join('|'),
    ),
  },
]
