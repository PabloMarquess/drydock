import { describe, expect, test } from 'claude-code/testing'
import {
  classify,
  clean,
  isSameSkill,
  mcpOf,
  programOf,
  redact,
  safe,
  shortPath,
  skillSource,
  tokensOf,
  webLabel,
} from '../hooks/sources'
import { groupsOf, lineOf, summaryOf, tokensText, topOf } from '../hooks/summary'
import type { Entry, SourceKind } from '../types'

const entry = (kind: SourceKind, label: string, tokens = 0, extra: Partial<Entry> = {}): Entry => ({
  kind,
  label,
  detail: '',
  agentId: null,
  tokens,
  isFailed: false,
  ref: null,
  ...extra,
})

// Fake keys, built from parts: shaped like real ones for the redactor, never one a scanner takes for real.
const FAKE = {
  aws: ['AKIA', 'FAKEFAKEFAKE0000'].join(''),
  github: ['ghp', '_fake0123fake'].join(''),
  openai: ['sk', '-live-0123456789abcdef'].join(''),
  slack: ['xoxb', '-0000-fake'].join(''),
  google: ['AIza', 'FakeFakeFake'].join(''),
  jwt: ['eyJ', 'hbGciOiJub25lIn0'].join(''),
  hex: '0123456789abcdef'.repeat(2),
  bot: ['AAHd', 'qTcvCH1vFAKEFAKEs0K5PALDsaw'].join(''),
}

describe('classify', () => {
  test('every kind, with only what the label needs', () => {
    expect(classify('Skill', { skill: '/finops-custos', args: 'hidden' })).toEqual({
      kind: 'skill',
      label: 'finops-custos',
      detail: 'Skill',
    })
    expect(classify('mcp__datadog__search_datadog_logs', { query: 'service:api' })).toEqual({
      kind: 'mcp',
      label: 'datadog · search_datadog_logs',
      detail: 'MCP',
    })
    expect(classify('Read', { file_path: '/home/dev/drydock/plugins/logbook/hooks/register.tsx', offset: 3 })).toEqual({
      kind: 'file',
      label: 'hooks/register.tsx',
      detail: 'Read',
    })
    expect(classify('NotebookRead', { notebook_path: '/a/b/analysis.ipynb' })).toEqual({
      kind: 'file',
      label: 'b/analysis.ipynb',
      detail: 'NotebookRead',
    })
    expect(classify('Grep', { pattern: 'TODO', path: '/repo/plugins/deck' })).toEqual({
      kind: 'file',
      label: 'grep in plugins/deck',
      detail: 'Grep',
    })
    expect(classify('Glob', { pattern: '**/*.test.ts' })).toEqual({ kind: 'file', label: 'glob', detail: 'Glob' })
    expect(classify('Glob', { pattern: '*.md', path: '/repo/docs' })).toMatchObject({ label: 'glob in repo/docs' })
    expect(
      classify('WebFetch', { url: 'https://user:pw@docs.example.com/guide/start/?token=abc#top', prompt: 'p' }),
    ).toEqual({ kind: 'web', label: 'docs.example.com/guide', detail: 'WebFetch' })
    expect(classify('WebSearch', { query: 'lambda cold start' })).toEqual({
      kind: 'web',
      label: 'web search',
      detail: 'WebSearch',
    })
    expect(classify('Bash', { command: 'git status --short' })).toEqual({ kind: 'shell', label: 'git', detail: 'Bash' })
    expect(classify('PowerShell', { command: 'Get-ChildItem -Force' })).toEqual({
      kind: 'shell',
      label: 'Get-ChildItem',
      detail: 'PowerShell',
    })
    expect(classify('ReadMcpResourceTool', { server: 'github', uri: 'repo://x/y?token=1' })).toEqual({
      kind: 'mcp',
      label: 'github · resource',
      detail: 'ReadMcpResourceTool',
    })
    expect(classify('ReadMcpResourceDirTool', { server: 'github', uri: 'repo://x/' })).toMatchObject({
      label: 'github · resources',
    })
    expect(classify('ListMcpResourcesTool', {})).toEqual({
      kind: 'mcp',
      label: 'mcp · resources',
      detail: 'ListMcpResourcesTool',
    })
    expect(classify('Edit', { file_path: '/x/y.ts', old_string: 'a', new_string: 'b' })).toEqual({
      kind: 'other',
      label: 'Edit',
      detail: '',
    })
    expect(classify('Agent', { description: 'scan', prompt: 'p' })).toBeNull()
    expect(classify('Task', { description: 'scan', prompt: 'p' })).toBeNull()
  })

  test('a plugin MCP server loses its plugin_ prefix; a connector named by a UUID reads connector', () => {
    expect(mcpOf('mcp__plugin_deploy-on-aws_awsiac__cdk_best_practices')).toEqual({
      server: 'deploy-on-aws_awsiac',
      name: 'cdk_best_practices',
    })
    expect(mcpOf('mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch')).toEqual({ server: 'connector', name: 'batch' })
    expect(classify('ReadMcpResourceTool', { server: '1A59C906-04DA-521D-BDA7-7F71B9F9E01C' })).toMatchObject({
      label: 'connector · resource',
    })
    expect(mcpOf(`mcp__${'s'.repeat(50)}__${'t'.repeat(80)}`).server).toHaveLength(32)
    expect(mcpOf('mcp__x__a__b').name).toBe('a__b')
  })

  test('inputs of the wrong type fall back to a plain label', () => {
    expect(classify('Read', { file_path: 42 })).toMatchObject({ label: 'file' })
    expect(classify('WebFetch', { url: 'not a url' })).toMatchObject({ label: 'web' })
    expect(classify('Bash', {})).toMatchObject({ label: 'shell' })
    expect(classify('Grep', { pattern: 7, path: [] })).toMatchObject({ label: 'grep' })
  })

  test('no pattern, query, command line or key reaches a label', () => {
    for (const secret of Object.values(FAKE)) {
      const labels = [
        classify('Grep', { pattern: secret, path: `/repo/${secret}/src` }),
        classify('Glob', { pattern: `**/${secret}*`, path: '/repo' }),
        classify('WebSearch', { query: `error ${secret} invalid` }),
        classify('WebFetch', { url: `https://api.example.com/v1/${secret}/x?key=${secret}`, prompt: 'p' }),
        classify('WebFetch', { url: `https://api.example.com/${secret}`, prompt: 'p' }),
        classify('Read', { file_path: `/home/dev/${secret}/notes.md` }),
        classify('Bash', { command: `curl -H "Authorization: Bearer ${secret}" https://x` }),
        classify('Bash', { command: `cd /a\n${secret}` }),
        classify('Skill', { skill: secret }),
      ]
      expect(JSON.stringify(labels), secret).not.toContain(secret)
    }
  })
})

describe('redact', () => {
  test('keys and tokens become …; plain words, paths and numbers stay', () => {
    for (const secret of Object.values(FAKE)) expect(redact(secret), secret).toBe('…')
    expect(redact(`use ${FAKE.openai} to call the api`)).toBe('use … to call the api')
    expect(redact(`bot123456789:${FAKE.bot}`)).toBe('bot123456789:…')
    expect(redact(`${FAKE.hex}.ngrok.io`)).toBe('….ngrok.io')
    expect(redact('hooks/register.tsx')).toBe('hooks/register.tsx')
    expect(redact('internationalization')).toBe('internationalization')
    expect(redact('1234567890123456')).toBe('1234567890123456')
    expect(redact('plugins/v2/handlers-2024.ts')).toBe('plugins/v2/handlers-2024.ts')
    expect(redact('sk')).toBe('sk')
  })

  test('a label is redacted before it is cut, so no part of a key is left', () => {
    expect(safe(`${FAKE.hex} and more words`, 10)).toBe('… and mor…')
    expect(safe(`a\u0000${FAKE.aws}`, 80)).toBe('a …')
  })
})

describe('web', () => {
  test('an http(s) URL keeps its host and first path segment; another keeps its protocol', () => {
    expect(webLabel(`https://api.telegram.org/bot123456789:${FAKE.bot}/getMe`)).toBe('api.telegram.org/bot123456789:…')
    expect(webLabel(`https://mainnet.infura.io/v3/${FAKE.hex}`)).toBe('mainnet.infura.io/v3')
    expect(webLabel(`https://eth-mainnet.g.alchemy.com/v2/${FAKE.hex}`)).toBe('eth-mainnet.g.alchemy.com/v2')
    expect(webLabel(`https://${FAKE.hex}.ngrok.io/hook`)).toBe('….ngrok.io/hook')
    expect(webLabel('https://user:tok@host.example/p/q?q=1#f')).toBe('host.example/p')
    expect(webLabel('data:text/plain;base64,c2VjcmV0LXRva2VuLXZhbHVl')).toBe('data:')
    expect(webLabel('http://example.com/')).toBe('example.com')
    expect(webLabel('file:///etc/hosts')).toBe('file:')
    expect(webLabel(7)).toBe('web')
  })
})

describe('shell', () => {
  test('only the program name is kept, never its arguments', () => {
    const cases: [string, string][] = [
      [`API_TOKEN=${FAKE.openai} curl -H "Authorization: Bearer ${FAKE.openai}" https://api.example.com`, 'curl'],
      ['cd /repo && pnpm exec biome check', 'pnpm'],
      ['cd /repo; cd sub && git log --oneline | head -5', 'git'],
      ['sudo -E systemctl status app', 'systemctl'],
      ['env FOO=1 node scripts/run.mjs', 'node'],
      ['/usr/local/bin/aws s3 ls', 'aws'],
      ['(cd x && make test)', 'make'],
      ['"$(cat token.txt)" --flag', 'shell'],
      ['cd /tmp', 'cd'],
      ['', 'shell'],
    ]
    for (const [command, program] of cases) {
      expect(programOf(command), command).toBe(program)
      expect(classify('Bash', { command })?.label ?? '').not.toContain(FAKE.openai)
    }
  })

  test("a wrapper's options and their values are skipped", () => {
    const cases: [string, string][] = [
      ['sudo -u postgres psql -c "select 1"', 'psql'],
      ['sudo -Eu root make', 'make'],
      ['sudo -uroot make', 'make'],
      ['sudo --user postgres psql', 'psql'],
      ['sudo -- make install', 'make'],
      ['doas -u www node app.js', 'node'],
      ['env -u HOME node x.js', 'node'],
      ['env -C /srv -S x node', 'node'],
      ['sudo env FOO=1 nice -n 5 node x.js', 'node'],
      ['time -p make', 'make'],
      ['time -f "%e" make', 'make'],
      ['nice -n 5 make', 'make'],
      ['nohup python3 serve.py', 'python3'],
      ['exec -a name bash', 'bash'],
      ['C:\\tools\\aws.exe s3 ls', 'aws.exe'],
      ['export X=1 && aws s3 ls', 'export'],
      ['TOKEN=abc123', 'shell'],
      ['$(cat t) --x', 'shell'],
      ['constructor x', 'constructor'],
    ]
    for (const [command, program] of cases) expect(programOf(command), command).toBe(program)
  })

  test('a word that looks like a key reads shell', () => {
    expect(programOf(FAKE.aws)).toBe('shell')
    expect(programOf(`cd /a\n${FAKE.aws}`)).toBe('shell')
    expect(programOf(`${FAKE.hex} --help`)).toBe('shell')
  })
})

describe('text', () => {
  test('control and format characters, lone surrogates and U+FFFE/U+FFFF become spaces', () => {
    expect(clean('a\u0001b\nc\u202Ed\u009be\uFFFFf\uD800g\u200Bh\u2066i\uFEFFj')).toBe('a b c d e f g h i j')
    expect(clean(42)).toBe('')
    expect(clean('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  test('paths keep their last two segments', () => {
    expect(shortPath('C:\\Users\\dev\\repo\\src\\main.ts')).toBe('src/main.ts')
    expect(shortPath('/CLAUDE.md')).toBe('CLAUDE.md')
    expect(shortPath(`/home/dev/${FAKE.hex}/a.ts`)).toBe('…/a.ts')
    expect(shortPath(undefined)).toBe('')
  })

  test('tokens are the text length / 4, shown without a unit rounding up into the next', () => {
    expect(tokensOf('x'.repeat(4000))).toBe(1000)
    expect(tokensOf('abcdef')).toBe(2)
    expect(tokensOf(undefined)).toBe(0)
    expect(tokensText(300)).toBe('300')
    expect(tokensText(999.6)).toBe('1k')
    expect(tokensText(42_400)).toBe('42k')
    expect(tokensText(999_400)).toBe('999k')
    expect(tokensText(999_600)).toBe('1.0M')
    expect(tokensText(1_250_000)).toBe('1.3M')
  })

  test('skills match with or without their plugin prefix', () => {
    expect(isSameSkill('commit', 'tools:commit')).toBe(true)
    expect(isSameSkill('Tools:Commit', 'commit')).toBe(true)
    expect(isSameSkill('commit', 'commit-push')).toBe(false)
    expect(skillSource('userSettings', undefined)).toBe('user')
    expect(skillSource('plugin', 'finops')).toBe('plugin finops')
    expect(skillSource('mcp', undefined)).toBe('mcp')
    expect(skillSource('constructor', undefined)).toBe('constructor')
  })

  test("a skill's source and its plugin's name are redacted, as every label is", () => {
    expect(skillSource('plugin', FAKE.aws)).toBe('plugin …')
    expect(skillSource('plugin', `tools ${FAKE.github}`)).toBe('plugin tools …')
    expect(skillSource(FAKE.openai, undefined)).toBe('…')
    expect(skillSource('plugin\u202Etools', undefined)).toBe('plugin tools')
  })
})

describe('summary', () => {
  const turn = [
    entry('skill', 'finops-custos', 3_000),
    entry('mcp', 'datadog · search_logs', 8_000),
    entry('mcp', 'datadog · search_logs', 8_000),
    entry('mcp', 'datadog · get_metric', 4_000),
    ...['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'a.ts'].map((f) => entry('file', f, 3_000)),
    entry('web', 'docs.example.com/x', 1_000),
  ]

  test('counts by kind, MCP by server, then the tokens in', () => {
    expect(summaryOf(turn, false)).toBe(
      '⚓ logbook · skill finops-custos · datadog ×3 · 6 files · 1 web · ≈42k tokens in',
    )
  })

  test('the line under a reply ends pointing to the pane, a long one too', () => {
    expect(lineOf(turn, false)).toBe(
      '⚓ logbook · skill finops-custos · datadog ×3 · 6 files · 1 web · ≈42k tokens in · /logbook pane',
    )
    const many = Array.from({ length: 300 }, (_, i) => entry('file', `dir/file-${i}.ts`, 10))
    const long = lineOf(many, true)
    expect(long.endsWith('… · /logbook pane')).toBe(true)
    expect([...long]).toHaveLength(1500)
  })

  test('a turn with no new sources has no pointer to the pane', () => {
    expect(lineOf([], false)).toBe('⚓ logbook · no new sources')
    expect(lineOf([], true)).toBe('⚓ logbook · no new sources')
  })

  test('details list every source', () => {
    expect(summaryOf(turn, true)).toBe(
      '⚓ logbook · skill finops-custos · datadog search_logs ×2, get_metric · files a.ts ×2, b.ts, c.ts, d.ts, e.ts · web docs.example.com/x · ≈42k tokens in',
    )
  })

  test('what subagents read for themselves is counted apart', () => {
    const line = summaryOf(
      [
        entry('agent', 'scan', 2_000, { detail: 'Explore', ref: 'a1' }),
        entry('file', 'x.ts', 30_000, { agentId: 'a1' }),
        entry('shell', 'git', 0),
        entry('instructions', '.claude/CLAUDE.md', 500),
        entry('other', 'Edit', 0, { isFailed: true }),
      ],
      false,
    )
    expect(line).toBe(
      '⚓ logbook · 1 file · 1 agent · 1 shell · 1 instruction file · 1 other · ≈3k tokens in · ≈30k inside agents',
    )
    expect(summaryOf([entry('other', 'Edit', 0, { isFailed: true })], true)).toBe('⚓ logbook · other Edit (1 failed)')
  })

  test('a turn with no sources says so; a long line is cut', () => {
    expect(summaryOf([], false)).toBe('⚓ logbook · no new sources')
    const many = Array.from({ length: 300 }, (_, i) => entry('file', `dir/file-${i}.ts`, 10))
    const line = summaryOf(many, true)
    expect([...line]).toHaveLength(1500)
    expect(line.endsWith('…')).toBe(true)
  })

  test('more than three skills and four servers collapse into a count', () => {
    const line = summaryOf(
      [
        ...['a', 'b', 'c', 'd'].map((s) => entry('skill', s)),
        ...['s1', 's2', 's3', 's4', 's5', 's6'].map((s) => entry('mcp', `${s} · t`)),
      ],
      false,
    )
    expect(line).toBe('⚓ logbook · skills a, b, c +1 · s1 · s2 · s3 · s4 · +2 mcp')
  })

  test('groups follow a fixed kind order; top sources by tokens', () => {
    expect(groupsOf([entry('web', 'w'), entry('skill', 's'), entry('file', 'f')]).map((g) => g.kind)).toEqual([
      'skill',
      'file',
      'web',
    ])
    expect(topOf(turn)).toEqual([
      ['datadog', 20_000],
      ['files', 18_000],
      ['skill finops-custos', 3_000],
    ])
  })
})
