import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Pairing codes, device credentials, and the per-address throttle (`remote-access`, design D3 of
 * `mobile-remote-bridge`). The clock and the randomness are injected, so expiry and throttling are tested
 * without waiting and without a test branch in the product.
 */

export const PAIRING_CODE_TTL_MS = 5 * 60_000

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding. 16 bytes → 26 characters, easy to type when the QR code cannot be scanned. */
export function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Constant-time string equality (lengths may differ; that is not secret). */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The one live pairing code. It is valid for five minutes, for one pairing, and only while the pairing view
 * is open; starting a new one replaces the old one.
 */
export class PairingCodes {
  #live: { code: string; expiresAt: number } | null = null

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {}

  start(): { code: string; expiresAt: number } {
    this.#live = { code: base32(this.random(16)), expiresAt: this.now() + PAIRING_CODE_TTL_MS }
    return { ...this.#live }
  }

  /** The pairing view closed. */
  cancel(): void {
    this.#live = null
  }

  /** The live code, if any and not expired. */
  current(): { code: string; expiresAt: number } | null {
    if (this.#live && this.now() >= this.#live.expiresAt) this.#live = null
    return this.#live ? { ...this.#live } : null
  }

  /** Whether the code is the live one; a matching code is used up. */
  consume(code: unknown): boolean {
    const live = this.current()
    if (!live || typeof code !== 'string') return false
    if (!sameText(code.trim().toUpperCase(), live.code)) return false
    this.#live = null
    return true
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** A device's id and secret (256 bits). Only the hash is stored (`remote-access`). */
export function newDeviceCredential(random: (size: number) => Buffer = randomBytes): {
  deviceId: string
  deviceSecret: string
  secretHash: string
} {
  const deviceSecret = random(32).toString('base64url')
  return { deviceId: random(12).toString('base64url'), deviceSecret, secretHash: hashSecret(deviceSecret) }
}

/** A full-entropy secret needs no salt or stretching; the comparison is constant-time. */
export function secretMatches(secret: unknown, secretHash: string): boolean {
  if (typeof secret !== 'string' || secret === '') return false
  return sameText(hashSecret(secret), secretHash)
}

export interface ThrottleLimits {
  failures: number
  windowMs: number
  blockMs: number
}

export const DEFAULT_THROTTLE: ThrottleLimits = { failures: 10, windowMs: 60_000, blockMs: 60_000 }

/**
 * Refusals per source address. Ten within sixty seconds refuse that address for sixty seconds; other
 * addresses are unaffected. **There is no global lockout**: it would let anyone on the network keep the
 * user's own phone out, and the credentials are long enough that guessing is no threat (design D3).
 */
export class AddressThrottle {
  readonly #failures = new Map<string, number[]>()
  readonly #blockedUntil = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits: ThrottleLimits = DEFAULT_THROTTLE,
  ) {}

  /** Whether connections from this address are refused right now. */
  blocked(address: string): boolean {
    const until = this.#blockedUntil.get(address)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.#blockedUntil.delete(address)
    return false
  }

  /** One refusal (a wrong credential or code, or the authentication deadline passing). */
  fail(address: string): void {
    const now = this.now()
    const recent = (this.#failures.get(address) ?? []).filter((at) => now - at < this.limits.windowMs)
    recent.push(now)
    if (recent.length >= this.limits.failures) {
      this.#blockedUntil.set(address, now + this.limits.blockMs)
      this.#failures.delete(address)
      return
    }
    this.#failures.set(address, recent)
  }
}
