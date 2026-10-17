import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionLineage } from '../../../../shared/lineage/types'
import { buildForest, childInsertIndex } from '../session-forest'
import type { FsFailure, SpawnTarget } from '../types'

/**
 * `dormant` = 已從持久化重建、具備完整身分（名字、順序、錨定），但**還沒有 pty**。
 *
 * 重開 app 時若把每個 session 都 spawn 起來，就是同時啟動 N 個 claude —— 而它們本來就是死的
 * （app 關掉時 pty 就沒了），喚醒它們只是讓一堆 claude 閒置著搶 CPU。**懶惰嚴格地更好**。
 *
 * Since `session-hibernation` a running session can also go back to `dormant` (by the user's hand or
 * after a period of idleness), and a dormant session starts **only on an explicit wake** — displaying
 * it does not. There is one dormant state: a hibernated session is exactly a restored one.
 */
export type SessionStatus = 'dormant' | 'running' | 'exited'

export interface SessionState {
  id: string
  /**
   * 這個 session 隸屬於哪個 workspace folder。**`null` ＝ 全域**（不隸屬任何 folder，
   * 見 `global-session`）。
   *
   * **刻意不用保留字串表示全域**（design D1）：那樣型別仍是 `string`，於是
   * `folders.find((f) => f.id === folderId)` 會靜默回 `undefined`、`forFolder(id)` 靜默回
   * 空陣列 —— 型別檢查一條都不會攔。
   *
   * **但 `null` 只讓編譯器攔下「傳參」與「Map 鍵」那一半**：`string | null` 與
   * `string | undefined` 的 `===` 比較**合法且不報錯**（實測），而歸屬的消費點絕大多數是比較。
   * 每一處以識別碼相等判定歸屬的地方都必須人工列舉（design D1a）。
   */
  folderId: string | null
  spawnTarget: SpawnTarget
  status: SessionStatus
  exitCode?: number
    /** 喚醒失敗的原因（folder 路徑失效時）。休眠態的呈現會顯示它，而不是靜默地什麼都不發生。 */
  wakeError?: string
  /**
   * How many times this session has been hibernated in this run. Part of its view's key: a hibernated
   * session's view remounts, so it takes the same path a restored one does (a shell replays its
   * snapshot; a claude view starts empty and `--resume` redraws) — `session-hibernation` design D1.
   */
  generation?: number
  /** 該 folder 內的建立序號（自 1 起）。pty 未宣告標題時，標籤的退路。 */
  ordinal: number
  /**
   * 這個 session 開在哪個工作目錄（git worktree）—— core 算的不可逆識別碼。
   * `undefined` ＝ folder 根。
   *
   * **它不是路徑，renderer 也解析不出路徑** —— 主行程只對查表命中的值解析
   * （`terminal-sessions`）。續寫入口拿它與 change 的來源識別碼比對。
   */
  worktreeKey?: string
  /**
   * pty 以 OSC 序列設定的終端標題。
   *
   * session 的身分由**跑在裡面的東西**宣告（`claude` 會主動送這個），而不是由我們的流水號
   * 決定。未設定時為 `undefined`，標籤退回 `${spawnTarget} ${ordinal}`。
   *
   * **它恆被記錄，即使使用者已接管命名權**（此時它只是不被呈現）—— 於是使用者清空名稱、
   * 交還命名權的那一刻，標籤能**立即**回到 pty 最近一次宣告的標題，而不必空等它下一次宣告
   *（那可能是好幾分鐘後，session 閒置的話甚至永遠不會來）。「清空名稱」是交還命名權的唯一
   * 路徑，它必須即時且確定（session-title-authority 的 design D3）。
   */
  title?: string
  /**
   * 使用者親自取的名字。**優先於 pty 宣告的標題。**
   *
   * 一旦設定，就代表使用者**永久接管了這個 session 的命名權** —— 此後 pty 宣告的標題一律
   * 靜默地不予呈現：不覆蓋、不確認、不提示。**連 pty 反覆宣告同一個標題也一樣。**
   *
   * 這裡曾經有一個確認對話框（「pty 想改名，要採用嗎？」），已於 session-title-authority
   * 移除：`claude` 隨任務進展**持續**改標題，那個對話框於是無限重跳（第二次 dogfooding 抓到）；
   * 而它問的又是一個答案可預測的問題 —— 使用者才剛親手命名，當然是保留自己的。**「使用者指定
   * 的名稱 > pty 宣告的標題」這條優先序本身就已經是那個裁決**，不需要再問第二次（design D1）。
   *
   * 交還命名權：把名字清空（見 `rename`）。
   */
  customTitle?: string
  /**
   * 這個 session 是由哪一個 session 交接出來的（`session-lineage`）。**唯讀** —— 權威在主行程，
   * 它只經 restore 與 `create` 的回傳進來，**不送回持久化**（主行程也不會採信）。
   */
  lineage?: SessionLineage
}

export type CreateOutcome =
  | { status: 'created'; sessionId: string }
  | { status: 'failed'; failure: FsFailure }

export type WakeOutcome = { status: 'woken' } | { status: 'failed'; message: string }

/** Which view's automatic focus a quiet arrival holds back (`remote-protocol`, design D4). */
export type QuietConsumer = 'terminal' | 'conversation'

export interface SessionsApi {
  /**
   * 所有 folder 的所有 session。
   *
   * 終端必須**跨切換 folder 常駐**：若只掛載當前 folder 的 session，切走再切回時 xterm 實例
   * 已被卸載，先前的 scrollback 就消失了（backlog 只補得回未顯示期間的新輸出，補不回已經
   * 卸載的歷史）。掛載以此為準，顯示才以當前 folder 為準（design D7）。
   */
  all(): SessionState[]
  forFolder(folderId: string | null): SessionState[]
  countFor(folderId: string | null): number
  /** 該 folder 當前聚焦的 session。未明確指定時退回它的第一個。 */
  focusedIdFor(folderId: string | null): string | null
  /**
   * Moves on every action by which the user turns to a session: `focus()` (also for the session that
   * is already focused), `create()` unless it is a background creation, `sendInput()`. The value
   * means nothing; only a change does — the maximized side panel restores on it
   * (`maximize-panel-and-confirm-close` design M4).
   */
  attention: number
  focus(folderId: string | null, sessionId: string): void
  /**
   * `worktreeKey` 指定它開在哪個工作目錄（不可逆識別碼，**不是路徑**）。省略＝ folder 根。
   *
   * **尾參是 options 物件而不是位置參數。** 此前這裡是
   * `create(folderId, spawnTarget, anchoredChange?, worktreeKey?)` —— 兩個相鄰的
   * `string | undefined`，移除中間那個時漏改任一呼叫點，slug 會**靜默地**被當成工作目錄
   * 識別碼傳下去（型別檢查一聲不響），而主行程對查無的識別碼是拒絕建立 ⇒ 使用者看到一顆
   * 沒反應的按鈕。把同型相鄰消掉，比記得改每一個呼叫點可靠。
   */
  create(
    folderId: string | null,
    spawnTarget: SpawnTarget,
    options?: {
      worktreeKey?: string
      /** 交接的單次憑證 —— 主行程簽發，renderer 原樣轉交（見 `handoff-ticket.ts`）。 */
      ticket?: string
      /**
       * Created without the user asking at that moment (a handoff accepted on arrival). The session
       * still becomes its item's focused session, but `attention` does not move.
       */
      background?: boolean
      /**
       * Requested from a paired device (`remote-protocol`): it **never takes the desktop**. It sets no
       * item's focused session (so it replaces nothing on screen; an item with no session shows it by the
       * `focusedIdFor` fallback), and its arrival does not take keyboard focus — see `takeQuietArrival`.
       */
      quiet?: boolean
    },
  ): Promise<CreateOutcome>
    /**
   * 喚醒一個休眠的 session（＝為它 spawn pty）。
   *
   * **Called only on the user's explicit wake** (the dormant screen's Wake button, or `Enter` on it) —
   * displaying a dormant session does not start it (`session-persistence`). So nothing calls this on
   * re-render, and a failed wake can be retried by pressing Wake again.
   *
   * 重複呼叫是安全的（已在喚醒中或已有 pty 者為 no-op）。
   *
   * `quiet`: requested from a paired device — the session starting does not take keyboard focus.
   * Resolves with the outcome (a device is told whether it worked).
   */
  wake(sessionId: string, options?: { quiet?: boolean }): Promise<WakeOutcome>
  /**
   * Whether this view should hold back its automatic focus for a session that arrived quietly (created or
   * woken for a paired device). **One-shot per view**: the answer is consumed. A view asks only at the
   * moment it would focus on its own — a terminal at its first evaluation or a status change, the
   * conversation on dormant → running — so a view that is not on screen at that moment drops the mark,
   * and a later activation (the user turning to it) focuses as usual. Any user action that turns to the
   * session (`focus()`, a wake the user asks for) clears the mark.
   */
  takeQuietArrival(sessionId: string, consumer: QuietConsumer): boolean
  /**
   * Whether a view of this session holds its automatic focus because a paired device just hibernated it, or
   * closed the session it replaces (`remote-hibernate-close` D4). **Read, not consumed**: the hold lasts
   * exactly the commit of that transition — the provider clears it afterwards — so it can never swallow a
   * later activation, whatever triggers that. Stable (ref-backed), so it never re-runs an effect.
   */
  isFocusHeld(sessionId: string): boolean
  /**
   * Put a running session back to dormant (`session-hibernation`). A shell's screen is serialized
   * first, so the snapshot is current when its pty dies. The session becomes dormant when the main
   * process reports the hibernated exit. `token` marks an automatic request (the main process checks
   * its policy again); without one the request is the user's and always proceeds.
   *
   * `quiet`: requested by a paired device. The main process already confirmed a process, so it is sent even
   * when this view's status has not caught up (then without a snapshot), and the view takes no focus when the
   * session turns dormant. Resolves with the main process's answer (`false`: no process to end).
   */
  hibernate(sessionId: string, token?: string, options?: { quiet?: boolean }): Promise<boolean>
  /** Registered by `TerminalView`: serialize this session's screen. Returns an unregister function. */
  registerSerializer(sessionId: string, serialize: () => string | undefined): () => void
  /**
   * `quiet`: requested by a paired device — the session displayed in place of a closed displayed one takes no
   * focus on that activation (`remote-hibernate-close` D4).
   */
  close(sessionId: string, options?: { quiet?: boolean }): void
  /**
   * pty 宣告的終端標題。空字串視為未設定。
   *
   * 使用者已接管命名權時**照樣記錄，只是不呈現** —— 不覆蓋、不確認、不打斷（design D1／D3）。
   */
  setTitle(sessionId: string, title: string): void
  /** 使用者親自命名（＝永久接管命名權）。空字串＝交還命名權，回到跟隨 pty。 */
  rename(sessionId: string, name: string): void
  /**
   * The agent in this session asked to close it and its turn ended (`agent-session-control` D12): its views show
   * the offer, and nothing closes until the user chooses to. Cleared when the session stops running.
   */
  closeOffered(sessionId: string): boolean
  offerClose(sessionId: string): void
  /** The offer was taken back: the main process says so (a keystroke, a device's keep), or the user kept it. */
  withdrawCloseOffer(sessionId: string): void
  /**
   * The user chose Keep on the offer: the card goes at once, and the main process, which owns the offer for paired
   * devices, is told (`remote-close-offer` D4).
   */
  keepCloseOffer(sessionId: string): void
  /** 重排同一個 folder 之內的 session 順序。索引是該 folder 之內的序位。 */
  reorder(folderId: string | null, fromIndex: number, toIndex: number): void
  /**
   * 以一整份新的次序取代某個 folder 的 session 順序（rail 上帶子孫的整塊移動，`session-forest`）。
   *
   * `reorder` 一次只能移一個項目，表達不出「節點連同子孫」。`ids` 必須恰為該 folder 目前的
   * session 集合（次序不同），否則為無操作 —— 飛行中的清單可能已經變了。
   */
  setOrder(folderId: string | null, ids: readonly string[]): void
  /**
   * 把一段文字送進某個 session 的 pty，**並把焦點交還該 session 的終端**。
   * 換行不自動附加 —— 要不要送出由呼叫端決定（本 change 的續寫入口是要的）。
   *
   * 這是 renderer 對 pty 寫入的**第二個**入口（第一個是 `TerminalView` 轉發 xterm 的按鍵）。
   * 它存在的理由是讓側欄不必自己去碰 `window.workspace.terminal.write` —— 對 pty 寫入的能力
   * 集中在這裡，日後要加約束（例如「只允許送給 claude 目標」）才有一個施加的地方（design D5）。
   *
   * **聚焦是這個動作的一部分，不是呼叫端的義務**：文字送進去之後，使用者的下一個動作必然是
   * 繼續跟 agent 對話。少了它，使用者得再點一次終端才能打字 —— 那正是 `terminal-clipboard`
   * 實測抓到過的毛病（自選單貼上後按 Enter 不會執行，因為焦點還在選單上）。
   */
  sendInput(sessionId: string, text: string): void
  /**
   * 由 `TerminalView` 註冊「聚焦我這個終端」的方法。回傳解除註冊的函式。
   *
   * xterm 的把手是 `TerminalView` 的 ref，跨元件拿不到；而 `sendInput` 必須聚焦。沿用 `attach`
   * 已經在用的註冊模式（ref 保存，不引起 re-render）。
   */
  registerFocus(sessionId: string, focusTerminal: () => void): () => void
  /**
   * 把一個終端接上它的 session：先補回 attach 之前累積的輸出，再接續 live 串流。
   * 回傳解除接續的函式。
   */
  attach(sessionId: string, write: (chunk: string) => void): () => void
  /**
   * 該 session 重建時要重播的終端畫面快照。
   *
   * 為什麼不像 pty 的輸出那樣塞進 backlog：重播不是「寫一段文字」那麼簡單 —— 它要處理游標與
   * 終端模式（見 `XtermHandle.replay`），且必須在**接上 live 之前**完成。
   *
   * **它刻意不是「取走」（讀完即刪）**：dev 的 StrictMode 會把 `TerminalView` 的掛載 effect 跑
   * **兩次** —— 第一次就把快照取走了，第二次（也就是真正存活下來的那個 xterm）於是拿到
   * `undefined`，畫面一片空白。而且 **build 模式完全正常**，是那種「一邊過一邊不過」的病。
   * 條目改在 `close()` 時才清掉。
   */
  restoredScrollbackOf(sessionId: string): string | undefined
}

const SessionsContext = createContext<SessionsApi | null>(null)

/**
 * session 清單的所有者。
 *
 * **必須位於 `MainStage` 之上**：session 綁在 folder 上，切換選中的 repo 不該讓清單消失，
 * 而 rail 要同時呈現**所有** folder 的 session（design D9）。
 */
/**
 * 以新的次序填回某個 folder 原本佔據的那些位置 —— 其餘 folder 的相對順序完全不動（與 `reorder`
 * 同一個作法）。`ids` 必須恰為該 folder 目前的 session 集合，否則回傳原陣列。
 */
function applyOrder(previous: SessionState[], folderId: string | null, ids: readonly string[]): SessionState[] {
  const slots = previous.reduce<number[]>((acc, session, index) => {
    if (session.folderId === folderId) acc.push(index)
    return acc
  }, [])
  const byId = new Map(slots.map((index) => [previous[index].id, previous[index]]))
  if (ids.length !== slots.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
    return previous
  }
  const next = [...previous]
  slots.forEach((index, position) => {
    next[index] = byId.get(ids[position]) as SessionState
  })
  return next
}

/**
 * 交接出來、且與母 session 同一個 rail 項目的新 session，放到「母 session 與它所有子孫」裡位置
 * 最後的那一個之後（`workspace-layout`），使分頁列中它也緊鄰母 session。其餘照舊留在最後。
 */
function placeChild(sessions: SessionState[], newId: string): SessionState[] {
  const created = sessions.find((session) => session.id === newId)
  const parentId = created?.lineage?.parentId
  if (!created || !parentId) return sessions
  const group = sessions.filter((session) => session.folderId === created.folderId)
  const present = new Set(group.filter((session) => session.status !== 'exited').map((session) => session.id))
  if (!present.has(parentId)) return sessions

  const without = group.filter((session) => session.id !== newId)
  const forest = buildForest(
    without.map((session) => ({ id: session.id, parentId: session.lineage?.parentId })),
    present,
  )
  const order = without.map((session) => session.id)
  const at = childInsertIndex(order, forest, parentId)
  order.splice(at, 0, newId)
  return applyOrder(sessions, created.folderId, order)
}

export function SessionsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionState[]>([])
  /** Sessions whose agent asked to close them (D12 of `agent-session-control`). */
  const [closeOffers, setCloseOffers] = useState<ReadonlySet<string>>(() => new Set())
  // 鍵是 session 的歸屬（`null` ＝ 全域）。Map 對 `null` 鍵完全合法，於是全域項目的 focus
  // 記憶不需要第二套資料結構。
  const [focused, setFocused] = useState<ReadonlyMap<string | null, string>>(() => new Map())
  /** See `SessionsApi.attention`. */
  const [attention, setAttention] = useState(0)

  // 回呼需要當下的清單，但不該因清單變動而重新產生。
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  /** 尚未有終端接上的 session，其輸出暫存於此。 */
  const backlog = useRef(new Map<string, string[]>())
  /** 已接上的終端。 */
  const sinks = useRef(new Map<string, (chunk: string) => void>())
  /**
   * 每個 folder 下一個 session 的序號。**單調遞增，不因關閉而回退** —— 若改用「當前
   * session 數 + 1」，關掉一個之後新開的會拿到已用過的序號（實測：關掉 shell 1 後開的
   * claude 標成 `claude 2`，與現存的 `shell 2` 撞號）。
   */
  const nextOrdinal = useRef(new Map<string | null, number>())

  /**
   * **這個訂閱必須早於任何一次 `create`。**
   *
   * pty 在 `create` 回傳的那一刻就開始吐出 shell 的第一個 prompt，而 `TerminalView` 要等
   * React 完成渲染才 attach —— 中間這段沒有接收者的輸出會直接消失。因此輸出一律先進
   * backlog，等終端接上再補。與 Phase 2「先訂閱、再列目錄」同源：**訂閱要早於會產生事件的
   * 那個動作**。
   */
  useEffect(() => {
    return window.workspace.terminal.onData((sessionId, chunk) => {
      const sink = sinks.current.get(sessionId)
      if (sink) {
        sink(chunk)
        return
      }
      const pending = backlog.current.get(sessionId)
      if (pending) pending.push(chunk)
      else backlog.current.set(sessionId, [chunk])
    })
  }, [])

    // pty 自行結束（使用者打了 exit、claude 收工、或命令啟動失敗）。標示為已結束但**不移除**
  // —— 使用者要看得到它結束了，也要讀得到最後的輸出（design D9、D15）。
  useEffect(() => {
    return window.workspace.terminal.onExit((sessionId, exitCode, reason) => {
      if (reason === 'hibernated') {
        // **Not an ending** — the session goes back to dormant (`session-hibernation`, design D1).
        // Output queued from the dying process would land in the dormant view ahead of the resumed
        // conversation; the snapshot taken at hibernation becomes what the remounted view replays
        // (the restore map is otherwise only filled at startup); and `waking` forgets the session so
        // the next Wake actually wakes it.
        backlog.current.delete(sessionId)
        waking.current.delete(sessionId)
        const snapshot = hibernationSnapshots.current.get(sessionId)
        hibernationSnapshots.current.delete(sessionId)
        if (snapshot !== undefined) restoredScrollback.current.set(sessionId, snapshot)
        const quiet = quietHibernations.current.delete(sessionId)
        setSessions((previous) => {
          // A device's hibernation: the views turning dormant in this very commit hold their focus.
          if (quiet) holdFocus([sessionId], previous)
          return previous.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  status: 'dormant',
                  wakeError: undefined,
                  exitCode: undefined,
                  generation: (session.generation ?? 0) + 1,
                }
              : session,
          )
        })
        return
      }
      setSessions((previous) =>
        previous.map((session) =>
          session.id === sessionId ? { ...session, status: 'exited', exitCode } : session,
        ),
      )
    })
  }, [])

  /**
   * 重建尚未完成時，**不可以把 session 清單寫回磁碟** —— 首次渲染時它是空的。
   * 這個旗標就是那道閘（見下方的落盤 effect）。
   */
  const [restored, setRestored] = useState(false)
  const restoredRef = useRef(false)
    /** 已經送出喚醒請求的 session。避免同一個 session 被 spawn 兩次。 */
  const waking = useRef(new Set<string>())
  /** Sessions that arrived quietly, with the views whose automatic focus is still held back. */
  const quietArrivals = useRef(new Map<string, Set<QuietConsumer>>())
  /**
   * The views whose automatic focus is held, for the commit of one transition a device caused
   * (`remote-hibernate-close` D4). `against` is the session list that transition replaced: the hold is cleared
   * in the first commit that renders a different list — the transition's own — after every view in it
   * evaluated (child effects run before this provider's). So it cannot outlive that commit, and a commit for
   * some other update (a list unchanged) does not clear it early.
   */
  const heldFocus = useRef<{ ids: Set<string>; against: SessionState[] } | null>(null)
  /** Hibernations a device asked for whose exit has not arrived yet. */
  const quietHibernations = useRef(new Set<string>())

  /**
   * Called inside a `setSessions` updater with its `previous` list. Idempotent for the same arguments, so
   * StrictMode's double invocation of updaters is harmless.
   */
  function holdFocus(ids: readonly string[], against: SessionState[]): void {
    const held = heldFocus.current
    heldFocus.current = { ids: new Set([...(held?.against === against ? held.ids : []), ...ids]), against }
  }

  // No dependency array: after every commit, once the views (children) ran their effects.
  useEffect(() => {
    if (heldFocus.current && heldFocus.current.against !== sessions) heldFocus.current = null
  })

  const isFocusHeld = useCallback((sessionId: string) => heldFocus.current?.ids.has(sessionId) ?? false, [])

  // An offer lives only while its session runs: a close, a hibernation, an exit or a wake ends it. Adjusted while
  // rendering (the list it was last checked against is kept), not in an effect.
  const [offersCheckedAgainst, setOffersCheckedAgainst] = useState(sessions)
  if (offersCheckedAgainst !== sessions) {
    setOffersCheckedAgainst(sessions)
    const running = new Set(sessions.filter((session) => session.status === 'running').map((session) => session.id))
    const kept = [...closeOffers].filter((id) => running.has(id))
    if (kept.length !== closeOffers.size) setCloseOffers(new Set(kept))
  }
  const offerClose = useCallback((sessionId: string) => {
    setCloseOffers((current) => (current.has(sessionId) ? current : new Set([...current, sessionId])))
  }, [])
  const withdrawCloseOffer = useCallback((sessionId: string) => {
    setCloseOffers((current) => {
      if (!current.has(sessionId)) return current
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
  }, [])
  const keepCloseOffer = useCallback(
    (sessionId: string) => {
      withdrawCloseOffer(sessionId)
      window.workspace.handoff.keepCloseOffer(sessionId)
    },
    [withdrawCloseOffer],
  )
  /** A shell's screen serialized when its hibernation was requested; it becomes the replay once the pty is gone. */
  const hibernationSnapshots = useRef(new Map<string, string>())
  /** sessionId → serialize that session's screen. Registered by `TerminalView`. */
  const serializers = useRef(new Map<string, () => string | undefined>())
  /** 重建的 session 其上次的終端畫面。由 `TerminalView` 在掛載時取走（見 `takeScrollback`）。 */
  const restoredScrollback = useRef(new Map<string, string>())

  /**
   * 從持久化重建 session。**每個都是休眠的** —— 有身分、有畫面，但沒有 pty（design D11）。
   */
  useEffect(() => {
    // **StrictMode 會把 effect 跑兩次（且只在 dev）。** 少了這道 ref，`restore()` 會被呼叫兩次，
    // 每個 session 都變成兩份分頁 —— 而 build 模式完全正常，是那種「一邊過一邊不過」的病。
    if (restoredRef.current) return
    restoredRef.current = true

    void window.workspace.terminal
      .restore()
      .then((persisted) => {
        for (const entry of persisted) {
          // **快照要在 session 出現之前就備妥**：`TerminalView` 一掛載就會來取它，而重播必須先於
          // 接上 live 串流 —— 否則 pty 的第一個 prompt 會插進歷史中間（design D6）。
          if (entry.scrollback) restoredScrollback.current.set(entry.id, entry.scrollback)

          // 序號不可回退：重建後新開的 session 必須拿到比現存最大值更大的號，否則會撞號。
          const seen = nextOrdinal.current.get(entry.folderId) ?? 0
          nextOrdinal.current.set(entry.folderId, Math.max(seen, entry.ordinal))
        }

        // **合併，不是覆蓋。**
        //
        // restore 是一次非同步的 IPC —— 使用者（或探針）完全可能在它回來之前就按下「+ session」。
        // 若在這裡直接 `setSessions(重建的清單)`，那個剛建好的 session 會被整個換掉而**憑空消失**，
        // 但它的 pty 還活著（探針抓到的正是這個：「pty 行程存在」是綠的，「分頁出現」是紅的）。
        setSessions((previous) => {
          const known = new Set(previous.map((session) => session.id))
          const restoredSessions = persisted
            .filter((entry) => !known.has(entry.id))
            .map((entry) => ({
              id: entry.id,
              folderId: entry.folderId,
              spawnTarget: entry.spawnTarget,
              status: 'dormant' as const,
              ordinal: entry.ordinal,
              title: entry.title,
              customTitle: entry.customTitle,
              worktreeKey: entry.worktreeKey,
              lineage: entry.lineage,
            }))
          // 重建的排在前面 —— 它們是上次的順序，而在它們之前建立的那些是「新的」。
          return [...restoredSessions, ...previous]
        })
      })
      .catch((error) => {
        console.error(`[sessions] restore failed: ${String(error)}`)
      })
      .finally(() => {
        // 無論成敗都要開閘 —— 否則落盤永遠不會發生，使用者接下來做的一切都不會被記住。
        setRestored(true)
      })
  }, [])

  /**
   * 落盤。
   *
   * **`restored` 這道閘是承重的**：首次渲染時 `sessions` 是空陣列 —— 少了它，這個 effect 會在
   * restore 從磁碟讀回來**之前**就送出一份空清單，把上一次的 session 全部抹掉。而且是靜默的：
   * 沒有錯誤、沒有訊息，只有「重開之後什麼都不見了」。
   *
   * payload **不含 cwd、不含對話識別碼** —— 那兩個是主行程的欄位（design D9）。
   *
   * **也不含側欄座標**（來源 repo／工作目錄／錨定的 change）。它們隸屬於 rail 的項目而非
   * session，由 `PanelCoordinateProvider` 自行落盤 —— 一個沒有任何 session 的 folder，其座標
   * 同樣要跨重啟存活，而掛在 session 上的資料做不到這件事（`session-persistence`）。
   */
  useEffect(() => {
    if (!restored) return
    window.workspace.terminal.persist(
      sessions
        // 已結束的 session 不持久化：重開時不該把一個死掉的分頁重建回來（使用者裁決）。
        .filter((session) => session.status !== 'exited')
        .map(
          ({ id, folderId, spawnTarget, ordinal, title, customTitle, worktreeKey }) => ({
            id,
            folderId,
            spawnTarget,
            ordinal,
            title,
            customTitle,
            worktreeKey,
          }),
        ),
    )
  }, [sessions, restored])

  /**
   * 喚醒一個休眠的 session。
   *
   * **不從 `sessionsRef` 判斷它是不是休眠的** —— 那個 ref 由一個 effect 更新，而 React 的 effect
   * 由內而外執行：呼叫端（`MainStage`，它是子層）的 effect 會**早於**這裡的 ref 更新，於是重建後
   * 的第一次喚醒會讀到一份還是空的 ref，然後什麼都不做。休眠與否由呼叫端判斷（它手上的
   * `SessionState` 是當下這一次渲染的），這裡只負責「同一個 session 不送出兩次」。
   */
  const wake = useCallback((sessionId: string, options?: { quiet?: boolean }): Promise<WakeOutcome> => {
    // A wake the user asks for is the user turning to the session: no held-back focus survives it.
    if (options?.quiet) quietArrivals.current.set(sessionId, new Set<QuietConsumer>(['terminal', 'conversation']))
    else quietArrivals.current.delete(sessionId)
    // A device's hibernation that never produced an exit must not make a later one quiet.
    quietHibernations.current.delete(sessionId)
    if (waking.current.has(sessionId)) return Promise.resolve({ status: 'woken' })
    waking.current.add(sessionId)

        const fail = (message: string): WakeOutcome => {
      // A failed wake leaves the set: waking is only ever the user's explicit action now (nothing
      // calls it on re-render), so pressing Wake again is the retry.
      waking.current.delete(sessionId)
      quietArrivals.current.delete(sessionId)
      setSessions((previous) =>
        previous.map((session) =>
          // session 維持休眠，並把原因呈現出來 —— 而不是靜默地什麼都不發生。
          session.id === sessionId ? { ...session, wakeError: message } : session,
        ),
      )
      return { status: 'failed', message }
    }

    return window.workspace.terminal
      .wake(sessionId)
      .then((result): WakeOutcome => {
        if (!result.ok) return fail(result.message)
        setSessions((previous) =>
          previous.map((session) =>
            session.id === sessionId
              ? { ...session, status: 'running', wakeError: undefined }
              : session,
          ),
        )
        return { status: 'woken' }
      })
      // IPC 本身 reject（罕見，但不是不可能）時，少了這個 catch，該 session 會永遠卡在
      // `waking` 集合裡、`wakeError` 也不會被設定 —— 使用者面對的是一個什麼都不做、也不說
      // 為什麼的分頁。
      .catch((error) => fail(String(error)))
  }, [])

  const takeQuietArrival = useCallback((sessionId: string, consumer: QuietConsumer): boolean => {
    const pending = quietArrivals.current.get(sessionId)
    if (!pending?.delete(consumer)) return false
    if (pending.size === 0) quietArrivals.current.delete(sessionId)
    return true
  }, [])

    const hibernate = useCallback((sessionId: string, token?: string, options?: { quiet?: boolean }): Promise<boolean> => {
    const target = sessionsRef.current.find((session) => session.id === sessionId)
    // A device's request goes on although this view's status lags: the main process saw a process.
    if (!target || (target.status !== 'running' && !options?.quiet)) return Promise.resolve(false)
    if (target.spawnTarget === 'shell' && target.status === 'running') {
      // The rolling snapshot may be a debounce interval behind; the screen at this moment is what
      // the user must see after waking. Sent before `hibernate`: messages from one renderer arrive
      // in order, and the main process also records the shell's last directory from it.
      const data = serializers.current.get(sessionId)?.()
      if (data) {
        window.workspace.terminal.snapshot(sessionId, data)
        hibernationSnapshots.current.set(sessionId, data)
      }
    }
    if (options?.quiet) quietHibernations.current.add(sessionId)
    else quietHibernations.current.delete(sessionId)
    return window.workspace.terminal.hibernate(sessionId, token).then((result) => {
      // Refused (an automatic request the session no longer qualifies for, or no process left): keep nothing.
      if (!result.ok) {
        hibernationSnapshots.current.delete(sessionId)
        quietHibernations.current.delete(sessionId)
      }
      return result.ok
    })
  }, [])

  // The main process asks for idle sessions to be hibernated; they go through the same path as the
  // user's request, carrying the token back.
  useEffect(
    () => window.workspace.terminal.onHibernateRequest((sessionId, token) => hibernate(sessionId, token)),
    [hibernate],
  )

  const registerSerializer = useCallback((sessionId: string, serialize: () => string | undefined) => {
    serializers.current.set(sessionId, serialize)
    return () => {
      if (serializers.current.get(sessionId) === serialize) serializers.current.delete(sessionId)
    }
  }, [])

  const create = useCallback(
    async (
      folderId: string,
      spawnTarget: SpawnTarget,
      options?: { worktreeKey?: string; ticket?: string; background?: boolean; quiet?: boolean },
    ): Promise<CreateOutcome> => {
      const worktreeKey = options?.worktreeKey
      const result = await window.workspace.terminal.create(folderId, spawnTarget, worktreeKey, options?.ticket)
      if (!result.ok) return { status: 'failed', failure: result }

      const { sessionId, lineage } = result.value
      const ordinal = (nextOrdinal.current.get(folderId) ?? 0) + 1
      nextOrdinal.current.set(folderId, ordinal)

      // Marked before the session is rendered, so its terminal sees the mark when it first evaluates.
      if (options?.quiet) quietArrivals.current.set(sessionId, new Set<QuietConsumer>(['terminal']))
      setSessions((previous) =>
        placeChild([...previous, { id: sessionId, folderId, spawnTarget, status: 'running', ordinal, worktreeKey, lineage }], sessionId),
      )
      // A quiet session changes nobody's focused session: it never replaces what the desktop displays.
      if (options?.quiet) return { status: 'created', sessionId }
      setFocused((previous) => new Map(previous).set(folderId, sessionId))
      if (!options?.background) setAttention((n) => n + 1)

      return { status: 'created', sessionId }
    },
    [],
  )

  const close = useCallback((sessionId: string, options?: { quiet?: boolean }) => {
    const target = sessionsRef.current.find((session) => session.id === sessionId)
    quietHibernations.current.delete(sessionId)

    // 已結束的 session 主行程已無該 pty，kill 是 no-op —— 一律呼叫，不必分支（design D12）。
    window.workspace.terminal.kill(sessionId)
    sinks.current.delete(sessionId)
    backlog.current.delete(sessionId)
        waking.current.delete(sessionId)
    restoredScrollback.current.delete(sessionId)
    hibernationSnapshots.current.delete(sessionId)

    setSessions((previous) => {
      if (options?.quiet && target) {
        // The session shown in the closed one's place (the sibling `setFocused` below picks, which is also the
        // `focusedIdFor` fallback) holds its focus for this commit. Harmless when nothing is displayed instead.
        const replacement = previous.find((session) => session.folderId === target.folderId && session.id !== sessionId)
        if (replacement) holdFocus([replacement.id], previous)
      }
      return previous.filter((session) => session.id !== sessionId)
    })
    if (!target) return

    setFocused((previous) => {
      if (previous.get(target.folderId) !== sessionId) return previous
      const sibling = sessionsRef.current.find(
        (session) => session.folderId === target.folderId && session.id !== sessionId,
      )
      const next = new Map(previous)
      if (sibling) next.set(target.folderId, sibling.id)
      else next.delete(target.folderId)
      return next
    })
  }, [])

  const focus = useCallback((folderId: string, sessionId: string) => {
    setFocused((previous) => new Map(previous).set(folderId, sessionId))
    setAttention((n) => n + 1)
    // The user turned to it: whatever focus a quiet arrival still held back is released.
    quietArrivals.current.delete(sessionId)
  }, [])

  const setTitle = useCallback((sessionId: string, title: string) => {
    const trimmed = title.trim()
    const next = trimmed === '' ? undefined : trimmed

    setSessions((previous) => {
      const target = previous.find((session) => session.id === sessionId)
      if (!target) return previous

      // **login shell 宣告的標題一律丟棄。**
      //
      // shell 送的是它預設的 prompt 標題（`使用者@主機:/路徑`），對使用者零識別意義 —— 那不
      // 回答「這個 session 在幹嘛」。更糟的是它比 session 晚一秒多才到（shell 要先載完 rc、
      // 畫出第一個 prompt），抵達時分頁的標籤由 `shell 1` 暴增為一長串，寬度從約 60px 撐到
      // 約 210px，把緊鄰其後的「+ session」入口往右推 150px —— 使用者正要點下去時，按鈕從
      // 游標底下跳走。`claude` 宣告的標題則相反：短、且正是我們要的身分。
      //
      // **擋在這裡，而不是擋在顯示層**（session-navigation-and-labels 的 design D4）：這是 OSC
      // 標題進入 session 狀態的唯一入口，於是 shell session 的 `title` 恆為 undefined —— 標籤
      // 自然退回本地標籤，而「清空名稱後回到本地標籤（即使 pty 曾宣告過標題）」也自然成立，
      // 顯示層與 `rename` 都不必為 spawn 目標特判。
      if (target.spawnTarget === 'shell') return previous

      // **使用者已接管命名權時，標題照樣記錄下來 —— 只是不被呈現。**
      //
      // 這裡不做任何裁決：不覆蓋（標籤的優先序自然讓 `customTitle` 贏），也不呈現確認。`claude`
      // 隨任務進展持續改標題，每次都問一遍就是無限打斷，而那個問題的答案又是可預測的 —— 使用者
      // 才剛親手命名（design D1）。
      //
      // **記錄而不丟棄**是有目的的：使用者清空名稱交還命名權時，標籤要能立即回到 pty 最近一次
      // 宣告的標題，不必空等它下一次宣告（design D3）。

      // agent 可能反覆送同一個標題 —— 值沒變就不要製造新的陣列（否則每次都重繪整棵樹）。
      if (target.title === next) return previous
      return previous.map((session) =>
        session.id === sessionId ? { ...session, title: next } : session,
      )
    })
  }, [])

  const rename = useCallback((sessionId: string, name: string) => {
    const trimmed = name.trim()
    const next = trimmed === '' ? undefined : trimmed

    setSessions((previous) =>
      previous.map((session) =>
        session.id === sessionId
          ? // 清空＝交還命名權，標籤回到跟隨 pty。`title` 一直都在記錄（見 `setTitle`），
            // 所以這一刻標籤立即變成 pty 最近宣告的標題，不必等它下一次宣告。
            { ...session, customTitle: next }
          : session,
      ),
    )
  }, [])

  const reorder = useCallback((folderId: string, fromIndex: number, toIndex: number) => {
    setSessions((previous) => {
      // 只重排該 folder 佔據的那些位置，其餘 folder 的相對順序完全不動。
      const slots = previous.reduce<number[]>((acc, session, index) => {
        if (session.folderId === folderId) acc.push(index)
        return acc
      }, [])

      if (fromIndex < 0 || fromIndex >= slots.length) return previous
      if (toIndex < 0 || toIndex >= slots.length) return previous
      if (fromIndex === toIndex) return previous

      const group = slots.map((index) => previous[index])
      const [moved] = group.splice(fromIndex, 1)
      group.splice(toIndex, 0, moved)

      const next = [...previous]
      slots.forEach((index, position) => {
        next[index] = group[position]
      })
      return next
    })
  }, [])

  const setOrder = useCallback((folderId: string | null, ids: readonly string[]) => {
    setSessions((previous) => applyOrder(previous, folderId, ids))
  }, [])

  const restoredScrollbackOf = useCallback(
    (sessionId: string): string | undefined => restoredScrollback.current.get(sessionId),
    [],
  )

  /** sessionId → 聚焦該終端的方法。由 `TerminalView` 掛載時註冊（見 `registerFocus`）。 */
  const focusers = useRef<Map<string, () => void>>(new Map())

  const registerFocus = useCallback((sessionId: string, focusTerminal: () => void) => {
    focusers.current.set(sessionId, focusTerminal)
    return () => {
      // 只在仍是自己時移除 —— StrictMode 會把掛載 effect 跑兩次，第二個註冊才是存活下來的那個，
      // 第一個的 cleanup 若無條件刪除，就會把它一起刪掉。
      if (focusers.current.get(sessionId) === focusTerminal) focusers.current.delete(sessionId)
    }
  }, [])

  const sendInput = useCallback((sessionId: string, text: string) => {
    window.workspace.terminal.write(sessionId, text)
    focusers.current.get(sessionId)?.()
    setAttention((n) => n + 1)
  }, [])

  const attach = useCallback((sessionId: string, write: (chunk: string) => void) => {
    const pending = backlog.current.get(sessionId)
    if (pending) {
      backlog.current.delete(sessionId)
      for (const chunk of pending) write(chunk)
    }
    sinks.current.set(sessionId, write)

    return () => {
      if (sinks.current.get(sessionId) === write) sinks.current.delete(sessionId)
    }
  }, [])

  const api = useMemo<SessionsApi>(
    () => ({
      all: () => sessions,
      forFolder: (folderId) => sessions.filter((session) => session.folderId === folderId),
      countFor: (folderId) =>
        sessions.reduce((total, session) => (session.folderId === folderId ? total + 1 : total), 0),
      focusedIdFor: (folderId) => {
        const explicit = focused.get(folderId)
        if (explicit && sessions.some((session) => session.id === explicit)) return explicit
        return sessions.find((session) => session.folderId === folderId)?.id ?? null
      },
      attention,
      focus,
      create,
      wake,
      takeQuietArrival,
      isFocusHeld,
      hibernate,
      registerSerializer,
      close,
      setTitle,
      rename,
      closeOffered: (sessionId) => closeOffers.has(sessionId),
      offerClose,
      withdrawCloseOffer,
      keepCloseOffer,
      reorder,
      setOrder,
      attach,
      sendInput,
      registerFocus,
      restoredScrollbackOf,
    }),
    [
      closeOffers,
      offerClose,
      withdrawCloseOffer,
      keepCloseOffer,
      sessions,
      focused,
      attention,
      focus,
      create,
      wake,
      takeQuietArrival,
      isFocusHeld,
      hibernate,
      registerSerializer,
      close,
      setTitle,
      rename,
      reorder,
      setOrder,
      attach,
      sendInput,
      registerFocus,
      restoredScrollbackOf,
    ],
  )

  return <SessionsContext.Provider value={api}>{children}</SessionsContext.Provider>
}

export function useSessions(): SessionsApi {
  const api = useContext(SessionsContext)
  if (!api) throw new Error('useSessions must be used inside a SessionsProvider')
  return api
}
