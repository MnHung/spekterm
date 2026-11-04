import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { MAX_FIELD_LENGTH, MAX_TEAMMATE_BODY_LENGTH } from './intake-schema'
import type { DeliverOutcome } from './intake-service'
import { MAX_OUTGOING_WAITING, type TeamPort, TeammateOutbox } from './teammate-outbox'
import { teammateRules, teammatesContent, writeTeammatesFile } from './teammates-file'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teammates-file-'))
  dirs.push(dir)
  return dir
}

const members = [
  { id: 'm_me', handle: 'me', displayName: 'Me', deviceCount: 1 },
  { id: 'm_sam', handle: 'sam', displayName: 'Sam‮ Lee\nSecond line', deviceCount: 2 },
  { id: 'm_long', handle: 'long', displayName: 'x'.repeat(100) },
]

describe('the teammates file', () => {
  it('lists the teammates with normalized one-line names, marks you, says connected and when fetched', () => {
    const content = teammatesContent({ you: 'me', connected: true, fetchedAt: Date.UTC(2026, 10, 3), members })
    assert.equal(content.you, 'me')
    assert.equal(content.connected, true)
    assert.equal(content.fetchedAt, '2026-11-03T00:00:00.000Z')
    assert.deepEqual(content.teammates, [
      { handle: 'sam', name: 'Sam Lee Second line' },
      { handle: 'long', name: 'x'.repeat(64) },
    ])
  })

  it('states every rule, each number from the constant in effect', () => {
    const rules = teammateRules()
    assert.match(rules, /"to" in place of "target"/)
    assert.match(rules, /"to" together with "target" is rejected/)
    assert.match(rules, /"at", "repeat" or "until": a teammate handoff cannot be scheduled/)
    assert.match(rules, /compared case-insensitively/)
    assert.match(rules, /"teammateHandoffs" with its status/)
    assert.match(rules, /report and any decline reason are not given to you/)
    assert.match(rules, /and so is your own/)
    assert.ok(rules.includes(`title: at most ${MAX_FIELD_LENGTH} characters`))
    assert.ok(rules.includes(`body: at most ${MAX_TEAMMATE_BODY_LENGTH} characters`))
    assert.ok(rules.includes(`At most ${MAX_OUTGOING_WAITING} wait for confirmation`))
    assert.match(rules, /confirms it on the desktop/)
    assert.match(rules, /OUTGOING_FULL/)
    for (const status of ['awaiting-confirmation', 'sent', 'discarded', 'rejected', 'held']) assert.ok(rules.includes(`"${status}"`), status)
    for (const code of ['NOT_CONNECTED', 'RATE_LIMITED', 'RETRYING', 'TEAM_UNAVAILABLE']) assert.ok(rules.includes(code), code)
    assert.match(rules, /not that they have seen or accepted it/)
    assert.match(rules, /its own checkout/)
  })

  it('a body one over the stated limit is refused, and one at it is not', async () => {
    const stated = Number(/body: at most (\d+) characters/.exec(teammateRules())?.[1])
    const team: TeamPort = {
      enabled: () => true,
      membership: () => ({ server: 'wss://t', memberId: 'm_me' }),
      self: () => 'me',
      members: () => members,
      connected: () => false,
      operations: () => [],
      refreshMembers: async () => null,
      request: async () => ({ ok: true, r: {} }),
    }
    const outbox = new TeammateOutbox({
      file: path.join(tmp(), 'team-outgoing.json'),
      team,
      receiptsDir: () => '',
      reject: (code): DeliverOutcome => ({ ok: false, code, consume: true, notify: true }),
      refusedLater: () => {},
      onChange: () => {},
      onArrival: () => {},
    })
    const read = (body: string): Promise<DeliverOutcome> =>
      outbox.read({ sessionId: 's', receiptFile: 'a.json', source: { label: 'x' }, payload: { to: 'sam', title: 't', body } })
    assert.equal((await read('b'.repeat(stated + 1))).code, 'TOO_LONG')
    assert.equal((await read('b'.repeat(stated))).ok, true)
  })

  it('holds no credential, no device id and no server address', () => {
    const file = path.join(tmp(), 'teammates.json')
    writeTeammatesFile(file, { you: 'me', connected: true, members })
    const text = fs.readFileSync(file, 'utf8')
    for (const secret of ['m_me', 'm_sam', 'wss://', 'deviceSecret', 'device']) assert.ok(!text.includes(secret), secret)
  })

  it('is rewritten whole only on a change, and removed with no membership', () => {
    const dir = tmp()
    const file = path.join(dir, 'teammates.json')
    writeTeammatesFile(file, { you: 'me', connected: true, members })
    const first = fs.statSync(file).mtimeMs
    writeTeammatesFile(file, { you: 'me', connected: true, members })
    assert.equal(fs.statSync(file).mtimeMs, first)
    writeTeammatesFile(file, { you: 'me', connected: false, members })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).connected, false)
    assert.deepEqual(fs.readdirSync(dir), ['teammates.json'], 'no temporary file left behind')
    writeTeammatesFile(file, null)
    assert.equal(fs.existsSync(file), false)
  })
})
