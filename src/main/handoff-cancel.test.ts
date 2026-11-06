import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, describe, it } from 'node:test'

import { agentCancels, AGENT_CANCEL_WINDOW_MS, CANCEL_DETAIL, decideCancel, HandoffCanceller } from './handoff-cancel'
import { HANDOFF_ADAPTER } from './handoff-delivery'
import type { HandoffOpener } from './handoff-opener'
import { testOpener } from './handoff-opener.testkit'
import { configureHandoff, outboxDir, prepareOutbox, receiptsDir, resetHandoffState } from './handoff-outbox'
import { receiptFor } from './handoff-receipt'
import { HandoffService } from './handoff-service'
import { dismissIntake, onIntakeDismissed } from './intake-changes'
import { listView, scheduleShapeOf } from './intake-projection'
import { IntakeService } from './intake-service'
import { IntakeStore, type IntakeRecord } from './intake-store'
import { RecurrenceKeeper } from './recurrence-keeper'
import { RecurrenceStore } from './recurrence-store'

import { isProposal, isScheduled } from '../shared/intake/scheduled'

process.env.TZ = 'Asia/Taipei'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WRITER = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-8888-4777-8666-555555555555'
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
/** Monday 19 October 2026, 10:00. */
const MONDAY = local(2026, 10, 19, 10)
const iso = (ms: number): string => new Date(ms).toISOString()

const bases: string[] = []
const unsubscribe: (() => void)[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})
afterEach(() => {
  for (const off of unsubscribe.splice(0)) off()
})

interface World {
  base: string
  clock: { now: number }
  store: IntakeStore
  service: IntakeService
  recurrences: RecurrenceStore
  keeper: RecurrenceKeeper
  opener: HandoffOpener
  folders: { id: string; name: string; path: string }[]
  handoff: HandoffService
  /** Writes a handoff from `WRITER` and returns its record. */
  write: (fields: Record<string, unknown>) => Promise<IntakeRecord>
  /** Writes a cancel from `from`, returns the outcome and the receipt the service would write. */
  cancel: (id: unknown, from?: string, extra?: Record<string, unknown>) => Promise<{ outcome: Awaited<ReturnType<HandoffService['deliverFile']>>; receipt: ReturnType<typeof receiptFor> }>
  approve: (record: IntakeRecord) => void
  occurrences: () => IntakeRecord[]
}

function world(options: { dismiss?: 'store' } = {}): World {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cancel-'))
  bases.push(base)
  resetHandoffState()
  configureHandoff(base)
  const archive = path.join(base, 'intake')
  fs.mkdirSync(archive, { recursive: true })
  const clock = { now: MONDAY }
  const store = new IntakeStore(path.join(base, 'intake.json'))
  store.load()
  const service = new IntakeService({ store, archiveRoot: archive })
  const recurrences = new RecurrenceStore(path.join(base, 'handoff-recurrences.json'))
  recurrences.load()
  const folders = [
    { id: 'f2', name: 'beta', path: '/repos/beta' },
    { id: 'f3', name: 'gamma', path: '/repos/gamma' },
  ]
  const openerRef: { current: HandoffOpener | null } = { current: null }
  const keeper = new RecurrenceKeeper({
    service,
    recurrences,
    candidates: () => folders,
    opening: (adapter, id) => openerRef.current?.wasRequested(adapter, id) ?? false,
    changed: () => {},
    now: () => clock.now,
  })
  // As production wires it (`index.ts`): an ignore from anywhere reaches the keeper.
  unsubscribe.push(onIntakeDismissed((adapter, id) => keeper.afterDismiss(adapter, id)))
  const opener = testOpener(service, () => folders, () => {}, { now: () => clock.now, keeper })
  openerRef.current = opener
  const canceller = new HandoffCanceller({
    records: () => store.list(),
    listing: () => keeper.listing(),
    recurrences,
    dismiss: (adapter, id, by) =>
      options.dismiss === 'store' ? store.setState(adapter, id, 'dismissed', undefined, by) : dismissIntake(store, adapter, id, by),
    stop: (id, by) => keeper.stop(id, by),
    reject: (code, label, detail, context) => service.reject(code, label, detail, context),
    labelOf: (sessionId) => (sessionId === WRITER ? 'alpha' : 'gamma · Plan next week'),
    now: () => clock.now,
  })
  const handoff = new HandoffService({
    service,
    sourceOf: () => ({ folderId: 'f1', label: 'alpha' }),
    candidates: () => folders,
    agentEventsEnabled: () => true,
    onDelivered: () => opener.tick(),
    now: () => clock.now,
    cancel: (sessionId, contents) => canceller.deliver(sessionId, contents),
  })
  let n = 0
  const file = (from: string, payload: Record<string, unknown>): string => {
    prepareOutbox(from)
    const target = path.join(outboxDir(from), `d${(n += 1)}.json`)
    fs.writeFileSync(target, JSON.stringify(payload))
    return target
  }
  return {
    base,
    clock,
    store,
    service,
    recurrences,
    keeper,
    opener,
    folders,
    handoff,
    write: async (fields) => {
      const target = file(WRITER, { target: 'beta', title: 'nightly build', body: 'run the nightly build', ...fields })
      const outcome = await handoff.deliverFile(fs.readFileSync(target, 'utf8'), target)
      assert.ok(outcome.ok && outcome.record, `handoff refused: ${outcome.code} ${outcome.detail ?? ''}`)
      return outcome.record
    },
    cancel: async (id, from = OTHER, extra = {}) => {
      const target = file(from, { kind: 'cancel', ...(id === undefined ? {} : { id }), ...extra })
      const outcome = await handoff.deliverFile(fs.readFileSync(target, 'utf8'), target)
      return { outcome, receipt: receiptFor(target, outcome, clock.now) }
    },
    approve: (record) => {
      const result = keeper.approve(record.adapter, record.id, 'f2')
      assert.ok(result.ok, `approve refused: ${JSON.stringify(result)}`)
    },
    occurrences: () => store.list().filter((r) => r.content?.verified.recurrenceId !== undefined),
  }
}

const recordOf = (w: World, id: string): IntakeRecord | undefined => w.store.get(HANDOFF_ADAPTER, id)
const upcoming = (w: World): IntakeRecord[] => w.occurrences().filter((r) => r.state === 'pending' && r.firedAt === undefined)

describe('a cancel carries out the desktop action on what the Schedules tab lists (D2, D3)', () => {
  it('cancels a one-off scheduled handoff by the id its receipt states, from an unrelated session', async () => {
    const w = world()
    const record = await w.write({ at: iso(MONDAY + DAY) })
    const written = receiptFor('a.json', { ok: true, consume: true, notify: false, record }, w.clock.now)
    assert.equal(written.status, 'scheduled')
    assert.equal(written.id, record.id, 'the scheduled receipt carries the id a cancel names')

    const { outcome, receipt } = await w.cancel(record.id, OTHER)
    assert.equal(receipt.status, 'accepted')
    assert.equal(receipt.id, record.id)
    assert.equal(outcome.notify, false)
    assert.equal(recordOf(w, record.id)?.state, 'dismissed')
    assert.deepEqual(recordOf(w, record.id)?.cancelledBy, { label: 'gamma · Plan next week', at: MONDAY })
    assert.equal(w.service.notices().length, 0, 'a carried-out cancel leaves no trace')
  })

  it('reads only "id": a target and title beside it choose nothing', async () => {
    const w = world()
    const a = await w.write({ at: iso(MONDAY + DAY), title: 'A' })
    const b = await w.write({ at: iso(MONDAY + 2 * DAY), title: 'B', target: 'gamma' })
    await w.cancel(a.id, OTHER, { target: 'gamma', title: 'B' })
    assert.equal(recordOf(w, a.id)?.state, 'dismissed')
    assert.equal(recordOf(w, b.id)?.state, 'pending')
  })

  it('skips an occurrence through the inbox ignore, so the keeper lists the next one', async () => {
    // Control: dismissing through the store (`options.dismiss: 'store'`) skips the keeper — see the next test.
    const w = world()
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    const [first] = upcoming(w)
    const firstAt = first.content?.verified.scheduledAt ?? 0
    const { receipt } = await w.cancel(first.id)
    assert.equal(receipt.status, 'accepted')
    assert.equal(recordOf(w, first.id)?.state, 'dismissed')
    const next = upcoming(w)
    assert.equal(next.length, 1)
    assert.equal(next[0].content?.verified.scheduledAt, firstAt + 7 * DAY)
  })

  it('control: a cancel that writes the state through the store, not dismissIntake, leaves no next occurrence', async () => {
    const w = world({ dismiss: 'store' })
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    const [first] = upcoming(w)
    await w.cancel(first.id)
    assert.equal(upcoming(w).length, 0, 'the keeper never heard of the skip: the mutation this suite guards against')
  })

  it('declines a proposal', async () => {
    const w = world()
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    const { receipt } = await w.cancel(proposal.id)
    assert.equal(receipt.status, 'accepted')
    assert.equal(recordOf(w, proposal.id)?.state, 'dismissed')
    assert.equal(w.keeper.approve(proposal.adapter, proposal.id, 'f2').ok, false, 'nothing left to approve')
  })

  it('stops an approved recurrence with no confirmation, removes its upcoming occurrence, and marks it', async () => {
    const w = world()
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    const [first] = upcoming(w)
    const { receipt } = await w.cancel(proposal.id)
    assert.equal(receipt.status, 'accepted')
    const stopped = w.recurrences.get(proposal.id)
    assert.equal(stopped?.stoppedAt, MONDAY)
    assert.deepEqual(stopped?.cancelledBy, { label: 'gamma · Plan next week', at: MONDAY })
    assert.equal(recordOf(w, first.id)?.state, 'dismissed')
    assert.equal(recordOf(w, first.id)?.cancelledBy, undefined, 'the keeper\'s own removal is not an agent cancel')
    assert.equal(w.keeper.listing().recurrences.length, 0)
  })

  it('stops a recurrence past its end whose occurrence waits for the user, as the desktop can', async () => {
    const w = world()
    const proposal = await w.write({ repeat: '0 21 * * 3', until: iso(local(2026, 10, 22)) })
    w.approve(proposal)
    const [only] = upcoming(w)
    // Its folder is gone when it falls due: the opener refuses, and the occurrence waits for the user.
    w.folders.splice(0, w.folders.length)
    w.clock.now = (only.content?.verified.scheduledAt ?? 0) + MINUTE
    w.opener.tick()
    w.clock.now = local(2026, 10, 23)
    assert.equal(recordOf(w, only.id)?.state, 'pending')
    assert.ok(w.keeper.listing().recurrences.some((r) => r.id === proposal.id), 'listed: it has not ended for the tab')
    // Control: judging "ended" by `until < now` would refuse this; the listing is the judge.
    const { receipt } = await w.cancel(proposal.id)
    assert.equal(receipt.status, 'accepted')
    assert.equal(recordOf(w, only.id)?.state, 'pending', 'a waiting occurrence stays for the user')
  })
})

describe('what cannot be cancelled is refused, and visibly (D2, D8)', () => {
  it('refuses a handoff fired by Run now whose time is still ahead: its opening has begun', async () => {
    // This fixture is the one where `opensAt <= now` and the tab's reading disagree: opensAt is tomorrow.
    const w = world()
    const record = await w.write({ at: iso(MONDAY + DAY) })
    assert.ok(w.opener.runNow(record.adapter, record.id))
    const { receipt } = await w.cancel(record.id)
    assert.equal(receipt.status, 'rejected')
    assert.equal(receipt.code, 'CANCEL_NOT_FOUND')
    assert.equal(receipt.permanent, true)
    assert.match(receipt.reason ?? '', new RegExp(CANCEL_DETAIL.opening))
    assert.equal(recordOf(w, record.id)?.state, 'pending')
    assert.equal(w.service.notices().length, 1, 'a refused cancel is visible')
  })

  it('refuses an opened handoff, and never touches its session', async () => {
    const w = world()
    const record = await w.write({})
    w.store.setState(record.adapter, record.id, 'accepted', 'session-1')
    const { receipt } = await w.cancel(record.id)
    assert.equal(receipt.code, 'CANCEL_NOT_FOUND')
    assert.equal(recordOf(w, record.id)?.state, 'accepted')
    assert.equal(recordOf(w, record.id)?.sessionId, 'session-1')
  })

  it('refuses an unknown id, another producer\'s item, and an ended recurrence, each with its detail', async () => {
    const w = world()
    w.store.add({
      id: 'slack-1',
      verified: { adapter: 'slack', originKind: 'channel', originId: 'C1' },
      authored: { title: 'ping', body: 'ping', actor: 'alex', originLabel: '#general' },
      receivedAt: MONDAY,
    })
    const unknown = await w.cancel('nope')
    assert.match(unknown.receipt.reason ?? '', new RegExp(CANCEL_DETAIL.unknown))
    const slack = await w.cancel('slack-1')
    assert.match(slack.receipt.reason ?? '', new RegExp(CANCEL_DETAIL.notCancellable))
    assert.equal(w.store.get('slack', 'slack-1')?.state, 'pending')

    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    const recurrence = w.recurrences.get(proposal.id)
    assert.ok(recurrence)
    for (const record of upcoming(w)) w.store.setState(record.adapter, record.id, 'dismissed')
    w.recurrences.put({ ...recurrence, endedAt: MONDAY })
    const ended = await w.cancel(proposal.id)
    assert.equal(ended.receipt.code, 'CANCEL_NOT_FOUND')
    assert.match(ended.receipt.reason ?? '', new RegExp(CANCEL_DETAIL.ended))
  })

  it('refuses a cancel without an id, naming the field', async () => {
    const w = world()
    for (const id of [undefined, '', 7]) {
      const { receipt } = await w.cancel(id)
      assert.equal(receipt.code, 'FIELD_TYPE')
      assert.match(receipt.reason ?? '', /\bid\b/)
    }
  })

  it('refuses as a field of the wrong type when no canceller is wired', async () => {
    const w = world()
    const bare = new HandoffService({
      service: w.service,
      sourceOf: () => null,
      candidates: () => w.folders,
      agentEventsEnabled: () => true,
      onDelivered: () => {},
    })
    prepareOutbox(OTHER)
    const target = path.join(outboxDir(OTHER), 'x.json')
    fs.writeFileSync(target, JSON.stringify({ kind: 'cancel', id: 'a' }))
    const outcome = await bare.deliverFile(fs.readFileSync(target, 'utf8'), target)
    assert.equal(outcome.code, 'FIELD_TYPE')
    assert.equal(outcome.detail, 'kind')
  })
})

describe('cancelling twice is not a failure (D11)', () => {
  it('a second cancel of a dismissed handoff or a stopped recurrence is a duplicate with no trace', async () => {
    const w = world()
    const record = await w.write({ at: iso(MONDAY + DAY) })
    await w.cancel(record.id)
    const again = await w.cancel(record.id)
    assert.equal(again.receipt.status, 'duplicate')
    assert.equal(again.receipt.id, record.id)

    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    await w.cancel(proposal.id)
    const stopAgain = await w.cancel(proposal.id)
    assert.equal(stopAgain.receipt.status, 'duplicate')
    assert.equal(w.service.notices().length, 0)
    // The desktop's ignore first, then an agent: the state holds, and the line is not the agent's.
    const desk = await w.write({ at: iso(MONDAY + 3 * DAY) })
    dismissIntake(w.store, desk.adapter, desk.id)
    assert.equal((await w.cancel(desk.id)).receipt.status, 'duplicate')
    assert.equal(recordOf(w, desk.id)?.cancelledBy, undefined)
  })
})

describe('an unavailable recurrence store (D2 row 4)', () => {
  it('an approved recurrence\'s id is temporary, not permanent; an opened ordinary handoff is still permanent', async () => {
    const w = world()
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    const opened = await w.write({ title: 'now' })
    w.store.setState(opened.adapter, opened.id, 'accepted', 'session-2')
    // A newer build's file: the store reads as unavailable.
    fs.writeFileSync(path.join(w.base, 'handoff-recurrences.json'), JSON.stringify({ version: 99, entries: [] }))
    w.recurrences.load()
    assert.equal(w.recurrences.available, false)

    const stop = await w.cancel(proposal.id)
    assert.equal(stop.receipt.status, 'rejected')
    assert.equal(stop.receipt.code, 'CANCEL_UNAVAILABLE', 'control: without row 4 this is CANCEL_NOT_FOUND')
    assert.equal(stop.receipt.permanent, false)

    const unknown = await w.cancel('never-seen')
    assert.equal(unknown.receipt.code, 'CANCEL_UNAVAILABLE')

    const ordinary = await w.cancel(opened.id)
    assert.equal(ordinary.receipt.code, 'CANCEL_NOT_FOUND')
    assert.equal(ordinary.receipt.permanent, true)
  })

  it('a stop whose store write throws is refused as unavailable, not a failed read', async () => {
    const w = world()
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    const put = w.recurrences.put.bind(w.recurrences)
    w.recurrences.put = () => {
      throw new Error('disk full')
    }
    const errors = console.error
    console.error = () => {}
    try {
      const { receipt } = await w.cancel(proposal.id)
      assert.equal(receipt.status, 'rejected')
      assert.equal(receipt.code, 'CANCEL_UNAVAILABLE')
    } finally {
      console.error = errors
      w.recurrences.put = put
    }
  })
})

describe('the decision reads the Schedules tab\'s own predicates', () => {
  it('dismisses exactly the records the tab lists, for every kind of record', async () => {
    const w = world()
    await w.write({ at: iso(MONDAY + DAY), title: 'one-off' })
    const proposal = await w.write({ repeat: '0 21 * * 3', title: 'proposal' })
    await w.write({ repeat: '0 9 * * 1', title: 'approved' }).then((r) => w.approve(r))
    const fired = await w.write({ at: iso(MONDAY + 2 * DAY), title: 'fired' })
    w.opener.runNow(fired.adapter, fired.id)
    const opened = await w.write({ title: 'opened' })
    w.store.setState(opened.adapter, opened.id, 'accepted', 's')
    void proposal
    const deps = { records: () => w.store.list(), listing: () => w.keeper.listing(), recurrences: w.recurrences }
    for (const record of w.store.list()) {
      const shape = scheduleShapeOf(record)
      const listed = isProposal(shape) || isScheduled(shape)
      const decision = decideCancel(record.id, deps)
      const recurrenceListed = w.keeper.listing().recurrences.some((r) => r.id === record.id)
      assert.equal(decision.kind === 'dismiss', listed && !recurrenceListed, `${record.content?.authored.title}`)
    }
    // And the projection the tab renders agrees with the shape the decision reads.
    for (const view of listView(w.store.list(), { rules: [], fallbackFolderId: null }, new Set(['f2', 'f3']))) {
      const record = recordOf(w, view.id)
      assert.ok(record)
      assert.equal(isScheduled(view), isScheduled(scheduleShapeOf(record)))
      assert.equal(isProposal(view), isProposal(scheduleShapeOf(record)))
    }
  })
})

describe('what agents cancelled (D5)', () => {
  it('lists marked, dismissed records and stopped recurrences for 7 days, newest first, with their action', async () => {
    const w = world()
    const oneOff = await w.write({ at: iso(MONDAY + DAY), title: '' , body: '\n  Check the deploy\nmore' })
    const proposal = await w.write({ repeat: '0 21 * * 3', title: 'Weekly report' })
    await w.cancel(oneOff.id)
    w.clock.now += HOUR
    w.approve(proposal)
    const [occurrence] = upcoming(w)
    await w.cancel(occurrence.id)
    w.clock.now += HOUR
    await w.cancel(proposal.id)
    const desk = await w.write({ at: iso(MONDAY + 3 * DAY), title: 'desk' })
    dismissIntake(w.store, desk.adapter, desk.id)

    const lines = agentCancels(w.store.list(), w.recurrences.list(), w.clock.now)
    assert.deepEqual(
      lines.map((line) => [line.action, line.title, line.label]),
      [
        ['stopped', 'Weekly report', 'gamma · Plan next week'],
        ['skipped', 'Weekly report', 'gamma · Plan next week'],
        ['cancelled', 'Check the deploy', 'gamma · Plan next week'],
      ],
    )
    const firstAt = lines[2].at
    assert.equal(agentCancels(w.store.list(), w.recurrences.list(), firstAt + AGENT_CANCEL_WINDOW_MS - 1).length, 3)
    assert.equal(agentCancels(w.store.list(), w.recurrences.list(), firstAt + AGENT_CANCEL_WINDOW_MS).length, 2, '7 days on, gone')
  })

  it('a mark on a record that is not dismissed is not listed', () => {
    const record = {
      adapter: HANDOFF_ADAPTER,
      id: 'x',
      state: 'pending' as const,
      digest: 'd',
      cancelledBy: { label: 'alpha', at: MONDAY },
      content: null,
    }
    assert.equal(agentCancels([record], [], MONDAY + MINUTE).length, 0)
  })

  it('the mark survives a reload, and a damaged one reads as absent', async () => {
    const w = world()
    const record = await w.write({ at: iso(MONDAY + DAY) })
    await w.cancel(record.id)
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    w.approve(proposal)
    await w.cancel(proposal.id)

    const store = new IntakeStore(path.join(w.base, 'intake.json'))
    store.load()
    assert.deepEqual(store.get(HANDOFF_ADAPTER, record.id)?.cancelledBy, { label: 'gamma · Plan next week', at: MONDAY })
    const recurrences = new RecurrenceStore(path.join(w.base, 'handoff-recurrences.json'))
    recurrences.load()
    assert.equal(recurrences.available, true, 'the version did not change')
    assert.deepEqual(recurrences.get(proposal.id)?.cancelledBy, { label: 'gamma · Plan next week', at: MONDAY })

    const file = path.join(w.base, 'intake.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const entry of data.entries) if (entry.id === record.id) entry.cancelledBy = { label: 7, at: 'soon' }
    fs.writeFileSync(file, JSON.stringify(data))
    const damaged = new IntakeStore(file)
    damaged.load()
    assert.equal(damaged.get(HANDOFF_ADAPTER, record.id)?.cancelledBy, undefined)
    assert.equal(damaged.get(HANDOFF_ADAPTER, record.id)?.state, 'dismissed')
  })
})

describe('receipts carry ids (handoff-receipt)', () => {
  it('a proposal\'s receipt id is the recurrence id after approval, and a same-content resend is a duplicate with the id', async () => {
    const w = world()
    const proposal = await w.write({ repeat: '0 21 * * 3' })
    const proposed = receiptFor('p.json', { ok: true, consume: true, notify: false, record: proposal }, MONDAY)
    assert.equal(proposed.status, 'proposed')
    assert.equal(proposed.id, proposal.id)
    w.approve(proposal)
    assert.ok(w.recurrences.get(proposed.id ?? ''))

    prepareOutbox(WRITER)
    const target = path.join(outboxDir(WRITER), 'again.json')
    fs.writeFileSync(target, JSON.stringify({ target: 'beta', title: 'nightly build', body: 'run the nightly build', repeat: '0 21 * * 3' }))
    const outcome = await w.handoff.deliverFile(fs.readFileSync(target, 'utf8'), target)
    const receipt = receiptFor(target, outcome, MONDAY)
    assert.equal(receipt.status, 'duplicate')
    assert.equal(receipt.id, proposal.id)
    assert.ok(!JSON.stringify(receipt).includes('nightly'), 'no delivery text')
    void receiptsDir
  })
})
