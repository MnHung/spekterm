import assert from 'node:assert/strict'
import test from 'node:test'
import type { WaitState } from './agent-events'
import { SUBMIT_KEY_DELAY_MS } from './intake-prefill'
import { cleanReply, type ReplyDeps, resumeFrom, runQueued, sendReply } from './remote-conversation'
import { RemoteError } from './remote-frames'
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
  assert.equal((await outcome).outcome, 'submitted')
  assert.deepEqual(r.writes.map((w) => w.data), ['a long dictated reply', '\r'])
  assert.ok(r.writes[1].at - r.writes[0].at >= SUBMIT_KEY_DELAY_MS)
})

test('a choice that appears during the delay keeps the submit key back', async () => {
  const r = rig('busy')
  const outcome = sendReply(r.deps, 's', 's', 'go on')
  await r.advance(100)
  r.setState('awaiting-choice')
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.equal((await outcome).outcome, 'filled-not-submitted')
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
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.outcome), ['submitted', 'submitted'])
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

test('an answer queued behind a reply waits for the reply\'s submit key', async () => {
  const r = rig('ready')
  const reply = sendReply(r.deps, 's', 's', 'one')
  const answer = runQueued('s', async () => {
    r.deps.write('s', '1')
    return 'sent'
  })
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.deepEqual(await Promise.all([reply.then((r) => r.outcome), answer]), ['submitted', 'sent'])
  assert.deepEqual(r.writes.map((w) => w.data), ['one', '\r', '1'])
})

function attachments(paths: string[]) {
  const log: string[] = []
  return {
    log,
    take: () => ({ paths, commit: () => void log.push('commit'), release: () => void log.push('release') }),
  }
}

test('a reply with attachments names their paths inside a sentence, and returns the exact text', async () => {
  const r = rig('ready')
  const a = attachments(['/data/remote-attachments/s/sent/ab-photo.jpg'])
  const reply = sendReply(r.deps, 's', 's', 'what is this?', a.take)
  await r.advance(SUBMIT_KEY_DELAY_MS)
  const result = await reply
  assert.equal(result.outcome, 'submitted')
  assert.equal(
    result.text,
    'what is this?\n\n(The user attached 1 file from their phone; read it with the Read tool: `/data/remote-attachments/s/sent/ab-photo.jpg`)',
  )
  assert.equal(r.writes[0].data, result.text)
  assert.ok(!result.text.split('\n').some((line) => line.startsWith('/')), 'no path on a line of its own')
  assert.deepEqual(a.log, ['commit'])
})

test('a reply may be attachments only; with neither text nor attachments it is refused', async () => {
  const r = rig('ready')
  const a = attachments(['/x/a.png', '/x/b.pdf'])
  const reply = sendReply(r.deps, 's', 's', '  ', a.take)
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.equal((await reply).text, '(The user attached 2 files from their phone; read them with the Read tool: `/x/a.png`, `/x/b.pdf`)')
  await assert.rejects(sendReply(r.deps, 's', 's', '  '), { code: 'BAD_PARAMS' })
})

test('a reply refused after its attachments were taken releases them', async () => {
  const r = rig('ready')
  const a = attachments(['/x/a.png'])
  const reply = sendReply({ ...r.deps, write: () => false }, 's', 's', 'hi', a.take)
  await assert.rejects(reply, { code: 'NOT_FOUND' })
  assert.deepEqual(a.log, ['release'])
  await assert.rejects(
    sendReply(r.deps, 's', 's', 'hi', () => {
      throw new RemoteError('NOT_FOUND', 'no unsent attachment x')
    }),
    { code: 'NOT_FOUND' },
  )
  assert.equal(r.writes.length, 0)
})

/** `prefillPending` of `sendReply` (`remote-prefill-send` D5): a switchable fill. */
function withFill(r: ReturnType<typeof rig>, initial: { prefillId?: string; edited: boolean } | null) {
  let fill = initial
  r.deps.prefillPending = () => fill
  return (next: { prefillId?: string; edited: boolean } | null) => {
    fill = next
  }
}

test('a reply while a filled-in prompt waits is refused and writes nothing, edited or not, listed or not', async () => {
  for (const fill of [{ prefillId: 'p1', edited: false }, { prefillId: 'p1', edited: true }, { edited: false }]) {
    const r = rig('ready')
    withFill(r, fill)
    const a = attachments(['/x/a.png'])
    await assert.rejects(sendReply(r.deps, 's', 's', 'also do this', a.take), (error: RemoteError) => {
      assert.equal(error.code, 'PREFILL_PENDING')
      assert.deepEqual(error.detail, fill)
      return true
    })
    assert.deepEqual(r.writes, [], JSON.stringify(fill))
    assert.deepEqual(a.log, [], 'refused before the attachments are taken')
  }
})

test('a fill that appears while the reply waits its turn refuses it inside the queue and releases the attachments', async () => {
  const r = rig('ready')
  const set = withFill(r, null)
  const a = attachments(['/x/a.png'])
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  void runQueued('s', () => gate)
  const reply = sendReply(r.deps, 's', 's', 'hi', a.take)
  set({ prefillId: 'p1', edited: false })
  release()
  await assert.rejects(reply, (error: RemoteError) => error.code === 'PREFILL_PENDING')
  assert.deepEqual(r.writes, [])
  assert.deepEqual(a.log, ['release'])
})

test('a fill that appears during the delay keeps the submit key back', async () => {
  // Control group: remove the check before the submit key → the outcome is `submitted` and `\r` is written (red).
  const r = rig('ready')
  const set = withFill(r, null)
  const outcome = sendReply(r.deps, 's', 's', 'go on')
  await r.advance(100)
  set({ edited: true })
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.equal((await outcome).outcome, 'filled-not-submitted')
  assert.deepEqual(r.writes.map((w) => w.data), ['go on'])
})

test('with no fill a reply is written and submitted as before', async () => {
  const r = rig('ready')
  withFill(r, null)
  const outcome = sendReply(r.deps, 's', 's', 'hi')
  await r.advance(SUBMIT_KEY_DELAY_MS)
  assert.equal((await outcome).outcome, 'submitted')
})
