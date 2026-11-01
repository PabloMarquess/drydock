import type { ModelUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { costOf, modelName, priceOf, windowOf } from '../hooks/pricing'

const usage = (input: number, output: number, read: number, write: number): ModelUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

describe('pricing', () => {
  test('Opus 5.5 with 5m cache writes', () => {
    expect(Math.round((costOf('claude-opus-5-5', usage(1_000, 2_000, 10_000, 1_000), 1.25) ?? 0) * 1e6)).toBe(51_000)
  })

  test('1h cache writes cost twice the input price', () => {
    expect(costOf('claude-sonnet-5-5', usage(0, 0, 0, 1_000_000), 2)).toBe(4)
  })

  test('each family resolves to its own price', () => {
    expect(priceOf('claude-fable-5-1', 0)).toEqual({ input: 10, output: 50, cacheRead: 0.25 })
    expect(priceOf('claude-fable-5', 0)).toEqual({ input: 10, output: 50, cacheRead: 1 })
    expect(priceOf('claude-opus-5', 0)).toEqual({ input: 5, output: 25, cacheRead: 0.5 })
    expect(priceOf('claude-opus-4-8', 0)).toEqual({ input: 5, output: 25, cacheRead: 0.5 })
    expect(priceOf('claude-sonnet-5', 0)).toEqual({ input: 2, output: 10, cacheRead: 0.2 })
    expect(priceOf('claude-sonnet-4-6', 0)).toEqual({ input: 3, output: 15, cacheRead: 0.3 })
    expect(priceOf('claude-haiku-4-5', 0)).toEqual({ input: 1, output: 5, cacheRead: 0.1 })
  })

  test('Haiku 5.5 switches price above 100k prompt tokens', () => {
    expect(priceOf('claude-haiku-5-5', 100_000)?.input).toBe(0.1)
    expect(priceOf('claude-haiku-5-5', 100_001)?.input).toBe(0.5)
  })

  test('unknown models are not priced', () => {
    expect(costOf('gpt-x', usage(1, 1, 1, 1), 1.25)).toBeNull()
  })

  test('names and windows', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(windowOf('claude-haiku-4-5')).toBe(200_000)
    expect(windowOf('claude-opus-5-5')).toBe(1_000_000)
  })
})
