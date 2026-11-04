import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { MAX_BODY_LENGTH } from './intake-schema'
import { listView } from './intake-projection'
import { IntakeService } from './intake-service'
import { IntakeStore } from './intake-store'
import type { Answer } from './team-connection'
import { type InboxTeamPort, readOffer, TEAMMATE_ADAPTER, TeammateInbox, teammateIntakeId } from './teammate-inbox'
import type { MembershipStamp } from './teammate-outbox'

const A: MembershipStamp = { server: 'wss://team-a.example:8443', memberId: 'm_me' }

class FakeTeam implements InboxTeamPort {
  stamp: MembershipStamp | null = A
  name = 'Acme'
  isConnected = true
  ops = ['handoff.send', 'handoff.received', 'handoff.update', 'team.members']
  device: string | null = 'd_laptop'
  acks: { id: string; storedAtAck: string | null }[] = []
  /** Pending acknowledgements, answered by the test. */
  pending: { id: string; resolve: (a: Answer) => void; reject: (e: Error) => void }[] = []
  file = ''
  autoAnswer: ((id: string) => Answer) | null = () => ({ ok: true, r: {} })

  membership(): MembershipStamp | null {
    return this.stamp
  }
  teamName(): string {
    return this.name
  }
  operations(): string[] {
    return this.ops
  }
  connected(): boolean {
    return this.isConnected
  }
  deviceId(): string | null {
    return this.device
  }
  request(_m: string, p: Record<string, unknown>): Promise<Answer> {
    const id = p.id as string
    this.acks.push({ id, storedAtAck: fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : null })
    if (this.autoAnswer) return Promise.resolve(this.autoAnswer(id))
    return new Promise((resolve, reject) => this.pending.push({ id, resolve, reject }))
  }
  answer(a: Answer): void {
    const next = this.pending.shift()
    assert.ok(next, 'an acknowledgement is pending')
    next.resolve(a)
  }
  drop(): void {
    for (const p of this.pending.splice(0)) p.reject(new Error('connection ended'))
  }
}

const bases: string[] = []
const inboxes: TeammateInbox[] = []
after(() => {
  for (const i of inboxes) i.dispose()
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true })
})

function harness(options: { team?: FakeTeam; maxPending?: number; base?: string } = {}) {
  const base = options.base ?? fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-inbox-'))
  if (!options.base) bases.push(base)
  fs.mkdirSync(path.join(base, 'intake'), { recursive: true })
  const store = new IntakeStore(path.join(base, 'intake.json'))
  store.load()
  const service = new IntakeService({ store, archiveRoot: path.join(base, 'intake'), ...(options.maxPending ? { maxPending: options.maxPending } : {}) })
  const team = options.team ?? new FakeTeam()
  const file = path.join(base, 'team-incoming.json')
  team.file = file
  const arrivals: string[] = []
  service.onArrival((record) => arrivals.push(record.id))
  const make = (): TeammateInbox => {
    const inbox = new TeammateInbox({
      file,
      team,
      deliver: (contents, provenance) => service.deliver(contents, TEAMMATE_ADAPTER, provenance),
      hasRoom: () => service.hasRoom(),
      unreadable: (key) => service.reject('TEAMMATE_UNREADABLE', key, undefined, { adapter: TEAMMATE_ADAPTER }),
    })
    inboxes.push(inbox)
    inbox.start()
    return inbox
  }
  return { base, store, service, team, file, arrivals, inbox: make(), make }
}

function offer(id = 'h_0123abcd', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    from: { id: 'm_sam', handle: 'sam', displayName: 'Sam Lee' },
    payload: { enc: 'none', title: 'review the migration', body: 'From: alex\nplease check db/0042' },
    sentAt: Date.now() - 1000,
    expiresAt: Date.now() + 30 * 86_400_000,
    ...overrides,
  }
}

const intakeId = (id: string): string => teammateIntakeId(id) as string

describe('the intake id', () => {
  it('maps _ to . and accepts only the protocol rule', () => {
    assert.equal(teammateIntakeId('h_0123'), 'teammate:h.0123')
    assert.equal(teammateIntakeId('H-a_b'), 'teammate:H-a.b')
    for (const bad of ['', '-x', 'a.b', 'a b', 'x'.repeat(65)]) assert.equal(teammateIntakeId(bad), null, bad)
    assert.ok(Buffer.byteLength(teammateIntakeId('x'.repeat(64)) as string) <= 73)
  })
  it('an encoding other than none, or a bad sender handle, is unreadable', () => {
    assert.deepEqual(readOffer(offer('h_1', { payload: { enc: 'age', title: 't', body: 'b' } })), { unreadable: 'teammate:h.1' })
    assert.deepEqual(readOffer(offer('h_1', { from: { id: 'm', handle: 'Sam!', displayName: 'S' } })), { unreadable: 'teammate:h.1' })
    assert.ok('unreadable' in (readOffer(offer('-bad')) ?? {}))
  })
})

describe('receiving (task 4.3, one case per arrow of D9)', () => {
  it('stored before acknowledged, and not in the inbox until {}', async () => {
    const team = new FakeTeam()
    team.autoAnswer = null
    const h = harness({ team })
    h.inbox.incoming(offer())
    await h.inbox.idle()
    assert.equal(team.acks.length, 1)
    assert.match(team.acks[0].storedAtAck ?? '', /"state": "stored"/, 'stored durably before the acknowledgement')
    assert.equal(h.store.list().length, 0, 'hidden while unanswered')
    team.answer({ ok: true, r: {} })
    await h.inbox.idle()
    const record = h.store.get(TEAMMATE_ADAPTER, intakeId('h_0123abcd'))
    assert.equal(record?.state, 'pending')
    assert.deepEqual(h.arrivals, [intakeId('h_0123abcd')])
  })

  it('the item: the sender from the server, no folder, the third-party prompt, the handoff limit', async () => {
    const h = harness()
    h.inbox.incoming(offer('h_1', { payload: { enc: 'none', title: 't', body: 'x'.repeat(15_000) } }))
    await h.inbox.idle()
    const record = h.store.get(TEAMMATE_ADAPTER, intakeId('h_1'))
    const content = record?.content
    assert.ok(content)
    assert.equal(content.verified.adapter, TEAMMATE_ADAPTER)
    assert.equal(content.verified.originKind, 'teammate')
    assert.equal(content.verified.originId, 'sam')
    assert.equal(content.authored.actor, 'Sam Lee')
    assert.equal(content.authored.originLabel, 'Acme')
    assert.equal(content.verified.targetFolderId, undefined)
    assert.equal(content.verified.firstPartyBody, undefined)
    assert.equal(content.verified.handoffBodyLimit, true)
    assert.equal(content.authored.body.length, 15_000)
    assert.ok(15_000 > MAX_BODY_LENGTH)
  })

  it('the sender is the server’s, not the text’s', async () => {
    const h = harness()
    h.inbox.incoming(offer())
    await h.inbox.idle()
    const content = h.store.get(TEAMMATE_ADAPTER, intakeId('h_0123abcd'))?.content
    assert.equal(content?.verified.originId, 'sam')
    assert.doesNotMatch(`${content?.authored.actor} ${content?.verified.originId} ${content?.authored.originLabel}`, /alex/)
  })

  it('a repeat is acknowledged again and not shown twice', async () => {
    const h = harness()
    h.inbox.incoming(offer())
    await h.inbox.idle()
    h.inbox.incoming(offer())
    await h.inbox.idle()
    assert.equal(h.team.acks.length, 2)
    assert.equal(h.arrivals.length, 1)
  })

  it('a later offer with a changed display name does not change the item', async () => {
    const h = harness()
    h.inbox.incoming(offer())
    await h.inbox.idle()
    h.inbox.incoming(offer('h_0123abcd', { from: { id: 'm_sam', handle: 'sam', displayName: 'Samuel' } }))
    await h.inbox.idle()
    assert.equal(h.store.get(TEAMMATE_ADAPTER, intakeId('h_0123abcd'))?.content?.authored.actor, 'Sam Lee')
    assert.equal(h.service.notices().filter((n) => n.code === 'DUPLICATE').length, 0)
  })

  it('a reconnect re-acknowledges without a second acknowledgement in flight', async () => {
    const team = new FakeTeam()
    team.autoAnswer = null
    const h = harness({ team })
    h.inbox.incoming(offer())
    await h.inbox.idle()
    h.inbox.incoming(offer()) // in flight already: no second one
    h.inbox.connected()
    await h.inbox.idle()
    assert.equal(team.acks.length, 1)
    team.drop() // the connection ended before the answer
    await h.inbox.idle()
    h.inbox.connected()
    await h.inbox.idle()
    assert.equal(team.acks.length, 2, 'acknowledged again after reconnecting')
    team.answer({ ok: true, r: {} })
    await h.inbox.idle()
    assert.equal(h.arrivals.length, 1)
  })

  it('an acknowledgement lost before it was sent: the reconnect sends it, and the inbox holds it once', async () => {
    const team = new FakeTeam()
    team.isConnected = false // the connection dropped right after the event: the acknowledgement was never sent
    const h = harness({ team })
    h.inbox.incoming(offer())
    await h.inbox.idle()
    assert.equal(team.acks.length, 0)
    assert.equal(h.inbox.entries()[0].state, 'stored')
    team.isConnected = true
    h.inbox.connected()
    await h.inbox.idle()
    assert.equal(team.acks.length, 1)
    assert.equal(h.arrivals.length, 1)
  })

  for (const code of ['HANDOFF_DELIVERED_ELSEWHERE', 'HANDOFF_EXPIRED']) {
    it(`${code}: never shown, the id kept`, async () => {
      const team = new FakeTeam()
      team.autoAnswer = () => ({ ok: false, e: { code, message: '' } })
      const h = harness({ team })
      h.inbox.incoming(offer())
      await h.inbox.idle()
      assert.equal(h.store.list().length, 0)
      const [entry] = h.inbox.entries()
      assert.equal(entry.state, 'gone')
      assert.equal(entry.body, undefined, 'its content is removed')
      h.inbox.incoming(offer())
      await h.inbox.idle()
      assert.equal(h.store.list().length, 0, 'a repeat is recognised')
    })
  }

  it('HANDOFF_UNKNOWN: shown', async () => {
    const team = new FakeTeam()
    team.autoAnswer = () => ({ ok: false, e: { code: 'HANDOFF_UNKNOWN', message: '' } })
    const h = harness({ team })
    h.inbox.incoming(offer())
    await h.inbox.idle()
    assert.equal(h.arrivals.length, 1)
  })

  it('no handoff.received operation: shown', async () => {
    const team = new FakeTeam()
    team.ops = ['handoff.send']
    const h = harness({ team })
    h.inbox.incoming(offer())
    await h.inbox.idle()
    assert.equal(team.acks.length, 0)
    assert.equal(h.arrivals.length, 1)
  })

  it('{} to an entry not waiting for one changes nothing', async () => {
    const team = new FakeTeam()
    team.autoAnswer = null
    const h = harness({ team })
    h.inbox.incoming(offer())
    await h.inbox.idle()
    team.answer({ ok: true, r: {} })
    await h.inbox.idle()
    h.inbox.incoming(offer())
    await h.inbox.idle()
    team.answer({ ok: true, r: {} })
    await h.inbox.idle()
    assert.equal(h.arrivals.length, 1)
    assert.equal(h.inbox.entries()[0].state, 'shown')
  })

  it('a discarded credential shows stored entries, marked possibly elsewhere, and keeps acked ones', async () => {
    const team = new FakeTeam()
    team.autoAnswer = null
    const h = harness({ team, maxPending: 1 })
    // One acked that cannot enter (the inbox is full), one stored with its acknowledgement unanswered.
    await h.service.deliver(JSON.stringify({ id: 'x1', origin: { kind: 'k', id: 'i', label: 'l' }, title: 't', body: 'b' }), 'file')
    h.inbox.incoming(offer('h_acked'))
    await h.inbox.idle()
    // Full inbox: kept in memory, not stored. Make room so it is stored, then fill again.
    assert.equal(team.acks.length, 0)
    h.store.setState('file', 'x1', 'accepted')
    await h.inbox.tick()
    await h.inbox.idle()
    assert.equal(team.acks.length, 1)
    team.answer({ ok: true, r: {} })
    await h.inbox.idle()
    assert.equal(h.store.get(TEAMMATE_ADAPTER, intakeId('h_acked'))?.state, 'pending')
    h.inbox.incoming(offer('h_stored'))
    await h.inbox.idle()
    // The inbox is full again (the first teammate item is pending); h_stored waits in memory.
    h.store.setState(TEAMMATE_ADAPTER, intakeId('h_acked'), 'accepted')
    await h.inbox.tick()
    await h.inbox.idle()
    assert.equal(h.inbox.entries().find((e) => e.id === 'h_stored')?.state, 'stored')
    // Revoked now.
    team.stamp = null
    team.isConnected = false
    team.drop()
    h.inbox.credentialDiscarded()
    await h.inbox.idle()
    const record = h.store.get(TEAMMATE_ADAPTER, intakeId('h_stored'))
    assert.equal(record?.state, 'pending')
    assert.equal(record?.content?.verified.possiblyElsewhere, true)
    assert.equal(record?.content?.authored.originLabel, 'Acme', 'built from the stored entry, which keeps the team name')
  })

  it('a full inbox neither stores nor acknowledges, then does both once there is room', async () => {
    const h = harness({ maxPending: 1 })
    await h.service.deliver(JSON.stringify({ id: 'x1', origin: { kind: 'k', id: 'i', label: 'l' }, title: 't', body: 'b' }), 'file')
    h.inbox.incoming(offer())
    await h.inbox.idle()
    assert.equal(h.team.acks.length, 0)
    assert.equal(h.inbox.entries().length, 0)
    h.store.setState('file', 'x1', 'accepted')
    await h.inbox.tick()
    await h.inbox.idle()
    assert.equal(h.team.acks.length, 1)
    assert.equal(h.store.get(TEAMMATE_ADAPTER, intakeId('h_0123abcd'))?.state, 'pending')
  })

  it('an offer kept in memory is dropped when its connection ends', async () => {
    const h = harness({ maxPending: 1 })
    await h.service.deliver(JSON.stringify({ id: 'x1', origin: { kind: 'k', id: 'i', label: 'l' }, title: 't', body: 'b' }), 'file')
    h.inbox.incoming(offer())
    await h.inbox.idle()
    h.inbox.disconnected()
    h.store.setState('file', 'x1', 'accepted')
    await h.inbox.tick()
    await h.inbox.idle()
    assert.equal(h.team.acks.length, 0)
  })

  it('an acked entry left by a crash reaches the inbox at the next start, without a connection', async () => {
    const team = new FakeTeam()
    const h = harness({ team, maxPending: 1 })
    await h.service.deliver(JSON.stringify({ id: 'x1', origin: { kind: 'k', id: 'i', label: 'l' }, title: 't', body: 'b' }), 'file')
    // Stored and acknowledged while there was room... simulate by writing the store directly.
    fs.writeFileSync(
      h.file,
      JSON.stringify({
        version: 1,
        entries: [{ id: 'h_crash', state: 'acked', membership: A, expiresAt: Date.now() + 1e9, from: { id: 'm_sam', handle: 'sam', displayName: 'Sam Lee' }, team: 'Acme', title: 't', body: 'b', sentAt: 1 }],
      }),
    )
    h.store.setState('file', 'x1', 'accepted')
    team.isConnected = false
    team.stamp = A
    h.make()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.store.get(TEAMMATE_ADAPTER, intakeId('h_crash'))?.state, 'pending')
  })

  it('an unreadable offer leaves one trace and no acknowledgement', async () => {
    const h = harness()
    h.inbox.incoming(offer('h_enc', { payload: { enc: 'x25519', title: 't', body: 'b' } }))
    h.inbox.incoming(offer('h_enc', { payload: { enc: 'x25519', title: 't', body: 'b' } }))
    await h.inbox.idle()
    assert.equal(h.team.acks.length, 0)
    assert.equal(h.inbox.entries().length, 0)
    const traces = h.service.notices().filter((n) => n.code === 'TEAMMATE_UNREADABLE')
    assert.equal(traces.length, 1)
    assert.equal(traces[0].count, 1)
    assert.equal(traces[0].permanent, false)
  })
})

describe('which handoffs may be reported on (teammate-handoff-return D8, task 3.1)', () => {
  it('an answered acknowledgement, this device, the current membership and handoff.update: reportable, also once shown', async () => {
    const h = harness()
    h.inbox.incoming(offer('h_r1'))
    await h.inbox.idle()
    const entry = h.inbox.entries().find((e) => e.id === 'h_r1')
    assert.equal(entry?.state, 'shown')
    assert.equal(entry?.answered?.deviceId, 'd_laptop')
    assert.deepEqual(h.inbox.reportable('h_r1'), { membership: A, deviceId: 'd_laptop' })
    // Kept across a restart.
    assert.ok(h.make().reportable('h_r1'))
  })

  it('HANDOFF_UNKNOWN: shown, not reportable', async () => {
    const team = new FakeTeam()
    team.autoAnswer = () => ({ ok: false, e: { code: 'HANDOFF_UNKNOWN', message: 'x' } })
    const h = harness({ team })
    h.inbox.incoming(offer('h_r2'))
    await h.inbox.idle()
    assert.equal(h.store.get(TEAMMATE_ADAPTER, intakeId('h_r2'))?.state, 'pending')
    assert.equal(h.inbox.reportable('h_r2'), null)
  })

  it('no handoff.received: shown, not reportable', async () => {
    const team = new FakeTeam()
    team.ops = ['handoff.send', 'handoff.update', 'team.members']
    const h = harness({ team })
    h.inbox.incoming(offer('h_r3'))
    await h.inbox.idle()
    assert.equal(h.store.get(TEAMMATE_ADAPTER, intakeId('h_r3'))?.state, 'pending')
    assert.equal(h.inbox.reportable('h_r3'), null)
  })

  it('a discarded credential: shown possibly elsewhere, not reportable', async () => {
    const team = new FakeTeam()
    team.autoAnswer = null
    const h = harness({ team })
    h.inbox.incoming(offer('h_r4'))
    await h.inbox.idle()
    team.stamp = null
    h.inbox.credentialDiscarded()
    await h.inbox.idle()
    team.stamp = A
    assert.equal(h.inbox.reportable('h_r4'), null)
  })

  it('another device of the same member, or a server without handoff.update: not reportable', async () => {
    const h = harness()
    h.inbox.incoming(offer('h_r5'))
    await h.inbox.idle()
    h.team.device = 'd_new'
    assert.equal(h.inbox.reportable('h_r5'), null)
    h.team.device = 'd_laptop'
    h.team.ops = ['handoff.send', 'handoff.received']
    assert.equal(h.inbox.reportable('h_r5'), null)
  })
})

describe('the phone does not see which items may be declined (teammate-handoff-return D9)', () => {
  it('a teammate item in the projection a paired device receives carries no decline mark', async () => {
    const h = harness()
    h.inbox.incoming(offer('h_p1'))
    await h.inbox.idle()
    const [item] = listView(h.store.list(), { rules: [], fallbackFolderId: null }, new Set())
    assert.equal(item.adapter, TEAMMATE_ADAPTER)
    for (const key of ['declinable', 'reportable', 'answered']) assert.ok(!(key in item), key)
  })
})

