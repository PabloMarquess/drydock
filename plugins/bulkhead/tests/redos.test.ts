import { describe, expect, test } from 'claude-code/testing'

import { judge, RULES } from '../hooks/rules'
import { RULES as OLD } from './rules-plain'

const extra = { block: [], confirm: [], disabled: new Set<string>() }
const run = (cmd: string) => judge(cmd, '/home/dev/work/infra', '/home/dev/work/infra', '/home/dev', extra)

const time = (cmd: string) => {
  const t = performance.now()
  const v = run(cmd)
  return { ms: performance.now() - t, v: v?.id ?? null }
}

describe('budget', () => {
  for (const unit of [
    'terraform apply ',
    'kubectl scale ',
    'kubectl replace ',
    'aws s3 rb ',
    'aws s3 sync ',
    'git push ',
    'git reset git branch git clean ',
    'terraform apply kubectl scale aws s3 rb git push helm ',
  ]) {
    test(`200 KB of "${unit.trim()}" stays well under the budget`, () => {
      const cmd = unit.repeat(Math.ceil(200_000 / unit.length))
      expect(time(cmd).ms).toBeLessThan(1000)
    })
  }
})

const WORDS = [
  'terraform',
  'tofu',
  'apply',
  'destroy',
  '-destroy',
  '-auto-approve',
  'state',
  'rm',
  'mv',
  'workspace',
  'delete',
  'kubectl',
  'delete',
  '--all',
  '-A',
  'ns',
  'pods',
  '-n',
  'x',
  'drain',
  'rollout',
  'undo',
  'replace',
  '--force',
  'scale',
  '--replicas=0',
  '--replicas',
  '0',
  'helm',
  'uninstall',
  'aws',
  's3',
  'rb',
  '--recursive',
  'sync',
  '--delete',
  'rds',
  'delete-db-instance',
  '--skip-final-snapshot',
  'cloudformation',
  'delete-stack',
  'eks',
  'delete-cluster',
  'iam',
  'attach-role-policy',
  'terminate-instances',
  'git',
  'push',
  '-f',
  '+main',
  'main',
  'master',
  'origin',
  '-d',
  ':old',
  'reset',
  '--hard',
  'branch',
  '-D',
  'clean',
  '-fdx',
  'checkout',
  'restore',
  '--',
  '.',
  'filter-repo',
  'echo',
  '=',
  'terragrunt',
  'run-all',
  '--all',
  '--non-interactive',
  '--auto-approve',
  'TF_CLI_ARGS=-auto-approve',
  '<<<',
  'yes',
  'destroy.tfplan',
  'Namespace',
  'deploy,ns',
  'namespace/prod',
  'nodes-exporter.yaml',
  '--dry-run=client',
  '--dry-run=none',
  '--context',
  '-x',
  'kubectl.exe',
  'apply',
  '--prune',
  'taint',
  'k=v:NoExecute',
  'del',
  'un',
  'helmfile',
  'batch-delete-image',
  'schedule-key-deletion',
  '--function-name',
  'stop-x',
  'SkipFinalSnapshot":true',
  '--mirror',
  '-uf',
  'HEAD:main',
  'refs/heads/main',
  'main-menu',
  '-C',
  'stash',
  'clear',
  '-S',
  '--staged',
  '--worktree',
  '-W',
  ':/',
  'switch',
  '--discard-changes',
  'update-ref',
  'reflog',
  'expire',
  '--delete',
  '--force',
]

describe('same verdicts as the original patterns', () => {
  test('200k random segments', () => {
    let seed = 42
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    let diffs = 0
    const shown: string[] = []
    for (let i = 0; i < 200_000; i++) {
      const len = 1 + rnd(9)
      const seg = Array.from({ length: len }, () => WORDS[rnd(WORDS.length)]).join(' ')
      for (const [r, rule] of RULES.entries()) {
        if (rule.pattern.test(seg) !== OLD[r]?.pattern.test(seg)) {
          if (diffs++ < 10) shown.push(`${rule.id} ${JSON.stringify(seg)}`)
        }
      }
    }
    expect(shown).toEqual([])
    expect(diffs).toBe(0)
  })
})
