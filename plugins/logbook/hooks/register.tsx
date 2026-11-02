import type { EngineInterface, InstructionFile, PromptOrigin, Register, ToolCallResult } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Agent, Entry, Log, Turn } from '../types'
import { allSet, toggled } from './expanded'
import { drawPane } from './pane'
import { classify, clean, isSameSkill, type Source, safe, shortPath, skillName, skillSource, tokensOf } from './sources'
import { lineOf, plural, tokensText, topOf } from './summary'

const PANE = 'logbook'
const TITLE = 'Logbook'
const MAX_TURNS = 50
const MAX_ENTRIES = 200
const MAX_PENDING = 200
const MAX_AGENTS = 300
const MAX_FOREIGN = 200
const MAX_FILES = 200
const MAX_LISTED = 50
const MAX_DRAWN = 20
const MAX_TITLE = 60
const TITLE_WORDS = 8
const RESUMED = '(recording resumed)'
const PEOPLE: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'sdk', 'bridge'])
const USAGE = 'Usage: /logbook [on|off|pane|details|clear|help]. /logbook help explains each.'
const HELP = [
  '/logbook: status on one line.',
  '/logbook on | off: resume or stop recording and the per-turn line, for this session.',
  '/logbook pane: show or hide the timeline; press a group to list its sources, `expand all` to open a turn.',
  '/logbook details: the per-turn line lists every source instead of counts.',
  '/logbook clear: empty the log; the turn in progress keeps recording.',
].join('\n')

const NOTE =
  'The logbook records where context came from, turn by turn: skills, MCP calls, files read, web fetches and searches, subagents and what each used, shell programs and the instruction files. It keeps short labels, never a command line, query or result, and only in memory. Tokens are estimates, each result’s length / 4. It cannot see why the model chose a source, nor the reminders the engine adds by itself.'

const LOG = { plugin: 'logbook', key: 'log' } as const
const PENDING = { plugin: 'logbook', key: 'pending' } as const
const AGENTS = { plugin: 'logbook', key: 'agents' } as const
const RECORDED = { plugin: 'logbook', key: 'recorded' } as const
const INSTRUCTIONS = { plugin: 'logbook', key: 'instructions' } as const
const FOREIGN = { plugin: 'logbook', key: 'foreign' } as const
const EXPANDED = { plugin: 'logbook', key: 'expanded' } as const
const EMPTY_LOG: Log = { turns: [], open: null, last: 0, inTurn: false }

const log = atom(LOG, EMPTY_LOG)
const pending = atom(PENDING, [])
const agents = atom(AGENTS, {})
const recorded = atom(RECORDED, 0)
const instructions = atom(INSTRUCTIONS, {})
const foreign = atom(FOREIGN, [])
const isOff = atom({ plugin: 'logbook', key: 'isOff' } as const, false)
const isDetails = atom({ plugin: 'logbook', key: 'isDetails' } as const, false)
const expanded = atom(EXPANDED, {})

const slotId = (index: number): string => String(index % MAX_TURNS)

/** Where a source lands: a turn (null while none is open) and the loop that used it; `moved`, its agent to re-anchor there. */
type Place = { turn: number | null; agentId: string | null; moved?: Agent }

/** A Skill tool call in flight: the `skill.prompt` it causes adds its prompt's tokens to it. */
type SkillCall = { name: string; prompt: { label: string; detail: string; tokens: number } | null }

const isSpawn = (e: Entry): boolean => e.kind === 'agent'

const kept = (turn: Turn | null | undefined, index: number): turn is Turn => turn?.index === index

// The entry to drop past the bound: the oldest of the busiest subagent's own, then the main loop's oldest,
// spawn entries last. So a busy subagent never pushes out the conversation's own sources.
const victimOf = (list: readonly Entry[]): number => {
  const counts = new Map<string, number>()
  for (const e of list) if (e.agentId !== null && !isSpawn(e)) counts.set(e.agentId, (counts.get(e.agentId) ?? 0) + 1)
  let busiest: string | null = null
  for (const [id, n] of counts) if (busiest === null || n > (counts.get(busiest) ?? 0)) busiest = id
  if (busiest !== null) return list.findIndex((e) => e.agentId === busiest && !isSpawn(e))
  const main = list.findIndex((e) => !isSpawn(e))
  return main === -1 ? 0 : main
}

const trimmed = (list: Entry[], max: number): Entry[] => {
  let out = list
  while (out.length > max) out = out.toSpliced(victimOf(out), 1)
  return out
}

const withEntries = (turn: Turn, added: readonly Entry[]): Turn => {
  const all = [...turn.entries, ...added]
  const entries = trimmed(all, MAX_ENTRIES)
  return { ...turn, entries, dropped: turn.dropped + all.length - entries.length }
}

// Markup such as `<command-name>`: a tag's name and quoted attributes; `a < b and c > d` is text.
const TAG = /<\/?[A-Za-z][\w:-]*(?:\s+[\w:-]+="[^"]*")*\s*\/?>/g

const titleOf = (text: string): string => {
  const words = clean(text.slice(0, 2000).replace(TAG, ' '), 2000).split(' ').filter(Boolean)
  return safe(words.slice(0, TITLE_WORDS).join(' '), MAX_TITLE) || '(continued)'
}

const entryOf = (place: Place, source: Source, tokens: number, isFailed = false): Entry => ({
  kind: source.kind,
  label: source.label,
  detail: source.detail,
  agentId: place.agentId,
  tokens,
  isFailed,
  ref: null,
})

const spawnOf = (id: string, agent: Agent): Entry => ({
  kind: 'agent',
  label: agent.label,
  detail: agent.detail,
  agentId: agent.parent,
  tokens: 0,
  isFailed: false,
  ref: id,
})

// A subagent's sources go to the turn it was spawned in. One whose turn is gone (cleared, or past the bound)
// moves to the open turn, or the latest, as does one no spawn announced (an agent resumed from disk).
const turnOf = (l: Log, agent: Agent | undefined): number | null => {
  if (agent && (agent.turn === null ? l.open === null : l.turns.includes(agent.turn))) return agent.turn
  return l.open ?? l.turns.at(-1) ?? null
}

// `null`: an agent a plugin spawned, whose calls feed that plugin.
const placeOf = async ($: EngineInterface, agentId: string | undefined): Promise<Place | null> => {
  if (agentId === undefined) return { turn: (await read($, log)).open, agentId: null }
  const [l, known, others] = await Promise.all([read($, log), read($, agents), read($, foreign)])
  if (others.includes(agentId)) return null
  const agent = known[agentId]
  const turn = turnOf(l, agent)
  return { turn, agentId, moved: agent && turn !== null && turn !== agent.turn ? agent : undefined }
}

// A turn dropped past the bound, or cleared, takes nothing more and counts nothing.
const add = async ($: EngineInterface, index: number | null, entries: readonly Entry[]) => {
  if (entries.length === 0) return
  if (index === null) await update($, pending, (list) => trimmed([...list, ...entries], MAX_PENDING))
  else {
    let isKept = false
    await update($, { plugin: 'logbook', key: 'turn', id: slotId(index) }, (t) => {
      isKept = kept(t, index)
      return kept(t, index) ? withEntries(t, entries) : (t ?? null)
    })
    if (!isKept) return
  }
  await update($, recorded, (n) => n + entries.length)
}

// The agent continues in `index`, under its spawn entry there, which comes back if the clear took it.
const reanchor = async ($: EngineInterface, id: string, agent: Agent, index: number) => {
  let isAdded = false
  await Promise.all([
    update($, agents, (map) => {
      const found = map[id]
      return found ? { ...map, [id]: { ...found, turn: index } } : map
    }),
    update($, { plugin: 'logbook', key: 'turn', id: slotId(index) }, (t) => {
      isAdded = kept(t, index) && !t.entries.some((e) => e.ref === id)
      return kept(t, index) && isAdded ? withEntries(t, [spawnOf(id, agent)]) : (t ?? null)
    }),
  ])
  if (isAdded) await update($, recorded, (n) => n + 1)
}

const record = async ($: EngineInterface, place: Place, entries: readonly Entry[]) => {
  if (place.moved && place.agentId !== null && place.turn !== null)
    await reanchor($, place.agentId, place.moved, place.turn)
  await add($, place.turn, entries)
}

const readTurns = async ($: EngineInterface, indexes: readonly number[]): Promise<Turn[]> => {
  const found = await Promise.all(indexes.map((i) => read($, { plugin: 'logbook', key: 'turn', id: slotId(i) })))
  return found.filter((t, k): t is Turn => kept(t, indexes[k] ?? -1))
}

const isWaitingKey = (key: string): boolean => key === 'pending' || key.startsWith('pending-')

// Gives the next number to a new turn, which takes the sources waiting for one, and forgets what was
// expanded among them.
const openTurn = async ($: EngineInterface, title: string, at: number) => {
  const [l, waiting] = await Promise.all([
    update($, log, (x) => {
      const n = x.last + 1
      return { turns: [...x.turns.filter((t) => slotId(t) !== slotId(n)), n], open: n, last: n, inTurn: true }
    }),
    read($, pending),
  ])
  let taken: Entry[] = []
  if (waiting.length > 0) {
    await update($, pending, (list) => {
      taken = list
      return []
    })
    if (Object.keys(await read($, expanded)).some(isWaitingKey))
      await update($, expanded, (map) => allSet(map, 'pending', false))
  }
  await $.state.set(
    { plugin: 'logbook', key: 'turn', id: slotId(l.last) },
    withEntries({ index: l.last, title, startedAt: at, entries: [], dropped: 0 }, taken),
  )
}

// Ends the main loop's turn and, when asked, logs its line: a notice in the transcript, under the turn's
// reply, that the model never reads.
const close = async ($: EngineInterface, withLine: boolean) => {
  let index = null as number | null
  await update($, log, (l) => {
    index = l.open
    return { ...l, open: null, inTurn: false }
  })
  if (index === null || !withLine) return
  const [turn, off, details] = await Promise.all([
    read($, { plugin: 'logbook', key: 'turn', id: slotId(index) }),
    read($, isOff),
    read($, isDetails),
  ])
  if (!off && kept(turn, index)) $.ui.log(lineOf(turn.entries, details))
}

// `/logbook on` in a turn that started with the logbook off: that turn is recorded from here on.
const resume = async ($: EngineInterface) => {
  const l = await read($, log)
  if (l.inTurn && l.open === null) await openTurn($, RESUMED, await $.clock.now())
}

// Empties the log but for the open turn, which keeps recording; running agents keep who they are.
const clear = async ($: EngineInterface) => {
  const l = await read($, log)
  const open = l.open
  await Promise.all([
    update($, log, (x) => ({ ...x, turns: x.turns.filter((t) => t === x.open) })),
    ...l.turns
      .filter((t) => t !== open)
      .map((t) => $.state.set({ plugin: 'logbook', key: 'turn', id: slotId(t) }, null)),
    open === null
      ? undefined
      : update($, { plugin: 'logbook', key: 'turn', id: slotId(open) }, (t) =>
          kept(t, open) ? { ...t, entries: [], dropped: 0 } : (t ?? null),
        ),
    update($, pending, () => []),
    update($, recorded, () => 0),
    update($, expanded, () => ({})),
  ])
}

// Starts the log over with plain writes and no reads: every turn slot and every list.
const reset = ($: EngineInterface) =>
  Promise.all([
    $.state.set(LOG, EMPTY_LOG),
    $.state.set(PENDING, []),
    $.state.set(AGENTS, {}),
    $.state.set(RECORDED, 0),
    $.state.set(INSTRUCTIONS, {}),
    $.state.set(FOREIGN, []),
    $.state.set(EXPANDED, {}),
    ...Array.from({ length: MAX_TURNS }, (_, i) =>
      $.state.set({ plugin: 'logbook', key: 'turn', id: slotId(i) }, null),
    ),
  ])

// A subagent's first answer is what its spawner reads: its tokens go to the agent's own entry. A teammate's
// later wakes reach the conversation as messages, and a workflow's agents answer their script: not counted.
const credit = async ($: EngineInterface, id: string, answer: string) => {
  const [known, l] = await Promise.all([read($, agents), read($, log)])
  const agent = known[id]
  if (!agent?.isAwaited) return
  const index = turnOf(l, agent)
  if (index !== null && index !== agent.turn) await reanchor($, id, agent, index)
  await update($, agents, (map) => {
    const found = map[id]
    return found ? { ...map, [id]: { ...found, isAwaited: false } } : map
  })
  const tokens = tokensOf(answer)
  if (tokens === 0) return
  const holds = (list: readonly Entry[]) => list.some((e) => isSpawn(e) && e.ref === id)
  const credited = (list: readonly Entry[]) =>
    list.map((e) => (isSpawn(e) && e.ref === id ? { ...e, tokens: e.tokens + tokens } : e))
  if (index === null) {
    if (holds(await read($, pending))) await update($, pending, credited)
    return
  }
  const turn = await read($, { plugin: 'logbook', key: 'turn', id: slotId(index) })
  if (kept(turn, index) && holds(turn.entries))
    await update($, { plugin: 'logbook', key: 'turn', id: slotId(index) }, (t) =>
      kept(t, index) ? { ...t, entries: credited(t.entries) } : (t ?? null),
    )
}

const noteInstructions = async ($: EngineInterface, files: readonly InstructionFile[] | undefined) => {
  if (!files || files.length === 0) return
  const listed = files.slice(0, MAX_LISTED)
  const isFresh = (seen: Readonly<Record<string, number>>) => (f: InstructionFile) =>
    seen[clean(f.path, 300)] !== f.content.length
  if (!listed.some(isFresh(await read($, instructions)))) return
  let fresh: InstructionFile[] = []
  await update($, instructions, (seen) => {
    fresh = listed.filter(isFresh(seen))
    const sizes = new Map(Object.entries(seen))
    for (const f of fresh) {
      sizes.delete(clean(f.path, 300))
      sizes.set(clean(f.path, 300), f.content.length)
    }
    return Object.fromEntries([...sizes].slice(-MAX_FILES))
  })
  const place = await placeOf($, undefined)
  if (place === null) return
  await add(
    $,
    place.turn,
    fresh.map((f) => {
      const via = f.parent ? ` · via ${shortPath(f.parent)}` : ''
      const source: Source = {
        kind: 'instructions',
        label: shortPath(f.path) || 'instructions',
        detail: `${safe(f.kind, 20)}${via}`,
      }
      return entryOf(place, source, tokensOf(f.content))
    }),
  )
}

const paneState = async ($: EngineInterface): Promise<'open' | 'waiting' | 'closed'> => {
  const pane = (await $.ui.panes()).find((p) => p.id === PANE)
  return pane === undefined ? 'closed' : pane.isPlaced ? 'open' : 'waiting'
}

const togglePane = async ($: EngineInterface): Promise<string> => {
  if ((await paneState($)) === 'open') {
    await $.ui.close({ id: PANE })
    return 'Logbook pane closed.'
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  return opened.isPlaced ? 'Logbook pane opened.' : 'Logbook pane opened; it shows when there is room.'
}

// The command's text, which the model also reads: one short line; NOTE explains it in a notice.
const statusOf = async ($: EngineInterface, showLine: boolean): Promise<string> => {
  const [off, l, waiting, total, details] = await Promise.all([
    read($, isOff),
    read($, log),
    read($, pending),
    read($, recorded),
    read($, isDetails),
  ])
  const top = topOf([...(await readTurns($, l.turns)).flatMap((t) => t.entries), ...waiting])
  const line = showLine ? (details ? 'details' : 'counts') : 'off (option)'
  return [
    `Logbook ${off ? 'off for this session' : 'on'}`,
    `${plural(total, 'entry', 'entries')} this session`,
    top.length ? `top ${top.map(([k, n]) => `${k} ≈${tokensText(n)}`).join(', ')}` : 'no tokens counted yet',
    `per-turn line ${line}.`,
  ].join(' · ')
}

export const register: Register = (on, options) => {
  const showLine = options.summary !== false
  const skillCalls: SkillCall[] = []

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'logbook',
      description:
        'Where context came from, turn by turn; `on` and `off` for this session, `pane` the timeline, whose groups expand to list their sources, `details` lists every source on the per-turn line, `clear` empties it, `help` lists these',
      argumentHint: '[on|off|pane|details|clear|help]',
      immediate: true,
    })
    return result
  })

  on('command.run', { command: 'logbook' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isPerson = PEOPLE.has(e.origin.kind)
    if (arg === '') {
      $.ui.log(NOTE)
      return { text: await statusOf($, showLine) }
    }
    if (arg === 'help') return { text: HELP }
    if (arg === 'off') {
      if (!isPerson) return { text: 'Only a /logbook off the person types turns the logbook off. Nothing changed.' }
      await update($, isOff, () => true)
      return { text: 'Logbook off for this session: nothing is recorded and no per-turn line shows.' }
    }
    if (arg === 'on') {
      const wasOff = await read($, isOff)
      await update($, isOff, () => false)
      if (wasOff) await resume($)
      return {
        text: showLine ? 'Logbook on: recording and the per-turn line resume.' : 'Logbook on: recording resumes.',
      }
    }
    if (arg === 'pane') return { text: await togglePane($) }
    if (arg === 'details') {
      const shown = await update($, isDetails, (d) => !d)
      return {
        text: shown
          ? 'Details on: the per-turn line lists every source.'
          : 'Details off: the per-turn line counts sources.',
      }
    }
    if (arg === 'clear') {
      if (!isPerson) return { text: 'Only a /logbook clear the person types clears the log. Nothing changed.' }
      await clear($)
      return { text: 'Logbook cleared.' }
    }
    return { text: USAGE }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const [off, at] = await Promise.all([read($, isOff), $.clock.now()])
        if (off) await update($, log, (l) => ({ ...l, open: null, inTurn: true }))
        else await openTurn($, titleOf(e.text), at)
      } catch {}
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined) await close($, showLine)
      else if (!(await read($, isOff))) await credit($, e.agentId, e.answer)
    } catch {}
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const source = classify(String(e.tool), e as unknown as Record<string, unknown>)
    let place: Place | null = null
    if (source !== null) {
      try {
        const [off, where] = await Promise.all([read($, isOff), placeOf($, e.agentId)])
        place = off ? null : where
      } catch {}
    }
    if (source === null || place === null) return next(e)
    const call: SkillCall | null = source.kind === 'skill' ? { name: source.label, prompt: null } : null
    if (call) skillCalls.push(call)
    let result: ToolCallResult
    try {
      result = await next(e)
    } finally {
      if (call) skillCalls.splice(skillCalls.indexOf(call), 1)
    }
    if (result.deny !== undefined) return result
    try {
      const prompt = call?.prompt
      const tokens = tokensOf(result.text) + (prompt?.tokens ?? 0)
      const shown: Source = prompt ? { kind: 'skill', label: prompt.label, detail: prompt.detail } : source
      await record($, place, [entryOf(place, shown, tokens, result.isError === true)])
    } catch {}
    return result
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    try {
      if (next.origin.plugin !== 'engine' || (await read($, isOff))) return result
      const label = skillName(e.skill) || 'skill'
      const detail = skillSource(e.source, e.pluginName)
      const tokens = tokensOf(result.text)
      const call = skillCalls.findLast((c) => c.prompt === null && isSameSkill(c.name, label))
      if (call) {
        call.prompt = { label, detail, tokens }
        return result
      }
      const place = await placeOf($, undefined)
      if (place) await add($, place.turn, [entryOf(place, { kind: 'skill', label, detail }, tokens)])
    } catch {}
    return result
  }).catch(($, e, next) => next(e))

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    try {
      if (next.origin.plugin === 'engine' && !(await read($, isOff))) {
        await noteInstructions($, result.instructionFiles ?? e.instructionFiles)
      }
    } catch {}
    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    try {
      const parent = e.parentAgentId
      const [others, known, off] = await Promise.all([read($, foreign), read($, agents), read($, isOff)])
      if (next.origin.plugin !== 'engine' || (parent !== undefined && others.includes(parent))) {
        await update($, foreign, (list) => [...list.filter((x) => x !== id), id].slice(-MAX_FOREIGN))
        return started
      }
      if (off || known[id]) return started
      const place = await placeOf($, parent)
      if (place === null) return started
      const kinds = [safe(e.subagentType, 40), e.workflow ? 'workflow' : '', e.isTeammate ? 'teammate' : '']
      const agent: Agent = {
        turn: place.turn,
        label: safe(e.description, 60) || safe(e.subagentType, 60) || 'agent',
        detail: kinds.filter(Boolean).join(' · '),
        parent: parent ?? null,
        isAwaited: !e.workflow,
      }
      await update($, agents, (map) =>
        Object.fromEntries([...Object.entries(map).filter(([k]) => k !== id), [id, agent]].slice(-MAX_AGENTS)),
      )
      await record($, place, [spawnOf(id, agent)])
    } catch {}
    return started
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await reset($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [l, waiting, off, total, open] = await Promise.all([
      read($, log),
      read($, pending),
      read($, isOff),
      read($, recorded),
      read($, expanded),
    ])
    const turns = (await readTurns($, l.turns.slice(-MAX_DRAWN))).reverse()
    const view = {
      turns,
      kept: l.turns.length,
      hidden: Math.max(0, l.turns.length - MAX_DRAWN),
      waiting,
      total,
      isOff: off,
      isCard: e.surface !== 'terminal',
      expanded: open,
    }
    return drawPane($.ui.resolve(e), view, {
      toggle: (key, scope) => update($, expanded, (map) => toggled(map, key, scope)).catch(() => undefined),
      setAll: (scope, isAll) => update($, expanded, (map) => allSet(map, scope, isAll)).catch(() => undefined),
    })
  })
}
