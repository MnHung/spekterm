import fs from 'node:fs'
import path from 'node:path'

/**
 * The team membership file, `<userData>/team.json` (`team-membership`, design D4).
 *
 * **The device secret is not here** — it is `team.deviceSecret` in the secret store. This file is projected to the
 * renderer (field by field, in `ipc/team.ts`); the secret beside it would make that projection the exit
 * `secret-scope` guards first.
 *
 * - **Written whole, the file first, then memory**: a write that throws leaves memory as it was
 *   (`settings-sections`' rule; the remote store's violation, issue #88, is not copied).
 * - **Only the join writes `server`** (`setMembership`): it is where the credential is sent, and its only caller is
 *   the join path in `team-service.ts`, whose only caller is the IPC join handler (`scripts/secret-scope.test.mjs`).
 *   Every other update goes through `updateMembership`, whose patch type cannot name `server`.
 * - A damaged file is set aside and reads as no membership (`loadIssue` says so); the caller then discards the
 *   secret, which has no address it could be sent to.
 */

export const TEAM_FILE_VERSION = 1

export interface TeamMember {
  id: string
  handle: string
  displayName: string
  /** The member's devices that are not revoked; from `team.members` (spekterm-server 0.2.1). */
  deviceCount?: number
}

export interface Membership {
  server: { address: string; fingerprint?: string }
  team: { name: string }
  member: { id: string; handle: string; displayName: string; deviceCount: number }
  device: { id: string; name: string }
  operations: string[]
  members?: { list: TeamMember[]; fetchedAt: number }
  /** A `device.leave` was sent and not yet seen through (design D6). */
  leaving?: true
}

/** A stop that outlives a restart: its reason, the spekterm version that stopped, whether the user was notified. */
export interface TeamStop {
  reason: string
  appVersion: string
  notified: boolean
  /** The device's name, kept when the membership is discarded, so the section can still name it for the admin. */
  deviceName?: string
}

export interface TeamState {
  enabled: boolean
  membership: Membership | null
  stop?: TeamStop
}

export type MembershipPatch = Partial<Pick<Membership, 'device' | 'operations' | 'members' | 'member' | 'team'>> & {
  leaving?: boolean
}

const EMPTY: TeamState = { enabled: false, membership: null }

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseMember(raw: unknown): TeamMember | null {
  const m = record(raw)
  if (!m || !isString(m.id) || !isString(m.handle) || !isString(m.displayName)) return null
  return { id: m.id, handle: m.handle, displayName: m.displayName, ...(isCount(m.deviceCount) ? { deviceCount: m.deviceCount } : {}) }
}

function parseMembership(raw: unknown): Membership | null | 'invalid' {
  if (raw === null || raw === undefined) return null
  const m = record(raw)
  if (!m) return 'invalid'
  const server = record(m.server)
  const team = record(m.team)
  const member = record(m.member)
  const device = record(m.device)
  if (!server || !isString(server.address) || !server.address.startsWith('wss://')) return 'invalid'
  if (server.fingerprint !== undefined && !(isString(server.fingerprint) && /^[0-9A-F]{64}$/.test(server.fingerprint))) {
    return 'invalid'
  }
  if (!team || !isString(team.name)) return 'invalid'
  if (!member || !isString(member.id) || !isString(member.handle) || !isString(member.displayName) || !isCount(member.deviceCount)) {
    return 'invalid'
  }
  if (!device || !isString(device.id) || !isString(device.name)) return 'invalid'
  if (!Array.isArray(m.operations) || !m.operations.every(isString)) return 'invalid'
  let members: Membership['members']
  const ms = record(m.members)
  if (ms && Array.isArray(ms.list) && typeof ms.fetchedAt === 'number') {
    members = { list: ms.list.map(parseMember).filter((x): x is TeamMember => x !== null), fetchedAt: ms.fetchedAt }
  }
  return {
    server: { address: server.address, ...(isString(server.fingerprint) ? { fingerprint: server.fingerprint } : {}) },
    team: { name: team.name },
    member: { id: member.id, handle: member.handle, displayName: member.displayName, deviceCount: member.deviceCount },
    device: { id: device.id, name: device.name },
    operations: [...m.operations],
    ...(members ? { members } : {}),
    ...(m.leaving === true ? { leaving: true as const } : {}),
  }
}

/** `null`: not a team file this version can trust. */
export function parseTeamFile(raw: string): TeamState | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const d = record(data)
  if (!d || d.version !== TEAM_FILE_VERSION) return null
  const membership = parseMembership(d.membership)
  if (membership === 'invalid') return null
  const s = record(d.stop)
  const stop =
    s && isString(s.reason) && isString(s.appVersion) && typeof s.notified === 'boolean'
      ? { reason: s.reason, appVersion: s.appVersion, notified: s.notified, ...(isString(s.deviceName) ? { deviceName: s.deviceName } : {}) }
      : undefined
  return { enabled: d.enabled === true, membership, ...(stop ? { stop } : {}) }
}

export function writeTeamFileAtomic(filePath: string, state: TeamState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: TEAM_FILE_VERSION, ...state }, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, filePath)
}

export type TeamLoadIssue = 'damaged' | 'unreadable'

export class TeamStore {
  #state: TeamState = { ...EMPTY }
  #loadIssue: TeamLoadIssue | null = null

  constructor(private readonly filePath: string) {}

  load(): void {
    this.#loadIssue = null
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[team] membership file unreadable, starting with none: ${String(error)}`)
        this.#loadIssue = 'unreadable'
      }
      this.#state = { ...EMPTY }
      return
    }
    const parsed = parseTeamFile(raw)
    if (!parsed) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${stamp}`)
      } catch {
        // Kept in place; the next write replaces it.
      }
      console.error('[team] membership file unparsable, starting with none; the original was set aside')
      this.#loadIssue = 'damaged'
      this.#state = { ...EMPTY }
      return
    }
    this.#state = parsed
  }

  /** Why the last load found no membership although a file was there; `null` otherwise. */
  loadIssue(): TeamLoadIssue | null {
    return this.#loadIssue
  }

  get(): TeamState {
    return structuredClone(this.#state)
  }

  setEnabled(enabled: boolean): void {
    this.#commit({ ...this.#state, enabled })
  }

  /** **The join's write** — the only one that sets `server`. Clears any stop. */
  setMembership(membership: Membership): void {
    const { stop: _stop, ...rest } = this.#state
    this.#commit({ ...rest, membership: structuredClone(membership) })
  }

  /** Updates a held membership; cannot change `server`. No membership: nothing happens. */
  updateMembership(patch: MembershipPatch): void {
    const current = this.#state.membership
    if (!current) return
    // Field by field, not a spread: a cast that sneaks `server` into the patch must not reach the file.
    const { leaving } = patch
    const next: Membership = structuredClone(current)
    if (patch.device) next.device = structuredClone(patch.device)
    if (patch.operations) next.operations = [...patch.operations]
    if (patch.members) next.members = structuredClone(patch.members)
    if (patch.member) next.member = structuredClone(patch.member)
    if (patch.team) next.team = structuredClone(patch.team)
    if (leaving === true) next.leaving = true
    if (leaving === false) delete next.leaving
    this.#commit({ ...this.#state, membership: next })
  }

  /** Removes the membership, recording why (design D4: this file is written before the secret is removed). */
  clearMembership(stop?: TeamStop): void {
    const { stop: _old, ...rest } = this.#state
    this.#commit({ ...rest, membership: null, ...(stop ? { stop } : {}) })
  }

  setStop(stop: TeamStop | undefined): void {
    const { stop: _old, ...rest } = this.#state
    this.#commit({ ...rest, ...(stop ? { stop } : {}) })
  }

  #commit(next: TeamState): void {
    writeTeamFileAtomic(this.filePath, next)
    this.#state = next
  }
}
