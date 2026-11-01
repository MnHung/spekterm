import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { releaseSessions } from './session-release'
import { recordExit, recordHibernated, recordSpawned } from './session-running'
import { SessionStore } from './session-store'

/**
 * The record of which sessions were running (`restore-running-sessions` D1). Each rule fails silently when wrong:
 * a record never set starts nothing after a restart; one never cleared starts a session the user put to sleep.
 * Controls: removing the corresponding line in `session-running.ts` turns the matching test red.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111'

let dir: string
let file: string

function store(): SessionStore {
  const created = new SessionStore(file, path.join(dir, 'sessions'))
  created.load()
  return created
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-running-')))
  file = path.join(dir, 'sessions.json')
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const entry = { id: UUID_A, folderId: 'f1', spawnTarget: 'claude' as const, ordinal: 1 }

describe('the running record', () => {
  it('a spawn sets it, and it survives a reload of the file', () => {
    const s = store()
    s.replace([entry])
    recordSpawned(s, UUID_A)
    assert.equal(store().list()[0].running, true)
  })

  it('a hibernation clears it', () => {
    const s = store()
    s.replace([entry])
    recordSpawned(s, UUID_A)
    recordHibernated(s, UUID_A)
    assert.equal(store().list()[0].running, undefined)
  })

  it('a hibernated exit clears it too; disposed, self and killed exits leave it', () => {
    const s = store()
    s.replace([entry])
    recordSpawned(s, UUID_A)
    for (const reason of ['disposed', 'self', 'killed'] as const) {
      recordExit(s, UUID_A, reason)
      assert.equal(s.list()[0].running, true, reason)
    }
    recordExit(s, UUID_A, 'hibernated')
    assert.equal(s.list()[0].running, undefined)
  })

  it('a renderer persist can neither set nor clear it', () => {
    const s = store()
    s.replace([{ ...entry, running: true } as never])
    assert.equal(s.list()[0].running, undefined, 'the renderer cannot set it')
    recordSpawned(s, UUID_A)
    s.replace([entry])
    assert.equal(s.list()[0].running, true, 'the renderer cannot clear it')
  })

  it('a spawn before the first persist lands, both while provisional and before the entry exists', () => {
    const provisional = store()
    provisional.addProvisional({ id: UUID_A, folderId: 'f1', spawnTarget: 'claude' })
    recordSpawned(provisional, UUID_A)
    provisional.replace([entry])
    assert.equal(provisional.list()[0].running, true, 'provisional')

    fs.rmSync(file)
    const pending = store()
    recordSpawned(pending, UUID_A)
    pending.replace([entry])
    assert.equal(pending.list()[0].running, true, 'pending')
  })

  it('releasing a renderer keeps the record of a session it never persisted (flush before dropping)', () => {
    // Control: swapping the two calls in `releaseSessions` turns this red — `replace()` no longer finds the
    // provisional entry, and the session comes back dormant and without its lineage.
    const s = store()
    s.addProvisional({
      id: UUID_A,
      folderId: 'f1',
      spawnTarget: 'claude',
      lineage: {
        parentId: '22222222-2222-4222-8222-222222222222',
        origin: { kind: 'folder' as const, folderId: 'f1', folderName: 'alpha' },
      },
      peerName: 'alpha-1111',
    })
    recordSpawned(s, UUID_A)
    releaseSessions(s, () => s.replace([entry]))
    const [kept] = store().list()
    assert.equal(kept.running, true)
    assert.equal(kept.peerName, 'alpha-1111')
    assert.ok(kept.lineage)
  })
})
