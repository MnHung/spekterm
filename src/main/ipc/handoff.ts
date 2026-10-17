import { BrowserWindow, ipcMain } from 'electron'

import { readBriefFor } from '../handoff-brief'
import { lifecycleViewOf, type LifecycleView } from '../handoff-lifecycle-view'
import type { SessionStore } from '../session-store'

export type { HandoffBriefView } from '../handoff-brief'
export type { LifecycleView } from '../handoff-lifecycle-view'

export const HANDOFF_CHANNELS = {
  brief: 'workspace:handoff:brief',
  lifecycle: 'workspace:handoff:lifecycle',
  lifecycleChanged: 'workspace:handoff:lifecycleChanged',
  reveal: 'workspace:handoff:reveal',
  keepCloseOffer: 'workspace:handoff:keepCloseOffer',
} as const

let store: SessionStore | null = null

/**
 * 某個 session 的生命週期可能改變了 —— 推給每一個視窗（`handoff-completion`）。
 *
 * **推的是整份投影，不是差異** —— 畫面上「→ N」要看全部子 session 都完成了沒，拿一份差異去拼
 * 會在某一則遺失時永遠拼錯。份量是交接 session 的數量，很小。
 */
export function broadcastLifecycle(): void {
  if (!store) return
  const views = lifecycleViewOf(store)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(HANDOFF_CHANNELS.lifecycleChanged, views)
  }
}

/**
 * 觸發了一則完成通知 —— 請 renderer 把使用者帶去那個子 session 並打開它的交接單（`handoff-completion`）。
 * 送的只有 session 識別碼；「它還在不在」由 renderer 判定（session 清單的權威在那裡）。
 */
export function revealHandoffBrief(sessionId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(HANDOFF_CHANNELS.reveal, sessionId)
  }
}

export function registerHandoffHandlers(sessions: SessionStore): void {
  store = sessions
  ipcMain.handle(HANDOFF_CHANNELS.brief, (_event, sessionId: unknown) => readBriefFor(sessions, sessionId))
  ipcMain.handle(HANDOFF_CHANNELS.lifecycle, (): LifecycleView[] => lifecycleViewOf(sessions))
}

/**
 * The desktop's Keep on an agent's offer to close its own session reaches the main process, which owns the offer
 * (`remote-close-offer` D4). Registered once `SessionControl` exists. The window is not told back: it already cleared
 * its own card.
 */
export function registerKeepCloseOffer(withdraw: (sessionId: string) => void): void {
  ipcMain.on(HANDOFF_CHANNELS.keepCloseOffer, (_event, sessionId: unknown) => {
    if (typeof sessionId === 'string' && sessionId !== '') withdraw(sessionId)
  })
}
