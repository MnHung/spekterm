import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { type Membership, TeamStore } from './team-store'

const MEMBERSHIP: Membership = {
  server: { address: 'wss://team.example.com', fingerprint: 'A'.repeat(64) },
  team: { name: 'Acme' },
  member: { id: 'm_1', handle: 'sam', displayName: 'Sam', deviceCount: 1 },
  device: { id: 'd_1', name: 'laptop' },
  operations: ['device.rename', 'device.leave', 'team.members'],
}

function tmp(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-store-')), 'team.json')
}

test('a membership round-trips through the file', () => {
  const file = tmp()
  const store = new TeamStore(file)
  store.load()
  store.setEnabled(true)
  store.setMembership(MEMBERSHIP)
  store.updateMembership({ members: { list: [{ id: 'm_2', handle: 'alex', displayName: 'Alex', deviceCount: 2 }], fetchedAt: 5 } })
  const again = new TeamStore(file)
  again.load()
  assert.equal(again.get().enabled, true)
  assert.deepEqual(again.get().membership?.server, MEMBERSHIP.server)
  assert.equal(again.get().membership?.members?.list[0].handle, 'alex')
})

test('a damaged file is set aside and reads as no membership', () => {
  const file = tmp()
  fs.writeFileSync(file, '{ not json')
  const store = new TeamStore(file)
  store.load()
  assert.equal(store.get().membership, null)
  assert.equal(store.loadIssue(), 'damaged')
  const aside = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('team.json.corrupt-'))
  assert.equal(aside.length, 1)
})

test('a membership whose server is not wss is not trusted', () => {
  const file = tmp()
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, membership: { ...MEMBERSHIP, server: { address: 'https://x' } } }))
  const store = new TeamStore(file)
  store.load()
  assert.equal(store.get().membership, null)
  assert.equal(store.loadIssue(), 'damaged')
})

test('a failed write leaves memory unchanged', () => {
  const file = tmp()
  const store = new TeamStore(file)
  store.load()
  store.setMembership(MEMBERSHIP)
  // A directory where the temporary file would go makes the write fail.
  fs.mkdirSync(`${file}.tmp`)
  assert.throws(() => store.updateMembership({ device: { id: 'd_1', name: 'renamed' } }))
  assert.equal(store.get().membership?.device.name, 'laptop')
})

test('updateMembership cannot change the server', () => {
  const store = new TeamStore(tmp())
  store.load()
  store.setMembership(MEMBERSHIP)
  store.updateMembership({ server: { address: 'wss://elsewhere' } } as never)
  // The patch type has no `server`; a cast that sneaks one in is still spread, so the store must drop it.
  assert.equal(store.get().membership?.server.address, 'wss://team.example.com')
})

test('clearing a membership records the stop and the device name', () => {
  const file = tmp()
  const store = new TeamStore(file)
  store.load()
  store.setMembership(MEMBERSHIP)
  store.clearMembership({ reason: 'REVOKED', appVersion: '0.2.27', notified: false, deviceName: 'laptop' })
  const again = new TeamStore(file)
  again.load()
  assert.equal(again.get().membership, null)
  assert.equal(again.get().stop?.deviceName, 'laptop')
})

test('the relay setting survives a reload and goes with the membership (phone-relay)', () => {
  const file = tmp()
  const store = new TeamStore(file)
  store.load()
  store.setMembership(MEMBERSHIP)
  assert.equal(store.get().membership?.relay, undefined, 'a new membership starts with the relay off')
  store.updateMembership({ relay: true })
  const again = new TeamStore(file)
  again.load()
  assert.equal(again.get().membership?.relay, true)
  again.updateMembership({ relay: false })
  assert.equal(again.get().membership?.relay, undefined)
  again.updateMembership({ relay: true })
  again.clearMembership()
  again.setMembership(MEMBERSHIP)
  assert.equal(again.get().membership?.relay, undefined, 'joining again starts with the relay off')
})

test('a damaged relay value reads as off and keeps the membership (phone-relay)', () => {
  const file = tmp()
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, membership: { ...MEMBERSHIP, relay: 'yes' } }))
  const store = new TeamStore(file)
  store.load()
  assert.equal(store.get().membership?.device.id, 'd_1')
  assert.equal(store.get().membership?.relay, undefined)
})
