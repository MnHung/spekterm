import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { HANDOFF_ADAPTER } from './handoff-delivery'
import type { HandoffOpener } from './handoff-opener'
import { testOpener } from './handoff-opener.testkit'
import { configureHandoff, outboxDir, prepareOutbox, resetHandoffState } from './handoff-outbox'
import { HandoffService } from './handoff-service'
import { dismissIntake, onIntakeDismissed } from './intake-changes'
import { listView } from './intake-projection'
import { IntakeService } from './intake-service'
import { IntakeStore, type IntakeRecord } from './intake-store'
import { occurrenceId, RecurrenceKeeper } from './recurrence-keeper'
import { parseRecurrenceFile, RecurrenceStore } from './recurrence-store'

import { isItemsTabItem, isProposal, isScheduled, isWaitingForUser } from '../shared/intake/scheduled'

process.env.TZ = 'Asia/Taipei'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SOURCE = '11111111-2222-4333-8444-555555555555'
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
/** Monday 19 October 2026, 10:00. */
const MONDAY = local(2026, 10, 19, 10)
const WEDNESDAY_21 = local(2026, 10, 21, 21)
const iso = (ms: number): string => new Date(ms).toISOString()

const bases: string[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
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
  opened: string[]
  live: Set<string>
  propose: (fields: Record<string, unknown>) => Promise<IntakeRecord>
  /** The same as `propose`, returning the outcome whatever it is. */
  deliver: (fields: Record<string, unknown>) => ReturnType<HandoffService['deliverFile']>
  attach: (id: string) => void
  occurrences: () => IntakeRecord[]
  upcoming: () => IntakeRecord[]
  restart: () => World
}

function world(options: { maxPending?: number; base?: string; clock?: { now: number } } = {}): World {
  const base = options.base ?? fs.mkdtempSync(path.join(os.tmpdir(), 'recurrence-keeper-'))
  if (!options.base) bases.push(base)
  resetHandoffState()
  configureHandoff(base)
  const archive = path.join(base, 'intake')
  fs.mkdirSync(archive, { recursive: true })
  const clock = options.clock ?? { now: MONDAY }
  const store = new IntakeStore(path.join(base, 'intake.json'))
  store.load()
  const service = new IntakeService({ store, archiveRoot: archive, ...(options.maxPending ? { maxPending: options.maxPending } : {}) })
  const recurrences = new RecurrenceStore(path.join(base, 'handoff-recurrences.json'))
  recurrences.load()
  const folders = [
    { id: 'f2', name: 'beta', path: '/repos/beta' },
    { id: 'f3', name: 'gamma', path: '/repos/gamma' },
  ]
  const opened: string[] = []
  // A ticket an accept holds (simulated); the opener's own requests are asked of the opener, as in production —
  // where no ticket is issued for a handoff without a source, which is what these seeded proposals are.
  const live = new Set<string>()
  const openerRef: { current: HandoffOpener | null } = { current: null }
  const keeper = new RecurrenceKeeper({
    service,
    recurrences,
    candidates: () => folders,
    // As production: the opener's own record of what it asked to open, or a live ticket (simulated by `live`).
    opening: (adapter, id) => live.has(id) || (openerRef.current?.wasRequested(adapter, id) ?? false),
    changed: () => {},
    now: () => clock.now,
  })
  keeper.ensureAll()
  const opener = testOpener(
    service,
    () => folders,
    (_a, id) => opened.push(id),
    { now: () => clock.now, keeper },
  )
  openerRef.current = opener
  const handoff = new HandoffService({
    service,
    sourceOf: () => ({ folderId: 'f1', label: 'alpha' }),
    candidates: () => folders,
    agentEventsEnabled: () => true,
    onDelivered: () => opener.tick(),
    now: () => clock.now,
  })
  let n = 0
  const deliver = async (fields: Record<string, unknown>): ReturnType<HandoffService['deliverFile']> => {
    prepareOutbox(SOURCE)
    const target = path.join(outboxDir(SOURCE), `p${(n += 1)}.json`)
    fs.writeFileSync(target, JSON.stringify({ target: 'beta', title: 'weekly review', body: 'review the week', ...fields }))
    return handoff.deliverFile(fs.readFileSync(target, 'utf8'), target)
  }
  const occurrences = (): IntakeRecord[] =>
    store.list().filter((r) => r.content?.verified.recurrenceId !== undefined)
  return {
    base,
    clock,
    store,
    service,
    recurrences,
    keeper,
    opener,
    folders,
    opened,
    live,
    propose: async (fields) => {
      const outcome = await deliver(fields)
      assert.ok(outcome.ok && outcome.record, `proposal refused: ${outcome.code} ${outcome.detail ?? ''}`)
      return outcome.record
    },
    deliver,
    attach: (id) => {
      store.setState(HANDOFF_ADAPTER, id, 'accepted', `session-${id}`)
      live.delete(id)
    },
    occurrences,
    upcoming: () => occurrences().filter((r) => r.state === 'pending' && r.firedAt === undefined),
    restart: () => world({ ...options, base, clock }),
  }
}

const times = (records: IntakeRecord[]): number[] => records.map((r) => r.content?.verified.scheduledAt ?? 0).sort((a, b) => a - b)

describe('the recurrence store (D1)', () => {
  it('round-trips, drops an entry missing a required field, and reads a non-number as absent', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'recurrence-store-'))
    bases.push(base)
    const file = path.join(base, 'r.json')
    const store = new RecurrenceStore(file)
    store.load()
    const intake = {
      verified: { adapter: 'handoff', originKind: 'session', originId: 'f1', firstPartyBody: true },
      authored: { title: 't', body: 'b', actor: 'alpha', originLabel: 'alpha' },
    }
    store.put({ id: 'a', repeat: '0 9 * * *', intake, targetText: '/repos/beta', approvedAt: 1, until: 5 })
    const reread = new RecurrenceStore(file)
    reread.load()
    assert.deepEqual(reread.get('a'), store.get('a'))
    const parsed = parseRecurrenceFile(
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'b', repeat: '0 9 * * *', intake, targetText: '/x', approvedAt: 1, lastOccurrenceAt: 'soon' },
          { id: 'c', repeat: '0 9 * * *', intake, approvedAt: 1 },
        ],
      }),
    )
    assert.deepEqual(parsed?.map((r) => r.id), ['b'])
    assert.equal(parsed?.[0].lastOccurrenceAt, undefined)
  })

  it('an unknown version or a non-JSON file is unavailable, and is never written', async () => {
    for (const bytes of ['{"version":2,"entries":[]}', 'not json']) {
      const w = world()
      const file = path.join(w.base, 'handoff-recurrences.json')
      fs.writeFileSync(file, bytes)
      const r = w.restart()
      assert.equal(r.recurrences.available, false)
      const proposal = await r.propose({ repeat: '0 21 * * 3' })
      assert.deepEqual(r.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2'), { ok: false, reason: 'unavailable' })
      r.keeper.ensureAll()
      assert.equal(fs.readFileSync(file, 'utf8'), bytes)
      assert.deepEqual(r.keeper.listing(), { available: false, recurrences: [] })
    }
  })

  it('an unavailable store removes no occurrence', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    fs.writeFileSync(path.join(w.base, 'handoff-recurrences.json'), 'damaged')
    const r = w.restart()
    r.opener.tick()
    assert.equal(r.upcoming().length, 1)
  })
})

describe('approval (D4)', () => {
  it('opens nothing, settles the proposal without a session, and lists one occurrence in the approved folder', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    assert.deepEqual(w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f3'), { ok: true })
    const settled = w.store.get(HANDOFF_ADAPTER, proposal.id)
    assert.equal(settled?.state, 'accepted')
    assert.equal(settled?.sessionId, undefined)
    assert.notEqual(settled?.settledAt, undefined)
    assert.equal(w.opened.length, 0)
    const [occurrence] = w.upcoming()
    assert.equal(occurrence.content?.verified.scheduledAt, WEDNESDAY_21)
    assert.equal(occurrence.opensAt, WEDNESDAY_21)
    assert.equal(occurrence.content?.verified.targetFolderId, 'f3')
    assert.equal(occurrence.content?.verified.targetText, '/repos/gamma')
    assert.equal(occurrence.id, occurrenceId(proposal.id, WEDNESDAY_21))
    // Again, and every tick: nothing more.
    w.keeper.ensureAll()
    w.opener.tick()
    assert.equal(w.occurrences().length, 1)
    // Approving twice answers from the recurrence.
    assert.deepEqual(w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f3'), { ok: true })
    assert.equal(w.occurrences().length, 1)
  })

  it('a declined proposal never opens', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 * * * *' })
    w.store.setState(HANDOFF_ADAPTER, proposal.id, 'dismissed')
    w.clock.now = MONDAY + 30 * DAY
    w.opener.tick()
    assert.equal(w.opened.length, 0)
    assert.equal(w.occurrences().length, 0)
  })

  it('a recurrence survives a restart: one occurrence, at the same time', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    const r = w.restart()
    r.opener.tick()
    assert.deepEqual(times(r.upcoming()), [WEDNESDAY_21])
  })

  it('an approved proposal stays accepted without a session after a restart, and the same proposal again is a duplicate', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    const r = w.restart()
    const reloaded = r.store.get(HANDOFF_ADAPTER, proposal.id)
    assert.equal(reloaded?.state, 'accepted')
    assert.equal(reloaded?.sessionId, undefined)
    assert.notEqual(reloaded?.settledAt, undefined)
    // The same proposal from the same session, written again: the same id.
    const again = await r.deliver({ repeat: '0 21 * * 3' })
    assert.equal(again.code, 'DUPLICATE')
  })

  it('refuses a folder that is gone, and a proposal whose end has passed', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 21 * * 3', until: iso(WEDNESDAY_21 + HOUR) })
    assert.deepEqual(w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'nope'), { ok: false, reason: 'FOLDER_GONE' })
    w.clock.now = WEDNESDAY_21 + 2 * HOUR
    assert.deepEqual(w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2'), { ok: false, reason: 'ended' })
    assert.equal(w.store.get(HANDOFF_ADAPTER, proposal.id)?.state, 'pending')
  })

  it('a start two weeks ahead puts the first occurrence after it', async () => {
    const w = world()
    const start = local(2026, 11, 2, 0)
    const proposal = await w.propose({ repeat: '0 21 * * 3', at: iso(start) })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    assert.deepEqual(times(w.upcoming()), [local(2026, 11, 4, 21)])
  })

  it('a crash between writing the recurrence and settling the proposal: settled at the next start', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    // Undo the second write, as if the app stopped before it.
    w.store.setState(HANDOFF_ADAPTER, proposal.id, 'pending')
    const r = w.restart()
    assert.equal(r.store.get(HANDOFF_ADAPTER, proposal.id)?.state, 'accepted')
    assert.equal(r.upcoming().length, 1)
  })
})

describe('occurrences (D2)', () => {
  async function weekly(w: World): Promise<string> {
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    return proposal.id
  }

  it('an occurrence fires, and the next one exists before its session attaches', async () => {
    const w = world()
    await weekly(w)
    w.clock.now = WEDNESDAY_21
    w.opener.tick()
    assert.equal(w.opened.length, 1)
    // Opening in progress (ticket live, not attached): not waiting.
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 7 * DAY])
    w.attach(w.opened[0])
    w.opener.tick()
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 7 * DAY])
    // A prefill timeout after the next one exists does not pause it.
    w.store.setState(HANDOFF_ADAPTER, w.opened[0], 'pending')
    w.clock.now = WEDNESDAY_21 + 7 * DAY
    w.opener.tick()
    assert.equal(w.opened.length, 2)
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 14 * DAY])
  })

  it('three missed daily times open one session, and the next is after now', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 9 * * *' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    w.clock.now = local(2026, 10, 22, 10)
    const r = w.restart()
    r.opener.tick()
    r.opener.tick()
    assert.equal(r.opened.length, 1)
    assert.deepEqual(times(r.upcoming()), [local(2026, 10, 23, 9)])
  })

  it('Run now on Tuesday for Wednesday leaves the Wednesday after', async () => {
    const w = world()
    await weekly(w)
    w.clock.now = local(2026, 10, 20, 12)
    const [occurrence] = w.upcoming()
    assert.equal(w.opener.runNow(HANDOFF_ADAPTER, occurrence.id), true)
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 7 * DAY])
  })

  it('an ignore through the shared dismiss path (desktop or device) creates the next occurrence', async () => {
    const w = world()
    await weekly(w)
    const off = onIntakeDismissed((adapter, id) => w.keeper.afterDismiss(adapter, id))
    try {
      dismissIntake(w.store, HANDOFF_ADAPTER, w.upcoming()[0].id)
    } finally {
      off()
    }
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 7 * DAY])
  })

  it('Skip moves to the next time', async () => {
    const w = world()
    const id = await weekly(w)
    const [occurrence] = w.upcoming()
    w.store.setState(HANDOFF_ADAPTER, occurrence.id, 'dismissed')
    w.keeper.ensureNext(id)
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 7 * DAY])
    w.clock.now = WEDNESDAY_21 + MINUTE
    w.opener.tick()
    assert.equal(w.opened.length, 0)
  })

  it('a removed target fails one occurrence and the recurrence waits; dealing with it resumes after now', async () => {
    const w = world()
    const id = await weekly(w)
    w.folders.splice(0, 1)
    w.clock.now = WEDNESDAY_21
    w.opener.tick()
    assert.equal(w.opened.length, 0)
    assert.equal(w.upcoming().length, 0)
    const failed = w.occurrences().find((r) => r.state === 'pending')
    assert.ok(failed?.firedAt !== undefined)
    w.clock.now = WEDNESDAY_21 + 15 * DAY
    w.opener.tick()
    assert.equal(w.upcoming().length, 0)
    assert.deepEqual(w.keeper.listing().recurrences.map((r) => r.waiting), ['earlier'])
    w.store.setState(HANDOFF_ADAPTER, failed.id, 'dismissed')
    w.keeper.ensureNext(id)
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 21 * DAY])
  })

  it('accepting the waiting occurrence (its ticket now live) resumes the recurrence at once', async () => {
    const w = world()
    const id = await weekly(w)
    w.folders.splice(0, 1)
    w.clock.now = WEDNESDAY_21
    w.opener.tick()
    const failed = w.occurrences().find((r) => r.state === 'pending')
    assert.ok(failed)
    // What the accept handler does: issue the ticket, then ask the keeper.
    w.live.add(failed.id)
    w.keeper.ensureNext(id)
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 7 * DAY])
  })

  it('a crash after adding an occurrence and before recording it, restarted after its time: one, not two', async () => {
    const w = world()
    const id = await weekly(w)
    // Rewind the recurrence's record of it, as if the second write never happened.
    const recurrence = w.recurrences.get(id)
    assert.ok(recurrence)
    const { lastOccurrenceAt: _l, ...behind } = recurrence
    w.recurrences.put(behind)
    w.clock.now = WEDNESDAY_21 + 2 * DAY
    const r = w.restart()
    assert.equal(r.upcoming().length, 1)
    r.opener.tick()
    assert.equal(r.opened.length, 1)
    assert.deepEqual(times(r.upcoming()), [WEDNESDAY_21 + 7 * DAY])
  })

  it('two upcoming occurrences: the earliest is kept', async () => {
    const w = world()
    const id = await weekly(w)
    const [kept] = w.upcoming()
    const later = WEDNESDAY_21 + 7 * DAY
    w.store.add({ ...{ id: occurrenceId(id, later), verified: { ...kept.content!.verified, scheduledAt: later }, authored: kept.content!.authored, receivedAt: MONDAY } }, { opensAt: later })
    w.keeper.ensureAll()
    assert.deepEqual(w.upcoming().map((r) => r.id), [kept.id])
  })

  it('a full inbox creates nothing; once there is room, the next after that moment', async () => {
    const w = world({ maxPending: 2 })
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    // Fill the inbox: the proposal and one more pending item.
    await w.propose({ repeat: '0 9 * * 1' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    // The proposal settled, freeing its place; the occurrence took it — now full again.
    assert.equal(w.upcoming().length, 1)
    w.store.setState(HANDOFF_ADAPTER, w.upcoming()[0].id, 'dismissed')
    await w.propose({ repeat: '0 9 * * 2' })
    w.keeper.ensureNext(proposal.id)
    assert.equal(w.upcoming().length, 0)
    assert.deepEqual(w.keeper.listing().recurrences.map((r) => r.waiting), ['full'])
    w.clock.now = WEDNESDAY_21 + DAY
    w.store.list().filter((r) => r.state === 'pending').forEach((r) => w.store.setState(r.adapter, r.id, 'dismissed'))
    w.keeper.ensureNext(proposal.id)
    assert.deepEqual(times(w.upcoming()), [WEDNESDAY_21 + 7 * DAY])
  })

  it('until: a late occurrence before it still opens, and then the recurrence ends', async () => {
    const w = world()
    const friday = local(2026, 10, 23, 12)
    const proposal = await w.propose({ repeat: '0 9 * * *', until: iso(friday) })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    // Thursday: Tuesday's occurrence opens (Wednesday and Thursday coalesced), and Friday's is created.
    w.clock.now = local(2026, 10, 22, 10)
    w.opener.tick()
    w.opened.forEach((id) => w.attach(id))
    assert.equal(w.opened.length, 1)
    assert.deepEqual(times(w.upcoming()), [local(2026, 10, 23, 9)])
    // Closed through Friday: Friday's opens late, on Saturday, past the end; nothing after it.
    w.clock.now = local(2026, 10, 24, 10)
    const r = w.restart()
    r.opener.tick()
    r.opener.tick()
    assert.equal(r.opened.length, 1)
    assert.equal(r.upcoming().length, 0)
    assert.notEqual(r.recurrences.get(proposal.id)?.endedAt, undefined)
    assert.deepEqual(r.keeper.listing().recurrences, [])
  })

  it('stop removes the upcoming occurrence; nothing after a restart', async () => {
    const w = world()
    const id = await weekly(w)
    assert.equal(w.keeper.stop(id), true)
    assert.equal(w.upcoming().length, 0)
    w.clock.now = WEDNESDAY_21 + DAY
    const r = w.restart()
    r.opener.tick()
    assert.equal(r.opened.length, 0)
    assert.equal(r.upcoming().length, 0)
    assert.deepEqual(r.keeper.listing().recurrences, [])
  })
})

describe('the inbox projection (D6)', () => {
  const view = (w: World, id: string) =>
    listView(w.store.list(), { rules: [], fallbackFolderId: null }, new Set(['f2', 'f3']), w.clock.now).find((v) => v.id === id)

  it('a proposal: role, up to three next times from its start, its end, no scheduledAt; in the Schedules tab', async () => {
    const w = world()
    const until = local(2026, 11, 30)
    const proposal = await w.propose({ repeat: '0 21 * * 3', until: iso(until) })
    const v = view(w, proposal.id)
    assert.deepEqual(v?.recurrence, { role: 'proposal', repeat: '0 21 * * 3', until, next: [WEDNESDAY_21, WEDNESDAY_21 + 7 * DAY, WEDNESDAY_21 + 14 * DAY] })
    assert.equal(v?.scheduledAt, undefined)
    assert.ok(v && isWaitingForUser(v) && isProposal(v) && !isItemsTabItem(v))
    const short = await w.propose({ repeat: '0 21 * * 3', until: iso(WEDNESDAY_21 + DAY) })
    assert.deepEqual(view(w, short.id)?.recurrence?.next, [WEDNESDAY_21])
  })

  it('an upcoming occurrence carries its role and time; a fired pending one is an occurrence waiting for the user', async () => {
    const w = world()
    const proposal = await w.propose({ repeat: '0 21 * * 3' })
    w.keeper.approve(HANDOFF_ADAPTER, proposal.id, 'f2')
    const [upcoming] = w.upcoming()
    const v = view(w, upcoming.id)
    assert.deepEqual(v?.recurrence, { role: 'occurrence', repeat: '0 21 * * 3' })
    assert.equal(v?.scheduledAt, WEDNESDAY_21)
    assert.ok(v && isScheduled(v) && !isWaitingForUser(v))
    w.folders.splice(0, 1)
    w.clock.now = WEDNESDAY_21
    w.opener.tick()
    const failed = view(w, upcoming.id)
    assert.equal(failed?.scheduledAt, undefined)
    assert.equal(failed?.recurrence?.role, 'occurrence')
    assert.ok(failed && isWaitingForUser(failed) && !isProposal(failed) && isItemsTabItem(failed))
  })

  it('a one-off handoff carries no recurrence', async () => {
    const w = world()
    const outcome = await w.propose({})
    assert.equal(view(w, outcome.id)?.recurrence, undefined)
  })
})
