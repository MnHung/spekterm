import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  isPermanentTeammateRefusal,
  receiptReason,
  teammateReceiptReason,
  type TeammateReceiptCode,
  type TeammateRefusalCode,
} from './agent-protocol-copy'
import type { TeammatePayload } from './handoff-delivery'
import { type Receipt, rewriteReceipt } from './handoff-receipt'
import { isPermanentRejection } from './intake-rejection'
import { type IntakeRejection, MAX_FIELD_LENGTH, MAX_TEAMMATE_BODY_LENGTH, normalizeAuthored } from './intake-schema'
import type { DeliverOutcome, FailureContext } from './intake-service'
import type { Answer } from './team-connection'
import type { TeamMember } from './team-store'
import type { SendRecord } from './teammate-sent'

/**
 * Handing work to a teammate (`teammate-handoff`): reading a `to` delivery, the outgoing store
 * `<userData>/team-outgoing.json`, the user's Send / Discard / Dismiss, and sending with `handoff.send`.
 *
 * ## Nothing leaves before the user presses Send
 *
 * A read delivery waits (`awaiting`). Only Send makes it `confirmed`, and only a confirmed item is ever requested.
 * The text stored when it was read is the text shown and the text sent: one value, never re-derived.
 *
 * ## One queue (design D3)
 *
 * Every mutation — read, Send, Discard, Dismiss, recording `attempted`, applying an answer, the sweep — runs
 * through one serial queue, and each write is synchronous and whole (the file, then memory). A Discard queued
 * before "record attempted" removes the item, and the send finds nothing; one queued after it finds `attempted`
 * and is refused. That is "Discard sends nothing".
 *
 * ## The membership stamp
 *
 * Each item records the server and member it was read under, and only items of the current membership are offered
 * or sent. A handle on one team can be another person on the next, and a `clientId` belongs to one member's space.
 * Items of another membership are refused — at the discard, and as a sweep at every start and membership change,
 * so an interrupted discard leaves nothing waiting unseen.
 *
 * ## `attempted`
 *
 * Written before the request reaches the socket; cleared only by an answer proving the server did not store it.
 * While set, Discard is not offered, and a restart resends with the same `clientId` (the server recognises a
 * resend by sender and `clientId` before it checks the rate limit).
 */

export const OUTGOING_FILE_VERSION = 1

/** At most this many teammate handoffs wait for confirmation; a further one is held (`OUTGOING_FULL`). */
export const MAX_OUTGOING_WAITING = 20

/** How long the read path waits for a members refetch when a handle is not in the kept list. */
export const MEMBERS_REFETCH_WAIT_MS = 3_000

/** The wall-clock tick that sends what is due (no per-item timer: `setTimeout` overflows and sleeps). */
export const SEND_TICK_MS = 30_000

/** Backoff after `INTERNAL` or no answer: 5 s doubling, capped at 5 minutes. */
const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 5 * 60_000

/** When `RATE_LIMITED` carries no usable `retryAt`. */
const RATE_LIMIT_FALLBACK_MS = 60_000

export type OutgoingState = 'awaiting' | 'confirmed' | 'sent' | 'refused'

export interface MembershipStamp {
  server: string
  memberId: string
}

export interface OutgoingItem {
  id: string
  clientId: string
  membership: MembershipStamp
  source: { sessionId: string; label: string; title?: string }
  receipt: { sessionId: string; file: string }
  /** The member's handle from the list — what is shown and sent. */
  to: string
  /** The display name kept when the handoff was read. */
  recipientName: string
  title: string
  body: string
  readAt: number
  state: OutgoingState
  attempted?: true
  retryAt?: number
  retries?: number
  /** What the last answer made it wait for. */
  waiting?: 'RATE_LIMITED' | 'RETRYING'
  refusal?: { code: TeammateRefusalCode | 'TEAM_UNAVAILABLE' | 'SEND_UNCERTAIN' }
  noDevice?: true
  handoffId?: string
}

/** What the renderer gets: no `clientId`, no membership stamp. */
export interface OutgoingView {
  id: string
  to: string
  recipientName: string
  source: { label: string; title?: string }
  title: string
  body: string
  readAt: number
  state: OutgoingState
  /** For a confirmed item: what it waits for. */
  phase?: 'sending' | 'waiting-connection' | 'rate-limited' | 'retrying'
  retryAt?: number
  refusal?: string
  noDevice?: true
  canSend: boolean
  canDiscard: boolean
  canDismiss: boolean
}

/** The team as the outbox sees it. Adapted from `TeamService` in `index.ts`; tests fake it. */
export interface TeamPort {
  /** The Team feature is on. */
  enabled(): boolean
  membership(): MembershipStamp | null
  /** The user's own handle, when on a team. */
  self(): string | null
  /** The kept members list. */
  members(): TeamMember[]
  connected(): boolean
  operations(): string[]
  refreshMembers(options: { maxWaitMs?: number }): Promise<TeamMember[] | null>
  request(m: string, p: Record<string, unknown>): Promise<Answer>
}

export interface TeammateOutboxDeps {
  /** `<userData>/team-outgoing.json`. */
  file: string
  team: TeamPort
  /** The session's receipts directory (`receiptsDir`). */
  receiptsDir: (sessionId: string) => string
  /** A refusal at reading, recorded as an inbox trace (`IntakeService.reject`). */
  reject: (code: IntakeRejection, label: string, detail?: string, failure?: FailureContext) => DeliverOutcome
  /** A refusal after reading (the sweep), made visible as a handoff failure is: a trace, and a notification when permanent. */
  refusedLater: (code: 'TEAM_UNAVAILABLE' | 'SEND_UNCERTAIN', item: OutgoingView) => void
  /** The outgoing store changed: the inbox re-lists (its "changed" signal). */
  onChange: () => void
  /** A teammate handoff started waiting for confirmation (the notification). */
  onArrival: (item: OutgoingView) => void
  /**
   * The server answered a send (`teammate-handoff-return`, design D3): the Sent list records it **synchronously**,
   * before this store removes the item, so a crash in between cannot lose the title.
   */
  recordSend?: (send: SendRecord) => void
  now?: () => number
  /** Tests: the clientId's random bytes. */
  randomBytes?: (size: number) => Buffer
}

export interface ReadInput {
  sessionId: string
  /** The delivery's file name: its receipt's name. */
  receiptFile: string
  source: { label: string; title?: string }
  payload: TeammatePayload
  /** What a refusal's trace and notification say about it (the recipient as written, the source). */
  failure?: FailureContext
}

/** `String.prototype.toWellFormed` (ES2024, not in this lib): a lone surrogate becomes U+FFFD. */
export function toWellFormed(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1]
        i++
        continue
      }
      out += '�'
      continue
    }
    out += c >= 0xdc00 && c <= 0xdfff ? '�' : value[i]
  }
  return out
}

/** The text a teammate handoff carries: normalized as authored text, then well-formed (the server refuses lone surrogates). */
export function teammateText(value: string): string {
  return toWellFormed(normalizeAuthored(value))
}

function sameStamp(a: MembershipStamp, b: MembershipStamp | null): boolean {
  return b !== null && a.server === b.server && a.memberId === b.memberId
}

function digest(sessionId: string, to: string, title: string, body: string): string {
  return createHash('sha256').update(JSON.stringify([sessionId, to, title, body]), 'utf8').digest('hex')
}

export class TeammateOutbox {
  readonly #deps: TeammateOutboxDeps
  #items: OutgoingItem[] = []
  #loadIssue: 'damaged' | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #inflight = new Set<string>()
  #pumping = false
  #timer: NodeJS.Timeout | null = null
  #lastStamp: string | null = null

  constructor(deps: TeammateOutboxDeps) {
    this.#deps = deps
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  // ---- Lifecycle ----

  /** Loads the store, sweeps items of another membership, and starts the send tick. */
  start(): void {
    this.#load()
    this.#lastStamp = JSON.stringify(this.#deps.team.membership())
    void this.#run(() => this.#sweep())
    this.#timer = setInterval(() => this.pump(), SEND_TICK_MS)
    this.#timer.unref()
    this.pump()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Waits for every queued mutation (tests, and the IPC handlers' answers). */
  idle(): Promise<void> {
    return this.#queue.then(() => undefined)
  }

  /** The team's membership may have changed: sweep when it did. Called on every team change. */
  membershipChanged(): void {
    const stamp = JSON.stringify(this.#deps.team.membership())
    if (stamp === this.#lastStamp) return
    this.#lastStamp = stamp
    void this.#run(() => this.#sweep())
  }

  /** `onCredentialDiscarded`: refuse every item of that membership (the sweep's rules). */
  credentialDiscarded(): void {
    this.#lastStamp = JSON.stringify(this.#deps.team.membership())
    void this.#run(() => this.#sweep())
  }

  // ---- Views ----

  /** The outgoing items of the current membership, oldest first. */
  list(): OutgoingView[] {
    const current = this.#deps.team.membership()
    return this.#items.filter((item) => sameStamp(item.membership, current)).map((item) => this.#view(item))
  }

  /** How many wait for the user to send or discard them (the badge's share). */
  waitingCount(): number {
    const current = this.#deps.team.membership()
    return this.#items.filter((item) => item.state === 'awaiting' && sameStamp(item.membership, current)).length
  }

  /** Whether a `clientId` is a send still in this store (waiting for its answer; `teammate-handoff-return` D5). */
  hasClientId(clientId: string): boolean {
    return this.#items.some((item) => item.clientId === clientId && item.state === 'confirmed')
  }

  /** Whether one more could wait for confirmation (`OUTGOING_FULL`). */
  hasRoom(): boolean {
    return this.waitingCount() < MAX_OUTGOING_WAITING
  }

  loadIssue(): 'damaged' | null {
    return this.#loadIssue
  }

  #view(item: OutgoingItem): OutgoingView {
    const connected = this.#deps.team.connected()
    const now = this.#now()
    let phase: OutgoingView['phase']
    if (item.state === 'confirmed') {
      if (this.#inflight.has(item.id)) phase = 'sending'
      else if (item.retryAt !== undefined && item.retryAt > now) phase = item.waiting === 'RATE_LIMITED' ? 'rate-limited' : 'retrying'
      else if (!connected) phase = 'waiting-connection'
      else phase = 'sending'
    }
    return {
      id: item.id,
      to: item.to,
      recipientName: item.recipientName,
      source: { label: item.source.label, ...(item.source.title ? { title: item.source.title } : {}) },
      title: item.title,
      body: item.body,
      readAt: item.readAt,
      state: item.state,
      ...(phase ? { phase } : {}),
      ...(item.state === 'confirmed' && item.retryAt !== undefined && item.retryAt > now ? { retryAt: item.retryAt } : {}),
      ...(item.refusal ? { refusal: item.refusal.code } : {}),
      ...(item.noDevice ? { noDevice: true as const } : {}),
      canSend: item.state === 'awaiting',
      canDiscard: this.#discardable(item),
      canDismiss: item.state === 'refused' || (item.state === 'sent' && item.noDevice === true),
    }
  }

  #discardable(item: OutgoingItem): boolean {
    return item.state === 'awaiting' || (item.state === 'confirmed' && !item.attempted && !this.#inflight.has(item.id))
  }

  // ---- Reading a delivery (design D2) ----

  /**
   * Checks a `to` delivery in D2's order and, when it passes, records it as waiting. The shape was checked by
   * `parseHandoffPayload`. Returns the outcome for the receipt and the inbox's trace.
   */
  async read(input: ReadInput): Promise<DeliverOutcome> {
    const { team } = this.#deps
    const label = input.sessionId
    const reject = (code: IntakeRejection, detail?: string): DeliverOutcome => this.#deps.reject(code, label, detail, input.failure)
    // 2. Team.
    const membership = team.membership()
    if (!team.enabled() || !membership) return reject('TEAM_UNAVAILABLE')

    // 3. Recipient: trimmed, lowercased, looked up; refetched once (throttled) when connected and not found.
    const wanted = input.payload.to.trim().toLowerCase()
    const find = (list: TeamMember[]): TeamMember | undefined => list.find((m) => m.handle.toLowerCase() === wanted)
    let member = find(team.members())
    if (!member && team.connected()) {
      const fetched = await team.refreshMembers({ maxWaitMs: MEMBERS_REFETCH_WAIT_MS })
      member = find(fetched ?? team.members())
    }
    if (!member) return reject('TEAMMATE_NOT_FOUND')
    const self = team.self()
    if (self !== null && member.handle.toLowerCase() === self.toLowerCase()) return reject('TEAMMATE_IS_SELF')

    // 4. Text: normalized, well-formed, then measured.
    const title = teammateText(input.payload.title)
    const body = teammateText(input.payload.body)
    if (title.length > MAX_FIELD_LENGTH) return reject('TOO_LONG', `title ${title.length} > ${MAX_FIELD_LENGTH}`)
    if (body.length > MAX_TEAMMATE_BODY_LENGTH) return reject('TOO_LONG', `body ${body.length} > ${MAX_TEAMMATE_BODY_LENGTH}`)

    return this.#run(() => {
      // The membership may have changed while the members were fetched.
      if (!sameStamp(membership, team.membership())) return reject('TEAM_UNAVAILABLE')
      // 5. Duplicate: the same source, recipient and text still waiting or confirmed.
      const key = digest(input.sessionId, member.handle, title, body)
      const twin = this.#items.find(
        (item) =>
          (item.state === 'awaiting' || item.state === 'confirmed') &&
          sameStamp(item.membership, membership) &&
          digest(item.source.sessionId, item.to, item.title, item.body) === key,
      )
      if (twin) return { ok: true, consume: true, notify: false, duplicate: true }
      // 6. Bound: held, not consumed — read again once one leaves.
      if (!this.hasRoom()) return { ok: false, code: 'OUTGOING_FULL' as const, consume: false, notify: true }

      const item: OutgoingItem = {
        id: this.#newId(),
        clientId: this.#newId(),
        membership: { ...membership },
        source: { sessionId: input.sessionId, label: input.source.label, ...(input.source.title ? { title: input.source.title } : {}) },
        receipt: { sessionId: input.sessionId, file: input.receiptFile },
        to: member.handle,
        recipientName: member.displayName,
        title,
        body,
        readAt: this.#now(),
        state: 'awaiting',
      }
      this.#write([...this.#items, item])
      this.#deps.onArrival(this.#view(item))
      return { ok: true, consume: true, notify: false, awaiting: { ref: item.id } }
    })
  }

  /** 22 characters of base64url from 16 random bytes (protocol: 1–64 of `[A-Za-z0-9_-]`). */
  #newId(): string {
    return (this.#deps.randomBytes ?? randomBytes)(16).toString('base64url')
  }

  // ---- The user's decisions ----

  /** Send: recorded as confirmed before any request. Returns whether it applied. */
  async send(id: string): Promise<boolean> {
    const applied = await this.#run(() => {
      const item = this.#current(id)
      if (!item || item.state !== 'awaiting') return false
      this.#replace(item, { ...item, state: 'confirmed' })
      if (!this.#canRequest()) this.#receipt(item, { status: 'held', code: 'NOT_CONNECTED', reason: teammateReceiptReason('NOT_CONNECTED') })
      return true
    })
    if (applied) this.pump()
    return applied
  }

  /** Discard: removes an item that was never requested, and sends nothing. Returns whether it applied. */
  discard(id: string): Promise<boolean> {
    return this.#run(() => {
      const item = this.#current(id)
      if (!item || !this.#discardable(item)) return false
      this.#write(this.#items.filter((i) => i.id !== id))
      this.#receipt(item, { status: 'discarded' })
      return true
    })
  }

  /** Dismiss: removes a refused item, or a sent one waiting for the recipient's device. */
  dismiss(id: string): Promise<boolean> {
    return this.#run(() => {
      const item = this.#current(id)
      if (!item || !(item.state === 'refused' || (item.state === 'sent' && item.noDevice))) return false
      this.#write(this.#items.filter((i) => i.id !== id))
      return true
    })
  }

  #current(id: string): OutgoingItem | undefined {
    const current = this.#deps.team.membership()
    return this.#items.find((item) => item.id === id && sameStamp(item.membership, current))
  }

  // ---- Sending (design D5) ----

  #canRequest(): boolean {
    const { team } = this.#deps
    return team.connected() && team.operations().includes('handoff.send')
  }

  /** Sends what is due, one at a time, oldest first. On Send, on `connected`, and on the tick. Never throws. */
  pump(): void {
    if (this.#pumping) return
    this.#pumping = true
    void this.#drain()
      .catch((error: unknown) => console.error(`[team] sending failed: ${String(error)}`))
      .finally(() => {
        this.#pumping = false
      })
  }

  /** The connection ended: confirmed items now wait for it. */
  disconnected(): void {
    void this.#run(() => {
      for (const item of this.#items) {
        if (item.state === 'confirmed' && sameStamp(item.membership, this.#deps.team.membership()) && !(item.retryAt && item.retryAt > this.#now())) {
          this.#receipt(item, { status: 'held', code: 'NOT_CONNECTED', reason: teammateReceiptReason('NOT_CONNECTED') })
        }
      }
      this.#deps.onChange()
    })
  }

  async #drain(): Promise<void> {
    const tried = new Set<string>()
    for (;;) {
      if (!this.#canRequest()) return
      const now = this.#now()
      const current = this.#deps.team.membership()
      const next = this.#items.find(
        (item) =>
          item.state === 'confirmed' &&
          !tried.has(item.id) &&
          sameStamp(item.membership, current) &&
          !(item.retryAt !== undefined && item.retryAt > now),
      )
      if (!next) return
      tried.add(next.id)
      const ready = await this.#run(() => {
        // Discard may have come first: then there is nothing to send.
        const item = this.#items.find((i) => i.id === next.id)
        if (!item || item.state !== 'confirmed' || !sameStamp(item.membership, this.#deps.team.membership())) return null
        // `attempted` before the request reaches the socket.
        const marked: OutgoingItem = { ...item, attempted: true }
        this.#replace(item, marked)
        this.#inflight.add(item.id)
        return marked
      })
      if (!ready) continue
      this.#deps.onChange()
      let answer: Answer | null
      try {
        answer = await this.#deps.team.request('handoff.send', {
          clientId: ready.clientId,
          to: ready.to,
          payload: { enc: 'none', title: ready.title, body: ready.body },
        })
      } catch {
        answer = null
      }
      await this.#run(() => {
        this.#inflight.delete(ready.id)
        this.#apply(ready.id, answer)
      })
      // A lost answer means the connection is gone: stop until the next `connected`.
      if (answer === null) return
    }
  }

  /** The answer table of design D5. `null`: the connection ended before the answer. */
  #apply(id: string, answer: Answer | null): void {
    const item = this.#items.find((i) => i.id === id)
    if (!item) return
    if (answer === null) {
      this.#receipt(item, { status: 'held', code: 'NOT_CONNECTED', reason: teammateReceiptReason('NOT_CONNECTED') })
      this.#deps.onChange()
      return
    }
    if (answer.ok) {
      const r = (answer.r ?? {}) as {
        handoff?: { id?: unknown; status?: unknown; seq?: unknown; sentAt?: unknown; expiresAt?: unknown }
        recipient?: { id?: unknown; handle?: unknown; deviceCount?: unknown }
      }
      const noDevice = r.recipient?.deviceCount === 0
      const handoffId = typeof r.handoff?.id === 'string' ? r.handoff.id : undefined
      if (handoffId && this.#deps.recordSend) {
        // Before the outgoing write below: the other order loses the title on a crash in between.
        const now = this.#now()
        this.#deps.recordSend({
          membership: item.membership,
          clientId: item.clientId,
          handoffId,
          seq: typeof r.handoff?.seq === 'number' ? r.handoff.seq : 0,
          status: typeof r.handoff?.status === 'string' ? r.handoff.status : 'pending',
          sentAt: typeof r.handoff?.sentAt === 'number' ? r.handoff.sentAt : now,
          expiresAt: typeof r.handoff?.expiresAt === 'number' ? r.handoff.expiresAt : now,
          to: { ...(typeof r.recipient?.id === 'string' ? { id: r.recipient.id } : {}), handle: item.to, displayName: item.recipientName },
          title: item.title,
          sourceSessionId: item.source.sessionId,
        })
      }
      const sent: OutgoingItem = {
        ...item,
        state: 'sent',
        ...(handoffId ? { handoffId } : {}),
        ...(noDevice ? { noDevice: true } : {}),
      }
      delete sent.attempted
      delete sent.retryAt
      delete sent.waiting
      this.#receipt(item, {
        status: 'sent',
        to: item.to,
        ...(handoffId ? { handoffId } : {}),
        ...(noDevice ? { code: 'NO_DEVICE', reason: teammateReceiptReason('NO_DEVICE') } : {}),
      })
      // A sent item leaves the tab after its receipt step, unless it waits for the recipient's device.
      if (noDevice) this.#replace(item, sent)
      else this.#write(this.#items.filter((i) => i.id !== id))
      return
    }
    const code = answer.e.code
    switch (code) {
      case 'RATE_LIMITED': {
        const at = typeof answer.e.detail?.retryAt === 'number' ? answer.e.detail.retryAt : this.#now() + RATE_LIMIT_FALLBACK_MS
        const next: OutgoingItem = { ...item, retryAt: at, waiting: 'RATE_LIMITED' }
        delete next.attempted // the server did not store it: Discard is offered again
        this.#replace(item, next)
        this.#receipt(item, { status: 'held', code, reason: teammateReceiptReason(code), at: new Date(at).toISOString() })
        return
      }
      case 'RECIPIENT_UNKNOWN':
      case 'RECIPIENT_IS_SELF':
      case 'BAD_PARAMS':
      case 'HANDOFF_ID_REUSED': {
        const refused: OutgoingItem = { ...item, state: 'refused', refusal: { code } }
        delete refused.attempted
        delete refused.retryAt
        delete refused.waiting
        this.#replace(item, refused)
        this.#receipt(item, { status: 'rejected', code, reason: teammateReceiptReason(code), permanent: isPermanentTeammateRefusal(code) })
        return
      }
      case 'AUTH_FAILED': {
        // The request did nothing, and the credential is discarded next (then the sweep refuses it, temporarily).
        const next: OutgoingItem = { ...item }
        delete next.attempted
        this.#replace(item, next)
        return
      }
      default: {
        // `INTERNAL`, or anything this version does not know: retried after a backoff, with the same `clientId`.
        const retries = (item.retries ?? 0) + 1
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (retries - 1), BACKOFF_CAP_MS)
        this.#replace(item, { ...item, retryAt: this.#now() + delay, retries, waiting: 'RETRYING' })
        this.#receipt(item, { status: 'held', code: 'RETRYING', reason: teammateReceiptReason('RETRYING') })
      }
    }
  }

  // ---- The sweep ----

  /** Items of a membership other than the current one are refused, with their receipts, and leave the store. */
  #sweep(): void {
    const current = this.#deps.team.membership()
    const stale = this.#items.filter((item) => !sameStamp(item.membership, current))
    if (stale.length === 0) return
    for (const item of stale) {
      if (item.state !== 'awaiting' && item.state !== 'confirmed') continue
      const code = item.attempted ? 'SEND_UNCERTAIN' : 'TEAM_UNAVAILABLE'
      this.#receipt(item, {
        status: 'rejected',
        code,
        reason: receiptReason(code),
        permanent: isPermanentRejection({ code, notify: true }),
      })
      this.#deps.refusedLater(code, this.#view({ ...item, state: 'refused', refusal: { code } }))
    }
    this.#write(this.#items.filter((item) => sameStamp(item.membership, current)))
  }

  // ---- Receipts ----

  #receipt(item: OutgoingItem, fields: Omit<Receipt, 'file' | 'writtenAt' | 'ref'>): void {
    try {
      rewriteReceipt(this.#deps.receiptsDir(item.receipt.sessionId), {
        file: item.receipt.file,
        writtenAt: new Date(this.#now()).toISOString(),
        ref: item.id,
        ...fields,
      } as Receipt)
    } catch (error) {
      // The Outgoing tab is the user's record; a receipt that cannot be written changes nothing about the item.
      console.error(`[team] could not rewrite the receipt ${item.receipt.file}: ${String(error)}`)
    }
  }

  // ---- The store ----

  #run<T>(fn: () => T): Promise<T> {
    const next = this.#queue.then(fn, fn)
    this.#queue = next.catch(() => undefined)
    return next
  }

  #replace(previous: OutgoingItem, next: OutgoingItem): void {
    this.#write(this.#items.map((item) => (item === previous ? next : item)))
  }

  /** Whole-file, synchronous: the file, then memory. A write that throws leaves memory as it was. */
  #write(items: OutgoingItem[]): void {
    const dir = path.dirname(this.#deps.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.#deps.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: OUTGOING_FILE_VERSION, items }, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.#deps.file)
    this.#items = items
    this.#deps.onChange()
  }

  #load(): void {
    let text: string
    try {
      text = fs.readFileSync(this.#deps.file, 'utf8')
    } catch {
      this.#items = []
      return
    }
    const items = parseOutgoing(text)
    if (items === null) {
      // Set aside and read as empty; the Outgoing tab says unconfirmed or unanswered sends in it are lost.
      try {
        fs.renameSync(this.#deps.file, `${this.#deps.file}.damaged-${this.#now()}`)
      } catch {
        // Left in place: the next write replaces it.
      }
      this.#loadIssue = 'damaged'
      this.#items = []
      return
    }
    this.#items = items
  }
}

const REFUSALS: ReadonlySet<string> = new Set(['RECIPIENT_UNKNOWN', 'RECIPIENT_IS_SELF', 'BAD_PARAMS', 'HANDOFF_ID_REUSED', 'TEAM_UNAVAILABLE', 'SEND_UNCERTAIN'])
const STATES: ReadonlySet<string> = new Set(['awaiting', 'confirmed', 'sent', 'refused'])

function str(value: unknown): value is string {
  return typeof value === 'string'
}

/** Field by field. `null`: not this file's shape (damaged, or a newer version). An unreadable item is dropped. */
export function parseOutgoing(text: string): OutgoingItem[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const file = raw as Record<string, unknown>
  if (file.version !== OUTGOING_FILE_VERSION || !Array.isArray(file.items)) return null
  const items: OutgoingItem[] = []
  for (const entry of file.items) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const m = e.membership as Record<string, unknown> | undefined
    const s = e.source as Record<string, unknown> | undefined
    const r = e.receipt as Record<string, unknown> | undefined
    if (!str(e.id) || !str(e.clientId) || !m || !str(m.server) || !str(m.memberId)) continue
    if (!s || !str(s.sessionId) || !str(s.label) || !r || !str(r.sessionId) || !str(r.file)) continue
    if (!str(e.to) || !str(e.recipientName) || !str(e.title) || !str(e.body) || typeof e.readAt !== 'number') continue
    if (!str(e.state) || !STATES.has(e.state)) continue
    const refusal = e.refusal as Record<string, unknown> | undefined
    items.push({
      id: e.id,
      clientId: e.clientId,
      membership: { server: m.server, memberId: m.memberId },
      source: { sessionId: s.sessionId, label: s.label, ...(str(s.title) ? { title: s.title } : {}) },
      receipt: { sessionId: r.sessionId, file: path.basename(r.file) },
      to: e.to,
      recipientName: e.recipientName,
      title: e.title,
      body: e.body,
      readAt: e.readAt,
      state: e.state as OutgoingState,
      ...(e.attempted === true ? { attempted: true as const } : {}),
      ...(typeof e.retryAt === 'number' ? { retryAt: e.retryAt } : {}),
      ...(typeof e.retries === 'number' ? { retries: e.retries } : {}),
      ...(e.waiting === 'RATE_LIMITED' || e.waiting === 'RETRYING' ? { waiting: e.waiting } : {}),
      ...(refusal && str(refusal.code) && REFUSALS.has(refusal.code) ? { refusal: { code: refusal.code as NonNullable<OutgoingItem['refusal']>['code'] } } : {}),
      ...(e.noDevice === true ? { noDevice: true as const } : {}),
      ...(str(e.handoffId) ? { handoffId: e.handoffId } : {}),
    })
  }
  return items
}

/** The receipt codes a teammate handoff's later receipts use (re-exported for the teammates file's rules). */
export type { TeammateReceiptCode }
