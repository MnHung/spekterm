import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { IntakeStore } from './intake-store'
import { AttentionLog } from './remote-attention'
import { createRemoteHost, type HostDeps } from './remote-host'
import { RemoteError } from './remote-frames'
import { OPERATIONS, openRemoteSession, operationNames, type RemoteHost } from './remote-protocol'
import type { RemoteConnection } from './remote-server'

function connection(): RemoteConnection & { frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = []
  return { id: 7, deviceId: 'd', send: (text) => void frames.push(JSON.parse(text)), isOpen: () => true, frames }
}

async function call(session: ReturnType<typeof openRemoteSession>, conn: ReturnType<typeof connection>, m: string, p = {}) {
  const id = conn.frames.length + 1000
  session.onRequest({ t: 'req', id, m, p })
  for (let i = 0; i < 20; i += 1) {
    const found = conn.frames.find((frame) => frame.id === id)
    if (found) return found as { ok: boolean; r?: Record<string, unknown>; e?: { code: string } }
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`no response to ${m}`)
}

/** The real host with no window: only the folder list and the attention log are reachable. */
function noWindowHost(): RemoteHost {
  const attention = new AttentionLog({ now: () => 0, sessionInfo: () => null, displayedInFocus: () => false, newEpoch: () => 'e' })
  attention.setEnabled(true)
  return createRemoteHost({
    window: () => null,
    folders: { list: () => [{ id: 'f1', name: 'api-server', path: '/x', status: 'ok', pinned: false, hasOpenSpec: true, branch: 'main' }] },
    sessions: { view: () => [] },
    terminal: () => undefined,
    attention,
    // An empty inbox: `inbox.accept` asks whether the item is a repeating proposal before it needs a window.
    intake: { store: { get: () => undefined, list: () => [] } },
    request: () => Promise.reject(new Error('the renderer must not be asked')),
    setRemoteWatched: () => undefined,
  } as unknown as HostDeps)
}

test('an unknown operation is refused without effect, and the connection stays usable', async () => {
  const conn = connection()
  const session = openRemoteSession(noWindowHost(), conn)
  const unknown = await call(session, conn, 'fs.writeFile', { path: '/etc/passwd', content: 'x' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.e?.code, 'UNKNOWN_OPERATION')
  const prototype = await call(session, conn, 'constructor')
  assert.equal(prototype.e?.code, 'UNKNOWN_OPERATION', 'inherited names are not operations')
  const list = await call(session, conn, 'sessions.list')
  assert.equal(list.ok, true)
})

test('with no window: create, wake, accept and keep answer NO_WINDOW, and the session list is empty and says so', async () => {
  const conn = connection()
  const session = openRemoteSession(noWindowHost(), conn)
  for (const [m, p] of [
    ['sessions.create', { folderId: 'f1', target: 'claude' }],
    ['sessions.wake', { sessionId: 's1' }],
    ['inbox.accept', { adapter: 'file', id: 'i1', folderId: 'f1' }],
    ['sessions.keep', { sessionId: 's1' }],
  ] as const) {
    const response = await call(session, conn, m, p)
    assert.equal(response.e?.code, 'NO_WINDOW', m)
  }
  const list = await call(session, conn, 'sessions.list')
  assert.equal(list.r?.window, false)
  assert.deepEqual(list.r?.sessions, [])
  assert.equal((list.r?.folders as unknown[]).length, 1)
})

test('accepting without a folder is refused before anything else', async () => {
  const conn = connection()
  const session = openRemoteSession(noWindowHost(), conn)
  const response = await call(session, conn, 'inbox.accept', { adapter: 'file', id: 'i1' })
  assert.equal(response.e?.code, 'FOLDER_REQUIRED')
})

test('watching the attention stream again replaces the earlier watch', async () => {
  const attention = new AttentionLog({
    now: () => 0,
    sessionInfo: () => ({ folderName: null, title: 't' }),
    displayedInFocus: () => false,
    newEpoch: () => 'e',
  })
  attention.setEnabled(true)
  const host = { watchAttention: (after, listener) => attention.watch(after, listener), setWatched: () => undefined } as Partial<RemoteHost>
  const conn = connection()
  const session = openRemoteSession(host as RemoteHost, conn)
  await call(session, conn, 'attention.watch')
  await call(session, conn, 'attention.watch')
  attention.onWait('s', { state: 'ready', turnEnded: true, choicesRaised: [] })
  assert.equal(conn.frames.filter((frame) => frame.k === 'attention').length, 1)
})

test('a connection watches one folder’s OpenSpec: replaced, stopped, never recorded when refused', async () => {
  const asked: string[] = []
  const host = {
    openspecWatch: async (folderId: string) => {
      asked.push(folderId)
      if (folderId === 'gone') throw new RemoteError('NOT_FOUND', 'unknown folder: gone')
    },
    setWatched: () => undefined,
  } as Partial<RemoteHost>
  const conn = connection()
  const session = openRemoteSession(host as RemoteHost, conn)
  assert.equal((await call(session, conn, 'openspec.watch', { folderId: 'f1' })).ok, true)
  assert.equal(session.watchesOpenSpec('f1'), true)
  await call(session, conn, 'openspec.watch', { folderId: 'f2' })
  assert.deepEqual([session.watchesOpenSpec('f1'), session.watchesOpenSpec('f2')], [false, true], 'watching again replaces')
  assert.equal((await call(session, conn, 'openspec.watch', { folderId: 'gone' })).e?.code, 'NOT_FOUND')
  assert.equal(session.watchesOpenSpec('gone'), false, 'a refused watch is not recorded')
  assert.equal((await call(session, conn, 'openspec.watch', { folderId: 3 })).e?.code, 'BAD_PARAMS')
  await call(session, conn, 'openspec.watch', { folderId: null })
  assert.equal(session.watchesOpenSpec('f2'), false, 'null stops watching')
  await call(session, conn, 'openspec.watch', { folderId: 'f1' })
  await call(session, conn, 'openspec.watch')
  assert.equal(session.watchesOpenSpec('f1'), false, 'no folder stops watching')
  assert.deepEqual(asked, ['f1', 'f2', 'gone', 'f1'], 'stopping asks the host nothing')
  await call(session, conn, 'openspec.watch', { folderId: 'f1' })
  session.dispose()
  assert.equal(session.watchesOpenSpec('f1'), false, 'the watch ends with the connection')
  assert.ok(operationNames().includes('openspec.watch'), 'listed in the authentication answer’s operations')
})

test('the allow-list has no way to resize a terminal, write a file, or touch settings and credentials', () => {
  // The one file operation reads a file the agent sent to the user, addressed by its call (`remote-sent-files`).
  for (const name of Object.keys(OPERATIONS).filter((n) => n !== 'files.read')) {
    assert.doesNotMatch(name, /resize|write|file|setting|slack|secret|credential|delete|kill/i, name)
  }
  assert.ok(Object.keys(OPERATIONS).includes('files.read'))
  // Ending a session is exactly these two, both through the idle check (`remote-hibernate-close`).
  assert.deepEqual(
    Object.keys(OPERATIONS).filter((name) => /^(hibernate|close|end|stop|exit|remove)$/i.test(name.split('.').at(-1) ?? '')),
    ['sessions.hibernate', 'sessions.close'],
  )
  assert.ok(operationNames().includes('hello') && operationNames().includes('pair'))
})

test('conversation.answer checks the decision and refuses a conversation that is not watched', async () => {
  const conn = connection()
  const session = openRemoteSession(noWindowHost(), conn)
  const bad = await call(session, conn, 'conversation.answer', { sessionId: 's1', promptId: 'r1', decision: 'yes' })
  assert.equal(bad.e?.code, 'BAD_PARAMS')
  const missing = await call(session, conn, 'conversation.answer', { sessionId: 's1', decision: 'deny' })
  assert.equal(missing.e?.code, 'BAD_PARAMS')
  const unwatched = await call(session, conn, 'conversation.answer', { sessionId: 's1', promptId: 'r1', decision: 'deny' })
  assert.equal(unwatched.e?.code, 'NOT_WATCHING')
})

test('sessions.rename cleans the name, allows an empty one, and is refused with no window', async () => {
  const { cleanName } = await import('./remote-protocol')
  assert.equal(cleanName('fix\nthe\tlogin\x07'), 'fixthelogin')
  assert.equal([...cleanName('名'.repeat(300))].length, 200)
  assert.equal(cleanName(''), '')
  const conn = connection()
  const session = openRemoteSession(noWindowHost(), conn)
  const refused = await call(session, conn, 'sessions.rename', { sessionId: 's1', name: 'Fix login' })
  assert.equal(refused.e?.code, 'NO_WINDOW')
  const empty = await call(session, conn, 'sessions.rename', { sessionId: 's1', name: '' })
  assert.equal(empty.e?.code, 'NO_WINDOW', 'an empty name is a valid request')
  const missing = await call(session, conn, 'sessions.rename', { sessionId: 's1' })
  assert.equal(missing.e?.code, 'BAD_PARAMS')
})

test('a rename reaches the interface with the cleaned name', async () => {
  const asked: unknown[] = []
  const host = createRemoteHost({
    window: () => 1,
    folders: { list: () => [] },
    sessions: { view: () => [] },
    terminal: () => ({ sizeOf: () => null }),
    request: async (_contents: number, action: unknown) => {
      asked.push(action)
      return { ok: true, sessionId: 's1' }
    },
    setRemoteWatched: () => undefined,
  } as unknown as HostDeps)
  const conn = connection()
  const session = openRemoteSession(host, conn)
  const response = await call(session, conn, 'sessions.rename', { sessionId: 's1', name: ' Fix\nlogin ' })
  assert.equal(response.ok, true)
  assert.deepEqual(asked, [{ kind: 'rename', sessionId: 's1', name: ' Fixlogin ' }])
})

test('a session ending stops its conversation watch, tells how, and withdraws the displayed report', async () => {
  const watched: [string, string | null][] = []
  let stopped = 0
  const host = {
    followConversation: () => ({ stop: () => void (stopped += 1) }),
    setWatched: (key: string, sessionId: string | null) => void watched.push([key, sessionId]),
  } as Partial<RemoteHost> as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  assert.equal((await call(session, conn, 'conversation.watch', { sessionId: 's1' })).ok, true)

  session.sessionEnded('s2', 'closed')
  assert.equal(stopped, 0, 'another session leaves the watch alone')
  assert.equal(conn.frames.filter((frame) => frame.k === 'conversation.ended').length, 0)

  session.sessionEnded('s1', 'hibernated')
  assert.equal(stopped, 1)
  assert.deepEqual(
    conn.frames.filter((frame) => frame.k === 'conversation.ended').map((frame) => frame.d),
    [{ sessionId: 's1', reason: 'hibernated' }],
  )
  assert.deepEqual(watched.at(-1), ['remote:7:conversation', null], 'the session no longer counts as displayed')

  session.sessionEnded('s1', 'closed')
  assert.equal(conn.frames.filter((frame) => frame.k === 'conversation.ended').length, 1, 'no watch, nothing told')
})

test('hibernate and close read force as true only, refuse a non-boolean, and need a session id', async () => {
  const asked: unknown[] = []
  const host = {
    perform: async (action: unknown) => {
      asked.push(action)
      return { sessionId: 's1' }
    },
  } as Partial<RemoteHost> as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  for (const m of ['sessions.hibernate', 'sessions.close']) {
    const kind = m.slice('sessions.'.length)
    asked.length = 0
    for (const force of [undefined, null, false]) assert.equal((await call(session, conn, m, { sessionId: 's1', force })).ok, true)
    assert.equal((await call(session, conn, m, { sessionId: 's1', force: true })).ok, true)
    assert.deepEqual(asked, [
      { kind, sessionId: 's1', force: false },
      { kind, sessionId: 's1', force: false },
      { kind, sessionId: 's1', force: false },
      { kind, sessionId: 's1', force: true },
    ])
    assert.equal((await call(session, conn, m, { sessionId: 's1', force: 'yes' })).e?.code, 'BAD_PARAMS')
    assert.equal((await call(session, conn, m, {})).e?.code, 'BAD_PARAMS')
  }
})

test('sessions.keep needs a session id and goes to the host', async () => {
  const asked: string[] = []
  const host = {
    keep: async (sessionId: string) => {
      asked.push(sessionId)
      return { sessionId }
    },
  } as Partial<RemoteHost> as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  assert.deepEqual((await call(session, conn, 'sessions.keep', { sessionId: 's1' })).r, { sessionId: 's1' })
  assert.equal((await call(session, conn, 'sessions.keep', {})).e?.code, 'BAD_PARAMS')
  assert.equal((await call(session, conn, 'sessions.keep', { sessionId: 3 })).e?.code, 'BAD_PARAMS')
  assert.deepEqual(asked, ['s1'])
})

test('sessions.submitPrefill needs a session and a fill id, goes to the host, and its errors keep their codes', async () => {
  const asked: [string, string][] = []
  const host = {
    submitPrefill: async (sessionId: string, prefillId: string) => {
      asked.push([sessionId, prefillId])
      if (prefillId === 'stale') throw new RemoteError('PREFILL_GONE', 'not waiting')
      return { outcome: 'confirmed' as const }
    },
  } as Partial<RemoteHost> as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  assert.ok(operationNames().includes('sessions.submitPrefill'), 'listed in the authentication answer’s operations')
  assert.deepEqual((await call(session, conn, 'sessions.submitPrefill', { sessionId: 's1', prefillId: 'p1' })).r, { outcome: 'confirmed' })
  assert.equal((await call(session, conn, 'sessions.submitPrefill', { sessionId: 's1', prefillId: 'stale' })).e?.code, 'PREFILL_GONE')
  for (const p of [{}, { sessionId: 's1' }, { prefillId: 'p1' }, { sessionId: 's1', prefillId: '' }, { sessionId: 's1', prefillId: 3 }]) {
    assert.equal((await call(session, conn, 'sessions.submitPrefill', p)).e?.code, 'BAD_PARAMS', JSON.stringify(p))
  }
  assert.deepEqual(asked, [['s1', 'p1'], ['s1', 'stale']])
})

test('with no window, sessions.submitPrefill answers NO_WINDOW', async () => {
  const conn = connection()
  const session = openRemoteSession(noWindowHost(), conn)
  assert.equal((await call(session, conn, 'sessions.submitPrefill', { sessionId: 's1', prefillId: 'p1' })).e?.code, 'NO_WINDOW')
})

test('a conversation watch sends the agent status with its first events, and the host stops it with the watch', async () => {
  let stopped = 0
  let later: ((view: { sessionId: string; model?: string }) => void) | null = null
  const host = {
    followConversation: (_id: string, sink: { status: (view: { sessionId: string; model?: string }) => void }) => {
      sink.status({ sessionId: 's1', model: 'Opus' })
      later = sink.status
      return { stop: () => void (stopped += 1) }
    },
    setWatched: () => undefined,
  } as unknown as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  assert.equal((await call(session, conn, 'conversation.watch', { sessionId: 's1' })).ok, true)
  const kinds = conn.frames.map((frame) => (frame.t === 'evt' ? frame.k : frame.t))
  assert.deepEqual(kinds, ['conversation.status', 'res'], 'the first status comes before the answer, as the first update does')
  assert.deepEqual(conn.frames[0].d, { sessionId: 's1', model: 'Opus' })
  later!({ sessionId: 's1', model: 'Sonnet' })
  assert.deepEqual(conn.frames.at(-1), { t: 'evt', k: 'conversation.status', d: { sessionId: 's1', model: 'Sonnet' } })
  assert.equal((await call(session, conn, 'conversation.unwatch')).ok, true)
  assert.equal(stopped, 1)
})

test('a conversation watch sends the skill list as conversation.skills, null included', async () => {
  let report: ((skills: unknown) => void) | null = null
  const host = {
    followConversation: (_id: string, sink: { skills: (skills: unknown) => void }) => {
      report = sink.skills
      return { stop: () => undefined }
    },
    setWatched: () => undefined,
  } as unknown as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  assert.equal((await call(session, conn, 'conversation.watch', { sessionId: 's1' })).ok, true)
  report!(null)
  report!([{ name: 'pdf', description: 'Read PDFs.' }])
  assert.deepEqual(
    conn.frames.filter((frame) => frame.k === 'conversation.skills').map((frame) => frame.d),
    [
      { sessionId: 's1', skills: null },
      { sessionId: 's1', skills: [{ name: 'pdf', description: 'Read PDFs.' }] },
    ],
  )
})

test('a repeating proposal: accepting is refused before anything else and leaves it pending; ignoring declines it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'remote-proposal-'))
  try {
    const store = new IntakeStore(join(base, 'intake.json'))
    const verified = { adapter: 'handoff', originKind: 'session', originId: 'f1' }
    const authored = { title: 'weekly', body: 'review', actor: 'alpha', originLabel: 'alpha' }
    store.add({ id: 'p1', verified: { ...verified, repeat: '0 21 * * 3' }, authored, receivedAt: 1 })
    store.add({ id: 'o1', verified: { ...verified, repeat: '0 21 * * 3', recurrenceId: 'p0', scheduledAt: 9e12 }, authored, receivedAt: 1 }, { opensAt: 9e12 })
    const host = createRemoteHost({
      window: () => null,
      folders: { list: () => [{ id: 'f1', name: 'api-server', path: '/x', status: 'ok', pinned: false, hasOpenSpec: true, branch: 'main' }] },
      sessions: { view: () => [] },
      terminal: () => undefined,
      intake: { store },
      routing: { get: () => ({ rules: [], fallbackFolderId: null }) },
      request: () => Promise.reject(new Error('the renderer must not be asked')),
      setRemoteWatched: () => undefined,
    } as unknown as HostDeps)
    const conn = connection()
    const session = openRemoteSession(host, conn)
    const accepted = await call(session, conn, 'inbox.accept', { adapter: 'handoff', id: 'p1', folderId: 'f1' })
    assert.equal(accepted.e?.code, 'APPROVE_ON_DESKTOP')
    assert.equal(store.get('handoff', 'p1')?.state, 'pending')
    // An occurrence is not a proposal: its accept goes on to the window (none here).
    const occurrence = await call(session, conn, 'inbox.accept', { adapter: 'handoff', id: 'o1', folderId: 'f1' })
    assert.equal(occurrence.e?.code, 'NO_WINDOW')
    const list = await call(session, conn, 'inbox.list')
    const items = (list.r?.items ?? []) as { id: string; recurrence?: { role: string; repeat: string; next?: number[] } }[]
    assert.equal(items.find((i) => i.id === 'p1')?.recurrence?.role, 'proposal')
    assert.equal(items.find((i) => i.id === 'p1')?.recurrence?.next?.length, 3)
    assert.equal(items.find((i) => i.id === 'o1')?.recurrence?.role, 'occurrence')
    await call(session, conn, 'inbox.ignore', { adapter: 'handoff', id: 'p1' })
    assert.equal(store.get('handoff', 'p1')?.state, 'dismissed')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('images.read checks its parameters, defaults offset and length, goes to the host, and is listed (remote-result-images D5)', async () => {
  const asked: unknown[] = []
  const host = {
    readResultImage: async (sessionId: string, p: unknown) => {
      asked.push([sessionId, p])
      return { size: 1, mediaType: 'image/png', version: 'v', offset: 0, data: 'eA==', complete: true }
    },
  } as Partial<RemoteHost> as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  const ok = await call(session, conn, 'images.read', { sessionId: 's1', toolUseId: 't1', index: 0 })
  assert.equal(ok.ok, true)
  assert.equal(ok.r?.mediaType, 'image/png')
  await call(session, conn, 'images.read', { sessionId: 's1', toolUseId: 't1', index: 1, offset: 10, length: 65536, version: 'v1' })
  assert.deepEqual(asked, [
    ['s1', { toolUseId: 't1', index: 0, offset: 0, length: 524288, version: undefined }],
    ['s1', { toolUseId: 't1', index: 1, offset: 10, length: 65536, version: 'v1' }],
  ])
  const bad = [
    { toolUseId: 't1', index: 0 },
    { sessionId: 's1', index: 0 },
    { sessionId: 's1', toolUseId: 't1' },
    { sessionId: 's1', toolUseId: 't1', index: -1 },
    { sessionId: 's1', toolUseId: 't1', index: 0.5 },
    { sessionId: 's1', toolUseId: 't1', index: 0, offset: -1 },
    { sessionId: 's1', toolUseId: 't1', index: 0, length: 0 },
    { sessionId: 's1', toolUseId: 't1', index: 0, length: 524289 },
    { sessionId: 's1', toolUseId: 't1', index: 0, version: 3 },
  ]
  for (const p of bad) assert.equal((await call(session, conn, 'images.read', p)).e?.code, 'BAD_PARAMS', JSON.stringify(p))
  assert.equal(asked.length, 2)
  assert.ok(operationNames().includes('images.read'), 'listed in the authentication answer’s operations')
})

test('files.read checks its parameters, defaults offset and length, and goes to the host (remote-tool-detail D6)', async () => {
  const asked: unknown[] = []
  const host = {
    readSentFile: async (sessionId: string, p: unknown) => {
      asked.push([sessionId, p])
      return { name: 'a.md', size: 1, mediaType: 'text/markdown', version: 'v', offset: 0, data: 'eA==', complete: true }
    },
  } as Partial<RemoteHost> as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  const ok = await call(session, conn, 'files.read', { sessionId: 's1', toolUseId: 't1', index: 0 })
  assert.equal(ok.ok, true)
  assert.equal(ok.r?.name, 'a.md')
  await call(session, conn, 'files.read', { sessionId: 's1', toolUseId: 't1', index: 2, offset: 10, length: 65536, version: 'v1' })
  assert.deepEqual(asked, [
    ['s1', { toolUseId: 't1', index: 0, offset: 0, length: 524288, version: undefined }],
    ['s1', { toolUseId: 't1', index: 2, offset: 10, length: 65536, version: 'v1' }],
  ])
  const bad = [
    { toolUseId: 't1', index: 0 },
    { sessionId: 's1', index: 0 },
    { sessionId: 's1', toolUseId: 't1' },
    { sessionId: 's1', toolUseId: 't1', index: -1 },
    { sessionId: 's1', toolUseId: 't1', index: 1.5 },
    { sessionId: 's1', toolUseId: 't1', index: 0, offset: -1 },
    { sessionId: 's1', toolUseId: 't1', index: 0, length: 0 },
    { sessionId: 's1', toolUseId: 't1', index: 0, length: 524289 },
    { sessionId: 's1', toolUseId: 't1', index: 0, version: 3 },
    { sessionId: 's1', toolUseId: 't1', index: 0, path: '/etc/passwd' },
  ]
  for (const p of bad.slice(0, -1)) assert.equal((await call(session, conn, 'files.read', p)).e?.code, 'BAD_PARAMS', JSON.stringify(p))
  // A path parameter is not one: it is ignored, and the call is the one addressed by id.
  await call(session, conn, 'files.read', bad.at(-1) as Record<string, unknown>)
  assert.equal(asked.length, 3)
  assert.deepEqual((asked[2] as unknown[])[1], { toolUseId: 't1', index: 0, offset: 0, length: 524288, version: undefined })
})

test('conversation.setModel writes /model <name> as a reply and refuses a name outside the charset (remote-model-switch D4)', async () => {
  const replies: unknown[][] = []
  const host = {
    reply: (...args: unknown[]) => {
      replies.push(args)
      return Promise.resolve({ outcome: 'submitted', text: args[2] })
    },
  } as unknown as RemoteHost
  const conn = connection()
  const session = openRemoteSession(host, conn)
  for (const model of ['sonnet', 'opus[1m]', 'claude-sonnet-4@20250514']) {
    const ok = await call(session, conn, 'conversation.setModel', { sessionId: 's1', model })
    assert.equal(ok.ok, true, model)
    assert.deepEqual(ok.r, { outcome: 'submitted', text: `/model ${model}` })
  }
  assert.deepEqual(replies.map((args) => [args[1], args[2], args[3]]), [
    ['s1', '/model sonnet', []],
    ['s1', '/model opus[1m]', []],
    ['s1', '/model claude-sonnet-4@20250514', []],
  ])
  const before = replies.length
  for (const model of ['', 'a b', '-x', 'a'.repeat(101), 'a\nb', "a'b", 5, undefined]) {
    const bad = await call(session, conn, 'conversation.setModel', { sessionId: 's1', model })
    assert.equal(bad.ok, false, String(model))
    assert.equal(bad.e?.code, 'BAD_PARAMS', String(model))
  }
  assert.equal(replies.length, before, 'nothing is written for a refused name')
  assert.ok(operationNames().includes('conversation.setModel'), 'listed in the authentication answer’s operations')
})
