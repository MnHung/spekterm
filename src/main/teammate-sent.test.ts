import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import type { Answer } from './team-connection'
import type { MembershipStamp } from './teammate-outbox'
import { type SentNotice, type SentTeamPort, SENT_RETENTION_MS, TeammateSent } from './teammate-sent'

const A: MembershipStamp = { server: 'wss://team-a.example:8443', memberId: 'm_me' }
const B: MembershipStamp = { server: 'wss://team-b.example:8443', memberId: 'm_other' }
const ME = 'd_laptop'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-sent-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))
let n = 0

class FakeTeam implements SentTeamPort {
  stamp: MembershipStamp | null = A
  device: string | null = ME
  isConnected = true
  ops = ['handoff.send', 'handoff.received', 'handoff.update', 'handoff.sync', 'team.members']
  requests: Record<string, unknown>[] = []
  answers: ((p: Record<string, unknown>) => Promise<Answer>)[] = []
  membership(): MembershipStamp | null {
    return this.stamp
  }
  deviceId(): string | null {
    return this.device
  }
  operations(): string[] {
    return this.ops
  }
  connected(): boolean {
    return this.isConnected
  }
  async request(m: string, p: Record<string, unknown>): Promise<Answer> {
    assert.equal(m, 'handoff.sync')
    this.requests.push(p)
    const next = this.answers.shift()
    if (!next) return { ok: true, r: { records: [], more: false, latest: 0, reset: false } }
    return next(p)
  }
}

function rec(id: string, seq: number, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq,
    id,
    clientId: `c_${id}`,
    to: { id: 'm_sam', handle: 'sam', displayName: 'Sam Lee', removed: false },
    sentFrom: ME,
    status,
    sentAt: 1_000,
    expiresAt: 2_000,
    changedAt: Date.now() + seq,
    ...extra,
  }
}

function page(records: Record<string, unknown>[], more = false, reset = false): () => Promise<Answer> {
  return async () => ({ ok: true, r: { records, more, latest: 999, reset } })
}

function make(options: { file?: string; pending?: Set<string>; now?: () => number } = {}) {
  const team = new FakeTeam()
  const notices: SentNotice[] = []
  const file = options.file ?? path.join(root, `sent-${n++}.json`)
  const pending = options.pending ?? new Set<string>()
  const sent = new TeammateSent({
    file,
    team,
    onChange: () => {},
    notify: (notice) => notices.push(notice),
    pendingSend: (clientId) => pending.has(clientId),
    ...(options.now ? { now: options.now } : {}),
    setTimer: () => {},
  })
  sent.start()
  return { team, sent, notices, file, pending }
}

function send(sent: TeammateSent, extra: Partial<Parameters<TeammateSent['recordSend']>[0]> = {}): void {
  sent.recordSend({
    membership: A,
    clientId: 'c_h1',
    handoffId: 'h1',
    seq: 10,
    status: 'pending',
    sentAt: 1_000,
    expiresAt: 2_000,
    to: { id: 'm_sam', handle: 'sam', displayName: 'Sam Lee' },
    title: 'Fix billing export',
    sourceSessionId: 's1',
    ...extra,
  })
}

describe('teammate-sent: syncing (rules 1–3)', () => {
  it('pages from the stored cursor until more is false', async () => {
    const { team, sent } = make()
    team.answers = [page([rec('h1', 1, 'pending'), rec('h2', 2, 'pending')], true), page([rec('h3', 3, 'delivered')], false)]
    await sent.sync()
    assert.deepEqual(team.requests, [{ after: 0 }, { after: 2 }])
    assert.equal(sent.list().length, 3)
    assert.equal(sent.cursor()?.lastSeq, 3)
    await sent.sync()
    assert.deepEqual(team.requests.at(-1), { after: 3 })
  })

  it('stores a page and its cursor in one write: a restart resumes after the page', async () => {
    const first = make()
    first.team.answers = [page([rec('h1', 5, 'pending')], true), async () => { throw new Error('connection lost') }]
    await first.sent.sync()
    const second = make({ file: first.file })
    await second.sent.sync()
    assert.deepEqual(second.team.requests, [{ after: 5 }])
    assert.equal(second.sent.list().length, 1)
  })

  it('ignores a record whose seq is not greater (outside a reset)', async () => {
    const { team, sent } = make()
    team.answers = [page([rec('h1', 7, 'done', { reports: 1, payload: { enc: 'none', text: 'R2' } })])]
    await sent.sync()
    sent.status(rec('h1', 6, 'taken'))
    sent.status(rec('h1', 7, 'taken'))
    assert.equal(sent.list()[0].status, 'done')
  })

  it('during a reset replaces records with lower seqs and sets the cursor', async () => {
    const { team, sent } = make()
    team.answers = [page([rec('h1', 500, 'delivered')])]
    await sent.sync()
    assert.equal(sent.cursor()?.lastSeq, 500)
    team.answers = [page([rec('h1', 40, 'done', { reports: 1, payload: { enc: 'none', text: 'R' } })], false, true)]
    await sent.sync()
    assert.equal(sent.list()[0].status, 'done')
    assert.equal(sent.cursor()?.lastSeq, 40)
    await sent.sync()
    assert.deepEqual(team.requests.at(-1), { after: 40 })
  })

  it('finishes an interrupted reset from 0 by the stored flag, then marks what the server no longer has', async () => {
    const first = make()
    first.team.answers = [page([rec('h1', 1, 'pending'), rec('h2', 2, 'pending')])]
    await first.sent.sync()
    first.team.answers = [page([rec('h1', 1, 'delivered')], true, true), async () => { throw new Error('dropped') }]
    await first.sent.sync()
    assert.equal(first.sent.cursor()?.resetInProgress, true)

    const second = make({ file: first.file })
    // The answers of a sync from 0 do not say `reset`: the flag alone makes it the same reset.
    second.team.answers = [page([rec('h1', 1, 'delivered')], false, false)]
    await second.sent.sync()
    assert.deepEqual(second.team.requests, [{ after: 0 }])
    const byId = new Map(second.sent.list().map((v) => [v.id, v]))
    assert.equal(byId.get('h2')?.unknownToServer, true)
    assert.equal(byId.get('h1')?.unknownToServer, undefined)
    assert.equal(second.sent.cursor()?.resetInProgress, false)
    // A later record for the marked id clears the mark.
    second.sent.status(rec('h2', 9, 'taken'))
    assert.equal(new Map(second.sent.list().map((v) => [v.id, v])).get('h2')?.unknownToServer, undefined)
  })

  it('requests nothing from a server that does not offer handoff.sync', async () => {
    const { team, sent } = make()
    team.ops = ['handoff.send', 'handoff.received']
    await sent.sync()
    assert.equal(team.requests.length, 0)
    assert.equal(sent.supported(), false)
  })

  it('keeps a cursor per membership', async () => {
    const { team, sent } = make()
    team.answers = [page([rec('h1', 8, 'pending')])]
    await sent.sync()
    team.stamp = B
    await sent.sync()
    assert.deepEqual(team.requests.at(-1), { after: 0 })
    assert.equal(sent.list().length, 0)
    team.stamp = A
    await sent.sync()
    assert.deepEqual(team.requests.at(-1), { after: 8 })
  })
})

describe('teammate-sent: this device sends (design D3)', () => {
  it('records the title and source session, then a status record keeps them', () => {
    const { sent } = make()
    send(sent)
    sent.status(rec('h1', 11, 'delivered'))
    const [view] = sent.list()
    assert.equal(view.status, 'delivered')
    assert.equal(view.title, 'Fix billing export')
    assert.equal(sent.bySession().get('s1')?.[0].status, 'delivered')
  })

  it('a status record that came first keeps its state and gains the title', () => {
    const { sent } = make()
    sent.status(rec('h1', 12, 'delivered'))
    send(sent, { seq: 10 })
    const [view] = sent.list()
    assert.equal(view.status, 'delivered')
    assert.equal(view.title, 'Fix billing export')
  })

  it('a record with the same seq as the answer adds nothing', () => {
    const { sent, notices } = make()
    send(sent, { seq: 10 })
    sent.status(rec('h1', 10, 'pending', { to: { handle: 'sam', displayName: 'Changed', removed: false } }))
    assert.equal(sent.list()[0].to.displayName, 'Sam Lee')
    assert.equal(notices.length, 0)
  })

  it('a record from another device has no title and is attributed to no session', () => {
    const { sent } = make()
    sent.status(rec('h9', 3, 'done', { sentFrom: 'd_desktop', clientId: 'c_other' }))
    assert.equal(sent.list()[0].title, undefined)
    assert.equal(sent.bySession().size, 0)
  })
})

describe('teammate-sent: notifications (rule 5)', () => {
  it('notifies the sending device when a known handoff ends, once', () => {
    const { sent, notices } = make()
    send(sent)
    sent.status(rec('h1', 11, 'done', { reports: 1, payload: { enc: 'none', text: 'Exported' } }))
    sent.status(rec('h1', 11, 'done', { reports: 1, payload: { enc: 'none', text: 'Exported' } }))
    assert.equal(notices.length, 1)
    assert.equal(notices[0].status, 'done')
    assert.equal(notices[0].title, 'Fix billing export')
    assert.equal(notices[0].text, 'Exported')
  })

  it('a newer report notifies again', () => {
    const { sent, notices } = make()
    send(sent)
    sent.status(rec('h1', 11, 'done', { reports: 1, payload: { enc: 'none', text: 'R1' } }))
    sent.status(rec('h1', 12, 'done', { reports: 2, payload: { enc: 'none', text: 'R2' } }))
    assert.equal(notices.length, 2)
  })

  it('another device of the member does not notify', () => {
    const { sent, notices, team } = make()
    team.device = 'd_desktop'
    sent.status(rec('h1', 1, 'pending'))
    sent.status(rec('h1', 2, 'done', { reports: 1, payload: { enc: 'none', text: 'R' } }))
    assert.equal(notices.length, 0)
  })

  it('upgrading does not notify old results (no stored copy, no pending send)', async () => {
    const { team, sent, notices } = make()
    team.answers = [page([rec('h1', 1, 'done', { reports: 1, payload: { enc: 'none', text: 'R' } }), rec('h2', 2, 'expired')])]
    await sent.sync()
    assert.equal(sent.list().length, 2)
    assert.equal(notices.length, 0)
  })

  it('a send still waiting for its answer notifies without a stored copy', () => {
    const { sent, notices, pending } = make()
    pending.add('c_h1')
    sent.status(rec('h1', 5, 'declined', { payload: { enc: 'none', text: 'Not mine' } }))
    assert.equal(notices.length, 1)
  })

  it('a resend answered done notifies once', () => {
    const { sent, notices } = make()
    send(sent, { status: 'done', seq: 30 })
    sent.status(rec('h1', 30, 'done', { reports: 1 }))
    assert.equal(notices.length, 1)
  })

  it('a reset does not notify a restored older state', async () => {
    const { team, sent, notices } = make()
    send(sent)
    sent.status(rec('h1', 20, 'done', { reports: 3, payload: { enc: 'none', text: 'R3' } }))
    assert.equal(notices.length, 1)
    team.answers = [page([rec('h1', 4, 'done', { reports: 2, payload: { enc: 'none', text: 'R2' } })], false, true)]
    await sent.sync()
    assert.equal(notices.length, 1)
    assert.equal(sent.list()[0].reports, 2)
  })
})

describe('teammate-sent: the store', () => {
  it('prunes records 90 days after their last change', () => {
    let now = 10_000
    const first = make({ now: () => now })
    first.sent.status(rec('h1', 1, 'done', { changedAt: 10_000 }))
    now = 10_000 + SENT_RETENTION_MS + 1
    const second = make({ file: first.file, now: () => now })
    assert.equal(second.sent.list().length, 0)
  })

  it('sets a damaged file aside and reads it as empty', () => {
    const file = path.join(root, `damaged-${n++}.json`)
    fs.writeFileSync(file, '{ not json')
    const { sent } = make({ file })
    assert.equal(sent.loadIssue(), 'damaged')
    assert.equal(sent.list().length, 0)
  })
})

describe('teammate-sent: what the renderer gets (D4)', () => {
  it('no clientId, no sentFrom, no membership stamp', () => {
    const { sent } = make()
    send(sent)
    const [view] = sent.list()
    const keys = Object.keys(view)
    for (const hidden of ['clientId', 'sentFrom', 'membership', 'sourceSessionId', 'seq']) assert.ok(!keys.includes(hidden), hidden)
  })
})

