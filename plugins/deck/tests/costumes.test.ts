import { describe, expect, test } from 'claude-code/testing'

import { type Dress, describeDress, parseWardrobe, randomCostume, wear } from '../hooks/costumes'

const dress = (over: Partial<Dress> = {}): Dress => ({ session: {}, option: {}, isRandom: true, ...over })

describe('costumes', () => {
  test('a random costume is fixed by the agent id, and the seven all come up', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `a${i.toString(16).padStart(16, '0')}`)
    for (const id of ids) expect(randomCostume(id)).toBe(randomCostume(id))
    expect(new Set(ids.map(randomCostume)).size).toBe(7)
    expect(randomCostume('kiro-toolu_01')).toBe(randomCostume('kiro-toolu_01'))
  })

  test('the session wins, then the option, then a random draw, then the type and model rule', () => {
    const id = 'a0000000000000007'
    const drawn = randomCostume(id)
    expect(wear(dress(), id, 'general-purpose', 'claude-opus-5-5')).toBe(drawn)
    expect(wear(dress({ isRandom: false }), id, 'general-purpose', 'claude-opus-5-5')).toBe('heavy')
    expect(wear(dress({ isRandom: false }), id, 'Explore', 'claude-opus-5-5')).toBe('explore')
    expect(wear(dress({ isRandom: false }), id, 'Kiro', 'claude-opus-5.5')).toBe('other')
    const option = parseWardrobe('opus=racer')
    expect(wear(dress({ option }), id, 'general-purpose', 'claude-opus-5-5')).toBe('light')
    expect(wear(dress({ option }), id, 'general-purpose', 'claude-sonnet-5-5')).toBe(randomCostume(id))
    const session = parseWardrobe('astronaut')
    expect(wear(dress({ option, session }), id, 'general-purpose', 'claude-opus-5-5')).toBe('fable')
    expect(wear(dress({ session: parseWardrobe('kiro chef') }), id, 'Kiro', 'claude-opus-5.5')).toBe('medium')
    expect(wear(dress({ session: parseWardrobe('opus pirate') }), id, 'Kiro', 'claude-opus-5.5')).toBe('explore')
  })

  test('what the costume status says is worn', () => {
    expect(describeDress(dress())).toBe('a random costume per agent')
    expect(describeDress(dress({ isRandom: false }))).toBe('the default (by type, then model)')
    expect(describeDress(dress({ option: parseWardrobe('opus=racer') }))).toBe(
      'opus racer, a random costume for the rest',
    )
    expect(describeDress(dress({ option: parseWardrobe('opus=racer'), isRandom: false }))).toBe('opus racer')
    expect(
      describeDress(dress({ session: parseWardrobe('plan pirate'), option: parseWardrobe('plan=chef, kiro=racer') })),
    ).toBe('plan pirate, kiro racer, a random costume for the rest')
    expect(describeDress(dress({ session: parseWardrobe('astronaut'), option: parseWardrobe('opus=racer') }))).toBe(
      'all astronaut',
    )
  })
})
