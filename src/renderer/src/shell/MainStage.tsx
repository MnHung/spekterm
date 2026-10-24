import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import {
  type ContinuationBlock,
  continuationBlockOf,
  continuationCommand,
} from './openspec/continuation'
import { ROOT_PATH } from './files/paths'
import { resolveAnchoredChange } from './openspec/anchor'
import { useChanges, useWorktrees } from './openspec/data'
import { initialMaximizeState, maximizeReducer, type VizKind } from './maximize-state'
import type { FileRequest, OpenSpecRequest, OpenSpecTarget } from './openspec/nav'
import { usePanelCoordinate } from './panel-coordinate'
import { QuickOpen } from './quick-open/QuickOpen'
import { usePreferences } from './PreferencesProvider'
import { PanelSwitch } from './side-panel/PanelSwitch'
import { SidePanel } from './side-panel/SidePanel'
import { SessionSummary } from './SessionSummary'
import { SessionTabs } from './terminal/SessionTabs'
import { ConversationView } from './terminal/ConversationView'
import { TerminalView } from './terminal/TerminalView'
import { useSessions } from './terminal/sessions'
import { folderSelection } from './types'
import type {
  PanelIdentity,
  RailSelection,
  SpawnTarget,
  WorkspaceFolder,
  WorktreeOption,
} from './types'

/** 穩定的空陣列 —— 每次渲染新造一個會讓下游的依賴比較失效。 */
const EMPTY_WORKTREES: WorktreeOption[] = []

interface MainStageProps {
  /**
   * rail 上選中的項目 —— 「駕駛」那半（header、session 分頁、terminal）以它為準。
   * `null` ＝ 尚未選中任何項目（與「選中全域項目」互斥可辨，design D8）。
   */
  selection: RailSelection | null
  /** workspace 的所有 folder —— 來源指示器的下拉清單。 */
  folders: WorkspaceFolder[]
}

/**
 * 這個 session 當下的呈現方式。
 *
 * **選擇本身是全域偏好**（`agent-conversation-view`）—— 這個函式只多做一件事：
 * **shell 目標一律回終端**。那條判定與作用域無關，它保障的是「shell 沒有 agent 紀錄可看」，
 * 而不是「兩個 session 可以不一樣」—— 前者是 spawn 目標的性質，後者才是被移除的那個東西。
 */
function sessionViewOf(
  session: { spawnTarget: string },
  agentView: 'terminal' | 'conversation',
): 'terminal' | 'conversation' {
  if (session.spawnTarget !== 'claude') return 'terminal'
  return agentView
}

export function MainStage({ selection, folders }: MainStageProps): React.JSX.Element {
  // view 的選擇是全域偏好（`agent-conversation-view`），不再逐 session 持有。
  const preferences = usePreferences()
  const { t } = useTranslation()
  const sidePanelRef = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  // 預設身分是 OpenSpec —— 雛型的預設，也是這個工作台的主張：使用者加入一個有 openspec/ 的
  // repo，預期看到的是它的 spec 與 change，而不是一棵他在 IDE 裡已經看膩的檔案樹。
  // （Phase 2 曾暫設為 Files，理由是 OpenSpec 身分還沒有內容 —— 該理由已不復存在。）
  const [identity, setIdentity] = useState<PanelIdentity>('openspec')
  const [sessionError, setSessionError] = useState<string | null>(null)

  // 跨身分導航的請求（design D7）。nonce 讓「連續兩次跳到同一個目標」也能觸發。
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null)
  const [openSpecRequest, setOpenSpecRequest] = useState<OpenSpecRequest | null>(null)
  const nonce = useRef(0)

  const [quickOpen, setQuickOpen] = useState(false)
  /**
   * 側欄容器 —— quick open 關閉時焦點的退路。
   *
   * 它帶 `tabIndex={-1}`：一個沒有 tabIndex 的 `<section>` 對 `.focus()` 是 **no-op**，於是焦點
   * 會掉到 `<body>`，下一次 `Ctrl+P` 靜默失效。而「開啟檔案」正是記住的元素必然消失的那條路
   * （檔案樹被檢視器換掉），退路在最常走的路上才會被用到。
   */
  const sidePanelSectionRef = useRef<HTMLElement>(null)

  const sessions = useSessions()
  const panel = usePanelCoordinate()

  /**
   * The maximized side panel and the Graph / Timeline view in it (`maximize-panel-and-confirm-close`
   * design M3–M5). The rules — every way out also leaves Graph — are in the pure reducer.
   *
   * **Turning to a session restores it** (design M4): the sessions context moves `attention` on every
   * user-initiated focus, creation and input, and it is compared here during render — state, not a
   * ref written during render, the same pattern as the request nonce in `OpenSpecPanel`.
   */
  const [maximize, dispatchMaximize] = useReducer(maximizeReducer, sessions.attention, initialMaximizeState)
  if (sessions.attention !== maximize.seenAttention) {
    dispatchMaximize({ type: 'attention', value: sessions.attention })
  }
  const maximized = maximize.maximized

  // **「駕駛」那半：當前選中的 rail 項目。** header、session 分頁與 terminal 一律以它為準
  // —— 側欄指向另一個 repo 時，這一半完全不受影響（`side-panel-source`）。
  //
  // 選中的可能是**全域項目**（不隸屬任何 folder，`global-session`），因此這裡有兩個變數而不是
  // 一個：`itemKey` 是 session 的歸屬鍵（`null` ＝ 全域），`focusedFolder` 只有選中 folder 時
  // 才有值 —— header 的名稱與路徑要用它。
  const focusedFolder =
    selection?.kind === 'folder'
      ? (folders.find((candidate) => candidate.id === selection.id) ?? null)
      : null
  const itemKey: string | null = selection?.kind === 'folder' ? selection.id : null
  const folderSessions = selection ? sessions.forFolder(itemKey) : []
  const focusedId = selection ? sessions.focusedIdFor(itemKey) : null

  // The header (`session-wait-indicator`): the item's name, the workspace summary, the side panel controls.
  const headerRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLSpanElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const headerName = focusedFolder ? focusedFolder.name : selection ? t('rail.globalName') : t('stage.noRepo')

  // **「讀」那半：panelFolder。** side panel 呈現 rail 上選中之項目的側欄座標所指的 repo
  // （`side-panel-source`）—— **與有沒有 session 無關**。座標未曾改動時（`sourceFolderId` 省略）
  // 即為該 folder 自身；來源指向的 folder 已被移除時（`find` 找不到）同樣退回自身 —— 持久化的
  // 座標不保證重開後仍然有效，那是 spec 明文要求的降級。
  const coordinate = panel.coordinateOf(selection)
  const panelFolder =
    (coordinate.sourceFolderId
      ? folders.find((candidate) => candidate.id === coordinate.sourceFolderId)
      : null) ?? focusedFolder

  // 換側欄來源（切 rail focus 或改 panelSource 皆會改變 panelFolder）就把待處理的跨身分請求丟掉
  // —— 它是**上一個側欄來源**的座標。少了這步，切到新來源時側欄會停在「顯示某個 spec」的視圖，
  // 而那個 spec 屬於前一個 repo（側欄兩個面板都以 panelFolder.id 為 key 重新掛載，於是又把舊請求
  // 當成初始值套用了一次）。
  const [seenPanelFolder, setSeenPanelFolder] = useState<string | null>(panelFolder?.id ?? null)
  if ((panelFolder?.id ?? null) !== seenPanelFolder) {
    setSeenPanelFolder(panelFolder?.id ?? null)
    setFileRequest(null)
    setOpenSpecRequest(null)
  }

  /*
    **來源未選定時 OpenSpec 身分可用**（design D11）。此前這裡是 `panelFolder?.hasOpenSpec ?? false`
    —— 全域項目沒有 panelFolder ⇒ 恆為 false ⇒ 身分被停用並強制退回 Files，而 Files 在同一個
    狀態下也是空的，於是側欄整塊沒有任何入口，使用者無從得知「選一個 repo 就有了」。

    停用的條件因此收窄為「**來源已選定，且**該 repo 不含 `openspec/`」—— 那是該 repo 的性質；
    而「還沒選」是一個尚未作出的選擇，它要呈現的正是引導使用者去選的空狀態。
  */
  const openSpecEnabled = panelFolder ? panelFolder.hasOpenSpec : true
  // 側欄來源若沒有 openspec/，OpenSpec 身分不可用 —— 由衍生值退回 Files，
  // 而不是用一個 effect 去改狀態（那會多渲染一次，且順序難以推理）。
  const activeIdentity: PanelIdentity =
    identity === 'openspec' && !openSpecEnabled ? 'files' : identity

  // 拖到最小寬度以下時 Panel 會自行收合，因此收合狀態以實際尺寸為準，不靠按鈕自行記帳
  const syncCollapsed = useCallback((size: { inPixels: number }) => {
    setCollapsed(size.inPixels === 0)
  }, [])

  const expandSidePanel = useCallback(() => {
    const panel = sidePanelRef.current
    if (panel?.isCollapsed()) panel.expand()
  }, [sidePanelRef])

  const toggleSidePanel = useCallback(() => {
    const panel = sidePanelRef.current
    if (!panel) return
    // Collapsing while maximized restores and collapses (`workspace-layout`).
    if (maximized) {
      dispatchMaximize({ type: 'restore' })
      panel.collapse()
      return
    }
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }, [sidePanelRef, maximized])

  /**
   * Maximize / restore. Maximizing a collapsed side panel expands it first, so restoring returns an
   * expanded panel at its previous width — the `Panel` remembers it (design M3).
   */
  const toggleMaximized = useCallback(() => {
    if (!maximized) expandSidePanel()
    dispatchMaximize({ type: 'toggle' })
  }, [maximized, expandSidePanel])

  const chooseViz = useCallback(
    (kind: VizKind) => {
      expandSidePanel()
      dispatchMaximize({ type: 'chooseViz', kind })
    },
    [expandSidePanel],
  )
  const leaveViz = useCallback(() => dispatchMaximize({ type: 'leaveViz' }), [])

  // Maximizing moves focus into the side panel, so no key lands in the covered terminal; restoring
  // hands it back through the terminal's (or the conversation view's) own uncover rule (design M2).
  useEffect(() => {
    if (!maximized) return
    const section = sidePanelSectionRef.current
    if (section && !section.contains(document.activeElement)) section.focus()
  }, [maximized])

  const selectIdentity = useCallback(
    (next: PanelIdentity) => {
      setIdentity(next)
      // 收合狀態下點任一身分，都該把面板帶回來（雛型的 togglePanel(true)）
      expandSidePanel()
    },
    [expandSidePanel],
  )

    /**
   * The displayed session — its rail item is selected and it is that item's focused session (the
   * `active` test below).
   *
   * **Displaying a dormant session no longer starts it** (`session-persistence`): the dormant screen
   * offers Wake. Before `session-hibernation` an effect here woke whatever became displayed, so any
   * `Ctrl+Tab` pass over a hibernated session started its process again.
   *
   * The main process is told which session is displayed: automatic hibernation never takes it.
   */
    const displayed = focusedId ? folderSessions.find((s) => s.id === focusedId) : undefined
  // The same test as a terminal's `active` below: without a selected item nothing is on screen.
  const displayedId = selection !== null ? (displayed?.id ?? null) : null
  useEffect(() => {
    window.workspace.terminal.displayed(displayedId)
  }, [displayedId])

  // 側欄「本 change」的候選集合：以 **panelFolder**（側欄來源）為準。解析規則本身在
  // `resolveAnchoredChange`（狀態列共用同一份）。
  const { data: panelChanges } = useChanges(panelFolder?.hasOpenSpec ? panelFolder.id : null)

  // 側欄來源的工作目錄清單 —— 跨身分導覽要靠它判定「這個檔案屬於哪個工作目錄」。
  //
  // **不以 `hasOpenSpec` gate**（design D12）：工作目錄選擇器必須對「有 worktree 但沒有
  // `openspec/`」的 repo 也出現，否則使用者無從分辨那是刻意的限制還是壞了。代價是那些 folder
  // 首次進入 Files 身分時走一次掃描 —— 已裁決接受（結果為 per-folder 快取，成本一次性）。
  const { data: panelWorktreeData } = useWorktrees(panelFolder?.id ?? null)
  const panelWorktrees = panelWorktreeData ?? EMPTY_WORKTREES

  // **gate 在 `selection`，不在 `focusedFolder`。** 後者對全域項目是 `null`，於是這顆按鈕會
  // 靜默地什麼都不做 —— 沒有錯誤、沒有訊息。編譯器對此完全無感（兩者都是合法的 falsy 判斷）。
  const createSession = useCallback(
    (spawnTarget: SpawnTarget) => {
      if (!selection) return
      setSessionError(null)
      void sessions.create(itemKey, spawnTarget).then((outcome) => {
        if (outcome.status === 'failed') setSessionError(outcome.failure.message)
      })
    },
    [selection, itemKey, sessions],
  )

  const focusSession = useCallback(
    (sessionId: string) => {
      if (!selection) return
      sessions.focus(itemKey, sessionId)
    },
    [selection, itemKey, sessions],
  )

  /**
   * 側欄「本 change」看的是哪個 change —— 明確的錨定（**須存在於掃描結果中**）、否則衍生預設、
   * 否則沒有。規則與其論證在 `resolveAnchoredChange`，**狀態列吃的是同一個函式**。
   *
   * `null` 是一個正常的狀態，不是錯誤：此時「本 change」視圖與它的入口一併不呈現
   *（`openspec-panel`），OpenSpec 身分停在瀏覽視圖。
   */
  const anchoredChange = resolveAnchoredChange(coordinate.anchoredChange, panelChanges)

  const anchorChange = useCallback(
    (slug: string) => {
      if (!selection) return
      panel.setAnchor(selection, slug)
    },
    [selection, panel],
  )

  /**
   * 續寫入口能不能用 —— 三個條件全部成立才行（`artifact-continuation` 的 spec）。
   *
   * 條件的順序就是回報原因的優先序：先看有沒有對象，再看它是不是對的對象。
   */
  const continuationBlock: ContinuationBlock | null = continuationBlockOf({
    displayed,
    panelFolderId: panelFolder?.id,
  })

  /**
   * 把續寫指示送進 focused session 的 pty 並執行（`sendInput` 一併把焦點交還終端）。
   *
   * **目標恆為 focused session** —— 也就是畫面上那個終端。同一個 repo 有多個 claude 在跑也不
   * 構成歧義：側欄呈現的 change 就是 focused session 錨定的那一個（錨定是 per-session 的），
   * 而那行字會出現在使用者正看著的終端裡，送給了誰**在視覺上是自明的**（design D3）。
   */
  const continueArtifacts = useCallback(() => {
    if (!focusedId || !anchoredChange || continuationBlock) return
    sessions.sendInput(focusedId, continuationCommand(anchoredChange))
  }, [focusedId, anchoredChange, continuationBlock, sessions])

  /**
   * 於當前呈現的 change 之來源工作目錄開一個 claude session，**並錨定該 change**。
   *
   * **錨定是承重的，不是順手**：新 session 成為 focused 之後，側欄呈現的 change 由它的錨定決定。
   * 不錨定的話會落入「尚無錨定」的空狀態（衍生預設只在該 repo 恰有一個 active change 時成立，
   * 而「一個 change 一個 worktree」的工作流下通常不只一個）—— 續寫入口連呈現的機會都沒有，
   * 使用者按了一顆按鈕卻看見側欄變空白。
   *
   * **只開 session，不送續寫指示**：兩件可各自失敗的事併成一次點擊時，使用者無從得知壞的是哪一件。
   */
  const openSessionInChangeWorktree = useCallback(
    (worktreeKey: string) => {
      if (!panelFolder || !anchoredChange) return
      setSessionError(null)
      // **錨定寫進 `panelFolder` 的座標，不是 focusedFolder 的。** 側欄來源即 focused folder 時
      // 那是同一筆（該 change 本來就已經是它的錨定，否則側欄不會正在呈現它），此舉等於不變；
      // 指向另一個 repo 時，使用者切 rail focus 過去讀到的正是 panelFolder 那一筆 —— 沒有這步，
      // 他會落入「尚無錨定」的空狀態，續寫入口連呈現的機會都沒有。
      //
      // 這是本 change 唯一的**跨項目寫入**，而它是正當的：使用者的動作本身就是關於那個 repo 的
      // （他剛在那裡開了一個 session 去做這個 change），不是一次無來由的繼承。
      panel.setAnchor(folderSelection(panelFolder.id), anchoredChange)
      void sessions.create(panelFolder.id, 'claude', { worktreeKey }).then((outcome) => {
        if (outcome.status === 'failed') setSessionError(outcome.failure.message)
      })
    },
    [panelFolder, anchoredChange, panel, sessions],
  )

  /**
   * 來源指示器選了一個 folder：設定 **rail 上選中之項目**的側欄來源。
   *
   * **不以「有沒有 session」為條件** —— 座標隸屬於 rail 的項目，而側欄是一個閱讀工具，不該
   * 需要先開一個 terminal 才能選要讀什麼（`side-panel-source`）。
   */
  const changePanelSource = useCallback(
    (folderId: string | null) => {
      if (!selection) return
      panel.setSource(selection, folderId)
    },
    [selection, panel],
  )

  /** 側欄的工作目錄：Files 身分以哪個工作目錄為樹根。省略＝ folder 自身。 */
  const panelWorktreeKey = coordinate.worktreeKey

  /**
   * 樹根前綴的解析 —— **上提至此**（design D1c）。
   *
   * 它原本住在 `SidePanel` 裡只於 Files 身分渲染的那個元件中，而 quick open 在 OpenSpec 身分
   * 之下也要能用。留在原處的話，這裡就得**再解析一次**，那正好違反「搜尋範圍與檔案樹的根
   * SHALL NOT 各自解析」。
   */
  const panelRootPrefix =
    panelWorktrees.find((option) => option.key === panelWorktreeKey)?.relPath ?? ROOT_PATH
  /** 選了工作目錄、而清單尚未抵達 —— 此時還不知道前綴。 */
  const panelRootPending = panelWorktreeKey !== undefined && panelWorktreeData === null

  /** 選擇器選了一個工作目錄。與側欄來源同理 —— 同樣不以 session 的存在為前提。 */
  const changePanelWorktree = useCallback(
    (worktreeKey: string | undefined) => {
      if (!selection) return
      panel.setWorktree(selection, worktreeKey)
    },
    [selection, panel],
  )

  /**
   * quick open 的觸發 —— 掛在側欄容器的 **capture 階段**。
   *
   * 「焦點在側欄之內」**就是**「按鍵事件行經這個容器」，那是 DOM 事件傳播的定義：不需要
   * `closest()`、不需要比對 `document.activeElement`（它與事件來源在焦點轉移的瞬間可能不一致）。
   *
   * **capture 而非 bubble**：Monaco 會攔下按鍵並停止傳播 —— 既有的存檔快捷鍵正是因此被迫註冊在
   * 編輯器內部。React 的 `onKeyDownCapture` 在 root container 的原生 capture 階段派發，早於任何
   * 掛在子節點上的 listener。
   *
   * **終端持有焦點時什麼都不必做**：xterm 的按鍵來自它自己的隱形 textarea，而終端與側欄是兩塊
   * 並列的 Panel、互不為祖先 —— 事件根本不會行經這裡。讓路是焦點模型的推論，不是一段程式碼。
   */
  const onSidePanelKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return
      if (event.key.toLowerCase() !== 'p') return

      // 有東西在等使用者裁決 —— **判準與作用域都與 `KeyboardNavigation` 相同（document-wide）**。
      // 收窄為「側欄之內」會漏掉全視窗 overlay：它 portal 到 body 卻**不移動焦點**，而開啟它的
      // 按鈕就在側欄裡，於是觸發條件恰好成立、入口會在 overlay 底下開起來。
      // 不 preventDefault —— 按鍵照常抵達那個對話框或選單。
      if (document.querySelector('[role="dialog"], [role="menu"]')) return

      // 沒有可搜的工作目錄。**判準是「有沒有可搜的工作目錄」，不是「rail 選了什麼」** ——
      // 全域項目只要把側欄來源指向某個 repo，入口就該正常運作。
      if (!panelFolder) return

      event.preventDefault()
      event.stopPropagation()
      setQuickOpen(true)
    },
    [panelFolder],
  )

  /**
   * OpenSpec → Files：切到 Files 身分並開啟該檔。
   *
   * **目標所屬的工作目錄一併切換**（`side-panel-worktree`）—— 否則會把使用者送到一棵不含該檔案
   * 的樹上，麵包屑與樹的內容自相矛盾。切換在**這裡**完成，不由 `FilesPanel` 收到請求後回呼：
   * 它是在渲染期間套用請求的，而渲染期間不得呼叫父層的 setState（與 `viewInOpenSpec` 對錨定的
   * 處理同一條理由）。
   *
   * 歸屬以**最長相符根**判定 —— 工作目錄的根可能互為前綴（例如 `…/wt` 與 `…/wt-a`），取第一個
   * 命中會把後者的檔案誤判為前者的。
   */
  const openFileFromOpenSpec = useCallback(
    (relPath: string) => {
      const owner = [...panelWorktrees]
        .filter((option) => option.relPath !== null && option.relPath !== '')
        .sort((a, b) => (b.relPath as string).length - (a.relPath as string).length)
        .find((option) => relPath.startsWith(`${option.relPath}/`))

      // **無條件切換，不再包在「有沒有 session」裡。** `side-panel-worktree` 的「自 OpenSpec
      // 跳往檔案時工作目錄一併切換」是一條無條件的 SHALL，而此處原本的 `if (focusedId)` 讓它
      // 在無 session 時完全沒有兌現 —— 零覆蓋，因為探針一律先建 session。
      if (selection) panel.setWorktree(selection, owner?.key)

      nonce.current += 1
      setFileRequest({ target: relPath, nonce: nonce.current })
      setIdentity('files')
      expandSidePanel()
    },
    [expandSidePanel, selection, panel, panelWorktrees],
  )

  /**
   * Files → OpenSpec：切到 OpenSpec 身分並呈現該 spec／change。
   *
   * change 的錨定在**這裡**完成，不由 `OpenSpecPanel` 收到請求後回呼 —— 它是在渲染期間套用
   * 請求的，而在渲染期間呼叫父層的 setState 是不允許的。
   */
  const viewInOpenSpec = useCallback(
    (target: OpenSpecTarget) => {
      nonce.current += 1
      setOpenSpecRequest({ target, nonce: nonce.current })
      setIdentity('openspec')
      // The user asked for this target — not for Graph (`openspec-panel`).
      dispatchMaximize({ type: 'leaveViz' })
      expandSidePanel()
      if (target.kind === 'change') anchorChange(target.slug)
    },
    [anchorChange, expandSidePanel],
  )

  return (
    <main aria-label={t('stage.label')} className="flex h-full flex-col bg-stage">
      <header
        ref={headerRef}
        className="relative flex items-center gap-3 border-b border-hairline px-4 py-2 text-base"
      >
        {/*
          全域項目沒有名稱與路徑可呈現 —— 但它**已經被選中了**，因此不得沿用「尚未選擇 repo」
          那句（那在叫使用者去做一件他剛做完的事）。

          **The name stays the header's first child** (probes read the header's first line) and keeps at least its
          first few characters; the path is on the rail row's tooltip (`session-wait-indicator`).
        */}
        <span ref={nameRef} className={`min-w-[8ch] truncate ${selection ? 'text-ink' : 'text-ink-faint'}`}>
          {headerName}
        </span>

        <SessionSummary
          folders={folders}
          focusedId={focusedId}
          headerRef={headerRef}
          nameRef={nameRef}
          controlsRef={controlsRef}
          name={headerName}
        />

        <span className="flex-1" />

        {/*
          Not `shrink-0`: in a narrow header their labels wrap rather than leave the header, as they did before the
          summary existed. The summary measures their natural width (`SessionSummary`), so it never takes the room
          they need on one line.
        */}
        <div ref={controlsRef} className="flex items-center gap-3">
        <PanelSwitch
          active={activeIdentity}
          openSpecEnabled={openSpecEnabled}
          onSelect={selectIdentity}
        />

        <button
          type="button"
          onClick={toggleSidePanel}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('stage.expandSidePanel') : t('stage.collapseSidePanel')}
          title={collapsed ? t('stage.expandSidePanel') : t('stage.collapseSidePanel')}
          className="rounded border border-hairline px-2 py-1 text-sm text-ink-dim hover:text-accent"
        >
          {`▤ ${collapsed ? t('common.expand') : t('common.collapse')}`}
        </button>

        {/*
          Maximize / restore (`workspace-layout`). Its label says what it will do; `Ctrl+Shift+M`
          finds it by either label (design M3).
        */}
        <button
          type="button"
          onClick={toggleMaximized}
          aria-pressed={maximized}
          aria-label={maximized ? t('stage.restoreSidePanel') : t('stage.maximizeSidePanel')}
          title={maximized ? t('stage.restoreSidePanel') : t('stage.maximizeSidePanel')}
          className="rounded border border-hairline px-2 py-1 text-sm text-ink-dim hover:text-accent"
        >
          {maximized ? `⤡ ${t('stage.restore')}` : `⤢ ${t('stage.maximize')}`}
        </button>
        </div>
      </header>

      {/*
        The area the maximized side panel covers: the session tab strip and the terminal. **`relative`
        only while maximized** — always on, it would shrink the tab strip's own rename dialog to this
        area (design M1).
      */}
      <div className={`flex min-h-0 flex-1 flex-col ${maximized ? 'relative' : ''}`}>

      {/* 分頁列只屬於當前選中的 rail 項目（mockup 的 .session-tabs）—— 全域項目也有它自己的。 */}
      {selection && (
        <SessionTabs
          sessions={folderSessions}
          focusedId={focusedId}
          onFocus={focusSession}
          onClose={sessions.close}
          onCreate={createSession}
          onRename={sessions.rename}
          onReorder={(fromIndex, toIndex) => sessions.reorder(itemKey, fromIndex, toIndex)}
          view={preferences.agentView}
          onSetView={(view) => {
            // A refused write leaves the view as it was; the console keeps the cause.
            preferences.updateAgentView(view).catch((error: unknown) => {
              console.error(`[preferences] setAgentView failed: ${String(error)}`)
            })
          }}
          error={sessionError}
        />
      )}

      <Group orientation="horizontal" className="flex-1">
        {/*
          **Clip, do not scroll** (the library's default for a panel is `overflow: auto`). While the
          terminal is covered it has no GPU renderer, and the DOM renderer lays the same columns out
          wider (9.63px vs 9px per cell); with `auto` the column then shows scrollbars, its box
          shrinks by their width, and the resize observer sends the pty a smaller size — a reflow
          caused by nothing the user did (`workspace-layout`: maximizing SHALL NOT resize it).
        */}
        <Panel minSize="240px" style={{ overflow: 'hidden' }}>
          <section aria-label={t('stage.terminal')} className="relative h-full bg-shell">
            {/*
              **掛載所有 folder 的所有 session**，只讓當前 folder 的 focused 那一個顯示。
              若只掛載當前 folder 的，切走再切回時 xterm 實例已被卸載，scrollback 就沒了
              （design D7）。

              **掛載順序刻意與「顯示順序」脫鉤**（以 id 穩定排序）。終端是疊在一起的、只有
              focused 的那個可見，DOM 的先後本來就沒有意義；但若讓它跟著拖曳排序走，React 會
              用 insertBefore **搬動 xterm 的 DOM 節點**，而 xterm 一旦被移動，畫面就會空掉
              （直到有新輸出或 resize 才重繪）—— 實測：拖曳後點回某個 session 是一片空白，
              隨便打個字才冒出來。
            */}
            {[...sessions.all()]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((session) => (
                                <TerminalView
                  // The generation is part of the key: a hibernated session's view remounts and so
                  // takes the restore path (`session-hibernation` design D1).
                  key={`${session.id}:${session.generation ?? 0}`}
                  sessionId={session.id}
                  spawnTarget={session.spawnTarget}
                  status={session.status}
                  wakeError={session.wakeError}
                  /*
                    **以歸屬鍵比較，不是 `session.folderId === focusedFolder?.id`。** 後者對全域
                    session 是 `null === undefined` ⇒ 恆為 false ⇒ 它的終端永遠不是 active，
                    而依「休眠的 session 於首次被顯示時才啟動 pty」，那等於**休眠的全域 session
                    永遠不會被喚醒** —— 畫面上只是一片空白，沒有任何錯誤。編譯器攔不到這一行
                    （`string | null` 與 `string | undefined` 的 `===` 合法），是 grep 找到的。
                  */
                  active={
                    selection !== null && session.folderId === itemKey && session.id === focusedId
                  }
                  /*
                    **對話 view 在上層時終端仍然 active** —— `active` 決定的是「有沒有版面盒子」，
                    而 `terminal-sessions` 的尺寸同步正是以此為判準，並明文禁止在沒有盒子時推導
                    尺寸。少了它，pty 會停在那個從未被量測過的初始值，agent 以錯誤的寬度輸出，
                    **而那些輸出一旦印出就永久留在終端歷史裡** —— 使用者切回終端才看得到，
                    屆時已無法補救。
                    `covered` 另外表達「使用者看不看得見」，那是渲染資源與焦點的判準。
                  */
                  covered={
                    maximized ||
                    (session.id === focusedId && sessionViewOf(session, preferences.agentView) === 'conversation')
                  }
                />
              ))}

            {/*
              對話 view 是終端 host 的**兄弟節點，不是後代**。兩個理由都在 `TerminalView` 的
              註解裡記著：(a) `.xterm` 由 effect 掛上去，排在 React children 之後 ⇒ 依 tree order
              會蓋在它上面；(b) host 上有 capture 階段的滑鼠接管（中鍵貼上進 pty、右鍵開終端的
              選單），在它之下的元素會拿到錯的行為。
            */}
            {folderSessions
              .filter((session) => session.id === focusedId && sessionViewOf(session, preferences.agentView) === 'conversation')
              .map((session) => (
                <div key={session.id} className="absolute inset-0 z-10 bg-shell">
                  <ConversationView
                    sessionId={session.id}
                    active
                    dormant={session.status === 'dormant'}
                    covered={maximized}
                  />
                </div>
              ))}

            {!focusedId && (
              <div className="flex h-full items-center justify-center text-sm text-ink-faint">
                {selection ? t('stage.noSession') : t('stage.noRepo')}
              </div>
            )}
          </section>
        </Panel>

        <Separator className="w-[3px] cursor-col-resize bg-hairline transition-colors hover:bg-accent" />

        <Panel
          collapsible
          collapsedSize={0}
          minSize="240px"
          defaultSize="34%"
          panelRef={sidePanelRef}
          onResize={syncCollapsed}
        >
          {/* 視覺分界由 Separator 提供；此處若再加 border-l，收合後會殘留一條 1px 的線 */}
          <section
            ref={sidePanelSectionRef}
            // 可程式聚焦、不進 Tab 序 —— quick open 關閉時焦點的退路（見 sidePanelSectionRef）。
            tabIndex={-1}
            aria-label={t('openspec.sidePanel')}
            /*
              Maximized: the same element, in the same place in the tree, covers the tab strip and
              the terminal — nothing is remounted and the terminal keeps its size (design M1).
              `z-[15]`: above the conversation view (`z-10`), below the rail's rename dialog
              (`z-20`), which shares this stacking context and comes earlier in the DOM.
            */
            className={`overflow-hidden bg-panel outline-none ${
              maximized ? 'absolute inset-0 z-[15]' : 'h-full'
            }`}
            onKeyDownCapture={onSidePanelKeyDown}
          >
            <SidePanel
              identity={activeIdentity}
              folder={panelFolder}
              folders={folders}
              sourceOwnerId={focusedFolder?.id ?? null}
              itemSelected={selection !== null}
              onSelectSource={changePanelSource}
              anchoredChange={anchoredChange}
              onAnchor={anchorChange}
              continuationBlock={continuationBlock}
              sessionWorktreeKey={displayed?.worktreeKey}
              panelWorktreeKey={panelWorktreeKey}
              onSelectWorktree={changePanelWorktree}
              worktrees={panelWorktrees}
              rootPrefix={panelRootPrefix}
              rootPending={panelRootPending}
              onContinue={continueArtifacts}
              onOpenSessionHere={openSessionInChangeWorktree}
              onOpenFile={openFileFromOpenSpec}
              onViewInOpenSpec={viewInOpenSpec}
              fileRequest={fileRequest}
              openSpecRequest={openSpecRequest}
              viz={maximize.viz}
              onChooseViz={chooseViz}
              onLeaveViz={leaveViz}
            />
          </section>
        </Panel>
      </Group>
      </div>

      {quickOpen && panelFolder && (
        <QuickOpen
          folderId={panelFolder.id}
          rootPrefix={panelRootPrefix}
          fallbackFocus={sidePanelSectionRef}
          onOpen={(relPath) => {
            setQuickOpen(false)
            openFileFromOpenSpec(relPath)
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}

    </main>
  )
}
