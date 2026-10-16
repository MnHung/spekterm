import { hostname, networkInterfaces } from 'node:os'
import type { AttentionLog } from './remote-attention'
import { eventFrame } from './remote-frames'
import type { RemoteOutput } from './remote-output'
import { AddressThrottle, PairingCodes } from './remote-pairing'
import { AUTH_OPERATIONS, openRemoteSession, operationNames, type RemoteHost } from './remote-protocol'
import { type ListenState, type RemoteConnection, RemoteServer } from './remote-server'
import type { ProjectedDevice, RemoteStore, ResetReason } from './remote-store'
import type { SessionEnd } from './terminal'

/**
 * Remote access as one unit: the settings, the listener, pairing, and what connected devices are told
 * (`remote-access`, `remote-protocol`, `remote-notifications`).
 *
 * **Everything follows the user's switch** (`RemoteStore.enabled`): the listener, the output buffering and
 * the attention log. The attention log follows the *switch*, not the listener — a port change or a listen
 * failure restarts the listener without ending the log's span (`remote-notifications`).
 *
 * Electron-free; `ipc/remote.ts` puts it in front of the renderer.
 */

/** What the renderer receives: a field whitelist, no credential, no hash, no key (`remote-access`). */
export interface RemoteStateView {
  enabled: boolean
  port: number
  additionalAddress: string | null
  listen: ListenState
  fingerprint: string | null
  /** Addresses this machine may be reached at, as put in a pairing link. */
  addresses: string[]
  devices: (ProjectedDevice & { connected: boolean })[]
  resetNotice: { at: number; reason: ResetReason } | null
  /** The live pairing, if the pairing view is open: the link (it carries the code) and when it expires. */
  pairing: { link: string; expiresAt: number } | null
}

export interface RemoteServiceDeps {
  store: RemoteStore
  output: RemoteOutput
  attention: AttentionLog
  host: RemoteHost
  serverInfo: () => { name: string; version: string }
  /** The state the renderer shows changed. */
  onStateChanged?: () => void
  now?: () => number
  /** For the tests: listener timings. */
  serverTimings?: { pingIntervalMs?: number; authTimeoutMs?: number; failureDelayMs?: number }
  /** For the tests: the interface addresses (default `reachableAddresses()`) and the reconcile interval. */
  interfaceAddresses?: () => string[]
  reconcileMs?: number
}

/** How often the session list is recomputed while a device is connected, to catch changes nothing signals. */
const LIST_RECONCILE_MS = 5_000
/** Signals arrive in bursts (a persist, a pty change, a wait drain); one list per burst. */
const LIST_DEBOUNCE_MS = 150

type ListKind = 'sessions' | 'inbox' | 'handoffs'

/** The non-loopback interface addresses: IPv4 first, then global IPv6 (link-local needs a zone id). */
export function reachableAddresses(): string[] {
  const v4: string[] = []
  const v6: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family === 'IPv4') v4.push(entry.address)
      else if (!entry.address.toLowerCase().startsWith('fe80')) v6.push(entry.address)
    }
  }
  return [...v4, ...v6]
}

/** `spekterm://pair?v=1&a=…&p=…&fp=…&c=…&n=…` (`remote-access`, `docs/remote-protocol.md`). */
export function pairingLink(fields: { addresses: string[]; port: number; fingerprint: string; code: string; name: string }): string {
  const params = new URLSearchParams({
    v: '1',
    a: fields.addresses.join(','),
    p: String(fields.port),
    fp: fields.fingerprint.replace(/:/g, ''),
    c: fields.code,
    n: fields.name,
  })
  return `spekterm://pair?${params.toString()}`
}

export class RemoteService {
  readonly pairing: PairingCodes
  readonly throttle: AddressThrottle
  readonly server: RemoteServer
  readonly #deps: RemoteServiceDeps
  readonly #sessions = new Map<number, { connection: RemoteConnection; handle: ReturnType<typeof openRemoteSession> }>()
  #pairingOpen = false
  #listTimer: NodeJS.Timeout | null = null
  #pendingLists = new Set<ListKind>()
  #reconcileTimer: NodeJS.Timeout | null = null
  #lastSessionList = ''
  /** The address list connected devices were last told, as JSON; set when the first device connects. */
  #lastAddresses = ''

  constructor(deps: RemoteServiceDeps) {
    this.#deps = deps
    const now = deps.now ?? Date.now
    this.pairing = new PairingCodes(now)
    this.throttle = new AddressThrottle(now)
    this.server = new RemoteServer({
      store: deps.store,
      pairing: this.pairing,
      throttle: this.throttle,
      serverInfo: deps.serverInfo,
      addresses: () => this.currentAddresses(),
      operations: () => operationNames().filter((name) => !(AUTH_OPERATIONS as readonly string[]).includes(name)),
      ...deps.serverTimings,
      openSession: (connection) => {
        const handle = openRemoteSession(deps.host, connection)
        this.#sessions.set(connection.id, { connection, handle })
        this.#syncReconcile()
        return {
          onRequest: handle.onRequest,
          dispose: () => {
            handle.dispose()
            this.#sessions.delete(connection.id)
            this.#syncReconcile()
          },
        }
      },
      onChange: () => this.#changed(),
    })
  }

  /** Brings everything in line with the switch and the port. Called at startup and on every settings change. */
  async apply(): Promise<void> {
    const { enabled } = this.#deps.store.get()
    this.#deps.output.setEnabled(enabled)
    this.#deps.attention.setEnabled(enabled)
    if (!enabled) {
      this.pairing.cancel()
      this.#pairingOpen = false
    }
    await this.server.apply()
    this.#changed()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.#deps.store.setEnabled(enabled)
    await this.apply()
  }

  async setPort(port: unknown): Promise<boolean> {
    const taken = this.#deps.store.setPort(port)
    if (taken) await this.apply()
    return taken
  }

  setAdditionalAddress(address: unknown): boolean {
    const taken = this.#deps.store.setAdditionalAddress(address)
    this.#checkAddresses()
    this.#changed()
    return taken
  }

  /**
   * Where this desktop may be reached now: interface addresses, then the user's additional address. **One
   * list** for the pairing link, the authentication answers and `addresses.changed` (`remote-protocol`).
   */
  currentAddresses(): string[] {
    const settings = this.#deps.store.get()
    const interfaces = (this.#deps.interfaceAddresses ?? reachableAddresses)()
    return [...interfaces, ...(settings.additionalAddress ? [settings.additionalAddress] : [])]
  }

  /** Opens the pairing view: a new code. Only while remote access is on. */
  startPairing(): RemoteStateView['pairing'] {
    if (!this.#deps.store.get().enabled) return null
    this.pairing.start()
    this.#pairingOpen = true
    this.#changed()
    return this.state().pairing
  }

  /** The pairing view closed: its code stops working. */
  cancelPairing(): void {
    this.pairing.cancel()
    this.#pairingOpen = false
    this.#changed()
  }

  revoke(deviceId: string): void {
    this.#deps.store.removeDevice(deviceId)
    this.server.revoke(deviceId)
    this.#changed()
  }

  /** A new certificate, every device revoked, and the attention log starts over. */
  async reset(): Promise<void> {
    this.#deps.store.reset()
    this.#deps.attention.reset()
    this.server.revokeAll()
    this.pairing.cancel()
    this.#pairingOpen = false
    await this.server.apply()
    this.#changed()
  }

  dismissResetNotice(): void {
    this.#deps.store.dismissResetNotice()
    this.#changed()
  }

  async stop(): Promise<void> {
    this.#stopReconcile()
    await this.server.stop()
  }

  state(): RemoteStateView {
    const settings = this.#deps.store.get()
    const connected = new Set(this.server.connectedDeviceIds())
    const fingerprint = this.#deps.store.fingerprint() ?? null
    const addresses = this.currentAddresses()
    const live = this.#pairingOpen ? this.pairing.current() : null
    if (this.#pairingOpen && !live) this.#pairingOpen = false
    return {
      enabled: settings.enabled,
      port: settings.port,
      additionalAddress: settings.additionalAddress ?? null,
      listen: this.server.state(),
      fingerprint,
      addresses,
      devices: this.#deps.store.projectDevices().map((device) => ({ ...device, connected: connected.has(device.id) })),
      resetNotice: settings.resetNotice ?? null,
      pairing:
        live && fingerprint
          ? {
              link: pairingLink({ addresses, port: settings.port, fingerprint, code: live.code, name: hostname() }),
              expiresAt: live.expiresAt,
            }
          : null,
    }
  }

  /** A list changed; connected devices get the new complete list (debounced). */
  listChanged(kind: ListKind): void {
    if (this.#sessions.size === 0) return
    this.#pendingLists.add(kind)
    if (this.#listTimer) return
    this.#listTimer = setTimeout(() => {
      this.#listTimer = null
      const kinds = [...this.#pendingLists]
      this.#pendingLists.clear()
      for (const which of kinds) this.#sendList(which)
    }, LIST_DEBOUNCE_MS)
    this.#listTimer.unref()
  }

  /** A session's process ended: every connection's conversation watch on it ends with how. */
  sessionEnded(sessionId: string, how: SessionEnd): void {
    for (const { handle } of this.#sessions.values()) handle.sessionEnded(sessionId, how)
  }

  /** The window's interface reloaded or closed: remote watches on its sessions end; connections stay. */
  windowGone(): void {
    for (const { handle } of this.#sessions.values()) handle.windowGone()
    this.listChanged('sessions')
  }

  #sendList(kind: ListKind): void {
    const host = this.#deps.host
    let payload: unknown
    if (kind === 'sessions') {
      payload = host.sessionList()
      const text = JSON.stringify(payload)
      if (text === this.#lastSessionList) return
      this.#lastSessionList = text
    } else if (kind === 'inbox') payload = host.inboxList()
    else payload = host.handoffList()
    const frame = eventFrame(`${kind}.changed`, payload)
    for (const { connection } of this.#sessions.values()) connection.send(frame)
  }

  /**
   * Tells connected devices the address list when it changed since they were last told. Node has no
   * network-change event, so this rides the reconcile tick (and runs at once after the additional address
   * changes). **Only authenticated connections**: `#sessions` holds nothing else.
   */
  #checkAddresses(): void {
    if (this.#sessions.size === 0) return
    const addresses = this.currentAddresses()
    const text = JSON.stringify(addresses)
    if (text === this.#lastAddresses) return
    this.#lastAddresses = text
    const frame = eventFrame('addresses.changed', { addresses })
    for (const { connection } of this.#sessions.values()) connection.send(frame)
  }

  /** While a device is connected, recompute the session list now and then and send it when it changed. */
  #syncReconcile(): void {
    if (this.#sessions.size === 0) {
      this.#stopReconcile()
      return
    }
    if (this.#reconcileTimer) return
    this.#lastSessionList = JSON.stringify(this.#deps.host.sessionList())
    // The first device was just answered with this list.
    this.#lastAddresses = JSON.stringify(this.currentAddresses())
    this.#reconcileTimer = setInterval(() => {
      this.#sendList('sessions')
      this.#checkAddresses()
    }, this.#deps.reconcileMs ?? LIST_RECONCILE_MS)
    this.#reconcileTimer.unref()
  }

  #stopReconcile(): void {
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer)
    this.#reconcileTimer = null
  }

  #changed(): void {
    try {
      this.#deps.onStateChanged?.()
    } catch (error) {
      console.error(`[remote] state listener failed: ${String(error)}`)
    }
  }
}
