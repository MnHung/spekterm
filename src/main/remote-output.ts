/**
 * Recent pty output per session, for remote terminal watches (`remote-protocol`, design D6 of
 * `mobile-remote-bridge`).
 *
 * pty output reaches the main process as decoded strings, so a position is `{ gen, offset }`: `gen`
 * identifies the session's current pty (a new one after a wake or a heal), `offset` counts UTF-16 code units
 * of output since this buffer started for that pty. A position with another `gen` is one this buffer does
 * not hold.
 *
 * **Buffering runs only while remote access is on** (`remote-access`): turning it off drops every ring.
 * The `gen` counter keeps running regardless, because it costs nothing and a pty spawned while remote access
 * was off must still get its own `gen`.
 *
 * A snapshot and the live subscription are taken in **one synchronous call** on the same thread that
 * delivers `data`, so no chunk can fall between them.
 */

export const RING_CAPACITY = 262_144

export interface TerminalPosition {
  gen: number
  offset: number
}

export interface OutputSnapshot {
  gen: number
  /** The position just past `data`: where the next chunk starts. */
  offset: number
  data: string
  /** `data` reaches back to the pty's first output. */
  complete: boolean
  /** `data` does not continue from the position the client named; it replaces what the client has. */
  replacing: boolean
}

export interface OutputListener {
  data(gen: number, offset: number, chunk: string): void
  /** The pty was resized (by the desktop; a remote client never resizes). */
  size(cols: number, rows: number): void
  /** The watch is over: the pty ended or was replaced, or remote access was turned off. */
  ended(reason: 'exited' | 'restarted' | 'off'): void
}

interface Ring {
  gen: number
  chunks: string[]
  /** Offset of the first code unit held. */
  start: number
  /** Offset just past the last code unit held. */
  end: number
  /** The ring began with the pty, so `start === 0` means the very first output. */
  fromBirth: boolean
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

export class RemoteOutput {
  #enabled = false
  #nextGen = 1
  readonly #gens = new Map<string, number>()
  readonly #rings = new Map<string, Ring>()
  readonly #listeners = new Map<string, Set<OutputListener>>()

  constructor(private readonly capacity: number = RING_CAPACITY) {}

  enabled(): boolean {
    return this.#enabled
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return
    this.#enabled = enabled
    if (enabled) return
    this.#rings.clear()
    for (const [, listeners] of this.#listeners) for (const listener of listeners) listener.ended('off')
    this.#listeners.clear()
  }

  /** A new pty for the session (spawn, wake, heal): a new `gen`, an empty ring, and current watches end. */
  spawned(sessionId: string): void {
    const gen = this.#nextGen++
    this.#gens.set(sessionId, gen)
    this.#rings.delete(sessionId)
    if (this.#enabled) this.#rings.set(sessionId, { gen, chunks: [], start: 0, end: 0, fromBirth: true })
    this.#end(sessionId, 'restarted')
  }

  /** The session's pty is gone. */
  exited(sessionId: string): void {
    this.#gens.delete(sessionId)
    this.#rings.delete(sessionId)
    this.#end(sessionId, 'exited')
  }

  /** A chunk of the session's pty output (`TerminalSink.data`). */
  data(sessionId: string, chunk: string): void {
    if (!this.#enabled || chunk.length === 0) return
    let ring = this.#rings.get(sessionId)
    if (!ring) {
      // Remote access was turned on after this pty started: what came before is not held.
      const gen = this.#gens.get(sessionId) ?? this.#assignGen(sessionId)
      ring = { gen, chunks: [], start: 0, end: 0, fromBirth: false }
      this.#rings.set(sessionId, ring)
    }
    ring.chunks.push(chunk)
    ring.end += chunk.length
    this.#trim(ring)
    const listeners = this.#listeners.get(sessionId)
    if (listeners) for (const listener of [...listeners]) listener.data(ring.gen, ring.end, chunk)
  }

  /** The session's pty was resized. Delivered whether or not remote access buffers output. */
  resized(sessionId: string, cols: number, rows: number): void {
    const listeners = this.#listeners.get(sessionId)
    if (listeners) for (const listener of [...listeners]) listener.size(cols, rows)
  }

  /**
   * The snapshot after `from`, and a live subscription from exactly there. `null` when nothing can be
   * watched (remote access off, or the session has no pty).
   */
  watch(
    sessionId: string,
    from: TerminalPosition | undefined,
    listener: OutputListener,
  ): { snapshot: OutputSnapshot; stop: () => void } | null {
    if (!this.#enabled) return null
    const gen = this.#gens.get(sessionId)
    if (gen === undefined) return null
    let ring = this.#rings.get(sessionId)
    if (!ring) {
      ring = { gen, chunks: [], start: 0, end: 0, fromBirth: false }
      this.#rings.set(sessionId, ring)
    }
    const held = ring.chunks.join('')
    let snapshot: OutputSnapshot
    if (from && from.gen === ring.gen && from.offset >= ring.start && from.offset <= ring.end) {
      snapshot = { gen: ring.gen, offset: ring.end, data: held.slice(from.offset - ring.start), complete: true, replacing: false }
    } else {
      snapshot = { gen: ring.gen, offset: ring.end, data: held, complete: ring.fromBirth && ring.start === 0, replacing: true }
    }
    let listeners = this.#listeners.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    return {
      snapshot,
      stop: () => {
        const current = this.#listeners.get(sessionId)
        current?.delete(listener)
        if (current?.size === 0) this.#listeners.delete(sessionId)
      },
    }
  }

  #assignGen(sessionId: string): number {
    const gen = this.#nextGen++
    this.#gens.set(sessionId, gen)
    return gen
  }

  #end(sessionId: string, reason: 'exited' | 'restarted'): void {
    const listeners = this.#listeners.get(sessionId)
    if (!listeners) return
    this.#listeners.delete(sessionId)
    for (const listener of listeners) listener.ended(reason)
  }

  /** Drops from the front past the capacity, never between the halves of a surrogate pair. */
  #trim(ring: Ring): void {
    let excess = ring.end - ring.start - this.capacity
    while (excess > 0 && ring.chunks.length > 0) {
      const first = ring.chunks[0]
      if (first.length <= excess) {
        ring.chunks.shift()
        ring.start += first.length
        excess -= first.length
        continue
      }
      let cut = excess
      if (isHighSurrogate(first.charCodeAt(cut - 1))) cut += 1
      ring.chunks[0] = first.slice(cut)
      ring.start += cut
      excess = 0
    }
  }
}
