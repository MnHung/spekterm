/**
 * The remote protocol's frames and error codes (`remote-protocol`, `docs/remote-protocol.md`).
 *
 * - request  `{ t: 'req', id, m, p }`
 * - response `{ t: 'res', id, ok: true, r }` or `{ t: 'res', id, ok: false, e: { code, message, detail? } }`
 * - event    `{ t: 'evt', k, d }`
 *
 * Error codes are stable strings: the Android app branches on them, so renaming one is a protocol change.
 */

export const SUPPORTED_PROTOCOLS = [1] as const

export const ERROR_CODES = [
  'BAD_FRAME',
  'BAD_PARAMS',
  'UNKNOWN_OPERATION',
  'UNSUPPORTED_VERSION',
  'NOT_AUTHENTICATED',
  'AUTH_FAILED',
  'PAIRING_FAILED',
  'THROTTLED',
  'TOO_MANY_CONNECTIONS',
  'NOT_FOUND',
  'NO_WINDOW',
  'NO_CONVERSATION',
  'NOT_WATCHING',
  'WAIT_STATE',
  'FOLDER_REQUIRED',
  'CREATE_FAILED',
  'TIMEOUT',
  'PROMPT_GONE',
  'NOT_ANSWERABLE',
  'TOO_LARGE',
  'TOO_MANY',
  'UNSUPPORTED_TYPE',
  'SESSION_BUSY',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** A failure an operation reports to the client. Anything else thrown becomes `INTERNAL`. */
export class RemoteError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export interface RequestFrame {
  t: 'req'
  id: number | string
  m: string
  p: Record<string, unknown>
}

/** Close codes the server uses (4000–4999 is the application range of RFC 6455). */
export const CLOSE = {
  authTimeout: 4001,
  authFailed: 4003,
  revoked: 4004,
  off: 4005,
  tooMany: 4029,
  throttled: 4030,
  badFrame: 4400,
} as const

/** A request frame, or a reason it is not one. Only requests travel from client to server. */
export function parseRequest(raw: string): RequestFrame | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { error: 'not JSON' }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { error: 'not an object' }
  const o = data as Record<string, unknown>
  if (o.t !== 'req') return { error: 'not a request' }
  if (!(typeof o.id === 'number' && Number.isFinite(o.id)) && !(typeof o.id === 'string' && o.id.length <= 64)) {
    return { error: 'bad id' }
  }
  if (typeof o.m !== 'string' || o.m.length === 0 || o.m.length > 64) return { error: 'bad method' }
  const p = o.p === undefined ? {} : o.p
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { error: 'bad params' }
  return { t: 'req', id: o.id, m: o.m, p: p as Record<string, unknown> }
}

export function resultFrame(id: RequestFrame['id'], r: unknown): string {
  return JSON.stringify({ t: 'res', id, ok: true, r: r ?? null })
}

export function errorFrame(id: RequestFrame['id'] | null, code: ErrorCode, message: string, detail?: Record<string, unknown>): string {
  return JSON.stringify({ t: 'res', id, ok: false, e: { code, message, ...(detail ? { detail } : {}) } })
}

export function eventFrame(k: string, d: unknown): string {
  return JSON.stringify({ t: 'evt', k, d })
}

/** The highest protocol both sides support, or `null`. */
export function negotiate(offered: unknown): number | null {
  if (!Array.isArray(offered)) return null
  const supported = SUPPORTED_PROTOCOLS as readonly number[]
  const common = offered.filter((v): v is number => typeof v === 'number' && supported.includes(v))
  return common.length === 0 ? null : Math.max(...common)
}
