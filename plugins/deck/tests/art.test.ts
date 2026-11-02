import { describe, expect, test } from 'claude-code/testing'

import {
  agentSvg,
  bandSvg,
  barText,
  type Costume,
  CRAB_CSS,
  costumeOf,
  crab,
  ctxBar,
  FAILED,
  FIGURE_GLYPH,
  fit,
  GHOST_CSS,
  gridSvg,
  gridTiles,
  hasOwnColour,
  headerSvg,
  KIRO,
  MARK,
  markColorOf,
  PANE_CSS,
  type RowArt,
  rowHeight,
  STATUS_GLYPH,
  SUB,
  SUB_CSS,
  statusMark,
  sub,
  TIER_COLOR,
  TILE,
  textWidth,
  WARN,
  xml,
} from '../hooks/art'

// The pane behind the rows is the host's: white, or near-black in the dark theme. The tiles are the deck's.
const PANE_BG = { light: '#ffffff', dark: '#1f1e1d' }

const tiles = (svg: string): [string, string, string][] =>
  [...svg.matchAll(/<text class="s"[^>]*>([^<]*)<\/text>\n<text class="(\w)"[^>]*>([^<]*)<\/text>/g)].map((m) => [
    m[1] ?? '',
    m[2] ?? '',
    m[3] ?? '',
  ])

// FNV-1a over UTF-16 code units: enough to notice any change to a drawing.
const hash = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// The drawings ported from claude-kit savvy-progress (c871c15), as they draw there: a pixel, a colour,
// a keyframe or a timing that drifts fails here. PANE_CSS differs from the source in one place on
// purpose, the live dot's period (1s, not 1.6s).
const GOLDEN: Record<string, string> = {
  'crab fable still': 'f28d9c2f',
  'crab fable walking': 'b625b898',
  'crab fable dimmed': 'e53a019b',
  'crab heavy still': '9886311a',
  'crab heavy walking': 'eedb0ef5',
  'crab heavy dimmed': '333dcdfe',
  'crab careful still': '99576889',
  'crab careful walking': '17f8e19e',
  'crab careful dimmed': '66857edd',
  'crab medium still': '8f2c28ca',
  'crab medium walking': '07d4eacd',
  'crab medium dimmed': 'c8addb6e',
  'crab light still': '9b83b8ba',
  'crab light walking': '22978edb',
  'crab light dimmed': '76efafbe',
  'crab explore still': '3d8a4f1d',
  'crab explore walking': '3c7ad3b6',
  'crab explore dimmed': '7454efe1',
  'crab other still': 'f7ea9095',
  'crab other walking': 'c6e0c35a',
  'crab other dimmed': '45615219',
  'band crab still': '7730fdeb',
  'band crab walking': 'd889b1e0',
  'band 600 2/4': 'e15bed8e',
  'band 600 5/5': '0c2dab18',
  'band 864 2/5': 'd56df82b',
  CRAB_CSS: '2ad845f7',
  PANE_CSS: 'e7fd1abb',
}

// Kiro's ghost in every costume, and the background task's submarine: our own drawings, held here so a
// change to them is a choice.
const GHOST_GOLDEN: Record<string, string> = {
  'ghost fable still': '2fc0c8f0',
  'ghost fable floating': '9235ba95',
  'ghost fable dimmed': 'beeecfa4',
  'ghost heavy still': '55b1a6bb',
  'ghost heavy floating': 'd52a4426',
  'ghost heavy dimmed': '69edd767',
  'ghost careful still': 'ed299fea',
  'ghost careful floating': '20a5de73',
  'ghost careful dimmed': 'c6a50626',
  'ghost medium still': '4cce83ef',
  'ghost medium floating': '2b192faa',
  'ghost medium dimmed': 'f018695b',
  'ghost light still': 'e58f5ee9',
  'ghost light floating': '964cd47a',
  'ghost light dimmed': 'a5647765',
  'ghost explore still': '5406182e',
  'ghost explore floating': '31fc4deb',
  'ghost explore dimmed': 'aa0839ea',
  'ghost other still': '429a18a6',
  'ghost other floating': 'a3de277f',
  'ghost other dimmed': '725872b2',
  'sub still': '6f36a3ef',
  'sub running': 'd23db086',
  'sub dimmed': '9fd6dfbb',
  GHOST_CSS: 'cf691239',
  SUB_CSS: 'c51f06a3',
}

const COSTUMES = ['fable', 'heavy', 'careful', 'medium', 'light', 'explore', 'other'] as const

const ownDrawings = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const c of COSTUMES) {
    out[`ghost ${c} still`] = crab(0, 6, c, false, false, 1.1, 'ghost')
    out[`ghost ${c} floating`] = crab(0, 6, c, false, true, 1.1, 'ghost')
    out[`ghost ${c} dimmed`] = crab(0, 6, c, true, false, 1.1, 'ghost')
  }
  out['sub still'] = sub(0, 6)
  out['sub running'] = sub(0, 6, false, true)
  out['sub dimmed'] = sub(0, 6, true)
  out.GHOST_CSS = GHOST_CSS
  out.SUB_CSS = SUB_CSS
  return out
}

// The cells a drawing fills, by its rects' fill: `x,y` on the 30×28 grid.
const cells = (drawn: string, fill?: string): Set<string> => {
  const out = new Set<string>()
  for (const m of drawn.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="([^"]+)"/g)) {
    if (fill !== undefined && m[5] !== fill) continue
    const [x, y, w, h] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number]
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) out.add(`${x + i},${y + j}`)
  }
  return out
}

const drawings = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const c of ['fable', 'heavy', 'careful', 'medium', 'light', 'explore', 'other']) {
    out[`crab ${c} still`] = crab(0, 6, c)
    out[`crab ${c} walking`] = crab(0, 6, c, false, true)
    out[`crab ${c} dimmed`] = crab(0, 6, c, true)
  }
  out['band crab still'] = crab(0, 0, 'other', false, false, 0.8)
  out['band crab walking'] = crab(0, 0, 'other', false, true, 0.8)
  out['band 600 2/4'] = bandSvg(600, { total: 4, finished: 2, running: 2 })
  out['band 600 5/5'] = bandSvg(600, { total: 5, finished: 5, running: 0 })
  out['band 864 2/5'] = bandSvg(864, { total: 5, finished: 2, running: 3 })
  out.CRAB_CSS = CRAB_CSS
  out.PANE_CSS = PANE_CSS
  return out
}

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r = 0, g = 0, b = 0] = [16, 8, 0].map((shift) => {
    const c = ((n >> shift) & 255) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

const row = (over: Partial<RowArt> = {}): RowArt => ({
  title: 'scan',
  costume: 'heavy',
  status: 'running',
  model: 'Opus 5.5',
  meta: ' · 1:05 · ≈$0.05',
  warning: '',
  details: [],
  ...over,
})

describe('art', () => {
  test('the ported drawings match claude-kit exactly', () => {
    const got = Object.fromEntries(Object.entries(drawings()).map(([k, v]) => [k, hash(v)]))
    expect(got).toEqual(GOLDEN)
  })

  test('our own ghost and submarine draw as recorded, and the crabs did not move a pixel for them', () => {
    const got = Object.fromEntries(Object.entries(ownDrawings()).map(([k, v]) => [k, hash(v)]))
    expect(got).toEqual(GHOST_GOLDEN)
    expect(crab(0, 6, 'heavy', false, true, 1.1, 'crab')).toBe(crab(0, 6, 'heavy', false, true))
  })

  test("the ghost stands on the crab's footprint: body x7-22 y10-25, nubs where the claws are, no legs", () => {
    const body = cells(crab(0, 0, 'other', false, false, 1.1, 'ghost'), KIRO.body)
    const shade = cells(crab(0, 0, 'other', false, false, 1.1, 'ghost'), KIRO.shade)
    const all = new Set([...body, ...shade])
    for (let x = 7; x <= 22; x++) for (let y = 10; y <= 23; y++) expect(all.has(`${x},${y}`), `${x},${y}`).toBe(true)
    for (const c of ['3,15', '6,14', '23,15', '26,16']) expect(all.has(c), c).toBe(true)
    const xs = [...all].map((c) => Number(c.split(',')[0]))
    const ys = [...all].map((c) => Number(c.split(',')[1]))
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3, 26, 8, 25])
    // Three hem lobes with gaps between them at the bottom.
    expect(['11,24', '12,24', '17,24', '18,24'].some((c) => all.has(c))).toBe(false)
    const ghost = crab(0, 0, 'other', false, true, 1.1, 'ghost')
    expect(ghost).toContain('<g class="c-other ghost run">')
    expect(ghost).toContain('<g class="la"></g><g class="lb"></g>')
    expect(cells(ghost, '#1F1E1D').size).toBe(8)
  })

  test("every costume's hat and prop draw on the ghost as on the crab, only the body differs", () => {
    for (const c of COSTUMES) {
      const onCrab = crab(0, 0, c).replace(/<rect[^>]*fill="#D97757"[^>]*\/>|<rect[^>]*fill="#1F1E1D"[^>]*\/>/g, '')
      const onGhost = crab(0, 0, c, false, false, 1.1, 'ghost').replace(
        /<rect[^>]*fill="(#8B5CF6|#7C3AED|#1F1E1D)"[^>]*\/>/g,
        '',
      )
      const props = (s: string) => [...s.matchAll(/<rect[^>]*\/>/g)].map((m) => m[0]).sort()
      const kept = (s: string) => props(s).filter((r) => !/fill="#1F1E1D"/.test(r))
      expect(kept(onGhost), c).toEqual(kept(onCrab))
    }
  })

  test('the ghost floats while it runs, never walks, and stops under reduced motion', () => {
    expect(GHOST_CSS).toContain('.ghost.run{animation:drift 1s ease-in-out infinite}')
    expect(GHOST_CSS).toContain('.ghost.run .bd{animation:none}')
    expect(CRAB_CSS).toContain('@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}')
  })

  test('the submarine: hull, portholes, tower and periscope, a propeller of two frames and three bubbles', () => {
    const still = sub(0, 0)
    const running = sub(0, 0, false, true)
    expect(still).toContain('<g class="sub">')
    expect(running).toContain('<g class="sub run">')
    expect(sub(0, 0, true)).toContain('opacity="0.45"')
    expect(cells(still, SUB.port).size).toBe(13)
    expect(cells(still, SUB.brass).size).toBe(14)
    expect(running).toContain('<g class="pa">')
    expect(running).toContain('<g class="pb">')
    expect(running.match(/<g class="bub b\d">/g)).toHaveLength(3)
    const all = cells(still)
    const xs = [...all].map((c) => Number(c.split(',')[0]))
    const ys = [...all].map((c) => Number(c.split(',')[1]))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThan(30)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThan(28)
    expect(SUB_CSS).toContain('.sub .pb,.sub .bub{opacity:0}')
    expect(SUB_CSS).toContain('.sub.run .pa{animation:pa .25s steps(1) infinite}')
    expect(SUB_CSS).toContain('.sub.run .bub{animation:rise 1s steps(1) infinite}')
    expect(SUB_CSS).toContain('@media (prefers-reduced-motion: reduce)')
  })

  test('a Kiro row with no costume colour takes the purple, a task the teal; the terminal marks differ', () => {
    expect(hasOwnColour('other')).toBe(false)
    expect(hasOwnColour('explore')).toBe(false)
    expect(hasOwnColour('heavy')).toBe(true)
    expect(markColorOf('other', 'ghost')).toBe(KIRO.body)
    expect(markColorOf('explore', 'ghost')).toBe(KIRO.body)
    expect(markColorOf('heavy', 'ghost')).toBe(TIER_COLOR.heavy)
    expect(markColorOf('other', 'crab')).toBe('#888780')
    expect(markColorOf('fable', 'sub')).toBe(SUB.hull)
    expect(FIGURE_GLYPH).toEqual({ crab: '▣', ghost: '▣', sub: '◒' })
    expect(STATUS_GLYPH).toEqual({ running: '●', done: '✓', failed: '✗', unknown: '○' })
    const kiro = agentSvg(320, row({ costume: 'other', species: 'ghost', model: 'Kiro · claude-opus-5.5' }))
    expect(kiro).toContain('<tspan class="kv">Kiro · claude-opus-5.5</tspan>')
    expect(kiro).toContain(`.kv{fill:${KIRO.light}}@media (prefers-color-scheme: dark){.kv{fill:${KIRO.dark}}}`)
    expect(kiro).toContain(`<circle class="live" cx="312" cy="16" r="3.5" fill="${KIRO.body}"/>`)
    expect(kiro).toContain('<g class="c-other ghost run">')
    const dressed = agentSvg(320, row({ costume: 'heavy', species: 'ghost', model: 'Kiro' }))
    expect(dressed).toContain(`<tspan fill="${TIER_COLOR.heavy}">Kiro</tspan>`)
    expect(dressed).not.toContain('.kv{')
    const task = agentSvg(320, row({ costume: 'fable', species: 'sub', model: 'Bash' }))
    expect(task).toContain('<tspan class="tv">Bash</tspan>')
    expect(task).toContain('<g class="sub run">')
    expect(task).not.toContain('class="c-fable')
    const crabRow = agentSvg(320, row())
    expect(crabRow).not.toContain('ghost')
    expect(crabRow).not.toContain('.sub')
  })

  test('the Kiro and task names read at 4.5:1 or better on a light and on a dark pane', () => {
    for (const color of [KIRO.light, SUB.light]) {
      expect(contrast(color, PANE_BG.light), color).toBeGreaterThan(4.5)
      expect(contrast(color, TILE.light), color).toBeGreaterThan(4.5)
    }
    for (const color of [KIRO.dark, SUB.dark]) {
      expect(contrast(color, PANE_BG.dark), color).toBeGreaterThan(4.5)
      expect(contrast(color, TILE.dark), color).toBeGreaterThan(4.5)
    }
    // The names a row draws are exactly these, in the classes the row's CSS sets per theme.
    const kiro = agentSvg(320, row({ costume: 'other', species: 'ghost', model: 'Kiro' }))
    expect(kiro).toContain(`.kv{fill:${KIRO.light}}@media (prefers-color-scheme: dark){.kv{fill:${KIRO.dark}}}`)
    const task = agentSvg(320, row({ species: 'sub', model: 'Bash' }))
    expect(task).toContain(`.tv{fill:${SUB.light}}@media (prefers-color-scheme: dark){.tv{fill:${SUB.dark}}}`)
  })

  test('the marks (live dot, terminal mark, check, cross, ring) read at 3:1 or better on a light and on a dark pane', () => {
    const marks = [KIRO.body, SUB.hull, MARK.done, MARK.failed, MARK.unknown]
    for (const color of marks) {
      expect(contrast(color, PANE_BG.light), color).toBeGreaterThan(3)
      expect(contrast(color, PANE_BG.dark), color).toBeGreaterThan(3)
    }
    expect(statusMark(10, 16, 'done', KIRO.body)).toContain(`stroke="${MARK.done}"`)
    expect(statusMark(10, 16, 'failed', KIRO.body)).toContain(`stroke="${MARK.failed}"`)
    expect(statusMark(10, 16, 'unknown', KIRO.body)).toContain(`stroke="${MARK.unknown}"`)
    expect(statusMark(10, 16, 'running', SUB.hull)).toContain(`fill="${SUB.hull}"`)
    expect(markColorOf('other', 'ghost')).toBe(KIRO.body)
    expect(markColorOf('other', 'sub')).toBe(SUB.hull)
  })

  test('the grid is stacked from tiles of at most 4096px, its dots aligned', () => {
    expect(gridTiles(68)).toEqual([68])
    expect(gridTiles(10_000)).toEqual([4096, 4096, 1808])
    const grid = gridSvg(400, 160)
    expect(grid).toContain('height="160" viewBox="0 0 400 160"')
    expect(grid).toContain('<circle class="d" cx="8" cy="8" r="1"/>')
    expect(grid).toContain('.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}')
  })

  test('the live dot pulses in step with the once-a-second redraw', () => {
    expect(PANE_CSS).toContain('.live{animation:p 1s ease-in-out infinite}')
  })

  test('a long model id is cut before the time and cost', () => {
    const model = 'some-third-party-model-with-a-very-long-id-'.repeat(3)
    for (const W of [240, 312, 900]) {
      const source = agentSvg(W, row({ costume: 'other', model }))
      expect(source, String(W)).toContain(
        '<tspan class="s" font-variant-numeric="tabular-nums"> · 1:05 · ≈$0.05</tspan>',
      )
      expect(source, String(W)).toMatch(/…<\/tspan><tspan class="s"/)
    }
    expect(agentSvg(312, row())).toContain(
      '>Opus 5.5</tspan><tspan class="s" font-variant-numeric="tabular-nums"> · 1:05 · ≈$0.05</tspan>',
    )
    expect(agentSvg(100, row({ model }))).not.toContain('>…</tspan>')
  })

  test('fit keeps a short title and cuts a long one with an ellipsis', () => {
    expect(fit('scan', 200, 13)).toBe('scan')
    const cut = fit('x'.repeat(300), 200, 13)
    expect(cut.endsWith('…')).toBe(true)
    expect(textWidth(cut, 13)).toBeLessThan(201)
    expect(textWidth(`${cut.slice(0, -1)}x…`, 13)).toBeGreaterThan(200)
  })

  test('fit stays linear on a very long title', () => {
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) fit('long title '.repeat(1_000), 624, 13)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  test('CJK and emoji count as one em', () => {
    expect(textWidth('漢'.repeat(38), 13)).toBe(494)
    expect(textWidth('한글', 10)).toBe(20)
    expect(textWidth('🚀', 10)).toBe(10)
    expect(textWidth(fit('漢'.repeat(60), 624, 13), 13)).toBeLessThan(625)
  })

  test('xml escapes the four characters that break markup', () => {
    expect(xml('<a href="x">R&D</a>')).toBe('&lt;a href=&quot;x&quot;&gt;R&amp;D&lt;/a&gt;')
  })

  test('costume by agent type, then by model', () => {
    const cases: [string, string, Costume][] = [
      ['Explore', 'claude-opus-5-5', 'explore'],
      ['Plan', 'claude-haiku-5-5', 'careful'],
      ['general-purpose', 'claude-fable-5', 'fable'],
      ['general-purpose', 'claude-mythos-5-1', 'fable'],
      ['general-purpose', 'claude-opus-5-5', 'heavy'],
      ['general-purpose', 'claude-sonnet-5-5', 'medium'],
      ['general-purpose', 'claude-haiku-4-5', 'light'],
      ['general-purpose', 'haiku', 'light'],
      ['general-purpose', 'gpt-x', 'other'],
      ['explore', 'claude-opus-5-5', 'heavy'],
      ['Kiro', 'claude-opus-5.5', 'other'],
    ]
    for (const [type, model, costume] of cases) expect(costumeOf(type, model), `${type} ${model}`).toBe(costume)
  })

  test('a crab walks only when asked and dims when asked', () => {
    expect(crab(0, 6, 'heavy', false, true)).toContain('<g class="c-heavy run">')
    expect(crab(0, 6, 'heavy')).toContain('<g class="c-heavy">')
    expect(crab(0, 6, 'heavy', true)).toContain('opacity="0.45"')
    expect(crab(0, 6, 'heavy')).toContain('opacity="1"')
    expect(crab(0, 6, 'unknown')).toContain('<g class="c-unknown">')
  })

  test('each costume draws its own props in its own colour', () => {
    expect(crab(0, 0, 'fable')).toContain('class="ant"')
    expect(crab(0, 0, 'fable')).toContain(`fill="${TIER_COLOR.fable}"`)
    expect(crab(0, 0, 'heavy')).toContain('class="gl"')
    expect(crab(0, 0, 'careful')).toContain('fill="#F5C542"')
    expect(crab(0, 0, 'medium')).toContain('class="egg"')
    expect(crab(0, 0, 'light')).toContain('class="flag"')
    expect(crab(0, 0, 'explore')).toContain('fill="#55514C"')
    expect(crab(0, 0, 'other')).not.toContain('class="it"')
  })

  test('status marks: a live dot, a green check, a red cross, a grey ring for an end not seen', () => {
    expect(statusMark(10, 16, 'running', '#D85A30')).toContain('class="live"')
    expect(statusMark(10, 16, 'done', '#D85A30')).toContain('stroke="#3B9C5F"')
    expect(statusMark(10, 16, 'failed', '#D85A30')).toContain('stroke="#D0453F"')
    expect(statusMark(10, 16, 'unknown', '#D85A30')).toBe(
      '<circle cx="10" cy="16" r="3.5" fill="none" stroke="#888780" stroke-width="1.5"/>',
    )
  })

  test('a row grows a line for the warning and each detail', () => {
    expect(rowHeight(row())).toBe(46)
    expect(rowHeight(row({ warning: 'memory 70%' }))).toBe(61)
    expect(rowHeight(row({ warning: 'memory 70%', details: ['a', 'b', 'c'] }))).toBe(106)
    const source = agentSvg(320, row({ warning: 'memory 70%', details: ['a', 'b', 'c'] }))
    expect(source).toContain('height="106"')
    expect(source).toContain('y1="105.5"')
  })

  test('the warning text reaches 4.5:1 on a light and on a dark pane', () => {
    expect(contrast(WARN.light, PANE_BG.light)).toBeGreaterThan(4.5)
    expect(contrast(WARN.light, TILE.light)).toBeGreaterThan(4.5)
    expect(contrast(WARN.dark, PANE_BG.dark)).toBeGreaterThan(4.5)
    expect(contrast(WARN.dark, TILE.dark)).toBeGreaterThan(4.5)
  })

  test('header: Running and Finished, Failed only when one failed, Cost and Time only when given', () => {
    expect(tiles(headerSvg(600, { running: 2, finished: 3, failed: 0 }))).toEqual([
      ['Running', 't', '2'],
      ['Finished', 't', '3'],
    ])
    const failed = headerSvg(600, { running: 0, finished: 3, failed: 1 })
    expect(tiles(failed)).toEqual([
      ['Running', 't', '0'],
      ['Finished', 't', '3'],
      ['Failed', 'f', '1'],
    ])
    expect(failed).toContain(`.f{fill:${FAILED.light}}@media (prefers-color-scheme: dark){.f{fill:${FAILED.dark}}}`)
    expect(headerSvg(600, { running: 0, finished: 3, failed: 0 })).not.toContain('.f{fill')
    expect(tiles(headerSvg(600, { running: 1, finished: 0, failed: 0, cost: '≈$0.05', time: '1:05' }))).toEqual([
      ['Running', 't', '1'],
      ['Finished', 't', '0'],
      ['Cost', 't', '≈$0.05'],
      ['Time', 't', '1:05'],
    ])
  })

  test('with a failure in details mode the tiles keep their order: Running, Finished, Failed, Cost, Time', () => {
    expect(
      tiles(headerSvg(600, { running: 1, finished: 2, failed: 3, cost: '≈$0.05', time: '1:05' })).map(
        ([label]) => label,
      ),
    ).toEqual(['Running', 'Finished', 'Failed', 'Cost', 'Time'])
  })

  test('header values shrink to fit whole: no value is cut where a smaller size fits it', () => {
    const totals = { running: 1, finished: 2, failed: 1, cost: '≈$12.34+', time: '12:40' }
    for (let W = 296; W <= 904; W += 8) {
      for (const [label, , value] of tiles(headerSvg(W, totals))) {
        expect(value.endsWith('…') ? `${label}@${W}` : 'whole').toBe('whole')
      }
    }
    const narrow = headerSvg(240, { running: 100, finished: 100, failed: 100, cost: '≈$123.45+', time: '1:02:03' })
    const sizes = [...narrow.matchAll(/<text class="[tf]"[^>]*font-size="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(sizes).toHaveLength(5)
    expect(sizes.every((s) => s >= 8 && s <= 15)).toBe(true)
    const labels = [...narrow.matchAll(/<text class="s"[^>]*font-size="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(labels.every((s) => s >= 7.7 && s <= 11)).toBe(true)
  })

  test('the failed count reads at 4.5:1 or better on both tiles', () => {
    expect(PANE_CSS).toContain(`.tile{fill:${TILE.light}}`)
    expect(PANE_CSS).toContain(`.tile{fill:${TILE.dark}}`)
    expect(contrast(FAILED.light, TILE.light)).toBeGreaterThan(4.5)
    expect(contrast(FAILED.dark, TILE.dark)).toBeGreaterThan(4.5)
  })

  test('the band dither is the same on every redraw and stays under the Svg limit', () => {
    const b = { total: 200, finished: 199, running: 1 }
    expect(bandSvg(1600, b)).toBe(bandSvg(1600, b))
    expect(bandSvg(1600, b).length).toBeLessThan(131_072)
    expect(bandSvg(1600, { total: 2, finished: 1, running: 1 }).length).toBeLessThan(131_072)
  })

  test('the band: dots for finished, a faint layer for running, a tick per agent', () => {
    const half = bandSvg(600, { total: 4, finished: 2, running: 2 })
    expect(half).toContain('<g fill="#8f8cf4"><rect class="t')
    expect(half).toContain('<g fill="#8f8cf4" opacity="0.45"><rect class="t')
    expect(half.match(/<rect x="\d+" y="4" width="1.5"/g)).toHaveLength(1)
    expect(half).toContain('>2/4</text>')
    expect(half).toContain('>50%</text>')
    expect(half).toContain('<g class="c-other run">')
    const none = bandSvg(600, { total: 3, finished: 0, running: 3 })
    expect(none).toContain('<g fill="#8f8cf4"></g>')
    expect(none.match(/<rect x="\d+" y="4" width="1.5"/g)).toHaveLength(2)
  })

  test('a narrow band drops the percent, and a large batch its ticks, so nothing overlaps', () => {
    const big = { total: 200, finished: 150, running: 50 }
    for (const W of [180, 190, 206, 240, 320]) {
      const source = bandSvg(W, big)
      const barW = Number(source.match(/<clipPath id="c"><rect x="0" y="0" width="(\d+)"/)?.[1])
      const pillW = Number(source.match(/<rect x="[\d.]+" width="(\d+)" height="16" rx="8" fill=/)?.[1])
      const barX = Number(source.match(/<g transform="translate\((\d+),/)?.[1])
      expect(pillW, String(W)).toBeLessThan(barW + 1)
      expect(barX + barW, String(W)).toBeLessThan(W - 26 + 1)
      if (source.includes('>75%</text>'))
        expect(barX + barW, String(W)).toBeLessThan(W - 26 - 6 - textWidth('75%', 12.5))
      expect(source.match(/width="1.5"/g), String(W)).toBeNull()
    }
    expect(bandSvg(180, big)).not.toContain('>75%</text>')
    expect(bandSvg(240, big)).toContain('>75%</text>')
  })

  test('terminal bars keep their width', () => {
    expect(barText(0.5, 10)).toBe('█████░░░░░')
    expect(barText(1, 4)).toBe('████')
    expect(ctxBar(16, 10)).toBe('██░░░░░░░░')
    expect(ctxBar(250, 4)).toBe('████')
  })
})
