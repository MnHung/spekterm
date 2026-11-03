import assert from 'node:assert/strict'
import test from 'node:test'

import { backoffDelay, closeClassOf, olderSide, outcomeOf, preAuthErrorOf } from './team-outcome'

/** Protocol v1's error codes and close codes (spekterm-server `docs/protocol.md` §3). */
const PROTOCOL_ERRORS = [
  'BAD_FRAME', 'BAD_PARAMS', 'UNKNOWN_OPERATION', 'UNSUPPORTED_VERSION', 'NOT_AUTHENTICATED', 'ALREADY_AUTHENTICATED',
  'AUTH_FAILED', 'INVITE_UNKNOWN', 'INVITE_EXPIRED', 'INVITE_USED', 'HANDLE_TAKEN', 'RECIPIENT_UNKNOWN',
  'RECIPIENT_IS_SELF', 'HANDOFF_ID_REUSED', 'RATE_LIMITED', 'HANDOFF_UNKNOWN', 'HANDOFF_EXPIRED',
  'HANDOFF_DELIVERED_ELSEWHERE', 'INTERNAL',
]
const PROTOCOL_CLOSES = [1001, 1003, 1009, 4001, 4003, 4004, 4006]

test('every protocol error code and close code is mapped by name', () => {
  for (const code of PROTOCOL_ERRORS) assert.equal(preAuthErrorOf(code), code)
  for (const code of PROTOCOL_CLOSES) assert.equal(closeClassOf(code), code)
  assert.equal(preAuthErrorOf('SOMETHING_NEW'), 'other')
  assert.equal(closeClassOf(4999), 'other')
})

const closed = (code: number, preAuthError?: string) => ({ kind: 'closed' as const, code, ...(preAuthError ? { preAuthError } : {}) })

test('the reconnect table, row by row', () => {
  const rows: [Parameters<typeof outcomeOf>[0], ReturnType<typeof outcomeOf>][] = [
    [closed(1001), { kind: 'retry', reason: 'SERVER_CLOSED' }],
    [closed(1006), { kind: 'retry', reason: 'SERVER_CLOSED' }],
    [{ kind: 'network', reason: 'ECONNREFUSED' }, { kind: 'retry', reason: 'NETWORK' }],
    [{ kind: 'tls', pinMismatch: false, reason: 'CERT_HAS_EXPIRED' }, { kind: 'retry', reason: 'TLS' }],
    [{ kind: 'timeout', what: 'connect' }, { kind: 'retry', reason: 'TIMEOUT' }],
    [{ kind: 'timeout', what: 'ping' }, { kind: 'retry', reason: 'TIMEOUT' }],
    [closed(4001), { kind: 'retry', reason: 'SERVER_CLOSED' }],
    [closed(4003, 'INTERNAL'), { kind: 'retry', reason: 'SERVER_ERROR' }],
    [closed(4003), { kind: 'retry', reason: 'SERVER_ERROR' }],
    [closed(4004), { kind: 'discard' }],
    [closed(4003, 'AUTH_FAILED'), { kind: 'discard' }],
    [closed(4006), { kind: 'stop', reason: 'REPLACED' }],
    [closed(4003, 'UNSUPPORTED_VERSION'), { kind: 'stop', reason: 'UNSUPPORTED_VERSION' }],
    [closed(1003), { kind: 'stop', reason: 'FAULT' }],
    [closed(1009), { kind: 'stop', reason: 'FAULT' }],
    [{ kind: 'oversize' }, { kind: 'stop', reason: 'FAULT' }],
    [closed(4003, 'BAD_FRAME'), { kind: 'stop', reason: 'FAULT' }],
    [closed(4003, 'NOT_AUTHENTICATED'), { kind: 'stop', reason: 'FAULT' }],
    [closed(4003, 'UNKNOWN_OPERATION'), { kind: 'stop', reason: 'FAULT' }],
    [closed(4003, 'BAD_PARAMS'), { kind: 'stop', reason: 'FAULT' }],
    [{ kind: 'tls', pinMismatch: true, reason: 'pin' }, { kind: 'stop', reason: 'PIN_MISMATCH' }],
    [{ kind: 'terminated' }, { kind: 'none' }],
  ]
  for (const [end, expected] of rows) assert.deepEqual(outcomeOf(end), expected, JSON.stringify(end))
})

test('a recorded pre-auth error decides even when the connection then drops', () => {
  assert.deepEqual(outcomeOf({ kind: 'closed', code: 1006, preAuthError: 'AUTH_FAILED' }), { kind: 'discard' })
  assert.deepEqual(outcomeOf({ kind: 'terminated', preAuthError: 'UNSUPPORTED_VERSION' }), { kind: 'stop', reason: 'UNSUPPORTED_VERSION' })
})

test('backoff grows, is capped at five minutes, and jitters within 20%', () => {
  const mid = () => 0.5
  assert.equal(backoffDelay(0, 1000, mid), 1000)
  assert.equal(backoffDelay(3, 1000, mid), 8000)
  assert.equal(backoffDelay(20, 1000, mid), 300_000)
  assert.equal(backoffDelay(0, 1000, () => 0), 800)
  assert.equal(backoffDelay(0, 1000, () => 1), 1200)
})

test('which side is older', () => {
  assert.equal(olderSide([2, 3], [1]), 'spekterm')
  assert.equal(olderSide([0], [1]), 'server')
  assert.equal(olderSide([], [1]), null)
  assert.equal(olderSide(undefined, [1]), null)
})
