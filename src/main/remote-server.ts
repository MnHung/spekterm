import { type Server, createServer } from 'node:https'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CLOSE,
  type RequestFrame,
  errorFrame,
  negotiate,
  parseRequest,
  resultFrame,
  SUPPORTED_PROTOCOLS,
} from './remote-frames'
import { type AddressThrottle, type PairingCodes, newDeviceCredential, secretMatches } from './remote-pairing'
import type { RemoteStore } from './remote-store'

/**
 * The remote access listener: TLS, WebSocket, authentication, connection limits and liveness
 * (`remote-access`, design D1 / D3 of `mobile-remote-bridge`).
 *
 * **This is the only module in `src/main` that creates a server** (`scripts/server-source.test.mjs`), and
 * the only one allowed `https` and `ws` (`scripts/network-surface.test.mjs`). It knows nothing of sessions:
 * once a connection has authenticated, every request goes to the protocol layer through `openSession`.
 *
 * It accepts connections and makes none.
 */

export type ListenState =
  | { status: 'off' }
  | { status: 'listening'; port: number }
  | { status: 'error'; port: number; error: 'in-use' | 'denied' | 'other'; message: string }

/** What the protocol layer gets for one authenticated connection. */
export interface RemoteConnection {
  readonly id: number
  readonly deviceId: string
  send(frame: string): void
  /** Whether the socket can still be written to. */
  isOpen(): boolean
}

export interface RemoteSessionHandle {
  onRequest(frame: RequestFrame): void
  dispose(): void
}

export interface RemoteServerOptions {
  store: RemoteStore
  pairing: PairingCodes
  throttle: AddressThrottle
  openSession: (connection: RemoteConnection) => RemoteSessionHandle
  /** The listen state or the set of connected devices changed. */
  onChange?: () => void
  serverInfo: () => { name: string; version: string }
  /**
   * Where this desktop may be reached now, the same list as the pairing link's (`remote-protocol`). Sent in
   * the `hello` and `pair` answers only — never before authentication.
   */
  addresses: () => string[]
  pingIntervalMs?: number
  authTimeoutMs?: number
  failureDelayMs?: number
  maxUnauthenticated?: number
  maxAuthenticated?: number
}

interface Connection {
  id: number
  ws: WebSocket
  address: string
  deviceId: string | null
  /** Refused and waiting out the failure delay: nothing more it sends is read. */
  refused: boolean
  missedPings: number
  authTimer: NodeJS.Timeout | null
  session: RemoteSessionHandle | null
}

/** One megabyte: an operation's parameters never come close; a larger frame closes the connection. */
const MAX_PAYLOAD = 1024 * 1024

/** `::ffff:10.0.0.5` → `10.0.0.5`, so one IPv4 address is one throttle key on a dual-stack socket. */
function normalizeAddress(address: string | undefined): string {
  if (!address) return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

export class RemoteServer {
  readonly #options: Required<Omit<RemoteServerOptions, 'onChange'>> & Pick<RemoteServerOptions, 'onChange'>
  #state: ListenState = { status: 'off' }
  #server: Server | null = null
  #wss: WebSocketServer | null = null
  #pingTimer: NodeJS.Timeout | null = null
  /** What the running listener was started with, so `apply()` knows whether to restart. */
  #running: { port: number; fingerprint: string } | null = null
  readonly #connections = new Set<Connection>()
  #nextId = 1
  /** start/stop/apply run one at a time. */
  #queue: Promise<void> = Promise.resolve()

  constructor(options: RemoteServerOptions) {
    this.#options = {
      pingIntervalMs: 20_000,
      authTimeoutMs: 10_000,
      failureDelayMs: 1_000,
      maxUnauthenticated: 16,
      maxAuthenticated: 16,
      ...options,
    }
  }

  state(): ListenState {
    return this.#state
  }

  /** The devices with at least one authenticated connection. */
  connectedDeviceIds(): string[] {
    const ids = new Set<string>()
    for (const connection of this.#connections) if (connection.deviceId && !connection.refused) ids.add(connection.deviceId)
    return [...ids]
  }

  /** Brings the listener in line with the store: on or off, the port, the certificate. */
  apply(): Promise<void> {
    return this.#enqueue(async () => {
      const settings = this.#options.store.get()
      if (!settings.enabled) {
        await this.#stop()
        return
      }
      const identity = this.#options.store.identity()
      const wanted = { port: settings.port, fingerprint: identity.fingerprint }
      if (
        this.#running &&
        this.#running.port === wanted.port &&
        this.#running.fingerprint === wanted.fingerprint &&
        this.#state.status === 'listening'
      ) {
        return
      }
      await this.#stop()
      await this.#start(wanted.port, identity.keyPem, identity.certPem, identity.fingerprint)
    })
  }

  /** Stops listening and closes every connection. */
  stop(): Promise<void> {
    return this.#enqueue(() => this.#stop())
  }

  /** Closes the connections of a revoked device at once. */
  revoke(deviceId: string): void {
    for (const connection of this.#connections) {
      if (connection.deviceId === deviceId) connection.ws.close(CLOSE.revoked, 'device revoked')
    }
  }

  /** Closes every authenticated connection (a reset revokes every device). */
  revokeAll(): void {
    for (const connection of this.#connections) {
      if (connection.deviceId) connection.ws.close(CLOSE.revoked, 'device revoked')
    }
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }

  #changed(): void {
    try {
      this.#options.onChange?.()
    } catch (error) {
      console.error(`[remote] change listener failed: ${String(error)}`)
    }
  }

  async #start(port: number, key: string, cert: string, fingerprint: string): Promise<void> {
    const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, (_request, response) => {
      response.writeHead(404).end()
    })
    // A TLS socket that never sends its upgrade request is not left holding a slot.
    server.headersTimeout = this.#options.authTimeoutMs
    server.requestTimeout = this.#options.authTimeoutMs
    server.on('tlsClientError', () => undefined)
    const wss = new WebSocketServer({ server, path: '/v1', maxPayload: MAX_PAYLOAD, perMessageDeflate: true })
    wss.on('connection', (ws, request) => this.#accept(ws, normalizeAddress(request.socket.remoteAddress)))
    // It re-emits the listener's errors; a failure to listen is reported as the state below instead.
    wss.on('error', (error) => {
      if (this.#server === server) console.error(`[remote] websocket server error: ${String(error)}`)
    })

    const outcome = await new Promise<ListenState>((resolve) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        const kind = error.code === 'EADDRINUSE' ? 'in-use' : error.code === 'EACCES' ? 'denied' : 'other'
        resolve({ status: 'error', port, error: kind, message: String(error.message ?? error) })
      }
      server.once('error', onError)
      // No host: every interface, IPv6 and IPv4 (`remote-access`).
      server.listen(port, () => {
        server.off('error', onError)
        resolve({ status: 'listening', port })
      })
    })

    if (outcome.status !== 'listening') {
      wss.close()
      server.close()
      this.#state = outcome
      this.#running = null
      this.#changed()
      return
    }
    server.on('error', (error) => console.error(`[remote] listener error: ${String(error)}`))
    this.#server = server
    this.#wss = wss
    this.#running = { port, fingerprint }
    this.#state = outcome
    this.#pingTimer = setInterval(() => this.#ping(), this.#options.pingIntervalMs)
    this.#pingTimer.unref()
    this.#changed()
  }

  async #stop(): Promise<void> {
    if (this.#pingTimer) clearInterval(this.#pingTimer)
    this.#pingTimer = null
    const server = this.#server
    const wss = this.#wss
    this.#server = null
    this.#wss = null
    this.#running = null
    const connections = [...this.#connections]
    for (const connection of connections) connection.ws.close(CLOSE.off, 'remote access turned off')
    if (server) {
      // `close()` stops accepting at once; its callback waits for open connections, which the
      // terminate below ends if a client does not answer the close handshake.
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        wss?.close()
        setTimeout(() => {
          for (const connection of connections) connection.ws.terminate()
          server.closeAllConnections()
          resolve()
        }, this.#options.failureDelayMs).unref()
      })
    }
    const wasOn = this.#state.status !== 'off'
    this.#state = { status: 'off' }
    if (wasOn) this.#changed()
  }

  #accept(ws: WebSocket, address: string): void {
    ws.on('error', () => undefined)
    if (this.#options.throttle.blocked(address)) {
      ws.send(errorFrame(null, 'THROTTLED', 'too many failed attempts from this address; try again later'))
      ws.close(CLOSE.throttled, 'throttled')
      return
    }
    const unauthenticated = [...this.#connections].filter((connection) => connection.deviceId === null)
    if (unauthenticated.length >= this.#options.maxUnauthenticated) {
      // The oldest one goes, so idle unauthenticated sockets cannot keep a paired device out.
      unauthenticated[0].ws.terminate()
    }
    const connection: Connection = {
      id: this.#nextId++,
      ws,
      address,
      deviceId: null,
      refused: false,
      missedPings: 0,
      authTimer: null,
      session: null,
    }
    connection.authTimer = setTimeout(() => {
      connection.authTimer = null
      if (connection.deviceId !== null || connection.refused) return
      // Silence counts as a refusal, so reconnecting every ten seconds is throttled too.
      this.#options.throttle.fail(address)
      ws.close(CLOSE.authTimeout, 'authentication timeout')
    }, this.#options.authTimeoutMs)
    this.#connections.add(connection)

    ws.on('pong', () => {
      connection.missedPings = 0
    })
    ws.on('message', (raw, isBinary) => this.#message(connection, isBinary ? null : String(raw)))
    ws.on('close', () => {
      if (connection.authTimer) clearTimeout(connection.authTimer)
      connection.authTimer = null
      this.#connections.delete(connection)
      const hadDevice = connection.deviceId !== null
      try {
        connection.session?.dispose()
      } catch (error) {
        console.error(`[remote] session cleanup failed: ${String(error)}`)
      }
      connection.session = null
      if (hadDevice) this.#changed()
    })
  }

  #message(connection: Connection, raw: string | null): void {
    if (connection.refused) return
    const frame = raw === null ? { error: 'binary frame' } : parseRequest(raw)
    if ('error' in frame) {
      connection.ws.send(errorFrame(null, 'BAD_FRAME', frame.error))
      if (connection.deviceId === null) this.#refuse(connection, false)
      return
    }
    if (connection.deviceId !== null) {
      connection.session?.onRequest(frame)
      return
    }
    this.#authenticate(connection, frame)
  }

  #authenticate(connection: Connection, frame: RequestFrame): void {
    const { ws } = connection
    if (frame.m !== 'hello' && frame.m !== 'pair') {
      ws.send(errorFrame(frame.id, 'NOT_AUTHENTICATED', 'authenticate with hello or pair first'))
      this.#refuse(connection, true)
      return
    }
    const protocol = negotiate(frame.p.protocol)
    if (protocol === null) {
      ws.send(
        errorFrame(frame.id, 'UNSUPPORTED_VERSION', 'none of the offered protocol versions is supported', {
          supported: [...SUPPORTED_PROTOCOLS],
        }),
      )
      this.#refuse(connection, false)
      return
    }

    let deviceId: string
    let extra: Record<string, unknown> = {}
    if (frame.m === 'hello') {
      const device = typeof frame.p.deviceId === 'string' ? this.#options.store.device(frame.p.deviceId) : undefined
      if (!device || !secretMatches(frame.p.deviceSecret, device.secretHash)) {
        ws.send(errorFrame(frame.id, 'AUTH_FAILED', 'unknown device or wrong credential'))
        this.#refuse(connection, true)
        return
      }
      deviceId = device.id
    } else {
      if (!this.#options.pairing.consume(frame.p.code)) {
        ws.send(errorFrame(frame.id, 'PAIRING_FAILED', 'the pairing code is not valid'))
        this.#refuse(connection, true)
        return
      }
      const credential = newDeviceCredential()
      this.#options.store.addDevice({
        id: credential.deviceId,
        name: frame.p.deviceName,
        model: frame.p.deviceModel,
        secretHash: credential.secretHash,
      })
      deviceId = credential.deviceId
      extra = { deviceId: credential.deviceId, deviceSecret: credential.deviceSecret }
    }

    const authenticated = [...this.#connections].filter((other) => other.deviceId !== null && !other.refused)
    if (authenticated.length >= this.#options.maxAuthenticated) {
      ws.send(errorFrame(frame.id, 'TOO_MANY_CONNECTIONS', 'too many connected devices'))
      connection.refused = true
      ws.close(CLOSE.tooMany, 'too many connections')
      return
    }

    if (connection.authTimer) clearTimeout(connection.authTimer)
    connection.authTimer = null
    connection.deviceId = deviceId
    this.#options.store.touchDevice(deviceId)
    ws.send(
      resultFrame(frame.id, { protocol, server: this.#options.serverInfo(), addresses: this.#options.addresses(), ...extra }),
    )
    const handle: RemoteConnection = {
      id: connection.id,
      deviceId,
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text)
      },
      isOpen: () => ws.readyState === ws.OPEN,
    }
    connection.session = this.#options.openSession(handle)
    this.#changed()
  }

  /** Answers nothing more, and closes after the failure delay; `counts` = a refusal for the throttle. */
  #refuse(connection: Connection, counts: boolean): void {
    connection.refused = true
    if (connection.authTimer) clearTimeout(connection.authTimer)
    connection.authTimer = null
    if (counts) this.#options.throttle.fail(connection.address)
    const timer = setTimeout(() => connection.ws.close(CLOSE.authFailed, 'refused'), this.#options.failureDelayMs)
    timer.unref()
  }

  /** A ping to everyone; a connection that missed the previous two is closed. */
  #ping(): void {
    for (const connection of this.#connections) {
      if (connection.missedPings >= 2) {
        connection.ws.terminate()
        continue
      }
      connection.missedPings += 1
      try {
        connection.ws.ping()
      } catch {
        connection.ws.terminate()
      }
    }
  }
}

