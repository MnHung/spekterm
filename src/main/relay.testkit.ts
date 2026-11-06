import type { AddressInfo } from 'node:net'

import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws'

/**
 * A stand-in for spekterm-server's relay (`phone-relay`), for the unit tests: a plain WebSocket server on 127.0.0.1
 * that splices its connections in pairs, passing each binary message to the other leg unchanged, with the server's
 * 256 KiB message limit (a larger one closes that leg with 1009 and the other with 4010). It records the largest
 * message it relayed, and can stop reading a leg, as a stalled peer does.
 *
 * **Not `stream.duplexPair`**: a pair end is not destroyed with its peer, so a TLS socket over it never closes and a
 * WebSocket on top waits in CLOSING; the WebSocket-backed streams the relay really uses close in tens of milliseconds
 * (measured while writing these tests).
 */

export const RELAY_MAX_MESSAGE = 256 * 1024

export interface StandInRelay {
  url: string
  /** The largest message relayed so far, in bytes. */
  maxMessage(): number
  /** Close codes seen per leg, in order of the legs' arrival. */
  closes: number[]
  /** Stops reading every leg (a peer that no longer reads). */
  pauseAll(): void
  /** Every leg the relay has, in order of arrival. */
  legs: WebSocket[]
  close(): Promise<void>
}

export async function standInRelay(): Promise<StandInRelay> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: RELAY_MAX_MESSAGE, perMessageDeflate: false })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const legs: WebSocket[] = []
  const closes: number[] = []
  let max = 0
  wss.on('connection', (ws) => {
    const index = legs.length
    legs.push(ws)
    const other = (): WebSocket | undefined => legs[index % 2 === 0 ? index + 1 : index - 1]
    ws.on('message', (data, isBinary) => {
      const buffer = data as Buffer
      max = Math.max(max, buffer.length)
      const peer = other()
      if (!isBinary) {
        ws.close(1003)
        peer?.close(4010)
        return
      }
      peer?.send(buffer, { binary: true })
    })
    ws.on('error', () => undefined)
    ws.on('close', (code) => {
      closes[index] = code
      const peer = other()
      if (peer && peer.readyState === WebSocket.OPEN) peer.close(4010)
    })
  })
  const { port } = wss.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${port}`,
    maxMessage: () => max,
    closes,
    legs,
    pauseAll: () => {
      for (const leg of legs) leg.pause()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const leg of legs) leg.terminate()
        wss.close(() => resolve())
      }),
  }
}

/** Opens one leg as a client and resolves with its WebSocket once open. */
export async function openLeg(relay: StandInRelay): Promise<WebSocket> {
  const ws = new WebSocket(relay.url, { perMessageDeflate: false })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return ws
}

/** Two spliced legs, phone first, each as a byte stream (`createWebSocketStream`), with no cutting of writes. */
export async function relayedStreams(relay: StandInRelay): Promise<{
  phone: ReturnType<typeof createWebSocketStream>
  desktop: ReturnType<typeof createWebSocketStream>
  phoneLeg: WebSocket
  desktopLeg: WebSocket
}> {
  const phoneLeg = await openLeg(relay)
  const desktopLeg = await openLeg(relay)
  const phone = createWebSocketStream(phoneLeg)
  const desktop = createWebSocketStream(desktopLeg)
  // As a real leg does: a closed WebSocket destroys its stream (`createWebSocketStream` only ends its readable side).
  phoneLeg.once('close', () => phone.destroy())
  desktopLeg.once('close', () => desktop.destroy())
  return { phone, desktop, phoneLeg, desktopLeg }
}
