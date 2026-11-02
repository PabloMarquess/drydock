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

export const TARGETS = ['all', 'explore', 'plan', 'fable', 'opus', 'sonnet', 'haiku'] as const

export const costumeNamed = (word: string): Costume | undefined => NAMES[word.toLowerCase()]

export const costumeTitle = (c: Costume): string => TITLE[c]

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

/** The agent's type wins over its model, a named target over `all`, and the built-in rule comes last. */
export const wear = (wardrobe: Wardrobe, type: string, model: string): Costume => {
  const kind = type === 'Explore' ? 'explore' : type === 'Plan' ? 'plan' : undefined
  const family = familyOf(model)
  return (kind && wardrobe[kind]) || (family && wardrobe[family]) || wardrobe.all || costumeOf(type, model)
}

export const describeWardrobe = (wardrobe: Wardrobe): string => {
  const pairs = TARGETS.filter((t) => wardrobe[t]).map((t) => `${t} ${TITLE[wardrobe[t] as Costume]}`)
  return pairs.length ? pairs.join(', ') : 'the default (by type, then model)'
}
