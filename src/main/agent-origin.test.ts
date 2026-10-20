import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  armOrigin,
  clearOrigin,
  configureAgentOrigin,
  ORIGIN_COMMAND,
  ORIGIN_FILE_ENV,
  ORIGIN_TTL_S,
  originNoteJson,
  prepareOriginInjection,
} from './agent-origin'
import { configureAgentEvents, EVENT_COMMAND, prepareEventInjection } from './agent-events'
import { composeInjection } from './agent-injection'
import { phoneOriginNote } from './agent-protocol-copy'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-origin-'))
}

/** Runs the hook command the way the agent does: a JSON payload on stdin, the session's environment. */
function runHook(markFile: string | undefined, command = ORIGIN_COMMAND) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env[ORIGIN_FILE_ENV]
  if (markFile !== undefined) env[ORIGIN_FILE_ENV] = markFile
  return spawnSync('sh', ['-c', command], {
    input: '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}',
    env,
    encoding: 'utf8',
  })
}

function prepared(): { root: string; mark: string } {
  const root = tmp()
  configureAgentOrigin(root)
  const contribution = prepareOriginInjection('s1', true)
  assert.ok(contribution)
  return { root, mark: contribution.env[ORIGIN_FILE_ENV] }
}

test('an armed mark within its deadline prints exactly the note, once, and is taken', () => {
  const { root, mark } = prepared()
  assert.equal(armOrigin('s1'), true)
  const first = runHook(mark)
  assert.equal(first.status, 0, `stderr: ${first.stderr}`)
  assert.equal(first.stderr, '')
  assert.equal(first.stdout, originNoteJson())
  assert.deepEqual(JSON.parse(first.stdout), {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: phoneOriginNote() },
  })
  assert.deepEqual(fs.readdirSync(path.join(root, 'agent-origin')), [])

  const second = runHook(mark)
  assert.equal(second.status, 0)
  assert.equal(second.stdout, '')
})

test('an expired mark prints nothing and is removed', () => {
  const { root, mark } = prepared()
  assert.equal(armOrigin('s1', Date.now() - (ORIGIN_TTL_S + 5) * 1000), true)
  const result = runHook(mark)
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.deepEqual(fs.readdirSync(path.join(root, 'agent-origin')), [])
})

test('no mark, an unset variable and an unreadable mark print nothing and exit 0', () => {
  const { mark } = prepared()
  for (const file of [mark, undefined, '', path.join(tmp(), 'missing-dir', 'x')]) {
    const result = runHook(file)
    assert.equal(result.status, 0, `${file}: ${result.stderr}`)
    assert.equal(result.stdout, '', String(file))
    assert.equal(result.stderr, '', String(file))
  }
  // A mark whose content is not a number.
  fs.writeFileSync(mark, 'garbage')
  const result = runHook(mark)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(fs.existsSync(mark), false)
})

test('the command consumes its stdin', () => {
  // A large payload the command never read would block the writer once the pipe is full.
  const result = spawnSync('sh', ['-c', ORIGIN_COMMAND], {
    input: 'x'.repeat(1024 * 1024),
    env: { ...process.env, [ORIGIN_FILE_ENV]: '' },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
})

test('arming writes the deadline now + 10 s, through a temporary name', () => {
  const { mark } = prepared()
  const now = 1_700_000_000_500
  assert.equal(armOrigin('s1', now), true)
  assert.equal(fs.readFileSync(mark, 'utf8'), String(1_700_000_000 + 10))
  assert.equal(ORIGIN_TTL_S, 10)
  assert.equal(fs.existsSync(`${mark}.arming`), false)
})

test('arming returns false and throws nothing when it cannot write', () => {
  const root = tmp()
  configureAgentOrigin(root)
  // The directory was never prepared.
  assert.equal(armOrigin('s1'), false)
})

test('preparing returns null when disabled, and the hook and the mark file when enabled', () => {
  const root = tmp()
  configureAgentOrigin(root)
  assert.equal(prepareOriginInjection('s1', false), null)
  const contribution = prepareOriginInjection('s1', true)
  assert.deepEqual(contribution?.settings, {})
  assert.deepEqual(contribution?.hooks, { UserPromptSubmit: [ORIGIN_COMMAND] })
  assert.deepEqual(contribution?.env, { [ORIGIN_FILE_ENV]: path.join(root, 'agent-origin', 's1') })
})

test('preparing removes a stale mark of the session, and clearing removes what a killed hook left', () => {
  const { root, mark } = prepared()
  armOrigin('s1')
  fs.writeFileSync(`${mark}.4242`, '1')
  fs.writeFileSync(path.join(root, 'agent-origin', 's2'), '1')
  prepareOriginInjection('s1', true)
  assert.deepEqual(fs.readdirSync(path.join(root, 'agent-origin')), ['s2'])
  fs.writeFileSync(`${mark}.4243`, '1')
  clearOrigin('s1')
  assert.deepEqual(fs.readdirSync(path.join(root, 'agent-origin')), ['s2'])
})

test('composed with the event bridge, UserPromptSubmit runs the bridge first and the origin command second', () => {
  const root = tmp()
  configureAgentOrigin(root)
  configureAgentEvents(root)
  const file = path.join(root, 'agent-injection', 'settings.json')
  const injection = composeInjection(file, [prepareEventInjection('s1', true), prepareOriginInjection('s1', true)])
  assert.ok(injection)
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  const commands = settings.hooks.UserPromptSubmit[0].hooks.map((h: { command: string }) => h.command)
  assert.deepEqual(commands, [EVENT_COMMAND, ORIGIN_COMMAND])
  assert.equal(injection.env[ORIGIN_FILE_ENV], path.join(root, 'agent-origin', 's1'))
})
