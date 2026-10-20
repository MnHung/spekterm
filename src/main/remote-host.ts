import { preferredTitle } from '../shared/lineage/label'
import { armOrigin } from './agent-origin'
import { type AgentStatus, readAgentStatus } from './agent-status'
import { backgroundOf, dismissRequest, markAnswered, openRequestsOf, refreshWait, subscribeWait, waitStateOf } from './agent-wait'
import type { FinishedCall, WaitState } from './agent-events'
import { busyReason } from './hibernation-policy'
import { lastKeystrokeAt } from './pty-input'
import { promptView, writeAnswer } from './remote-answer'
import { startFollow } from './conversation-follow'
import { readBriefFor } from './handoff-brief'
import { lifecycleViewOf } from './handoff-lifecycle-view'
import { dismissIntake } from './intake-changes'
import {
  SUBMIT_KEY,
  SUBMIT_KEY_DELAY_MS,
  hasUnconfirmedSubmission,
  isSubmitted,
  notePrefillKey,
  prefillOf,
  type PrefillView,
} from './intake-prefill'
import { listView } from './intake-projection'
import type { RoutingStore } from './intake-routing'
import type { IntakeService } from './intake-service'
import type { OpenSpecService } from './openspec-service'
import { OpenSpecServiceError } from './openspec-service'
import type { AttentionLog } from './remote-attention'
import type { AttachmentStore } from './remote-attachments'
import { watchUsage } from './remote-agent-status'
import { runQueued, sendReply } from './remote-conversation'
import { RemoteError, type ErrorCode } from './remote-frames'
import { remoteChange, remoteChanges, remoteSpec, remoteSpecs } from './remote-openspec'
import type { RemoteOutput } from './remote-output'
import type { FolderView, HostAction, RemoteHost, SessionList, SessionView } from './remote-protocol'
import type { SessionStore } from './session-store'
import type { TerminalService } from './terminal'
import type { FolderLookup } from './workspace-store'
import { seenMarks } from './wait-seen'

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
  /** The session's unconfirmed prefill and the note of a submit key (`intake-prefill.ts`); the real ones by default. */
  prefills?: {
    of(sessionId: string): PrefillView | null
    noteKey(sessionId: string): void
  }
  /** Resolves `true` once the agent starts working (`isSubmitted`), `false` after `ms`; subscribed before the key. */
  started?: (sessionId: string, ms: number) => Promise<boolean>
  /** The agent's reported status (`agent-status.ts`); injected for tests. */
  readStatus?: (sessionId: string) => AgentStatus | undefined
  /** Arms the phone-origin note (`agent-origin.ts`); injected for tests. */
  armOrigin?: (sessionId: string) => boolean
}

/** How long a device's submit waits to see the agent start before answering `sent` (`remote-prefill-send` D3). */
export const SUBMIT_CONFIRM_WINDOW_MS = 3_000

function agentStarted(sessionId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
    const off = subscribeWait(sessionId, (snapshot) => {
      if (!isSubmitted(snapshot.state)) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
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

/**
 * The service's lookup errors become `NOT_FOUND` with their message (it names only the identifier the device sent).
 * A read failure's message is a file system error's text, absolute path included, so it stays in the log and the
 * device gets a fixed one (`remote-openspec-browse` D2).
 */
async function openspecCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof OpenSpecServiceError) {
      if (error.code !== 'READ_FAILED') throw new RemoteError('NOT_FOUND', error.message)
      console.error(`[remote] OpenSpec read failed: ${error.message}`)
      throw new RemoteError('INTERNAL', 'the OpenSpec content could not be read')
    }
    throw error
  }
}

/** An agent session's wait state, and while it is ready, whether its last turn end was seen (`session-wait-indicator`). */
function waitFields(sessionId: string): Pick<SessionView, 'wait' | 'seen'> {
  const wait = waitStateOf(sessionId)
  return wait === 'ready' ? { wait, seen: seenMarks.seenOf(sessionId) } : { wait }
}

/** A running agent session's background tasks, absent when there is none (`remote-background-tasks` D5). */
function backgroundField(sessionId: string): Pick<SessionView, 'background'> {
  const background = backgroundOf(sessionId)
  return background.length > 0 ? { background } : {}
}

function prefillField(prefill: SessionView['prefill'] | null): Pick<SessionView, 'prefill'> {
  return prefill ? { prefill } : {}
}

export function createRemoteHost(deps: HostDeps): RemoteHost {
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const service = (): TerminalService | undefined => {
    const contentsId = deps.window()
    return contentsId === null ? undefined : deps.terminal(contentsId)
  }

  const record = (sessionId: string) => deps.sessions.view().find((entry) => entry.session.id === sessionId)?.session
  const prefills = deps.prefills ?? { of: prefillOf, noteKey: notePrefillKey }

  /**
   * The fill a device may see and submit (`remote-prefill-send` D2): the desktop shows it as not sent, and its item
   * is still listed for this session — after the desktop's "clear" the client could no longer show the body.
   */
  const listedPrefill = (sessionId: string): NonNullable<SessionView['prefill']> | null => {
    const view = prefills.of(sessionId)
    if (!view || !view.offered || !view.intake) return null
    const item = deps.intake.store.get(view.intake.adapter, view.intake.id)
    if (!item || item.state !== 'accepted' || item.sessionId !== sessionId || item.settledAt !== undefined) return null
    return { id: view.id, text: view.text, intake: { ...view.intake }, edited: view.edited }
  }

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
          ...(target === 'claude' ? waitFields(session.id) : {}),
          ...(lifecycle.has(session.id) ? { lifecycle: lifecycle.get(session.id) } : {}),
          ...(session.lineage
            ? { lineage: { parentId: session.lineage.parentId, ...(session.lineage.parentTitle ? { title: session.lineage.parentTitle } : {}) } }
            : {}),
          // Only while it runs, whatever the record says: an end announced in advance is not timed (D5).
          ...(live.has(session.id) && deps.offers.offered(session.id) ? { closeOffered: true as const } : {}),
          // Only while it runs, as the offer: a list kept past a process end never reaches a device (D3).
          ...(target === 'claude' && live.has(session.id) ? backgroundField(session.id) : {}),
          ...(target === 'claude' && live.has(session.id) ? prefillField(listedPrefill(session.id)) : {}),
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
        skills: (list) => sink.skills(list),
      })
      if (!follow) return 'none'
      // With the follow's first update and wait, before the answer: one poll per watch (`remote-phone-context` B3).
      const usage = watchUsage(sessionId, deps.readStatus ?? readAgentStatus, (view) => {
        if (alive) sink.status(view)
      })
      return {
        stop: () => {
          alive = false
          usage.stop()
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
          waitStateOf: (deps.waits ?? REAL_WAITS).stateOf,
          write: (id, data) => {
            const terminal = service()
            if (!terminal || terminal.sizeOf(id) === null) return false
            terminal.write(id, data)
            return true
          },
          delay,
          submitDelayMs: SUBMIT_KEY_DELAY_MS,
          armOrigin: (id) => (deps.armOrigin ?? armOrigin)(id),
          // Any unconfirmed fill, listed or not, edited or not (`remote-prefill-send` D5).
          prefillPending: (id) => {
            const view = prefills.of(id)
            if (!view) return null
            const listed = listedPrefill(id)
            return { ...(listed ? { prefillId: listed.id } : {}), edited: view.edited }
          },
        },
        watching,
        sessionId,
        text,
        take,
      )
    },

    async submitPrefill(sessionId, prefillId) {
      if (deps.window() === null) throw new RemoteError('NO_WINDOW', 'the desktop has no window open')
      const terminal = service()
      if (!record(sessionId) || !terminal || terminal.sizeOf(sessionId) === null) {
        throw new RemoteError('NOT_FOUND', `session ${sessionId} has no running process`)
      }
      const waits = deps.waits ?? REAL_WAITS
      // In the session's queue, so no reply or answer is written between these checks and the key (D3).
      return runQueued(sessionId, async () => {
        const listed = listedPrefill(sessionId)
        if (!listed || listed.id !== prefillId) throw new RemoteError('PREFILL_GONE', 'that filled-in prompt is not waiting to be sent')
        if (listed.edited) throw new RemoteError('PREFILL_EDITED', 'something was typed into the session; send it at the desktop')
        // The periodic drain can be 400 ms behind a choice. The refresh can also remove the fill (a start), so the
        // state is read first: a choice is then answered as one, and the fill read again after.
        waits.refresh(sessionId)
        const state = waits.stateOf(sessionId)
        if (state !== 'ready') {
          throw new RemoteError('WAIT_STATE', `the agent cannot take the prompt now (${state})`, { state })
        }
        if (listedPrefill(sessionId)?.id !== prefillId) throw new RemoteError('PREFILL_GONE', 'that filled-in prompt is not waiting to be sent')
        const now = service()
        if (!now || now.sizeOf(sessionId) === null) throw new RemoteError('NOT_FOUND', `session ${sessionId} has no running process`)
        // Watched before the key, so a start drained right after it is not missed.
        const started = (deps.started ?? agentStarted)(sessionId, SUBMIT_CONFIRM_WINDOW_MS)
        // The user sent it from the phone (`remote-phone-context` A2); a failure to arm is no note.
        try {
          ;(deps.armOrigin ?? armOrigin)(sessionId)
        } catch {
          // No note for this prompt.
        }
        now.write(sessionId, SUBMIT_KEY)
        // At once: the device's own key is not typing over the prompt, so a key that did not take can be sent again.
        prefills.noteKey(sessionId)
        // The settle is `watchSubmission`'s, as for the desktop's Enter; this only says whether a start was seen.
        return { outcome: (await started) ? ('confirmed' as const) : ('sent' as const) }
      })
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

    // Mapped to the protocol's own shapes (`remote-openspec.ts`); never the service's views as they are.
    openspecChanges: (folderId) => openspecCall(async () => remoteChanges(await deps.openspec().getChanges(folderId))),
    openspecChange: (folderId, slug) =>
      openspecCall(async () => remoteChange(await deps.openspec().getChange(folderId, slug))),
    openspecSpecs: (folderId) => openspecCall(async () => remoteSpecs(await deps.openspec().getSpecs(folderId))),
    openspecSpec: (folderId, topic) => openspecCall(async () => remoteSpec(await deps.openspec().getSpec(folderId, topic))),
    /*
      A scan is what starts the service's file watching for the folder, and the watchers of its other working
      trees exist only once the scan resolved — so the answer waits for it (`remote-openspec-browse` D5).
    */
    openspecWatch: (folderId) => openspecCall(async () => void (await deps.openspec().getOverview(folderId))),

    watchAttention: (after, listener) => deps.attention.watch(after, listener),

    setWatched: (watchKey, sessionId) => deps.setRemoteWatched(watchKey, sessionId),
  }
}
