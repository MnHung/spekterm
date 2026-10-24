import assert from 'node:assert/strict'
import test from 'node:test'

import { CALL_LIMIT, STRING_LIMIT, toolInput } from './transcript-tool-input'

// Inputs shaped as the CLI records them (CLI 2.1.30x, `remote-tool-detail` design, Context); values generic.
const rows: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['Bash', { command: 'ls -la', description: 'List', timeout: 1000, run_in_background: true }, { command: 'ls -la', description: 'List', run_in_background: true }],
  ['Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b', replace_all: false }, { file_path: '/r/a.ts', old_string: 'a', new_string: 'b', replace_all: false }],
  ['Write', { file_path: '/r/b.md', content: '# hi' }, { file_path: '/r/b.md', content: '# hi' }],
  ['Read', { file_path: '/r/c.ts', offset: 10, limit: 20, pages: '1-2' }, { file_path: '/r/c.ts', offset: 10, limit: 20 }],
  ['Grep', { pattern: 'x', path: '/r', glob: '*.ts', output_mode: 'content' }, { pattern: 'x', path: '/r', glob: '*.ts' }],
  ['Glob', { pattern: '**/*.ts', path: '/r' }, { pattern: '**/*.ts', path: '/r' }],
  [
    'SendMessage',
    { to: 'api-server-8393', recipient: 'api-server-8393', recipient_kind: 'name', type: 'message', summary: 'Hi', message: 'Hello there', content: 'Hello' },
    { to: 'api-server-8393', recipient_kind: 'name', summary: 'Hi', message: 'Hello there' },
  ],
  [
    'Agent',
    { description: 'Review', subagent_type: 'general-purpose', prompt: 'Look', model: 'x', run_in_background: 'true' },
    { description: 'Review', subagent_type: 'general-purpose', prompt: 'Look', run_in_background: 'true' },
  ],
  ['Task', { description: 'Review', prompt: 'Look' }, { description: 'Review', prompt: 'Look' }],
  ['Skill', { skill: 'opsx:apply', args: 'my-change' }, { skill: 'opsx:apply', args: 'my-change' }],
  ['SendUserFile', { files: ['/r/a.md'], caption: 'Draft', status: 'normal', display: 'render' }, { files: ['/r/a.md'], caption: 'Draft' }],
  [
    'AskUserQuestion',
    { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a', preview: 'big' }] }] },
    { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }] }] },
  ],
  ['ToolSearch', { query: 'select:X', max_results: 1 }, { query: 'select:X' }],
  ['WebSearch', { query: 'node', mode: 'standard' }, { query: 'node' }],
  ['WebFetch', { url: 'https://example.com', prompt: 'Summarize', offset: 1 }, { url: 'https://example.com', prompt: 'Summarize' }],
  ['Monitor', { description: 'Wait', command: 'tail -f x', timeout_ms: 1 }, { description: 'Wait', command: 'tail -f x' }],
  ['TaskStop', { task_id: 'b1' }, { task_id: 'b1' }],
  ['ScheduleWakeup', { delaySeconds: 60, reason: 'Wait', prompt: 'x', noop: false }, { delaySeconds: 60, reason: 'Wait' }],
  ['CronCreate', { cron: '0 9 * * *', recurring: true, prompt: 'Check' }, { cron: '0 9 * * *', prompt: 'Check' }],
  ['Artifact', { action: 'publish', file_path: '/r/p.html', url: 'u', description: 'd', icon: 'chart' }, { action: 'publish', file_path: '/r/p.html', url: 'u', description: 'd' }],
  ['ExitPlanMode', { plan: 'Do it', planFilePath: '/r/plan.md' }, { plan: 'Do it' }],
]

for (const [name, raw, expected] of rows) {
  test(`${name}: only its listed fields are selected`, () => {
    assert.deepEqual(toolInput(name, raw), { input: expected, truncated: {} })
  })
}

test('a field the CLI adds to a listed tool is not passed on', () => {
  const result = toolInput('Edit', { file_path: '/r/a', old_string: 'a', new_string: 'b', replace_all: false, secret: 'tok-123' })
  assert.ok(result)
  assert.ok(!JSON.stringify(result).includes('tok-123'))
  assert.ok(!('secret' in result.input))
})

test('MCP and unknown tools carry no selected input', () => {
  assert.equal(toolInput('mcp__claude-in-chrome__navigate', { url: 'https://example.com' }), null)
  assert.equal(toolInput('SomeNewTool', { command: 'x' }), null)
  assert.equal(toolInput('Bash', null), null)
  assert.equal(toolInput('Bash', { timeout: 1 }), null, 'nothing selected')
})

test('a wrong-typed field is dropped, and a string flag passes as a string', () => {
  assert.deepEqual(toolInput('Read', { file_path: '/r/a', offset: '3', limit: Number.NaN }), { input: { file_path: '/r/a', offset: '3' }, truncated: {} })
  assert.deepEqual(toolInput('Bash', { command: 'x', description: { a: 1 }, run_in_background: 'false' }), {
    input: { command: 'x', run_in_background: 'false' },
    truncated: {},
  })
})

test('a long string is cut and named with its original length', () => {
  const content = 'x'.repeat(5000)
  const result = toolInput('Write', { file_path: '/r/a', content })
  assert.ok(result)
  assert.equal((result.input.content as string).length, STRING_LIMIT)
  assert.deepEqual(result.truncated, { content: 5000 })
})

test("one call's strings share a budget, spent in white-list order", () => {
  const old = 'o'.repeat(STRING_LIMIT)
  const neu = 'n'.repeat(STRING_LIMIT)
  const prompt = 'p'.repeat(STRING_LIMIT)
  const description = 'd'.repeat(STRING_LIMIT)
  // description + subagent_type + prompt: 4000 + 2 + 4000 fit; the call's limit cuts nothing yet.
  const fits = toolInput('Agent', { description, subagent_type: 'ab', prompt })
  assert.deepEqual(fits?.truncated, {})
  const result = toolInput('Edit', { file_path: 'f'.repeat(STRING_LIMIT), old_string: old, new_string: neu + 'tail' })
  assert.ok(result)
  // file_path 4000 + old_string 4000 leave 4000 for new_string, whose own limit already cuts it.
  assert.equal((result.input.new_string as string).length, CALL_LIMIT - 2 * STRING_LIMIT)
  assert.deepEqual(result.truncated, { new_string: STRING_LIMIT + 4 })
  const over = toolInput('Edit', { file_path: 'f'.repeat(STRING_LIMIT), old_string: old, new_string: neu, replace_all: false })
  assert.deepEqual(over?.truncated, {}, 'exactly the call limit cuts nothing')
  const spent = toolInput('Agent', { description, subagent_type: 's'.repeat(STRING_LIMIT), prompt: prompt + 'x' })
  assert.ok(spent)
  assert.equal((spent.input.prompt as string).length, STRING_LIMIT)
  assert.deepEqual(spent.truncated, { prompt: STRING_LIMIT + 1 })
  const empty = toolInput('Bash', { command: 'c'.repeat(STRING_LIMIT), description: 'd'.repeat(STRING_LIMIT) })
  assert.deepEqual(empty?.truncated, {})
})

test('the budget, once spent, leaves later strings empty and named', () => {
  const big = 'q'.repeat(STRING_LIMIT)
  const questions = [1, 2, 3, 4].map(() => ({ question: big, header: 'h', options: [{ label: 'a', description: 'b' }] }))
  const result = toolInput('AskUserQuestion', { questions })
  assert.ok(result)
  const views = result.input.questions as { question: string; header: string }[]
  assert.equal(views[3].question, '')
  assert.ok('questions' in result.truncated)
})

test('a cut does not split a surrogate pair', () => {
  const content = 'a'.repeat(STRING_LIMIT - 1) + '😀' + 'b'
  const result = toolInput('Write', { content })
  const kept = result?.input.content as string
  assert.equal(kept.length, STRING_LIMIT - 1)
  assert.ok(!/[\ud800-\udbff]$/.test(kept))
})

test('files: at most 20 kept, named with the original count; a non-string item drops the list', () => {
  const files = Array.from({ length: 25 }, (_, i) => `/r/${i}.md`)
  const result = toolInput('SendUserFile', { files, caption: 'c' })
  assert.equal((result?.input.files as string[]).length, 20)
  assert.deepEqual(result?.truncated, { files: 25 })
  assert.deepEqual(toolInput('SendUserFile', { files: ['/r/a', 3], caption: 'c' }), { input: { caption: 'c' }, truncated: {} })
})

test('questions: at most 4, options at most 8', () => {
  const options = Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` }))
  const questions = Array.from({ length: 5 }, () => ({ question: 'q', options }))
  const result = toolInput('AskUserQuestion', { questions })
  const views = result?.input.questions as { options: unknown[] }[]
  assert.equal(views.length, 4)
  assert.equal(views[0].options.length, 8)
  assert.deepEqual(result?.truncated, { questions: 5 })
})

test("SendMessage's recipient is selected only when it is a name", () => {
  const socket = 'uds:/run/user/1000/cc-socks/123.sock'
  const bySocket = toolInput('SendMessage', { to: socket, recipient_kind: 'session', summary: 's', message: 'm' })
  assert.deepEqual(bySocket, { input: { recipient_kind: 'session', summary: 's', message: 'm' }, truncated: {} })
  const noKind = toolInput('SendMessage', { to: socket, summary: 's', message: 'm' })
  assert.ok(!JSON.stringify(noKind).includes('uds:'))
  assert.ok(!('to' in (noKind?.input ?? {})))
  // A subagent id is not a location, but it is an internal id (D1): only a named recipient is kept.
  const byId = toolInput('SendMessage', { to: 'a0123456789abcdef', recipient_kind: 'agent', message: 'm' })
  assert.deepEqual(byId, { input: { recipient_kind: 'agent', message: 'm' }, truncated: {} })
})
