import type { SecretStore } from './secret-store'

/**
 * The relay grants this desktop holds for its paired phones (`phone-relay`, design D2): one per phone, made by the
 * team server (`relay.grant`), given to that phone over its authenticated remote connection.
 *
 * ## One secret entry, bound to the membership
 *
 * Kept in the secret store under one name, `team.relay` (a name per phone is ruled out by the store's name charset:
 * remote device ids are base64url), as JSON with the membership's server address and device id. A blob made for
 * another membership is discarded: that server deleted its grants with the old device.
 *
 * ## The only module that holds a grant secret in plain text
 *
 * The parsed records live in a private field and are read in exactly two places: `#serialize`, which rewrites the
 * whole blob on every change (it needs every grant's secret, not only the changed one), and `relayFor`, which builds
 * the phone's `relay` value. **Wrapping the stored secrets in `Secret` would write `"[redacted]"` to disk** through
 * `Secret.toJSON`, and after a restart the phone would be handed `[redacted]`, refused, and never given a new grant
 * (the same id is on both sides). `relay-grants.test.ts` round-trips a grant through the file to pin that.
 *
 * Every change is written first and taken after: a write that throws leaves the records as they were.
 */

export const RELAY_SECRET_NAME = 'team.relay'
const BLOB_VERSION = 1
const REDACTED = '[relay grants]'
const ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

export type GrantState = 'active' | 'revoke'

/** A grant as other modules see it: never its secret. */
export interface GrantView {
  /** The remote device id of the phone it was made for. */
  phone: string
  id: string
  name: string
  state: GrantState
}

interface GrantRecord extends GrantView {
  secret: string
}

/** Which membership the grants belong to. */
export interface GrantBinding {
  server: string
  device: string
}

/** What a phone receives (`docs/remote-protocol.md` §4, `relay`). */
export interface RelayValue {
  url: string
  fp?: string
  grant: string
  secret: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseGrant(raw: unknown): GrantRecord | null {
  if (!isRecord(raw)) return null
  const { phone, id, secret, name, state } = raw
  if (typeof phone !== 'string' || phone === '' || typeof id !== 'string' || !ID.test(id)) return null
  if (typeof secret !== 'string' || secret === '' || typeof name !== 'string') return null
  if (state !== 'active' && state !== 'revoke') return null
  return { phone, id, secret, name, state }
}

export class RelayGrants {
  readonly #secrets: SecretStore
  #binding: GrantBinding | null = null
  #records: GrantRecord[] = []

  constructor(secrets: SecretStore) {
    this.#secrets = secrets
  }

  /**
   * Reads the stored grants for this membership (`null`: none). A blob for another membership, or one that cannot
   * be read, is discarded.
   */
  load(binding: GrantBinding | null): void {
    this.#binding = binding
    this.#records = []
    const stored = this.#secrets.get(RELAY_SECRET_NAME)
    if (!stored) return
    let data: unknown
    try {
      data = JSON.parse(stored.reveal())
    } catch {
      data = null
    }
    const fits =
      binding !== null &&
      isRecord(data) &&
      data.v === BLOB_VERSION &&
      data.server === binding.server &&
      data.device === binding.device &&
      Array.isArray(data.grants)
    if (!fits) {
      this.#discardStored()
      return
    }
    const records = ((data as Record<string, unknown>).grants as unknown[]).map(parseGrant).filter((g): g is GrantRecord => g !== null)
    // One grant per phone and per id: a duplicate is the later write's leftover, kept to be revoked.
    const seenIds = new Set<string>()
    const activePhones = new Set<string>()
    for (const record of records) {
      if (seenIds.has(record.id)) continue
      seenIds.add(record.id)
      if (record.state === 'active') {
        if (activePhones.has(record.phone)) record.state = 'revoke'
        else activePhones.add(record.phone)
      }
      this.#records.push(record)
    }
  }

  /** The membership changed (joined, left, discarded): grants of another binding are dropped. */
  bind(binding: GrantBinding | null): void {
    const same = binding !== null && this.#binding !== null && binding.server === this.#binding.server && binding.device === this.#binding.device
    if (same) return
    this.#binding = binding
    if (this.#records.length > 0 || this.#secrets.has(RELAY_SECRET_NAME)) this.#discardStored()
    this.#records = []
  }

  binding(): GrantBinding | null {
    return this.#binding ? { ...this.#binding } : null
  }

  list(): GrantView[] {
    return this.#records.map(({ phone, id, name, state }) => ({ phone, id, name, state }))
  }

  activeFor(phone: string): GrantView | undefined {
    return this.list().find((g) => g.phone === phone && g.state === 'active')
  }

  byId(id: string): GrantView | undefined {
    return this.list().find((g) => g.id === id)
  }

  /** Stores a new active grant; an active grant the phone already had is marked to be revoked. */
  add(grant: { phone: string; id: string; secret: string; name: string }, state: GrantState = 'active'): void {
    if (!this.#binding) throw new Error('no membership to bind a grant to')
    if (!ID.test(grant.id) || grant.secret === '') throw new Error('not a grant')
    const next = this.#records
      .filter((r) => r.id !== grant.id)
      .map((r) => (state === 'active' && r.phone === grant.phone && r.state === 'active' ? { ...r, state: 'revoke' as const } : { ...r }))
    next.push({ ...grant, state })
    this.#commit(next)
  }

  markRevoke(id: string): boolean {
    const record = this.#records.find((r) => r.id === id)
    if (!record || record.state === 'revoke') return false
    this.#commit(this.#records.map((r) => (r.id === id ? { ...r, state: 'revoke' as const } : { ...r })))
    return true
  }

  remove(id: string): boolean {
    if (!this.#records.some((r) => r.id === id)) return false
    this.#commit(this.#records.filter((r) => r.id !== id).map((r) => ({ ...r })))
    return true
  }

  /** The phone's `relay` value, or `null` when it holds no active grant. **One of the two reads of a secret.** */
  relayFor(phone: string, server: { address: string; fingerprint?: string }): RelayValue | null {
    const record = this.#records.find((r) => r.phone === phone && r.state === 'active')
    if (!record) return null
    return {
      url: server.address,
      ...(server.fingerprint ? { fp: server.fingerprint } : {}),
      grant: record.id,
      secret: record.secret,
    }
  }

  #discardStored(): void {
    try {
      this.#secrets.clear(RELAY_SECRET_NAME)
    } catch (error) {
      console.error(`[relay] stored grants could not be removed: ${String((error as Error).message ?? error)}`)
    }
  }

  /** **The other read of a secret**: the whole blob, every grant's secret in it. */
  #serialize(records: GrantRecord[]): string {
    const binding = this.#binding as GrantBinding
    return JSON.stringify({
      v: BLOB_VERSION,
      server: binding.server,
      device: binding.device,
      grants: records.map(({ phone, id, secret, name, state }) => ({ phone, id, secret, name, state })),
    })
  }

  #commit(next: GrantRecord[]): void {
    if (next.length === 0) this.#secrets.clear(RELAY_SECRET_NAME)
    else this.#secrets.set(RELAY_SECRET_NAME, this.#serialize(next))
    this.#records = next
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }
}
