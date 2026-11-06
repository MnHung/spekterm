import { isProposal, isScheduled } from '@shared/intake/scheduled'

import { HANDOFF_ADAPTER, parseCancel } from './handoff-delivery'
import { bodyOf, type IntakeRejection } from './intake-schema'
import { scheduleShapeOf } from './intake-projection'
import type { DeliverOutcome, FailureContext } from './intake-service'
import type { CancelledBy, IntakeRecord } from './intake-store'
import { isProposalRecord } from './recurrence-kind'
import type { RecurrenceListing } from './recurrence-keeper'
import type { Recurrence } from './recurrence-store'

/**
 * An agent's cancel of a scheduled item (`handoff-cancel`). Electron-free; every effect goes through the desktop's
 * own functions (design D3), so the recurrence keeper and every open inbox hear of it as they hear of the user's.
 *
 * ## What can be cancelled — decided when the file is read (design D2)
 *
 * The rows, in this order:
 *
 * 1. a recurrence the Repeating section lists (`RecurrenceKeeper.listing`) → Stop repeating;
 * 2. a handoff record the Schedules tab lists (`isProposal` / `isScheduled` of `scheduleShapeOf`, the tab's own
 *    reading) → the inbox's ignore: Cancel, Skip or Decline;
 * 3. a handoff record already dismissed, or a recurrence already stopped → nothing, `duplicate` (D11): the state the
 *    cancel asks for holds;
 * 4. the recurrence store unavailable, and the id names no record at all or a proposal no longer pending — it may
 *    name an approved recurrence, whose id is its proposal's → `CANCEL_UNAVAILABLE`, temporary;
 * 5. anything else → `CANCEL_NOT_FOUND`, permanent, with a detail naming the case.
 *
 * **No lineage check** (D4): any agent session may cancel anything listed. The cancelling session's label marks the
 * item (D5), in the same save as its state change.
 */

export type CancelDecision =
  | { kind: 'stop'; id: string }
  | { kind: 'dismiss'; adapter: string; id: string }
  | { kind: 'duplicate' }
  | { kind: 'refuse'; code: Extract<IntakeRejection, 'CANCEL_NOT_FOUND' | 'CANCEL_UNAVAILABLE'>; detail?: string }

/** The cases `CANCEL_NOT_FOUND` names; system-written, carried into the receipt (`DETAILED`). */
export const CANCEL_DETAIL = {
  unknown: 'unknown id',
  opening: 'opening has begun or it was opened',
  notCancellable: 'not cancellable',
  ended: 'ended',
} as const

export interface CancelDecisionDeps {
  /** Every inbox record, every adapter: the store keys by adapter and id, and an id of another producer is refused. */
  records: () => readonly IntakeRecord[]
  /** The Repeating section's listing: the recurrences a cancel can stop. */
  listing: () => RecurrenceListing
  recurrences: { readonly available: boolean; get(id: string): Recurrence | undefined }
}

export function decideCancel(id: string, deps: CancelDecisionDeps): CancelDecision {
  const listing = deps.listing()
  if (listing.available && listing.recurrences.some((recurrence) => recurrence.id === id)) return { kind: 'stop', id }

  const records = deps.records().filter((record) => record.id === id)
  const handoff = records.find((record) => record.adapter === HANDOFF_ADAPTER)
  if (handoff) {
    const shape = scheduleShapeOf(handoff)
    if (isProposal(shape) || isScheduled(shape)) return { kind: 'dismiss', adapter: handoff.adapter, id }
    if (handoff.state === 'dismissed') return { kind: 'duplicate' }
  }

  const { recurrences } = deps
  const recurrence = recurrences.available ? recurrences.get(id) : undefined
  if (recurrence?.stoppedAt !== undefined) return { kind: 'duplicate' }

  if (!recurrences.available && (records.length === 0 || (handoff !== undefined && isProposalRecord(handoff) && handoff.state !== 'pending'))) {
    return { kind: 'refuse', code: 'CANCEL_UNAVAILABLE' }
  }

  // Not listed and not stopped: it has ended (`listing` drops an ended recurrence with nothing left to open).
  if (recurrence) return { kind: 'refuse', code: 'CANCEL_NOT_FOUND', detail: CANCEL_DETAIL.ended }
  if (records.length === 0) return { kind: 'refuse', code: 'CANCEL_NOT_FOUND', detail: CANCEL_DETAIL.unknown }
  if (!handoff) return { kind: 'refuse', code: 'CANCEL_NOT_FOUND', detail: CANCEL_DETAIL.notCancellable }
  if (handoff.state === 'accepted' || handoff.firedAt !== undefined) {
    return { kind: 'refuse', code: 'CANCEL_NOT_FOUND', detail: CANCEL_DETAIL.opening }
  }
  return { kind: 'refuse', code: 'CANCEL_NOT_FOUND', detail: CANCEL_DETAIL.notCancellable }
}

export interface HandoffCancellerDeps extends CancelDecisionDeps {
  /** The inbox's ignore (`dismissIntake`): the keeper and every open inbox hear of it. */
  dismiss: (adapter: string, id: string, by: CancelledBy) => void
  /** Stop repeating (`RecurrenceKeeper.stop`). Throws when the store write fails. */
  stop: (id: string, by: CancelledBy) => boolean
  /** A refusal: a trace in the inbox, a notification for a permanent one (`IntakeService.reject`). */
  reject: (code: IntakeRejection, label: string, detail: string | undefined, context: FailureContext & { adapter: string }) => DeliverOutcome
  /** The cancelling session's label (a folder name, `Global`, or ended). */
  labelOf: (sessionId: string) => string
  now?: () => number
}

export class HandoffCanceller {
  readonly #deps: HandoffCancellerDeps

  constructor(deps: HandoffCancellerDeps) {
    this.#deps = deps
  }

  /** One cancel file from `sessionId`'s outbox. Carried out at once; `accepted` means done. */
  deliver(sessionId: string, contents: string): DeliverOutcome {
    const origin = this.#deps.labelOf(sessionId)
    const failure: FailureContext = { origin, subject: 'cancel' }
    const refuse = (code: IntakeRejection, label: string, detail?: string): DeliverOutcome => ({
      ...this.#deps.reject(code, label, detail, { adapter: HANDOFF_ADAPTER, ...failure }),
      failure,
    })

    const parsed = parseCancel(contents)
    if (!parsed.ok) return refuse('FIELD_TYPE', sessionId, parsed.field)
    const { id } = parsed
    const by: CancelledBy = { label: origin, at: (this.#deps.now ?? Date.now)() }

    const decision = decideCancel(id, this.#deps)
    switch (decision.kind) {
      case 'dismiss':
        this.#deps.dismiss(decision.adapter, decision.id, by)
        return { ok: true, consume: true, notify: false, receiptId: id }
      case 'stop':
        try {
          if (!this.#deps.stop(decision.id, by)) return refuse('CANCEL_NOT_FOUND', id, CANCEL_DETAIL.ended)
        } catch (error) {
          console.error(`[handoff] stopping recurrence ${id} failed: ${String(error)}`)
          return refuse('CANCEL_UNAVAILABLE', id)
        }
        return { ok: true, consume: true, notify: false, receiptId: id }
      case 'duplicate':
        return { ok: true, consume: true, notify: false, duplicate: true, receiptId: id }
      case 'refuse':
        return refuse(decision.code, id, decision.detail)
    }
  }
}

/** How long an agent's cancel stays listed in the Schedules tab (`handoff-cancel`, design D5). */
export const AGENT_CANCEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** How much of a body stands in for a missing title on a line. */
const LINE_TITLE_CODE_POINTS = 80

/** One line of the Schedules tab's "Cancelled by an agent" section. Desktop only: never on `IntakeView`. */
export interface AgentCancelView {
  /** A stable key: the record's adapter and id, or the recurrence's id. */
  key: string
  title: string
  action: 'cancelled' | 'skipped' | 'declined' | 'stopped'
  /** The cancelling session's label. */
  label: string
  at: number
}

function lineTitle(title: string, body: string): string {
  if (title.trim() !== '') return title
  const firstLine = body.split('\n').find((line) => line.trim() !== '') ?? ''
  return [...firstLine.trim()].slice(0, LINE_TITLE_CODE_POINTS).join('')
}

/**
 * The agent cancels of the last `AGENT_CANCEL_WINDOW_MS`, newest first: dismissed records and stopped recurrences
 * that carry the mark — the mark alone is not enough (D5: only what was cancelled is listed).
 */
export function agentCancels(
  records: readonly IntakeRecord[],
  recurrences: readonly Recurrence[],
  now: number,
): AgentCancelView[] {
  const recent = (at: number): boolean => now - at < AGENT_CANCEL_WINDOW_MS
  const lines: AgentCancelView[] = []
  for (const record of records) {
    const by = record.cancelledBy
    if (record.state !== 'dismissed' || !by || !recent(by.at)) continue
    const role = scheduleShapeOf(record).recurrence?.role
    lines.push({
      key: `${record.adapter}:${record.id}`,
      title: record.content
        ? lineTitle(record.content.authored.title, bodyOf({ id: record.id, ...record.content }))
        : '',
      action: role === 'proposal' ? 'declined' : role === 'occurrence' ? 'skipped' : 'cancelled',
      label: by.label,
      at: by.at,
    })
  }
  for (const recurrence of recurrences) {
    const by = recurrence.cancelledBy
    if (recurrence.stoppedAt === undefined || !by || !recent(by.at)) continue
    lines.push({
      key: `recurrence:${recurrence.id}`,
      title: lineTitle(recurrence.intake.authored.title, bodyOf({ id: recurrence.id, ...recurrence.intake, receivedAt: recurrence.approvedAt })),
      action: 'stopped',
      label: by.label,
      at: by.at,
    })
  }
  return lines.sort((a, b) => b.at - a.at)
}
