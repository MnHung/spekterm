import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { testOpener } from './handoff-opener.testkit'
import { clearOutbox, configureHandoff, outboxDir, prepareOutbox, receiptsDir, resetHandoffState } from './handoff-outbox'
import { prepareHandoffInjection } from './handoff-injection'
import { MAX_RECEIPTS, receiptFor, writeReceipt, type Receipt } from './handoff-receipt'
import { HandoffService } from './handoff-service'
import type { DeliverOutcome } from './intake-service'
import { IntakeService } from './intake-service'
import { silentWatcher } from './intake-source.testkit'
import { IntakeStore, type IntakeRecord } from './intake-store'

const bases: string[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})
function tempDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-receipt-'))
  bases.push(base)
  return base
}

const NOW = Date.parse('2026-10-19T12:00:00Z')
const outcome = (o: Partial<DeliverOutcome>): DeliverOutcome => ({ ok: false, consume: true, notify: true, ...o })

describe('the mapping (D8)', () => {
  it('accepted, scheduled, duplicate', () => {
    const record = { content: { verified: { scheduledAt: NOW + 3_600_000 } } } as unknown as IntakeRecord
    assert.equal(receiptFor('/x/a.json', { ok: true, consume: true, notify: false }, NOW).status, 'accepted')
    const scheduled = receiptFor('/x/a.json', { ok: true, consume: true, notify: false, record }, NOW)
    assert.deepEqual([scheduled.status, scheduled.at], ['scheduled', '2026-10-19T13:00:00.000Z'])
    assert.equal(receiptFor('/x/a.json', { ok: true, consume: true, notify: false, duplicate: true }, NOW).status, 'duplicate')
    assert.equal(receiptFor('/x/a.json', outcome({ code: 'DUPLICATE', notify: false }), NOW).status, 'duplicate')
  })

  it('rejected carries the code, a reason and whether it is permanent', () => {
    const notFound = receiptFor('/x/a.json', outcome({ code: 'TARGET_NOT_FOUND' }), NOW)
    assert.deepEqual([notFound.status, notFound.code, notFound.permanent], ['rejected', 'TARGET_NOT_FOUND', true])
    assert.ok(notFound.reason)
    const prefill = receiptFor('/x/a.json', outcome({ code: 'PREFILL_UNAVAILABLE' }), NOW)
    assert.deepEqual([prefill.status, prefill.permanent], ['rejected', false])
    assert.match(prefill.reason ?? '', /once the user turns it on/)
    const takeover = receiptFor('/x/a.json', outcome({ code: 'DUPLICATE', notify: true }), NOW)
    assert.deepEqual([takeover.status, takeover.permanent], ['rejected', true])
  })

  it("a refused command's receipt states the refusal, with its code", () => {
    const refused = receiptFor('/x/c.json', outcome({ code: 'CONTROL_NOT_ALLOWED' }), NOW)
    assert.deepEqual([refused.status, refused.code, refused.permanent], ['rejected', 'CONTROL_NOT_ALLOWED', true])
    const noWindow = receiptFor('/x/c.json', outcome({ code: 'CONTROL_NO_WINDOW' }), NOW)
    assert.deepEqual([noWindow.status, noWindow.permanent], ['rejected', false])
  })

  it('held: not processed yet, with when it is read again', () => {
    const malformed = receiptFor('/x/a.json', outcome({ code: 'MALFORMED', consume: false, notify: false }), NOW)
    assert.deepEqual([malformed.status, malformed.code], ['held', 'MALFORMED'])
    assert.match(malformed.reason ?? '', /within a minute/)
    const full = receiptFor('/x/a.json', outcome({ code: 'CAPACITY', consume: false }), NOW)
    assert.deepEqual([full.status, full.code], ['held', 'CAPACITY'])
    const failed = receiptFor('/x/a.json', { failed: true }, NOW)
    assert.deepEqual([failed.status, failed.code], ['held', 'READ_FAILED'])
    assert.match(failed.reason ?? '', /next start/)
  })

  it('carries no delivery text: neither the target string nor the body', () => {
    const receipt = receiptFor(
      '/x/a.json',
      outcome({ code: 'TARGET_NOT_FOUND', failure: { target: 'secret-target', origin: 'alpha' }, detail: 'body text here' }),
      NOW,
    )
    const text = JSON.stringify(receipt)
    assert.equal(text.includes('secret-target'), false)
    assert.equal(text.includes('body text here'), false)
  })
})

describe('writing (D8)', () => {
  const receipt = (file: string, status: Receipt['status'] = 'accepted', code?: string): Receipt => ({
    file,
    status,
    writtenAt: new Date().toISOString(),
    ...(code ? { code } : {}),
  })

  it('a held receipt is rewritten only when its status or code changes', () => {
    const dir = tempDir()
    writeReceipt(dir, receipt('a.json', 'held', 'MALFORMED'))
    const first = fs.statSync(path.join(dir, 'a.json')).mtimeMs
    const before = fs.readFileSync(path.join(dir, 'a.json'), 'utf8')
    writeReceipt(dir, { ...receipt('a.json', 'held', 'MALFORMED'), writtenAt: 'later' })
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), before)
    assert.equal(fs.statSync(path.join(dir, 'a.json')).mtimeMs, first)
    writeReceipt(dir, receipt('a.json', 'accepted'))
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).status, 'accepted')
  })

  it('keeps the newest hundred, removes the oldest, and leaves a planted link alone', () => {
    const dir = tempDir()
    const outside = path.join(tempDir(), 'precious.txt')
    fs.writeFileSync(outside, 'keep me')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(outside, path.join(dir, 'link.json'))
    const past = Date.now() / 1000 - 10_000
    for (let i = 0; i <= MAX_RECEIPTS; i += 1) {
      writeReceipt(dir, receipt(`r${String(i).padStart(3, '0')}.json`))
      fs.utimesSync(path.join(dir, `r${String(i).padStart(3, '0')}.json`), past + i, past + i)
    }
    // One more write trims against the times just set.
    writeReceipt(dir, receipt('r999.json'))
    const names = fs.readdirSync(dir).filter((n) => n.startsWith('r'))
    assert.equal(names.length, MAX_RECEIPTS)
    assert.equal(names.includes('r000.json'), false)
    assert.equal(names.includes('r001.json'), false)
    assert.equal(names.includes('r999.json'), true)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me')
    assert.equal(fs.lstatSync(path.join(dir, 'link.json')).isSymbolicLink(), true)
  })

  it('a non-directory in the receipts directory place is replaced', () => {
    const dir = path.join(tempDir(), 'receipts')
    fs.writeFileSync(dir, 'not a directory')
    writeReceipt(dir, receipt('a.json'))
    assert.equal(fs.statSync(dir).isDirectory(), true)
  })

  /**
   * A reader in another process never sees half a receipt. The child reads the name in a loop while this process
   * rewrites a large receipt many times; with the rename removed (control group, see tasks 6.3) it reports torn
   * reads.
   */
  it('a reader in another process never sees a partial receipt', async () => {
    const dir = tempDir()
    const big = (n: number): Receipt => ({ ...receipt('big.json', 'rejected', 'FIELD_TYPE'), reason: String(n).repeat(400_000) })
    writeReceipt(dir, big(0))
    const target = path.join(dir, 'big.json')
    const reader = spawn(process.execPath, [
      '-e',
      `const fs=require('fs');let torn=0,reads=0;const end=Date.now()+1500;
       while(Date.now()<end){try{const t=fs.readFileSync(${JSON.stringify(target)},'utf8');reads++;try{JSON.parse(t)}catch{torn++}}catch{}}
       process.stdout.write(JSON.stringify({torn,reads}))`,
    ])
    let out = ''
    reader.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    const done = new Promise<void>((resolve) => reader.on('exit', () => resolve()))
    const until = Date.now() + 1500
    let n = 1
    while (Date.now() < until) {
      writeReceipt(dir, big(n % 10))
      n += 1
      await new Promise((resolve) => setImmediate(resolve))
    }
    await done
    const { torn, reads } = JSON.parse(out) as { torn: number; reads: number }
    assert.ok(reads > 10, `precondition: the reader read (${reads})`)
    assert.ok(n > 10, `precondition: the writer wrote (${n})`)
    assert.equal(torn, 0)
  })
})

describe('receipts on the handoff path (D8)', () => {
  function service(): { handoff: HandoffService; base: string; intake: IntakeService } {
    const base = tempDir()
    resetHandoffState()
    configureHandoff(base)
    const archive = path.join(base, 'intake')
    fs.mkdirSync(archive, { recursive: true })
    const store = new IntakeStore(path.join(base, 'intake.json'))
    const intake = new IntakeService({ store, archiveRoot: archive })
    const folders = [{ id: 'f2', name: 'beta', path: '/repos/beta' }]
    const opener = testOpener(intake, () => folders, () => {})
    const handoff = new HandoffService({
      service: intake,
      sourceOf: () => ({ folderId: 'f1', label: 'alpha' }),
      candidates: () => folders,
      agentEventsEnabled: () => true,
      onDelivered: () => opener.tick(),
      sourceTesting: { watch: silentWatcher },
    })
    return { handoff, base, intake }
  }

  it('an accepted handoff, a refused one, an unparseable one and a dot file', async (t) => {
    const { handoff } = service()
    const sessionId = '11111111-2222-4333-8444-555555555555'
    prepareOutbox(sessionId)
    const dir = outboxDir(sessionId)
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ target: 'beta', body: 'x' }))
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ target: 'nowhere', body: 'x' }))
    fs.writeFileSync(path.join(dir, 'd.json'), '{ not json')
    fs.writeFileSync(path.join(dir, '.e.json'), '{}')
    await handoff.start()
    t.after(() => handoff.dispose())
    const read = (name: string): Receipt => JSON.parse(fs.readFileSync(path.join(receiptsDir(sessionId), name), 'utf8'))
    assert.equal(read('a.json').status, 'accepted')
    assert.deepEqual([read('b.json').status, read('b.json').code, read('b.json').permanent], ['rejected', 'TARGET_NOT_FOUND', true])
    assert.equal(read('d.json').status, 'held')
    assert.equal(fs.existsSync(path.join(dir, 'd.json')), true)
    assert.equal(fs.existsSync(path.join(receiptsDir(sessionId), '.e.json')), false)
    assert.equal(fs.existsSync(path.join(dir, 'a.json')), false)
  })

  it('the same handoff written twice: one accepted, one duplicate, one record', async (t) => {
    const { handoff, intake } = service()
    const sessionId = '11111111-2222-4333-8444-555555555557'
    prepareOutbox(sessionId)
    const dir = outboxDir(sessionId)
    fs.writeFileSync(path.join(dir, 'e.json'), JSON.stringify({ target: 'beta', body: 'same' }))
    fs.writeFileSync(path.join(dir, 'f.json'), JSON.stringify({ target: 'beta', body: 'same' }))
    await handoff.start()
    t.after(() => handoff.dispose())
    const read = (name: string): string | undefined =>
      (JSON.parse(fs.readFileSync(path.join(receiptsDir(sessionId), name), 'utf8')) as Receipt).status
    assert.deepEqual([read('e.json'), read('f.json')].sort(), ['accepted', 'duplicate'])
    assert.equal(intake.store.list().length, 1)
  })

  it('a delivery is processed when its receipt cannot be written', async (t) => {
    const { handoff } = service()
    const sessionId = '11111111-2222-4333-8444-555555555556'
    prepareOutbox(sessionId)
    // A receipts directory that cannot be created: its parent is a file.
    fs.mkdirSync(path.dirname(path.dirname(receiptsDir(sessionId))), { recursive: true })
    fs.writeFileSync(path.dirname(receiptsDir(sessionId)), 'blocked')
    fs.writeFileSync(path.join(outboxDir(sessionId), 'a.json'), JSON.stringify({ target: 'beta', body: 'x' }))
    await handoff.start()
    t.after(() => handoff.dispose())
    assert.equal(fs.existsSync(path.join(outboxDir(sessionId), 'a.json')), false)
  })

  it('ending a session removes its receipts, and the pty learns where they are', () => {
    const base = tempDir()
    resetHandoffState()
    configureHandoff(base)
    const part = prepareHandoffInjection('s1', [])
    assert.equal(part?.env.SPEKTERM_HANDOFF_RECEIPTS, receiptsDir('s1'))
    writeReceipt(receiptsDir('s1'), { file: 'a.json', status: 'accepted', writtenAt: '' })
    clearOutbox('s1')
    assert.equal(fs.existsSync(receiptsDir('s1')), false)
  })
})
