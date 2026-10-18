import type { BackgroundTask, WaitState } from './agent-events'
import { type AnswerDecision, type AnswerOutcome, DECISIONS, type PromptView } from './remote-answer'
import { LIMITS, type PutParams, type PutResult } from './remote-attachments'
import type { AttentionEvent, AttentionPosition } from './remote-attention'
import { type ReplyOutcome, resumeFrom } from './remote-conversation'
import { RemoteError, type RequestFrame, errorFrame, eventFrame, resultFrame } from './remote-frames'
import type { OutputListener, OutputSnapshot, TerminalPosition } from './remote-output'
import type { RemoteConnection, RemoteSessionHandle } from './remote-server'
import type { SessionEnd } from './terminal'
import type { FollowUpdate } from './transcript-follow-service'

/**
 * What an authenticated connection can do (`remote-protocol`, design D4–D6 of `mobile-remote-bridge`).
 *
 * **`OPERATIONS` is the allow-list.** A method not on it is answered `UNKNOWN_OPERATION` and has no effect;
 * the connection stays open. `docs/remote-protocol.md` must list exactly these plus `hello` / `pair`
 * (`scripts/remote-protocol-doc.test.mjs`). Writing files, settings, Slack, credentials and resizing a
 * terminal are absent by construction.
 *
 * Each operation reuses what the desktop does through a `RemoteHost` — the protocol layer itself owns only
 * the per-connection state: at most one watched conversation, one watched terminal, one attention watch, one
 * watched OpenSpec folder.
 */

export interface FolderView {
  id: string
  name: string
  branch: string | null
  pinned: boolean
  hasOpenSpec: boolean
}

export interface SessionView {
  id: string
  folderId: string | null
  target: 'claude' | 'shell'
  label: string
  running: boolean
  wait?: WaitState
  /**
   * Present exactly while `wait` is `ready`: whether someone looked at the session since its last turn ended
   * (`session-wait-indicator`). Its absence on a ready session means an older desktop.
   */
  seen?: boolean
  lifecycle?: string
  lineage?: { parentId: string; title?: string }
  /** The agent asked to close its own session, and the user has not answered (`remote-close-offer`). */
  closeOffered?: true
  /**
   * The background tasks in flight as of the agent's last report (`remote-background-tasks`): present only for a
   * running agent session with at least one, in the agent's order.
   */
  background?: BackgroundTask[]
}

export interface SessionList {
  window: boolean
  folders: FolderView[]
  sessions: SessionView[]
}

export type HostAction =
  | { kind: 'create'; folderId: string | null; target: 'claude' | 'shell' }
  | { kind: 'wake'; sessionId: string }
  | { kind: 'rename'; sessionId: string; name: string }
  /** `force`: skip the idle check (`remote-hibernate-close` D2). The interface never reads it. */
  | { kind: 'hibernate'; sessionId: string; force: boolean }
  | { kind: 'close'; sessionId: string; force: boolean }
  | { kind: 'accept'; adapter: string; id: string; folderId: string }
  /**
   * An agent asked to close its own session, and its turn ended (`agent-session-control` D12): show the offer, do
   * not close. `withdraw-close` takes it back (a keystroke into the session, or a device's `sessions.keep`). Neither
   * is a device operation as such.
   */
  | { kind: 'offer-close'; sessionId: string }
  | { kind: 'withdraw-close'; sessionId: string }

export interface ConversationSink {
  update(update: FollowUpdate): void
  /** `prompt`: the open prompt and whether this device may answer it (`remote-answer.ts`), or `null`. */
  wait(state: WaitState, pending: { tool: string; arg: string | null } | null, prompt: PromptView | null): void
}

/** Everything the protocol needs from the application. The real one is `remote-host.ts`. */
export interface RemoteHost {
  sessionList(): SessionList
  inboxList(): unknown
  handoffList(): unknown
  handoffBrief(sessionId: string): unknown | null
  /** `null` = no such session; `'none'` = a session with no conversation (a shell). */
  followConversation(sessionId: string, sink: ConversationSink): { stop(): void } | null | 'none'
  reply(
    watching: string | null,
    sessionId: string,
    text: string,
    attachments: readonly string[],
  ): Promise<{ outcome: ReplyOutcome; text: string }>
  /** One chunk of an attachment upload (`remote-attachments.ts`). */
  putAttachment(sessionId: string, p: PutParams): PutResult
  /** Answers the watched session's open prompt (`remote-answer.ts`). */
  answer(
    watching: string | null,
    sessionId: string,
    promptId: string,
    decision: AnswerDecision,
    selections: unknown,
  ): Promise<AnswerOutcome>
  watchTerminal(
    sessionId: string,
    from: TerminalPosition | undefined,
    listener: OutputListener,
  ): { snapshot: OutputSnapshot & { cols: number; rows: number }; stop(): void } | null
  writeTerminal(sessionId: string, data: string): boolean
  /** Carried out by the window's interface; rejects with a `RemoteError` (`NO_WINDOW`, `TIMEOUT`, …). */
  perform(action: HostAction): Promise<{ sessionId: string }>
  /** Withdraws an agent's offer to close its own session, as the desktop's Keep (`remote-close-offer` D2). */
  keep(sessionId: string): Promise<{ sessionId: string }>
  dismissInbox(adapter: string, id: string): void
  openspecChanges(folderId: string): Promise<unknown>
  openspecChange(folderId: string, slug: string): Promise<unknown>
  openspecSpecs(folderId: string): Promise<unknown>
  openspecSpec(folderId: string, topic: string): Promise<unknown>
  /** Starts watching the folder's OpenSpec on the desktop; resolves once its file watching is in place. */
  openspecWatch(folderId: string): Promise<void>
  watchAttention(
    after: AttentionPosition | undefined,
    listener: (event: AttentionEvent) => void,
  ): { events: AttentionEvent[]; complete: boolean; stop(): void } | null
  /** A remote watch counts as displayed for automatic hibernation. */
  setWatched(watchKey: string, sessionId: string | null): void
}

interface ConnectionState {
  connection: RemoteConnection
  host: RemoteHost
  conversation: { sessionId: string; stop(): void } | null
  terminal: { sessionId: string; stop(): void } | null
  attention: { stop(): void } | null
  /** The folder whose OpenSpec changes this connection is told of (`openspec.watch`). */
  openspec: string | null
}

type Operation = (state: ConnectionState, p: Record<string, unknown>) => unknown | Promise<unknown>

function str(p: Record<string, unknown>, key: string): string {
  const value = p[key]
  if (typeof value !== 'string' || value === '') throw new RemoteError('BAD_PARAMS', `\`${key}\` must be a non-empty string`)
  return value
}

function optionalStr(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RemoteError('BAD_PARAMS', `\`${key}\` must be a string`)
  return value
}

/** A session name from a device: control characters (newlines included) removed, clipped to 200 characters. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return [...name.replace(/[\x00-\x1f\x7f]/g, '')].slice(0, 200).join('')
}

/** `true` forces; absent, `null` and `false` do not (a client that encodes defaults sends `false`). */
function force(p: Record<string, unknown>): boolean {
  const value = p.force
  if (value === undefined || value === null || value === false) return false
  if (value === true) return true
  throw new RemoteError('BAD_PARAMS', '`force` must be a boolean')
}

function send(state: ConnectionState, k: string, d: unknown): void {
  state.connection.send(eventFrame(k, d))
}

function stopConversation(state: ConnectionState): void {
  state.conversation?.stop()
  state.conversation = null
  state.host.setWatched(`remote:${state.connection.id}:conversation`, null)
}

function stopTerminal(state: ConnectionState): void {
  state.terminal?.stop()
  state.terminal = null
  state.host.setWatched(`remote:${state.connection.id}:terminal`, null)
}

function position(value: unknown): TerminalPosition | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new RemoteError('BAD_PARAMS', '`from` must be { gen, offset }')
  const { gen, offset } = value as Record<string, unknown>
  if (typeof gen !== 'number' || typeof offset !== 'number') throw new RemoteError('BAD_PARAMS', '`from` must be { gen, offset }')
  return { gen, offset }
}

function attentionPosition(value: unknown): AttentionPosition | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new RemoteError('BAD_PARAMS', '`after` must be { epoch, seq }')
  const { epoch, seq } = value as Record<string, unknown>
  if (typeof epoch !== 'string' || typeof seq !== 'number') throw new RemoteError('BAD_PARAMS', '`after` must be { epoch, seq }')
  return { epoch, seq }
}

export const OPERATIONS: Record<string, Operation> = {
  'sessions.list': (state) => state.host.sessionList(),

  'sessions.create': (state, p) => {
    const target = p.target
    if (target !== 'claude' && target !== 'shell') throw new RemoteError('BAD_PARAMS', '`target` must be "claude" or "shell"')
    const folderId = p.folderId === null ? null : str(p, 'folderId')
    return state.host.perform({ kind: 'create', folderId, target })
  },

  'sessions.wake': (state, p) => state.host.perform({ kind: 'wake', sessionId: str(p, 'sessionId') }),

  'sessions.rename': (state, p) => {
    const name = p.name
    if (typeof name !== 'string') throw new RemoteError('BAD_PARAMS', '`name` must be a string (empty hands naming back)')
    return state.host.perform({ kind: 'rename', sessionId: str(p, 'sessionId'), name: cleanName(name) })
  },

  'sessions.hibernate': (state, p) => state.host.perform({ kind: 'hibernate', sessionId: str(p, 'sessionId'), force: force(p) }),

  'sessions.close': (state, p) => state.host.perform({ kind: 'close', sessionId: str(p, 'sessionId'), force: force(p) }),

  'sessions.keep': (state, p) => state.host.keep(str(p, 'sessionId')),

  'conversation.watch': (state, p) => {
    const sessionId = str(p, 'sessionId')
    const afterUuid = optionalStr(p, 'afterUuid')
    stopConversation(state)
    let first = true
    const follow = state.host.followConversation(sessionId, {
      update: (update) => {
        const delivered = first ? resumeFrom(update, afterUuid) : update
        first = false
        send(state, 'conversation.update', delivered)
      },
      wait: (wait, pending, prompt) => send(state, 'conversation.wait', { sessionId, state: wait, pending, prompt }),
    })
    if (follow === null) throw new RemoteError('NOT_FOUND', `no session ${sessionId}`)
    if (follow === 'none') throw new RemoteError('NO_CONVERSATION', 'this session has no conversation (a shell)')
    state.conversation = { sessionId, stop: () => follow.stop() }
    state.host.setWatched(`remote:${state.connection.id}:conversation`, sessionId)
    return { sessionId }
  },

  'conversation.unwatch': (state) => {
    stopConversation(state)
    return {}
  },

  'conversation.send': async (state, p) => {
    const raw = p.attachments ?? []
    if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string' && id !== '')) {
      throw new RemoteError('BAD_PARAMS', '`attachments` must be a list of attachment ids')
    }
    if (raw.length > LIMITS.perReply) throw new RemoteError('BAD_PARAMS', `at most ${LIMITS.perReply} attachments per reply`)
    // Text may be empty when attachments carry the reply.
    const text = optionalStr(p, 'text') ?? ''
    return state.host.reply(state.conversation?.sessionId ?? null, str(p, 'sessionId'), text, raw as string[])
  },

  'attachments.put': (state, p) =>
    state.host.putAttachment(str(p, 'sessionId'), {
      name: p.name,
      size: p.size,
      offset: p.offset,
      data: p.data,
      attachmentId: p.attachmentId,
    }),

  'conversation.answer': async (state, p) => {
    const decision = p.decision
    if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) {
      throw new RemoteError('BAD_PARAMS', `\`decision\` must be one of ${DECISIONS.join(', ')}`)
    }
    const outcome = await state.host.answer(
      state.conversation?.sessionId ?? null,
      str(p, 'sessionId'),
      str(p, 'promptId'),
      decision as AnswerDecision,
      p.selections,
    )
    return { outcome }
  },

  'terminal.watch': (state, p) => {
    const sessionId = str(p, 'sessionId')
    const from = position(p.from)
    stopTerminal(state)
    const watch = state.host.watchTerminal(sessionId, from, {
      data: (gen, offset, data) => send(state, 'terminal.data', { sessionId, gen, offset, data }),
      size: (cols, rows) => send(state, 'terminal.size', { sessionId, cols, rows }),
      ended: (reason) => {
        if (state.terminal?.sessionId === sessionId) {
          state.terminal = null
          state.host.setWatched(`remote:${state.connection.id}:terminal`, null)
        }
        send(state, 'terminal.ended', { sessionId, reason })
      },
    })
    if (!watch) throw new RemoteError('NOT_FOUND', `session ${sessionId} has no running process to watch`)
    state.terminal = { sessionId, stop: () => watch.stop() }
    state.host.setWatched(`remote:${state.connection.id}:terminal`, sessionId)
    return { sessionId, ...watch.snapshot }
  },

  'terminal.unwatch': (state) => {
    stopTerminal(state)
    return {}
  },

  'terminal.input': (state, p) => {
    const sessionId = str(p, 'sessionId')
    const data = p.data
    if (typeof data !== 'string' || data.length > 65_536) throw new RemoteError('BAD_PARAMS', '`data` must be a string')
    if (!state.host.writeTerminal(sessionId, data)) throw new RemoteError('NOT_FOUND', `session ${sessionId} has no running process`)
    return {}
  },

  'inbox.list': (state) => state.host.inboxList(),

  'inbox.accept': (state, p) => {
    const adapter = str(p, 'adapter')
    const id = str(p, 'id')
    const folderId = p.folderId
    if (typeof folderId !== 'string' || folderId === '') throw new RemoteError('FOLDER_REQUIRED', 'accepting needs the folder the user chose')
    return state.host.perform({ kind: 'accept', adapter, id, folderId })
  },

  'inbox.ignore': (state, p) => {
    state.host.dismissInbox(str(p, 'adapter'), str(p, 'id'))
    return {}
  },

  'handoffs.list': (state) => state.host.handoffList(),

  'handoffs.brief': (state, p) => {
    const brief = state.host.handoffBrief(str(p, 'sessionId'))
    if (brief === null) throw new RemoteError('NOT_FOUND', 'no handoff brief for this session')
    return brief
  },

  'openspec.changes': (state, p) => state.host.openspecChanges(str(p, 'folderId')),
  'openspec.change': (state, p) => state.host.openspecChange(str(p, 'folderId'), str(p, 'slug')),
  'openspec.specs': (state, p) => state.host.openspecSpecs(str(p, 'folderId')),
  'openspec.spec': (state, p) => state.host.openspecSpec(str(p, 'folderId'), str(p, 'topic')),

  /*
    One folder per connection; watching again replaces it, no folder stops it (`remote-openspec-browse` D5). The
    folder is recorded only once the host's file watching is in place, so a refused watch leaves none. Its presence
    in the operation list is also what tells a client the OpenSpec results have the documented shapes.
  */
  'openspec.watch': async (state, p) => {
    const folderId = optionalStr(p, 'folderId')
    if (folderId === undefined) {
      state.openspec = null
      return {}
    }
    await state.host.openspecWatch(folderId)
    state.openspec = folderId
    return {}
  },

  'attention.watch': (state, p) => {
    const after = attentionPosition(p.after)
    // Watching again replaces the earlier watch, so no event arrives twice.
    state.attention?.stop()
    state.attention = null
    const watch = state.host.watchAttention(after, (event) => send(state, 'attention', event))
    if (!watch) throw new RemoteError('NOT_FOUND', 'remote access is off')
    state.attention = { stop: () => watch.stop() }
    return { events: watch.events, complete: watch.complete }
  },
}

/** The methods handled before authentication, by the server. */
export const AUTH_OPERATIONS = ['hello', 'pair'] as const

/** Every operation name the protocol accepts — what the protocol document must list. */
export function operationNames(): string[] {
  return [...AUTH_OPERATIONS, ...Object.keys(OPERATIONS)].sort()
}

/** The protocol session of one authenticated connection. */
export function openRemoteSession(host: RemoteHost, connection: RemoteConnection): RemoteSessionHandle & {
  /** The window's interface reloaded or closed: its sessions' watches end, the connection stays. */
  windowGone(): void
  /**
   * A session's process ended (`remote-hibernate-close` D5): a conversation watch on it ends with how. The
   * terminal watch is ended by `RemoteOutput`, which tells its own listeners.
   */
  sessionEnded(sessionId: string, how: SessionEnd): void
  /** Whether this connection watches that folder's OpenSpec (`openspec.watch`). */
  watchesOpenSpec(folderId: string): boolean
} {
  const state: ConnectionState = { connection, host, conversation: null, terminal: null, attention: null, openspec: null }
  return {
    onRequest: (frame: RequestFrame) => {
      const operation = Object.hasOwn(OPERATIONS, frame.m) ? OPERATIONS[frame.m] : undefined
      if (!operation) {
        connection.send(errorFrame(frame.id, 'UNKNOWN_OPERATION', `unknown operation: ${frame.m}`))
        return
      }
      void (async () => {
        try {
          const result = await operation(state, frame.p)
          connection.send(resultFrame(frame.id, result))
        } catch (error) {
          if (error instanceof RemoteError) connection.send(errorFrame(frame.id, error.code, error.message, error.detail))
          else {
            console.error(`[remote] ${frame.m} failed: ${String(error)}`)
            connection.send(errorFrame(frame.id, 'INTERNAL', 'the operation failed'))
          }
        }
      })()
    },
    windowGone: () => {
      const conversation = state.conversation?.sessionId
      const terminal = state.terminal?.sessionId
      stopConversation(state)
      stopTerminal(state)
      if (conversation) send(state, 'conversation.ended', { sessionId: conversation, reason: 'window' })
      if (terminal) send(state, 'terminal.ended', { sessionId: terminal, reason: 'window' })
    },
    sessionEnded: (sessionId, how) => {
      if (state.conversation?.sessionId !== sessionId) return
      // Through `stopConversation`: it also withdraws the watch's "displayed" report, without which the woken
      // session would count as displayed for automatic hibernation for good.
      stopConversation(state)
      send(state, 'conversation.ended', { sessionId, reason: how })
    },
    watchesOpenSpec: (folderId) => state.openspec === folderId,
    dispose: () => {
      state.openspec = null
      stopConversation(state)
      stopTerminal(state)
      state.attention?.stop()
      state.attention = null
    },
  }
}
