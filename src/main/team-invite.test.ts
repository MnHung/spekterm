import assert from 'node:assert/strict'
import test from 'node:test'

import { connectUrl, parseInvite, serverAddressOf } from './team-invite'

const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const FP = 'A'.repeat(64)
const link = (s: string, extra = ''): string => `spekterm://join?v=1&s=${encodeURIComponent(s)}&c=${CODE}${extra}`

test('a valid invite is read, with and without a pin', () => {
  assert.deepEqual(parseInvite(link('wss://team.example.com')), {
    ok: true,
    invite: { server: 'wss://team.example.com', code: CODE },
  })
  assert.deepEqual(parseInvite(link('wss://team.example.com:8443', `&fp=${FP.toLowerCase()}`)), {
    ok: true,
    invite: { server: 'wss://team.example.com:8443', code: CODE, fingerprint: FP },
  })
})

test('surrounding whitespace is ignored', () => {
  assert.equal(parseInvite(`  ${link('wss://team.example.com')}\n`).ok, true)
})

test('the code is compared case-insensitively and stored upper case', () => {
  const result = parseInvite(`spekterm://join?v=1&s=wss%3A%2F%2Fh&c=${CODE.toLowerCase()}`)
  assert.equal(result.ok && result.invite.code, CODE)
})

for (const [name, address] of [
  ['an https address', 'https://team.example.com'],
  ['a path', 'wss://team.example.com/other'],
  ['user information', 'wss://user:pass@team.example.com'],
  ['a user name alone', 'wss://user@team.example.com'],
  ['a query', 'wss://team.example.com?x=1'],
  ['a fragment', 'wss://team.example.com#x'],
  ['an empty query mark', 'wss://team.example.com?'],
  ['no host', 'wss://'],
  ['not a URL', 'team.example.com'],
] as const) {
  test(`a server address with ${name} is refused`, () => {
    assert.deepEqual(parseInvite(link(address)), { ok: false, reason: 'SERVER' })
  })
}

test('an empty path or a slash is accepted and normalized away', () => {
  assert.equal(serverAddressOf('wss://team.example.com/'), 'wss://team.example.com')
  assert.equal(serverAddressOf('wss://team.example.com'), 'wss://team.example.com')
  assert.equal(connectUrl('wss://team.example.com'), 'wss://team.example.com/connect')
  assert.equal(connectUrl('wss://team.example.com/'), 'wss://team.example.com/connect')
})

test('every other rule refuses the link', () => {
  assert.deepEqual(parseInvite('https://example.com/join?v=1'), { ok: false, reason: 'NOT_A_LINK' })
  assert.deepEqual(parseInvite(link('wss://h').replace('v=1', 'v=2')), { ok: false, reason: 'VERSION' })
  assert.deepEqual(parseInvite(`spekterm://join?v=1&s=wss%3A%2F%2Fh&c=${CODE.slice(1)}`), { ok: false, reason: 'CODE' })
  assert.deepEqual(parseInvite(`spekterm://join?v=1&s=wss%3A%2F%2Fh&c=${CODE.slice(1)}1`), { ok: false, reason: 'CODE' })
  assert.deepEqual(parseInvite(link('wss://h', `&fp=${FP.slice(1)}`)), { ok: false, reason: 'FINGERPRINT' })
  assert.deepEqual(parseInvite(link('wss://h', `&fp=${'G'.repeat(64)}`)), { ok: false, reason: 'FINGERPRINT' })
  assert.deepEqual(parseInvite(link('wss://h', `&c=${CODE}`)), { ok: false, reason: 'DUPLICATE' })
  assert.deepEqual(parseInvite(link('wss://h', '&x=1')), { ok: false, reason: 'UNKNOWN_PARAM' })
})

test('control: a parser that drops user information instead of refusing it would be caught', () => {
  // The URL parser keeps the host either way; only an explicit check refuses the link.
  const url = new URL('wss://user:pass@team.example.com')
  assert.equal(url.host, 'team.example.com')
  assert.equal(serverAddressOf('wss://user:pass@team.example.com'), null)
})

test('a server address with a ws address is refused', () => {
  assert.deepEqual(parseInvite(link('ws://team.example.com')), { ok: false, reason: 'SERVER' })
})
