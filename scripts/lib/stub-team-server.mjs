/**
 * A stand-in team server for `probe:team` (`team-membership`): a real TLS WebSocket server on 127.0.0.1 with a
 * self-signed certificate, speaking the parts of spekterm-server's protocol v1 the app uses (`invite.inspect`,
 * `join`, `hello`, `device.rename`, `device.leave`, `team.members`). The app trusts it through the invite's pinned
 * fingerprint — the self-signed path, which is the one a team on a private network uses.
 *
 * **It can drift from the real server.** Its answers follow protocol.md, not the server's code; the dogfood task
 * against spekterm-server 0.2.1 is what checks the two agree.
 *
 * Recorded for the probe: every TCP connection, the bytes each TLS session received (so "no application data
 * before the certificate check" is observable), and every request frame. `state.respond(m, p, socket)` overrides
 * an answer: return an answer object, `'silent'` to answer nothing, or `undefined` for the default.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocketServer } from 'ws'

export const STUB_INVITE_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const STUB_DEVICE_SECRET = 'STUB-DEVICE-SECRET-3f9c2a71-do-not-leak'

function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-team-cert-'))
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')],
      { stdio: 'ignore' },
    )
    const certPem = readFileSync(join(dir, 'c.pem'), 'utf8')
    const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ''), 'base64')
    return { keyPem: readFileSync(join(dir, 'k.pem'), 'utf8'), certPem, fingerprint: createHash('sha256').update(der).digest('hex').toUpperCase() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The default team the stub answers for. `deviceCount` and `members` are mutable through `state`. */
function defaultState() {
  return {
    team: 'Acme',
    member: { id: 'm_sam', handle: 'sam', displayName: 'Sam' },
    deviceCount: 1,
    inviteKind: 'member',
    members: [
      { id: 'm_sam', handle: 'sam', displayName: 'Sam' },
      { id: 'm_alex', handle: 'alex', displayName: 'Alex' },
    ],
    operations: ['device.rename', 'device.leave', 'team.members'],
    deviceName: 'laptop',
    respond: undefined,
  }
}

export async function startStubTeamServer({ port }) {
  const cert = makeCert()
  const state = defaultState()
  const connections = { tcp: 0 }
  const tlsBytes = []
  const frames = []
  const sockets = []

  const server = https.createServer({ key: cert.keyPem, cert: cert.certPem })
  server.on('connection', () => (connections.tcp += 1))
  server.on('secureConnection', (tlsSocket) => {
    const index = tlsBytes.push(0) - 1
    tlsSocket.on('data', (chunk) => (tlsBytes[index] += chunk.length))
  })
  const wss = new WebSocketServer({ server, path: '/connect' })

  const answer = (m, p, socket) => {
    const custom = state.respond?.(m, p, socket)
    if (custom !== undefined) return custom
    const member = { ...state.member, deviceCount: state.deviceCount }
    const authenticated = {
      protocol: 1,
      server: { name: 'spekterm-server', version: 'stub' },
      operations: state.operations,
      team: { name: state.team },
      member,
      device: { id: 'd_stub', name: state.deviceName },
    }
    switch (m) {
      case 'invite.inspect':
        return {
          ok: true,
          r: {
            protocol: 1,
            kind: state.inviteKind,
            team: { name: state.team },
            expiresAt: Date.now() + 7 * 86_400_000,
            ...(state.inviteKind === 'device' ? { member: { handle: state.member.handle, displayName: state.member.displayName } } : {}),
          },
        }
      case 'join':
        state.deviceName = String(p.deviceName ?? state.deviceName)
        return { ok: true, r: { ...authenticated, device: { id: 'd_stub', name: state.deviceName }, deviceId: 'd_stub', deviceSecret: STUB_DEVICE_SECRET } }
      case 'hello':
        return p.deviceSecret === STUB_DEVICE_SECRET ? { ok: true, r: authenticated } : { ok: false, e: { code: 'AUTH_FAILED', message: 'no' } }
      case 'device.rename':
        state.deviceName = String(p.name ?? '').trim()
        return { ok: true, r: { device: { id: 'd_stub', name: state.deviceName } } }
      case 'device.leave':
        setTimeout(() => socket.close(4004, 'left'), 20)
        return { ok: true, r: { memberRemoved: state.deviceCount <= 1 } }
      case 'team.members':
        return { ok: true, r: { members: state.members.map((x) => ({ ...x, deviceCount: x.id === state.member.id ? state.deviceCount : 1 })) } }
      default:
        return { ok: false, e: { code: 'UNKNOWN_OPERATION', message: m } }
    }
  }

  wss.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      frames.push({ m: frame.m, p: frame.p ?? {} })
      const reply = answer(frame.m, frame.p ?? {}, socket)
      if (reply === 'silent') return
      socket.send(JSON.stringify({ t: 'res', id: frame.id, ...reply }))
    })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = `wss://localhost:${port}`
  const link = ({ fingerprint = cert.fingerprint, server: s = address } = {}) =>
    `spekterm://join?v=1&s=${encodeURIComponent(s)}&c=${STUB_INVITE_CODE}${fingerprint ? `&fp=${fingerprint}` : ''}`

  return {
    address,
    fingerprint: cert.fingerprint,
    state,
    connections,
    tlsBytes,
    frames,
    link,
    /** The connections the app holds now. */
    openSockets: () => sockets.filter((socket) => socket.readyState === 1),
    count: (m) => frames.filter((frame) => frame.m === m).length,
    async close() {
      for (const socket of wss.clients) socket.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
