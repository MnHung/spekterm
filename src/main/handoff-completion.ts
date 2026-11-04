import { createHash } from 'node:crypto'

import { preferredTitle } from '../shared/lineage/label'
import { onReportAdopted, onWaitTick, type CompletionState, type WaitValue } from '../shared/lineage/lifecycle'
import type { SessionStore } from './session-store'
import { MAX_REPORT_LENGTH } from './handoff-delivery'
import { toWellFormed } from './teammate-outbox'

/**
 * 完成報告的採納與生命週期的推進（`handoff-completion`）。
 *
 * **它不傳遞任何東西給母 session** —— 結果由子 agent 自己以 agent CLI 的訊息功能送出；這裡只保存、
 * 讓畫面與關係檔看得到（design D7）。
 */

/**
 * A teammate report's limit: the completion report's own (which the introduction states), never above the server's
 * 4,000 (protocol §5 `handoff.update`). Today they are equal; the minimum keeps it so if the local one moves.
 */
export const MAX_TEAMMATE_REPORT_LENGTH = Math.min(MAX_REPORT_LENGTH, 4_000)

export type ReportDecision = 'accepted' | 'duplicate' | 'not-handoff' | 'gone' | 'teammate-stopped'

export interface CompletionDeps {
  sessions: SessionStore
  /** 訂閱某個 session 的等待狀態。**每一次輪詢都通知**（`agent-wait.ts` 的 `tick`）。 */
  subscribe: (sessionId: string, subscriber: (snapshot: { state: WaitValue }) => void) => () => void
  now?: () => number
  /** 呈現的狀態可能改變了（關係檔與 renderer 據此更新）。 */
  onChange?: (sessionId: string) => void
  /**
   * 一份報告**剛被採納**（`handoff-completion` 的通知）。**綁定於採納，不綁定於狀態** —— 重複讀到的
   * 同一份不會再呼叫，重新啟動也不會對既有的已完成狀態呼叫。
   */
  onReported?: (sessionId: string, title: string, summary: string, options?: { sheet: boolean }) => void
  /**
   * A session opened from a teammate's handoff reported (`teammate-handoff-return`, design D10): queue `done` with
   * the text. `ok: false` when reporting for that handoff has stopped or it was declined. `title` is the handoff's.
   */
  teammateReport?: (sessionId: string, handoffId: string, text: string) => { ok: true; title: string } | { ok: false }
}

export class HandoffCompletion {
  readonly #deps: CompletionDeps
  readonly #now: () => number
  /** 每個 session 最後一次採納的投遞檔身分 —— 同一份檔被讀兩次只採納一次。 */
  readonly #adopted = new Map<string, string>()
  readonly #subscriptions = new Map<string, () => void>()

  constructor(deps: CompletionDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /**
   * 採納一份完成報告。
   *
   * - 以 `view()` 查（**含暫定紀錄** —— 報告可能在 renderer 把新 session 送來持久化之前就到了）；
   * - 查無 ⇒ `gone`（呼叫端靜默丟棄：沒有可以掛上去的 session，而那不是投遞者的錯）；
   * - 非由交接建立 ⇒ `not-handoff`（呼叫端拒絕且可見）；
   * - **同一份投遞檔只採納一次**：「先監看再掃描」會讓它被讀兩次，而第二次採納會把已落定的狀態
   *   重設回未落定。身分由呼叫端給（路徑＋修改時間＋內容摘要）。
   */
  acceptReport(sessionId: string, summary: string, identity: string): ReportDecision {
    const session = this.#deps.sessions.view().find((entry) => entry.session.id === sessionId)?.session
    if (!session) return 'gone'
    if (!session.lineage) {
      if (session.teammateHandoff && this.#deps.teammateReport) return this.#acceptTeammate(sessionId, session.teammateHandoff.handoffId, summary, identity)
      return 'not-handoff'
    }
    if (this.#adopted.get(sessionId) === identity) return 'duplicate'
    this.#adopted.set(sessionId, identity)

    const reportedAt = this.#now()
    const existing = this.#deps.sessions.readHandoffBrief(sessionId)
    this.#deps.sessions.writeHandoffBrief(sessionId, { ...(existing ?? {}), report: { summary, reportedAt } })
    this.#deps.sessions.setCompletion(sessionId, onReportAdopted(reportedAt))
    this.#deps.onChange?.(sessionId)
    this.#deps.onReported?.(sessionId, preferredTitle(session) ?? '', summary)
    return 'accepted'
  }

  /**
   * A linked session's report (`teammate-handoff-return` D10): made well-formed (protocol §12 receiving rule 2: the
   * server refuses a lone surrogate, which normalization keeps), checked again in that order, and queued as `done`.
   * The completion lifecycle is not set (no parent to show it to); the user is notified, focused on the session.
   */
  #acceptTeammate(sessionId: string, handoffId: string, summary: string, identity: string): ReportDecision {
    if (this.#adopted.get(sessionId) === identity) return 'duplicate'
    const text = toWellFormed(summary)
    if (text.trim() === '' || text.length > MAX_TEAMMATE_REPORT_LENGTH) return 'not-handoff'
    const queued = this.#deps.teammateReport?.(sessionId, handoffId, text)
    if (!queued?.ok) return 'teammate-stopped'
    this.#adopted.set(sessionId, identity)
    this.#deps.onReported?.(sessionId, queued.title, text, { sheet: false })
    return 'accepted'
  }

  /**
   * 開始追蹤一個 session 的等待狀態（pty 存在期間）。**只追蹤帶來源的 session**；重複呼叫為 no-op。
   *
   * 每一次輪詢都餵給狀態機 —— 落定依「採納之後某次輪詢的值」判定，而那個「之後」由這裡保證：
   * 採納之前的輪詢看不到 `completion`，狀態機對 `undefined` 什麼都不做。
   */
  track(sessionId: string): void {
    if (this.#subscriptions.has(sessionId)) return
    const session = this.#deps.sessions.view().find((entry) => entry.session.id === sessionId)?.session
    if (!session?.lineage) return
    let lastWait: WaitValue | undefined
    const unsubscribe = this.#deps.subscribe(sessionId, (snapshot) => {
      const current = this.#completionOf(sessionId)
      const next = onWaitTick(current, snapshot.state, this.#now())
      const waitChanged = snapshot.state !== lastWait
      lastWait = snapshot.state
      if (next !== current && next) this.#deps.sessions.setCompletion(sessionId, next)
      // **只在呈現可能改變時通知** —— 每 400ms 一次的輪詢不該每次都重寫一輪關係檔。
      if (next !== current || waitChanged) this.#deps.onChange?.(sessionId)
    })
    this.#subscriptions.set(sessionId, unsubscribe)
  }

  /** pty 結束。訂閱隨之退掉（`clearWait` 也會清掉計時器，這裡只是不留一個懸空的回呼）。 */
  untrack(sessionId: string): void {
    this.#subscriptions.get(sessionId)?.()
    this.#subscriptions.delete(sessionId)
  }

  #completionOf(sessionId: string): CompletionState | undefined {
    return this.#deps.sessions.view().find((entry) => entry.session.id === sessionId)?.session.completion
  }
}

/** 投遞檔的身分：路徑、修改時間（拿得到時）與內容摘要。 */
export function reportIdentity(file: string, mtimeMs: number | undefined, contents: string): string {
  const digest = createHash('sha256').update(contents, 'utf8').digest('hex').slice(0, 16)
  return `${file}\u0000${mtimeMs ?? '-'}\u0000${digest}`
}
