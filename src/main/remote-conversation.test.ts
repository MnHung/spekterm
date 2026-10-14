import assert from 'node:assert/strict'
import test from 'node:test'
import type { WaitState } from './agent-events'
import { SUBMIT_KEY_DELAY_MS } from './intake-prefill'
import { cleanReply, type ReplyDeps, resumeFrom, sendReply } from './remote-conversation'
import type { FollowUpdate } from './transcript-follow-service'
import type { ViewEvent } from './transcript-follow'

/** A hand-driven clock: `delay` resolves when the test advances past it. */
function rig(initial: WaitState = 'ready') {
  let now = 0
  const timers: { at: number; resolve: () => void }[] = []
  const writes: { at: number; data: string }[] = []
  let state: WaitState = initial
  const deps: ReplyDeps = {
    waitStateOf: () => state,
    write: (_id, data) => {
      writes.push({ at: now, data })
      return true
    },
    delay: (ms) => new Promise<void>((resolve) => timers.push({ at: now + ms, resolve })),
    submitDelayMs: SUBMIT_KEY_DELAY_MS,
  }
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    deps,
    writes,
    setState: (next: WaitState) => {
      state = next
    },
    advance: async (ms: number) => {
      await flush()
      now += ms
      for (const timer of timers.splice(0)) {
        if (timer.at <= now) timer.resolve()
        else timers.push(timer)
      }
      await flush()
    },
  }
}

test('the text and the submit key are two writes at least the submit delay apart', async () => {
  const r = rig('ready')
  const outcome = sendReply(r.deps, 's', 's', 'a long dictated reply')
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.equal(await outcome, 'submitted')
  assert.deepEqual(r.writes.map((w) => w.data), ['a long dictated reply', '\r'])
  assert.ok(r.writes[1].at - r.writes[0].at >= SUBMIT_KEY_DELAY_MS)
})

test('a choice that appears during the delay keeps the submit key back', async () => {
  const r = rig('busy')
  const outcome = sendReply(r.deps, 's', 's', 'go on')
  await r.advance(100)
  r.setState('awaiting-choice')
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.equal(await outcome, 'filled-not-submitted')
  assert.deepEqual(r.writes.map((w) => w.data), ['go on'])
})

for (const state of ['unknown', 'awaiting-choice'] as const) {
  test(`a reply is refused while the agent is ${state}, and nothing is written`, async () => {
    const r = rig(state)
    await assert.rejects(sendReply(r.deps, 's', 's', 'hi'), (error: { code: string; detail: { state: string } }) => {
      assert.equal(error.code, 'WAIT_STATE')
      assert.equal(error.detail.state, state)
      return true
    })
    assert.deepEqual(r.writes, [])
  })
}

test('a reply to a session the connection does not watch is refused', async () => {
  const r = rig('ready')
  await assert.rejects(sendReply(r.deps, 'other', 's', 'hi'), { code: 'NOT_WATCHING' })
  await assert.rejects(sendReply(r.deps, null, 's', 'hi'), { code: 'NOT_WATCHING' })
  assert.deepEqual(r.writes, [])
})

test('two concurrent replies are written text, Enter, text, Enter', async () => {
  const r = rig('ready')
  const first = sendReply(r.deps, 's', 's', 'one')
  const second = sendReply(r.deps, 's', 's', 'two')
  await r.advance(SUBMIT_KEY_DELAY_MS)
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.deepEqual(await Promise.all([first, second]), ['submitted', 'submitted'])
  assert.deepEqual(r.writes.map((w) => w.data), ['one', '\r', 'two', '\r'])
})

test('control characters are cleaned as on the desktop, newlines kept', () => {
  assert.equal(cleanReply('a\tb\x01c\nd\re\x7f'), 'abc\nde')
})

const ev = (uuid: string, text: string): ViewEvent => ({ kind: 'text', uuid, at: 0, text })
const first = (events: ViewEvent[]): FollowUpdate => ({ sessionId: 's', status: 'ok', events, truncated: false, reset: true })

test('resume at a uuid several events share sends only events after the last of them', () => {
  const update = first([ev('a', '1'), ev('b', '2'), ev('b', '3'), ev('c', '4'), ev('d', '5')])
  const resumed = resumeFrom(update, 'b')
  assert.deepEqual(resumed.events.map((e) => e.uuid), ['c', 'd'])
  assert.equal(resumed.reset, false)
})

test('an empty, missing or unknown uuid replaces', () => {
  const update = first([ev('', 'x'), ev('a', 'y')])
  for (const after of ['', undefined, 'zzz']) {
    const resumed = resumeFrom(update, after)
    assert.equal(resumed.reset, true)
    assert.equal(resumed.events.length, 2)
  }
})
