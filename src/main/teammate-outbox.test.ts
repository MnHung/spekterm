import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { isFirstPartyBody } from './intake-context'
import { parseHandoffPayload, TEAMMATE_NOT_SCHEDULABLE } from './handoff-delivery'
import { clearOutbox, configureHandoff, outboxDir, prepareOutbox, receiptsDir, resetHandoffState } from './handoff-outbox'
import { receiptFor, type Receipt, writeReceipt } from './handoff-receipt'
import { HandoffService } from './handoff-service'
import { isPermanentRejection } from './intake-rejection'
import { MAX_BODY_LENGTH, MAX_FIRST_PARTY_BODY_LENGTH, MAX_TEAMMATE_BODY_LENGTH, parseIntake, SERVER_BODY_LIMIT } from './intake-schema'
import { IntakeService } from './intake-service'
import { rescanLog, rescanOnce, silentWatcher } from './intake-source.testkit'
import { IntakeStore } from './intake-store'
import type { Answer } from './team-connection'
import type { TeamMember } from './team-store'
import type { SendRecord } from './teammate-sent'
import { MAX_OUTGOING_WAITING, type MembershipStamp, type OutgoingView, type TeamPort, TeammateOutbox, toWellFormed } from './teammate-outbox'

const A: MembershipStamp = { server: 'wss://team-a.example:8443', memberId: 'm_me' }
const B: MembershipStamp = { server: 'wss://team-b.example:8443', memberId: 'm_me_b' }

class FakeTeam implements TeamPort {
  on = true
  stamp: MembershipStamp | null = A
  me = 'me'
  list: TeamMember[] = [
    { id: 'm_me', handle: 'me', displayName: 'Me' },
    { id: 'm_sam', handle: 'sam', displayName: 'Sam Lee', deviceCount: 1 },
  ]
  /** What a refetch finds (null: the fetch failed). */
  fetched: TeamMember[] | null = null
  refetches = 0
  isConnected = true
  ops = ['handoff.send', 'handoff.received', 'team.members']
  requests: { m: string; p: Record<string, unknown>; fileAtRequest?: string }[] = []
  /** Answers in order; past the end, `ok`. A function may throw (a lost answer) or never resolve. */
  answers: ((p: Record<string, unknown>) => Promise<Answer>)[] = []
  file = ''

  enabled(): boolean {
    return this.on
  }
  membership(): MembershipStamp | null {
    return this.stamp
  }
  self(): string | null {
    return this.stamp ? this.me : null
  }
  members(): TeamMember[] {
    return this.list
  }
  connected(): boolean {
    return this.isConnected
  }
  operations(): string[] {
    return this.ops
  }
  async refreshMembers(): Promise<TeamMember[] | null> {
    this.refetches++
    if (this.fetched) this.list = this.fetched
    return this.fetched
  }
  request(m: string, p: Record<string, unknown>): Promise<Answer> {
    this.requests.push({ m, p, ...(this.file && fs.existsSync(this.file) ? { fileAtRequest: fs.readFileSync(this.file, 'utf8') } : {}) })
    const next = this.answers.shift()
    if (next) return next(p)
    return Promise.resolve(ok(p))
  }
}

function ok(_p: Record<string, unknown>, deviceCount = 1): Answer {
  return {
    ok: true,
    r: { handoff: { id: 'h_0123', status: 'pending', sentAt: 1, expiresAt: 2 }, recipient: { id: 'm_sam', handle: 'sam', displayName: 'Sam Lee', deviceCount }, duplicate: false },
  }
}

function fail(code: string, detail?: Record<string, unknown>): () => Promise<Answer> {
  return () => Promise.resolve({ ok: false, e: { code, message: code, ...(detail ? { detail } : {}) } })
}

const lost = (): Promise<Answer> => Promise.reject(new Error('connection ended'))

const SESSION = '11111111-2222-4333-8444-555555555555'
const bases: string[] = []
const outboxes: TeammateOutbox[] = []
after(() => {
  for (const o of outboxes) o.dispose()
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true })
})

interface Harness {
  base: string
  team: FakeTeam
  service: IntakeService
  store: IntakeStore
  outbox: TeammateOutbox
  handoff: HandoffService
  arrivals: OutgoingView[]
  refusedLater: string[]
  /** `recordSend` calls, each with the outgoing file as it was at the call. */
  recorded: (SendRecord & { outgoingAtCall: string })[]
  now: { value: number }
  /** Writes a delivery, reads it the way the drop point does, and writes its receipt. */
  deliver: (name: string, payload: unknown) => Promise<{ outcome: Awaited<ReturnType<HandoffService['deliverFile']>>; file: string }>
  receipt: (name: string) => Receipt | null
  restart: () => TeammateOutbox
}

function harness(options: { team?: FakeTeam; base?: string } = {}): Harness {
  const base = options.base ?? fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-outbox-'))
  if (!options.base) bases.push(base)
  resetHandoffState()
  configureHandoff(base)
  fs.mkdirSync(path.join(base, 'intake'), { recursive: true })
  const store = new IntakeStore(path.join(base, 'intake.json'))
  const service = new IntakeService({ store, archiveRoot: path.join(base, 'intake') })
  const team = options.team ?? new FakeTeam()
  const file = path.join(base, 'team-outgoing.json')
  team.file = file
  const arrivals: OutgoingView[] = []
  const refusedLater: string[] = []
  const recorded: Harness['recorded'] = []
  const now = { value: Date.UTC(2026, 10, 3, 9, 0, 0) }
  const make = (): TeammateOutbox => {
    const outbox = new TeammateOutbox({
      file,
      team,
      receiptsDir,
      reject: (code, label, detail, failure) => service.reject(code, label, detail, { adapter: 'handoff', ...failure }),
      refusedLater: (code) => refusedLater.push(code),
      onChange: () => {},
      onArrival: (item) => arrivals.push(item),
      recordSend: (send) => recorded.push({ ...send, outgoingAtCall: fs.readFileSync(file, 'utf8') }),
      now: () => now.value,
    })
    outboxes.push(outbox)
    outbox.start()
    return outbox
  }
  const outbox = make()
  const handoff = new HandoffService({
    service,
    sourceOf: () => ({ folderId: 'f1', label: 'alpha', title: 'fix the build' }),
    candidates: () => [{ id: 'f2', name: 'beta', path: '/repos/beta' }],
    agentEventsEnabled: () => true,
    onDelivered: () => {},
    teammates: { read: (input) => h.outbox.read(input), hasRoom: () => h.outbox.hasRoom() },
  })
  const h: Harness = {
    base,
    team,
    service,
    store,
    outbox,
    handoff,
    arrivals,
    refusedLater,
    recorded,
    now,
    async deliver(name, payload) {
      prepareOutbox(SESSION)
      const target = path.join(outboxDir(SESSION), name)
      fs.writeFileSync(target, typeof payload === 'string' ? payload : JSON.stringify(payload))
      const outcome = await handoff.deliverFile(fs.readFileSync(target, 'utf8'), target)
      writeReceipt(receiptsDir(SESSION), receiptFor(target, outcome, now.value))
      if (outcome.consume) fs.rmSync(target, { force: true })
      return { outcome, file: target }
    },
    receipt(name) {
      try {
        return JSON.parse(fs.readFileSync(path.join(receiptsDir(SESSION), name), 'utf8')) as Receipt
      } catch {
        return null
      }
    },
    restart() {
      h.outbox.dispose()
      h.outbox = make()
      return h.outbox
    },
  }
  return h
}

const toSam = { to: 'sam', title: 'review the migration', body: 'please check db/0042 before Friday' }

async function settle(h: Harness): Promise<void> {
  // The pump runs outside the queue; let it reach the queue, then wait for it.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await h.outbox.idle()
  }
}

describe('the `to` payload (task 1.1)', () => {
  it('reads to, title and body as a teammate handoff', () => {
    const result = parseHandoffPayload(JSON.stringify(toSam))
    assert.deepEqual(result, { ok: true, teammate: toSam })
  })
  it('refuses to with target, naming both', () => {
    assert.deepEqual(parseHandoffPayload(JSON.stringify({ ...toSam, target: 'beta' })), { ok: false, reason: 'FIELD_TYPE', field: 'to / target' })
  })
  for (const field of ['at', 'repeat', 'until']) {
    it(`refuses to with ${field}, naming the rule`, () => {
      assert.deepEqual(parseHandoffPayload(JSON.stringify({ ...toSam, [field]: '2026-11-04T09:00:00Z' })), {
        ok: false,
        reason: 'SCHEDULE_INVALID',
        rule: TEAMMATE_NOT_SCHEDULABLE,
      })
    })
  }
  it('refuses a non-string or empty to', () => {
    for (const to of [5, '', '   ', null]) {
      assert.deepEqual(parseHandoffPayload(JSON.stringify({ ...toSam, to })), { ok: false, reason: 'FIELD_TYPE', field: 'to' }, String(to))
    }
  })
})

describe('the inbox schema (task 1.2, 1.3)', () => {
  const teammate = { origin: { kind: 'teammate', id: 'sam', label: 'Acme' }, handoffBodyLimit: true }
  const payload = (body: string): Record<string, unknown> => ({ id: 'teammate:h.1', title: 't', body, actor: 'Sam Lee' })

  it('the teammate body limit is the smaller of the handoff limit and the server limit', () => {
    assert.equal(MAX_TEAMMATE_BODY_LENGTH, Math.min(MAX_FIRST_PARTY_BODY_LENGTH, SERVER_BODY_LIMIT))
    assert.equal(MAX_TEAMMATE_BODY_LENGTH, 20_000)
  })
  it('a teammate-shaped provenance gets the 20,000 limit and no firstPartyBody', () => {
    const okResult = parseIntake(payload('x'.repeat(MAX_FIRST_PARTY_BODY_LENGTH)), 'teammate', teammate)
    assert.equal(okResult.ok, true)
    if (!okResult.ok) return
    assert.equal(okResult.value.verified.handoffBodyLimit, true)
    assert.equal(okResult.value.verified.firstPartyBody, undefined)
    assert.equal('targetFolderId' in okResult.value.verified && okResult.value.verified.targetFolderId !== undefined, false)
    const over = parseIntake(payload('x'.repeat(MAX_FIRST_PARTY_BODY_LENGTH + 1)), 'teammate', teammate)
    assert.deepEqual(over.ok ? null : over.code, 'TOO_LONG')
  })
  it('without the flag a third-party body keeps its limit', () => {
    const result = parseIntake(payload('x'.repeat(MAX_BODY_LENGTH + 1)), 'teammate', { origin: teammate.origin })
    assert.equal(result.ok ? null : result.code, 'TOO_LONG')
  })
  it('a teammate item gets the third-party prompt, in fill mode', () => {
    const result = parseIntake(payload('b'), 'teammate', teammate)
    assert.ok(result.ok)
    if (!result.ok) return
    // The accept path's choice (`ipc/intake.ts`): the limit flag must not choose the prompt.
    assert.equal(isFirstPartyBody(result.value.verified), false)
  })
  it('the store keeps handoffBodyLimit and possiblyElsewhere only when true', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-store-'))
    bases.push(base)
    const file = path.join(base, 'intake.json')
    const store = new IntakeStore(file)
    const parsed = parseIntake(payload('b'), 'teammate', { ...teammate, possiblyElsewhere: true })
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    store.add(parsed.value)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: { content: { verified: Record<string, unknown> } }[] }
    raw.entries.push({ ...raw.entries[0], content: { ...raw.entries[0].content, verified: { ...raw.entries[0].content.verified, handoffBodyLimit: 'yes', possiblyElsewhere: 1 } } })
    ;(raw.entries[1] as unknown as { id: string }).id = 'teammate:h.2'
    fs.writeFileSync(file, JSON.stringify(raw))
    const reloaded = new IntakeStore(file)
    reloaded.load()
    const first = reloaded.get('teammate', 'teammate:h.1')
    assert.equal(first?.content?.verified.handoffBodyLimit, true)
    assert.equal(first?.content?.verified.possiblyElsewhere, true)
    const second = reloaded.get('teammate', 'teammate:h.2')
    assert.ok(second?.content)
    assert.equal('handoffBodyLimit' in (second?.content?.verified ?? {}), false)
    assert.equal('possiblyElsewhere' in (second?.content?.verified ?? {}), false)
  })
})

describe('the new codes (task 1.4)', () => {
  it('permanence', () => {
    const temporary = ['TEAM_UNAVAILABLE', 'OUTGOING_FULL', 'TEAMMATE_UNREADABLE'] as const
    const permanent = ['TEAMMATE_NOT_FOUND', 'TEAMMATE_IS_SELF', 'SEND_UNCERTAIN'] as const
    for (const code of temporary) assert.equal(isPermanentRejection({ code, notify: true }), false, code)
    for (const code of permanent) assert.equal(isPermanentRejection({ code, notify: true }), true, code)
  })
})

describe('reading a teammate handoff (tasks 2.1, 2.2)', () => {
  it('a valid one waits in Outgoing, opens no session, and its receipt says awaiting-confirmation', async () => {
    const h = harness()
    const { outcome } = await h.deliver('a.json', toSam)
    assert.equal(outcome.ok, true)
    assert.equal(h.store.list().length, 0, 'no inbox item, no session')
    const [item] = h.outbox.list()
    assert.equal(item.to, 'sam')
    assert.equal(item.recipientName, 'Sam Lee')
    assert.equal(item.state, 'awaiting')
    assert.deepEqual(item.source, { label: 'alpha', title: 'fix the build' })
    assert.equal(h.receipt('a.json')?.status, 'awaiting-confirmation')
    assert.equal(h.receipt('a.json')?.ref, h.outbox.list()[0].id)
    assert.equal(h.team.requests.length, 0, 'nothing sent before Send')
    assert.equal(h.arrivals.length, 1)
  })

  it('an awaiting handoff is still listed after a restart', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    const restarted = h.restart()
    await settle(h)
    assert.equal(restarted.list().length, 1)
    assert.equal(restarted.list()[0].state, 'awaiting')
    assert.equal(restarted.list()[0].canSend, true)
    assert.equal(h.team.requests.length, 0)
  })

  it('records the handle from the list, not the agent spelling', async () => {
    const h = harness()
    await h.deliver('a.json', { ...toSam, to: '  SAM ' })
    assert.equal(h.outbox.list()[0].to, 'sam')
  })

  it('no team: TEAM_UNAVAILABLE, temporary', async () => {
    const team = new FakeTeam()
    team.stamp = null
    const h = harness({ team })
    const { outcome } = await h.deliver('a.json', toSam)
    assert.equal(outcome.code, 'TEAM_UNAVAILABLE')
    assert.equal(h.receipt('a.json')?.status, 'rejected')
    assert.equal(h.receipt('a.json')?.permanent, false)
    assert.match(h.receipt('a.json')?.reason ?? '', /can succeed once the user is on a team/)
  })

  it('feature off: TEAM_UNAVAILABLE, even with an unknown handle (team checked first)', async () => {
    const team = new FakeTeam()
    team.on = false
    const h = harness({ team })
    const { outcome } = await h.deliver('a.json', { ...toSam, to: 'alex' })
    assert.equal(outcome.code, 'TEAM_UNAVAILABLE')
  })

  it('an unknown handle is refused without asking, after one refetch', async () => {
    const h = harness()
    const { outcome } = await h.deliver('a.json', { ...toSam, to: 'alex', body: 'x'.repeat(30_000) })
    assert.equal(outcome.code, 'TEAMMATE_NOT_FOUND', 'the recipient is checked before the text')
    assert.equal(h.team.refetches, 1)
    assert.equal(h.outbox.list().length, 0)
    assert.equal(h.receipt('a.json')?.permanent, true)
    assert.ok(h.service.notices().some((n) => n.code === 'TEAMMATE_NOT_FOUND'), 'the user sees the failure')
  })

  it('a member who joined since the last fetch is found', async () => {
    const team = new FakeTeam()
    team.fetched = [...team.list, { id: 'm_alex', handle: 'alex', displayName: 'Alex' }]
    const h = harness({ team })
    const { outcome } = await h.deliver('a.json', { ...toSam, to: 'alex' })
    assert.equal(outcome.ok, true)
    assert.equal(h.outbox.list()[0].to, 'alex')
  })

  it('does not refetch while disconnected', async () => {
    const team = new FakeTeam()
    team.isConnected = false
    const h = harness({ team })
    await h.deliver('a.json', { ...toSam, to: 'alex' })
    assert.equal(team.refetches, 0)
  })

  it('the own handle: TEAMMATE_IS_SELF', async () => {
    const h = harness()
    const { outcome } = await h.deliver('a.json', { ...toSam, to: 'Me' })
    assert.equal(outcome.code, 'TEAMMATE_IS_SELF')
  })

  it('a title over 200 or a body over the limit after normalization is refused, not shortened', async () => {
    const h = harness()
    assert.equal((await h.deliver('t.json', { ...toSam, title: 't'.repeat(201) })).outcome.code, 'TOO_LONG')
    assert.equal((await h.deliver('b.json', { ...toSam, body: 'b'.repeat(MAX_TEAMMATE_BODY_LENGTH + 1) })).outcome.code, 'TOO_LONG')
    // Invisible characters do not count: they are removed first.
    const padded = 'b'.repeat(MAX_TEAMMATE_BODY_LENGTH) + '​'.repeat(50)
    assert.equal((await h.deliver('c.json', { ...toSam, body: padded })).outcome.ok, true)
    assert.equal(h.outbox.list().length, 1)
    assert.equal(h.outbox.list()[0].body.length, MAX_TEAMMATE_BODY_LENGTH)
  })

  it('a lone surrogate becomes U+FFFD', () => {
    assert.equal(toWellFormed('a\ud800b\udc00c😀'), 'a�b�c😀')
  })

  it('a scheduled teammate handoff is refused, naming the rule', async () => {
    const h = harness()
    const { outcome } = await h.deliver('a.json', { ...toSam, at: '2026-11-04T09:00:00+08:00' })
    assert.equal(outcome.code, 'SCHEDULE_INVALID')
    assert.match(h.receipt('a.json')?.reason ?? '', /cannot be scheduled/)
  })

  it('to and target together: the receipt names both', async () => {
    const h = harness()
    await h.deliver('a.json', { ...toSam, target: 'beta' })
    assert.equal(h.receipt('a.json')?.code, 'FIELD_TYPE')
  })

  it('the same handoff written twice waits once; the second receipt is duplicate', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    await h.deliver('b.json', toSam)
    assert.equal(h.outbox.list().length, 1)
    assert.equal(h.receipt('b.json')?.status, 'duplicate')
  })

  it('the bound holds the file, and reading again once there is room takes it', async () => {
    const h = harness()
    for (let i = 0; i < MAX_OUTGOING_WAITING; i++) await h.deliver(`w${i}.json`, { ...toSam, title: `t${i}` })
    assert.equal(h.outbox.waitingCount(), MAX_OUTGOING_WAITING)
    const { outcome, file } = await h.deliver('over.json', { ...toSam, title: 'over' })
    assert.equal(outcome.code, 'OUTGOING_FULL')
    assert.equal(outcome.consume, false)
    assert.ok(fs.existsSync(file), 'the file stays')
    assert.equal(h.receipt('over.json')?.status, 'held')
    assert.equal(h.receipt('over.json')?.code, 'OUTGOING_FULL')
    assert.equal(h.outbox.hasRoom(), false)
    await h.outbox.discard(h.outbox.list()[0].id)
    assert.equal(h.outbox.hasRoom(), true)
  })
})

describe('the drop point re-reads an OUTGOING_FULL file once there is room (task 1.5)', () => {
  it('with the default interval', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const h = harness()
    for (let i = 0; i < MAX_OUTGOING_WAITING; i++) await h.deliver(`w${i}.json`, { ...toSam, title: `t${i}` })
    prepareOutbox(SESSION)
    fs.writeFileSync(path.join(outboxDir(SESSION), 'over.json'), JSON.stringify({ ...toSam, title: 'over' }))
    const log = rescanLog()
    const handoff = new HandoffService({
      service: h.service,
      sourceOf: () => ({ folderId: 'f1', label: 'alpha' }),
      candidates: () => [],
      agentEventsEnabled: () => true,
      onDelivered: () => {},
      teammates: { read: (input) => h.outbox.read(input), hasRoom: () => h.outbox.hasRoom() },
      sourceTesting: { watch: silentWatcher, onRescan: log.onRescan },
    })
    await handoff.start()
    after(() => handoff.dispose())
    await rescanOnce(t, log)
    assert.equal(h.outbox.waitingCount(), MAX_OUTGOING_WAITING, 'still held while full')
    await h.outbox.discard(h.outbox.list()[0].id)
    await rescanOnce(t, log)
    assert.ok(h.outbox.list().some((item) => item.title === 'over'))
    assert.equal(fs.existsSync(path.join(outboxDir(SESSION), 'over.json')), false)
  })
})

describe('sending (tasks 2.3, 2.5)', () => {
  it('the text shown is the text sent, and Send leaves the tab', async () => {
    const h = harness()
    await h.deliver('a.json', { ...toSam, body: 'line one\u0007‮\nline two' })
    const shown = h.outbox.list()[0]
    assert.equal(shown.body, 'line one\nline two')
    await h.outbox.send(shown.id)
    await settle(h)
    assert.equal(h.team.requests.length, 1)
    const p = h.team.requests[0].p as { payload: { enc: string; title: string; body: string }; to: string; clientId: string }
    assert.equal(p.payload.body, shown.body)
    assert.equal(p.payload.title, shown.title)
    assert.equal(p.payload.enc, 'none')
    assert.equal(p.to, 'sam')
    assert.match(p.clientId, /^[A-Za-z0-9_-]{22}$/)
    assert.equal(h.outbox.list().length, 0)
    assert.equal(h.receipt('a.json')?.status, 'sent')
    assert.equal(h.receipt('a.json')?.to, 'sam')
    assert.equal(h.receipt('a.json')?.handoffId, 'h_0123')
    assert.doesNotMatch(JSON.stringify(h.receipt('a.json')), /received|accepted|line one/)
  })

  it('a sent handoff is recorded in the Sent list before it leaves the outgoing store (teammate-handoff-return D3)', async () => {
    const h = harness()
    h.team.answers = [
      (p) =>
        Promise.resolve({
          ok: true,
          r: {
            handoff: { id: 'h_77', status: 'pending', sentAt: 5, expiresAt: 6, seq: 41 },
            recipient: { id: 'm_sam', handle: 'sam', displayName: 'Sam Lee', deviceCount: 1 },
            duplicate: false,
            clientIdEcho: p.clientId,
          },
        }),
    ]
    await h.deliver('a.json', toSam)
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    assert.equal(h.recorded.length, 1)
    const [record] = h.recorded
    assert.equal(record.handoffId, 'h_77')
    assert.equal(record.seq, 41)
    assert.equal(record.title, toSam.title)
    assert.equal(record.sourceSessionId, SESSION)
    assert.equal(record.to.handle, 'sam')
    // The outgoing store still held the item when the Sent list recorded it.
    assert.match(record.outgoingAtCall, /"clientId"/)
    assert.equal(h.outbox.list().length, 0)
  })

  it('attempted is on disk before the request reaches the socket, and survives a restart', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.answers.push(() => new Promise<Answer>(() => {})) // never answered
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    const onDisk = JSON.parse(h.team.requests[0].fileAtRequest ?? '{}') as { items: { attempted?: boolean }[] }
    assert.equal(onDisk.items[0].attempted, true)
    // A crash now: the next start must not offer Discard, and resends with the same clientId.
    const clientId = (h.team.requests[0].p as { clientId: string }).clientId
    const restarted = h.restart()
    assert.equal(restarted.list()[0].canDiscard, false)
    await settle(h)
    assert.equal(h.team.requests.length, 2)
    assert.equal((h.team.requests[1].p as { clientId: string }).clientId, clientId)
  })

  it('a lost answer is resent with the same clientId when the connection is back', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.answers.push(lost)
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    assert.equal(h.receipt('a.json')?.code, 'NOT_CONNECTED')
    assert.equal(h.outbox.list()[0].canDiscard, false, 'the server may already hold it')
    h.outbox.pump() // `connected` again
    await settle(h)
    assert.equal(h.team.requests.length, 2)
    assert.equal((h.team.requests[0].p as { clientId: string }).clientId, (h.team.requests[1].p as { clientId: string }).clientId)
    assert.equal(h.receipt('a.json')?.status, 'sent')
  })

  it('confirmed while offline, sent once after a restart when connected', async () => {
    const team = new FakeTeam()
    team.isConnected = false
    const h = harness({ team })
    await h.deliver('a.json', toSam)
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    assert.equal(h.receipt('a.json')?.status, 'held')
    assert.equal(h.receipt('a.json')?.code, 'NOT_CONNECTED')
    assert.equal(h.outbox.list()[0].phase, 'waiting-connection')
    team.isConnected = true
    h.restart()
    await settle(h)
    assert.equal(team.requests.length, 1)
    assert.equal(h.outbox.list().length, 0)
  })

  it('RATE_LIMITED waits until retryAt across a restart, restores Discard, then sends without asking', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    const retryAt = h.now.value + 60_000
    h.team.answers.push(fail('RATE_LIMITED', { retryAt }))
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    let item = h.outbox.list()[0]
    assert.equal(item.phase, 'rate-limited')
    assert.equal(item.retryAt, retryAt)
    assert.equal(item.canDiscard, true)
    assert.equal(h.receipt('a.json')?.code, 'RATE_LIMITED')
    assert.equal(h.receipt('a.json')?.at, new Date(retryAt).toISOString())
    h.restart()
    await settle(h)
    assert.equal(h.team.requests.length, 1, 'not before retryAt')
    item = h.outbox.list()[0]
    assert.equal(item.canDiscard, true)
    h.now.value = retryAt + 1
    h.outbox.pump()
    await settle(h)
    assert.equal(h.team.requests.length, 2)
    assert.equal(h.outbox.list().length, 0)
  })

  it('a rate-limited handoff discarded before retryAt is not sent', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.answers.push(fail('RATE_LIMITED', { retryAt: h.now.value + 60_000 }))
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    assert.equal(await h.outbox.discard(h.outbox.list()[0].id), true)
    h.now.value += 120_000
    h.outbox.pump()
    await settle(h)
    assert.equal(h.team.requests.length, 1)
    assert.equal(h.receipt('a.json')?.status, 'discarded')
  })

  it('INTERNAL retries after a backoff without holding back a later handoff', async () => {
    const h = harness()
    await h.deliver('a.json', { ...toSam, title: 'first' })
    await h.deliver('b.json', { ...toSam, title: 'second' })
    const [first, second] = h.outbox.list()
    h.team.answers.push(fail('INTERNAL'))
    await h.outbox.send(first.id)
    await settle(h)
    assert.equal(h.receipt('a.json')?.code, 'RETRYING')
    assert.equal(h.outbox.list()[0].phase, 'retrying')
    assert.equal(h.outbox.list()[0].canDiscard, false)
    await h.outbox.send(second.id)
    await settle(h)
    assert.equal(h.receipt('b.json')?.status, 'sent', 'the later one is not held back')
    assert.equal(h.receipt('a.json')?.code, 'RETRYING')
    h.now.value += 5_001
    h.outbox.pump()
    await settle(h)
    assert.equal(h.receipt('a.json')?.status, 'sent')
    const ids = h.team.requests.filter((r) => (r.p as { payload: { title: string } }).payload.title === 'first').map((r) => (r.p as { clientId: string }).clientId)
    assert.equal(ids.length, 2)
    assert.equal(ids[0], ids[1], 'the same clientId')
  })

  for (const code of ['RECIPIENT_UNKNOWN', 'RECIPIENT_IS_SELF', 'BAD_PARAMS', 'HANDOFF_ID_REUSED']) {
    it(`${code}: refused, shown with its reason until dismissed, receipt rejected and permanent`, async () => {
      const h = harness()
      await h.deliver('a.json', toSam)
      h.team.answers.push(fail(code))
      await h.outbox.send(h.outbox.list()[0].id)
      await settle(h)
      const item = h.outbox.list()[0]
      assert.equal(item.state, 'refused')
      assert.equal(item.refusal, code)
      assert.equal(item.canDismiss, true)
      assert.equal(h.receipt('a.json')?.status, 'rejected')
      assert.equal(h.receipt('a.json')?.code, code)
      assert.equal(h.receipt('a.json')?.permanent, true)
      await h.outbox.dismiss(item.id)
      assert.equal(h.outbox.list().length, 0)
    })
  }

  it('a recipient with no device: sent, the receipt says so, and the tab keeps it until dismissed', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.answers.push((p) => Promise.resolve(ok(p, 0)))
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    assert.equal(h.receipt('a.json')?.status, 'sent')
    assert.equal(h.receipt('a.json')?.code, 'NO_DEVICE')
    const item = h.outbox.list()[0]
    assert.equal(item.noDevice, true)
    assert.equal(item.canDismiss, true)
  })

  it('a Discard queued before "attempted" sends nothing', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    const id = h.outbox.list()[0].id
    const sent = h.outbox.send(id)
    const discarded = h.outbox.discard(id)
    await Promise.all([sent, discarded])
    await settle(h)
    assert.equal(await discarded, true)
    assert.equal(h.team.requests.length, 0)
    assert.equal(h.receipt('a.json')?.status, 'discarded')
  })

  it('a Discard after the request was made is refused', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.answers.push(() => new Promise<Answer>(() => {}))
    const id = h.outbox.list()[0].id
    await h.outbox.send(id)
    await settle(h)
    assert.equal(await h.outbox.discard(id), false)
  })
})

describe('the membership stamp (task 2.3)', () => {
  it('leave A, join B: nothing is sent to B’s sam, and the waiting one is refused', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.stamp = B
    h.outbox.membershipChanged()
    await settle(h)
    assert.equal(h.outbox.list().length, 0)
    h.outbox.pump()
    await settle(h)
    assert.equal(h.team.requests.length, 0)
    assert.equal(h.receipt('a.json')?.code, 'TEAM_UNAVAILABLE')
    assert.equal(h.receipt('a.json')?.permanent, false)
    assert.deepEqual(h.refusedLater, ['TEAM_UNAVAILABLE'])
  })

  it('a stale-stamp item left by an interrupted discard is refused at the next start', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.stamp = B // the membership changed while spekterm was closed; no event fired
    h.restart()
    await settle(h)
    assert.equal(h.receipt('a.json')?.code, 'TEAM_UNAVAILABLE')
    assert.equal(h.outbox.waitingCount(), 0)
  })

  it('a lost answer, then a revocation: SEND_UNCERTAIN, permanent', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    h.team.answers.push(lost)
    await h.outbox.send(h.outbox.list()[0].id)
    await settle(h)
    h.team.stamp = null
    h.outbox.credentialDiscarded()
    await settle(h)
    assert.equal(h.receipt('a.json')?.status, 'rejected')
    assert.equal(h.receipt('a.json')?.code, 'SEND_UNCERTAIN')
    assert.equal(h.receipt('a.json')?.permanent, true)
    assert.match(h.receipt('a.json')?.reason ?? '', /may have been delivered/)
  })

  it('a confirmed handoff never requested is refused TEAM_UNAVAILABLE at the discard', async () => {
    const team = new FakeTeam()
    team.isConnected = false
    const h = harness({ team })
    await h.deliver('a.json', toSam)
    await h.outbox.send(h.outbox.list()[0].id)
    team.stamp = null
    h.outbox.credentialDiscarded()
    await settle(h)
    assert.equal(h.receipt('a.json')?.code, 'TEAM_UNAVAILABLE')
  })
})

describe('receipts after reading (task 2.4)', () => {
  it('a dormant session keeps its directory, and its receipt is rewritten', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    resetHandoffState() // not live in this run, as after a restart before the session started
    await h.outbox.discard(h.outbox.list()[0].id)
    assert.equal(h.receipt('a.json')?.status, 'discarded')
  })

  it('an ended session’s directory is not created again', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    clearOutbox(SESSION)
    await h.outbox.discard(h.outbox.list()[0].id)
    assert.equal(fs.existsSync(receiptsDir(SESSION)), false)
  })

  it('a reused file name keeps the other delivery’s receipt', async () => {
    const h = harness()
    await h.deliver('a.json', toSam)
    // The agent wrote another delivery as a.json, and it got its own receipt.
    await h.deliver('a.json', { target: 'nowhere', title: 't', body: 'b' })
    const other = h.receipt('a.json')
    assert.equal(other?.code, 'TARGET_NOT_FOUND')
    await h.outbox.discard(h.outbox.list()[0].id)
    assert.deepEqual(h.receipt('a.json'), other)
  })

  it('a damaged store is set aside and read as empty, saying so', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-outbox-'))
    bases.push(base)
    fs.writeFileSync(path.join(base, 'team-outgoing.json'), '{not json')
    const h = harness({ base })
    assert.equal(h.outbox.loadIssue(), 'damaged')
    assert.equal(h.outbox.list().length, 0)
    assert.ok(fs.readdirSync(base).some((name) => name.startsWith('team-outgoing.json.damaged-')))
  })
})
