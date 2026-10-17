import { BrowserWindow, ipcMain } from 'electron'

import { inTurnOf, openRequestsOf, waitStateOf, type WaitSnapshot } from '../agent-wait'
import { createLookedAt, type LookedAt } from '../looked-at'
import { lastKeystrokeAt } from '../pty-input'
import type { SessionStore } from '../session-store'
import { AttentionBroadcaster, attentionProjection, type AttentionView } from '../wait-attention'
import { seenMarks, setLookingSource } from '../wait-seen'
import { conversationWatched, displayedSessionOf, onDisplayedReport, onPtyChange, onRemoteWatch, runningAgents } from './terminal'

export type { AttentionView } from '../wait-attention'

export const WAIT_CHANNELS = {
  list: 'workspace:wait:list',
  changed: 'workspace:wait:changed',
} as const

let broadcaster: AttentionBroadcaster | null = null
let looking: LookedAt | null = null

const projection = (): AttentionView[] =>
  attentionProjection({
    running: runningAgents,
    wait: waitStateOf,
    inTurn: (sessionId) => inTurnOf(sessionId),
    seen: (sessionId) => seenMarks.seenOf(sessionId),
    requestTimes: (sessionId) => openRequestsOf(sessionId).map((request) => request.at),
    lastKeystroke: lastKeystrokeAt,
  })

/** Recomputes and sends the projection if it changed. */
export function refreshAttention(): void {
  broadcaster?.update(projection())
}

/** One drained batch of one session (the `observeWaits` observer): the mark first, then the projection. */
export function noteWaitBatch(sessionId: string, snapshot: WaitSnapshot): void {
  seenMarks.onBatch(sessionId, snapshot)
  refreshAttention()
}

/** A window gained focus: its displayed session is looked at. */
export function windowFocused(contentsId: number): void {
  looking?.windowFocused(contentsId)
}

/** The desktop user sees this session (`remote-attention.ts`'s `suppressed`). */
export function displayedInFocus(sessionId: string): boolean {
  return looking?.displayedInFocus(sessionId) ?? false
}

export interface WaitDeps {
  sessions: SessionStore
  lineageChanged: () => void
  remoteChanged: () => void
}

export function registerWaitHandlers(deps: WaitDeps): void {
  looking = createLookedAt(
    {
      focusedContentsId: () => {
        const focused = BrowserWindow.getFocusedWindow()
        return focused && !focused.isDestroyed() ? focused.webContents.id : null
      },
      displayedSessionOf,
      conversationWatched,
    },
    (sessionId) => {
      if (seenMarks.lookedAt(sessionId)) refreshAttention()
    },
  )
  setLookingSource((sessionId) => looking?.isLookedAt(sessionId) ?? false)
  broadcaster = new AttentionBroadcaster({
    send: (views) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send(WAIT_CHANNELS.changed, views)
      }
    },
    hasLineage: (sessionId) => deps.sessions.view().some(({ session }) => session.id === sessionId && session.lineage !== undefined),
    lineageChanged: deps.lineageChanged,
    remoteChanged: deps.remoteChanged,
  })
  onDisplayedReport((contentsId, sessionId) => looking?.displayedReported(contentsId, sessionId))
  onRemoteWatch((watchKey, sessionId) => looking?.remoteWatched(watchKey, sessionId))
  onPtyChange(() => {
    // A process that ended has no turn to have seen; a wake starts from nothing (`wait-seen.ts`).
    seenMarks.retain(new Set(runningAgents()))
    refreshAttention()
  })
  ipcMain.handle(WAIT_CHANNELS.list, (): AttentionView[] => projection())
}
