import { describe, expect, test } from 'claude-code/testing'

import { bash, COMMIT, engine } from './support'

describe('the Bash hook', () => {
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
    const text = JSON.stringify(await bash($, 'kubectl delete pod web-1'))
    expect(world.ran).toHaveLength(0)
    expect(text).toContain('Needs a person')
    expect(text).toContain('kubectl-change')
    expect(text).not.toContain('Permission to use Bash')
  })

  test('a harmless command runs untouched', async ($, on) => {
    const world = engine(on)
    await bash($, 'kubectl get pods')
    expect(world.ran).toEqual(['kubectl get pods'])
  })

  test('the usual commit heredoc reaches the shell', async ($, on) => {
    const world = engine(on)
    await bash($, COMMIT)
    expect(world.ran).toEqual([COMMIT])
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

  test(
    'concurrent calls with confirmStyle ask refuse each risky command and run the rest',
    { options: { confirmStyle: 'ask' } },
    async ($, on) => {
      const world = engine(on)
      const commands = ['kubectl delete pod a', 'ls', 'helm uninstall x', 'git status', 'kubectl delete pod b']
      const results = await Promise.all(commands.map((command) => bash($, command)))
      expect(world.ran.sort()).toEqual(['git status', 'ls'])
      expect(JSON.stringify(results[0])).toContain('Do not rewrite the command')
      expect(JSON.stringify(results[2])).toContain('helm-remove')
    },
  )

  test('a plain permission query keeps the engine verdict', async ($, on) => {
    engine(on)
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'terraform apply' } })).toMatchObject({
      decision: 'allow',
    })
  })
})
