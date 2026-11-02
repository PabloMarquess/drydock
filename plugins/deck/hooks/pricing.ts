import type { ModelUsage } from 'claude-code'

type Price = { input: number; output: number; cacheRead: number }

// Anthropic list prices, USD per million tokens, October 2026.
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
]

const HAIKU_LONG: Price = { input: 0.5, output: 2.5, cacheRead: 0.05 }
const HAIKU_LONG_PROMPT = 100_000

export const promptTokens = (u: ModelUsage): number =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export const priceOf = (model: string, prompt: number): Price | null => {
  const id = model.toLowerCase()
  if (/haiku-5-5/.test(id) && prompt > HAIKU_LONG_PROMPT) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? null
}

export const costOf = (model: string, u: ModelUsage, writeMultiplier: number): number | null => {
  const p = priceOf(model, promptTokens(u))
  if (p === null) return null
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cacheRead +
      u.cache_creation_input_tokens * p.input * writeMultiplier) /
    1e6
  )
}

export const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

export const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  // An unknown id shows its last path segment: an inference profile ARN would leave no room on the row.
  if (!m) return (id.split('/').pop() ?? '').replace(/^claude-/, '') || '-'
  const [, family = '', major = '', minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}`
}
