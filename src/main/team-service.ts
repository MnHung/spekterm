import { normalizeAuthored } from './intake-schema'
import { Secret, type SecretStore } from './secret-store'
import { type Answer, type ConnectionEnd, type ConnectionOptions, PROTOCOL_VERSIONS, TeamConnection } from './team-connection'
import { parseInvite, type InviteRefusal, type TeamInvite } from './team-invite'
import { backoffDelay, olderSide, type Outcome, type RetryReason, type StopReason, outcomeOf, outcomeOfPreAuthError, preAuthErrorOf } from './team-outcome'
import type { Membership, TeamMember, TeamState, TeamStop, TeamStore } from './team-store'

/**
 * Being on a team (`team-membership`): the lifecycle of the one connection, the reconnect table, and the operations
 * of the Team section. No network code here — `team-connection.ts` holds it.
 *
 * ## Generations (design D3)
 *
 * Every connection gets a generation number, and only events of the current one act. Spekterm ends a connection it
 * gives up on with `terminate()` and moves to the next generation at once, so a late close of an abandoned
 * connection can never start a third and make the server close the current one with 4006.
 *
 * ## The secret's order (design D4)
 *
 * Join writes the secret, then the membership. Discarding writes the membership file first (the membership removed,
 * the stop and the device's name recorded), then removes the secret, then tells the extension points. A secret left
 * by an interruption has no address and is removed at the next start. A membership whose secret cannot be found is a
 * stop that **keeps** the membership (`CREDENTIAL_UNAVAILABLE`): a `hello` without a secret would be answered
 * `AUTH_FAILED` and read as a revocation.
 */

export const SECRET_NAME = 'team.deviceSecret'

/** The stops that outlive a restart and keep spekterm from connecting until the user acts. */
const STICKY: ReadonlySet<string> = new Set<StopReason>(['REPLACED', 'UNSUPPORTED_VERSION', 'FAULT', 'PIN_MISMATCH'])

export type TeamStatus = 'off' | 'unjoined' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'

export interface TeamSnapshot {
  enabled: boolean
  status: TeamStatus
  /** The stop's reason (status `stopped`), or the last retry's reason (status `reconnecting`). */
  reason?: StopReason | RetryReason | 'LEFT'
  /** When the next attempt is made (status `reconnecting`). */
  nextAt?: number
  /** `UNSUPPORTED_VERSION`: which side needs updating, when the server said. */
  olderSide?: 'spekterm' | 'server'
  /** Why no membership was found although a file existed. */
  loadIssue?: 'damaged' | 'unreadable'
  /** The device's name after its membership was discarded or when its credential cannot be found. */
  deviceName?: string
  membership: Membership | null
}

export type InspectResult =
  | { ok: true; invite: TeamInvite; kind: 'member' | 'device'; team: string; expiresAt: number; member?: { handle: string; displayName: string } }
  | { ok: false; error: InviteRefusal | 'INVALID_LINK' | JoinFailure }

export type JoinFailure =
  | 'INVITE_UNKNOWN'
  | 'INVITE_EXPIRED'
  | 'INVITE_USED'
  | 'HANDLE_TAKEN'
  | 'BAD_PARAMS'
  | 'UNSUPPORTED_VERSION'
  | 'INTERNAL'
  | 'NETWORK'
  | 'PIN_MISMATCH'
  | 'LOST_ANSWER'
  | 'NOT_STORED'

export type JoinResult = { ok: true } | { ok: false; error: JoinFailure; field?: string; deviceName?: string; olderSide?: 'spekterm' | 'server' }

export interface TeamServiceDeps {
  store: TeamStore
  secrets: SecretStore
  appVersion: string
  /** One desktop notification for a stop that needs the user (design D10). */
  notifyStop: (reason: StopReason, teamName: string) => void
  /** Tests: the connection factory, the clock's scale, and the jitter. */
  testing?: {
    open?: (options: ConnectionOptions) => Promise<TeamConnection>
    baseDelayMs?: number
    stableMs?: number
    membersIntervalMs?: number
    random?: () => number
  }
}

type Listener<T> = (value: T) => void

export class TeamService {
  readonly #deps: TeamServiceDeps
  #generation = 0
  #connection: TeamConnection | null = null
  #connectionGeneration = -1
  #status: TeamStatus = 'off'
  #reason: TeamSnapshot['reason']
  #nextAt: number | undefined
  #olderSide: TeamSnapshot['olderSide']
  #attempt = 0
  #retryTimer: NodeJS.Timeout | null = null
  #stableTimer: NodeJS.Timeout | null = null
  #membersTimer: NodeJS.Timeout | null = null
  #lastMembersRefresh = 0
  readonly #changes = new Set<Listener<TeamSnapshot>>()
  readonly #events = new Map<string, Set<Listener<unknown>>>()
  readonly #states = new Set<Listener<TeamStatus>>()
  readonly #members = new Set<Listener<TeamMember[]>>()
  readonly #discarded = new Set<Listener<{ server: string; memberId: string }>>()

  constructor(deps: TeamServiceDeps) {
    this.#deps = deps
  }

  // ---- Lifecycle ----

  start(): void {
    const { store, secrets } = this.#deps
    store.load()
    const state = store.get()
    const membership = state.membership
    // A secret with no membership has no address: it can never be sent, so it is removed.
    if (!membership && secrets.has(SECRET_NAME)) secrets.clear(SECRET_NAME)
    if (membership && !secrets.has(SECRET_NAME)) {
      if (membership.leaving) {
        this.#completeLeave()
        return
      }
      this.#enterStop('CREDENTIAL_UNAVAILABLE', { persist: false, notify: false })
      return
    }
    const stop = state.stop
    if (membership && stop && STICKY.has(stop.reason)) {
      // A version mismatch lasts until spekterm's version changes.
      if (!(stop.reason === 'UNSUPPORTED_VERSION' && stop.appVersion !== this.#deps.appVersion)) {
        this.#status = 'stopped'
        this.#reason = stop.reason as StopReason
        this.#emit()
        return
      }
      store.setStop(undefined)
    }
    this.#settle()
  }

  dispose(): void {
    this.#generation++
    this.#clearTimers()
    this.#connection?.terminate()
    this.#connection = null
  }

  /** From `powerMonitor`'s `resume`: a connection that existed before sleep is not evidence of a live socket. */
  resume(): void {
    if (this.#status !== 'connected' && this.#status !== 'reconnecting' && this.#status !== 'connecting') return
    this.#abandon()
    this.#attempt = 0
    void this.#connect()
  }

  setEnabled(enabled: boolean): void {
    this.#deps.store.setEnabled(enabled)
    if (!enabled) {
      this.#abandon()
      this.#status = 'off'
      this.#reason = undefined
      this.#emit()
      return
    }
    this.#settle()
  }

  /** The user's Reconnect: clears a stop, reads the secret store again, connects. */
  reconnect(): void {
    const { store, secrets } = this.#deps
    secrets.load()
    if (store.get().stop) store.setStop(undefined)
    this.#abandon()
    this.#attempt = 0
    this.#reason = undefined
    this.#settle()
  }

  /** Decides from the stored state whether to connect. */
  #settle(): void {
    const state = this.#deps.store.get()
    if (!state.enabled) {
      this.#status = 'off'
      this.#emit()
      return
    }
    if (!state.membership) {
      this.#status = 'unjoined'
      this.#emit()
      return
    }
    if (!this.#deps.secrets.has(SECRET_NAME)) {
      this.#enterStop('CREDENTIAL_UNAVAILABLE', { persist: false, notify: false })
      return
    }
    void this.#connect()
  }

  #abandon(): void {
    this.#generation++
    this.#clearTimers()
    const connection = this.#connection
    this.#connection = null
    connection?.terminate()
  }

  #clearTimers(): void {
    for (const timer of [this.#retryTimer, this.#stableTimer, this.#membersTimer]) if (timer) clearTimeout(timer)
    this.#retryTimer = this.#stableTimer = this.#membersTimer = null
    this.#nextAt = undefined
  }

  async #connect(): Promise<void> {
    const state = this.#deps.store.get()
    const membership = state.membership
    const secret = this.#deps.secrets.get(SECRET_NAME)
    if (!state.enabled || !membership || !secret) return
    const generation = ++this.#generation
    this.#status = 'connecting'
    this.#nextAt = undefined
    this.#emit()
    let connection: TeamConnection
    try {
      connection = await this.#open(membership.server.address, membership.server.fingerprint, generation)
    } catch {
      return // reported through onEnd
    }
    if (generation !== this.#generation) {
      connection.terminate()
      return
    }
    this.#connection = connection
    this.#connectionGeneration = generation
    let answer: Answer
    try {
      answer = await connection.hello(membership.device.id, secret)
    } catch {
      return // the connection ended; onEnd decides
    }
    if (generation !== this.#generation) return
    if (!answer.ok) {
      // **The recorded pre-auth error decides by itself** — not the 4003 a second later.
      const outcome = outcomeOfPreAuthError(preAuthErrorOf(answer.e.code))
      if (answer.e.code === 'UNSUPPORTED_VERSION') this.#olderSide = olderSide(answer.e.detail?.supported, PROTOCOL_VERSIONS) ?? undefined
      this.#abandon()
      this.#apply(outcome)
      return
    }
    connection.markAuthenticated()
    this.#adoptAuthAnswer(answer.r)
    this.#status = 'connected'
    this.#reason = undefined
    this.#emit()
    for (const listener of this.#states) listener('connected')
    this.#stableTimer = setTimeout(() => (this.#attempt = 0), this.#deps.testing?.stableMs ?? 60_000)
    this.#stableTimer.unref()
    void this.refreshMembers()
    this.#scheduleMembers()
  }

  #open(server: string, fingerprint: string | undefined, generation: number): Promise<TeamConnection> {
    const options: ConnectionOptions = {
      server,
      ...(fingerprint ? { fingerprint } : {}),
      onEvent: (kind, data) => {
        if (generation !== this.#generation) return
        for (const listener of this.#events.get(kind) ?? []) listener(data)
      },
      onEnd: (end) => this.#onEnd(end, generation),
    }
    return (this.#deps.testing?.open ?? TeamConnection.open)(options)
  }

  #onEnd(end: ConnectionEnd, generation: number): void {
    if (generation !== this.#generation) return
    const wasConnected = this.#status === 'connected'
    this.#connection = null
    if (wasConnected) for (const listener of this.#states) listener('reconnecting')
    this.#apply(outcomeOf(end))
  }

  #apply(outcome: Outcome): void {
    switch (outcome.kind) {
      case 'none':
        return
      case 'retry':
        this.#scheduleRetry(outcome.reason)
        return
      case 'stop':
        this.#enterStop(outcome.reason, { persist: true, notify: true })
        return
      case 'discard':
        if (this.#deps.store.get().membership?.leaving) this.#completeLeave()
        else this.#discard('REVOKED', true)
        return
    }
  }

  #scheduleRetry(reason: RetryReason): void {
    this.#clearTimers()
    const delay = backoffDelay(this.#attempt++, this.#deps.testing?.baseDelayMs ?? 1000, this.#deps.testing?.random)
    this.#status = 'reconnecting'
    this.#reason = reason
    this.#nextAt = Date.now() + delay
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.#connect()
    }, delay)
    // Timers never keep the process alive: quitting must not wait for a reconnect.
    this.#retryTimer.unref()
    this.#emit()
  }

  #enterStop(reason: StopReason, { persist, notify }: { persist: boolean; notify: boolean }): void {
    this.#abandon()
    this.#status = 'stopped'
    this.#reason = reason
    const state = this.#deps.store.get()
    if (persist) {
      const already = state.stop?.reason === reason && state.stop.notified
      this.#deps.store.setStop({ reason, appVersion: this.#deps.appVersion, notified: notify || already })
      if (notify && !already) this.#deps.notifyStop(reason, state.membership?.team.name ?? '')
    }
    this.#emit()
  }

  /** Design D4's order: the membership file, then the secret, then the extension points. */
  #discard(reason: StopReason | 'LEFT', notify: boolean): void {
    const { store, secrets } = this.#deps
    const membership = store.get().membership
    this.#abandon()
    const stop: TeamStop | undefined =
      reason === 'LEFT'
        ? undefined
        : { reason, appVersion: this.#deps.appVersion, notified: notify, ...(membership ? { deviceName: membership.device.name } : {}) }
    store.clearMembership(stop)
    secrets.clear(SECRET_NAME)
    this.#status = store.get().enabled ? 'unjoined' : 'off'
    this.#reason = reason === 'LEFT' ? undefined : reason
    if (notify && membership) this.#deps.notifyStop('REVOKED', membership.team.name)
    if (membership) for (const listener of this.#discarded) listener({ server: membership.server.address, memberId: membership.member.id })
    this.#emit()
  }

  #completeLeave(): void {
    this.#discard('LEFT', false)
  }

  #adoptAuthAnswer(r: unknown): void {
    const a = (r ?? {}) as Record<string, unknown>
    const member = a.member as Record<string, unknown> | undefined
    const device = a.device as Record<string, unknown> | undefined
    const team = a.team as Record<string, unknown> | undefined
    const current = this.#deps.store.get().membership
    if (!current) return
    this.#deps.store.updateMembership({
      ...(Array.isArray(a.operations) ? { operations: a.operations.filter((o): o is string => typeof o === 'string') } : {}),
      ...(member && typeof member.handle === 'string'
        ? {
            member: {
              id: typeof member.id === 'string' ? member.id : current.member.id,
              handle: normalizeAuthored(member.handle),
              displayName: normalizeAuthored(typeof member.displayName === 'string' ? member.displayName : current.member.displayName),
              deviceCount: typeof member.deviceCount === 'number' ? member.deviceCount : current.member.deviceCount,
            },
          }
        : {}),
      ...(device && typeof device.name === 'string' ? { device: { id: current.device.id, name: normalizeAuthored(device.name) } } : {}),
      ...(team && typeof team.name === 'string' ? { team: { name: normalizeAuthored(team.name) } } : {}),
    })
  }

  #scheduleMembers(): void {
    const every = this.#deps.testing?.membersIntervalMs ?? 15 * 60_000
    this.#membersTimer = setTimeout(() => {
      void this.refreshMembers().finally(() => {
        if (this.#status === 'connected') this.#scheduleMembers()
      })
    }, every)
    this.#membersTimer.unref()
  }

  // ---- Operations ----

  operations(): string[] {
    return this.#deps.store.get().membership?.operations ?? []
  }

  membership(): { server: string; memberId: string } | null {
    const m = this.#deps.store.get().membership
    return m ? { server: m.server.address, memberId: m.member.id } : null
  }

  /** An operation on the device's connection, only when the server lists it. */
  async request(m: string, p?: Record<string, unknown>): Promise<Answer> {
    if (!this.operations().includes(m)) return { ok: false, e: { code: 'UNKNOWN_OPERATION', message: 'not offered by this server' } }
    const connection = this.#connection
    if (!connection || this.#status !== 'connected') throw new Error('not connected')
    return connection.request(m, p)
  }

  /**
   * Fetches the members (`team.members`), normalizes and keeps them. Throttled to once a minute unless forced;
   * `maxWaitMs` bounds how long a caller on a read path waits.
   */
  async refreshMembers(options: { force?: boolean; maxWaitMs?: number } = {}): Promise<TeamMember[] | null> {
    if (this.#status !== 'connected') return null
    if (!options.force && Date.now() - this.#lastMembersRefresh < 60_000 && this.#lastMembersRefresh !== 0) {
      return this.#deps.store.get().membership?.members?.list ?? null
    }
    this.#lastMembersRefresh = Date.now()
    const fetching = (async () => {
      const answer = await this.request('team.members', {})
      if (!answer.ok) return null
      const raw = ((answer.r as { members?: unknown[] })?.members ?? []) as Record<string, unknown>[]
      const list: TeamMember[] = raw
        .filter((m) => typeof m.id === 'string' && typeof m.handle === 'string' && typeof m.displayName === 'string')
        .map((m) => ({
          id: m.id as string,
          handle: normalizeAuthored(m.handle as string),
          displayName: normalizeAuthored(m.displayName as string).replace(/\n+/g, ' '),
          ...(typeof m.deviceCount === 'number' ? { deviceCount: m.deviceCount } : {}),
        }))
      this.#deps.store.updateMembership({ members: { list, fetchedAt: Date.now() } })
      for (const listener of this.#members) listener(list)
      this.#emit()
      return list
    })().catch(() => null)
    if (options.maxWaitMs === undefined) return fetching
    return Promise.race([fetching, new Promise<null>((resolve) => setTimeout(() => resolve(null), options.maxWaitMs))])
  }

  async rename(name: string): Promise<{ ok: true } | { ok: false; error: 'NOT_CONNECTED' | 'BAD_PARAMS' | 'NOT_OFFERED' | 'FAILED' }> {
    if (!this.operations().includes('device.rename')) return { ok: false, error: 'NOT_OFFERED' }
    if (this.#status !== 'connected') return { ok: false, error: 'NOT_CONNECTED' }
    try {
      const answer = await this.request('device.rename', { name })
      if (!answer.ok) return { ok: false, error: answer.e.code === 'BAD_PARAMS' ? 'BAD_PARAMS' : 'FAILED' }
      const device = (answer.r as { device?: { name?: unknown } }).device
      const current = this.#deps.store.get().membership
      if (current && typeof device?.name === 'string') {
        this.#deps.store.updateMembership({ device: { id: current.device.id, name: normalizeAuthored(device.name) } })
      }
      this.#emit()
      return { ok: true }
    } catch {
      return { ok: false, error: 'FAILED' }
    }
  }

  /** The member's device count from a list fetched now (design D6), or `null` when it cannot be fetched. */
  async leavePreview(): Promise<{ deviceCount: number } | null> {
    const list = await this.refreshMembers({ force: true })
    const me = this.#deps.store.get().membership?.member.id
    const count = list?.find((m) => m.id === me)?.deviceCount
    return typeof count === 'number' ? { deviceCount: count } : null
  }

  async leave(): Promise<{ ok: true; memberRemoved: boolean } | { ok: false; error: 'NOT_CONNECTED' | 'NOT_OFFERED' | 'FAILED' }> {
    if (!this.operations().includes('device.leave')) return { ok: false, error: 'NOT_OFFERED' }
    if (this.#status !== 'connected') return { ok: false, error: 'NOT_CONNECTED' }
    // Recorded before the request: a lost answer, a timeout or a restart completes the leave quietly (D6).
    this.#deps.store.updateMembership({ leaving: true })
    try {
      const answer = await this.request('device.leave', {})
      if (!answer.ok) {
        this.#deps.store.updateMembership({ leaving: false })
        return { ok: false, error: 'FAILED' }
      }
      this.#completeLeave()
      return { ok: true, memberRemoved: (answer.r as { memberRemoved?: unknown }).memberRemoved === true }
    } catch {
      // The connection ended before the answer: the reconnect's 4004 or AUTH_FAILED completes the leave.
      return { ok: false, error: 'FAILED' }
    }
  }

  /** Remove from this computer: discards locally; the server keeps the device until the admin revokes it. */
  removeLocally(): void {
    this.#discard('LEFT', false)
  }

  // ---- Invite ----

  async inspect(link: string): Promise<InspectResult> {
    const parsed = parseInvite(link)
    if (!parsed.ok) return { ok: false, error: 'INVALID_LINK' }
    const invite = parsed.invite
    let connection: TeamConnection | null = null
    let end = null as ConnectionEnd | null
    try {
      connection = await (this.#deps.testing?.open ?? TeamConnection.open)({
        server: invite.server,
        ...(invite.fingerprint ? { fingerprint: invite.fingerprint } : {}),
        onEvent: () => {},
        onEnd: (e) => (end = e),
      })
      const answer = await connection.request('invite.inspect', { protocol: PROTOCOL_VERSIONS, code: invite.code })
      if (!answer.ok) return { ok: false, error: joinFailureOf(answer.e.code) }
      const r = answer.r as Record<string, unknown>
      const member = r.member as { handle?: unknown; displayName?: unknown } | undefined
      return {
        ok: true,
        invite,
        kind: r.kind === 'device' ? 'device' : 'member',
        team: normalizeAuthored(String((r.team as { name?: unknown })?.name ?? '')),
        expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : 0,
        ...(member && typeof member.handle === 'string'
          ? { member: { handle: normalizeAuthored(member.handle), displayName: normalizeAuthored(String(member.displayName ?? '')) } }
          : {}),
      }
    } catch {
      return { ok: false, error: failureOfEnd(end) }
    } finally {
      connection?.terminate()
    }
  }

  /**
   * Joins (design D5): its own connection, which becomes the device's on success. Writes the secret, then the
   * membership; a failed write leaves the device on the server's list, so it sends `device.leave` on that connection.
   */
  async joinTeam(input: { link: string; deviceName: string; handle?: string; displayName?: string }): Promise<JoinResult> {
    const parsed = parseInvite(input.link)
    if (!parsed.ok) return { ok: false, error: 'BAD_PARAMS', field: 'link' }
    const invite = parsed.invite
    this.#abandon()
    const generation = ++this.#generation
    let connection: TeamConnection
    let end = null as ConnectionEnd | null
    // Until the join succeeds, an end is the join's failure, not the device's: it must not reach the reconnect table
    // (an `INVITE_USED` there would read as a fault and stop the device's own membership).
    let joined = false
    try {
      connection = await (this.#deps.testing?.open ?? TeamConnection.open)({
        server: invite.server,
        ...(invite.fingerprint ? { fingerprint: invite.fingerprint } : {}),
        onEvent: (kind, data) => {
          if (generation !== this.#generation) return
          for (const listener of this.#events.get(kind) ?? []) listener(data)
        },
        onEnd: (e) => {
          end = e
          if (joined) this.#onEnd(e, generation)
        },
      })
    } catch {
      this.#settleAfterFailedJoin()
      return { ok: false, error: failureOfEnd(end) }
    }
    let answer: Answer
    try {
      answer = await connection.join(
        {
          code: invite.code,
          deviceName: input.deviceName,
          ...(input.handle !== undefined ? { handle: input.handle } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        },
        (value) => new Secret(value),
      )
    } catch {
      // The connection ended after `join` was sent: the invite may have been used, and the secret is gone.
      this.#settleAfterFailedJoin()
      return { ok: false, error: 'LOST_ANSWER', deviceName: input.deviceName }
    }
    if (!answer.ok) {
      connection.terminate()
      this.#settleAfterFailedJoin()
      const error = joinFailureOf(answer.e.code)
      const detail = answer.e.detail ?? {}
      return {
        ok: false,
        error,
        ...(typeof detail.field === 'string' ? { field: detail.field } : {}),
        ...(error === 'UNSUPPORTED_VERSION' ? { olderSide: olderSide(detail.supported, PROTOCOL_VERSIONS) ?? undefined } : {}),
      } as JoinResult
    }
    const r = answer.r as Record<string, unknown>
    const secret = r.deviceSecret
    const member = (r.member ?? {}) as Record<string, unknown>
    const device = (r.device ?? {}) as Record<string, unknown>
    const membership: Membership = {
      server: { address: invite.server, ...(invite.fingerprint ? { fingerprint: invite.fingerprint } : {}) },
      team: { name: normalizeAuthored(String((r.team as { name?: unknown })?.name ?? '')) },
      member: {
        id: String(member.id ?? ''),
        handle: normalizeAuthored(String(member.handle ?? '')),
        displayName: normalizeAuthored(String(member.displayName ?? '')),
        deviceCount: typeof member.deviceCount === 'number' ? member.deviceCount : 1,
      },
      device: { id: String(r.deviceId ?? device.id ?? ''), name: normalizeAuthored(String(device.name ?? input.deviceName)) },
      operations: Array.isArray(r.operations) ? r.operations.filter((o): o is string => typeof o === 'string') : [],
    }
    try {
      if (!(secret instanceof Secret)) throw new Error('no secret in the join answer')
      this.#deps.secrets.setSecret(SECRET_NAME, secret)
      this.#deps.store.setMembership(membership)
      if (!this.#deps.store.get().enabled) this.#deps.store.setEnabled(true)
    } catch {
      // Undo what was written, and do not leave an orphan device on the server.
      try {
        this.#deps.secrets.clear(SECRET_NAME)
      } catch {
        // Nothing more to undo.
      }
      const left = await (async () => {
        try {
          connection.markAuthenticated()
          return (await connection.request('device.leave', {})).ok
        } catch {
          return false
        }
      })()
      connection.terminate()
      this.#settleAfterFailedJoin()
      return { ok: false, error: 'NOT_STORED', ...(left ? {} : { deviceName: membership.device.name }) }
    }
    if (generation !== this.#generation) {
      connection.terminate()
      return { ok: true }
    }
    connection.markAuthenticated()
    joined = true
    this.#connection = connection
    this.#connectionGeneration = generation
    this.#attempt = 0
    this.#status = 'connected'
    this.#reason = undefined
    this.#emit()
    for (const listener of this.#states) listener('connected')
    this.#stableTimer = setTimeout(() => (this.#attempt = 0), this.#deps.testing?.stableMs ?? 60_000)
    this.#stableTimer.unref()
    void this.refreshMembers({ force: true })
    this.#scheduleMembers()
    return { ok: true }
  }

  #settleAfterFailedJoin(): void {
    this.#abandon()
    const state = this.#deps.store.get()
    if (state.membership && state.stop && STICKY.has(state.stop.reason)) {
      this.#status = 'stopped'
      this.#reason = state.stop.reason as StopReason
      this.#emit()
      return
    }
    this.#settle()
  }

  // ---- State and extension points ----

  snapshot(): TeamSnapshot {
    const state: TeamState = this.#deps.store.get()
    const loadIssue = this.#deps.store.loadIssue()
    return {
      enabled: state.enabled,
      status: this.#status,
      ...(this.#reason ? { reason: this.#reason } : state.stop && !state.membership ? { reason: state.stop.reason as StopReason } : {}),
      ...(this.#nextAt !== undefined ? { nextAt: this.#nextAt } : {}),
      ...(this.#olderSide ? { olderSide: this.#olderSide } : {}),
      ...(loadIssue ? { loadIssue } : {}),
      ...(state.membership ? { deviceName: state.membership.device.name } : state.stop?.deviceName ? { deviceName: state.stop.deviceName } : {}),
      membership: state.membership,
    }
  }

  onChange(listener: Listener<TeamSnapshot>): () => void {
    this.#changes.add(listener)
    return () => this.#changes.delete(listener)
  }

  onEvent(kind: string, listener: Listener<unknown>): () => void {
    const set = this.#events.get(kind) ?? new Set()
    set.add(listener)
    this.#events.set(kind, set)
    return () => set.delete(listener)
  }

  /** Entering (`connected`) and leaving (`reconnecting`) the connected state. */
  onState(listener: Listener<TeamStatus>): () => void {
    this.#states.add(listener)
    return () => this.#states.delete(listener)
  }

  onMembers(listener: Listener<TeamMember[]>): () => void {
    this.#members.add(listener)
    return () => this.#members.delete(listener)
  }

  onCredentialDiscarded(listener: Listener<{ server: string; memberId: string }>): () => void {
    this.#discarded.add(listener)
    return () => this.#discarded.delete(listener)
  }

  #emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.#changes) listener(snapshot)
  }

  /** Tests: the generation of the connection currently held. */
  get connectionGeneration(): number {
    return this.#connectionGeneration
  }
}

function joinFailureOf(code: string): JoinFailure {
  switch (code) {
    case 'INVITE_UNKNOWN':
    case 'INVITE_EXPIRED':
    case 'INVITE_USED':
    case 'HANDLE_TAKEN':
    case 'BAD_PARAMS':
    case 'UNSUPPORTED_VERSION':
      return code
    default:
      return 'INTERNAL'
  }
}

function failureOfEnd(end: ConnectionEnd | null): JoinFailure {
  if (end && end.kind === 'tls' && end.pinMismatch) return 'PIN_MISMATCH'
  return 'NETWORK'
}
