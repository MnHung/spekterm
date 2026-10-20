import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  buildDelivery,
  HANDOFF_ADAPTER,
  handoffIntakeId,
  MAX_SCHEDULE_AHEAD_DAYS,
  parseHandoffPayload,
  parseScheduledAt,
} from './handoff-delivery'
import { anyWindowReceives, HandoffOpener, whenAnnounced } from './handoff-opener'
import { testOpener } from './handoff-opener.testkit'
import { configureHandoff, outboxDir, prepareOutbox, resetHandoffState } from './handoff-outbox'
import { HandoffService } from './handoff-service'
import { TicketStore, ticketFor } from './handoff-ticket'
import { decideAccept } from './intake-accept'
import { listView } from './intake-projection'
import { isPermanentRejection } from './intake-rejection'
import { IntakeService, type DeliverOutcome } from './intake-service'
import { IntakeStore, parseIntakeFile, type IntakeRecord } from './intake-store'
import { isScheduled, isWaitingForUser } from '../shared/intake/scheduled'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const SOURCE = '11111111-2222-4333-8444-555555555555'

const bases: string[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})

describe('parseScheduledAt (scheduled-handoff, D2)', () => {
  const at = (s: string): ReturnType<typeof parseScheduledAt> => parseScheduledAt(s, NOW)

  it('absent stays absent', () => {
    assert.deepEqual(parseScheduledAt(undefined, NOW), { kind: 'absent' })
  })

  it('a future time with Z or an offset schedules it at that instant', () => {
    assert.deepEqual(at('2026-10-20T09:00:00Z'), { kind: 'scheduled', at: Date.parse('2026-10-20T09:00:00Z') })
    assert.deepEqual(at('2026-10-20T17:00+08:00'), { kind: 'scheduled', at: Date.parse('2026-10-20T09:00:00Z') })
  })

  it('refuses a time without an offset, a compact offset and a space separator', () => {
    for (const value of ['2026-10-20T09:00:00', '2026-10-20T09:00:00+0800', '2026-10-20 09:00:00Z']) {
      assert.equal(at(value).kind, 'invalid', value)
    }
  })

  it('refuses dates and times that do not exist, which Date.parse rolls over', () => {
    assert.ok(Number.isFinite(Date.parse('2026-02-30T10:00:00+08:00')), 'precondition: Date.parse accepts it')
    for (const value of ['2027-02-30T10:00:00+08:00', '2027-02-29T10:00:00Z', '2026-10-20T24:00:00Z', '2026-10-20T10:60Z', '2026-13-01T10:00Z']) {
      assert.equal(parseScheduledAt(value, NOW).kind, 'invalid', value)
    }
  })

  it('29 February exists in a leap year', () => {
    const leapNow = Date.parse('2028-02-20T00:00:00Z')
    assert.equal(parseScheduledAt('2028-02-29T10:00:00Z', leapNow).kind, 'scheduled')
  })

  it('a fraction of a second is accepted', () => {
    assert.equal(at('2026-10-20T09:00:00.250Z').kind, 'scheduled')
  })

  it('a past time, or exactly now, is absent: the handoff opens at once', () => {
    assert.deepEqual(at('2026-10-19T11:59:00Z'), { kind: 'absent' })
    assert.deepEqual(at('2026-10-19T12:00:00Z'), { kind: 'absent' })
  })

  it('exactly the bound is allowed, one minute past it is refused', () => {
    const bound = new Date(NOW + MAX_SCHEDULE_AHEAD_DAYS * DAY).toISOString()
    const past = new Date(NOW + MAX_SCHEDULE_AHEAD_DAYS * DAY + MINUTE).toISOString()
    assert.equal(at(bound).kind, 'scheduled')
    assert.equal(at(past).kind, 'invalid')
  })
})

describe('the payload and the identity', () => {
  it('reads at; a non-string is FIELD_TYPE', () => {
    const ok = parseHandoffPayload(JSON.stringify({ target: 'b', body: 'x', at: '2026-10-20T09:00Z' }))
    assert.equal(ok.ok && ok.value.at, '2026-10-20T09:00Z')
    const bad = parseHandoffPayload(JSON.stringify({ target: 'b', body: 'x', at: 5 }))
    assert.deepEqual(bad, { ok: false, reason: 'FIELD_TYPE', field: 'at' })
    const none = parseHandoffPayload(JSON.stringify({ target: 'b', body: 'x' }))
    assert.equal(none.ok && 'at' in none.value, false)
  })

  it('an unscheduled handoff keeps the id it had before scheduling existed', () => {
    const payload = { target: 'beta', title: 't', body: 'b' }
    // The digest of the three fields, as it was computed before `at` was read.
    const before = createHash('sha256').update(JSON.stringify(['beta', 't', 'b']), 'utf8').digest('hex').slice(0, 16)
    assert.equal(handoffIntakeId('s1', payload), `s1-${before}`)
    assert.equal(handoffIntakeId('s1', { ...payload, at: '2026-10-19T00:00Z' }), `s1-${before}`)
  })

  it('the same body at two times is two handoffs', () => {
    const payload = { target: 'beta', title: 't', body: 'b' }
    assert.notEqual(handoffIntakeId('s1', payload, NOW + DAY), handoffIntakeId('s1', payload, NOW + 2 * DAY))
    assert.notEqual(handoffIntakeId('s1', payload, NOW + DAY), handoffIntakeId('s1', payload))
  })

  it('SCHEDULE_INVALID is a permanent refusal', () => {
    assert.equal(isPermanentRejection({ code: 'SCHEDULE_INVALID', notify: true }), true)
  })
})

interface World {
  store: IntakeStore
  service: IntakeService
  handoff: HandoffService
  opener: HandoffOpener
  opened: { id: string; folderId: string }[]
  arrivals: string[]
  failures: string[]
  clock: { now: number }
  window: { receives: boolean }
  folders: { id: string; name: string; path: string }[]
  events: { on: boolean }
  file: string
  deliver: (payload: Record<string, unknown>, name?: string) => Promise<DeliverOutcome>
  reload: () => { store: IntakeStore; service: IntakeService; opener: HandoffOpener; opened: { id: string; folderId: string }[] }
}

function world(): World {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-schedule-'))
  bases.push(base)
  resetHandoffState()
  configureHandoff(base)
  const archive = path.join(base, 'intake')
  fs.mkdirSync(archive, { recursive: true })
  const file = path.join(base, 'intake.json')
  const store = new IntakeStore(file)
  const service = new IntakeService({ store, archiveRoot: archive })
  const opened: { id: string; folderId: string }[] = []
  const arrivals: string[] = []
  const failures: string[] = []
  const clock = { now: NOW }
  const window = { receives: true }
  const events = { on: true }
  const folders = [{ id: 'f2', name: 'beta', path: '/repos/beta' }]
  service.onArrival(whenAnnounced((record) => arrivals.push(record.id)))
  service.onFailure((failure) => failures.push(failure.code))
  const opener = testOpener(service, () => folders, (_a, id, folderId) => opened.push({ id, folderId }), {
    eventsEnabled: () => events.on,
    canReceive: () => window.receives,
    now: () => clock.now,
  })
  const handoff = new HandoffService({
    service,
    sourceOf: () => ({ folderId: 'f1', label: 'alpha' }),
    candidates: () => folders,
    agentEventsEnabled: () => events.on,
    onDelivered: () => opener.tick(),
  })
  let n = 0
  return {
    store,
    service,
    handoff,
    opener,
    opened,
    arrivals,
    failures,
    clock,
    window,
    folders,
    events,
    file,
    deliver: async (payload, name) => {
      prepareOutbox(SOURCE)
      const target = path.join(outboxDir(SOURCE), name ?? `h${(n += 1)}.json`)
      fs.writeFileSync(target, JSON.stringify(payload))
      return handoff.deliverFile(fs.readFileSync(target, 'utf8'), target)
    },
    reload: () => {
      const store2 = new IntakeStore(file)
      store2.load()
      const service2 = new IntakeService({ store: store2, archiveRoot: archive })
      const opened2: { id: string; folderId: string }[] = []
      const opener2 = testOpener(service2, () => folders, (_a, id, folderId) => opened2.push({ id, folderId }), {
        now: () => clock.now,
      })
      return { store: store2, service: service2, opener: opener2, opened: opened2 }
    },
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()
const good = { target: 'beta', title: 'later', body: 'finish the change' }

/** `Date.now()` is the read time inside `deliverFile`; these tests schedule relative to the real clock. */
const realSoon = (ms: number): string => iso(Date.now() + ms)

describe('records: the four fields (D1)', () => {
  it('a round trip keeps them; wrong types load as absent', async () => {
    const w = world()
    await w.deliver({ ...good, at: realSoon(DAY) })
    {
      const raw = JSON.parse(fs.readFileSync(w.file, 'utf8'))
      const entry = raw.entries[0]
      assert.equal(typeof entry.opensAt, 'number')
      assert.equal(typeof entry.content.verified.scheduledAt, 'number')
      assert.equal(entry.content.verified.targetText, 'beta')
      const kept = parseIntakeFile(JSON.stringify(raw))!.entries[0]
      assert.equal(kept.opensAt, entry.opensAt)
      assert.equal(kept.content?.verified.scheduledAt, entry.content.verified.scheduledAt)

      entry.opensAt = 'soon'
      entry.firedAt = null
      entry.content.verified.scheduledAt = 'tomorrow'
      entry.content.verified.targetText = 7
      const broken = parseIntakeFile(JSON.stringify(raw))!.entries[0]
      assert.equal(broken.opensAt, undefined)
      assert.equal(broken.firedAt, undefined)
      assert.equal(broken.content?.verified.scheduledAt, undefined)
      assert.equal(broken.content?.verified.targetText, undefined)
      assert.equal(broken.state, 'pending')
    }
  })

  it('a record without opensAt (from before this version) is never opened automatically', async () => {
    const w = world()
    w.window.receives = false
    await w.deliver(good)
    const raw = JSON.parse(fs.readFileSync(w.file, 'utf8'))
    delete raw.entries[0].opensAt
    fs.writeFileSync(w.file, JSON.stringify(raw))
    const r = w.reload()
    r.opener.tick()
    assert.equal(r.opened.length, 0)
    assert.equal(r.store.list()[0].state, 'pending')
  })
})

describe('markFired and one live ticket (D3)', () => {
  const record = (overrides: Partial<IntakeRecord> = {}): IntakeRecord => ({
    adapter: HANDOFF_ADAPTER,
    id: 'h1',
    state: 'pending',
    digest: 'd',
    opensAt: 1,
    content: {
      verified: { adapter: HANDOFF_ADAPTER, originKind: 'session', originId: 'f1', source: { sessionId: SOURCE, origin: { kind: 'global' } } },
      authored: { title: 't', body: 'b', actor: '', originLabel: '' },
      receivedAt: 1,
    },
    ...overrides,
  })

  it('issuing a ticket persists firedAt', async () => {
    const w = world()
    w.window.receives = false
    await w.deliver(good)
    const id = w.store.list()[0].id
    const fired: string[] = []
    const token = ticketFor(w.store.get(HANDOFF_ADAPTER, id), 'f2', new TicketStore(), (a, i) => {
      fired.push(i)
      w.store.markFired(a, i)
    })
    assert.ok(token)
    assert.deepEqual(fired, [id])
    const r = w.reload()
    assert.equal(typeof r.store.get(HANDOFF_ADAPTER, id)?.firedAt, 'number')
  })

  it('an accepted handoff whose session creation failed is not opened after a restart', async () => {
    const w = world()
    w.window.receives = false
    await w.deliver(good)
    const id = w.store.list()[0].id
    // The user's accept issues a ticket (and marks it); creation then fails, so no attach follows.
    ticketFor(w.store.get(HANDOFF_ADAPTER, id), 'f2', new TicketStore(), (a, i) => w.store.markFired(a, i))
    const r = w.reload()
    r.opener.tick()
    assert.equal(r.opened.length, 0)
    assert.equal(r.store.get(HANDOFF_ADAPTER, id)?.state, 'pending')
  })

  it('no second ticket while one is live; an accept in between is refused as opening', () => {
    const tickets = new TicketStore()
    const r = record()
    const first = ticketFor(r, 'f2', tickets)
    assert.ok(first)
    assert.equal(ticketFor(r, 'f2', tickets), undefined)
    const decision = decideAccept({ record: r, chosenFolderId: 'f2', knownFolderIds: new Set(['f2']), eventsEnabled: true, opening: tickets.isLive('handoff', 'h1') })
    assert.deepEqual(decision, { ok: false, reason: 'opening' })
    // Used to create the session, it is still being opened until attach.
    tickets.consume(first, 'f2', 'claude')
    assert.equal(tickets.isLive('handoff', 'h1'), true)
    tickets.release('handoff', 'h1')
    assert.equal(tickets.isLive('handoff', 'h1'), false)
  })

  it('a ticket that expires frees the record', () => {
    let now = 0
    const tickets = new TicketStore(() => now)
    ticketFor(record(), 'f2', tickets)
    now = 61_000
    assert.equal(tickets.isLive('handoff', 'h1'), false)
  })

  it('a record pending again after a prefill timeout is still accepted, and reuses its session', () => {
    const tickets = new TicketStore()
    const r = record({ firedAt: 5, sessionId: 'sess-1' })
    const decision = decideAccept({ record: r, chosenFolderId: 'f2', knownFolderIds: new Set(['f2']), eventsEnabled: true, opening: tickets.isLive('handoff', 'h1') })
    assert.deepEqual(decision, { ok: true, folderId: 'f2', existingSessionId: 'sess-1' })
  })
})

describe('the inbox projection (D7)', () => {
  it('a scheduled item carries scheduledAt and is not counted; an opened one is counted without it', async () => {
    const w = world()
    await w.deliver({ ...good, at: realSoon(DAY) })
    const routing = { rules: [], fallbackFolderId: null }
    const [view] = listView(w.store.list(), routing, new Set(['f2']))
    assert.equal(typeof view.scheduledAt, 'number')
    assert.equal(isScheduled(view), true)
    assert.equal(isWaitingForUser(view), false)

    w.store.markFired(view.adapter, view.id)
    const [fired] = listView(w.store.list(), routing, new Set(['f2']))
    assert.equal(fired.scheduledAt, undefined)
    assert.equal(isWaitingForUser(fired), true)
  })

  it('an accepted record whose time is still ahead does not carry scheduledAt', async () => {
    const w = world()
    await w.deliver({ ...good, at: realSoon(DAY) })
    const id = w.store.list()[0].id
    w.store.setState(HANDOFF_ADAPTER, id, 'accepted', 'sess')
    const [view] = listView(w.store.list(), { rules: [], fallbackFolderId: null }, new Set(['f2']))
    assert.equal(view.scheduledAt, undefined)
  })
})

describe('the opener (D3)', () => {
  it('a scheduled handoff is recorded and not opened; it opens once when due', async () => {
    const w = world()
    w.clock.now = Date.now()
    await w.deliver({ ...good, at: iso(w.clock.now + 2 * MINUTE) })
    assert.equal(w.opened.length, 0)
    w.opener.tick()
    assert.equal(w.opened.length, 0)
    w.clock.now += 2 * MINUTE
    w.opener.tick()
    w.opener.tick()
    assert.equal(w.opened.length, 1)
    assert.equal(w.opened[0].folderId, 'f2')
  })

  it('a fired record is never fired again, also by a new opener after a restart', async () => {
    const w = world()
    // An unscheduled handoff is due from its delivery time, read from the real clock: run the fake one ahead of it.
    w.clock.now = Date.now() + MINUTE
    await w.deliver(good)
    assert.equal(w.opened.length, 1)
    const r = w.reload()
    r.opener.tick()
    assert.equal(r.opened.length, 0)
  })

  it('a handoff read while no window can receive opens when one can', async () => {
    const w = world()
    w.clock.now = Date.now() + MINUTE
    w.window.receives = false
    await w.deliver(good)
    assert.equal(w.opened.length, 0)
    w.window.receives = true
    w.opener.tick()
    assert.equal(w.opened.length, 1)
  })

  it('a removed folder gives a visible failure, and the record stays pending with firedAt', async () => {
    const w = world()
    w.clock.now = Date.now()
    await w.deliver({ ...good, at: iso(w.clock.now + MINUTE) })
    w.folders.splice(0)
    w.clock.now += MINUTE
    w.opener.tick()
    const record = w.store.list()[0]
    assert.equal(w.opened.length, 0)
    assert.deepEqual(w.failures, ['TARGET_NOT_FOUND'])
    assert.equal(record.state, 'pending')
    assert.equal(typeof record.firedAt, 'number')
    w.clock.now += 10 * MINUTE
    w.folders.push({ id: 'f2', name: 'beta', path: '/repos/beta' })
    w.opener.tick()
    assert.equal(w.opened.length, 0, 'not retried')
  })

  it('a folder removed and added back (new id, same name) is still found', async () => {
    const w = world()
    w.clock.now = Date.now()
    await w.deliver({ ...good, at: iso(w.clock.now + MINUTE) })
    w.folders.splice(0, 1, { id: 'f9', name: 'beta', path: '/repos/beta' })
    w.clock.now += MINUTE
    w.opener.tick()
    assert.deepEqual(w.opened.map((o) => o.folderId), ['f9'])
  })

  it('agent events off when due: a non-notifying rejection, no session', async () => {
    const w = world()
    w.clock.now = Date.now()
    await w.deliver({ ...good, at: iso(w.clock.now + MINUTE) })
    w.events.on = false
    w.clock.now += MINUTE
    w.opener.tick()
    assert.equal(w.opened.length, 0)
    assert.deepEqual(w.failures, [])
    assert.ok(w.service.notices().some((n) => n.code === 'PREFILL_UNAVAILABLE'))
  })

  it('a cancelled record never fires', async () => {
    const w = world()
    w.clock.now = Date.now()
    await w.deliver({ ...good, at: iso(w.clock.now + MINUTE) })
    const id = w.store.list()[0].id
    w.store.setState(HANDOFF_ADAPTER, id, 'dismissed')
    w.clock.now += MINUTE
    w.opener.tick()
    assert.equal(w.opened.length, 0)
  })

  it('Run now opens a scheduled handoff at once, and only once', async () => {
    const w = world()
    await w.deliver({ ...good, at: realSoon(DAY) })
    const id = w.store.list()[0].id
    assert.equal(w.opener.runNow(HANDOFF_ADAPTER, id), true)
    assert.equal(w.opener.runNow(HANDOFF_ADAPTER, id), false)
    assert.equal(w.opened.length, 1)
  })

  it('an unknown target with a future time is refused when it is read', async () => {
    const w = world()
    const outcome = await w.deliver({ ...good, target: 'nowhere', at: realSoon(DAY) })
    assert.equal(outcome.code, 'TARGET_NOT_FOUND')
    assert.equal(w.store.list().length, 0)
  })

  it('a time that breaks the rules is refused as SCHEDULE_INVALID and nothing is recorded', async () => {
    const w = world()
    const outcome = await w.deliver({ ...good, at: '2026-10-20T09:00:00' })
    assert.equal(outcome.code, 'SCHEDULE_INVALID')
    assert.equal(outcome.consume, true)
    assert.equal(w.store.list().length, 0)
  })
})

describe('at start (D5)', () => {
  it('several due handoffs all open, oldest first', async () => {
    const w = world()
    w.clock.now = Date.now()
    await w.deliver({ ...good, body: 'second', at: iso(w.clock.now + 2 * MINUTE) })
    await w.deliver({ ...good, body: 'first', at: iso(w.clock.now + MINUTE) })
    w.clock.now += 3 * MINUTE
    w.opener.tick()
    const bodies = w.opened.map((o) => w.store.get(HANDOFF_ADAPTER, o.id)?.content?.authored.body)
    assert.deepEqual(bodies, ['first', 'second'])
  })

  it('a waiting scheduled handoff is neither opened nor announced at start', async () => {
    const w = world()
    w.window.receives = false
    await w.deliver({ ...good, at: realSoon(DAY) })
    const r = w.reload()
    const announced: string[] = []
    r.service.onArrival(whenAnnounced((record) => announced.push(record.id)))
    r.opener.tick()
    assert.equal(r.opened.length, 0)
    assert.deepEqual(announced, [])
  })
})

describe('a window can receive (D3)', () => {
  it('needs one window that both lists the inbox and has restored, in either order', async () => {
    const listing = new Set<number>()
    const restored = new Set<number>()
    const w = world()
    w.window.receives = false
    await w.deliver(good)
    const opener = testOpener(w.service, () => w.folders, (_a, id, folderId) => w.opened.push({ id, folderId }), {
      canReceive: () => anyWindowReceives([...listing], (id) => restored.has(id)),
    })
    // A sender whose gate is closed, and a restored window that does not list: nothing.
    listing.add(1)
    opener.tick()
    restored.add(2)
    opener.tick()
    assert.equal(w.opened.length, 0)
    // Window 1 restores (gate first for 2 would be the other order): it fires at once.
    restored.add(1)
    opener.tick()
    assert.equal(w.opened.length, 1)
  })

  it('list first, then gate, also fires', () => {
    assert.equal(anyWindowReceives([3], (id) => id === 3), true)
    assert.equal(anyWindowReceives([], () => true), false)
  })
})

describe('arrival when it opens (D4)', () => {
  it('scheduling announces nothing; the opener announces it once; Run now once', async () => {
    const w = world()
    w.clock.now = Date.now()
    await w.deliver({ ...good, at: iso(w.clock.now + MINUTE) })
    assert.deepEqual(w.arrivals, [])
    w.clock.now += MINUTE
    w.opener.tick()
    w.opener.tick()
    assert.equal(w.arrivals.length, 1)

    await w.deliver({ ...good, body: 'second', at: realSoon(DAY) })
    assert.equal(w.arrivals.length, 1)
    const second = w.store.list().find((r) => r.content?.authored.body === 'second')!
    w.opener.runNow(HANDOFF_ADAPTER, second.id)
    assert.equal(w.arrivals.length, 2)
  })

  it('an unscheduled handoff is announced on delivery, and not again when it opens', async () => {
    const w = world()
    w.clock.now = Date.now() + MINUTE
    w.window.receives = false
    await w.deliver(good)
    assert.equal(w.arrivals.length, 1)
    w.window.receives = true
    w.opener.tick()
    assert.equal(w.opened.length, 1)
    assert.equal(w.arrivals.length, 1)
  })

  it('buildDelivery keeps the target text and the schedule', () => {
    const { provenance } = buildDelivery({
      sessionId: SOURCE,
      payload: { target: ' beta ', title: 't', body: 'b' },
      contents: '{}',
      originId: 'f1',
      originLabel: 'alpha',
      targetFolderId: 'f2',
      scheduledAt: NOW + DAY,
    })
    assert.equal(provenance.targetText, ' beta ')
    assert.equal(provenance.scheduledAt, NOW + DAY)
    assert.equal(provenance.autoOpen, true)
  })
})
