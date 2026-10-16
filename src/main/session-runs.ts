/**
 * When each session's process last started or ended, in this run of the application (`agent-session-control`,
 * design D11).
 *
 * A close or hibernate an agent wrote yields to anything that happened to its target afterwards — the user's wake,
 * hibernate or quit — and this is the "afterwards" it is judged against. **Process-wide**, as `pty-input.ts` is:
 * `TerminalService` is one instance per window and forgets its sessions when the window goes, and macOS reopens
 * windows. A per-instance record would forget a session, which would then be judged by the run's start: the very
 * case the rule exists for.
 */

let runStart = Date.now()
const lastChange = new Map<string, number>()
/** Ends a session command asked for, so they do not count against the next command (the latest still wins). */
const expected = new Set<string>()

/** This run of the application started at. */
export function runStartedAt(): number {
  return runStart
}

/** A pty now serves the session: a spawn, a wake, or a heal (not the user's act, but dropping near it is safe). */
export function noteProcessStart(sessionId: string, now: number = Date.now()): void {
  lastChange.set(sessionId, now)
}

/** The session's process ended, for any reason (`disposed` included: a quit or a window reload). */
export function noteProcessEnd(sessionId: string, now: number = Date.now()): void {
  if (expected.delete(sessionId)) return
  lastChange.set(sessionId, now)
}

/** A session command is about to end this session's process; that end does not count. */
export function expectCommandEnd(sessionId: string): void {
  expected.add(sessionId)
}

/** The command's request failed, so the end it announced will not come. */
export function cancelCommandEnd(sessionId: string): void {
  expected.delete(sessionId)
}

/** The last start or end of the session's process in this run that no command caused, or `null`. */
export function lastProcessChangeAt(sessionId: string): number | null {
  return lastChange.get(sessionId) ?? null
}

/** Tests only. */
export function resetSessionRuns(start: number = Date.now()): void {
  runStart = start
  lastChange.clear()
  expected.clear()
}
