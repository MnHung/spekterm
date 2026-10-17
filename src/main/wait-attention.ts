import { attentionOf, type Attention } from '../shared/wait/attention'
import type { WaitValue } from '../shared/lineage/lifecycle'

/** One running agent session's attention state (`session-wait-indicator`). */
export interface AttentionView {
  sessionId: string
  attention: Attention
}

export interface AttentionSources {
  running: () => readonly string[]
  wait: (sessionId: string) => WaitValue
  inTurn: (sessionId: string) => boolean
  seen: (sessionId: string) => boolean
  /** The open requests' tool start times. */
  requestTimes: (sessionId: string) => number[]
  lastKeystroke: (sessionId: string) => number | null
}

/**
 * The attention of every running agent session. A choice is typed over when a keystroke followed every open
 * request's tool start: the agent reports nothing for a denial at the desktop (`agent-event-bridge`).
 */
export function attentionProjection(sources: AttentionSources): AttentionView[] {
  return sources.running().map((sessionId) => {
    const times = sources.requestTimes(sessionId)
    const keystroke = sources.lastKeystroke(sessionId)
    const choiceTypedOver = times.length > 0 && keystroke !== null && times.every((at) => keystroke > at)
    return {
      sessionId,
      attention: attentionOf({
        wait: sources.wait(sessionId),
        inTurn: sources.inTurn(sessionId),
        seen: sources.seen(sessionId),
        choiceTypedOver,
      }),
    }
  })
}

export interface BroadcastTargets {
  send: (views: AttentionView[]) => void
  /** Whether the session was created by a handoff: its lifecycle reads the seen mark too (`handoff-completion`). */
  hasLineage: (sessionId: string) => boolean
  /** A handoff session's attention changed: the relations file, the lifecycle marks and the remote lists follow. */
  lineageChanged: () => void
  /** Any attention changed: the remote session list carries `seen`. */
  remoteChanged: () => void
}

/**
 * Sends the projection only when it differs from the last one sent. The wait observer runs every 400 ms for every
 * running session, so without this every tick would reach the window. **The whole projection, not a diff** — one
 * lost message cannot then leave the picture wrong (the same choice as `broadcastLifecycle`).
 */
export class AttentionBroadcaster {
  #last = new Map<string, Attention>()

  constructor(private readonly targets: BroadcastTargets) {}

  update(views: AttentionView[]): void {
    const next = new Map(views.map((view) => [view.sessionId, view.attention]))
    const changed = new Set<string>()
    for (const [sessionId, attention] of next) if (this.#last.get(sessionId) !== attention) changed.add(sessionId)
    for (const sessionId of this.#last.keys()) if (!next.has(sessionId)) changed.add(sessionId)
    if (changed.size === 0) return
    this.#last = next
    this.targets.send(views)
    this.targets.remoteChanged()
    if ([...changed].some((sessionId) => this.targets.hasLineage(sessionId))) this.targets.lineageChanged()
  }
}
