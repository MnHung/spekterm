/**
 * 交接 session 的生命週期（`handoff-completion`）—— **純函式**，主行程與 renderer 共用。
 *
 * 落盤的只有三件事（`completion`）：報告何時被採納、這一輪落定了沒、之後有沒有重新開始。
 * 呈現的狀態由它們與**等待狀態**推導，不落盤 —— 等待狀態重啟之後本來就要重新取得。
 */

/** 主行程擁有的欄位（`sessions.json`）。 */
export interface CompletionState {
  /** 完成報告被採納的時刻。 */
  reportedAt: number
  /** 報告被採納之後，是否已見過一次等待狀態為就緒（這一輪結束了）。 */
  settled: boolean
  /** 落定之後重新開始工作的時刻。存在 ⇒ 不再是已完成。 */
  reopenedAt?: number
}

/** 等待狀態（`agent-event-bridge`）。與 `agent-events.ts` 的 `WaitState` 同一組值。 */
export type WaitValue = 'ready' | 'busy' | 'awaiting-choice' | 'unknown'

/**
 * 呈現的狀態。`idle` ＝ 不呈現任何一個（等待狀態未知，含休眠與已結束的 session）——
 * 它也是關係檔裡給 agent 看的那個值。
 */
export type LifecycleState = 'done' | 'working' | 'waiting' | 'idle'

export function isDone(completion: CompletionState | undefined): boolean {
  return completion !== undefined && completion.reopenedAt === undefined
}

/**
 * `seen` is the main process's seen mark (`session-wait-indicator`): a ready child the user has already looked at is
 * not "waiting for you" — the same words the session's status dot stops saying at that moment. Working stays the raw
 * busy state: a child given new work through Claude Code's messaging may report it with no prompt submission.
 */
export function lifecycleOf(completion: CompletionState | undefined, wait: WaitValue, seen: boolean): LifecycleState {
  if (isDone(completion)) return 'done'
  if (wait === 'busy') return 'working'
  if (wait === 'awaiting-choice') return 'waiting'
  if (wait === 'ready') return seen ? 'idle' : 'waiting'
  return 'idle'
}

/** 報告被採納。**覆蓋先前的一切**（含 `reopenedAt`）—— 後到的報告取代先前的。 */
export function onReportAdopted(reportedAt: number): CompletionState {
  return { reportedAt, settled: false }
}

/**
 * 報告被採納**之後**的一次等待狀態結算。回傳新值；沒有改變時回傳**同一個物件**（呼叫端據此決定要不要落盤）。
 *
 * ## 依「值」判定，不依「轉變」判定
 *
 * 報告經檔案監看送達、等待狀態經 400ms 輪詢送達，兩條通道互不排序。「寫報告 → 送訊息 → Stop」
 * 若 Stop 先被輪詢到、報告才被讀到，採納那一刻狀態已經是就緒，之後不會再「成為」就緒 —— 依轉變
 * 判定的話它永遠不會落定，其後的追問整段都顯示「已完成」。
 *
 * **「之後」由呼叫端保證**：只把採納之後的輪詢餵進來（採納當下快取的那個值可能是報告之前的殘留）。
 * 寫報告必經的工具呼叫事件一定在報告檔之前落盤，於是採納之後的下一次輪詢一定看得到它。
 *
 * ## 落定之前的忙碌不算重新開始
 *
 * 子 agent 寫完報告通常還會用訊息把結果送給母 session（一次工具呼叫 ⇒ 忙碌）；若報告之後的第一次
 * 忙碌就算重新開始，每一份報告都會被自己的收尾推翻。
 *
 * **未知不觸發任何轉移**（與 `isSubmitted` 同一個教訓：無法分辨的狀態不能推定為任何事）。
 */
export function onWaitTick(completion: CompletionState | undefined, wait: WaitValue, now: number): CompletionState | undefined {
  if (!completion || completion.reopenedAt !== undefined) return completion
  if (!completion.settled) return wait === 'ready' ? { ...completion, settled: true } : completion
  if (wait === 'busy' || wait === 'awaiting-choice') return { ...completion, reopenedAt: now }
  return completion
}

/** 落盤的形狀驗證。壞掉的丟棄（session 照留）。 */
export function parseCompletion(raw: unknown): CompletionState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { reportedAt, settled, reopenedAt } = raw as Record<string, unknown>
  if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt)) return undefined
  if (typeof settled !== 'boolean') return undefined
  if (reopenedAt !== undefined && (typeof reopenedAt !== 'number' || !Number.isFinite(reopenedAt))) return undefined
  return { reportedAt, settled, ...(reopenedAt !== undefined ? { reopenedAt } : {}) }
}

/**
 * 「收掉已完成」確認時真正要關的 session（`handoff-completion`）：**對話框列出的** ∩ **確認當下仍為已完成的**。
 *
 * 只取後者會關掉對話框開著期間才完成、使用者根本沒看到的 session；只取前者會關掉期間重新開始的。
 * 關閉 pty 不可逆，兩邊都要擋。
 */
export function closableNow(listed: readonly string[], isDoneNow: (sessionId: string) => boolean): string[] {
  return listed.filter((sessionId) => isDoneNow(sessionId))
}
