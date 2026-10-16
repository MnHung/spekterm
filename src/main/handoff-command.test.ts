import assert from 'node:assert/strict'
import { test } from 'node:test'

import { outboxKindOf, parseCommand } from './handoff-delivery'
import { MAX_FIELD_LENGTH } from './intake-schema'

/** The session commands' shapes (`agent-session-control`, design D1). */

test('the three command kinds are told from a handoff, a report and an unknown kind', () => {
  assert.equal(outboxKindOf('{"kind":"close"}'), 'close')
  assert.equal(outboxKindOf('{"kind":"hibernate","target":"x"}'), 'hibernate')
  assert.equal(outboxKindOf('{"kind":"rename","name":"n"}'), 'rename')
  assert.equal(outboxKindOf('{"kind":"report","summary":"s"}'), 'report')
  assert.equal(outboxKindOf('{"target":"t","body":"b"}'), 'handoff')
  assert.equal(outboxKindOf('{"kind":"wake"}'), 'unknown')
  assert.equal(outboxKindOf('{"kind":["close"]}'), 'unknown')
})

test('target is optional, and a present one must be a non-empty string', () => {
  assert.deepEqual(parseCommand('close', '{"kind":"close"}'), { ok: true, command: { kind: 'close' } })
  assert.deepEqual(parseCommand('hibernate', '{"kind":"hibernate","target":"beta-1a2b"}'), {
    ok: true,
    command: { kind: 'hibernate', target: 'beta-1a2b' },
  })
  assert.deepEqual(parseCommand('close', '{"kind":"close","target":""}'), { ok: false, reason: 'FIELD_TYPE', field: 'target' })
  assert.deepEqual(parseCommand('close', '{"kind":"close","target":7}'), { ok: false, reason: 'FIELD_TYPE', field: 'target' })
})

test('a field claiming a source is not read', () => {
  const parsed = parseCommand('close', '{"kind":"close","source":"other","sessionId":"x","from":"p"}')
  assert.deepEqual(parsed, { ok: true, command: { kind: 'close' } })
})

test('a rename needs a name, flattened to one line', () => {
  assert.deepEqual(parseCommand('rename', '{"kind":"rename"}'), { ok: false, reason: 'FIELD_TYPE', field: 'name' })
  assert.deepEqual(parseCommand('rename', JSON.stringify({ kind: 'rename', name: 'Fix\n\nlogin ' })), {
    ok: true,
    command: { kind: 'rename', name: 'Fix login' },
  })
  // Empty after flattening hands naming back; it is not an error.
  assert.deepEqual(parseCommand('rename', JSON.stringify({ kind: 'rename', name: ' \n ' })), {
    ok: true,
    command: { kind: 'rename', name: '' },
  })
})

test('the name limit is counted in code points, and a longer name is refused', () => {
  const at = '😀'.repeat(MAX_FIELD_LENGTH)
  assert.equal(parseCommand('rename', JSON.stringify({ kind: 'rename', name: at })).ok, true)
  assert.deepEqual(parseCommand('rename', JSON.stringify({ kind: 'rename', name: `${at}x` })), {
    ok: false,
    reason: 'TOO_LONG',
    length: MAX_FIELD_LENGTH + 1,
  })
})
