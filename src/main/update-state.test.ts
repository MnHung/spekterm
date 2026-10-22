import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { UpdateStateStore, parseUpdateState } from './update-state'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spekterm-update-state-'))
  dirs.push(dir)
  return dir
}

describe('parseUpdateState', () => {
  it('keeps the valid fields', () => {
    const state = parseUpdateState(
      JSON.stringify({
        notifiedVersion: 'v0.2.18',
        lastCheckedAt: 1700000000000,
        installOutcome: { version: '0.2.18', ok: false, reason: 'download-missing' },
      }),
    )
    assert.deepEqual(state, {
      notifiedVersion: '0.2.18',
      lastCheckedAt: 1700000000000,
      installOutcome: { version: '0.2.18', ok: false, reason: 'download-missing' },
    })
  })

  it('drops what is malformed, field by field', () => {
    assert.deepEqual(parseUpdateState('not json'), {})
    assert.deepEqual(parseUpdateState('[]'), {})
    assert.deepEqual(
      parseUpdateState(JSON.stringify({ notifiedVersion: '1.2.3-beta', lastCheckedAt: 'yesterday', installOutcome: { version: '1.0.0' } })),
      {},
    )
    assert.deepEqual(
      parseUpdateState(JSON.stringify({ installOutcome: { version: '1.0.0', ok: false, reason: 'Click https://evil.example' } })).installOutcome,
      { version: '1.0.0', ok: false },
    )
  })
})

describe('UpdateStateStore', () => {
  it('persists and reloads', () => {
    const file = path.join(scratch(), 'update-state.json')
    const store = new UpdateStateStore(file)
    store.load()
    assert.deepEqual(store.get(), {})
    store.update({ notifiedVersion: '0.2.18', lastCheckedAt: 5 })
    store.update({ lastCheckedAt: undefined })
    const again = new UpdateStateStore(file)
    again.load()
    assert.deepEqual(again.get(), { notifiedVersion: '0.2.18' })
  })

  it('keeps the previous state in memory when the write fails', () => {
    const dir = scratch()
    const file = path.join(dir, 'update-state.json')
    const store = new UpdateStateStore(file)
    store.load()
    store.update({ notifiedVersion: '0.2.18' })
    // A directory where the temporary file goes makes the write fail.
    fs.mkdirSync(`${file}.tmp`)
    assert.throws(() => store.update({ notifiedVersion: '0.2.19' }))
    assert.equal(store.get().notifiedVersion, '0.2.18')
  })

  it('treats an unreadable file as empty', () => {
    const dir = scratch()
    const file = path.join(dir, 'update-state.json')
    fs.mkdirSync(file)
    const store = new UpdateStateStore(file)
    store.load()
    assert.deepEqual(store.get(), {})
  })
})
