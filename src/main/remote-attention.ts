import { randomBytes } from 'node:crypto'
import { FIELD_MAX, reduceForNotification } from './intake-notify'
import type { IntakeRecord } from './intake-store'
import type { WaitState } from './agent-events'

/**
 * Attention events for paired devices, and the short memory that lets a reconnecting device catch up
 * (`remote-notifications`, design D7 of `mobile-remote-bridge`).
 *
 * ## One derivation
 *
 * - `waiting`: a drained batch with the agent's turn completion, ending in any state but a choice;
 * - `choice`: a drained batch with a permission request, still waiting on it;
 * - `handoff-done`: a handoff report adopted (the moment the desktop notification uses);
 * - `intake`: an inbox arrival.
 *
 * Both batch facts come from the drain itself (`DrainResult.turnEnded` / `choiceRaised`), never from
 * comparing states: a short turn folds to `ready` → `ready`, and an answered prompt followed by the next
 * folds to `awaiting-choice` → `awaiting-choice`.
 *
 * ## The log
 *
 * Every event of the last 24 hours, up to the 200 most recent, held in memory **only while remote access is
 * on**. A position is `{ epoch, seq }`; the epoch is new each time the log starts (remote access turned on,
 * including at startup) and the log is dropped when it is turned off or reset — **not** when the listener
 * restarts for a port change or fails to listen. A reset drops it so a device paired afterwards is not
 * shown titles from before.
 *
 * Text that agents or third parties control is reduced the way the desktop reduces text for its own
 * notifications (`agent-intake`): a phone's notification shade parses it the same way.
 */

export type AttentionKind = 'waiting' | 'choice' | 'handoff-done' | 'intake'

export interface AttentionPosition {
  epoch: string
  seq: number
}

export interface AttentionEvent {
  pos: AttentionPosition
  kind: AttentionKind
  at: number
  sessionId?: string
  intake?: { adapter: string; id: string }
  /** The folder's name, clipped; absent for the global session and for an inbox item. */
  folderName?: string
  title: string
  /** For `handoff-done`: the report summary. */
  summary?: string
  /** For `choice`: the tool the agent asks about. */
  tool?: string
  /** About the session the user is looking at on the desktop: update state, do not notify. */
  suppressed: boolean
}

export interface AttentionSources {
  now: () => number
  /** The session's display facts, or `null` for a session that does not exist. */
  sessionInfo: (sessionId: string) => { folderName: string | null; title: string } | null
  /** The desktop's focused window displays this session. */
  displayedInFocus: (sessionId: string) => boolean
  newEpoch?: () => string
}

export interface AttentionListener {
  (event: AttentionEvent): void
}

export const LOG_CAPACITY = 200
export const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Folder names are the user's own and not reduced, but clipped to the same length as reduced fields. */
function clip(text: string): string {
  const points = [...text]
  return points.length > FIELD_MAX ? `${points.slice(0, FIELD_MAX).join('')}…` : text
}

export class AttentionLog {
  #epoch: string | null = null
  #nextSeq = 1
  #events: AttentionEvent[] = []
  readonly #listeners = new Set<AttentionListener>()

  constructor(
    private readonly sources: AttentionSources,
    private readonly limits = { capacity: LOG_CAPACITY, maxAgeMs: LOG_MAX_AGE_MS },
  ) {}

  enabled(): boolean {
    return this.#epoch !== null
  }

  /** Follows the user's remote access setting. Turning on starts a new span; off drops everything. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled()) return
    if (enabled) this.#start()
    else this.#drop()
  }

  /** The user reset remote access: a new span, nothing from before. */
  reset(): void {
    if (!this.enabled()) return
    this.#start()
  }

  /** A drained batch of one session (`observeWaits`). */
  onWait(sessionId: string, batch: { state: WaitState; turnEnded: boolean; choiceRaised: { tool: string } | null }): void {
    if (!this.enabled()) return
    if (batch.choiceRaised && batch.state === 'awaiting-choice') {
      this.#sessionEvent('choice', sessionId, { tool: reduceForNotification(batch.choiceRaised.tool) })
    } else if (batch.turnEnded && batch.state !== 'awaiting-choice') {
      this.#sessionEvent('waiting', sessionId, {})
    }
  }

  /** A handoff report was adopted (`HandoffCompletion.onReported`). */
  onReported(sessionId: string, title: string, summary: string): void {
    if (!this.enabled()) return
    const info = this.sources.sessionInfo(sessionId)
    this.#append({
      kind: 'handoff-done',
      sessionId,
      ...(info?.folderName ? { folderName: clip(info.folderName) } : {}),
      title: reduceForNotification(title || info?.title || ''),
      summary: reduceForNotification(summary),
      suppressed: false,
    })
  }

  /** A new inbox item arrived (`IntakeService.onArrival`), a handoff's arrival included. */
  onIntake(record: IntakeRecord): void {
    if (!this.enabled()) return
    this.#append({
      kind: 'intake',
      intake: { adapter: record.adapter, id: record.id },
      title: reduceForNotification(record.content?.authored.title ?? ''),
      suppressed: false,
    })
  }

  /**
   * The held events after `after` and a live subscription from exactly there, in one synchronous call.
   * `complete` is false when events after `after` may have been dropped, or `after` is from another span
   * or absent. `null` while remote access is off.
   */
  watch(
    after: AttentionPosition | undefined,
    listener: AttentionListener,
  ): { events: AttentionEvent[]; complete: boolean; stop: () => void } | null {
    if (!this.enabled()) return null
    this.#prune()
    const firstHeld = this.#events[0]?.pos.seq ?? this.#nextSeq
    const held =
      after !== undefined &&
      after.epoch === this.#epoch &&
      firstHeld <= after.seq + 1 &&
      after.seq + 1 <= this.#nextSeq
    const events = held ? this.#events.filter((event) => event.pos.seq > after.seq) : [...this.#events]
    this.#listeners.add(listener)
    return { events, complete: held, stop: () => this.#listeners.delete(listener) }
  }

  #sessionEvent(kind: 'waiting' | 'choice', sessionId: string, extra: { tool?: string }): void {
    const info = this.sources.sessionInfo(sessionId)
    if (!info) return
    this.#append({
      kind,
      sessionId,
      ...(info.folderName ? { folderName: clip(info.folderName) } : {}),
      title: reduceForNotification(info.title),
      ...extra,
      suppressed: this.sources.displayedInFocus(sessionId),
    })
  }

  #append(fields: Omit<AttentionEvent, 'pos' | 'at'>): void {
    if (this.#epoch === null) return
    const event: AttentionEvent = { pos: { epoch: this.#epoch, seq: this.#nextSeq++ }, at: this.sources.now(), ...fields }
    this.#events.push(event)
    this.#prune()
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error(`[remote] attention listener failed: ${String(error)}`)
      }
    }
  }

  #prune(): void {
    const oldest = this.sources.now() - this.limits.maxAgeMs
    let drop = 0
    while (drop < this.#events.length && this.#events[drop].at < oldest) drop += 1
    drop = Math.max(drop, this.#events.length - this.limits.capacity)
    if (drop > 0) this.#events = this.#events.slice(drop)
  }

  #start(): void {
    this.#epoch = (this.sources.newEpoch ?? (() => randomBytes(8).toString('hex')))()
    this.#nextSeq = 1
    this.#events = []
  }

  #drop(): void {
    this.#epoch = null
    this.#events = []
    // Watchers belong to connections, which close when remote access goes off; nothing more is sent.
    this.#listeners.clear()
  }
}
