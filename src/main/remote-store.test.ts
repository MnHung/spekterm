import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_REMOTE_PORT, RemoteStore, TLS_KEY_SECRET, parseRemoteSettings } from './remote-store'
import { SecretStore } from './secret-store'

function setup(): { dir: string; make: () => { store: RemoteStore; secrets: SecretStore } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-store-'))
  return {
    dir,
    make: () => {
      const secrets = new SecretStore(path.join(dir, 'secrets.json'))
      secrets.load()
      const store = new RemoteStore(path.join(dir, 'remote.json'), secrets, () => 1_000)
      store.load()
      return { store, secrets }
    },
  }
}

const HASH = 'a'.repeat(64)

test('settings, identity and devices survive a reload', () => {
  const { dir, make } = setup()
  try {
    const first = make()
    first.store.setEnabled(true)
    assert.equal(first.store.setPort(47700), true)
    assert.equal(first.store.setAdditionalAddress('home.example.net'), true)
    const identity = first.store.identity()
    first.store.addDevice({ id: 'device-0001', name: 'Pixel', model: 'Pixel 9', secretHash: HASH })

    const second = make()
    const settings = second.store.get()
    assert.equal(settings.enabled, true)
    assert.equal(settings.port, 47700)
    assert.equal(settings.additionalAddress, 'home.example.net')
    assert.equal(second.store.identity().fingerprint, identity.fingerprint)
    assert.equal(second.store.get().devices.length, 1)
    assert.equal(fs.statSync(path.join(dir, 'remote.json')).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an invalid port falls back to the default, and an invalid setter is refused', () => {
  const parsed = parseRemoteSettings(JSON.stringify({ version: 1, remote: { port: 80, devices: [] } }))
  assert.equal(parsed?.port, DEFAULT_REMOTE_PORT)
  const { dir, make } = setup()
  try {
    const { store } = make()
    assert.equal(store.setPort(70000), false)
    assert.equal(store.setPort(1.5), false)
    assert.equal(store.setAdditionalAddress('two words'), false)
    assert.equal(store.setAdditionalAddress('a,b'), false)
    assert.equal(store.get().port, DEFAULT_REMOTE_PORT)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the projection carries no hash', () => {
  const { dir, make } = setup()
  try {
    const { store } = make()
    store.addDevice({ id: 'device-0001', name: 'Pixel', model: 'Pixel 9', secretHash: HASH })
    const projected = store.projectDevices()
    assert.deepEqual(Object.keys(projected[0]).sort(), ['id', 'model', 'name', 'pairedAt'])
    assert.ok(!JSON.stringify(projected).includes(HASH))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const [label, damage, reason] of [
  ['a missing key', (secrets: SecretStore) => secrets.clear(TLS_KEY_SECRET), 'key-missing'],
  ['a mismatched key', (secrets: SecretStore) => secrets.set(TLS_KEY_SECRET, makeOtherKey()), 'key-mismatch'],
] as const) {
  test(`${label} at start resets: a new certificate, the devices gone, the notice set`, () => {
    const { dir, make } = setup()
    try {
      const first = make()
      const before = first.store.identity()
      first.store.addDevice({ id: 'device-0001', name: 'Pixel', model: 'Pixel 9', secretHash: HASH })
      damage(first.secrets)

      const second = make()
      const after = second.store.identity()
      assert.notEqual(after.fingerprint, before.fingerprint)
      assert.deepEqual(second.store.get().devices, [])
      assert.equal(second.store.get().resetNotice?.reason, reason)
      // And the new pair is consistent: a third start keeps it.
      assert.equal(make().store.identity().fingerprint, after.fingerprint)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('a user reset replaces the certificate, drops the devices, and sets no notice', () => {
  const { dir, make } = setup()
  try {
    const { store } = make()
    const before = store.identity()
    store.addDevice({ id: 'device-0001', name: 'Pixel', model: 'Pixel 9', secretHash: HASH })
    const after = store.reset()
    assert.notEqual(after.fingerprint, before.fingerprint)
    assert.deepEqual(store.get().devices, [])
    assert.equal(store.get().resetNotice, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeOtherKey(): string {
  const { dir, make } = setup()
  try {
    return make().store.identity().keyPem
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
