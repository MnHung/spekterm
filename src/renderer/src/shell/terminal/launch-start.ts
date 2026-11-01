/**
 * Starting again the sessions that were running when their ptys were last ended (`restore-running-sessions`,
 * design D3). Pure of React and of the IPC so the order and the stop rules are unit tested.
 *
 * - **Shells first, then agents**, each in persisted order: a shell is never held back by an agent's canary.
 * - **Skip what the user already took**: a session that is gone, no longer dormant, or already being woken (the
 *   user pressed Wake) is left alone — nothing starts twice.
 * - **A systemic failure is not repeated across every agent.** If the main process refuses an agent because the
 *   user's environment could not be read, no further agent is started. And the first agent started is a canary:
 *   it is watched for a while, and if it ends on its own (`exited`) in that time, no further agent is started.
 *   An agent the user closes or hibernates during the watch, or whose wake fails, is not such a failure: the
 *   next agent becomes the canary. Agents left out say why (`notStarted`), and keep their record, so the next
 *   launch tries again.
 */

export type LaunchTarget = 'claude' | 'shell'

/** What the walk needs to know about a session right now. `gone` = closed (no longer in the list). */
export type LaunchState = { kind: 'gone' } | { kind: 'present'; target: LaunchTarget; dormant: boolean }

export type LaunchWakeOutcome = { status: 'woken' } | { status: 'failed'; code?: string }

/** How the canary's watch ended: it ended on its own, the user took it away (closed / hibernated), or it lived. */
export type CanaryVerdict = 'exited' | 'left' | 'survived'

export type NotStartedReason = 'env' | 'canary'

export interface LaunchStartDeps {
  stateOf(sessionId: string): LaunchState
  isWaking(sessionId: string): boolean
  wake(sessionId: string): Promise<LaunchWakeOutcome>
  /** Watch a just-started agent until it exits, leaves, or has lived through the canary window. */
  watchCanary(sessionId: string): Promise<CanaryVerdict>
  notStarted(sessionId: string, reason: NotStartedReason): void
}

/** The main process's refusal of an automatic agent start (`TerminalCode`). */
export const USER_ENV_UNAVAILABLE = 'USER_ENV_UNAVAILABLE'

/**
 * Two resume-failure windows (`RESUME_FAILURE_WINDOW_MS`, 3 s each: the resume fails, then the healed fresh
 * conversation fails) plus a margin. Counted from the wake's resolution, which is when the pty exists — the wait
 * for the user's environment and the previous pty happen before it.
 */
export const CANARY_WINDOW_MS = 7000

export async function startAtLaunch(queue: readonly string[], deps: LaunchStartDeps): Promise<void> {
  const targetOf = (id: string): LaunchTarget | null => {
    const state = deps.stateOf(id)
    return state.kind === 'present' ? state.target : null
  }
  const ordered = [
    ...queue.filter((id) => targetOf(id) === 'shell'),
    ...queue.filter((id) => targetOf(id) === 'claude'),
  ]

  let blocked: NotStartedReason | null = null
  let canaryPassed = false

  for (const id of ordered) {
    // Read again before each start: the user may have woken, closed or hibernated it meanwhile.
    const state = deps.stateOf(id)
    if (state.kind === 'gone' || !state.dormant || deps.isWaking(id)) continue

    if (state.target === 'claude' && blocked) {
      deps.notStarted(id, blocked)
      continue
    }

    const outcome = await deps.wake(id)
    if (outcome.status === 'failed') {
      // The session itself already shows the reason (the wake path's failure handling).
      if (state.target === 'claude' && outcome.code === USER_ENV_UNAVAILABLE) blocked = 'env'
      continue
    }

    if (state.target === 'claude' && !canaryPassed) {
      const verdict = await deps.watchCanary(id)
      if (verdict === 'exited') blocked = 'canary'
      else if (verdict === 'survived') canaryPassed = true
      // 'left': the user closed or hibernated it — not a systemic failure; the next agent is the canary.
    }
  }
}
