import { createHash } from 'node:crypto'
import tls from 'node:tls'

import WebSocket, { createWebSocketStream } from 'ws'

import type { Secret } from './secret-store'
import { connectUrl } from './team-invite'

/**
 * One connection to a team server (`team-membership`, design D1–D3): TLS, the certificate check, the WebSocket and
 * its frames. **The only module that touches the network for the team**, and the only one of the team code that
 * reveals the device secret (where `hello` is built).
 *
 * ## Verify first, then hand the socket to the WebSocket client (D2)
 *
 * "Send nothing before the certificate is verified" (protocol §2) is held by structure: the TLS socket is opened
 * here, its certificate checked on `secureConnect`, and only then is the `ws` client built, with a
 * `createConnection` that returns that verified socket. The upgrade request cannot be written before the check,
 * because the client that writes it does not exist yet. (Node's `checkServerIdentity` is not the place: it is not
 * called when the chain fails, which a self-signed certificate always does. `ws`'s `upgrade` event is not either:
 * the request was sent by then.)
 *
 * ## Ending is `terminate()`, never `close()`
 *
 * `ws`'s `close()` waits up to 30 s for the peer's close frame. A connection spekterm gave up on would then report
 * its close long after a newer one authenticated — read as a drop, it would reconnect a third time and make the
 * server close the current one with 4006. Every end decided here terminates, and the owner ignores events of a
 * connection it no longer holds (the generation in `team-service.ts`).
 *
 * ## Relay legs (`phone-relay`, design D6)
 *
 * `openRelayLeg` opens the desktop's side of a tunnel a phone asked for: the same check before anything is sent, to
 * `<server>/relay` of the membership's own server (the caller passes the stored address; the event carries none),
 * one `relay.accept`, then the leg's bytes as a stream for the remote access listener. Two wrappers on that stream:
 *
 * - **Every write is cut into messages of at most 64 KiB.** `createWebSocketStream` sends one message per write, and
 *   the listener's TLS hands down a whole application write as one chunk; the relay ends a tunnel on a message over
 *   256 KiB, so one large snapshot would end it on every reconnect.
 * - **Its end terminates the WebSocket.** The stream's own `_final` calls `close()`, which waits for the relay's close
 *   frame — 30 s when the relay is not reading.
 */

/** The protocol versions this client speaks (`invite.inspect`, `join`, `hello`). */
export const PROTOCOL_VERSIONS = [1]

/** Bounds and deadlines (design D3). */
export const CONNECT_TIMEOUT_MS = 20_000
export const REQUEST_TIMEOUT_MS = 15_000
/** Two and a half of the server's 30-second ping intervals. */
export const PING_TIMEOUT_MS = 75_000
/** The server closes a client frame above this with 1009 (protocol §2). */
export const MAX_OUTGOING_FRAME_BYTES = 256 * 1024
/** What this client accepts; the protocol bounds only client frames. */
export const MAX_INCOMING_FRAME_BYTES = 1024 * 1024
/** A relay leg's messages: what this client sends, cut to this size (server design D4). */
export const RELAY_CHUNK_BYTES = 64 * 1024
/** What the relay passes at most in one message (its own limit). */
export const RELAY_MAX_MESSAGE_BYTES = 256 * 1024
/** From the call to `relay.accept`'s answer. */
export const RELAY_ACCEPT_TIMEOUT_MS = 10_000

export interface ErrorAnswer {
  code: string
  message: string
  detail?: Record<string, unknown>
}

export type Answer = { ok: true; r: unknown } | { ok: false; e: ErrorAnswer }

/** How a connection ended. `preAuthError` is the code of an error answered before authentication, if any. */
export type ConnectionEnd =
  | { kind: 'closed'; code: number; preAuthError?: string }
  | { kind: 'tls'; pinMismatch: boolean; reason: string; preAuthError?: undefined }
  | { kind: 'network'; reason: string; preAuthError?: undefined }
  | { kind: 'timeout'; what: 'connect' | 'request' | 'ping'; preAuthError?: string }
  | { kind: 'oversize'; preAuthError?: string }
  | { kind: 'terminated'; preAuthError?: string }

export interface ConnectionOptions {
  server: string
  fingerprint?: string
  onEvent: (kind: string, data: unknown) => void
  onEnd: (end: ConnectionEnd) => void
  /** Tests only: the trust anchors for an unpinned connection, and shorter deadlines. */
  testing?: { ca?: string[]; connectTimeoutMs?: number; requestTimeoutMs?: number; pingTimeoutMs?: number }
}

/** The SHA-256 of a certificate's DER, upper-case hex without separators (the invite's `fp`). */
export function fingerprintOfDer(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex').toUpperCase()
}

/** The trust anchors of an unpinned connection: the runtime's (bundled + `NODE_EXTRA_CA_CERTS`) and the OS's. */
export function trustAnchors(): string[] {
  const get = (tls as unknown as { getCACertificates?: (kind: string) => string[] }).getCACertificates
  if (!get) return [...tls.rootCertificates]
  let system: string[] = []
  try {
    system = get('system')
  } catch {
    // No system store on this platform: the runtime's roots alone.
  }
  return [...get('default'), ...system]
}

function hostOf(server: string): { host: string; port: number } {
  const url = new URL(server)
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 443 }
}

function isIp(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(':')
}

/** Opens the TLS socket and checks the certificate before anything else is written. */
function openVerified(
  options: Pick<ConnectionOptions, 'server' | 'fingerprint' | 'testing'>,
  signal: { aborted: boolean; socket?: tls.TLSSocket },
): Promise<tls.TLSSocket> {
  const { host, port } = hostOf(options.server)
  return new Promise((resolve, reject) => {
    const pinned = options.fingerprint !== undefined
    const socket = tls.connect({
      host,
      port,
      ...(isIp(host) ? {} : { servername: host }),
      rejectUnauthorized: !pinned,
      ...(pinned ? {} : { ca: options.testing?.ca ?? trustAnchors() }),
      // `ws` negotiates HTTP/1.1; nothing else may be offered.
      ALPNProtocols: ['http/1.1'],
    })
    // Kept so an end decided while the handshake runs (the connect deadline, terminate) can destroy it.
    signal.socket = socket
    const fail = (error: Error & { pinMismatch?: boolean }): void => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    socket.once('secureConnect', () => {
      socket.off('error', fail)
      if (signal.aborted) {
        socket.destroy()
        reject(Object.assign(new Error('aborted'), { aborted: true }))
        return
      }
      if (pinned) {
        const cert = socket.getPeerX509Certificate()
        if (!cert || fingerprintOfDer(cert.raw) !== options.fingerprint) {
          fail(Object.assign(new Error('the server certificate does not match the pinned fingerprint'), { pinMismatch: true }))
          return
        }
      }
      resolve(socket)
    })
  })
}

export class TeamConnection {
  readonly #options: ConnectionOptions
  #ws: WebSocket | null = null
  #nextId = 1
  readonly #pending = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  #authenticated = false
  #preAuthError: string | undefined
  #ended = false
  #connectTimer: NodeJS.Timeout | null = null
  #pingTimer: NodeJS.Timeout | null = null
  #oversize = false
  readonly #abort: { aborted: boolean; socket?: tls.TLSSocket } = { aborted: false }

  private constructor(options: ConnectionOptions) {
    this.#options = options
  }

  /**
   * Connects: TLS, the certificate check, the WebSocket upgrade. Resolves when the WebSocket is open; the caller then
   * sends `hello`, `join` or `invite.inspect`. A failure is reported once, through `onEnd`, and rejects.
   */
  static async open(options: ConnectionOptions): Promise<TeamConnection> {
    const connection = new TeamConnection(options)
    await connection.#start()
    return connection
  }

  async #start(): Promise<void> {
    const connectTimeout = this.#options.testing?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this.#connectTimer = setTimeout(() => this.#end({ kind: 'timeout', what: 'connect' }), connectTimeout)
    // No timer here keeps the process alive: quitting must not wait for a deadline.
    this.#connectTimer.unref()
    let socket: tls.TLSSocket
    try {
      socket = await openVerified(this.#options, this.#abort)
    } catch (error) {
      const e = error as Error & { pinMismatch?: boolean; aborted?: boolean; code?: string }
      if (!e.aborted) {
        const tlsFailure = e.pinMismatch === true || (typeof e.code === 'string' && /CERT|SSL|TLS|SELF_SIGNED|VERIFY/.test(e.code))
        this.#end(tlsFailure ? { kind: 'tls', pinMismatch: e.pinMismatch === true, reason: e.code ?? e.message } : { kind: 'network', reason: e.code ?? e.message })
      }
      throw error
    }
    if (this.#ended) {
      socket.destroy()
      throw new Error('ended')
    }
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(connectUrl(this.#options.server), {
        createConnection: () => socket,
        maxPayload: MAX_INCOMING_FRAME_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      })
      this.#ws = ws
      ws.once('open', () => {
        this.#armPing()
        resolve()
      })
      ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary))
      ws.on('ping', () => this.#armPing())
      ws.on('error', (error: Error & { code?: string }) => {
        if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') this.#oversize = true
        reject(error)
      })
      ws.on('close', (code) => {
        if (this.#oversize) this.#end({ kind: 'oversize' })
        else this.#end({ kind: 'closed', code })
        reject(new Error(`closed ${code}`))
      })
    })
  }

  #armPing(): void {
    if (this.#pingTimer) clearTimeout(this.#pingTimer)
    const timeout = this.#options.testing?.pingTimeoutMs ?? PING_TIMEOUT_MS
    this.#pingTimer = setTimeout(() => this.#end({ kind: 'timeout', what: 'ping' }), timeout)
    this.#pingTimer.unref()
  }

  /** The connection authenticated (`hello` or `join` answered ok): the connect deadline no longer applies. */
  markAuthenticated(): void {
    this.#authenticated = true
    if (this.#connectTimer) clearTimeout(this.#connectTimer)
    this.#connectTimer = null
  }

  get authenticated(): boolean {
    return this.#authenticated
  }

  /** Sends one request and waits for its answer. Rejects when the connection ends first. */
  request(m: string, p?: Record<string, unknown>): Promise<Answer> {
    const ws = this.#ws
    if (this.#ended || !ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'))
    const id = this.#nextId++
    const frame = JSON.stringify({ t: 'req', id, m, ...(p === undefined ? {} : { p }) })
    if (Buffer.byteLength(frame, 'utf8') > MAX_OUTGOING_FRAME_BYTES) return Promise.reject(new Error('frame too large'))
    return new Promise((resolve, reject) => {
      const timeout = this.#options.testing?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
      const timer = setTimeout(() => this.#end({ kind: 'timeout', what: 'request' }), timeout)
      timer.unref()
      this.#pending.set(id, { resolve, reject, timer })
      ws.send(frame)
    })
  }

  /**
   * `join`. **The answer's `deviceSecret` is wrapped in a `Secret` here**, before the answer reaches any other code:
   * from then on it prints as `[redacted]` in every log line and error.
   */
  async join(params: { code: string; deviceName: string; handle?: string; displayName?: string }, wrap: (value: string) => Secret): Promise<Answer> {
    const answer = await this.request('join', { protocol: PROTOCOL_VERSIONS, ...params })
    if (!answer.ok) return answer
    const r = { ...(answer.r as Record<string, unknown>) }
    const secret = r.deviceSecret
    r.deviceSecret = typeof secret === 'string' ? wrap(secret) : undefined
    return { ok: true, r }
  }

  /** `hello` with the device credential — **the one place the secret is revealed**. */
  hello(deviceId: string, secret: Secret): Promise<Answer> {
    return this.request('hello', { protocol: PROTOCOL_VERSIONS, deviceId, deviceSecret: secret.reveal() })
  }

  #onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.#ended || isBinary) return
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    // **No received frame is ever logged**: a `join` answer carries the device secret in plaintext.
    if (frame.t === 'res') {
      const pending = typeof frame.id === 'number' ? this.#pending.get(frame.id) : undefined
      if (!pending) return
      this.#pending.delete(frame.id as number)
      clearTimeout(pending.timer)
      if (frame.ok === true) pending.resolve({ ok: true, r: frame.r })
      else {
        const e = (frame.e ?? {}) as Partial<ErrorAnswer>
        const error: ErrorAnswer = {
          code: typeof e.code === 'string' ? e.code : 'INTERNAL',
          message: typeof e.message === 'string' ? e.message : '',
          ...(e.detail && typeof e.detail === 'object' ? { detail: e.detail } : {}),
        }
        if (!this.#authenticated) this.#preAuthError = error.code
        pending.resolve({ ok: false, e: error })
      }
      return
    }
    if (frame.t === 'evt' && typeof frame.k === 'string' && this.#authenticated) {
      this.#options.onEvent(frame.k, frame.d)
    }
  }

  /** Ends the connection at once, without the closing handshake. Reported as `terminated`. */
  terminate(): void {
    this.#end({ kind: 'terminated' })
  }

  #end(end: ConnectionEnd): void {
    if (this.#ended) return
    this.#ended = true
    this.#abort.aborted = true
    this.#abort.socket?.destroy()
    if (this.#connectTimer) clearTimeout(this.#connectTimer)
    if (this.#pingTimer) clearTimeout(this.#pingTimer)
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('connection ended'))
    }
    this.#pending.clear()
    try {
      this.#ws?.terminate()
    } catch {
      // Already gone.
    }
    const withError = this.#preAuthError !== undefined && end.kind !== 'tls' && end.kind !== 'network' ? { ...end, preAuthError: this.#preAuthError } : end
    this.#options.onEnd(withError as ConnectionEnd)
  }
}


// ---- Relay legs (`phone-relay`) ----

/** A leg's byte stream: what `remote-server.ts` takes as one more incoming connection. */
export type RelayStream = ReturnType<typeof createWebSocketStream>

/** How a leg ended: a close code, an error answer's code, or a local reason. */
export type RelayLegEnd =
  | { kind: 'closed'; code: number }
  | { kind: 'refused'; code: string }
  | { kind: 'tls'; pinMismatch: boolean; reason: string }
  | { kind: 'network'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'protocol'; reason: string }
  | { kind: 'terminated' }

export interface RelayLegOptions {
  /** The stored membership's server address and pin — never anything from the event. */
  server: string
  fingerprint?: string
  deviceId: string
  secret: Secret
  tunnel: string
  /** Called once, however the leg ends. */
  onEnd: (end: RelayLegEnd) => void
  testing?: { ca?: string[]; acceptTimeoutMs?: number }
}

export interface RelayLeg {
  stream: RelayStream
  /** Ends the leg at once. */
  terminate(): void
}

/** The relay URL of a server address: exactly `/relay`. */
export function relayUrl(server: string): string {
  return `${server.replace(/\/+$/, '')}/relay`
}

/**
 * Wraps a WebSocket stream so each write leaves as messages of at most `chunk` bytes, in order, the callback after
 * the last; and so its end terminates the WebSocket instead of waiting for a closing handshake. `_write` and `_final`
 * are set per instance by `createWebSocketStream` (ws 8), so they are wrapped on the instance; `team-connection.test.ts`
 * pins both behaviours against a stand-in relay.
 */
export function cutAndTerminate(stream: RelayStream, ws: WebSocket, chunk = RELAY_CHUNK_BYTES): RelayStream {
  type Write = (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) => void
  const target = stream as unknown as { _write: Write; _final: (callback: (error?: Error | null) => void) => void }
  const send = target._write
  target._write = function (data, encoding, callback) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as string, encoding)
    let offset = 0
    const next = (error?: Error | null): void => {
      if (error) {
        callback(error)
        return
      }
      if (offset >= buffer.length) {
        callback()
        return
      }
      const piece = buffer.subarray(offset, offset + chunk)
      offset += piece.length
      send.call(stream, piece, encoding, next)
    }
    next()
  }
  target._final = function (callback) {
    ws.terminate()
    callback()
  }
  return stream
}

/**
 * Opens the desktop's leg of a tunnel and sends `relay.accept`. Resolves with the leg's stream once the answer is ok;
 * otherwise reports the end through `onEnd` (once) and rejects. **No frame is ever logged**: the accept carries the
 * device secret.
 */
export function openRelayLeg(options: RelayLegOptions): Promise<RelayLeg> {
  return new Promise((resolve, reject) => {
    const abort: { aborted: boolean; socket?: tls.TLSSocket } = { aborted: false }
    let ws: WebSocket | null = null
    let ended = false
    let accepted = false
    const end = (how: RelayLegEnd): void => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      abort.aborted = true
      abort.socket?.destroy()
      try {
        ws?.terminate()
      } catch {
        // Already gone.
      }
      options.onEnd(how)
      if (!accepted) reject(new Error(`relay leg ended: ${how.kind}`))
    }
    const timer = setTimeout(() => end({ kind: 'timeout' }), options.testing?.acceptTimeoutMs ?? RELAY_ACCEPT_TIMEOUT_MS)
    timer.unref()

    openVerified({ server: options.server, fingerprint: options.fingerprint, testing: options.testing }, abort).then(
      (socket) => {
        if (ended) {
          socket.destroy()
          return
        }
        const leg = new WebSocket(relayUrl(options.server), {
          createConnection: () => socket,
          maxPayload: RELAY_MAX_MESSAGE_BYTES,
          perMessageDeflate: false,
          followRedirects: false,
        })
        ws = leg
        leg.on('error', () => end({ kind: 'network', reason: 'websocket error' }))
        leg.on('close', (code) => end({ kind: 'closed', code }))
        const onAnswer = (data: WebSocket.RawData, isBinary: boolean): void => {
          // Nothing but the answer may come first.
          if (isBinary) {
            end({ kind: 'protocol', reason: 'binary before the answer' })
            return
          }
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(data.toString()) as Record<string, unknown>
          } catch {
            end({ kind: 'protocol', reason: 'unreadable answer' })
            return
          }
          if (frame.t !== 'res' || frame.id !== 1) {
            end({ kind: 'protocol', reason: 'not the answer' })
            return
          }
          leg.off('message', onAnswer)
          if (frame.ok !== true) {
            const e = (frame.e ?? {}) as { code?: unknown }
            end({ kind: 'refused', code: typeof e.code === 'string' ? e.code : 'INTERNAL' })
            return
          }
          clearTimeout(timer)
          accepted = true
          // The stream is built only now, so the answer's text frame is never read as tunnel bytes.
          const stream = cutAndTerminate(createWebSocketStream(leg), leg)
          stream.on('error', () => end({ kind: 'terminated' }))
          leg.once('close', () => stream.destroy())
          resolve({ stream, terminate: () => end({ kind: 'terminated' }) })
        }
        leg.on('message', onAnswer)
        leg.once('open', () => {
          leg.send(
            JSON.stringify({
              t: 'req',
              id: 1,
              m: 'relay.accept',
              p: { protocol: PROTOCOL_VERSIONS, deviceId: options.deviceId, deviceSecret: options.secret.reveal(), tunnel: options.tunnel },
            }),
          )
        })
      },
      (error: Error & { pinMismatch?: boolean; aborted?: boolean; code?: string }) => {
        if (error.aborted) return
        const tlsFailure = error.pinMismatch === true || (typeof error.code === 'string' && /CERT|SSL|TLS|SELF_SIGNED|VERIFY/.test(error.code))
        end(
          tlsFailure
            ? { kind: 'tls', pinMismatch: error.pinMismatch === true, reason: error.code ?? error.message }
            : { kind: 'network', reason: error.code ?? error.message },
        )
      },
    )
  })
}
