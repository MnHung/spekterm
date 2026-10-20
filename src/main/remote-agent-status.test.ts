import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { type AgentStatus, configureAgentStatus, readAgentStatus } from './agent-status'
import { type UsageTimers, type UsageView, usageView, watchUsage } from './remote-agent-status'

/** A payload shaped as the agent writes it, path-like fields included (measured, CLI 2.1.30x). */
const PAYLOAD = {
  session_id: 'abc',
  session_name: 'api-server-1a2b',
  transcript_path: '/home/me/.claude/projects/x/abc.jsonl',
  cwd: '/home/me/git/api-server',
  scratchpad_dir: '/tmp/scratch',
  workspace: { current_dir: '/home/me/git/api-server', project_dir: '/home/me/git/api-server' },
  version: '2.1.304',
  output_style: { name: 'Concise' },
  model: { id: 'claude-opus', display_name: 'Opus 5.5' },
  effort: { level: 'high' },
  thinking: { enabled: true },
  context_window: { used_percentage: 41, total_input_tokens: 82_000, context_window_size: 200_000 },
  cost: { total_cost_usd: 1.25, total_lines_added: 10, total_lines_removed: 2 },
  rate_limits: { five_hour: { used_percentage: 5, resets_at: 1_760_000_000 }, seven_day: { used_percentage: 30, resets_at: 1_760_500_000 } },
  something_new: { path: '/home/me/secret' },
}

function read(payload: unknown): AgentStatus | undefined {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-usage-'))
  configureAgentStatus(root)
  fs.mkdirSync(path.join(root, 'agent-status'), { recursive: true })
  fs.writeFileSync(path.join(root, 'agent-status', 's1.json'), JSON.stringify(payload))
  return readAgentStatus('s1')
}

test('each reported value is mapped, and nothing else from the payload reaches the view', () => {
  // Control group: build the view as `{ sessionId, ...status }` → the deepEqual fails on the extra fields (red).
  assert.deepEqual(usageView('s1', read(PAYLOAD)), {
    sessionId: 's1',
    model: 'Opus 5.5',
    effort: 'high',
    context: { percent: 41, size: 200_000 },
    costUsd: 1.25,
    rateLimits: {
      fiveHour: { percent: 5, resetsAt: 1_760_000_000_000 },
      sevenDay: { percent: 30, resetsAt: 1_760_500_000_000 },
    },
  })
  const encoded = JSON.stringify(usageView('s1', read(PAYLOAD)))
  for (const leak of ['/home/me', '/tmp/scratch', 'api-server', '2.1.304', 'Concise', 'abc']) {
    assert.equal(encoded.includes(leak), false, leak)
  }
})

test('no payload is the session id alone', () => {
  assert.deepEqual(usageView('s1', undefined), { sessionId: 's1' })
  assert.deepEqual(usageView('s1', read({})), { sessionId: 's1' })
})

test('partial reports keep only what was reported; a non-positive reset time is absent', () => {
  assert.deepEqual(usageView('s1', { contextPercent: 3 }), { sessionId: 's1', context: { percent: 3 } })
  assert.deepEqual(usageView('s1', { fiveHourPercent: 7, fiveHourResetsAt: 0 }), {
    sessionId: 's1',
    rateLimits: { fiveHour: { percent: 7 } },
  })
  assert.deepEqual(usageView('s1', { fiveHourResetsAt: 1_760_000_000 }), { sessionId: 's1' }, 'a reset time with no percent')
  assert.deepEqual(usageView('s1', { costUsd: Number.NaN, contextSize: Infinity }), { sessionId: 's1' })
})

test('text is cleaned and clipped', () => {
  const view = usageView('s1', { model: `Op\x1b[31mus\n${'x'.repeat(200)}`, effort: '\x07' })
  assert.equal(view.model?.includes('\x1b'), false)
  assert.equal(view.model?.includes('\n'), false)
  assert.equal(view.model?.length, 80)
  assert.equal(view.effort, undefined)
})

function manualTimers() {
  let tick: (() => void) | null = null
  let cleared = false
  const timers: UsageTimers = {
    setInterval: (fn) => {
      tick = fn
      return 1
    },
    clearInterval: () => void (cleared = true),
  }
  return { timers, tick: () => tick?.(), cleared: () => cleared }
}

test('a watch sends at once, then only on a change, and keeps polling an absent payload until stopped', () => {
  const t = manualTimers()
  let status: AgentStatus | undefined
  const sent: UsageView[] = []
  const watch = watchUsage('s1', () => status, (view) => sent.push(view), 2000, t.timers)
  assert.deepEqual(sent, [{ sessionId: 's1' }], 'nothing reported yet is still sent once')
  t.tick()
  t.tick()
  assert.equal(sent.length, 1, 'an unchanged payload sends nothing')
  status = { model: 'Opus', contextPercent: 10 }
  t.tick()
  assert.deepEqual(sent[1], { sessionId: 's1', model: 'Opus', context: { percent: 10 } }, 'a first report later is sent')
  t.tick()
  assert.equal(sent.length, 2)
  status = { model: 'Opus', contextPercent: 12 }
  t.tick()
  assert.equal(sent.length, 3, 'a change sends once')
  watch.stop()
  assert.equal(t.cleared(), true)
})
