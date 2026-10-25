import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  armModelSwitch,
  clearModelSwitch,
  configureAgentModelSwitch,
  isModelName,
  MODEL_COMMAND,
  MODEL_FILE_ENV,
  MODEL_GRACE_S,
  MODEL_TTL_S,
  modelCommandName,
  prepareModelSwitchInjection,
} from './agent-model-switch'
import { composeInjection } from './agent-injection'

const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PreModelSwitch","permissionDecision":"allow"}}'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-'))
}

/** The payload as the agent writes it (measured, CLI 2.1.310): compact JSON. */
function payload(requested: string, source = 'command', spaced = false): string {
  const json = JSON.stringify({
    hook_event_name: 'PreModelSwitch',
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: requested,
    source,
    prompt_cache_warm: true,
  })
  return spaced ? json.replace(/":/g, '": ') : json
}

function runHook(markFile: string | undefined, input: string) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env[MODEL_FILE_ENV]
  if (markFile !== undefined) env[MODEL_FILE_ENV] = markFile
  return spawnSync('sh', ['-c', MODEL_COMMAND], { input, env, encoding: 'utf8' })
}

function prepared(): { root: string; mark: string } {
  const root = tmp()
  configureAgentModelSwitch(root)
  const contribution = prepareModelSwitchInjection('s1', true)
  assert.ok(contribution)
  return { root, mark: contribution.env[MODEL_FILE_ENV] }
}

test('one switch asking the hook twice is allowed both times', () => {
  const { mark } = prepared()
  assert.equal(armModelSwitch('s1', 'haiku'), true)
  for (let i = 0; i < 2; i += 1) {
    const run = runHook(mark, payload('haiku'))
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stderr, '')
    assert.equal(run.stdout, ALLOW)
  }
})

test('the allow cuts the mark to the grace, and a run after it prints nothing', () => {
  const { mark } = prepared()
  const now = Date.now()
  armModelSwitch('s1', 'sonnet', now)
  assert.equal(runHook(mark, payload('sonnet')).stdout, ALLOW)
  const [deadline] = fs.readFileSync(mark, 'utf8').split('\n')
  assert.ok(Number(deadline) <= Math.floor(Date.now() / 1000) + MODEL_GRACE_S)
  // The grace over: the mark's deadline in the past.
  fs.writeFileSync(mark, `${Math.floor(Date.now() / 1000) - 1}\nsonnet\n`)
  const late = runHook(mark, payload('sonnet'))
  assert.equal(late.status, 0)
  assert.equal(late.stdout, '')
})

test('nothing is printed without a mark, for a picker switch, or without the variable', () => {
  const { mark } = prepared()
  assert.equal(runHook(mark, payload('sonnet')).stdout, '')
  armModelSwitch('s1', 'sonnet')
  const picker = runHook(mark, payload('sonnet', 'picker'))
  assert.equal(picker.status, 0)
  assert.equal(picker.stdout, '')
  const bare = runHook(undefined, payload('sonnet'))
  assert.equal(bare.status, 0)
  assert.equal(bare.stdout, '')
  // The picker run did not use the mark up.
  assert.equal(runHook(mark, payload('sonnet')).stdout, ALLOW)
})

test('a different name prints nothing and leaves the mark for the right one', () => {
  const { mark } = prepared()
  armModelSwitch('s1', 'sonnet')
  assert.equal(runHook(mark, payload('opus')).stdout, '')
  assert.equal(runHook(mark, payload('sonnet')).stdout, ALLOW)
})

test('the name is compared lower-cased, as the agent reports it', () => {
  const { mark } = prepared()
  armModelSwitch('s1', 'Sonnet')
  assert.equal(runHook(mark, payload('sonnet')).stdout, ALLOW)
})

test('spaces in the agent payload do not matter, and a name with brackets is literal', () => {
  const { mark } = prepared()
  armModelSwitch('s1', 'opus[1m]')
  assert.equal(runHook(mark, payload('opus[1m]', 'command', true)).stdout, ALLOW)
  armModelSwitch('s1', 'opus[1m]')
  // A glob character in the mark must not match another name.
  assert.equal(runHook(mark, payload('opus1')).stdout, '')
})

test('a lapsed mark prints nothing', () => {
  const { mark } = prepared()
  armModelSwitch('s1', 'sonnet', Date.now() - (MODEL_TTL_S + 5) * 1000)
  const run = runHook(mark, payload('sonnet'))
  assert.equal(run.status, 0)
  assert.equal(run.stdout, '')
})

test('an unreadable or garbled mark prints nothing and exits 0', () => {
  const { mark } = prepared()
  fs.writeFileSync(mark, 'garbage')
  const run = runHook(mark, payload('sonnet'))
  assert.equal(run.status, 0)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr, '')
})

test('preparing clears an old mark; a session not taking part gets nothing; clearing removes the mark', () => {
  const { root, mark } = prepared()
  armModelSwitch('s1', 'sonnet')
  assert.ok(prepareModelSwitchInjection('s1', true))
  assert.equal(fs.existsSync(mark), false)
  assert.equal(prepareModelSwitchInjection('s1', false), null)
  armModelSwitch('s1', 'sonnet')
  clearModelSwitch('s1')
  assert.deepEqual(fs.readdirSync(path.join(root, 'agent-model')), [])
})

test('the contribution registers the hook and the variable and composes with others', () => {
  const root = tmp()
  configureAgentModelSwitch(root)
  const contribution = prepareModelSwitchInjection('s1', true)
  const composed = composeInjection(path.join(root, 'settings.json'), [contribution])
  assert.ok(composed)
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.hooks.PreModelSwitch[0].hooks, [{ type: 'command', command: MODEL_COMMAND }])
  assert.ok(composed.env[MODEL_FILE_ENV])
})

test('model names and commands', () => {
  for (const ok of ['sonnet', 'opus[1m]', 'claude-sonnet-4@20250514', 'anthropic.claude-v2:0', 'a'.repeat(100)]) {
    assert.equal(isModelName(ok), true, ok)
  }
  for (const bad of ['', '-x', 'a b', 'a\nb', "a'b", 'a"b', 'a'.repeat(101), 'a;b', '$x', 5, null]) {
    assert.equal(isModelName(bad), false, String(bad))
  }
  assert.equal(modelCommandName('/model sonnet'), 'sonnet')
  for (const text of ['/model', '/model ', '/model a b', '/effort high', 'model sonnet', '/model sonnet\nx', '/model -x']) {
    assert.equal(modelCommandName(text), null, text)
  }
})
