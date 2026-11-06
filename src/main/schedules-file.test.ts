import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import type { IntakeView } from './intake-projection'
import { SCHEDULE_PREVIEW_CODE_POINTS, scheduleRules, schedulesContent, writeSchedulesFile } from './schedules-file'

const bases: string[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})

const T = Date.UTC(2026, 9, 21, 13)

function view(fields: Partial<IntakeView> & Pick<IntakeView, 'id'>): IntakeView {
  return {
    adapter: 'handoff',
    state: 'pending',
    originKind: 'session',
    originId: 'f1',
    originLabel: 'alpha',
    title: '',
    actor: 'alpha',
    body: '',
    bodyLength: 0,
    receivedAt: T,
    occurredAt: T,
    ...fields,
  }
}

const folders = [
  { id: 'f2', name: 'beta' },
  { id: 'f3', name: 'gamma' },
]

const items: IntakeView[] = [
  view({ id: 'p1', title: 'Weekly report', body: 'write it', folderId: 'f2', recurrence: { role: 'proposal', repeat: '0 21 * * 3', next: [T] } }),
  view({ id: 's1', body: 'Deploy check at /home/me/notes/deploy.md', folderId: 'f3', scheduledAt: T + 3600_000 }),
  view({ id: 's2', body: 'Another untitled job', folderId: 'f2', scheduledAt: T }),
  view({ id: 'r1-rabc', title: 'Daily', body: 'daily', folderId: 'f2', scheduledAt: T + 60_000, recurrence: { role: 'occurrence', repeat: '0 9 * * *' } }),
  // Not in the Schedules tab: waiting for the user, fired, and another producer.
  view({ id: 'w1', title: 'waiting', body: 'ordinary pending', folderId: 'f2' }),
  view({ id: 'x1', adapter: 'slack', originKind: 'channel', originLabel: '#general', title: 'secret slack text', body: 'secret slack text', scheduledAt: T }),
]

const recurrences = {
  available: true,
  recurrences: [
    { id: 'r1', repeat: '0 9 * * *', title: 'Daily', folderId: 'f2', targetText: '/repos/beta', next: T + 60_000 },
    { id: 'r2', repeat: '0 8 * * 1', title: '', targetText: '/repos/removed-repo', until: T + 86_400_000 },
  ],
}

const content = (): Record<string, unknown> =>
  schedulesContent({
    items,
    recurrences,
    recurrenceContent: (id) => (id === 'r2' ? { source: 'gamma', body: 'Monday sweep' } : { source: 'alpha', body: 'daily' }),
    folders,
  })

describe('the schedules file lists what the Schedules tab lists (handoff-cancel D6)', () => {
  it('has the three groups, from the predicates of the tab, and nothing else', () => {
    const c = content() as {
      proposals: { id: string }[]
      scheduled: { id: string; recurrenceId?: string; at: string }[]
      recurrences: { id: string }[]
    }
    assert.deepEqual(c.proposals.map((p) => p.id), ['p1'])
    assert.deepEqual(c.scheduled.map((s) => s.id), ['s2', 'r1-rabc', 's1'], 'earliest first')
    assert.equal(c.scheduled.find((s) => s.id === 'r1-rabc')?.recurrenceId, 'r1')
    assert.equal(c.scheduled.find((s) => s.id === 's2')?.recurrenceId, undefined)
    assert.equal(c.scheduled[0].at, new Date(T).toISOString())
    assert.deepEqual(c.recurrences.map((r) => r.id), ['r1', 'r2'])
  })

  it('carries no Slack text and no path the system derived, while text an agent wrote keeps its path', () => {
    // Control: list every pending record of every adapter, and the Slack text appears.
    const text = JSON.stringify(content())
    assert.ok(!text.includes('secret slack text'))
    assert.ok(!text.includes('/repos/'), 'no folder path or approved path')
    assert.ok(text.includes('/home/me/notes/deploy.md'), 'the body the agent wrote is as written')
  })

  it('names a recurrence\'s folder by its last segment and says when it is gone', () => {
    const c = content() as { recurrences: { id: string; target: string; targetGone?: boolean; source: string; preview: string }[] }
    const gone = c.recurrences.find((r) => r.id === 'r2')
    assert.equal(gone?.target, 'removed-repo')
    assert.equal(gone?.targetGone, true)
    assert.equal(gone?.source, 'gamma')
    assert.equal(gone?.preview, 'Monday sweep')
    assert.equal(c.recurrences.find((r) => r.id === 'r1')?.target, 'beta')
  })

  it('tells two untitled handoffs apart by their bodies, cut at the constant', () => {
    const long = 'x'.repeat(SCHEDULE_PREVIEW_CODE_POINTS + 50)
    const c = schedulesContent({
      items: [view({ id: 'a', body: long, scheduledAt: T }), view({ id: 'b', body: 'short one', scheduledAt: T + 1 })],
      recurrences: { available: true, recurrences: [] },
      recurrenceContent: () => undefined,
      folders,
    }) as { scheduled: { preview: string }[] }
    assert.equal([...c.scheduled[0].preview].length, SCHEDULE_PREVIEW_CODE_POINTS)
    assert.equal(c.scheduled[1].preview, 'short one')
  })

  it('states when the recurrences could not be read', () => {
    const c = schedulesContent({ items: [], recurrences: { available: false, recurrences: [] }, recurrenceContent: () => undefined, folders })
    assert.equal(c.recurrencesAvailable, false)
  })
})

describe('the rules state every constraint, one assertion per statement', () => {
  const rules = scheduleRules()
  const cases: [string, RegExp][] = [
    ['the shape', /\{"kind": "cancel", "id": "<id>"\}/],
    ['each effect', /never opens.*skipped.*declined.*stops repeating, with no confirmation/],
    ['no undo, and the user sees it', /cannot be undone, and the user sees it/],
    ['confirm with the user', /confirm with the user which one/],
    ['a snapshot; opening begun is refused', /snapshot.*opening has begun since is refused/],
    ['new first, then cancel', /write the new handoff first.*cancel the old one only after/],
    ['a changed recurrence waits for approval', /stop the old recurrence only once the new one appears under "recurrences"/],
    ['the same-content duplicate', /same content from the same session is a duplicate/],
    ['the receipt', /"accepted" once it is done, "duplicate" when the item was already cancelled/],
  ]
  for (const [what, pattern] of cases) {
    it(`states ${what}`, () => assert.match(rules, pattern))
  }
})

describe('writing the file', () => {
  it('writes whole, only on change, and never throws', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-file-'))
    bases.push(base)
    const file = path.join(base, 'handoff', 'schedules.json')
    writeSchedulesFile(file, { a: 1 })
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 })
    const before = fs.statSync(file).mtimeMs
    fs.utimesSync(file, new Date(0), new Date(0))
    writeSchedulesFile(file, { a: 1 })
    assert.equal(fs.statSync(file).mtimeMs, 0, 'unchanged content is not rewritten')
    void before
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['schedules.json'], 'no temporary file left')

    // A parent that is a file: the write fails (ENOTDIR), and nothing throws.
    const blocker = path.join(base, 'blocker')
    fs.writeFileSync(blocker, '')
    const errors = console.error
    const logged: string[] = []
    console.error = (message: string) => logged.push(message)
    try {
      writeSchedulesFile(path.join(blocker, 'schedules.json'), { a: 1 })
      writeSchedulesFile('', { a: 1 })
    } finally {
      console.error = errors
    }
    assert.equal(logged.length, 2, 'both failures are logged, neither is silent')
  })
})
