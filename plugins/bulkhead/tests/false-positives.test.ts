import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { compile, type Extra, judge } from '../hooks/rules'

const HOME = '/home/dev'
const ROOT = '/home/dev/work/infra'
const NONE: Extra = { block: [], confirm: [], disabled: new Set() }

const verdict = (command: string, cwd = ROOT, extra: Extra = NONE) => {
  const v = judge(command, cwd, ROOT, HOME, extra)
  return v === null ? 'pass' : `${v.level}:${v.id}`
}

const COMMIT = `git commit -m "$(cat <<'EOF'
feat(bulkhead): guard Bash

Blocks terraform destroy -auto-approve and kubectl delete ns.
EOF
)"`
const PR = `gh pr create --title "bulkhead" --body "$(cat <<'EOF'
## Summary
- refuses aws s3 rb s3://x --force
- refuses git push --force origin main
EOF
)"`
const DOC = `cat > docs/runbook.md <<'MD'
# Teardown
Run kubectl delete namespace staging, then terraform destroy -auto-approve.
MD`

const FALSE_POSITIVES: [string, string][] = [
  // text that is never run
  [COMMIT, 'pass'],
  [PR, 'pass'],
  [DOC, 'pass'],
  ['git commit -m "fix: terraform destroy -auto-approve no longer runs in CI"', 'pass'],
  ['git commit -m "chore: never run git push --force to main"', 'pass'],
  ['git commit -m "chore: rm -rf /tmp/cache in the cleanup script"', 'pass'],
  ['git log -S "kubectl delete" --oneline', 'pass'],
  ['grep -rn "kubectl delete ns" docs/', 'pass'],
  ["rg 'terraform destroy -auto-approve' .", 'pass'],
  ['echo "run: terraform destroy -auto-approve"', 'pass'],
  ["printf '%s\\n' 'kubectl delete namespace prod'", 'pass'],
  ['git push -f origin feat/x  # rebased onto main', 'confirm:git-force-push'],
  // terraform: flags, file names and paths are not subcommands
  ['terraform plan -destroy', 'pass'],
  ['terraform plan -destroy -out=destroy.tfplan', 'pass'],
  ['terraform plan -out=apply.tfplan', 'pass'],
  ['terraform show -json apply.tfplan', 'pass'],
  ['terraform -chdir=modules/import plan', 'pass'],
  ['cat terraform/import.tf', 'pass'],
  ['git diff terraform/apply.tf', 'pass'],
  ['git checkout -b fix/terraform-apply-timeout', 'pass'],
  ['terraform apply -auto-approve destroy.tfplan', 'confirm:terraform-change'],
  // kubectl and helm: only the subcommand counts
  ['kubectl auth can-i delete pods --all-namespaces', 'pass'],
  ['kubectl get cronjob delete-old -A', 'pass'],
  ['kubectl get pods -A -l app=delete-me', 'pass'],
  ['kubectl logs deploy/cleanup -c delete-worker', 'pass'],
  ['kubectl apply -f jobs/delete-old-backups.yaml', 'pass'],
  ['kubectl api-resources --verbs=delete', 'pass'],
  ['kubectl delete pod web-1 --dry-run=client', 'pass'],
  ['kubectl delete -f nodes-exporter.yaml', 'confirm:kubectl-change'],
  ['kubectl delete -f pv-claim.yaml', 'confirm:kubectl-change'],
  ['helm upgrade --install web ./chart --set cleanup.delete=true', 'pass'],
  ['helm upgrade --install delete-old-jobs ./chart', 'pass'],
  ['helm plugin uninstall diff', 'pass'],
  // aws: only the operation counts, not a resource name
  ['aws lambda invoke --function-name stop-dev-instances out.json', 'pass'],
  ['aws ecs describe-services --cluster prod --services delete-queue-consumer', 'pass'],
  ['aws ssm get-parameter --name stop-window', 'pass'],
  ['aws dynamodb scan --table-name reset-tokens', 'pass'],
  // git: main must be the pushed ref, push must be the subcommand
  ['git push --force-with-lease origin feat/main-menu', 'confirm:git-force-push'],
  ['git push -f origin fix/main-page', 'confirm:git-force-push'],
  ['git stash push -m wip -- :/src', 'pass'],
  // rm: scratch and cache dirs are not the user's data
  ['rm -rf /tmp/build-1234', 'pass'],
  ['rm -rf /tmp/claude-1000/session/scratchpad/out', 'pass'],
  ['rm -rf ~/.cache/pip', 'pass'],
  ['kubectl exec web-1 -- rm -rf /tmp/uploads', 'pass'],
]

const STILL_GUARDED: [string, string][] = [
  ['bash -c "terraform destroy -auto-approve"', 'block:terraform-auto-destroy'],
  ["sh -c 'kubectl delete ns prod'", 'block:kubectl-mass-delete'],
  ['eval "aws s3 rb s3://b --force"', 'block:aws-mass-delete'],
  ["echo 'terraform destroy -auto-approve' | sh", 'block:terraform-auto-destroy'],
  ["printf 'kubectl delete ns prod\\n' | xargs -I{} sh -c '{}'", 'block:kubectl-mass-delete'],
  ['echo "$(terraform destroy -auto-approve)"', 'block:terraform-auto-destroy'],
  ['git commit -m "`kubectl delete ns prod`"', 'block:kubectl-mass-delete'],
  ["$(echo 'terraform destroy -auto-approve')", 'block:terraform-auto-destroy'],
  ["bash <<'EOF'\nterraform destroy -auto-approve\nEOF", 'block:terraform-auto-destroy'],
  ["cat <<'EOF' | sh\nkubectl delete ns prod\nEOF", 'block:kubectl-mass-delete'],
  ['bash -c "$(cat <<\'EOF\'\nterraform destroy -auto-approve\nEOF\n)"', 'block:terraform-auto-destroy'],
  ['cat > f <<EOF\n$(terraform destroy -auto-approve)\nEOF', 'block:terraform-auto-destroy'],
  ["echo 'terraform destroy -auto-approve' > x.sh && chmod +x x.sh && ./x.sh", 'block:terraform-auto-destroy'],
  ["git -c alias.nuke='!terraform destroy -auto-approve' nuke", 'block:terraform-auto-destroy'],
  ["git -c core.editor='terraform destroy -auto-approve' commit", 'block:terraform-auto-destroy'],
  ['ssh bastion "kubectl delete ns prod"', 'block:kubectl-mass-delete'],
  ['python3 -c \'import os; os.system("terraform destroy -auto-approve")\'', 'block:terraform-auto-destroy'],
  ["watch -n 60 'kubectl delete pod --all -n app'", 'block:kubectl-mass-delete'],
  ['git commit -m "x" ; kubectl delete ns prod', 'block:kubectl-mass-delete'],
  ['echo a #comment\nkubectl delete ns prod', 'block:kubectl-mass-delete'],
  ['rm -rf "$HOME/old stuff"', 'confirm:rm-unresolved'],
  ['kubectl -n app delete ns prod', 'block:kubectl-mass-delete'],
  ['kubectl -A delete pods --all', 'block:kubectl-mass-delete'],
  ['kubectl delete namespace/prod', 'block:kubectl-mass-delete'],
  ['kubectl delete pods --all -n app --dry-run=none', 'block:kubectl-mass-delete'],
  ['helm --kube-context prod uninstall web', 'confirm:helm-remove'],
  ['aws --profile prod ec2 terminate-instances --instance-ids i-1', 'confirm:aws-delete'],
  ['aws ec2 --region us-east-1 terminate-instances --instance-ids i-1', 'confirm:aws-delete'],
  ['aws-vault exec prod -- aws ec2 terminate-instances --instance-ids i-1', 'confirm:aws-delete'],
  ['git push -f origin HEAD:main', 'block:git-force-push-main'],
  ['git push --force origin refs/heads/main', 'block:git-force-push-main'],
  ['git --no-pager push -f origin master', 'block:git-force-push-main'],
  ['terragrunt run-all destroy -auto-approve', 'block:terraform-auto-destroy'],
  ['docker run --rm -v $PWD:/w hashicorp/terraform:1.9 destroy -auto-approve', 'block:terraform-auto-destroy'],
  ['terraform apply -destroy -auto-approve', 'block:terraform-auto-destroy'],
  ['rm -rf /tmp/../etc', 'block:rm-outside-project'],
  ['rm -rf /tmp/*', 'block:rm-outside-project'],
  ['rm -rf /tmp', 'block:rm-outside-project'],
  ['rm -rf ~/.cache/../.ssh', 'block:rm-outside-project'],
  ['kubectl exec db-0 -- rm -rf /var/lib/postgresql/data', 'block:rm-outside-project'],
  // holes in the first proposed fix (RUNS deny-list, \s-only token anchors, dry-run, /tmp)
  ['echo "<<EOF"\nkubectl delete ns prod\nEOF', 'block:kubectl-mass-delete'],
  ["x=$(echo 'kubectl delete ns prod'); $x", 'block:kubectl-mass-delete'],
  ["echo 'terraform destroy -auto-approve' | at now", 'block:terraform-auto-destroy'],
  ['terraform "destroy" -auto-approve', 'block:terraform-auto-destroy'],
  ['terraform destroy>tf.log -auto-approve', 'block:terraform-auto-destroy'],
  ['git push -f origin "main"', 'block:git-force-push-main'],
  ['git -C "my repo" push -f origin main', 'block:git-force-push-main'],
  ['kubectl "delete" ns prod', 'block:kubectl-mass-delete'],
  ['kubectl --context "my ctx" delete ns prod', 'block:kubectl-mass-delete'],
  ['kubectl delete ns prod --dry-run=server --dry-run=none', 'block:kubectl-mass-delete'],
  ["kubectl delete ns prod ' --dry-run=client'", 'block:kubectl-mass-delete'],
  ['rm -rf /tmp/{a,../../etc}', 'block:rm-outside-project'],
  ['helm "uninstall" web', 'confirm:helm-remove'],
  ['aws ec2 "terminate-instances" --instance-ids i-1', 'confirm:aws-delete'],
  // tokenizer edge cases that must not hide a command
  ["echo \\$'\\' ; kubectl delete ns prod ; echo \\$'\\'", 'block:kubectl-mass-delete'],
  ["echo $'it\\'s' ; kubectl delete ns prod", 'block:kubectl-mass-delete'],
  ['echo ` # x` ; kubectl delete ns prod', 'block:kubectl-mass-delete'],
  ['cat <<E"OF"\nEOF\nkubectl delete ns prod\nE', 'block:kubectl-mass-delete'],
  [
    'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\necho)" ; kubectl delete ns prod ; echo "$(cat <<\'EOF\'\nx\nEOF\n)"',
    'block:kubectl-mass-delete',
  ],
  ["echo '\"$(cat <<'EOF'\nx'\nkubectl delete ns prod\necho '\nEOF\n)\"'", 'block:kubectl-mass-delete'],
  ["x=$(echo 'kubectl delete ns prod') $[1<<2]\n$x\n2", 'block:kubectl-mass-delete'],
  ["cat <<'EOF' > x.sh\nkubectl delete ns prod\nEOF\n. x.sh", 'block:kubectl-mass-delete'],
  ["kubectl apply -f - <<'EOF'\nkind: Namespace\nEOF\nkubectl delete ns prod", 'block:kubectl-mass-delete'],
  ['git -c "core.fsmonitor=kubectl delete ns prod" commit -m x', 'block:kubectl-mass-delete'],
  ["printf 'kubectl delete ns prod' | sed e", 'block:kubectl-mass-delete'],
]

const MORE_FALSE_POSITIVES: [string, string][] = [
  ['git commit -m "fix: terraform destroy -auto-approve" 2>&1 | tail -5', 'pass'],
  ["git commit -F - <<'EOF'\nchore: kubectl delete ns prod is guarded\nEOF", 'pass'],
  ['grep -rn "kubectl delete ns" docs/ | head', 'pass'],
  ['git push -f origin main-menu', 'confirm:git-force-push'],
  ['git push -f origin main:main', 'block:git-force-push-main'],
  ['kubectl delete ns prod --dry-run=client', 'pass'],
  ['terraform show -json destroy.tfplan', 'pass'],
]

describe('false positives', () => {
  for (const [command, expected] of FALSE_POSITIVES) {
    test(command, () => {
      expect(verdict(command)).toBe(expected)
    })
  }
})

describe('more false positives', () => {
  for (const [command, expected] of MORE_FALSE_POSITIVES) {
    test(command, () => {
      expect(verdict(command)).toBe(expected)
    })
  }
})

describe('still guarded', () => {
  for (const [command, expected] of STILL_GUARDED) {
    test(command, () => {
      expect(verdict(command)).toBe(expected)
    })
  }

  test('custom rules still see quoted text', () => {
    const extra: Extra = { block: [], confirm: compile('\\bDROP DATABASE\\b'), disabled: new Set() }
    expect(verdict('psql -c "DROP DATABASE prod"', ROOT, extra)).toBe('confirm:custom:\\bDROP DATABASE\\b')
  })

  test('pathological inputs stay fast', () => {
    for (const long of [
      `git${' -c a'.repeat(3000)} x`,
      `kubectl${' -n a'.repeat(3000)} get`,
      `aws${' --a b'.repeat(3000)} ec2 describe`,
      `echo ${'"a" '.repeat(5000)}`,
      `terraform${' destroy.x'.repeat(3000)}`,
    ]) {
      const t = Date.now()
      verdict(long)
      expect(Date.now() - t).toBeLessThan(200)
    }
  })

  test('a long command stays fast', () => {
    const long = `kubectl get pods${' -l a=b -n x'.repeat(200)} | grep x`
    const t = Date.now()
    verdict(long)
    expect(Date.now() - t).toBeLessThan(200)
  })
})

describe('through the hook', () => {
  const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)
  const engine = (on: On) => {
    const ran: string[] = []
    mock.env(on, { HOME })
    on('session.root', () => ({ value: ROOT }))
    on('session.cwd', () => ({ value: ROOT }))
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      ran.push(String(e.command))
      return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
    })
    return ran
  }

  test('the usual commit heredoc reaches the shell', async ($, on) => {
    const ran = engine(on)
    await bash($, COMMIT)
    expect(ran).toEqual([COMMIT])
  })
})
