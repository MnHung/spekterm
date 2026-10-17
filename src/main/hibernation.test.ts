import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { WaitState } from './agent-events'
import { HibernationTracker } from './hibernation'

const HOUR = 60 * 60 * 1000

/** A tracker on a hand-driven clock and a hand-driven wait state. */
function setup() {
  let now = 0
  const waits = new Map<string, WaitState>()
  const subscribers = new Map<string, (snapshot: { state: WaitState }) => void>()
  const unconfirmed = new Set<string>()
  const tracker = new HibernationTracker({
    now: () => now,
    subscribeWait: (sessionId, subscriber) => {
      subscribers.set(sessionId, subscriber)
      return () => subscribers.delete(sessionId)
    },
    waitStateOf: (sessionId) => waits.get(sessionId) ?? 'unknown',
    hasUnconfirmedSubmission: (sessionId) => unconfirmed.has(sessionId),
  })
  return {
    tracker,
    advance: (ms: number) => {
      now += ms
    },
    /** The wait state changes, as a drain would report it. */
    setWait: (sessionId: string, state: WaitState) => {
      waits.set(sessionId, state)
      subscribers.get(sessionId)?.({ state })
    },
    subscribers,
    unconfirmed,
  }
}

describe('HibernationTracker (session-hibernation)', () => {
  it('an untracked session never qualifies', () => {
    const { tracker } = setup()
    assert.equal(tracker.eligible('nope', 'idle', HOUR), false)
  })

  it('a shell qualifies once idle for the threshold; output restarts the clock', () => {
    const { tracker, advance } = setup()
    tracker.track('s', 'shell')
    advance(HOUR - 1)
    assert.equal(tracker.eligible('s', 'idle', HOUR), false)
    tracker.output('s')
    advance(HOUR - 1)
    assert.equal(tracker.eligible('s', 'idle', HOUR), false, 'output is activity for a shell')
    advance(1)
    assert.equal(tracker.eligible('s', 'idle', HOUR), true)
  })

  it('claude output is not activity; a wait-state change is', () => {
    const { tracker, advance, setWait } = setup()
    tracker.track('c', 'claude')
    setWait('c', 'ready')
    advance(HOUR)
    tracker.output('c')
    assert.equal(tracker.eligible('c', 'unknown', HOUR), true, 'output did not restart the clock')

    setWait('c', 'busy')
    setWait('c', 'ready')
    assert.equal(tracker.eligible('c', 'unknown', HOUR), false, 'finishing a turn restarts it')
  })

  it('subscribes claude to its wait state for its whole life, and only claude', () => {
    const { tracker, subscribers } = setup()
    tracker.track('c', 'claude')
    tracker.track('s', 'shell')
    assert.deepEqual([...subscribers.keys()], ['c'])
    tracker.untrack('c')
    assert.equal(subscribers.size, 0, 'the subscription ends with the pty')
  })

  it('a stale ready cannot hibernate a working agent', () => {
    const { tracker, advance, setWait } = setup()
    tracker.track('c', 'claude')
    setWait('c', 'ready')
    advance(HOUR)
    setWait('c', 'busy')
    advance(2 * HOUR)
    assert.equal(tracker.eligible('c', 'unknown', HOUR), false)
  })

  it('the displayed session never qualifies; showing and leaving restart the clock', () => {
    const { tracker, advance } = setup()
    tracker.track('s', 'shell')
    tracker.setDisplayed(1, 's')
    advance(2 * HOUR)
    assert.equal(tracker.eligible('s', 'idle', HOUR), false, 'displayed')
    tracker.setDisplayed(1, null)
    assert.equal(tracker.eligible('s', 'idle', HOUR), false, 'leaving is activity')
    advance(HOUR)
    assert.equal(tracker.eligible('s', 'idle', HOUR), true)
  })

  it('a session a paired device watches does not qualify, and does once the watch ends and the threshold passes', () => {
    const { tracker, advance, setWait } = setup()
    tracker.track('c', 'claude')
    setWait('c', 'ready')
    tracker.setRemoteWatched('remote:1:conversation', 'c')
    advance(2 * HOUR)
    assert.equal(tracker.eligible('c', 'idle', HOUR), false, 'watched from a phone')
    tracker.setRemoteWatched('remote:1:conversation', null)
    assert.equal(tracker.eligible('c', 'idle', HOUR), false, 'the watch ending is activity')
    advance(HOUR)
    assert.equal(tracker.eligible('c', 'idle', HOUR), true)
  })

  it('only a conversation watch counts as a device reading the session', () => {
    const { tracker } = setup()
    tracker.setRemoteWatched('remote:1:conversation', 'c')
    tracker.setRemoteWatched('remote:2:terminal', 't')
    assert.equal(tracker.conversationWatched('c'), true)
    assert.equal(tracker.conversationWatched('t'), false, 'a terminal watch is not reading the conversation')
    tracker.setRemoteWatched('remote:1:conversation', 't')
    assert.equal(tracker.conversationWatched('c'), false, 'the watch moved away')
    tracker.setDisplayed(1, 'w')
    assert.equal(tracker.conversationWatched('w'), false, 'a window is not a device')
  })

  it('a remote watch and a window are counted separately', () => {
    const { tracker, advance } = setup()
    tracker.track('s', 'shell')
    tracker.setDisplayed(1, 's')
    tracker.setRemoteWatched('remote:1:terminal', 's')
    tracker.setDisplayed(1, null)
    advance(2 * HOUR)
    assert.equal(tracker.eligible('s', 'idle', HOUR), false, 'the phone still watches it')
  })

  it('an unconfirmed filled-in prompt keeps a ready agent', () => {
    const { tracker, advance, setWait, unconfirmed } = setup()
    tracker.track('c', 'claude')
    setWait('c', 'ready')
    advance(HOUR)
    unconfirmed.add('c')
    assert.equal(tracker.eligible('c', 'unknown', HOUR), false)
  })

    it('an automatic request is refused once the session was displayed between decision and execution', () => {
    const { tracker, advance } = setup()
    tracker.track('s', 'shell')
    advance(2 * HOUR)
    assert.equal(tracker.eligible('s', 'idle', HOUR), true, 'precondition: eligible when the request is issued')
    const token = tracker.issueToken('s')
    tracker.setDisplayed(1, 's')
    assert.equal(tracker.authorize('s', token, 'idle', HOUR), false)

    // Control: the same sequence without the display change is honored.
    const other = setup()
    other.tracker.track('s', 'shell')
    other.advance(2 * HOUR)
    assert.equal(other.tracker.authorize('s', other.tracker.issueToken('s'), 'idle', HOUR), true)
  })

  it('a token is single-use, bound to its session, and expires with the tick', () => {
    const { tracker } = setup()
    const token = tracker.issueToken('s')
    assert.equal(tracker.redeem(token, 'other'), false, 'bound to its session')
    const again = tracker.issueToken('s')
    assert.equal(tracker.redeem(again, 's'), true)
    assert.equal(tracker.redeem(again, 's'), false, 'single-use')
    const stale = tracker.issueToken('s')
    tracker.newTick()
    assert.equal(tracker.redeem(stale, 's'), false, 'expired')
  })
})
