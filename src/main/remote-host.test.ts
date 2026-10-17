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
    offers: { offered: () => false, withdraw: () => false },
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

test('an OpenSpec answer is the protocol’s shape, never the service’s view as it is', async () => {
  const openspec = {
    getSpecs: async () => [{ topic: 'auth', relPath: 'openspec/specs/auth/spec.md', relatedChangeCount: 1, futureField: '/home/me' }],
  }
  const h = host({ openspec: () => openspec as never }).host
  assert.deepEqual(await h.openspecSpecs('f1'), [{ topic: 'auth', relatedChangeCount: 1 }])
})

test('a read failure answers INTERNAL with a fixed message: the file system error’s path stays on the desktop', async () => {
  const { OpenSpecServiceError } = await import('./openspec-service')
  const failure = new OpenSpecServiceError('READ_FAILED', "Error: EACCES: permission denied, open '/home/me/repo/openspec/changes/x/design.md'")
  const openspec = {
    getChange: async () => {
      throw failure
    },
    getOverview: async () => {
      throw failure
    },
  }
  const h = host({ openspec: () => openspec as never }).host
  const logged = console.error
  console.error = () => undefined
  try {
    for (const call of [() => h.openspecChange('f1', 'x'), () => h.openspecWatch('f1')]) {
      await assert.rejects(call(), (error: Error & { code: string }) => {
        assert.equal(error.code, 'INTERNAL')
        assert.equal(error.message.includes('/home/me'), false, error.message)
        return true
      })
    }
  } finally {
    console.error = logged
  }
})

test('watching a folder’s OpenSpec answers once the scan is done; an unknown folder is NOT_FOUND', async () => {
  const { OpenSpecServiceError } = await import('./openspec-service')
  let finish: () => void = () => undefined
  const openspec = {
    getOverview: (folderId: string) => {
      if (folderId !== 'f1') return Promise.reject(new OpenSpecServiceError('UNKNOWN_FOLDER', `unknown folder: ${folderId}`))
      return new Promise<void>((resolve) => (finish = resolve))
    },
  }
  const h = host({ openspec: () => openspec as never }).host
  await assert.rejects(h.openspecWatch('nope'), { code: 'NOT_FOUND' })
  let answered = false
  const watch = h.openspecWatch('f1').then(() => (answered = true))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(answered, false, 'the answer waits for the scan that creates the worktree watchers')
  finish()
  await watch
  assert.equal(answered, true)
})

test('waking a session that has a process answers at once, without asking the interface', async () => {
  let asked = 0
  const h = host({ request: () => ((asked += 1), Promise.resolve({ ok: true, sessionId: 'x' })) }).host
  assert.deepEqual(await h.perform({ kind: 'wake', sessionId: 'a' }), { sessionId: 'a' })
  assert.equal(asked, 0)
  await h.perform({ kind: 'wake', sessionId: 'c' })
  assert.equal(asked, 1, 'a session with no process is woken by the interface')
})

/** A host for hibernate / close: `a` a running agent, `b` a running shell, `c` dormant. */
function sessionActions(facts: { wait?: string; unsent?: boolean; shell?: string } = {}) {
  const asked: unknown[] = []
  const refreshed: string[] = []
  let wait = facts.wait ?? 'ready'
  const made = host({
    terminal: (() => ({
      liveSessionIds: () => ['a', 'b'],
      sizeOf: (id: string) => (id === 'a' || id === 'b' ? { cols: 120, rows: 40 } : null),
      idleFactsOf: (id: string) =>
        id === 'a' ? { target: 'claude', shell: 'unknown' } : id === 'b' ? { target: 'shell', shell: facts.shell ?? 'idle' } : null,
    })) as unknown as HostDeps['terminal'],
    request: async (_contents: number, action: unknown) => {
      asked.push(action)
      return { ok: true, sessionId: (action as { sessionId: string }).sessionId }
    },
    waits: {
      refresh: (id) => {
        refreshed.push(id)
        // The periodic drain may lag: what counts is the state after the refresh.
        if (facts.wait === 'stale-ready') wait = 'awaiting-choice'
      },
      stateOf: () => wait as never,
      unsent: () => facts.unsent ?? false,
    },
  })
  return { ...made, asked, refreshed }
}

async function busy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'proceeded',
    (error: { code: string; detail?: { reason: string } }) => (error.code === 'SESSION_BUSY' ? error.detail?.reason : error.code),
  )
}

test('a device hibernates or closes a session that is not idle only when it forces', async () => {
  const cases: [Parameters<typeof sessionActions>[0], string, string][] = [
    [{ wait: 'busy' }, 'a', 'working'],
    [{ wait: 'awaiting-choice' }, 'a', 'choice'],
    [{ wait: 'unknown' }, 'a', 'unknown'],
    [{ wait: 'ready', unsent: true }, 'a', 'unsent'],
    [{ shell: 'busy' }, 'b', 'job'],
    [{ shell: 'unknown' }, 'b', 'unknown'],
  ]
  for (const [facts, sessionId, reason] of cases) {
    for (const kind of ['hibernate', 'close'] as const) {
      const { host: h, asked } = sessionActions(facts)
      assert.equal(await busy(h.perform({ kind, sessionId, force: false })), reason, `${kind} ${JSON.stringify(facts)}`)
      assert.equal(asked.length, 0, 'the interface is not asked')
      assert.equal(await busy(h.perform({ kind, sessionId, force: true })), 'proceeded', 'force skips the check')
      assert.deepEqual(asked, [{ kind, sessionId, force: true }])
    }
  }
})

test('the wait state is refreshed before the check reads it', async () => {
  const { host: h, refreshed, asked } = sessionActions({ wait: 'stale-ready' })
  assert.equal(await busy(h.perform({ kind: 'close', sessionId: 'a', force: false })), 'choice')
  assert.deepEqual(refreshed, ['a'])
  assert.equal(asked.length, 0)
})

test('idle sessions proceed; a dormant one hibernates at once and closes without a check', async () => {
  const { host: h, asked, refreshed } = sessionActions()
  assert.equal(await busy(h.perform({ kind: 'hibernate', sessionId: 'a', force: false })), 'proceeded')
  assert.equal(await busy(h.perform({ kind: 'close', sessionId: 'b', force: false })), 'proceeded')
  assert.deepEqual(await h.perform({ kind: 'hibernate', sessionId: 'c', force: false }), { sessionId: 'c' })
  assert.equal(await busy(h.perform({ kind: 'close', sessionId: 'c', force: false })), 'proceeded')
  assert.deepEqual(
    asked.map((a) => [(a as { kind: string }).kind, (a as { sessionId: string }).sessionId]),
    [
      ['hibernate', 'a'],
      ['close', 'b'],
      ['close', 'c'],
    ],
    'a dormant hibernation never reaches the interface',
  )
  assert.deepEqual(refreshed, ['a', 'b'], 'a dormant session is not checked')
})

test('hibernate and close: an unknown session is not found, and no window refuses both', async () => {
  const { host: h, asked } = sessionActions()
  for (const kind of ['hibernate', 'close'] as const) {
    assert.equal(await busy(h.perform({ kind, sessionId: 'nope', force: true })), 'NOT_FOUND')
  }
  const none = sessionActions()
  const noWindow = host({ window: () => null, request: () => Promise.reject(new Error('must not be asked')) }).host
  for (const kind of ['hibernate', 'close'] as const) {
    assert.equal(await busy(noWindow.perform({ kind, sessionId: 'a', force: true })), 'NO_WINDOW')
  }
  assert.equal(asked.length + none.asked.length, 0)
})

test('the list marks an offered close only on a running session (remote-close-offer D5)', () => {
  const offered = new Set(['a', 'b', 'c'])
  const list = host({ offers: { offered: (id) => offered.has(id), withdraw: () => false } }).host.sessionList()
  assert.deepEqual(
    list.sessions.map((s) => [s.id, s.closeOffered]),
    [
      ['a', true],
      ['b', true],
      ['c', undefined],
    ],
    'c is offered in the record but has no process',
  )
  const none = host().host.sessionList()
  assert.equal(
    none.sessions.some((s) => 'closeOffered' in s),
    false,
    'absent, not false, with no offer',
  )
})

test('keep withdraws in the main process, then always asks the window (remote-close-offer D2)', async () => {
  const order: string[] = []
  const asked: unknown[] = []
  let had = true
  let answer: { ok: true; sessionId: string } | { ok: false; code: string } = { ok: true, sessionId: 'a' }
  const { host: h } = host({
    offers: {
      offered: () => false,
      withdraw: (id) => {
        order.push(`withdraw ${id}`)
        const was = had
        had = false
        return was
      },
    },
    request: (_contents, action) => {
      order.push(`ask ${action.kind}`)
      asked.push(action)
      return Promise.resolve(answer)
    },
  })
  assert.deepEqual(await h.keep('a'), { sessionId: 'a' })
  assert.deepEqual(await h.keep('a'), { sessionId: 'a' }, 'no offer: still succeeds')
  assert.deepEqual(order, ['withdraw a', 'ask withdraw-close', 'withdraw a', 'ask withdraw-close'], 'the window is asked even with no offer')
  assert.deepEqual(asked[0], { kind: 'withdraw-close', sessionId: 'a' })

  answer = { ok: false, code: 'TIMEOUT' }
  await assert.rejects(h.keep('a'), (error: { code?: string }) => error.code === 'TIMEOUT')
  answer = { ok: false, code: 'SOMETHING_ELSE' }
  await assert.rejects(h.keep('a'), (error: { code?: string }) => error.code === 'CREATE_FAILED')

  await assert.rejects(h.keep('zzz'), (error: { code?: string }) => error.code === 'NOT_FOUND')
  const { host: windowless } = host({ window: () => null })
  await assert.rejects(windowless.keep('a'), (error: { code?: string }) => error.code === 'NO_WINDOW')
})
