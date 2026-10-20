import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachmentOf,
  consume,
  initialFollowState,
  planRead,
  project,
  projectLine,
  transcriptPathFor,
  type ViewEvent,
} from './transcript-follow'

const ENV = { userEnv: {}, processEnv: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/home/u' }

test('來源位置由起始工作目錄與對話識別碼算出', () => {
  assert.equal(
    transcriptPathFor('/home/u/git/spekterm', 'abc-123', ENV),
    '/cfg/projects/-home-u-git-spekterm/abc-123.jsonl',
  )
})

test('來源根尊重 CLAUDE_CONFIG_DIR，且使用者 shell 的值優先', () => {
  const p = transcriptPathFor('/a', 'x', { userEnv: { CLAUDE_CONFIG_DIR: '/user' }, processEnv: { CLAUDE_CONFIG_DIR: '/proc' }, home: '/h' })
  assert.ok(p.startsWith('/user/projects/'), p)
})

test('planRead 三種情況各自分開', () => {
  const s = { offset: 10, pending: Buffer.alloc(0) }
  assert.deepEqual(planRead(s, 10), { kind: 'idle' })
  assert.deepEqual(planRead(s, 25), { kind: 'append', from: 10 })
  // 檔案變短 ⇒ 它被改寫或換掉了。沿用舊偏移會從內容的中間開始讀。
  assert.deepEqual(planRead(s, 4), { kind: 'reset' })
})

test('只送出新增的內容', () => {
  let s = initialFollowState()
  const first = consume(s, Buffer.from('{"a":1}\n{"a":2}\n'), false)
  s = first.state
  assert.deepEqual(first.lines, ['{"a":1}', '{"a":2}'])
  const second = consume(s, Buffer.from('{"a":3}\n'), false)
  assert.deepEqual(second.lines, ['{"a":3}'])
  assert.equal(second.state.offset, 24)
})

test('不完整的最後一行不被送出，補完之後只送一次', () => {
  let s = initialFollowState()
  const a = consume(s, Buffer.from('{"a":1}\n{"a":'), false)
  s = a.state
  assert.deepEqual(a.lines, ['{"a":1}'])
  const b = consume(s, Buffer.from('2}\n'), false)
  assert.deepEqual(b.lines, ['{"a":2}'])
  const c = consume(b.state, Buffer.from(''), false)
  assert.deepEqual(c.lines, [])
})

test('多位元組字元被讀取邊界切開時仍能還原', () => {
  const body = Buffer.from('{"t":"繁體中文"}\n', 'utf8')
  const cut = 10 // 落在某個中文字的中間
  const s = initialFollowState()
  const a = consume(s, body.subarray(0, cut), false)
  assert.deepEqual(a.lines, [])
  const b = consume(a.state, body.subarray(cut), false)
  assert.deepEqual(b.lines, ['{"t":"繁體中文"}'])
})

test('reset 時自頭重讀，且不沿用舊的未完成尾段', () => {
  const s = { offset: 100, pending: Buffer.from('{"stale"') }
  const r = consume(s, Buffer.from('{"a":1}\n'), true)
  assert.deepEqual(r.lines, ['{"a":1}'])
  assert.equal(r.state.offset, 8)
})

const userRec = {
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-09-06T00:00:00.000Z',
  cwd: '/home/u/secret-place',
  message: { role: 'user', content: 'hello' },
}

test('未知的記錄類型被忽略且不報錯', () => {
  for (const t of ['attachment', 'file-history-snapshot', 'queue-operation', 'ai-title', 'system']) {
    assert.deepEqual(project({ ...userRec, type: t }), [], t)
  }
})

test('投影不含絕對路徑（對照組：改為原樣轉手即應失敗）', () => {
  const events = project(userRec)
  assert.equal(events.length, 1)
  const serialized = JSON.stringify(events)
  assert.ok(!serialized.includes('/home/u/secret-place'), serialized)
  // 對照組：若實作改成「複製整則再刪幾個欄位」，這一行會抓到殘留的路徑。
  assert.ok(!serialized.includes('/'), serialized)
})

test('工具只帶單一辨識參數，完整參數不外流', () => {
  const rec = {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-06T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/y.ts', offset: 3, secret: '/private/key' } },
      ],
    },
  }
  const [e] = project(rec) as [Extract<ViewEvent, { kind: 'tool' }>]
  assert.equal(e.kind, 'tool')
  assert.equal(e.name, 'Read')
  assert.equal(e.arg, '/x/y.ts')
  assert.ok(!JSON.stringify(e).includes('/private/key'))
})

test('assistant 的三種區塊各自投影，未知區塊被忽略', () => {
  const rec = {
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-09-06T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
        { type: 'redacted_thinking', data: 'zzz' },
      ],
    },
  }
  assert.deepEqual(
    project(rec).map((e) => e.kind),
    ['thinking', 'text', 'tool'],
  )
})

test('tool_result 自 user 記錄投影，且不被當成使用者訊息', () => {
  const rec = {
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-09-06T00:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok', is_error: false }] },
  }
  const [e] = project(rec) as [Extract<ViewEvent, { kind: 'result' }>]
  assert.equal(e.kind, 'result')
  assert.equal(e.id, 't2')
  assert.equal(e.error, false)
})

test('isMeta 的使用者訊息保留但標示，不丟棄', () => {
  const [e] = project({ ...userRec, isMeta: true }) as [Extract<ViewEvent, { kind: 'user' }>]
  assert.equal(e.meta, true)
})

// Shapes measured on CLI 2.1.300 (`docs/lessons/transcript.md`); identifiers shortened, paths removed.
function queued(attachment: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'attachment',
    uuid: 'att-1',
    timestamp: '2026-10-15T01:14:33.936Z',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt: '  what is 6 times 7?  ',
      source_uuid: 'src-1',
      delivery_id: 'del-1',
      commandMode: 'prompt',
      origin: { kind: 'human' },
      ...attachment,
    },
  }
}

test('a message typed while tools ran is the user\'s message, text unchanged', () => {
  assert.deepEqual(project(queued({})), [
    { kind: 'user', uuid: 'att-1', at: Date.parse('2026-10-15T01:14:33.936Z'), text: '  what is 6 times 7?  ', meta: false },
  ])
})

test('other mid-turn deliveries and other attachments are not shown', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['task notice', queued({ commandMode: 'task-notification', origin: { kind: 'task-notification' } })],
    ['peer message', queued({ origin: { kind: 'peer', name: 'other-1234' } })],
    ['no origin', queued({ origin: undefined })],
    ['non-string prompt', queued({ prompt: [{ type: 'text', text: 'x' }] })],
    ['blank prompt', queued({ prompt: '   ' })],
    ['other subtype', queued({ type: 'edited_text_file' })],
    ['no attachment', { ...queued({}), attachment: undefined }],
  ]
  for (const [name, rec] of cases) assert.deepEqual(project(rec), [], name)
})

test('records the user did not type are marked, typed ones are not', () => {
  const meta = (extra: Record<string, unknown>, content = 'x'): boolean => {
    const [e] = project({ ...userRec, message: { role: 'user', content }, ...extra }) as [
      Extract<ViewEvent, { kind: 'user' }>,
    ]
    return e.meta
  }
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'
  assert.equal(
    meta({ promptSource: 'system', origin: { kind: 'task-notification', producer: 'session-task' } }, notice),
    true,
    'task notice',
  )
  assert.equal(meta({ promptSource: 'system' }, notice), true, 'system source alone')
  assert.equal(meta({ origin: { kind: 'peer' } }), true, 'non-human origin alone')
  assert.equal(meta({ isCompactSummary: true, isVisibleInTranscriptOnly: true }), true, 'compaction summary')
  assert.equal(meta({ promptSource: 'typed', origin: { kind: 'human' } }), false, 'typed prompt')
  assert.equal(meta({ promptSource: 'queued', origin: { kind: 'human' } }), false, 'queued prompt')
  assert.equal(meta({}, '<command-name>/clear</command-name>'), false, 'slash command, no origin fields')
})

test('subagent 的記錄被略過', () => {
  assert.deepEqual(project({ ...userRec, isSidechain: true }), [])
})

test('壞掉的一行被忽略，不使跟進停擺', () => {
  assert.deepEqual(projectLine('{"a":'), [])
  assert.deepEqual(projectLine(''), [])
})

test('初次附掛超過上限時只送最近一段並標示', () => {
  const events: ViewEvent[] = Array.from({ length: 10 }, (_, i) => ({
    kind: 'text',
    uuid: `u${i}`,
    at: i,
    text: `t${i}`,
  }))
  const a = attachmentOf(events, 4)
  assert.equal(a.truncated, true)
  assert.deepEqual(a.events.map((e) => e.uuid), ['u6', 'u7', 'u8', 'u9'])
  const b = attachmentOf(events, 10)
  assert.equal(b.truncated, false)
  assert.equal(b.events.length, 10)
})

const userRecord = (content: string) => ({
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-10-15T00:00:00Z',
  message: { role: 'user', content },
  promptSource: 'typed',
  origin: { kind: 'human' },
})

test('a message that is one paste is shown as the pasted text (the measured shape)', () => {
  const sent = 'a long reply\n\nwith paragraphs and a path `/home/me/x.png`'
  const recorded = `\n\n<pasted_content id="55b5">\n${sent}\n</pasted_content id="55b5">\n`
  const [event] = project(userRecord(recorded))
  assert.equal(event.kind, 'user')
  assert.equal((event as { text: string }).text, sent)
})

test('a paste among typed text, or with a mismatched closing id, is shown as recorded', () => {
  const mixed = 'typed first\n\n<pasted_content id="a1">\npasted\n</pasted_content id="a1">\n'
  assert.equal((project(userRecord(mixed))[0] as { text: string }).text, mixed)
  const mismatched = '<pasted_content id="a1">\npasted\n</pasted_content id="b2">\n'
  assert.equal((project(userRecord(mismatched))[0] as { text: string }).text, mismatched)
})

test('a path in a message is delivered as written', () => {
  const text = 'look at /home/me/repo/src/x.ts please'
  assert.equal((project(userRecord(text))[0] as { text: string }).text, text)
})

const textOf = (content: string) => (project(userRecord(content))[0] as { text: string; meta: boolean })

test('a skill run with arguments is shown as the line typed (the measured shape, message first)', () => {
  const recorded = '<command-message>opsx:continue</command-message>\n<command-name>/opsx:continue</command-name>\n<command-args>my-change</command-args>'
  assert.equal(textOf(recorded).text, '/opsx:continue my-change')
  assert.equal(textOf(recorded).meta, false)
})

test('a command without arguments is shown as its name', () => {
  assert.equal(textOf('<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n<command-args></command-args>').text, '/simplify')
  assert.equal(textOf('<command-message>simplify</command-message>\n<command-name>/simplify</command-name>').text, '/simplify', 'no args marker')
})

test('a built-in command recorded name first and indented is shown as typed', () => {
  const recorded = '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'
  assert.equal(textOf(recorded).text, '/compact')
})

test('arguments keep their inner spacing, special characters and newlines, trimmed at both ends', () => {
  const recorded = '<command-message>probe-echo</command-message>\n<command-name>/probe-echo</command-name>\n<command-args>  sp1  <a&b>\nline2 </command-args>'
  assert.equal(textOf(recorded).text, '/probe-echo sp1  <a&b>\nline2')
})

test('markers among other text, or a second name, are shown as recorded', () => {
  // Control group: drop the whole-content check (`rest.trim() !== ''`) → the first case is restored (red).
  const mixed = 'typed first <command-name>/x</command-name>'
  assert.equal(textOf(mixed).text, mixed)
  const twice = '<command-name>/a</command-name><command-name>/b</command-name>'
  assert.equal(textOf(twice).text, twice)
  const output = '<local-command-stdout>Compacted</local-command-stdout>'
  assert.equal(textOf(output).text, output, 'a built-in command\'s output is not restored')
})
