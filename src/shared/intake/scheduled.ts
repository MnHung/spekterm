/**
 * Which inbox items wait for the user, which wait for their time (`scheduled-handoff`, design D7), and which wait
 * for approval (`recurring-handoff`, design D6). **One named predicate per list**, each evaluated over the same
 * list the overlay renders:
 *
 * - the activity bar's badge and the overlay's header count: `isWaitingForUser` — proposals included (they wait
 *   for the user), scheduled handoffs not;
 * - the items tab: `isItemsTabItem` — waiting for the user, not a proposal;
 * - the Schedules tab: `isProposal`, then `isScheduled`.
 *
 * The projection carries `scheduledAt` only while the item is scheduled (pending, not fired), so no caller
 * compares it with the clock; and the recurrence role comes from the record, so a failed occurrence (pending, no
 * `scheduledAt`) is never taken for a proposal.
 */
export interface ScheduleShape {
  state: string
  scheduledAt?: number
}

/** A handoff waiting for its time: listed in its own section, not counted. */
export function isScheduled(item: ScheduleShape): boolean {
  return item.state === 'pending' && item.scheduledAt !== undefined
}

/** An item waiting for the user: what the badge counts. */
export function isWaitingForUser(item: ScheduleShape): boolean {
  return item.state === 'pending' && item.scheduledAt === undefined
}

/** The part of a view that says what it is to a repeating handoff (`recurring-handoff`, design D6). */
export interface RecurrenceShape {
  recurrence?: { role: 'proposal' | 'occurrence' }
}

/** A repeating handoff waiting for the user's approval. Read from the role, never from "has `scheduledAt`". */
export function isProposal(item: ScheduleShape & RecurrenceShape): boolean {
  return item.state === 'pending' && item.recurrence?.role === 'proposal'
}

/** What the items tab lists: waiting for the user, not a proposal (those are in the Schedules tab). */
export function isItemsTabItem(item: ScheduleShape & RecurrenceShape): boolean {
  return isWaitingForUser(item) && !isProposal(item)
}
