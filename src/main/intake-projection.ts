import { bodyOf } from './intake-schema'
import { resolveRouting, type RoutingConfig } from './intake-routing'
import type { IntakeRecord } from './intake-store'

/**
 * 收件匣送往 renderer 的投影 —— **不 import electron**，於是測得到。
 *
 * 此前它住在 `ipc/intake.ts`（載入時就 `import { ipcMain } from 'electron'`，`node:test` 進不去），
 * 於是 `ipc/intake-projection.test.ts` 只能手抄一份「與 `project()` 同源」的投影來測 ——
 * 那是複本，不是被出貨的那一份；而那個檔案當時也不在 `npm test` 的 glob 裡。
 */

/** 送往 renderer 的投影 —— **逐欄位建構，不原樣轉手**。 */
export interface IntakeView {
  id: string
  adapter: string
  state: IntakeRecord['state']
  originKind: string
  originId: string
  originLabel: string
  title: string
  actor: string
  body: string
  bodyLength: number
  receivedAt: number
  /**
   * **呈現與排序用的時間**：投遞宣告的發生時間，**但不晚於到達時間**；沒有宣告時即到達時間。
   *
   * 上限是結構性的防護：發生時間是投遞者撰寫的，不夾住的話任何一份投遞都能宣告一個未來的
   * 時刻，把自己釘在收件匣的最上面。內容已過期時為 0。
   */
  occurredAt: number
  sessionId?: string
  /**
   * 解析結果 —— 已經是 renderer 的合法詞彙。**只有待處理項目帶它。**
   *
   * 已接受者開在哪裡，由它的 session 說了算（renderer 查 live 清單）。在這裡重算 routing
   * 報的是「現在的規則會解到哪」，而使用者接受時可以改選 folder、規則也可能事後改變 ——
   * 那會把「Opened in」標錯。
   */
  folderId?: string
  unresolved?: 'NO_MATCH' | 'FOLDER_GONE'
  /**
   * When a scheduled handoff opens (`scheduled-handoff`). **Only while it is scheduled** — pending and not yet
   * fired (design D1) — so an accepted record whose time is still ahead, or one whose opening was attempted, does
   * not carry it. A device reads a past value as due.
   */
  scheduledAt?: number
}

export function project(
  record: IntakeRecord,
  routing: RoutingConfig,
  knownFolderIds: ReadonlySet<string>,
): IntakeView {
  const content = record.content
  const base: IntakeView = {
    id: record.id,
    adapter: record.adapter,
    state: record.state,
    originKind: content?.verified.originKind ?? '',
    originId: content?.verified.originId ?? '',
    originLabel: content?.authored.originLabel ?? '',
    title: content?.authored.title ?? '',
    actor: content?.authored.actor ?? '',
    body: '',
    bodyLength: 0,
    receivedAt: content?.receivedAt ?? 0,
    occurredAt: content ? effectiveOccurredAt(content.authored.occurredAt, content.receivedAt) : 0,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
  }
  if (!content) return base

  const intake = { id: record.id, verified: content.verified, authored: content.authored, receivedAt: content.receivedAt }
  const body = bodyOf(intake)
  const scheduledAt = content.verified.scheduledAt
  const withBody = {
    ...base,
    body,
    bodyLength: body.length,
    ...(record.state === 'pending' && scheduledAt !== undefined && record.firedAt === undefined ? { scheduledAt } : {}),
  }
  if (record.state !== 'pending') return withBody

  // **解析失敗時不帶 `folderId`** —— `RoutingResult` 的失敗分支帶著「指向哪個不可用的
  // folder」，順手轉交就讓一則「沒有被預先選定」的項目在 renderer 那端有了一個預選值。
  const resolved = resolveRouting(routing, intake, knownFolderIds)
  return resolved.ok ? { ...withBody, folderId: resolved.folderId } : { ...withBody, unresolved: resolved.reason }
}

/**
 * 收件匣要呈現的那些，由新到舊。
 *
 * - **已忽略的不列**（既有）。
 * - **已了結的不列**（`accepted` 且帶 `settledAt`）。放在這裡而不是 renderer：那些項目的本文
 *   不必再隨每次推送整批送過去，而「已了結卻仍呈現」的錯誤只剩這一個地方可以犯。
 * - **依發生時間由新到舊**（見 `IntakeView.occurredAt`），同值時維持落盤的順序
 *   （`Array.prototype.sort` 是穩定的）。內容已過期者沒有時間，排在最後。
 *
 *   **不是依到達時間**：回補一次進來的項目到達時間幾乎相同，依它排序等於沒有排序。
 */
export function listView(
  records: readonly IntakeRecord[],
  routing: RoutingConfig,
  knownFolderIds: ReadonlySet<string>,
): IntakeView[] {
  return records
    .filter((record) => record.state !== 'dismissed')
    .filter((record) => !(record.state === 'accepted' && record.settledAt !== undefined))
    .map((record) => project(record, routing, knownFolderIds))
    .sort(byNewestOccurrence)
}

/**
 * 呈現與排序用的時間：宣告的發生時間，不晚於到達時間。
 *
 * **落盤的內容以型別判定**：舊版寫出來的紀錄沒有這個欄位，而落盤檔可能被手動改壞 ——
 * 不是有限的數字就當作沒有宣告。
 */
export function effectiveOccurredAt(declared: unknown, receivedAt: number): number {
  return typeof declared === 'number' && Number.isFinite(declared) ? Math.min(declared, receivedAt) : receivedAt
}

/** 依**發生**時間由新到舊。內容已過期（時間為 0）者自然落到最後。 */
export function byNewestOccurrence(a: IntakeView, b: IntakeView): number {
  return b.occurredAt - a.occurredAt
}
