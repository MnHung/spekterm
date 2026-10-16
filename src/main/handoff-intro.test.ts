import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { introText, writeIntroFile } from './handoff-intro'
import { MAX_FIELD_LENGTH, MAX_FIRST_PARTY_BODY_LENGTH } from './intake-schema'
import { MAX_DELIVERY_BYTES } from './intake-source'
import { MAX_REPORT_LENGTH } from './handoff-delivery'

const folders = [
  { name: 'spekterm', path: '/home/u/git/spekterm' },
  { name: 'billservice', path: '/home/u/git/billservice' },
  { name: 'journal', path: '/home/u/work/journal' },
]

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-intro-')), 'intro.json')
}

test('每一個 folder 的名稱與絕對路徑都在文字裡', () => {
  const text = introText({ folders, outbox: '/data/handoff/s1' })
  for (const folder of folders) {
    assert.ok(text.includes(folder.name), `缺 ${folder.name}`)
    assert.ok(text.includes(folder.path), `缺 ${folder.path}`)
  }
})

test('投遞落點的位置在文字裡', () => {
  assert.ok(introText({ folders, outbox: '/data/handoff/s1' }).includes('/data/handoff/s1'))
})

test('告訴 agent 目標可以用絕對路徑 —— 那是同名歧義唯一的脫困路徑', () => {
  const text = introText({ folders, outbox: '/x' })
  assert.match(text, /absolute path/)
  assert.match(text, /Names are not unique/)
})

test('告訴 agent 它收不到投遞的結果 —— 否則它會回報一件沒有發生的事', () => {
  // 比對的是**那件事**而不是某一句的措辭：這段文字自本 change 起還要說明失敗長什麼樣子，
  // 而把斷言釘在一整句上會讓每一次補充都變成一次假性的紅燈。
  const text = introText({ folders, outbox: '/x' })
  assert.match(text, /YOU are not told|NOT be told/)
  assert.match(text, /no reply channel/i)
})

test('零 folder 的 workspace 不產生一份謊稱有對象的清單', () => {
  const text = introText({ folders: [], outbox: '/x' })
  assert.ok(text.includes('(none)'))
})

test('文字全為 ASCII —— 它會原樣進入 agent 的脈絡', () => {
  // 實測：格式壞掉的 JSON 也會原樣進脈絡，於是這份內容沒有「格式不對就被丟掉」的保護。
  assert.ok(/^[\x20-\x7e\n]*$/.test(introText({ folders, outbox: '/x' })))
})

test('落盤的是完整的 SessionStart hook 輸出，additionalContext 即那段文字', () => {
  const file = tmpFile()
  assert.equal(writeIntroFile(file, { folders, outbox: '/data/handoff/s1' }), file)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(
    written.hookSpecificOutput.additionalContext,
    introText({ folders, outbox: '/data/handoff/s1' }),
  )
})

test('不留下暫存檔 —— hook 可能正在讀它', () => {
  const file = tmpFile()
  writeIntroFile(file, { folders, outbox: '/x' })
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)])
})

test('寫不出來時回 null，呼叫端據此降級為沒有自我介紹', () => {
  // 讓父層是一個**檔案** ⇒ `mkdir` 立刻 `ENOTDIR`。
  //
  // **不要用 `/proc/<不存在>` 當作「寫不進去的位置」** —— 實測（2026-09-17、Node 22.22.0）
  // `fs.mkdirSync('/proc/x', { recursive: true })` 在這台機器上**不拋錯，它直接卡住**，
  // 於是整個測試檔連一條斷言都印不出來，看起來像測試框架壞了。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-intro-'))
  const blocker = path.join(base, 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  assert.equal(writeIntroFile(path.join(blocker, 'intro.json'), { folders, outbox: '/x' }), null)
})

/**
 * **告知的內容必須涵蓋所有會導致拒絕的約束。**
 *
 * 投遞者沒有回饋管道 —— 一個未被告知的約束就是一條死路：它照著手上那份說明去寫、
 * 被拒絕、然後回報自己已經交出去了。這正是本 change 要修的那個 bug。
 */
test('告知的內容涵蓋三個上限，且數字由常數推導', () => {
  const text = introText({ folders: [{ name: 'alpha', path: '/a' }], outbox: '/out' })

  assert.ok(text.includes(String(MAX_FIRST_PARTY_BODY_LENGTH)), '本文的長度上限要講')
  assert.ok(text.includes(String(MAX_FIELD_LENGTH)), '標題的長度上限要講（它同樣產生 TOO_LONG）')
  assert.ok(text.includes(String(Math.floor(MAX_DELIVERY_BYTES / 1024))), '整份投遞的大小上限要講')
})

test('告知的內容說明失敗是可達的結果，且投遞者不會被告知', () => {
  const text = introText({ folders: [], outbox: '/out' }).toLowerCase()

  assert.ok(text.includes('rejected'), '要明說一則交接可能被拒絕')
  assert.ok(text.includes('inbox'), '要說明使用者會在何處看到那次失敗')
  assert.ok(text.includes('not told') || text.includes('no reply channel'), '要說明投遞者不會被告知')
})

test('告知的內容給出「內容太長時怎麼辦」的做法', () => {
  // 少了這一句，agent 面對一份長交接只能自己截斷 —— 而截掉的正是它要交代的事。
  const text = introText({ folders: [], outbox: '/out' })
  assert.ok(/write the detail to a file/i.test(text))
})

{
  const text = introText({
    folders: [],
    outbox: '/o',
    name: 'alpha-1111',
    relations: '/data/handoff/relations/s1.json',
  })

  test('名字與關係：說出自己的名字', () => assert.ok(text.includes('alpha-1111')))
  test('名字與關係：指出關係檔的位置，並說明它會隨時更新', () => {
    assert.ok(text.includes('/data/handoff/relations/s1.json'))
    assert.match(text, /kept up to date/)
  })
  test('名字與關係：涵蓋母、子、兄弟', () => {
    for (const word of ['parent', 'children', 'siblings']) assert.ok(text.includes(word), word)
  })
  test('名字與關係：說明以名字經 Claude Code 的訊息功能聯絡、不在執行者收不到且不會被喚醒', () => {
    assert.match(text, /SendMessage/)
    assert.match(text, /"running": false/)
        assert.match(text, /will not\s+start it/)
  })
  test('relations: a relative listed as not running is hibernated, returns when the user wakes it, and is not woken by the agent (session-hibernation)', () => {
    assert.match(text, /"running": false is hibernated/)
    assert.match(text, /comes back when the user wakes it/)
    assert.match(text, /must not try to wake it/)
  })
  test('名字與關係：沒有名字與關係檔時不出現那一段', () => {
    assert.ok(!introText({ folders: [], outbox: '/o' }).includes('SendMessage'))
  })
}

test('告訴 agent 第一則 prompt 會被代為送出，且不再要求等使用者送出（handoff-session-lifecycle）', () => {
  // **對照組**：把舊句子放回 → 前兩條必須變紅。
  const text = introText({ folders, outbox: '/x', name: 'n', relations: '/r.json' })
  assert.ok(!text.includes('NOT submitted'), text)
  assert.ok(!text.includes('until the user has sent its first prompt'), text)
  assert.match(text, /sends its first prompt as soon as that agent is ready/)
})

test('完成報告的說明：上限由常數推導、要求不得為空、只對由交接建立的 session 說（handoff-completion）', () => {
  const child = introText({ folders, outbox: '/x', name: 'n', relations: '/r.json', reportable: true })
  assert.ok(child.includes(`at most ${MAX_REPORT_LENGTH} characters`), child)
  assert.ok(child.includes('not empty'))
  assert.ok(child.includes('SendMessage'))
  assert.ok(!introText({ folders, outbox: '/x', name: 'n', relations: '/r.json' }).includes('"kind": "report"'))
})

test('告訴母 session 關係檔裡看得到子 session 的狀態與摘要', () => {
  const text = introText({ folders, outbox: '/x', name: 'n', relations: '/r.json' })
  assert.match(text, /"state"/)
  assert.match(text, /"summary"/)
})

test('the session commands (agent-session-control)', async (t) => {
  const base = { folders: [], outbox: '/o' }

  await t.test('every agent session is told them, not only one created by a handoff', () => {
    const text = introText(base)
    assert.ok(text.includes('{"kind": "close"}'))
    assert.ok(text.includes('{"kind": "hibernate"}'))
    assert.ok(text.includes('{"kind": "rename", "name": "<new label>"}'))
    assert.match(text, /With no "target" it acts on your own session/)
  })

  await t.test('states the end-of-turn rule, the keystroke cancel, the events requirement and the missing reply', () => {
    const text = introText({ ...base, relations: '/r.json', name: 'alpha-1a2b' })
    assert.match(text, /wait until the target finishes its current turn/)
    assert.match(text, /Closing your own session does not close it: once your reply ends, the user is offered to close\s+or keep it/)
    assert.match(text, /If the user types into the target before a command is\s+carried out, it is dropped/)
    assert.match(text, /need agent event reporting to be on/)
    assert.match(text, /You are not told whether a command was carried out/)
    assert.match(text, /a closed one is gone, a hibernated one has "running": false/)
    assert.match(text, /"children" tree of your relations file/)
  })

  await t.test('the name limit it states is the one applied', () => {
    assert.ok(introText(base).includes(`"name" is at most ${MAX_FIELD_LENGTH} characters`))
  })

  await t.test('the relations paragraph describes the nesting and parentGone', () => {
    const text = introText({ ...base, relations: '/r.json' })
    assert.match(text, /Children nest/)
    assert.match(text, /"parentGone": true/)
  })
})
