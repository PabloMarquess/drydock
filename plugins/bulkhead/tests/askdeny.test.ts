import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const engine = (on: On) => {
  const ran: string[] = []
  mock.env(on, { HOME: '/home/dev' })
  on('session.root', () => ({ value: '/home/dev/work/infra' }))
  on('session.cwd', () => ({ value: '/home/dev/work/infra' }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(String(e.command))
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  return ran
}
describe('ask refusal text', () => {
  test('refused ask', { options: { confirmStyle: 'ask' } }, async ($, on) => {
    const ran = engine(on)
    const cmds = ['kubectl delete pod a', 'ls', 'helm uninstall x', 'git status', 'kubectl delete pod b']
    const rs = await Promise.all(cmds.map((c) => $.tool.call({ tool: 'Bash', command: c } as never)))
    expect(ran.sort()).toEqual(['git status', 'ls'])
    expect(JSON.stringify(rs[0])).toContain('Do not rewrite the command')
    expect(JSON.stringify(rs[2])).toContain('helm-remove')
  })
  test('block style for comparison', async ($, on) => {
    engine(on)
    const text = JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'kubectl delete pod a' } as never))
    expect(text).toContain('Needs a person')
    expect(text).toContain('kubectl-change')
    expect(text).not.toContain('Permission to use Bash')
  })
})
