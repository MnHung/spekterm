/**
 * Reading a team invite link (`team-membership`): `spekterm://join?v=1&s=<server address>&c=<code>[&fp=<fingerprint>]`
 * (spekterm-server `docs/protocol.md` §1).
 *
 * **Strict, because `s` is where the device credential will be sent** (`secret-scope`): only `wss:`, a host and an
 * optional port. User information is refused, not dropped: a WebSocket client turns it into an `Authorization`
 * header sent to the server, so a link could make the credential's first connection carry someone else's
 * credentials. An empty path or `/` is accepted and normalized away, so the connection's path is exactly
 * `/connect`. A parameter given twice makes the link invalid: which of the two a reader takes is not a rule anyone
 * wrote down.
 *
 * Pure: no connection is made here, so an invalid link is refused before anything is sent.
 */

export interface TeamInvite {
  /** `wss://host[:port]`, without a trailing slash. */
  server: string
  /** The invite code, upper case (base32 is case-insensitive). */
  code: string
  /** The pinned certificate's SHA-256 over DER, 64 upper-case hex digits; absent: verify with the trust store. */
  fingerprint?: string
}

export type InviteResult = { ok: true; invite: TeamInvite } | { ok: false; reason: InviteRefusal }

/** Why a link is not a valid invite. The renderer shows one message for all of them; the reason is for tests. */
export type InviteRefusal = 'NOT_A_LINK' | 'VERSION' | 'SERVER' | 'CODE' | 'FINGERPRINT' | 'DUPLICATE' | 'UNKNOWN_PARAM'

const CODE = /^[A-Z2-7]{26}$/
const FINGERPRINT = /^[0-9A-F]{64}$/
const KNOWN = new Set(['v', 's', 'c', 'fp'])

export function parseInvite(text: string): InviteResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith('spekterm://join?')) return { ok: false, reason: 'NOT_A_LINK' }
  const params = new URLSearchParams(trimmed.slice('spekterm://join?'.length))
  const seen = new Set<string>()
  for (const key of params.keys()) {
    if (seen.has(key)) return { ok: false, reason: 'DUPLICATE' }
    seen.add(key)
    // An unknown parameter is refused rather than ignored: version 1's link has exactly these, and a later version
    // says so with `v`.
    if (!KNOWN.has(key)) return { ok: false, reason: 'UNKNOWN_PARAM' }
  }
  if (params.get('v') !== '1') return { ok: false, reason: 'VERSION' }

  const server = serverAddressOf(params.get('s'))
  if (!server) return { ok: false, reason: 'SERVER' }

  const code = (params.get('c') ?? '').toUpperCase()
  if (!CODE.test(code)) return { ok: false, reason: 'CODE' }

  const fp = params.get('fp')
  if (fp === null) return { ok: true, invite: { server, code } }
  const fingerprint = fp.toUpperCase()
  if (!FINGERPRINT.test(fingerprint)) return { ok: false, reason: 'FINGERPRINT' }
  return { ok: true, invite: { server, code, fingerprint } }
}

/** `wss://host[:port]`, or `null` for anything else. */
export function serverAddressOf(value: string | null): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'wss:') return null
  if (url.hostname === '') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  if (url.search !== '' || url.hash !== '') return null
  // `new URL` keeps a bare `?` or `#` as empty strings; the raw text must not carry them either.
  if (/[?#]/.test(value)) return null
  return `wss://${url.host}`
}

/** The connection URL for a server address: exactly `/connect`, never `//connect`. */
export function connectUrl(server: string): string {
  return `${server.replace(/\/+$/, '')}/connect`
}
