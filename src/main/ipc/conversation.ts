import { type WebContents, ipcMain } from 'electron'

import { encodeInput } from '../agent-events'
import { waitStateOf } from '../agent-wait'
import { type Follow, startFollow } from '../conversation-follow'
import { existingTerminalService } from './terminal'

/**
 * 對話 view 的內容通道。
 *
 * ## 只跟一個 session
 *
 * 與 `session-status` 同一條理由：呈現的恆是當下顯示的那一個 session，因此 renderer 告訴主行程
 * 「現在看的是誰」，主行程就只為那一個建立跟進。開了 20 個 session 也只有一份監看。
 *
 * **這也是為什麼跟進不在 `TerminalService` 裡建立**：那樣每個 session 一建立就開始跟進，而
 * 絕大多數 session 的對話 view 從來沒有被打開過。
 *
 * ## 拆除的兩個來源，以及一個**不是**來源的東西
 *
 * 拆除發生於：renderer 換去看別的 session，或這個 renderer 消失（reload／關窗）。
 *
 * **agent 自己回報的「對話結束」不是拆除的來源。** 實測（2026-09-06、CLI 2.1.263）：使用者在
 * agent 之內清空對話時它就會回報結束，**而 pty 還活著**。接上拆除的話，使用者按一次清空，
 * 對話 view 就此停住 —— 而 session 正常、終端正常、沒有任何錯誤。
 */

export const CONVERSATION_CHANNELS = {
  /** renderer → main：現在盯著哪個 session 的對話（`null` ＝ 停止）。 */
  watch: 'workspace:conversation:watch',
  /** main → renderer：內容更新。單向推送，與 terminal 的 `data` 同類。 */
  update: 'workspace:conversation:update',
  /** main → renderer：等待狀態（能不能送）。 */
  wait: 'workspace:conversation:wait',
  /** renderer → main：送出一則訊息。**閘在主行程**。 */
  send: 'workspace:conversation:send',
} as const

/**
 * 等待狀態住在 `agent-wait`，**而這裡只是它的訂閱者之一**。
 *
 * 狀態本來就是 per session（事件是讀完即刪的串流，把狀態綁在訂閱上會讓切走再切回時它退回
 * 未知，而重建它所需的事件早已被讀走）。**輪詢原本還綁在這個觀察者身上** —— 於是「還沒有人
 * 在看」的 session 其狀態根本不會被求值，預填就永遠等不到 `ready`。那一半已經搬走。
 */

/** 每個 renderer 至多一份 —— 呈現的恆是當下顯示的那一個 session。 */
const followers = new Map<number, Follow>()

function stop(contentsId: number): void {
  const entry = followers.get(contentsId)
  if (!entry) return
  entry.stop()
  followers.delete(contentsId)
  // **等待狀態刻意不清除** —— 它屬於那個 session，不屬於這次訂閱。
  // 清除的時機是 session 結束，那由 `agent-events` 的落點清理負責。
}

function start(contents: WebContents, sessionId: string): void {
  const current = followers.get(contents.id)
  if (current?.sessionId === sessionId) return
  stop(contents.id)

  const source = existingTerminalService(contents.id)?.agentSourceOf(sessionId) ?? null
  const follow = startFollow(sessionId, source, {
    update: (update) => contents.send(CONVERSATION_CHANNELS.update, update),
    wait: (state, pending) => contents.send(CONVERSATION_CHANNELS.wait, sessionId, state, pending),
    alive: () => !contents.isDestroyed(),
  })
  if (follow) followers.set(contents.id, follow)
}

/** renderer 消失時的清理。與 watcher／pty 的擁有者記帳同構。 */
export function disposeConversationFor(contentsId: number): void {
  stop(contentsId)
}

export function registerConversationHandlers(): void {
  ipcMain.on(CONVERSATION_CHANNELS.watch, (event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      stop(event.sender.id)
      return
    }
    start(event.sender, sessionId)
  })

  /**
   * 送出的閘**在主行程**。
   *
   * renderer 那側的停用只是 UI 提示 —— 它不能是唯一的把關者，理由與檔案系統邊界相同：
   * preload 與 renderer 同屬一個行程樹，在那裡檢查等同沒有檢查。
   *
   * **未知時拒絕**。兩種失敗的代價不對等：「不確定就送送看」的失效是把內容打進一個正在等待
   * 其他輸入的位置（已知的真實後果包含替使用者做出未經同意的選擇）；「不確定就不送」的失效
   * 只是使用者多切換一次 view。
   */
  ipcMain.handle(CONVERSATION_CHANNELS.send, (event, sessionId: unknown, text: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') return { ok: false, reason: 'unknown' }
    const entry = followers.get(event.sender.id)
    if (!entry || entry.sessionId !== sessionId) return { ok: false, reason: 'unknown' }
    const wait = waitStateOf(sessionId)
    // `awaiting-choice` 只接受選項，不接受自由文字（`agent-input-bridge`）。
    if (wait === 'unknown' || wait === 'awaiting-choice') return { ok: false, reason: wait }
    const service = existingTerminalService(event.sender.id)
    if (!service) return { ok: false, reason: 'unknown' }
    service.write(sessionId, encodeInput(text))
    return { ok: true }
  })
}
