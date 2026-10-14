import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpawnTarget } from '../types'
import { ContextMenu, type MenuItem } from '../files/dialogs'
import { usePreferences } from '../PreferencesProvider'
import { type SessionStatus, useSessions } from './sessions'
import { type XtermHandle, createXterm } from './xterm'
import { useTranslation } from 'react-i18next'
import { t } from '@shared/i18n'

interface TerminalViewProps {
  sessionId: string
  spawnTarget: SpawnTarget
  status: SessionStatus
  /** 喚醒失敗的原因（folder 路徑失效）。 */
  wakeError?: string
  /** 非 focused 的終端仍然掛載（保留 scrollback），只是隱藏起來（design D7）。 */
  active: boolean
  /**
   * 這個 session 是當前的，但**另一種呈現覆蓋在它上面**（對話 view）。
   *
   * **`active` 與 `covered` 是兩個不同的謂詞，此前它們恆等。**
   *
   * - `active` ＝ **有沒有版面盒子**。尺寸同步以此為判準（`terminal-sessions` 明文，且禁止在
   *   沒有盒子時推導尺寸）—— 被覆蓋時**仍然為 true**，否則 pty 會停在一個從未被量測過的值。
   * - `covered` ＝ **使用者看不看得見**。渲染資源的持有與焦點以此為判準。
   */
  covered?: boolean
}

/** 拖動分界時 resize 會連續觸發；pty 不需要每一幀都收到一次 SIGWINCH。 */
const RESIZE_DEBOUNCE_MS = 60

/**
 * 終端畫面快照的節流：pty 靜下來這麼久之後，序列化一次並送去落盤。
 *
 * **快照刻意不倚賴「關閉視窗時的同步往返」**（design D4）：那樣的話 renderer 一卡，關窗就跟著卡，
 * 而且 crash 或斷電時什麼都留不下。滾動快照的代價是最多丟失這段時間的畫面 —— 用它換掉一條在
 * 必要路徑上的 IPC 往返，划算。
 */
const SNAPSHOT_DEBOUNCE_MS = 2000

/**
 * 重播的歷史與 live 內容之間的分隔。
 *
 * **這不是裝飾，是誠實性。** 重播的字不是這個 pty 產生的 —— 新 shell 對它一無所知。不標示的話，
 * 使用者會以為那個 shell 還活著：去找他背景跑著的 job、以為 `cd` 過的位置與環境變數還在。
 */
function separator(): string {
  // 只有**文字**進字典 —— ANSI 與框線字元是呈現，不是文案。
  return `\x1b[2m── ${t('sessions.replaySeparator')} ──\x1b[0m\r\n`
}

export function TerminalView({
  sessionId,
  spawnTarget,
  status,
  wakeError,
  active,
  covered = false,
}: TerminalViewProps): React.JSX.Element {
  const { t } = useTranslation()
  // 解構出穩定的 callback。若依賴整個 api 物件，session 清單一變動就會重建 xterm
  // （連同 scrollback 一起消失）。
    const { attach, setTitle, restoredScrollbackOf, registerFocus, registerSerializer, wake, takeQuietArrival } = useSessions()
  const { terminal: termPrefs, gpuEnabled } = usePreferences()
  const hostRef = useRef<HTMLDivElement | null>(null)
    const handleRef = useRef<XtermHandle | null>(null)
  /** The dormant screen's Wake button. It takes focus where the terminal would (`session-persistence`). */
  const wakeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)

  const copy = useCallback(() => {
    const selection = handleRef.current?.getSelection()
    if (selection) window.workspace.clipboard.writeText(selection)
    // 焦點必須回到終端 —— 從選單操作完之後，使用者的下一個動作是繼續打字。
    handleRef.current?.focus()
  }, [])

  // **只在使用者明確要求貼上時讀取剪貼簿** —— 不主動讀、不輪詢（design D2）。
  const paste = useCallback(() => {
    void window.workspace.clipboard.readText().then((text) => {
      if (text) handleRef.current?.paste(text)
      // 少了這一行，自右鍵選單貼上之後按 Enter 不會執行 —— 焦點還在選單那邊，
      // 使用者得再點一次終端才能繼續（實測由探針抓到）。
      handleRef.current?.focus()
    })
  }, [])

  // **claude session 不做快照。** `claude --resume` 續接時會自行把先前的對話重現在終端上 ——
  // 再重播一次我們存的畫面，使用者會看到兩份歷史（design D3）。順帶省下絕大部分的快照 IO：
  // 一直在吐字的正是 agent。
  const snapshots = spawnTarget === 'shell'
  const snapshotTimer = useRef<number | undefined>(undefined)

  const scheduleSnapshot = useCallback(() => {
    if (!snapshots) return
    window.clearTimeout(snapshotTimer.current)
    snapshotTimer.current = window.setTimeout(() => {
      const data = handleRef.current?.serialize()
      if (data) window.workspace.terminal.snapshot(sessionId, data)
    }, SNAPSHOT_DEBOUNCE_MS)
  }, [sessionId, snapshots])

  // 關閉視窗前的 best-effort flush（補上最後這段還沒落盤的畫面）。
  //
  // **它不在必要路徑上** —— 拿不到也只是丟失最後兩秒，因為滾動快照一直在寫。這正是「非正常結束
  // 仍保有最近一次快照」那條 requirement 的實作依據：`kill -9` 收不到 beforeunload，但磁碟上
  // 仍有一份略舊的快照。
  useEffect(() => {
    if (!snapshots) return
    // **只有真的有 pty 的 session 才可以覆寫自己的快照。**
    //
    // 一個從未被喚醒的休眠 shell session，它的 xterm 裡已經被 `replay()` 寫進了「歷史 + 分隔線」。
    // 若關窗時照樣序列化，那份**含分隔線**的內容就會被寫回快照檔 —— 下次開啟再重播一次、再追加
    // 一條新的分隔線。使用者一路不碰它，**每重開一次就多一條「以上為上次的內容」**。而且從未被
    // 顯示過的終端沒有量到過尺寸，它是以 xterm 的預設 80 欄重新序列化的，歷史每輪還會被重排一次。
    //
    // （這裡原本寫「隱藏中的終端從未 `fit()` 過」——**曾經有一段時間那是錯的**：隱藏時
    // `fit()` 會把它重排成 **2 欄**，於是落盤的快照本身就是壞的。修正見
    // `docs/lessons/terminal.md` 的「隱藏的終端絕不可被 fit」。現在隱藏的終端保留最後一次真實
    // 量測的尺寸，這條防護的理由回到「從未顯示過」那一種。）
    if (status !== 'running') return

    const flush = (): void => {
      const data = handleRef.current?.serialize()
      if (data) window.workspace.terminal.snapshot(sessionId, data)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [sessionId, snapshots, status])

  // 建立終端、接上 session、把使用者輸入送回 pty。這個 effect 一輩子只跑一次。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const handle = createXterm({
      openLink: (uri) => {
        // 協定驗證在主行程。pty 的輸出是不受信任的內容，絕不讓它直接驅動導航（design D13）。
        void window.workspace.shell.openExternal(uri)
      },
      onCopy: (text) => window.workspace.clipboard.writeText(text),
      onPaste: () => {
        void window.workspace.clipboard.readText().then((text) => {
          if (text) handle.paste(text)
        })
      },
    })
    handleRef.current = handle
    handle.open(host)

    // 重建的 session：先把上次的畫面重播完、寫上分隔，**然後才**接上 live 串流。
    //
    // 順序是承重的：pty 的輸出一律先進 backlog（`SessionsProvider` 在任何 create 之前就訂閱了），
    // 直到這裡 attach 才被倒出來 —— 於是「歷史 → 分隔 → pty 的第一個 prompt」的順序由 attach
    // 的時機決定。若在重播完成前就 attach，新 shell 的 prompt 會插進歷史中間（design D6）。
    let detach = () => {}
    let disposed = false

    const streamLive = (): void => {
      if (disposed) return
      detach = attach(sessionId, (chunk) => {
        handle.write(chunk)
        scheduleSnapshot()
      })
    }

    const history = restoredScrollbackOf(sessionId)
    if (history) handle.replay(history, separator(), streamLive)
    else streamLive()

    const stopInput = handle.onInput((data) => {
      window.workspace.terminal.write(sessionId, data)
    })
    // pty 裡的程式（如 claude）以 OSC 序列宣告自己是誰 —— 那就是這個 session 的名字。
    const stopTitle = handle.onTitle((title) => setTitle(sessionId, title))

    return () => {
      disposed = true
      window.clearTimeout(snapshotTimer.current)
      stopTitle()
      stopInput()
      detach()
      handle.dispose()
      handleRef.current = null
    }
  }, [sessionId, attach, setTitle, restoredScrollbackOf, scheduleSnapshot])

  // 讓側欄之類的遠端呼叫端有辦法把焦點交回這個終端 —— xterm 的把手只有這裡握著。
  // 註冊獨立於上面那個掛載 effect：它的 deps 多，重跑一次就白白解註冊再註冊一次。
    useEffect(() => registerFocus(sessionId, () => handleRef.current?.focus()), [
    sessionId,
    registerFocus,
  ])

  // Hibernation serializes the screen at that moment (`session-hibernation`): only this view holds the xterm.
  useEffect(() => registerSerializer(sessionId, () => handleRef.current?.serialize()), [
    sessionId,
    registerSerializer,
  ])

  // 尺寸同步。不同步的後果：agent 以為終端是 80 欄、實際更寬，輸出會在錯的位置換行。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let timer: number | undefined
    const sync = (): void => {
      const size = handleRef.current?.fit()
      // null＝尺寸未變，或容器不可見（display:none 時量到 0）—— 兩者都不必打擾 pty。
      if (size) window.workspace.terminal.resize(sessionId, size.cols, size.rows)
    }

    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(sync, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(host)
    sync()

    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [sessionId])

  /**
   * pty 誕生的那一刻，把終端**當下的**尺寸告訴它。
   *
   * **喚醒把「pty 先誕生、終端後掛載」的順序倒了過來**（dogfooding 抓到）：休眠的 session 其終端
   * 早就掛載並 `fit()` 過了，那次 `resize` 打在一個**還不存在的 pty** 上（主行程直接忽略）；等
   * `wake()` 真的 spawn 出 pty，已經沒有人會再送一次尺寸了 —— `fit()` 因為「尺寸沒變」一律回
   * `null`。於是新 pty **一輩子停在 spawn 時的 80×24**：claude 以 80 欄排版，畫面縮成一小塊，
   * 要等使用者手動拖動視窗才恢復。
   *
   * 新建的 session 不會踩到，因為它的 pty **先**誕生、終端**後**掛載 `fit()`。
   */
  useEffect(() => {
    if (status !== 'running') return
    const size = handleRef.current?.size()
    if (size) window.workspace.terminal.resize(sessionId, size.cols, size.rows)
  }, [status, sessionId])

  // 中鍵與右鍵：**在 capture 階段完全接管這兩顆鍵**（中鍵貼上一次，右鍵開我們的選單）。
  //
  // ## 右鍵為什麼也在這裡（而不是 `onContextMenu`）
  //
  // 右鍵此前 gate 在 mouse reporting：程式接管滑鼠時讓位給它，理由是「讓 claude 自己的右鍵貼上
  // 生效」。**那個前提是錯的，兩端都已實測否證**：`claude` 一啟動就送 `?1000h ?1002h ?1003h
  // ?1006h`（於是 agent session 裡右鍵**永遠**被讓出去），而 pty 內的程式**讀不到系統剪貼簿**
  // —— 唯一的管道 OSC 52 xterm.js 未實作（且我們選擇不加）。讓出去的是一顆什麼都不做的鍵，
  // 而觸控板沒有中鍵，於是使用者完全失去滑鼠貼上。右鍵因此與中鍵收斂為同一條歸屬規則。
  //
  // **選單自 `mousedown` 開，不依賴 `contextmenu` 事件**：後者由平台決定派送在 mousedown 還是
  // mouseup（Linux/GTK 與 Windows 不同），依賴它就等於讓「選單會不會被自己開啟的那次事件關掉」
  // 取決於平台 —— 而 `ContextMenu` 的「延一個 tick 才掛 dismiss」正是在賭這個時序。把整顆按鍵的
  // 四個事件都攔在 host 之下，那個時序問題**表達不出來**（它們冒不到 window，dismiss 收不到）。
  //
  // **`contextmenu` 必須列進來**：`mousedown` 上的 `preventDefault()` 實測**不會**取消它，
  // 不攔就會跳出瀏覽器的原生選單。（此前那件事由 React 的 `onContextMenu` 負責，而它在 capture
  // 接管之後**永遠不會執行** —— React 19 的委派 listener 掛在 `#root`，是 host 的祖先，
  // `stopPropagation` 之後事件既不再往下、也不再冒泡。那個 prop 因此整個移除，不留死碼。）
  //
  // 已知取捨：先在分頁上右鍵開了選單、再到終端右鍵，以前終端的 `contextmenu` 會冒到 window 把
  // 分頁那個關掉，現在不會 —— 兩個 `[role="menu"]` 會並存到使用者左鍵點掉為止。接受它：另一條路
  // （不攔 `contextmenu`）會把選單的存活重新交還給平台時序，而 Phase 6 要出 Windows。
  //
  // 攔掉右鍵對 xterm 的既有行為只關掉一件事：它綁在 `contextmenu` 上的
  // `moveTextAreaUnderMouseCursor`（為了讓**原生**選單的貼上落在隱形 textarea 上）—— 我們本來
  // 就擋掉原生選單、貼上走 `term.paste()`。**選取不受影響**：xterm 的選取只認左鍵。
  //
  // ## 中鍵的部分（原有的論證，未改變）
  //
  // 中鍵貼上是**終端的**慣例，不是 pty 內程式的慣例 —— 由我們擁有它、只貼一次，才是確定的行為。
  // dogfood 抓到：login shell（mouse off）與 claude（mouse on）中鍵**都貼兩次** —— 兇手是 Chromium 的
  // native 中鍵貼上（X11 PRIMARY selection）一直在發生，加上我們自己的貼上就是兩次。原本走 React 的
  // `onMouseDown`（bubble 階段）擋不掉它：其一 bubble 晚於 xterm 掛在 `.xterm-screen`（host 子節點）
  // 上的 listener（xterm 已把中鍵轉發給 claude）；其二 native 貼上掛在 `auxclick` 而非 mousedown，
  // mousedown 的 `preventDefault` 打不到它。
  //
  // capture 由 host 往下傳、早於子節點的 listener：對中鍵的 mousedown／mouseup／auxclick 一律
  // `preventDefault`（擋掉 native 貼上，不論它掛在哪個事件）+ `stopPropagation`（xterm 收不到、不會
  // 轉發給 claude），並在 mousedown 時做**唯一一次**我們的貼上。於是中鍵恆為一次乾淨的貼上，與
  // mouse reporting 開不開無關（貼的是 CLIPBOARD，與快捷鍵同源，design D5）。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    /** 我們擁有的兩顆鍵：1＝中鍵、2＝右鍵。左鍵不在此列（它是 pty 內程式的主要互動面）。 */
    const owned = (button: number): boolean => button === 1 || button === 2

    const suppress = (event: MouseEvent): void => {
      if (!owned(event.button)) return
      event.preventDefault()
      event.stopPropagation()
    }
    // `contextmenu` 沒有 `button` —— 它整個屬於右鍵這條路徑。
    const suppressContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const onDown = (event: MouseEvent): void => {
      if (!owned(event.button)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.button === 1) {
        paste()
        return
      }
      // 選取狀態要在開啟選單的當下取樣 —— 選單一旦開啟，焦點就離開終端了。
      setMenu({
        x: event.clientX,
        y: event.clientY,
        hasSelection: handleRef.current?.hasSelection() ?? false,
      })
    }

    host.addEventListener('mousedown', onDown, true)
    host.addEventListener('mouseup', suppress, true)
    host.addEventListener('auxclick', suppress, true)
    host.addEventListener('contextmenu', suppressContextMenu, true)
    return () => {
      host.removeEventListener('mousedown', onDown, true)
      host.removeEventListener('mouseup', suppress, true)
      host.removeEventListener('auxclick', suppress, true)
      host.removeEventListener('contextmenu', suppressContextMenu, true)
    }
  }, [paste])

  // 由隱藏轉為顯示的那一刻，容器才第一次有尺寸 —— 必須重新 fit 一次（design D7 的代價）。
  //
  // **fit 與 focus 的條件不同，那是承重的。** fit 只要有版面盒子就該做（`active`）；
  // 但**搶焦點要看使用者看不看得見**：對話 view 覆蓋在上面時，一個隱形的終端把焦點搶走，
  // 使用者接著打的字會進 pty 而畫面上什麼都沒有 —— 與「訊息被送到錯的地方」同一族的失效。
    //
  // **While the session is dormant the same rule focuses the Wake button instead** — one rule, not two
  // effects racing for focus (`session-persistence`). So `Ctrl+Tab` then `Enter` wakes it, and an
  // `Enter` can never be written to a pty that does not exist. The status is a dependency so that
  // when the session starts running the terminal takes focus (the button is gone by then and focus
  // would otherwise sit on `<body>`). Other status changes (a pty exiting) leave focus alone.
  //
  // **A change of `covered` alone does not fit** (`maximize-panel-and-confirm-close`). Covering keeps
  // the box, so there is nothing to measure — and the GPU renderer is released or taken back on that
  // same transition, and the two renderers measure different cells (DOM ≈ 9.63px, webgl 9px wide):
  // a fit there would send the pty a size computed from the renderer that is not the one in use, and
  // the agent would reflow for nothing (measured: 63 → 57 columns on maximize + restore).
  //
  // **A session that arrived quietly** (created or woken for a paired device, `remote-protocol`) holds back
  // only the `focus()` of the moment it arrives — the fit still runs, or the pty would stay 80×24 and
  // output at the wrong width would stay in history. The mark is asked for only at that moment (the first
  // evaluation, or a status change): if the terminal is not on screen then, the mark is simply dropped, and
  // the user's later activation focuses as usual.
  const previousStatus = useRef(status)
  // `false` at first, so the first run with a box fits.
  const previousActive = useRef(false)
  const evaluated = useRef(false)
  useEffect(() => {
    const was = previousStatus.current
    const wasActive = previousActive.current
    const arriving = !evaluated.current || was !== status
    evaluated.current = true
    previousStatus.current = status
    previousActive.current = active
    const quiet = arriving && takeQuietArrival(sessionId, 'terminal')
    if (!active) return
    if (!wasActive || was !== status) {
      const size = handleRef.current?.fit()
      if (size) window.workspace.terminal.resize(sessionId, size.cols, size.rows)
    }
    if (covered) return
    if (was !== status && was !== 'dormant' && status !== 'dormant') return
    if (quiet) return
    if (status === 'dormant') wakeButtonRef.current?.focus()
    else handleRef.current?.focus()
  }, [active, covered, sessionId, status, takeQuietArrival])

  /**
   * GPU 加速：**只給當下顯示的那一個終端**，且使用者可以整個關掉。
   *
   * **「只給顯示中的」不是優化，是正確性要求。** 所有 session 的終端同時掛載（保留各自的
   * scrollback，見 design D7），而並存的 webgl context 有上限（實測恰為 16）—— **超出時最舊的
   * 會被靜默丟棄，不觸發任何事件**。若每個終端各持有一份，開了夠多 session 的使用者會看到較舊
   * 的終端**無聲地變成空白**，而 wrapper 裡那條 `onContextLoss` 的自癒救不了他（它倚賴一個
   * 通知，而那裡根本沒有通知）。
   *
   * 切走即釋放、切回即取得 —— 並存恆為 1。而「需要框線正確」的地方，恰好就是「看得見」的地方。
   *
   * `gpuEnabled` 是使用者的逃生口（見 `PreferencesProvider`）：自動降級只擋得住「資源取不到」，
   * 擋不住「取得了、但驅動有缺陷而畫出錯的內容」—— 那只有使用者看得出來，也只有他關得掉。
   */
  useEffect(() => {
    // **判準是「看不看得見」，不是「有沒有版面盒子」。** 對話 view 覆蓋在上面時終端仍保有盒子
    // （尺寸同步需要它），但使用者看不見它 —— 依本要求必須歸還並存額度。
    //
    // 這是**第四種轉換**：保有盒子、失去可見、不銷毀、不失去掛載。既有條款只寫了
    // 顯示↔隱藏與銷毀三種，本 change 為它補了條文與驗收（`terminal-sessions` delta）。
    handleRef.current?.setGpuRenderer(active && !covered && gpuEnabled)
  }, [active, covered, gpuEnabled])

  // 套用終端字型偏好。掛載時套一次（偏好通常已由 `PreferencesProvider` 早載入備妥），偏好變更時再套。
  //
  // **只有 `setFont` 真的改動了選項才 `fit()`／`resize()`。** 掛載時偏好通常等於預設 —— 什麼都沒變卻
  // 照樣 resize，等於對 pty 多送一次無謂的 SIGWINCH，而 shell 收到它會重畫 prompt，把終端既有的輸出
  // 往上推（probe 抓到：「切回 session 後其先前的輸出仍在」讀不到早期內容，baseline 168/168 卻是綠的）。
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const changed = handle.setFont({
      family: termPrefs.fontFamily ?? null,
      size: termPrefs.fontSize ?? null,
      lineHeight: termPrefs.lineHeight ?? null,
    })
    if (!changed) return
    // 字級與行高改變會改 cell 尺寸 —— 新的行列數必須告知 pty。
    const size = handle.fit()
    if (size) window.workspace.terminal.resize(sessionId, size.cols, size.rows)
  }, [termPrefs.fontFamily, termPrefs.fontSize, termPrefs.lineHeight, sessionId])

  const items: MenuItem[] = [
    {
      label: t('sessions.copy'),
      // 停用而非隱藏 —— 使用者要看得到這個操作存在。
      disabled: !menu?.hasSelection,
      onSelect: () => {
        setMenu(null)
        copy()
      },
    },
    {
      label: t('sessions.paste'),
      onSelect: () => {
        setMenu(null)
        paste()
      },
    },
  ]

  return (
    <div
      ref={hostRef}
      // 隱藏而非卸載 —— scrollback 活在 xterm 實例裡，卸載即遺失。
      //
      // **`relative` 是承重的**：底下那些休眠提示是 `absolute` 的，需要一個定位祖先；少了它，
      // 它們會相對於更外層的 `<section>` 定位。而真正致命的是**堆疊順序** —— xterm 的 `.xterm`
      // 是 `position: relative`（它自己的 CSS），且由 `handle.open(host)` 在 effect 裡 append，
      // 也就是排在 React children **之後**。兩者都是 `z-index: auto` → 依 tree order 繪製 →
      // **xterm 蓋在提示上**，而 `.xterm-viewport` 的背景是不透明的。於是休眠的 claude 分頁
      // 看起來就是一塊空白終端 —— 正是 spec 明文禁止的那件事。提示因此必須明確拿到 z-index。
      //
      // **這裡沒有 `onContextMenu`，是刻意的。** 右鍵（連同原生選單的抑制）整個由上面那個
      // capture 階段的 effect 擁有 —— React 的委派 listener 掛在 `#root`（host 的祖先），
      // capture 一 `stopPropagation` 它就永遠不會執行。放一個在這裡只會是誤導人的死碼。
      className={active ? 'relative h-full w-full' : 'hidden'}
    >
      {/*
        休眠態的呈現。**休眠的 session 絕不能只是一塊空白的終端** —— 那看起來像壞掉。

        兩個目標的處境不同（design D11）：shell 的歷史畫面已經重播進終端了，提示只能是一條
        不遮蔽它的細帶；claude 不重播（`--resume` 會自己重現對話），它背後真的是空的，所以
        提示置中、自己成為那個「有東西可看」。
      */}
            {status === 'dormant' &&
        (wakeError ? (
          // **恢復不了是個錯誤狀態，它必須看得見。** 貼在底部的一條細帶太弱 —— 使用者面對的仍是
          // 一大塊黑色空白，只有邊緣一行小字。置中呈現，與 claude 的休眠提示同一種載體。
          //
          // **這一個刻意不是 `pointer-events-none`**（另外兩個是）：它背後是一個**永遠不會活過來**
          // 的終端，沒有東西值得點。讓它接住指標事件，這塊提示才是實心的 —— 而不是一層點得穿的
          // 幽靈。順帶也讓探針能以 `elementFromPoint` 做真正的 hit-test（`pointer-events-none`
          // 的元素會被它跳過，於是「它有沒有被 xterm 蓋住」根本量不到）。
          //
          // Its Wake button is the retry: a failed wake is no longer retried on its own.
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex max-w-[80%] flex-col items-center gap-2 rounded border border-hairline bg-shell/90 px-4 py-3 text-center text-2xs text-danger">
              <span>{t('sessions.wakeFailed', { message: wakeError })}</span>
              <WakeButton ref={wakeButtonRef} onWake={() => wake(sessionId)} />
            </div>
          </div>
        ) : spawnTarget === 'shell' ? (
          // The strip lets clicks through to the replayed history (selection, scrolling); only the
          // button takes them.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 bg-shell/90 px-3 py-2 text-2xs text-ink-faint">
            <span className="min-w-0 flex-1">{t('sessions.dormantShell')}</span>
            <WakeButton ref={wakeButtonRef} onWake={() => wake(sessionId)} />
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 rounded border border-hairline bg-shell/90 px-4 py-3 text-center text-2xs text-ink-faint">
              <span>{t('sessions.dormantClaude')}</span>
              <WakeButton ref={wakeButtonRef} onWake={() => wake(sessionId)} />
            </div>
          </div>
        ))}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          // **焦點要回到終端。** 右鍵的 mousedown 被 capture 攔下之後 xterm 不再取得焦點
          //（此前它會），於是以 Escape 關掉選單時焦點會落在 `document.body` —— 使用者接著打字
          // 什麼都不會發生，得再點一次終端。複製／貼上兩個項目本來就各自 `focus()` 過了，
          // 這裡補的是「開了選單又不選任何項目」那條路徑。
          onClose={() => {
            setMenu(null)
            handleRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/**
 * The dormant screen's only way to start the session (`session-persistence`: displaying a dormant
 * session does not start it). A native `<button>`, so `Enter` and `Space` activate it with no key
 * handling of our own; it takes pointer events inside overlays that otherwise let them through.
 */
export function WakeButton({
  ref,
  onWake,
}: {
  ref?: React.Ref<HTMLButtonElement>
  onWake: () => void
}): React.JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onWake}
      className="pointer-events-auto shrink-0 cursor-pointer rounded border border-hairline bg-panel px-3 py-1 text-xs text-ink hover:bg-hover focus:outline focus:outline-2 focus:outline-accent"
    >
      {t('sessions.wake')}
    </button>
  )
}
