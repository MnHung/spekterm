import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import type { Answer } from './team-connection'
import type { MembershipStamp } from './teammate-outbox'
import { declineTeammate, merge, type ReportStamp, type ReturnTeamPort, type StoppedReports, TeammateReturn } from './teammate-return'

const A: MembershipStamp = { server: 'wss://team.example', memberId: 'm_me' }
const STAMP: ReportStamp = { ...A, deviceId: 'd_laptop' }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-return-'))
const instances: TeammateReturn[] = []
after(() => {
  for (const i of instances) i.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})
let n = 0

class FakeTeam implements ReturnTeamPort {
  stamp: MembershipStamp | null = A
  device: string | null = 'd_laptop'
  isConnected = true
  requests: { m: string; p: Record<string, unknown>; fileAtRequest: string }[] = []
  /** Scripted answers; past the end, `{ status }` echoing the report. A function may throw (a lost answer). */
  answers: ((p: Record<string, unknown>) => Promise<Answer>)[] = []
  file = ''
  membership(): MembershipStamp | null {
    return this.stamp
  }
  deviceId(): string | null {
    return this.device
  }
  connected(): boolean {
    return this.isConnected
  }
  request(m: string, p: Record<string, unknown>): Promise<Answer> {
    this.requests.push({ m, p, fileAtRequest: fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '' })
    const next = this.answers.shift()
    if (next) return next(p)
    return Promise.resolve({ ok: true, r: m === 'handoff.update' ? { status: p.status } : {} })
  }
}

const fail = (code: string): (() => Promise<Answer>) => () => Promise.resolve({ ok: false, e: { code, message: code } })
const lost = (): Promise<Answer> => Promise.reject(new Error('connection ended'))

function make(options: { team?: FakeTeam; file?: string; sessions?: Set<string>; now?: () => number } = {}) {
  const team = options.team ?? new FakeTeam()
  const file = options.file ?? path.join(root, `return-${n++}.json`)
  team.file = file
  const stops: StoppedReports[] = []
  let changes = 0
  const sessions = options.sessions ?? new Set(['s1'])
  const ret = new TeammateReturn({
    file,
    team,
    stopped: (stop) => stops.push(stop),
    onChange: () => changes++,
    sessionExists: (id) => sessions.has(id),
    ...(options.now ? { now: options.now } : {}),
  })
  instances.push(ret)
  ret.start()
  return { team, ret, file, stops, changes: () => changes, sessions }
}

function linked(h: ReturnType<typeof make>, id = 'h1'): void {
  h.ret.link({ handoffId: id, sessionId: 's1', stamp: STAMP, title: 'Fix billing export', senderName: 'Sam Lee' })
}

const updates = (team: FakeTeam) => team.requests.filter((r) => r.m === 'handoff.update').map((r) => r.p)

describe('teammate-return: sending (receiving rules 1–3)', () => {
  it('sends taken, then done with the report, in order', async () => {
    const h = make()
    linked(h)
    h.ret.queue('h1', { status: 'taken' })
    await h.ret.idle()
    h.ret.queue('h1', { status: 'done', text: 'Exported' })
    await h.ret.idle()
    assert.deepEqual(updates(h.team), [
      { id: 'h1', status: 'taken' },
      { id: 'h1', status: 'done', payload: { enc: 'none', text: 'Exported' } },
    ])
    assert.equal(h.ret.entries()[0].queue.length, 0)
  })

  it('marks attempted on disk before the request reaches the socket', async () => {
    const h = make()
    linked(h)
    h.ret.queue('h1', { status: 'done', text: 'R' })
    await h.ret.idle()
    assert.match(h.team.requests[0].fileAtRequest, /"attempted": true/)
  })

  it('one at a time: a report made while one is in flight waits for its answer', async () => {
    const h = make()
    linked(h)
    let release: (a: Answer) => void = () => {}
    h.team.answers = [() => new Promise((resolve) => (release = resolve))]
    h.ret.queue('h1', { status: 'taken' })
    await new Promise((resolve) => setImmediate(resolve))
    h.ret.queue('h1', { status: 'done', text: 'R' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(updates(h.team).length, 1)
    release({ ok: true, r: { status: 'taken' } })
    await h.ret.idle()
    assert.deepEqual(updates(h.team).map((p) => p.status), ['taken', 'done'])
  })

  it('a lost answer: the same report again before a later one, also after a restart', async () => {
    const h = make()
    linked(h)
    h.team.answers = [lost]
    h.ret.queue('h1', { status: 'done', text: 'S1' })
    await h.ret.idle()
    h.ret.queue('h1', { status: 'done', text: 'S2' })
    await h.ret.idle()
    // Not sent yet: the connection was gone. Now restart and reconnect.
    const again = make({ team: h.team, file: h.file })
    again.ret.connected()
    await again.ret.idle()
    assert.deepEqual(updates(h.team).map((p) => (p.payload as { text: string }).text), ['S1', 'S1', 'S2'])
  })

  it('merges reports never attempted: a newer done replaces an older one, taken is dropped behind done', () => {
    assert.deepEqual(merge([{ status: 'taken' }, { status: 'done', text: 'a' }], { status: 'done', text: 'b' }), [{ status: 'done', text: 'b' }])
    assert.deepEqual(merge([{ status: 'done', text: 'a', attempted: true }], { status: 'done', text: 'b' }), [
      { status: 'done', text: 'a', attempted: true },
      { status: 'done', text: 'b' },
    ])
    assert.deepEqual(merge([], { status: 'taken' }, { status: 'done', text: 'x' }), [])
    assert.deepEqual(merge([{ status: 'taken' }], { status: 'declined', text: 'no' }), [{ status: 'declined', text: 'no' }])
  })

  it('HANDOFF_NOT_DELIVERED: acknowledged again, then the same report; a second one backs off', async () => {
    const h = make()
    linked(h)
    h.team.answers = [fail('HANDOFF_NOT_DELIVERED')]
    h.ret.queue('h1', { status: 'done', text: 'R' })
    await h.ret.idle()
    assert.deepEqual(h.team.requests.map((r) => r.m), ['handoff.update', 'handoff.received', 'handoff.update'])
    assert.equal(h.ret.entries()[0].queue.length, 0)

    const h2 = make()
    linked(h2)
    h2.team.answers = [fail('HANDOFF_NOT_DELIVERED'), () => Promise.resolve({ ok: true, r: {} }), fail('HANDOFF_NOT_DELIVERED')]
    h2.ret.queue('h1', { status: 'done', text: 'R' })
    await h2.ret.idle()
    assert.equal(h2.ret.entries()[0].retryAt !== undefined, true)
  })

  it('INTERNAL retries after a backoff with the same report', async () => {
    let now = 1_000_000
    const h = make({ now: () => now })
    linked(h)
    h.team.answers = [fail('INTERNAL')]
    h.ret.queue('h1', { status: 'done', text: 'R' })
    await h.ret.idle()
    assert.equal(updates(h.team).length, 1)
    h.ret.tick()
    await h.ret.idle()
    assert.equal(updates(h.team).length, 1, 'not before retryAt')
    now += 5_001
    h.ret.tick()
    await h.ret.idle()
    assert.equal(updates(h.team).length, 2)
    assert.deepEqual(updates(h.team)[1], updates(h.team)[0])
  })

  it('nothing is sent while disconnected; the next connected sends it', async () => {
    const h = make()
    h.team.isConnected = false
    linked(h)
    h.ret.queue('h1', { status: 'taken' })
    await h.ret.idle()
    assert.equal(h.team.requests.length, 0)
    h.team.isConnected = true
    h.ret.connected()
    await h.ret.idle()
    assert.equal(updates(h.team).length, 1)
  })
})

describe('teammate-return: stopping (rule 5)', () => {
  for (const code of ['HANDOFF_FINISHED', 'HANDOFF_EXPIRED', 'HANDOFF_DELIVERED_ELSEWHERE', 'HANDOFF_UNKNOWN', 'TOO_MANY_REPORTS', 'BAD_PARAMS', 'UNKNOWN_OPERATION']) {
    it(`${code} stops reporting, says so once, and refuses later reports`, async () => {
      const h = make()
      linked(h)
      h.team.answers = [fail(code)]
      h.ret.queue('h1', { status: 'done', text: 'R' })
      await h.ret.idle()
      assert.equal(h.ret.state('h1'), 'stopped')
      assert.equal(h.stops.length, 1)
      assert.equal(h.stops[0].code, code)
      assert.equal(h.stops[0].title, 'Fix billing export')
      assert.equal(h.ret.queue('h1', { status: 'done', text: 'R2' }), 'stopped')
      assert.equal(updates(h.team).length, 1)
    })
  }

  it('an answered decline is final: later reports are refused, not sent', async () => {
    const h = make()
    h.ret.queue('h1', { status: 'declined', text: 'Not mine' }, { stamp: STAMP, title: 'T', senderName: 'Sam' })
    await h.ret.idle()
    assert.equal(h.ret.state('h1'), 'final')
    assert.equal(h.ret.queue('h1', { status: 'done', text: 'R' }), 'stopped')
    assert.equal(updates(h.team).length, 1)
    assert.equal(h.stops.length, 0)
  })

  it('a membership or device change stops every entry of the old stamp, queued reports or not', async () => {
    const h = make()
    h.team.isConnected = false
    linked(h, 'h1')
    linked(h, 'h2')
    h.ret.queue('h1', { status: 'done', text: 'R' })
    h.team.device = 'd_new'
    h.ret.membershipChanged()
    assert.equal(h.ret.state('h1'), 'stopped')
    assert.equal(h.ret.state('h2'), 'stopped')
    assert.equal(h.stops.length, 1, 'a trace only where reports were dropped')
    assert.equal(h.stops[0].handoffId, 'h1')
  })

  it('a report under a stale stamp is stopped at once, not queued', () => {
    const h = make()
    h.team.isConnected = false
    linked(h)
    h.team.stamp = null
    assert.equal(h.ret.queue('h1', { status: 'done', text: 'R' }), 'stopped')
  })
})

describe('teammate-return: the store', () => {
  it('prunes an entry whose session is gone and whose queue is empty', () => {
    const sessions = new Set(['s1'])
    const h = make({ sessions })
    linked(h)
    sessions.delete('s1')
    h.ret.tick()
    assert.equal(h.ret.entries().length, 0)
  })

  it('keeps a stopped state across a restart', async () => {
    const h = make()
    linked(h)
    h.team.answers = [fail('TOO_MANY_REPORTS')]
    h.ret.queue('h1', { status: 'done', text: 'R' })
    await h.ret.idle()
    const again = make({ team: h.team, file: h.file })
    assert.equal(again.ret.state('h1'), 'stopped')
  })
})

describe('teammate-return: declining (D9)', () => {
  const reportable = { membership: A, deviceId: 'd_laptop' }
  const base = { handoffId: 'h1', reportable, title: 'T', senderName: 'Sam' }

  it('queues declined with the normalized reason; an empty one is no reason', async () => {
    const h = make()
    assert.deepEqual(declineTeammate({ ...base, returns: h.ret, reason: '  Not my area\u200b  ' }), { ok: true })
    await h.ret.idle()
    assert.deepEqual(updates(h.team)[0], { id: 'h1', status: 'declined', payload: { enc: 'none', text: 'Not my area' } })
    const h2 = make()
    declineTeammate({ ...base, returns: h2.ret, reason: '   ' })
    await h2.ret.idle()
    assert.deepEqual(updates(h2.team)[0], { id: 'h1', status: 'declined' })
  })

  it('refuses a reason over 500 after normalization, and a handoff that cannot be reported on', () => {
    const h = make()
    assert.deepEqual(declineTeammate({ ...base, returns: h.ret, reason: 'x'.repeat(501) }), { ok: false, reason: 'TOO_LONG' })
    // Invisible characters are removed first: 500 visible plus some zero-width ones fit.
    assert.deepEqual(declineTeammate({ ...base, returns: h.ret, reason: `${'x'.repeat(500)}\u200b\u200b` }), { ok: true })
    assert.deepEqual(declineTeammate({ ...base, returns: make().ret, reportable: null, reason: '' }), { ok: false, reason: 'unknown' })
  })
})

