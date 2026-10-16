import assert from 'node:assert/strict'
import test from 'node:test'

import type { FinishedCall, OpenRequest, Question } from './agent-events'
import { type AnswerDeps, KEY_GAP_MS, planKeys, promptView, writeAnswer } from './remote-answer'
import { RemoteError } from './remote-frames'

const request = (extra: Partial<OpenRequest> = {}): OpenRequest => ({
  id: 'r1',
  toolUseId: 't1',
  agentId: null,
  tool: 'Bash',
  arg: 'ls',
  questions: null,
  plan: null,
  at: 1000,
  answeredAt: null,
  stirred: false,
  ...extra,
})

const q = (question: string, labels: string[], multiSelect = false): Question => ({
  question,
  header: question,
  multiSelect,
  options: labels.map((label) => ({ label, description: '' })),
})

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    return error instanceof RemoteError ? error.code : String(error)
  }
  return 'no error'
}

test('key plans match the measured screens, and none contains Enter', () => {
  const plans = [
    planKeys(request(), 'allow'),
    planKeys(request(), 'deny'),
    planKeys(request({ tool: 'AskUserQuestion', questions: [q('Color?', ['Red', 'Green', 'Blue'])] }), 'answer', [[1]]),
    planKeys(
      request({ tool: 'AskUserQuestion', questions: [q('Fruit?', ['Apple', 'Banana']), q('Toppings?', ['Salt', 'Sugar', 'Honey'], true)] }),
      'answer',
      [[1], [2, 0]],
    ),
    planKeys(request({ tool: 'AskUserQuestion', questions: [q('Toppings?', ['Salt', 'Sugar', 'Honey'], true)] }), 'answer', [[1]]),
    planKeys(request({ tool: 'ExitPlanMode', plan: 'do it' }), 'approve'),
    planKeys(request({ tool: 'ExitPlanMode', plan: 'do it' }), 'approve-auto'),
    planKeys(request({ tool: 'ExitPlanMode', plan: null }), 'approve'),
  ]
  assert.deepEqual(
    plans.map((plan) => plan.keys),
    [['1'], ['\x1b'], ['2'], ['2', '1', '3', '\t', '1'], ['2', '\t', '1'], ['2'], ['1'], ['1']],
  )
  for (const plan of plans) assert.ok(!plan.keys.some((key) => key.includes('\r')), JSON.stringify(plan.keys))
  assert.deepEqual(plans[3].expect, { answers: { 'Fruit?': 'Banana', 'Toppings?': 'Salt, Honey' } })
  assert.deepEqual(plans[5].expect, { mode: 'default' })
  assert.deepEqual(plans[6].expect, { mode: 'auto' })
})

test('refusals: a decision that does not fit, an unmeasured tool, the plan without a plan, bad selections', () => {
  assert.equal(code(() => planKeys(request({ tool: 'mcp__x__y' }), 'allow')), 'NOT_ANSWERABLE')
  assert.equal(code(() => planKeys(request({ tool: 'ExitPlanMode', plan: 'p' }), 'allow')), 'NOT_ANSWERABLE')
  assert.equal(code(() => planKeys(request({ tool: 'ExitPlanMode', plan: null }), 'approve-auto')), 'NOT_ANSWERABLE')
  assert.equal(code(() => planKeys(request(), 'answer', [[0]])), 'NOT_ANSWERABLE')
  assert.equal(code(() => planKeys(request(), 'approve')), 'NOT_ANSWERABLE')
  const asked = request({ tool: 'AskUserQuestion', questions: [q('A?', ['x', 'y']), q('B?', ['u', 'v'], true)] })
  for (const bad of [undefined, [[0]], [[0, 1], [0]], [[2], [0]], [[0], []], [[0], [1, 1]], [['0'], [0]]]) {
    assert.equal(code(() => planKeys(asked, 'answer', bad)), 'BAD_PARAMS', JSON.stringify(bad))
  }
  const tooMany = request({ tool: 'AskUserQuestion', questions: [q('A?', ['1', '2', '3', '4', '5', '6', '7', '8', '9'])] })
  assert.equal(code(() => planKeys(tooMany, 'answer', [[0]])), 'NOT_ANSWERABLE')
  // Denying is always possible.
  assert.deepEqual(planKeys(tooMany, 'deny').keys, ['\x1b'])
})

test('the prompt a device is shown, and when it may answer', () => {
  assert.equal(promptView([], null), null)
  assert.deepEqual(promptView([request()], null), {
    id: 'r1', kind: 'permission', tool: 'Bash', arg: 'ls', canAllow: true, answerable: true, open: 1,
  })
  assert.equal((promptView([request({ tool: 'ExitPlanMode', plan: 'p' })], null) as { canAllow?: boolean }).canAllow, undefined)
  assert.deepEqual(promptView([request({ tool: 'ExitPlanMode', plan: 'p' })], null), {
    id: 'r1', kind: 'plan', plan: 'p', choices: ['approve', 'approve-auto', 'deny'], answerable: true, open: 1,
  })
  assert.deepEqual((promptView([request({ tool: 'ExitPlanMode' })], null) as { choices: string[] }).choices, ['approve', 'deny'])
  const view = (requests: OpenRequest[], key: number | null) => promptView(requests, key)?.answerable
  assert.equal(view([request(), request({ id: 'r2' })], null), false, 'two open')
  assert.equal(view([request()], 1001), false, 'typed after it appeared')
  assert.equal(view([request()], 999), true, 'typed before it appeared')
  assert.equal(view([request({ stirred: true })], null), false)
  assert.equal(view([request({ answeredAt: 5 })], null), false)
  assert.equal(view([request({ tool: 'AskUserQuestion', questions: null })], null), false)
})

function rig(initial: OpenRequest[], finished: FinishedCall | null = null) {
  let requests = initial
  let keystroke: number | null = null
  const written: string[] = []
  const dismissed: string[] = []
  const between: (() => void)[] = []
  const deps: AnswerDeps = {
    refresh: () => requests,
    lastKeystrokeAt: () => keystroke,
    write: (_id, key) => {
      written.push(key)
      return true
    },
    markAnswered: (_id, requestId, at) => {
      requests = requests.map((r) => (r.id === requestId ? { ...r, answeredAt: at } : r))
    },
    dismiss: (_id, requestId) => dismissed.push(requestId),
    awaitFinished: async () => finished,
    delay: async (ms) => {
      assert.equal(ms, KEY_GAP_MS)
      between.shift()?.()
    },
    now: () => 2000,
  }
  return {
    deps,
    written,
    dismissed,
    setRequests: (next: OpenRequest[]) => (requests = next),
    type: (at: number) => (keystroke = at),
    between,
  }
}

test('an allow writes one key, marks the request answered, and a second answer is refused', async () => {
  const r = rig([request()])
  assert.equal(await writeAnswer(r.deps, 's', 'r1', 'allow'), 'sent')
  assert.deepEqual(r.written, ['1'])
  await assert.rejects(writeAnswer(r.deps, 's', 'r1', 'allow'), { code: 'PROMPT_GONE' })
  assert.deepEqual(r.written, ['1'], 'nothing more written')
})

test('each check withholds the first key with PROMPT_GONE', async () => {
  const cases: [string, (r: ReturnType<typeof rig>) => void][] = [
    ['two open', (r) => r.setRequests([request(), request({ id: 'r2' })])],
    ['another id', (r) => r.setRequests([request({ id: 'r9' })])],
    ['desktop typed', (r) => r.type(1500)],
    ['stirred', (r) => r.setRequests([request({ stirred: true })])],
    ['answered before', (r) => r.setRequests([request({ answeredAt: 1 })])],
  ]
  for (const [label, arrange] of cases) {
    const r = rig([request()])
    arrange(r)
    await assert.rejects(writeAnswer(r.deps, 's', 'r1', 'deny'), { code: 'PROMPT_GONE' }, label)
    assert.deepEqual(r.written, [], label)
    assert.deepEqual(r.dismissed, [], label)
  }
})

test('each check withholds a later key and the answer is partial', async () => {
  const asked = request({ tool: 'AskUserQuestion', questions: [q('A?', ['x', 'y']), q('B?', ['u', 'v'])] })
  const cases: [string, (r: ReturnType<typeof rig>) => void][] = [
    ['another request queued', (r) => r.setRequests([{ ...asked, answeredAt: 2000 }, request({ id: 'r2' })])],
    ['the request ended', (r) => r.setRequests([])],
    ['desktop typed', (r) => r.type(1500)],
    ['stirred', (r) => r.setRequests([{ ...asked, answeredAt: 2000, stirred: true }])],
  ]
  for (const [label, arrange] of cases) {
    const r = rig([asked])
    r.between.push(() => arrange(r))
    assert.equal(await writeAnswer(r.deps, 's', 'r1', 'answer', [[0], [1]]), 'partial', label)
    assert.deepEqual(r.written, ['1'], label)
  }
})

test('a question\'s answer is confirmed, or reported as differing, from the agent\'s record', async () => {
  const asked = request({ tool: 'AskUserQuestion', questions: [q('A?', ['x', 'y'])] })
  const ok = rig([asked], { toolUseId: 't1', answers: { 'A?': 'y' }, permissionMode: 'default' })
  assert.equal(await writeAnswer(ok.deps, 's', 'r1', 'answer', [[1]]), 'confirmed')
  const off = rig([asked], { toolUseId: 't1', answers: { 'A?': 'x' }, permissionMode: 'default' })
  assert.equal(await writeAnswer(off.deps, 's', 'r1', 'answer', [[1]]), 'mismatch')
  const none = rig([asked])
  assert.equal(await writeAnswer(none.deps, 's', 'r1', 'answer', [[1]]), 'sent')
})

test('a plan approval is confirmed by the mode the agent reports next', async () => {
  const plan = request({ tool: 'ExitPlanMode', plan: 'p' })
  const auto = rig([plan], { toolUseId: 't1', answers: null, permissionMode: 'auto' })
  assert.equal(await writeAnswer(auto.deps, 's', 'r1', 'approve-auto'), 'confirmed')
  assert.deepEqual(auto.written, ['1'])
  const wrong = rig([plan], { toolUseId: 't1', answers: null, permissionMode: 'default' })
  assert.equal(await writeAnswer(wrong.deps, 's', 'r1', 'approve-auto'), 'mismatch')
})

test('a deny writes Esc and closes the request', async () => {
  const r = rig([request()])
  assert.equal(await writeAnswer(r.deps, 's', 'r1', 'deny'), 'sent')
  assert.deepEqual(r.written, ['\x1b'])
  assert.deepEqual(r.dismissed, ['r1'])
})
