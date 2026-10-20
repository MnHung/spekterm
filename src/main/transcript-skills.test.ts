import assert from 'node:assert/strict'
import test from 'node:test'

import { foldSkills, listingOf, sameSkills } from './transcript-skills'

/** A `skill_listing` record shaped as the agent writes it (CLI 2.1.304). */
function listing(names: string[], content: string, isInitial: boolean): unknown {
  return {
    type: 'attachment',
    uuid: 'u',
    timestamp: '2026-10-20T00:00:00.000Z',
    attachment: { type: 'skill_listing', content, skillCount: names.length, isInitial, names },
  }
}

const INITIAL = listing(
  ['probe-echo', 'opsx:apply', 'opsx:apply-x', 'bare', 'pdf'],
  [
    '- probe-echo: Echo the arguments back.',
    '- opsx:apply: Implement tasks',
    '  from a change.',
    '- opsx:apply-x: Another one.',
    '- bare',
    '- pdf: Read PDFs.',
  ].join('\n'),
  true,
)

test('an initial listing gives every name with its description, in order', () => {
  assert.deepEqual(foldSkills(null, [INITIAL]), [
    { name: 'probe-echo', description: 'Echo the arguments back.' },
    { name: 'opsx:apply', description: 'Implement tasks from a change.' },
    { name: 'opsx:apply-x', description: 'Another one.' },
    { name: 'bare', description: null },
    { name: 'pdf', description: 'Read PDFs.' },
  ])
})

test('a later listing adds and updates in first-seen order', () => {
  const later = listing(['probe-echo', 'probe-new'], '- probe-echo: Edited.\n- probe-new: Newly added.', false)
  const list = foldSkills(foldSkills(null, [INITIAL]), [later])
  assert.deepEqual(list?.map((s) => s.name), ['probe-echo', 'opsx:apply', 'opsx:apply-x', 'bare', 'pdf', 'probe-new'])
  assert.equal(list?.[0].description, 'Edited.')
  assert.equal(list?.[5].description, 'Newly added.')
})

test('a later near-complete re-listing missing a name is read as an addition: the name stays', () => {
  const relist = listing(['probe-echo', 'opsx:apply', 'opsx:apply-x', 'bare'], '- probe-echo: x', false)
  assert.deepEqual(foldSkills(foldSkills(null, [INITIAL]), [relist])?.map((s) => s.name), [
    'probe-echo', 'opsx:apply', 'opsx:apply-x', 'bare', 'pdf',
  ])
})

test('a later initial listing replaces', () => {
  const again = listing(['pdf'], '- pdf: Read PDFs.', true)
  assert.deepEqual(foldSkills(foldSkills(null, [INITIAL]), [again]), [{ name: 'pdf', description: 'Read PDFs.' }])
})

test('records of another shape are ignored, never shown as skills', () => {
  const start = foldSkills(null, [INITIAL])
  const ignored = [
    { type: 'attachment', attachment: { type: 'skill_listing', content: '- a: b', isInitial: true } },
    { type: 'attachment', attachment: { type: 'skill_listing', names: ['ok', 3], isInitial: true } },
    { type: 'attachment', attachment: { type: 'skill_listing', names: ['two words'], isInitial: true } },
    { type: 'attachment', attachment: { type: 'skill_listing', names: [], isInitial: true } },
    { type: 'attachment', attachment: { type: 'agent_listing_delta', names: ['x'], isInitial: true } },
    { type: 'user', attachment: { type: 'skill_listing', names: ['x'], isInitial: true } },
    null,
    'text',
  ]
  assert.equal(foldSkills(start, ignored), start)
  assert.equal(foldSkills(null, ignored), null)
  assert.equal(listingOf(ignored[0]), null)
})

test('descriptions are cleaned and clipped', () => {
  const long = listing(['a'], `- a: ${'x'.repeat(400)}\u0007end`, true)
  const [skill] = foldSkills(null, [long]) ?? []
  assert.equal(skill.description?.length, 300)
  assert.equal(skill.description?.includes('\u0007'), false)
})

test('sameSkills compares by value', () => {
  assert.equal(sameSkills(foldSkills(null, [INITIAL]), foldSkills(null, [INITIAL])), true)
  assert.equal(sameSkills(null, null), true)
  assert.equal(sameSkills(null, []), false)
})
