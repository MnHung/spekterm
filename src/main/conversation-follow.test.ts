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
