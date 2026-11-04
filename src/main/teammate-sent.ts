import fs from 'node:fs'
import path from 'node:path'

import type { Answer } from './team-connection'
import type { MembershipStamp } from './teammate-outbox'

/**
 * The Sent list (`teammate-handoff-return`, design D1–D6): the handoffs this member sent to teammates, as the team
 * server reports them (spekterm-server protocol §5 `handoff.sync`, §10 `handoff.status`, §12 sending rules).
 *
 * ## One write per page
 *
 * A page's records and the cursor they raise go to disk in one synchronous whole-file write, so a record is durable no
 * later than its sequence number (rule 2). Every mutation is synchronous over the current memory; only the paging loop
 * awaits, and it applies each answer through those mutations. `recordSend` is therefore complete when it returns,
 * which is what lets the outbox remove its item afterwards without a window that loses the title.
 *
 * ## A reset (rule 3)
 *
 * A server restored from an older backup numbers from an older counter: while a reset is in progress, a record
 * replaces the stored one whatever its `seq`, and the cursor is set, not raised. The flag is on disk, so an interrupted
 * reset is finished by a sync from 0 whose answers do not say `reset`.
 *
 * ## Notifications (rule 5)
 *
 * Only on the device that sent the handoff, only for a change the stored copy did not have, never during a reset. A
 * record of this device's own with no stored copy notifies only when its `clientId` is a send still waiting for its
 * answer; any other such record comes from before this list existed, and notifying would replay old results.
 */

export const SENT_FILE_VERSION = 1

/** Records are kept this long after their last change (the server's own period, protocol §8). */
export const SENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Backoff after `INTERNAL`: 5 s doubling, capped at 5 minutes (the outbox's). */
const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 5 * 60_000

export type SentStatus = 'pending' | 'delivered' | 'taken' | 'declined' | 'done' | 'expired'

const STATUSES: ReadonlySet<string> = new Set(['pending', 'delivered', 'taken', 'declined', 'done', 'expired'])

/** The statuses that end a handoff for its sender; the sending device is notified of them. */
const NOTIFIED: ReadonlySet<SentStatus> = new Set(['done', 'declined', 'expired'])

export interface SentRecord {
  membership: MembershipStamp
  id: string
  clientId: string
  seq: number
  to: { id?: string; handle: string; displayName: string; removed: boolean }
  sentFrom: string
  status: SentStatus
  sentAt: number
  expiresAt: number
  changedAt?: number
  deliveredAt?: number
  reports?: number
  /** The decline reason or the latest report: written by the teammate or their agent (third-party text). */
  text?: string
  /** Only for handoffs this device sent: the title as confirmed. */
  title?: string
  /** Only for handoffs this device sent: the session whose agent wrote it. */
  sourceSessionId?: string
  /** A reset of the server's list did not include it. */
  unknownToServer?: true
}

interface Cursor {
  membership: MembershipStamp
  lastSeq: number
  resetInProgress?: true
}

/** What the renderer gets: no `clientId`, no `sentFrom`, no stamp. */
export interface SentView {
  id: string
  to: { handle: string; displayName: string; removed: boolean }
  status: SentStatus
  sentAt: number
  changedAt: number
  title?: string
  text?: string
  reports?: number
  unknownToServer?: true
}

/** A sending session's view of one of its teammate handoffs (its relations file). No text, no display name. */
export interface TeammateHandoffView {
  to: string
  title: string
  status: SentStatus
  changedAt: string
  recipientLeft?: true
}

/** One ended handoff to tell the user about. */
export interface SentNotice {
  id: string
  status: 'done' | 'declined' | 'expired'
  title?: string
  recipientName: string
  text?: string
}

export interface SentTeamPort {
  membership(): MembershipStamp | null
  /** This device's id (`team.json`'s `membership.device.id`). */
  deviceId(): string | null
  operations(): string[]
  connected(): boolean
  request(m: string, p: Record<string, unknown>): Promise<Answer>
}

export interface TeammateSentDeps {
  /** `<userData>/team-sent.json`. */
  file: string
  team: SentTeamPort
  /** The store changed: the inbox re-lists, relations files are rewritten. */
  onChange: () => void
  /** An ended handoff the sending device should be told about. */
  notify: (notice: SentNotice) => void
  /** Whether a `clientId` is a send of this device still in the outgoing store (waiting for its answer). */
  pendingSend: (clientId: string) => boolean
  now?: () => number
  /** Tests: the retry timer. */
  setTimer?: (fn: () => void, ms: number) => void
}

/** What `TeammateOutbox` knows when the server answers a send. */
export interface SendRecord {
  membership: MembershipStamp
  clientId: string
  handoffId: string
  /** The answer's `handoff.seq` (0 for a server that does not send it). */
  seq: number
  status: string
  sentAt: number
  expiresAt: number
  to: { id?: string; handle: string; displayName: string }
  title: string
  sourceSessionId: string
}

function sameStamp(a: MembershipStamp, b: MembershipStamp | null): boolean {
  return b !== null && a.server === b.server && a.memberId === b.memberId
}

function str(value: unknown): value is string {
  return typeof value === 'string'
}

function num(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A StatusRecord from the server, field by field. `null`: unreadable (skipped). */
export function readStatusRecord(data: unknown, membership: MembershipStamp): SentRecord | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  const to = d.to as Record<string, unknown> | undefined
  if (!num(d.seq) || !str(d.id) || !str(d.clientId) || !str(d.sentFrom)) return null
  if (!str(d.status) || !STATUSES.has(d.status)) return null
  if (!to || !str(to.handle) || !str(to.displayName)) return null
  if (!num(d.sentAt) || !num(d.expiresAt)) return null
  const payload = d.payload as Record<string, unknown> | undefined
  const text = payload && payload.enc === 'none' && str(payload.text) && payload.text !== '' ? payload.text : undefined
  return {
    membership,
    id: d.id,
    clientId: d.clientId,
    seq: d.seq,
    to: { ...(str(to.id) ? { id: to.id } : {}), handle: to.handle, displayName: to.displayName, removed: to.removed === true },
    sentFrom: d.sentFrom,
    status: d.status as SentStatus,
    sentAt: d.sentAt,
    expiresAt: d.expiresAt,
    ...(num(d.changedAt) ? { changedAt: d.changedAt } : {}),
    ...(num(d.deliveredAt) ? { deliveredAt: d.deliveredAt } : {}),
    ...(num(d.reports) ? { reports: d.reports } : {}),
    ...(text !== undefined ? { text } : {}),
  }
}

export class TeammateSent {
  readonly #deps: TeammateSentDeps
  #records: SentRecord[] = []
  #cursors: Cursor[] = []
  #loadIssue: 'damaged' | null = null
  #syncing = false
  #again = false
  #retries = 0
  #retryPending = false

  constructor(deps: TeammateSentDeps) {
    this.#deps = deps
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  // ---- Lifecycle ----

  start(): void {
    this.#load()
    this.#prune()
  }

  /** The connection entered `connected` (after every `hello` and `join`): sync from the stored cursor (rule 1). */
  connected(): void {
    void this.sync()
  }

  loadIssue(): 'damaged' | null {
    return this.#loadIssue
  }

  /** Whether the server offers the Sent list. */
  supported(): boolean {
    return this.#deps.team.operations().includes('handoff.sync')
  }

  // ---- Views ----

  list(): SentView[] {
    const current = this.#deps.team.membership()
    return this.#records
      .filter((record) => sameStamp(record.membership, current))
      .map((record) => ({
        id: record.id,
        to: { handle: record.to.handle, displayName: record.to.displayName, removed: record.to.removed },
        status: record.status,
        sentAt: record.sentAt,
        changedAt: record.changedAt ?? record.sentAt,
        ...(record.title !== undefined ? { title: record.title } : {}),
        ...(record.text !== undefined ? { text: record.text } : {}),
        ...(record.reports !== undefined ? { reports: record.reports } : {}),
        ...(record.unknownToServer ? { unknownToServer: true as const } : {}),
      }))
      .sort((a, b) => b.changedAt - a.changedAt)
  }

  /** The current membership's handoffs by the session that sent them (relations files, design D6). */
  bySession(): Map<string, TeammateHandoffView[]> {
    const current = this.#deps.team.membership()
    const out = new Map<string, TeammateHandoffView[]>()
    for (const record of this.#records) {
      if (!record.sourceSessionId || record.title === undefined || !sameStamp(record.membership, current)) continue
      const views = out.get(record.sourceSessionId) ?? []
      views.push({
        to: record.to.handle,
        title: record.title,
        status: record.status,
        changedAt: new Date(record.changedAt ?? record.sentAt).toISOString(),
        ...(record.to.removed ? { recipientLeft: true as const } : {}),
      })
      out.set(record.sourceSessionId, views)
    }
    return out
  }

  /** Tests and diagnostics. */
  cursor(): { lastSeq: number; resetInProgress: boolean } | null {
    const current = this.#deps.team.membership()
    const cursor = current ? this.#cursors.find((c) => sameStamp(c.membership, current)) : undefined
    return cursor ? { lastSeq: cursor.lastSeq, resetInProgress: cursor.resetInProgress === true } : null
  }

  // ---- This device's sends (design D3) ----

  /**
   * The server answered a send. **Synchronous**: when it returns, the record with its title is on disk, so the
   * outbox may then remove its item. Never moves the sync cursor (protocol §5: other handoffs may have changed).
   */
  recordSend(send: SendRecord): void {
    const status: SentStatus = STATUSES.has(send.status) ? (send.status as SentStatus) : 'pending'
    const deviceId = this.#deps.team.deviceId() ?? ''
    const existing = this.#find(send.membership, send.handoffId, send.clientId)
    if (existing && existing.seq >= send.seq && existing.seq > 0) {
      // A status record came first: it is newer or the same. Only the local fields are added.
      this.#write(
        this.#records.map((r) => (r === existing ? { ...r, title: send.title, sourceSessionId: send.sourceSessionId } : r)),
        this.#cursors,
      )
      return
    }
    const record: SentRecord = {
      membership: send.membership,
      id: send.handoffId,
      clientId: send.clientId,
      seq: send.seq,
      to: { ...(send.to.id ? { id: send.to.id } : {}), handle: send.to.handle, displayName: send.to.displayName, removed: false },
      sentFrom: deviceId,
      status,
      sentAt: send.sentAt,
      expiresAt: send.expiresAt,
      changedAt: this.#now(),
      title: send.title,
      sourceSessionId: send.sourceSessionId,
    }
    const notice = this.#noticeFor(record, existing, { reset: false, pendingSend: true })
    this.#write(existing ? this.#records.map((r) => (r === existing ? record : r)) : [...this.#records, record], this.#cursors)
    if (notice) this.#deps.notify(notice)
  }

  // ---- Events ----

  /** A `handoff.status` event (only after a `more: false` answer). */
  status(data: unknown): void {
    const current = this.#deps.team.membership()
    if (!current) return
    const record = readStatusRecord(data, current)
    if (!record) return
    const notices: SentNotice[] = []
    const records = this.#applyAll([record], current, false, notices)
    const cursor = this.#cursorOf(current)
    const cursors = this.#withCursor(current, { ...cursor, lastSeq: Math.max(cursor.lastSeq, record.seq) })
    this.#write(records, cursors)
    for (const notice of notices) this.#deps.notify(notice)
  }

  // ---- Sync (design D2) ----

  /** Pages `handoff.sync` from the stored cursor until `more: false`. One run at a time; a call during a run reruns. */
  async sync(): Promise<void> {
    if (this.#syncing) {
      this.#again = true
      return
    }
    this.#syncing = true
    try {
      do {
        this.#again = false
        await this.#syncOnce()
      } while (this.#again)
    } finally {
      this.#syncing = false
    }
  }

  async #syncOnce(): Promise<void> {
    const stamp = this.#deps.team.membership()
    if (!stamp || !this.#deps.team.connected() || !this.supported()) return
    let resetting = this.#cursorOf(stamp).resetInProgress === true
    let after = resetting ? 0 : this.#cursorOf(stamp).lastSeq
    const seen = new Set<string>()
    for (;;) {
      let answer: Answer
      try {
        answer = await this.#deps.team.request('handoff.sync', { after })
      } catch {
        // The connection ended (a timeout ends it too): the next `connected` syncs again.
        return
      }
      if (!sameStamp(stamp, this.#deps.team.membership())) return
      if (!answer.ok) {
        if (answer.e.code === 'INTERNAL') this.#scheduleRetry()
        return
      }
      this.#retries = 0
      const r = (answer.r ?? {}) as Record<string, unknown>
      const page = (Array.isArray(r.records) ? r.records : [])
        .map((entry) => readStatusRecord(entry, stamp))
        .filter((entry): entry is SentRecord => entry !== null)
      if (r.reset === true) resetting = true
      const more = r.more === true
      const notices: SentNotice[] = []
      let records = this.#applyAll(page, stamp, resetting, notices)
      for (const record of page) seen.add(record.id)
      const cursor = this.#cursorOf(stamp)
      const last = page.length > 0 ? page[page.length - 1].seq : after
      let next: Cursor
      if (resetting) {
        next = { membership: stamp, lastSeq: last, resetInProgress: true }
        if (!more) {
          // The reset is finished: what the server no longer has is marked, and the flag is cleared.
          records = records.map((record) =>
            sameStamp(record.membership, stamp) && !seen.has(record.id) && record.seq > 0
              ? { ...record, unknownToServer: true as const }
              : record,
          )
          next = { membership: stamp, lastSeq: last }
        }
      } else {
        next = { membership: stamp, lastSeq: Math.max(cursor.lastSeq, last) }
      }
      this.#write(records, this.#withCursor(stamp, next))
      for (const notice of notices) this.#deps.notify(notice)
      if (!more) return
      after = last
    }
  }

  #scheduleRetry(): void {
    if (this.#retryPending) return
    this.#retries++
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.#retries - 1), BACKOFF_CAP_MS)
    this.#retryPending = true
    const timer = this.#deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
    timer(() => {
      this.#retryPending = false
      void this.sync()
    }, delay)
  }

  // ---- Applying records ----

  #find(membership: MembershipStamp, id: string, clientId: string): SentRecord | undefined {
    return (
      this.#records.find((r) => sameStamp(r.membership, membership) && r.id === id) ??
      this.#records.find((r) => sameStamp(r.membership, membership) && r.clientId === clientId)
    )
  }

  /** Applies records to a copy of the list; pushes the notices they raise. */
  #applyAll(incoming: SentRecord[], stamp: MembershipStamp, reset: boolean, notices: SentNotice[]): SentRecord[] {
    let records = this.#records
    for (const record of incoming) {
      const existing =
        records.find((r) => sameStamp(r.membership, stamp) && r.id === record.id) ??
        records.find((r) => sameStamp(r.membership, stamp) && r.clientId === record.clientId)
      // Outside a reset a record replaces only a lower `seq` (rule 2); during one, whatever its `seq` (rule 3).
      if (existing && !reset && record.seq <= existing.seq) continue
      const merged: SentRecord = {
        ...record,
        ...(existing?.title !== undefined ? { title: existing.title } : {}),
        ...(existing?.sourceSessionId !== undefined ? { sourceSessionId: existing.sourceSessionId } : {}),
      }
      const notice = this.#noticeFor(merged, existing, { reset, pendingSend: this.#deps.pendingSend(record.clientId) })
      if (notice) notices.push(notice)
      records = existing ? records.map((r) => (r === existing ? merged : r)) : [...records, merged]
    }
    return records
  }

  #noticeFor(record: SentRecord, existing: SentRecord | undefined, context: { reset: boolean; pendingSend: boolean }): SentNotice | null {
    if (context.reset) return null
    if (!NOTIFIED.has(record.status)) return null
    const deviceId = this.#deps.team.deviceId()
    if (!deviceId || record.sentFrom !== deviceId) return null
    if (existing) {
      if (existing.status === record.status && (existing.reports ?? 0) === (record.reports ?? 0)) return null
    } else if (!context.pendingSend) {
      return null
    }
    return {
      id: record.id,
      status: record.status as SentNotice['status'],
      ...(record.title !== undefined ? { title: record.title } : {}),
      recipientName: record.to.displayName,
      ...(record.text !== undefined ? { text: record.text } : {}),
    }
  }

  #cursorOf(stamp: MembershipStamp): Cursor {
    return this.#cursors.find((c) => sameStamp(c.membership, stamp)) ?? { membership: stamp, lastSeq: 0 }
  }

  #withCursor(stamp: MembershipStamp, next: Cursor): Cursor[] {
    return [...this.#cursors.filter((c) => !sameStamp(c.membership, stamp)), next]
  }

  #prune(): void {
    const cutoff = this.#now() - SENT_RETENTION_MS
    const kept = this.#records.filter((record) => (record.changedAt ?? record.sentAt) > cutoff)
    if (kept.length !== this.#records.length) this.#write(kept, this.#cursors)
  }

  // ---- The store ----

  /** Whole-file, synchronous: the file, then memory. A write that throws leaves memory as it was. */
  #write(records: SentRecord[], cursors: Cursor[]): void {
    fs.mkdirSync(path.dirname(this.#deps.file), { recursive: true })
    const tmp = `${this.#deps.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: SENT_FILE_VERSION, cursors, records }, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.#deps.file)
    this.#records = records
    this.#cursors = cursors
    this.#deps.onChange()
  }

  #load(): void {
    let text: string
    try {
      text = fs.readFileSync(this.#deps.file, 'utf8')
    } catch {
      return
    }
    const parsed = parseSent(text)
    if (parsed === null) {
      try {
        fs.renameSync(this.#deps.file, `${this.#deps.file}.damaged-${this.#now()}`)
      } catch {
        // Left in place: the next write replaces it.
      }
      this.#loadIssue = 'damaged'
      return
    }
    this.#records = parsed.records
    this.#cursors = parsed.cursors
  }
}

function readStamp(value: unknown): MembershipStamp | null {
  if (typeof value !== 'object' || value === null) return null
  const m = value as Record<string, unknown>
  return str(m.server) && str(m.memberId) ? { server: m.server, memberId: m.memberId } : null
}

/** Field by field. `null`: not this file's shape (damaged, or a newer version). An unreadable entry is dropped. */
export function parseSent(text: string): { records: SentRecord[]; cursors: Cursor[] } | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const file = raw as Record<string, unknown>
  if (file.version !== SENT_FILE_VERSION || !Array.isArray(file.records) || !Array.isArray(file.cursors)) return null
  const cursors: Cursor[] = []
  for (const entry of file.cursors) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const membership = readStamp(e.membership)
    if (!membership || !num(e.lastSeq)) continue
    cursors.push({ membership, lastSeq: e.lastSeq, ...(e.resetInProgress === true ? { resetInProgress: true as const } : {}) })
  }
  const records: SentRecord[] = []
  for (const entry of file.records) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const membership = readStamp(e.membership)
    if (!membership) continue
    const base = readStatusRecord(
      { ...e, ...(str(e.text) ? { payload: { enc: 'none', text: e.text } } : {}) },
      membership,
    )
    if (!base) continue
    records.push({
      ...base,
      ...(str(e.title) ? { title: e.title } : {}),
      ...(str(e.sourceSessionId) ? { sourceSessionId: e.sourceSessionId } : {}),
      ...(e.unknownToServer === true ? { unknownToServer: true as const } : {}),
    })
  }
  return { records, cursors }
}
