import { HANDOFF_ADAPTER } from './handoff-delivery'
import { resolveTarget, type TargetCandidate } from './handoff-target'
import type { IntakeFailure, IntakeService } from './intake-service'
import type { IntakeRecord } from './intake-store'

/**
 * The one owner of every automatic handoff opening (`scheduled-handoff`, design D3).
 *
 * ## Why one owner
 *
 * Opening is a request to a window (`intake:autoAccept`): session creation lives in the renderer. **A request no
 * window receives is lost**, and the handoff then sits in the inbox as if it had been refused — the state a
 * handoff read at startup, before the window listens, used to end in. And a handoff whose prefill timed out goes
 * back to pending: without a persisted "opened once" mark, any rule that opens pending handoffs would reopen it at
 * every start, and announce it again each time. So every opening — on arrival, when a schedule falls due, overdue
 * at start, Run now — goes through `#fire`, which persists `firedAt` before anything else.
 *
 * ## When it looks
 *
 * After each delivery, every 30 s, when a window's restore gate opens, when a window first lists the inbox, and
 * on resume from sleep. A timer per record is not used: `setTimeout` overflows past 2^31−1 ms (about 24.8 days,
 * inside the scheduling bound) and fires at once, and the due time is judged against the wall clock.
 *
 * Electron-free: `index.ts` wires the window and the timer.
 */

export const OPENER_INTERVAL_MS = 30_000

export interface HandoffOpenerDeps {
  service: Pick<IntakeService, 'store' | 'reject' | 'reportFailure' | 'announceArrival'>
  /** The folders a target resolves against: the same source as the introduction's list. */
  candidates: () => TargetCandidate[]
  agentEventsEnabled: () => boolean
  /** Some window has restored its sessions **and** listens to the inbox (`ipc/intake.ts`, `restore-gate.ts`). */
  canReceive: () => boolean
  /** Ask the window to create the handoff's session (`intake:autoAccept`, which also issues its ticket). */
  requestOpen: (adapter: string, id: string, folderId: string) => void
  /** The inbox changed (`notifyIntakeChanged`). */
  changed: () => void
  now?: () => number
}

export class HandoffOpener {
  readonly #deps: HandoffOpenerDeps
  readonly #now: () => number

  constructor(deps: HandoffOpenerDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /** Opens every due handoff, oldest first, if a window can receive them. Never throws. */
  tick(): void {
    if (!this.#deps.canReceive()) return
    const now = this.#now()
    const due = this.#deps.service.store
      .list()
      .filter((record) => isDue(record, now))
      .sort((a, b) => (a.opensAt ?? 0) - (b.opensAt ?? 0))
    for (const record of due) {
      try {
        this.#fire(record)
      } catch (error) {
        console.error(`[handoff] opening ${record.id} failed: ${String(error)}`)
      }
    }
  }

  /**
   * The desktop's Run now: opens a scheduled handoff at once, whatever its time. This is its one automatic
   * opening. `false` when the record is not a waiting handoff (already opened, cancelled, unknown).
   */
  runNow(adapter: string, id: string): boolean {
    const record = this.#deps.service.store.get(adapter, id)
    if (!record || record.state !== 'pending' || record.opensAt === undefined || record.firedAt !== undefined) return false
    return this.#fire(record)
  }

  #fire(record: IntakeRecord): boolean {
    const { service } = this.#deps
    const content = record.content
    // Persisted first: a crash or a failure below cannot make this record open again, in this run or the next.
    if (!content || !service.store.markFired(record.adapter, record.id, this.#now())) return false
    this.#deps.changed()

    const verified = content.verified
    const failure = { target: verified.targetText ?? '', origin: content.authored.originLabel }
    const label = verified.targetText ?? record.id
    // Resolved again from what the agent wrote: a folder removed and added back has a new id.
    const target =
      verified.targetText === undefined
        ? verified.targetFolderId !== undefined && this.#deps.candidates().some((c) => c.id === verified.targetFolderId)
          ? ({ ok: true, folderId: verified.targetFolderId } as const)
          : ({ ok: false, reason: 'NOT_FOUND' } as const)
        : resolveTarget(verified.targetText, this.#deps.candidates())
    if (!target.ok) {
      const code = target.reason === 'AMBIGUOUS' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND'
      const detail = target.reason === 'AMBIGUOUS' ? target.candidates.join(', ') : undefined
      service.reject(code, label, detail, { adapter: record.adapter, ...failure })
      const reported: IntakeFailure = { code, ...(detail === undefined ? {} : { detail }), ...failure, at: this.#now() }
      service.reportFailure(reported)
      return false
    }
    // The non-notifying rejection of "預填不可能發生時不建立 session": agent events are a setting.
    if (!this.#deps.agentEventsEnabled()) {
      service.reject('PREFILL_UNAVAILABLE', label, undefined, { adapter: record.adapter, ...failure })
      return false
    }

    this.#deps.requestOpen(record.adapter, record.id, target.folderId)
    // A scheduled handoff is announced now, not when it was scheduled (design D4); an unscheduled one was
    // announced by `deliver` on arrival and is not announced twice.
    if (verified.scheduledAt !== undefined) service.announceArrival(service.store.get(record.adapter, record.id) ?? record)
    return true
  }
}

function isDue(record: IntakeRecord, now: number): boolean {
  return (
    record.adapter === HANDOFF_ADAPTER &&
    record.state === 'pending' &&
    record.opensAt !== undefined &&
    record.opensAt <= now &&
    record.firedAt === undefined &&
    record.content !== null
  )
}

/**
 * "A window can receive" (design D3): **one** window that both lists the inbox and has restored its sessions. Tied
 * to one window because a request goes to the listing windows, and only a restored one keeps the session it creates
 * in a list that is persisted (two windows exist only on macOS).
 */
export function anyWindowReceives(listing: readonly number[], isRestored: (contentsId: number) => boolean): boolean {
  return listing.some((id) => isRestored(id))
}

/**
 * The arrival listeners' guard (design D4): a scheduled handoff is not announced when it is scheduled. Every
 * arrival listener is registered through it, so a third one cannot forget the rule.
 */
export function whenAnnounced(listener: (record: IntakeRecord) => void): (record: IntakeRecord) => void {
  return (record) => {
    if (record.content?.verified.scheduledAt !== undefined && record.firedAt === undefined) return
    listener(record)
  }
}
