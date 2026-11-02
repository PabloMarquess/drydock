import { describe } from 'claude-code/testing'

import { COMMIT, table } from './support'

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

const GROUPS: Record<string, string[]> = {
  'text that is never run': [
    COMMIT,
    PR,
    DOC,
    'git commit -m "fix: terraform destroy -auto-approve no longer runs in CI"',
    'git commit -m "fix: terraform destroy -auto-approve" 2>&1 | tail -5',
    "git commit -F - <<'EOF'\nchore: kubectl delete ns prod is guarded\nEOF",
    'git commit -m "chore: never run git push --force to main"',
    'git commit -m "chore: rm -rf /tmp/cache in the cleanup script"',
    'git log -S "kubectl delete" --oneline',
    'grep -rn "kubectl delete ns" docs/',
    'grep -rn "kubectl delete ns" docs/ | head',
    "rg 'terraform destroy -auto-approve' .",
    'echo "run: terraform destroy -auto-approve"',
    "printf '%s\\n' 'kubectl delete namespace prod'",
  ],
  'terraform: flags, file names and paths are not subcommands': [
    'tf plan',
    'terraform plan -destroy',
    'terraform plan -destroy -out=destroy.tfplan',
    'terraform plan -out=apply.tfplan',
    'terraform show -json apply.tfplan',
    'terraform show -json destroy.tfplan',
    'terraform -chdir=modules/import plan',
    'terragrunt run-all plan --terragrunt-non-interactive',
    'cat terraform/import.tf',
    'git diff terraform/apply.tf',
    'git checkout -b fix/terraform-apply-timeout',
  ],
  'kubectl and helm: only the subcommand counts': [
    'k get pods',
    'kubectl auth can-i delete pods --all-namespaces',
    'kubectl get cronjob delete-old -A',
    'kubectl get pods -A -l app=delete-me',
    'kubectl logs deploy/cleanup -c delete-worker',
    'kubectl apply -f jobs/delete-old-backups.yaml',
    'kubectl api-resources --verbs=delete',
    'kubectl taint nodes n1 key=value:NoSchedule',
    'kubectl delete pod web-1 --dry-run=client',
    'kubectl delete ns prod --dry-run=client',
    'helm upgrade --install web ./chart -n app',
    'helm upgrade --install web ./chart --set cleanup.delete=true',
    'helm upgrade --install delete-old-jobs ./chart',
    'helm plugin uninstall diff',
    'helmfile apply',
  ],
  'aws: only the operation counts, not a resource name': [
    'aws lambda invoke --function-name stop-dev-instances out.json',
    'aws ecs describe-services --cluster prod --services delete-queue-consumer',
    'aws ssm get-parameter --name stop-window',
    'aws dynamodb scan --table-name reset-tokens',
    'aws kms describe-key --key-id k',
  ],
  'git: no force, no discard': [
    'git push -u origin feat/x',
    'git push --follow-tags',
    'git push --follow-tags origin feat/x',
    'git stash push -m wip -- :/src',
    'git stash pop',
    'git checkout -b feat/x',
    'git restore --staged .',
    'git branch -d feat/x',
  ],
  'rm: build output, scratch and cache dirs': [
    'rm -rf node_modules/*',
    'cd src && rm -rf build',
    "find . -name '*.pyc' -delete",
    'rm -rf /tmp/build-1234',
    'rm -rf /tmp/claude-1000/session/scratchpad/out',
    'rm -rf ~/.cache/pip',
    'kubectl exec web-1 -- rm -rf /tmp/uploads',
  ],
}

for (const [name, commands] of Object.entries(GROUPS))
  describe(name, () => table(commands.map((command) => [command, 'pass'])))
