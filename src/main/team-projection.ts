import type { TeamSnapshot } from './team-service'

/**
 * What the renderer gets of the team (`team-membership`, design D8): **built field by field**, never a spread of the
 * service's state, so a field added there (the device id, anything secret-bearing) does not reach the renderer by
 * itself. No device id, no secret.
 */
export interface TeamView {
  enabled: boolean
  status: TeamSnapshot['status']
  reason?: string
  nextAt?: number
  olderSide?: 'spekterm' | 'server'
  loadIssue?: 'damaged' | 'unreadable'
  deviceName?: string
  /** The computer's host name, to prefill a new device's name. */
  suggestedDeviceName?: string
  membership: {
    server: string
    pinned: boolean
    team: string
    member: { handle: string; displayName: string }
    device: string
    operations: string[]
    members: { handle: string; displayName: string; you: boolean }[]
    membersFetchedAt?: number
  } | null
}

export function projectTeam(snapshot: TeamSnapshot): TeamView {
  const m = snapshot.membership
  return {
    enabled: snapshot.enabled,
    status: snapshot.status,
    ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}),
    ...(snapshot.nextAt !== undefined ? { nextAt: snapshot.nextAt } : {}),
    ...(snapshot.olderSide !== undefined ? { olderSide: snapshot.olderSide } : {}),
    ...(snapshot.loadIssue !== undefined ? { loadIssue: snapshot.loadIssue } : {}),
    ...(snapshot.deviceName !== undefined ? { deviceName: snapshot.deviceName } : {}),
    membership: m
      ? {
          server: m.server.address,
          pinned: m.server.fingerprint !== undefined,
          team: m.team.name,
          member: { handle: m.member.handle, displayName: m.member.displayName },
          device: m.device.name,
          operations: [...m.operations],
          members: (m.members?.list ?? []).map((x) => ({ handle: x.handle, displayName: x.displayName, you: x.id === m.member.id })),
          ...(m.members ? { membersFetchedAt: m.members.fetchedAt } : {}),
        }
      : null,
  }
}
