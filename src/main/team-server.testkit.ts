import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

import { WebSocketServer, type WebSocket } from 'ws'

/**
 * A throwaway team server for the unit tests (`team-membership`): HTTPS + `ws` on 127.0.0.1, a self-signed
 * certificate for `localhost` (with a SAN, so the unpinned path can verify the host name against it), and a handler
 * per request. It records every byte each TLS connection received, so "nothing is sent before the check" is
 * observable.
 */

export interface TestCert {
  keyPem: string
  certPem: string
  /** SHA-256 over DER, upper-case hex without separators (the invite's `fp`). */
  fingerprint: string
}

export function makeCert(commonName = 'localhost'): TestCert {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-cert-'))
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', `/CN=${commonName}`, '-addext', `subjectAltName=DNS:${commonName}`, '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' })
  const certPem = fs.readFileSync(cert, 'utf8')
  const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ''), 'base64')
  return { keyPem: fs.readFileSync(key, 'utf8'), certPem, fingerprint: createHash('sha256').update(der).digest('hex').toUpperCase() }
}

export type Handler = (m: string, p: Record<string, unknown>, socket: WebSocket) =>
  | { ok: true; r: unknown }
  | { ok: false; e: { code: string; message?: string; detail?: Record<string, unknown> } }
  | 'silent'

export interface TestServer {
  server: string
  /** Bytes received per TLS connection, in order of connection. */
  received: number[]
  frames: { m: string; p: Record<string, unknown> }[]
  sockets: WebSocket[]
  /**
   * The server side of each `/relay` connection (`phone-relay`), in order. Its first text frame goes to the handler
   * like any request; after an ok answer it carries binary messages, at most 256 KiB each (over it: 1009), as
   * spekterm-server's relay does. `relayMessages` records each binary message's size per leg.
   */
  relayLegs: WebSocket[]
  relayMessages: number[][]
  setHandler(handler: Handler): void
  close(): Promise<void>
}

export async function startTestServer(cert: TestCert, handler: Handler): Promise<TestServer> {
  let current = handler
  const received: number[] = []
  const frames: TestServer['frames'] = []
  const sockets: WebSocket[] = []
  const relayLegs: WebSocket[] = []
  const relayMessages: number[][] = []
  const server = https.createServer({ key: cert.keyPem, cert: cert.certPem })
  server.on('secureConnection', (tlsSocket) => {
    const index = received.push(0) - 1
    tlsSocket.on('data', (chunk: Buffer) => {
      received[index] += chunk.length
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  const relayWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'https://localhost').pathname
    if (path === '/connect') wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
    else if (path === '/relay') relayWss.handleUpgrade(request, socket, head, (ws) => relayWss.emit('connection', ws, request))
    else socket.destroy()
  })
  relayWss.on('connection', (socket) => {
    const index = relayLegs.push(socket) - 1
    relayMessages.push([])
    socket.on('error', () => undefined)
    let answered = false
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        relayMessages[index].push((data as Buffer).length)
        return
      }
      if (answered) return
      answered = true
      const frame = JSON.parse(data.toString()) as { id: number; m: string; p?: Record<string, unknown> }
      frames.push({ m: frame.m, p: frame.p ?? {} })
      const answer = current(frame.m, frame.p ?? {}, socket)
      if (answer === 'silent') return
      socket.send(JSON.stringify({ t: 'res', id: frame.id, ...answer }))
    })
  })
  wss.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as { id: number; m: string; p?: Record<string, unknown> }
      frames.push({ m: frame.m, p: frame.p ?? {} })
      const answer = current(frame.m, frame.p ?? {}, socket)
      if (answer === 'silent') return
      socket.send(JSON.stringify({ t: 'res', id: frame.id, ...answer }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    server: `wss://localhost:${port}`,
    received,
    frames,
    sockets,
    relayLegs,
    relayMessages,
    setHandler(next) {
      current = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate()
        for (const socket of relayWss.clients) socket.terminate()
        wss.close()
        relayWss.close()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
