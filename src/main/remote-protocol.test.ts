import assert from 'node:assert/strict'
import test from 'node:test'
import { AttentionLog } from './remote-attention'
import { createRemoteHost, type HostDeps } from './remote-host'
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

test('with no window: create, wake and accept answer NO_WINDOW, and the session list is empty and says so', async () => {
  const conn = connection()
  const session = openRemoteSession(noWindowHost(), conn)
  for (const [m, p] of [
    ['sessions.create', { folderId: 'f1', target: 'claude' }],
    ['sessions.wake', { sessionId: 's1' }],
    ['inbox.accept', { adapter: 'file', id: 'i1', folderId: 'f1' }],
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
  attention.onWait('s', { state: 'ready', turnEnded: true, choiceRaised: null })
  assert.equal(conn.frames.filter((frame) => frame.k === 'attention').length, 1)
})

test('the allow-list has no way to resize a terminal, write a file, or touch settings and credentials', () => {
  for (const name of Object.keys(OPERATIONS)) {
    assert.doesNotMatch(name, /resize|write|file|setting|slack|secret|credential|delete|kill|hibernate/i, name)
  }
  assert.ok(operationNames().includes('hello') && operationNames().includes('pair'))
})
