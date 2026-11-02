import type { AgentStatus, Costume } from '../types'

// Drawings ported from claude-kit's savvy-progress (commit c871c15, MIT): Pixel Clawd and its
// costumes, the pane's rows, tiles and dotted grid, and the band's dithered bar. Pure strings in, SVG out.

export type { Costume }

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// CJK, fullwidth forms and emoji advance about 1em.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-\uA97F가-힣豈-\uFAFF︰-﹏！-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56

export const textWidth = (s: string, size: number): number => {
  let em = 0
  for (const ch of s) em += charEm(ch)
  return em * size
}

const ELLIPSIS = '…'

// One pass that stops at the first character past px: a description has no length limit and the pane
// redraws every second while an agent runs.
export const fit = (s: string, px: number, size: number): string => {
  const dots = charEm(ELLIPSIS)
  let em = 0
  let at = 0
  let cut = 0
  for (const ch of s) {
    em += charEm(ch)
    if (em * size > px) return `${s.slice(0, cut).trimEnd()}${ELLIPSIS}`
    at += ch.length
    if ((em + dots) * size <= px) cut = at
  }
  return s
}

export const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

export const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

// Built-in Explore and Plan agents wear their own costume; any other agent dresses for its model.
export const costumeOf = (type: string, model: string): Costume => {
  if (type === 'Explore') return 'explore'
  if (type === 'Plan') return 'careful'
  const id = model.toLowerCase()
  if (/fable|mythos/.test(id)) return 'fable'
  if (/opus/.test(id)) return 'heavy'
  if (/sonnet/.test(id)) return 'medium'
  if (/haiku/.test(id)) return 'light'
  return 'other'
}

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
export const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void => {
  rows.forEach((row, dy) => {
    ;[...row].forEach((ch, dx) => {
      const c = map[ch]
      if (c) f(x + dx, y + dy, 1, 1, c, cls)
    })
  })
}

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
export const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE')
    f(5, 8, 1, 14, '#E6E8EE')
    f(24, 8, 1, 14, '#E6E8EE')
    f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)')
    f(8, 9, 2, 1, '#fff')
    f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2')
    f(14, 2, 2, 2, t, 'ant')
    f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star')
    f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(
      f,
      6,
      3,
      [
        '......bbbbbb......',
        '....bbcbbcbbbb....',
        '...bbbbbbbbbbbb...',
        '..bcbbcbbcbbcbbb..',
        '.bbbbbbbbbbbbbbbb.',
        'dddddddddddddddddd',
      ],
      { b: '#7A4A26', c: '#A0703F', d: '#5A3519' },
    )
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it')
    f(25, 6, 1, 4, '#7A4A26', 'it')
    f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(
      f,
      6,
      4,
      [
        '.....yyyyyyyy.....',
        '...yyyyyhhyyyyy...',
        '..yyyyyyhhyyyyyy..',
        '..yyyyyyhhyyyyyy..',
        '.yyyyyyyhhyyyyyyy.',
        'dddddddddddddddddd',
      ],
      { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' },
    )
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(
      f,
      6,
      0,
      [
        '........lll.......',
        '.......lllll......',
        '.wwwwgwwwwwwgwwwww',
        'wwwwwwwwwwwwwwwwww',
        'wwwwwwwwwwwwwwwwww',
        'wwwwwgwwwwwggwwwww',
        '.wwwwgwwwwwggwwwww',
        '.dddbbbbbbbbbbbbb.',
        '.dddbbbbbbbbbbbbb.',
        '.dddbbbbbbbbbbbbb.',
      ],
      { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' },
    )
    f(22, 8, 7, 2, '#4A4A48', 'pan')
    f(26, 10, 1, 1, '#4A4A48', 'pan')
    f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(
      f,
      6,
      5,
      [
        '....rrrrrrrrrr....',
        '..rrrrrrwwrrrrrr..',
        '.rrrrrrrwwrrrrrrr.',
        '.rrrrrrrwwrrrrrrr.',
        '.rrrrrrrwwrrrrrrr.',
        '.kkkkkkkkkkkkkkkkr',
      ],
      { r: t, w: '#F8F6F1', k: INK },
    )
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: (f) => {
    crabBody(f)
    stamp(
      f,
      5,
      3,
      [
        '.kk..............kk.',
        '.kkk....kkkk....kkk.',
        '..kkkkkkkwwkkkkkkk..',
        '..kkkkkkkkkkkkkkkk..',
        '.gggggggggggggggggg.',
      ],
      { k: '#55514C', w: '#F8F6F1', g: '#F5C542' },
    )
    f(7, 11, 11, 1, INK)
    f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it')
    f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: (f) => crabBody(f),
}

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const drawCrab = (
  x: number,
  y: number,
  costume: string,
  dim = false,
  isWalking = false,
  scale = CRAB_SCALE,
): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter((k) => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const place = `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

// A crab depends on nothing but its arguments, which take a handful of values: drawn once each.
const crabs = new Map<string, string>()
export const crab = (
  x: number,
  y: number,
  costume: string,
  dim = false,
  isWalking = false,
  scale = CRAB_SCALE,
): string => {
  const key = `${x},${y},${costume},${dim},${isWalking},${scale}`
  const hit = crabs.get(key)
  if (hit !== undefined) return hit
  const drawn = drawCrab(x, y, costume, dim, isWalking, scale)
  if (crabs.size < 256) crabs.set(key, drawn)
  return drawn
}

export const statusMark = (x: number, y: number, status: AgentStatus, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done')
    return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
}

// The live dot pulses once a second, not every 1.6s as in claude-kit: a running row redraws each
// second, which restarts the pulse, and a period that divides the second restarts it in phase.
export const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// The pane's backdrop: a dotted grid as tall as the content laid over it; the
// row SVGs are transparent, so it shows through between their marks.
const GRID_STEP = 16
// A Text or Button row on the desktop is about 20px; the grid errs taller.
export const LINE_H = 24
// The engine refuses an Svg taller than 4096px, so a long grid is stacked from
// tiles of at most this height; a multiple of GRID_STEP keeps the dots aligned.
const GRID_TILE = 4096
export const gridTiles = (H: number): number[] =>
  Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))
export const gridSvg = (
  W: number,
  H: number,
): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

// The memory warning's text: at least 4.5:1 on a white pane and on a near-black one.
export const WARN = { light: '#a3540c', dark: '#f0a04b' }
const WARN_CSS = `<style>.w{fill:${WARN.light}}@media (prefers-color-scheme: dark){.w{fill:${WARN.dark}}}</style>`

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Cost and time are set only in details mode. */
export type Totals = { running: number; finished: number; failed: number; cost?: string; time?: string }

export const HEADER_H = 44

// The failed count's text: at least 4.5:1 on the light and the dark tile.
export const FAILED = { light: '#b42318', dark: '#f97066' }
const FAILED_CSS = `<style>.f{fill:${FAILED.light}}@media (prefers-color-scheme: dark){.f{fill:${FAILED.dark}}}</style>`

// Running and Finished always, Failed only when an agent failed, Cost and Time in details mode; equal
// tiles, and a value too wide for its tile shrinks to fit.
export const headerSvg = (W: number, t: Totals): string => {
  const gap = 6
  const tiles: [label: string, value: string, cls: string][] = [
    ['Running', String(t.running), 't'],
    ['Finished', String(t.finished), 't'],
  ]
  if (t.failed > 0) tiles.push(['Failed', String(t.failed), 'f'])
  if (t.cost !== undefined) tiles.push(['Cost', t.cost, 't'])
  if (t.time !== undefined) tiles.push(['Time', t.time, 't'])
  const w = (W - gap * (tiles.length - 1)) / tiles.length
  const room = w - 18
  // Floored, not rounded: a size rounded up would no longer fit and fit() would cut the value.
  const sizeFor = (text: string, full: number, least: number): number =>
    Math.floor(10 * full * Math.max(least, Math.min(1, room / Math.max(1, textWidth(text, full))))) / 10
  const tile = ([label, value, cls]: [string, string, string], i: number) => {
    const x = i * (w + gap)
    const size = sizeFor(value, 15, 0.55)
    const labelSize = sizeFor(label, 11, 0.7)
    return `<rect class="tile" x="${round1(x)}" y="0" width="${round1(w)}" height="40" rx="8"/>
<text class="s" x="${round1(x + 9)}" y="16" font-family="${FONT}" font-size="${labelSize}">${xml(fit(label, room, labelSize))}</text>
<text class="${cls}" x="${round1(x + 9)}" y="33" font-family="${FONT}" font-size="${size}" font-weight="600" font-variant-numeric="tabular-nums">${xml(fit(value, room, size))}</text>`
  }
  return svg(W, HEADER_H, `${t.failed > 0 ? FAILED_CSS : ''}${tiles.map(tile).join('')}`)
}

export type RowArt = {
  title: string
  costume: Costume
  status: AgentStatus
  /** The model's name, drawn in the costume's colour. */
  model: string
  /** What follows the model on the second line: " · 1:05". */
  meta: string
  /** Empty, or the memory warning. */
  warning: string
  /** The details mode's extra lines; none in the lean view. */
  details: string[]
}

export const rowHeight = (r: RowArt): number => 46 + 15 * ((r.warning ? 1 : 0) + r.details.length)

// Crab left, bold title, the model in the costume's colour, the status mark right, a hairline under.
export const agentSvg = (W: number, r: RowArt): string => {
  const color = colorOf(r.costume)
  const textW = W - 42 - 22
  const H = rowHeight(r)
  // The time keeps its room: a long model id is cut first, and a meta with no room left is dropped
  // rather than drawn as a lone ellipsis.
  const model = fit(r.model, Math.max(40, textW - textWidth(r.meta, 11)), 11)
  const meta = fit(r.meta, Math.max(0, textW - textWidth(model, 11)), 11)
  const extra = [
    ...(r.warning ? [{ cls: 'w', text: r.warning }] : []),
    ...r.details.map((text) => ({ cls: 's', text })),
  ]
  const lines = extra
    .map(
      (l, i) =>
        `<text class="${l.cls}" x="42" y="${49 + 15 * i}" font-family="${FONT}" font-size="11"${l.cls === 'w' ? ' font-weight="600"' : ''} font-variant-numeric="tabular-nums">${xml(fit(l.text, textW, 11))}</text>`,
    )
    .join('\n')
  return svg(
    W,
    H,
    `${r.warning ? WARN_CSS : ''}${crab(0, 6, r.costume, r.status === 'failed', r.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fit(r.title, textW, 13))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(model)}</tspan>${meta === ELLIPSIS ? '' : `<tspan class="s" font-variant-numeric="tabular-nums">${xml(meta)}</tspan>`}</text>
${lines}
${statusMark(W - 8, 16, r.status, color)}
<line class="ln" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>`,
  )
}

export type BandArt = { total: number; finished: number; running: number }

export const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

// The band is one SVG: the desktop wraps sibling elements onto new lines, so title, bar, percent and
// the crab live in one drawing; only the buttons sit beside it.
export const BAND_H = 22
const H = BAND_H
const BAR_H = 16
const CRAB_W = 26
const CELL = 3

export const bandRatio = (b: BandArt): number => (b.total ? b.finished / b.total : 0)

export const bandSvg = (W: number, b: BandArt): string => {
  const isFinished = b.running === 0
  const title = 'Agents'
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  // Too narrow for bar, percent and crab: the percent goes, so nothing overlaps.
  const hasPercent = W - BAR_X - 46 - CRAB_W >= 60
  const BAR_W = Math.max(60, W - BAR_X - (hasPercent ? 46 : 6) - CRAB_W)
  const color = isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * bandRatio(b))
  const runW = b.total ? Math.round((BAR_W * Math.min(b.total, b.finished + b.running)) / b.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * (c / Math.max(1, cols)) ** 1.2
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density)
        dots.push(
          `<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`,
        )
    }
  }
  // Agents still running: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2)
        faint.push(
          `<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`,
        )
    }
  }

  // A tick per agent while they stand 4px apart; closer, they would merge into a slab.
  const ticks: string[] = []
  for (let i = 1; i < b.total && BAR_W / b.total >= 4; i++) {
    const x = Math.round((BAR_W * i) / b.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = `${b.finished}/${b.total}`
  const pillW = Math.min(BAR_W, Math.round(18 + text.length * 6.6))
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(bandRatio(b) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
${hasPercent ? `<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>\n` : ''}${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, !isFinished, 0.8)}
</svg>`
}

// Terminal fallbacks: the same marks and bars in text.
export const STATUS_GLYPH: Record<AgentStatus, string> = { running: '●', done: '✓', failed: '✗' }

const blocks = (filled: number, width: number): string =>
  '█'.repeat(Math.max(0, Math.min(width, filled))) + '░'.repeat(Math.max(0, width - filled))

export const ctxBar = (pct: number, width: number): string => blocks(Math.round((width * pct) / 100), width)

export const barText = (ratio: number, width: number): string => blocks(Math.round(width * ratio), width)
