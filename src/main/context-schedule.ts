import { matchesBetween, parseCron } from './cron'
import type { ContextSchedule } from './intake-context'
import type { IntakeVerified } from './intake-schema'

/*
 * Kept out of `intake-context.ts`, whose source guard allows no `Math` or `Date` near the nonce.
 */

/** How many missed times are counted (hourly for six weeks), and how many are listed by time. */
export const MISSED_COUNT_LIMIT = 1_000
export const MISSED_LISTED = 10

/**
 * What a record's context says about its schedule (`scheduled-handoff` D6, `recurring-handoff` D7). The missed times
 * of an occurrence run from its time to **when it was fired**, not to `startedAt`: a failed occurrence accepted by
 * hand days later was fired on time, and the days its recurrence waited are not times this session stands in for.
 * They stop at the recurrence's end.
 */
export function contextScheduleFor(
  verified: Pick<IntakeVerified, 'scheduledAt' | 'repeat' | 'repeatUntil' | 'recurrenceId'>,
  firedAt: number | undefined,
  startedAt: number,
): ContextSchedule | undefined {
  const { scheduledAt, repeatUntil: until } = verified
  if (scheduledAt === undefined) return undefined
  if (verified.recurrenceId === undefined || verified.repeat === undefined) return { scheduledAt, startedAt }
  const cron = parseCron(verified.repeat)
  const to = Math.min(firedAt ?? scheduledAt, until ?? Infinity)
  const missed = cron.ok && to > scheduledAt ? matchesBetween(cron.schedule, scheduledAt, to, MISSED_COUNT_LIMIT) : { times: [], more: false }
  return {
    scheduledAt,
    startedAt,
    recurrence: {
      repeat: verified.repeat,
      ...(until !== undefined ? { until } : {}),
      missed: missed.times.slice(0, MISSED_LISTED),
      missedCount: missed.times.length,
      missedMore: missed.more,
    },
  }
}
