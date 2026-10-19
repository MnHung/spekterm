import type { IntakeRejection } from './intake-schema'

/**
 * 一次拒絕是**永久**的還是**暫時**的。
 *
 * ## 判準：同一份投遞、在使用者不改變任何設定的情況下重送，會不會有不同結果
 *
 * **不是「這個失敗發生在系統的哪一層」。** 一部分失敗由交接自己的 adapter 算出（目標查無、
 * 目標歧義），另一部分由共用的攝入路徑算出（本文過長、投遞過大、識別碼不合法）——
 * **而那條內部界線對使用者毫無意義**。對他而言唯一有意義的分類是「這件事還有沒有救」。
 *
 * 以發生位置分流正是那個 bug 的成因：一則本文過長的交接被消費、沒有通知、沒有留下痕跡，
 * 使用者由「目標 repo 沒有開出 session」才得知，而來源 agent 回報它已經交接出去了。
 *
 * ## 「在使用者不改變任何設定的情況下」是這條判準承重的一半
 *
 * 少了它，`PREFILL_UNAVAILABLE`（agent 事件回報被關閉）會被判為永久 —— 於是使用者把那個
 * 開關打開之後，系統仍在提醒他一件已經不再成立的事。它與 `CAPACITY`（清一清收件匣就過）
 * 同類，雖然兩者在程式碼裡的 `consume` 相反。
 *
 * ## 定義域是一次投遞的結果，不是拒絕的類別代碼
 *
 * `DUPLICATE` **一個代碼承載兩種行為**：內容相同時是正常重送（靜默、不是失敗），
 * 內容不同時是識別碼搶佔（必須讓使用者知道）。兩者在 `IntakeRejection` 上分不開，
 * 而既有的 `notify` 旗標恰好就是它們的分水嶺 —— 於是這裡收 `{ code, notify }` 而非 `code`。
 *
 * ## 它決定通知與痕跡，**不決定** `consume`
 *
 * 兩者獨立。`handoff-service` 對落在錯誤位置的投遞回 `MALFORMED` 且 `consume: true`
 * （否則它每次掃描都再走一趟），而 `MALFORMED` 在這裡是暫時性的。把 `consume` 綁進這個
 * 判準會把那條路改壞。
 */
export interface RejectionOutcome {
  code: IntakeRejection
  /** 見 `DeliverOutcome.notify`：內容相同的重複恆為 false。 */
  notify: boolean
}

/**
 * **exhaustive switch，沒有 `default`。**
 *
 * 新增一種 `IntakeRejection` 時，這裡會**編譯失敗**，於是「它是永久還是暫時」成為一個
 * 必須被作出的決定，而不是一個靠作者記得去讀某份清單的約定。
 *
 * 這條紀律的必要性有一個就地的證據：本 change 的 design 第一版用來論證它的那張分類表，
 * **自己漏掉了 `MISSING_ID`**。
 */
export function isPermanentRejection({ code, notify }: RejectionOutcome): boolean {
  switch (code) {
    // ── 永久：重送必然同樣失敗 ──────────────────────────────────────────────
    case 'TOO_LONG':
    case 'TOO_LARGE':
    case 'INVALID_ID':
    case 'MISSING_ID':
    case 'FIELD_TYPE':
    case 'TARGET_NOT_FOUND':
    case 'TARGET_AMBIGUOUS':
    case 'REPORT_NOT_HANDOFF': // 同一個 session 再報告一次，它仍然不是交接建立的。
    case 'CONTROL_TARGET_NOT_FOUND': // The same name, resent, names the same nothing.
    case 'CONTROL_NOT_ALLOWED':
    case 'CONTROL_FAILED': // The session is gone, or the interface failed on it.
    case 'SCHEDULE_INVALID': // The same `at`, resent, breaks the same rule.
      return true

    // ── 暫時：狀態或設定改變後可能成功 ──────────────────────────────────────
    // `MALFORMED` —— 可能只是寫到一半，補寫完就過。
    // `CAPACITY` —— 使用者清一清收件匣就過。
    // `PREFILL_UNAVAILABLE` —— 使用者把 agent 事件回報打開就過。
    // `CONTROL_NO_WINDOW` —— a window coming back would let it succeed. The file is consumed anyway (`reject()`
    // always consumes), so "temporary" decides only the notification: a stale close cannot fire later
    // (`agent-session-control` D6).
    // `CONTROL_UNAVAILABLE` —— agent events off: a setting, as `PREFILL_UNAVAILABLE`.
    case 'MALFORMED':
    case 'CAPACITY':
    case 'PREFILL_UNAVAILABLE':
    case 'CONTROL_NO_WINDOW':
    case 'CONTROL_UNAVAILABLE':
      return false

    // ── 一個代碼、兩種行為 ──────────────────────────────────────────────────
    // 內容相同的重送是正常的（`notify: false`），它根本不是一次失敗。
    // 內容不同＝識別碼搶佔，那是永久的：同一個識別碼再送一次仍然撞上同一筆。
    case 'DUPLICATE':
      return notify
  }
}
