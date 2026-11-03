import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import util from 'node:util'

import { SecretStore } from './secret-store'
import { SECRET_NAME, type TeamService as TeamServiceType, TeamService } from './team-service'
import { type Handler, makeCert, startTestServer, type TestServer } from './team-server.testkit'
import { TeamStore } from './team-store'
import type { StopReason } from './team-outcome'

const CERT = makeCert()
const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface Rig {
  service: TeamServiceType
  store: TeamStore
  secrets: SecretStore
  server: TestServer
  notified: { reason: StopReason; team: string }[]
  dir: string
  link: string
}

function joinAnswer(deviceCount = 1) {
  return {
    ok: true as const,
    r: {
      protocol: 1,
      server: { name: 'spekterm-server', version: '0.2.1' },
      operations: ['device.rename', 'device.leave', 'team.members'],
      team: { name: 'Acme' },
      member: { id: 'm_1', handle: 'sam', displayName: 'Sam', deviceCount },
      device: { id: 'd_1', name: 'laptop' },
      deviceId: 'd_1',
      deviceSecret: 'PLAINTEXT-SECRET',
    },
  }
}

/** A server that behaves like spekterm-server for the happy path; individual tests override `respond`. */
function serverHandler(state: { respond?: Handler; deviceCount?: number }): Handler {
  return (m, p, socket) => {
    const custom = state.respond?.(m, p, socket)
    if (custom !== undefined) return custom
    switch (m) {
      case 'invite.inspect':
        return { ok: true, r: { protocol: 1, kind: 'member', team: { name: 'Acme' }, expiresAt: 1 } }
      case 'join':
        return joinAnswer(state.deviceCount)
      case 'hello': {
        const { deviceSecret: _s, deviceId: _d, ...rest } = joinAnswer(state.deviceCount).r
        return { ok: true, r: rest }
      }
      case 'team.members':
        return { ok: true, r: { members: [{ id: 'm_1', handle: 'sam', displayName: 'Sam', deviceCount: state.deviceCount ?? 1 }] } }
      case 'device.leave':
        setTimeout(() => socket.close(4004), 10)
        return { ok: true, r: { memberRemoved: (state.deviceCount ?? 1) === 1 } }
      case 'device.rename':
        return { ok: true, r: { device: { id: 'd_1', name: String(p.name).trim() } } }
      default:
        return { ok: false, e: { code: 'UNKNOWN_OPERATION' } }
    }
  }
}

async function rig(state: { respond?: Handler; deviceCount?: number } = {}): Promise<Rig> {
  const server = await startTestServer(CERT, serverHandler(state))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-service-'))
  const store = new TeamStore(path.join(dir, 'team.json'))
  const secrets = new SecretStore(path.join(dir, 'secrets.json'))
  secrets.load()
  const notified: Rig['notified'] = []
  const service = new TeamService({
    store,
    secrets,
    appVersion: '1.0.0',
    notifyStop: (reason, team) => notified.push({ reason, team }),
    testing: { baseDelayMs: 20, stableMs: 200, random: () => 0.5 },
  })
  const link = `spekterm://join?v=1&s=${encodeURIComponent(server.server)}&c=${CODE}&fp=${CERT.fingerprint}`
  return { service, store, secrets, server, notified, dir, link }
}

async function joined(state: { respond?: Handler; deviceCount?: number } = {}): Promise<Rig> {
  const r = await rig(state)
  r.service.start()
  r.service.setEnabled(true)
  const result = await r.service.joinTeam({ link: r.link, deviceName: 'laptop', handle: 'sam', displayName: 'Sam' })
  assert.deepEqual(result, { ok: true })
  return r
}

test('joining stores the secret, then the membership, and connects', async () => {
  const r = await joined()
  assert.equal(r.service.snapshot().status, 'connected')
  assert.equal(r.secrets.get(SECRET_NAME)?.reveal(), 'PLAINTEXT-SECRET')
  assert.equal(r.store.get().membership?.server.address, r.server.server)
  assert.doesNotMatch(JSON.stringify(r.service.snapshot()), /PLAINTEXT-SECRET/)
  assert.doesNotMatch(util.inspect(r.service.snapshot(), { depth: 6 }), /PLAINTEXT-SECRET/)
  r.service.dispose()
  await r.server.close()
})

test('a membership with the feature off opens no connection', async () => {
  const r = await joined()
  await until(() => r.server.frames.some((f) => f.m === 'team.members'))
  r.service.setEnabled(false)
  r.service.dispose()
  const frames = r.server.frames.length
  const again = new TeamService({ store: new TeamStore(path.join(r.dir, 'team.json')), secrets: r.secrets, appVersion: '1.0.0', notifyStop: () => {} })
  again.start()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(again.snapshot().status, 'off')
  assert.equal(r.server.frames.length, frames)
  await r.server.close()
})

test('a dropped connection is reconnected', async () => {
  const r = await joined()
  const hellosBefore = r.server.frames.filter((f) => f.m === 'hello').length
  for (const socket of r.server.sockets) socket.terminate()
  await until(() => r.server.frames.filter((f) => f.m === 'hello').length > hellosBefore && r.service.snapshot().status === 'connected')
  r.service.dispose()
  await r.server.close()
})

test('a revocation discards the credential, notifies once, and stops', async () => {
  const r = await joined()
  for (const socket of r.server.sockets) socket.close(4004)
  await until(() => r.service.snapshot().status === 'unjoined')
  assert.equal(r.secrets.has(SECRET_NAME), false)
  assert.equal(r.store.get().membership, null)
  assert.equal(r.store.get().stop?.deviceName, 'laptop')
  assert.deepEqual(r.notified, [{ reason: 'REVOKED', team: 'Acme' }])
  const hellos = r.server.frames.filter((f) => f.m === 'hello').length
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(r.server.frames.filter((f) => f.m === 'hello').length, hellos)
  r.service.dispose()
  await r.server.close()
})

test('a device revoked while offline finds out at hello', async () => {
  const state: { respond?: Handler } = {}
  const r = await joined(state)
  r.service.dispose()
  state.respond = (m) => (m === 'hello' ? { ok: false, e: { code: 'AUTH_FAILED' } } : undefined) as never
  const again = new TeamService({ store: r.store, secrets: r.secrets, appVersion: '1.0.0', notifyStop: (reason) => r.notified.push({ reason, team: '' }) })
  again.start()
  await until(() => again.snapshot().status === 'unjoined')
  assert.equal(r.secrets.has(SECRET_NAME), false)
  again.dispose()
  await r.server.close()
})

test('4006 stops and does not reconnect by itself; Reconnect does', async () => {
  const r = await joined()
  for (const socket of r.server.sockets) socket.close(4006)
  await until(() => r.service.snapshot().status === 'stopped')
  assert.equal(r.service.snapshot().reason, 'REPLACED')
  const hellos = r.server.frames.filter((f) => f.m === 'hello').length
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(r.server.frames.filter((f) => f.m === 'hello').length, hellos)
  assert.equal(r.notified.length, 1)
  r.service.reconnect()
  await until(() => r.service.snapshot().status === 'connected')
  r.service.dispose()
  await r.server.close()
})

test('a stop is not notified again at the next start', async () => {
  const r = await joined()
  for (const socket of r.server.sockets) socket.close(4006)
  await until(() => r.service.snapshot().status === 'stopped')
  r.service.dispose()
  const notified: string[] = []
  const again = new TeamService({ store: r.store, secrets: r.secrets, appVersion: '1.0.0', notifyStop: (reason) => notified.push(reason) })
  again.start()
  assert.equal(again.snapshot().status, 'stopped')
  assert.deepEqual(notified, [])
  await r.server.close()
})

test('an abandoned connection’s late close does not disturb the next one', async () => {
  // Fake connections, so the old one's close can be made to arrive after the new one authenticated — the shape
  // \`ws\`'s 30-second closing handshake used to produce.
  const r = await joined()
  r.service.dispose()
  const opened: { onEnd: (e: unknown) => void }[] = []
  const fake = (options: { onEnd: (e: unknown) => void }) => {
    opened.push(options)
    return Promise.resolve({
      hello: async () => ({ ok: true, r: { operations: ['team.members'] } }),
      markAuthenticated: () => {},
      request: async () => ({ ok: true, r: { members: [] } }),
      terminate: () => {},
    } as never)
  }
  const service = new TeamService({
    store: r.store,
    secrets: r.secrets,
    appVersion: '1.0.0',
    notifyStop: () => {},
    testing: { open: fake as never, baseDelayMs: 20, random: () => 0.5 },
  })
  service.start()
  await until(() => service.snapshot().status === 'connected')
  service.resume()
  await until(() => opened.length === 2 && service.snapshot().status === 'connected')
  opened[0].onEnd({ kind: 'closed', code: 1006 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(service.snapshot().status, 'connected')
  assert.equal(opened.length, 2, 'no third connection')
  service.dispose()
  await r.server.close()
})

test('a failure right after hello does not reconnect in a tight loop', async () => {
  const state: { respond?: Handler } = {}
  const r = await joined(state)
  state.respond = (m, _p, socket) => {
    if (m === 'hello') setTimeout(() => socket.terminate(), 5)
    return undefined as never
  }
  for (const socket of r.server.sockets) socket.terminate()
  const waits: number[] = []
  const off = r.service.onChange((s) => {
    if (s.status === 'reconnecting' && s.nextAt) waits.push(s.nextAt - Date.now())
  })
  await until(() => waits.length >= 4, 5000)
  off()
  assert.ok(waits[3] > waits[0] * 3, `waits grow: ${waits.join(', ')}`)
  r.service.dispose()
  await r.server.close()
})

test('a version mismatch names the older side and does not retry', async () => {
  const state: { respond?: Handler } = {}
  const r = await joined(state)
  state.respond = (m) =>
    (m === 'hello' ? { ok: false, e: { code: 'UNSUPPORTED_VERSION', detail: { supported: [2] } } } : undefined) as never
  for (const socket of r.server.sockets) socket.terminate()
  await until(() => r.service.snapshot().status === 'stopped')
  assert.equal(r.service.snapshot().reason, 'UNSUPPORTED_VERSION')
  assert.equal(r.service.snapshot().olderSide, 'spekterm')
  r.service.dispose()
  await r.server.close()
})

test('a membership whose secret is missing stops without discarding or notifying', async () => {
  const r = await joined()
  await until(() => r.server.frames.some((f) => f.m === 'team.members'))
  r.service.dispose()
  r.secrets.clear(SECRET_NAME)
  const frames = r.server.frames.length
  const notified: string[] = []
  const again = new TeamService({ store: r.store, secrets: r.secrets, appVersion: '1.0.0', notifyStop: (reason) => notified.push(reason) })
  again.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(again.snapshot().status, 'stopped')
  assert.equal(again.snapshot().reason, 'CREDENTIAL_UNAVAILABLE')
  assert.notEqual(r.store.get().membership, null)
  assert.equal(r.server.frames.length, frames, 'no hello was sent')
  assert.deepEqual(notified, [])
  await r.server.close()
})

test('a secret with no membership is removed at start', async () => {
  const r = await rig()
  r.secrets.set(SECRET_NAME, 'orphan')
  r.service.start()
  assert.equal(r.secrets.has(SECRET_NAME), false)
  await r.server.close()
})

test('a credential that cannot be stored sends device.leave and leaves no membership', async () => {
  const r = await rig()
  r.service.start()
  r.service.setEnabled(true)
  // A directory where the membership file's temporary file goes makes that write fail.
  fs.mkdirSync(path.join(r.dir, 'team.json.tmp'))
  const result = await r.service.joinTeam({ link: r.link, deviceName: 'laptop', handle: 'sam', displayName: 'Sam' })
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error, 'NOT_STORED')
  assert.ok(r.server.frames.some((f) => f.m === 'device.leave'))
  assert.equal(r.secrets.has(SECRET_NAME), false)
  assert.equal(r.store.get().membership, null)
  r.service.dispose()
  await r.server.close()
})

test('a lost join answer is reported and not retried', async () => {
  const state: { respond?: Handler } = {
    respond: (m, _p, socket) => {
      if (m === 'join') {
        socket.terminate()
        return 'silent'
      }
      return undefined as never
    },
  }
  const r = await rig(state)
  r.service.start()
  r.service.setEnabled(true)
  const result = await r.service.joinTeam({ link: r.link, deviceName: 'laptop', handle: 'sam', displayName: 'Sam' })
  assert.deepEqual(result, { ok: false, error: 'LOST_ANSWER', deviceName: 'laptop' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(r.server.frames.filter((f) => f.m === 'join').length, 1)
  assert.equal(r.store.get().membership, null)
  r.service.dispose()
  await r.server.close()
})

test('a taken handle keeps the invite usable and the device unchanged', async () => {
  let taken = true
  const state: { respond?: Handler } = {
    respond: (m, p) => (m === 'join' && taken && p.handle === 'sam' ? { ok: false, e: { code: 'HANDLE_TAKEN' } } : undefined) as never,
  }
  const r = await rig(state)
  r.service.start()
  r.service.setEnabled(true)
  const first = await r.service.joinTeam({ link: r.link, deviceName: 'laptop', handle: 'sam', displayName: 'Sam' })
  assert.equal(!first.ok && first.error, 'HANDLE_TAKEN')
  assert.equal(r.service.snapshot().status, 'unjoined')
  taken = false
  const second = await r.service.joinTeam({ link: r.link, deviceName: 'laptop', handle: 'sam2', displayName: 'Sam' })
  assert.deepEqual(second, { ok: true })
  r.service.dispose()
  await r.server.close()
})

test('inspecting does not redeem, and its pin is checked', async () => {
  const r = await rig()
  r.service.start()
  const result = await r.service.inspect(r.link)
  assert.equal(result.ok && result.team, 'Acme')
  assert.equal(r.server.frames.filter((f) => f.m === 'join').length, 0)
  const wrongPin = r.link.replace(CERT.fingerprint, 'B'.repeat(64))
  assert.deepEqual(await r.service.inspect(wrongPin), { ok: false, error: 'PIN_MISMATCH' })
  assert.deepEqual(await r.service.inspect('spekterm://join?v=1&s=https%3A%2F%2Fx&c=' + CODE), { ok: false, error: 'INVALID_LINK' })
  await r.server.close()
})

test('leaving from the last device completes quietly, also with the answer lost', async () => {
  const state: { respond?: Handler; deviceCount?: number } = {}
  const r = await joined(state)
  assert.deepEqual(await r.service.leavePreview(), { deviceCount: 1 })
  const result = await r.service.leave()
  assert.deepEqual(result, { ok: true, memberRemoved: true })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(r.store.get().membership, null)
  assert.deepEqual(r.notified, [])
  r.service.dispose()
  await r.server.close()

  const lost: { respond?: Handler } = {}
  const r2 = await joined(lost)
  lost.respond = (m, _p, socket) => {
    if (m === 'device.leave') {
      socket.terminate()
      return 'silent'
    }
    if (m === 'hello') return { ok: false, e: { code: 'AUTH_FAILED' } }
    return undefined as never
  }
  await r2.service.leave()
  await until(() => r2.store.get().membership === null)
  assert.deepEqual(r2.notified, [])
  r2.service.dispose()
  await r2.server.close()
})

test('leave preview uses a members list fetched now', async () => {
  const state: { deviceCount?: number } = { deviceCount: 1 }
  const r = await joined(state)
  state.deviceCount = 2
  assert.deepEqual(await r.service.leavePreview(), { deviceCount: 2 })
  r.service.dispose()
  await r.server.close()
})

test('a renamed device keeps the server’s name', async () => {
  const r = await joined()
  assert.deepEqual(await r.service.rename('  desk  '), { ok: true })
  assert.equal(r.store.get().membership?.device.name, 'desk')
  r.service.dispose()
  await r.server.close()
})

test('members are normalized and kept', async () => {
  const r = await joined({
    respond: (m) =>
      (m === 'team.members'
        ? { ok: true, r: { members: [{ id: 'm_2', handle: 'alex', displayName: 'Al‮ex\nLee', deviceCount: 1 }] } }
        : undefined) as never,
  })
  await until(() => (r.store.get().membership?.members?.list.length ?? 0) > 0)
  assert.equal(r.store.get().membership?.members?.list[0].displayName, 'Alex Lee')
  r.service.dispose()
  await r.server.close()
})

test('a server without rename refuses the rename locally', async () => {
  const r = await joined({
    respond: (m) => {
      if (m === 'hello' || m === 'join') {
        const answer = joinAnswer()
        answer.r.operations = ['team.members']
        if (m === 'hello') {
          const { deviceSecret: _s, ...rest } = answer.r
          return { ok: true, r: rest }
        }
        return answer
      }
      return undefined as never
    },
  })
  assert.deepEqual(await r.service.rename('x'), { ok: false, error: 'NOT_OFFERED' })
  r.service.dispose()
  await r.server.close()
})

test('turning the feature off closes the connection and keeps the membership; on again reconnects', async () => {
  const r = await joined()
  r.service.setEnabled(false)
  await until(() => r.server.sockets.every((socket) => socket.readyState !== 1))
  assert.equal(r.service.snapshot().status, 'off')
  assert.notEqual(r.store.get().membership, null)
  assert.equal(r.secrets.has(SECRET_NAME), true)
  const joins = r.server.frames.filter((f) => f.m === 'join').length
  r.service.setEnabled(true)
  await until(() => r.service.snapshot().status === 'connected')
  assert.equal(r.server.frames.filter((f) => f.m === 'join').length, joins, 'no invite asked for')
  r.service.dispose()
  await r.server.close()
})
