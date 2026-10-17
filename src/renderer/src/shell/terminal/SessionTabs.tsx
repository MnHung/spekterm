import { useCallback, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from '../files/dialogs'
import { LineageMarkers } from './lineage'
import { useHandoffBrief } from './HandoffBrief'
import type { SpawnTarget } from '../types'
import { SessionNameDialog } from './SessionNameDialog'
import { StatusDot, sessionLabel, sessionTitle, statusTitle } from './session-badge'
import { useAttention } from './wait'
import { type SessionState, useSessions } from './sessions'
import { useDragReorder } from '../useDragReorder'
import { useScrollIntoView } from '../useScrollIntoView'
import { useSpawnMenu } from './useSpawnMenu'
import { useTranslation } from 'react-i18next'
import { usePrefillState } from '../intake/prefill-state'

interface SessionTabsProps {
  sessions: SessionState[]
  focusedId: string | null
  onFocus: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onCreate: (spawnTarget: SpawnTarget) => void
  onRename: (sessionId: string, name: string) => void
  onReorder: (fromIndex: number, toIndex: number) => void
  /**
   * 當前的呈現方式。**這是全域偏好，不屬於任何一個 session**
   * （`agent-conversation-view`）—— 切一個，所有 agent session 一起改變。
   */
  view: 'terminal' | 'conversation'
  /** 切換呈現方式（終端 ↔ 對話）。作用域是全部的 agent session。 */
  onSetView: (view: 'terminal' | 'conversation') => void
  /** 建立失敗的訊息（folder 失效、pty 配置不出來等）。 */
  error: string | null
}

const NEW_BUTTON_CLASS =
  'shrink-0 self-center rounded border border-hairline px-2 py-1 text-xs text-ink-dim hover:border-accent/40 hover:text-accent'

export function SessionTabs({
  sessions,
  focusedId,
  onFocus,
  onClose,
  onCreate,
  onRename,
  onReorder,
  view,
  onSetView,
  error,
}: SessionTabsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { attentionOf } = useAttention()

  const spawn = useSpawnMenu(onCreate)
    const [menu, setMenu] = useState<{ x: number; y: number; session: SessionState } | null>(null)
  const { hibernate } = useSessions()
  const briefs = useHandoffBrief()
  const [renaming, setRenaming] = useState<SessionState | null>(null)
  const tabRefs = useRef(new Map<number, HTMLDivElement>())

  const rectOf = useCallback((index: number) => {
    return tabRefs.current.get(index)?.getBoundingClientRect() ?? null
  }, [])

  const reorder = useDragReorder(sessions.length, 'horizontal', rectOf, onReorder)

  /**
   * focused session 改變時，把它的分頁捲進**橫向**可視範圍。
   *
   * 分頁列是 `overflow-x-auto` —— session 開多了，`Ctrl+Tab` 會切到一個看不見的分頁上，而
   * 畫面上什麼都不會變（使用者只會判定快捷鍵壞了）。`'both'` 是橫向的那一半，少了它這個
   * 捲動對橫向完全無效。
   *
   * `nearest` 只讓「**完全**可見就不捲」成立；以滑鼠點一個**半截**的分頁時它仍會捲，於是
   * 那個分頁在游標底下跳走。該例外由 `useScrollIntoView` 承擔（guard 掛在分頁列上）——
   * 而在 rail 點一列 session 時**仍會捲**，那是另一個容器。
   *
   * **key 是「焦點 ＋ 位置」**：少了位置，`Shift+←→` 重排 focused session 時不會捲；而放進
   * 整個 `sessions` 陣列（它每次渲染都是新身分）則會讓觸發條件退化成「任何重繪」—— 那正是
   * 這裡此前的缺陷。
   */
  const focusedIndex = sessions.findIndex((session) => session.id === focusedId)
  const focused = focusedIndex === -1 ? null : sessions[focusedIndex]
  const tabsGuard = useScrollIntoView(
    focusedId !== null && focusedIndex !== -1 ? `${focusedId}:${focusedIndex}` : null,
    () => tabRefs.current.get(focusedIndex),
    'both',
  )

  const items: MenuItem[] = menu
    ? [
        // 交接單（`handoff-brief`）只在由交接建立的 session 上出現。
        ...(menu.session.lineage?.brief
          ? [
              {
                label: t('handoffBrief.open'),
                onSelect: () => {
                  briefs.open(menu.session.id)
                  setMenu(null)
                },
              },
            ]
          : []),
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
            onClose(menu.session.id)
            setMenu(null)
          },
        },
      ]
    : []

  if (sessions.length === 0) {
    return (
      <div className="flex items-center gap-3 border-b border-hairline bg-panel px-3 py-2">
        <span className="text-sm text-ink-faint">{t('sessions.empty')}</span>
        <button
          type="button"
          onClick={spawn.open}
          aria-label={t('sessions.new')}
          className={NEW_BUTTON_CLASS}
        >
          +
        </button>
        {error && <span className="truncate text-xs text-danger">{error}</span>}
        {spawn.menu}
      </div>
    )
  }

  return (
    <div className="flex items-stretch border-b border-hairline bg-panel" {...tabsGuard}>
      {/*
        `tablist` 不佔 flex-1 —— 否則它會把建立入口一路推到分頁列的另一端，開第二個分頁之後
        滑鼠得橫越整條列才點得到。剩餘空間交給後面的 spacer 吸收。
      */}
      <div
        role="tablist"
        aria-label={t('sessions.tabs')}
        className="flex min-w-0 items-stretch overflow-x-auto"
      >
        {sessions.map((session, index) => {
          const selected = session.id === focusedId
          const label = sessionLabel(session)
          const full = sessionTitle(session)
          const dragging = reorder.drag?.fromIndex === index

          return (
            <div
              key={session.id}
              role="presentation"
              ref={(el) => {
                if (el) tabRefs.current.set(index, el)
                else tabRefs.current.delete(index)
              }}
              onMouseDown={(event) => reorder.onMouseDown(index, event)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, session })
              }}
              className={
                // select-none：拖曳時不該把分頁的文字反白選起來。
                'group flex shrink-0 items-center gap-1 border-b-2 pr-1 select-none ' +
                // 靜止時 pointer：分頁**點一下是有作用的**（切換 focused session），拖曳是偶爾
                // 為之 —— 游標宣告主要的可供性（design D8；VS Code 與瀏覽器的分頁亦然）。
                // 拖曳中的 grabbing 由 `index.css` 的 `body[data-dragging]` 全域覆蓋。
                'cursor-pointer ' +
                // 插入指示：拖到這個位置放開，就會插在它前面
                (reorder.isDropTarget(index) ? 'border-l-2 border-l-accent ' : '') +
                // 插到最後一格 —— 少了它，「拖到最右邊」這個落點沒有任何指示線
                (reorder.dropAtEnd && index === sessions.length - 1
                  ? 'border-r-2 border-r-accent '
                  : '') +
                (dragging ? 'opacity-40 ' : '') +
                (selected
                  ? 'border-accent bg-stage text-ink'
                  : 'border-transparent text-ink-dim hover:bg-hover')
              }
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                // 截斷的是呈現，不是資料 —— 完整標題在這裡拿得到。
                title={`${full} — ${statusTitle(session, attentionOf(session.id))}`}
                onClick={() => onFocus(session.id)}
                // **游標必須掛在按鈕自己身上，掛在外層 wrapper 上到不了這裡。**
                // `cursor` 雖然是可繼承的屬性，但瀏覽器的 UA 樣式給了 `button` 一條
                // `cursor: default` —— 而 Tailwind v4 的 preflight **不再**像 v3 那樣把它改回
                // `pointer`。於是外層設的 `cursor-pointer` 被它蓋掉，滑鼠停在分頁上看到的是箭頭
                // （實測：探針量到 `default`）。
                className="flex cursor-pointer items-center gap-2 py-2 pr-1 pl-3 text-sm"
              >
                <StatusDot session={session} attention={attentionOf(session.id)} />
                <span className="whitespace-nowrap font-mono">{label}</span>
                {session.status === 'exited' && (
                  <span className="text-2xs text-ink-faint">{t('sessions.exitedBadge')}</span>
                )}
                <PrefillBadge sessionId={session.id} />
              </button>

              {/* 在分頁按鈕之外 —— 按鈕不能巢狀，而標示有自己的動作（跳到母／子 session）。 */}
              <LineageMarkers session={session} />

              <button
                type="button"
                aria-label={t('sessions.closeSession', { label })}
                title={t('sessions.closeSession', { label: full })}
                onClick={() => onClose(session.id)}
                className="cursor-pointer rounded px-1 text-sm text-ink-faint opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 hover:text-danger"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={spawn.open}
        aria-label={t('sessions.new')}
        className={`${NEW_BUTTON_CLASS} mx-2`}
      >
        +
      </button>

      {/* 剩餘空間由它吸收，好讓建立入口留在分頁旁邊。 */}
      <span className="flex-1" />

      {/*
        呈現方式的切換。**只對 agent 目標呈現** —— shell session 沒有紀錄可跟，
        給它一顆按不出東西的按鈕比不給更糟。
      */}
      {focused?.spawnTarget === 'claude' && (
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-2 py-0.5 text-xs text-ink-faint transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:bg-hover focus-visible:text-ink focus-visible:ring-1 focus-visible:ring-accent"
          aria-label={
            view === 'conversation' ? t('conversation.showTerminal') : t('conversation.showConversation')
          }
          aria-pressed={view === 'conversation'}
          onClick={() => onSetView(view === 'conversation' ? 'terminal' : 'conversation')}
        >
          {view === 'conversation' ? t('stage.terminal') : t('conversation.label')}
        </button>
      )}

      {error && (
        <span className="max-w-[240px] self-center truncate px-2 text-xs text-danger">
          {error}
        </span>
      )}

      {spawn.menu}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
      {renaming && (
        <SessionNameDialog
          initialValue={sessionTitle(renaming)}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => {
            onRename(renaming.id, name)
            setRenaming(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * 「有一則尚未送出的 prompt」。
 *
 * 預填寫進的是 pty —— 終端 view 裡直接看得到，**對話 view 裡看不到**。
 * 少了這個標示，全域偏好是對話 view 的使用者接受一則 intake 之後會看到一個空的對話畫面、
 * 什麼提示都沒有：這條管線在他眼中就是「接受了卻什麼也沒發生」。
 */
function PrefillBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = usePrefillState(sessionId)
  if (!state) return null
  const text = state === 'timedOut' ? t('intake.prefillTimedOut') : t('intake.prefillPending')
  return (
    <span aria-label={text} title={text} className="text-2xs text-accent">
      ✎
    </span>
  )
}
