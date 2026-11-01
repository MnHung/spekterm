import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type CanaryVerdict,
  type LaunchState,
  type LaunchWakeOutcome,
  type NotStartedReason,
  startAtLaunch,
  USER_ENV_UNAVAILABLE,
} from './launch-start'

interface Fake {
  states: Map<string, LaunchState>
  waking: Set<string>
  outcomes: Map<string, LaunchWakeOutcome>
  verdicts: Map<string, CanaryVerdict>
}

function run(queue: string[], fake: Fake): Promise<{ woken: string[]; watched: string[]; notStarted: [string, NotStartedReason][] }> {
  const woken: string[] = []
  const watched: string[] = []
  const notStarted: [string, NotStartedReason][] = []
  return startAtLaunch(queue, {
    stateOf: (id) => fake.states.get(id) ?? { kind: 'gone' },
    isWaking: (id) => fake.waking.has(id),
    wake: async (id) => {
      woken.push(id)
      return fake.outcomes.get(id) ?? { status: 'woken' }
    },
    watchCanary: async (id) => {
      watched.push(id)
      return fake.verdicts.get(id) ?? 'survived'
    },
    notStarted: (id, reason) => notStarted.push([id, reason]),
  }).then(() => ({ woken, watched, notStarted }))
}

const agent = (dormant = true): LaunchState => ({ kind: 'present', target: 'claude', dormant })
const shell = (dormant = true): LaunchState => ({ kind: 'present', target: 'shell', dormant })

function fake(states: Record<string, LaunchState>): Fake {
  return { states: new Map(Object.entries(states)), waking: new Set(), outcomes: new Map(), verdicts: new Map() }
}

describe('startAtLaunch', () => {
  it('starts shells first, then agents, each in persisted order, and watches only the first agent', async () => {
    const f = fake({ a1: agent(), s1: shell(), a2: agent(), s2: shell() })
    const result = await run(['a1', 's1', 'a2', 's2'], f)
    assert.deepEqual(result.woken, ['s1', 's2', 'a1', 'a2'])
    assert.deepEqual(result.watched, ['a1'])
    assert.deepEqual(result.notStarted, [])
  })

  it('skips a session that is gone, no longer dormant, or already being woken', async () => {
    const f = fake({ running: agent(false), waking: shell(), kept: shell() })
    f.waking.add('waking')
    const result = await run(['gone', 'running', 'waking', 'kept'], f)
    assert.deepEqual(result.woken, ['kept'])
  })

  it('stops agents when the canary exits, and says why on each one left; shells are not held back', async () => {
    const f = fake({ a1: agent(), a2: agent(), a3: agent(), s1: shell() })
    f.verdicts.set('a1', 'exited')
    const result = await run(['a1', 'a2', 'a3', 's1'], f)
    assert.deepEqual(result.woken, ['s1', 'a1'])
    assert.deepEqual(result.notStarted, [['a2', 'canary'], ['a3', 'canary']])
  })

  it('hands the canary role to the next agent when the user takes the first away', async () => {
    const f = fake({ a1: agent(), a2: agent(), a3: agent() })
    f.verdicts.set('a1', 'left')
    const result = await run(['a1', 'a2', 'a3'], f)
    assert.deepEqual(result.woken, ['a1', 'a2', 'a3'])
    assert.deepEqual(result.watched, ['a1', 'a2'])
  })

  it('hands the canary role on when the first agent fails to be created', async () => {
    const f = fake({ a1: agent(), a2: agent() })
    f.outcomes.set('a1', { status: 'failed', code: 'FOLDER_UNAVAILABLE' })
    const result = await run(['a1', 'a2'], f)
    assert.deepEqual(result.woken, ['a1', 'a2'])
    assert.deepEqual(result.watched, ['a2'])
  })

  it('starts no further agent when the environment is refused, but still starts shells', async () => {
    const f = fake({ a1: agent(), a2: agent(), s1: shell() })
    f.outcomes.set('a1', { status: 'failed', code: USER_ENV_UNAVAILABLE })
    const result = await run(['a1', 'a2', 's1'], f)
    assert.deepEqual(result.woken, ['s1', 'a1'])
    assert.deepEqual(result.notStarted, [['a2', 'env']])
  })

  it('reads the state again before each start (a session closed during the canary is skipped)', async () => {
    const f = fake({ a1: agent(), a2: agent() })
    const woken: string[] = []
    await startAtLaunch(['a1', 'a2'], {
      stateOf: (id) => f.states.get(id) ?? { kind: 'gone' },
      isWaking: () => false,
      wake: async (id) => {
        woken.push(id)
        return { status: 'woken' }
      },
      watchCanary: async () => {
        f.states.delete('a2')
        return 'survived'
      },
      notStarted: () => assert.fail('nothing is left out'),
    })
    assert.deepEqual(woken, ['a1'])
  })
})
