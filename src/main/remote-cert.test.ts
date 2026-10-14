import assert from 'node:assert/strict'
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { connect, createServer } from 'node:tls'
import test from 'node:test'
import { certificateDer, fingerprintOf, generateIdentity, keyMatchesCertificate, tbsCertificate } from './remote-cert'

test('the certificate parses, verifies with its own key, and its fingerprint is Node’s', () => {
  const identity = generateIdentity(new Date('2026-10-13T00:00:00Z'))
  const parsed = new X509Certificate(identity.certPem)
  assert.equal(parsed.verify(createPublicKey(createPrivateKey(identity.keyPem))), true)
  assert.equal(parsed.fingerprint256, identity.fingerprint)
  assert.equal(parsed.subject, 'CN=spekterm')
  assert.equal(parsed.issuer, 'CN=spekterm')
  assert.ok(new Date(parsed.validTo).getUTCFullYear() >= 2036, `ten years: ${parsed.validTo}`)
})

test('a TLS server with the identity completes a handshake with a client that pins it', async () => {
  const identity = generateIdentity()
  const server = createServer({ key: identity.keyPem, cert: identity.certPem }, (socket) => socket.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const port = (server.address() as { port: number }).port
    const seen = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        resolve(socket.getPeerX509Certificate()?.fingerprint256 ?? '')
        socket.end()
      })
      socket.on('error', reject)
    })
    assert.equal(seen, identity.fingerprint)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the key check accepts the key and rejects another', () => {
  const identity = generateIdentity()
  const other = generateIdentity()
  assert.equal(keyMatchesCertificate(identity.keyPem, identity.certPem), true)
  assert.equal(keyMatchesCertificate(other.keyPem, identity.certPem), false)
  assert.equal(keyMatchesCertificate('not a key', identity.certPem), false)
})

test('control group: one flipped byte of the signed part fails verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const tbs = tbsCertificate(
    publicKey.export({ type: 'spki', format: 'der' }),
    Buffer.from([1, 2, 3]),
    new Date('2026-01-01T00:00:00Z'),
    new Date('2036-01-01T00:00:00Z'),
  )
  const signature = sign('sha256', tbs, privateKey)
  const good = new X509Certificate(certificateDer(tbs, signature))
  assert.equal(good.verify(publicKey), true)
  const tampered = Buffer.from(tbs)
  // A byte inside the validity, so the structure still parses.
  const index = tampered.indexOf(Buffer.from('260101'))
  tampered[index + 5] ^= 0x01
  assert.equal(new X509Certificate(certificateDer(tampered, signature)).verify(publicKey), false)
})

test('the fingerprint is computed from the DER, not from the parser', () => {
  const identity = generateIdentity()
  assert.match(identity.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  assert.equal(fingerprintOf(identity.certPem), new X509Certificate(identity.certPem).fingerprint256)
})
