/**
 * 交接關係的型別 —— 主行程與 renderer 共用（renderer 不能 import 主行程的模組）。
 */

/**
 * 來源的歸屬。**三態，而且必須是三態** —— 以 `null`／`undefined` 表達「全域」與「未知」的話，
 * 一個以 `=== null` 或 falsy 判斷的消費端會把「攝入時來源已結束」呈現成「來自全域」，
 * 而型別檢查對此無感（`CLAUDE.md`「加列舉值時 grep 所有 `===`」）。消費端一律窮舉 `kind`。
 */
export type HandoffSourceOrigin =
  | { kind: 'folder'; folderId: string; folderName: string }
  | { kind: 'global' }
  | { kind: 'unknown' }

/**
 * 交接單中**留在 session 清單裡**的那一小部分（`handoff-brief`）。
 *
 * **本文不在這裡** —— 它另存為 `<id>.handoff.json`：`sessions.json` 每次整份同步重寫，一份本文
 * 最多兩萬字元，放進來會讓那個小檔隨交接數線性長大（畫面快照當初被搬出去是同一個理由）。
 * 標題留在這裡是因為每一個分頁與 rail 列的標籤都要它。
 */
export interface HandoffBrief {
  /** 交接的標題，攝入時正規化過的那一份。**可能為空** —— 標籤的取用順序會跳過空白的它。 */
  title: string
  /** 交接到達（被攝入）的時刻，epoch ms。 */
  receivedAt: number
}

/** session 的來源：母 session 的識別碼，與交接被攝入當下的快照。 */
export interface SessionLineage {
  /** 母 session 的 spekterm 識別碼（UUID）。**不是**對話識別碼 —— 後者在自癒時會換號。 */
  parentId: string
  origin: HandoffSourceOrigin
  parentTitle?: string
  /** 只有 agent 發起的交接（非第三方本文）才有。 */
  brief?: HandoffBrief
  /**
   * The ids above the parent, nearest first, so `[parentId, ...ancestors]` is the whole chain
   * (`agent-session-control` design D4). Taken when the handoff was ingested, not when this session was created.
   * Absent on records written before chains were kept: `ancestryOf` derives those from the records that remain.
   *
   * **Main process only.** The renderer receives it with the rest of the lineage and ignores it; the rail's tree
   * stays on `parentId` (`session-forest.ts`), and nothing the renderer persists can write it (`lineage` is a
   * main-owned field of the session store).
   */
  ancestors?: string[]
}
