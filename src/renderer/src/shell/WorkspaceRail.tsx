import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ContextMenu, type MenuItem } from './files/dialogs'
import { SessionNameDialog } from './terminal/SessionNameDialog'
import { StateDot, StatusDot, rowStateOf, rowStateWords, sessionLabel, sessionTitle, statusTitle } from './terminal/session-badge'
import { useAttention } from './terminal/wait'
import { mostUrgent } from '@shared/wait/attention'
import { type SessionState, useSessions } from './terminal/sessions'
import { LineageMarkers, useLineage } from './terminal/lineage'
import { useCompletedAmong, useLifecycle } from './terminal/lifecycle'
import { type Forest, ROOT, blockOf, buildForest, moveBlock } from './session-forest'
import { dividerRowOf, folderIndexToRow, placeFromRow, rowToFolderIndex } from './rail-rows'
import { useDragReorder } from './useDragReorder'
import { useScrollIntoView } from './useScrollIntoView'
import { useSpawnMenu } from './terminal/useSpawnMenu'
import { type RailSelection, type SpawnTarget, type WorkspaceFolder, selectedFolderId } from './types'

interface WorkspaceRailProps {
  folders: WorkspaceFolder[]
  /** rail 上選中的項目。`null` ＝ 尚未選中任何項目（與「選中全域項目」互斥可辨，design D8）。 */
  selection: RailSelection | null
  onSelect: (id: string) => void
  /** 選中那個不隸屬任何 folder 的全域項目（`global-session`）。 */
  onSelectGlobal: () => void
  onAdd: () => void
  onRemove: (id: string) => void
  /**
   * 把某個 folder 移到清單的第 `toIndex` 個位置，並一併指定它移動後的置頂狀態。
   * **以 id 指定，不以位置**（design D5）；`pinned` **必填** —— 每一次移動都可能跨越分界。
   */
  onReorder: (id: string, toIndex: number, pinned: boolean) => void
  /** 切換置頂狀態；位置由它推導（跨越分界的最小移動）。 */
  onSetPinned: (id: string, pinned: boolean) => void
}

// `cursor-pointer` 不是多餘的：瀏覽器的 UA 樣式給 `button` 一條 `cursor: default`，而 Tailwind v4
// 的 preflight **不再**把它改回 `pointer`（v3 會）—— 於是按鈕會蓋掉外層那一列設的 `cursor-pointer`，
// 滑鼠停在 ＋／✕ 上看到的是箭頭，儘管它們就在一列食指之中。
//
// **Shown on hover and on keyboard focus, never on a click's focus.** Clicking a row focuses it; reading
// focus-within would keep its controls up after every click. `:focus-visible` is the keyboard's focus.
const REVEAL_CLASS = 'opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100'
const ICON_BUTTON_CLASS = `shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-sm ${REVEAL_CLASS}`

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className="h-4 w-4 shrink-0 text-ink-faint"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

/** 全域項目的圖示 —— 與資料夾明顯區隔（它不是一個 repo）。 */
function GlobeIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className="h-4 w-4 shrink-0 text-ink-faint"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
    </svg>
  )
}

/**
 * 圖釘。置頂時實心、未置頂時空心 —— 它同時是狀態指示與入口，兩種角色要一眼分得出來。
 */
function PinIcon({ filled }: { filled: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M9 4h6l-1 5 3 3v2h-5v5l-1 2-1-2v-5H5v-2l3-3-1-5z" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * rail 上一列所需的一切 —— **刻意不是 `WorkspaceFolder`**。
 *
 * rail 的項目集合不再等於 workspace 的 folder 清單（`global-session` 加了一個不隸屬任何 folder
 * 的固定項目），因此這一列吃的是「呈現一列需要什麼」，而不是「一個 folder 是什麼」。session
 * 子列、拖曳排序、右鍵選單與命名對話框於是**兩種項目完全共用**，不必抄第二份。
 */
interface RailItemView {
  /** session 的歸屬鍵：folder 識別碼，或 `null`（全域項目）。 */
  folderId: string | null
  name: string
  /** 標題列的 tooltip：folder 是它的路徑，全域項目是一句說明。 */
  title: string
  /** 副標（分支／警示）。全域項目沒有 —— 它沒有 repo 可讀。 */
  subtitle?: string
  /** 可否於其上建立 session（folder 路徑失效時為 false）。 */
  available: boolean
  /** 有值 ⇒ 呈現「路徑失效」徽章。全域項目恆無。 */
  missingPath?: string
  icon: React.JSX.Element
  /** 置頂狀態。決定圖釘是實心還是空心，也決定它恆常呈現還是只在 hover 呈現。 */
  pinned: boolean
  /**
   * 置頂狀態不可切換（全域項目）。圖釘改為**停用**：它仍然傳達狀態，但明確宣告自己動不了。
   *
   * 這與 `workspace-layout`「rail SHALL NOT 呈現不可操作的控制項」不衝突 —— 那條針對的是
   * 「長得像可按、按下去什麼都不發生、且不傳達任何狀態」的元素（rail 曾有的那顆 `◈`）。
   */
  pinLocked?: boolean
}

/** 每一層縮排的寬度（rem）。與基準的 `pl-9`（2.25rem）同一個單位。 */
const INDENT_STEP_REM = 0.875

/**
 * rail 上的一組兄弟 session（同一個母節點之下，或頂層），**各自持有一份拖曳**（`handoff-lineage`
 * design D4）。
 *
 * `useDragReorder` 的 `count`／`rectOf` 在按下之前就固定了，而「要在哪一組兄弟之間移動」只有按下
 * 哪一列才知道 —— 每組一個實例，那兩個值在按下之前就已確定。子節點的那一組渲染在母節點的
 * `<li>` 之內、列的 `<div>` 之外，於是在子列按下不會同時啟動母節點那一組的拖曳。
 *
 * **命中判定量的是「節點連同子孫」整塊**（比照 folder 列量整個區塊）—— 那是使用者眼中它佔的
 * 地盤；而整塊移動會把插入點差一格的偏移放大成整塊的長度（見 `session-forest.ts`）。
 */
function SessionGroup({
  ids,
  depth,
  forest,
  byId,
  focusedSessionId,
  onStage,
  rowRefs,
  onSelectSession,
  onCloseSession,
  onContextMenu,
  onMove,
}: {
  ids: readonly string[]
  depth: number
  forest: Forest
  byId: ReadonlyMap<string, SessionState>
  focusedSessionId: string | null
  /**
   * 這一組所屬的 rail 項目是否為選中的那一個。每個項目都各自記著一個 focused session，
   * 但**只有選中項目的那一個正顯示在主畫面上** —— 兩者的呈現必須分得開，否則畫面上同時有
   * 好幾列看起來「被選中」。
   */
  onStage: boolean
  /** 以 ref 物件傳入 —— 渲染期間不讀它，只在 ref callback 與命中判定裡讀。 */
  rowRefs: React.RefObject<Map<string, HTMLDivElement>>
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onContextMenu: (session: SessionState, x: number, y: number) => void
  onMove: (siblings: readonly string[], from: number, to: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { attentionOf } = useAttention()

  const rectOf = useCallback(
    (index: number): DOMRect | null => {
      const rects = blockOf(forest, ids[index])
        .map((id) => rowRefs.current.get(id)?.getBoundingClientRect())
        .filter((rect): rect is DOMRect => rect !== undefined)
      if (rects.length === 0) return null
      const top = Math.min(...rects.map((rect) => rect.top))
      const bottom = Math.max(...rects.map((rect) => rect.bottom))
      const left = Math.min(...rects.map((rect) => rect.left))
      const right = Math.max(...rects.map((rect) => rect.right))
      return new DOMRect(left, top, right - left, bottom - top)
    },
    [forest, ids, rowRefs],
  )

  const reorder = useDragReorder(ids.length, 'vertical', rectOf, (from, to) => onMove(ids, from, to))

  return (
    <>
      {ids.map((id, index) => {
        const session = byId.get(id)
        if (!session) return null
        const isFocused = session.id === focusedSessionId
        const label = sessionLabel(session)
        const full = sessionTitle(session)
        const attention = attentionOf(session.id)
        const dragging = reorder.drag?.fromIndex === index
        const children = forest.childrenOf.get(id) ?? []
        const displayDepth = Math.min(depth, 3)

        return (
          <li
            key={session.id}
            className={
              // 插入指示畫在**整塊**上（它的 `<li>` 含子孫），因為命中判定也是整塊。
              (reorder.isDropTarget(index) ? 'border-t-2 border-t-accent ' : '') +
              (reorder.dropAtEnd && index === ids.length - 1 ? 'border-b-2 border-b-accent ' : '') +
              (dragging ? 'opacity-40 ' : '')
            }
          >
            <div
              ref={(el) => {
                if (el) rowRefs.current.set(session.id, el)
                else rowRefs.current.delete(session.id)
              }}
              role="button"
              tabIndex={0}
              onMouseDown={(event) => reorder.onMouseDown(index, event)}
              onClick={() => onSelectSession(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectSession(session.id)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onContextMenu(session, event.clientX, event.clientY)
              }}
              title={`${full} — ${statusTitle(session, attention)}`}
              style={{ paddingLeft: `${2.25 + displayDepth * INDENT_STEP_REM}rem` }}
              className={
                // 縮排造出樹狀層次（mockup 的 .ws-session-row）；交接的子 session 再往內縮一層。
                // select-none：拖曳時不該把標籤的文字反白選起來（實測體感很差）。
                // `group/session` 掛在**列**上而不是 `<li>`：`<li>` 含子孫的列，掛在那裡的話
                // 滑過子列時母節點的 ✕ 也會一起浮現。
                'group/session flex items-center gap-2 py-1.5 pr-1 text-xs select-none ' +
                // 靜止時 pointer：點一下會切換 focused session —— 那才是主要的可供性
                // （design D8）。拖曳中的 grabbing 由 `body[data-dragging]` 全域覆蓋。
                'cursor-pointer ' +
                // 主畫面正在顯示的那一列：琥珀邊條＋亮灰底＋粗體。**底色必須比 hover 亮** ——
                // 反過來的話，滑過的那一列看起來比選中的更像被選中（雛型的 `--bg-2` 與 rail
                // 背景幾乎同色，就是這樣）。邊條用 inset shadow 而不是 border，才不會推動縮排。
                // 其他項目記住的 focused session 只提亮文字、不加底：它不在主畫面上。
                (isFocused && onStage
                  ? 'bg-hover text-ink font-semibold shadow-[inset_2px_0_0_var(--color-accent)]'
                  : isFocused
                    ? 'text-ink font-semibold hover:bg-hover/60'
                    : 'text-ink-dim hover:bg-hover/60')
              }
            >
              <StatusDot session={session} attention={attention} />
              <span className="min-w-0 flex-1 truncate font-mono">{label}</span>

              <LineageMarkers session={session} />

              <button
                type="button"
                aria-label={t('sessions.closeSession', { label })}
                title={t('sessions.closeSession', { label: full })}
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseSession(session.id)
                }}
                className="shrink-0 cursor-pointer rounded px-1 text-ink-faint opacity-0 group-hover/session:opacity-100 group-has-[:focus-visible]/session:opacity-100 hover:text-danger"
              >
                ✕
              </button>
            </div>

            {children.length > 0 && (
              <ul>
                <SessionGroup
                  ids={children}
                  depth={depth + 1}
                  forest={forest}
                  byId={byId}
                  focusedSessionId={focusedSessionId}
                  onStage={onStage}
                  rowRefs={rowRefs}
                  onSelectSession={onSelectSession}
                  onCloseSession={onCloseSession}
                  onContextMenu={onContextMenu}
                  onMove={onMove}
                />
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}

function RailRow({
  item,
  selected,
  sessions,
  focusedSessionId,
  expanded,
  onToggle,
  onSelect,
  onSelectSession,
  onCloseSession,
  onCreateSession,
  onRenameSession,
  onSetSessionOrder,
  onRemove,
  onTogglePin,
  blockRef,
  headerRef,
  onDragStart,
  dropTarget,
  dropAtEnd,
  dragged,
}: {
  item: RailItemView
  selected: boolean
  sessions: SessionState[]
  focusedSessionId: string | null
  expanded: boolean
  onToggle: () => void
  onSelect: () => void
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onCreateSession: (spawnTarget: SpawnTarget) => void
  onRenameSession: (sessionId: string, name: string) => void
  /**
   * 以新的次序取代這個項目的 session 順序。rail 上的拖曳是**兄弟之間、帶子孫的整塊移動**
   * （`session-forest`），一次只能移一個項目的 `reorder` 表達不出來。
   */
  onSetSessionOrder: (ids: string[]) => void
  /** 全域項目不可移除 —— 它不是 workspace 的成員（`global-session`）。 */
  onRemove?: () => void
  /** 切換置頂。全域項目不傳（它的置頂狀態不可取消）。 */
  onTogglePin?: () => void
  /** 整個 repo 區塊（含展開的 session 子列）—— repo 拖曳的命中判定以它為準（design D6）。 */
  blockRef?: (element: HTMLLIElement | null) => void
  /**
   * **標題列**的元素 —— 「捲入可視範圍」以它為目標，不以整個區塊。
   *
   * 區塊含展開的 session 子列，一個展開了數個 session 的 repo 可能比捲動容器**還高**，而
   * `scrollIntoView({ block: 'nearest' })` 對「已與 scrollport 相交但更高」的元素**不捲動**
   * —— 判準（目標完整落在容器內）於是永遠為假，與實作對錯無關。
   */
  headerRef?: (element: HTMLDivElement | null) => void
  /**
   * 掛在**標題列**上，不掛在整塊上：否則於 session 子列按下會同時啟動兩個拖曳（design D6）。
   * 全域項目不可拖曳排序，因此它不傳這個。
   */
  onDragStart?: (event: React.MouseEvent) => void
  dropTarget: boolean
  /** 指示線畫在這一列**之後**（此刻放開會落到 rail 的最後一格）。只有最後一列會拿到 true。 */
  dropAtEnd: boolean
  dragged: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { attentionOf } = useAttention()
  // The item's most urgent session state (`session-wait-indicator`): a collapsed item still says that something
  // inside it needs the user. No session, no dot.
  const urgent = mostUrgent(sessions.map((session) => rowStateOf(session, attentionOf(session.id))))
  // 每個 folder 各持有自己的選單狀態 —— rail 上有很多列，共用一份會錨錯位置。
  const spawn = useSpawnMenu(onCreateSession)
    const [menu, setMenu] = useState<{ x: number; y: number; session: SessionState } | null>(null)
  const { hibernate } = useSessions()
  // folder 標題列自己的右鍵選單 —— 與 session 子列那一份分開：兩者的項目不同，共用一份狀態會
  // 讓「在標題列按右鍵」跳出 session 的選單。
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<SessionState | null>(null)
  /**
   * 子列的元素，**鍵為 session 識別碼**，不是序位 —— 樹狀呈現之後，畫面上的列序與單一順序中的
   * 序位不同，以序位為鍵的話捲動與命中判定會指向別的列。
   */
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const lineage = useLineage()

  /**
   * 這個項目的樹（`session-forest`）。母節點必須**存在且屬於這個項目** —— 不存在的來源、別的
   * 項目的來源，子 session 一律以頂層呈現，它的來源由標示表達。
   */
  const forest = buildForest(
    sessions.map((session) => ({ id: session.id, parentId: session.lineage?.parentId })),
    new Set(sessions.filter((session) => lineage.exists(session)).map((session) => session.id)),
  )
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const order = sessions.map((session) => session.id)
  const moveSiblings = (siblings: readonly string[], from: number, to: number): void => {
    const next = moveBlock(order, forest, siblings, from, to)
    if (next.some((id, index) => id !== order[index])) onSetSessionOrder(next)
  }

  /**
   * 這一列被選中時，把它的 focused session 子列捲進可視範圍。
   *
   * **同一顆 `Ctrl+Tab` 要捲兩個容器**：分頁列（橫向，在 `SessionTabs`）與 rail（縱向，這裡）
   * —— 一個展開了數個 session 的 repo，其子列很容易落在 rail 的視野之外。
   *
   * 只在 `selected` 時捲：否則切換選中的 repo 時，**每一列**都會搶著把自己的 focused 子列
   * 捲進視野，最後一個贏 —— 畫面會跳到一個使用者沒有選的地方。
   *
   * 以指標直接點這一塊裡的東西時不捲（guard 掛在 `<li>` 上）—— 但在**分頁列**點一個分頁
   * 時仍會捲，那是另一個容器，使用者還沒看到這裡的子列。
   *
   * **key 是「焦點 ＋ 位置」，索引在此算完、不進 key 以外的任何地方。** 它曾經是一個依賴著
   * 整個 `sessions` 陣列的 effect —— 而該陣列來自 `forFolder()` 的 `filter()`，每次渲染都是新
   * 身分，於是觸發條件實際上是「這個元件重繪了」：背景中運作的 agent 每改一次終端標題就把
   * 使用者手動捲到的位置搶回來一次。
   */
  const focusedIndex = forest.rows.findIndex((row) => row.id === focusedSessionId)
  const rowGuard = useScrollIntoView(
    selected && focusedSessionId !== null && focusedIndex !== -1
      ? `${focusedSessionId}:${focusedIndex}`
      : null,
    () => (focusedSessionId === null ? undefined : rowRefs.current.get(focusedSessionId)),
    'block',
  )

  const items: MenuItem[] = menu
    ? [
        {
          label: t('sessions.rename'),
          onSelect: () => {
            setRenaming(menu.session)
            setMenu(null)
          },
        },
                // Offered only while the session has a process (`session-hibernation`).
        ...(menu.session.status === 'running'
          ? [
              {
                label: t('sessions.hibernate'),
                onSelect: () => {
                  hibernate(menu.session.id)
                  setMenu(null)
                },
              },
            ]
          : []),
        {
          label: t('sessions.close'),
          tone: 'danger',
          onSelect: () => {
            onCloseSession(menu.session.id)
            setMenu(null)
          },
        },
      ]
    : []

  /**
   * 第二個 pin 入口。**全域項目不提供這個選單** —— 它既不可移除、置頂狀態也不可切換，一個只有
   * 停用項目的選單正是 `workspace-layout` 禁止的那種東西。
   */
  const folderMenuItems: MenuItem[] = folderMenu
    ? [
        ...(onTogglePin
          ? [
              {
                label: item.pinned ? t('rail.unpinAction') : t('rail.pinAction'),
                onSelect: () => {
                  onTogglePin()
                  setFolderMenu(null)
                },
              },
            ]
          : []),
        ...(onRemove
          ? [
              {
                label: t('rail.removeAction'),
                tone: 'danger' as const,
                onSelect: () => {
                  onRemove()
                  setFolderMenu(null)
                },
              },
            ]
          : []),
      ]
    : []

  // Pinned (or locked) is a state and stays in the row; unpinned it is one of the hover controls.
  const pinShown = item.pinLocked === true || item.pinned
  const pinButton = (
          <button
            type="button"
            disabled={item.pinLocked === true}
            aria-disabled={item.pinLocked === true ? 'true' : undefined}
            aria-label={
              item.pinLocked === true
                ? t('rail.globalPinned', { name: item.name })
                : item.pinned
                  ? t('rail.unpinFolder', { name: item.name })
                  : t('rail.pinFolder', { name: item.name })
            }
            title={
              item.pinLocked === true
                ? t('rail.globalPinnedTooltip')
                : item.pinned
                  ? t('rail.unpinTooltip')
                  : t('rail.pinTooltip')
            }
            onClick={(event) => {
              event.stopPropagation()
              onTogglePin?.()
            }}
            className={
              'shrink-0 rounded px-1.5 py-0.5 ' +
              (item.pinLocked === true
                ? // 停用：置灰、游標不是 pointer、恆常呈現（它傳達的是狀態，不是一個入口）。
                  'cursor-default text-ink-faint opacity-40 '
                : item.pinned
                  ? 'cursor-pointer text-accent hover:text-ink '
                  : `cursor-pointer text-ink-faint ${REVEAL_CLASS} hover:text-accent `)
            }
          >
            <PinIcon filled={item.pinned} />
          </button>
  )

  return (
    <li
      ref={blockRef}
      {...rowGuard}
      className={
        'group ' +
        // 插入指示：拖到這裡放開，就會插在它前面。畫在**整塊**上，因為命中判定也是整塊。
        (dropTarget ? 'border-t-2 border-t-accent ' : '') +
        // 插到最後一格 —— 少了它，「拖到 rail 最下面」這個落點沒有任何指示線。
        (dropAtEnd ? 'border-b-2 border-b-accent ' : '') +
        (dragged ? 'opacity-40 ' : '')
      }
    >
      <div
        ref={headerRef}
        role="button"
        tabIndex={0}
        /*
          **標題列一律有 `aria-label`，值為項目的名稱。**

          此前這一列只有 `title`（folder 的路徑）—— 螢幕閱讀器讀到的是一長串路徑，而不是使用者
          用來辨識它的名字。全域項目更是完全沒有可定位的標籤，而 `aria-label` 在這個 repo 裡
          **同時是探針的選擇器**（`probe:workspace` 以「移除按鈕」識別 folder 列，全域項目沒有
          那顆按鈕，於是它在探針眼中根本不存在）。
        */
        aria-label={item.name}
        /*
          **選中狀態要有一個可辨識的屬性，不能只靠 class。**

          它首先是無障礙的正確標記（rail 是一組互斥的選項，螢幕閱讀器要知道哪一個是當前的）；
          而它同時修掉一個**假綠**：探針此前以 `className.includes('bg-hover')` 判斷選中，而
          未選中的列帶著 `hover:bg-hover/60` —— **那個字串也包含 `bg-hover`**，於是判準恆回
          第一列。以它為期望值的斷言（「循環回全域項目」）因此不論實作對錯都通過。
        */
        aria-current={selected ? 'true' : undefined}
        onMouseDown={onDragStart}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') onSelect()
        }}
        // 右鍵不會啟動拖曳 —— `useDragReorder.onMouseDown` 已濾掉非左鍵。
        onContextMenu={
          !onTogglePin && !onRemove
            ? undefined
            : (event) => {
                event.preventDefault()
                event.stopPropagation()
                setFolderMenu({ x: event.clientX, y: event.clientY })
              }
        }
        title={urgent ? `${item.title} — ${t('rail.mostUrgent', { state: rowStateWords(urgent) })}` : item.title}
        className={
          // select-none：拖曳時不該把名稱與分支反白選起來。
          'group/row relative flex items-center gap-2 px-3 py-2 text-base select-none ' +
          // 靜止時是 pointer（食指）—— 這一列**點一下是有作用的**（選中這個 repo），而那是
          // 使用者在它身上最常做的事；拖曳是偶爾為之。游標宣告主要的可供性（design D8）。
          // 拖曳中的 grabbing 由 `index.css` 的 `body[data-dragging]` 全域覆蓋（它必須蓋過
          // 這裡的 pointer 與按鈕的 UA `default`，否則游標會在拖曳途中閃爍）。
          'cursor-pointer ' +
          (selected ? 'bg-hover text-ink' : 'text-ink-dim hover:bg-hover/60')
        }
      >
        {sessions.length > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t('rail.collapseSessions', { name: item.name })
                : t('rail.expandSessions', { name: item.name })
            }
            title={expanded ? t('rail.collapseTooltip') : t('rail.expandTooltip')}
            onClick={(event) => {
              // 展開／收合不該順手改變選中的 repo。
              event.stopPropagation()
              onToggle()
            }}
            className="-my-1 w-4 shrink-0 cursor-pointer py-1 text-2xs text-ink-faint hover:text-ink"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}

        {item.icon}

        <div className="min-w-0 flex-1">
          {/*
            名稱是使用者用來辨識 repo 的東西，必須是這一列視覺權重最高的元素。它一度是
            normal weight + 未選中時暗灰，於是雖然字級比副標大，卻被副標平分了注意力 ——
            字重與顏色比 px 更能解決「不夠突出」。
          */}
          <div className={`truncate font-bold ${selected ? 'text-accent' : 'text-ink'}`}>
            {item.name}
          </div>
          {item.subtitle && (
            <div className="truncate font-mono text-xs text-ink-faint">{item.subtitle}</div>
          )}
        </div>

        {sessions.length > 0 && (
          <span
            title={t('rail.sessionCount', { count: sessions.length })}
            className="shrink-0 rounded bg-hover px-1 text-2xs text-ink-faint"
          >
            {sessions.length}
          </span>
        )}

        {/* After the count, as the mockup places it; its words are in the row's title. */}
        {urgent && <StateDot state={urgent} />}

        {item.missingPath !== undefined && (
          <span
            title={t('rail.missingTooltip', { path: item.missingPath })}
            className="shrink-0 rounded border border-danger/40 px-1 text-2xs text-danger"
          >
            {t('rail.missingBadge')}
          </span>
        )}

        {/*
          圖釘。**可見性依它當下扮演的角色**：置頂時它是狀態指示（恆常呈現），未置頂時它只是
          一個入口（與 ＋／✕ 同族，hover 才出現）。因此不能直接沿用 `ICON_BUTTON_CLASS`
          —— 那個 class 帶著 `opacity-0`。
        */}
        {/*
          A pinned row keeps its pin in view, at the row's end (inside the controls below). This invisible
          copy holds that place so the name and the count stop before it.
        */}
        {pinShown ? (
          <span aria-hidden="true" className="invisible shrink-0 px-1.5 py-0.5">
            <PinIcon filled />
          </span>
        ) : null}

        {/*
          The hover controls float over the row's right end instead of taking width: invisible controls that
          kept their place left the name a few characters wide ("api-…" in a 250px rail). Their backing is
          the row's own background, so what they cover (the count, the state dot) is hidden while they show.
        */}
        <span className="absolute inset-y-0 right-3 flex items-center group-hover/row:bg-inherit group-has-[:focus-visible]/row:bg-inherit">

        {/* 在 rail 上看得到 session，就該能在原地開一個 —— 不必先切到主舞台。 */}
        <button
          type="button"
          disabled={!item.available}
          aria-label={t('rail.newSessionIn', { name: item.name })}
          title={item.available ? t('sessions.new') : t('rail.newSessionDisabled')}
          onClick={spawn.open}
          className={`${ICON_BUTTON_CLASS} ${
            item.available ? 'text-ink-faint hover:text-accent' : 'text-ink-faint opacity-40'
          }`}
        >
          ＋
        </button>

        {/*
          這裡曾有一顆 `◈`。它的 onClick 裡**只有 stopPropagation()** —— 一顆長得像按鈕、
          按下去卻什麼都不發生的指示燈，會反覆消耗使用者的注意力去確認它是不是壞了。而且
          OpenSpec 身分的**真入口**是主舞台 header 的 PanelSwitch（那裡本來就有一個 ◈），
          雛型的 rail 裡從來沒有這顆。已移除 —— rail 不呈現不可操作的控制項。
        */}
        {onRemove && (
          <button
            type="button"
            aria-label={t('rail.removeFolder', { name: item.name })}
            title={t('rail.removeFolderTooltip', { name: item.name })}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
            className={`${ICON_BUTTON_CLASS} text-ink-faint hover:text-danger`}
          >
            ✕
          </button>
        )}
        {pinButton}
        </span>
      </div>

      {expanded && sessions.length > 0 && (
        <ul aria-label={t('rail.folderSessions', { name: item.name })} className="pb-1">
          <SessionGroup
            ids={forest.childrenOf.get(ROOT) ?? []}
            depth={0}
            forest={forest}
            byId={byId}
            focusedSessionId={focusedSessionId}
            onStage={selected}
            rowRefs={rowRefs}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
            onContextMenu={(session, x, y) => setMenu({ x, y, session })}
            onMove={moveSiblings}
          />
        </ul>
      )}

      {spawn.menu}
      {folderMenu && folderMenuItems.length > 0 && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems}
          onClose={() => setFolderMenu(null)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {renaming && (
        <SessionNameDialog
          initialValue={sessionTitle(renaming)}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => {
            onRenameSession(renaming.id, name)
            setRenaming(null)
          }}
        />
      )}
    </li>
  )
}

export function WorkspaceRail({
  folders,
  selection,
  onSelect,
  onSelectGlobal,
  onAdd,
  onRemove,
  onReorder,
  onSetPinned,
}: WorkspaceRailProps): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessions()
  // 預設展開；記錄的是「被收合的」，因此新出現的 folder 自然是展開的。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string | null>>(() => new Set())
  /**
   * 每個 rail 項目的**標題列**元素，鍵為它的歸屬（`null` ＝ 全域項目）。
   *
   * 與 `blockRefs` 是兩份：那一份鍵為 folder 的**索引**、指向整個區塊，供拖曳的命中判定使用；
   * 這一份供「捲入可視範圍」使用，兩者的目標與座標系都不同（見 `RailRow.headerRef`）。
   */
  const headerRefs = useRef(new Map<string | null, HTMLDivElement>())

  /**
   * 拖曳命中判定的**列**（不是 folder）—— 鍵是**列索引**：
   * `0…pinnedCount-1` 是置頂的 folder、`pinnedCount` 是分界、其後是未置頂的 folder。
   *
   * 全域項目不進來（`global-session`：它不可拖曳、也不作為落點）。
   */
  const rowRefs = useRef(new Map<number, HTMLElement>())

  /** 分界所在的列索引。它同時是「置頂段的最後一格」與「其餘段的第一格」之間那個落點。 */
  const dividerRow = dividerRowOf(folders)

  /**
   * **量整個 `<li>`**（含展開的 session 子列），不是標題列 —— 那是使用者眼中「這個 repo 佔的
   * 地盤」，插入點以它判定才跟手（design D6）。
   *
   * **回傳的是該列與其所屬捲動容器可視區的交集，完全被裁掉時回 `null`。**
   * `useDragReorder.insertAtFor` 依 **DOM 順序**掃描並比中線 —— 那只在「DOM 順序 ＝ 螢幕上的
   * 垂直順序」時成立。rail 有兩個獨立裁切的區域：置頂段一旦內部捲動，被裁掉的置頂列其**未裁切**
   * 的 rect 會落在其餘段**下方**，於是游標停在一個看得見的未置頂列上、掃描卻先命中一個看不見的
   * 置頂列 —— 症狀是**一個使用者根本沒碰過的 repo 被移動並置頂**。取交集之後，看不見的列回
   * `null`（`insertAtFor` 對它 `continue`），可見的列仍依螢幕順序排列。
   */
  const folderRectOf = useCallback((row: number) => {
    const element = rowRefs.current.get(row)
    if (!element) return null

    const rect = element.getBoundingClientRect()
    const clip = element.closest('ul')?.getBoundingClientRect()
    if (!clip) return rect

    const top = Math.max(rect.top, clip.top)
    const bottom = Math.min(rect.bottom, clip.bottom)
    if (bottom <= top) return null
    return new DOMRect(rect.x, top, rect.width, bottom - top)
  }, [])

  /**
   * 列空間的落點 → `(folderIndex, pinned)`。
   *
   * 分界是一個**真正的落點列**，於是「置頂段的最後一格」與「其餘段的第一格」各自到得了，而
   * 「有沒有移動」的判定留在列空間裡 —— 一次**只改變置頂狀態、序位不變**的拖曳（把置頂段最後
   * 一個拖到分界之下）在列空間裡確實移動了一列，`useDragReorder` 既有的提交閘門因此放行。
   *
   * 抽成純函式是為了讓它**可單元測試** —— 這個 repo 已在同一族的索引換算上栽過三次。
   */
  const commitFolderOrder = useCallback(
    (fromRow: number, toRow: number) => {
      const moved = folders[rowToFolderIndex(fromRow, dividerRow)]
      if (!moved) return
      const { folderIndex, pinned } = placeFromRow(fromRow, toRow, dividerRow)
      onReorder(moved.id, folderIndex, pinned)
    },
    [folders, dividerRow, onReorder],
  )

  const folderReorder = useDragReorder(
    // 列數 ＝ folder 數 ＋ 分界那一列。
    folders.length + 1,
    'vertical',
    folderRectOf,
    commitFolderOrder,
  )

  const toggle = useCallback((folderId: string | null) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  /**
   * 選中的項目改變時，把它捲進可視範圍。
   *
   * **在 effect 裡做，不在事件處理器裡** —— 順序改變（`Shift+↑↓`）之後元素的位置隨之改變，
   * 於同一輪更新中量測會得到舊位置。而副作用**絕不可寫進 `setState` 的 updater**：StrictMode
   * 會 double-invoke 它（這個 repo 為此付過一次「拖曳完全沒反應、且只有 dev 模式壞」的學費）。
   *
   * `block: 'nearest'` 讓「已完整可見就不捲動」成立，但**它不涵蓋滑鼠** —— 部分可見的元素
   * 它照樣會捲。以指標直接操作時的例外由 `useScrollIntoView` 承擔（guard 掛在 `<aside>` 上）。
   *
   * **key 取的是選取的「值」，不是 `selection` 物件的身分** —— `folderSelection()` 每次呼叫都
   * 造一個新物件，以身分為觸發時「把選取重設成同一個值」也會捲，而 `keyboard-navigation` 明載
   * 選取未改變時 SHALL NOT 捲動。
   *
   * **而序位是承重的**：`Shift+↑↓` 移動選中的 folder 時，`selection` 一個位元都沒變 —— 少了
   * 序位，這條 requirement 表格裡「`Shift+↑↓` → 選中的 rail 項目」那一列就靜默失效（它此前是
   * 靠 `RailRow` 那個「重繪就捲」的缺陷順帶成立的）。全域項目恆為第一列、不參與排序，序位取
   * `-1`。
   */
  const selectedKey = selection === null ? null : selection.kind === 'global' ? null : selection.id
  const selectedRailIndex =
    selection === null || selection.kind === 'global'
      ? -1
      : folders.findIndex((folder) => folder.id === selection.id)
  const railGuard = useScrollIntoView(
    selection === null ? null : `${selectedKey ?? 'global'}:${selectedRailIndex}`,
    () => headerRefs.current.get(selectedKey),
    'block',
  )

  /** 選中一個 rail 項目 —— `null` ＝ 全域項目。兩種歸屬共用一個入口，呼叫端不必各自分岔。 */
  const selectItem = useCallback(
    (folderId: string | null) => {
      if (folderId === null) onSelectGlobal()
      else onSelect(folderId)
    },
    [onSelect, onSelectGlobal],
  )

  // 點 session 子列＝選中它所屬的項目，並把它設為該項目的 focused session。
  const selectSession = useCallback(
    (folderId: string | null, sessionId: string) => {
      selectItem(folderId)
      sessions.focus(folderId, sessionId)
    },
    [selectItem, sessions],
  )

  // 自 rail 建立 session：必然要看到它，因此也選中該項目（create 內部會聚焦新 session）。
  const createSession = useCallback(
    (folderId: string | null, spawnTarget: SpawnTarget) => {
      selectItem(folderId)
      void sessions.create(folderId, spawnTarget)
    },
    [selectItem, sessions],
  )

  /** 一列 folder 的完整接線 —— 兩段共用，差別只在它的列索引與置頂狀態。 */
  const renderFolder = (folder: WorkspaceFolder, folderIndex: number): React.JSX.Element => {
    const row = folderIndexToRow(folderIndex, dividerRow)
    return (
      <RailRow
        key={folder.id}
        blockRef={(element) => {
          if (element) rowRefs.current.set(row, element)
          else if (rowRefs.current.get(row) === element) rowRefs.current.delete(row)
        }}
        headerRef={(element) => {
          if (element) headerRefs.current.set(folder.id, element)
          else headerRefs.current.delete(folder.id)
        }}
        /*
          **每一個與拖曳有關的索引都是「列」，不是 folder 序位。** 混用的具體後果：沒有任何
          folder 被置頂時分界是第 0 列，於是把第一個 folder 拖到它自己的下半部會算出
          `commitIndex(0, 2) = 1 ≠ 0` —— 畫出一條幽靈指示線，並送出一次會被 store 吞掉的提交。
          而既有的探針只斷言「順序不變」，那是綠的。
        */
        onDragStart={(event) => folderReorder.onMouseDown(row, event)}
        dropTarget={folderReorder.isDropTarget(row)}
        dropAtEnd={folderReorder.dropAtEnd && row === folders.length}
        dragged={folderReorder.drag?.fromIndex === row}
        item={{
          folderId: folder.id,
          name: folder.name,
          title: folder.path,
          /*
            副標只說**非常態**的事。「含有 `openspec/`」是常態 —— 每一列都喊一次的訊息
            不傳達任何資訊，只是噪音。因此有 openspec 時它沉默，只在**缺少**時附註；
            分支則是常時呈現的事實。
          */
          subtitle:
            folder.status === 'missing'
              ? t('rail.pathMissing')
              : [folder.branch, folder.hasOpenSpec ? null : t('rail.noOpenspec')]
                  .filter(Boolean)
                  .join(' · '),
          available: folder.status === 'ok',
          missingPath: folder.status === 'missing' ? folder.path : undefined,
          icon: <FolderIcon />,
          pinned: folder.pinned,
        }}
        selected={folder.id === selectedFolderId(selection)}
        sessions={sessions.forFolder(folder.id)}
        focusedSessionId={sessions.focusedIdFor(folder.id)}
        expanded={!collapsed.has(folder.id)}
        onToggle={() => toggle(folder.id)}
        onSelect={() => onSelect(folder.id)}
        onSelectSession={(sessionId) => selectSession(folder.id, sessionId)}
        onCloseSession={sessions.close}
        onCreateSession={(spawnTarget) => createSession(folder.id, spawnTarget)}
        onRenameSession={sessions.rename}
        onSetSessionOrder={(ids) => sessions.setOrder(folder.id, ids)}
        onRemove={() => onRemove(folder.id)}
        onTogglePin={() => onSetPinned(folder.id, !folder.pinned)}
      />
    )
  }

  return (
    <aside
      aria-label={t('rail.label')}
      className="flex h-full min-w-0 flex-col overflow-hidden border-r border-hairline bg-rail"
      {...railGuard}
    >
      {/*
        標題不會自己截斷，於是它會撐住 rail 的 min-content —— 拖到最小寬度時就溢出到分界之外。

        **`shrink-0` 是承重的，不是保險。** 它與底部的加入入口同為 `<aside>` 的 flex item、
        收縮因子同為 1，於是負的剩餘空間會分給**三個**項目而不只是置頂段；而 `truncate`
        （`overflow: hidden`）讓它的自動最小尺寸變成 0 —— 實測置頂段一長，它會從 35px 被壓到
        22px，**標題文字直接被裁掉**。
      */}
      <h2 className="shrink-0 truncate px-3 pt-3 pb-2 text-xs tracking-widest text-ink-faint">
        {t('rail.heading')}
      </h2>

      {/* 收掉所有已完成的交接 session（`handoff-completion`）—— 只在有已完成者時出現，先開確認對話框。 */}
      <CloseCompletedEntry />

      {/*
        **置頂段位於捲動容器之外**（不是 `position: sticky`）。等價於 sticky 的視覺效果，但
        遮擋問題**從結構上消失** —— 捲動容器的視口從這一段的下緣才開始，容器內的元素不可能被它
        蓋住，`scrollIntoView` 因此沒有東西要避讓（design D2／D4）。

        `min-h-0 overflow-y-auto`：極端情況下（置頂很多、或全域項目展開了十幾個 session）它自己
        內部捲動，內容不會變成不可達。
      */}
      <ul
        aria-label={t('rail.pinnedList')}
        className="min-h-0 shrink overflow-y-auto"
      >
        {/*
          全域項目恆為置頂段的第一列，且**不進 `rowRefs`、不接 `onDragStart`** —— 它不是
          workspace 的成員，既不可被拖曳，也不作為別人的落點（`global-session`）。它的圖釘是
          **停用**的：傳達「置頂，而且動不了」這個狀態，而不是一顆按下去沒反應的按鈕。
        */}
        <RailRow
          item={{
            folderId: null,
            name: t('rail.globalName'),
            title: t('rail.globalTooltip'),
            available: true,
            icon: <GlobeIcon />,
            pinned: true,
            pinLocked: true,
          }}
          selected={selection?.kind === 'global'}
          sessions={sessions.forFolder(null)}
          focusedSessionId={sessions.focusedIdFor(null)}
          expanded={!collapsed.has(null)}
          onToggle={() => toggle(null)}
          headerRef={(element) => {
            if (element) headerRefs.current.set(null, element)
            else headerRefs.current.delete(null)
          }}
          onSelect={onSelectGlobal}
          onSelectSession={(sessionId) => selectSession(null, sessionId)}
          onCloseSession={sessions.close}
          onCreateSession={(spawnTarget) => createSession(null, spawnTarget)}
          onRenameSession={sessions.rename}
          onSetSessionOrder={(ids) => sessions.setOrder(null, ids)}
          dropTarget={false}
          dropAtEnd={false}
          dragged={false}
        />

        {folders.filter((folder) => folder.pinned).map(renderFolder)}
      </ul>

      {/*
        兩段之間的分界。**它是兩個 `<ul>` 的 sibling，不在置頂段之內** —— 放在段內它會是該段的
        最後一個子節點，於是該段一內部捲動它就第一個離開視野，而它同時是「拖過這條線就改變置頂
        狀態」的目標。放在這裡它不屬於任何捲動容器，因此於任何捲動位置都在。

        它也是一個**真正的落點列**（列索引 = 置頂數）：分界的兩側各自是一個到得了的落點，
        「置頂段的最後一格」與「其餘段的第一格」才都拖得到。
      */}
      <div
        aria-hidden="true"
        ref={(element) => {
          if (element) rowRefs.current.set(dividerRow, element)
          else if (rowRefs.current.get(dividerRow) === element) rowRefs.current.delete(dividerRow)
        }}
        className="relative mx-3 my-1 shrink-0 border-t border-hairline"
      >
        {/*
          落在分界**之上** ⇒ 置頂段的最後一格。

          **指示線不能直接畫在分界的 border 上** —— 那會蓋掉分界本身（同一個 CSS 屬性），於是
          使用者只看到一條線，無從判斷它是分界還是落點；而另一個落點（其餘段的第一格）畫出來的
          線就在幾個像素之外，長得一模一樣。分界必須留著當參照物，指示線疊在它**上方**，
          兩個落點才讀得出「上面那一段」與「下面那一段」的差別。
        */}
        {folderReorder.isDropTarget(dividerRow) && (
          <span className="absolute inset-x-0 -top-1.5 block h-0.5 rounded bg-accent" />
        )}

        {/*
          **落到列空間的最後一格，而最後一格是分界本身**（＝所有 folder 都被置頂時）。

          `dropAtEnd` 的指示線平常畫在最後一個 folder 之下 —— 但全部置頂時分界就是最後一列，
          沒有任何 folder 拿得到它，於是「拖到線下面來取消置頂」這個**當下唯一的** unpin 手勢
          會完全沒有指示線。探針抓到的就是這個。
        */}
        {folderReorder.dropAtEnd && dividerRow === folders.length && (
          <span className="absolute inset-x-0 -bottom-1.5 block h-0.5 rounded bg-accent" />
        )}
      </div>

      <ul
        aria-label={t('rail.folderList')}
        /*
          **`min-h-[6rem]` 不是留白，是「下半段必須還能用」的直接編碼。** 這一段是
          `flex: 1 1 0%`：它不會收縮，但也拿不到任何剩餘空間 —— 實測置頂段一長，它的
          `clientHeight` 直接變成 0。而那**不是「置頂太多」才會遇到的事**：全域項目恆為置頂段的
          成員，一個 repo 都沒置頂時，光是它展開十來個 session 就到得了。
        */
        className="min-h-[6rem] flex-1 overflow-y-auto"
      >
        {folders.length === 0 ? (
          <li className="px-3 py-6 text-sm text-ink-faint">{t('rail.empty')}</li>
        ) : (
          folders
            .map((folder, folderIndex) => ({ folder, folderIndex }))
            .filter(({ folder }) => !folder.pinned)
            .map(({ folder, folderIndex }) => renderFolder(folder, folderIndex))
        )}
      </ul>

      {/* `shrink-0` 與 `<h2>` 同一條理由 —— 見上面那段註解。 */}
      <button
        type="button"
        onClick={onAdd}
        className="m-2 shrink-0 cursor-pointer rounded border border-dashed border-hairline px-3 py-2 text-sm text-ink-dim hover:border-accent/40 hover:text-accent"
      >
        {t('rail.addFolder')}
      </button>
    </aside>
  )
}

/** rail 上「收掉已完成的交接 session」的全域入口。**沒有已完成者時不佔位。** */
function CloseCompletedEntry(): React.JSX.Element | null {
  const { t } = useTranslation()
  const sessions = useSessions()
  const lifecycle = useLifecycle()
  const completed = useCompletedAmong()(sessions.all())
  if (completed.length === 0) return null
  return (
    <button
      type="button"
      onClick={() => lifecycle.confirmClose(completed.map((session) => session.id))}
      className="mx-3 mb-2 shrink-0 cursor-pointer truncate rounded border border-hairline px-2 py-1 text-left text-2xs text-ink-faint hover:text-accent"
    >
      {t('handoffLifecycle.closeCompletedAll', { count: completed.length })}
    </button>
  )
}
