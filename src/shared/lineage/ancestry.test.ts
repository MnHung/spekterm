import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ancestryOf, isDescendantOf, MAX_ANCESTRY, parseAncestors, type AncestryRecord } from './ancestry'

const lookup = (records: Record<string, AncestryRecord>) => (id: string) => records[id]

test('a session without lineage has no ancestors', () => {
  assert.deepEqual(ancestryOf('p', lookup({ p: {} })), [])
  assert.deepEqual(ancestryOf('gone', lookup({})), [])
})

test('older records are walked through the parents that still exist', () => {
  const records = { p: {}, c: { lineage: { parentId: 'p' } }, g: { lineage: { parentId: 'c' } } }
  assert.deepEqual(ancestryOf('g', lookup(records)), ['c', 'p'])
  assert.equal(isDescendantOf('g', 'p', lookup(records)), true)
  assert.equal(isDescendantOf('p', 'g', lookup(records)), false)
})

test('a walk stops at a missing record: a link broken before chains were kept stays broken', () => {
  const records = { g: { lineage: { parentId: 'c' } } }
  assert.deepEqual(ancestryOf('g', lookup(records)), ['c'])
})

test('a recorded chain ends the walk and outlives the records it names', () => {
  // `c` is gone; `g` still reaches `p` and `root` through its recorded chain.
  const records = { g: { lineage: { parentId: 'c', ancestors: ['p', 'root'] } }, p: { lineage: { parentId: 'other' } } }
  assert.deepEqual(ancestryOf('g', lookup(records)), ['c', 'p', 'root'])
})

test('a cycle in corrupt records does not loop', () => {
  const records = { a: { lineage: { parentId: 'b' } }, b: { lineage: { parentId: 'a' } } }
  assert.deepEqual(ancestryOf('a', lookup(records)), ['b'])
  const recordedCycle = { a: { lineage: { parentId: 'b', ancestors: ['c', 'a', 'd'] } } }
  assert.deepEqual(ancestryOf('a', lookup(recordedCycle)), ['b', 'c'])
})

test('the chain is capped, keeping the nearest ancestors', () => {
  const records: Record<string, AncestryRecord> = {}
  for (let i = 0; i < MAX_ANCESTRY + 10; i++) records[`s${i}`] = { lineage: { parentId: `s${i + 1}` } }
  const chain = ancestryOf('s0', lookup(records))
  assert.equal(chain.length, MAX_ANCESTRY)
  assert.equal(chain[0], 's1')
  const long = { x: { lineage: { parentId: 'p', ancestors: Array.from({ length: 100 }, (_, i) => `a${i}`) } } }
  assert.equal(ancestryOf('x', lookup(long)).length, MAX_ANCESTRY)
})

test('a persisted chain is read back only when every element is a session id', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  assert.deepEqual(parseAncestors([id(1), id(2)]), [id(1), id(2)])
  assert.equal(parseAncestors([id(1), 'nope']), undefined)
  assert.equal(parseAncestors(id(1)), undefined)
  assert.equal(parseAncestors(undefined), undefined)
  assert.equal(parseAncestors(Array.from({ length: MAX_ANCESTRY + 5 }, (_, i) => id(i)))?.length, MAX_ANCESTRY)
})
