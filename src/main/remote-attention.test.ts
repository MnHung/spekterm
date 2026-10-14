import assert from 'node:assert/strict'
import test from 'node:test'
import { type AttentionEvent, AttentionLog, type AttentionSources } from './remote-attention'
import type { IntakeRecord } from './intake-store'

function rig(overrides: Partial<AttentionSources> = {}) {
  let now = 1_000_000
  let epochs = 0
  const focused = new Set<string>()
  const log = new AttentionLog({
    now: () => now,
    sessionInfo: (id) => (id === 'gone' ? null : { folderName: id === 'g' ? null : 'api-server', title: `claude 1 (${id})` }),
    displayedInFocus: (id) => focused.has(id),
    newEpoch: () => `e${++epochs}`,
    ...overrides,
  })
  log.setEnabled(true)
  const seen: AttentionEvent[] = []
  return { log, seen, focused, advance: (ms: number) => (now += ms), listen: () => log.watch(undefined, (e) => seen.push(e)) }
}

const batch = (state: 'ready' | 'busy' | 'awaiting-choice', turnEnded = false, tool: string | null = null) => ({
  state,
  turnEnded,
  choiceRaised: tool === null ? null : { tool },
})

test('derivations: a finished turn, a choice, an adopted report, an arrival', () => {
  const r = rig()
  r.listen()
  r.log.onWait('s', batch('ready', true))
  r.log.onWait('s', batch('awaiting-choice', false, 'Bash'))
  r.log.onReported('s', 'Fix the login', 'Done.')
  r.log.onIntake({ adapter: 'file', id: 'i1', state: 'pending', digest: 'd', content: { authored: { title: 'Look at this' } } } as unknown as IntakeRecord)
  assert.deepEqual(
    r.seen.map((e) => [e.kind, e.sessionId ?? e.intake?.id, e.tool, e.folderName]),
    [
      ['waiting', 's', undefined, 'api-server'],
      ['choice', 's', 'Bash', 'api-server'],
      ['handoff-done', 's', undefined, 'api-server'],
      ['intake', 'i1', undefined, undefined],
    ],
  )
  assert.equal(r.seen[2].summary, 'Done.')
  assert.equal(r.seen[3].title, 'Look at this')
})

test('a turn inside one batch (ready → ready) still raises waiting; a busy batch raises nothing', () => {
  const r = rig()
  r.listen()
  r.log.onWait('s', batch('busy'))
  r.log.onWait('s', batch('ready'))
  assert.equal(r.seen.length, 0)
  r.log.onWait('s', batch('ready', true))
  assert.deepEqual(r.seen.map((e) => e.kind), ['waiting'])
})

test('a second prompt while already waiting on a choice raises its own event', () => {
  const r = rig()
  r.listen()
  r.log.onWait('s', batch('awaiting-choice', false, 'Edit'))
  r.log.onWait('s', batch('awaiting-choice', false, 'Bash'))
  assert.deepEqual(r.seen.map((e) => e.tool), ['Edit', 'Bash'])
})

test('the session displayed in the focused window is marked suppressed, and still delivered and held', () => {
  const r = rig()
  r.focused.add('s')
  r.listen()
  r.log.onWait('s', batch('ready', true))
  assert.equal(r.seen[0].suppressed, true)
  assert.equal(r.log.watch(undefined, () => undefined)?.events[0].suppressed, true)
})

test('a URL in a report summary is replaced; a long folder name is clipped, not reduced', () => {
  const r = rig({ sessionInfo: () => ({ folderName: `<${'x'.repeat(100)}>`, title: 't' }) })
  r.listen()
  r.log.onReported('s', 't', 'see https://example.com/pr/1 now')
  assert.ok(!r.seen[0].summary?.includes('example.com'))
  assert.ok(r.seen[0].folderName?.startsWith('<'), 'markup characters stay in a folder name')
  assert.equal([...(r.seen[0].folderName ?? '')].length, 81)
})

test('resume from a held position sends only what follows, complete', () => {
  const r = rig()
  r.log.onWait('s', batch('ready', true))
  const first = r.log.watch(undefined, () => undefined)!
  const position = first.events[0].pos
  first.stop()
  r.log.onWait('s', batch('awaiting-choice', false, 'A'))
  r.log.onWait('s', batch('awaiting-choice', false, 'B'))
  const resumed = r.log.watch(position, () => undefined)!
  assert.equal(resumed.complete, true)
  assert.deepEqual(resumed.events.map((e) => e.tool), ['A', 'B'])
})

test('a position whose own event was pushed out, with nothing after it lost, is still complete', () => {
  const r = rig()
  const small = new AttentionLog(
    { now: () => 0, sessionInfo: () => ({ folderName: null, title: 't' }), displayedInFocus: () => false, newEpoch: () => 'e' },
    { capacity: 2, maxAgeMs: 1e9 },
  )
  small.setEnabled(true)
  for (let i = 0; i < 3; i += 1) small.onWait('s', batch('ready', true)) // seq 1..3, holds 2..3
  assert.equal(small.watch({ epoch: 'e', seq: 1 }, () => undefined)?.complete, true, 'nothing after seq 1 was dropped')
  assert.equal(small.watch({ epoch: 'e', seq: 0 }, () => undefined)?.complete, false, 'seq 1 was dropped')
  void r
})

test('another epoch, a position with later events dropped, and no position each send all held, incomplete', () => {
  const r = rig()
  r.log.onWait('s', batch('ready', true))
  assert.equal(r.log.watch({ epoch: 'old', seq: 1 }, () => undefined)?.complete, false)
  assert.equal(r.log.watch(undefined, () => undefined)?.complete, false)
  assert.equal(r.log.watch(undefined, () => undefined)?.events.length, 1)
})

test('an event older than 24 h is gone', () => {
  const r = rig()
  r.log.onWait('s', batch('ready', true))
  r.advance(24 * 60 * 60 * 1000 + 1)
  assert.deepEqual(r.log.watch(undefined, () => undefined)?.events, [])
})

test('off holds nothing; on again is a new span; a reset is a new span with nothing from before', () => {
  const r = rig()
  r.log.onWait('s', batch('ready', true))
  const position = r.log.watch(undefined, () => undefined)!.events[0].pos
  r.log.setEnabled(false)
  r.log.onWait('s', batch('awaiting-choice', false, 'while-off'))
  assert.equal(r.log.watch(undefined, () => undefined), null)
  r.log.setEnabled(true)
  r.log.onWait('s', batch('awaiting-choice', false, 'after-on'))
  const answer = r.log.watch(position, () => undefined)!
  assert.equal(answer.complete, false)
  assert.deepEqual(answer.events.map((e) => e.tool), ['after-on'])

  r.log.reset()
  const afterReset = r.log.watch(undefined, () => undefined)!
  assert.deepEqual(afterReset.events, [])
  r.log.onWait('s', batch('ready', true))
  const fresh = r.log.watch(undefined, () => undefined)!.events[0]
  assert.notEqual(fresh.pos.epoch, answer.events[0].pos.epoch)
  assert.equal(fresh.pos.seq, 1)
})

test('no event is lost or repeated across a subscribe', () => {
  const r = rig()
  r.log.onWait('s', batch('ready', true))
  const live: AttentionEvent[] = []
  const answer = r.log.watch(undefined, (e) => live.push(e))!
  r.log.onWait('s', batch('awaiting-choice', false, 'X'))
  assert.deepEqual([...answer.events, ...live].map((e) => e.pos.seq), [1, 2])
})

test('a session that no longer exists raises nothing', () => {
  const r = rig()
  r.listen()
  r.log.onWait('gone', batch('ready', true))
  assert.equal(r.seen.length, 0)
})
