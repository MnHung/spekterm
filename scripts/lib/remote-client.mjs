import { connect as tlsConnect } from 'node:tls'
import WebSocket from 'ws'
import { pollFor } from './instrument.mjs'

/**
 * A test client that acts as the phone (`probe-remote.mjs`, `remote-client.test.mjs`).
 *
 * **It pins the certificate by its SHA-256 fingerprint and refuses anything else**, the way the Android app
 * must (`docs/remote-protocol.md`). The check runs twice: when the TLS handshake completes, before the
 * upgrade request is answered, and again on `open`, before the client sends a single frame. A client that
 * accepted any certificate would make every assertion about "only the paired desktop can be reached" green
 * against a man in the middle.
 *
 * Nothing secret is sent before both checks pass: the credential or pairing code goes in the first frame,
 * which is written only after `open`.
 */

/** `AB:CD:…` or `abcd…` → `ABCD…`, so the dialog's form, the link's form and Node's form compare equal. */
export function normalizeFingerprint(value) {
  return String(value ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase()
}

/** The fields of a `spekterm://pair?…` link (`remote-access`'s pairing link). */
export function parsePairingLink(link) {
  const url = new URL(link)
  if (url.protocol !== 'spekterm:' || url.host !== 'pair') throw new Error(`not a pairing link: ${link}`)
  const params = url.searchParams
  return {
    version: params.get('v'),
    addresses: (params.get('a') ?? '').split(',').filter(Boolean),
    port: Number(params.get('p')),
    fingerprint: normalizeFingerprint(params.get('fp')),
    code: params.get('c') ?? '',
    name: params.get('n') ?? '',
  }
}

/**
 * Opens a connection and resolves once it is open and the pin checked. Rejects when the certificate is
 * not the pinned one, or the connection fails.
 *
 * `answerPings: false` leaves the server's liveness pings unanswered (`remote-protocol`'s dead-connection
 * rule).
 */
export function openRemote({ host = '127.0.0.1', port, fingerprint, answerPings = true, path = '/v1' }) {
  const pin = normalizeFingerprint(fingerprint)
  let pinFailure = null
  /** Read at the handshake: after the upgrade the socket no longer reports its peer certificate (measured). */
  let seenAtHandshake = null
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${host}:${port}${path}`, {
      autoPong: answerPings,
      // The pin is the only trust: the certificate is self-signed and the address is whatever works.
      createConnection: (options) => {
        const tls = tlsConnect({ ...options, rejectUnauthorized: false })
        tls.once('secureConnect', () => {
          const seen = normalizeFingerprint(tls.getPeerX509Certificate()?.fingerprint256)
          seenAtHandshake = seen
          if (seen !== pin) {
            pinFailure = new Error(`certificate fingerprint ${seen} is not the pinned ${pin}`)
            tls.destroy(pinFailure)
          }
        })
        return tls
      },
    })
    socket.once('error', (error) => reject(pinFailure ?? error))
    socket.once('open', () => {
      if (seenAtHandshake !== pin) {
        socket.terminate()
        reject(new Error(`certificate fingerprint ${seenAtHandshake} is not the pinned ${pin}`))
        return
      }
      resolve(wrap(socket))
    })
  })
}

function wrap(socket) {
  let nextId = 1
  const waiting = new Map()
  const events = []
  let closeInfo = null
  const closed = new Promise((resolve) => {
    socket.once('close', (code, reason) => {
      closeInfo = { code, reason: String(reason) }
      for (const { reject } of waiting.values()) reject(new Error(`connection closed (${code})`))
      waiting.clear()
      resolve(closeInfo)
    })
  })
  socket.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    if (frame?.t === 'res') {
      const entry = waiting.get(frame.id)
      if (!entry) return
      waiting.delete(frame.id)
      entry.resolve(frame)
    } else if (frame?.t === 'evt') {
      events.push({ ...frame, receivedAt: Date.now() })
    }
  })

  /** Sends a request and resolves with the whole response frame (`{ ok, r }` or `{ ok, e }`). */
  const call = (m, p = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('connection is not open'))
        return
      }
      waiting.set(id, { resolve, reject })
      socket.send(JSON.stringify({ t: 'req', id, m, p }))
    })
  }

  return {
    call,
    /** Every event received so far, in order: `{ k, d, receivedAt }`. */
    events,
    /** Events of one kind received after index `from`. */
    eventsOf: (k, from = 0) => events.slice(from).filter((event) => event.k === k),
    /**
     * Waits for an event of kind `k`, received after index `from`, that satisfies `match`. Resolves with it,
     * or with `null` when the window runs out (the caller's assertion then says what was missing).
     */
    waitEvent: async (k, { match = () => true, from = 0, timeoutMs = 10_000, label } = {}) => {
      const found = await pollFor({
        read: () => events.slice(from).find((event) => event.k === k && match(event.d)) ?? null,
        settled: (event) => event !== null,
        timeoutMs,
        interval: 50,
        label: label ?? `event ${k}`,
      })
      return found ?? null
    },
    /** Resolves with `{ code, reason }` once the server or the client closed the connection. */
    closed,
    isOpen: () => socket.readyState === WebSocket.OPEN,
    closeInfo: () => closeInfo,
    close: () => socket.close(),
    /** Ends the connection with no close handshake, as a phone losing its network does. */
    drop: () => socket.terminate(),
  }
}

/** Opens a connection and pairs. Resolves with `{ client, response }`; the client is open when pairing succeeded. */
export async function pairRemote(target, { code, deviceName = 'Probe Phone', deviceModel = 'Probe', protocol = [1] }) {
  const client = await openRemote(target)
  const response = await client.call('pair', { protocol, code, deviceName, deviceModel })
  return { client, response }
}

/** Opens a connection and authenticates as a paired device. Resolves with `{ client, response }`. */
export async function helloRemote(target, { deviceId, deviceSecret, protocol = [1] }) {
  const client = await openRemote(target)
  const response = await client.call('hello', { protocol, deviceId, deviceSecret })
  return { client, response }
}
