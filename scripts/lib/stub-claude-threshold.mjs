#!/usr/bin/env node
/**
 * A stand-in `claude` for `scripts/measure-intro-threshold.test.mjs` and `scripts/intro-threshold-check.test.mjs`.
 *
 * `--version` prints `STUB_VERSION` the way the real CLI does (`<version> (Claude Code)` and more). Otherwise it reads
 * `--settings`, runs each `SessionStart` hook command as the CLI would, and replies with the markers of each context
 * that "arrived", by the rule in `STUB_MODE`:
 *
 * - `threshold:<n>` — a context of at most n characters arrives whole; a longer one keeps only its start (a preview);
 * - `exit` — exits 1 when a context is longer than 10,000 characters (an API failure on the negative control);
 * - `silent` — replies NONE when a context is longer than 10,000 characters;
 * - `blind` — no context arrives (the hook did not fire);
 * - `flaky` — as `threshold:10000`, but every other call replies NONE (a lazy model), counted in `STUB_COUNTER`.
 *
 * Its argv is appended to `STUB_ARGV_LOG`, one JSON line per call, when set.
 */
import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.STUB_ARGV_LOG) appendFileSync(process.env.STUB_ARGV_LOG, `${JSON.stringify(argv)}\n`)
if (argv[0] === '--version') {
  process.stdout.write(`${process.env.STUB_VERSION ?? '2.1.319'} (Claude Code)\n`)
  process.exit(0)
}

const settings = JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'))
const contexts = settings.hooks.SessionStart.flatMap((entry) => entry.hooks).map(
  (hook) => JSON.parse(execSync(hook.command, { encoding: 'utf8' })).hookSpecificOutput.additionalContext,
)
const mode = process.env.STUB_MODE ?? 'threshold:10000'
if (mode === 'flaky') {
  const counter = process.env.STUB_COUNTER
  const calls = counter && existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  if (counter) writeFileSync(counter, String(calls + 1))
  if (calls % 2 === 0) {
    process.stdout.write('NONE\n')
    process.exit(0)
  }
}
const seen = []
for (const text of contexts) {
  const [start] = /START-[0-9a-f]+/.exec(text) ?? []
  const [end] = /END-[0-9a-f]+/.exec(text) ?? []
  if (mode === 'blind') continue
  if (text.length > 10_000 && mode === 'exit') process.exit(1)
  if (text.length > 10_000 && mode === 'silent') continue
  const limit = mode.startsWith('threshold:') ? Number(mode.slice('threshold:'.length)) : 10_000
  seen.push(start)
  if (text.length <= limit) seen.push(end)
}
process.stdout.write(seen.length > 0 ? `${seen.join(' ')}\n` : 'NONE\n')
