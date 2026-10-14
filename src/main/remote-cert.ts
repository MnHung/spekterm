import { X509Certificate, createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/**
 * The remote access listener's identity: an ECDSA P-256 key and a minimal self-signed certificate
 * (`remote-access`, design D2 of `mobile-remote-bridge`).
 *
 * **No certificate library.** Exactly one shape is ever produced, and Node's own `X509Certificate`
 * (`verify`, `fingerprint256`) plus a real TLS handshake with a pinning client are the oracles
 * (`remote-cert.test.ts`). The phone trusts this certificate by its fingerprint, never by a chain or a host
 * name, so there are no extensions and no SAN.
 *
 * The signature over the certificate is **DER**, the form X.509 requires and `crypto.sign`'s default.
 */

export interface RemoteIdentity {
  /** PKCS#8 PEM. It belongs in the secret store and never leaves the main process. */
  keyPem: string
  certPem: string
  /** SHA-256 over the certificate's DER, upper-case hex pairs joined by `:` (Node's `fingerprint256` form). */
  fingerprint: string
}

/** Ten years: the certificate is replaced only by the user's reset. */
const VALIDITY_YEARS = 10

// ---- A minimal DER writer: only the types one certificate needs. ----

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

export const der = {
  sequence: (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items)),
  /** A non-negative integer from its big-endian bytes (a leading zero is added when the top bit is set). */
  integer: (bytes: Buffer): Buffer => {
    let body = bytes
    while (body.length > 1 && body[0] === 0 && (body[1] & 0x80) === 0) body = body.subarray(1)
    if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body])
    return tlv(0x02, body)
  },
  oid: (dotted: string): Buffer => {
    const parts = dotted.split('.').map(Number)
    const out: number[] = [parts[0] * 40 + parts[1]]
    for (const part of parts.slice(2)) {
      const chunk: number[] = []
      let v = part
      do {
        chunk.unshift(v & 0x7f)
        v = Math.floor(v / 128)
      } while (v > 0)
      for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80
      out.push(...chunk)
    }
    return tlv(0x06, Buffer.from(out))
  },
  utf8: (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8')),
  /** UTCTime before 2050, GeneralizedTime from then on (RFC 5280 §4.1.2.5). */
  time: (date: Date): Buffer => {
    const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`))
  },
  bitString: (bytes: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes])),
  explicit: (tagNumber: number, body: Buffer): Buffer => tlv(0xa0 | tagNumber, body),
}

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2'
const COMMON_NAME = '2.5.4.3'

function name(commonName: string): Buffer {
  return der.sequence(der.set(der.sequence(der.oid(COMMON_NAME), der.utf8(commonName))))
}

/** The to-be-signed part, for the given key and validity. Exported for the tests' control group. */
export function tbsCertificate(spkiDer: Buffer, serial: Buffer, notBefore: Date, notAfter: Date): Buffer {
  const algorithm = der.sequence(der.oid(ECDSA_WITH_SHA256))
  return der.sequence(
    der.explicit(0, der.integer(Buffer.from([2]))), // v3
    der.integer(serial),
    algorithm,
    name('spekterm'),
    der.sequence(der.time(notBefore), der.time(notAfter)),
    name('spekterm'),
    spkiDer,
  )
}

/** Wraps a signed TBS into a certificate. */
export function certificateDer(tbs: Buffer, signatureDer: Buffer): Buffer {
  return der.sequence(tbs, der.sequence(der.oid(ECDSA_WITH_SHA256)), der.bitString(signatureDer))
}

function pem(label: string, body: Buffer): string {
  const lines = body.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

function pemBody(text: string): Buffer {
  return Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
}

/** Node's `fingerprint256` form, computed from the PEM so it does not depend on the parser. */
export function fingerprintOf(certPem: string): string {
  const hex = createHash('sha256').update(pemBody(certPem)).digest('hex').toUpperCase()
  return hex.match(/../g)?.join(':') ?? ''
}

/** A new key pair and self-signed certificate. `now` and `random` are injectable for the tests. */
export function generateIdentity(now: Date = new Date(), random: (size: number) => Buffer = randomBytes): RemoteIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const serial = random(16)
  serial[0] &= 0x7f // positive (RFC 5280 §4.1.2.2)
  const notBefore = new Date(now.getTime() - 60_000) // a slightly fast phone clock still accepts it
  const notAfter = new Date(now)
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS)
  const tbs = tbsCertificate(publicKey.export({ type: 'spki', format: 'der' }), serial, notBefore, notAfter)
  const signature = sign('sha256', tbs, privateKey)
  const certPem = pem('CERTIFICATE', certificateDer(tbs, signature))
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certPem,
    fingerprint: fingerprintOf(certPem),
  }
}

/**
 * Whether the key belongs to the certificate. The two live in different files (the key in the secret
 * store, the certificate in `remote.json`), and either can be lost or set aside on its own (design D2).
 */
export function keyMatchesCertificate(keyPem: string, certPem: string): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem))
  } catch {
    return false
  }
}
