import type { CoreEngineInterface, PromptOrigin, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { type ConfirmStyle, compile, decide, type Extra, judge } from './rules'

const FAILED = 'bulkhead could not check this command, so it was refused. Ask the user to run it.'
const PAUSED = '⚠ bulkhead paused for this session · /bulkhead resume'
const USAGE = 'Usage: /bulkhead [pause | resume]. With no argument it shows the guard.'
const PEOPLE: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'sdk', 'bridge'])

const paused = atom({ plugin: 'bulkhead', key: 'paused' } as const, '')

const isPaused = async ($: Pick<CoreEngineInterface, 'state' | 'session'>): Promise<boolean> => {
  const owner = await read($, paused)
  return owner !== '' && owner === (await $.session.id())
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const settings = (style: ConfirmStyle, extra: Extra): string[] => [
  style === 'ask'
    ? 'risky commands open the permission dialog (confirmStyle ask)'
    : 'risky commands are refused for a person to run (confirmStyle block)',
  ...(extra.block.length > 0 ? [`${extra.block.length} custom block rule(s)`] : []),
  ...(extra.confirm.length > 0 ? [`${extra.confirm.length} custom confirm rule(s)`] : []),
  ...(extra.disabled.size > 0 ? [`disabled: ${[...extra.disabled].join(', ')}`] : []),
]

export const register: Register = (on, options) => {
  const extra: Extra = {
    block: compile(text(options.extraBlock)),
    confirm: compile(text(options.extraConfirm)),
    disabled: new Set(
      text(options.disabledRules)
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  }
  const style: ConfirmStyle = options.confirmStyle === 'ask' ? 'ask' : 'block'
  const asked = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'bulkhead',
      description: 'Show the command guard; `pause` turns it off for this session, `resume` turns it back on',
      argumentHint: '[pause|resume]',
      immediate: true,
    })
    if (await isPaused($)) $.ui.status(PAUSED)
    return result
  })

  on('command.run', { command: 'bulkhead' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      const isOff = await isPaused($)
      $.ui.status(isOff ? PAUSED : undefined)
      const state = isOff
        ? 'bulkhead is PAUSED for this session: no command is checked. /bulkhead resume turns it back on.'
        : 'bulkhead is on.'
      return { text: [state, ...settings(style, extra)].join('\n') }
    }
    if (arg === 'pause') {
      if (!PEOPLE.has(e.origin.kind)) {
        return { text: 'Only a /bulkhead pause the person types can pause the guard. Nothing changed.' }
      }
      const id = await $.session.id()
      await update($, paused, () => id)
      $.ui.status(PAUSED)
      return {
        text: 'bulkhead paused for this session: commands run unchecked until /bulkhead resume or the session ends.',
      }
    }
    if (arg === 'resume') {
      await update($, paused, () => '')
      $.ui.status(undefined)
      return { text: 'bulkhead is on.' }
    }
    return { text: USAGE }
  })

  on('session.end', async ($, e, next) => {
    await update($, paused, () => '')
    $.ui.status(undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (await isPaused($)) return next(e)
    const root = await $.session.root()
    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) ?? '/root'
    const decision = decide(judge(e.command, cwd, root, home, extra), e.command, style)
    if (decision.kind === 'deny') return { deny: decision.reason }
    if (decision.kind === 'pass') return next(e)
    asked.set(e.tool_use_id, decision.reason)
    try {
      const result = await next(e)
      // Refused at the permission step: the engine's text invites other tools,
      // so say what bulkhead says in block style.
      return result.isError && /^Permission to use \S+ has been denied/.test(result.text ?? '')
        ? {
            deny: `${result.text}\n\nbulkhead: ${decision.reason.replace(/ Allow it\?$/, '')} Ask the user to run it in their own terminal. Do not rewrite the command to get around the rule.`,
          }
        : result
    } finally {
      asked.delete(e.tool_use_id)
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED }))

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const reason = e.tool_use_id === undefined ? undefined : asked.get(e.tool_use_id)
    if (reason === undefined) return next(e)
    const core = await next(e)
    return core.decision === 'deny' ? core : { decision: 'ask', reason }
  }).catch(() => ({ decision: 'deny', reason: FAILED }))
}
