import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearAgentEvents,
  configureAgentEvents,
  drainEvents,
  encodeInput, encodePrefill,
  fileTimeOf,
  heldWait,
  EVENT_COMMAND,
  HOOKED_EVENTS,
  nextWaitState,
  parseEvent,
  prepareEventInjection,
  type AgentEvent,
} from './agent-events'
import { composeInjection } from './agent-injection'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spekterm-events-'))
}

const ev = (name: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  name,
  transcriptPath: null,
  notificationType: null,
  toolName: null,
  toolArg: null,
  agentId: null,
  toolUseId: null,
  inputHash: null,
  questions: null,
  answers: null,
  plan: null,
  permissionMode: null,
  source: null,
  runningAgents: null,
  backgroundAgentRunning: false,
  trigger: null,
  ...extra,
})

test('許可請求是等待選擇的權威訊號', () => {
  assert.equal(nextWaitState(ev('PermissionRequest', { toolName: 'Write' })), 'awaiting-choice')
  // 計畫核准走同一個 hook（實測 `ExitPlanMode` 同樣觸發）—— 不需要維護一張工具清單。
  assert.equal(nextWaitState(ev('PermissionRequest', { toolName: 'ExitPlanMode' })), 'awaiting-choice')
})

test('Notification 依 notification_type 分派（本模組最承重的一條）', () => {
  // **對照組**：把分派拿掉、一律回 ready，這一條必須變紅 —— 而那正是「許可提示被讀成就緒」。
  assert.equal(nextWaitState(ev('Notification', { notificationType: 'permission_prompt' })), 'awaiting-choice')
  assert.equal(nextWaitState(ev('Notification', { notificationType: 'idle_prompt' })), 'ready')
})

test('認得 hook 但不認得它的種類 ⇒ 未知，不是就緒也不是忙碌', () => {
  assert.equal(nextWaitState(ev('Notification', { notificationType: 'something_new' })), 'unknown')
  assert.equal(nextWaitState(ev('Notification')), 'unknown')
})

test('不認得的事件形狀 ⇒ 未知，且不沿用前一個狀態', () => {
  assert.equal(nextWaitState(ev('SomeFutureHook')), 'unknown')
})

test('工具結束是離開等待選擇的訊號', () => {
  assert.equal(nextWaitState(ev('PostToolUse')), 'busy')
  assert.equal(nextWaitState(ev('Stop')), 'ready')
})

test('對話結束 ⇒ 未知（它不代表 session 結束）', () => {
  assert.equal(nextWaitState(ev('SessionEnd')), 'unknown')
  assert.equal(nextWaitState(ev('SessionStart')), 'ready')
})

test('payload 以白名單取欄位，絕對路徑不外流（transcript_path 除外，它不送 renderer）', () => {
  const parsed = parseEvent({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    transcript_path: '/home/u/.claude/projects/x/y.jsonl',
    cwd: '/home/u/secret',
    scratchpad_dir: '/tmp/scratch/abc',
    permission_mode: 'default',
    tool_name: 'Write',
    tool_input: { file_path: '/home/u/secret/file.ts' },
  })
  assert.ok(parsed)
  assert.deepEqual(Object.keys(parsed).sort(), [
    'agentId', 'answers', 'backgroundAgentRunning', 'inputHash', 'name', 'notificationType', 'permissionMode', 'plan',
    'questions', 'runningAgents', 'source', 'toolArg', 'toolName', 'toolUseId', 'transcriptPath', 'trigger',
  ])
  // `toolArg` 是**單一辨識參數**，其值本身可能是路徑 —— 那是刻意的（使用者要看得出 agent 在動
  // 哪個檔）。真正必須不外流的是**其餘一切**：工作目錄、暫存目錄、以及參數裡的其他欄位。
  assert.equal(parsed.toolArg, '/home/u/secret/file.ts')
  const serialized = JSON.stringify({ ...parsed, transcriptPath: undefined, toolArg: undefined })
  // The input is kept only as a hash.
  assert.match(parsed.inputHash ?? '', /^[0-9a-f]{32}$/)
  assert.ok(!serialized.includes('/home/u/secret'), serialized)
  assert.ok(!serialized.includes('/tmp/scratch'), serialized)
})

test('沒有 hook_event_name 的東西不是事件', () => {
  assert.equal(parseEvent({ foo: 1 }), null)
  assert.equal(parseEvent(null), null)
  assert.equal(parseEvent('x'), null)
})

test('未啟用時完全不注入，也不建立落點', () => {
  const root = tmp()
  configureAgentEvents(root)
  assert.equal(prepareEventInjection('s1', false), null)
  assert.equal(fs.existsSync(path.join(root, 'agent-events', 's1')), false)
})

test('啟用時注入 hooks 並以環境變數指定落點', () => {
  const root = tmp()
  configureAgentEvents(root)
  const part = prepareEventInjection('s1', true)
  assert.ok(part)
  // hooks 走獨立欄位，不進 `settings` —— 見 `agent-injection` 的 `HookContribution`。
  assert.equal('hooks' in part.settings, false)
  assert.deepEqual(Object.keys(part.hooks ?? {}).sort(), [...HOOKED_EVENTS].sort())
  assert.ok(part.env.SPEKTERM_EVENT_DIR.endsWith(path.join('agent-events', 's1')))
  assert.equal(fs.existsSync(part.env.SPEKTERM_EVENT_DIR), true)
})

test('the injection names the submission, tool-failure and failed-turn hooks', () => {
  configureAgentEvents(tmp())
  const hooks = Object.keys(prepareEventInjection('s1', true)?.hooks ?? {})
  // Named literally: comparing with `HOOKED_EVENTS` stays green when an event is dropped from the list.
  for (const name of ['UserPromptSubmit', 'PostToolUseFailure', 'StopFailure', 'PermissionRequest', 'Stop']) {
    assert.ok(hooks.includes(name), `${name} is injected (got ${hooks.join(', ')})`)
  }
})

test('a submitted prompt and a failed tool are busy; a failed turn is ready, a subagent\'s unknown', () => {
  assert.equal(nextWaitState(ev('UserPromptSubmit')), 'busy')
  assert.equal(nextWaitState(ev('PostToolUseFailure', { toolName: 'Bash' })), 'busy')
  assert.equal(nextWaitState(ev('StopFailure')), 'ready')
  assert.equal(nextWaitState(ev('StopFailure', { agentId: 'a5a6' })), 'unknown')
  assert.equal(parseEvent({ hook_event_name: 'StopFailure', agent_id: 'a5a6' })?.agentId, 'a5a6')
})

test('a failed turn does not count as a turn completion', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}')
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"StopFailure","error":"server_error"}')
  const result = drainEvents('s1', heldWait('ready'))
  assert.equal(result.state, 'ready')
  assert.equal(result.turnEnded, false)
})

test('a SessionStart that is not a compaction marks the batch as a start', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  for (const source of ['startup', 'resume', 'clear']) {
    fs.writeFileSync(path.join(dir, '100-1.json'), JSON.stringify({ hook_event_name: 'SessionStart', source }))
    assert.equal(drainEvents('s1', heldWait('unknown')).sessionStarted, true, source)
  }
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"SessionStart","source":"compact"}')
  assert.equal(drainEvents('s1', heldWait('busy')).sessionStarted, false)
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"Stop"}')
  assert.equal(drainEvents('s1', heldWait('busy')).sessionStarted, false)
  assert.equal(drainEvents('s1', heldWait('ready')).sessionStarted, false)
})

test('a subagent\'s failed turn during a choice does not allow sending', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}')
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"StopFailure","agent_id":"a5a6"}')
  const state = drainEvents('s1', heldWait()).state
  assert.notEqual(state, 'ready')
  assert.notEqual(state, 'busy')
})

test('a prompt submitted after a denied permission prompt leaves awaiting-choice', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  // A denial sends nothing (measured), so the next thing the drainer sees is the user's next prompt.
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}')
  const asked = drainEvents('s1', heldWait())
  assert.equal(asked.state, 'awaiting-choice')
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"UserPromptSubmit","prompt":"do it differently"}')
  const after = drainEvents('s1', asked.held)
  assert.equal(after.state, 'busy')
  assert.equal(after.pending, null)
})

test('新 session 不繼承上一輪的殘留', () => {
  const root = tmp()
  configureAgentEvents(root)
  const first = prepareEventInjection('s1', true)!
  fs.writeFileSync(path.join(first.env.SPEKTERM_EVENT_DIR, '1-1.json'), '{"hook_event_name":"Stop"}')
  // 重新 spawn 同一個 id ⇒ 落點必須是乾淨的，否則等待狀態會先呈現一份過期的值。
  prepareEventInjection('s1', true)
  assert.deepEqual(fs.readdirSync(first.env.SPEKTERM_EVENT_DIR), [])
})

test('連續多筆事件全部被讀到、各只處理一次，順序即發生順序', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t1"}')
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}')
  fs.writeFileSync(path.join(dir, '300-1.json'), '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"t1"}')

  const first = drainEvents('s1', heldWait())
  assert.equal(first.count, 3)
  assert.equal(first.state, 'busy')
  // 讀完即刪 ⇒ 去重由結構保證。
  const second = drainEvents('s1', first.held)
  assert.equal(second.count, 0)
  assert.equal(second.state, 'busy')
})

test('損毀的單筆被忽略，其餘照常處理', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_na')
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"Stop"}')
  const result = drainEvents('s1', heldWait())
  assert.equal(result.count, 1)
  assert.equal(result.state, 'ready')
})

test('事件帶來的紀錄位置被回報出來（定位的權威來源）', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(
    path.join(dir, '100-1.json'),
    JSON.stringify({ hook_event_name: 'SessionStart', transcript_path: '/p/new.jsonl' }),
  )
  assert.equal(drainEvents('s1', heldWait()).transcriptPath, '/p/new.jsonl')
})

test('未注入時等待狀態不變（呼叫端的初始值本來就是未知）', () => {
  const root = tmp()
  configureAgentEvents(root)
  assert.equal(drainEvents('never-injected', heldWait()).state, 'unknown')
})

test('session 結束後落點被清除', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  clearAgentEvents('s1')
  assert.equal(fs.existsSync(dir), false)
})

test('合成器：兩者皆參與 ⇒ 一份設定含兩者', () => {
  const file = path.join(tmp(), 'settings.json')
  const injection = composeInjection(file, [
    { settings: { statusLine: { type: 'command', command: 'a' } }, env: { A: '1' } },
    { settings: {}, hooks: { Stop: ['cmd'] }, env: { B: '2' } },
  ])
  assert.ok(injection)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok('statusLine' in written)
  assert.ok('hooks' in written)
  assert.deepEqual(injection.env, { A: '1', B: '2' })
})

test('合成器：其一不參與時另一者仍注入（啟用狀態彼此獨立）', () => {
  const file = path.join(tmp(), 'settings.json')
  const injection = composeInjection(file, [null, { settings: {}, hooks: { Stop: ['cmd'] }, env: { B: '2' } }])
  assert.ok(injection)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(written), ['hooks'])
})

test('合成器：全部不參與 ⇒ 完全不注入', () => {
  const file = path.join(tmp(), 'settings.json')
  assert.equal(composeInjection(file, [null, null]), null)
  assert.equal(fs.existsSync(file), false)
})

test('送出的編碼：換行保留、其餘控制位元組移除、結尾為送出鍵', () => {
  // `\n` 是訊息內的換行（實測：得到恰好一則訊息且換行保留）。
  assert.equal(encodeInput('one\ntwo'), 'one\ntwo\r')
  // 其餘控制位元組**必須移除** —— 實測它們會讓整則訊息無聲消失（紀錄檔根本沒被建立）。
  // **對照組**：拿掉過濾，這一條必須變紅。
  assert.equal(encodeInput('abc\td'), 'abcd\r')
  assert.equal(encodeInput('x[200~y'), 'x[200~y\r')
  assert.ok(!encodeInput('a\rb').slice(0, -1).includes('\r'))
})

/**
 * **這一條真的把注入的命令跑一次。**
 *
 * 它的存在是因為一個實際發生過的失敗：命令被拆成陣列的多個元素再以 `'; '` 相接，於是 `then`
 * 後面多了一個分號，shell 語法錯誤，hook **每一次都失敗** —— 而**失效完全靜默**：agent 不會
 * 抱怨一個寫壞的 hook，我們只看到一個空的事件目錄、一個永遠「未知」的等待狀態、一個永遠停用
 * 的輸入框，沒有任何訊息指向真正的原因。
 *
 * 一條只斷言「命令字串包含某些片段」的測試擋不住它。**唯一擋得住的是執行它。**
 */
test('注入的 hook 命令真的跑得起來，且把 payload 原子地寫成一個檔', () => {
  const dir = tmp()
  const payload = JSON.stringify({ hook_event_name: 'Stop', transcript_path: '/p/a.jsonl' })
  const result = spawnSync('sh', ['-c', EVENT_COMMAND], {
    input: payload,
    env: { ...process.env, SPEKTERM_EVENT_DIR: dir },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  assert.equal(result.stderr, '')

  const written = fs.readdirSync(dir)
  assert.equal(written.length, 1, `寫出的檔案：${written.join(', ')}`)
  assert.ok(written[0].endsWith('.json'), written[0])
  // 暫存檔不得留下 —— 讀取端只認 `.json`，殘留的 `.tmp` 代表更名沒有發生。
  assert.equal(written.filter((name) => name.endsWith('.tmp')).length, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, written[0]), 'utf8')), JSON.parse(payload))
})

test('the hook command prints nothing (a UserPromptSubmit hook\'s stdout is added to the prompt)', () => {
  const result = spawnSync('sh', ['-c', EVENT_COMMAND], {
    input: '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}',
    env: { ...process.env, SPEKTERM_EVENT_DIR: tmp() },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  assert.equal(result.stdout, '')
})

test('未設定落點時 hook 命令是無操作，不報錯', () => {
  const result = spawnSync('sh', ['-c', EVENT_COMMAND], {
    input: '{"hook_event_name":"Stop"}',
    env: { ...process.env, SPEKTERM_EVENT_DIR: '' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
})

test('等待選擇時回報「正在被問什麼」，離開後清掉', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  const input = { file_path: '/x/y.ts', other: '/private/should-not-leak' }
  fs.writeFileSync(path.join(dir, '050-1.json'), JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: input }))
  fs.writeFileSync(path.join(dir, '100-1.json'), JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: input }))
  const asked = drainEvents('s1', heldWait())
  assert.equal(asked.state, 'awaiting-choice')
  assert.deepEqual(asked.pending, { tool: 'Write', arg: '/x/y.ts' })
  // **只有辨識參數**，其餘參數不外流。
  assert.ok(!JSON.stringify(asked.pending).includes('should-not-leak'))

  // 離開等待選擇時必須清掉 —— 否則畫面會留著一個已經被回答完的請求。
  assert.ok(!JSON.stringify(asked.held.requests).includes('should-not-leak'))
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_use_id":"w1"}')
  const after = drainEvents('s1', asked.held)
  assert.equal(after.state, 'busy')
  assert.equal(after.pending, null)
})

test('the prompt\'s later notice keeps the tool, in separate drains with an empty drain between', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(
    path.join(dir, '100-1.json'),
    JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rmdir /tmp/x' } }),
  )
  const asked = drainEvents('s1', heldWait())
  assert.deepEqual(asked.pending, { tool: 'Bash', arg: 'rmdir /tmp/x' })
  const quiet = drainEvents('s1', asked.held)
  assert.equal(quiet.count, 0)
  assert.deepEqual(quiet.pending, { tool: 'Bash', arg: 'rmdir /tmp/x' }, 'an empty drain keeps it')
  // Measured: about six seconds later, naming no tool.
  fs.writeFileSync(
    path.join(dir, '200-1.json'),
    '{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission"}',
  )
  const noticed = drainEvents('s1', quiet.held)
  assert.equal(noticed.state, 'awaiting-choice')
  assert.deepEqual(noticed.pending, { tool: 'Bash', arg: 'rmdir /tmp/x' }, 'the notice keeps it')
  assert.equal(noticed.held.requests[0].id, asked.held.requests[0].id, 'the identity is kept')
})

test('the prompt\'s notice in the same drain keeps the tool', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"PermissionRequest","tool_name":"Write"}')
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"Notification","notification_type":"permission_prompt"}')
  assert.deepEqual(drainEvents('s1', heldWait()).pending, { tool: 'Write', arg: null })
})

test('a missing event location keeps the held request', () => {
  configureAgentEvents(tmp())
  const held = heldWait('busy')
  held.requests.push({ id: 'r1', toolUseId: 't1', agentId: null, tool: 'Bash', arg: 'ls', questions: null, plan: null, at: 1, answeredAt: null, stirred: false })
  const result = drainEvents('never-injected', held)
  assert.deepEqual(result.pending, { tool: 'Bash', arg: 'ls' })
  assert.equal(result.state, 'awaiting-choice')
  assert.equal(result.held.requests[0].id, 'r1')
  // Outside a choice nothing is held.
  assert.equal(drainEvents('never-injected', heldWait('busy')).pending, null)
})

test('the next request after an answered one is the pending one, and leaving the choice clears it', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  const write = (name: string, body: Record<string, unknown>) => fs.writeFileSync(path.join(dir, name), JSON.stringify(body))
  write('100-1.json', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' } })
  write('110-1.json', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })
  const first = drainEvents('s1', heldWait())
  write('200-1.json', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1' })
  write('300-1.json', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'x' } })
  write('310-1.json', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'x' } })
  const second = drainEvents('s1', first.held)
  assert.deepEqual(second.pending, { tool: 'Write', arg: 'x' })
  assert.notEqual(second.held.requests[0].id, first.held.requests[0].id, 'a new identity')
  write('400-1.json', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w1' })
  const third = drainEvents('s1', second.held)
  assert.equal(third.pending, null)
  assert.equal(third.state, 'busy')
})

test('許可提示出現中不得歸為忙碌或就緒（本 change 最承重的一條）', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  // 真實時序（實測）：工具即將執行 → 許可請求 → （6 秒後才有 Notification）。
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_use_id":"w1"}')
  fs.writeFileSync(path.join(dir, '200-1.json'), '{"hook_event_name":"PermissionRequest","tool_name":"Write"}')
  const result = drainEvents('s1', heldWait())
  assert.equal(result.state, 'awaiting-choice')
  // **對照組**：把 `PermissionRequest` 的處理拿掉（退回只看 `Notification`），狀態會停在
  // `busy` —— 而忙碌是允許送出的。那正是 proposal 立論要防的災難。
  assert.notEqual(result.state, 'busy')
  assert.notEqual(result.state, 'ready')
})

test('延遲六秒才到的 Notification 不會把已經是等待選擇的狀態拉回就緒', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(path.join(dir, '100-1.json'), '{"hook_event_name":"PermissionRequest","tool_name":"Write"}')
  fs.writeFileSync(
    path.join(dir, '200-1.json'),
    '{"hook_event_name":"Notification","notification_type":"permission_prompt"}',
  )
  assert.equal(drainEvents('s1', heldWait()).state, 'awaiting-choice')
})

test('對話結束後接著開始的新對話，其位置被回報且狀態為就緒', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  // 實測 `/clear` 的形狀：`SessionEnd`（舊路徑）＋ 59ms 後 `SessionStart`（新路徑）。
  fs.writeFileSync(
    path.join(dir, '100-1.json'),
    JSON.stringify({ hook_event_name: 'SessionEnd', transcript_path: '/p/old.jsonl' }),
  )
  fs.writeFileSync(
    path.join(dir, '200-1.json'),
    JSON.stringify({ hook_event_name: 'SessionStart', transcript_path: '/p/new.jsonl' }),
  )
  const result = drainEvents('s1', heldWait('ready'))
  // **`SessionEnd` 不是「session 結束」** —— 它之後跟著的是一份新的紀錄，不是拆除。
  assert.equal(result.transcriptPath, '/p/new.jsonl')
  assert.equal(result.state, 'ready')
  // 落點仍在：清除只由 session 自身的結束觸發。
  assert.equal(fs.existsSync(dir), true)
})

test('預填的編碼不附送出字元，且濾掉換行', () => {
  // **單行是編碼器的性質，不是呼叫端的義務。**
  const encoded = encodePrefill('first\nsecond\r\tthird')
  assert.equal(encoded.includes('\r'), false)
  assert.equal(encoded.includes('\n'), false)
  assert.equal(encoded, 'firstsecondthird')
})

test('預填與送出的控制字元過濾一致（除了換行與送出字元本身）', () => {
  assert.equal(encodePrefill('a\x01b\x07c'), 'abc')
})

// ---- Open requests (`remote-prompts-attachments-rename` D1), sequences copied from measured runs ----

function rig() {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  let seq = 100
  let ids = 0
  let held = heldWait()
  return {
    fire(body: Record<string, unknown>): void {
      fs.writeFileSync(path.join(dir, `${seq++}-1.json`), JSON.stringify(body))
    },
    drain() {
      const result = drainEvents('s1', held, { newId: () => `r${++ids}` })
      held = result.held
      return result
    },
  }
}

const pre = (tool: string, id: string, input: Record<string, unknown>, agent?: string) => ({
  hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: input, ...(agent ? { agent_id: agent } : {}),
})
const ask = (tool: string, input: Record<string, unknown>, agent?: string) => ({
  hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input, ...(agent ? { agent_id: agent } : {}),
})
const post = (tool: string, id: string, agent?: string) => ({
  hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: id, ...(agent ? { agent_id: agent } : {}),
})

test('two parallel requests are both open, in order, and the second remains when the first finishes', () => {
  const r = rig()
  r.fire(pre('Read', 'a', { file_path: '/h/a.txt' }))
  r.fire(ask('Read', { file_path: '/h/a.txt' }))
  r.fire(pre('Read', 'b', { file_path: '/h/b.txt' }))
  r.fire(ask('Read', { file_path: '/h/b.txt' }))
  const both = r.drain()
  assert.equal(both.held.requests.length, 2)
  assert.deepEqual(both.pending, { tool: 'Read', arg: '/h/a.txt' })
  assert.deepEqual(both.choicesRaised.map((c) => c.arg), ['/h/a.txt', '/h/b.txt'])
  r.fire(post('Read', 'a'))
  const one = r.drain()
  assert.equal(one.state, 'awaiting-choice')
  assert.deepEqual(one.pending, { tool: 'Read', arg: '/h/b.txt' })
  assert.equal(one.held.requests[0].id, 'r2')
})

test('a parallel call that needed no permission does not close the other call\'s request', () => {
  // Measured: two parallel starts 1.5 ms apart, before either request. Matching by order alone gives the
  // request the wrong call, and that call's end closes it while its prompt is on screen.
  const r = rig()
  r.fire(pre('Read', 'outside', { file_path: '/h/out.txt' }))
  r.fire(pre('Read', 'inside', { file_path: '/w/in.txt' }))
  r.fire(ask('Read', { file_path: '/h/out.txt' }))
  r.fire(post('Read', 'inside'))
  const result = r.drain()
  assert.equal(result.state, 'awaiting-choice')
  assert.equal(result.held.requests[0].toolUseId, 'outside')
})

test('a background subagent\'s prompt survives the agent\'s turn end and a notice submission', () => {
  // The measured shape (two background subagents, each asking to run a command).
  const r = rig()
  r.fire(pre('Agent', 'ag1', { prompt: 'one' }))
  r.fire(post('Agent', 'ag1'))
  r.fire(pre('Bash', 'b1', { command: 'echo one > one.txt' }, 'sub1'))
  r.fire(ask('Bash', { command: 'echo one > one.txt' }, 'sub1'))
  r.fire({ hook_event_name: 'Stop', background_tasks: [{ id: 'sub1', type: 'subagent', status: 'running' }, { id: 'sub2', type: 'subagent', status: 'running' }] })
  r.fire(pre('Bash', 'b2', { command: 'echo two > two.txt' }, 'sub2'))
  r.fire(ask('Bash', { command: 'echo two > two.txt' }, 'sub2'))
  const open = r.drain()
  assert.equal(open.state, 'awaiting-choice', 'the agent\'s own Stop does not make it ready')
  assert.equal(open.held.requests.length, 2)
  r.fire(post('Bash', 'b1', 'sub1'))
  r.fire({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>sub1</task-id>' })
  r.fire({ hook_event_name: 'Stop', background_tasks: [{ id: 'sub2', type: 'subagent', status: 'running' }] })
  const after = r.drain()
  assert.equal(after.state, 'awaiting-choice', 'the notice and the turn end do not leave the choice')
  assert.deepEqual(after.pending, { tool: 'Bash', arg: 'echo two > two.txt' })
})

test('a dismissed subagent prompt ends with the subagent; a helper\'s end changes nothing', () => {
  const r = rig()
  r.fire(pre('Bash', 'b1', { command: 'x' }, 'sub1'))
  r.fire(ask('Bash', { command: 'x' }, 'sub1'))
  r.fire({ hook_event_name: 'Stop', background_tasks: [{ id: 'sub1', type: 'subagent', status: 'running' }] })
  assert.equal(r.drain().state, 'awaiting-choice')
  r.fire({ hook_event_name: 'SubagentStop', agent_id: 'helper', agent_type: '' })
  assert.equal(r.drain().state, 'awaiting-choice', 'a helper\'s end closes nothing')
  r.fire({ hook_event_name: 'SubagentStop', agent_id: 'sub1', agent_type: 'general-purpose' })
  const closed = r.drain()
  assert.equal(closed.held.requests.length, 0)
  assert.equal(closed.state, 'ready', 'the base state stays the agent\'s own (its Stop)')
  r.fire({ hook_event_name: 'SubagentStop', agent_id: 'helper2', agent_type: '' })
  assert.equal(r.drain().state, 'ready', 'a helper\'s end after the turn does not move the state')
})

test('a subagent the agent no longer lists as running does not keep its request open', () => {
  const r = rig()
  r.fire(pre('Bash', 'b1', { command: 'x' }, 'sub1'))
  r.fire(ask('Bash', { command: 'x' }, 'sub1'))
  r.drain()
  r.fire({ hook_event_name: 'UserPromptSubmit', prompt: 'next' })
  r.fire({ hook_event_name: 'Stop', background_tasks: [] })
  const result = r.drain()
  assert.equal(result.held.requests.length, 0)
  assert.equal(result.state, 'ready')
})

test('without the background task list, the agent\'s Stop leaves a subagent\'s request open', () => {
  const r = rig()
  r.fire(pre('Bash', 'b1', { command: 'x' }, 'sub1'))
  r.fire(ask('Bash', { command: 'x' }, 'sub1'))
  r.fire({ hook_event_name: 'Stop' })
  assert.equal(r.drain().state, 'awaiting-choice')
})

test('the agent\'s own turn events close its own requests, and an unmatched request too', () => {
  const r = rig()
  r.fire(ask('Bash', { command: 'x' }))
  const asked = r.drain()
  assert.equal(asked.held.requests[0].toolUseId, null, 'no tool start to match')
  r.fire({ hook_event_name: 'Stop' })
  assert.equal(r.drain().state, 'ready')
})

test('a retried call takes its new start, not a stale one left unmatched', () => {
  // Measured: two parallel Bash calls, only the first requested; Esc interrupts both with no event.
  const r = rig()
  r.fire(pre('Bash', 'old1', { command: 'echo a' }))
  r.fire(ask('Bash', { command: 'echo a' }))
  r.fire(pre('Bash', 'old2', { command: 'echo b' }))
  r.drain()
  // A subagent's own retry: no turn event of the agent itself removes the stale start in between.
  r.fire(post('Bash', 'old1'))
  r.fire(pre('Bash', 'new2', { command: 'echo b' }))
  r.fire(ask('Bash', { command: 'echo b' }))
  const retried = r.drain()
  assert.equal(retried.held.requests.length, 1)
  assert.equal(retried.held.requests[0].toolUseId, 'new2')
  r.fire(post('Bash', 'new2'))
  assert.equal(r.drain().state, 'busy')
})

test('a conversation start clears the requests unless it is a compaction', () => {
  for (const [source, open] of [['compact', 1], ['startup', 0], ['resume', 0], ['clear', 0]] as const) {
    const r = rig()
    r.fire(pre('Bash', 'b1', { command: 'x' }, 'sub1'))
    r.fire(ask('Bash', { command: 'x' }, 'sub1'))
    r.fire({ hook_event_name: 'SessionStart', source })
    assert.equal(r.drain().held.requests.length, open, source)
  }
})

test('a request takes its tool start\'s time, from the event file name', () => {
  assert.equal(fileTimeOf('1792057954828123456-42.json'), 1792057954828)
  assert.equal(fileTimeOf('100-1.json'), null)
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  fs.writeFileSync(path.join(dir, '1792057954000000000-1.json'), JSON.stringify(pre('Bash', 'b1', { command: 'x' })))
  fs.writeFileSync(path.join(dir, '1792057954500000000-1.json'), JSON.stringify(ask('Bash', { command: 'x' })))
  assert.equal(drainEvents('s1', heldWait()).held.requests[0].at, 1792057954000)
})

test('a question\'s questions are kept by white-list, clipped, in order', () => {
  const parsed = parseEvent({
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        { question: 'Which fruit?', header: 'Fruit', multiSelect: false, extra: 'x', options: [{ label: 'Apple', description: 'red' }, { label: 'Banana' }] },
        { question: 'q'.repeat(2000), header: 'h'.repeat(200), multiSelect: true, options: [{ label: 'Keep /home/me/x.ts', description: 'd'.repeat(2000) }] },
      ],
    },
  })!
  assert.deepEqual(parsed.questions?.[0], {
    question: 'Which fruit?', header: 'Fruit', multiSelect: false,
    options: [{ label: 'Apple', description: 'red' }, { label: 'Banana', description: '' }],
  })
  assert.equal(parsed.questions?.[1].question.length, 1000)
  assert.equal(parsed.questions?.[1].header.length, 100)
  assert.equal(parsed.questions?.[1].options[0].description.length, 1000)
  assert.equal(parsed.questions?.[1].multiSelect, true)
  // Agent-written prose is kept as written, a path included.
  assert.equal(parsed.questions?.[1].options[0].label, 'Keep /home/me/x.ts')
})

test('a malformed question leaves the request without questions', () => {
  const shapes: unknown[] = [
    { questions: [{ question: 'q', options: 'Apple' }] },
    { questions: [{ options: [{ label: 'a' }] }] },
    { questions: [{ question: 'q', options: [{ description: 'no label' }] }] },
    { questions: [] },
    {},
  ]
  for (const tool_input of shapes) {
    assert.equal(parseEvent({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input })?.questions, null)
  }
  // Another tool never carries questions.
  assert.equal(parseEvent({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { questions: [] } })?.questions, null)
})

test('recorded answers, the plan text and the permission mode are kept', () => {
  const finished = parseEvent({
    hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', permission_mode: 'default',
    tool_input: { questions: [], answers: { 'Which fruit?': 'Banana', 'n': 3 } },
  })!
  assert.deepEqual(finished.answers, { 'Which fruit?': 'Banana' })
  assert.equal(finished.permissionMode, 'default')
  const plan = parseEvent({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'p'.repeat(30_000), planFilePath: '/home/me/.claude/plans/x.md' } })!
  assert.equal(plan.plan?.length, 20_000)
  assert.ok(!JSON.stringify({ ...plan, toolArg: null }).includes('.claude/plans'), 'the plan file path is not kept')
  assert.equal(parseEvent({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: {} })?.plan, null)
})

test('a finished call is reported with its recorded answers and mode', () => {
  const r = rig()
  r.fire(pre('AskUserQuestion', 'q1', { questions: [{ question: 'Q', options: [{ label: 'A' }] }] }))
  r.fire(ask('AskUserQuestion', { questions: [{ question: 'Q', options: [{ label: 'A' }] }] }))
  r.drain()
  r.fire({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1', permission_mode: 'default', tool_input: { answers: { Q: 'A' } } })
  assert.deepEqual(r.drain().finished, [{ toolUseId: 'q1', answers: { Q: 'A' }, permissionMode: 'default' }])
})

test('another tool start or finish of the same agent after a request marks it stirred', () => {
  const root = tmp()
  configureAgentEvents(root)
  const dir = prepareEventInjection('s1', true)!.env.SPEKTERM_EVENT_DIR
  const at = (ms: number) => `${BigInt(ms) * 1_000_000n}-1.json`
  const put = (ms: number, body: Record<string, unknown>) => fs.writeFileSync(path.join(dir, at(ms)), JSON.stringify(body))
  put(1_792_000_000_000, pre('Bash', 'a', { command: 'x' }))
  put(1_792_000_000_100, ask('Bash', { command: 'x' }))
  const single = drainEvents('s1', heldWait())
  assert.equal(single.held.requests[0].stirred, false, 'a single sequential prompt is not stirred')
  put(1_792_000_000_200, pre('Read', 'b', { file_path: 'y' }, 'sub'))
  assert.equal(drainEvents('s1', single.held).held.requests[0].stirred, false, 'another agent does not stir it')
  put(1_792_000_000_300, pre('Read', 'c', { file_path: 'z' }))
  assert.equal(drainEvents('s1', single.held).held.requests[0].stirred, true)
  // A start between the call's start and its request (the parallel shape).
  put(1_792_000_001_000, { hook_event_name: 'SessionStart', source: 'clear' })
  put(1_792_000_001_100, pre('Read', 'p', { file_path: '/h/out' }))
  put(1_792_000_001_101, pre('Read', 'q', { file_path: '/w/in' }))
  put(1_792_000_001_200, ask('Read', { file_path: '/h/out' }))
  assert.equal(drainEvents('s1', heldWait()).held.requests[0].stirred, true)
})
