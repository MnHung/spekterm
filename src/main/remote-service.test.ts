import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AttentionLog } from './remote-attention'
import { RemoteOutput } from './remote-output'
import type { RemoteHost } from './remote-protocol'
import { RemoteService, pairingLink } from './remote-service'
import { RemoteStore } from './remote-store'
import { SecretStore } from './secret-store'

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as { port: number }
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-service-'))
  const secrets = new SecretStore(path.join(dir, 'secrets.json'))
  const store = new RemoteStore(path.join(dir, 'remote.json'), secrets)
  store.load()
  store.setPort(await freePort())
  let epochs = 0
  const attention = new AttentionLog({
    now: () => 0,
    sessionInfo: () => ({ folderName: null, title: 't' }),
    displayedInFocus: () => false,
    newEpoch: () => `e${++epochs}`,
  })
  const output = new RemoteOutput()
  const service = new RemoteService({
    store,
    output,
    attention,
    host: {} as RemoteHost,
    serverInfo: () => ({ name: 't', version: '0' }),
  })
  const epoch = () => {
    attention.onWait('s', { state: 'ready', turnEnded: true, choiceRaised: null })
    return attention.watch(undefined, () => undefined)?.events.at(-1)?.pos.epoch ?? null
  }
  return {
    service,
    store,
    output,
    epoch,
    done: async () => {
      await service.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('the attention log follows the switch: a port change keeps its span, a reset starts a new one, off drops it', async () => {
  const r = await rig()
  try {
    await r.service.setEnabled(true)
    assert.equal(r.service.state().listen.status, 'listening')
    const first = r.epoch()
    assert.equal(first, 'e1')
    assert.equal(await r.service.setPort(await freePort()), true)
    assert.equal(r.epoch(), first, 'a port change restarts the listener, not the log')
    await r.service.reset()
    assert.equal(r.epoch(), 'e2')
    await r.service.setEnabled(false)
    assert.equal(r.epoch(), null)
    assert.equal(r.output.enabled(), false)
    assert.equal(r.service.state().listen.status, 'off')
  } finally {
    await r.done()
  }
})

test('pairing exists only while on, and its link carries the port, the fingerprint and the code', async () => {
  const r = await rig()
  try {
    assert.equal(r.service.startPairing(), null, 'off: no pairing')
    await r.service.setEnabled(true)
    const pairing = r.service.startPairing()
    assert.ok(pairing)
    const url = new URL(pairing.link)
    assert.equal(url.searchParams.get('p'), String(r.store.get().port))
    assert.equal(url.searchParams.get('fp'), r.store.fingerprint()?.replace(/:/g, ''))
    assert.equal(url.searchParams.get('c')?.length, 26)
    r.service.cancelPairing()
    assert.equal(r.service.state().pairing, null)
  } finally {
    await r.done()
  }
})

test('the state for the renderer carries no hash, credential or key', async () => {
  const r = await rig()
  try {
    await r.service.setEnabled(true)
    r.store.addDevice({ id: 'device-0001', name: 'Pixel', model: 'Pixel 9', secretHash: 'b'.repeat(64) })
    const text = JSON.stringify(r.service.state())
    assert.ok(!text.includes('b'.repeat(64)))
    assert.ok(!text.includes('PRIVATE KEY'))
    assert.ok(!text.includes('BEGIN CERTIFICATE'))
  } finally {
    await r.done()
  }
})

test('the pairing link format', () => {
  assert.equal(
    pairingLink({ addresses: ['10.0.0.2', 'home.example'], port: 47615, fingerprint: 'AB:CD', code: 'CODE', name: 'my desk' }),
    'spekterm://pair?v=1&a=10.0.0.2%2Chome.example&p=47615&fp=ABCD&c=CODE&n=my+desk',
  )
})
