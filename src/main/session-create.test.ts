import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { SessionLineage } from '../shared/lineage/types'
import { configureTeammateTickets, configureTicketLineage, handoffTickets } from './handoff-ticket'
import { createSession } from './session-create'
import { SessionStore } from './session-store'

const PARENT = 'c463620e-cfbf-40e4-9732-685d0ea94b89'
const LINEAGE: SessionLineage = {
  parentId: PARENT,
  origin: { kind: 'folder', folderId: 'f1', folderName: 'alpha' },
  parentTitle: 'Session 交接',
}

let dir: string
let sessions: SessionStore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'session-create-'))
  sessions = new SessionStore(path.join(dir, 'sessions.json'), path.join(dir, 'sessions'))
  sessions.load()
  configureTicketLineage((claim) => (claim.id === 'h1' ? { lineage: LINEAGE } : undefined))
})

afterEach(() => {
  configureTicketLineage(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** spawn 的替身：記下**spawn 當下**主行程看得到的暫定紀錄 —— 那是自我介紹與關係檔讀的東西。 */
function recordingSpawn(seen: unknown[]) {
  return async (sessionId: string) => {
    seen.push(sessions.view().find((v) => v.session.id === sessionId)?.session)
    return { sessionId }
  }
}

describe('建立 session 時寫入來源與名字（handoff-lineage）', () => {
  it('spawn 的那一刻，暫定紀錄已含來源與名字', async () => {
    const seen: unknown[] = []
    const ticket = handoffTickets.issue({ adapter: 'handoff', id: 'h1', folderId: 'f2' })
    const result = await createSession({
      sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket, spawn: recordingSpawn(seen),
    })
    const atSpawn = seen[0] as { lineage?: SessionLineage; peerName?: string }
    assert.deepEqual(atSpawn.lineage, LINEAGE)
    assert.match(atSpawn.peerName ?? '', /^beta-[0-9a-f]{4}$/)
    assert.deepEqual(result.lineage, LINEAGE)
  })

  it('同一張憑證建第二個 session ⇒ 第二個沒有來源', async () => {
    const ticket = handoffTickets.issue({ adapter: 'handoff', id: 'h1', folderId: 'f2' })
    const spawn = async (sessionId: string) => ({ sessionId })
    await createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket, spawn })
    const second = await createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket, spawn })
    assert.equal(second.lineage, undefined)
  })

  it('沒有憑證 ⇒ 沒有來源，但 claude 仍有名字', async () => {
    const seen: unknown[] = []
    await createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket: undefined, spawn: recordingSpawn(seen) })
    const atSpawn = seen[0] as { lineage?: SessionLineage; peerName?: string }
    assert.equal(atSpawn.lineage, undefined)
    assert.ok(atSpawn.peerName)
  })

  it('shell 目標沒有名字，憑證也不寫入來源', async () => {
    const seen: unknown[] = []
    const ticket = handoffTickets.issue({ adapter: 'handoff', id: 'h1', folderId: 'f2' })
    await createSession({ sessions, folderId: 'f2', target: 'shell', railLabel: 'beta', ticket, spawn: recordingSpawn(seen) })
    const atSpawn = seen[0] as { lineage?: SessionLineage; peerName?: string }
    assert.equal(atSpawn.peerName, undefined)
    assert.equal(atSpawn.lineage, undefined)
  })

  it('兩個並行的建立不會拿到同一個名字', async () => {
    const names: (string | undefined)[] = []
    const spawn = async (sessionId: string, peerName: string | undefined) => {
      names.push(peerName)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { sessionId }
    }
    await Promise.all([
      createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket: undefined, spawn }),
      createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket: undefined, spawn }),
    ])
    assert.equal(new Set(names).size, 2)
  })

  it('spawn 失敗 ⇒ 暫定紀錄被撤掉', async () => {
    await assert.rejects(
      createSession({
        sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket: undefined,
        spawn: async () => { throw new Error('boom') },
      }),
    )
    assert.equal(sessions.view().length, 0)
  })

  it('一則交接建出兩個 session（憑證各簽一次）兩者皆為子 session', async () => {
    const spawn = async (sessionId: string) => ({ sessionId })
    const a = await createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta',
      ticket: handoffTickets.issue({ adapter: 'handoff', id: 'h1', folderId: 'f2' }), spawn })
    const b = await createSession({ sessions, folderId: 'f3', target: 'claude', railLabel: 'gamma',
      ticket: handoffTickets.issue({ adapter: 'handoff', id: 'h1', folderId: 'f3' }), spawn })
    assert.equal(a.lineage?.parentId, PARENT)
    assert.equal(b.lineage?.parentId, PARENT)
  })
})

describe('a teammate handoff\'s session is linked before it spawns (teammate-handoff-return D7)', () => {
  it('the provisional record carries teammateHandoff at spawn, the link is reported, and it survives the persist', async () => {
    const linked: [string, string][] = []
    configureTicketLineage((claim) => (claim.id === 'teammate:h.1' ? { teammate: { handoffId: 'h_1' } } : undefined))
    configureTeammateTickets({ reportable: () => true, linked: (sessionId, handoffId) => linked.push([sessionId, handoffId]) })
    try {
      const seen: unknown[] = []
      const ticket = handoffTickets.issue({ adapter: 'teammate', id: 'teammate:h.1', folderId: 'f2' })
      const result = await createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket, spawn: recordingSpawn(seen) })
      const atSpawn = seen[0] as { teammateHandoff?: { handoffId: string }; lineage?: unknown }
      assert.deepEqual(atSpawn.teammateHandoff, { handoffId: 'h_1' })
      assert.equal(atSpawn.lineage, undefined)
      assert.deepEqual(linked, [[result.sessionId, 'h_1']])
      // The renderer persists it without the field; the main-owned value is kept, and read back after a reload.
      sessions.replace([{ id: result.sessionId, folderId: 'f2', spawnTarget: 'claude', ordinal: 0 }])
      const reloaded = new SessionStore(path.join(dir, 'sessions.json'), path.join(dir, 'sessions'))
      reloaded.load()
      assert.deepEqual(reloaded.view().find((v) => v.session.id === result.sessionId)?.session.teammateHandoff, { handoffId: 'h_1' })
    } finally {
      configureTeammateTickets({ reportable: () => false, linked: () => {} })
    }
  })

  it('no ticket: no link', async () => {
    const seen: unknown[] = []
    await createSession({ sessions, folderId: 'f2', target: 'claude', railLabel: 'beta', ticket: undefined, spawn: recordingSpawn(seen) })
    assert.equal((seen[0] as { teammateHandoff?: unknown }).teammateHandoff, undefined)
  })
})

