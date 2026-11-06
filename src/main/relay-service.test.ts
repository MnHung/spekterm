import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { RelayValue } from './relay-grants'
import { type RelayRemote, RelayService, type RelayTeam, grantName } from './relay-service'
import { Secret, SecretStore } from './secret-store'
import type { Answer, RelayLeg, RelayLegOptions } from './team-connection'
import { SECRET_NAME, type TeamStatus } from './team-service'
import { type Membership, TeamStore } from './team-store'

/**
 * The relay's grants and tunnels (`phone-relay`, design D3–D5) against a stand-in team server that keeps grants as
 * spekterm-server does, and a stand-in remote access service that records what each phone was told.
 */

const MEMBERSHIP: Membership = {
  server: { address: 'wss://team.example.com', fingerprint: 'B'.repeat(64) },
  team: { name: 'Acme' },
  member: { id: 'm_1', handle: 'sam', displayName: 'Sam', deviceCount: 1 },
  device: { id: 'd_1', name: 'laptop' },
  operations: ['relay.grant', 'relay.grants', 'relay.revoke', 'relay.refuse'],
}

class FakeServer {
  grants = new Map<string, string>()
  next = 1
  requests: { m: string; p: Record<string, unknown> }[] = []
  /** When set, `relay.grant` answers wait for it. */
  hold: Promise<void> | null = null
  limit = 16
  async handle(m: string, p: Record<string, unknown> = {}): Promise<Answer> {
    this.requests.push({ m, p })
    if (m === 'relay.grants') return { ok: true, r: { grants: [...this.grants.entries()].map(([id, name]) => ({ id, name, createdAt: 1 })) } }
    if (m === 'relay.grant') {
      if (this.hold) await this.hold
      if (this.grants.size >= this.limit) return { ok: false, e: { code: 'TOO_MANY_GRANTS', message: '' } }
      const id = `g_${this.next++}`
      this.grants.set(id, String(p.name))
      return { ok: true, r: { grant: { id, name: p.name, createdAt: 1 }, secret: `secret-${id}` } }
    }
    if (m === 'relay.revoke') return { ok: true, r: { revoked: this.grants.delete(String(p.id)) } }
    if (m === 'relay.refuse') return { ok: true, r: {} }
    return { ok: false, e: { code: 'UNKNOWN_OPERATION', message: '' } }
  }
}

class FakeTeam implements RelayTeam {
  status: TeamStatus = 'connected'
  readonly states = new Set<(s: TeamStatus) => void>()
  readonly events = new Map<string, (d: unknown) => void>()
  readonly changes = new Set<(s: { enabled: boolean }) => void>()
  readonly discards = new Set<(v: { server: string; memberId: string }) => void>()
  constructor(
    readonly server: FakeServer,
    readonly store: TeamStore,
  ) {}
  snapshot() {
    return { enabled: this.store.get().enabled, status: this.status }
  }
  operations() {
    return this.store.get().membership?.operations ?? []
  }
  request(m: string, p?: Record<string, unknown>) {
    if (this.status !== 'connected') return Promise.reject(new Error('not connected'))
    return this.server.handle(m, p)
  }
  onState(l: (s: TeamStatus) => void) {
    this.states.add(l)
    return () => this.states.delete(l)
  }
  onEvent(kind: string, l: (d: unknown) => void) {
    this.events.set(kind, l)
    return () => this.events.delete(kind)
  }
  onChange(l: (s: { enabled: boolean }) => void) {
    this.changes.add(l)
    return () => this.changes.delete(l)
  }
  onCredentialDiscarded(l: (v: { server: string; memberId: string }) => void) {
    this.discards.add(l)
    return () => this.discards.delete(l)
  }
  connect() {
    this.status = 'connected'
    for (const l of this.states) l('connected')
  }
  drop() {
    this.status = 'reconnecting'
    for (const l of this.states) l('reconnecting')
  }
}

class FakeRemote implements RelayRemote {
  devices: { id: string; name: string }[] = []
  on = true
  connected = new Set<string>()
  /** What each connected phone was last told, and every telling. */
  told = new Map<string, string>()
  events: { device: string; relay: RelayValue | null }[] = []
  accepted: { grant: string; phone: string }[] = []
  provider: ((id: string) => RelayValue | null) | null = null
  throttled = new Set<string>()
  readonly inputs = new Set<() => void>()
  pairedDevices() {
    return [...this.devices]
  }
  enabled() {
    return this.on
  }
  listening() {
    return this.on
  }
  relayThrottled(grant: string) {
    return this.throttled.has(grant)
  }
  acceptRelayed(_stream: unknown, grant: string, phone: string) {
    this.accepted.push({ grant, phone })
    return true
  }
  setRelayProvider(p: (id: string) => RelayValue | null) {
    this.provider = p
  }
  onRelayInputs(l: () => void) {
    this.inputs.add(l)
    return () => this.inputs.delete(l)
  }
  /** As `RemoteService.relayChanged`: per connection, only on a difference. */
  relayChanged(deviceId?: string) {
    for (const device of this.connected) {
      if (deviceId !== undefined && device !== deviceId) continue
      const relay = this.provider?.(device) ?? null
      const text = JSON.stringify(relay)
      if ((this.told.get(device) ?? 'null') === text) continue
      this.told.set(device, text)
      this.events.push({ device, relay })
    }
  }
  /** A phone authenticates with hello: its baseline is what the answer carried. */
  hello(device: string) {
    this.connected.add(device)
    this.told.set(device, JSON.stringify(this.provider?.(device) ?? null))
  }
  pair(id: string, name: string) {
    this.devices.push({ id, name })
    for (const l of this.inputs) l()
  }
  unpair(id: string) {
    this.devices = this.devices.filter((d) => d.id !== id)
    this.connected.delete(id)
    for (const l of this.inputs) l()
  }
  setOn(on: boolean) {
    this.on = on
    for (const l of this.inputs) l()
  }
}

function setup(options: { devices?: { id: string; name: string }[]; relay?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-service-'))
  const teamStore = new TeamStore(path.join(dir, 'team.json'))
  teamStore.load()
  teamStore.setEnabled(true)
  teamStore.setMembership(MEMBERSHIP)
  if (options.relay) teamStore.updateMembership({ relay: true })
  const secrets = new SecretStore(path.join(dir, 'secrets.json'))
  secrets.load()
  secrets.set(SECRET_NAME, 'device-secret')
  const server = new FakeServer()
  const team = new FakeTeam(server, teamStore)
  const remote = new FakeRemote()
  remote.devices = options.devices ?? []
  const legs: RelayLegOptions[] = []
  const service = new RelayService({
    team,
    teamStore,
    secrets,
    remote,
    openLeg: async (o) => {
      legs.push(o)
      const leg: RelayLeg = { stream: {} as RelayLeg['stream'], terminate: () => o.onEnd({ kind: 'terminated' }) }
      return leg
    },
  })
  service.start()
  return { dir, teamStore, secrets, server, team, remote, service, legs }
}

const settle = (service: RelayService) => service.reconcile()
const PHONES = [
  { id: 'phoneA', name: 'Pixel' },
  { id: 'phoneB', name: 'Tab' },
]

test('turning the relay on gets one grant per phone, and each phone is told only its own', async () => {
  const s = setup({ devices: PHONES })
  s.remote.hello('phoneA')
  s.remote.hello('phoneB')
  s.service.setOn(true)
  await settle(s.service)
  assert.deepEqual([...s.server.grants.values()].sort(), ['Pixel', 'Tab'])
  const a = s.remote.provider?.('phoneA')
  assert.equal(s.remote.events.filter((e) => e.device === 'phoneA').length, 1)
  assert.equal(s.remote.events.filter((e) => e.device === 'phoneB').length, 1)
  assert.notEqual(a?.grant, s.remote.provider?.('phoneB')?.grant, 'each phone gets its own grant')
  assert.equal(a?.url, MEMBERSHIP.server.address)
  assert.equal(a?.fp, MEMBERSHIP.server.fingerprint)
  assert.deepEqual(s.service.view().phones, { withGrant: 2, paired: 2 })
})

test('a phone paired while the relay is on gets a grant; unpairing revokes it', async () => {
  const s = setup({ relay: true })
  s.remote.pair('phoneA', 'Pixel')
  await settle(s.service)
  assert.equal(s.server.grants.size, 1)
  s.remote.unpair('phoneA')
  await settle(s.service)
  assert.equal(s.server.grants.size, 0)
})

test('turning the relay off revokes every grant and tells the phones null', async () => {
  const s = setup({ devices: PHONES, relay: true })
  s.remote.hello('phoneA')
  await settle(s.service)
  s.remote.hello('phoneA')
  s.service.setOn(false)
  await settle(s.service)
  assert.equal(s.server.grants.size, 0)
  assert.deepEqual(s.remote.events.at(-1), { device: 'phoneA', relay: null })
})

test('an unpairing while disconnected is never given again and is revoked after the next hello', async () => {
  const s = setup({ devices: PHONES, relay: true })
  await settle(s.service)
  const grantOfA = s.remote.provider?.('phoneA')?.grant as string
  s.team.drop()
  s.remote.unpair('phoneA')
  await settle(s.service)
  assert.equal(s.remote.provider?.('phoneA'), null, 'never given again')
  assert.ok(s.server.grants.has(grantOfA), 'still on the server while disconnected')
  s.team.connect()
  await settle(s.service)
  assert.equal(s.server.grants.has(grantOfA), false, 'revoked after the hello')
})

test('a grant the server holds and the desktop does not is revoked', async () => {
  const s = setup({ relay: true })
  s.server.grants.set('g_lost', 'Pixel')
  await settle(s.service)
  assert.equal(s.server.grants.has('g_lost'), false)
})

test('a grant the server lost is forgotten, its phone told, and a new one requested', async () => {
  const s = setup({ devices: [PHONES[0]], relay: true })
  await settle(s.service)
  const first = s.remote.provider?.('phoneA')?.grant as string
  s.remote.hello('phoneA')
  s.server.grants.delete(first)
  await settle(s.service)
  const second = s.remote.provider?.('phoneA')?.grant
  assert.ok(second && second !== first)
  assert.equal(s.remote.events.at(-1)?.relay?.grant, second)
})

test('remote access turned off revokes nothing and requests nothing', async () => {
  const s = setup({ devices: [PHONES[0]], relay: true })
  await settle(s.service)
  s.remote.setOn(false)
  await settle(s.service)
  assert.equal(s.server.grants.size, 1, 'nothing revoked (control: wanted computed with remote access → red)')
  s.remote.pair('phoneB', 'Tab')
  await settle(s.service)
  assert.equal(s.server.grants.size, 1, 'nothing requested while off')
  s.remote.setOn(true)
  await settle(s.service)
  assert.equal(s.server.grants.size, 2)
})

test('a grant answered after the relay was turned off is never given, and is revoked', async () => {
  const s = setup({ devices: [PHONES[0]] })
  s.remote.hello('phoneA')
  let release!: () => void
  s.server.hold = new Promise<void>((resolve) => (release = resolve))
  s.service.setOn(true)
  // The request is on its way; the user turns the relay off meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 20))
  s.service.setOn(false)
  s.server.hold = null
  release()
  await settle(s.service)
  assert.equal(s.server.grants.size, 0, 'revoked')
  assert.equal(s.remote.events.filter((e) => e.relay !== null).length, 0, 'the phone was never told')
  // Revoked in the same round, before the next round lists the grants again (control: act on the round's starting
  // wanted set → the grant is stored as active and revoked only by the next round → red).
  const order = s.server.requests.map((r) => r.m)
  const revokeAt = order.indexOf('relay.revoke')
  const secondListing = order.indexOf('relay.grants', order.indexOf('relay.grant'))
  assert.ok(revokeAt !== -1 && (secondListing === -1 || revokeAt < secondListing), order.join(','))
})

test('TOO_MANY_GRANTS stops the round and is shown', async () => {
  const s = setup({ devices: PHONES, relay: true })
  s.server.limit = 1
  await settle(s.service)
  assert.equal(s.server.grants.size, 1)
  assert.equal(s.service.view().limitReached, true)
  assert.deepEqual(s.service.view().phones, { withGrant: 1, paired: 2 })
})

test('leaving the team tells connected phones null at once', async () => {
  const s = setup({ devices: PHONES, relay: true })
  await settle(s.service)
  s.remote.hello('phoneA')
  s.remote.hello('phoneB')
  s.teamStore.clearMembership()
  for (const l of s.team.discards) l({ server: MEMBERSHIP.server.address, memberId: 'm_1' })
  assert.deepEqual(
    s.remote.events.filter((e) => e.relay === null).map((e) => e.device).sort(),
    ['phoneA', 'phoneB'],
    'control: clear without telling → red',
  )
})

test('the Team feature off withdraws the grant without revoking; on again gives it back', async () => {
  const s = setup({ devices: [PHONES[0]], relay: true })
  await settle(s.service)
  s.remote.hello('phoneA')
  const grant = s.remote.provider?.('phoneA')?.grant
  s.teamStore.setEnabled(false)
  for (const l of s.team.changes) l({ enabled: false })
  assert.deepEqual(s.remote.events.at(-1), { device: 'phoneA', relay: null })
  assert.equal(s.server.grants.size, 1, 'nothing revoked')
  s.teamStore.setEnabled(true)
  for (const l of s.team.changes) l({ enabled: true })
  assert.equal(s.remote.events.at(-1)?.relay?.grant, grant)
})

test('an unchanged value is not sent again; a change and its undoing are both sent', async () => {
  const s = setup({ devices: [PHONES[0]], relay: true })
  await settle(s.service)
  s.remote.hello('phoneA')
  s.remote.relayChanged('phoneA')
  assert.equal(s.remote.events.length, 0, 'the hello answer already carried it')
  s.teamStore.setEnabled(false)
  for (const l of s.team.changes) l({ enabled: false })
  s.teamStore.setEnabled(true)
  for (const l of s.team.changes) l({ enabled: true })
  assert.deepEqual(
    s.remote.events.map((e) => (e.relay ? 'grant' : 'null')),
    ['null', 'grant'],
  )
})

test('the grant name is the phone name, cleaned', () => {
  assert.equal(grantName('  Pixel\u0007 8  '), 'Pixel 8')
  assert.equal(grantName('\u0001'), 'phone')
  assert.equal([...grantName('x'.repeat(100))].length, 64)
})

// ---- Tunnels ----

async function withGrant() {
  const s = setup({ devices: [PHONES[0]], relay: true })
  await settle(s.service)
  const grant = s.remote.provider?.('phoneA')?.grant as string
  return { ...s, grant }
}

const incoming = (s: ReturnType<typeof setup>, data: unknown) => s.team.events.get('relay.incoming')?.(data)
const refusals = (s: ReturnType<typeof setup>) => s.server.requests.filter((r) => r.m === 'relay.refuse')
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('a tunnel for a held grant opens a leg to the membership’s own server, for the grant’s phone', async () => {
  const s = await withGrant()
  incoming(s, { tunnel: 't_1', grant: s.grant, expiresAt: 0, server: 'wss://elsewhere.example.com' })
  await tick()
  assert.equal(s.legs.length, 1)
  assert.equal(s.legs[0].server, MEMBERSHIP.server.address, 'the event’s extra address is ignored')
  assert.equal(s.legs[0].fingerprint, MEMBERSHIP.server.fingerprint)
  assert.equal(s.legs[0].tunnel, 't_1')
  assert.ok(s.legs[0].secret instanceof Secret)
  assert.deepEqual(s.remote.accepted, [{ grant: s.grant, phone: 'phoneA' }])
  assert.equal(refusals(s).length, 0)
})

test('each refusal condition refuses and opens no leg', async () => {
  const cases: [string, (s: Awaited<ReturnType<typeof withGrant>>) => void][] = [
    ['setting off', (s) => s.teamStore.updateMembership({ relay: false })],
    ['remote access off', (s) => (s.remote.on = false)],
    ['unknown grant', (s) => (s.grant = 'g_other')],
    ['phone unpaired', (s) => (s.remote.devices = [])],
    ['throttled', (s) => s.remote.throttled.add(s.grant)],
  ]
  for (const [name, change] of cases) {
    const s = await withGrant()
    change(s)
    incoming(s, { tunnel: 't_1', grant: s.grant, expiresAt: 0 })
    await tick()
    assert.equal(s.legs.length, 0, `${name}: no leg`)
    assert.equal(refusals(s).length, 1, `${name}: refused`)
  }
})

test('RELAY_DISABLED on a leg refuses later tunnels until a hello lists the relay', async () => {
  const s = await withGrant()
  incoming(s, { tunnel: 't_1', grant: s.grant, expiresAt: 0 })
  await tick()
  s.legs[0].onEnd({ kind: 'refused', code: 'RELAY_DISABLED' })
  incoming(s, { tunnel: 't_2', grant: s.grant, expiresAt: 0 })
  await tick()
  assert.equal(s.legs.length, 1)
  assert.equal(refusals(s).length, 1)
  s.team.connect()
  incoming(s, { tunnel: 't_3', grant: s.grant, expiresAt: 0 })
  await tick()
  assert.equal(s.legs.length, 2)
})

test('an expired expiresAt is not compared with this clock', async () => {
  const s = await withGrant()
  incoming(s, { tunnel: 't_1', grant: s.grant, expiresAt: 1 })
  await tick()
  assert.equal(s.legs.length, 1)
})

test('turning the Team feature off ends open legs; a team reconnect does not', async () => {
  const s = await withGrant()
  incoming(s, { tunnel: 't_1', grant: s.grant, expiresAt: 0 })
  await tick()
  assert.equal(s.service.openLegs, 1)
  s.team.drop()
  s.team.connect()
  assert.equal(s.service.openLegs, 1, 'a reconnect leaves it')
  s.teamStore.setEnabled(false)
  for (const l of s.team.changes) l({ enabled: false })
  assert.equal(s.service.openLegs, 0, 'control: leave legs open → red')
})

test('nothing but a phone’s tunnel request opens a leg', async () => {
  // Attention events, pairings, reconnects and setting changes never make the desktop dial (`remote-notifications`);
  // the only path to `openLeg` is `relay.incoming`. Control: dial on any of these → red.
  const s = await withGrant()
  s.remote.hello('phoneA')
  s.remote.pair('phoneB', 'Tab')
  s.team.drop()
  s.team.connect()
  s.service.setOn(false)
  s.service.setOn(true)
  await settle(s.service)
  for (const l of s.team.changes) l({ enabled: true })
  await tick()
  assert.equal(s.legs.length, 0)
})
