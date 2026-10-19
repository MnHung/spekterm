import type { WaitState } from './agent-events'
import { attachmentSentence } from './agent-protocol-copy'
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

/** A reply's attachments, reserved when the reply was accepted (`remote-attachments.ts`). */
export interface ReplyAttachments {
  readonly paths: readonly string[]
  commit(): void
  release(): void
}

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
  /**
   * The session holds a filled-in prompt the desktop has not seen submitted (`remote-prefill-send` D5): a reply
   * would be typed after it and submitted with it. `prefillId` when a device can see it.
   */
  prefillPending?: (sessionId: string) => { prefillId?: string; edited: boolean } | null
}

function prefillRefusal(pending: { prefillId?: string; edited: boolean }): RemoteError {
  return new RemoteError(
    'PREFILL_PENDING',
    'a filled-in prompt waits to be sent in this session; send it first (sessions.submitPrefill) or at the desktop',
    { ...pending },
  )
}

const SENDABLE: readonly WaitState[] = ['ready', 'busy']

/** Per-session queues, shared by every connection: replies and prompt answers to one session never interleave. */
const queues = new Map<string, Promise<unknown>>()

/** Runs `job` after everything queued for this session before it. */
export function runQueued<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve()
  const run = previous.then(job)
  const settled = run.catch(() => undefined)
  queues.set(sessionId, settled)
  void settled.then(() => {
    if (queues.get(sessionId) === settled) queues.delete(sessionId)
  })
  return run
}

/**
 * Sends a reply to a watched session. `watching` is the session this connection watches. Throws a
 * `RemoteError` when the gate refuses; resolves with whether the submit key was written.
 */
/**
 * `attachments` is taken by the caller when the reply is accepted (so a second reply naming the same ones fails
 * at once), committed right after the text is written, and released when the reply fails before that. A
 * `filled-not-submitted` reply counts as sent: its text and the paths are in the agent's input box.
 */
export function sendReply(
  deps: ReplyDeps,
  watching: string | null,
  sessionId: string,
  text: string,
  takeAttachments?: () => ReplyAttachments,
): Promise<{ outcome: ReplyOutcome; text: string }> {
  if (watching !== sessionId) {
    return Promise.reject(new RemoteError('NOT_WATCHING', 'reply only to the conversation this connection watches'))
  }
  const cleaned = cleanReply(text)
  if (cleaned.trim() === '' && !takeAttachments) return Promise.reject(new RemoteError('BAD_PARAMS', 'the reply is empty'))
  const state = deps.waitStateOf(sessionId)
  if (!SENDABLE.includes(state)) {
    return Promise.reject(new RemoteError('WAIT_STATE', `the agent cannot take a reply now (${state}); answer a prompt with conversation.answer`, { state }))
  }
  const pendingFill = deps.prefillPending?.(sessionId)
  if (pendingFill) return Promise.reject(prefillRefusal(pendingFill))
  let attachments: ReplyAttachments | undefined
  try {
    attachments = takeAttachments?.()
  } catch (error) {
    return Promise.reject(error)
  }
  const sentence = attachments ? attachmentSentence(attachments.paths) : ''
  const full = cleaned.trim() === '' ? sentence : sentence ? `${cleaned}\n\n${sentence}` : cleaned

  return runQueued(sessionId, async () => {
    // The state may have moved while an earlier reply was being written.
    const now = deps.waitStateOf(sessionId)
    if (!SENDABLE.includes(now)) {
      attachments?.release()
      throw new RemoteError('WAIT_STATE', `the agent cannot take a reply now (${now})`, { state: now })
    }
    // A prompt may have been filled in while an earlier reply was being written.
    const filledMeanwhile = deps.prefillPending?.(sessionId)
    if (filledMeanwhile) {
      attachments?.release()
      throw prefillRefusal(filledMeanwhile)
    }
    if (!deps.write(sessionId, full)) {
      attachments?.release()
      throw new RemoteError('NOT_FOUND', 'the session has no running process')
    }
    attachments?.commit()
    await deps.delay(deps.submitDelayMs)
    if (!SENDABLE.includes(deps.waitStateOf(sessionId))) return { outcome: 'filled-not-submitted' as const, text: full }
    // A prompt filled in during the delay sits in the box with the reply: the key would submit both.
    if (deps.prefillPending?.(sessionId)) return { outcome: 'filled-not-submitted' as const, text: full }
    deps.write(sessionId, '\r')
    return { outcome: 'submitted' as const, text: full }
  })
}
