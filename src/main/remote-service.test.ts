import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
// @ts-expect-error — the probe's phone stand-in is plain JavaScript.
import { helloRemote, openRemote, pairRemote } from '../../scripts/lib/remote-client.mjs'
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

async function rig(options: { interfaceAddresses?: () => string[]; reconcileMs?: number } = {}) {
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
    host: { sessionList: () => ({ window: false, folders: [], sessions: [] }), setWatched: () => undefined } as unknown as RemoteHost,
    serverInfo: () => ({ name: 't', version: '0' }),
    ...options,
  })
  const epoch = () => {
    attention.onWait('s', { state: 'ready', turnEnded: true, choicesRaised: [] })
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

async function pairedClient(r: Awaited<ReturnType<typeof rig>>) {
  const target = { port: r.store.get().port, fingerprint: r.store.fingerprint() }
  const { code } = r.service.pairing.start()
  const paired = await pairRemote(target, { code })
  assert.equal(paired.response.ok, true, JSON.stringify(paired.response))
  return { target, paired }
}

test('both authentication answers carry the current addresses, ending with the additional one', async () => {
  const r = await rig({ interfaceAddresses: () => ['192.0.2.10', '2001:db8::10'] })
  try {
    await r.service.setEnabled(true)
    r.service.setAdditionalAddress('desk.example.ts.net')
    const expected = ['192.0.2.10', '2001:db8::10', 'desk.example.ts.net']
    const { target, paired } = await pairedClient(r)
    assert.deepEqual(paired.response.r.addresses, expected, 'pair answer')
    paired.client.close()
    await paired.client.closed
    const hello = await helloRemote(target, {
      deviceId: paired.response.r.deviceId,
      deviceSecret: paired.response.r.deviceSecret,
    })
    assert.deepEqual(hello.response.r.addresses, expected, 'hello answer')
    hello.client.close()
    await hello.client.closed
  } finally {
    await r.done()
  }
})

test('a changed address list reaches authenticated connections only, once, and an unchanged one is not sent', async () => {
  let interfaces = ['192.0.2.10']
  const r = await rig({ interfaceAddresses: () => interfaces, reconcileMs: 50 })
  try {
    await r.service.setEnabled(true)
    const { target, paired } = await pairedClient(r)
    const waiting = await openRemote(target) // open, never authenticates
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(paired.client.eventsOf('addresses.changed').length, 0, 'an unchanged list is not announced')

    interfaces = ['192.0.2.77']
    const event = await paired.client.waitEvent('addresses.changed', { timeoutMs: 2000 })
    assert.deepEqual(event?.d, { addresses: ['192.0.2.77'] })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(paired.client.eventsOf('addresses.changed').length, 1, 'announced once')
    assert.deepEqual(waiting.events, [], 'a connection that has not authenticated receives nothing')

    waiting.close()
    paired.client.close()
    await Promise.all([waiting.closed, paired.client.closed])
  } finally {
    await r.done()
  }
})

test('changing the additional address is announced at once', async () => {
  const r = await rig({ interfaceAddresses: () => ['192.0.2.10'], reconcileMs: 60_000 })
  try {
    await r.service.setEnabled(true)
    const { paired } = await pairedClient(r)
    r.service.setAdditionalAddress('desk.example.ts.net')
    const event = await paired.client.waitEvent('addresses.changed', { timeoutMs: 1000 })
    assert.deepEqual(event?.d, { addresses: ['192.0.2.10', 'desk.example.ts.net'] })
    paired.client.close()
    await paired.client.closed
  } finally {
    await r.done()
  }
})
