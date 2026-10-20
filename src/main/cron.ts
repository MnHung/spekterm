/**
 * The cron subset a repeating handoff may use (`recurring-handoff`, design D5) — parsed strictly and matched in the
 * desktop's local time.
 *
 * ## Why hand-written
 *
 * The subset is small enough to state whole in the introduction, and a library accepts a superset (seconds, `L`,
 * `W`, `#`, `?`): the strict check would be written anyway. Five fields, each `*` or a comma list of `n`, `a-b`,
 * `*\/s`, `a-b/s`; month and weekday names; weekday 0 and 7 are Sunday. **The minute is one number**: a schedule
 * that could open sessions more than once an hour is far more likely a typo (`* * * * *`) than a plan.
 *
 * ## Local time
 *
 * Candidates are built with the local `Date` constructor, day by day. Measured on Node 22 under
 * `TZ=America/New_York`: a time inside a daylight-saving gap moves forward by the gap (02:30 → 03:30), a time that
 * occurs twice resolves to the first. Two candidates can resolve to one instant (02:30 and 03:30 on the spring day),
 * so every search is "strictly after", which also deduplicates.
 */

/** How far ahead a schedule must have a time (`0 0 29 2 *` passes, `0 0 31 2 *` never occurs). Stated to agents. */
export const MAX_REPEAT_SEARCH_YEARS = 4

const SEARCH_DAYS = MAX_REPEAT_SEARCH_YEARS * 366 + 1

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

export interface CronSchedule {
  minute: number
  hours: readonly number[]
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  weekdays: ReadonlySet<number>
  /** A field not starting with `*` restricts the day; when both do, either matches (POSIX and Vixie cron). */
  daysRestricted: boolean
  weekdaysRestricted: boolean
}

export type CronResult = { ok: true; schedule: CronSchedule } | { ok: false; rule: string }

interface FieldSpec {
  name: string
  min: number
  max: number
  names?: readonly string[]
  /** The value names count from (months from 1, days from 0). */
  nameBase?: number
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, nameBase: 0 },
]

const PART = /^(?:\*|([0-9A-Za-z]+)(?:-([0-9A-Za-z]+))?)(?:\/([0-9]+))?$/

function valueOf(token: string, spec: FieldSpec): number | null {
  if (/^[0-9]+$/.test(token)) return Number(token)
  const index = spec.names?.indexOf(token.toUpperCase()) ?? -1
  return index < 0 ? null : index + (spec.nameBase ?? 0)
}

function parseField(text: string, spec: FieldSpec): { ok: true; values: Set<number> } | { ok: false; rule: string } {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const m = PART.exec(part)
    if (!m) return { ok: false, rule: `${spec.name}: "${part}" is not *, n, a-b, */s or a-b/s` }
    const star = part.startsWith('*')
    // `a/s` alone is not in the subset: a step needs `*` or a range.
    if (!star && m[2] === undefined && m[3] !== undefined) return { ok: false, rule: `${spec.name}: a step needs * or a range (a-b/s)` }
    const from = star ? spec.min : valueOf(m[1], spec)
    const to = star ? spec.max : m[2] === undefined ? from : valueOf(m[2], spec)
    if (from === null || to === null) return { ok: false, rule: `${spec.name}: "${part}" is not a number${spec.names ? ' or a name' : ''}` }
    if (from < spec.min || from > spec.max || to < spec.min || to > spec.max) {
      return { ok: false, rule: `${spec.name}: out of range ${spec.min}-${spec.max}` }
    }
    if (from > to) return { ok: false, rule: `${spec.name}: range ${from}-${to} starts after it ends` }
    const step = m[3] === undefined ? 1 : Number(m[3])
    if (step === 0) return { ok: false, rule: `${spec.name}: a step of 0` }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return { ok: true, values }
}

/** Parses a five-field expression. Fields are separated by any run of spaces or tabs. Never throws. */
export function parseCron(text: string): CronResult {
  const fields = text.trim().split(/[ \t]+/)
  if (fields.length !== 5 || fields[0] === '') {
    return { ok: false, rule: 'expected five fields: minute hour day month weekday (no seconds, no @macros)' }
  }
  if (!/^[0-9]+$/.test(fields[0])) return { ok: false, rule: 'minute must be a single number (at most once an hour)' }
  const parsed: Set<number>[] = []
  for (let i = 0; i < FIELDS.length; i++) {
    const result = parseField(fields[i], FIELDS[i])
    if (!result.ok) return result
    parsed.push(result.values)
  }
  const weekdays = new Set([...parsed[4]].map((d) => (d === 7 ? 0 : d)))
  return {
    ok: true,
    schedule: {
      minute: [...parsed[0]][0],
      hours: [...parsed[1]].sort((a, b) => a - b),
      days: parsed[2],
      months: parsed[3],
      weekdays,
      daysRestricted: !fields[2].startsWith('*'),
      weekdaysRestricted: !fields[4].startsWith('*'),
    },
  }
}

function dayMatches(s: CronSchedule, date: Date): boolean {
  if (!s.months.has(date.getMonth() + 1)) return false
  const day = s.days.has(date.getDate())
  const weekday = s.weekdays.has(date.getDay())
  if (s.daysRestricted && s.weekdaysRestricted) return day || weekday
  return day && weekday
}

/**
 * The first matching instant strictly after `t`, in local time; `null` when none falls within
 * `MAX_REPEAT_SEARCH_YEARS` years and a day.
 */
export function firstMatchAfter(s: CronSchedule, t: number): number | null {
  const start = new Date(t)
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    // Noon: a day's own date, whatever the day's daylight-saving transition.
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12)
    if (!dayMatches(s, day)) continue
    for (const hour of s.hours) {
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, s.minute).getTime()
      if (candidate > t) return candidate
    }
  }
  return null
}

/** The matching instants in `(from, to]`, at most `limit`; `more` when the limit cut the list. */
export function matchesBetween(s: CronSchedule, from: number, to: number, limit: number): { times: number[]; more: boolean } {
  const times: number[] = []
  let t = from
  for (;;) {
    const next = firstMatchAfter(s, t)
    if (next === null || next > to) return { times, more: false }
    if (times.length === limit) return { times, more: true }
    times.push(next)
    t = next
  }
}
