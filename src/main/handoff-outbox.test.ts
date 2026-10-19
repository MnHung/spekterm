import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { configureHandoff, outboxDir, prepareOutbox, resetHandoffState } from './handoff-outbox'
import { testOpener } from './handoff-opener.testkit'
import { HandoffService } from './handoff-service'
import { IntakeService } from './intake-service'
import { IntakeStore } from './intake-store'

/**
 * 落點的**偵測**，而不是落點的內容。
 *
 * 這一整份的前提是「監看先掛上該落點，落點才被重新準備」—— 那是 session 被還原時的路徑，
 * 也是唯一會失效的路徑。**新建落點的情境驗不出這裡任何一條**（它是唯一不受影響的情形，
 * 而這個缺陷正是這樣躲過了整個能力的驗收）。
 *
 * **投遞寫入之後不得直接或間接觸發 `scan()`。** 掃描讀的是路徑，它看得到新目錄裡的檔案 ——
 * 走了掃描，一個監看已死的實作照樣通過。不明顯的入口有一個：`HandoffService.endSession()`
 * 會先 `await scan()` 再清除落點，這裡一律不呼叫它。
 */

const bases: string[] = []
const services: HandoffService[] = []

interface Harness {
  store: IntakeStore
  handoff: HandoffService
  accepted: { id: string; folderId: string }[]
  dir: (sessionId: string) => string
}

function harness(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-outbox-'))
  bases.push(base)
  resetHandoffState()
  configureHandoff(base)
  const archive = path.join(base, 'intake')
  fs.mkdirSync(archive, { recursive: true })
  const store = new IntakeStore(path.join(base, 'intake.json'))
  const service = new IntakeService({ store, archiveRoot: archive })
  const accepted: { id: string; folderId: string }[] = []
  const candidates = (): { id: string; name: string; path: string }[] => [{ id: 'f2', name: 'beta', path: '/repos/beta' }]
  const opener = testOpener(service, candidates, (_adapter, id, folderId) => accepted.push({ id, folderId }))
  const handoff = new HandoffService({
    service,
    sourceOf: (sessionId) => ({ folderId: 'f1', label: `session ${sessionId}` }),
    candidates,
    agentEventsEnabled: () => true,
    onDelivered: () => opener.tick(),
  })
  services.push(handoff)
  return { store, handoff, accepted, dir: (sessionId) => outboxDir(sessionId) }
}

/** 原子寫入：暫存檔名**不以 `.json` 結尾**（產品對那種檔名的處置是跳過）。 */
function drop(dir: string, name: string, contents: string): string {
  const target = path.join(dir, name)
  const tmp = `${target}.partial`
  fs.writeFileSync(tmp, contents)
  fs.renameSync(tmp, target)
  return target
}

/**
 * 讓監看把那次目錄替換**處理完**。
 *
 * **這個等待是承重的，而它是一條被實測逼出來的等待。** 重新準備之後**立刻**寫入的檔案，
 * 會在 chokidar 重新讀取那個新目錄時被一併撿走 —— 於是一個監看已死的實作**照樣全綠**
 * （第一版的對照組就是這樣過的）。現場的投遞是在 spawn 之後好幾分鐘才寫進去的，那時監看
 * 早已定案。這個間隔就是在重現那件事。
 *
 * 它沒有可觀察的完成訊號（我們看不見產品那個監看者的內部狀態），因此只能以時間界定。
 * 取 400ms：實測 400／500／2000ms 在舊實作下皆為紅，而整支測試仍在一秒級。
 */
const settleAfterSwap = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

/** 等待一個條件成立。**不是固定睡眠** —— 逾時即失敗並說出觀察到的值。 */
async function waitFor(
  label: () => string,
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // **label 是函式而不是字串** —— 字串會在等待**開始之前**就被求值，印出來的永遠是初始值，
  // 而「觀察到的值」正是這個訊息唯一的用處。
  assert.fail(`timed out waiting for: ${label()}`)
}

const payload = JSON.stringify({ target: 'beta', title: 'hand off', body: 'do the thing' })

after(async () => {
  for (const service of services) await service.dispose()
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})

test('落點被重新準備之後，其後寫入的投遞仍被偵測', async () => {
  // **對照組**：把 `prepareOutbox` 退回「刪掉再重建」→ 這條必須變紅。
  const h = harness()
  const session = 'restored-session'

  // 上一輪留下的落點 —— 監看在它之上掛起來。
  prepareOutbox(session)
  await h.handoff.start()

  // 還原：同一個 session 再次被準備。舊實作在這一步把被監看的對象換掉。
  prepareOutbox(session)
  await settleAfterSwap()

  drop(h.dir(session), 'a.json', payload)

  // 失敗訊息要分得出兩件事：**完全沒有收到事件**（兩個計數都是 0 ⇒ 監看死了）與
  // **收到了但內容不符**（有痕跡 ⇒ 監看活著，是投遞被拒絕）。兩者的處置完全不同。
  await waitFor(
    () => `監看收到重新準備之後的投遞（交接 ${h.store.list().length} 筆、`
      + `拒絕的痕跡 ${h.store.notices().length} 則）`,
    () => h.store.list().length === 1,
  )
  assert.equal(h.accepted.length, 1, '該則交接應被請求自動接受')
  assert.equal(h.accepted[0].folderId, 'f2')
})

test('重新準備不移除落點中未被消費的投遞，且它補寫之後仍被處理', async () => {
  const h = harness()
  const session = 'session-with-leftover'

  // 寫到一半的投遞 —— 解析失敗，因此不被消費。
  prepareOutbox(session)
  const leftover = drop(h.dir(session), 'half.json', '{"target": "beta", "bo')
  await h.handoff.start()
  assert.equal(h.store.list().length, 0, '半成品不該產生任何一則交接')
  assert.ok(fs.existsSync(leftover), '半成品不該被消費')

  // 重新準備**不得**把它清掉 —— 一則尚未被讀到的交接在它的 session 重啟時消失，
  // 投遞端與使用者兩邊都不會知道。
  prepareOutbox(session)
  assert.ok(fs.existsSync(leftover), '重新準備之後，未被消費的投遞仍應存在')
  await settleAfterSwap()

  // 補寫發生在同一個路徑上（不會再產生一次 `add`，靠 `change`）。
  fs.writeFileSync(leftover, payload)
  await waitFor(
    () => `補寫之後那則交接被處理（交接 ${h.store.list().length} 筆、`
      + `拒絕的痕跡 ${h.store.notices().length} 則）`,
    () => h.store.list().length === 1,
  )
})

test('準備落點不會把落點換成另一個目錄', { skip: process.platform !== 'linux' && '判準為 Linux-only' }, () => {
  // **這條是結構判準，不是行為斷言。** 上面兩條對一個「rm → 讓出一個 event loop tick →
  // mkdir」的實作**會全綠**（實測 chokidar 在那之下來得及重新掛上）—— 而那個實作把不變式
  // 押在監看者的處理速度上，機器忙一點就再度失效。只有這一條攔得住它。
  //
  // **那個變體在今天的形狀下寫不出來**（`prepareOutbox` 是同步的，同步函式裡讓不出 tick），
  // 因此它沒有對應的 mutation —— 這一條的對照組與上面兩條共用「退回刪掉再重建」那一個。
  // 它獨立的價值在於**與時序無關**：日後若這支函式變成非同步、或 chokidar 改以路徑重新掛上
  // （見 design R4），上面兩條會開始變綠，而這一條照樣紅。
  //
  // **不可改用 inode 比對**：實測 ext4 在 `rmSync` 之後立刻 `mkdirSync`，20/20 次 inode
  // 被重用，那會是一盞永遠亮綠的燈 —— 而它是下一個人第一個會想到的辦法。
  const h = harness()
  const session = 'session-identity'
  prepareOutbox(session)

  const fd = fs.openSync(h.dir(session), 'r')
  try {
    prepareOutbox(session)
    const seen = fs.readlinkSync(`/proc/self/fd/${fd}`)
    assert.ok(
      !seen.endsWith(' (deleted)'),
      `準備落點之後它應仍是同一個目錄物件，實際為 ${seen}`,
    )
  } finally {
    fs.closeSync(fd)
  }
})

test('落點的路徑被佔成檔案時仍能準備起來', () => {
  // 少了這條，`mkdirSync` 拋 `EEXIST` ⇒ `prepareOutbox` 回 `null` ⇒ 該 session
  // **完全不注入交接**（agent 不知道自己可以交接），而畫面上什麼都沒有。
  const h = harness()
  const session = 'session-occupied'
  const dir = h.dir(session)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  fs.writeFileSync(dir, 'not a directory')

  assert.equal(prepareOutbox(session), dir)
  assert.ok(fs.lstatSync(dir).isDirectory())
})
