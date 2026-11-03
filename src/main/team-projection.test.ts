import assert from 'node:assert/strict'
import test from 'node:test'

import { projectTeam } from './team-projection'
import type { TeamSnapshot } from './team-service'

const SNAPSHOT: TeamSnapshot = {
  enabled: true,
  status: 'connected',
  membership: {
    server: { address: 'wss://team.example.com', fingerprint: 'A'.repeat(64) },
    team: { name: 'Acme' },
    member: { id: 'm_1', handle: 'sam', displayName: 'Sam', deviceCount: 2 },
    device: { id: 'd_SECRET_ID', name: 'laptop' },
    operations: ['team.members'],
    members: { list: [{ id: 'm_1', handle: 'sam', displayName: 'Sam' }], fetchedAt: 1 },
  },
}

test('the projection carries no device id and marks the member itself', () => {
  const view = projectTeam(SNAPSHOT)
  assert.doesNotMatch(JSON.stringify(view), /d_SECRET_ID|m_1/)
  assert.deepEqual(view.membership?.members, [{ handle: 'sam', displayName: 'Sam', you: true }])
  assert.equal(view.membership?.pinned, true)
})

test('control: a field added to the snapshot does not reach the projection', () => {
  const extended = { ...SNAPSHOT, membership: { ...SNAPSHOT.membership!, deviceSecret: 'PLAINTEXT' } } as unknown as TeamSnapshot
  assert.doesNotMatch(JSON.stringify(projectTeam(extended)), /PLAINTEXT/)
})
