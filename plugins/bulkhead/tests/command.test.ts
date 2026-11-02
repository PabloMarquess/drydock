import type { On, PromptOrigin } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

type Surface = 'terminal' | 'desktop'
type World = {
  ran: string[]
  checks: string[]
  status: (string | undefined)[]
  commands: string[]
  sessionId: string
  isStoreDown: boolean
}

const SURFACES = ['terminal', 'desktop'] as const
const RISKY = 'kubectl delete pod web-1'
const BANNER = '⚠ bulkhead paused for this session · /bulkhead resume'

const PEOPLE: PromptOrigin[] = [{ kind: 'composer' }, { kind: 'sdk' }, { kind: 'bridge' }]
const OTHERS: PromptOrigin[] = [
  { kind: 'plugin', name: 'other' },
  { kind: 'task-notification' },
  { kind: 'scheduled-trigger' },
  { kind: 'peer' },
  { kind: 'peer-send-message' },
  { kind: 'projects-relay' },
  { kind: 'channel', server: 'slack' },
  { kind: 'coordinator' },
  { kind: 'observer' },
  { kind: 'observer-activity' },
  { kind: 'auto-continuation' },
  { kind: 'unclassified' },
  { kind: 'slack-ping' },
]

const engine = (on: On): World => {
  const world: World = { ran: [], checks: [], status: [], commands: [], sessionId: 's1', isStoreDown: false }
  mock.env(on, { HOME: '/home/dev' })
  on('state.get', { plugin: 'bulkhead' }, (_$, e, next) => (world.isStoreDown ? { deny: 'store down' } : next(e)))
  on('state.set', { plugin: 'bulkhead' }, (_$, e, next) => (world.isStoreDown ? { deny: 'store down' } : next(e)))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.run', (_$, e) => ({ text: `unhandled ${e.command}` }))
  on('ui.status', (_$, e) => {
    world.status.push(e.text)
    return { value: undefined }
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: world.sessionId }))
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

const start = async ($: Engine, on: On, surface: Surface) => {
  const world = engine(on)
  await $.session.start({ cwd: '/home/dev/work/infra', surface, isInteractive: true })
  return world
}

const bulkhead = async ($: Engine, args = '', origin: PromptOrigin = { kind: 'composer' }) =>
  (
    await $.command.run({
      command: 'bulkhead',
      args,
      origin,
      presentation: { isFullscreen: false, columns: 120 },
    })
  ).text ?? ''

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)

const OPTIONS = {
  extraBlock: 'secret-wipe\n^nuke ',
  extraConfirm: 'deploy-prod',
  disabledRules: 'git-discard, helm-remove',
}

describe('/bulkhead', () => {
  for (const surface of SURFACES) {
    test(`${surface}: registers the command at session start`, async ($, on) => {
      const world = await start($, on, surface)
      expect(world.commands).toEqual(['bulkhead'])
      expect(world.status).toEqual([])
    })

    test(`${surface}: a session start while paused pins the status again`, async ($, on) => {
      const world = await start($, on, surface)
      await bulkhead($, 'pause')
      await $.session.start({ cwd: '/home/dev/work/infra', surface, isInteractive: true })
      expect(world.commands).toEqual(['bulkhead', 'bulkhead'])
      expect(world.status).toEqual([BANNER, BANNER])
      await bash($, RISKY)
      expect(world.ran).toEqual([RISKY])
      expect(await bulkhead($)).toContain('bulkhead is PAUSED for this session')
    })

    test(`${surface}: status with the defaults`, async ($, on) => {
      await start($, on, surface)
      const text = await bulkhead($)
      expect(text).toContain('bulkhead is on')
      expect(text).toContain('confirmStyle block')
      expect(text).not.toContain('custom')
      expect(text).not.toContain('disabled')
    })

    test(`${surface}: status with options, block style`, { options: OPTIONS }, async ($, on) => {
      await start($, on, surface)
      const text = await bulkhead($, '  ')
      expect(text).toContain('bulkhead is on')
      expect(text).toContain('confirmStyle block')
      expect(text).toContain('2 custom block rule(s)')
      expect(text).toContain('1 custom confirm rule(s)')
      expect(text).toContain('disabled: git-discard, helm-remove')
    })

    test(
      `${surface}: status with options, ask style`,
      { options: { ...OPTIONS, confirmStyle: 'ask' } },
      async ($, on) => {
        await start($, on, surface)
        const text = await bulkhead($)
        expect(text).toContain('confirmStyle ask')
        expect(text).toContain('2 custom block rule(s)')
        expect(text).toContain('disabled: git-discard, helm-remove')
      },
    )

    for (const origin of PEOPLE) {
      test(`${surface}: pause by ${origin.kind} lets a blocked command through`, async ($, on) => {
        const world = await start($, on, surface)
        await bash($, RISKY)
        expect(world.ran).toHaveLength(0)
        expect(await bulkhead($, 'PAUSE', origin)).toContain('paused for this session')
        expect(world.status).toEqual([BANNER])
        await bash($, RISKY)
        await bash($, 'terraform destroy -auto-approve')
        expect(world.ran).toEqual([RISKY, 'terraform destroy -auto-approve'])
        expect(await bulkhead($)).toContain('bulkhead is PAUSED for this session')
      })
    }

    test(
      `${surface}: while paused, ask style neither asks nor denies`,
      { options: { confirmStyle: 'ask' } },
      async ($, on) => {
        const world = await start($, on, surface)
        await bulkhead($, 'pause')
        const result = await bash($, RISKY)
        expect(world.ran).toEqual([RISKY])
        expect(JSON.stringify(result)).not.toContain('bulkhead')
        expect(await $.tool.check({ tool: 'Bash', input: { command: RISKY } })).toMatchObject({ decision: 'allow' })
      },
    )

    for (const origin of OTHERS) {
      test(`${surface}: pause from ${origin.kind} is refused`, async ($, on) => {
        const world = await start($, on, surface)
        expect(await bulkhead($, 'pause', origin)).toContain('Nothing changed')
        expect(world.status).toEqual([])
        const result = await bash($, RISKY)
        expect(world.ran).toHaveLength(0)
        expect(JSON.stringify(result)).toContain('Needs a person')
        expect(await bulkhead($)).toContain('bulkhead is on')
      })
    }

    for (const origin of [...PEOPLE, ...OTHERS]) {
      test(`${surface}: resume from ${origin.kind} blocks again`, async ($, on) => {
        const world = await start($, on, surface)
        await bulkhead($, 'pause')
        expect(await bulkhead($, ' Resume ', origin)).toContain('bulkhead is on')
        expect(world.status).toEqual([BANNER, undefined])
        await bash($, RISKY)
        expect(world.ran).toHaveLength(0)
      })
    }

    test(`${surface}: an unknown argument shows the usage`, async ($, on) => {
      const world = await start($, on, surface)
      expect(await bulkhead($, 'off')).toContain('Usage: /bulkhead')
      await bash($, RISKY)
      expect(world.ran).toHaveLength(0)
    })

    for (const reason of ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] as const) {
      test(`${surface}: session end (${reason}) resets the pause`, async ($, on) => {
        const world = await start($, on, surface)
        await bulkhead($, 'pause')
        await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
        expect(world.status).toEqual([BANNER, undefined])
        await bash($, RISKY)
        expect(world.ran).toHaveLength(0)
        expect(await bulkhead($)).toContain('bulkhead is on')
      })
    }

    test(`${surface}: a failed reset does not break the session end`, async ($, on) => {
      const world = await start($, on, surface)
      await bulkhead($, 'pause')
      world.isStoreDown = true
      expect(await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })).toMatchObject({
        sessionId: 's1',
      })
      expect(world.status).toEqual([BANNER])
    })

    for (const reason of ['clear', 'resume'] as const) {
      test(`${surface}: a failed reset at ${reason} does not carry the pause over`, async ($, on) => {
        const world = await start($, on, surface)
        await bulkhead($, 'pause')
        world.isStoreDown = true
        await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
        world.isStoreDown = false
        world.sessionId = 's2'
        await bash($, RISKY)
        expect(world.ran).toHaveLength(0)
        expect(await bulkhead($)).toContain('bulkhead is on')
        expect(world.status).toEqual([BANNER, undefined])
      })
    }

    test(`${surface}: a failed state read stays closed`, async ($, on) => {
      const world = await start($, on, surface)
      await bulkhead($, 'pause')
      world.isStoreDown = true
      const result = await bash($, 'ls')
      expect(world.ran).toHaveLength(0)
      expect(JSON.stringify(result)).toContain('could not check this command')
    })

    test(
      `${surface}: a failed state read cannot open the ask path`,
      { options: { confirmStyle: 'ask' } },
      async ($, on) => {
        const world = await start($, on, surface)
        world.isStoreDown = true
        const result = await bash($, RISKY)
        expect(world.ran).toHaveLength(0)
        expect(world.checks).toEqual([])
        expect(JSON.stringify(result)).toContain('could not check this command')
      },
    )
  }
})
