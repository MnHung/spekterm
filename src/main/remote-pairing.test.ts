import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AddressThrottle,
  PAIRING_CODE_TTL_MS,
  PairingCodes,
  base32,
  hashSecret,
  newDeviceCredential,
  secretMatches,
} from './remote-pairing'

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

test('base32 matches RFC 4648', () => {
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI')
  assert.equal(base32(Buffer.alloc(16)).length, 26)
})

test('a pairing code expires after five minutes', () => {
  const c = clock()
  const codes = new PairingCodes(c.now)
  const { code } = codes.start()
  c.advance(PAIRING_CODE_TTL_MS)
  assert.equal(codes.consume(code), false)
})

test('a pairing code works once, case-insensitively', () => {
  const codes = new PairingCodes(clock().now)
  const { code } = codes.start()
  assert.equal(codes.consume(code.toLowerCase()), true)
  assert.equal(codes.consume(code), false)
})

test('cancelling and restarting invalidate the earlier code', () => {
  const codes = new PairingCodes(clock().now)
  const first = codes.start().code
  codes.cancel()
  assert.equal(codes.consume(first), false)
  const second = codes.start().code
  const third = codes.start().code
  assert.equal(codes.consume(second), false)
  assert.equal(codes.consume(third), true)
})

test('a credential matches only its own hash; a revoked one is simply absent', () => {
  const credential = newDeviceCredential()
  assert.equal(credential.secretHash, hashSecret(credential.deviceSecret))
  assert.equal(secretMatches(credential.deviceSecret, credential.secretHash), true)
  assert.equal(secretMatches(`${credential.deviceSecret}x`, credential.secretHash), false)
  assert.equal(secretMatches('', credential.secretHash), false)
  assert.equal(secretMatches(42, credential.secretHash), false)
  assert.ok(Buffer.from(credential.deviceSecret, 'base64url').length === 32)
})

test('the throttle refuses only its address, and lapses after sixty seconds', () => {
  const c = clock()
  const throttle = new AddressThrottle(c.now)
  for (let i = 0; i < 9; i += 1) throttle.fail('10.0.0.1')
  assert.equal(throttle.blocked('10.0.0.1'), false)
  throttle.fail('10.0.0.1')
  assert.equal(throttle.blocked('10.0.0.1'), true)
  assert.equal(throttle.blocked('10.0.0.2'), false)
  c.advance(59_999)
  assert.equal(throttle.blocked('10.0.0.1'), true)
  c.advance(1)
  assert.equal(throttle.blocked('10.0.0.1'), false)
})

test('failures older than the window do not count', () => {
  const c = clock()
  const throttle = new AddressThrottle(c.now)
  for (let i = 0; i < 9; i += 1) throttle.fail('10.0.0.1')
  c.advance(60_000)
  throttle.fail('10.0.0.1')
  assert.equal(throttle.blocked('10.0.0.1'), false)
})
