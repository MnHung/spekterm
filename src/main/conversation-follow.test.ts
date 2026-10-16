import assert from 'node:assert/strict'
import test from 'node:test'
import { startFollow } from './conversation-follow'
import type { FollowUpdate } from './transcript-follow-service'

test('startFollow answers "no conversation" for a session with no agent transcript, and starts nothing', () => {
  const updates: FollowUpdate[] = []
  const waits: string[] = []
  // A shell has no agent source.
  const follow = startFollow('no-such-session', null, {
    update: (update) => updates.push(update),
    wait: (state) => waits.push(state),
    alive: () => true,
  })
  assert.equal(follow, null)
  assert.deepEqual(updates, [
    { sessionId: 'no-such-session', status: 'unavailable', events: [], truncated: false, reset: true },
  ])
  assert.deepEqual(waits, [], 'no wait subscription was made')
})

test('a follower sends the wait again when the open prompt changes with no event, and not otherwise', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { configureAgentEvents, prepareEventInjection } = await import('./agent-events')
  const { clearWait, markAnswered, openRequestsOf, pokeWait, refreshWait } = await import('./agent-wait')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-'))
  configureAgentEvents(base)
  const sessionId = 'F1'
  const dir = prepareEventInjection(sessionId, true)!.env.SPEKTERM_EVENT_DIR
  const waits: { state: string; answered: (number | null)[] }[] = []
  const follow = startFollow(sessionId, { cwd: base, conversationId: 'c' }, {
    update: () => undefined,
    wait: (state, _pending, requests) => waits.push({ state, answered: requests.map((r) => r.answeredAt) }),
    alive: () => true,
  })!
  try {
    fs.writeFileSync(path.join(dir, '100-1.json'), JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }))
    refreshWait(sessionId)
    const afterRequest = waits.length
    assert.equal(waits.at(-1)?.state, 'awaiting-choice')
    refreshWait(sessionId)
    assert.equal(waits.length, afterRequest, 'an empty drain with nothing changed sends nothing')
    markAnswered(sessionId, openRequestsOf(sessionId)[0].id, 7)
    assert.deepEqual(waits.at(-1)?.answered, [7], 'an answer is sent with no event')
    const afterAnswer = waits.length
    pokeWait(sessionId)
    assert.equal(waits.length, afterAnswer + 1, 'a poke (a key typed on the desktop) is sent')
  } finally {
    follow.stop()
    clearWait(sessionId)
    fs.rmSync(base, { recursive: true, force: true })
  }
})
