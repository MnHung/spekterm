import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { configureAgentEvents, drainEvents, HOOKED_EVENTS, parseEvent, prepareEventInjection, type HeldWait } from './agent-events'
import { clearWait, dismissRequest, forgetRequests, foldDrain, inTurnOf, openRequestsOf, waitStateOf } from './agent-wait'

/**
 * Turn tracking (`agent-session-control` design D3, measured CLI 2.1.301 in `docs/lessons/transcript.md`, "Turn
 * boundaries"): a turn is an own submission or a keystroke since the last turn end, and only the agent's own turn
 * boundaries end it.
 */

const roots: string[] = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** Event file names carry nanoseconds; times shorter than 16 digits read as "now" (`fileTimeOf`). */
const T0 = 1_790_000_000_000
let seq = 0
/** A session whose events are written with explicit wall-clock times (ms), as the injected hook names them. */
function session(): { id: string; at: (ms: number, body: Record<string, unknown>) => void; drain: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-turn-'))
  roots.push(root)
  configureAgentEvents(root)
  const id = `turn-${++seq}`
  clearWait(id)
  const dir = prepareEventInjection(id, true)!.env.SPEKTERM_EVENT_DIR
  let held: HeldWait | undefined
  return {
    id,
    at: (ms, body) => fs.writeFileSync(path.join(dir, `${BigInt(T0 + ms) * 1_000_000n}-1.json`), JSON.stringify(body)),
    drain: () => {
      const result = drainEvents(id, held)
      held = result.held
      foldDrain(id, result)
    },
  }
}
const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name, ...extra })

describe('a turn starts with a submission or a keystroke', () => {
  it('a fresh session with no events and no keystroke is at rest', () => {
    const s = session()
    assert.equal(inTurnOf(s.id, null), false)
  })

  it('an own submission starts a turn and its Stop ends it', () => {
    const s = session()
    s.at(1_000, ev('SessionStart', { source: 'startup' }))
    s.at(2_000, ev('UserPromptSubmit'))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 1_900), true)
    s.at(3_000, ev('Stop', { background_tasks: [] }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 1_900), false)
  })

  it('a keystroke after the last turn end with no event (a `!cmd`) is a turn until the next Stop', () => {
    const s = session()
    s.at(1_000, ev('SessionStart', { source: 'startup' }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 1_500), true)
    s.at(2_000, ev('Stop'))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 1_500), false)
  })

  it('an own PreToolUse alone does not start a turn', () => {
    const s = session()
    s.at(1_000, ev('Stop'))
    s.at(2_000, ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1' }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 500), false)
  })
})

describe('only the agent\'s own turn boundaries end a turn', () => {
  it('idle_prompt and a stray subagent PreToolUse after Stop leave the session at rest', () => {
    const s = session()
    s.at(1_000, ev('UserPromptSubmit'))
    s.at(2_000, ev('Stop'))
    s.at(3_000, ev('PreToolUse', { tool_name: 'Read', agent_id: 'sub1', tool_use_id: 't1' }))
    s.at(62_000, ev('Notification', { notification_type: 'idle_prompt' }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), false)
    assert.equal(waitStateOf(s.id), 'ready')
  })

  it('a compaction the agent starts inside a turn neither ends nor starts it', () => {
    const s = session()
    s.at(1_000, ev('UserPromptSubmit'))
    s.at(2_000, ev('PreCompact', { trigger: 'auto' }))
    s.at(3_000, ev('SessionStart', { source: 'compact' }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), true)
  })

  it("the user's /compact ends the turn the user started with it, with no Stop", () => {
    const s = session()
    s.at(1_000, ev('Stop'))
    s.drain()
    const typed = 1_500
    assert.equal(inTurnOf(s.id, T0 + typed), true)
    s.at(2_000, ev('PreCompact', { trigger: 'manual' }))
    s.at(11_000, ev('SubagentStop', { agent_id: 'helper' }))
    s.at(11_100, ev('SessionStart', { source: 'compact' }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + typed), false)
  })

  it('PreCompact moves no wait state', () => {
    const s = session()
    s.at(1_000, ev('Stop'))
    s.drain()
    s.at(2_000, ev('PreCompact', { trigger: 'manual' }))
    s.drain()
    assert.equal(waitStateOf(s.id), 'ready')
    assert.ok((HOOKED_EVENTS as readonly string[]).includes('PreCompact'))
  })

  it('a Stop with a background subagent running keeps the turn, and the later Stop with none ends it', () => {
    const s = session()
    s.at(1_000, ev('UserPromptSubmit'))
    s.at(2_000, ev('Stop', { background_tasks: [{ id: 'a1', type: 'local_agent', status: 'running' }] }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), true)
    s.at(30_000, ev('UserPromptSubmit', { prompt: '<task-notification>' }))
    s.at(31_000, ev('Stop', { background_tasks: [] }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), false)
  })

  it('a background shell does not hold the turn', () => {
    const s = session()
    s.at(1_000, ev('UserPromptSubmit'))
    s.at(2_000, ev('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'sleep 40' }] }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), false)
    assert.equal(parseEvent(ev('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }))?.backgroundAgentRunning, false)
  })

  it('a subagent StopFailure does not end the turn, an own one does', () => {
    const s = session()
    s.at(1_000, ev('UserPromptSubmit'))
    s.at(2_000, ev('StopFailure', { agent_id: 'sub1' }))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), true)
    s.at(3_000, ev('StopFailure'))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), false)
  })

  it('a start, resume or clear ends any turn', () => {
    for (const source of ['startup', 'resume', 'clear']) {
      const s = session()
      s.at(1_000, ev('UserPromptSubmit'))
      s.at(2_000, ev('SessionStart', { source }))
      s.drain()
      assert.equal(inTurnOf(s.id, T0 + 900), false, source)
    }
  })

  it("a device dismissing the agent's own prompt ends the turn; dismissing a subagent's does not", () => {
    const own = session()
    own.at(1_000, ev('UserPromptSubmit'))
    own.at(2_000, ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } }))
    own.at(2_100, ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
    own.drain()
    assert.equal(inTurnOf(own.id, T0 + 900), true)
    assert.ok(dismissRequest(own.id, openRequestsOf(own.id)[0]!.id))
    assert.equal(inTurnOf(own.id, T0 + 900), false)

    const sub = session()
    sub.at(1_000, ev('UserPromptSubmit'))
    sub.at(2_100, ev('PermissionRequest', { tool_name: 'Bash', agent_id: 'sub1', tool_input: { command: 'ls' } }))
    sub.drain()
    assert.ok(dismissRequest(sub.id, openRequestsOf(sub.id)[0]!.id))
    assert.equal(inTurnOf(sub.id, T0 + 900), true)
  })

  it('the process ending resets the turn', () => {
    const s = session()
    s.at(1_000, ev('UserPromptSubmit'))
    s.drain()
    assert.equal(inTurnOf(s.id, T0 + 900), true)
    forgetRequests(s.id)
    assert.equal(inTurnOf(s.id, T0 + 900), false)
  })
})
