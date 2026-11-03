import fs from 'node:fs'
import path from 'node:path'

import { isPermanentRejection } from './intake-rejection'
import { normalizeAuthored, type DeliveryProvenance } from './intake-schema'
import type { DeliverOutcome } from './intake-service'
import type { Answer } from './team-connection'
import type { MembershipStamp } from './teammate-outbox'

/**
 * Receiving a teammate's handoff (`teammate-handoff`, design D9–D10): the hidden store
 * `<userData>/team-incoming.json` in front of the inbox, and the receiving rules the team server's delivery rests on
 * (spekterm-server protocol §11).
 *
 * ## Hidden, then acknowledged, then shown
 *
 * An offer is written to this store (`stored`) **before** `handoff.received` is sent, and enters the inbox only once
 * the acknowledgement is answered `{}` (`acked`, then `shown`). The inbox never sees a `stored` entry. Acknowledging
 * first would let a crash lose a handoff the server counts as delivered here.
 *
 * ## The item is built from the stored entry
 *
 * Never from a later event: a repeat with a changed display name would otherwise change the inbox item's digest and
 * raise a false "identifier taken" warning.
 *
 * ## The sender comes from the server
 *
 * The event's `from` is the sender as the server knows them, verified by its credential. It becomes the item's
 * origin and actor; nothing in the text is parsed for it. The adapter `teammate` is what makes an item a teammate's:
 * a file in the shared drop point can declare the same origin kind.
 */

export const INCOMING_FILE_VERSION = 1

/** The adapter of a teammate's handoff in the inbox. Only this adapter makes an item a teammate's. */
export const TEAMMATE_ADAPTER = 'teammate'

/** The origin kind of a teammate's handoff. A file in the shared drop point can declare it too. */
export const TEAMMATE_ORIGIN_KIND = 'teammate'

/** The tick that delivers acknowledged entries and stores offers kept in memory. */
export const INCOMING_TICK_MS = 30_000

/** `shown` and `gone` entries keep their id this long past `expiresAt`, to recognise a repeat. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000

/** The protocol's id rule (§5): 1–64 of `[A-Za-z0-9_-]`, not starting with `-`. Case-sensitive. */
const SERVER_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

/** The protocol's handle rule (§5 `join`): 1–32 of `[a-z0-9-]`, starting with a letter or digit. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,31}$/

export type IncomingState = 'stored' | 'acked' | 'shown' | 'gone'

export interface IncomingEntry {
  id: string
  state: IncomingState
  membership: MembershipStamp
  expiresAt: number
  /** The content, while it may still enter the inbox (`stored`, `acked`). */
  from?: { id: string; handle: string; displayName: string }
  team?: string
  title?: string
  body?: string
  sentAt?: number
  /** Shown after the credential was discarded with its acknowledgement unanswered (protocol §11 rule 6). */
  possiblyElsewhere?: true
}

/** A `handoff.incoming` event, as read. */
interface Offer {
  id: string
  from: { id: string; handle: string; displayName: string }
  title: string
  body: string
  sentAt: number
  expiresAt: number
}

/** The team as the receiving side sees it. Adapted from `TeamService` in `index.ts`; tests fake it. */
export interface InboxTeamPort {
  membership(): MembershipStamp | null
  /** The team's name now (kept with the entry at arrival). */
  teamName(): string
  operations(): string[]
  connected(): boolean
  request(m: string, p: Record<string, unknown>): Promise<Answer>
}

export interface TeammateInboxDeps {
  /** `<userData>/team-incoming.json`. */
  file: string
  team: InboxTeamPort
  /** `IntakeService.deliver(contents, 'teammate', provenance)`. */
  deliver: (contents: string, provenance: DeliveryProvenance) => Promise<DeliverOutcome>
  /** Whether the inbox has room for one more pending item. */
  hasRoom: () => boolean
  /** One visible trace for an offer this version cannot read, keyed by its intake id. */
  unreadable: (key: string) => void
  now?: () => number
}

/**
 * The intake id of a teammate's handoff: `teammate:` + the server's id with `_` mapped to `.`. Reversible (`.` is
 * not in the server's set, `_` not in the inbox's), and at most 73 bytes. `null` for an id outside the protocol's
 * rule: an offer spekterm cannot key.
 */
export function teammateIntakeId(serverId: string): string | null {
  if (!SERVER_ID.test(serverId)) return null
  return `teammate:${serverId.replace(/_/g, '.')}`
}

/** Reads an event's data. `{ unreadable }` names the intake key for the trace (or the raw id when it has none). */
export function readOffer(data: unknown): { offer: Offer } | { unreadable: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  const rawId = typeof d.id === 'string' ? d.id : ''
  const key = teammateIntakeId(rawId)
  const traceKey = key ?? `teammate:(unreadable)`
  if (!key) return { unreadable: traceKey }
  const from = d.from as Record<string, unknown> | undefined
  const payload = d.payload as Record<string, unknown> | undefined
  if (!payload || payload.enc !== 'none') return { unreadable: key }
  if (!from || typeof from.handle !== 'string' || !HANDLE.test(from.handle)) return { unreadable: key }
  if (typeof from.id !== 'string' || typeof from.displayName !== 'string') return { unreadable: key }
  if (typeof payload.title !== 'string' || typeof payload.body !== 'string') return { unreadable: key }
  if (typeof d.expiresAt !== 'number' || typeof d.sentAt !== 'number') return { unreadable: key }
  return {
    offer: {
      id: rawId,
      from: { id: from.id, handle: from.handle, displayName: from.displayName },
      title: payload.title,
      body: payload.body,
      sentAt: d.sentAt,
      expiresAt: d.expiresAt,
    },
  }
}

function sameStamp(a: MembershipStamp, b: MembershipStamp | null): boolean {
  return b !== null && a.server === b.server && a.memberId === b.memberId
}

export class TeammateInbox {
  readonly #deps: TeammateInboxDeps
  #entries: IncomingEntry[] = []
  /** Offers kept in memory while the inbox is full (rule 7), for the connection they came on. */
  #memory = new Map<string, Offer>()
  #inflight = new Set<string>()
  #traced = new Set<string>()
  #timer: NodeJS.Timeout | null = null
  #queue: Promise<unknown> = Promise.resolve()

  constructor(deps: TeammateInboxDeps) {
    this.#deps = deps
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  // ---- Lifecycle ----

  start(): void {
    this.#load()
    this.#timer = setInterval(() => void this.tick(), INCOMING_TICK_MS)
    this.#timer.unref()
    void this.#run(() => this.#sweepOtherMembership())
    void this.tick()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Waits for every queued step (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await this.#queue
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** The entries, for tests. */
  entries(): IncomingEntry[] {
    return this.#entries.map((entry) => ({ ...entry }))
  }

  // ---- Events ----

  /** `handoff.incoming`. */
  incoming(data: unknown): void {
    const read = readOffer(data)
    if (!read) return
    if ('unreadable' in read) {
      // Not stored, not acknowledged: the server keeps it for the member's other device. One trace per id.
      if (!this.#traced.has(read.unreadable)) {
        this.#traced.add(read.unreadable)
        this.#deps.unreadable(read.unreadable)
      }
      return
    }
    const offer = read.offer
    void this.#run(async () => {
      const known = this.#entries.find((entry) => entry.id === offer.id)
      if (known) {
        // Rule 2: acknowledge again, show nothing.
        this.#acknowledge(offer.id)
        return
      }
      if (!this.#deps.hasRoom()) {
        // Rule 7: kept in memory only, not stored and not acknowledged.
        this.#memory.set(offer.id, offer)
        return
      }
      await this.#store(offer)
    })
  }

  /** The connection is (back) up: rule 3 and rule 5 (no `handoff.received`), then what memory and the store hold. */
  connected(): void {
    void this.#run(() => {
      const current = this.#deps.team.membership()
      const canAcknowledge = this.#deps.team.operations().includes('handoff.received')
      const mine = (entry: IncomingEntry): boolean => entry.state === 'stored' && sameStamp(entry.membership, current)
      if (canAcknowledge) {
        for (const entry of this.#entries) if (mine(entry)) this.#acknowledge(entry.id)
        return
      }
      if (this.#entries.some(mine)) this.#save(this.#entries.map((entry) => (mine(entry) ? { ...entry, state: 'acked' as const } : entry)))
    })
    void this.tick()
  }

  /** The connection ended: offers kept in memory are dropped; the server offers them again. */
  disconnected(): void {
    this.#memory.clear()
  }

  /**
   * The credential was discarded (rule 6, as changed upstream): stored entries whose acknowledgement was never
   * answered are shown, marked as possibly delivered to the member's other device too. `acked` ones are kept.
   */
  credentialDiscarded(): void {
    this.#memory.clear()
    void this.#run(() => this.#sweepOtherMembership())
    void this.tick()
  }

  /** The membership may have changed (a discard not observed): the same rule for entries of another membership. */
  membershipChanged(): void {
    void this.#run(() => this.#sweepOtherMembership())
    void this.tick()
  }

  #sweepOtherMembership(): void {
    const current = this.#deps.team.membership()
    const orphan = (entry: IncomingEntry): boolean => entry.state === 'stored' && !sameStamp(entry.membership, current)
    if (!this.#entries.some(orphan)) return
    this.#save(this.#entries.map((entry) => (orphan(entry) ? { ...entry, state: 'acked' as const, possiblyElsewhere: true as const } : entry)))
  }

  /** Delivers every `acked` entry while the inbox has room, stores and acknowledges what memory holds, prunes. */
  tick(): Promise<void> {
    return this.#run(async () => {
      for (const entry of this.#entries.filter((e) => e.state === 'acked')) {
        if (!this.#deps.hasRoom()) break
        await this.#deliver(entry)
      }
      if (this.#deps.team.connected()) {
        for (const offer of [...this.#memory.values()]) {
          if (!this.#deps.hasRoom()) break
          this.#memory.delete(offer.id)
          if (!this.#entries.some((entry) => entry.id === offer.id)) await this.#store(offer)
        }
      }
      this.#prune()
    })
  }

  // ---- Steps ----

  /** Rule 1: written first (the file, then memory), then acknowledged. */
  async #store(offer: Offer): Promise<void> {
    const membership = this.#deps.team.membership()
    if (!membership) return
    const entry: IncomingEntry = {
      id: offer.id,
      state: 'stored',
      membership: { ...membership },
      expiresAt: offer.expiresAt,
      from: offer.from,
      team: this.#deps.team.teamName(),
      title: offer.title,
      body: offer.body,
      sentAt: offer.sentAt,
    }
    this.#save([...this.#entries, entry])
    if (this.#deps.team.operations().includes('handoff.received')) {
      this.#acknowledge(offer.id)
      return
    }
    // Rule 5: a server that does not offer the acknowledgement leaves spekterm's copy the only one.
    await this.#deliver(this.#acked(entry))
  }

  /** At most one acknowledgement per handoff in flight. Its answer is applied through the queue. */
  #acknowledge(id: string): void {
    if (this.#inflight.has(id)) return
    if (!this.#deps.team.connected() || !this.#deps.team.operations().includes('handoff.received')) return
    this.#inflight.add(id)
    void this.#deps.team
      .request('handoff.received', { id })
      .then(
        (answer) => this.#run(() => this.#answered(id, answer)),
        () => undefined, // the connection ended: acknowledged again after reconnecting (rule 3)
      )
      .finally(() => this.#inflight.delete(id))
  }

  async #answered(id: string, answer: Answer): Promise<void> {
    const entry = this.#entries.find((e) => e.id === id)
    if (!entry) return
    if (answer.ok) {
      // `{}` for an entry not waiting for one changes nothing.
      if (entry.state !== 'stored') return
      const acked = this.#acked(entry)
      if (this.#deps.hasRoom()) await this.#deliver(acked)
      return
    }
    switch (answer.e.code) {
      case 'HANDOFF_DELIVERED_ELSEWHERE':
      case 'HANDOFF_EXPIRED':
        // Rule 4: removed without having been shown; the id is kept to recognise a repeat.
        if (entry.state === 'stored') this.#strip(entry, 'gone')
        return
      case 'HANDOFF_UNKNOWN':
        // Rule 5: spekterm's copy is the only one left.
        if (entry.state === 'stored') {
          const acked = this.#acked(entry)
          if (this.#deps.hasRoom()) await this.#deliver(acked)
        }
        return
      default:
        // Left stored: acknowledged again at the next connection.
        return
    }
  }

  #acked(entry: IncomingEntry): IncomingEntry {
    const acked: IncomingEntry = { ...entry, state: 'acked' }
    this.#save(this.#entries.map((e) => (e === entry ? acked : e)))
    return acked
  }

  /** Into the inbox, built from the stored entry only. */
  async #deliver(entry: IncomingEntry): Promise<void> {
    if (entry.state !== 'acked' || !entry.from || entry.title === undefined || entry.body === undefined) return
    const id = teammateIntakeId(entry.id)
    if (!id) return
    const contents = JSON.stringify({ id, title: entry.title, body: entry.body, actor: entry.from.displayName })
    const provenance: DeliveryProvenance = {
      origin: { kind: TEAMMATE_ORIGIN_KIND, id: entry.from.handle, label: entry.team ?? '' },
      handoffBodyLimit: true,
      ...(entry.possiblyElsewhere ? { possiblyElsewhere: true } : {}),
    }
    let outcome: DeliverOutcome
    try {
      outcome = await this.#deps.deliver(contents, provenance)
    } catch (error) {
      console.error(`[team] could not deliver a teammate's handoff: ${String(error)}`)
      return
    }
    if (outcome.ok || (outcome.code === 'DUPLICATE' && !outcome.notify)) {
      this.#strip(entry, 'shown')
      return
    }
    if (outcome.code === 'CAPACITY') return
    // A permanent refusal: its trace in the inbox is the visible outcome, and the entry must not loop.
    if (outcome.code && isPermanentRejection({ code: outcome.code, notify: outcome.notify })) this.#strip(entry, 'shown')
  }

  /** Keeps the id and state only. */
  #strip(entry: IncomingEntry, state: 'shown' | 'gone'): void {
    const kept: IncomingEntry = { id: entry.id, state, membership: entry.membership, expiresAt: entry.expiresAt }
    this.#save(this.#entries.map((e) => (e === entry ? kept : e)))
  }

  #prune(): void {
    const now = this.#now()
    const kept = this.#entries.filter((e) => !((e.state === 'shown' || e.state === 'gone') && now > e.expiresAt + PRUNE_AFTER_MS))
    if (kept.length !== this.#entries.length) this.#save(kept)
  }

  // ---- The store ----

  #run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn)
    this.#queue = next.catch((error: unknown) => console.error(`[team] receiving failed: ${String(error)}`))
    return next
  }

  /** Whole-file, synchronous: the file, then memory. */
  #save(entries: IncomingEntry[] = this.#entries): void {
    fs.mkdirSync(path.dirname(this.#deps.file), { recursive: true })
    const tmp = `${this.#deps.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: INCOMING_FILE_VERSION, entries }, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.#deps.file)
    this.#entries = entries
  }

  #load(): void {
    let text: string
    try {
      text = fs.readFileSync(this.#deps.file, 'utf8')
    } catch {
      return
    }
    const entries = parseIncoming(text)
    if (entries === null) {
      // A damaged store is set aside; its handoffs are offered again by the server where it still holds them.
      try {
        fs.renameSync(this.#deps.file, `${this.#deps.file}.damaged-${this.#now()}`)
      } catch {
        // Replaced by the next write.
      }
      return
    }
    this.#entries = entries
  }
}

const STATES: ReadonlySet<string> = new Set(['stored', 'acked', 'shown', 'gone'])

/** Field by field; `null` for a file that is not this shape. An unreadable entry is dropped. */
export function parseIncoming(text: string): IncomingEntry[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const file = raw as Record<string, unknown>
  if (file.version !== INCOMING_FILE_VERSION || !Array.isArray(file.entries)) return null
  const out: IncomingEntry[] = []
  for (const value of file.entries) {
    if (typeof value !== 'object' || value === null) continue
    const e = value as Record<string, unknown>
    const m = e.membership as Record<string, unknown> | undefined
    if (typeof e.id !== 'string' || !SERVER_ID.test(e.id) || typeof e.state !== 'string' || !STATES.has(e.state)) continue
    if (!m || typeof m.server !== 'string' || typeof m.memberId !== 'string' || typeof e.expiresAt !== 'number') continue
    const f = e.from as Record<string, unknown> | undefined
    const from =
      f && typeof f.id === 'string' && typeof f.handle === 'string' && HANDLE.test(f.handle) && typeof f.displayName === 'string'
        ? { id: f.id, handle: f.handle, displayName: f.displayName }
        : undefined
    const entry: IncomingEntry = {
      id: e.id,
      state: e.state as IncomingState,
      membership: { server: m.server, memberId: m.memberId },
      expiresAt: e.expiresAt,
      ...(from ? { from } : {}),
      ...(typeof e.team === 'string' ? { team: normalizeAuthored(e.team) } : {}),
      ...(typeof e.title === 'string' ? { title: e.title } : {}),
      ...(typeof e.body === 'string' ? { body: e.body } : {}),
      ...(typeof e.sentAt === 'number' ? { sentAt: e.sentAt } : {}),
      ...(e.possiblyElsewhere === true ? { possiblyElsewhere: true as const } : {}),
    }
    // An entry that still has to enter the inbox needs its content; one without it cannot.
    if ((entry.state === 'stored' || entry.state === 'acked') && (!entry.from || entry.title === undefined || entry.body === undefined)) continue
    out.push(entry)
  }
  return out
}
