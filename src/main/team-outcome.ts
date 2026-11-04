import type { ConnectionEnd } from './team-connection'

/**
 * What a connection's end means (`team-membership`, the reconnect table; design D3). **One exhaustive mapping, no
 * `default`** (`scripts/team-outcome-exhaustive.test.mjs`): a `default` would turn a code nobody thought about into a
 * silent retry or a silent stop.
 *
 * - **The recorded pre-auth error decides by itself**, whatever close follows it (4003, or a drop within the
 *   server's one second); a 4003 with no recorded error is `INTERNAL`.
 * - An `AUTH_FAILED` answered **after** authentication never reaches here as a pre-auth error: the 4004 that the
 *   server sends at once decides (spekterm-server 0.2.1).
 */

export type RetryReason = 'NETWORK' | 'TLS' | 'TIMEOUT' | 'SERVER_CLOSED' | 'SERVER_ERROR'
export type StopReason =
  | 'REPLACED'
  | 'UNSUPPORTED_VERSION'
  | 'FAULT'
  | 'PIN_MISMATCH'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'REVOKED'

export type Outcome =
  | { kind: 'retry'; reason: RetryReason }
  | { kind: 'stop'; reason: Exclude<StopReason, 'REVOKED' | 'CREDENTIAL_UNAVAILABLE'> }
  | { kind: 'discard' }
  /** Spekterm ended it on purpose (Reconnect, resume, off, a superseded attempt): nothing to decide. */
  | { kind: 'none' }

/** Every error code protocol v1 defines, and `other` for one it does not. */
export type PreAuthError =
  | 'BAD_FRAME'
  | 'BAD_PARAMS'
  | 'UNKNOWN_OPERATION'
  | 'UNSUPPORTED_VERSION'
  | 'NOT_AUTHENTICATED'
  | 'ALREADY_AUTHENTICATED'
  | 'AUTH_FAILED'
  | 'INVITE_UNKNOWN'
  | 'INVITE_EXPIRED'
  | 'INVITE_USED'
  | 'HANDLE_TAKEN'
  | 'RECIPIENT_UNKNOWN'
  | 'RECIPIENT_IS_SELF'
  | 'HANDOFF_ID_REUSED'
  | 'RATE_LIMITED'
  | 'HANDOFF_UNKNOWN'
  | 'HANDOFF_EXPIRED'
  | 'HANDOFF_DELIVERED_ELSEWHERE'
  | 'HANDOFF_NOT_DELIVERED'
  | 'HANDOFF_FINISHED'
  | 'TOO_MANY_REPORTS'
  | 'INTERNAL'
  | 'other'

const KNOWN_ERRORS: readonly string[] = [
  'BAD_FRAME', 'BAD_PARAMS', 'UNKNOWN_OPERATION', 'UNSUPPORTED_VERSION', 'NOT_AUTHENTICATED', 'ALREADY_AUTHENTICATED',
  'AUTH_FAILED', 'INVITE_UNKNOWN', 'INVITE_EXPIRED', 'INVITE_USED', 'HANDLE_TAKEN', 'RECIPIENT_UNKNOWN',
  'RECIPIENT_IS_SELF', 'HANDOFF_ID_REUSED', 'RATE_LIMITED', 'HANDOFF_UNKNOWN', 'HANDOFF_EXPIRED',
  'HANDOFF_DELIVERED_ELSEWHERE', 'HANDOFF_NOT_DELIVERED', 'HANDOFF_FINISHED', 'TOO_MANY_REPORTS', 'INTERNAL',
] satisfies Exclude<PreAuthError, 'other'>[]

export function preAuthErrorOf(code: string): PreAuthError {
  return KNOWN_ERRORS.includes(code) ? (code as PreAuthError) : 'other'
}

/** The outcome of an error answered before authentication — the device's own `hello`. */
export function outcomeOfPreAuthError(code: PreAuthError): Outcome {
  switch (code) {
    case 'AUTH_FAILED':
      return { kind: 'discard' }
    case 'UNSUPPORTED_VERSION':
      return { kind: 'stop', reason: 'UNSUPPORTED_VERSION' }
    case 'INTERNAL':
      return { kind: 'retry', reason: 'SERVER_ERROR' }
    // Spekterm sent something the server could not take: retrying sends the same thing again.
    case 'BAD_FRAME':
    case 'BAD_PARAMS':
    case 'NOT_AUTHENTICATED':
    case 'UNKNOWN_OPERATION':
    case 'ALREADY_AUTHENTICATED':
      return { kind: 'stop', reason: 'FAULT' }
    // Not answers `hello` can get; one here is a server fault, not something to retry blindly.
    case 'INVITE_UNKNOWN':
    case 'INVITE_EXPIRED':
    case 'INVITE_USED':
    case 'HANDLE_TAKEN':
    case 'RECIPIENT_UNKNOWN':
    case 'RECIPIENT_IS_SELF':
    case 'HANDOFF_ID_REUSED':
    case 'RATE_LIMITED':
    case 'HANDOFF_UNKNOWN':
    case 'HANDOFF_EXPIRED':
    case 'HANDOFF_DELIVERED_ELSEWHERE':
    case 'HANDOFF_NOT_DELIVERED':
    case 'HANDOFF_FINISHED':
    case 'TOO_MANY_REPORTS':
    case 'other':
      return { kind: 'stop', reason: 'FAULT' }
  }
}

/** Close codes protocol v1 names, and `other`. */
export type CloseClass = 1000 | 1001 | 1003 | 1006 | 1009 | 1011 | 4001 | 4003 | 4004 | 4006 | 'other'

const KNOWN_CLOSES: readonly number[] = [1000, 1001, 1003, 1006, 1009, 1011, 4001, 4003, 4004, 4006] satisfies Exclude<CloseClass, 'other'>[]

export function closeClassOf(code: number): CloseClass {
  return KNOWN_CLOSES.includes(code) ? (code as CloseClass) : 'other'
}

function outcomeOfClose(code: CloseClass): Outcome {
  switch (code) {
    case 4004:
      return { kind: 'discard' }
    case 4006:
      return { kind: 'stop', reason: 'REPLACED' }
    case 1003:
    case 1009:
      return { kind: 'stop', reason: 'FAULT' }
    // A 4003 with no recorded error: treated as `INTERNAL`. A 1011: the server could not bring this connection's
    // `handoff.status` events up to date — reconnect with backoff, and the next `connected` syncs from the stored
    // cursor (`teammate-handoff-return`).
    case 4003:
    case 1011:
      return { kind: 'retry', reason: 'SERVER_ERROR' }
    case 1000:
    case 1001:
    case 1006:
    case 4001:
    case 'other':
      return { kind: 'retry', reason: 'SERVER_CLOSED' }
  }
}

export function outcomeOf(end: ConnectionEnd): Outcome {
  if (end.preAuthError !== undefined) return outcomeOfPreAuthError(preAuthErrorOf(end.preAuthError))
  switch (end.kind) {
    case 'closed':
      return outcomeOfClose(closeClassOf(end.code))
    case 'tls':
      return end.pinMismatch ? { kind: 'stop', reason: 'PIN_MISMATCH' } : { kind: 'retry', reason: 'TLS' }
    case 'network':
      return { kind: 'retry', reason: 'NETWORK' }
    case 'timeout':
      return { kind: 'retry', reason: 'TIMEOUT' }
    // `ws` reports its own size bound as a 1006 close; the connection records it apart, and it is a fault.
    case 'oversize':
      return { kind: 'stop', reason: 'FAULT' }
    case 'terminated':
      return { kind: 'none' }
  }
}

/** Backoff: 1 s doubling, capped at five minutes, ±20% jitter (design D3). */
export function backoffDelay(attempt: number, base = 1000, random: () => number = Math.random): number {
  const raw = Math.min(5 * 60_000, base * 2 ** Math.max(0, attempt))
  return Math.round(raw * (0.8 + 0.4 * random()))
}

/** Which side is older, from `UNSUPPORTED_VERSION`'s `detail.supported` and the versions spekterm speaks (D9). */
export function olderSide(supported: unknown, ours: readonly number[]): 'spekterm' | 'server' | null {
  if (!Array.isArray(supported) || supported.length === 0 || !supported.every((v) => typeof v === 'number')) return null
  const max = Math.max(...ours)
  const min = Math.min(...ours)
  if ((supported as number[]).every((v) => v > max)) return 'spekterm'
  if ((supported as number[]).every((v) => v < min)) return 'server'
  return null
}
