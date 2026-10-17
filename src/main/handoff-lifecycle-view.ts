import { lifecycleOf, type LifecycleState } from '../shared/lineage/lifecycle'
import { waitStateOf } from './agent-wait'
import type { SessionStore } from './session-store'
import { seenMarks } from './wait-seen'

/** 一個交接 session 在畫面上的生命週期（`handoff-completion`）。 */
export interface LifecycleView {
  sessionId: string
  state: LifecycleState
  /** 最新一份完成報告的摘要與時刻（有的話）。**已正規化**，renderer 以純文字呈現。 */
  summary?: string
  reportedAt?: number
}

/**
 * 所有帶來源的 session 的生命週期投影。**權威在主行程**：完成狀態來自落盤、等待狀態來自事件橋接，
 * renderer 只拿結果。
 */
export function lifecycleViewOf(sessions: SessionStore): LifecycleView[] {
  return sessions
    .view()
    .filter(({ session }) => session.lineage !== undefined)
    .map(({ session }) => {
      const report = session.completion ? sessions.readHandoffBrief(session.id)?.report : undefined
      return {
        sessionId: session.id,
        state: lifecycleOf(session.completion, waitStateOf(session.id), seenMarks.seenOf(session.id)),
        ...(report ? { summary: report.summary, reportedAt: report.reportedAt } : {}),
      }
    })
}
