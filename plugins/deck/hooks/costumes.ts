import type { Costume, Wardrobe } from '../types'
import { costumeOf } from './art'

const NAMES: Readonly<Record<string, Costume>> = {
  astronaut: 'fable',
  detective: 'heavy',
  engineer: 'careful',
  chef: 'medium',
  racer: 'light',
  pirate: 'explore',
  crab: 'other',
}

export const COSTUME_NAMES = ['astronaut', 'detective', 'engineer', 'chef', 'racer', 'pirate', 'crab'] as const

const TITLE: Readonly<Record<Costume, string>> = {
  fable: 'astronaut',
  heavy: 'detective',
  careful: 'engineer',
  medium: 'chef',
  light: 'racer',
  explore: 'pirate',
  other: 'crab',
}

export const TARGETS = ['all', 'explore', 'plan', 'fable', 'opus', 'sonnet', 'haiku', 'kiro'] as const

export const costumeNamed = (word: string): Costume | undefined => NAMES[word.toLowerCase()]

const isTarget = (word: string): boolean => (TARGETS as readonly string[]).includes(word)

/**
 * `astronaut` dresses every agent; `opus astronaut` or `opus=astronaut` dresses one target.
 * A list joins pairs with commas. Unknown words are left out.
 */
export const parseWardrobe = (text: unknown): Wardrobe => {
  const out: Wardrobe = {}
  if (typeof text !== 'string') return out
  for (const part of text.split(',')) {
    const words = part
      .trim()
      .toLowerCase()
      .split(/[\s=]+/)
      .filter(Boolean)
    const [first = '', second = ''] = words
    if (words.length === 1) {
      const c = costumeNamed(first)
      if (c) out.all = c
    } else if (words.length === 2 && isTarget(first)) {
      const c = costumeNamed(second)
      if (c) out[first] = c
    }
  }
  return out
}

const familyOf = (model: string): string | undefined =>
  /fable|mythos/i.test(model)
    ? 'fable'
    : /opus/i.test(model)
      ? 'opus'
      : /sonnet/i.test(model)
        ? 'sonnet'
        : /haiku/i.test(model)
          ? 'haiku'
          : undefined

const kindOf = (type: string): string | undefined =>
  type === 'Explore' ? 'explore' : type === 'Plan' ? 'plan' : type === 'Kiro' ? 'kiro' : undefined

/** What one wardrobe puts on an agent: its type's target, then its model family's, then `all`. */
export const chosen = (wardrobe: Wardrobe, type: string, model: string): Costume | undefined => {
  const kind = kindOf(type)
  const family = familyOf(model)
  return (kind && wardrobe[kind]) || (family && wardrobe[family]) || wardrobe.all || undefined
}

// Every costume, in a fixed order: a random draw indexes it.
const DRAW: readonly Costume[] = ['fable', 'heavy', 'careful', 'medium', 'light', 'explore', 'other']

// FNV-1a over UTF-16 code units: the same id draws the same costume on every redraw and reload.
const hash = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** The costume an agent draws when costumes are random: one of the seven, fixed by its id. */
export const randomCostume = (id: string): Costume => DRAW[hash(id) % DRAW.length] ?? 'other'

/** The session's choices, the `costumes` option's, and whether the rest draw a random costume. */
export type Dress = { session: Wardrobe; option: Wardrobe; isRandom: boolean }

/** The session's choice wins, then the option's, then a random draw when on, then the type and model rule. */
export const wear = (dress: Dress, id: string, type: string, model: string): Costume =>
  chosen(dress.session, type, model) ??
  chosen(dress.option, type, model) ??
  (dress.isRandom ? randomCostume(id) : costumeOf(type, model))

const pairsOf = (wardrobe: Wardrobe, shadow: Wardrobe = {}): string[] =>
  shadow.all ? [] : TARGETS.filter((t) => wardrobe[t] && !shadow[t]).map((t) => `${t} ${TITLE[wardrobe[t] as Costume]}`)

/** The session's choices, then the option's it leaves standing, then what the rest wear. */
export const describeDress = (dress: Dress): string => {
  const pairs = [...pairsOf(dress.session), ...pairsOf(dress.option, dress.session)]
  if (dress.session.all || dress.option.all) return pairs.join(', ')
  if (dress.isRandom)
    return pairs.length ? `${pairs.join(', ')}, a random costume for the rest` : 'a random costume per agent'
  return pairs.length ? pairs.join(', ') : 'the default (by type, then model)'
}
