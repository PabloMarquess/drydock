import type { On, RenderPropsOf, UiPane } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

type Surface = 'terminal' | 'desktop'
type World = { panes: UiPane[] }

const SURFACES = ['terminal', 'desktop'] as const

const PANE: RenderPropsOf['Pane'] = {
  title: 'Livery',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const engine = (on: On, world: World) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', (_$, e) => ({ text: `unhandled ${e.command}` }))
  on('ui.open', (_$, e) => {
    if (!world.panes.some((p) => p.id === e.id)) {
      world.panes.push({ id: e.id, title: e.title ?? '', isShown: true, isFocused: false, isPlaced: true })
    }
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    world.panes = world.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: world.panes }))
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'engine', ref: 0 }))
}

const start = async ($: Engine, on: On, surface: Surface = 'desktop') => {
  const world: World = { panes: [] }
  engine(on, world)
  await $.session.start({ cwd: '/x', surface, isInteractive: true })
  return world
}

const livery = ($: Engine, args = '') =>
  $.command.run({
    command: 'livery',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const tool = (name: string, isErrored = false): RenderPropsOf['ToolUse'] => ({
  tool_use_id: `tu-${name}`,
  tool: name,
  input: {},
  isRunning: false,
  isErrored,
  isInterrupted: false,
})

const prompt = (extra: Partial<RenderPropsOf['UserMessage']> = {}): RenderPropsOf['UserMessage'] => ({
  text: 'hello',
  origin: { kind: 'composer' },
  isExpanded: false,
  ...extra,
})

const reply = (text: string, extra: Partial<RenderPropsOf['AssistantMessage']> = {}) => ({
  text,
  isFirstOfReply: true,
  ...extra,
})

type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const outer = async (ui: { drawn: () => Promise<unknown> }) => (await ui.drawn()) as Drawn

const strip = async (ui: { drawn: () => Promise<unknown> }) => {
  const box = await outer(ui)
  const bar = box.children?.[0] as Drawn | undefined
  return { bg: box.props?.backgroundColor, accent: bar?.props?.backgroundColor }
}

const mountTool = ($: Engine, surface: Surface, props: RenderPropsOf['ToolUse']) =>
  $.ui.mount({ plugin: 'livery', surface, component: 'ToolUse', props })

const mountReply = ($: Engine, surface: Surface, props: RenderPropsOf['AssistantMessage']) =>
  $.ui.mount({ plugin: 'livery', surface, component: 'AssistantMessage', props })

describe('tool rows', () => {
  const cases = [
    ['Bash', 'rgba(245, 158, 11, 0.14)', 'warning'],
    ['Edit', 'rgba(16, 185, 129, 0.14)', 'success'],
    ['Write', 'rgba(16, 185, 129, 0.14)', 'success'],
    ['NotebookEdit', 'rgba(16, 185, 129, 0.14)', 'success'],
    ['mcp__datadog__search_logs', 'rgba(217, 70, 239, 0.12)', 'remember'],
    ['Read', 'rgba(56, 189, 248, 0.12)', 'suggestion'],
    ['Grep', 'rgba(56, 189, 248, 0.12)', 'suggestion'],
  ] as const

  for (const [name, bg, accent] of cases) {
    test(`desktop: ${name} wraps the engine row in its tone`, async ($, on) => {
      await start($, on)
      const ui = await mountTool($, 'desktop', tool(name))
      const box = await outer(ui)
      expect(box.type).toBe('Box')
      expect(box.props?.backgroundColor).toBe(bg)
      expect(box.props?.borderColor).toBe(accent)
      expect(await ui.find({ type: 'engine' })).toBeDefined()
    })
  }

  test('desktop: an errored call is red whatever the tool', async ($, on) => {
    await start($, on)
    for (const name of ['Bash', 'Edit', 'mcp__x__y', 'Read']) {
      const ui = await mountTool($, 'desktop', tool(name, true))
      expect((await outer(ui)).props?.backgroundColor).toBe('rgba(244, 63, 94, 0.16)')
      expect((await outer(ui)).props?.borderColor).toBe('error')
    }
  })

  test('terminal: tool rows pass through', async ($, on) => {
    await start($, on, 'terminal')
    for (const name of ['Bash', 'Edit', 'mcp__x__y', 'Read']) {
      const ui = await mountTool($, 'terminal', tool(name, name === 'Read'))
      expect(await outer(ui)).toMatchObject({ type: 'engine' })
    }
  })
})

describe('messages', () => {
  test('desktop: the prompt wraps the engine drawing in blue', async ($, on) => {
    await start($, on)
    for (const isExpanded of [false, true]) {
      const ui = await $.ui.mount({
        plugin: 'livery',
        surface: 'desktop',
        component: 'UserMessage',
        props: prompt({ isExpanded }),
      })
      const box = await outer(ui)
      expect(box.props?.backgroundColor).toBe('rgba(56, 189, 248, 0.14)')
      expect(box.props?.borderColor).toBe('suggestion')
      expect(await ui.find({ type: 'engine' })).toBeDefined()
    }
  })

  test('desktop: a slash command keeps the engine drawing, a path does not count', async ($, on) => {
    await start($, on)
    for (const text of ['/deck', '/livery gelo', '  /plugin:cmd arg']) {
      const ui = await $.ui.mount({
        plugin: 'livery',
        surface: 'desktop',
        component: 'UserMessage',
        props: prompt({ text }),
      })
      expect(await outer(ui)).toMatchObject({ type: 'engine' })
    }
    const path = await $.ui.mount({
      plugin: 'livery',
      surface: 'desktop',
      component: 'UserMessage',
      props: prompt({ text: '/home/user/notes is the folder' }),
    })
    expect((await outer(path)).props?.backgroundColor).toBe('rgba(56, 189, 248, 0.14)')
  })

  test('desktop: notifications and messages from others pass through', async ($, on) => {
    await start($, on)
    const rows: RenderPropsOf['UserMessage'][] = [
      prompt({ origin: { kind: 'task-notification' }, task: { id: 'a1', status: 'completed' } }),
      prompt({ origin: { kind: 'peer' }, from: { name: 'other' } }),
      prompt({ origin: { kind: 'unclassified' } }),
    ]
    for (const props of rows) {
      const ui = await $.ui.mount({ plugin: 'livery', surface: 'desktop', component: 'UserMessage', props })
      expect(await outer(ui)).toMatchObject({ type: 'engine' })
    }
  })

  test('terminal: messages pass through', async ($, on) => {
    await start($, on, 'terminal')
    const user = await $.ui.mount({ plugin: 'livery', surface: 'terminal', component: 'UserMessage', props: prompt() })
    expect(await outer(user)).toMatchObject({ type: 'engine' })
    const ui = await mountReply($, 'terminal', reply('text\n\n```sh\nls\n```'))
    expect(await outer(ui)).toMatchObject({ type: 'engine' })
  })

  test('desktop: a reply without code wraps the engine drawing in the default palette', async ($, on) => {
    await start($, on)
    const ui = await mountReply($, 'desktop', reply('Just **text**.'))
    expect(await strip(ui)).toEqual({ bg: 'rgba(150, 156, 112, 0.11)', accent: '#a3a88a' })
    expect(await ui.find({ type: 'engine' })).toBeDefined()
  })

  test('desktop: fenced code splits into code cards', async ($, on) => {
    await start($, on)
    const text = 'Run this:\n\n```sh\npnpm run check\n```\n\nThen:\n\n```ts\nconst a = 1\n```\n\nDone.'
    const ui = await mountReply($, 'desktop', reply(text))
    const marks = await ui.findAll({ type: 'Markdown' })
    expect(marks.map((m) => m.text)).toEqual(['Run this:', 'Then:', 'Done.'])
    const codes = await ui.findAll({ type: 'Code' })
    expect(codes.map((c) => [c.props.language, c.text])).toEqual([
      ['sh', 'pnpm run check'],
      ['ts', 'const a = 1'],
    ])
    for (const key of ['c1', 'c3']) {
      const card = await ui.find({ key })
      expect(card?.props.backgroundColor).toBe('rgba(100, 116, 139, 0.16)')
      expect(card?.props.borderColor).toBe('inactive')
    }
    expect(await strip(ui)).toEqual({ bg: 'rgba(150, 156, 112, 0.11)', accent: '#a3a88a' })
    expect(await ui.find({ type: 'engine' })).toBeUndefined()
  })

  test('desktop: a longer fence keeps a nested fence inside one code card', async ($, on) => {
    await start($, on)
    const text = 'Example:\n\n````md\nText\n\n```sh\nls\n```\n\nmore\n````\n\nEnd.'
    const ui = await mountReply($, 'desktop', reply(text))
    expect((await ui.findAll({ type: 'Markdown' })).map((m) => m.text)).toEqual(['Example:', 'End.'])
    const codes = await ui.findAll({ type: 'Code' })
    expect(codes.map((c) => [c.props.language, c.text])).toEqual([['md', 'Text\n\n```sh\nls\n```\n\nmore']])
  })

  test('desktop: a tilde fence becomes a code card', async ($, on) => {
    await start($, on)
    const ui = await mountReply($, 'desktop', reply('Try:\n\n~~~py\nx = 1\n~~~'))
    const codes = await ui.findAll({ type: 'Code' })
    expect(codes.map((c) => [c.props.language, c.text])).toEqual([['py', 'x = 1']])
  })

  test('desktop: a fence left open keeps the engine drawing in the palette', async ($, on) => {
    await start($, on)
    for (const text of ['Streaming:\n\n```sh\nls', 'a\n\n```sh\nls\n```\n\nthen\n\n````md\nstill open']) {
      const ui = await mountReply($, 'desktop', reply(text))
      expect(await ui.find({ type: 'engine' })).toBeDefined()
      expect(await ui.findAll({ type: 'Code' })).toHaveLength(0)
      expect(await strip(ui)).toEqual({ bg: 'rgba(150, 156, 112, 0.11)', accent: '#a3a88a' })
    }
  })

  test('desktop: a summary block passes through', async ($, on) => {
    await start($, on)
    const ui = await mountReply($, 'desktop', reply('summary\n\n```sh\nls\n```', { isSummary: true }))
    expect(await outer(ui)).toMatchObject({ type: 'engine' })
  })
})

describe('palettes', () => {
  test('/livery <palette> switches the reply palette for the session', async ($, on) => {
    await start($, on)
    const ui = await mountReply($, 'desktop', reply('hi'))
    expect(await livery($, 'gelo')).toMatchObject({ text: 'Livery on · palette gelo for this session.' })
    expect(await strip(ui)).toEqual({ bg: 'rgba(140, 195, 230, 0.10)', accent: '#8cc3e6' })
    await livery($, 'ARGILA')
    expect(await strip(ui)).toEqual({ bg: 'rgba(217, 119, 87, 0.07)', accent: 'claude' })
    await livery($, 'plain')
    expect(await strip(ui)).toEqual({ bg: undefined, accent: 'claude' })
    expect((await livery($)).text).toContain('palette plain (this session)')
  })

  test('userConfig picks the palette', { options: { palette: 'cinza' } }, async ($, on) => {
    await start($, on)
    const ui = await mountReply($, 'desktop', reply('hi'))
    expect(await strip(ui)).toEqual({ bg: 'rgba(120, 124, 135, 0.07)', accent: 'permission' })
    expect((await livery($)).text).toContain('palette cinza (from config)')
  })

  test('the session palette overrides userConfig', { options: { palette: 'areia' } }, async ($, on) => {
    await start($, on)
    const ui = await mountReply($, 'desktop', reply('hi'))
    expect((await strip(ui)).bg).toBe('rgba(176, 148, 104, 0.09)')
    await livery($, 'manteiga')
    expect((await strip(ui)).bg).toBe('rgba(150, 156, 112, 0.11)')
  })
})

describe('/livery', () => {
  for (const surface of SURFACES) {
    test(`${surface}: status lists state, palette and palettes`, async ($, on) => {
      await start($, on, surface)
      expect(await livery($)).toMatchObject({
        text: 'Livery on · palette manteiga (from config) · palettes: plain, areia, argila, manteiga, gelo, cinza. Colors draw in the desktop app.',
      })
      await livery($, 'off')
      expect((await livery($)).text).toContain('Livery off')
    })

    test(`${surface}: unknown arguments get a short help`, async ($, on) => {
      await start($, on, surface)
      expect((await livery($, 'neon')).text).toBe(
        'Usage: /livery [on | off | preview | <palette>]. Palettes: plain, areia, argila, manteiga, gelo, cinza.',
      )
    })
  }

  test('off passes everything through and on brings it back', async ($, on) => {
    await start($, on)
    const row = await mountTool($, 'desktop', tool('Bash'))
    const msg = await mountReply($, 'desktop', reply('hi\n\n```sh\nls\n```'))
    const user = await $.ui.mount({ plugin: 'livery', surface: 'desktop', component: 'UserMessage', props: prompt() })
    expect(await livery($, 'off')).toMatchObject({ text: 'Livery off for this session.' })
    for (const ui of [row, msg, user]) expect(await outer(ui)).toMatchObject({ type: 'engine' })
    expect(await livery($, 'on')).toMatchObject({ text: 'Livery on · palette manteiga.' })
    for (const ui of [row, msg, user]) expect((await outer(ui)).type).toBe('Box')
    expect(await strip(msg)).toEqual({ bg: 'rgba(150, 156, 112, 0.11)', accent: '#a3a88a' })
    expect((await msg.find({ key: 'c1' }))?.props.borderColor).toBe('inactive')
  })

  test('a palette turns it back on', async ($, on) => {
    await start($, on)
    const msg = await mountReply($, 'desktop', reply('hi'))
    await livery($, 'off')
    await livery($, 'gelo')
    expect((await strip(msg)).bg).toBe('rgba(140, 195, 230, 0.10)')
  })
})

describe('preview pane', () => {
  for (const surface of SURFACES) {
    test(`${surface}: /livery preview toggles the pane and its buttons pick a palette`, async ($, on) => {
      const world = await start($, on, surface)
      expect(await livery($, 'preview')).toMatchObject({ text: 'Palette preview opened.' })
      expect(world.panes.map((p) => p.id)).toEqual(['livery'])

      const pane = await $.ui.mount({
        plugin: 'livery',
        surface,
        component: 'Pane',
        requestId: 'livery',
        props: PANE,
      })
      expect(await pane.findAll({ type: 'Button' })).toHaveLength(6)
      expect(await pane.find({ type: 'Text', text: 'Manteiga (in use)' })).toBeDefined()
      const swatches = await pane.findAll({ type: 'Markdown' })
      expect(swatches).toHaveLength(surface === 'desktop' ? 6 : 0)
      if (surface === 'desktop') {
        const gelo = await pane.find({ key: 'gelo' })
        const sample = gelo?.children[2] as Drawn | undefined
        expect(sample?.props?.backgroundColor).toBe('rgba(140, 195, 230, 0.10)')
      }

      await pane.press({ key: 'use-gelo' })
      expect(await pane.find({ type: 'Text', text: 'Gelo (in use)' })).toBeDefined()
      expect((await livery($)).text).toContain('palette gelo (this session)')

      expect(await livery($, 'preview')).toMatchObject({ text: 'Palette preview closed.' })
      expect(world.panes).toHaveLength(0)
    })
  }

  test('the pane marks a selected palette while off', async ($, on) => {
    await start($, on)
    await livery($, 'off')
    const pane = await $.ui.mount({
      plugin: 'livery',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'livery',
      props: PANE,
    })
    expect(await pane.find({ type: 'Text', text: 'Manteiga (selected, off)' })).toBeDefined()
  })
})
