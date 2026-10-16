import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
// @ts-expect-error — the probe's phone stand-in is plain JavaScript.
import { helloRemote, openRemote, pairRemote } from '../../scripts/lib/remote-client.mjs'
import { resultFrame } from './remote-frames'
import { AddressThrottle, PairingCodes } from './remote-pairing'
import { RemoteServer } from './remote-server'
import { RemoteStore } from './remote-store'
import { SecretStore } from './secret-store'

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
  sessions: { deviceId: string; disposed: boolean }[]
  done: () => Promise<void>
}

async function rig(options: Partial<ConstructorParameters<typeof RemoteServer>[0]> = {}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-server-'))
  const secrets = new SecretStore(path.join(dir, 'secrets.json'))
  const store = new RemoteStore(path.join(dir, 'remote.json'), secrets)
  store.load()
  const port = await freePort()
  store.setPort(port)
  store.setEnabled(true)
  const pairing = new PairingCodes()
  const throttle = new AddressThrottle()
  const sessions: Rig['sessions'] = []
  const server = new RemoteServer({
    store,
    pairing,
    throttle,
    serverInfo: () => ({ name: 'test', version: '0' }),
    addresses: () => ['192.0.2.10', 'desk.example.ts.net'],
    operations: () => ['conversation.answer', 'sessions.list'],
    openSession: (connection) => {
      const session = { deviceId: connection.deviceId, disposed: false }
      sessions.push(session)
      return {
        onRequest: (frame) => connection.send(resultFrame(frame.id, { echo: frame.m })),
        dispose: () => {
          session.disposed = true
        },
      }
    },
    failureDelayMs: 50,
    ...options,
  })
  await server.apply()
  return {
    server,
    store,
    pairing,
    throttle,
    target: { port, fingerprint: store.identity().fingerprint },
    sessions,
    done: async () => {
      await server.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function paired(r: Rig): Promise<{ deviceId: string; deviceSecret: string }> {
  const { code } = r.pairing.start()
  const { client, response } = await pairRemote(r.target, { code })
  assert.equal(response.ok, true, JSON.stringify(response))
  assert.deepEqual(response.r.operations, ['conversation.answer', 'sessions.list'], 'the pairing answer lists the operations')
  client.close()
  await client.closed
  return { deviceId: response.r.deviceId, deviceSecret: response.r.deviceSecret }
}

test('an operation before authentication is refused and the connection closed', async () => {
  const r = await rig()
  try {
    const client = await openRemote(r.target)
    const response = await client.call('sessions.list', {})
    assert.equal(response.ok, false)
    assert.equal(response.e.code, 'NOT_AUTHENTICATED')
    await client.closed
    assert.equal(r.sessions.length, 0)
  } finally {
    await r.done()
  }
})

test('pairing yields a credential that authenticates; a wrong one is refused', async () => {
  const r = await rig()
  try {
    const credential = await paired(r)
    const seenBefore = r.store.device(credential.deviceId)?.lastSeenAt ?? 0
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { client, response } = await helloRemote(r.target, credential)
    assert.equal(response.ok, true)
    assert.equal(response.r.protocol, 1)
    assert.deepEqual(response.r.addresses, ['192.0.2.10', 'desk.example.ts.net'])
    assert.deepEqual(response.r.operations, ['conversation.answer', 'sessions.list'])
    assert.ok((r.store.device(credential.deviceId)?.lastSeenAt ?? 0) > seenBefore, 'connecting updates the last-seen time')
    const echoed = await client.call('anything', {})
    assert.equal(echoed.r.echo, 'anything')
    assert.deepEqual(r.server.connectedDeviceIds(), [credential.deviceId])
    client.close()

    const wrong = await helloRemote(r.target, { deviceId: credential.deviceId, deviceSecret: 'nope' })
    assert.equal(wrong.response.e.code, 'AUTH_FAILED')
    assert.ok(!JSON.stringify(wrong.response).includes('192.0.2.10'), 'a refused connection learns no addresses')
    assert.deepEqual(wrong.client.events, [])
    await wrong.client.closed
  } finally {
    await r.done()
  }
})

test('an unsupported protocol version is refused, naming the supported ones', async () => {
  const r = await rig()
  try {
    const credential = await paired(r)
    const { response } = await helloRemote(r.target, { ...credential, protocol: [99] })
    assert.equal(response.e.code, 'UNSUPPORTED_VERSION')
    assert.deepEqual(response.e.detail.supported, [1])
  } finally {
    await r.done()
  }
})

test('a silent client is closed at the deadline and counted as a failure', async () => {
  const r = await rig({ authTimeoutMs: 100 })
  try {
    for (let i = 0; i < 10; i += 1) {
      const client = await openRemote(r.target)
      await client.closed
    }
    assert.equal(r.throttle.blocked('127.0.0.1'), true)
  } finally {
    await r.done()
  }
})

test('idle unauthenticated connections at the cap do not keep a device out', async () => {
  const r = await rig({ maxUnauthenticated: 3 })
  try {
    const credential = await paired(r)
    const idle = await Promise.all([1, 2, 3].map(() => openRemote(r.target)))
    const { client, response } = await helloRemote(r.target, credential)
    assert.equal(response.ok, true)
    await idle[0].closed
    client.close()
    for (const other of idle) other.close()
  } finally {
    await r.done()
  }
})

test('revoking closes the device’s connection at once', async () => {
  const r = await rig()
  try {
    const credential = await paired(r)
    const { client } = await helloRemote(r.target, credential)
    r.store.removeDevice(credential.deviceId)
    r.server.revoke(credential.deviceId)
    const closed = await client.closed
    assert.equal(closed.code, 4004)
    assert.equal(r.sessions.at(-1)?.disposed, true)
  } finally {
    await r.done()
  }
})

test('a client that ignores pings is closed after two intervals', async () => {
  const r = await rig({ pingIntervalMs: 100 })
  try {
    const credential = await paired(r)
    const { client: quiet } = await helloRemote({ ...r.target, answerPings: false }, credential)
    const { client: lively } = await helloRemote(r.target, credential)
    const started = Date.now()
    await quiet.closed
    assert.ok(Date.now() - started < 1_000)
    assert.equal(lively.isOpen(), true, 'a client that answers stays')
    lively.close()
  } finally {
    await r.done()
  }
})

test('stop() releases the port; a busy port is an error state, and a port change recovers', async () => {
  const r = await rig()
  try {
    await r.server.stop()
    const holder = createNetServer()
    await new Promise<void>((resolve) => holder.listen(r.target.port, () => resolve()))
    try {
      await r.server.apply()
      const state = r.server.state()
      assert.equal(state.status, 'error')
      assert.equal(state.status === 'error' && state.error, 'in-use')
      const other = await freePort()
      r.store.setPort(other)
      await r.server.apply()
      assert.deepEqual(r.server.state(), { status: 'listening', port: other })
      const client = await openRemote({ ...r.target, port: other })
      client.close()
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  } finally {
    await r.done()
  }
})
