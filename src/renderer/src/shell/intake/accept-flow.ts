import type { SessionsApi } from '../terminal/sessions'
import { sessionToReuse } from './reuse-session'

/**
 * The desktop's accept, as one function — **the inbox overlay and a paired device both run it**
 * (`remote-protocol`'s "Inbox accept from a device follows the desktop's accept"):
 *
 * 1. the main process decides (`decideAccept`): the folder the user chose, the session an earlier accept left;
 * 2. that earlier session is reused when it still exists in the chosen folder (`sessionToReuse`) — a prefill
 *    timeout puts the item back to pending while its session lives, and accepting again must not open another;
 * 3. otherwise a session is created there;
 * 4. `attach` writes the context and fills in or submits the prompt, by the main process's rule
 *    (`prefillModeFor`).
 *
 * A creation failure stops before `attach`, so the item stays pending.
 */

export type AcceptFlowOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'unknown' | 'prefillUnavailable' | 'FOLDER_GONE' | 'opening' }
  | { ok: false; reason: 'createFailed'; message: string }

export interface AcceptFlowDeps {
  intake: Pick<typeof window.workspace.intake, 'accept' | 'attach'>
  sessions: Pick<SessionsApi, 'all' | 'create'>
}

export async function runAccept(
  deps: AcceptFlowDeps,
  item: { id: string; adapter: string },
  folderId: string,
  options: { quiet?: boolean } = {},
): Promise<AcceptFlowOutcome> {
  const decision = await deps.intake.accept(item.id, item.adapter, folderId)
  if (!decision.ok) return decision
  const reusable = sessionToReuse(decision.existingSessionId, deps.sessions.all(), decision.folderId)
  let sessionId = reusable
  if (!sessionId) {
    const outcome = await deps.sessions.create(decision.folderId, 'claude', {
      ticket: decision.ticket,
      ...(options.quiet ? { quiet: true } : {}),
    })
    if (outcome.status !== 'created') return { ok: false, reason: 'createFailed', message: outcome.failure.message }
    sessionId = outcome.sessionId
  }
  await deps.intake.attach(item.id, item.adapter, sessionId)
  return { ok: true, sessionId }
}
