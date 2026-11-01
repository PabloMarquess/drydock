import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

type World = { ran: string[]; checks: string[] }

const engine = (on: On): World => {
  const world: World = { ran: [], checks: [] }
  mock.env(on, { HOME: '/home/dev' })
  on('session.root', () => ({ value: '/home/dev/work/infra' }))
  on('session.cwd', () => ({ value: '/home/dev/work/infra' }))
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

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)

describe('bulkhead', () => {
  test('a catastrophic command never reaches the shell', async ($, on) => {
    const world = engine(on)
    const result = await bash($, 'terraform destroy -auto-approve')
    expect(world.ran).toHaveLength(0)
    expect(JSON.stringify(result)).toContain('terraform-auto-destroy')
  })

  test('a subagent gets the same refusal', async ($, on) => {
    const world = engine(on)
    await $.tool.call({ tool: 'Bash', command: 'aws s3 rb s3://b --force', agentId: 'sub-1' } as never)
    expect(world.ran).toHaveLength(0)
  })

  test('a risky command is refused for a person by default', async ($, on) => {
    const world = engine(on)
    const result = await bash($, 'kubectl delete pod web-1')
    expect(world.ran).toHaveLength(0)
    expect(JSON.stringify(result)).toContain('Needs a person')
  })

  test('a harmless command runs untouched', async ($, on) => {
    const world = engine(on)
    await bash($, 'kubectl get pods')
    expect(world.ran).toEqual(['kubectl get pods'])
  })

  test(
    'confirmStyle ask turns the engine verdict into a question',
    { options: { confirmStyle: 'ask' } },
    async ($, on) => {
      const world = engine(on)
      const result = await bash($, 'kubectl delete pod web-1')
      expect(world.ran).toHaveLength(0)
      expect(JSON.stringify(result)).toContain('Permission to use Bash has been denied')
      expect(world.checks).toEqual(['kubectl delete pod web-1'])
    },
  )

  test('a plain permission query keeps the engine verdict', async ($, on) => {
    engine(on)
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'terraform apply' } })).toMatchObject({
      decision: 'allow',
    })
  })
})
