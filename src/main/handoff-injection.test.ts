import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { composeInjection } from './agent-injection'
import { prepareEventInjection, configureAgentEvents } from './agent-events'
import { prepareHandoffInjection, refreshIntros } from './handoff-injection'
import { configureHandoff, introFile, outboxDir, receiptsDir, resetHandoffState } from './handoff-outbox'

const folders = [{ name: 'alpha', path: '/repos/alpha' }]

function setup(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-injection-'))
  resetHandoffState()
  configureHandoff(base)
  configureAgentEvents(base)
  return base
}

function introContext(sessionId: string): string {
  const raw = JSON.parse(fs.readFileSync(introFile(sessionId), 'utf8'))
  return raw.hookSpecificOutput.additionalContext as string
}

test('建立投遞落點、寫出自我介紹、並以環境變數告知兩者的位置', () => {
  setup()
  const part = prepareHandoffInjection('s1', folders)
  assert.ok(part)
  assert.equal(fs.existsSync(outboxDir('s1')), true)
  assert.equal(part.env.SPEKTERM_HANDOFF_DIR, outboxDir('s1'))
  assert.equal(part.env.SPEKTERM_HANDOFF_INTRO, introFile('s1'))
  assert.ok(introContext('s1').includes(outboxDir('s1')))
})

test('hooks 走獨立欄位，不進 settings', () => {
  setup()
  const part = prepareHandoffInjection('s1', folders)!
  assert.equal('hooks' in part.settings, false)
  assert.deepEqual(Object.keys(part.hooks ?? {}), ['SessionStart'])
})

test('自我介紹不落在投遞落點之內 —— 落在裡面會被當成一份投遞讀走', () => {
  setup()
  prepareHandoffInjection('s1', folders)
  assert.equal(path.relative(outboxDir('s1'), introFile('s1')).startsWith('..'), true)
  assert.deepEqual(fs.readdirSync(outboxDir('s1')), [])
})

test('與事件橋接合成之後，SessionStart 上兩條命令都在', () => {
  const base = setup()
  const file = path.join(base, 'settings.json')
  const injection = composeInjection(file, [
    prepareEventInjection('s1', true),
    prepareHandoffInjection('s1', folders),
  ])
  assert.ok(injection)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  const commands = written.hooks.SessionStart.flatMap(
    (group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command),
  )
  assert.equal(commands.length, 2)
  assert.ok(commands.some((command: string) => command.includes('SPEKTERM_EVENT_DIR')))
  assert.ok(commands.some((command: string) => command.includes('SPEKTERM_HANDOFF_INTRO')))
})

test('清單變動時重寫活著的 session 的自我介紹', () => {
  setup()
  prepareHandoffInjection('s1', folders)
  assert.equal(introContext('s1').includes('beta'), false)

  refreshIntros(['s1'], [...folders, { name: 'beta', path: '/repos/beta' }], () => undefined)

  // The list is grouped by directory: `/repos` once, then `beta` on a line of its own.
  assert.match(introContext('s1'), /^ {4}beta$/m)
  assert.match(introContext('s1'), /^ {2}\/repos$/m)
})

test('上一輪未被消費的投遞不會在重建時被清掉', () => {
  // **這條原本是反過來寫的**（「殘留不會在重建後被重新投遞」），而它釘住的理由不成立：
  // 已經處理過的投遞早就被消費，即使沒有，去重也會在建立 session 之前擋下它。
  // 清得到的只有「同一個 session 上一輪的殘留」，而那正是啟動掃描本來就會讀到的；
  // 代價卻是真的 —— 一則**尚未被消費**的待處理交接被銷毀，而投遞端與使用者兩邊都不會知道。
  //
  // 落點不被刪除同時是「重新準備之後仍被偵測」的前提，見 `handoff-outbox.test.ts`。
  setup()
  prepareHandoffInjection('s1', folders)
  fs.writeFileSync(path.join(outboxDir('s1'), 'leftover.json'), '{}')

  prepareHandoffInjection('s1', folders)

  assert.deepEqual(fs.readdirSync(outboxDir('s1')), ['leftover.json'])
})

test('folder 清單變動後重寫的自我介紹仍含名字與關係檔位置', () => {
  setup()
  prepareHandoffInjection('s1', folders, { name: 'alpha-1111' })
  assert.ok(introContext('s1').includes('alpha-1111'))

  refreshIntros(['s1'], [...folders, { name: 'beta', path: '/repos/beta' }], (id) => (id === 's1' ? 'alpha-1111' : undefined))

  assert.ok(introContext('s1').includes('alpha-1111'), '名字仍在')
  assert.ok(introContext('s1').includes(path.join('relations', 's1.json')), '關係檔位置仍在')
})

test('由交接建立的 session，spawn 時的自我介紹含完成報告的說明；其他 session 沒有（handoff-completion）', () => {
  setup()
  prepareHandoffInjection('s1', folders, { name: 'alpha-1111', reportable: true })
  prepareHandoffInjection('s2', folders, { name: 'alpha-2222' })
  assert.ok(introContext('s1').includes('"kind": "report"'))
  assert.ok(!introContext('s2').includes('"kind": "report"'))
})

test('folder 清單變動後重寫的自我介紹仍含完成報告的說明', () => {
  setup()
  prepareHandoffInjection('s1', folders, { name: 'alpha-1111', reportable: true })
  refreshIntros(
    ['s1'],
    [...folders, { name: 'beta', path: '/repos/beta' }],
    () => 'alpha-1111',
    (id) => id === 's1',
  )
  assert.ok(introContext('s1').includes('"kind": "report"'), '完成報告那一段仍在')
  assert.match(introContext('s1'), /^ {4}beta$/m, '前置：真的重寫了（新 folder 在）')
})

test('the introduction written at spawn names the receipts directory (handoff-receipt)', () => {
  setup()
  prepareHandoffInjection('s1', folders)
  assert.ok(introContext('s1').includes(receiptsDir('s1')))
  refreshIntros(['s1'], folders, () => undefined)
  assert.ok(introContext('s1').includes(receiptsDir('s1')), 'and still after a rewrite')
})

test('注入的環境變數含關係檔位置', () => {
  setup()
  const contribution = prepareHandoffInjection('s1', folders, { name: 'alpha-1111' })
  assert.ok(contribution?.env?.SPEKTERM_HANDOFF_RELATIONS?.endsWith(path.join('relations', 's1.json')))
})
