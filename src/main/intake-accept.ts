import type { IntakeRecord } from './intake-store'

/**
 * `accept` 的回傳形狀 —— 成功時帶一個**指示**（在哪個 folder 建立），外加「它是不是已經
 * 建過一個」（預填逾時退回待處理時，那個 session 仍然存在）。
 */
export type IntakeAcceptResult =
  | { ok: true; folderId: string; existingSessionId?: string; ticket?: string }
  | { ok: false; reason: 'unknown' | 'prefillUnavailable' | 'FOLDER_GONE' | 'opening' }

/**
 * 接受一則 intake 的判定 —— **在哪個 folder 建立，由使用者確認的那一個決定**。
 *
 * ## 輸入刻意不含 routing 的解析結果
 *
 * routing 只決定卡片上**預先選定**哪一個（renderer 那端）。接受時若主行程還能退回解析結果，
 * 「使用者沒選」與「使用者選了解析結果」在這裡就分不出來，而解析不出 folder 的項目多了一條
 * 不經使用者的預設路徑 —— 那正是 `intake-routing` 禁止的事。**不給這個函式解析結果，
 * 退回就寫不出來。** handler 那一層由 `probe-intake` 直接呼叫 IPC 的斷言守著。
 *
 * ## 順序
 *
 * 事件回報關閉的檢查排在 folder 之前（與此前相同）：那是「接受之前就要告知」的快速路徑，
 * 而它與使用者選了哪裡無關。
 */
export function decideAccept(input: {
  record: IntakeRecord | undefined
  /** 使用者在卡片上確認的 folder。**不受信任** —— 它來自 renderer。 */
  chosenFolderId: unknown
  knownFolderIds: ReadonlySet<string>
  eventsEnabled: boolean
  /**
   * A session is being opened for this record now: an opening request or another accept holds its ticket
   * (`TicketStore.isLive`). Accepting it too would open a second session (`scheduled-handoff`, design D3).
   */
  opening?: boolean
}): IntakeAcceptResult {
  const { record, chosenFolderId, knownFolderIds, eventsEnabled } = input
  if (!record?.content) return { ok: false, reason: 'unknown' }
  // Not `firedAt`: a record pending again after a prefill timeout must still be accepted, reusing its session.
  if (input.opening) return { ok: false, reason: 'opening' }

  // **事件回報關閉時，預填永遠不會發生 —— 於是在建立 session 之前就告知。**
  // 少了這條，使用者得到一個空的 session、一則已離開待處理清單的工作項目，以及零錯誤訊息。
  if (!eventsEnabled) return { ok: false, reason: 'prefillUnavailable' }

  // 空字串是 renderer「沒有選定」的表示（佔位項的值）—— 與缺漏同義。
  if (typeof chosenFolderId !== 'string' || chosenFolderId === '') return { ok: false, reason: 'unknown' }

  // **查表，不是信任**：folder 識別碼是 renderer 的合法詞彙，但它指的 folder 必須此刻確實在
  // workspace 之中 —— 選定之後、按下接受之前被移除的，正確的處置是告訴使用者。
  if (!knownFolderIds.has(chosenFolderId)) return { ok: false, reason: 'FOLDER_GONE' }

  /**
   * **這一則已經建過 session 了嗎。**
   *
   * 預填逾時會把它退回待處理，而**那個 session 仍然存在** —— 再次接受時若又建一個，
   * 每處理一次就多一個空的 session，**沒有上界**，而每一個看起來都正常。
   *
   * 回傳既有的識別碼，由 renderer 判斷它還在不在、是不是在使用者這次選的 folder：
   * 兩者皆是才沿用。判斷放在 renderer 是因為 session 清單的權威在它那裡。
   */
  return {
    ok: true,
    folderId: chosenFolderId,
    ...(record.sessionId ? { existingSessionId: record.sessionId } : {}),
  }
}
