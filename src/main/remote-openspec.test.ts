import assert from 'node:assert/strict'
import test from 'node:test'
import { FRAME_MAX_BYTES } from './remote-frames'
import { ANSWER_BUDGET_BYTES, remoteChange, remoteChanges, remoteSpec, remoteSpecs } from './remote-openspec'

/** Views as the service hands them over, plus what a later core or side panel might add. */
const origin = { key: 'bf3be879', branch: 'feat', vcs: 'git', isMain: false, isFolderRoot: false }
const extras = { relPath: 'openspec/changes/one', path: '/home/me/repo/openspec', futureField: 1 }

function summary(slug: string, more: Record<string, unknown> = {}) {
  return {
    slug,
    date: null,
    timestamp: '2026-01-02T03:04:05+08:00',
    createdDate: '2026-01-02',
    archivedDate: null,
    description: slug.replace(/-/g, ' '),
    status: 'active',
    hasProposal: true,
    hasDesign: false,
    hasTasks: true,
    hasSpecs: false,
    artifactCount: 2,
    schema: 'spec-driven',
    defaultSchema: 'spec-driven',
    taskStats: { total: 2, completed: 1 },
    ...extras,
    ...more,
  }
}

function detail(artifacts: unknown[], more: Record<string, unknown> = {}) {
  return {
    slug: 'one',
    status: 'active',
    createdDate: '2026-01-02',
    archivedDate: null,
    schema: 'spec-driven',
    defaultSchema: 'spec-driven',
    artifacts,
    schemaOrder: undefined,
    missingArtifacts: ['design'],
    relPath: 'openspec/changes/one',
    ...more,
  }
}

const md = (id: string, content: string) => ({ id, title: id, kind: 'markdown', content, ...extras })

test('a change listing carries exactly the documented fields, and the worktree as { branch, isMain }', () => {
  const view = {
    active: [summary('one', { worktree: origin, isCurrent: true })],
    archived: [summary('2026-01-01-old', { status: 'archived' })],
    defaultSchema: 'spec-driven',
  }
  const result = remoteChanges(view as never)
  assert.deepEqual(Object.keys(result), ['active', 'archived'])
  assert.deepEqual(Object.keys(result.active[0]).sort(), [
    'archivedDate', 'createdDate', 'description', 'hasDesign', 'hasProposal', 'hasSpecs', 'hasTasks', 'slug', 'status',
    'taskStats', 'timestamp', 'worktree',
  ])
  assert.deepEqual(result.active[0].worktree, { branch: 'feat', isMain: false })
  assert.equal('worktree' in result.archived[0], false, 'no worktree without an origin')
  assert.equal(JSON.stringify(result).includes('/home/me'), false)
})

test('a spec list and a spec carry exactly the documented fields', () => {
  assert.deepEqual(remoteSpecs([{ topic: 'auth', relatedChangeCount: 3, ...extras }] as never), [
    { topic: 'auth', relatedChangeCount: 3 },
  ])
  const spec = remoteSpec({
    topic: 'auth',
    content: '# auth\n',
    relatedChanges: ['one'],
    history: [{ slug: 'one', date: null, timestamp: null, description: 'one', status: 'active', ...extras }],
    origin: { ...origin, isMain: true, branch: 'main' },
    ...extras,
  } as never)
  assert.deepEqual(spec, {
    topic: 'auth',
    content: '# auth\n',
    history: [{ slug: 'one', status: 'active', description: 'one', date: null, timestamp: null }],
    origin: { branch: 'main', isMain: true },
  })
})

test('a change carries exactly the documented fields; tasks as the parsed list; deltas by topic', () => {
  const view = detail(
    [
      md('proposal', '# p'),
      {
        id: 'tasks',
        title: 'Tasks',
        kind: 'tasks',
        content: '- [x] 1.1 a\n- [ ] 1.2 b\n',
        tasks: { total: 2, completed: 1, sections: [{ title: '1. A', tasks: [{ text: '1.1 a', completed: true, x: 1 }, { text: '1.2 b', completed: false }], extra: 1 }], more: 1 },
        relPath: 'x/tasks.md',
      },
      { id: 'specs', title: 'Specs', kind: 'specs', specs: [{ topic: 'auth', content: '## ADDED', relPath: 'x/spec.md' }], relPath: null },
      { id: 'notes', title: 'notes.yaml', kind: 'data', content: 'k: v\n', relPath: 'x/notes.yaml' },
    ],
    { worktree: origin },
  )
  const result = remoteChange(view as never)
  assert.deepEqual(Object.keys(result).sort(), ['archivedDate', 'artifacts', 'createdDate', 'slug', 'status', 'worktree'])
  const byId = Object.fromEntries(result.artifacts.map((a) => [a.id, a]))
  assert.deepEqual(byId.proposal, { id: 'proposal', title: 'proposal', kind: 'markdown', content: '# p' })
  assert.deepEqual(byId.tasks, {
    id: 'tasks',
    title: 'Tasks',
    kind: 'tasks',
    tasks: { total: 2, completed: 1, sections: [{ title: '1. A', tasks: [{ text: '1.1 a', completed: true }, { text: '1.2 b', completed: false }] }] },
  })
  assert.deepEqual(byId.specs, { id: 'specs', title: 'Specs', kind: 'specs', specs: [{ topic: 'auth', content: '## ADDED' }] })
  assert.deepEqual(byId.notes, { id: 'notes', title: 'notes.yaml', kind: 'data', content: 'k: v\n' })
})

test('artifacts come out in schemaOrder, not in the order they came in nor in the default narrative order', () => {
  // Input order and DEFAULT_ORDER (proposal, design, specs, tasks) both differ from the schema's order.
  const view = detail([md('proposal', 'p'), md('design', 'd'), md('tasks', 't')], { schemaOrder: ['tasks', 'design', 'proposal'] })
  assert.deepEqual(remoteChange(view as never).artifacts.map((a) => a.id), ['tasks', 'design', 'proposal'])
})

test('a change within the budget is sent whole', () => {
  const result = remoteChange(detail([md('proposal', 'x'.repeat(200_000)), md('design', 'y'.repeat(200_000))]) as never)
  assert.equal(JSON.stringify(result).includes('omitted'), false)
})

test('an artifact larger than a frame is left out with its size, and the others keep their content', () => {
  const huge = 'z'.repeat(FRAME_MAX_BYTES + 10)
  const result = remoteChange(detail([md('proposal', 'small'), md('design', huge)]) as never)
  const design = result.artifacts.find((a) => a.id === 'design')
  assert.deepEqual(design, { id: 'design', title: 'design', kind: 'markdown', omitted: { bytes: huge.length + 2 } })
  assert.equal(result.artifacts.find((a) => a.id === 'proposal')?.content, 'small')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= ANSWER_BUDGET_BYTES)
})

test('medium pieces over the budget together are left out largest first, deltas as { topic, omitted }, the same way every time', () => {
  const run = () =>
    remoteChange(
      detail([
        md('proposal', 'p'.repeat(300_000)),
        md('design', 'd'.repeat(400_000)),
        { id: 'specs', title: 'Specs', kind: 'specs', specs: [{ topic: 'a', content: 'a'.repeat(400_000) }, { topic: 'b', content: 'b'.repeat(100) }] },
      ]) as never,
    )
  const result = run()
  // design and delta a tie at 400,000; display order (design before specs) breaks the tie, and dropping it fits.
  assert.deepEqual(result.artifacts.find((a) => a.id === 'design')?.omitted, { bytes: 400_002 })
  const specs = result.artifacts.find((a) => a.id === 'specs')?.specs
  assert.deepEqual(specs?.[1], { topic: 'b', content: 'b'.repeat(100) })
  assert.equal(specs?.[0].content, 'a'.repeat(400_000), 'one omission was enough')
  assert.deepEqual(run(), result)

  const deltaOnly = remoteChange(
    detail([{ id: 'specs', title: 'Specs', kind: 'specs', specs: [{ topic: 'a', content: 'a'.repeat(FRAME_MAX_BYTES) }] }]) as never,
  )
  assert.deepEqual(deltaOnly.artifacts[0].specs, [{ topic: 'a', omitted: { bytes: FRAME_MAX_BYTES + 2 } }])
})

test('many small pieces fit after omission: each saving is counted exactly, not as the piece size', () => {
  // 3,000 pieces of ~350 bytes: counting each saving as its full size would stop ~16 bytes short each time and
  // overshoot the 4 KiB reserve.
  const artifacts = Array.from({ length: 3_000 }, (_, i) => md(`a${i}`, 'q'.repeat(340)))
  const result = remoteChange(detail(artifacts) as never)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= ANSWER_BUDGET_BYTES)
  assert.ok(result.artifacts.some((a) => a.omitted) && result.artifacts.some((a) => a.content))
})

test('a list over the budget, and a change still over with everything left out, are TOO_LARGE with the limit', () => {
  const many = Array.from({ length: 4_000 }, (_, i) => summary(`change-${i}-${'n'.repeat(200)}`))
  assert.throws(() => remoteChanges({ active: many, archived: [], defaultSchema: null } as never), {
    code: 'TOO_LARGE',
    detail: { limit: FRAME_MAX_BYTES },
  })
  const titled = Array.from({ length: 12_000 }, (_, i) => ({ id: `a${i}`, title: 't'.repeat(80), kind: 'markdown', content: 'c' }))
  assert.throws(() => remoteChange(detail(titled) as never), { code: 'TOO_LARGE' })
})

test('a spec larger than a frame is sent without its content, its history intact', () => {
  const result = remoteSpec({ topic: 'big', content: 's'.repeat(FRAME_MAX_BYTES), relatedChanges: [], history: [], relPath: null } as never)
  assert.deepEqual(result, { topic: 'big', history: [], omitted: { bytes: FRAME_MAX_BYTES + 2 } })
})
