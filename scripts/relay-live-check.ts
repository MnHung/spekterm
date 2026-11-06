/**
 * A live check of the phone relay (`phone-relay`, tasks 6.2 / 6.3) against a real spekterm-server checkout — not part
 * of `npm test`: it needs that checkout, takes minutes in `--slow`, and its numbers are recorded by hand in
 * `docs/lessons/team.md`.
 *
 *   SPEKTERM_SERVER_DIR=../spekterm-server node --import tsx scripts/relay-live-check.ts           # 6.2
 *   SPEKTERM_SERVER_DIR=../spekterm-server node --import tsx scripts/relay-live-check.ts --slow    # 6.3 (≈ 12 min)
 *
 * What runs: the server with `RELAY=on` on a temporary data directory and a self-signed certificate; spekterm's own
 * `TeamService` + `RelayService` + `RemoteServer` on a temporary profile, joined through a real invite; a phone
 * stand-in that pairs directly, then reaches the listener through `/relay` — outer WebSocket to the server pinned to
 * its certificate, inner TLS pinned to the listener, then `hello` — as the Android app does.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

import WebSocket, { createWebSocketStream } from 'ws'

// @ts-expect-error — the probe's phone stand-in is plain JavaScript.
import { normalizeFingerprint, pairRemote } from './lib/remote-client.mjs'
import { resultFrame } from '../src/main/remote-frames'
import { AddressThrottle, PairingCodes } from '../src/main/remote-pairing'
import { type RemoteConnection, RemoteServer } from '../src/main/remote-server'
import { RemoteStore } from '../src/main/remote-store'
import { RelayService } from '../src/main/relay-service'
import { SecretStore } from '../src/main/secret-store'
import { cutAndTerminate } from '../src/main/team-connection'
import { TeamService } from '../src/main/team-service'
import { TeamStore } from '../src/main/team-store'

const serverDir = process.env.SPEKTERM_SERVER_DIR
if (!serverDir) {
  console.error('SPEKTERM_SERVER_DIR is not set: point it at a spekterm-server checkout (0.4.0 or later).')
  process.exit(2)
}
const SLOW = process.argv.includes('--slow')
const MINUTES = Number(process.env.RELAY_CHECK_MINUTES ?? 3)
const CAP_KIB = 16

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as net.AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- The server ----

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-live-'))
const keyPath = path.join(work, 'key.pem')
const certPath = path.join(work, 'cert.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', keyPath, '-out', certPath,
], { stdio: 'ignore' })
const serverPort = await freePort()
const serverEnv = {
  ...process.env,
  RELAY: 'on',
  DATA_DIR: path.join(work, 'data'),
  PUBLIC_URL: `wss://localhost:${serverPort}`,
  PORT: String(serverPort),
  TLS_CERT: certPath,
  TLS_KEY: keyPath,
  ...(SLOW ? { RELAY_KIB_PER_SECOND: String(CAP_KIB) } : {}),
}
fs.mkdirSync(serverEnv.DATA_DIR, { recursive: true })
const server: ChildProcess = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: serverDir, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout?.on('data', (chunk) => (serverLog += chunk))
server.stderr?.on('data', (chunk) => (serverLog += chunk))

const cleanups: (() => Promise<void> | void)[] = []
async function finish(code: number): Promise<never> {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch {
      // Best effort.
    }
  }
  server.kill()
  fs.rmSync(work, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length > 0 ? 1 : code)
}

for (let i = 0; ; i++) {
  const up = await new Promise<boolean>((resolve) => {
    const socket = net.connect(serverPort, '127.0.0.1', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
  if (up) break
  if (i > 100) {
    console.error(`the server did not start:\n${serverLog}`)
    await finish(1)
  }
  await sleep(100)
}
const link = execFileSync('node', ['--disable-warning=ExperimentalWarning', 'src/admin.ts', 'invite', 'create'], { cwd: serverDir, env: serverEnv })
  .toString()
  .split('\n')
  .find((line) => line.startsWith('spekterm://join'))
if (!link) {
  console.error('no invite link from the admin command')
  await finish(1)
}
const serverFp = new URL(link as string).searchParams.get('fp')
check('the server is up with the relay on, and an invite was created', Boolean(link), `pinned: ${serverFp ? 'yes' : 'no'}`)

// ---- The desktop ----

const profile = path.join(work, 'profile')
fs.mkdirSync(profile)
const secrets = new SecretStore(path.join(profile, 'secrets.json'))
secrets.load()
const teamStore = new TeamStore(path.join(profile, 'team.json'))
const team = new TeamService({ store: teamStore, secrets, appVersion: 'live-check', notifyStop: () => undefined })
team.start()
team.setEnabled(true)

const remoteStore = new RemoteStore(path.join(profile, 'remote.json'), secrets)
remoteStore.load()
const listenerPort = await freePort()
remoteStore.setPort(listenerPort)
remoteStore.setEnabled(true)
const throttle = new AddressThrottle()
const pairing = new PairingCodes()
/** What each authenticated connection streams to its phone: set per case. */
let stream: { kibPerSecond: number; snapshotBytes: number } = { kibPerSecond: 0, snapshotBytes: 0 }
const connections: RemoteConnection[] = []
let relayProvider: ((id: string) => unknown) | null = null
const listener = new RemoteServer({
  store: remoteStore,
  pairing,
  throttle,
  serverInfo: () => ({ name: 'spekterm', version: 'live-check' }),
  addresses: () => ['127.0.0.1'],
  operations: () => ['terminal.watch'],
  authExtras: (deviceId) => {
    const relay = relayProvider?.(deviceId) ?? null
    return relay ? { relay } : {}
  },
  openSession: (connection) => {
    connections.push(connection)
    const { kibPerSecond, snapshotBytes } = stream
    // Terminal-like output: printable text that compresses the way a busy build log does not (hex of random bytes).
    if (snapshotBytes > 0) connection.send(JSON.stringify({ t: 'evt', k: 'terminal.output', d: { data: randomBytes(snapshotBytes / 2).toString('hex') } }))
    const timer =
      kibPerSecond > 0
        ? setInterval(() => {
            if (!connection.isOpen()) return
            connection.send(JSON.stringify({ t: 'evt', k: 'terminal.output', d: { data: randomBytes((kibPerSecond * 1024) / 20).toString('hex') } }))
          }, 100)
        : null
    return {
      onRequest: (frame) => connection.send(resultFrame(frame.id, { echo: frame.m })),
      dispose: () => {
        if (timer) clearInterval(timer)
      },
    }
  },
})
await listener.apply()
cleanups.push(() => listener.stop())

const relay = new RelayService({
  team,
  teamStore,
  secrets,
  remote: {
    pairedDevices: () => remoteStore.projectDevices().map(({ id, name }) => ({ id, name })),
    enabled: () => remoteStore.get().enabled,
    listening: () => listener.state().status === 'listening',
    relayThrottled: (grant) => throttle.blocked(`relay:${grant}`),
    acceptRelayed: (s, grant, phone) => listener.acceptRelayed(s, grant, phone),
    relayChanged: () => undefined,
    setRelayProvider: (provider) => (relayProvider = provider),
    onRelayInputs: () => () => undefined,
  },
})
relay.start()
cleanups.push(() => {
  relay.dispose()
  team.dispose()
})

const joined = await team.joinTeam({ link: link as string, deviceName: 'live-check desktop', handle: 'sam', displayName: 'Sam' })
check('the desktop joins the team', joined.ok, JSON.stringify(joined))
for (let i = 0; i < 100 && team.snapshot().status !== 'connected'; i++) await sleep(100)
check('the team connection is up and the server lists the relay', team.snapshot().status === 'connected' && team.operations().includes('relay.grant'), team.operations().join(','))

// ---- The phone pairs directly ----

const listenerFp = normalizeFingerprint(remoteStore.identity().fingerprint)
const { code } = pairing.start()
const paired = await pairRemote({ port: listenerPort, fingerprint: listenerFp }, { code, deviceName: 'Live Pixel' })
check('the phone pairs directly', paired.response.ok === true)
paired.client.close()
const phone = { deviceId: paired.response.r.deviceId as string, deviceSecret: paired.response.r.deviceSecret as string }

check('no relay leg is open before a phone asks', relay.openLegs === 0)
relay.setOn(true)
await relay.reconcile()
const grant = relay.relayFor(phone.deviceId)
check('turning the relay on gives the phone a grant for this server', grant !== null && grant.url === `wss://localhost:${serverPort}`, JSON.stringify({ url: grant?.url, fp: grant?.fp ? 'present' : 'absent' }))
if (!grant) await finish(1)

// ---- Through the relay ----

interface RelayedPhone {
  ws: WebSocket
  closed: Promise<{ code: number; at: number }>
  received: () => number
  hello: Record<string, unknown>
}

/** As the Android app: outer WebSocket pinned to the server, cut writes, inner TLS pinned to the listener, `hello`. */
async function relayedPhone(): Promise<RelayedPhone> {
  const g = grant as NonNullable<typeof grant>
  const outer = new WebSocket(`${g.url}/relay`, {
    perMessageDeflate: false,
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  })
  outer.on('upgrade', (response) => {
    const cert = (response.socket as tls.TLSSocket).getPeerX509Certificate()
    const fp = cert ? createHash('sha256').update(cert.raw).digest('hex').toUpperCase() : ''
    if (g.fp && fp !== g.fp.toUpperCase()) outer.terminate()
  })
  await new Promise((resolve, reject) => {
    outer.once('open', resolve)
    outer.once('error', reject)
  })
  outer.send(JSON.stringify({ t: 'req', id: 1, m: 'relay.open', p: { protocol: [1], grant: g.grant, secret: g.secret } }))
  const answer = await new Promise<Record<string, unknown>>((resolve) => outer.once('message', (data) => resolve(JSON.parse(String(data)))))
  if (answer.ok !== true) throw new Error(`relay.open refused: ${JSON.stringify(answer)}`)
  const bytes = cutAndTerminate(createWebSocketStream(outer), outer)
  outer.once('close', () => bytes.destroy())
  const socket = tls.connect({ socket: bytes, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => {
      const der = socket.getPeerX509Certificate()?.raw
      const fp = der ? createHash('sha256').update(der).digest('hex').toUpperCase() : ''
      if (fp !== listenerFp) reject(new Error('inner pin mismatch'))
      else resolve()
    })
    socket.once('error', reject)
  })
  const inner = new WebSocket('wss://desktop/v1', { createConnection: () => socket, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    inner.once('open', resolve)
    inner.once('error', reject)
  })
  let received = 0
  let helloAnswer: Record<string, unknown> | null = null
  const hello = new Promise<Record<string, unknown>>((resolve) => {
    inner.on('message', (data) => {
      const buffer = data as Buffer
      received += buffer.length
      if (!helloAnswer) {
        helloAnswer = JSON.parse(String(buffer))
        resolve(helloAnswer as Record<string, unknown>)
      }
    })
  })
  const closed = new Promise<{ code: number; at: number }>((resolve) => inner.once('close', (code) => resolve({ code, at: Date.now() })))
  inner.on('error', () => undefined)
  inner.send(JSON.stringify({ t: 'req', id: 1, m: 'hello', p: { protocol: [1], ...phone } }))
  return { ws: inner, closed, received: () => received, hello: await hello }
}

if (!SLOW) {
  stream = { kibPerSecond: 0, snapshotBytes: 1024 * 1024 }
  const relayed = await relayedPhone()
  const r = (relayed.hello.r ?? {}) as Record<string, unknown>
  check('through the relay, the phone authenticates with hello', relayed.hello.ok === true, JSON.stringify(Object.keys(r)))
  check('the relayed hello answer carries the phone’s grant', JSON.stringify(r.relay) === JSON.stringify(grant))
  check('one relay leg is open once the phone’s tunnel is accepted', relay.openLegs === 1, `legs ${relay.openLegs}`)
  check('the listener sees the connection as relayed', connections.at(-1)?.relayed === true)
  for (let i = 0; i < 100 && relayed.received() < 1024 * 1024; i++) await sleep(100)
  check('a 1 MiB message from the listener crosses the relay whole', relayed.received() >= 1024 * 1024, `${relayed.received()} bytes`)
  relayed.ws.send(JSON.stringify({ t: 'req', id: 2, m: 'terminal.watch', p: { pad: randomBytes(450 * 1024).toString('hex') } }))
  await sleep(1500)
  check('a 900 KiB message from the phone crosses and the tunnel stays open', relayed.ws.readyState === WebSocket.OPEN)
  relayed.ws.terminate()
  await finish(0)
}

// ---- --slow: the listener's keepalive through a 16 KiB/s relay (design D9) ----

/** A direct path throttled like the relay: a TCP proxy that passes at most `kib` KiB/s each way. */
async function throttledProxy(kib: number): Promise<{ port: number; close: () => Promise<void> }> {
  const proxy = net.createServer((client) => {
    const upstream = net.connect(listenerPort, '127.0.0.1')
    const pace = (from: net.Socket, to: net.Socket) => {
      let budget = kib * 1024
      const refill = setInterval(() => {
        budget = Math.min(kib * 1024, budget + (kib * 1024) / 10)
        if (budget > 0 && from.isPaused()) from.resume()
      }, 100)
      from.on('data', (chunk: Buffer) => {
        budget -= chunk.length
        to.write(chunk)
        if (budget <= 0) from.pause()
      })
      from.on('close', () => {
        clearInterval(refill)
        to.destroy()
      })
      from.on('error', () => undefined)
    }
    pace(client, upstream)
    pace(upstream, client)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
  return { port: (proxy.address() as net.AddressInfo).port, close: () => new Promise((resolve) => proxy.close(() => resolve())) }
}

async function directPhone(port: number): Promise<{ ws: WebSocket; closed: Promise<{ code: number; at: number }> }> {
  const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
  await new Promise((resolve) => socket.once('secureConnect', resolve))
  const ws = new WebSocket('wss://desktop/v1', { createConnection: () => socket, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve) => ws.once('open', resolve))
  const closed = new Promise<{ code: number; at: number }>((resolve) => ws.once('close', (code) => resolve({ code, at: Date.now() })))
  ws.on('error', () => undefined)
  ws.send(JSON.stringify({ t: 'req', id: 1, m: 'hello', p: { protocol: [1], ...phone } }))
  return { ws, closed }
}

async function hold(what: string, closed: Promise<{ code: number; at: number }>): Promise<string> {
  const started = Date.now()
  const outcome = await Promise.race([closed, sleep(MINUTES * 60_000).then(() => null)])
  return outcome ? `${what}: closed with ${outcome.code} after ${Math.round((outcome.at - started) / 1000)} s` : `${what}: open after ${MINUTES} min`
}

console.log(`--slow: relay capped at ${CAP_KIB} KiB/s per direction, ${MINUTES} min per case`)

stream = { kibPerSecond: 8, snapshotBytes: 0 }
const below = await relayedPhone()
const belowResult = await hold('relayed, output ≈ 8 KiB/s', below.closed)
check('below the cap, the relayed connection is not dropped for missed pings', belowResult.endsWith('min'), belowResult)
below.ws.terminate()

stream = { kibPerSecond: 64, snapshotBytes: 0 }
const above = await relayedPhone()
const proxy = await throttledProxy(CAP_KIB)
const direct = await directPhone(proxy.port)
const [aboveRelayed, aboveDirect] = await Promise.all([hold('relayed, output ≈ 64 KiB/s', above.closed), hold('direct through a 16 KiB/s proxy, output ≈ 64 KiB/s', direct.closed)])
check('above the cap (recorded)', true, `${aboveRelayed}; ${aboveDirect}`)
above.ws.terminate()
direct.ws.terminate()
await proxy.close()

stream = { kibPerSecond: 8, snapshotBytes: 1024 * 1024 }
const snapshot = await relayedPhone()
const snapshotResult = await hold('relayed, a 1 MiB snapshot then ≈ 8 KiB/s', snapshot.closed)
check('a reconnect with a full snapshot (recorded)', true, snapshotResult)
snapshot.ws.terminate()

await finish(0)
