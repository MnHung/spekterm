import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { nextInOrder, railItems, railSessionOrder, type RailFolder, type RailSession } from './rail-order'

interface S extends RailSession {
  ended?: boolean
}

const folders: RailFolder[] = [
  { id: 'b', pinned: false },
  { id: 'a', pinned: true },
  { id: 'c', pinned: false },
]

const sessionsByItem = new Map<string | null, S[]>([
  [null, [{ id: 'g1' }]],
  ['a', [{ id: 'a1' }, { id: 'a2' }]],
  ['b', [{ id: 'b1' }, { id: 'b2' }, { id: 'b3', lineage: { parentId: 'b1' } }]],
  ['c', []],
  // A removed folder's session: no rail item, so it must not appear.
  ['gone', [{ id: 'x1' }]],
])
const sessionsOf = (folderId: string | null): S[] => sessionsByItem.get(folderId) ?? []
const exists = (session: S): boolean => !session.ended
const ids = (order: { session: S }[]) => order.map((entry) => entry.session.id)

describe('railSessionOrder', () => {
  it('lists the global item, the pinned folders, then the rest; a child under its parent', () => {
    assert.deepEqual(railItems(folders), [null, 'a', 'b', 'c'])
    assert.deepEqual(ids(railSessionOrder(folders, sessionsOf, exists)), ['g1', 'a1', 'a2', 'b1', 'b3', 'b2'])
  })

  it("leaves out a removed folder's sessions", () => {
    assert.ok(!ids(railSessionOrder(folders, sessionsOf, exists)).includes('x1'))
  })

  it('keeps an ended session and lists a child whose parent ended at the top level, in rail order', () => {
    // Control: filtering by `exists` drops b1 from the list.
    const ended = new Map(sessionsByItem)
    ended.set('b', [{ id: 'b1', ended: true }, { id: 'b2' }, { id: 'b3', lineage: { parentId: 'b1' } }])
    const order = railSessionOrder(folders, (id) => ended.get(id) ?? [], exists)
    assert.deepEqual(ids(order), ['g1', 'a1', 'a2', 'b1', 'b2', 'b3'])
  })
})

describe('nextInOrder', () => {
  const order = railSessionOrder(folders, sessionsOf, exists)

  it('goes to the next candidate after the focused session, wrapping', () => {
    const idle = new Set(['a1', 'b2'])
    assert.equal(nextInOrder(order, idle, 'a1')?.session.id, 'b2')
    assert.equal(nextInOrder(order, idle, 'b2')?.session.id, 'a1')
    assert.equal(nextInOrder(order, idle, 'b1')?.session.id, 'b2')
  })

  it('starts from the beginning with no focused session, or one not in the order', () => {
    const idle = new Set(['b2', 'a2'])
    assert.equal(nextInOrder(order, idle, null)?.session.id, 'a2')
    assert.equal(nextInOrder(order, idle, 'x1')?.session.id, 'a2')
  })

  it('returns the focused session itself when it is the only candidate, and null for none', () => {
    assert.equal(nextInOrder(order, new Set(['a1']), 'a1')?.session.id, 'a1')
    assert.equal(nextInOrder(order, new Set(), 'a1'), null)
    assert.equal(nextInOrder([], new Set(['a1']), null), null)
  })
})
