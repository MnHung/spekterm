import type { ExitReason } from './terminal'

/**
 * Whether a session had a running process, as `sessions.json` records it (`restore-running-sessions`
 * design D1). Restore starts again exactly the sessions recorded as running.
 *
 * **Kept free of `electron`** so these rules are unit tested: `ipc/terminal.ts` cannot be imported under
 * node:test, and the rules are what fail silently — a record that is never set starts nothing after a
 * restart, one that is never cleared starts a session the user put to sleep.
 */
export interface RunningRecord {
  update(sessionId: string, patch: { running?: true }): void
}

/** A pty was spawned for the session: create, wake (explicit or at launch), or the self-heal respawn. */
export function recordSpawned(sessions: RunningRecord, sessionId: string): void {
  sessions.update(sessionId, { running: true })
}

/**
 * The session was hibernated. Called **when the hibernation is accepted**, not only at the pty's exit: the
 * hibernated pty leaves the service at once, so a quit right after it does not wait for its exit, and the
 * main process may end first — the session the user just put to sleep would then start at the next launch.
 */
export function recordHibernated(sessions: RunningRecord, sessionId: string): void {
  sessions.update(sessionId, { running: undefined })
}

/**
 * A pty ended. Only a hibernation clears the record (again — idempotent). **`disposed` leaves it**: the window
 * closing, the renderer reloading and the application quitting all end ptys that way, and the record must still
 * say what was running before. `self` and `killed` remove the session from persistence altogether.
 */
export function recordExit(sessions: RunningRecord, sessionId: string, reason: ExitReason): void {
  if (reason === 'hibernated') recordHibernated(sessions, sessionId)
}
