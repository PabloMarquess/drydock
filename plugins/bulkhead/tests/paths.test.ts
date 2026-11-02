import { describe } from 'claude-code/testing'

import { type Case, table } from './support'

const B = 'block:rm-outside-project'
const P = 'confirm:rm-project'
const U = 'confirm:rm-unresolved'

const GROUPS: Record<string, Case[]> = {
  'recursive rm outside the project': [
    ['rm -rf "/home/dev/my docs"', B],
    ['rm --recur /home/dev/other', B],
    ['rm --rec -f /home/dev/other', B],
    ['rm --r /home/dev/other', B],
    ['rm -rf ~root', B],
    ['rm -rf ~dev', B],
    ['rm -rf ~user', B],
    ['rm -rf {/home/dev,x}', B],
    ['kubectl exec db-0 -- rm -rf /var/lib/postgresql/data', B],
  ],
  'paths known only when it runs': [
    ['rm -rf ~-', U],
    ['rm -rf "$HOME/old stuff"', U],
    ['rm -rf "$(dirname $PWD)"', U],
    ['xargs rm -rf < list.txt', U],
  ],
  'the project itself': [
    ['rm -rf *', P],
    ['rm -rf .*', P],
    ['cd .. && rm -rf infra', P],
  ],
  'cd and pushd move the paths': [
    ['cd / && rm -rf *', B],
    ['cd /; rm -rf *', B],
    ['cd ~ && rm -rf *', B],
    ['cd /home/dev && rm -rf work', B],
    ['pushd / && rm -rf home', B],
    ['(cd / && rm -rf usr)', B],
    ["bash -c 'cd / && rm -rf home'", B],
    ['echo cd x && rm -rf ../other-project', B],
    ['cd nonexistent; rm -rf ../other-project', B],
    ['cd src && cd .. && rm -rf build', 'pass'],
    ['cd - && rm -rf build', U],
  ],
  'cd into a command substitution': [
    ['cd "$(git rev-parse --show-toplevel)" && rm -rf dist', U],
    ['cd $(git rev-parse --show-toplevel) && rm -rf node_modules', U],
    ['cd && rm -rf work', B],
    ['cd "$(pwd)" && rm -rf ../other', B],
    ['kubectl delete ns $(cat ns.txt)', 'block:kubectl-mass-delete'],
    ['rm -rf "$(pwd)/x"', U],
  ],
  'find deletes from its start paths': [
    ['find / -delete', B],
    ['find /home/dev -delete', B],
    ['find .. -delete', B],
    ['find / -exec rm -rf {} +', B],
    ['find / -name x -exec rm -rf {} ;', B],
    ['find / -name x -exec rm -rf {} \\;', B],
    ['find /home/dev -type f -exec rm {} +', B],
    ['find -L / -delete', B],
    ['find -H /home/dev -delete', B],
    ['find -O3 / -exec rm -rf {} +', B],
    ['find -D tree / -delete', B],
    ['find -L . -delete', 'pass'],
  ],
  'scratch dirs and globs below them': [
    ['rm -rf /tmp', B],
    ['rm -rf /tmp/../etc', B],
    ['rm -rf ~/.cache/../.ssh', B],
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
  'git rm --cached only unstages': [
    ['git rm -r --cached .', 'pass'],
    ['git rm -r .', P],
    ['git rm -rf /home/dev/other', B],
    ['rm -r --cached /home/dev', B],
  ],
}

for (const [name, cases] of Object.entries(GROUPS)) describe(name, () => table(cases))
