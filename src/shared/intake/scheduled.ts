/**
 * Which inbox items wait for the user, and which wait for their time (`scheduled-handoff`, design D7).
 *
 * One predicate for the badge, the overlay and every other count: the badge filters the same list the overlay
 * renders, so a scheduled handoff cannot be counted by one and listed apart by the other. The projection carries
 * `scheduledAt` only while the item is scheduled (pending, not fired), so no caller compares it with the clock.
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
