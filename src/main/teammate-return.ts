import fs from 'node:fs'
import path from 'node:path'

import type { Answer } from './team-connection'
import { MAX_DECLINE_REASON_LENGTH } from '../shared/team/limits'
import { teammateText, type MembershipStamp } from './teammate-outbox'

/**
 * Reporting back on a teammate's handoff (`teammate-handoff-return`, design D8): the store
 * `<userData>/team-return.json` and the serial sender of `handoff.update` (spekterm-server protocol §5, §12 receiving
 * rules 1–5).
 *
 * ## One at a time, in order, the same report again after a lost answer
 *
 * A report is marked `attempted` on disk before the request reaches the socket. While the head of a handoff's queue is
 * `attempted`, nothing later is sent for it: after a timeout, a dropped connection or a restart, the same report goes
 * again, and the server answers a repeat without changing anything. Only reports never attempted are merged (a newer
 * `done` replaces an older one; a `taken` is dropped behind a `done` or `declined` — `taken` is optional, rule 4).
 *
 * ## Who reports
 *
 * Each entry carries the stamp it may be reported under: the membership **and the device** whose acknowledgement was
 * answered (rule 1). Joining again as the same member gives a new device, which the server would answer
 * `HANDOFF_DELIVERED_ELSEWHERE`; the stamp says so first. Every entry of another stamp is stopped by the sweep.
 *
 * ## Stopping is visible
 *
 * A refusal that ends reporting stops the entry and empties its queue; when reports were dropped that way, `stopped`
 * is called once (a trace and a notification, in `index.ts`). A later report for a stopped or declined entry is refused
 * at once by the caller (`state()`), never sent to meet `HANDOFF_FINISHED`.
 */

export const RETURN_FILE_VERSION = 1

export { MAX_DECLINE_REASON_LENGTH }

/** The 30-second wall-clock tick (no per-entry timer: `setTimeout` overflows and sleeps). */
export const RETURN_TICK_MS = 30_000

/** An entry is removed this long after its last report, answer or stop (the server deletes its record by then). */
export const RETURN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 5 * 60_000

export type ReportStatus = 'taken' | 'declined' | 'done'

export interface QueuedReport {
  status: ReportStatus
  /** The decline reason (absent: none) or the report. Already normalized, well-formed and within its limit. */
  text?: string
  attempted?: true
  /** `HANDOFF_NOT_DELIVERED` was answered once for this report and the handoff acknowledged again. */
  reacked?: true
}

export interface ReportStamp extends MembershipStamp {
  deviceId: string
}

export interface ReturnEntry {
  stamp: ReportStamp
  handoffId: string
  /** The linked session, once one was opened for it. */
  sessionId?: string
  /** The handoff's title and its sender's display name: the teammate's text, for the trace when reports are lost. */
  title: string
  senderName: string
  queue: QueuedReport[]
  last?: { status: ReportStatus; text?: string }
  /** A decline was answered: nothing more is reported. */
  final?: true
  stopped?: { code: string; unsent: number }
  retryAt?: number
  retries?: number
  touchedAt: number
}

/** What the caller tells about a stop that dropped reports. */
export interface StoppedReports {
  handoffId: string
  title: string
  senderName: string
  code: string
  unsent: number
}

export interface ReturnTeamPort {
  membership(): MembershipStamp | null
  deviceId(): string | null
  connected(): boolean
  request(m: string, p: Record<string, unknown>): Promise<Answer>
}

export interface TeammateReturnDeps {
  /** `<userData>/team-return.json`. */
  file: string
  team: ReturnTeamPort
  /** Reports were dropped by a stop (D8: one trace and a notification). */
  stopped: (stop: StoppedReports) => void
  /** An entry stopped or became final, or a link was made: introductions may change (`refreshIntros`). */
  onChange: () => void
  /** Whether a session still exists (pruning). */
  sessionExists: (sessionId: string) => boolean
  now?: () => number
}

/** Answers that end reporting for a handoff (rule 5), and a server that does not offer the operation. */
const STOP_CODES: ReadonlySet<string> = new Set([
  'HANDOFF_FINISHED',
  'HANDOFF_EXPIRED',
  'HANDOFF_DELIVERED_ELSEWHERE',
  'HANDOFF_UNKNOWN',
  'TOO_MANY_REPORTS',
  'BAD_PARAMS',
  'UNKNOWN_OPERATION',
])

function sameStamp(a: ReportStamp, membership: MembershipStamp | null, deviceId: string | null): boolean {
  return membership !== null && deviceId !== null && a.server === membership.server && a.memberId === membership.memberId && a.deviceId === deviceId
}

export class TeammateReturn {
  readonly #deps: TeammateReturnDeps
  #entries: ReturnEntry[] = []
  #pumping = false
  #again = false
  #timer: NodeJS.Timeout | null = null

  constructor(deps: TeammateReturnDeps) {
    this.#deps = deps
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  // ---- Lifecycle ----

  start(): void {
    this.#load()
    this.#sweep()
    this.#prune()
    this.#timer = setInterval(() => this.tick(), RETURN_TICK_MS)
    this.#timer.unref()
    this.pump()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  tick(): void {
    this.#prune()
    this.pump()
  }

  connected(): void {
    this.pump()
  }

  /** The membership may have changed, or the credential was discarded: stop every entry of another stamp. */
  membershipChanged(): void {
    this.#sweep()
  }

  // ---- Queries ----

  entries(): ReturnEntry[] {
    return this.#entries.map((entry) => ({ ...entry, queue: entry.queue.map((r) => ({ ...r })) }))
  }

  /** `missing`: no entry; `stopped` / `final`: nothing more is sent; `open`: reports are taken. */
  state(handoffId: string): 'missing' | 'open' | 'stopped' | 'final' {
    const entry = this.#entries.find((e) => e.handoffId === handoffId)
    if (!entry) return 'missing'
    if (entry.stopped) return 'stopped'
    if (entry.final) return 'final'
    return 'open'
  }

  /** Whether a linked session's introduction still promises the teammate a report (D11). */
  reportsOpenFor(handoffId: string): boolean {
    return this.state(handoffId) === 'open'
  }

  // ---- Changes ----

  /** A session was opened for the handoff (D7): creates the entry or records the session on it. */
  link(input: { handoffId: string; sessionId: string; stamp: ReportStamp; title: string; senderName: string }): void {
    const existing = this.#entries.find((e) => e.handoffId === input.handoffId)
    if (existing) {
      this.#replace(existing, { ...existing, sessionId: input.sessionId, touchedAt: this.#now() })
    } else {
      this.#write([...this.#entries, { ...input, queue: [], touchedAt: this.#now() }])
    }
    this.#deps.onChange()
  }

  /**
   * Queues a report. `stopped` when the entry is stopped or final (the caller refuses it). `context` creates the entry
   * when there is none (a decline of an item never accepted).
   */
  queue(
    handoffId: string,
    report: { status: ReportStatus; text?: string },
    context?: { stamp: ReportStamp; title: string; senderName: string },
  ): 'queued' | 'stopped' | 'missing' {
    let entry = this.#entries.find((e) => e.handoffId === handoffId)
    if (!entry) {
      if (!context) return 'missing'
      entry = { handoffId, stamp: context.stamp, title: context.title, senderName: context.senderName, queue: [], touchedAt: this.#now() }
      this.#write([...this.#entries, entry])
    }
    if (entry.stopped || entry.final) return 'stopped'
    // An entry of a stamp that is not the current one cannot report: stop it now rather than queue for nothing.
    if (!sameStamp(entry.stamp, this.#deps.team.membership(), this.#deps.team.deviceId())) {
      this.#stop(entry, 'TEAM_UNAVAILABLE', entry.queue.length)
      return 'stopped'
    }
    const queue = merge(entry.queue, report, entry.last)
    this.#replace(entry, { ...entry, queue, touchedAt: this.#now() })
    this.pump()
    return 'queued'
  }

  // ---- Sending ----

  /** Sends the heads of the queues, one request at a time. A call while sending reruns once it ends. */
  pump(): void {
    if (this.#pumping) {
      this.#again = true
      return
    }
    this.#pumping = true
    void (async () => {
      try {
        do {
          this.#again = false
          await this.#drain()
        } while (this.#again)
      } catch (error) {
        console.error(`[team] reporting failed: ${String(error)}`)
      } finally {
        this.#pumping = false
      }
    })()
  }

  /** Tests: waits until no sending is in progress. */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && this.#pumping; i++) await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }

  async #drain(): Promise<void> {
    for (;;) {
      if (!this.#deps.team.connected()) return
      const membership = this.#deps.team.membership()
      const deviceId = this.#deps.team.deviceId()
      const now = this.#now()
      const entry = this.#entries.find(
        (e) =>
          e.queue.length > 0 &&
          !e.stopped &&
          !e.final &&
          sameStamp(e.stamp, membership, deviceId) &&
          !(e.retryAt !== undefined && e.retryAt > now),
      )
      if (!entry) return
      const head = entry.queue[0]
      // `attempted` before the request reaches the socket.
      const marked: ReturnEntry = { ...entry, queue: [{ ...head, attempted: true }, ...entry.queue.slice(1)] }
      this.#replace(entry, marked)
      let answer: Answer
      try {
        answer = await this.#deps.team.request('handoff.update', {
          id: entry.handoffId,
          status: head.status,
          ...(head.text !== undefined && head.status !== 'taken' ? { payload: { enc: 'none', text: head.text } } : {}),
        })
      } catch {
        // The connection ended (a timeout ends it too): the same report goes again on the next `connected`.
        return
      }
      if (!(await this.#apply(entry.handoffId, answer))) return
    }
  }

  /** The answer table of D8. `false`: stop sending for now. */
  async #apply(handoffId: string, answer: Answer): Promise<boolean> {
    const entry = this.#entries.find((e) => e.handoffId === handoffId)
    if (!entry || entry.queue.length === 0) return true
    const head = entry.queue[0]
    if (answer.ok) {
      const next: ReturnEntry = {
        ...entry,
        queue: entry.queue.slice(1),
        last: { status: head.status, ...(head.text !== undefined ? { text: head.text } : {}) },
        touchedAt: this.#now(),
        ...(head.status === 'declined' ? { final: true as const } : {}),
      }
      delete next.retryAt
      delete next.retries
      this.#replace(entry, next)
      if (next.final) this.#deps.onChange()
      return true
    }
    const code = answer.e.code
    if (code === 'HANDOFF_NOT_DELIVERED' && !head.reacked) {
      // Rule 1: acknowledge it again, then send the same report. Once per report; again ⇒ as `INTERNAL`.
      this.#replace(entry, { ...entry, queue: [{ ...head, reacked: true }, ...entry.queue.slice(1)] })
      let ack: Answer
      try {
        ack = await this.#deps.team.request('handoff.received', { id: handoffId })
      } catch {
        return false
      }
      if (ack.ok) return true
      return this.#apply(handoffId, ack)
    }
    if (STOP_CODES.has(code)) {
      this.#stop(entry, code, entry.queue.length)
      return true
    }
    if (code === 'AUTH_FAILED') return false // nothing recorded; the credential is discarded next (the sweep)
    // `INTERNAL`, a second `HANDOFF_NOT_DELIVERED`, or a code this version does not know: the same report after a backoff.
    const retries = (entry.retries ?? 0) + 1
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (retries - 1), BACKOFF_CAP_MS)
    this.#replace(entry, { ...entry, retries, retryAt: this.#now() + delay })
    return true
  }

  #stop(entry: ReturnEntry, code: string, unsent: number): void {
    const stopped: ReturnEntry = { ...entry, queue: [], stopped: { code, unsent }, touchedAt: this.#now() }
    delete stopped.retryAt
    delete stopped.retries
    this.#replace(entry, stopped)
    if (unsent > 0) {
      this.#deps.stopped({ handoffId: entry.handoffId, title: entry.title, senderName: entry.senderName, code, unsent })
    }
    this.#deps.onChange()
  }

  /** Every entry whose stamp is not the current membership and device is stopped, queued reports or not (D8). */
  #sweep(): void {
    const membership = this.#deps.team.membership()
    const deviceId = this.#deps.team.deviceId()
    for (const entry of [...this.#entries]) {
      if (entry.stopped || entry.final) continue
      if (sameStamp(entry.stamp, membership, deviceId)) continue
      this.#stop(entry, 'TEAM_UNAVAILABLE', entry.queue.length)
    }
  }

  #prune(): void {
    const now = this.#now()
    const kept = this.#entries.filter((e) => {
      if (now - e.touchedAt > RETURN_RETENTION_MS) return false
      // A linked session that is gone, with nothing left to send: nothing can report on it any more.
      if (e.sessionId !== undefined && e.queue.length === 0 && !this.#deps.sessionExists(e.sessionId)) return false
      return true
    })
    if (kept.length !== this.#entries.length) this.#write(kept)
  }

  // ---- The store ----

  #replace(previous: ReturnEntry, next: ReturnEntry): void {
    this.#write(this.#entries.map((e) => (e === previous ? next : e)))
  }

  /** Whole-file, synchronous: the file, then memory. */
  #write(entries: ReturnEntry[]): void {
    fs.mkdirSync(path.dirname(this.#deps.file), { recursive: true })
    const tmp = `${this.#deps.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: RETURN_FILE_VERSION, entries }, null, 2)}\n`, 'utf8')
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
    const entries = parseReturn(text)
    if (entries === null) {
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

/**
 * Adds a report to a queue. Only reports never attempted are merged: an attempted head is resent as it is, before
 * anything later (rule 3).
 */
export function merge(queue: readonly QueuedReport[], report: { status: ReportStatus; text?: string }, last?: { status: ReportStatus; text?: string }): QueuedReport[] {
  const next: QueuedReport = { status: report.status, ...(report.text !== undefined ? { text: report.text } : {}) }
  if (report.status === 'taken') {
    // `taken` after anything else is stale; twice is once.
    if (last || queue.length > 0) return [...queue]
    return [next]
  }
  // A later `done` or `declined` makes an unsent `taken` redundant, and a newer `done` an unsent older one.
  const kept = queue.filter((r) => r.attempted || !(r.status === 'taken' || (report.status === 'done' && r.status === 'done')))
  // The same report as the last one answered, with nothing in between, is a repeat the server ignores.
  if (kept.length === 0 && last && last.status === next.status && last.text === next.text) return kept
  return [...kept, next]
}

const STATUSES: ReadonlySet<string> = new Set(['taken', 'declined', 'done'])

function str(value: unknown): value is string {
  return typeof value === 'string'
}

function readReport(value: unknown): QueuedReport | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (!str(r.status) || !STATUSES.has(r.status)) return null
  return {
    status: r.status as ReportStatus,
    ...(str(r.text) ? { text: r.text } : {}),
    ...(r.attempted === true ? { attempted: true as const } : {}),
    ...(r.reacked === true ? { reacked: true as const } : {}),
  }
}

/** Field by field; `null` for a file that is not this shape. An unreadable entry is dropped. */
export function parseReturn(text: string): ReturnEntry[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const file = raw as Record<string, unknown>
  if (file.version !== RETURN_FILE_VERSION || !Array.isArray(file.entries)) return null
  const out: ReturnEntry[] = []
  for (const value of file.entries) {
    if (typeof value !== 'object' || value === null) continue
    const e = value as Record<string, unknown>
    const s = e.stamp as Record<string, unknown> | undefined
    if (!s || !str(s.server) || !str(s.memberId) || !str(s.deviceId)) continue
    if (!str(e.handoffId) || !str(e.title) || !str(e.senderName) || typeof e.touchedAt !== 'number' || !Array.isArray(e.queue)) continue
    const queue = e.queue.map(readReport).filter((r): r is QueuedReport => r !== null)
    const last = readReport(e.last)
    const stopped = e.stopped as Record<string, unknown> | undefined
    out.push({
      stamp: { server: s.server, memberId: s.memberId, deviceId: s.deviceId },
      handoffId: e.handoffId,
      ...(str(e.sessionId) ? { sessionId: e.sessionId } : {}),
      title: e.title,
      senderName: e.senderName,
      queue,
      ...(last ? { last: { status: last.status, ...(last.text !== undefined ? { text: last.text } : {}) } } : {}),
      ...(e.final === true ? { final: true as const } : {}),
      ...(stopped && str(stopped.code) && typeof stopped.unsent === 'number' ? { stopped: { code: stopped.code, unsent: stopped.unsent } } : {}),
      ...(typeof e.retryAt === 'number' ? { retryAt: e.retryAt } : {}),
      ...(typeof e.retries === 'number' ? { retries: e.retries } : {}),
      touchedAt: e.touchedAt,
    })
  }
  return out
}

/**
 * Declining a teammate's handoff (D9). `reason` is untrusted (it comes from the renderer): it goes through the same
 * text path as everything sent to the team server — normalized, made well-formed, then measured — and an empty one is
 * no reason. `reportable` is the incoming store's answer for this handoff (`TeammateInbox.reportable`).
 */
export function declineTeammate(input: {
  returns: Pick<TeammateReturn, 'queue'>
  handoffId: string | null
  reportable: { membership: MembershipStamp; deviceId: string } | null
  reason: unknown
  title: string
  senderName: string
}): { ok: true } | { ok: false; reason: 'unknown' | 'TOO_LONG' | 'stopped' } {
  if (!input.handoffId || !input.reportable) return { ok: false, reason: 'unknown' }
  const text = typeof input.reason === 'string' ? teammateText(input.reason).trim() : ''
  if (text.length > MAX_DECLINE_REASON_LENGTH) return { ok: false, reason: 'TOO_LONG' }
  const queued = input.returns.queue(
    input.handoffId,
    { status: 'declined', ...(text !== '' ? { text } : {}) },
    { stamp: { ...input.reportable.membership, deviceId: input.reportable.deviceId }, title: input.title, senderName: input.senderName },
  )
  return queued === 'queued' ? { ok: true } : { ok: false, reason: 'stopped' }
}

