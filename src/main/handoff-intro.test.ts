import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { INTRO_HARD_LIMIT, introText, writeIntroFile } from './handoff-intro'
import { MAX_FIELD_LENGTH, MAX_FIRST_PARTY_BODY_LENGTH } from './intake-schema'
import { MAX_DELIVERY_BYTES } from './intake-source'
import { MAX_REPORT_LENGTH, MAX_SCHEDULE_AHEAD_DAYS, parseScheduledAt } from './handoff-delivery'
import { resolveTarget } from './handoff-target'

const folders = [
  { name: 'spekterm', path: '/home/u/git/spekterm' },
  { name: 'billservice', path: '/home/u/git/billservice' },
  { name: 'journal', path: '/home/u/work/journal' },
]

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-intro-')), 'intro.json')
}

test('every folder is listed: its directory once, then its name; directory + "/" + name is its path', () => {
  const text = introText({ folders, outbox: '/data/handoff/s1' })
  assert.match(text, /absolute path is its directory, "\/", and its name/)
  const lines = text.split('\n')
  for (const folder of folders) {
    assert.ok(lines.includes(`    ${path.basename(folder.path)}`), `missing ${folder.name}`)
  }
  // Each directory as a whole line, exactly once: a substring count would also find it inside a longer path.
  for (const dir of ['/home/u/git', '/home/u/work']) {
    assert.equal(lines.filter((line) => line === `  ${dir}`).length, 1, dir)
  }
})

test('two repos of one name in two directories: each path built from the text resolves to its folder', () => {
  const twins = [
    { id: 'a', name: 'api', path: '/srv/one/api' },
    { id: 'b', name: 'web', path: '/srv/one/web' },
    { id: 'c', name: 'api', path: '/srv/two/api' },
    { id: 'd', name: 'tools', path: '/srv/one/tools' },
  ]
  const lines = introText({ folders: twins, outbox: '/o' }).split('\n')
  const start = lines.findIndex((line) => line.startsWith('Repos in this workspace'))
  // Rebuild every listed path the way the text says: the directory line above, "/", the name.
  const built: string[] = []
  let dir = ''
  for (const line of lines.slice(start + 1)) {
    if (/^ {4}\S/.test(line)) built.push(`${dir}/${line.trim()}`)
    else if (/^ {2}\S/.test(line)) dir = line.trim()
    else break
  }
  assert.deepEqual(built.sort(), twins.map((f) => f.path).sort())
  for (const folder of twins) {
    assert.deepEqual(resolveTarget(folder.path, twins), { ok: true, folderId: folder.id })
  }
  assert.equal(resolveTarget('api', twins).ok, false, 'precondition: the name alone is ambiguous')
})

test('a folder at the root is listed by its path', () => {
  const lines = introText({ folders: [{ name: '', path: '/' }], outbox: '/o' }).split('\n')
  assert.ok(lines.includes('    /'))
})

test('投遞落點的位置在文字裡', () => {
  assert.ok(introText({ folders, outbox: '/data/handoff/s1' }).includes('/data/handoff/s1'))
})

test('告訴 agent 目標可以用絕對路徑 —— 那是同名歧義唯一的脫困路徑', () => {
  const text = introText({ folders, outbox: '/x' })
  assert.match(text, /absolute path/)
  assert.match(text, /Names are not unique/)
})

test('tells the agent where its receipts are and what they state (handoff-receipt)', () => {
  const text = introText({ folders, outbox: '/x/outbox/s1', receipts: '/x/receipts/s1' })
  assert.ok(text.includes('/x/receipts/s1'))
  for (const status of ['accepted', 'scheduled', 'duplicate', 'rejected', 'held']) assert.match(text, new RegExp(`^  ${status} +- `, 'm'), status)
  assert.match(text, /A file gone from your outbox means its receipt exists/)
  assert.match(text, /give each delivery a new file name/)
  assert.match(text, /"permanent": false means it can succeed once something changes/)
  // A handoff's accepted is checked again when it opens, and a failure then is not in the receipt.
  assert.match(text, /checked again when it opens; a failure then reaches the user, not the receipt/)
  assert.match(text, /say that you wrote the handoff, not that it was delivered/)
  assert.doesNotMatch(text, /no reply channel/i)
})

test('scheduling: the field, the offset, the bound, now, and only while spekterm runs (scheduled-handoff)', () => {
  const text = introText({ folders, outbox: '/x' })
  assert.match(text, /"at": "<optional>"/)
  assert.match(text, /ISO 8601 time with an offset/)
  assert.ok(text.includes(`more than ${MAX_SCHEDULE_AHEAD_DAYS} days ahead is rejected`))
  assert.match(text, /a time not later than now opens at once/)
  assert.match(text, /opens only while spekterm runs: if its time passed while spekterm was closed, it opens at the next start/)
  // The example time is itself valid, and accepted against a clock before it.
  const example = /\((\d{4}-\d{2}-\d{2}T[\d:]+[+-]\d{2}:\d{2})/.exec(text)?.[1]
  assert.ok(example)
  assert.equal(parseScheduledAt(example, Date.parse(example) - 60_000).kind, 'scheduled')
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

test('告知的內容說明失敗是可達的結果，以及投遞者從回條得知', () => {
  const text = introText({ folders: [], outbox: '/out' }).toLowerCase()

  assert.ok(text.includes('rejected'), '要明說一則交接可能被拒絕')
  assert.ok(text.includes('inbox'), '要說明使用者會在何處看到那次失敗')
  assert.ok(text.includes('receipt'), 'the agent learns it from the receipt')
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
    assert.match(text, /receipt says it was accepted, not that it was carried out/)
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

/**
 * **Every constraint that refuses a delivery or a command has its own assertion** (`scheduled-handoff`, D10): the
 * wording is tightened, and a rule dropped from unasserted text would turn nothing red. Key words, not sentences,
 * so tightening keeps them green; each was checked by deleting its sentence (control group, tasks 7.2).
 */
test('every constraint is stated (scheduled-handoff D10)', async (t) => {
  const handoff = introText({ folders, outbox: '/o', name: 'n', relations: '/r.json', reportable: true })
  const cases: [string, RegExp][] = [
    ['the .json suffix', /must end in \.json/],
    ['the atomic write: a temporary name that does not end in .json', /temporary name that does NOT end\s+in \.json/],
    ['the atomic write: then rename', /then rename/],
    ['a half-written file is read and rejected', /half-written \.json file (will be|is) read and rejected/],
    ['names match exactly and case-insensitively', /exactly \(case-insensitive\)/],
    ['partial or fuzzy matches are rejected', /Partial or fuzzy matches are rejected/],
    ['a command on a parent, a sibling or any other session is refused', /parent,\s+(your )?siblings and any other session are refused/],
    ['rename: one line', /on one\s+line/],
    ['rename: an empty name gives naming back', /empty name gives naming back/],
    ['rename: no messaging name changes', /No name used for messaging changes/],
    ['hibernate keeps the session', /Hibernate ends its process but keeps it/],
    ['report again after each later request', /Report again after each/],
  ]
  for (const [label, pattern] of cases) {
    await t.test(label, () => assert.match(handoff, pattern))
  }
})

/**
 * The budget (`agent-handoff-source`, D10): 30 folders under three directories, paths as long as a real user
 * data directory gives, the longest variant (a session created by a handoff). Past ~10,000 characters the CLI
 * replaces the whole introduction with a short preview; this keeps the margin visible to the next change that
 * adds a paragraph. Control group (tasks 7.4): fixed-length padding added to the text turns it red.
 */
const BUDGET = 8_000

function realisticInput(count: number): Parameters<typeof introText>[0] {
  const dirs = ['/home/alex/git', '/home/alex/git/acme-workspace', '/home/alex/src/personal']
  // Names of about 16 characters, as in a real workspace (measured average 15.7).
  const names = Array.from({ length: count }, (_, i) => `service-${String(i).padStart(2, '0')}-worker`.slice(0, 16))
  const id = '0f4c2b9e-7a1d-4e3b-9c55-2b8f6d1e0a37'
  return {
    folders: names.map((name, i) => ({ name, path: `${dirs[i % dirs.length]}/${name}` })),
    outbox: `/home/alex/.config/Spekterm/handoff/outbox/${id}`,
    receipts: `/home/alex/.config/Spekterm/handoff/receipts/${id}`,
    name: 'acme-workspace-0f4c',
    relations: `/home/alex/.config/Spekterm/handoff/relations/${id}.json`,
    reportable: true,
  }
}

test('the introduction stays within its budget for 30 folders', () => {
  const text = introText(realisticInput(30))
  console.log(`introduction: ${text.length} characters, budget ${BUDGET}, margin ${BUDGET - text.length}`)
  assert.ok(text.length <= BUDGET, `${text.length} > ${BUDGET}`)
  assert.ok(!text.includes('more not listed'), 'precondition: 30 folders are all listed')
})

test('a very large workspace keeps every rule within the hard limit, and says how many repos it left out', () => {
  const input = realisticInput(200)
  const text = introText(input)
  assert.ok(text.length <= INTRO_HARD_LIMIT, `${text.length} > ${INTRO_HARD_LIMIT}`)
  const left = /\((\d+) more not listed/.exec(text)
  assert.ok(left, 'the left-out count is stated')
  const listed = text.split('\n').filter((line) => /^ {4}\S/.test(line)).length
  assert.equal(listed + Number(left[1]), 200)
  // Every rule is still there: the end of the text is the report paragraph, the last one composed.
  assert.match(text, /Report again after each later request you finish\.$/)
  assert.match(text, /Partial or fuzzy matches are rejected/)
})
