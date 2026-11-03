import { hostname } from 'node:os'

import { BrowserWindow, ipcMain, type WebContents } from 'electron'

import { projectTeam, type TeamView } from '../team-projection'
import type { InspectResult, JoinResult, TeamService } from '../team-service'

export const TEAM_CHANNELS = {
  get: 'workspace:team:get',
  setEnabled: 'workspace:team:setEnabled',
  inspect: 'workspace:team:inspect',
  join: 'workspace:team:join',
  rename: 'workspace:team:rename',
  leavePreview: 'workspace:team:leavePreview',
  leave: 'workspace:team:leave',
  removeLocally: 'workspace:team:removeLocally',
  reconnect: 'workspace:team:reconnect',
  changed: 'workspace:team:changed',
  showTeam: 'workspace:team:showTeam',
} as const

/** What the renderer gets of an inspect: no code, no fingerprint (the renderer keeps the link it pasted). */
export type InspectView =
  | { ok: true; kind: 'member' | 'device'; team: string; expiresAt: number; member?: { handle: string; displayName: string } }
  | { ok: false; error: string }

function inspectView(result: InspectResult): InspectView {
  if (!result.ok) return { ok: false, error: result.error }
  return {
    ok: true,
    kind: result.kind,
    team: result.team,
    expiresAt: result.expiresAt,
    ...(result.member ? { member: result.member } : {}),
  }
}

/**
 * The Team section's IPC (`team-membership`). **The join handler is the only caller of `TeamService.joinTeam`**, which is
 * the only caller of `TeamStore.setMembership` — the write of the server address, where the credential is sent
 * (`scripts/secret-scope.test.mjs`). It is bound to the user's click in Settings.
 */
export function registerTeamHandlers(service: TeamService): void {
  const senders = new Set<WebContents>()
  service.onChange((snapshot) => {
    const view = projectTeam(snapshot)
    for (const sender of senders) {
      if (sender.isDestroyed()) senders.delete(sender)
      else sender.send(TEAM_CHANNELS.changed, view)
    }
  })

  ipcMain.handle(TEAM_CHANNELS.get, (event): TeamView => {
    senders.add(event.sender)
    // Showing the section while connected refreshes the members (`team-membership`).
    void service.refreshMembers()
    return { ...projectTeam(service.snapshot()), suggestedDeviceName: hostname() }
  })
  ipcMain.handle(TEAM_CHANNELS.setEnabled, (_event, enabled: unknown): TeamView => {
    if (typeof enabled === 'boolean') service.setEnabled(enabled)
    return projectTeam(service.snapshot())
  })
  ipcMain.handle(TEAM_CHANNELS.inspect, async (_event, link: unknown): Promise<InspectView> =>
    typeof link === 'string' ? inspectView(await service.inspect(link)) : { ok: false, error: 'INVALID_LINK' },
  )
  ipcMain.handle(TEAM_CHANNELS.join, (_event, input: unknown): Promise<JoinResult> => {
    const i = (input ?? {}) as Record<string, unknown>
    if (typeof i.link !== 'string' || typeof i.deviceName !== 'string') return Promise.resolve({ ok: false, error: 'BAD_PARAMS' })
    return service.joinTeam({
      link: i.link,
      deviceName: i.deviceName,
      ...(typeof i.handle === 'string' ? { handle: i.handle } : {}),
      ...(typeof i.displayName === 'string' ? { displayName: i.displayName } : {}),
    })
  })
  ipcMain.handle(TEAM_CHANNELS.rename, (_event, name: unknown) =>
    typeof name === 'string' ? service.rename(name) : { ok: false, error: 'BAD_PARAMS' },
  )
  ipcMain.handle(TEAM_CHANNELS.leavePreview, () => service.leavePreview())
  ipcMain.handle(TEAM_CHANNELS.leave, () => service.leave())
  ipcMain.handle(TEAM_CHANNELS.removeLocally, (): TeamView => {
    service.removeLocally()
    return projectTeam(service.snapshot())
  })
  ipcMain.handle(TEAM_CHANNELS.reconnect, (): TeamView => {
    service.reconnect()
    return projectTeam(service.snapshot())
  })
}

/** A team notification was activated: open Settings on Team (closing the inbox first, `terminal-preferences`). */
export function sendShowTeam(window: BrowserWindow): void {
  if (!window.webContents.isDestroyed()) window.webContents.send(TEAM_CHANNELS.showTeam)
}
