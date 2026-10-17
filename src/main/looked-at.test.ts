import assert from 'node:assert/strict'
import test from 'node:test'

import { createLookedAt } from './looked-at'

function setup() {
  const state = { focused: null as number | null, displayed: new Map<number, string>(), watched: new Set<string>() }
  const looked: string[] = []
  const lookedAt = createLookedAt(
    {
      focusedContentsId: () => state.focused,
      displayedSessionOf: (id) => state.displayed.get(id) ?? null,
      conversationWatched: (id) => state.watched.has(id),
    },
    (id) => looked.push(id),
  )
  return { state, looked, lookedAt }
}

test('a displayed report from an unfocused window is not looking; focusing that window is', () => {
  // Control: drop the focus condition from `displayedReported` → the first assertion goes red.
  const { state, looked, lookedAt } = setup()
  state.displayed.set(1, 'a')
  lookedAt.displayedReported(1, 'a')
  assert.deepEqual(looked, [])
  assert.equal(lookedAt.isLookedAt('a'), false)
  state.focused = 1
  lookedAt.windowFocused(1)
  assert.deepEqual(looked, ['a'])
  assert.equal(lookedAt.isLookedAt('a'), true)
})

test('a displayed report from the focused window is looking', () => {
  const { state, looked, lookedAt } = setup()
  state.focused = 1
  state.displayed.set(1, 'b')
  lookedAt.displayedReported(1, 'b')
  lookedAt.displayedReported(1, null)
  assert.deepEqual(looked, ['b'])
})

test('a conversation watch is looking; a terminal watch is not', () => {
  const { state, looked, lookedAt } = setup()
  lookedAt.remoteWatched('remote:1:terminal', 'c')
  assert.deepEqual(looked, [])
  lookedAt.remoteWatched('remote:1:conversation', 'c')
  lookedAt.remoteWatched('remote:1:conversation', null)
  assert.deepEqual(looked, ['c'])
  state.watched.add('c')
  assert.equal(lookedAt.isLookedAt('c'), true)
  assert.equal(lookedAt.displayedInFocus('c'), false, 'the desktop half alone does not count a device')
})

test('focusing a window that displays nothing looks at nothing', () => {
  const { looked, lookedAt } = setup()
  lookedAt.windowFocused(1)
  assert.deepEqual(looked, [])
})
