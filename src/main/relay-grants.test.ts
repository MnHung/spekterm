import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inspect } from 'node:util'

import { RELAY_SECRET_NAME, RelayGrants } from './relay-grants'
import { Secret, SecretStore } from './secret-store'

const BINDING = { server: 'wss://team.example.com', device: 'd_1' }
const SERVER = { address: 'wss://team.example.com', fingerprint: 'A'.repeat(64) }
const SECRET = 'grant-secret-0123456789abcdefghijklmnop'

function setup(): { dir: string; file: string; secrets: SecretStore } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-grants-')))
  const file = path.join(dir, 'secrets.json')
  const secrets = new SecretStore(file)
  secrets.load()
  return { dir, file, secrets }
}

function reloaded(file: string, binding = BINDING): RelayGrants {
  const secrets = new SecretStore(file)
  secrets.load()
  const grants = new RelayGrants(secrets)
  grants.load(binding)
  return grants
}

test('a grant round-trips through the secrets file with its real secret', () => {
  const { file, secrets } = setup()
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  const again = reloaded(file)
  assert.deepEqual(again.relayFor('phoneA', SERVER), { url: SERVER.address, fp: SERVER.fingerprint, grant: 'g_1', secret: SECRET })
})

test('control: serializing wrapped secrets with JSON.stringify writes the redaction, not the secret', () => {
  // The mistake design D2 rules out: records holding `Secret` serialized as a whole.
  const written = JSON.stringify({ grants: [{ id: 'g_1', secret: new Secret(SECRET) }] })
  assert.ok(!written.includes(SECRET))
  assert.ok(written.includes('[redacted]'))
})

test('a write that throws leaves the grants as they were', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions')
  const { dir, secrets } = setup()
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  fs.chmodSync(dir, 0o500)
  try {
    assert.throws(() => grants.add({ phone: 'phoneB', id: 'g_2', secret: 'other-secret', name: 'Tab' }))
    assert.throws(() => grants.markRevoke('g_1'))
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  assert.equal(grants.activeFor('phoneB'), undefined)
  assert.equal(grants.relayFor('phoneA', SERVER)?.grant, 'g_1')
})

test('grants made for another membership are discarded', () => {
  const { file, secrets } = setup()
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  const otherDevice = reloaded(file, { ...BINDING, device: 'd_2' })
  assert.equal(otherDevice.relayFor('phoneA', SERVER), null)
  assert.equal(otherDevice.list().length, 0)
  const check = new SecretStore(file)
  check.load()
  assert.equal(check.has(RELAY_SECRET_NAME), false, 'the stale blob is removed from the store')
})

test('rebinding to another membership drops the grants; the same binding keeps them', () => {
  const { secrets } = setup()
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  grants.bind({ ...BINDING })
  assert.equal(grants.list().length, 1)
  grants.bind(null)
  assert.equal(grants.list().length, 0)
  assert.equal(secrets.has(RELAY_SECRET_NAME), false)
})

test('a grant marked to be revoked is never given to its phone', () => {
  const { file, secrets } = setup()
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  assert.equal(grants.markRevoke('g_1'), true)
  assert.equal(grants.relayFor('phoneA', SERVER), null)
  assert.equal(reloaded(file).relayFor('phoneA', SERVER), null)
  assert.equal(reloaded(file).byId('g_1')?.state, 'revoke')
})

test('a second active grant for a phone retires the first', () => {
  const { secrets } = setup()
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  grants.add({ phone: 'phoneA', id: 'g_2', secret: 'second-secret', name: 'Pixel' })
  assert.equal(grants.relayFor('phoneA', SERVER)?.grant, 'g_2')
  assert.equal(grants.byId('g_1')?.state, 'revoke')
})

test('the object never prints a secret', () => {
  const { secrets } = setup()
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  assert.ok(!JSON.stringify(grants).includes(SECRET))
  assert.ok(!inspect(grants, { depth: 10, showHidden: true }).includes(SECRET))
  assert.ok(!String(grants).includes(SECRET))
  assert.ok(!JSON.stringify(grants.list()).includes(SECRET))
})

test('the secret is in no other file under the user-data directory', () => {
  const { dir, file, secrets } = setup()
  fs.writeFileSync(path.join(dir, 'team.json'), '{}')
  const grants = new RelayGrants(secrets)
  grants.load(BINDING)
  grants.add({ phone: 'phoneA', id: 'g_1', secret: SECRET, name: 'Pixel' })
  const holders = fs.readdirSync(dir).filter((name) => fs.readFileSync(path.join(dir, name), 'utf8').includes(SECRET))
  assert.deepEqual(holders, [path.basename(file)])
})
