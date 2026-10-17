import { preferredTitle } from '../shared/lineage/label'
import { dismissRequest, markAnswered, openRequestsOf, refreshWait, subscribeWait, waitStateOf } from './agent-wait'
import type { FinishedCall, WaitState } from './agent-events'
import { busyReason } from './hibernation-policy'
import { lastKeystrokeAt } from './pty-input'
import { promptView, writeAnswer } from './remote-answer'
import { startFollow } from './conversation-follow'
import { readBriefFor } from './handoff-brief'
import { lifecycleViewOf } from './handoff-lifecycle-view'
import { dismissIntake } from './intake-changes'
import { SUBMIT_KEY_DELAY_MS, hasUnconfirmedSubmission } from './intake-prefill'
import { listView } from './intake-projection'
import type { RoutingStore } from './intake-routing'
import type { IntakeService } from './intake-service'
import type { OpenSpecService } from './openspec-service'
import { OpenSpecServiceError } from './openspec-service'
import type { AttentionLog } from './remote-attention'
import type { AttachmentStore } from './remote-attachments'
import { runQueued, sendReply } from './remote-conversation'
import { RemoteError, type ErrorCode } from './remote-frames'
import type { RemoteOutput } from './remote-output'
import type { FolderView, HostAction, RemoteHost, SessionList, SessionView } from './remote-protocol'
import type { SessionStore } from './session-store'
import type { TerminalService } from './terminal'
import type { FolderLookup } from './workspace-store'

/**
 * The application as the remote protocol sees it (`remote-protocol`). Every method reuses the desktop's
 * own path for the same thing — the session store, the transcript follower, the send gate, the inbox
 * projection, the OpenSpec service — so a phone cannot reach a state the desktop cannot.
 *
 * Electron-free: the window, the terminal service and the renderer bridge are injected (`index.ts`), so the
 * no-window behavior is tested without a window.
 */

/** What the window's interface answers to a create, wake or accept (`workspace:remote:reply`). */
export type RendererOutcome = { ok: true; sessionId: string } | { ok: false; code: string; message?: string }

export interface HostDeps {
  /** The live window's `webContents.id`, or `null` when there is none (macOS after closing it). */
  window: () => number | null
  folders: FolderLookup
  sessions: SessionStore
  terminal: (contentsId: number) => TerminalService | undefined
  output: RemoteOutput
  intake: IntakeService
  routing: RoutingStore
  openspec: () => OpenSpecService
  attention: AttentionLog
  /** Asks the window's interface to carry out an action; resolves with its outcome or rejects on timeout. */
  request: (contentsId: number, action: HostAction) => Promise<RendererOutcome>
  setRemoteWatched: (watchKey: string, sessionId: string | null) => void
  /**
   * An agent's offer to close its own session (`agent-session-control` D12), owned by `SessionControl`
   * (`remote-close-offer` D1): whether one stands now, and withdrawing it in the main process (the window is asked
   * here). Built after the host in `index.ts`, so passed as closures.
   */
  offers: {
    offered(sessionId: string): boolean
    withdraw(sessionId: string): boolean
  }
  /** Where a device's attachments are stored (`remote-attachments.ts`); `null` until configured. */
  attachments?: AttachmentStore | null
  delay?: (ms: number) => Promise<void>
  /** What a device's hibernate or close checks (`remote-hibernate-close` D3); the real functions by default. */
  waits?: {
    /** Drains the agent's events now: the periodic drain can be 400 ms behind a prompt. */
    refresh(sessionId: string): void
    stateOf(sessionId: string): WaitState
    unsent(sessionId: string): boolean
  }
}

const RENDERER_CODES: readonly ErrorCode[] = ['NOT_FOUND', 'CREATE_FAILED', 'FOLDER_REQUIRED', 'NO_WINDOW', 'TIMEOUT', 'BAD_PARAMS']

const REAL_WAITS = { refresh: refreshWait, stateOf: waitStateOf, unsent: hasUnconfirmedSubmission }

/** What the window's interface answered, as a device's result or error. */
function fromRenderer(outcome: RendererOutcome): { sessionId: string } {
  if (outcome.ok) return { sessionId: outcome.sessionId }
  const code = (RENDERER_CODES as readonly string[]).includes(outcome.code) ? (outcome.code as ErrorCode) : 'CREATE_FAILED'
  throw new RemoteError(code, outcome.message ?? 'the desktop could not carry it out')
}

function folderViews(folders: FolderLookup): FolderView[] {
  return folders.list().map((folder) => ({
    id: folder.id,
    name: folder.name,
    branch: folder.branch,
    pinned: folder.pinned,
    hasOpenSpec: folder.hasOpenSpec,
  }))
}

async function openspecCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof OpenSpecServiceError) {
      throw new RemoteError(error.code === 'READ_FAILED' ? 'INTERNAL' : 'NOT_FOUND', error.message)
    }
    throw error
  }
}

export function createRemoteHost(deps: HostDeps): RemoteHost {
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const service = (): TerminalService | undefined => {
    const contentsId = deps.window()
    return contentsId === null ? undefined : deps.terminal(contentsId)
  }

  const record = (sessionId: string) => deps.sessions.view().find((entry) => entry.session.id === sessionId)?.session

  return {
    sessionList(): SessionList {
      const contentsId = deps.window()
      if (contentsId === null) return { window: false, folders: folderViews(deps.folders), sessions: [] }
      const live = new Set(deps.terminal(contentsId)?.liveSessionIds() ?? [])
      const lifecycle = new Map(lifecycleViewOf(deps.sessions).map((view) => [view.sessionId, view.state]))
      const sessions: SessionView[] = deps.sessions.view().map(({ session }) => {
        const target = session.spawnTarget
        return {
          id: session.id,
          folderId: session.folderId,
          target,
          label: preferredTitle(session) ?? (session.ordinal ? `${target} ${session.ordinal}` : target),
          running: live.has(session.id),
          ...(target === 'claude' ? { wait: waitStateOf(session.id) } : {}),
          ...(lifecycle.has(session.id) ? { lifecycle: lifecycle.get(session.id) } : {}),
          ...(session.lineage
            ? { lineage: { parentId: session.lineage.parentId, ...(session.lineage.parentTitle ? { title: session.lineage.parentTitle } : {}) } }
            : {}),
          // Only while it runs, whatever the record says: an end announced in advance is not timed (D5).
          ...(live.has(session.id) && deps.offers.offered(session.id) ? { closeOffered: true as const } : {}),
        }
      })
      return { window: true, folders: folderViews(deps.folders), sessions }
    },

    inboxList() {
      const known = new Set(deps.folders.list().map((folder) => folder.id))
      return { items: listView(deps.intake.store.list(), deps.routing.get(), known) }
    },

    handoffList: () => lifecycleViewOf(deps.sessions),

    handoffBrief: (sessionId) => readBriefFor(deps.sessions, sessionId),

    followConversation(sessionId, sink) {
      const session = record(sessionId)
      const terminal = service()
      if (!session || !terminal) return null
      if (session.spawnTarget === 'shell') return 'none'
      const source = terminal.agentSourceOf(sessionId)
      if (!source) return null
      let alive = true
      const follow = startFollow(sessionId, source, {
        update: sink.update,
        wait: (state, pending, requests) => sink.wait(state, pending, promptView(requests, lastKeystrokeAt(sessionId))),
        alive: () => alive,
      })
      if (!follow) return 'none'
      return {
        stop: () => {
          alive = false
          follow.stop()
        },
      }
    },

    putAttachment(sessionId, p) {
      const session = record(sessionId)
      if (!session) throw new RemoteError('NOT_FOUND', `no session ${sessionId}`)
      if (session.spawnTarget === 'shell') throw new RemoteError('NO_CONVERSATION', 'this session has no conversation (a shell)')
      if (!deps.attachments) throw new RemoteError('INTERNAL', 'attachments are not available')
      return deps.attachments.put(sessionId, p)
    },

    reply(watching, sessionId, text, attachments) {
      const store = deps.attachments
      const take =
        attachments.length === 0
          ? undefined
          : () => {
              if (!store) throw new RemoteError('NOT_FOUND', 'no such attachment')
              return store.reserve(sessionId, attachments)
            }
      return sendReply(
        {
          waitStateOf,
          write: (id, data) => {
            const terminal = service()
            if (!terminal || terminal.sizeOf(id) === null) return false
            terminal.write(id, data)
            return true
          },
          delay,
          submitDelayMs: SUBMIT_KEY_DELAY_MS,
        },
        watching,
        sessionId,
        text,
        take,
      )
    },

    answer(watching, sessionId, promptId, decision, selections) {
      if (watching !== sessionId) {
        return Promise.reject(new RemoteError('NOT_WATCHING', 'answer only the conversation this connection watches'))
      }
      return runQueued(sessionId, () =>
        writeAnswer(
          {
            refresh: (id) => {
              refreshWait(id)
              return openRequestsOf(id)
            },
            lastKeystrokeAt,
            write: (id, key) => {
              const terminal = service()
              if (!terminal || terminal.sizeOf(id) === null) return false
              terminal.write(id, key, 'answer')
              return true
            },
            markAnswered: (id, requestId, at) => void markAnswered(id, requestId, at),
            dismiss: (id, requestId) => void dismissRequest(id, requestId),
            awaitFinished: (id, toolUseId, ms) =>
              new Promise<FinishedCall | null>((resolve) => {
                const timer = setTimeout(() => {
                  off()
                  resolve(null)
                }, ms)
                const off = subscribeWait(id, (snapshot) => {
                  const finished = snapshot.finished.find((call) => call.toolUseId === toolUseId)
                  if (!finished) return
                  clearTimeout(timer)
                  off()
                  resolve(finished)
                })
              }),
            delay,
            now: Date.now,
          },
          sessionId,
          promptId,
          decision,
          selections,
        ),
      )
    },

    watchTerminal(sessionId, from, listener) {
      const size = service()?.sizeOf(sessionId)
      if (!size) return null
      const watch = deps.output.watch(sessionId, from, listener)
      if (!watch) return null
      return { snapshot: { ...watch.snapshot, ...size }, stop: watch.stop }
    },

    writeTerminal(sessionId, data) {
      const terminal = service()
      if (!terminal || terminal.sizeOf(sessionId) === null) return false
      terminal.write(sessionId, data)
      return true
    },

    async perform(action) {
      const contentsId = deps.window()
      // **No window is opened for a device** (`remote-protocol`): the user is not at the desktop.
      if (contentsId === null) throw new RemoteError('NO_WINDOW', 'the desktop has no window open')
      // "Already running" is the main process's fact (it holds the pty); the interface's status can lag
      // a hibernation by a moment, so it is not asked whether a session runs — only to wake one that does not.
      if (action.kind === 'wake' && deps.terminal(contentsId)?.sizeOf(action.sessionId)) return { sessionId: action.sessionId }
      if (action.kind === 'hibernate' || action.kind === 'close') {
        if (!record(action.sessionId)) throw new RemoteError('NOT_FOUND', `no session ${action.sessionId}`)
        const terminal = deps.terminal(contentsId)
        const running = Boolean(terminal?.sizeOf(action.sessionId))
        // Already dormant: the state asked for holds (as a wake of a running session answers at once).
        if (action.kind === 'hibernate' && !running) return { sessionId: action.sessionId }
        const facts = running && !action.force ? terminal?.idleFactsOf(action.sessionId) : null
        if (facts) {
          // The one definition of idle, shared with automatic hibernation (`hibernation-policy.ts`). The
          // desktop is the only side that knows whether something would be lost, so it says why.
          const waits = deps.waits ?? REAL_WAITS
          waits.refresh(action.sessionId)
          const reason = busyReason({
            target: facts.target,
            wait: waits.stateOf(action.sessionId),
            unconfirmedSubmission: waits.unsent(action.sessionId),
            shell: facts.shell,
          })
          if (reason) throw new RemoteError('SESSION_BUSY', `the session is busy (${reason}); send again with force to proceed`, { reason })
        }
      }
      return fromRenderer(await deps.request(contentsId, action))
    },

    async keep(sessionId) {
      const contentsId = deps.window()
      if (contentsId === null) throw new RemoteError('NO_WINDOW', 'the desktop has no window open')
      if (!record(sessionId)) throw new RemoteError('NOT_FOUND', `no session ${sessionId}`)
      // The record first, so the list is right whatever the window does next (`remote-close-offer` D2).
      deps.offers.withdraw(sessionId)
      // Asked even when there was no offer: a retry after a timed-out attempt still clears the desktop's card.
      fromRenderer(await deps.request(contentsId, { kind: 'withdraw-close', sessionId }))
      return { sessionId }
    },

    dismissInbox(adapter, id) {
      if (!deps.intake.store.get(adapter, id)) throw new RemoteError('NOT_FOUND', 'no such inbox item')
      dismissIntake(deps.intake.store, adapter, id)
    },

    openspecChanges: (folderId) => openspecCall(() => deps.openspec().getChanges(folderId)),
    openspecChange: (folderId, slug) => openspecCall(() => deps.openspec().getChange(folderId, slug)),
    openspecSpecs: (folderId) => openspecCall(() => deps.openspec().getSpecs(folderId)),
    openspecSpec: (folderId, topic) => openspecCall(() => deps.openspec().getSpec(folderId, topic)),

    watchAttention: (after, listener) => deps.attention.watch(after, listener),

    setWatched: (watchKey, sessionId) => deps.setRemoteWatched(watchKey, sessionId),
  }
}
