import type { EngineInterface, Register, Timer, TurnCompleteInput, TurnUsage } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { AgentRow } from '../types'
import { costOf, modelName, promptTokens, windowOf } from './pricing'

const PANE = 'deck'
const TITLE = 'Deck'
const MAX_ROWS = 200

const agents = atom({ plugin: 'deck', key: 'agents' } as const, [])
const now = atom({ plugin: 'deck', key: 'now' } as const, 0)
const autoOpened = atom({ plugin: 'deck', key: 'autoOpened' } as const, false)

const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

const tokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))

const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const openPane = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: TITLE })
}

const togglePane = async ($: EngineInterface): Promise<boolean> => {
  if ((await $.ui.panes()).some((p) => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($)
  return true
}

const tick = async ($: EngineInterface) => {
  const list = await read($, agents)
  if (!list.some((a) => a.status === 'running')) return
  const at = await $.clock.now()
  await update($, now, () => at)
}

const recordStep = async ($: EngineInterface, agentId: string, usage: TurnUsage, writeMultiplier: number) => {
  const cost = costOf(usage.model, usage, writeMultiplier)
  const prompt = promptTokens(usage)
  await update($, agents, (list) =>
    list.map((a) =>
      a.id !== agentId
        ? a
        : {
            ...a,
            model: usage.model || a.model,
            status: 'running',
            endedAt: null,
            requests: a.requests + 1,
            tokens: a.tokens + prompt + usage.output_tokens,
            context: prompt + usage.output_tokens,
            usd: a.usd + (cost ?? 0),
            isPriced: a.isPriced && cost !== null,
          },
    ),
  )
}

const finish = async ($: EngineInterface, e: TurnCompleteInput, agentId: string, writeMultiplier: number) => {
  const at = await $.clock.now()
  await update($, agents, (list) =>
    list.map((a) => {
      if (a.id !== agentId) return a
      const ended: AgentRow = { ...a, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: at }
      if (a.requests > 0 || !e.usage) return ended
      const cost = costOf(e.usage.model || a.model, e.usage, writeMultiplier)
      return {
        ...ended,
        model: e.usage.model || a.model,
        tokens: promptTokens(e.usage) + e.usage.output_tokens,
        usd: cost ?? 0,
        isPriced: cost !== null,
      }
    }),
  )
  await update($, now, () => at)
}

export const register: Register = (on, options) => {
  const writeMultiplier = options.subagentCacheTtl === '1h' ? 2 : 1.25
  const autoOpen = options.autoOpen !== false
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($).catch(() => undefined))
    await $.command.register({
      name: 'deck',
      description: 'Show or hide the agents deck; `clear` drops finished agents',
      argumentHint: '[clear]',
      immediate: true,
    })
    return result
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, (list) => list.filter((a) => a.status === 'running'))
      return { text: 'Finished agents cleared.' }
    }
    return { text: (await togglePane($)) ? 'Deck opened.' : 'Deck closed.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    const at = await $.clock.now()
    const row: AgentRow = {
      id,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      workflow: e.workflow ? e.workflow.runId.slice(0, 8) : null,
      startedAt: at,
      endedAt: null,
      requests: 0,
      tokens: 0,
      context: 0,
      usd: 0,
      isPriced: true,
    }
    await update($, agents, (list) => [...list.filter((a) => a.id !== id), row].slice(-MAX_ROWS))
    await update($, now, () => at)
    if (autoOpen && !(await read($, autoOpened))) {
      await update($, autoOpened, () => true)
      await openPane($).catch(() => undefined)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const result = yield* next(e)
    if (result.usage) await recordStep($, e.agentId, result.usage, writeMultiplier).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) await finish($, e, e.agentId, writeMultiplier).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, agents, () => [])
      await update($, autoOpened, () => false)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const at = Math.max(await read($, now), ...list.map((a) => a.startedAt))

    const running = list.filter((a) => a.status === 'running').reverse()
    const finished = list.filter((a) => a.status !== 'running').reverse()
    const cost = list.reduce((s, a) => s + a.usd, 0)
    const total = list.reduce((s, a) => s + a.tokens, 0)
    const priced = list.every((a) => a.isPriced)
    const summary = `${running.length} running · ${finished.length} finished · ≈${usd(cost)}${priced ? '' : '+'} · ${tokens(total)} tokens`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Box key="summary" flexGrow={1}>
            <Text bold wrap="truncate-end">
              {summary}
            </Text>
          </Box>
          {finished.length > 0 ? (
            <Button
              key="clear"
              label="Clear finished"
              plain
              dimColor
              onPress={() => update($, agents, (l) => l.filter((a) => a.status === 'running'))}
            />
          ) : null}
        </Box>
        {list.length === 0 ? (
          <Box key="empty">
            <Text dimColor>No agents yet. Subagents and workflow agents show up here as they start.</Text>
          </Box>
        ) : null}
        {[...running, ...finished].map((a) => {
          const glyph = a.status === 'running' ? '●' : a.status === 'done' ? '✓' : '✗'
          const color = a.status === 'running' ? 'warning' : a.status === 'done' ? 'success' : 'error'
          const ctx = Math.min(100, Math.round((a.context / windowOf(a.model)) * 100))
          const where = a.workflow ? ` · workflow ${a.workflow}` : ''
          const detail = `${a.type}${where} · ${a.requests} req · ${tokens(a.tokens)} tok · ctx ${ctx}% · ≈${usd(a.usd)}${a.isPriced ? '' : '+'}`
          return (
            <Box key={a.id} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" columnGap={1}>
                <Text color={color}>{glyph}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold wrap="truncate-end">
                    {a.description || a.type}
                  </Text>
                </Box>
                <Text dimColor>{`${modelName(a.model)} · ${duration((a.endedAt ?? at) - a.startedAt)}`}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">{`  ${detail}`}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
