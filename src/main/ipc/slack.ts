import { type WebContents, ipcMain } from 'electron'
import type { SecretStore } from '../secret-store'
import {
  type SlackState,
  type SlackTokenKind,
  type SlackWriteResult,
  isTokenKind,
  secretName,
  slackState,
  slackWrite,
} from '../slack-state'
import { DEFAULT_API_BASE_URL, DEFAULT_LOOKBACK_DAYS, type SlackSettingsStore } from '../slack-settings-store'
import type { SlackStatus } from '../slack-service'

export const SLACK_CHANNELS = {
  get: 'workspace:slack:get',
  setToken: 'workspace:slack:setToken',
  setLookbackDays: 'workspace:slack:setLookbackDays',
  setApiBaseUrl: 'workspace:slack:setApiBaseUrl',
  changed: 'workspace:slack:changed',
} as const

/**
 * Slack 連線設定的讀寫。
 *
 * **純邏輯不住在這裡** —— `slackState()` 與白名單判定在 `../slack-state.ts`。理由與
 * `report-runner` 的 `delegateEnv` 相同：本模組 import `electron`，於是 `node:test`
 * 載入不起來，而那會讓「IPC 回傳值整份不含憑證」這條斷言無處可放。
 *
 * ## 沒有「要偵測誰」與「哪個工作區」的 setter，而那是刻意的
 *
 * 兩者**自憑證推導**（`auth.test` 回傳它擁有者的身分），不是使用者設定 —— 見 design D14。
 * 一個填錯的「要偵測誰」，其症狀是**什麼都不會發生**，與「沒有人提及我」和「連線已失效」
 * 在畫面上完全相同；而讓後兩者可區分正是本能力花了一整條 requirement 在做的事。
 *
 * ## 端點有自己的 channel，不併進一個吃整份設定的 setter
 *
 * `secret-scope` 要求端點**只能由使用者明確操作改動**。一個吃整份物件的 `update()`
 * 會讓任何一次「改回看範圍」的呼叫**順帶**有能力改掉端點 —— 那條要求就從結構退回紀律。
 */
export function registerSlackHandlers(input: {
  settings: SlackSettingsStore
  secrets: SecretStore
  status: () => SlackStatus
  /** 註冊「狀態改變了」的通知器 —— 回補是非同步的，取一次是不夠的（見下）。 */
  onStatusChanged?: (notify: () => void) => void
  /**
   * 請求跑一輪回補。
   *
   * **使用者剛存下憑證的那一刻，正是該去試一次的時候。** 少了它，他貼完 token 之後畫面上
   * 什麼都不會變，而下一輪要等到週期到期或重開 app —— 那個「什麼都沒發生」與「功能壞了」
   * 在畫面上完全相同（實測踩過：在 app 起來之後才貼憑證，那一輪早就跑完了）。
   */
  requestRound?: () => void
}): void {
  const state = (): SlackState => slackState(input)

  /**
   * 狀態改變時推給 renderer。
   *
   * **少了它，整個狀態呈現是一個只在掛載時取一次的快照。** 回補在啟動數秒後才跑完，於是
   * 使用者打開分頁看到的永遠是「還沒檢查過」，而憑證失效**永遠不會出現在畫面上** ——
   * 那正是 D10 那條 requirement 要防的事，而它會以一個看起來正常的介面失敗。
   * （這是 `probe:slack` 抓到的：狀態停在「Set up, but it has not checked yet」。）
   */
  const senders = new Set<WebContents>()
  const broadcast = (): void => {
    for (const sender of senders) {
      if (sender.isDestroyed()) senders.delete(sender)
      else sender.send(SLACK_CHANNELS.changed)
    }
  }
  input.onStatusChanged?.(broadcast)

  ipcMain.handle(SLACK_CHANNELS.get, (event): SlackState => {
    senders.add(event.sender)
    return state()
  })

  // 值的驗證在這裡（種類白名單）與 store（值的清理）。`null` ＝清除該份憑證。
  // Each write answers with a result object: a failure the renderer must show has to survive IPC (`slackWrite`).
  ipcMain.handle(SLACK_CHANNELS.setToken, (_event, kind: unknown, value: unknown): SlackWriteResult => {
    if (!isTokenKind(kind)) return { ok: true, state: state() }
    const result = slackWrite(() => {
      if (value === null) input.secrets.clear(secretName(kind))
      else if (typeof value === 'string') input.secrets.set(secretName(kind), value.trim())
    }, state)
    // **存下憑證即試一次。** 不 await —— 回傳值只回報「已設定」那個事實，結果經
    // `changed` 事件推送。
    if (result.ok && value !== null) input.requestRound?.()
    return result
  })

  ipcMain.handle(
    SLACK_CHANNELS.setLookbackDays,
    (_event, days: unknown): SlackWriteResult =>
      slackWrite(() => {
        input.settings.setLookbackDays(typeof days === 'number' ? days : null)
      }, state),
  )

  ipcMain.handle(
    SLACK_CHANNELS.setApiBaseUrl,
    (_event, url: unknown): SlackWriteResult =>
      slackWrite(() => {
        input.settings.setApiBaseUrl(typeof url === 'string' ? url : null)
      }, state),
  )
}

export { DEFAULT_API_BASE_URL, DEFAULT_LOOKBACK_DAYS }
export type { SlackState, SlackTokenKind }
export { SLACK_TOKEN_KINDS } from '../slack-state'
