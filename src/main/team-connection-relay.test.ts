import assert from 'node:assert/strict'
import test from 'node:test'

import WebSocket, { createWebSocketStream } from 'ws'

import { Secret } from './secret-store'
import { RELAY_CHUNK_BYTES, type RelayLegEnd, openRelayLeg } from './team-connection'
import { type Handler, makeCert, startTestServer } from './team-server.testkit'

/**
 * The desktop's leg of a relay tunnel (`phone-relay`, design D6), against the team test server's `/relay`, which
 * enforces the relay's 256 KiB message limit.
 */

const CERT = makeCert()
const OTHER = makeCert()
const SECRET = 'device-secret-for-the-relay-leg'

const accept: Handler = (m) => (m === 'relay.accept' ? { ok: true, r: { protocol: 1 } } : { ok: true, r: {} })

function leg(server: string, fingerprint: string, ends: RelayLegEnd[], acceptTimeoutMs?: number) {
  return openRelayLeg({
    server,
    fingerprint,
    deviceId: 'd_1',
    secret: new Secret(SECRET),
    tunnel: 't_1',
    onEnd: (e) => ends.push(e),
    ...(acceptTimeoutMs ? { testing: { acceptTimeoutMs } } : {}),
  })
}

const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

test('the leg sends one relay.accept with the device credential to /relay, then carries bytes', async () => {
  const server = await startTestServer(CERT, accept)
  const ends: RelayLegEnd[] = []
  const opened = await leg(server.server, CERT.fingerprint, ends)
  assert.deepEqual(server.frames, [{ m: 'relay.accept', p: { protocol: [1], deviceId: 'd_1', deviceSecret: SECRET, tunnel: 't_1' } }])
  const got: Buffer[] = []
  opened.stream.on('data', (chunk: Buffer) => got.push(chunk))
  server.relayLegs[0].send(Buffer.from('hello'), { binary: true })
  assert.ok(await until(() => Buffer.concat(got).toString() === 'hello'))
  opened.terminate()
  assert.equal(ends[0]?.kind, 'terminated')
  await server.close()
})

test('a pin that does not match sends nothing on the leg', async () => {
  const server = await startTestServer(CERT, accept)
  const ends: RelayLegEnd[] = []
  await assert.rejects(leg(server.server, OTHER.fingerprint, ends))
  assert.deepEqual(ends.map((e) => e.kind === 'tls' && e.pinMismatch), [true])
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(server.received.reduce((sum, n) => sum + n, 0), 0, 'no application data arrived')
  assert.equal(server.frames.length, 0)
  await server.close()
})

test('a 1 MiB write leaves in messages of at most 64 KiB and the leg stays open', async () => {
  const server = await startTestServer(CERT, accept)
  const ends: RelayLegEnd[] = []
  const opened = await leg(server.server, CERT.fingerprint, ends)
  const size = 1024 * 1024
  await new Promise<void>((resolve, reject) => opened.stream.write(Buffer.alloc(size, 7), (error) => (error ? reject(error) : resolve())))
  assert.ok(await until(() => server.relayMessages[0].reduce((a, b) => a + b, 0) === size), 'every byte arrived')
  assert.ok(Math.max(...server.relayMessages[0]) <= RELAY_CHUNK_BYTES, `largest message ${Math.max(...server.relayMessages[0])}`)
  assert.equal(server.relayLegs[0].readyState, WebSocket.OPEN)
  assert.deepEqual(ends, [])
  opened.terminate()
  await server.close()
})

test('control: an uncut 300 KiB write through a stream ends the relay leg with 1009', async () => {
  const server = await startTestServer(CERT, accept)
  const ws = new WebSocket(`${server.server}/relay`, { ca: [CERT.certPem], perMessageDeflate: false })
  await new Promise((resolve) => ws.once('open', resolve))
  ws.send(JSON.stringify({ t: 'req', id: 1, m: 'relay.accept', p: {} }))
  await new Promise((resolve) => ws.once('message', resolve))
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  ws.on('error', () => undefined)
  createWebSocketStream(ws).write(Buffer.alloc(300 * 1024, 1))
  assert.equal(await closed, 1009)
  await server.close()
})

test('ending the stream ends the leg at once, even when the relay stops reading', async () => {
  const server = await startTestServer(CERT, accept)
  const ends: RelayLegEnd[] = []
  const opened = await leg(server.server, CERT.fingerprint, ends)
  server.relayLegs[0].pause()
  opened.stream.end()
  assert.ok(await until(() => ends.length > 0, 1000), 'the leg ended within a second')
  await server.close()
})

test('control: the unwrapped stream waits for the closing handshake while the relay stops reading', async () => {
  const server = await startTestServer(CERT, accept)
  const ws = new WebSocket(`${server.server}/relay`, { ca: [CERT.certPem], perMessageDeflate: false })
  await new Promise((resolve) => ws.once('open', resolve))
  ws.on('error', () => undefined)
  server.relayLegs[0].pause()
  createWebSocketStream(ws).end()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.notEqual(ws.readyState, WebSocket.CLOSED, 'still not closed after a second')
  ws.terminate()
  await server.close()
})

test('a binary frame before the answer ends the leg', async () => {
  const server = await startTestServer(CERT, (m, _p, socket) => {
    if (m === 'relay.accept') socket.send(Buffer.from('x'), { binary: true })
    return 'silent'
  })
  const ends: RelayLegEnd[] = []
  await assert.rejects(leg(server.server, CERT.fingerprint, ends))
  assert.equal(ends[0]?.kind, 'protocol')
  await server.close()
})

test('no answer within the deadline ends the leg', async () => {
  const server = await startTestServer(CERT, () => 'silent')
  const ends: RelayLegEnd[] = []
  await assert.rejects(leg(server.server, CERT.fingerprint, ends, 300))
  assert.equal(ends[0]?.kind, 'timeout')
  assert.ok(await until(() => server.relayLegs[0]?.readyState === WebSocket.CLOSED))
  await server.close()
})

test('error answers are reported by their codes', async () => {
  for (const code of ['AUTH_FAILED', 'TUNNEL_UNKNOWN', 'RELAY_DISABLED']) {
    const server = await startTestServer(CERT, () => ({ ok: false, e: { code } }))
    const ends: RelayLegEnd[] = []
    await assert.rejects(leg(server.server, CERT.fingerprint, ends))
    assert.deepEqual(ends[0], { kind: 'refused', code })
    await server.close()
  }
})

test('no output of a leg carries the device secret', async (t) => {
  const lines: string[] = []
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => void lines.push(args.map(String).join(' ')))
  }
  const server = await startTestServer(CERT, accept)
  const ends: RelayLegEnd[] = []
  const opened = await leg(server.server, CERT.fingerprint, ends)
  opened.terminate()
  const refusing = await startTestServer(CERT, () => ({ ok: false, e: { code: 'AUTH_FAILED' } }))
  const failed = await leg(refusing.server, CERT.fingerprint, ends).catch((error: Error) => error)
  assert.ok(!String(failed).includes(SECRET))
  assert.ok(!JSON.stringify(ends).includes(SECRET))
  assert.ok(!lines.some((line) => line.includes(SECRET)))
  await server.close()
  await refusing.close()
})
