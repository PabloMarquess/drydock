import { describe, expect, test } from 'claude-code/testing'

import { compile, decide, type Extra, judge } from '../hooks/rules'

const HOME = '/home/dev'
const ROOT = '/home/dev/work/infra'
const NONE: Extra = { block: [], confirm: [], disabled: new Set() }

const verdict = (command: string, extra: Extra = NONE, cwd = ROOT) => {
  const v = judge(command, cwd, ROOT, HOME, extra)
  return v === null ? 'pass' : `${v.level}:${v.id}`
}

const CASES: [string, string][] = [
  ['terraform plan', 'pass'],
  ['terraform apply', 'confirm:terraform-change'],
  ['terraform apply -auto-approve', 'confirm:terraform-change'],
  ['terraform destroy', 'confirm:terraform-change'],
  ['terraform destroy -auto-approve', 'block:terraform-auto-destroy'],
  ['tofu apply -destroy -auto-approve', 'block:terraform-auto-destroy'],
  ['cd envs/prod && TF_LOG=debug terraform destroy -auto-approve', 'block:terraform-auto-destroy'],
  ['bash -c "terraform destroy -auto-approve"', 'block:terraform-auto-destroy'],
  ['terraform state rm aws_instance.web', 'confirm:terraform-state'],
  ['terraform workspace delete old', 'confirm:terraform-state'],
  ['kubectl get pods -A', 'pass'],
  ['kubectl -n app delete pod web-1', 'confirm:kubectl-change'],
  ['kubectl delete ns prod', 'block:kubectl-mass-delete'],
  ['kubectl delete pods --all -n app', 'block:kubectl-mass-delete'],
  ['kubectl drain node-1 --ignore-daemonsets', 'confirm:kubectl-change'],
  ['kubectl scale deploy web --replicas=0', 'confirm:kubectl-scale-zero'],
  ['kubectl scale deploy web --replicas=3', 'pass'],
  ['helm uninstall web -n app', 'confirm:helm-remove'],
  ['helm upgrade --install web ./chart', 'pass'],
  ['aws s3 ls s3://bucket', 'pass'],
  ['aws ec2 describe-instances', 'pass'],
  ['aws ec2 terminate-instances --instance-ids i-1', 'confirm:aws-delete'],
  ['AWS_PROFILE=prod aws s3 rm s3://bucket --recursive', 'block:aws-mass-delete'],
  ['aws s3 rb s3://bucket --force', 'block:aws-mass-delete'],
  ['aws rds delete-db-instance --db-instance-identifier db --skip-final-snapshot', 'block:aws-mass-delete'],
  ['aws cloudformation delete-stack --stack-name app', 'block:aws-mass-delete'],
  ['aws iam attach-role-policy --role-name r --policy-arn p', 'confirm:aws-iam'],
  ['aws iam list-roles', 'pass'],
  ['aws s3 sync ./site s3://bucket --delete', 'confirm:aws-s3-write'],
  ['git push', 'pass'],
  ['git push origin feat/x', 'pass'],
  ['git push --force-with-lease origin feat/x', 'confirm:git-force-push'],
  ['git -C repo push -f origin main', 'block:git-force-push-main'],
  ['git push origin +main', 'block:git-force-push-main'],
  ['git push origin --delete old-branch', 'confirm:git-delete-remote'],
  ['git reset --hard HEAD~1', 'confirm:git-discard'],
  ['git clean -fdx', 'confirm:git-discard'],
  ['git branch -D feat/x', 'confirm:git-discard'],
  ['git status && git diff', 'pass'],
  ['rm file.txt', 'pass'],
  ['rm -rf node_modules dist', 'pass'],
  ['rm -rf .', 'confirm:rm-project'],
  ['rm -rf .git', 'confirm:rm-project'],
  ['rm -rf ../other-project', 'block:rm-outside-project'],
  ['rm -rf /', 'block:rm-outside-project'],
  ['rm -rf /*', 'block:rm-outside-project'],
  ['rm -r ~/', 'block:rm-outside-project'],
  ['sudo -u root rm -rf /var/lib/app', 'block:rm-outside-project'],
  ['echo ok; rm -rf "$HOME"', 'confirm:rm-unresolved'],
  ['rm -rf $BUILD_DIR', 'confirm:rm-unresolved'],
  ['ls | xargs rm -rf', 'confirm:rm-unresolved'],
  ['x=$(rm -rf ~/notes)', 'block:rm-outside-project'],
]

describe('rules', () => {
  for (const [command, expected] of CASES) {
    test(command, () => {
      expect(verdict(command)).toBe(expected)
    })
  }

  test('a block anywhere wins over an earlier confirm', () => {
    expect(verdict('git reset --hard && terraform destroy -auto-approve')).toBe('block:terraform-auto-destroy')
  })

  test('disabled rules are skipped', () => {
    expect(verdict('git clean -fdx', { ...NONE, disabled: new Set(['git-discard']) })).toBe('pass')
  })

  test('custom rules apply and bad expressions are ignored', () => {
    const extra: Extra = {
      block: compile('\\bmkfs\\b\n(broken'),
      confirm: compile('^psql .*drop\\b'),
      disabled: new Set(),
    }
    expect(verdict('mkfs.ext4 /dev/sdb1', extra)).toBe('block:custom:\\bmkfs\\b')
    expect(verdict('psql -c drop table x', extra)).toBe('confirm:custom:^psql .*drop\\b')
    expect(extra.block).toHaveLength(1)
  })
})

describe('decide', () => {
  const block = judge('terraform destroy -auto-approve', ROOT, ROOT, HOME, NONE)
  const confirm = judge('terraform apply', ROOT, ROOT, HOME, NONE)

  test('nothing to guard passes', () => {
    expect(decide(null, 'ls', 'block')).toEqual({ kind: 'pass' })
  })

  for (const style of ['block', 'ask'] as const) {
    test(`a block rule is refused with confirmStyle ${style}`, () => {
      expect(decide(block, 'terraform destroy -auto-approve', style)).toMatchObject({
        kind: 'deny',
        reason: expect.stringContaining('Do not rewrite the command'),
      })
    })
  }

  test('a confirm rule is refused for a person with confirmStyle block', () => {
    expect(decide(confirm, 'terraform apply', 'block')).toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('Needs a person'),
    })
  })

  test('a confirm rule asks with confirmStyle ask', () => {
    expect(decide(confirm, 'terraform apply', 'ask')).toMatchObject({
      kind: 'ask',
      reason: expect.stringContaining('terraform-change'),
    })
  })
})
