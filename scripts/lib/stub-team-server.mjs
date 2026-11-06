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
 *
 * The way back (`teammate-handoff-return`): every sent handoff is a StatusRecord with its own `seq` from one
 * counter. `handoff.sync` pages them (`state.syncPageSize`; `state.syncReset` answers the next sync as a reset), and a
 * connection whose last sync answer said `more: false` receives `handoff.status` events. `setStatus(id, patch)`
 * changes a record (a new `seq`) and pushes it; `addRecord(record)` stores one sent from another device;
 * `closeAll(code)` closes every connection with a code (1011). `handoff.update` is recorded in `updates` and answered
 * `{ status }`, or by `state.respond`.
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
    operations: ['device.rename', 'device.leave', 'team.members', 'handoff.send', 'handoff.received', 'handoff.update', 'handoff.sync'],
    deviceName: 'laptop',
    respond: undefined,
    /** `handoff.received` is held, unanswered, until `releaseReceived`. */
    holdReceived: false,
    /** The answer to `handoff.received` for an id, when not held: `undefined` ⇒ `{}`. */
    received: undefined,
    /** Devices the recipient of a send has (0: the handoff waits until they add one). */
    recipientDevices: 1,
    /** Records per `handoff.sync` page. */
    syncPageSize: 100,
    /** The next `handoff.sync` is answered as a reset (`reset: true`, from 0). */
    syncReset: false,
    /** The relay's grants for this device (`phone-relay`): id → name. Answered only when listed in `operations`. */
    grants: new Map(),
    nextGrant: 1,
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
  /** StatusRecords by handoff id, and the one counter of their `seq` (protocol §10). */
  const records = new Map()
  let seq = 0
  /** Connections whose last `handoff.sync` answer said `more: false`: they receive `handoff.status`. */
  const subscribed = new Set()
  const updates = []
  const pushStatus = (record) => {
    for (const socket of subscribed) if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'evt', k: 'handoff.status', d: record }))
  }

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
        if (!previous) {
          seq += 1
          records.set(handoff.id, {
            seq, id: handoff.id, clientId: String(p.clientId), to: { id: recipient.id, handle: recipient.handle, displayName: recipient.displayName, removed: false },
            sentFrom: 'd_stub', status: 'pending', sentAt: handoff.sentAt, expiresAt: handoff.expiresAt, changedAt: handoff.sentAt,
          })
          // After the answer, as the server publishes (protocol §10).
          setTimeout(() => pushStatus(records.get(handoff.id)), 30)
        }
        const record = records.get(handoff.id)
        return { ok: true, r: { handoff: { ...handoff, status: record?.status ?? handoff.status, seq: record?.seq ?? 0 }, recipient: { ...recipient, deviceCount: state.recipientDevices }, duplicate: Boolean(previous) } }
      }
      case 'handoff.sync': {
        let after = typeof p.after === 'number' ? p.after : 0
        const reset = state.syncReset
        state.syncReset = false
        if (reset) after = 0
        const all = [...records.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq)
        const page = all.slice(0, state.syncPageSize)
        const more = all.length > page.length
        if (more) subscribed.delete(socket)
        else subscribed.add(socket)
        return { ok: true, r: { records: page, more, latest: seq, reset } }
      }
      case 'handoff.update': {
        const status = String(p.status)
        return { ok: true, r: { status } }
      }
      case 'handoff.received': {
        if (state.holdReceived) return 'held'
        return state.received?.(String(p.id)) ?? { ok: true, r: {} }
      }
      case 'relay.grant': {
        if (!state.operations.includes('relay.grant')) return { ok: false, e: { code: 'UNKNOWN_OPERATION', message: m } }
        const id = `g_stub${state.nextGrant++}`
        state.grants.set(id, String(p.name ?? ''))
        return { ok: true, r: { grant: { id, name: String(p.name ?? ''), createdAt: Date.now() }, secret: `grant-secret-${id}` } }
      }
      case 'relay.grants':
        if (!state.operations.includes('relay.grants')) return { ok: false, e: { code: 'UNKNOWN_OPERATION', message: m } }
        return { ok: true, r: { grants: [...state.grants.entries()].map(([id, name]) => ({ id, name, createdAt: 0 })) } }
      case 'relay.revoke':
        if (!state.operations.includes('relay.revoke')) return { ok: false, e: { code: 'UNKNOWN_OPERATION', message: m } }
        return { ok: true, r: { revoked: state.grants.delete(String(p.id)) } }
      case 'relay.refuse':
        return { ok: true, r: {} }
      case 'team.members':
        return { ok: true, r: { members: state.members.map((x) => ({ ...x, deviceCount: x.id === state.member.id ? state.deviceCount : 1 })) } }
      default:
        return { ok: false, e: { code: 'UNKNOWN_OPERATION', message: m } }
    }
  }

  wss.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('close', () => subscribed.delete(socket))
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
      if (frame.m === 'handoff.update') updates.push(frame.p ?? {})
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
    /** Every `handoff.update` the app sent, in order. */
    updates,
    /** The stored StatusRecord of a sent handoff, by id or `clientId`. */
    record: (key) => [...records.values()].find((r) => r.id === key || r.clientId === key) ?? null,
    /** Changes a sent handoff (a new `seq`) and pushes the record to subscribed connections. */
    setStatus(id, patch) {
      const current = records.get(id)
      if (!current) throw new Error(`no record ${id}`)
      seq += 1
      const next = { ...current, ...patch, seq, changedAt: Date.now() }
      records.set(id, next)
      pushStatus(next)
      return next
    },
    /** Stores a record as if another device of the member had sent it (no event: it is found by a sync). */
    addRecord(record) {
      seq += 1
      const next = { sentFrom: 'd_other', sentAt: Date.now(), expiresAt: Date.now() + 30 * 86_400_000, changedAt: Date.now(), ...record, seq }
      records.set(next.id, next)
      return next
    },
    /** Closes every open connection with a code (1011: status events could not be brought up to date). */
    closeAll(code, reason = '') {
      for (const socket of sockets) if (socket.readyState === 1) socket.close(code, reason)
    },
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
