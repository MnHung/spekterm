import { firstMatchAfter, parseCron } from './cron'
import { HANDOFF_ADAPTER } from './handoff-delivery'
import { resolveTarget, type TargetCandidate } from './handoff-target'
import type { Intake } from './intake-schema'
import type { IntakeService } from './intake-service'
import type { IntakeRecord } from './intake-store'
import { isProposalRecord } from './recurrence-kind'
import type { Recurrence, RecurrenceStore } from './recurrence-store'

/**
 * Keeps each approved recurrence's upcoming occurrence right (`recurring-handoff`, design D2). **The one owner**:
 * every path that can change it — approval, an occurrence firing, Run now, a skip from the desktop or a device, an
 * accept of a waiting occurrence, the opener's tick, the start — calls `ensureNext` / `ensureAll`, so the rule lives
 * here and nowhere else.
 *
 * ## The steps, in this order
 *
 * 1. Its records are found by **scanning** for its id, not by a pointer: a crash between adding an occurrence and
 *    recording it leaves a record the scan still finds.
 * 2. An upcoming occurrence (pending, not fired) is kept — the earliest; others are removed.
 * 3. **Waiting**: its latest fired occurrence is pending and is not being opened — the opener refused it (target
 *    gone, agent events off). Nothing is created until the user deals with it; otherwise a recurrence whose folder
 *    is gone adds a failed item at every time and fills the inbox. "Being opened" matters: a fired occurrence stays
 *    pending until the window attaches its session, so an opening in progress must not read as waiting, or the next
 *    occurrence would appear only at a later tick. It is "the opener asked a window in this run, or an accept holds
 *    its ticket" — not the ticket alone, which is issued only for a handoff with a source.
 * 4. A full inbox: nothing is created.
 * 5. The next time after `max(now, last occurrence, start)`; past `until`, the recurrence ends.
 *
 * Its own removals go to the store directly, never through the inbox's ignore, which calls the keeper.
 * Electron-free; the clock is injected.
 */

export interface RecurrenceKeeperDeps {
  service: Pick<IntakeService, 'store' | 'hasRoom'>
  recurrences: RecurrenceStore
  candidates: () => TargetCandidate[]
  /**
   * A session is being opened for this record: the opener asked a window to open it in this run, or an accept holds
   * its ticket (`HandoffOpener.wasRequested`, `TicketStore.isLive`).
   */
  opening: (adapter: string, id: string) => boolean
  /** The inbox or the recurrences changed (`notifyIntakeChanged`). */
  changed: () => void
  now?: () => number
}

export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'FOLDER_GONE' | 'ended' | 'unavailable' }

/** What the inbox shows for one recurrence (the Repeating section). */
export interface RecurrenceView {
  id: string
  repeat: string
  title: string
  /** The approved folder, resolved now; absent when it no longer resolves. */
  folderId?: string
  /** The approved folder's path, for when it no longer resolves. */
  targetText: string
  until?: number
  /** The upcoming occurrence's time. */
  next?: number
  /** Why there is no upcoming occurrence. */
  waiting?: 'earlier' | 'full'
}

export interface RecurrenceListing {
  available: boolean
  recurrences: RecurrenceView[]
}

/** An occurrence's id: the recurrence and its time, so a crash cannot add the same time twice. */
export function occurrenceId(recurrenceId: string, at: number): string {
  return `${recurrenceId}-r${at.toString(36)}`
}

export class RecurrenceKeeper {
  readonly #deps: RecurrenceKeeperDeps
  readonly #now: () => number

  constructor(deps: RecurrenceKeeperDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  #recordsOf(id: string): IntakeRecord[] {
    return this.#deps.service.store.list().filter((r) => r.adapter === HANDOFF_ADAPTER && r.content?.verified.recurrenceId === id)
  }

  #upcoming(records: IntakeRecord[]): IntakeRecord[] {
    return records
      .filter((r) => r.state === 'pending' && r.firedAt === undefined)
      .sort((a, b) => (a.opensAt ?? 0) - (b.opensAt ?? 0))
  }

  #waiting(records: IntakeRecord[]): boolean {
    const fired = records
      .filter((r) => r.firedAt !== undefined)
      .sort((a, b) => (b.content?.verified.scheduledAt ?? 0) - (a.content?.verified.scheduledAt ?? 0))
    const latest = fired[0]
    return latest !== undefined && latest.state === 'pending' && !this.#deps.opening(latest.adapter, latest.id)
  }

  /** Every recurrence, at load and at the start of every opener tick. Never throws. */
  ensureAll(): void {
    const { recurrences, service } = this.#deps
    if (!recurrences.available) return
    let changed = false
    // A crash between approval's two writes: the recurrence exists, its proposal is still pending.
    for (const record of service.store.list()) {
      if (record.state === 'pending' && isProposalRecord(record) && recurrences.get(record.id)) {
        service.store.setState(record.adapter, record.id, 'accepted')
        service.store.settle(record.adapter, record.id, this.#now())
        changed = true
      }
    }
    for (const recurrence of recurrences.list()) {
      try {
        if (this.#ensure(recurrence)) changed = true
      } catch (error) {
        console.error(`[recurrence] ${recurrence.id}: ${String(error)}`)
      }
    }
    if (changed) this.#deps.changed()
  }

  /** One recurrence (after it fired, Run now, a skip, an accept of its waiting occurrence). Never throws. */
  ensureNext(recurrenceId: string): void {
    const recurrence = this.#deps.recurrences.get(recurrenceId)
    if (!recurrence || !this.#deps.recurrences.available) return
    try {
      if (this.#ensure(recurrence)) this.#deps.changed()
    } catch (error) {
      console.error(`[recurrence] ${recurrenceId}: ${String(error)}`)
    }
  }

  /** An item was ignored, on the desktop or from a device (`onIntakeDismissed`): a skipped occurrence's next one. */
  afterDismiss(adapter: string, id: string): void {
    const recurrenceId = this.#deps.service.store.get(adapter, id)?.content?.verified.recurrenceId
    if (recurrenceId !== undefined) this.ensureNext(recurrenceId)
  }

  /** The keeper's steps for one recurrence; `true` when something changed. */
  #ensure(recurrence: Recurrence): boolean {
    const { service, recurrences } = this.#deps
    const records = this.#recordsOf(recurrence.id)
    const upcoming = this.#upcoming(records)

    if (recurrence.stoppedAt !== undefined) {
      for (const record of upcoming) service.store.setState(record.adapter, record.id, 'dismissed')
      return upcoming.length > 0
    }

    if (upcoming.length > 0) {
      let changed = false
      for (const extra of upcoming.slice(1)) {
        service.store.setState(extra.adapter, extra.id, 'dismissed')
        changed = true
      }
      // A crash may have left the recurrence behind its own occurrence: catch it up, so Run now consumes this time.
      const at = upcoming[0].content?.verified.scheduledAt
      if (at !== undefined && (recurrence.lastOccurrenceAt ?? -Infinity) < at) {
        recurrences.put({ ...recurrence, lastOccurrenceAt: at })
        changed = true
      }
      return changed
    }

    if (recurrence.endedAt !== undefined || this.#waiting(records) || !service.hasRoom()) return false

    const cron = parseCron(recurrence.repeat)
    if (!cron.ok) return false
    let last = recurrence.lastOccurrenceAt
    // A few rounds only: each round either adds a record or catches `last` up to one that exists already.
    for (let round = 0; round < 3; round++) {
      const base = Math.max(this.#now(), last ?? recurrence.approvedAt, recurrence.startAt === undefined ? -Infinity : recurrence.startAt - 1)
      const next = firstMatchAfter(cron.schedule, base)
      if (next === null || (recurrence.until !== undefined && next > recurrence.until)) {
        recurrences.put({ ...recurrence, ...(last !== undefined ? { lastOccurrenceAt: last } : {}), endedAt: this.#now() })
        return true
      }
      const id = occurrenceId(recurrence.id, next)
      if (service.store.get(HANDOFF_ADAPTER, id)) {
        last = next
        continue
      }
      service.store.add(this.#occurrence(recurrence, id, next), { opensAt: next })
      // The record first: whatever happens to this write, the scan finds the record.
      recurrences.put({ ...recurrence, lastOccurrenceAt: next })
      return true
    }
    return false
  }

  #occurrence(recurrence: Recurrence, id: string, at: number): Intake {
    const target = resolveTarget(recurrence.targetText, this.#deps.candidates())
    return {
      id,
      verified: {
        ...recurrence.intake.verified,
        adapter: HANDOFF_ADAPTER,
        targetText: recurrence.targetText,
        // The approved folder, not the one the agent named: routing preselects `targetFolderId`.
        ...(target.ok ? { targetFolderId: target.folderId } : {}),
        scheduledAt: at,
        repeat: recurrence.repeat,
        ...(recurrence.until !== undefined ? { repeatUntil: recurrence.until } : {}),
        recurrenceId: recurrence.id,
      },
      authored: recurrence.intake.authored,
      receivedAt: this.#now(),
    }
  }

  /**
   * The desktop's Approve (design D4): a pending proposal, a current folder, an available store, a time left before
   * its end. The recurrence is written before the proposal is settled; `ensureAll` settles a proposal left pending
   * by a crash in between.
   */
  approve(adapter: string, id: string, folderId: unknown): ApproveResult {
    const { service, recurrences } = this.#deps
    if (!recurrences.available) return { ok: false, reason: 'unavailable' }
    const record = service.store.get(adapter, id)
    const existing = recurrences.get(id)
    if (existing && existing.stoppedAt === undefined) {
      this.ensureAll()
      return { ok: true }
    }
    if (!record?.content || record.state !== 'pending' || !isProposalRecord(record)) return { ok: false, reason: 'unknown' }
    const folder = this.#deps.candidates().find((candidate) => candidate.id === folderId)
    if (!folder) return { ok: false, reason: 'FOLDER_GONE' }
    const verified = record.content.verified
    const repeat = verified.repeat ?? ''
    const cron = parseCron(repeat)
    const now = this.#now()
    if (!cron.ok) return { ok: false, reason: 'unknown' }
    const first = firstMatchAfter(cron.schedule, Math.max(now, verified.repeatStart === undefined ? -Infinity : verified.repeatStart - 1))
    if (first === null || (verified.repeatUntil !== undefined && first > verified.repeatUntil)) return { ok: false, reason: 'ended' }

    const { repeat: _r, repeatStart: _s, repeatUntil: _u, scheduledAt: _a, targetText: _t, targetFolderId: _f, recurrenceId: _i, ...kept } = verified
    recurrences.put({
      id,
      repeat,
      intake: { verified: kept, authored: record.content.authored },
      targetText: folder.path,
      approvedAt: now,
      ...(verified.repeatStart !== undefined ? { startAt: verified.repeatStart } : {}),
      ...(verified.repeatUntil !== undefined ? { until: verified.repeatUntil } : {}),
    })
    service.store.setState(adapter, id, 'accepted')
    service.store.settle(adapter, id, now)
    this.#ensure(recurrences.get(id) as Recurrence)
    this.#deps.changed()
    return { ok: true }
  }

  /** The desktop's Stop repeating: a tombstone first, then its unopened occurrence removed. */
  stop(recurrenceId: string): boolean {
    const { recurrences } = this.#deps
    const recurrence = recurrences.get(recurrenceId)
    if (!recurrences.available || !recurrence || recurrence.stoppedAt !== undefined) return false
    recurrences.put({ ...recurrence, stoppedAt: this.#now() })
    this.#ensure(recurrences.get(recurrenceId) as Recurrence)
    this.#deps.changed()
    return true
  }

  /** The Repeating section: every recurrence neither stopped nor ended, or ended with an occurrence still to open. */
  listing(): RecurrenceListing {
    const { recurrences, service } = this.#deps
    if (!recurrences.available) return { available: false, recurrences: [] }
    const views: RecurrenceView[] = []
    for (const recurrence of recurrences.list()) {
      if (recurrence.stoppedAt !== undefined) continue
      const records = this.#recordsOf(recurrence.id)
      const next = this.#upcoming(records)[0]?.content?.verified.scheduledAt
      if (recurrence.endedAt !== undefined && next === undefined) continue
      const target = resolveTarget(recurrence.targetText, this.#deps.candidates())
      views.push({
        id: recurrence.id,
        repeat: recurrence.repeat,
        title: recurrence.intake.authored.title,
        ...(target.ok ? { folderId: target.folderId } : {}),
        targetText: recurrence.targetText,
        ...(recurrence.until !== undefined ? { until: recurrence.until } : {}),
        ...(next !== undefined
          ? { next }
          : this.#waiting(records)
            ? { waiting: 'earlier' as const }
            : !service.hasRoom()
              ? { waiting: 'full' as const }
              : {}),
      })
    }
    return { available: true, recurrences: views.sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)) }
  }
}
