import type { WaitState } from './agent-events'
import { RemoteError } from './remote-frames'
import type { FollowUpdate } from './transcript-follow-service'

/**
 * A paired device's view of one conversation, and its replies (`remote-protocol`, design D5 / D6 of
 * `mobile-remote-bridge`).
 *
 * ## Resume
 *
 * The follower's first update is the last 400 events, replacing. A client that names `afterUuid` gets only
 * the events after the **last** event carrying that uuid — one transcript record yields several events
 * sharing its uuid — not replacing. An empty or missing uuid, or one not in that batch, leaves the update as
 * it is: replacing. Later updates pass through unchanged.
 *
 * ## Reply
 *
 * - **Gate**: the desktop's (`agent-input-bridge`) — only the watched session, only while `ready` or `busy`.
 * - **Cleaning**: the desktop's (`encodeInput`'s character filter).
 * - **Writes**: the text, then the submit key `SUBMIT_KEY_DELAY_MS` later. Phone input is often dictated or
 *   pasted and long, and a long single write is taken as a paste whose submit key is lost
 *   (`docs/lessons/handoff.md` 13.1).
 * - **Re-check**: immediately before the submit key the wait state is read again. If the agent began waiting
 *   on a choice during the delay, the key is withheld and the reply answered `filled-not-submitted` —
 *   writing it would pick the prompt's default for the user. Nothing is sent later.
 * - **Order**: one queue per session, across connections, so two replies never interleave.
 */

export type ReplyOutcome = 'submitted' | 'filled-not-submitted'

/** The resume filter for a follow's first update. */
export function resumeFrom(update: FollowUpdate, afterUuid: unknown): FollowUpdate {
  if (typeof afterUuid !== 'string' || afterUuid === '' || !update.reset) return update
  let last = -1
  update.events.forEach((event, index) => {
    if (event.uuid === afterUuid) last = index
  })
  if (last < 0) return update
  return { ...update, events: update.events.slice(last + 1), reset: false }
}

/** `encodeInput`'s filter without its submit key: newlines kept, other C0 controls and DEL removed. */
export function cleanReply(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
}

export interface ReplyDeps {
  waitStateOf: (sessionId: string) => WaitState
  /** Writes to the session's pty; `false` when the session has no pty. */
  write: (sessionId: string, data: string) => boolean
  delay: (ms: number) => Promise<void>
  submitDelayMs: number
}

const SENDABLE: readonly WaitState[] = ['ready', 'busy']

/** Per-session reply queues, shared by every connection. */
const queues = new Map<string, Promise<unknown>>()

/**
 * Sends a reply to a watched session. `watching` is the session this connection watches. Throws a
 * `RemoteError` when the gate refuses; resolves with whether the submit key was written.
 */
export function sendReply(
  deps: ReplyDeps,
  watching: string | null,
  sessionId: string,
  text: string,
): Promise<ReplyOutcome> {
  if (watching !== sessionId) {
    return Promise.reject(new RemoteError('NOT_WATCHING', 'reply only to the conversation this connection watches'))
  }
  const cleaned = cleanReply(text)
  if (cleaned.trim() === '') return Promise.reject(new RemoteError('BAD_PARAMS', 'the reply is empty'))
  const state = deps.waitStateOf(sessionId)
  if (!SENDABLE.includes(state)) {
    return Promise.reject(new RemoteError('WAIT_STATE', `the agent cannot take a reply now (${state})`, { state }))
  }

  const previous = queues.get(sessionId) ?? Promise.resolve()
  const run = previous.then(async (): Promise<ReplyOutcome> => {
    // The state may have moved while an earlier reply was being written.
    const now = deps.waitStateOf(sessionId)
    if (!SENDABLE.includes(now)) {
      throw new RemoteError('WAIT_STATE', `the agent cannot take a reply now (${now})`, { state: now })
    }
    if (!deps.write(sessionId, cleaned)) throw new RemoteError('NOT_FOUND', 'the session has no running process')
    await deps.delay(deps.submitDelayMs)
    if (!SENDABLE.includes(deps.waitStateOf(sessionId))) return 'filled-not-submitted'
    deps.write(sessionId, '\r')
    return 'submitted'
  })
  const settled = run.catch(() => undefined)
  queues.set(sessionId, settled)
  void settled.then(() => {
    if (queues.get(sessionId) === settled) queues.delete(sessionId)
  })
  return run
}
