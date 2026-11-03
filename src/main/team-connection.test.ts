import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import tls from 'node:tls'
import util from 'node:util'

import { Secret } from './secret-store'
import { type ConnectionEnd, TeamConnection, trustAnchors } from './team-connection'
import { type Handler, makeCert, startTestServer } from './team-server.testkit'

const CERT = makeCert()
const OTHER = makeCert()

const ok: Handler = (m) => (m === 'hello' ? { ok: true, r: { protocol: 1 } } : { ok: true, r: {} })

test('a matching pin connects and frames flow', async () => {
  const server = await startTestServer(CERT, ok)
  const recorded: ConnectionEnd[] = []
  const connection = await TeamConnection.open({ server: server.server, fingerprint: CERT.fingerprint, onEvent: () => {}, onEnd: (e) => recorded.push(e) })
  const answer = await connection.hello('d_1', new Secret('s3cret'))
  assert.equal(answer.ok, true)
  assert.equal(server.frames[0].m, 'hello')
  connection.terminate()
  assert.equal(recorded[0].kind, 'terminated')
  await server.close()
})

test('a pin that does not match sends no application data', async () => {
  const server = await startTestServer(CERT, ok)
  const recorded: ConnectionEnd[] = []
  await assert.rejects(
    TeamConnection.open({ server: server.server, fingerprint: OTHER.fingerprint, onEvent: () => {}, onEnd: (e) => recorded.push(e) }),
  )
  assert.deepEqual(recorded.map((e) => e.kind === 'tls' && e.pinMismatch), [true])
  // Give the server a moment to account for anything that might have arrived.
  await new Promise((resolve) => setTimeout(resolve, 100))
  // A TLS session the client abandons right after its check may never complete on the server side; either way, no
  // byte of application data arrived.
  assert.equal(server.received.reduce((sum, n) => sum + n, 0), 0, 'the server received no application data')
  assert.equal(server.frames.length, 0)
  await server.close()
})

test('an unpinned connection verifies the chain and the host name', async () => {
  const server = await startTestServer(CERT, ok)
  const trusted: ConnectionEnd[] = []
  const connection = await TeamConnection.open({
    server: server.server,
    onEvent: () => {},
    onEnd: (e) => trusted.push(e),
    testing: { ca: [CERT.certPem] },
  })
  connection.terminate()
  const untrusted: ConnectionEnd[] = []
  await assert.rejects(
    TeamConnection.open({ server: server.server, onEvent: () => {}, onEnd: (e) => untrusted.push(e), testing: { ca: [OTHER.certPem] } }),
  )
  assert.equal(untrusted[0].kind, 'tls')
  assert.equal(untrusted[0].kind === 'tls' && untrusted[0].pinMismatch, false)
  await server.close()
})

test('NODE_EXTRA_CA_CERTS reaches the trust anchors of an unpinned connection', async () => {
  // The variable is read once at process start, so this runs in a child process.
  const server = await startTestServer(CERT, ok)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ca-'))
  const ca = path.join(dir, 'ca.pem')
  fs.writeFileSync(ca, CERT.certPem)
  const script = path.join(dir, 'probe.mts')
  fs.writeFileSync(
    script,
    `import { TeamConnection } from ${JSON.stringify(path.resolve('src/main/team-connection.ts'))}\n` +
      `const c = await TeamConnection.open({ server: ${JSON.stringify(server.server)}, onEvent() {}, onEnd() {} })\n` +
      `c.terminate(); console.log('connected')\n`,
  )
  const output = await new Promise<string>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: ca } }, (_error, stdout, stderr) =>
      resolve(String(stdout) + String(stderr)),
    )
  })
  assert.match(output, /connected/)
  await server.close()
})

test('a request with no answer ends the connection as a request timeout', async () => {
  const server = await startTestServer(CERT, () => 'silent')
  const recorded: ConnectionEnd[] = []
  const connection = await TeamConnection.open({
    server: server.server,
    fingerprint: CERT.fingerprint,
    onEvent: () => {},
    onEnd: (e) => recorded.push(e),
    testing: { requestTimeoutMs: 100 },
  })
  await assert.rejects(connection.request('team.members', {}))
  assert.deepEqual(recorded.map((e) => e.kind === 'timeout' && e.what), ['request'])
  await server.close()
})

test('a connection not authenticated in time ends at the connect deadline', async () => {
  const server = await startTestServer(CERT, ok)
  const recorded: ConnectionEnd[] = []
  await TeamConnection.open({
    server: server.server,
    fingerprint: CERT.fingerprint,
    onEvent: () => {},
    onEnd: (e) => recorded.push(e),
    testing: { connectTimeoutMs: 150 },
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(recorded.map((e) => e.kind === 'timeout' && e.what), ['connect'])
  await server.close()
})

test('a server that sends no pings ends the connection at the watchdog', async () => {
  const server = await startTestServer(CERT, ok)
  const recorded: ConnectionEnd[] = []
  const connection = await TeamConnection.open({
    server: server.server,
    fingerprint: CERT.fingerprint,
    onEvent: () => {},
    onEnd: (e) => recorded.push(e),
    testing: { pingTimeoutMs: 150 },
  })
  connection.markAuthenticated()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(recorded.map((e) => e.kind === 'timeout' && e.what), ['ping'])
  await server.close()
})

test('an oversize incoming frame is reported as the bound, not as a plain drop', async () => {
  const server = await startTestServer(CERT, (_m, _p, socket) => {
    socket.send('x'.repeat(1024 * 1024 + 10))
    return 'silent'
  })
  const recorded: ConnectionEnd[] = []
  const connection = await TeamConnection.open({ server: server.server, fingerprint: CERT.fingerprint, onEvent: () => {}, onEnd: (e) => recorded.push(e) })
  await assert.rejects(connection.request('team.members', {}))
  assert.deepEqual(recorded.map((e) => e.kind), ['oversize'])
  await server.close()
})

test('an oversize outgoing frame is refused locally', async () => {
  const server = await startTestServer(CERT, ok)
  const connection = await TeamConnection.open({ server: server.server, fingerprint: CERT.fingerprint, onEvent: () => {}, onEnd: () => {} })
  await assert.rejects(connection.request('x', { body: 'y'.repeat(256 * 1024) }), /too large/)
  assert.equal(server.frames.length, 0)
  connection.terminate()
  await server.close()
})

test('a pre-auth error is reported with the close that follows it', async () => {
  const server = await startTestServer(CERT, (_m, _p, socket) => {
    setTimeout(() => socket.close(4003), 20)
    return { ok: false, e: { code: 'AUTH_FAILED' } }
  })
  const recorded: ConnectionEnd[] = []
  const connection = await TeamConnection.open({ server: server.server, fingerprint: CERT.fingerprint, onEvent: () => {}, onEnd: (e) => recorded.push(e) })
  const answer = await connection.hello('d_1', new Secret('s3cret'))
  assert.equal(answer.ok, false)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(recorded, [{ kind: 'closed', code: 4003, preAuthError: 'AUTH_FAILED' }])
  await server.close()
})

test('the join answer’s secret is wrapped before it leaves the module, and no output carries it', async () => {
  const server = await startTestServer(CERT, () => ({ ok: true, r: { deviceId: 'd_1', deviceSecret: 'PLAINTEXT-SECRET' } }))
  const logged: string[] = []
  const original = { log: console.log, error: console.error, warn: console.warn }
  for (const key of ['log', 'error', 'warn'] as const) console[key] = (...args: unknown[]) => logged.push(util.format(...args))
  try {
    const connection = await TeamConnection.open({ server: server.server, fingerprint: CERT.fingerprint, onEvent: () => {}, onEnd: () => {} })
    const answer = await connection.join({ code: 'C', deviceName: 'laptop' }, (value) => new Secret(value))
    assert.equal(answer.ok, true)
    const r = (answer as { r: Record<string, unknown> }).r
    assert.ok(r.deviceSecret instanceof Secret)
    assert.doesNotMatch(util.inspect(answer, { depth: 5 }), /PLAINTEXT-SECRET/)
    assert.doesNotMatch(JSON.stringify(answer), /PLAINTEXT-SECRET/)
    connection.terminate()
  } finally {
    Object.assign(console, original)
  }
  assert.doesNotMatch(logged.join('\n'), /PLAINTEXT-SECRET/)
  await server.close()
})

test('the test certificate has the shape the unpinned path needs', () => {
  const text = execFileSync('openssl', ['x509', '-noout', '-ext', 'subjectAltName'], { input: CERT.certPem }).toString()
  assert.match(text, /DNS:localhost/)
})

test('the unpinned trust anchors include the operating system’s, not only the runtime’s', () => {
  const get = (tls as unknown as { getCACertificates: (kind: string) => string[] }).getCACertificates
  const anchors = new Set(trustAnchors())
  const system = get('system')
  assert.ok(system.length > 0, 'precondition: this machine has a system store')
  assert.ok(system.every((cert) => anchors.has(cert)), 'every system certificate is an anchor')
  assert.ok(get('default').every((cert) => anchors.has(cert)), 'every default (bundled + extra) certificate is an anchor')
})
