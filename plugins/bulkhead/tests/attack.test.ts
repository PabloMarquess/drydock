import { describe, expect, test } from 'claude-code/testing'
import { type Extra, judge } from '../hooks/rules'

const HOME = '/home/dev'
const ROOT = '/home/dev/work/infra'
const NONE: Extra = { block: [], confirm: [], disabled: new Set() }
const verdict = (command: string) => {
  const v = judge(command, ROOT, ROOT, HOME, NONE)
  return v === null ? 'pass' : `${v.level}:${v.id}`
}
const B = 'block:rm-outside-project'
const K = 'block:kubectl-mass-delete'
const T = 'block:terraform-auto-destroy'
const U = 'confirm:rm-unresolved'

const CASES: Record<string, [string, string][]> = {
  'quotes nest inside "$(...)"': [
    ['git commit -m "$(echo "x"; rm -rf ~)"', B],
    ['echo "$(true "a"; terraform destroy -auto-approve)"', T],
    ['git commit -m "$(echo "x"; kubectl delete ns prod)"', K],
    ['echo "`echo "x"; kubectl delete ns prod`"', K],
  ],
  '${...} and $[...] are one word': [
    [`echo "$\{x:-"'"}"; rm -rf ~; echo '\\'`, B],
    [`echo "$\{x:-"'"}"; kubectl delete ns prod; echo '\\'`, K],
    [`echo $\{x:- #}; rm -rf ~`, B],
    [`echo $\{x:- #}; terraform destroy -auto-approve`, T],
    [`echo $\{x:-<<EOF }\nrm -rf ~\nEOF`, B],
    ['echo $[1<<EOF ]\nrm -rf ~\nEOF', B],
  ],
  "$$'...' is $$ and a plain quote": [["echo $$'\\'; rm -rf ~; echo '\\'", B]],
  'git runs the value of an alias or editor': [
    ["git -c alias.x='!rm -rf ~' x", B],
    ["git -c core.editor='rm -rf ~' commit", B],
  ],
  'globs below a scratch dir': [
    ['rm -rf /tmp/claude-*', 'pass'],
    ['rm -rf /tmp/test-run-*', 'pass'],
    ['rm -rf /tmp/build-*/out', 'pass'],
    ['rm -rf /tmp/*', B],
    ['rm -rf /tmp/.*', B],
    ['rm -rf /tmp/x/.*', B],
    ['rm -rf /tmp/.?*', B],
    ['rm -rf /tmp/[.][.]/etc', B],
    ['rm -rf /tmp/*/../../etc', B],
    ['rm -rf /tmp/{a,../../etc}', B],
    ['rm -rf /tmp/{.,.}{.,.}/home/dev', B],
    // zsh with BRACE_CCL expands {.}{.} to ..
    ['rm -rf /tmp/{.}{.}/home/dev', B],
  ],
  'find with a filter below a scratch dir': [
    ["find /tmp -maxdepth 1 -name 'pytest-*' -mtime +1 -delete", 'pass'],
    ["find /tmp -mindepth 1 -name 'tmp*' -exec rm -rf {} +", 'pass'],
    // the start path itself is tested too: -name 'tmp*' matches /tmp, so rm -rf /tmp runs
    ["find /tmp -name 'tmp*' -exec rm -rf {} +", B],
    ["find /tmp -mindepth 0 -name 'tmp*' -exec rm -rf {} +", B],
    ['find /tmp -delete', B],
    ['find / -name x -delete', B],
    ["find ~ -name '*.log' -delete", B],
    ["find /tmp/../etc -name '*.conf' -delete", B],
  ],
  'redirection targets are not paths': [
    ['rm -rf build 2> /dev/null', 'pass'],
    ['rm -rf dist > /dev/null 2>&1', 'pass'],
    ['rm -rf ~ 2> /dev/null', B],
    ['rm -rf / 2>/dev/null', B],
    ['rm -rf > /dev/null /home/dev', B],
    ["rm -rf '>' ~ build", B],
    ['rm -rf ">" /home/dev build', B],
  ],
  'cd into a command substitution': [
    ['cd "$(git rev-parse --show-toplevel)" && rm -rf dist', U],
    ['cd $(git rev-parse --show-toplevel) && rm -rf node_modules', U],
    ['cd && rm -rf work', B],
    ['cd "$(pwd)" && rm -rf ../other', B],
    ['kubectl delete ns $(cat ns.txt)', K],
    ['rm -rf "$(pwd)/x"', U],
  ],
  'backticks that are only text': [
    ["git commit -m 'docs: explain `kubectl delete ns` guard'", 'pass'],
    ["gh pr create --title 'x' --body 'blocks `terraform destroy -auto-approve`'", 'pass'],
    ['git commit -m "docs: explain \\`kubectl delete ns\\` guard"', 'pass'],
    ['git commit -m "`kubectl delete ns prod`"', K],
    ['git commit -m "\\\\`kubectl delete ns prod`"', K],
    ['git commit -m "$(kubectl delete ns prod)"', K],
    ["echo 'kubectl delete ns `x`' | sh", K],
    ["git commit -m 'x `' ; kubectl delete ns prod ; echo '` y'", K],
    ['echo "$(date)" ; rm -rf ~', B],
  ],
  'heredocs written next to mkdir, chmod or touch': [
    ["mkdir -p docs && cat > docs/teardown.md <<'EOF'\n# Teardown\nkubectl delete namespace staging\nEOF", 'pass'],
    [
      "mkdir -p .github/workflows && cat > .github/workflows/destroy.yml <<'EOF'\n      - run: terraform destroy -auto-approve\nEOF",
      'pass',
    ],
    ["cat > scripts/clean.sh <<'EOF'\nrm -rf /var/lib/app/cache\nEOF\nchmod +x scripts/clean.sh", 'pass'],
    ["mkdir -p x && bash <<'EOF'\nterraform destroy -auto-approve\nEOF", T],
    ["mkdir -p x && cat <<'EOF' | sh\nkubectl delete ns prod\nEOF", K],
    ["echo 'kubectl delete ns prod' > x.sh && chmod +x x.sh && ./x.sh", K],
    ["touch x && eval 'kubectl delete ns prod'", K],
  ],
  'git rm --cached only unstages': [
    ['git rm -r --cached .', 'pass'],
    ['git rm -r .', 'confirm:rm-project'],
    ['git rm -rf /home/dev/other', B],
    ['rm -r --cached /home/dev', B],
  ],
}

for (const [name, cases] of Object.entries(CASES))
  describe(name, () => {
    for (const [command, expected] of cases)
      test(command, () => {
        expect(verdict(command)).toBe(expected)
      })
  })
