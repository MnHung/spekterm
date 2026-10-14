import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteHost, type HostDeps } from './remote-host'
import { RemoteOutput } from './remote-output'

function host(overrides: Partial<HostDeps> = {}) {
  const output = new RemoteOutput()
  output.setEnabled(true)
  const writes: string[] = []
  const deps = {
    window: () => 1,
    folders: { list: () => [{ id: 'f1', name: 'api-server', path: '/x', status: 'ok', pinned: true, hasOpenSpec: false, branch: 'main' }] },
    sessions: {
      view: () => [
        { session: { id: 'a', folderId: 'f1', spawnTarget: 'claude', ordinal: 1, customTitle: 'Fix login' }, provisional: false },
        { session: { id: 'b', folderId: null, spawnTarget: 'shell', ordinal: 2 }, provisional: false },
        {
          session: { id: 'c', folderId: 'f1', spawnTarget: 'claude', ordinal: 3, lineage: { parentId: 'a', origin: {}, parentTitle: 'Fix login' } },
          provisional: true,
        },
      ],
      readHandoffBrief: () => null,
    },
    terminal: () => ({
      liveSessionIds: () => ['a', 'b'],
      sizeOf: (id: string) => (id === 'a' || id === 'b' ? { cols: 120, rows: 40 } : null),
      write: (_id: string, data: string) => void writes.push(data),
      agentSourceOf: () => null,
    }),
    output,
    request: () => Promise.resolve({ ok: true, sessionId: 'new' }),
    setRemoteWatched: () => undefined,
    ...overrides,
  } as unknown as HostDeps
  return { host: createRemoteHost(deps), output, writes }
}

test('the session list carries folder, target, label, liveness, wait state and lineage', () => {
  const list = host().host.sessionList()
  assert.equal(list.window, true)
  assert.deepEqual(list.folders, [{ id: 'f1', name: 'api-server', branch: 'main', pinned: true, hasOpenSpec: false }])
  assert.deepEqual(
    list.sessions.map((s) => [s.id, s.folderId, s.target, s.label, s.running, s.wait, s.lineage?.parentId]),
    [
      ['a', 'f1', 'claude', 'Fix login', true, 'unknown', undefined],
      ['b', null, 'shell', 'shell 2', true, undefined, undefined],
      ['c', 'f1', 'claude', 'claude 3', false, 'unknown', 'a'],
    ],
  )
})

test('a terminal watch carries the pty size; input reaches a running session only', () => {
  const { host: h, output, writes } = host()
  output.spawned('a')
  output.data('a', 'hello')
  const watch = h.watchTerminal('a', undefined, { data: () => undefined, size: () => undefined, ended: () => undefined })
  assert.equal(watch?.snapshot.cols, 120)
  assert.equal(watch?.snapshot.rows, 40)
  assert.equal(watch?.snapshot.data, 'hello')
  assert.equal(h.writeTerminal('a', 'ls\r'), true)
  assert.equal(h.writeTerminal('c', 'ls\r'), false, 'a dormant session has no pty')
  assert.deepEqual(writes, ['ls\r'])
})

test('a renderer failure becomes an error code; an unknown code becomes CREATE_FAILED', async () => {
  const failing = host({ request: () => Promise.resolve({ ok: false, code: 'weird', message: 'no' }) }).host
  await assert.rejects(failing.perform({ kind: 'create', folderId: 'f1', target: 'claude' }), { code: 'CREATE_FAILED' })
  const missing = host({ request: () => Promise.resolve({ ok: false, code: 'NOT_FOUND' }) }).host
  await assert.rejects(missing.perform({ kind: 'wake', sessionId: 'zz' }), { code: 'NOT_FOUND' })
  assert.deepEqual(await host().host.perform({ kind: 'create', folderId: 'f1', target: 'shell' }), { sessionId: 'new' })
})

test('OpenSpec reads go through the side panel’s service and its lookup errors become NOT_FOUND', async () => {
  const { OpenSpecServiceError } = await import('./openspec-service')
  const asked: string[] = []
  const openspec = {
    getChange: async (folderId: string, slug: string) => {
      asked.push(`${folderId}/${slug}`)
      // The service answers from its scan table; a slug not in it is NOT_FOUND (`openspec-service.test.ts`).
      throw new OpenSpecServiceError('NOT_FOUND', `no change ${slug}`)
    },
  }
  const h = host({ openspec: () => openspec as never }).host
  await assert.rejects(h.openspecChange('f1', '../../etc'), { code: 'NOT_FOUND' })
  assert.deepEqual(asked, ['f1/../../etc'], 'the identifier went to the lookup, not to the file system')
})

test('waking a session that has a process answers at once, without asking the interface', async () => {
  let asked = 0
  const h = host({ request: () => ((asked += 1), Promise.resolve({ ok: true, sessionId: 'x' })) }).host
  assert.deepEqual(await h.perform({ kind: 'wake', sessionId: 'a' }), { sessionId: 'a' })
  assert.equal(asked, 0)
  await h.perform({ kind: 'wake', sessionId: 'c' })
  assert.equal(asked, 1, 'a session with no process is woken by the interface')
})
