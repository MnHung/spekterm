import { BrowserWindow, type WebContents, ipcMain, webContents as allWebContents } from 'electron'
import type { RendererOutcome } from '../remote-host'
import { RendererRequests } from '../remote-requests'
import type { HostAction } from '../remote-protocol'
import type { RemoteService } from '../remote-service'

/**
 * The remote access IPC (`remote-access`, `remote-protocol`, design D4 / D10 of `mobile-remote-bridge`).
 *
 * Two directions:
 *
 * - **the dialog and Settings** ask for the state and change it. The state is `RemoteService.state()`, a
 *   field whitelist: no credential, no hash, no key. The pairing code is the one secret it carries, because
 *   the dialog must show it.
 * - **remote session actions** (create, wake, accept) are requests *to* the renderer, which owns the session
 *   list. The main process sends `request (requestId, action)` and waits up to 15 s for `reply (requestId,
 *   outcome)`. A renderer that reloads or closes answers everything pending with `NO_WINDOW`.
 */

export const REMOTE_CHANNELS = {
  state: 'workspace:remote:state',
  setEnabled: 'workspace:remote:setEnabled',
  setPort: 'workspace:remote:setPort',
  setAdditionalAddress: 'workspace:remote:setAdditionalAddress',
  startPairing: 'workspace:remote:startPairing',
  cancelPairing: 'workspace:remote:cancelPairing',
  revoke: 'workspace:remote:revoke',
  reset: 'workspace:remote:reset',
  dismissNotice: 'workspace:remote:dismissNotice',
  /** main → renderer: the state changed (carries the new state). */
  changed: 'workspace:remote:changed',
  /** main → renderer: carry out a session action for a device. */
  request: 'workspace:remote:request',
  /** renderer → main: the outcome of a request. */
  reply: 'workspace:remote:reply',
} as const

const requests = new RendererRequests()
const watchedRenderers = new Set<number>()

function watchRenderer(contents: WebContents): void {
  if (watchedRenderers.has(contents.id)) return
  watchedRenderers.add(contents.id)
  const id = contents.id
  contents.on('did-navigate', () => requests.rendererGone(id))
  contents.once('destroyed', () => {
    watchedRenderers.delete(id)
    requests.rendererGone(id)
  })
}

/** Asks the window's renderer to carry out a session action for a device (`remote-requests.ts`). */
export function requestRenderer(contentsId: number, action: HostAction): Promise<RendererOutcome> {
  const contents = allWebContents.fromId(contentsId)
  if (!contents || contents.isDestroyed()) return Promise.resolve({ ok: false, code: 'NO_WINDOW' })
  watchRenderer(contents)
  return requests.request(contentsId, (requestId, sent) => contents.send(REMOTE_CHANNELS.request, requestId, sent), action)
}

/** Tells every window the new state. */
export function broadcastRemoteState(service: RemoteService): void {
  const state = service.state()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(REMOTE_CHANNELS.changed, state)
  }
}

export function registerRemoteHandlers(service: RemoteService): void {
  ipcMain.handle(REMOTE_CHANNELS.state, () => service.state())
  ipcMain.handle(REMOTE_CHANNELS.setEnabled, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return service.state()
    await service.setEnabled(enabled)
    return service.state()
  })
  ipcMain.handle(REMOTE_CHANNELS.setPort, async (_event, port: unknown) => ({
    ok: await service.setPort(port),
    state: service.state(),
  }))
  ipcMain.handle(REMOTE_CHANNELS.setAdditionalAddress, (_event, address: unknown) => ({
    ok: service.setAdditionalAddress(address),
    state: service.state(),
  }))
  ipcMain.handle(REMOTE_CHANNELS.startPairing, () => service.startPairing())
  ipcMain.on(REMOTE_CHANNELS.cancelPairing, () => service.cancelPairing())
  ipcMain.handle(REMOTE_CHANNELS.revoke, (_event, deviceId: unknown) => {
    if (typeof deviceId === 'string') service.revoke(deviceId)
    return service.state()
  })
  ipcMain.handle(REMOTE_CHANNELS.reset, async () => {
    await service.reset()
    return service.state()
  })
  ipcMain.on(REMOTE_CHANNELS.dismissNotice, () => service.dismissResetNotice())
  // Only the renderer that was asked may answer (checked in `RendererRequests.reply`).
  ipcMain.on(REMOTE_CHANNELS.reply, (event, requestId: unknown, outcome: unknown) => requests.reply(event.sender.id, requestId, outcome))
}
