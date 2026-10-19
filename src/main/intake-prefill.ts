import { randomUUID } from 'node:crypto'

import { encodePrefill, type WaitState } from './agent-events'
import { subscribeWait, waitStateOf } from './agent-wait'
import { keystrokeSeq, lastKeystrokeAt } from './pty-input'

/**
 * 預填 —— 把第一則 prompt 寫進 agent 的輸入處，**而不送出**。
 *
 * ## 落點是 pty，而且由主行程寫
 *
 * agent session 有兩種 view，各有一個可以打字的地方，**而只有使用者當下在看的那一個看得到**，
 * 終端 view 是預設。被否決的落點是對話 view 的文字框：它要成立必須配「接受時自動切到對話
 * view」，而 `agent-conversation-view` 明文要求 view 的選擇是**單一的全域偏好**。
 *
 * **由主行程執行寫入不是實作偏好**：prompt 含 context 檔的絕對路徑，交給 renderer 再寫回去
 * 等同把那個位置送過 IPC，而那是本能力明文避免的事。
 *
 * ## 時機：等待狀態**首次**成為就緒
 *
 * 太早寫入，內容會落進 agent 的啟動畫面而非輸入處，**而畫面上不會有任何錯誤**。
 * 判準不是固定延遲、不是重試次數、也不是看終端畫面。
 *
 * 實測（2026-09-11、CLI 2.1.267，見 `docs/lessons/transcript.md`）：`SessionStart` 恆晚於 TUI
 * 進入 alt-screen 約 200–300ms，也晚於 TUI 啟動時的輸入丟棄窗口；以它為閘重複 5 次，
 * **5 次全部落進輸入框**。而失效的是一個**窄帶**（約 1000ms 前後），不是「越早越糟」。
 *
 * ## 寫一次就退訂
 *
 * 狀態會再次成為就緒（agent 每講完一次話都會）。沒有 write-once 的話，使用者正在打字時
 * 會被插進第二份 prompt。
 *
 * ## 等不到就緒時要說話
 *
 * **判準以狀態為準，不以成因為準** —— 等待狀態始終不到的成因不只一種（事件回報未啟用、
 * 注入失敗、agent 啟動失敗、CLI 換版）。逾時之後：可見地說明，且該則 intake **回到可重新
 * 處理的狀態**。少了這條，使用者得到的是一個空的 session、一則已離開待處理清單的工作項目，
 * 以及零錯誤訊息。
 */

/** 等不到就緒的上限。**必須大於 drain 的 tick（400ms）數個數量級**，否則正常啟動會被判成逾時。 */
/**
 * 預填之後，**使用者送出了嗎**。
 *
 * 「使用者按下 Enter」發生在 pty 之內，renderer 與主行程都收不到自己發出的訊號。The injected hooks
 * include `UserPromptSubmit` since `companion-test-fixes`, and it sets the wait state to busy at once — so
 * the clue is still that the agent **started working** (busy or awaiting-choice), now also for a submission
 * that uses no tool.
 *
 * ## `unknown` 不算
 *
 * 此前的判定是「不再是 ready」，那把落回未知的事件（不認得種類的 `Notification`、
 * `SessionEnd`、不認得的事件）一併當成送出。那在過去只撤掉一個暫時的標示；自
 * `intake-inbox-usability` 起它會**落盤**「已了結」—— 一次誤判就把交接的本文從它唯一的呈現位置
 * 永久移除，而且沒有復原的入口。**一個無法分辨的狀態不能推定為送出。**
 *
 * 收件匣的 prompt 必然要求 agent 先讀 context 檔，所以真正的送出一定會經過一次工具呼叫（⇒ 忙碌）。
 *
 * **「待送出」標示與「已了結」共用這一個判定** —— 兩處各自判斷的話，標示消失而項目還在（或反之）。
 */
export function isSubmitted(state: WaitState): boolean {
  return state === 'busy' || state === 'awaiting-choice'
}

export const PREFILL_TIMEOUT_MS = 30_000

/**
 * 寫入之後**要不要一併送出**（`handoff-session-lifecycle` design D1）。
 *
 * - **第三方的本文**：只填入 —— 送出是使用者的動作，那是這條管線唯一的人類閘門。
 * - **非第三方的本文**（agent 發起的交接）：送出 —— 本文是使用者自己 session 裡的 agent 寫的。
 * - **沿用既有 session**（逾時退回後在同一個 folder 再次接受）：**一律只填入**。那時使用者面對的是
 *   一個空的 session，可能已經在裡面打了字；`schedulePrefill` 在已就緒時立刻寫，`prompt\r` 會接在
 *   他打到一半的內容後面一起送出，而他在那之前看不到。
 *
 * 判定依**本文的來源**，不依「是誰觸發了建立」—— 退回待處理的交接由使用者接受而**新建**
 * session 時仍然送出。
 */
export type PrefillMode = 'fill' | 'submit'

export function prefillModeFor(input: { firstPartyBody: boolean; reusedSession: boolean }): PrefillMode {
  return input.firstPartyBody && !input.reusedSession ? 'submit' : 'fill'
}

/**
 * 送出字元（Enter）。**與文字分開、隔一段時間才寫**（見 `SUBMIT_KEY_DELAY_MS`）。
 */
export const SUBMIT_KEY = '\r'

/**
 * 文字寫進去之後，隔多久才送出字元。
 *
 * **不能與文字一起寫。** 實測（CLI 2.1.283，`docs/lessons/handoff.md` 第十三節）：一段長文字
 * （真實的 prompt 約 300 字元、含非 ASCII）一次抵達時被 agent 當成**貼上**，緊跟在後的 `\r`
 * 被併進貼上成為換行 —— 文字停在輸入框、沒有送出，畫面上沒有任何錯誤。分開寫時的門檻落在
 * 100–150ms 之間（100ms 仍失敗，150ms 以上 8/8 送出）；取 500ms，約為門檻的三倍。
 *
 * 第一版 dogfood 就是這樣壞的：探針的替身不做貼上偵測、第一次實測用的是 50 字元的短 prompt，
 * 兩者都測不出來。**送出字元仍可能沒生效**，退路見 `SUBMIT_CONFIRM_MS`。
 */
export const SUBMIT_KEY_DELAY_MS = 500

/**
 * 代為送出之後，多久沒見到 agent 開始工作就**退回「待送出」的標示**。
 *
 * 實測（CLI 2.1.283，`docs/lessons/handoff.md` 第十三節）：首次就緒時寫入的 `prompt\r` 偶爾
 * （1/13）只有文字進了輸入框、送出字元沒有生效。失效方向是溫和的（退化成填入），但若產品以為已
 * 送出而不呈現標示，使用者就看不到它在等他。
 *
 * **不自動補送一次 `\r`** —— 那段時間使用者可能已經在那個 session 裡打字。
 */
export const SUBMIT_CONFIRM_MS = 10_000

/** The inbox item a prefill came from. */
export interface PrefillIntake {
  adapter: string
  id: string
}

/**
 * A filled-in prompt whose submission has not been confirmed (`session-hibernation`, `remote-prefill-send` D4).
 *
 * Set when the text is written — in submit mode too, because the send key sometimes does not take
 * (see `SUBMIT_CONFIRM_MS`) — and removed when the agent starts working or the session ends. While a
 * session has one it is never hibernated automatically (resuming would discard the unsent text), and a
 * device's reply is refused (it would be submitted together with the prompt). `watchSubmission` keeps its
 * own state in a closure and only messages the renderer, so the main process needs this registry to ask
 * the question at all.
 */
interface PrefillRecord {
  /** This one fill's identity: a device submits the fill it showed the user, not a later one. */
  id: string
  /** Exactly what was written, before any submit key. */
  text: string
  intake: PrefillIntake | null
  /** The session's keystroke count after the desktop's last write for this fill (`keystrokeSeq`). */
  seq: number
  /**
   * Something was typed since the session's process started, before the fill: the input box may hold it in
   * front of the prompt. No event says the box is empty — a `Stop` leaves text typed during the turn in place —
   * so any keystroke of this process counts.
   */
  typedBefore: boolean
  /** The desktop shows its "not sent" label: at once when only filled in, after the fallback when submitted. */
  offered: boolean
}

const records = new Map<string, PrefillRecord>()
const changeListeners = new Set<(sessionId: string) => void>()

function changed(sessionId: string): void {
  for (const listener of changeListeners) {
    try {
      listener(sessionId)
    } catch (error) {
      console.error(`[intake-prefill] listener failed: ${String(error)}`)
    }
  }
}

export function hasUnconfirmedSubmission(sessionId: string): boolean {
  return records.has(sessionId)
}

/** The session ended (its pty is gone, and the prompt with it). */
export function forgetSubmission(sessionId: string): void {
  if (records.delete(sessionId)) changed(sessionId)
}

/** A session's unconfirmed prefill as the remote protocol reads it (`remote-prefill-send` D2). */
export interface PrefillView {
  id: string
  text: string
  intake: PrefillIntake | null
  /** The input box may hold more than `text`: typed into after the fill, or before it in this process. */
  edited: boolean
  offered: boolean
}

export function prefillOf(sessionId: string): PrefillView | null {
  const record = records.get(sessionId)
  if (!record) return null
  return {
    id: record.id,
    text: record.text,
    intake: record.intake,
    edited: record.typedBefore || keystrokeSeq(sessionId) > record.seq,
    offered: record.offered,
  }
}

/** A submit key the desktop wrote for the fill (its own, or a device's): not someone typing over the prompt. */
export function notePrefillKey(sessionId: string): void {
  const record = records.get(sessionId)
  if (record) record.seq = keystrokeSeq(sessionId)
}

/** Hears a prefill set, removed, or offered. */
export function onPrefillChange(listener: (sessionId: string) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function markOffered(sessionId: string): void {
  const record = records.get(sessionId)
  if (!record || record.offered) return
  record.offered = true
  changed(sessionId)
}

export interface SubmissionHandlers {
  /** 呈現「待送出」的標示。每次監看至多一次。 */
  onPending(): void
  /** agent 開始工作了（`isSubmitted`）。每次監看至多一次，之後監看即結束。 */
  onSubmitted(): void
}

export interface SubmissionDeps {
  subscribe: (sessionId: string, subscriber: (snapshot: { state: WaitState }) => void) => () => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

const defaultSubmissionDeps: SubmissionDeps = {
  subscribe: subscribeWait,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/**
 * 寫入之後，監看「送出了沒」。
 *
 * - 只填入：立刻呈現待送出；見到 agent 開始工作即視為使用者送出了。
 * - 送出：不呈現；`SUBMIT_CONFIRM_MS` 內沒見到開始工作才呈現（退路）。
 *
 * 回傳結束監看的函式。
 */
export function watchSubmission(
  sessionId: string,
  mode: PrefillMode,
  handlers: SubmissionHandlers,
  deps: SubmissionDeps = defaultSubmissionDeps,
): () => void {
  let done = false
  let pendingShown = false
  const showPending = (): void => {
    if (done || pendingShown) return
    pendingShown = true
    markOffered(sessionId)
    handlers.onPending()
  }

  let timer: unknown = undefined
  if (mode === 'fill') showPending()
  else timer = deps.setTimer(showPending, SUBMIT_CONFIRM_MS)

  // 訂閱回呼可能在 `subscribe` 回傳之前就同步觸發 —— 那時退訂函式還沒拿到，所以放在一個容器裡。
  const subscription: { unsubscribe?: () => void } = {}
  const stop = (): void => {
    if (done) return
    done = true
    if (timer !== undefined) deps.clearTimer(timer)
    subscription.unsubscribe?.()
  }
  subscription.unsubscribe = deps.subscribe(sessionId, (snapshot) => {
        if (done || !isSubmitted(snapshot.state)) return
    stop()
    if (records.delete(sessionId)) changed(sessionId)
    handlers.onSubmitted()
  })
  if (done) subscription.unsubscribe()
  return stop
}

export interface PrefillDeps {
  /** 往 pty 寫入。由呼叫端注入，於是本模組不認識終端服務。 */
  write(sessionId: string, data: string): void
  /** 逾時的處置 —— 呈現說明，並把該則 intake 放回待處理。 */
  onTimeout(sessionId: string): void
  /** 成功填入。 */
  onFilled?(sessionId: string): void
  /** When the session's current process was spawned, or `null` (then any earlier keystroke counts as typed). */
  processStartedAt?(sessionId: string): number | null
}

interface PendingPrefill {
  unsubscribe: () => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingPrefill>()

/** 目前有幾個 session 在等預填。測試用。 */
export function pendingPrefillCount(): number {
  return pending.size
}

/**
 * 排定一次預填。
 *
 * 已就緒時**立刻寫**（那不是「太早」——狀態已經是就緒了）；否則訂閱等待狀態，
 * 首次就緒時寫一次即退訂。
 */
export function schedulePrefill(
  sessionId: string,
  prompt: string,
  deps: PrefillDeps,
  mode: PrefillMode = 'fill',
  intake: PrefillIntake | null = null,
): void {
  cancelPrefill(sessionId)

  let done = false
  const finish = (filled: boolean): void => {
    if (done) return
    done = true
    const entry = pending.get(sessionId)
    if (entry) {
      entry.unsubscribe()
      clearTimeout(entry.timer)
      pending.delete(sessionId)
    }
    if (filled) deps.onFilled?.(sessionId)
    else deps.onTimeout(sessionId)
  }

  const fill = (): void => {
    // Read before the write: the write itself is a keystroke (`noteWrite`), and would mark every fill typed into.
    const startedAt = deps.processStartedAt?.(sessionId) ?? null
    const last = lastKeystrokeAt(sessionId)
    const typedBefore = last !== null && (startedAt === null || last >= startedAt)
    // **不附送出字元，且換行由編碼器濾掉** —— 單行是編碼器的性質，不是呼叫端的義務。
    const text = encodePrefill(prompt)
    deps.write(sessionId, text)
    records.set(sessionId, { id: randomUUID(), text, intake, seq: keystrokeSeq(sessionId), typedBefore, offered: mode === 'fill' })
    changed(sessionId)
    // 送出字元**分開、稍後**才寫 —— 與文字一起到達會被當成貼上的一部分（見 `SUBMIT_KEY_DELAY_MS`）。
    if (mode === 'submit') {
      setTimeout(() => {
        deps.write(sessionId, SUBMIT_KEY)
        notePrefillKey(sessionId)
      }, SUBMIT_KEY_DELAY_MS)
    }
    finish(true)
  }

  const timer = setTimeout(() => finish(false), PREFILL_TIMEOUT_MS)
  const unsubscribe = subscribeWait(sessionId, (snapshot) => {
    if (done) return
    if (snapshot.state === 'ready') fill()
  })
  pending.set(sessionId, { unsubscribe, timer })

  // 訂閱之前狀態就已經是就緒（例如重建一個早就在跑的 session）。
  if (waitStateOf(sessionId) === 'ready') fill()
}

/** session 被關掉或使用者自己送出時取消。 */
export function cancelPrefill(sessionId: string): void {
  const entry = pending.get(sessionId)
  if (!entry) return
  entry.unsubscribe()
  clearTimeout(entry.timer)
  pending.delete(sessionId)
}
