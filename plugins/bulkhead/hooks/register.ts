import type { Register } from 'claude-code'

import { type ConfirmStyle, compile, decide, type Extra, judge } from './rules'

const FAILED = 'bulkhead could not check this command, so it was refused. Ask the user to run it.'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

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

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
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
