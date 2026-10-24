import assert from 'node:assert/strict'
import test from 'node:test'

import type { RowState } from './attention'
import { BUCKET_OF, BUCKET_ORDER, summarize } from './summary'

const ALL: RowState[] = ['choice', 'waiting', 'error', 'working', 'running', 'unknown', 'idle', 'dormant', 'ended']

test('every row state has a bucket, and the buckets are listed in order of urgency, ended last', () => {
  for (const state of ALL) assert.ok(BUCKET_OF[state], state)
  assert.deepEqual(BUCKET_ORDER, ['needsYou', 'error', 'working', 'running', 'idle', 'hibernated', 'ended'])
})

test('choice and waiting count together; running and unknown count together', () => {
  const summary = summarize(ALL.map((state) => ({ state, item: state })))
  assert.deepEqual(
    summary.map(({ bucket, items }) => [bucket, items]),
    [
      ['needsYou', ['choice', 'waiting']],
      ['error', ['error']],
      ['working', ['working']],
      ['running', ['running', 'unknown']],
      ['idle', ['idle']],
      ['hibernated', ['dormant']],
      ['ended', ['ended']],
    ],
  )
})

test('only states with a session are listed, the most urgent first, items in the given order', () => {
  const summary = summarize<string>([
    { state: 'dormant', item: 'a' },
    { state: 'working', item: 'b' },
    { state: 'dormant', item: 'c' },
  ])
  assert.deepEqual(
    summary.map(({ bucket, items }) => [bucket, items]),
    [
      ['working', ['b']],
      ['hibernated', ['a', 'c']],
    ],
  )
  assert.deepEqual(summarize([]), [])
})
