import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { firstMatchAfter, matchesBetween, MAX_REPEAT_SEARCH_YEARS, parseCron, type CronSchedule } from './cron'

// A fixed zone without daylight saving, so the expectations below do not depend on the machine running them.
// (`node --test` runs each file in its own process, so this does not reach other files.)
process.env.TZ = 'Asia/Taipei'

const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

function schedule(text: string): CronSchedule {
  const result = parseCron(text)
  assert.ok(result.ok, `${text}: ${result.ok ? '' : result.rule}`)
  return result.schedule
}

function refusal(text: string): string {
  const result = parseCron(text)
  assert.equal(result.ok, false, `${text} should be refused`)
  return result.ok ? '' : result.rule
}

describe('parseCron (recurring-handoff, D5)', () => {
  it('accepts the subset, names in any case, and any run of spaces or tabs', () => {
    for (const text of ['0 21 * * WED', '0  9 1-7 * 1', '0 */6 * * *', '0 0 29 2 *', '5 9 * jan-mar mon-fri', '0\t9 * * 0,7', ' 0 9 * * * ']) {
      schedule(text)
    }
  })

  it('reads weekday 7 as Sunday', () => {
    assert.deepEqual([...schedule('0 9 * * 7').weekdays], [0])
  })

  it('refuses each rule outside the subset, naming it', () => {
    assert.match(refusal('* * * * *'), /minute must be a single number/)
    assert.match(refusal('*/15 9 * * *'), /minute must be a single number/)
    assert.match(refusal('0,30 9 * * *'), /minute must be a single number/)
    assert.match(refusal('0 0 9 * * *'), /five fields/)
    assert.match(refusal('0 9 * *'), /five fields/)
    assert.match(refusal('@daily'), /five fields/)
    assert.match(refusal(''), /five fields/)
    assert.match(refusal('60 9 * * *'), /minute: out of range/)
    assert.match(refusal('0 24 * * *'), /hour: out of range/)
    assert.match(refusal('0 9 0 * *'), /day of month: out of range/)
    assert.match(refusal('0 9 * 13 *'), /month: out of range/)
    assert.match(refusal('0 9 * * 8'), /day of week: out of range/)
    assert.match(refusal('0 9 5-1 * *'), /starts after it ends/)
    assert.match(refusal('0 */0 * * *'), /step of 0/)
    assert.match(refusal('0 9 L * *'), /day of month/)
    assert.match(refusal('0 9 * * 1#2'), /day of week/)
    assert.match(refusal('0 9 ? * *'), /day of month/)
    assert.match(refusal('0 9 15W * *'), /day of month/)
    assert.match(refusal('0 9/2 * * *'), /a step needs \* or a range/)
    assert.match(refusal('0 9 * FOO *'), /month/)
  })
})

describe('firstMatchAfter and matchesBetween', () => {
  const monday = local(2026, 10, 19, 10)

  it('finds the next Wednesday at 21:00, strictly after', () => {
    const s = schedule('0 21 * * 3')
    const wednesday = local(2026, 10, 21, 21)
    assert.equal(firstMatchAfter(s, monday), wednesday)
    assert.equal(firstMatchAfter(s, wednesday), local(2026, 10, 28, 21))
    assert.equal(firstMatchAfter(s, wednesday - 1), wednesday)
  })

  it('matches day of month or day of week when both are restricted', () => {
    const s = schedule('0 9 1 * MON')
    const { times } = matchesBetween(s, local(2026, 10, 25), local(2026, 11, 10), 10)
    assert.deepEqual(times, [local(2026, 10, 26, 9), local(2026, 11, 1, 9), local(2026, 11, 2, 9), local(2026, 11, 9, 9)])
  })

  it('needs both when one of them starts with *', () => {
    const s = schedule('0 9 */2 * MON')
    // */2 starts with *, so the two combine with AND (as in Vixie cron): odd days that are Mondays. 26 October is
    // an even Monday; 9 November is the first odd one.
    assert.equal(firstMatchAfter(s, monday), local(2026, 11, 9, 9))
  })

  it(`finds 29 February within ${MAX_REPEAT_SEARCH_YEARS} years, and never 31 February`, () => {
    assert.equal(firstMatchAfter(schedule('0 0 29 2 *'), monday), local(2028, 2, 29))
    assert.equal(firstMatchAfter(schedule('0 0 31 2 *'), monday), null)
  })

  it('stops at its limit and says so', () => {
    const s = schedule('0 * * * *')
    const all = matchesBetween(s, monday, monday + 5 * 3_600_000, 10)
    assert.equal(all.times.length, 5)
    assert.equal(all.more, false)
    const cut = matchesBetween(s, monday, monday + 5 * 3_600_000, 3)
    assert.equal(cut.times.length, 3)
    assert.equal(cut.more, true)
  })
})
