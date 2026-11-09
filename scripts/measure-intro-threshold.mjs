#!/usr/bin/env node
/**
 * Measures how much injected `SessionStart` context reaches the agent whole with the installed Claude Code, and
 * records it in `scripts/intro-threshold.json` (`agent-handoff-source`, `intro-layered-rules` design D7).
 *
 * ## Why it exists
 *
 * The introduction spekterm injects is cut by the CLI, not by spekterm: past a threshold (10,000 characters when
 * last measured) the whole context is replaced by a file pointer and a ~2,000-character preview, and the binary
 * carries a further cut at 8,000 characters / 200 lines that did not apply. Any CLI release can move either, and
 * nothing turns red when it does — the agent just loses the rules after the cut. So the threshold is measured by this
 * script, recorded with the CLI version, held under the introduction's limits by `scripts/intro-threshold.test.mjs`,
 * and `scripts/intro-threshold-check.mjs` refuses a release whose CLI differs from the recorded one.
 *
 * ## How
 *
 * For each case, a context of an exact character and line count, with a random marker at its very start and another
 * at its very end, is injected the way spekterm injects the introduction: a temporary `--settings` file whose
 * `SessionStart` hook `cat`s a `hookSpecificOutput` JSON. `claude -p` runs in an empty temporary directory with
 * **no tools** (so it cannot read the file behind a preview and report the end marker anyway) and **no session
 * persistence** (no transcript lands in `~/.claude/projects`, which the app's conversation insights scan), and is
 * asked to repeat the markers it sees. The markers are random, so an end marker in a reply proves the end arrived.
 *
 * Haiku sometimes answers NONE although both markers reached it (measured 2026-11-09: 2 of 5 runs of a case whose
 * markers both arrived), and could as well leave one out. So each case is asked up to `ATTEMPTS` times: an end marker
 * in any reply is whole; a start marker in some reply and no end marker in any is cut; neither in any reply fails the
 * run, as a non-zero exit does at once — an API or network failure is not a cut, and counting it as one could hide the
 * negative control.
 *
 * The nested-session variables are stripped (`docs/lessons/handoff.md` §11): a claude started inside a claude
 * session behaves differently.
 *
 * It needs the network and costs a few cents, so it is never part of `npm test` or `test:e2e`.
 *
 * Usage: `npm run measure:intro [-- --cli <path>] [--record <path>]`
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_RECORD = join(repoRoot, 'scripts', 'intro-threshold.json')

/** A limit exported by `src/main/handoff-intro.ts`, read from source (scripts cannot import TypeScript). */
export function introConstant(name) {
  const source = readFileSync(join(repoRoot, 'src', 'main', 'handoff-intro.ts'), 'utf8')
  const match = source.match(new RegExp(`export const ${name} = ([0-9_]+)`))
  if (!match) throw new Error(`src/main/handoff-intro.ts has no ${name}`)
  return Number(match[1].replace(/_/g, ''))
}

/** The latent cut the CLI binary carries (`docs/lessons/handoff.md` §16). */
export const LATENT_CHARS = 8_000
export const LATENT_LINES = 200
/** The threshold last measured, and its control. */
export const THRESHOLD = 10_000

/** Few lines: a character case is measured on this many, far from the line limits. */
const FEW = 3

/** The cases the record must hold (`role` says which ones decide the run). */
export function cases() {
  const budget = introConstant('INTRO_BUDGET')
  const hard = introConstant('INTRO_HARD_LIMIT')
  const lines = introConstant('INTRO_LINE_LIMIT')
  return [
    { label: 'positive control', chars: 200, lines: 1, role: 'positive' },
    { label: 'budget', chars: budget, lines: FEW, role: 'budget' },
    { label: 'hard limit', chars: hard, lines: FEW, role: 'hard' },
    { label: 'line limit', chars: lines * 8, lines, role: 'lines' },
    { label: 'past the latent character cut', chars: LATENT_CHARS + 1, lines: FEW, role: 'probe' },
    { label: 'past the latent line cut', chars: (LATENT_LINES + 1) * 8, lines: LATENT_LINES + 1, role: 'probe' },
    { label: 'the threshold', chars: THRESHOLD, lines: FEW, role: 'probe' },
    { label: 'negative control', chars: THRESHOLD + 1, lines: FEW, role: 'negative' },
  ]
}

/** Cases recorded only to learn something; never asserted. */
export const INFORMATIONAL = [{ label: 'two hooks of 6,000 characters each', chars: 6_000, lines: FEW, hooks: 2 }]

function marker(kind) {
  return `${kind}-${randomBytes(6).toString('hex')}`
}

/**
 * A context of exactly `chars` characters and `lines` lines (`split('\n').length`, as the CLI and `introText` count),
 * starting with `start` and ending with `end`.
 */
export function buildContext(chars, lines, start, end) {
  const head = `${start} `
  const tail = ` ${end}`
  const fillTotal = chars - head.length - tail.length - (lines - 1)
  if (fillTotal < lines) throw new Error(`a case of ${chars} characters cannot have ${lines} lines`)
  const per = Math.floor(fillTotal / lines)
  const parts = Array.from({ length: lines }, (_, i) => 'x'.repeat(i === lines - 1 ? fillTotal - per * (lines - 1) : per))
  parts[0] = head + parts[0]
  parts[lines - 1] = parts[lines - 1] + tail
  const text = parts.join('\n')
  if (text.length !== chars || text.split('\n').length !== lines) throw new Error('context shape mismatch')
  return text
}

/** The child's environment: the nested-session variables and spekterm's own removed. */
export function childEnv(env = process.env) {
  const out = { ...env }
  for (const key of Object.keys(out)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_JOB_DIR') delete out[key]
    else if (key.startsWith('CLAUDE_CODE_') || key.startsWith('SPEKTERM_')) delete out[key]
  }
  return out
}

/** The CLI's version: the semver at the start of `--version` (`<version> (Claude Code)` and more). */
export function cliVersion(cli) {
  const result = spawnSync(cli, ['--version'], { encoding: 'utf8', env: childEnv() })
  if (result.error || result.status !== 0) return null
  return /^\s*(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null
}

export const PROMPT =
  'The SessionStart hook context you were given is filler between two codes: one at its very beginning that looks like ' +
  'START-xxxxxxxxxxxx and one at its very end that looks like END-xxxxxxxxxxxx (12 hex digits each). ' +
  'Look at the beginning and at the end of that context. Reply with every such code you can see, separated by spaces, ' +
  'and nothing else. Reply NONE only if you see no such code at all.'

/** How many times a case is asked before an absent end marker counts as a cut. */
export const ATTEMPTS = 3

export const ARGS = ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence']

/** Asks the CLI once; returns the reply, or throws when the CLI failed. */
function ask(cli, hooks) {
  const dir = mkdtempSync(join(tmpdir(), 'intro-threshold-'))
  try {
    const commands = hooks.map((context, i) => {
      const file = join(dir, `hook-${i}.json`)
      writeFileSync(file, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.text } }))
      return { type: 'command', command: `cat '${file}'` }
    })
    const settings = join(dir, 'settings.json')
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: commands }] } }))
    // An empty working directory: no project CLAUDE.md or settings join the context.
    const work = join(dir, 'work')
    mkdirSync(work)
    const result = spawnSync(cli, [...ARGS, '--settings', settings, PROMPT], {
      cwd: work,
      env: childEnv(),
      encoding: 'utf8',
      timeout: 180_000,
    })
    if (result.error) throw new Error(`the CLI could not run: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`the CLI exited with ${result.status}: ${(result.stderr || result.stdout).slice(0, 500)}`)
    return result.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Runs one case (up to `ATTEMPTS` times); returns `{ whole, attempts }` or throws when the run cannot be trusted. */
function runCase(cli, hooks) {
  const endsSeen = hooks.map(() => false)
  let startSeen = false
  let last = ''
  // At most ATTEMPTS calls of at most 180 s each; the loop stops as soon as every end marker has come back.
  let attempts = 0
  for (; attempts < ATTEMPTS && !endsSeen.every(Boolean); attempts += 1) {
    last = ask(cli, hooks)
    hooks.forEach((h, i) => {
      if (last.includes(h.end)) endsSeen[i] = true
      if (last.includes(h.start)) startSeen = true
    })
  }
  if (endsSeen.every(Boolean)) return { whole: true, attempts }
  if (!startSeen && !endsSeen.some(Boolean)) {
    throw new Error(`neither marker came back in ${ATTEMPTS} attempts, which is a failure, not a cut. Last reply: ${last.slice(0, 300)}`)
  }
  return { whole: false, attempts: ATTEMPTS }
}

function hook(chars, lines) {
  const start = marker('START')
  const end = marker('END')
  return { start, end, text: buildContext(chars, lines, start, end) }
}

/**
 * Measures every case. Throws (and writes nothing) when the run cannot be trusted or the threshold moved.
 */
export function measure({ cli = 'claude', record = DEFAULT_RECORD, log = console.log } = {}) {
  const version = cliVersion(cli)
  if (!version) throw new Error(`no Claude Code found at "${cli}" (\`${cli} --version\` failed)`)
  log(`Claude Code ${version}`)
  const results = []
  for (const c of cases()) {
    const { whole } = runCase(cli, [hook(c.chars, c.lines)])
    log(`  ${c.label}: ${c.chars} characters, ${c.lines} lines → ${whole ? 'whole' : 'cut'}`)
    results.push({ label: c.label, chars: c.chars, lines: c.lines, whole, role: c.role })
  }
  const positive = results.find((r) => r.role === 'positive')
  if (!positive?.whole) throw new Error('the 200-character positive control did not arrive whole: the injection did not happen. Nothing recorded.')
  const negative = results.find((r) => r.role === 'negative')
  if (negative?.whole) {
    throw new Error(
      `the ${THRESHOLD + 1}-character negative control arrived whole: the threshold moved. ` +
        'Extend the measured sizes in scripts/measure-intro-threshold.mjs to find the new one, then measure again. Nothing recorded.',
    )
  }
  const informational = []
  for (const c of INFORMATIONAL) {
    const { whole } = runCase(cli, Array.from({ length: c.hooks }, () => hook(c.chars, c.lines)))
    log(`  ${c.label} → ${whole ? 'whole' : 'cut'}`)
    informational.push({ label: c.label, chars: c.chars, lines: c.lines, hooks: c.hooks, whole })
  }
  const out = {
    cliVersion: version,
    measuredAt: new Date().toISOString().slice(0, 10),
    mode: 'print',
    model: 'haiku',
    cases: results.map(({ role: _role, ...rest }) => rest),
    informational,
  }
  writeFileSync(record, `${JSON.stringify(out, null, 2)}\n`)
  log(`recorded in ${record}`)
  return out
}

function argValue(argv, name) {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    measure({ cli: argValue(process.argv, '--cli') ?? 'claude', record: argValue(process.argv, '--record') ?? DEFAULT_RECORD })
  } catch (error) {
    console.error(`measure:intro: ${error.message}`)
    process.exit(1)
  }
}
