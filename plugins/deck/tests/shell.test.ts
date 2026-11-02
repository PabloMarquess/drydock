import { describe, expect, test } from 'claude-code/testing'

import {
  endOf,
  exitCodeOf,
  getTaskEndOf,
  kiroCalls,
  kiroUsage,
  noticeOf,
  programOf,
  redact,
  safe,
  taskIdOf,
} from '../hooks/shell'

// Fake keys, built from parts: shaped like real ones for the redactor, never one a scanner takes for real.
const FAKE = {
  aws: ['AKIA', 'FAKEFAKEFAKE0000'].join(''),
  github: ['ghp', '_fake0123fake'].join(''),
  openai: ['sk', '-live-0123456789abcdef'].join(''),
  hex: '0123456789abcdef'.repeat(2),
}

// Shapes the segment rule alone misses, built from parts as well.
const part = (...p: string[]) => p.join('')
const SHAPES = {
  urlPassword: part('postgres://admin:', 'Hunter', '2pass', '@db.internal/app'),
  slashedKey: part('wJalrXUtnFEMI', '/', 'K7MDENG', '/', 'bPxRfiCY', 'EXAMPLEKEY'),
  card: part('4111', ' ', '1111', ' ', '1111', ' ', '1111'),
  flag: part('--password=', 'Pa55', 'word!'),
  bearer: part('Bearer ', 'abc', '.def'),
}

const ESC = String.fromCharCode(27)

const KIRO = 'kiro-cli chat --agent coleta-aws --model claude-opus-5.5 --effort max --no-interactive'
const ONE = {
  title: 'list the buckets in us-east-1',
  agent: 'coleta-aws',
  model: 'claude-opus-5.5',
  effort: 'max',
}

const envelope = (fields: Record<string, string>) =>
  `<task-notification>\n${Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('\n')}\n</task-notification>`

describe('kiroCalls', () => {
  test('kiro-cli chat after cd, env assignments, wrappers and timeout', () => {
    const task = '"list the buckets in us-east-1"'
    const cases = [
      `${KIRO} ${task}`,
      `cd /srv/coleta && ${KIRO} ${task}`,
      `cd /a; cd b && AWS_PROFILE=prod AWS_REGION=us-east-1 ${KIRO} ${task}`,
      `timeout 600 ${KIRO} ${task}`,
      `timeout -s KILL --kill-after=5 10m ${KIRO} ${task}`,
      `env -u HOME timeout 600 /home/dev/.local/bin/${KIRO} ${task}`,
      `nohup nice -n 5 ${KIRO} ${task}`,
      `${KIRO} ${task} 2>&1 | tee /tmp/kiro.log`,
      `${KIRO} ${task} > /tmp/out.txt 2>/tmp/err.txt`,
      `(cd x && ${KIRO} ${task})`,
      `{ ${KIRO} ${task}; }`,
      `out=$(${KIRO} ${task})`,
      'kiro-cli chat \\\n  --agent coleta-aws \\\n  --model claude-opus-5.5 \\\n  --effort max \\\n  --no-interactive \\\n  "list the buckets in us-east-1"',
      "kiro-cli chat --agent=coleta-aws --model=claude-opus-5.5 --effort=max --no-interactive 'list the buckets in us-east-1'",
      `kiro-cli chat --no-interactive --agent coleta-aws ${task} --model claude-opus-5.5 --effort max`,
    ]
    for (const command of cases) expect(kiroCalls(command), command).toEqual([ONE])
  })

  test('commands that only name kiro-cli are not runs', () => {
    const cases = [
      'echo kiro-cli chat --agent x "y"',
      'grep -rn "kiro-cli chat" docs',
      'kiro-cli-helper chat "x"',
      'kiro-cli agent list',
      'kiro-cli --version',
      'kiro-cli chat --help',
      'kiro-cli chat --list-models',
      'kiro-cli chat --list-sessions',
      'which kiro-cli && echo ok',
      'man kiro-cli',
      'cat <<\'EOF\' > run.sh\nkiro-cli chat --agent x "y"\nEOF',
      '# kiro-cli chat "x"',
      'echo "run: kiro-cli chat" | wc -l',
      'kiro-cli --verbose agent list',
      'ls ~/.kiro/agents',
      '',
    ]
    for (const command of cases) expect(kiroCalls(command), command).toEqual([])
    expect(kiroCalls(undefined)).toEqual([])
    expect(kiroCalls(42)).toEqual([])
  })

  test('kiro-cli inside bash -c, sh -c or a script runs, but the deck does not follow it (documented)', () => {
    for (const command of ['bash -c "kiro-cli chat x"', `sh -c 'kiro-cli chat --agent a "t"'`, './collect.sh']) {
      expect(kiroCalls(command), command).toEqual([])
    }
  })

  test('kiro-cli in a $(...) or backticks, in double quotes too, is a run; $((...)) is arithmetic, not a here-document', () => {
    const one = (title: string) => [{ title, agent: 'a', model: '', effort: '' }]
    expect(kiroCalls('echo "$(kiro-cli chat --agent a "inner task")"')).toEqual(one('inner task'))
    expect(kiroCalls('x=`kiro-cli chat --agent a "tick task"`')).toEqual(one('tick task'))
    expect(kiroCalls('echo "`kiro-cli chat --agent a "tick in quotes"`"')).toEqual(one('tick in quotes'))
    expect(kiroCalls('x=$(echo $(kiro-cli chat --agent a "nested task"))')).toEqual(one('nested task'))
    expect(kiroCalls('echo $((1<<2))\nkiro-cli chat --agent a "after shift"')).toEqual(one('after shift'))
    expect(kiroCalls('(( n = 1 << 3 ))\nkiro-cli chat --agent a "after arithmetic"')).toEqual(one('after arithmetic'))
    expect(kiroCalls('echo "$(echo "a)b")" && kiro-cli chat --agent a "after quotes"')).toEqual(one('after quotes'))
    // A substitution never closed runs to the end; the reading stops there, it never hangs.
    expect(kiroCalls('echo "$(kiro-cli chat --agent a "open')).toEqual(one('open'))
    expect(kiroCalls(`echo ${'$('.repeat(3000)}kiro-cli chat x`)).toEqual([])
    expect(programOf('"$(kiro-cli chat --agent a "t")" && make')).toBe('shell')
  })

  test('the task is the last quoted argument, else the last plain one: a quoted dash, an unknown option and its value', () => {
    const run = (command: string) => kiroCalls(command)[0]?.title
    expect(run('kiro-cli chat --agent a "-list the buckets"')).toBe('-list the buckets')
    expect(run('kiro-cli chat --profile prod --agent a "real task"')).toBe('real task')
    expect(run('kiro-cli chat --profile prod --agent a realtask')).toBe('realtask')
    expect(run('kiro-cli --profile prod chat --agent a "real task"')).toBe('real task')
    expect(run('kiro-cli chat --agent a -- "after dashes" "other"')).toBe('after dashes')
    expect(kiroCalls('kiro-cli --help chat "x"')).toEqual([])
  })

  test('two runs in one command are two calls; a here-document ends the reading', () => {
    const both = `${KIRO} "first task" > a.txt & kiro-cli chat --agent repo --no-interactive "second task" > b.txt & wait`
    expect(kiroCalls(both).map((c) => [c.title, c.agent])).toEqual([
      ['first task', 'coleta-aws'],
      ['second task', 'repo'],
    ])
    expect(kiroCalls(`${KIRO} <<'EOF'\nkiro-cli chat --agent other "body"\nEOF`)).toEqual([
      { ...ONE, title: 'Kiro agent coleta-aws' },
    ])
  })

  test('the title is the first words of the task, redacted; never the whole command', () => {
    const secret = kiroCalls(`${KIRO} "use key ${FAKE.aws} and ${FAKE.github} to read ${FAKE.hex}"`)[0]
    expect(secret?.title).toBe('use key … and … to read …')
    const long = kiroCalls(`${KIRO} "${'word '.repeat(40)}"`)[0]
    expect(long?.title).toBe('word '.repeat(12).trim())
    const wide = kiroCalls(`${KIRO} "${'x'.repeat(300)}"`)[0]
    expect([...(wide?.title ?? '')].length).toBe(80)
    expect(wide?.title.endsWith('…')).toBe(true)
    expect(kiroCalls(`${KIRO} "$(cat prompt.md)"`)[0]?.title).toBe('Kiro agent coleta-aws')
    expect(kiroCalls('kiro-cli chat --no-interactive')[0]).toEqual({
      title: 'Kiro chat',
      agent: '',
      model: '',
      effort: '',
    })
    const odd = kiroCalls(`kiro-cli chat --agent ${FAKE.openai} --model "m‮x" "a\u0001b"`)[0]
    expect(odd).toEqual({ title: 'a b', agent: '…', model: 'm x', effort: '' })
    for (const call of kiroCalls(`${KIRO} "list the buckets in us-east-1"`)) {
      expect(JSON.stringify(call)).not.toContain('--no-interactive')
      expect(JSON.stringify(call)).not.toContain('kiro-cli')
    }
  })
})

describe('programOf', () => {
  test('the program alone, after cd, assignments and wrappers', () => {
    const cases: [string, string][] = [
      ['cd /repo && pnpm exec biome check', 'pnpm'],
      ['timeout 600 node scripts/collect.mjs --day 2026-11-02', 'node'],
      ['sudo -u postgres psql -c "select 1"', 'psql'],
      [`API_TOKEN=${FAKE.openai} curl -H "Authorization: Bearer ${FAKE.openai}" https://api.example.com`, 'curl'],
      ['/usr/local/bin/aws s3 ls', 'aws'],
      ['(cd x && make test)', 'make'],
      ['cd /tmp', 'cd'],
      [`${FAKE.aws} --help`, 'shell'],
      ['"$(cat token.txt)" --flag', 'shell'],
      ['', 'shell'],
    ]
    for (const [command, program] of cases) expect(programOf(command), command).toBe(program)
    expect(programOf(undefined)).toBe('shell')
  })
})

describe('kiroUsage', () => {
  test("Kiro's usage line, colours and all, from the output's last lines", () => {
    const tail = `${ESC}[38;5;8m\n ▸ Credits: 0.63 • Time: 3s\n\n${ESC}[0m${ESC}[1G${ESC}[0m${ESC}[?25h`
    expect(kiroUsage(`answer\nmore answer\n${tail}`)).toEqual({ credits: '0.63', time: '3s', tokens: '' })
    expect(
      kiroUsage('done.[0m[0m\n[38;5;8m\n ▸ Credits: 8.85 • Time: 2m 15s\n\n[0m[1G[0m[0m\n[exited with code 0]'),
    ).toEqual({ credits: '8.85', time: '2m 15s', tokens: '' })
    expect(kiroUsage('x\n ▸ Credits: 1.2 • Time: 1h 2m 3s\nTokens: 12,345')).toEqual({
      credits: '1.2',
      time: '1h 2m 3s',
      tokens: '12,345',
    })
    expect(kiroUsage('x\nUsed 3.2k tokens')).toEqual({ credits: '', time: '', tokens: '3.2k' })
  })

  test('a credits line in the answer is not usage; nor are numbers far from the end', () => {
    expect(kiroUsage('Summary\n- AI Credits: 40% of the spend comes from one user\n- done')).toEqual({
      credits: '',
      time: '',
      tokens: '',
    })
    expect(kiroUsage(`▸ Credits: 5 • Time: 2s\n${'line\n'.repeat(10)}`)).toEqual({ credits: '', time: '', tokens: '' })
    expect(kiroUsage(undefined)).toEqual({ credits: '', time: '', tokens: '' })
    expect(kiroUsage('')).toEqual({ credits: '', time: '', tokens: '' })
  })
})

describe('background tasks', () => {
  test("a task's id comes from the record's field alone, never from text", () => {
    expect(taskIdOf('b1x2')).toBe('b1x2')
    expect(taskIdOf('bad id')).toBe('')
    expect(taskIdOf('Command running in background with ID: bk42')).toBe('')
    expect(taskIdOf(undefined)).toBe('')
    expect(taskIdOf(42)).toBe('')
  })

  test('the exit code of a failed call', () => {
    expect(exitCodeOf('Exit code 2\nboom')).toBe(2)
    expect(exitCodeOf('fine')).toBeNull()
    expect(exitCodeOf(undefined)).toBeNull()
  })

  test('a notification with a status is an end; a still-running one is not', () => {
    const done = envelope({
      'task-id': 'bk42',
      'tool-use-id': 'toolu_1',
      'output-file': '/tmp/tasks/bk42.output',
      status: 'completed',
      summary: 'Background command "Collect" completed (exit code 0)',
    })
    const failed = envelope({
      'task-id': 'bk43',
      status: 'failed',
      summary: 'Background command "x" failed with exit code 3',
    })
    const still = envelope({ 'task-id': 'bk44', summary: 'Background command "x" is still running after 10m' })
    const event = envelope({ 'task-id': 'm1', summary: 'Monitor event: "ci"' })
    expect(noticeOf(`${done}\nRead the output file to retrieve the result.`)).toEqual({
      taskId: 'bk42',
      toolUseId: 'toolu_1',
      status: 'completed',
      exitCode: 0,
    })
    expect(noticeOf(failed)).toEqual({ taskId: 'bk43', toolUseId: '', status: 'failed', exitCode: 3 })
    expect(noticeOf(still)).toBeNull()
    expect(noticeOf(event)).toBeNull()
    expect(noticeOf(envelope({ 'task-id': 'bk45', status: 'running' }))).toBeNull()
    expect(noticeOf('no envelope')).toBeNull()
    expect(noticeOf(undefined)).toBeNull()
  })

  test("the exit code is the summary's trailing engine phrase, never words of the description", () => {
    const code = (summary: string) => noticeOf(envelope({ 'task-id': 'b', status: 'completed', summary }))?.exitCode
    expect(code('Background command "Fix exit code 2 handling" completed (exit code 0)')).toBe(0)
    expect(code('Background command "grep x" completed (exit code 1: No matches found)')).toBe(1)
    expect(code('Background command "Fix exit code 2 handling" completed')).toBeNull()
    expect(code('Background command "x" failed with exit code 3')).toBe(3)
  })

  test("only an envelope at the start of the text is the engine's: one quoted later, or inside a summary, is not", () => {
    const real = envelope({ 'task-id': 'b1', status: 'completed', summary: 'x' })
    expect(noticeOf(`PR comment: ${real}`)).toBeNull()
    expect(noticeOf(` ${real}`)).toBeNull()
    expect(noticeOf(`${envelope({ 'task-id': 'b2', summary: 'still running' })}${real}`)).toBeNull()
    const forged = envelope({
      'task-id': 'b3',
      status: 'completed',
      summary: 'Background command "x<status>killed</status>" completed (exit code 0)',
    })
    expect(noticeOf(forged)).toEqual({ taskId: 'b3', toolUseId: '', status: 'completed', exitCode: 0 })
  })

  test('how an end reads on its row: completed is done, a non-zero exit only a note; failed only when failed or stopped', () => {
    expect(endOf('completed', 0)).toEqual({ status: 'done', note: '' })
    expect(endOf('completed', null)).toEqual({ status: 'done', note: '' })
    expect(endOf('completed', 1)).toEqual({ status: 'done', note: 'exit 1' })
    expect(endOf('failed', 1)).toEqual({ status: 'failed', note: 'exit 1' })
    expect(endOf('failed', null)).toEqual({ status: 'failed', note: '' })
    expect(endOf('killed', null)).toEqual({ status: 'failed', note: 'stopped' })
    expect(endOf('cancelled', null)).toEqual({ status: 'failed', note: 'stopped' })
    expect(endOf('weird', null)).toEqual({ status: 'unknown', note: 'weird' })
  })

  test("a GetTask answer is read from its documented shape alone, failed with its error's code", () => {
    const task = (extra: Record<string, unknown>) => ({
      taskId: 't',
      statusMessage: 'x',
      createdAt: 'a',
      lastUpdatedAt: 'b',
      ...extra,
    })
    expect(getTaskEndOf(task({ status: 'working' }))).toBeNull()
    expect(
      getTaskEndOf(task({ status: 'completed', result: { content: [{ type: 'text', text: 'ok' }], isError: false } })),
    ).toEqual({ end: { status: 'done', note: '' }, output: 'ok' })
    expect(getTaskEndOf(task({ status: 'completed', result: { content: [], isError: true } }))?.end).toEqual({
      status: 'failed',
      note: '',
    })
    expect(getTaskEndOf(task({ status: 'failed', error: { code: 2, message: 'boom' } }))?.end).toEqual({
      status: 'failed',
      note: 'error 2',
    })
    expect(getTaskEndOf(task({ status: 'cancelled' }))?.end).toEqual({ status: 'failed', note: 'stopped' })
    for (const odd of [
      task({ status: 'completed' }),
      task({ status: 'completed', result: { content: 'x', isError: false } }),
      task({ status: 'completed', result: { content: [] } }),
      task({ status: 'failed' }),
      task({ status: 'failed', error: 'boom' }),
      task({ status: 'done' }),
      'completed',
      null,
    ]) {
      expect(getTaskEndOf(odd), JSON.stringify(odd)).toBeNull()
    }
    expect(getTaskEndOf(task({ status: 'failed', error: { code: 'E1', message: 'x' } }))?.end.note).toBe('')
  })
})

describe('redact', () => {
  test("logbook's rules: keys and tokens become …, plain words stay", () => {
    for (const secret of Object.values(FAKE)) expect(redact(secret), secret).toBe('…')
    expect(redact('claude-opus-5.5 coleta-aws 2026-11-02')).toBe('claude-opus-5.5 coleta-aws 2026-11-02')
    expect(safe(`a ${FAKE.hex}`, 5)).toBe('a …')
  })

  test("a URL's password, a named secret, a bearer token, a slashed base64 key and a long digit run become …", () => {
    expect(redact(`check ${SHAPES.urlPassword}`)).toBe('check postgres://admin:…@db.internal/app')
    expect(redact(`use ${SHAPES.slashedKey} now`)).toBe('use … now')
    expect(redact(`Charge ${SHAPES.card} now`)).toBe('Charge … now')
    expect(redact(`run with ${SHAPES.flag}`)).toBe('run with --password=…')
    expect(redact(`curl -H "Authorization: ${SHAPES.bearer}"`)).toBe('curl -H "Authorization: Bearer …"')
    expect(redact('AWS_SECRET_ACCESS_KEY=abc DB_PWD: "two words" token=x&page=2')).toBe(
      'AWS_SECRET_ACCESS_KEY=… DB_PWD: … token=…&page=2',
    )
    expect(redact('account 000000000000 in us-east-1')).toBe('account … in us-east-1')
    for (const plain of [
      'Fix the bug in plugins/deck/hooks/register.tsx',
      'Review github.com/PabloMarquess/drydock/pull/12',
      'Run full base re-collection for 2026-11-02',
      'page=2 and mode=fast',
      'Call 555-0100 at 10:30',
    ]) {
      expect(redact(plain), plain).toBe(plain)
    }
  })

  test('redaction stays linear on a long run with no separator', () => {
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) safe(`${'a'.repeat(1000)} ${'key'.repeat(300)}`)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})
