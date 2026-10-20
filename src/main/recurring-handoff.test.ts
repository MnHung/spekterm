import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { handoffIntakeId, parseHandoffPayload, parseRecurrence } from './handoff-delivery'
import { whenAnnounced } from './handoff-opener'
import { testOpener } from './handoff-opener.testkit'
import { configureHandoff, outboxDir, prepareOutbox, resetHandoffState } from './handoff-outbox'
import { receiptFor } from './handoff-receipt'
import { HandoffService } from './handoff-service'
import { decideAccept } from './intake-accept'
import { listView } from './intake-projection'
import { isPermanentRejection } from './intake-rejection'
import { IntakeService, type DeliverOutcome } from './intake-service'
import { IntakeStore } from './intake-store'
import { contextScheduleFor } from './context-schedule'
import { buildContext, fencedBody } from './intake-context'
import { notificationTab } from './recurrence-kind'
import { isWaitingForUser } from '../shared/intake/scheduled'

// The repeat schedule is read in local time; a fixed zone keeps the expectations machine-independent.
process.env.TZ = 'Asia/Taipei'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const SOURCE = '11111111-2222-4333-8444-555555555555'
/** Monday 19 October 2026, 10:00 in Taipei. */
const MONDAY = new Date(2026, 9, 19, 10).getTime()
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

const bases: string[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})

describe('parseRecurrence (recurring-handoff, D3)', () => {
  const read = (fields: Record<string, string>, start?: number) =>
    parseRecurrence({ target: 'beta', title: '', body: 'b', ...fields }, start, MONDAY)

  it('absent without repeat or until', () => {
    assert.deepEqual(read({}), { kind: 'absent' })
  })

  it('reads repeat in its canonical form, with an optional start and end', () => {
    assert.deepEqual(read({ repeat: '  0  21 * *\tWED ' }), { kind: 'repeating', recurrence: { repeat: '0 21 * * WED' } })
    const until = local(2026, 12, 31)
    assert.deepEqual(read({ repeat: '0 21 * * 3', until: iso(until) }, MONDAY + DAY), {
      kind: 'repeating',
      recurrence: { repeat: '0 21 * * 3', startAt: MONDAY + DAY, until },
    })
  })

  it('refuses each rule, naming it', () => {
    const rule = (fields: Record<string, string>, start?: number): string => {
      const result = read(fields, start)
      assert.equal(result.kind, 'invalid')
      return result.kind === 'invalid' ? result.rule : ''
    }
    assert.match(rule({ until: iso(MONDAY + DAY) }), /until: only with repeat/)
    assert.match(rule({ repeat: '*/15 9 * * *' }), /repeat: minute must be a single number/)
    assert.match(rule({ repeat: '0 0 31 2 *' }), /repeat: no time within 4 years/)
    assert.match(rule({ repeat: '0 9 * * *', until: '2026-12-01T00:00' }), /until: no offset/)
    assert.match(rule({ repeat: '0 9 * * *', until: '2026-02-30T00:00:00+08:00' }), /until: day does not exist/)
    assert.match(rule({ repeat: '0 9 * * *', until: iso(MONDAY - MINUTE) }), /until: not later than now and the start/)
    assert.match(rule({ repeat: '0 9 * * *', until: iso(MONDAY + DAY) }, MONDAY + 2 * DAY), /until: not later than now and the start/)
    // Saturday: the coming Monday at 08:00 ends before Monday's 09:00.
    const saturday = local(2026, 10, 24, 10)
    const result = parseRecurrence({ target: 'beta', title: '', body: 'b', repeat: '0 9 * * 1', until: iso(local(2026, 10, 26, 8)) }, undefined, saturday)
    assert.deepEqual(result, { kind: 'invalid', rule: 'until: no time between the start and until' })
  })

  it('the start is inclusive', () => {
    const wednesday = local(2026, 10, 21, 21)
    const ok = read({ repeat: '0 21 * * 3', until: iso(wednesday) }, wednesday)
    assert.equal(ok.kind, 'invalid') // until must be later than the start
    assert.equal(read({ repeat: '0 21 * * 3', until: iso(wednesday + MINUTE) }, wednesday).kind, 'repeating')
  })
})

describe('the payload and the identity', () => {
  it('reads repeat and until; a non-string is FIELD_TYPE', () => {
    const ok = parseHandoffPayload(JSON.stringify({ target: 'a', body: 'b', repeat: '0 9 * * *', until: '2027-01-01T00:00:00Z' }))
    assert.ok(ok.ok)
    assert.equal(ok.ok && ok.value.repeat, '0 9 * * *')
    assert.equal(ok.ok && ok.value.until, '2027-01-01T00:00:00Z')
    assert.deepEqual(parseHandoffPayload(JSON.stringify({ target: 'a', body: 'b', repeat: 5 })), { ok: false, reason: 'FIELD_TYPE', field: 'repeat' })
    assert.deepEqual(parseHandoffPayload(JSON.stringify({ target: 'a', body: 'b', until: 5 })), { ok: false, reason: 'FIELD_TYPE', field: 'until' })
  })

  it('an existing handoff keeps its id; two expressions give two ids', () => {
    const payload = { target: 'a', title: 't', body: 'b' }
    assert.equal(handoffIntakeId(SOURCE, payload), handoffIntakeId(SOURCE, payload, undefined, undefined))
    const weekly = handoffIntakeId(SOURCE, payload, undefined, { repeat: '0 21 * * 3' })
    const daily = handoffIntakeId(SOURCE, payload, undefined, { repeat: '0 9 * * *' })
    assert.notEqual(weekly, handoffIntakeId(SOURCE, payload))
    assert.notEqual(weekly, daily)
    assert.notEqual(weekly, handoffIntakeId(SOURCE, payload, undefined, { repeat: '0 21 * * 3', until: MONDAY + 30 * DAY }))
  })

  it('REPEAT_INVALID is a permanent refusal', () => {
    assert.equal(isPermanentRejection({ code: 'REPEAT_INVALID', notify: true }), true)
  })
})

interface World {
  store: IntakeStore
  service: IntakeService
  opened: string[]
  arrivals: string[]
  failures: string[]
  deliver: (payload: Record<string, unknown>, name?: string) => Promise<DeliverOutcome>
}

function world(now: number = MONDAY): World {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'recurring-handoff-'))
  bases.push(base)
  resetHandoffState()
  configureHandoff(base)
  const archive = path.join(base, 'intake')
  fs.mkdirSync(archive, { recursive: true })
  const store = new IntakeStore(path.join(base, 'intake.json'))
  const service = new IntakeService({ store, archiveRoot: archive })
  const opened: string[] = []
  const arrivals: string[] = []
  const failures: string[] = []
  const folders = [{ id: 'f2', name: 'beta', path: '/repos/beta' }]
  service.onArrival(whenAnnounced((record) => arrivals.push(record.id)))
  service.onFailure((failure) => failures.push(failure.code))
  // A year ahead: a proposal must never be opened by the opener, whatever the clock.
  const opener = testOpener(service, () => folders, (_a, id) => opened.push(id), { now: () => now + 365 * DAY })
  const handoff = new HandoffService({
    service,
    sourceOf: () => ({ folderId: 'f1', label: 'alpha' }),
    candidates: () => folders,
    agentEventsEnabled: () => true,
    onDelivered: () => opener.tick(),
    now: () => now,
  })
  let n = 0
  return {
    store,
    service,
    opened,
    arrivals,
    failures,
    deliver: async (payload, name) => {
      prepareOutbox(SOURCE)
      const target = path.join(outboxDir(SOURCE), name ?? `r${(n += 1)}.json`)
      fs.writeFileSync(target, JSON.stringify(payload))
      return handoff.deliverFile(fs.readFileSync(target, 'utf8'), target)
    },
  }
}

const good = { target: 'beta', title: 'weekly review', body: 'review the week' }

describe('a proposal (D3)', () => {
  it('is announced on arrival, waits for the user, and is never opened', async () => {
    const w = world()
    const outcome = await w.deliver({ ...good, repeat: '0 21 * * 3' })
    assert.ok(outcome.ok)
    assert.equal(w.opened.length, 0)
    assert.equal(w.arrivals.length, 1)
    const record = outcome.record
    assert.equal(record?.opensAt, undefined)
    assert.equal(record?.content?.verified.repeat, '0 21 * * 3')
    assert.equal(record?.content?.verified.scheduledAt, undefined)
    const [view] = listView(w.store.list(), { rules: [], fallbackFolderId: null }, new Set(['f2']))
    assert.equal(isWaitingForUser(view), true)
    assert.equal(receiptFor('r1.json', outcome, MONDAY).status, 'proposed')
  })

  it('with a future at, the start never reaches scheduledAt: proposed, announced, counted', async () => {
    const w = world()
    const start = MONDAY + 14 * DAY
    const outcome = await w.deliver({ ...good, repeat: '0 21 * * 3', at: iso(start) })
    assert.ok(outcome.ok)
    assert.equal(outcome.record?.content?.verified.scheduledAt, undefined)
    assert.equal(outcome.record?.content?.verified.repeatStart, start)
    assert.equal(receiptFor('r1.json', outcome, MONDAY).status, 'proposed')
    assert.equal(w.arrivals.length, 1)
    const [view] = listView(w.store.list(), { rules: [], fallbackFolderId: null }, new Set(['f2']))
    assert.equal(view.scheduledAt, undefined)
    assert.equal(isWaitingForUser(view), true)
  })

  it('a one-off scheduled handoff still states scheduled', async () => {
    const w = world(Date.now())
    const outcome = await w.deliver({ ...good, at: iso(Date.now() + DAY) })
    assert.equal(receiptFor('r1.json', outcome, Date.now()).status, 'scheduled')
  })

  it('refusals: repeat with an offset-less at, until alone, the minute rule — each visible, nothing recorded', async () => {
    const w = world()
    const noOffset = await w.deliver({ ...good, repeat: '0 9 * * *', at: '2026-10-20T09:00' })
    assert.equal(noOffset.code, 'SCHEDULE_INVALID')
    const alone = await w.deliver({ ...good, until: iso(MONDAY + DAY) })
    assert.equal(alone.code, 'REPEAT_INVALID')
    const minute = await w.deliver({ ...good, repeat: '*/15 9 * * *' })
    assert.equal(minute.code, 'REPEAT_INVALID')
    const receipt = receiptFor('r3.json', minute, MONDAY)
    assert.equal(receipt.status, 'rejected')
    assert.equal(receipt.permanent, true)
    assert.match(receipt.reason ?? '', /minute must be a single number/)
    // The inbox's failure trace (the notification is raised by the outbox reader, `notifyFailures`).
    assert.deepEqual(w.service.notices().map((n) => n.code).sort(), ['REPEAT_INVALID', 'SCHEDULE_INVALID'])
    assert.equal(w.store.list().length, 0)
  })

  it('is refused by the accept path', async () => {
    const w = world()
    const outcome = await w.deliver({ ...good, repeat: '0 21 * * 3' })
    const decision = decideAccept({ record: outcome.record, chosenFolderId: 'f2', knownFolderIds: new Set(['f2']), eventsEnabled: true })
    assert.equal(decision.ok, false)
  })
})

describe('what an occurrence is told (D7)', () => {
  const occurrence = (scheduledAt: number, extra: Record<string, unknown> = {}) => ({
    scheduledAt,
    repeat: '0 9 * * *',
    recurrenceId: 'r1',
    ...extra,
  })

  it('a Monday occurrence opened on Wednesday lists Tuesday and Wednesday 09:00, and the body is untouched', () => {
    const monday = local(2026, 10, 19, 9)
    const wednesday = local(2026, 10, 21, 10)
    const schedule = contextScheduleFor(occurrence(monday), wednesday, wednesday)
    assert.deepEqual(schedule?.recurrence?.missed, [local(2026, 10, 20, 9), local(2026, 10, 21, 9)])
    const body = 'review the week\n```\nnot a fence\n```'
    const doc = buildContext(body, 'n1', schedule)
    assert.match(doc.contents, /repeats on the schedule "0 9 \* \* \*"/)
    assert.match(doc.contents, /2 later scheduled times passed before it started and were not run separately: 2026-10-20T09:00:00\+08:00, 2026-10-21T09:00:00\+08:00\./)
    assert.match(doc.contents, /scheduled for 2026-10-19T09:00:00\+08:00\. It started at 2026-10-21T10:00:00\+08:00\./)
    assert.equal(fencedBody(doc.contents, 'n1'), body)
  })

  it('on time: both times and no missed ones', () => {
    const at = local(2026, 10, 19, 9)
    const doc = buildContext('b', 'n1', contextScheduleFor(occurrence(at), at + 20_000, at + 20_000))
    assert.match(doc.contents, /repeats on the schedule/)
    assert.doesNotMatch(doc.contents, /not run separately/)
  })

  it('a failed occurrence accepted three days later lists none: the count stops at when it was fired', () => {
    const at = local(2026, 10, 19, 9)
    const schedule = contextScheduleFor(occurrence(at), at + 20_000, at + 3 * DAY)
    assert.equal(schedule?.recurrence?.missedCount, 0)
  })

  it('lists ten and counts the rest; stops at the end, which it states', () => {
    const at = local(2026, 10, 1, 9)
    const many = contextScheduleFor({ ...occurrence(at), repeat: '0 * * * *' }, at + 20 * 3_600_000, at + 20 * 3_600_000)
    assert.equal(many?.recurrence?.missed.length, 10)
    assert.equal(many?.recurrence?.missedCount, 20)
    assert.match(buildContext('b', 'n', many).contents, /20 later scheduled times .*, and 10 more\./)
    const capped = contextScheduleFor({ ...occurrence(at), repeat: '0 * * * *' }, at + 2_000 * 3_600_000, at + 2_000 * 3_600_000)
    assert.match(buildContext('b', 'n', capped).contents, /At least 1000 later scheduled times .*, and more\./)
    const until = local(2026, 10, 2, 12)
    const ended = contextScheduleFor(occurrence(at, { repeatUntil: until }), local(2026, 10, 5, 9), local(2026, 10, 5, 9))
    assert.deepEqual(ended?.recurrence?.missed, [local(2026, 10, 2, 9)])
    assert.match(buildContext('b', 'n', ended).contents, /The schedule ends at 2026-10-02T12:00:00\+08:00\./)
  })

  it('a one-off scheduled handoff keeps its one line', () => {
    const at = local(2026, 10, 19, 9)
    const doc = buildContext('b', 'n', contextScheduleFor({ scheduledAt: at }, at, at))
    assert.doesNotMatch(doc.contents, /repeats/)
    assert.match(doc.contents, /This handoff was scheduled for/)
  })
})

describe('which tab a notification opens (D6)', () => {
  it('only proposals ⇒ schedules; a proposal and an ordinary item, or no keys ⇒ inbox; an approved proposal still counts', async () => {
    const w = world()
    const proposal = await w.deliver({ ...good, repeat: '0 21 * * 3' })
    const plain = await w.deliver({ ...good, title: 'now', body: 'do it now' })
    const get = (adapter: string, id: string) => w.store.get(adapter, id)
    const key = (o: DeliverOutcome) => ({ adapter: o.record?.adapter ?? '', id: o.record?.id ?? '' })
    assert.equal(notificationTab([key(proposal)], get), 'schedules')
    assert.equal(notificationTab([key(proposal), key(plain)], get), 'inbox')
    assert.equal(notificationTab([], get), 'inbox')
    assert.equal(notificationTab([key(plain)], get), 'inbox')
    w.store.setState(key(proposal).adapter, key(proposal).id, 'accepted')
    assert.equal(notificationTab([key(proposal)], get), 'schedules')
  })
})
