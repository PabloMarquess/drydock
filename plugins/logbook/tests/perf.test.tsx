import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const TURNS = 50
const PER_TURN = 200
const SAMPLE = 20

type Write = { key: string; bytes: number }

const engine = (on: On, writes: Write[]) => {
  mock.clock(on, { now: 1_000_000 })
  mock.session(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { ok: true }, text: 'x'.repeat(400) }) as never)
  on('state.set', (_$, e, next) => {
    writes.push({ key: e.key, bytes: JSON.stringify(e.value).length })
    return next(e)
  })
}

const read = ($: Engine, path: string) => $.tool.call({ tool: 'Read', file_path: path } as never)

// One turn filled to its bound, then a sample of calls into it: what each call writes, and how long it takes.
const fullTurn = async ($: Engine, writes: Write[], t: number) => {
  await $.turn.start({ text: `turn ${t}`, turnId: `t${t}` })
  for (let i = 0; i < PER_TURN; i++) await read($, `/repo/some/dir/file-${t}-${i}.ts`)
  writes.length = 0
  const startedAt = Date.now()
  for (let i = 0; i < SAMPLE; i++) await read($, `/repo/some/dir/extra-${t}-${i}.ts`)
  const cost = {
    ms: (Date.now() - startedAt) / SAMPLE,
    bytes: writes.reduce((s, w) => s + w.bytes, 0) / SAMPLE,
    largest: Math.max(...writes.map((w) => w.bytes)),
    keys: [...new Set(writes.map((w) => w.key))].sort(),
    perCall: writes.length / SAMPLE,
  }
  await $.turn.complete({ answer: 'd', durationMs: 1, isAborted: false, turnId: `t${t}`, reason: 'answer' })
  return cost
}

describe('cost per call', () => {
  test(
    `with ${TURNS} turns of ${PER_TURN} entries a call writes its turn and the count, as cheaply as in the first turn`,
    { timeoutMs: 300_000 },
    async ($, on) => {
      const writes: Write[] = []
      engine(on, writes)
      await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
      const first = await fullTurn($, writes, 1)
      for (let t = 2; t < TURNS; t++) await fullTurn($, writes, t)
      const last = await fullTurn($, writes, TURNS + 1)
      expect(last.keys).toEqual(['recorded', 'turn'])
      expect(last.perCall).toBe(2)
      expect(last.largest).toBeLessThan(40_000)
      expect(last.bytes).toBeLessThanOrEqual(first.bytes * 1.05)
    },
  )
})
