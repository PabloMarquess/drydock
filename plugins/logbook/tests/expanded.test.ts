import { describe, expect, test } from 'claude-code/testing'
import { allSet, isOpen, MAX_EXPANDED, toggled } from '../hooks/expanded'

describe('expanded', () => {
  test('a group is collapsed by default, follows its turn, and its own choice wins', () => {
    expect(isOpen({}, 't1-main-file', 't1')).toBe(false)
    expect(isOpen({ t1: true }, 't1-main-file', 't1')).toBe(true)
    expect(isOpen({ t1: true, 't1-main-file': false }, 't1-main-file', 't1')).toBe(false)
    expect(isOpen({ 't1-main-file': true }, 't1-main-file', 't1')).toBe(true)
  })

  test('a toggle flips the group and moves its choice to the newest end', () => {
    expect(toggled({}, 't1-main-file', 't1')).toEqual({ 't1-main-file': true })
    expect(toggled({ t1: true }, 't1-main-file', 't1')).toEqual({ t1: true, 't1-main-file': false })
    expect(Object.keys(toggled({ 't1-main-file': false, t2: true }, 't1-main-file', 't1'))).toEqual([
      't2',
      't1-main-file',
    ])
  })

  test('a group flipped back to how its turn draws it keeps no choice', () => {
    expect(toggled({ 't1-main-file': true, t2: true }, 't1-main-file', 't1')).toEqual({ t2: true })
    expect(toggled({ t1: true, 't1-main-file': false }, 't1-main-file', 't1')).toEqual({ t1: true })
    let map = {}
    for (let i = 0; i < 4; i++) map = toggled(map, 't1-a:main-shell', 't1')
    expect(map).toEqual({})
  })

  test('past the bound the oldest choice goes', () => {
    let map = {}
    for (let i = 0; i < MAX_EXPANDED + 5; i++) map = toggled(map, `t${i}-main-file`, `t${i}`)
    expect(Object.keys(map)).toHaveLength(MAX_EXPANDED)
    expect(isOpen(map, 't4-main-file', 't4')).toBe(false)
    expect(isOpen(map, 't5-main-file', 't5')).toBe(true)
  })

  test("expand all and collapse all set a turn and drop its groups' own choices, never another turn's", () => {
    const map = { 't1-main-file': false, 't1-a1-shell': true, 't10-main-file': true, t2: true }
    expect(allSet(map, 't1', true)).toEqual({ 't10-main-file': true, t2: true, t1: true })
    expect(allSet({ ...map, t1: true }, 't1', false)).toEqual({ 't10-main-file': true, t2: true })
  })
})
