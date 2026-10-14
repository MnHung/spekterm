import assert from 'node:assert/strict'
import test from 'node:test'
import { type AcceptFlowDeps, runAccept } from './accept-flow'

function deps(overrides: {
  decision?: unknown
  live?: { id: string; folderId: string | null }[]
  create?: unknown
}) {
  const calls: string[] = []
  const d = {
    intake: {
      accept: async () => {
        calls.push('accept')
        return (overrides.decision ?? { ok: true, folderId: 'f1' }) as never
      },
      attach: async (_id: string, _adapter: string, sessionId: string) => {
        calls.push(`attach:${sessionId}`)
        return { ok: true }
      },
    },
    sessions: {
      all: () => (overrides.live ?? []) as never,
      create: async (_folderId: string, _target: string, options?: { quiet?: boolean }) => {
        calls.push(`create${options?.quiet ? ':quiet' : ''}`)
        return (overrides.create ?? { status: 'created', sessionId: 'new' }) as never
      },
    },
  } as unknown as AcceptFlowDeps
  return { d, calls }
}

test('a fresh accept creates (quietly for a device) and attaches', async () => {
  const { d, calls } = deps({})
  assert.deepEqual(await runAccept(d, { id: 'i', adapter: 'file' }, 'f1', { quiet: true }), { ok: true, sessionId: 'new' })
  assert.deepEqual(calls, ['accept', 'create:quiet', 'attach:new'])
})

test('accepting again reuses the earlier session in the chosen folder', async () => {
  const { d, calls } = deps({
    decision: { ok: true, folderId: 'f1', existingSessionId: 'old' },
    live: [{ id: 'old', folderId: 'f1' }],
  })
  assert.deepEqual(await runAccept(d, { id: 'i', adapter: 'file' }, 'f1'), { ok: true, sessionId: 'old' })
  assert.deepEqual(calls, ['accept', 'attach:old'])
})

test('a creation failure stops before attach, so the item stays pending', async () => {
  const { d, calls } = deps({ create: { status: 'failed', failure: { ok: false, code: 'X', message: 'no' } } })
  assert.deepEqual(await runAccept(d, { id: 'i', adapter: 'file' }, 'f1'), { ok: false, reason: 'createFailed', message: 'no' })
  assert.deepEqual(calls, ['accept', 'create'])
})

test('a refused decision creates nothing', async () => {
  const { d, calls } = deps({ decision: { ok: false, reason: 'FOLDER_GONE' } })
  assert.deepEqual(await runAccept(d, { id: 'i', adapter: 'file' }, 'gone'), { ok: false, reason: 'FOLDER_GONE' })
  assert.deepEqual(calls, ['accept'])
})
