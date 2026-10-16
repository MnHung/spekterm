import { ancestryOf } from '../shared/lineage/ancestry'
import { preferredTitle } from '../shared/lineage/label'
import { type CommandKind, parseCommand, type SessionCommand } from './handoff-delivery'
import type { IntakeRejection } from './intake-schema'
import { isPermanentRejection } from './intake-rejection'
import type { DeliverOutcome, FailureContext } from './intake-service'
import type { HostAction } from './remote-protocol'
import type { RendererOutcome } from './remote-host'
import type { PersistedSession } from './session-store'

/**
 * An agent's session commands: close, hibernate or rename its own session or a descendant
 * (`agent-session-control`).
 *
 * Electron-free; everything it reads or does is injected (`index.ts` wires the real ones), so every branch is
 * tested by facts rather than by a window.
 *
 * ## What it decides, and in what order
 *
 * 1. **Who** (design D2): the target is the source, or an existing session whose fixed name matches exactly and
 *    whose chain of ancestors holds the source. The chain is walked over every record; existence only filters
 *    who may be named. Nothing in the command's contents says who sent it: the drop point does.
 * 2. **Whether it still applies** (D11): a close or hibernate written before the target's process last started
 *    or ended (a wake, a hibernate, a quit) yields to that later act, silently.
 * 3. **When** (D3): a rename at once; a close or hibernate at once on a target at rest, otherwise when its turn
 *    ends. A keystroke into the target or its process ending drops the wait.
 *
 * ## `deliver` never waits for the window
 *
 * The drop points are read one file at a time, and a periodic re-read is skipped while the last one runs. A
 * `deliver` that awaited the window would stall every handoff and report behind one command (D6). So it decides,
 * returns, and the request runs on its own. Its failures come after the file was consumed, and are reported here.
 */

export type ControlRequest = (action: HostAction) => Promise<RendererOutcome>

/** Whether the window can be asked now: its restore finished (D9). `'ready'`, or why not. */
export type GateResult = 'ready' | 'no-window' | 'timeout'

export interface SessionControlDeps {
  /** Every record, provisional ones included, each with whether it **exists** (`sessionExists`). */
  sessions: () => readonly { session: PersistedSession; exists: boolean }[]
  /** The session has a pty now. */
  running: (sessionId: string) => boolean
  /** Drains the agent's events now (`refreshWait`). */
  refreshWait: (sessionId: string) => void
  /** A turn is in progress (`inTurnOf`). */
  inTurn: (sessionId: string) => boolean
  /** Hears every drain of the session's events. */
  subscribeWait: (sessionId: string, listener: () => void) => () => void
  /** Hears every keystroke into any session. */
  onKeystroke: (listener: (sessionId: string) => void) => () => void
  agentEventsEnabled: () => boolean
  /** `session-runs.ts`. */
  runs: {
    runStartedAt: () => number
    lastProcessChangeAt: (sessionId: string) => number | null
    expectCommandEnd: (sessionId: string) => void
    cancelCommandEnd: (sessionId: string) => void
  }
  /** Resolves once the window can be asked (its restore is done), bounded (D9). */
  whenReady: () => Promise<GateResult>
  /** Asks the window to carry an action out (`requestRenderer`), quietly. */
  request: ControlRequest
  /** The source session's rail item and label, for the trace (`failure.origin`); `null` when it is gone. */
  describe: (sessionId: string) => string | null
  /** The intake service's two halves of a visible failure. */
  reject: (code: IntakeRejection, label: string, detail: string | undefined, failure: FailureContext) => DeliverOutcome
  reportFailure: (code: IntakeRejection, detail: string | undefined, failure: FailureContext) => void
}

/** The origin shown for a command whose source session no longer exists (as for handoffs). */
const ENDED_ORIGIN = '(ended)'

interface Pending {
  command: SessionCommand & { kind: 'close' | 'hibernate' }
  failure: FailureContext
  mtimeMs: number
  stop: () => void
}

const DONE: DeliverOutcome = { ok: true, consume: true, notify: false }

export class SessionControl {
  readonly #deps: SessionControlDeps
  readonly #seen = new Set<string>()
  readonly #pending = new Map<string, Pending>()
  /** Sessions whose own close is offered to the user (D12): a keystroke into one withdraws the offer. */
  readonly #offered = new Set<string>()
  readonly #stopKeystrokes: () => void

  constructor(deps: SessionControlDeps) {
    this.#deps = deps
    // Anything typed into a target takes it back: its waiting command is dropped, silently (D3).
    this.#stopKeystrokes = deps.onKeystroke((sessionId) => {
      this.#drop(sessionId)
      this.#withdrawOffer(sessionId)
    })
  }

  dispose(): void {
    this.#stopKeystrokes()
    for (const sessionId of [...this.#pending.keys()]) this.#drop(sessionId)
  }

  /** The target's process ended for any reason: a command waiting on its turn is dropped (D3). */
  processEnded(sessionId: string): void {
    this.#drop(sessionId)
    this.#offered.delete(sessionId)
  }

  /** Sessions whose own close is offered, for tests and diagnostics. */
  isOffered(sessionId: string): boolean {
    return this.#offered.has(sessionId)
  }

  /** Typing into an offered session takes it back: the offer goes, the session stays. */
  #withdrawOffer(sessionId: string): void {
    if (!this.#offered.delete(sessionId)) return
    void this.#deps.request({ kind: 'withdraw-close', sessionId }).catch(() => undefined)
  }

  /** The targets with a command waiting on their turn. */
  pendingTargets(): string[] {
    return [...this.#pending.keys()]
  }

  /** Waiting commands, for tests and diagnostics. */
  pendingFor(sessionId: string): CommandKind | null {
    return this.#pending.get(sessionId)?.command.kind ?? null
  }

  /**
   * One command file from `sourceId`'s drop point. `identity` makes a file read twice act once; `mtimeMs` is the
   * file's time as the read saw it (D11).
   */
  deliver(sourceId: string, kind: CommandKind, contents: string, identity: string, mtimeMs: number | undefined): DeliverOutcome {
    if (this.#seen.has(identity)) return DONE
    const parsed = parseCommand(kind, contents)
    const origin = this.#deps.describe(sourceId) ?? ENDED_ORIGIN
    if (!parsed.ok) {
      const failure: FailureContext = { origin, subject: 'command' }
      this.#seen.add(identity)
      return parsed.reason === 'TOO_LONG'
        ? { ...this.#deps.reject('TOO_LONG', kind, `name ${parsed.length}`, failure), failure }
        : { ...this.#deps.reject('FIELD_TYPE', kind, parsed.field, failure), failure }
    }
    const command = parsed.command
    this.#seen.add(identity)

    const view = this.#deps.sessions()
    const records = new Map(view.map((entry) => [entry.session.id, entry.session]))
    const existing = view.filter((entry) => entry.exists).map((entry) => entry.session)
    const source = existing.find((session) => session.id === sourceId)
    const named = command.target === undefined ? undefined : existing.find((session) => session.peerName === command.target)
    const descends = (session: PersistedSession): boolean =>
      ancestryOf(session.id, (id) => records.get(id)).includes(sourceId)
    const failure: FailureContext = {
      origin,
      target: command.target ?? (source ? (preferredTitle(source) ?? source.peerName ?? '') : ''),
      subject: 'command',
    }

    let target: PersistedSession
    if (!source) {
      // S is gone (the usual case on its drop point's final read). Only an existing descendant is still acted on;
      // anything else is dropped silently: S's own name cannot be told from an unknown one any more (D2).
      if (!named || !descends(named)) return DONE
      target = named
    } else if (command.target === undefined || command.target === source.peerName) {
      target = source
    } else if (!named) {
      return { ...this.#deps.reject('CONTROL_TARGET_NOT_FOUND', command.target, undefined, failure), failure }
    } else if (!descends(named)) {
      return { ...this.#deps.reject('CONTROL_NOT_ALLOWED', command.target, undefined, failure), failure }
    } else {
      target = named
    }

    if (command.kind === 'rename') {
      void this.#carryOut(target.id, command, failure, undefined)
      return DONE
    }
    const ending = command as SessionCommand & { kind: 'close' | 'hibernate' }
    // Written before the target's last start or end: the user's later act wins (D11). No time: cannot tell.
    if (mtimeMs === undefined || this.#stale(target.id, mtimeMs)) return DONE

    const self = target.id === sourceId
    if (!this.#deps.running(target.id)) {
      if (ending.kind === 'close') void this.#carryOut(target.id, ending, failure, mtimeMs, self)
      return DONE
    }
    if (!this.#deps.agentEventsEnabled()) {
      return { ...this.#deps.reject('CONTROL_UNAVAILABLE', command.target ?? kind, undefined, failure), failure }
    }
    this.#deps.refreshWait(target.id)
    if (!this.#deps.inTurn(target.id)) {
      this.#drop(target.id)
      void this.#carryOut(target.id, ending, failure, mtimeMs, self)
      return DONE
    }
    this.#wait(target.id, ending, failure, mtimeMs, self)
    return DONE
  }

  #stale(sessionId: string, mtimeMs: number): boolean {
    const since = this.#deps.runs.lastProcessChangeAt(sessionId) ?? this.#deps.runs.runStartedAt()
    return mtimeMs < since
  }

  #wait(sessionId: string, command: Pending['command'], failure: FailureContext, mtimeMs: number, self: boolean): void {
    // One per target; the latest wins.
    this.#drop(sessionId)
    const stop = this.#deps.subscribeWait(sessionId, () => {
      if (this.#pending.get(sessionId)?.stop !== stop) return
      if (this.#deps.inTurn(sessionId)) return
      this.#drop(sessionId)
      void this.#carryOut(sessionId, command, failure, mtimeMs, self)
    })
    this.#pending.set(sessionId, { command, failure, mtimeMs, stop })
  }

  #drop(sessionId: string): void {
    const pending = this.#pending.get(sessionId)
    if (!pending) return
    this.#pending.delete(sessionId)
    pending.stop()
  }

  /**
   * Asks the window, once it can be asked. **Decided again** when the gate releases it: a reload in between ends
   * every pty, and the target may have been closed or woken (D9, D11).
   */
  async #carryOut(
    sessionId: string,
    command: SessionCommand,
    failure: FailureContext,
    mtimeMs: number | undefined,
    self = false,
  ): Promise<void> {
    const gate = await this.#deps.whenReady()
    if (gate !== 'ready') {
      this.#fail('CONTROL_NO_WINDOW', gate === 'timeout' ? 'TIMEOUT' : 'NO_WINDOW', failure)
      return
    }
    const exists = this.#deps.sessions().some((entry) => entry.exists && entry.session.id === sessionId)
    if (!exists) return
    let action: HostAction
    if (command.kind === 'rename') {
      action = { kind: 'rename', sessionId, name: command.name ?? '' }
    } else {
      if (mtimeMs !== undefined && this.#stale(sessionId, mtimeMs)) return
      const running = this.#deps.running(sessionId)
      if (command.kind === 'hibernate' && !running) return
      if (command.kind === 'close' && self && running) {
        // The agent's close of its own session is **offered**, not carried out (D12): its last reply may be what
        // the user needs to read. Nothing ends, so no command end is announced.
        this.#offered.add(sessionId)
        action = { kind: 'offer-close', sessionId }
      } else {
        // `force`: this module already decided; the interface does not read it.
        action = { kind: command.kind, sessionId, force: true }
        if (running) this.#deps.runs.expectCommandEnd(sessionId)
      }
    }
    let outcome: RendererOutcome
    try {
      outcome = await this.#deps.request(action)
    } catch (error) {
      outcome = { ok: false, code: 'CREATE_FAILED', message: String(error) }
    }
    if (outcome.ok) return
    this.#offered.delete(sessionId)
    if (command.kind !== 'rename') this.#deps.runs.cancelCommandEnd(sessionId)
    const windowGone = outcome.code === 'NO_WINDOW' || outcome.code === 'TIMEOUT'
    this.#fail(windowGone ? 'CONTROL_NO_WINDOW' : 'CONTROL_FAILED', outcome.code, failure)
  }

  /** A failure after the file was consumed: the trace always, the notification for a permanent one (D6). */
  #fail(code: IntakeRejection, detail: string, failure: FailureContext): void {
    const outcome = this.#deps.reject(code, failure.target ?? '', detail, failure)
    if (isPermanentRejection({ code, notify: outcome.notify })) this.#deps.reportFailure(code, detail, failure)
  }
}
