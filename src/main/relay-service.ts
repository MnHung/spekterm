import { type GrantBinding, RelayGrants, type RelayValue } from './relay-grants'
import type { RelayedStream } from './remote-server'
import type { SecretStore } from './secret-store'
import { type RelayLeg, type RelayLegEnd, type RelayLegOptions, openRelayLeg } from './team-connection'
import type { Answer } from './team-connection'
import { SECRET_NAME } from './team-service'
import type { TeamStatus } from './team-service'
import type { TeamStore } from './team-store'

/**
 * Reaching this desktop from its paired phones through the team server (`phone-relay`). Electron-free.
 *
 * - **The setting** lives on the membership (`TeamStore`, design D1).
 * - **Grants** (design D2–D3): one per paired phone while the setting is on, requested from the team server, stored in
 *   `RelayGrants`, revoked when unwanted. One reconcile at a time; after every awaited answer it re-reads the world.
 * - **Tunnels** (design D5–D6): `relay.incoming` is refused unless everything holds; otherwise the leg is opened to the
 *   membership's own server and handed to the remote access listener.
 * - **Phones are told** through `RemoteService.relayChanged`, which compares with what each connection was told.
 */

/** The parts of `TeamService` the relay uses. */
export interface RelayTeam {
  snapshot(): { enabled: boolean; status: TeamStatus }
  operations(): string[]
  request(m: string, p?: Record<string, unknown>): Promise<Answer>
  onState(listener: (status: TeamStatus) => void): () => void
  onEvent(kind: string, listener: (data: unknown) => void): () => void
  onChange(listener: (snapshot: { enabled: boolean }) => void): () => void
  onCredentialDiscarded(listener: (value: { server: string; memberId: string }) => void): () => void
}

/** The parts of `RemoteService` the relay uses. */
export interface RelayRemote {
  pairedDevices(): { id: string; name: string }[]
  enabled(): boolean
  listening(): boolean
  relayThrottled(grant: string): boolean
  acceptRelayed(stream: RelayedStream, grant: string, phone: string): boolean
  relayChanged(deviceId?: string): void
  setRelayProvider(provider: (deviceId: string) => RelayValue | null): void
  onRelayInputs(listener: () => void): () => void
}

export interface RelayServiceDeps {
  team: RelayTeam
  teamStore: TeamStore
  secrets: SecretStore
  remote: RelayRemote
  /** Tests: the leg opener. */
  openLeg?: (options: RelayLegOptions) => Promise<RelayLeg>
}

/** What the Team section shows of the relay (design D1). No grant id or secret. */
export interface RelayView {
  /** The setting. */
  on: boolean
  /** The server lists the relay and remote access is on: the switch can be used. */
  available: boolean
  /** Why a switch that is on cannot be used now. */
  blocked?: 'remote-off' | 'server'
  /** Paired phones holding an active grant, of all paired phones. */
  phones: { withGrant: number; paired: number }
  /** The server refused a grant: the device holds the most it allows. */
  limitReached: boolean
}

const GRANT_NAME_MAX = 64
const ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

/** The phone's name as a grant name: control characters out, 1–64 code points. */
export function grantName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = [...name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim()].slice(0, GRANT_NAME_MAX).join('').trim()
  return clean === '' ? 'phone' : clean
}

export class RelayService {
  readonly #deps: RelayServiceDeps
  readonly #grants: RelayGrants
  #queue: Promise<void> = Promise.resolve()
  #limitReached = false
  /** `RELAY_DISABLED` was answered on a leg since the last `hello` listing the relay (server §13.6). */
  #relayDisabled = false
  readonly #legs = new Set<RelayLeg>()
  readonly #listeners = new Set<() => void>()
  readonly #offs: (() => void)[] = []

  constructor(deps: RelayServiceDeps) {
    this.#deps = deps
    this.#grants = new RelayGrants(deps.secrets)
  }

  /** Loads the grants and subscribes. Call before remote access starts listening (design D4). */
  start(): void {
    const { team, remote } = this.#deps
    this.#grants.load(this.#binding())
    remote.setRelayProvider((deviceId) => this.relayFor(deviceId))
    this.#offs.push(
      team.onState((status) => {
        if (status !== 'connected') return
        if (team.operations().includes('relay.grant')) this.#relayDisabled = false
        void this.reconcile()
      }),
      team.onEvent('relay.incoming', (data) => this.#incoming(data)),
      team.onChange((snapshot) => {
        if (!snapshot.enabled) this.#endLegs()
        this.#local()
      }),
      team.onCredentialDiscarded(() => {
        // The server deleted the grants with the device; open legs end there too (4004).
        this.#local()
      }),
      remote.onRelayInputs(() => void this.reconcile()),
    )
    this.#local()
  }

  dispose(): void {
    for (const off of this.#offs.splice(0)) off()
    this.#endLegs()
  }

  // ---- The setting and the view ----

  setOn(on: boolean): void {
    this.#deps.teamStore.updateMembership({ relay: on })
    if (!on) this.#limitReached = false
    void this.reconcile()
  }

  view(): RelayView {
    const membership = this.#deps.teamStore.get().membership
    const on = membership?.relay === true
    const offered = (membership?.operations ?? []).includes('relay.grant')
    const remoteOn = this.#deps.remote.enabled()
    const paired = this.#deps.remote.pairedDevices()
    const withGrant = paired.filter((device) => this.#grants.activeFor(device.id)).length
    return {
      on,
      available: offered && remoteOn,
      ...(on && !remoteOn ? { blocked: 'remote-off' as const } : on && !offered ? { blocked: 'server' as const } : {}),
      phones: { withGrant, paired: paired.length },
      limitReached: on && this.#limitReached,
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The phone's `relay` value: only with the Team feature and the setting on, for an active grant. */
  relayFor(deviceId: string): RelayValue | null {
    const state = this.#deps.teamStore.get()
    const membership = state.membership
    if (!state.enabled || !membership || membership.relay !== true) return null
    return this.#grants.relayFor(deviceId, membership.server)
  }

  // ---- Grants ----

  #binding(): GrantBinding | null {
    const membership = this.#deps.teamStore.get().membership
    return membership ? { server: membership.server.address, device: membership.device.id } : null
  }

  #wanted(): Set<string> {
    const membership = this.#deps.teamStore.get().membership
    if (!membership || membership.relay !== true) return new Set()
    return new Set(this.#deps.remote.pairedDevices().map((device) => device.id))
  }

  /**
   * What needs no server (design D3): rebind to the current membership, mark unwanted grants to be revoked, tell
   * phones whatever changed, tell the Team view.
   */
  #local(): void {
    try {
      this.#grants.bind(this.#binding())
      const wanted = this.#wanted()
      for (const grant of this.#grants.list()) {
        if (grant.state === 'active' && !wanted.has(grant.phone)) this.#grants.markRevoke(grant.id)
      }
    } catch (error) {
      console.error(`[relay] grants could not be updated: ${String((error as Error).message ?? error)}`)
    }
    this.#deps.remote.relayChanged()
    this.#emit()
  }

  /** One round at a time; every trigger enqueues one. */
  reconcile(): Promise<void> {
    const run = this.#queue.then(() => this.#round())
    this.#queue = run.catch((error) => {
      console.error(`[relay] reconcile stopped: ${String((error as Error).message ?? error)}`)
    })
    return this.#queue
  }

  async #round(): Promise<void> {
    this.#local()
    const { team, remote } = this.#deps
    if (team.snapshot().status !== 'connected' || !team.operations().includes('relay.grants')) return
    const binding = this.#binding()
    if (!binding) return
    const sameBinding = (): boolean => {
      const now = this.#binding()
      return now !== null && now.server === binding.server && now.device === binding.device
    }

    // 1. What the server holds for this device.
    const listed = await team.request('relay.grants', {})
    if (!listed.ok || !sameBinding()) return
    const serverIds = new Set(
      (((listed.r as { grants?: unknown[] })?.grants ?? []) as Record<string, unknown>[])
        .map((g) => g.id)
        .filter((id): id is string => typeof id === 'string'),
    )

    // 2. Held here, gone there: forgotten, its phone told.
    for (const grant of this.#grants.list()) {
      if (!serverIds.has(grant.id)) this.#grants.remove(grant.id)
    }
    this.#local()

    // 3. Held there, unknown here (a lost answer, a damaged store): revoked.
    const known = new Set(this.#grants.list().map((g) => g.id))
    for (const id of serverIds) {
      if (known.has(id)) continue
      await team.request('relay.revoke', { id })
      if (!sameBinding()) return
    }

    // 4–5. Unwanted grants (marked by `#local`): revoked, then removed.
    for (const grant of this.#grants.list()) {
      if (grant.state !== 'revoke') continue
      const answer = await team.request('relay.revoke', { id: grant.id })
      if (!sameBinding()) return
      if (answer.ok) this.#grants.remove(grant.id)
    }

    // 6. A wanted phone without a grant, only while remote access is on.
    if (!remote.enabled()) {
      this.#emit()
      return
    }
    for (const device of remote.pairedDevices()) {
      if (!this.#wanted().has(device.id) || this.#grants.activeFor(device.id)) continue
      let name = grantName(device.name)
      let answer = await team.request('relay.grant', { name })
      if (!answer.ok && answer.e.code === 'BAD_PARAMS' && name !== 'phone') {
        name = 'phone'
        answer = await team.request('relay.grant', { name })
      }
      if (!answer.ok) {
        if (answer.e.code === 'TOO_MANY_GRANTS') {
          this.#limitReached = true
          break
        }
        continue
      }
      const r = (answer.r ?? {}) as { grant?: { id?: unknown }; secret?: unknown }
      const id = r.grant?.id
      const secret = r.secret
      if (typeof id !== 'string' || !ID.test(id) || typeof secret !== 'string' || secret === '') continue
      // The world may have moved while the answer was on its way (design D3).
      if (!sameBinding()) return
      if (this.#wanted().has(device.id)) {
        this.#grants.add({ phone: device.id, id, secret, name })
        remote.relayChanged(device.id)
      } else {
        this.#grants.add({ phone: device.id, id, secret, name }, 'revoke')
        const revoked = await team.request('relay.revoke', { id })
        if (!sameBinding()) return
        if (revoked.ok) this.#grants.remove(id)
      }
    }
    this.#emit()
  }

  // ---- Tunnels ----

  #incoming(data: unknown): void {
    const d = (data ?? {}) as Record<string, unknown>
    const tunnel = d.tunnel
    const grant = d.grant
    if (typeof tunnel !== 'string' || !ID.test(tunnel) || typeof grant !== 'string' || !ID.test(grant)) return
    const refuse = (why: string): void => {
      console.log(`[relay] tunnel refused: ${why}`)
      this.#deps.team.request('relay.refuse', { tunnel }).catch(() => undefined)
    }
    const { remote, teamStore, secrets } = this.#deps
    const state = teamStore.get()
    const membership = state.membership
    // 1. The setting, the Team feature, remote access and its listener.
    if (!state.enabled || !membership || membership.relay !== true || !remote.enabled() || !remote.listening()) {
      refuse('off')
      return
    }
    // 2. A grant held here and given to a phone that is still paired.
    const held = this.#grants.byId(grant)
    if (!held || held.state !== 'active' || !remote.pairedDevices().some((device) => device.id === held.phone)) {
      refuse('unknown grant')
      return
    }
    // 3. Not throttled.
    if (remote.relayThrottled(grant)) {
      refuse('throttled')
      return
    }
    // 4. The server did not say its relay is off since the last hello.
    if (this.#relayDisabled) {
      refuse('relay disabled')
      return
    }
    const secret = secrets.get(SECRET_NAME)
    if (!secret) {
      refuse('no credential')
      return
    }
    const open = this.#deps.openLeg ?? openRelayLeg
    let leg: RelayLeg | null = null
    open({
      // The stored membership's server and pin — the event carries no address.
      server: membership.server.address,
      ...(membership.server.fingerprint ? { fingerprint: membership.server.fingerprint } : {}),
      deviceId: membership.device.id,
      secret,
      tunnel,
      onEnd: (end) => this.#legEnded(end, leg),
    }).then(
      (opened) => {
        leg = opened
        this.#legs.add(opened)
        // Phone fixed now (design D8), from the check above.
        if (!remote.acceptRelayed(opened.stream, grant, held.phone)) opened.terminate()
      },
      () => undefined, // reported through onEnd
    )
  }

  #legEnded(end: RelayLegEnd, leg: RelayLeg | null): void {
    if (leg) this.#legs.delete(leg)
    if (end.kind === 'refused') {
      if (end.code === 'RELAY_DISABLED') this.#relayDisabled = true
      console.log(`[relay] leg refused: ${end.code}`)
    }
  }

  #endLegs(): void {
    for (const leg of [...this.#legs]) leg.terminate()
    this.#legs.clear()
  }

  /** Tests: open legs. */
  get openLegs(): number {
    return this.#legs.size
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error(`[relay] change listener failed: ${String(error)}`)
      }
    }
  }
}
