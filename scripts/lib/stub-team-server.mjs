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
 *
 * Teammate handoffs (`teammate-handoff`): `handoff.send` is answered as protocol §5 says (a resend with the same
 * `clientId` answers the stored handoff with `duplicate: true`); `handoff.received` is answered `{}` unless
 * `state.holdReceived` keeps it pending until `releaseReceived(answer)`; `push(data)` sends a `handoff.incoming`
 * event to every open connection. `sends` and `acks` record what the app sent.
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
    operations: ['device.rename', 'device.leave', 'team.members', 'handoff.send', 'handoff.received'],
    deviceName: 'laptop',
    respond: undefined,
    /** `handoff.received` is held, unanswered, until `releaseReceived`. */
    holdReceived: false,
    /** The answer to `handoff.received` for an id, when not held: `undefined` ⇒ `{}`. */
    received: undefined,
    /** Devices the recipient of a send has (0: the handoff waits until they add one). */
    recipientDevices: 1,
  }
}

export async function startStubTeamServer({ port }) {
  const cert = makeCert()
  const state = defaultState()
  const connections = { tcp: 0 }
  const tlsBytes = []
  const frames = []
  const sockets = []
  const sends = []
  const acks = []
  const held = []
  const stored = new Map()

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
      case 'handoff.send': {
        const to = String(p.to ?? '').toLowerCase()
        const recipient = state.members.find((x) => x.handle === to)
        if (!recipient) return { ok: false, e: { code: 'RECIPIENT_UNKNOWN', message: to } }
        if (recipient.id === state.member.id) return { ok: false, e: { code: 'RECIPIENT_IS_SELF', message: to } }
        const previous = stored.get(p.clientId)
        const handoff = previous ?? { id: `h_stub${stored.size + 1}`, status: 'pending', sentAt: Date.now(), expiresAt: Date.now() + 30 * 86_400_000 }
        stored.set(p.clientId, handoff)
        return { ok: true, r: { handoff, recipient: { ...recipient, deviceCount: state.recipientDevices }, duplicate: Boolean(previous) } }
      }
      case 'handoff.received': {
        if (state.holdReceived) return 'held'
        return state.received?.(String(p.id)) ?? { ok: true, r: {} }
      }
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
      // Recorded before any scripted answer: a dropped answer is still a request the server received.
      if (frame.m === 'handoff.send') sends.push(frame.p ?? {})
      if (frame.m === 'handoff.received') acks.push(String(frame.p?.id))
      const reply = answer(frame.m, frame.p ?? {}, socket)
      if (reply === 'silent') return
      if (reply === 'held') {
        held.push({ socket, id: frame.id })
        return
      }
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
    sends,
    acks,
    /** Answers every held `handoff.received` (on connections still open) with `answer`. */
    releaseReceived(answer = { ok: true, r: {} }) {
      for (const { socket, id } of held.splice(0)) {
        if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'res', id, ...answer }))
      }
    },
    /** Sends a `handoff.incoming` event to every open connection. */
    push(data) {
      for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'evt', k: 'handoff.incoming', d: data }))
    },
    async close() {
      for (const socket of wss.clients) socket.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
