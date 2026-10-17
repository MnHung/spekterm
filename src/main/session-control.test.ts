import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CommandKind } from './handoff-delivery'
import type { IntakeRejection } from './intake-schema'
import type { DeliverOutcome, FailureContext } from './intake-service'
import type { HostAction } from './remote-protocol'
import type { RendererOutcome } from './remote-host'
import { type GateResult, SessionControl } from './session-control'
import type { PersistedSession } from './session-store'

/** `agent-session-control`: every branch of design D2, D3, D6, D9 and D11, by injected facts. */

const P = '10000000-0000-4000-8000-000000000001'
const C = '10000000-0000-4000-8000-000000000002'
const G = '10000000-0000-4000-8000-000000000003'
const C2 = '10000000-0000-4000-8000-000000000004'
const X = '10000000-0000-4000-8000-000000000005'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function rec(id: string, peerName: string, parentId?: string, extra: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    folderId: 'f1',
    spawnTarget: 'claude',
    ordinal: 0,
    peerName,
    ...(parentId ? { lineage: { parentId, origin: { kind: 'folder', folderId: 'f1', folderName: 'alpha' } } } : {}),
    ...extra,
  }
}

function harness() {
  const sessions = new Map<string, { session: PersistedSession; exists: boolean }>()
  const add = (session: PersistedSession, exists = true) => sessions.set(session.id, { session, exists })
  add(rec(P, 'alpha-p'))
  add(rec(C, 'alpha-c', P))
  add(rec(G, 'alpha-g', C))
  add(rec(C2, 'alpha-c2', P))
  add(rec(X, 'alpha-x'))
  const running = new Set([P, C, G, C2, X])
  const inTurn = new Set<string>()
  const waitListeners = new Map<string, Set<() => void>>()
  const keystrokes = new Set<(id: string) => void>()
  const lastChange = new Map<string, number>()
  const expected = new Set<string>()
  let runStart = 1_000
  let eventsOn = true
  let gate: () => Promise<GateResult> = async () => 'ready'
  let answer: (action: HostAction) => RendererOutcome = (action) => ({ ok: true, sessionId: (action as { sessionId: string }).sessionId })
  const requests: HostAction[] = []
  const rejects: { code: IntakeRejection; failure: FailureContext }[] = []
  const reported: IntakeRejection[] = []
  const refreshed: string[] = []
  let announced = 0
  let clock = 10_000

  const control = new SessionControl({
    sessions: () => [...sessions.values()],
    running: (id) => running.has(id),
    refreshWait: (id) => refreshed.push(id),
    inTurn: (id) => inTurn.has(id),
    subscribeWait: (id, listener) => {
      const set = waitListeners.get(id) ?? new Set()
      set.add(listener)
      waitListeners.set(id, set)
      return () => set.delete(listener)
    },
    onKeystroke: (listener) => {
      keystrokes.add(listener)
      return () => keystrokes.delete(listener)
    },
    agentEventsEnabled: () => eventsOn,
    runs: {
      runStartedAt: () => runStart,
      lastProcessChangeAt: (id) => lastChange.get(id) ?? null,
      expectCommandEnd: (id) => expected.add(id),
      cancelCommandEnd: (id) => expected.delete(id),
    },
    whenReady: () => gate(),
    request: async (action) => {
      requests.push(action)
      return answer(action)
    },
    describe: (id) => (sessions.get(id)?.exists ? `alpha · ${sessions.get(id)?.session.peerName}` : null),
    reject: (code, _label, detail, failure): DeliverOutcome => {
      rejects.push({ code, failure })
      return { ok: false, code, consume: true, notify: true, detail }
    },
    reportFailure: (code) => reported.push(code),
    offersChanged: () => announced++,
    now: () => clock,
  })

  let n = 0
  const deliver = (source: string, kind: CommandKind, body: Record<string, unknown> = {}, mtimeMs: number | undefined = 5_000) =>
    control.deliver(source, kind, JSON.stringify({ kind, ...body }), `id-${++n}`, mtimeMs)
  const drain = (id: string) => {
    for (const listener of waitListeners.get(id) ?? []) listener()
  }
  const type = (id: string) => {
    for (const listener of keystrokes) listener(id)
  }
  return {
    control,
    sessions,
    add,
    running,
    inTurn,
    lastChange,
    expected,
    requests,
    rejects,
    reported,
    refreshed,
    deliver,
    drain,
    type,
    setRunStart: (at: number) => (runStart = at),
    setEvents: (on: boolean) => (eventsOn = on),
    setGate: (next: () => Promise<GateResult>) => (gate = next),
    setAnswer: (next: (action: HostAction) => RendererOutcome) => (answer = next),
    announced: () => announced,
    setClock: (at: number) => (clock = at),
  }
}

describe('who may be targeted (D2)', () => {
  it('an omitted target and the own name both mean the source', async () => {
    const h = harness()
    h.deliver(P, 'close')
    h.deliver(C2, 'close', { target: 'alpha-c2' })
    await flush()
    // A close of the agent's own session is offered, not carried out (D12).
    assert.deepEqual(h.requests.map((r) => [r.kind, (r as { sessionId: string }).sessionId]), [
      ['offer-close', P],
      ['offer-close', C2],
    ])
  })

  it('a grandchild is reachable, also through a closed intermediate', async () => {
    const h = harness()
    h.deliver(P, 'hibernate', { target: 'alpha-g' })
    await flush()
    assert.deepEqual(h.requests.at(-1), { kind: 'hibernate', sessionId: G, force: true })
    h.sessions.delete(C)
    h.sessions.set(G, { session: rec(G, 'alpha-g', C, { lineage: { parentId: C, origin: { kind: 'unknown' }, ancestors: [P] } }), exists: true })
    h.deliver(P, 'close', { target: 'alpha-g' })
    await flush()
    assert.deepEqual(h.requests.at(-1), { kind: 'close', sessionId: G, force: true })
  })

  for (const [label, source, target] of [
    ['the parent', C, 'alpha-p'],
    ['a sibling', C, 'alpha-c2'],
    ['an unrelated session', P, 'alpha-x'],
  ] as const) {
    it(`${label} is refused, visibly`, async () => {
      const h = harness()
      const outcome = h.deliver(source, 'close', { target })
      await flush()
      assert.equal(outcome.code, 'CONTROL_NOT_ALLOWED')
      assert.equal(h.requests.length, 0)
      assert.equal(h.rejects[0]?.failure.subject, 'command')
      assert.equal(h.rejects[0]?.failure.target, target)
      assert.match(h.rejects[0]?.failure.origin ?? '', /^alpha · /)
    })
  }

  it('a session hidden from the relations (its folder left) cannot be named', () => {
    const h = harness()
    h.sessions.set(C, { session: rec(C, 'alpha-c', P), exists: false })
    assert.equal(h.deliver(P, 'close', { target: 'alpha-c' }).code, 'CONTROL_TARGET_NOT_FOUND')
  })

  it('an unknown name is refused, visibly', () => {
    const h = harness()
    assert.equal(h.deliver(P, 'close', { target: 'nobody' }).code, 'CONTROL_TARGET_NOT_FOUND')
  })

  it('with the source gone: its own name and unknown names are dropped silently, a descendant is acted on', async () => {
    const h = harness()
    h.sessions.delete(P)
    assert.deepEqual(h.deliver(P, 'close', { target: 'alpha-p' }), { ok: true, consume: true, notify: false })
    assert.deepEqual(h.deliver(P, 'close'), { ok: true, consume: true, notify: false })
    assert.deepEqual(h.deliver(P, 'close', { target: 'nobody' }), { ok: true, consume: true, notify: false })
    assert.equal(h.rejects.length, 0)
    h.deliver(P, 'hibernate', { target: 'alpha-c' })
    await flush()
    assert.deepEqual(h.requests, [{ kind: 'hibernate', sessionId: C, force: true }])
  })

  it('a field claiming another source has no effect', () => {
    const h = harness()
    assert.equal(h.deliver(C, 'close', { target: 'alpha-c2', source: P, sessionId: P }).code, 'CONTROL_NOT_ALLOWED')
  })
})

describe('when (D3)', () => {
  it('a rename happens at once, even mid-turn; an empty name is sent as an empty rename', async () => {
    const h = harness()
    h.inTurn.add(C)
    h.deliver(P, 'rename', { target: 'alpha-c', name: 'Fix login' })
    h.deliver(P, 'rename', { target: 'alpha-c', name: '' })
    await flush()
    assert.deepEqual(h.requests, [
      { kind: 'rename', sessionId: C, name: 'Fix login' },
      { kind: 'rename', sessionId: C, name: '' },
    ])
  })

  it('a target at rest is acted on at once, after the events were drained', async () => {
    const h = harness()
    h.deliver(P, 'close', { target: 'alpha-c' })
    assert.deepEqual(h.refreshed, [C])
    await flush()
    assert.equal(h.requests.length, 1)
  })

  it('a target in a turn waits for the drain after which it is at rest, and is acted on once', async () => {
    const h = harness()
    h.inTurn.add(C)
    h.deliver(P, 'close', { target: 'alpha-c' })
    h.drain(C)
    await flush()
    assert.equal(h.requests.length, 0, 'still in its turn (a permission prompt, a compaction, a background agent)')
    h.inTurn.delete(C)
    h.drain(C)
    h.drain(C)
    await flush()
    assert.deepEqual(h.requests, [{ kind: 'close', sessionId: C, force: true }])
  })

  it('a keystroke drops the waiting command, and a later rest does not revive it', async () => {
    const h = harness()
    h.inTurn.add(C)
    h.deliver(P, 'close', { target: 'alpha-c' })
    h.type(C)
    assert.equal(h.control.pendingFor(C), null)
    h.inTurn.delete(C)
    h.drain(C)
    await flush()
    assert.equal(h.requests.length, 0)
  })

  it("a keystroke into another session does not drop it", () => {
    const h = harness()
    h.inTurn.add(C)
    h.deliver(P, 'close', { target: 'alpha-c' })
    h.type(C2)
    assert.equal(h.control.pendingFor(C), 'close')
  })

  it('the process ending drops it', async () => {
    const h = harness()
    h.inTurn.add(C)
    h.deliver(P, 'close', { target: 'alpha-c' })
    h.control.processEnded(C)
    h.inTurn.delete(C)
    h.drain(C)
    await flush()
    assert.equal(h.requests.length, 0)
  })

  it('the latest command for a target wins', async () => {
    const h = harness()
    h.inTurn.add(C)
    h.deliver(P, 'hibernate', { target: 'alpha-c' })
    h.deliver(P, 'close', { target: 'alpha-c' })
    h.inTurn.delete(C)
    h.drain(C)
    await flush()
    assert.deepEqual(h.requests, [{ kind: 'close', sessionId: C, force: true }])
  })

  it('dormant: hibernate does nothing, close happens at once', async () => {
    const h = harness()
    h.running.delete(C)
    h.inTurn.add(C)
    h.deliver(P, 'hibernate', { target: 'alpha-c' })
    await flush()
    assert.equal(h.requests.length, 0)
    assert.equal(h.rejects.length, 0)
    h.deliver(P, 'close', { target: 'alpha-c' })
    await flush()
    assert.deepEqual(h.requests, [{ kind: 'close', sessionId: C, force: true }])
  })

  it('with agent events off a running target is refused, temporarily; a rename still works', async () => {
    const h = harness()
    h.setEvents(false)
    assert.equal(h.deliver(P, 'close', { target: 'alpha-c' }).code, 'CONTROL_UNAVAILABLE')
    h.deliver(P, 'rename', { target: 'alpha-c', name: 'n' })
    await flush()
    assert.deepEqual(h.requests.map((r) => r.kind), ['rename'])
    assert.equal(h.reported.length, 0)
  })

  it('deliver returns before the window has answered', async () => {
    const h = harness()
    let release!: (result: GateResult) => void
    h.setGate(() => new Promise((resolve) => (release = resolve)))
    const outcome = h.deliver(P, 'close', { target: 'alpha-c' })
    assert.deepEqual(outcome, { ok: true, consume: true, notify: false })
    await flush()
    assert.equal(h.requests.length, 0)
    release('ready')
    await flush()
    assert.equal(h.requests.length, 1)
  })
})

describe('yielding to what happened afterwards (D11)', () => {
  it("a close written before the target's last start or end, or before this run, is dropped", async () => {
    const h = harness()
    h.lastChange.set(C, 6_000)
    h.deliver(P, 'close', { target: 'alpha-c' }, 5_000)
    h.setRunStart(9_000)
    h.deliver(P, 'close', { target: 'alpha-c2' }, 8_000)
    h.deliver(P, 'close', { target: 'alpha-g' }, undefined)
    await flush()
    assert.equal(h.requests.length, 0)
    assert.equal(h.rejects.length, 0)
  })

  it('one written after a wake acts', async () => {
    const h = harness()
    h.lastChange.set(C, 4_000)
    h.deliver(P, 'close', { target: 'alpha-c' }, 5_000)
    await flush()
    assert.equal(h.requests.length, 1)
  })

  it('a rename is not subject to it', async () => {
    const h = harness()
    h.setRunStart(9_000)
    h.deliver(P, 'rename', { target: 'alpha-c', name: 'n' }, 1)
    await flush()
    assert.equal(h.requests.length, 1)
  })

  it('a running target is marked as ending by a command, and the mark is cleared when the request fails', async () => {
    const h = harness()
    h.deliver(P, 'hibernate', { target: 'alpha-c' })
    await flush()
    assert.ok(h.expected.has(C))
    h.setAnswer(() => ({ ok: false, code: 'NOT_FOUND' }))
    h.deliver(P, 'close', { target: 'alpha-c2' })
    await flush()
    assert.ok(!h.expected.has(C2))
  })
})

describe('the window (D6, D9)', () => {
  it('a request waits for the gate, and is decided again when released', async () => {
    const h = harness()
    let release!: (result: GateResult) => void
    h.setGate(() => new Promise((resolve) => (release = resolve)))
    h.deliver(P, 'close', { target: 'alpha-c' }, 5_000)
    // A reload ended every pty meanwhile.
    h.lastChange.set(C, 7_000)
    release('ready')
    await flush()
    assert.equal(h.requests.length, 0)
  })

  it('a gate that never opens fails temporarily: a trace, no notification', async () => {
    const h = harness()
    h.setGate(async () => 'timeout')
    h.deliver(P, 'close', { target: 'alpha-c' })
    await flush()
    assert.deepEqual(h.rejects.map((r) => r.code), ['CONTROL_NO_WINDOW'])
    assert.deepEqual(h.reported, [])
  })

  it('a failure after waiting is a trace and a notification', async () => {
    const h = harness()
    h.inTurn.add(C)
    h.setAnswer(() => ({ ok: false, code: 'NOT_FOUND' }))
    h.deliver(P, 'close', { target: 'alpha-c' })
    h.inTurn.delete(C)
    h.drain(C)
    await flush()
    assert.deepEqual(h.rejects.map((r) => r.code), ['CONTROL_FAILED'])
    assert.deepEqual(h.reported, ['CONTROL_FAILED'])
    assert.equal(h.rejects[0]?.failure.subject, 'command')
  })

  it('a duplicate identity acts once', async () => {
    const h = harness()
    const body = JSON.stringify({ kind: 'rename', target: 'alpha-c', name: 'n' })
    h.control.deliver(P, 'rename', body, 'same', 5_000)
    assert.deepEqual(h.control.deliver(P, 'rename', body, 'same', 5_000), { ok: true, consume: true, notify: false })
    await flush()
    assert.equal(h.requests.length, 1)
  })

  it('a malformed command is refused as a command', () => {
    const h = harness()
    assert.equal(h.deliver(P, 'rename', { target: 'alpha-c' }).code, 'FIELD_TYPE')
    assert.equal(h.rejects[0]?.failure.subject, 'command')
  })
})

describe("the agent's own close is offered (D12)", () => {
  it('a running self-close is offered, nothing ends, and no command end is announced', async () => {
    const h = harness()
    h.deliver(P, 'close')
    await flush()
    assert.deepEqual(h.requests, [{ kind: 'offer-close', sessionId: P }])
    assert.equal(h.control.isOffered(P), true)
    assert.equal(h.expected.has(P), false)
  })

  it("a descendant's close and the agent's own hibernation are carried out as before", async () => {
    const h = harness()
    h.deliver(P, 'close', { target: 'alpha-c' })
    h.deliver(P, 'hibernate')
    await flush()
    assert.deepEqual(h.requests, [
      { kind: 'close', sessionId: C, force: true },
      { kind: 'hibernate', sessionId: P, force: true },
    ])
  })

  it('a self-close waiting on the turn is offered when the turn ends', async () => {
    const h = harness()
    h.inTurn.add(P)
    h.deliver(P, 'close')
    h.inTurn.delete(P)
    h.drain(P)
    await flush()
    assert.deepEqual(h.requests, [{ kind: 'offer-close', sessionId: P }])
  })

  it('a keystroke into an offered session withdraws the offer; into another session it does not', async () => {
    const h = harness()
    h.deliver(P, 'close')
    await flush()
    h.type(C)
    assert.equal(h.control.isOffered(P), true)
    h.type(P)
    await flush()
    assert.equal(h.control.isOffered(P), false)
    assert.deepEqual(h.requests.at(-1), { kind: 'withdraw-close', sessionId: P })
    h.type(P)
    await flush()
    assert.equal(h.requests.filter((r) => r.kind === 'withdraw-close').length, 1, 'withdrawn once')
  })

  it("the session's process ending forgets the offer", async () => {
    const h = harness()
    h.deliver(P, 'close')
    await flush()
    h.lastChange.set(P, 10_001)
    h.control.processEnded(P)
    assert.equal(h.control.isOffered(P), false)
  })
})

describe('offers are one record, announced on every change (remote-close-offer D1, D3)', () => {
  // Written at the current clock, so a process change before it does not make the command itself stale (D11).
  const offered = async (h: ReturnType<typeof harness>, id = P, at = 10_000) => {
    h.deliver(id, 'close', {}, at)
    await flush()
    assert.equal(h.control.isOffered(id), true)
  }

  it('making an offer announces it once; a second self-close of an offered session does not', async () => {
    const h = harness()
    await offered(h)
    assert.equal(h.announced(), 1)
    h.deliver(P, 'close')
    await flush()
    assert.equal(h.announced(), 1)
  })

  it('a keystroke, a failed offer and withdraw each announce once; on an unoffered session never', async () => {
    const h = harness()
    await offered(h)
    h.type(P)
    assert.equal(h.announced(), 2, 'keystroke')
    h.type(P)
    assert.equal(h.announced(), 2, 'keystroke with no offer')

    assert.equal(h.control.withdraw(C), false)
    await offered(h, C)
    const before = h.requests.length
    assert.equal(h.control.withdraw(C), true)
    assert.equal(h.control.isOffered(C), false)
    assert.equal(h.announced(), 4, 'withdraw')
    assert.equal(h.requests.length, before, 'withdraw does not contact the window')

    h.setAnswer(() => ({ ok: false, code: 'TIMEOUT' }))
    h.deliver(C2, 'close')
    await flush()
    assert.equal(h.control.isOffered(C2), false)
    assert.equal(h.announced(), 6, 'offered, then taken back by the failed request')
  })

  it("processEnded keeps a pending command's session's offer and announces nothing", async () => {
    const h = harness()
    await offered(h)
    h.inTurn.add(P)
    h.deliver(C, 'close', { target: 'alpha-p' })
    assert.equal(h.announced(), 1)
    h.control.processEnded(P)
    assert.equal(h.control.isOffered(P), true)
    assert.equal(h.announced(), 1)
  })

  it('an offer ends with the next process start or end, silently; one before the offer does not end it', async () => {
    const h = harness()
    h.lastChange.set(P, 9_000)
    await offered(h)
    h.setClock(12_000)
    assert.equal(h.control.isOffered(P), true, 'a change before the offer')

    h.lastChange.set(P, 10_500)
    assert.equal(h.control.isOffered(P), false, 'a later start or end')
    assert.equal(h.announced(), 1, 'reading a stale offer announces nothing')
    assert.equal(h.control.withdraw(P), false, 'a stale offer is none')
    assert.equal(h.announced(), 1)
  })

  it('a self-close after a stale offer is a fresh offer, announced', async () => {
    const h = harness()
    await offered(h)
    h.lastChange.set(P, 10_500)
    h.setClock(11_000)
    await offered(h, P, 11_000)
    assert.equal(h.announced(), 2)
  })

  it('a failed rename or hibernate of an offered session keeps the offer', async () => {
    const h = harness()
    await offered(h, C)
    h.setAnswer(() => ({ ok: false, code: 'TIMEOUT' }))
    h.deliver(P, 'rename', { target: 'alpha-c', name: 'x' })
    h.deliver(P, 'hibernate', { target: 'alpha-c' })
    await flush()
    assert.equal(h.control.isOffered(C), true)
    assert.equal(h.announced(), 1)
  })
})
