/**
 * The recorded CLI threshold holds the introduction's limits (`agent-handoff-source`, `intro-layered-rules` D7).
 *
 * The record (`scripts/intro-threshold.json`) is written by `npm run measure:intro` with the real CLI. This test does
 * not measure anything: it fails when the record does not show the introduction's budget, hard limit and line limit
 * reaching the agent whole, so lowering a threshold under a limit — or raising a limit over a threshold — turns red.
 * A case beyond either limit may be cut: the latent 8,000-character / 200-line cut turning on keeps it green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { DEFAULT_RECORD, introConstant } from './measure-intro-threshold.mjs'

const LIMITS = {
  budget: introConstant('INTRO_BUDGET'),
  hard: introConstant('INTRO_HARD_LIMIT'),
  lines: introConstant('INTRO_LINE_LIMIT'),
}

/** The problems with a record, or an empty list. */
export function recordProblems(record, limits = LIMITS) {
  const problems = []
  const cases = Array.isArray(record?.cases) ? record.cases : []
  if (!record?.cliVersion) problems.push('no CLI version')
  const has = (pred, what) => {
    if (!cases.some(pred)) problems.push(`no ${what} case`)
  }
  has((c) => c.chars === limits.budget && c.lines <= limits.lines, `budget (${limits.budget} characters)`)
  has((c) => c.chars === limits.hard && c.lines <= limits.lines, `hard limit (${limits.hard} characters)`)
  has((c) => c.lines === limits.lines && c.chars <= limits.hard, `line limit (${limits.lines} lines)`)
  for (const c of cases) {
    if (c.chars <= limits.hard && c.lines <= limits.lines && c.whole !== true) {
      problems.push(`${c.chars} characters on ${c.lines} lines is within both limits but was cut`)
    }
  }
  return problems
}

const record = JSON.parse(readFileSync(DEFAULT_RECORD, 'utf8'))

test('the recorded measurement holds the introduction\'s limits', () => {
  assert.deepEqual(recordProblems(record), [], `run \`npm run measure:intro\` (recorded with Claude Code ${record.cliVersion})`)
})

// Control groups: each mutation of the real record must turn it red, or green where the spec says green.
const mutate = (fn) => {
  const copy = structuredClone(record)
  fn(copy)
  return copy
}
const red = [
  ['the hard-limit case removed', (r) => (r.cases = r.cases.filter((c) => c.chars !== LIMITS.hard))],
  ['the hard-limit case cut', (r) => (r.cases.find((c) => c.chars === LIMITS.hard).whole = false)],
  ['the line-limit case cut', (r) => (r.cases.find((c) => c.lines === LIMITS.lines).whole = false)],
  ['the budget case removed', (r) => (r.cases = r.cases.filter((c) => c.chars !== LIMITS.budget))],
]
for (const [label, fn] of red) {
  test(`control: ${label} → red`, () => assert.notDeepEqual(recordProblems(mutate(fn)), []))
}
const green = [
  ['201 lines cut (the latent line cut turned on)', (r) => (r.cases.find((c) => c.lines === 201).whole = false)],
  ['8,001 characters cut (the latent character cut turned on)', (r) => (r.cases.find((c) => c.chars === 8001).whole = false)],
  ['the informational two-hook case cut', (r) => r.informational.forEach((c) => (c.whole = false))],
]
for (const [label, fn] of green) {
  test(`control: ${label} → green`, () => assert.deepEqual(recordProblems(mutate(fn)), []))
}
