import { randomUUID } from 'node:crypto'
import type { RendererOutcome } from './remote-host'
import type { HostAction } from './remote-protocol'

/**
 * Requests to a window's renderer and their replies (`remote-protocol`, design D4): the renderer owns the
 * session list, so a device's create, wake and accept are carried out by it. A request is answered by the
 * renderer that was asked, by a timeout, or — when that renderer reloads or closes — with `NO_WINDOW`.
 * Electron-free, so the timing is tested without a window; `ipc/remote.ts` supplies `send`.
 */

export const RENDERER_REQUEST_TIMEOUT_MS = 15_000

interface Pending {
  contentsId: number
  resolve: (outcome: RendererOutcome) => void
  timer: NodeJS.Timeout
}

function parseOutcome(raw: unknown): RendererOutcome | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.ok === true && typeof o.sessionId === 'string') return { ok: true, sessionId: o.sessionId }
  if (o.ok === false && typeof o.code === 'string') {
    return { ok: false, code: o.code, ...(typeof o.message === 'string' ? { message: o.message.slice(0, 500) } : {}) }
  }
  return null
}

export class RendererRequests {
  readonly #pending = new Map<string, Pending>()

  constructor(private readonly timeoutMs: number = RENDERER_REQUEST_TIMEOUT_MS) {}

  request(contentsId: number, send: (requestId: string, action: HostAction) => void, action: HostAction): Promise<RendererOutcome> {
    const requestId = randomUUID()
    return new Promise<RendererOutcome>((resolve) => {
      const timer = setTimeout(
        () => this.#settle(requestId, { ok: false, code: 'TIMEOUT', message: 'the desktop did not answer in time' }),
        this.timeoutMs,
      )
      this.#pending.set(requestId, { contentsId, resolve, timer })
      send(requestId, action)
    })
  }

  /** A renderer's reply. Only the renderer that was asked can answer; a malformed reply is a failure. */
  reply(contentsId: number, requestId: unknown, outcome: unknown): void {
    if (typeof requestId !== 'string') return
    const entry = this.#pending.get(requestId)
    if (!entry || entry.contentsId !== contentsId) return
    this.#settle(requestId, parseOutcome(outcome) ?? { ok: false, code: 'CREATE_FAILED', message: 'malformed reply' })
  }

  /** The renderer reloaded or closed: everything it was asked is answered with `NO_WINDOW`. */
  rendererGone(contentsId: number): void {
    for (const [requestId, entry] of this.#pending) {
      if (entry.contentsId === contentsId) this.#settle(requestId, { ok: false, code: 'NO_WINDOW', message: 'the window went away' })
    }
  }

  #settle(requestId: string, outcome: RendererOutcome): void {
    const entry = this.#pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.#pending.delete(requestId)
    entry.resolve(outcome)
  }
}
