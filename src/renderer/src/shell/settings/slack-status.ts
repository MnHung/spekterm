import { formatTime } from '@shared/i18n/locale'
import type { SlackState } from '../types'

/**
 * 狀態那一行要用哪個字典 key。
 *
 * **回傳 key 而不是已翻譯的字串**，兩個理由：`t` 的型別不必在這裡重述（那會迫使我們寫一個比
 * i18next 寬鬆的簽名，而寬鬆的簽名會讓打錯的 key 通過編譯）；而且 key 是**字面值的聯集**，
 * 於是字典的型別安全仍然管得到它 —— 樣板字串組出來的 key 逃得過那道檢查。
 *
 * 順序是刻意的：**失效優先於一切**。設定好了而連不上時，「Working」是一句謊話。
 * 四種情形各一句而不是一個布林 —— 「失效」與「目前沒有待處理項目」在外部本來是同一個樣子。
 */
export function statusCopy(state: SlackState): {
  key:
    | 'slack.statusUnconfigured'
    | 'slack.statusFailureAuth'
    | 'slack.statusFailureScope'
    | 'slack.statusFailureScopeUnknown'
    | 'slack.statusFailureTransient'
    | 'slack.statusRateLimited'
    | 'slack.statusRateLimitedSoon'
    | 'slack.statusNeverRan'
    | 'slack.statusIdle'
  options?: { error: string } | { needed: string } | { time: string }
} {
  if (!state.configured.userToken) return { key: 'slack.statusUnconfigured' }
  const failure = state.status.failure
  if (failure !== undefined) {
    // **權限不足與憑證失效的處置完全不同** —— 前者要加 scope 並重新安裝，後者要換一份 token。
    // 報錯的那一句必須說對，否則使用者會白做一輪（實測踩過：`missing_scope` 被報成憑證失效）。
    if (failure.kind === 'scope') {
      return failure.needed === undefined || failure.needed === ''
        ? { key: 'slack.statusFailureScopeUnknown', options: { error: failure.error } }
        : { key: 'slack.statusFailureScope', options: { needed: failure.needed } }
    }
    // **「對端要我們慢一點」的處置是什麼都不必做。** 報成憑證或權限的問題，會讓使用者去修
    // 一個根本不存在的問題 —— 那正是 `missing_scope` 曾被歸進 `auth` 時發生的事。
    if (failure.kind === 'rate_limited') {
      const retryAt = state.status.retryAt
      return retryAt === undefined
        ? { key: 'slack.statusRateLimitedSoon' }
        : {
            key: 'slack.statusRateLimited',
            options: { time: formatTime(new Date(retryAt)) },
          }
    }
    return failure.kind === 'auth'
      ? { key: 'slack.statusFailureAuth', options: { error: failure.error } }
      : { key: 'slack.statusFailureTransient', options: { error: failure.error } }
  }
  if (state.status.lastRoundAt === undefined) return { key: 'slack.statusNeverRan' }
  return { key: 'slack.statusIdle' }
}

/** 即時路徑的三種狀態各一句。**`off` 與 `degraded` 分得出來** —— 前者沒開，後者壞了。 */
export const REALTIME_COPY = {
  connected: 'slack.realtimeConnected',
  degraded: 'slack.realtimeDegraded',
  off: 'slack.realtimeOff',
} as const


/**
 * Whether the inbox must say that Slack is not working (`slack-intake-source`, "The inbox says when Slack is not
 * working"): set up, and failing or held back. Never set up is not a failure, and says nothing.
 */
export function slackNeedsAttention(state: SlackState): boolean {
  return state.configured.userToken && state.status.failure !== undefined
}
