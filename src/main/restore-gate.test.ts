import assert from 'node:assert/strict'
import { test } from 'node:test'

import { closeRestoreGate, openRestoreGate, resetRestoreGates, whenRestored } from './restore-gate'

test('a request waits for the window restore, and passes at once after it', async () => {
  resetRestoreGates()
  const waiting = whenRestored(1, 1_000)
  openRestoreGate(1)
  assert.equal(await waiting, true)
  assert.equal(await whenRestored(1, 1), true)
})

test('a reload closes the gate again, and the wait is bounded', async () => {
  resetRestoreGates()
  openRestoreGate(2)
  closeRestoreGate(2)
  assert.equal(await whenRestored(2, 20), false)
})

test('gates are per window', async () => {
  resetRestoreGates()
  openRestoreGate(3)
  assert.equal(await whenRestored(4, 20), false)
})
