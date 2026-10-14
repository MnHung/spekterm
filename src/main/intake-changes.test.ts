import assert from 'node:assert/strict'
import test from 'node:test'
import { dismissIntake, notifyIntakeChanged, onIntakeChanged } from './intake-changes'

test('a desktop dismiss and a remote dismiss each reach both listeners', () => {
  const states: string[] = []
  const store = { setState: (_adapter: string, id: string, state: string) => void states.push(`${id}:${state}`) }
  let desktop = 0
  let remote = 0
  const offDesktop = onIntakeChanged(() => (desktop += 1))
  const offRemote = onIntakeChanged(() => (remote += 1))
  try {
    dismissIntake(store, 'file', 'from-desktop')
    dismissIntake(store, 'file', 'from-device')
    notifyIntakeChanged() // any other change (accept, attach, settle) uses the same signal
    assert.deepEqual(states, ['from-desktop:dismissed', 'from-device:dismissed'])
    assert.equal(desktop, 3)
    assert.equal(remote, 3)
  } finally {
    offDesktop()
    offRemote()
  }
})
