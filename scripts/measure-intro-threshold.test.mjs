/**
 * The threshold measurement (`intro-layered-rules` design D7), driven with a stand-in CLI: it records only a run it
 * can trust, and the run it records is what the real CLI is asked.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildContext, cases, childEnv, cliVersion, introConstant, measure } from './measure-intro-threshold.mjs'

const STUB = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'stub-claude-threshold.mjs')
const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'measure-intro-'))
  dirs.push(dir)
  return dir
}

/** Runs `measure` with the stub in a mode; returns the outcome and the record path. */
function run(mode, { previous } = {}) {
  const dir = tmp()
  const record = join(dir, 'record.json')
  if (previous) writeFileSync(record, previous)
  const argvLog = join(dir, 'argv.log')
  const saved = { ...process.env }
  Object.assign(process.env, { STUB_MODE: mode, STUB_ARGV_LOG: argvLog, STUB_VERSION: '2.1.319' })
  try {
    const out = measure({ cli: STUB, record, log: () => {} })
    return { out, record, argvLog }
  } catch (error) {
    return { error, record, argvLog }
  } finally {
    for (const key of ['STUB_MODE', 'STUB_ARGV_LOG', 'STUB_VERSION']) {
      if (key in saved) process.env[key] = saved[key]
      else delete process.env[key]
    }
  }
}

test('a context has exactly the asked characters and lines, starting and ending with the markers', () => {
  for (const [chars, lines] of [[200, 1], [7900, 3], [1520, 190], [10001, 3]]) {
    const text = buildContext(chars, lines, 'START-aa', 'END-bb')
    assert.equal(text.length, chars)
    assert.equal(text.split('\n').length, lines)
    assert.ok(text.startsWith('START-aa') && text.endsWith('END-bb'))
  }
})

test('the cases come from the introduction\'s exported limits', () => {
  const byLabel = Object.fromEntries(cases().map((c) => [c.label, c]))
  assert.equal(byLabel.budget.chars, introConstant('INTRO_BUDGET'))
  assert.equal(byLabel['hard limit'].chars, introConstant('INTRO_HARD_LIMIT'))
  assert.equal(byLabel['line limit'].lines, introConstant('INTRO_LINE_LIMIT'))
  assert.equal(byLabel['past the latent character cut'].chars, 8001)
  assert.equal(byLabel['past the latent line cut'].lines, 201)
  assert.equal(byLabel['negative control'].chars, 10001)
})

test('a normal run records every case, the version and the informational case apart', () => {
  const { out, record, error } = run('threshold:10000')
  assert.equal(error, undefined, error?.message)
  const written = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(written, out)
  assert.equal(written.cliVersion, '2.1.319')
  assert.equal(written.cases.find((c) => c.chars === 10000).whole, true)
  assert.equal(written.cases.find((c) => c.chars === 10001).whole, false)
  assert.equal(written.informational.length, 1)
  assert.equal(written.informational[0].hooks, 2)
})

test('the CLI is asked with no tools and no session persistence, in print mode with haiku', () => {
  const { argvLog } = run('threshold:10000')
  const calls = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((a) => a[0] !== '--version')
  assert.ok(calls.length >= cases().length)
  for (const argv of calls) {
    assert.equal(argv[argv.indexOf('--tools') + 1], '', '--tools ""')
    assert.ok(argv.includes('--no-session-persistence'))
    assert.ok(argv.includes('-p'))
    assert.equal(argv[argv.indexOf('--model') + 1], 'haiku')
  }
})

const PREVIOUS = '{"cliVersion":"0.0.1"}\n'
const refused = [
  ['the negative control arrives whole: the threshold moved', 'threshold:20000', /threshold moved/],
  ['the positive control does not arrive: the hook did not fire', 'blind', /neither marker|positive control/],
  ['the CLI exits with an error on the negative control', 'exit', /exited with 1/],
  ['the negative control returns neither marker', 'silent', /neither marker came back/],
]
for (const [label, mode, pattern] of refused) {
  test(`${label}: the run fails and the record is unchanged`, () => {
    const { error, record } = run(mode, { previous: PREVIOUS })
    assert.ok(error, 'the run failed')
    assert.match(error.message, pattern)
    assert.equal(readFileSync(record, 'utf8'), PREVIOUS)
  })
}

test('a lazy reply is asked again: a case whose end marker comes back on a later attempt is whole', () => {
  const dir = tmp()
  process.env.STUB_COUNTER = join(dir, 'counter')
  try {
    const { out, error } = run('flaky')
    assert.equal(error, undefined, error?.message)
    assert.equal(out.cases.find((c) => c.chars === 10000).whole, true)
    assert.equal(out.cases.find((c) => c.chars === 10001).whole, false)
  } finally {
    delete process.env.STUB_COUNTER
  }
})

test('no record is created by a failed run', () => {
  const dir = tmp()
  const record = join(dir, 'record.json')
  process.env.STUB_MODE = 'threshold:20000'
  try {
    assert.throws(() => measure({ cli: STUB, record, log: () => {} }))
  } finally {
    delete process.env.STUB_MODE
  }
  assert.equal(existsSync(record), false)
})

test('the version is the semver at the start of --version, and the nested-session variables are stripped', () => {
  assert.equal(cliVersion(STUB), process.env.STUB_VERSION ?? '2.1.319')
  assert.equal(cliVersion(join(tmp(), 'missing')), null)
  const env = childEnv({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_PID: '1', SPEKTERM_HANDOFF_DIR: '/x', HOME: '/h', ANTHROPIC_API_KEY: 'k' })
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME'])
})
