import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import tls from 'node:tls'

import WebSocket from 'ws'

// @ts-expect-error — the probe's phone stand-in is plain JavaScript.
import { helloRemote, normalizeFingerprint, pairRemote } from '../../scripts/lib/remote-client.mjs'
import { resultFrame } from './remote-frames'
import { AddressThrottle, PairingCodes } from './remote-pairing'
import { type RemoteConnection, RemoteServer, relayThrottleKey } from './remote-server'
import { RemoteStore } from './remote-store'
import { relayedStreams, type StandInRelay, standInRelay } from './relay.testkit'
import { SecretStore } from './secret-store'

/**
 * Relayed connections (`phone-relay`, design D7–D8): a byte stream handed to `acceptRelayed`, as `team-connection.ts`
 * hands over a relay leg. Both ends go through a stand-in relay (`relay.testkit.ts`); the phone side has TLS pinned to
 * the listener's certificate on top, then the WebSocket — the same layering the Android app uses inside the tunnel.
 */

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as { port: number }
  await new Promise((resolve) => probe.close(resolve))
  return port
}

interface Rig {
  server: RemoteServer
  store: RemoteStore
  pairing: PairingCodes
  throttle: AddressThrottle
  target: { port: number; fingerprint: string }
  connections: RemoteConnection[]
  relay: StandInRelay
  done: () => Promise<void>
}

async function rig(options: Partial<ConstructorParameters<typeof RemoteServer>[0]> = {}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-relay-'))
  const secrets = new SecretStore(path.join(dir, 'secrets.json'))
  const store = new RemoteStore(path.join(dir, 'remote.json'), secrets)
  store.load()
  const port = await freePort()
  store.setPort(port)
  store.setEnabled(true)
  const pairing = new PairingCodes()
  const throttle = new AddressThrottle()
  const connections: RemoteConnection[] = []
  const server = new RemoteServer({
    store,
    pairing,
    throttle,
    serverInfo: () => ({ name: 'test', version: '0' }),
    addresses: () => ['192.0.2.10'],
    operations: () => ['sessions.list'],
    authExtras: (deviceId) => ({ relay: { url: 'wss://team.example.com', grant: `g_${deviceId.slice(0, 4)}`, secret: 's' } }),
    openSession: (connection) => {
      connections.push(connection)
      return { onRequest: (frame) => connection.send(resultFrame(frame.id, { echo: frame.m })), dispose: () => undefined }
    },
    failureDelayMs: 50,
    ...options,
  })
  await server.apply()
  const relay = await standInRelay()
  return {
    server,
    store,
    pairing,
    throttle,
    target: { port, fingerprint: store.identity().fingerprint },
    connections,
    relay,
    done: async () => {
      await server.stop()
      await relay.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function pairDirect(r: Rig): Promise<{ deviceId: string; deviceSecret: string }> {
  const { code } = r.pairing.start()
  const { client, response } = await pairRemote(r.target, { code })
  assert.equal(response.ok, true, JSON.stringify(response))
  client.close()
  await client.closed
  return { deviceId: response.r.deviceId, deviceSecret: response.r.deviceSecret }
}

interface Phone {
  call: (m: string, p: Record<string, unknown>) => Promise<Record<string, unknown> & { ok: boolean; r?: Record<string, unknown>; e?: { code: string } }>
  closed: Promise<number>
  close: () => void
}

/** Hands one end of a pair to the listener as relayed through `grant` (for `phone`), and opens the phone on the other. */
async function relayedPhone(r: Rig, grant: string, phone: string): Promise<Phone> {
  const { phone: phoneEnd, desktop } = await relayedStreams(r.relay)
  assert.equal(r.server.acceptRelayed(desktop, grant, phone), true)
  const socket = tls.connect({ socket: phoneEnd, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => {
      const der = socket.getPeerX509Certificate()?.raw
      const fp = der ? createHash('sha256').update(der).digest('hex').toUpperCase() : ''
      if (fp !== normalizeFingerprint(r.target.fingerprint)) reject(new Error('pin mismatch'))
      else resolve()
    })
    socket.once('error', reject)
  })
  const ws = new WebSocket('wss://desktop/v1', { createConnection: () => socket })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const waiting = new Map<number, (frame: never) => void>()
  let next = 1
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data))
    waiting.get(frame.id)?.(frame as never)
    waiting.delete(frame.id)
  })
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  return {
    call: (m, p) =>
      new Promise((resolve) => {
        const id = next++
        waiting.set(id, resolve as (frame: never) => void)
        ws.send(JSON.stringify({ t: 'req', id, m, p }))
      }),
    closed,
    close: () => ws.terminate(),
  }
}

const hello = (credential: { deviceId: string; deviceSecret: string }) => ({ protocol: [1], ...credential })

test('a relayed phone authenticates with hello and gets the same answer fields as a direct one', async () => {
  const r = await rig()
  try {
    const credential = await pairDirect(r)
    const direct = await helloRemote(r.target, credential)
    const phone = await relayedPhone(r, 'g_1', credential.deviceId)
    const answer = await phone.call('hello', hello(credential))
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.deepEqual(Object.keys(answer.r ?? {}).sort(), Object.keys(direct.response.r).sort())
    assert.ok(answer.r?.relay, 'the hello answer carries the extras')
    const relayed = r.connections.at(-1)
    assert.equal(relayed?.relayed, true)
    assert.equal(relayed?.method, 'hello')
    direct.client.close()
    phone.close()
  } finally {
    await r.done()
  }
})

test('the pair answer never carries the hello-only extras', async () => {
  const r = await rig()
  try {
    const { code } = r.pairing.start()
    const { client, response } = await pairRemote(r.target, { code })
    assert.equal(response.ok, true)
    assert.equal(response.r.relay, undefined)
    assert.deepEqual(r.connections.at(-1)?.extras, {})
    client.close()
  } finally {
    await r.done()
  }
})

test('pairing through the relay is refused, counted on the grant, and leaves the code usable directly', async () => {
  const r = await rig()
  try {
    const { code } = r.pairing.start()
    const phone = await relayedPhone(r, 'g_1', 'whoever')
    const answer = await phone.call('pair', { protocol: [1], code, deviceName: 'x', deviceModel: 'y' })
    assert.equal(answer.ok, false)
    assert.equal(answer.e?.code, 'PAIRING_FAILED')
    assert.equal(await phone.closed, 4003)
    assert.equal(r.store.get().devices.length, 0, 'no device was added')
    // Control for "the code was not consumed": the same code pairs directly.
    const { client, response } = await pairRemote(r.target, { code })
    assert.equal(response.ok, true, 'the open code still pairs directly')
    client.close()
    for (let i = 0; i < 9; i++) r.throttle.fail(relayThrottleKey('g_1'))
    assert.equal(r.throttle.blocked(relayThrottleKey('g_1')), true, 'the refusal counted on the grant: nine more block it')
  } finally {
    await r.done()
  }
})

test('another paired phone’s valid credential through a grant is refused', async () => {
  const r = await rig()
  try {
    const a = await pairDirect(r)
    const b = await pairDirect(r)
    const phone = await relayedPhone(r, 'g_a', a.deviceId)
    const answer = await phone.call('hello', hello(b))
    assert.equal(answer.ok, false)
    assert.equal(answer.e?.code, 'AUTH_FAILED')
    assert.equal(await phone.closed, 4003)
    // Control: the grant's own phone is accepted on a new tunnel through the same grant.
    const own = await relayedPhone(r, 'g_a', a.deviceId)
    assert.equal((await own.call('hello', hello(a))).ok, true)
    own.close()
  } finally {
    await r.done()
  }
})

test('failures through one grant block that grant only', async () => {
  const r = await rig()
  try {
    const credential = await pairDirect(r)
    for (let i = 0; i < 10; i++) r.throttle.fail(relayThrottleKey('g_a'))
    const blocked = await relayedPhone(r, 'g_a', credential.deviceId)
    assert.equal(await blocked.closed, 4030, 'a connection through the blocked grant is throttled')
    const other = await relayedPhone(r, 'g_b', credential.deviceId)
    assert.equal((await other.call('hello', hello(credential))).ok, true, 'another grant is unaffected')
    const direct = await helloRemote(r.target, credential)
    assert.equal(direct.response.ok, true, 'a direct address is unaffected')
    // Control: keyed as a direct connection without an address, every relayed phone shares one key.
    assert.notEqual(relayThrottleKey('g_a'), relayThrottleKey('g_b'))
    other.close()
    direct.client.close()
  } finally {
    await r.done()
  }
})

test('a relayed stream that never upgrades is closed at the deadline and counted', async () => {
  const r = await rig({ authTimeoutMs: 300 })
  try {
    const { phone: phoneEnd, desktop: desktopEnd } = await relayedStreams(r.relay)
    r.server.acceptRelayed(desktopEnd, 'g_s', 'p')
    const socket = tls.connect({ socket: phoneEnd, rejectUnauthorized: false })
    await new Promise((resolve) => socket.once('secureConnect', resolve))
    const closed = new Promise((resolve) => desktopEnd.once('close', resolve))
    // Sends nothing after TLS. A server that never listens enforces no headersTimeout: only the own deadline ends it.
    await closed
    for (let i = 0; i < 9; i++) r.throttle.fail(relayThrottleKey('g_s'))
    assert.equal(r.throttle.blocked(relayThrottleKey('g_s')), true, 'the silence counted once on the grant')
    socket.destroy()
  } finally {
    await r.done()
  }
})

test('a relayed stream that closes before its deadline is not counted', async () => {
  const r = await rig({ authTimeoutMs: 300 })
  try {
    const { desktop: desktopEnd, phoneLeg } = await relayedStreams(r.relay)
    r.server.acceptRelayed(desktopEnd, 'g_c', 'p')
    // The phone drops before its TLS handshake completes: the relay ends the desktop's leg.
    phoneLeg.terminate()
    await new Promise((resolve) => desktopEnd.once('close', resolve))
    await new Promise((resolve) => setTimeout(resolve, 500))
    for (let i = 0; i < 9; i++) r.throttle.fail(relayThrottleKey('g_c'))
    assert.equal(r.throttle.blocked(relayThrottleKey('g_c')), false, 'nine more failures do not block: none was counted')
  } finally {
    await r.done()
  }
})

test('turning remote access off closes relayed connections before and after their upgrade', async () => {
  const r = await rig()
  try {
    const credential = await pairDirect(r)
    const phone = await relayedPhone(r, 'g_1', credential.deviceId)
    assert.equal((await phone.call('hello', hello(credential))).ok, true)
    const { desktop: waitingEnd } = await relayedStreams(r.relay)
    r.server.acceptRelayed(waitingEnd, 'g_2', credential.deviceId)
    const waitingClosed = new Promise((resolve) => waitingEnd.once('close', resolve))
    r.store.setEnabled(false)
    await r.server.apply()
    assert.equal(await phone.closed, 4005)
    await waitingClosed
    const { desktop: late } = await relayedStreams(r.relay)
    assert.equal(r.server.acceptRelayed(late, 'g_3', credential.deviceId), false, 'nothing is taken while off')
  } finally {
    await r.done()
  }
})

test('a stream handed over during a stop is refused', async () => {
  const r = await rig()
  try {
    // A connected device keeps the stop waiting for its close, so there is a window to hand a stream over in.
    const credential = await pairDirect(r)
    const direct = await helloRemote(r.target, credential)
    const { desktop: stream } = await relayedStreams(r.relay)
    const stopping = r.server.stop()
    // Let the queued stop begin: it clears the listener at once and changes the state only after awaiting.
    await Promise.resolve()
    await Promise.resolve()
    // Control for checking `state()`: it still says listening here, while the stop has begun.
    assert.equal(r.server.state().status, 'listening')
    assert.equal(r.server.acceptRelayed(stream, 'g_1', 'p'), false)
    await stopping
    direct.client.close()
  } finally {
    await r.done()
  }
})
