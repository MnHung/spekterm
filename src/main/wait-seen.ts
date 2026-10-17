import type { WaitSnapshot } from './agent-wait'

/** What `onBatch` reads of a drained batch. */
export type SeenBatch = Pick<WaitSnapshot, 'state' | 'inTurn' | 'turnEnded' | 'sessionStarted' | 'poke'>

/**
 * The seen mark for each agent session's last turn end (`session-wait-indicator`) — **owned by the main process**,
 * so the desktop's dots, the handoff lifecycle and a paired device all read the same answer, and looking on any of
 * them clears it on all.
 *
 * It holds the sessions whose last turn end is **unseen**. Absent means "nothing to see", which is the right answer
 * for every case the rules do not name — a start, a resume, a wake, and every session after a restart (the mark is
 * not persisted).
 */
export class SeenMarks {
  readonly #unseen = new Set<string>()
  /** The previous batch's `inTurn`, per session: a turn that was in progress and no longer is has ended. */
  readonly #wasInTurn = new Map<string, boolean>()

  constructor(private readonly isLookedAt: (sessionId: string) => boolean) {}

  /**
   * One drained batch of one session (`observeWaits`). Returns whether the session's seen value changed.
   *
   * A **turn end** is a batch that leaves the agent waiting for input and out of a turn, and that either holds the
   * turn's `Stop` or follows a batch in a turn. Three measured cases shape it (`docs/lessons/transcript.md`):
   *
   * - an automatic compaction is busy → ready **within** a turn: `!inTurn` keeps it from pulsing;
   * - the user's `/compact` ends with no `Stop`, after a keystroke turn: `wasInTurn` catches it;
   * - a wake or a `/clear` passes through `inTurn: true` on a stale keystroke: a batch with a non-compaction
   *   `SessionStart` does not count `wasInTurn`.
   *
   * `wasInTurn` is recorded on **every** batch, pokes included: a device's dismissal is a poke with `inTurn: false`,
   * and skipping it would turn the next quiet tick into a turn end.
   */
  onBatch(sessionId: string, batch: SeenBatch): boolean {
    const wasInTurn = this.#wasInTurn.get(sessionId) ?? false
    this.#wasInTurn.set(sessionId, batch.inTurn)
    // A poke is a device's answer or dismissal, or a keystroke: the user acted.
    if (batch.poke) return false
    if (batch.inTurn) return this.#set(sessionId, false)
    const ended = batch.turnEnded || (wasInTurn && !batch.sessionStarted)
    if (batch.state !== 'ready' || !ended) return false
    return this.#set(sessionId, !this.isLookedAt(sessionId))
  }

  /** Someone looked at the session. Returns whether that cleared anything. */
  lookedAt(sessionId: string): boolean {
    return this.#set(sessionId, false)
  }

  /** The session's process ended, or the session went. */
  forget(sessionId: string): void {
    this.#unseen.delete(sessionId)
    this.#wasInTurn.delete(sessionId)
  }

  /** Drops every session not in `running`: a process that ended has no turn to have seen (hibernation, exit, reload). */
  retain(running: ReadonlySet<string>): void {
    for (const sessionId of [...this.#unseen, ...this.#wasInTurn.keys()]) {
      if (!running.has(sessionId)) this.forget(sessionId)
    }
  }

  /** Meaningful while the session's agent waits for input. */
  seenOf(sessionId: string): boolean {
    return !this.#unseen.has(sessionId)
  }

  #set(sessionId: string, unseen: boolean): boolean {
    if (this.#unseen.has(sessionId) === unseen) return false
    if (unseen) this.#unseen.add(sessionId)
    else this.#unseen.delete(sessionId)
    return true
  }
}

let lookingSource: (sessionId: string) => boolean = () => false

/**
 * The process's marks. A module singleton, as the wait states in `agent-wait.ts` are: the handoff lifecycle, the
 * remote session list and the renderer's projection all read it, and none of them may import the window side.
 */
export const seenMarks = new SeenMarks((sessionId) => lookingSource(sessionId))

/** Who is looking (`looked-at.ts`), set once the window side exists (`ipc/wait.ts`). */
export function setLookingSource(source: (sessionId: string) => boolean): void {
  lookingSource = source
}
