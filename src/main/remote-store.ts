import fs from 'node:fs'
import path from 'node:path'
import { type RemoteIdentity, fingerprintOf, generateIdentity, keyMatchesCertificate } from './remote-cert'
import type { SecretStore } from './secret-store'

/**
 * Remote access settings, the certificate and the paired devices (`remote.json`), and the TLS key in the
 * secret store (`remote-access`, design D2 / D3 / D10 of `mobile-remote-bridge`).
 *
 * ## Its own file, not `preferences.json`
 *
 * The device list is not a preference, and it holds credential hashes that must never be projected. Like
 * `slack.json`, the renderer receives a field-whitelisted projection (`project()`), never this object.
 *
 * ## The key and the certificate live in different files, and either can be lost on its own
 *
 * A corrupt `secrets.json` is set aside whole. So whenever the identity is needed, the key is checked
 * against the certificate. A missing or mismatched key **resets** remote access (new certificate, every
 * device revoked) and leaves a notice for the dialog — a silent regeneration would make every phone fail
 * to connect with no explanation.
 */

export const REMOTE_SETTINGS_VERSION = 1
export const DEFAULT_REMOTE_PORT = 47615
const PORT_MIN = 1024
const PORT_MAX = 65535

/** The secret-store entry of the TLS private key. */
export const TLS_KEY_SECRET = 'remote.tlsKey'

/** Display fields from a device are clipped to this many code points. */
const DEVICE_FIELD_MAX = 64

export interface RemoteDevice {
  id: string
  name: string
  model: string
  pairedAt: number
  lastSeenAt?: number
  /** `sha256(secret)`, hex. The secret itself is never stored (`remote-access`). */
  secretHash: string
}

export type ResetReason = 'key-missing' | 'key-mismatch'

export interface RemoteSettings {
  enabled: boolean
  port: number
  /** Another address put into the pairing link, such as a DDNS name for a port forward. */
  additionalAddress?: string
  certPem?: string
  devices: RemoteDevice[]
  /** Set when remote access reset itself; shown in the dialog until the user dismisses it. */
  resetNotice?: { at: number; reason: ResetReason }
}

/** What the renderer receives about one device: no hash, nothing secret. */
export interface ProjectedDevice {
  id: string
  name: string
  model: string
  pairedAt: number
  lastSeenAt?: number
}

export function sanitizePort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= PORT_MIN && value <= PORT_MAX ? value : undefined
}

/**
 * A host name or an IP literal, as typed. It goes into the pairing link, whose address list is
 * comma-separated, so anything outside host-name and IP-literal characters is refused.
 */
export function sanitizeAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 253) return undefined
  return /^[A-Za-z0-9.:\-[\]]+$/.test(trimmed) ? trimmed : undefined
}

/** A device's self-reported name or model: control characters removed, clipped. */
export function sanitizeDeviceField(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  // eslint-disable-next-line no-control-regex
  const cleaned = [...value.replace(/[\x00-\x1f\x7f]/g, '').trim()].slice(0, DEVICE_FIELD_MAX).join('')
  return cleaned === '' ? fallback : cleaned
}

function parseDevice(raw: unknown): RemoteDevice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(o.id)) return null
  if (typeof o.secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(o.secretHash)) return null
  if (typeof o.pairedAt !== 'number' || !Number.isFinite(o.pairedAt)) return null
  return {
    id: o.id,
    name: sanitizeDeviceField(o.name, 'device'),
    model: sanitizeDeviceField(o.model, ''),
    pairedAt: o.pairedAt,
    ...(typeof o.lastSeenAt === 'number' && Number.isFinite(o.lastSeenAt) ? { lastSeenAt: o.lastSeenAt } : {}),
    secretHash: o.secretHash,
  }
}

/** `null` when the content cannot be trusted. Strict on structure, lenient on single fields. */
export function parseRemoteSettings(raw: string): RemoteSettings | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const { version, remote } = data as Record<string, unknown>
  if (version !== REMOTE_SETTINGS_VERSION) return null
  if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) return null
  const o = remote as Record<string, unknown>
  const devices = Array.isArray(o.devices) ? o.devices.map(parseDevice).filter((d): d is RemoteDevice => d !== null) : []
  const notice = o.resetNotice as Record<string, unknown> | undefined
  const additionalAddress = sanitizeAddress(o.additionalAddress)
  return {
    enabled: o.enabled === true,
    port: sanitizePort(o.port) ?? DEFAULT_REMOTE_PORT,
    ...(additionalAddress ? { additionalAddress } : {}),
    ...(typeof o.certPem === 'string' && o.certPem.includes('BEGIN CERTIFICATE') ? { certPem: o.certPem } : {}),
    devices,
    ...(notice &&
    typeof notice.at === 'number' &&
    (notice.reason === 'key-missing' || notice.reason === 'key-mismatch')
      ? { resetNotice: { at: notice.at, reason: notice.reason } }
      : {}),
  }
}

/** Owner-only, like `secrets.json`: the file holds credential hashes. */
const OWNER_ONLY = 0o600

function writeAtomic(filePath: string, settings: RemoteSettings): void {
  const tmp = `${filePath}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify({ version: REMOTE_SETTINGS_VERSION, remote: settings }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  })
  try {
    fs.chmodSync(tmp, OWNER_ONLY)
  } catch {
    // A platform without POSIX modes.
  }
  fs.renameSync(tmp, filePath)
}

function quarantine(filePath: string): string | null {
  const target = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    fs.renameSync(filePath, target)
    return target
  } catch {
    return null
  }
}

function defaults(): RemoteSettings {
  return { enabled: false, port: DEFAULT_REMOTE_PORT, devices: [] }
}

export class RemoteStore {
  #settings: RemoteSettings = defaults()
  readonly #listeners = new Set<() => void>()

  constructor(
    private readonly filePath: string,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
    private readonly generate: () => RemoteIdentity = () => generateIdentity(),
  ) {}

  /** A read failure never keeps the application from starting. */
  load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[remote] settings unreadable, starting with defaults: ${String(error)}`)
      }
      this.#settings = defaults()
      return
    }
    const parsed = parseRemoteSettings(raw)
    if (!parsed) {
      const kept = quarantine(this.filePath)
      console.error(
        `[remote] settings unparsable, starting with defaults` +
          (kept ? `; the original was kept at ${kept}` : `; the original could not be kept`),
      )
      this.#settings = defaults()
      return
    }
    this.#settings = parsed
  }

  get(): RemoteSettings {
    return { ...this.#settings, devices: this.#settings.devices.map((device) => ({ ...device })) }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  setEnabled(enabled: boolean): void {
    this.#update({ enabled })
  }

  /** An out-of-range or non-integer port is refused (the setting is unchanged). Returns whether it was taken. */
  setPort(port: unknown): boolean {
    const value = sanitizePort(port)
    if (value === undefined) return false
    this.#update({ port: value })
    return true
  }

  /** `null` or an empty string clears it; an invalid value is refused. Returns whether it was taken. */
  setAdditionalAddress(address: unknown): boolean {
    if (address === null || address === '') {
      const next = { ...this.#settings }
      delete next.additionalAddress
      this.#replace(next)
      return true
    }
    const value = sanitizeAddress(address)
    if (value === undefined) return false
    this.#update({ additionalAddress: value })
    return true
  }

  /**
   * The identity the listener presents. Generated the first time; **reset** when the stored key is
   * missing or does not belong to the stored certificate (see the file header).
   */
  identity(): RemoteIdentity {
    const certPem = this.#settings.certPem
    const keyPem = this.secrets.get(TLS_KEY_SECRET)?.reveal()
    if (!certPem) return this.#install(this.generate(), { devices: [] })
    if (!keyPem) return this.#install(this.generate(), { devices: [], resetNotice: { at: this.now(), reason: 'key-missing' } })
    if (!keyMatchesCertificate(keyPem, certPem)) {
      return this.#install(this.generate(), { devices: [], resetNotice: { at: this.now(), reason: 'key-mismatch' } })
    }
    return { keyPem, certPem, fingerprint: fingerprintOf(certPem) }
  }

  /** The fingerprint of the stored certificate, if there is one. */
  fingerprint(): string | undefined {
    return this.#settings.certPem ? fingerprintOf(this.#settings.certPem) : undefined
  }

  /** The user's reset: a new identity and no devices. No notice — the user did it. */
  reset(): RemoteIdentity {
    const next = { ...this.#settings }
    delete next.resetNotice
    this.#replace(next)
    return this.#install(this.generate(), { devices: [] })
  }

  dismissResetNotice(): void {
    if (!this.#settings.resetNotice) return
    const next = { ...this.#settings }
    delete next.resetNotice
    this.#replace(next)
  }

  addDevice(device: { id: string; name: unknown; model: unknown; secretHash: string }): RemoteDevice {
    const record: RemoteDevice = {
      id: device.id,
      name: sanitizeDeviceField(device.name, 'device'),
      model: sanitizeDeviceField(device.model, ''),
      pairedAt: this.now(),
      secretHash: device.secretHash,
    }
    this.#update({ devices: [...this.#settings.devices, record] })
    return { ...record }
  }

  device(id: string): RemoteDevice | undefined {
    const found = this.#settings.devices.find((device) => device.id === id)
    return found ? { ...found } : undefined
  }

  /** Returns whether a device was removed. */
  removeDevice(id: string): boolean {
    const devices = this.#settings.devices.filter((device) => device.id !== id)
    if (devices.length === this.#settings.devices.length) return false
    this.#update({ devices })
    return true
  }

  touchDevice(id: string): void {
    const at = this.now()
    this.#update({
      devices: this.#settings.devices.map((device) => (device.id === id ? { ...device, lastSeenAt: at } : device)),
    })
  }

  /** The devices as the renderer may see them: a field whitelist, no hash. */
  projectDevices(): ProjectedDevice[] {
    return this.#settings.devices.map(({ id, name, model, pairedAt, lastSeenAt }) => ({
      id,
      name,
      model,
      pairedAt,
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    }))
  }

  #install(identity: RemoteIdentity, patch: Partial<RemoteSettings>): RemoteIdentity {
    this.secrets.set(TLS_KEY_SECRET, identity.keyPem)
    this.#update({ ...patch, certPem: identity.certPem })
    return identity
  }

  #update(patch: Partial<RemoteSettings>): void {
    this.#replace({ ...this.#settings, ...patch })
  }

  #replace(next: RemoteSettings): void {
    this.#settings = next
    try {
      writeAtomic(this.filePath, next)
    } catch (error) {
      console.error(`[remote] settings could not be written: ${String(error)}`)
    }
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error(`[remote] settings listener failed: ${String(error)}`)
      }
    }
  }
}
