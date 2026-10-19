import fs from 'node:fs'
import path from 'node:path'

/**
 * 交接的投遞落點 —— **每個 agent session 各一個目錄**。
 *
 * ## 目錄名決定來源，而那**不是**不可偽造的
 *
 * 一則交接的來源由「它落在哪一個 session 的目錄」推導，於是「payload 自稱來源」這件事在型別上
 * 表達不出來 —— 收件匣「可驗證／第三方撰寫」的分類因此不被破壞。
 *
 * **但它擋不掉「agent 直接寫進別人的目錄」**：落點的根位置算得出來（`SPEKTERM_EVENT_DIR` 已經
 * 把 userData 交給它了，argv 上還有 `--settings` 的路徑），而 agent 有完整的檔案系統寫入權。
 * **這不是一道安全邊界**，任何倚賴「來源不可偽造」的下游設計都不成立（此前的交接次數上限因此
 * 是全域的；上限已於 `handoff-session-lifecycle` 移除）。
 *
 * ## 兩個目錄分開，而那是承重的
 *
 * - `outbox/<sessionId>/` —— agent 寫進來的地方，落點來源以 `depth: 1` 監看它的**父層**。
 * - `intro/<sessionId>.json` —— 我們寫給 agent 讀的自我介紹。
 *
 * 自我介紹**不能**放在 outbox 之內：它的副檔名是 `.json`，會被當成一份投遞讀進去。
 */

/** 落點的根。`configureHandoff()` 於主行程啟動時設定一次。 */
let handoffRootPath: string | null = null

/** 目前活著的 session —— 清單變動時要重寫它們的自我介紹。 */
const live = new Set<string>()

export function configureHandoff(userDataPath: string): void {
  handoffRootPath = path.join(userDataPath, 'handoff')
}

/** agent 寫進來的地方的**父層** —— 落點來源監看的就是它。 */
export function outboxRoot(): string {
  return handoffRootPath ? path.join(handoffRootPath, 'outbox') : ''
}

/** 某個 session 的投遞目錄。 */
export function outboxDir(sessionId: string): string {
  const root = outboxRoot()
  return root ? path.join(root, sessionId) : ''
}

/**
 * 某個 session 的關係檔（`session-lineage`）。**在 outbox 之外**，理由與自我介紹檔相同。
 */
export function relationsDir(): string {
  return handoffRootPath ? path.join(handoffRootPath, 'relations') : ''
}

export function relationsFile(sessionId: string): string {
  const dir = relationsDir()
  return dir ? path.join(dir, `${sessionId}.json`) : ''
}

/**
 * A session's receipts directory (`handoff-receipt`): beside the outbox, never in it — a receipt is a `.json`
 * file and would be read as a delivery there.
 */
export function receiptsDir(sessionId: string): string {
  return handoffRootPath ? path.join(handoffRootPath, 'receipts', sessionId) : ''
}

/** 某個 session 的自我介紹檔。**在 outbox 之外** —— 放進去會被當成一份投遞。 */
export function introFile(sessionId: string): string {
  return handoffRootPath ? path.join(handoffRootPath, 'intro', `${sessionId}.json`) : ''
}

/**
 * 由一份投遞檔的位置推出它的來源 session。
 *
 * **這是來源身分唯一的依據** —— 不看檔案內容、也不看目錄裡的任何檔案（agent 對自己的目錄有
 * 寫入權，那些東西不比 payload 可信）。
 *
 * 不在 `outbox/<sessionId>/` 正下方的檔案一律回 `null`。
 */
export function sourceSessionOf(file: string): string | null {
  const root = outboxRoot()
  if (!root) return null
  const rel = path.relative(root, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  if (parts.length !== 2) return null
  return parts[0] || null
}

/**
 * 建立某個 session 的投遞目錄。失敗回 `null`（呼叫端據此不注入）。
 *
 * ## 這裡**不移除任何東西**，而那是承重的
 *
 * 落點的監看是 app 啟動時對 `outbox/` 根掛一次的，它綁定的是目錄這個**對象**（watch 掛在
 * inode 上），不是它的路徑。**把落點刪掉再建立，監看就留在一個不再有任何動靜的舊對象上**
 * —— 該 session 的落點從此不被偵測，直到下次重啟。實測那次替換**不發出任何目錄事件**
 * （沒有 `unlinkDir`、沒有 `addDir`），於是連「在 `unlinkDir` 時重新掛上」這條補救路徑都不
 * 存在。觸發條件是「落點在被監看之後又被重新準備」，而最常見的形式就是 **session 被還原**。
 *
 * **在 rm 與 mkdir 之間讓出一個 event loop tick 會讓它「過」，而那是最糟的一種過** ——
 * 不變式被押在 chokidar 的處理速度上。唯一可靠的作法是不碰那個目錄。
 *
 * ## 為什麼連「清掉裡面的項目」都不做
 *
 * session 的識別碼不重複，於是這裡清得到的殘留**只有一種**：同一個 session 在上一次 app 執行
 * 中留下的東西 —— 而那正是啟動掃描本來就會讀到的（成功的已被消費、重複的由去重消費、
 * 解析不了的留著等補寫）。真正沒有清理路徑的孤兒落點（app 被強制結束、該 session 再也不會被
 * spawn）它**永遠碰不到**。
 *
 * 清除清得到的幾乎是空集合，代價卻是真的：一則**尚未被消費**的待處理交接會在下次 spawn 時
 * 被銷毀，**而投遞端與使用者兩邊都不會知道**。
 *
 * ## 但「已存在卻不是目錄」時仍要重建
 *
 * `mkdirSync(p, { recursive: true })` 在 `p` 已存在且不是目錄時拋 `EEXIST` ⇒ 這裡回 `null`
 * ⇒ 該 session **完全不注入交接**（沒有自我介紹、agent 不知道自己可以交接），而畫面上什麼
 * 都沒有。舊的「刪掉再重建」會自動化解這種情形，改成保留之後就化解不了，必須明寫。
 */
export function prepareOutbox(sessionId: string): string | null {
  const dir = outboxDir(sessionId)
  if (!dir) return null
  try {
    // `lstat` 而非 `stat`：指向別處的 symlink 也要當成「不是我們的落點」而重建。
    const existing = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (!existing?.isDirectory()) {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
    }
  } catch {
    return null
  }
  live.add(sessionId)
  return dir
}

/** 目前活著的 session（自我介紹要重寫時用）。 */
export function liveSessions(): string[] {
  return [...live]
}

/**
 * 清除某個 session 的落點與自我介紹。
 *
 * **呼叫端必須先把落點裡既有的項目處理完** —— 否則一則已經投遞、尚未被讀到的交接會隨 session
 * 的結束而消失，而投遞端與使用者兩邊都不會知道。那個順序住在 `handoff-service`。
 */
export function clearOutbox(sessionId: string): void {
  live.delete(sessionId)
  for (const target of [outboxDir(sessionId), introFile(sessionId), receiptsDir(sessionId)]) {
    if (!target) continue
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      // 清不掉不影響任何人：下次 spawn 同一個 id 時 `prepareOutbox` 會再清一次。
    }
  }
}

/** 供測試重置。 */
export function resetHandoffState(): void {
  live.clear()
}
