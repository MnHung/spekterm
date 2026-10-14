/**
 * The probe's phone stand-in pins the certificate (`scripts/lib/remote-client.mjs`). If it accepted any
 * certificate, every `probe:remote` assertion about reaching "the paired desktop" would pass against a
 * different server. Control group: the same server, pinned by its real fingerprint, is reached.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { normalizeFingerprint, openRemote, parsePairingLink } from './lib/remote-client.mjs'

const dirs = []
test.after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-client-cert-'))
  dirs.push(dir)
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=spekterm',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, `openssl failed: ${result.stderr}`)
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

async function startServer({ key, cert }) {
  const server = createServer({ key, cert })
  const wss = new WebSocketServer({ server, path: '/v1' })
  const received = []
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      received.push(String(raw))
      const frame = JSON.parse(String(raw))
      socket.send(JSON.stringify({ t: 'res', id: frame.id, ok: true, r: { echo: frame.m } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    received,
    stop: () => new Promise((resolve) => { wss.close(); server.close(resolve) }),
  }
}

test('a client pinned to another certificate is refused before it sends anything', async () => {
  const served = makeCert()
  const other = makeCert()
  const server = await startServer(served)
  try {
    const wrongPin = new X509Certificate(other.cert).fingerprint256
    await assert.rejects(openRemote({ port: server.port, fingerprint: wrongPin }), /not the pinned/)
    assert.deepEqual(server.received, [], 'no frame reached the server')

    // Control group: pinned to the certificate actually served, the same client gets through.
    const rightPin = new X509Certificate(served.cert).fingerprint256
    const client = await openRemote({ port: server.port, fingerprint: rightPin })
    const response = await client.call('hello', {})
    assert.equal(response.ok, true)
    assert.equal(response.r.echo, 'hello')
    client.close()
  } finally {
    await server.stop()
  }
})

test('fingerprints compare across forms, and a pairing link parses', () => {
  assert.equal(normalizeFingerprint('ab:cd:EF'), 'ABCDEF')
  const link = parsePairingLink('spekterm://pair?v=1&a=192.168.1.5,host.example&p=47615&fp=abcd&c=CODE&n=desk')
  assert.deepEqual(link, {
    version: '1',
    addresses: ['192.168.1.5', 'host.example'],
    port: 47615,
    fingerprint: 'ABCD',
    code: 'CODE',
    name: 'desk',
  })
})
