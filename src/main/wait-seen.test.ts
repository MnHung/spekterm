import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { configureAgentEvents, prepareEventInjection } from './agent-events'
import { clearWait, observeWaits, pokeWait, refreshWait, subscribeWait } from './agent-wait'
import { noteWrite } from './pty-input'
import { SeenMarks } from './wait-seen'

const bases: string[] = []
/** Every harness still subscribed: a failed assertion skips its `done()`, and a live timer would hold the process. */
const live = new Set<() => void>()
after(() => {
  for (const done of [...live]) done()
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})

let counter = 0

/**
 * One session on the real drain path: events are written as the injected hook writes them, drained by `refreshWait`
 * (the timer's own `tick`), and every batch reaches the marks through `observeWaits` — the wiring `index.ts` uses.
 */
function harness(lookedAt = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-seen-'))
  bases.push(base)
  configureAgentEvents(base)
  const sessionId = `seen-${++counter}`
  prepareEventInjection(sessionId, true)
  const looking = { now: lookedAt }
  const marks = new SeenMarks(() => looking.now)
  const stopObserving = observeWaits((id, snapshot) => {
    if (id === sessionId) marks.onBatch(id, snapshot)
  })
  const unsubscribe = subscribeWait(sessionId, () => {})
  // Event times are wall-clock ms in the file name; keystrokes use the same clock. Start well in the past so every
  // explicit time below is ordered.
  let clock = Date.now() - 60_000
  const dir = path.join(base, 'agent-events', sessionId)
  const done = (): void => {
    live.delete(done)
    stopObserving()
    unsubscribe()
    clearWait(sessionId)
  }
  live.add(done)
  return {
    sessionId,
    marks,
    looking,
    fire(body: Record<string, unknown>): void {
      clock += 10
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${BigInt(clock) * 1_000_000n}-x.json`), JSON.stringify(body))
    },
    key(): void {
      clock += 10
      noteWrite(sessionId, 'x', undefined, clock)
    },
    drain(): void {
      refreshWait(sessionId)
    },
    seen(): boolean {
      return marks.seenOf(sessionId)
    },
    done,
  }
}

describe('SeenMarks on the real drain path', () => {
  it('a turn that ends unseen is unseen; while looked at it is seen at once', () => {
    const h = harness()
    h.fire({ hook_event_name: 'SessionStart', source: 'startup' })
    h.drain()
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    h.drain()
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    assert.equal(h.seen(), false)
    h.done()

    const looked = harness(true)
    looked.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    looked.drain()
    looked.fire({ hook_event_name: 'Stop' })
    looked.drain()
    assert.equal(looked.seen(), true)
    looked.done()
  })

  it('a failed turn after a prompt is unseen', () => {
    const h = harness()
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    h.drain()
    h.fire({ hook_event_name: 'StopFailure', error: 'server_error' })
    h.drain()
    assert.equal(h.seen(), false)
    h.done()
  })

  it('a start or a resume that reports only its start is seen', () => {
    const h = harness()
    h.fire({ hook_event_name: 'SessionStart', source: 'resume' })
    h.drain()
    assert.equal(h.seen(), true)
    h.done()
  })

  it('a late subagent tool start after an unseen turn end leaves it unseen', () => {
    const h = harness()
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    h.drain()
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    h.fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'sub1' })
    h.drain()
    assert.equal(h.seen(), false)
    h.done()
  })

  it('an automatic compaction within a turn sets no mark', () => {
    // Control: drop `!inTurn` from the turn-end test → this goes red.
    const h = harness()
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    h.drain()
    h.fire({ hook_event_name: 'PreCompact', trigger: 'auto' })
    h.fire({ hook_event_name: 'SessionStart', source: 'compact' })
    h.drain()
    assert.equal(h.seen(), true)
    h.done()
  })

  it("the user's /compact ends a turn with no Stop: unseen when not looked at", () => {
    // Control: reduce the turn-end test to `turnEnded` alone → this goes red.
    const h = harness()
    h.fire({ hook_event_name: 'SessionStart', source: 'startup' })
    h.drain()
    h.key()
    h.drain()
    h.fire({ hook_event_name: 'PreCompact', trigger: 'manual' })
    h.fire({ hook_event_name: 'SessionStart', source: 'compact' })
    h.drain()
    assert.equal(h.seen(), false)
    h.done()
  })

  it('a wake on a stale keystroke, then its resume, is seen', () => {
    // Control: drop the `sessionStarted` exception → this goes red.
    const h = harness()
    h.key()
    h.drain()
    // Hibernation: the process ends and its wait state goes (`clearWait`), the last keystroke stays.
    h.marks.forget(h.sessionId)
    clearWait(h.sessionId)
    subscribeWait(h.sessionId, () => {})
    h.drain()
    h.fire({ hook_event_name: 'SessionStart', source: 'resume' })
    h.drain()
    assert.equal(h.seen(), true)
    h.done()
  })

  it("a user's /clear while not looked at is seen", () => {
    const h = harness()
    h.fire({ hook_event_name: 'SessionStart', source: 'startup' })
    h.drain()
    h.key()
    h.drain()
    h.fire({ hook_event_name: 'SessionEnd' })
    h.fire({ hook_event_name: 'SessionStart', source: 'clear' })
    h.drain()
    assert.equal(h.seen(), true)
    h.done()
  })

  it('a !cmd (keystroke and Stop in one batch) while not looked at is unseen', () => {
    const h = harness()
    h.fire({ hook_event_name: 'SessionStart', source: 'startup' })
    h.drain()
    h.key()
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    assert.equal(h.seen(), false)
    h.done()
  })

  it('a poke changes nothing to the mark but records the turn state', () => {
    const h = harness()
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    h.drain()
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    assert.equal(h.seen(), false)
    pokeWait(h.sessionId)
    assert.equal(h.seen(), false)
    h.marks.lookedAt(h.sessionId)
    // A poke with `inTurn: false` after a batch in a turn: the next quiet tick must not read as a turn end.
    const quiet = harness()
    quiet.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    quiet.drain()
    quiet.marks.onBatch(quiet.sessionId, { state: 'ready', inTurn: false, turnEnded: false, sessionStarted: false, poke: true })
    quiet.marks.onBatch(quiet.sessionId, { state: 'ready', inTurn: false, turnEnded: false, sessionStarted: false, poke: false })
    assert.equal(quiet.seen(), true)
    quiet.done()
    h.done()
  })

  it('a new turn clears the mark, and the next unseen turn end sets it again', () => {
    const h = harness()
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'one' })
    h.drain()
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    assert.equal(h.seen(), false)
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'two' })
    h.drain()
    assert.equal(h.seen(), true)
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    assert.equal(h.seen(), false)
    h.done()
  })

  it('lookedAt clears it and reports the change once; forget drops it', () => {
    const h = harness()
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    h.drain()
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    assert.equal(h.marks.lookedAt(h.sessionId), true)
    assert.equal(h.marks.lookedAt(h.sessionId), false)
    assert.equal(h.seen(), true)
    h.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    h.drain()
    h.fire({ hook_event_name: 'Stop' })
    h.drain()
    assert.equal(h.seen(), false)
    h.marks.forget(h.sessionId)
    assert.equal(h.seen(), true)
    h.done()
  })
})
