import assert from 'node:assert/strict'
import { it } from 'node:test'

import { firstMatchAfter, matchesBetween, parseCron, type CronSchedule } from './cron'

// Daylight saving (`recurring-handoff`, D5). Set before any `Date` is used; Node re-reads `TZ` on assignment, and
// `node --test` runs each file in its own process.
process.env.TZ = 'America/New_York'

const HOUR = 3_600_000

function schedule(text: string): CronSchedule {
  const result = parseCron(text)
  assert.ok(result.ok)
  return result.schedule
}

it('runs in a zone with daylight saving (control: a TZ that did not apply would fail here)', () => {
  assert.notEqual(new Date(2026, 0, 15).getTimezoneOffset(), new Date(2026, 6, 15).getTimezoneOffset())
})

it('a time in the spring gap opens after it, and the next day at its own time', () => {
  const s = schedule('30 2 * * *')
  const first = firstMatchAfter(s, Date.parse('2026-03-08T00:00:00-05:00'))
  assert.equal(first, Date.parse('2026-03-08T03:30:00-04:00'))
  assert.equal(firstMatchAfter(s, first ?? 0), Date.parse('2026-03-09T02:30:00-04:00'))
})

it('a time that occurs twice in the autumn opens once', () => {
  const s = schedule('30 1 * * *')
  const { times } = matchesBetween(s, Date.parse('2026-10-31T12:00:00-04:00'), Date.parse('2026-11-02T00:00:00-05:00'), 10)
  assert.deepEqual(times, [Date.parse('2026-11-01T01:30:00-04:00')])
})

it('an hourly schedule has no duplicate instant across either transition', () => {
  const s = schedule('30 * * * *')
  for (const [from, to] of [
    ['2026-03-07T22:00:00-05:00', '2026-03-08T06:00:00-04:00'],
    ['2026-10-31T22:00:00-04:00', '2026-11-01T06:00:00-05:00'],
  ]) {
    const { times } = matchesBetween(s, Date.parse(from), Date.parse(to), 100)
    assert.equal(new Set(times).size, times.length)
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= HOUR - 1, `gap at ${new Date(times[i]).toISOString()}`)
  }
})
