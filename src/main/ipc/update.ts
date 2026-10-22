import { BrowserWindow, ipcMain } from 'electron'

import type { UpdateView } from '../update-coordinator'

/**
 * The update check's IPC (`app-update`; design U8 of `auto-update`).
 *
 * **The renderer sends no URL, version or path.** `openRelease` opens the link the main process built from a
 * version (`releasePageUrl`); `restart` acts on the update the main process holds, and refuses unless it is ready.
 */
export const UPDATE_CHANNELS = {
  get: 'workspace:update:get',
  check: 'workspace:update:check',
  restart: 'workspace:update:restart',
  openRelease: 'workspace:update:openRelease',
  changed: 'workspace:update:changed',
  showAbout: 'workspace:update:showAbout',
} as const

export interface UpdateIpcDeps {
  /** `null` when this build does not check (development mode without a probe's feed). */
  view(): UpdateView | null
  check(): Promise<void>
  /** Starts "Restart to update"; `false` when nothing is ready or a close question is already open. */
  restart(): boolean
  openRelease(): void
}

export function registerUpdateHandlers(deps: UpdateIpcDeps): void {
  ipcMain.handle(UPDATE_CHANNELS.get, (): UpdateView | null => deps.view())
  ipcMain.handle(UPDATE_CHANNELS.check, async (): Promise<UpdateView | null> => {
    await deps.check()
    return deps.view()
  })
  ipcMain.handle(UPDATE_CHANNELS.restart, (): boolean => deps.restart())
  ipcMain.handle(UPDATE_CHANNELS.openRelease, (): void => deps.openRelease())
}

export function broadcastUpdate(view: UpdateView | null): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(UPDATE_CHANNELS.changed, view)
  }
}

/** The notification was activated: open Settings at About (closing the inbox first, `terminal-preferences`). */
export function sendShowAbout(window: BrowserWindow): void {
  if (!window.webContents.isDestroyed()) window.webContents.send(UPDATE_CHANNELS.showAbout)
}
