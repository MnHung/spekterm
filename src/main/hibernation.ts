import { randomUUID } from 'node:crypto'

import type { WaitState } from './agent-events'
import { isEligible, type ShellFacts } from './hibernation-policy'
import type { SpawnTarget } from './terminal'

/**
 * The state automatic hibernation decides on (`session-hibernation`, design D3/D4): when each running
 * session last saw activity, which session each renderer displays, and the single-use tokens that
 * mark a hibernation as automatic.
 *
 * The decision itself is `isEligible`; this class only keeps what that function needs.
 */

export interface TrackerDeps {
  now: () => number
  /** Subscribe to a session's wait state. The tracker keeps one subscription per running claude session. */
  subscribeWait: (sessionId: string, subscriber: (snapshot: { state: WaitState }) => void) => () => void
  waitStateOf: (sessionId: string) => WaitState
  hasUnconfirmedSubmission: (sessionId: string) => boolean
}

interface Tracked {
  target: SpawnTarget
  lastActivity: number
  /** claude: the wait-state subscription, and the last value seen (a change is activity). */
  unsubscribe?: () => void
  lastWait?: WaitState
}

export class HibernationTracker {
  readonly #deps: TrackerDeps
  readonly #sessions = new Map<string, Tracked>()
  /** Displayed session per renderer (`webContents.id`). */
  /**
   * What is on screen: each window's displayed session (keyed by `webContents.id`), and each remote watch
   * (keyed by a string, `session-hibernation`'s "a session a paired device is watching counts as displayed").
   */
  readonly #displayed = new Map<number | string, string | null>()
  /** token → session it was issued for. Cleared on every tick: a token lives one tick at most. */
  readonly #tokens = new Map<string, string>()

  constructor(deps: TrackerDeps) {
    this.#deps = deps
  }

  /**
   * A pty was born (create or wake). Activity starts now.
   *
   * A claude session is subscribed to its wait state for its whole life — **not only while someone
   * watches it**. Without that, a session watched until it was waiting, then left, then sent work,
   * would still read `ready` while working (the wait state is only evaluated while subscribed).
   */
  track(sessionId: string, target: SpawnTarget): void {
    this.untrack(sessionId)
    const tracked: Tracked = { target, lastActivity: this.#deps.now() }
    this.#sessions.set(sessionId, tracked)
    if (target !== 'claude') return
    tracked.lastWait = this.#deps.waitStateOf(sessionId)
    tracked.unsubscribe = this.#deps.subscribeWait(sessionId, (snapshot) => {
      if (snapshot.state === tracked.lastWait) return
      tracked.lastWait = snapshot.state
      tracked.lastActivity = this.#deps.now()
    })
  }

  /** The pty ended (for any reason). */
  untrack(sessionId: string): void {
    const tracked = this.#sessions.get(sessionId)
    if (!tracked) return
    tracked.unsubscribe?.()
    this.#sessions.delete(sessionId)
  }

  /** Output from a shell's process is activity. claude's own output is not (design D4). */
  output(sessionId: string): void {
    const tracked = this.#sessions.get(sessionId)
    if (tracked?.target === 'shell') tracked.lastActivity = this.#deps.now()
  }

  /** A renderer reports the session it displays. Becoming and ceasing to be displayed are both activity. */
  /**
   * A paired device started or stopped watching a session (`remote-protocol`). It counts as displayed, and
   * starting or stopping is activity, exactly as a window turning to a session or away from it.
   */
  setRemoteWatched(watchKey: string, sessionId: string | null): void {
    this.setDisplayed(watchKey, sessionId)
  }

  setDisplayed(contentsId: number | string, sessionId: string | null): void {
    const previous = this.#displayed.get(contentsId) ?? null
    if (previous === sessionId) return
    const now = this.#deps.now()
    for (const id of [previous, sessionId]) {
      const tracked = id === null ? undefined : this.#sessions.get(id)
      if (tracked) tracked.lastActivity = now
    }
    if (sessionId === null) this.#displayed.delete(contentsId)
    else this.#displayed.set(contentsId, sessionId)
  }

  /** The session a window displays (by `webContents.id`), if any. */
  displayedBy(contentsId: number): string | null {
    return this.#displayed.get(contentsId) ?? null
  }

  isDisplayed(sessionId: string): boolean {
    for (const id of this.#displayed.values()) if (id === sessionId) return true
    return false
  }

  /** Whether the policy allows hibernating this session now. Untracked sessions never qualify. */
  eligible(sessionId: string, shell: ShellFacts, thresholdMs: number): boolean {
    const tracked = this.#sessions.get(sessionId)
    if (!tracked) return false
    return isEligible({
      displayed: this.isDisplayed(sessionId),
      now: this.#deps.now(),
      lastActivity: tracked.lastActivity,
      thresholdMs,
      target: tracked.target,
      wait: this.#deps.waitStateOf(sessionId),
      unconfirmedSubmission: this.#deps.hasUnconfirmedSubmission(sessionId),
      shell,
    })
  }

  /** Start of a tick: tokens from the previous one expire. */
  newTick(): void {
    this.#tokens.clear()
  }

  /** A single-use token marking a hibernation request as automatic. */
  issueToken(sessionId: string): string {
    const token = randomUUID()
    this.#tokens.set(token, sessionId)
    return token
  }

    /**
   * An automatic request coming back from the renderer (design D3): honored only with a token issued
   * for this session in the current tick, **and only if the policy still allows it** — the session may
   * have become displayed or started working during the round trip.
   */
  authorize(sessionId: string, token: string, shell: ShellFacts, thresholdMs: number): boolean {
    return this.redeem(token, sessionId) && this.eligible(sessionId, shell, thresholdMs)
  }

  /** Consumes a token. True only if it was issued for this session in the current tick. */
  redeem(token: string, sessionId: string): boolean {
    const issuedFor = this.#tokens.get(token)
    this.#tokens.delete(token)
    return issuedFor === sessionId
  }

  }
