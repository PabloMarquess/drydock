import { describe, expect, test } from 'claude-code/testing'

import { type Extra, judge } from '../hooks/rules'

const HOME = '/home/dev'
const ROOT = '/home/dev/work/infra'
const NONE: Extra = { block: [], confirm: [], disabled: new Set() }

const verdict = (command: string) => {
  const v = judge(command, ROOT, ROOT, HOME, NONE)
  return v === null ? 'pass' : `${v.level}:${v.id}`
}

const BYPASSES: [string, string][] = [
  // quoting inside a word
  ["'t'erraform destroy -auto-approve", 'block:terraform-auto-destroy'],
  ["terraform des'troy' -auto-approve", 'block:terraform-auto-destroy'],
  ["terraform destroy '-auto-approve'", 'block:terraform-auto-destroy'],
  ["kubectl de'lete' ns prod", 'block:kubectl-mass-delete'],
  ["git push origin '+main'", 'block:git-force-push-main'],
  ["aws s3 rm s3://b '--recursive'", 'block:aws-mass-delete'],
  // terraform flag forms
  ['terraform destroy --auto-approve', 'block:terraform-auto-destroy'],
  ['terraform apply --destroy --auto-approve', 'block:terraform-auto-destroy'],
  ['TF_CLI_ARGS_destroy=-auto-approve terraform destroy', 'block:terraform-auto-destroy'],
  ['echo yes | terraform destroy', 'block:terraform-auto-destroy'],
  ['terraform destroy <<< yes', 'block:terraform-auto-destroy'],
  ['terragrunt run-all destroy --terragrunt-non-interactive', 'block:terraform-auto-destroy'],
  // kubectl / helm
  ['kubectl delete --namespace prod ns x', 'block:kubectl-mass-delete'],
  ['kubectl delete -n prod namespace x', 'block:kubectl-mass-delete'],
  ['kubectl delete deploy,ns prod', 'block:kubectl-mass-delete'],
  ['kubectl delete Namespace prod', 'block:kubectl-mass-delete'],
  ['kubectl apply --prune --all -f dir/', 'confirm:kubectl-change'],
  ['helm del web', 'confirm:helm-remove'],
  ['helm un web', 'confirm:helm-remove'],
  ['helmfile destroy', 'confirm:helm-remove'],
  // aliases the user's shell snapshot defines (oh-my-zsh git + kubectl)
  ['k delete ns prod', 'block:kubectl-mass-delete'],
  ['kdelns prod', 'block:kubectl-mass-delete'],
  ['gpf! origin main', 'block:git-force-push-main'],
  ['grhh', 'confirm:git-discard'],
  ['gpristine', 'confirm:git-discard'],
  // aws
  [
    'aws rds delete-db-instance --cli-input-json \'{"DBInstanceIdentifier":"db","SkipFinalSnapshot":true}\'',
    'block:aws-mass-delete',
  ],
  ['aws kms schedule-key-deletion --key-id k', 'confirm:aws-delete'],
  ['aws ecr batch-delete-image --repository-name r --image-ids imageTag=x', 'confirm:aws-delete'],
  // git
  ['git push -uf origin main', 'block:git-force-push-main'],
  ['git push --mirror', 'block:git-force-push-main'],
  ['git clean --force -d', 'confirm:git-discard'],
  ['git branch --delete --force feat/x', 'confirm:git-discard'],
  ['git branch -df feat/x', 'confirm:git-discard'],
  ['git switch --discard-changes main', 'confirm:git-discard'],
  ['git stash clear', 'confirm:git-discard'],
  // rm
  ['bash -c "rm -rf /home/dev"', 'block:rm-outside-project'],
  ["sh -c 'rm -rf /home/dev'", 'block:rm-outside-project'],
  ['eval "rm -rf /home/dev"', 'block:rm-outside-project'],
  ['\\rm -rf /home/dev/other', 'block:rm-outside-project'],
  ['rm -rf "/home/dev/my docs"', 'block:rm-outside-project'],
  ['rm --recur /home/dev/other', 'block:rm-outside-project'],
  ['rm -rf ~root', 'block:rm-outside-project'],
  ['rm -rf ~dev', 'block:rm-outside-project'],
  ['rm -rf {/home/dev,x}', 'block:rm-outside-project'],
  ['cd / && rm -rf *', 'block:rm-outside-project'],
  ['cd /home/dev && rm -rf work', 'block:rm-outside-project'],
  ["bash -c 'cd / && rm -rf home'", 'block:rm-outside-project'],
  ['rm -rf *', 'confirm:rm-project'],
  ['rm -rf "$(dirname $PWD)"', 'confirm:rm-unresolved'],
  ['xargs rm -rf < list.txt', 'confirm:rm-unresolved'],
  ['find / -delete', 'block:rm-outside-project'],
  ['find / -name x -exec rm -rf {} \\;', 'block:rm-outside-project'],
]

const HARMLESS = [
  'git checkout -b feat/x',
  'git restore --staged .',
  'git branch -d feat/x',
  'git push -u origin feat/x',
  'git push --follow-tags origin feat/x',
  'helm upgrade --install web ./chart -n app',
  'rm -rf node_modules/*',
  'cd src && rm -rf build',
  "find . -name '*.pyc' -delete",
  'k get pods',
  'tf plan',
  'terragrunt run-all plan --terragrunt-non-interactive',
  'kubectl taint nodes n1 key=value:NoSchedule',
]

describe('evasion', () => {
  for (const [command, expected] of BYPASSES) {
    test(command, () => {
      expect(verdict(command)).toBe(expected)
    })
  }
  for (const command of HARMLESS) {
    test(`harmless: ${command}`, () => {
      expect(verdict(command)).toBe('pass')
    })
  }
})
