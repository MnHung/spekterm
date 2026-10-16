import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cancelCommandEnd,
  expectCommandEnd,
  lastProcessChangeAt,
  noteProcessEnd,
  noteProcessStart,
  resetSessionRuns,
  runStartedAt,
} from './session-runs'

test('starts and ends are recorded per session, process-wide', () => {
  resetSessionRuns(100)
  assert.equal(runStartedAt(), 100)
  assert.equal(lastProcessChangeAt('s'), null)
  noteProcessStart('s', 200)
  assert.equal(lastProcessChangeAt('s'), 200)
  noteProcessEnd('s', 300)
  assert.equal(lastProcessChangeAt('s'), 300)
})

test("an end a command caused does not count, and a cancelled one does not swallow the user's", () => {
  resetSessionRuns(100)
  noteProcessStart('s', 200)
  expectCommandEnd('s')
  noteProcessEnd('s', 300)
  assert.equal(lastProcessChangeAt('s'), 200)
  // The next end is the user's again.
  noteProcessEnd('s', 400)
  assert.equal(lastProcessChangeAt('s'), 400)
  expectCommandEnd('s')
  cancelCommandEnd('s')
  noteProcessEnd('s', 500)
  assert.equal(lastProcessChangeAt('s'), 500)
})
