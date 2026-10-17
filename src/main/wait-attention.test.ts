import assert from 'node:assert/strict'
import test from 'node:test'

import type { WaitValue } from '../shared/lineage/lifecycle'
import { AttentionBroadcaster, attentionProjection, type AttentionView } from './wait-attention'

function sources(over: Partial<Record<string, { wait: WaitValue; inTurn?: boolean; seen?: boolean; at?: number[]; key?: number | null }>>) {
  const of = (id: string) => over[id]!
  return {
    running: () => Object.keys(over),
    wait: (id: string) => of(id).wait,
    inTurn: (id: string) => of(id).inTurn ?? false,
    seen: (id: string) => of(id).seen ?? true,
    requestTimes: (id: string) => of(id).at ?? [],
    lastKeystroke: (id: string) => of(id).key ?? null,
  }
}

test('the projection derives each running session; a choice typed over after every tool start is not a choice', () => {
  const views = attentionProjection(
    sources({
      a: { wait: 'ready', seen: false },
      b: { wait: 'awaiting-choice', at: [100], key: 50 },
      c: { wait: 'awaiting-choice', at: [100, 200], key: 150 },
      d: { wait: 'awaiting-choice', at: [100, 200], key: 250 },
      e: { wait: 'busy', inTurn: true },
    }),
  )
  assert.deepEqual(views, [
    { sessionId: 'a', attention: 'waiting' },
    { sessionId: 'b', attention: 'choice' },
    { sessionId: 'c', attention: 'choice' },
    { sessionId: 'd', attention: 'idle' },
    { sessionId: 'e', attention: 'working' },
  ])
})

function broadcaster(lineage: string[] = []) {
  const sent: AttentionView[][] = []
  const calls = { lineage: 0, remote: 0 }
  const b = new AttentionBroadcaster({
    send: (views) => sent.push(views),
    hasLineage: (id) => lineage.includes(id),
    lineageChanged: () => calls.lineage++,
    remoteChanged: () => calls.remote++,
  })
  return { b, sent, calls }
}

test('identical consecutive projections are sent once', () => {
  const { b, sent, calls } = broadcaster()
  const views: AttentionView[] = [{ sessionId: 'a', attention: 'working' }]
  b.update(views)
  b.update([...views])
  assert.equal(sent.length, 1)
  assert.equal(calls.remote, 1)
})

test('a seen flip, a session starting and a session ending each send', () => {
  const { b, sent } = broadcaster()
  b.update([{ sessionId: 'a', attention: 'waiting' }])
  b.update([{ sessionId: 'a', attention: 'idle' }])
  b.update([{ sessionId: 'a', attention: 'idle' }, { sessionId: 'b', attention: 'idle' }])
  b.update([{ sessionId: 'b', attention: 'idle' }])
  assert.equal(sent.length, 4)
  assert.deepEqual(sent.at(-1), [{ sessionId: 'b', attention: 'idle' }], 'an ended session has no entry')
})

test('a change on a handoff session refreshes the relations; one on any other session does not', () => {
  const { b, calls } = broadcaster(['child'])
  b.update([{ sessionId: 'plain', attention: 'waiting' }, { sessionId: 'child', attention: 'working' }])
  assert.equal(calls.lineage, 1)
  b.update([{ sessionId: 'plain', attention: 'idle' }, { sessionId: 'child', attention: 'working' }])
  assert.equal(calls.lineage, 1)
  b.update([{ sessionId: 'plain', attention: 'idle' }, { sessionId: 'child', attention: 'idle' }])
  assert.equal(calls.lineage, 2)
})
