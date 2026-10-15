import { drainEvents, type DrainResult, type WaitState } from './agent-events'

/**
 * 等待狀態的求值 —— **per session、訂閱式，而且只有一個 drainer**。
 *
 * ## 這是把既有的一條教訓走完
 *
 * `ipc/conversation.ts` 的註解早就寫著：「一個由可消費串流推導出來的狀態，其生命週期必須綁在
 * **被描述的對象**上，不能綁在觀察者上。」既有實作把**狀態**綁對了（`waitStates` 是 per
 * session），**只有輪詢還綁在觀察者身上** —— drain 掛在對話 view 的跟進器裡，而跟進器只對
 * renderer 當下盯著的那一個 session 存在。
 *
 * 於是「還沒有人在看」的 session 其等待狀態**根本不會被求值**：預填要等 `ready`，就永遠等不到。
 * （事件檔仍在磁碟上累積 —— 事件不是「錯過就沒了」，是「沒人讀」。）
 *
 * ## 單一 drainer 是硬性要求
 *
 * 事件是**讀完即刪**的串流（去重由此保證）。兩個消費者各自 drain 同一個目錄會互相偷事件，
 * 而 `agent-event-bridge` 明文要求「事件的寫入與讀取不得遺失事件」。
 * 因此：**每個 session 至多一個計時器**，所有訂閱者共用同一次 drain 的結果。
 *
 * ## 命名的限制
 *
 * 訂閱入口**不得命名為 `listen`** —— `probe-core.mjs` 的「主行程未建立 server」守衛是純文字
 * 比對：它比對的是 HTTP 伺服器那兩個慣用名，而且**連註解一起吃**。
 * （所以這一段也不能把那兩個字面寫出來 —— 寫警告的時候特別容易踩到自己警告的那件事。）
 */

/** 輪詢間隔。與狀態列的 tick 同量級 —— 事件是落盤的，沒有推送可訂閱。 */
const WAIT_TICK_MS = 400

export interface WaitSnapshot {
  state: WaitState
  pending: { tool: string; arg: string | null } | null
  /** 最後一次事件回報的紀錄位置（若有）。跟進器據它重新定位。 */
  transcriptPath: string | null
  /** 這一次 drain 讀到幾則事件。 */
  count: number
  /** The batch contained a turn completion (`DrainResult.turnEnded`). */
  turnEnded: boolean
  /** The batch's last permission request (`DrainResult.choiceRaised`). */
  choiceRaised: { tool: string; arg: string | null } | null
}

type Subscriber = (snapshot: WaitSnapshot) => void

interface SessionEntry {
  timer: NodeJS.Timeout
  subscribers: Set<Subscriber>
}

/**
 * 等待狀態 —— **per session，而不是 per 訂閱**。
 *
 * 把它放在訂閱物件裡的話，使用者切走再切回時狀態重設為未知，**而重建它所需的事件早已被前一次
 * 訂閱讀走刪掉** —— agent 正閒著、不再產生新事件，於是狀態永遠停在未知。
 */
const waitStates = new Map<string, WaitState>()
const pendingRequests = new Map<string, { tool: string; arg: string | null } | null>()
const entries = new Map<string, SessionEntry>()
/**
 * The last transcript location an event reported, per session.
 *
 * Events are read-and-delete, and since `session-hibernation` every running claude session is
 * drained whether or not its conversation view is open. A relocation (after `/clear` or a resume)
 * would otherwise be consumed with no one to follow it, and a view opened later would follow the
 * computed path — the old file — forever.
 */
const transcriptPaths = new Map<string, string>()

/** The last transcript location an event reported for this session, if any. */
export function lastTranscriptPathOf(sessionId: string): string | null {
  return transcriptPaths.get(sessionId) ?? null
}

export function waitStateOf(sessionId: string): WaitState {
  return waitStates.get(sessionId) ?? 'unknown'
}

export function pendingRequestOf(sessionId: string): { tool: string; arg: string | null } | null {
  return pendingRequests.get(sessionId) ?? null
}

/** 讓測試與其他消費者共用同一個折疊結果。 */
export function foldDrain(sessionId: string, result: DrainResult): WaitSnapshot {
    waitStates.set(sessionId, result.state)
  pendingRequests.set(sessionId, result.pending)
  if (result.transcriptPath) transcriptPaths.set(sessionId, result.transcriptPath)
  return {
    state: result.state,
    pending: result.pending,
    transcriptPath: result.transcriptPath,
    count: result.count,
    turnEnded: result.turnEnded,
    choiceRaised: result.choiceRaised,
  }
}

/** Sees every drained batch of every session, with the state before it. */
export type WaitObserver = (sessionId: string, snapshot: WaitSnapshot, previous: WaitState) => void

const observers = new Set<WaitObserver>()

/**
 * A process-wide observer of every drained batch (`remote-notifications`). One registration covers every
 * session, including ones created later, so no per-session wiring can be forgotten — the attention events
 * and the remote session list hang off this. It sees each batch once, after the session's subscribers.
 */
export function observeWaits(observer: WaitObserver): () => void {
  observers.add(observer)
  return () => observers.delete(observer)
}

function tick(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  const previous = waitStateOf(sessionId)
  const result = drainEvents(sessionId, previous, pendingRequestOf(sessionId))
  const snapshot = foldDrain(sessionId, result)
  // **無論有沒有變化都通知** —— 跟進器要靠每一次 tick 主動 poll 一次紀錄，
  // 那是它「監看負責延遲、主動讀負責保證」的那一半。
  for (const subscriber of entry.subscribers) subscriber(snapshot)
  for (const observer of observers) {
    try {
      observer(sessionId, snapshot, previous)
    } catch (error) {
      console.error(`[agent-wait] observer failed: ${String(error)}`)
    }
  }
}

/**
 * 訂閱一個 session 的等待狀態。回傳退訂函式。
 *
 * 第一個訂閱者建立計時器，最後一個離開時停掉它 —— **但狀態留著**（它屬於那個 session，
 * 不屬於這次訂閱）。
 */
export function subscribeWait(sessionId: string, subscriber: Subscriber): () => void {
  let entry = entries.get(sessionId)
  if (!entry) {
    entry = {
      subscribers: new Set(),
      timer: setInterval(() => tick(sessionId), WAIT_TICK_MS),
    }
    entries.set(sessionId, entry)
  }
  entry.subscribers.add(subscriber)

  return () => {
    const current = entries.get(sessionId)
    if (!current) return
    current.subscribers.delete(subscriber)
    if (current.subscribers.size > 0) return
    clearInterval(current.timer)
    entries.delete(sessionId)
  }
}

/** session 結束時清除。**agent 回報的「對話結束」不是這個訊號。** */
export function clearWait(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (entry) {
    clearInterval(entry.timer)
    entries.delete(sessionId)
  }
    waitStates.delete(sessionId)
  pendingRequests.delete(sessionId)
  transcriptPaths.delete(sessionId)
}

/** 測試用：目前有幾個 session 正在被輪詢。 */
export function activeWaitSessions(): number {
  return entries.size
}
