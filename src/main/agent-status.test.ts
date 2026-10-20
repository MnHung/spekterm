import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { configureAgentStatus, readAgentStatus } from './agent-status'

function withPayload(payload: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
  configureAgentStatus(root)
  fs.mkdirSync(path.join(root, 'agent-status'), { recursive: true })
  fs.writeFileSync(path.join(root, 'agent-status', 's1.json'), JSON.stringify(payload))
  return root
}

test('the context window size is read from the payload', () => {
  withPayload({
    model: { display_name: 'Opus' },
    context_window: { used_percentage: 12.5, total_input_tokens: 25_000, context_window_size: 200_000 },
  })
  const status = readAgentStatus('s1')
  assert.equal(status?.contextSize, 200_000)
  assert.equal(status?.contextPercent, 12.5)
  assert.equal(status?.contextTokens, 25_000)
  assert.equal(status?.model, 'Opus')
})

test('a missing or non-numeric window size is absent', () => {
  withPayload({ context_window: { context_window_size: 'big' } })
  assert.equal(readAgentStatus('s1')?.contextSize, undefined)
  withPayload({})
  assert.equal(readAgentStatus('s1')?.contextSize, undefined)
})
