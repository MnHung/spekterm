import type { WaitState } from './agent-events'
import { lastTranscriptPathOf, pendingRequestOf, subscribeWait, waitStateOf, type WaitSnapshot } from './agent-wait'
import { transcriptPathFor } from './transcript-follow'
import { type FollowUpdate, TranscriptFollower } from './transcript-follow-service'

/** Where an agent session's transcript is, as the terminal service knows it. */
export interface AgentSource {
  cwd: string
  conversationId: string
}

/** Where a follow delivers: the desktop's renderer, or a remote connection (`remote-protocol`). */
export interface FollowSink {
  update(update: FollowUpdate): void
  wait(state: WaitState, pending: { tool: string; arg: string | null } | null): void
  /** `false` once the consumer is gone; nothing more is delivered. */
  alive(): boolean
}

/** One running follow of one session's conversation. */
export interface Follow {
  readonly sessionId: string
  stop(): void
}

/**
 * Starts following a session's conversation for one consumer — **the one path both consumers use**, so the
 * desktop's view and a phone cannot drift: the initial location, relocation on wait snapshots, the forced
 * poll on every tick, and the answer for a shell.
 *
 * `source` is the session's agent transcript coordinates (`TerminalService.agentSourceOf`); `null` for a
 * shell, which is answered as having no conversation and gets `null` back.
 */
export function startFollow(sessionId: string, source: AgentSource | null, sink: FollowSink): Follow | null {
  if (!source) {
    // shell 目標沒有紀錄可跟。**明說**，不要讓呈現層停在「跟進中」。
    sink.update({
      sessionId,
      status: 'unavailable',
      events: [],
      truncated: false,
      reset: true,
    } satisfies FollowUpdate)
    return null
  }

  const follower = new TranscriptFollower(sessionId, (update) => {
    if (!sink.alive()) return
    sink.update(update)
  })
  let lastSent: WaitState = waitStateOf(sessionId)
  const unsubscribe = subscribeWait(sessionId, (snapshot) => {
    const previous = lastSent
    lastSent = snapshot.state
    onWait(sink, follower, snapshot, () => previous)
  })
  // 沿用這個 session 既有的狀態（切走再切回不該退回未知）。
  sink.wait(waitStateOf(sessionId), pendingRequestOf(sessionId))
  // 算出來的位置是初始值；事件帶來的 `transcript_path` 一旦到達即取代它。
  // An event may already have relocated it while no view was open: the wait state is drained for
  // every running claude session (`session-hibernation`), so start from the last reported location.
  follower.relocate(lastTranscriptPathOf(sessionId) ?? transcriptPathFor(source.cwd, source.conversationId))
  return {
    sessionId,
    stop: () => {
      unsubscribe()
      follower.dispose()
    },
  }
}

/**
 * 一次事件輪詢。
 *
 * **事件帶來的 `transcript_path` 是定位的權威來源** —— 它關掉了「使用者在 agent 之內清空或
 * 切換對話」那條路：那些操作發生在 pty 之內，pty 沒死，我們收不到任何自己發出的訊號
 * （實測 `/clear` 會換一份紀錄）。
 *
 * **而 `SessionEnd` 事件 SHALL NOT 觸發拆除** —— `drainEvents` 只把它翻成「狀態未知」，
 * 跟進器照常活著，等 `SessionStart` 帶來新位置。
 */
function onWait(
  sink: FollowSink,
  follower: TranscriptFollower,
  snapshot: WaitSnapshot,
  previous: () => WaitState,
): void {
  if (!sink.alive()) return
  if (snapshot.transcriptPath) follower.relocate(snapshot.transcriptPath)
  // **監看負責延遲，這裡負責保證。** 監看有一整類靜默的失效方式，而它們的徵狀都是
  // 「畫面安靜地停住」—— 那比沒有 view 更糟。
  follower.poll()
  if (snapshot.count === 0 && snapshot.state === previous()) return
  sink.wait(snapshot.state, snapshot.pending)
}
