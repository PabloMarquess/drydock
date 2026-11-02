import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { type Extra, judge } from '../hooks/rules'

export const HOME = '/home/dev'
export const ROOT = '/home/dev/work/infra'
export const NONE: Extra = { block: [], confirm: [], disabled: new Set() }

export const verdict = (command: string, extra: Extra = NONE): string => {
  const v = judge(command, ROOT, ROOT, HOME, extra)
  return v === null ? 'pass' : `${v.level}:${v.id}`
}

export type Case = [command: string, expected: string]

export const table = (cases: readonly Case[]) => {
  for (const [command, expected] of cases)
    test(command, () => {
      expect(verdict(command)).toBe(expected)
    })
}

export const COMMIT = `git commit -m "$(cat <<'EOF'
feat(bulkhead): guard Bash

Blocks terraform destroy -auto-approve and kubectl delete ns.
EOF
)"`

export type World = { ran: string[]; checks: string[] }

export const engine = (on: On): World => {
  const world: World = { ran: [], checks: [] }
  mock.env(on, { HOME })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('tool.check', (_$, e) => {
    world.checks.push(String((e.input as { command?: unknown }).command))
    return { decision: 'allow' }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    world.ran.push(String(e.command))
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  return world
}

export const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)
