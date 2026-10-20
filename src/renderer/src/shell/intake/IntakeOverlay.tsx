import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { runAccept } from './accept-flow'
import { useTranslation } from 'react-i18next'

import { formatDateTime, relativeTime } from '@shared/i18n/locale'
import { isItemsTabItem, isProposal, isScheduled, isWaitingForUser } from '@shared/intake/scheduled'
import type { ApproveResult, IntakeView, RecurrenceListing, RecurrenceView } from '../../../../main/ipc/intake'
import { useSessions } from '../terminal/sessions'
import type { WorkspaceFolder } from '../types'
import { useNow } from '../useNow'
import { useWorkspaceFolders } from '../useWorkspaceFolders'
import { useIntake } from './intake-state'
import { preselectFolder, type Preselection } from './preselect-folder'
import { showTitleSeparately } from './title-redundancy'
import { RulesEditor } from './RulesEditor'
import { slackNeedsAttention, statusCopy } from '../settings/slack-status'
import type { SlackState } from '../types'

/**
 * 收件匣的全視窗 overlay。
 *
 * ## 形狀與對話計量同構，而那是刻意的
 *
 * 活動列入口 ＋ 全視窗 overlay。已排除的兩個替代方案：**側欄的第三個身分**（側欄的身分被
 * `workspace-layout` 定義為 OpenSpec 與 Files **兩個**互斥的身分，且它們的座標隸屬於當下選中的
 * folder，而收件匣的範圍是整個 workspace、其項目尚未歸屬於任何 folder）；
 * **Settings 對話框的一個區段**（Settings 是放旋鈕的地方，而收件匣是內容）。
 *
 * ## 本文以純文字呈現
 *
 * 這是這個 app **第一次把第三方逐字撰寫的文字渲染進自己的介面**。此前 Files 面板渲染的 markdown
 * 來自使用者自己的 repo、終端渲染的是 pty 輸出。
 *
 * 因此：**不套用任何標記語言的渲染、不載入遠端資源、不產生可點選的連結**。
 * CSP 的 `img-src` 放行 `https:`，其既有理由是「markdown 本就該能載入遠端圖片，而使用者本就在
 * 這些 repo 裡跑 agent」—— **對一則陌生人推來的 intake，那個前提整條不成立**：
 * 一個遠端圖片會讓投遞者在使用者只是掃一眼收件匣的那一刻拿到回條。
 *
 * （不可列印字元與雙向覆寫的移除發生在**攝入**，不在這裡 —— 在呈現層做會讓交付的那一份與它
 * 不同，而「交給 agent 的內容逐字元等於呈現給使用者的內容」就在建構上不成立。）
 *
 * ## 接受的流程
 *
 * 主行程的 `accept` 只回一個**指示**（在哪個 folder 建立），建立本身走 renderer 既有的
 * `create` 路徑 —— session 清單的權威在 renderer，主行程自行建立的 session 會在 500ms 後被
 * 抹掉，**而 pty 還活著**。建好之後以 `attach` 回報，主行程才寫 context 檔並排定預填。
 *
 * **folder 由使用者在卡片上確認**（intake-inbox-usability）：routing 只決定預先選定哪一個，
 * 按下接受時送出去的是卡片上被選定的那一個，主行程查表驗證、缺了就拒絕。
 */

/** 改選的鍵。**不用 NUL 當分隔符** —— 見 CLAUDE.md「原始碼裡一個字面的 NUL」。 */
function itemKey(item: IntakeView): string {
  return `${item.adapter} ${item.id}`
}

/** The overlay's tabs. `schedules` holds everything planned (`recurring-handoff`, design D6). */
export type IntakeTab = 'inbox' | 'schedules' | 'rules'
type Tab = IntakeTab

export interface IntakeOverlayProps {
  onClose: () => void
  /** 開啟它的那個元素 —— 關閉時把焦點還回去。 */
  opener: HTMLElement | null
  /** The tab to open on: Settings' Integrations hint opens the routing rules. */
  initialTab?: Tab
  /** Closes the inbox and opens Settings on Integrations (the Slack line). */
  onOpenSlackSettings: () => void
}

export function IntakeOverlay({
  onClose,
  opener,
  initialTab = 'inbox',
  onOpenSlackSettings,
}: IntakeOverlayProps): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessions()
  // **folder 的名字住在 renderer。** 主行程的投影刻意只給識別碼（送路徑會破壞邊界語彙），
  // 而「Opens in <uuid>」對使用者不構成資訊 —— 那個字串要回答的是「它會開在我的哪個 repo」。
  const { folders } = useWorkspaceFolders()
  // 拒絕痕跡仍以相對時間呈現（「這件事還在發生嗎」），它會過期 —— 每分鐘重算一次。
  const now = useNow()
  /**
   * 使用者在這次打開收件匣之後的改選 —— **住在 overlay，不在卡片**。
   *
   * 卡片在切到 Rules 分頁時會卸載，而規則只能在那個分頁改：放在卡片裡的話，使用者先改選、
   * 再去改規則、切回來，他的改選就不見了 —— 「規則的變動不覆蓋使用者的選擇」在真實操作中
   * 必然不成立。overlay 關閉時它隨之消失；那是「選擇不落盤」的直接後果。
   */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string>>(() => new Map())
  const choose = useCallback((key: string, folderId: string) => {
    setOverrides((current) => new Map(current).set(key, folderId))
  }, [])
  // **快照來自常駐的 provider，不是這裡自己拉的。** 兩份的話，計數與內容可以無聲分岔
  // （見 `intake-state.tsx` 的檔頭）。`reload` 仍然保留 —— 主行程那幾條路徑都有推送，
  // 但顯式的重新拉取是第二條防線。
  const { snapshot, refresh: reload } = useIntake()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [failure, setFailure] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // 使用者打開了收件匣 —— 通知上界的重置點。**掛載時一次**，不隨重繪。
  useEffect(() => {
    window.workspace.intake.opened()
  }, [])

  const close = useCallback(() => {
    onClose()
    if (opener?.isConnected) opener.focus()
  }, [onClose, opener])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close])

  /**
   * 初始焦點 —— **掛載時的一次性動作，因此依賴陣列是空的**。
   *
   * 併進上面那個 effect 的話它會跟著 `close` 走，而 `close` 跟著父層每次渲染重建的 `onClose`
   * 走 ⇒ **父層每重繪一次，焦點就被搶回關閉鈕一次**。活動列一旦訂閱收件匣狀態（計數），
   * 儲存一次 routing 規則就會觸發它 —— 使用者正在編輯的欄位當場失去焦點。
   * 「掛載」不是「改變」。
   */
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const accept = useCallback(
    async (item: IntakeView, folderId: string) => {
      setFailure(null)
      // The desktop's accept, shared with a paired device (`accept-flow.ts`): reuse the session an earlier
      // accept left in this folder, else create one, then attach.
      const outcome = await runAccept({ intake: window.workspace.intake, sessions }, item, folderId)
      if (outcome.ok) {
        close()
        return
      }
      setFailure(
        outcome.reason === 'createFailed'
          ? outcome.message
          : outcome.reason === 'prefillUnavailable'
            ? t('intake.prefillUnavailable')
            : // 主行程回 FOLDER_GONE 只剩一個成因：使用者確認的 folder 在按下接受之前被移除了。
              // 「這條規則指向的…」那句講的是規則，對這裡是錯的。
              outcome.reason === 'FOLDER_GONE'
              ? t('intake.chosenFolderGone')
              : outcome.reason === 'opening'
                ? t('intake.opening')
                : t('intake.unresolved'),
      )
    },
    [close, sessions, t],
  )

  /**
   * One named predicate per list (`src/shared/intake/scheduled.ts`): the items tab lists what waits for the user
   * now; the Schedules tab what is planned — proposals, then every scheduled handoff by time (one-off and
   * occurrences of recurrences). The header counts what the badge counts, proposals included, so the two numbers
   * the user sees agree.
   */
  const items = snapshot.items.filter(isItemsTabItem)
  const waitingCount = snapshot.items.filter(isWaitingForUser).length
  const proposals = snapshot.items.filter(isProposal)
  const scheduled = snapshot.items.filter(isScheduled).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
  const recurrences: RecurrenceListing = snapshot.recurrences ?? { available: true, recurrences: [] }
  const folderName = (id: string | undefined): string | undefined => folders.find((folder) => folder.id === id)?.name
  const liveSessions = sessions.all()
  const knownFolderIds = new Set(folders.map((folder) => folder.id))
  /**
   * 已經開好 session 的那些。
   *
   * **它們在收件匣裡沒有任何待辦動作，但不呈現它們是錯的** —— 到達即接受的交接
   * （`agent-handoff-source`）從不經過待處理：少了這一段，使用者看到一則通知、打開收件匣、
   * 什麼都沒有。既有的 requirement 早就要求「這個 session 從哪來」在收件匣中看得見，
   * 而那條此前沒有任何載體（`intake.fromSession` 這個字串在字典裡躺著沒人用）。
   *
   * **但它有離開的條件**（intake-inbox-usability）：這一段存在的理由是「按下送出之前看得到
   * 本文全文」。送出之後與使用者清除之後的，主行程已經不列（`settledAt`）；這裡再篩掉
   * **session 已不存在**、以及 **session 所在的 folder 已不在 workspace** 的 ——
   * 移除一個 folder 不會關閉它的 session（`folders:remove` 與 renderer 都不修剪），那樣的
   * session 沒有 rail 入口，呈現它只會讓這一則永遠留著。
   *
   * **folder 名取自它的 session，不取自主行程的解析結果**：接受時使用者可以改選 folder，
   * 規則也可能事後改變 —— 重算 routing 會把「Opened in」標錯。
   */
  const opened = snapshot.items.flatMap((item) => {
    if (item.state !== 'accepted' || !item.sessionId) return []
    const session = liveSessions.find((candidate) => candidate.id === item.sessionId)
    const folder = session ? folders.find((candidate) => candidate.id === session.folderId) : undefined
    return folder ? [{ item, folderName: folder.name }] : []
  })
  const notices = snapshot.notices

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('intake.label')}
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-stage"
    >
      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b border-hairline bg-stage px-4 py-2">
        <h2 className="text-sm font-bold text-ink">{t('intake.title')}</h2>
        <div role="tablist" aria-label={t('intake.label')} className="flex gap-1">
          {/*
            Each tab is named by a fixed dictionary label: the Schedules tab's visible text carries a count, and a
            selector built from visible text would stop finding it when the number changes.
          */}
          <button
            type="button"
            role="tab"
            aria-label={t('intake.title')}
            aria-selected={tab === 'inbox'}
            onClick={() => setTab('inbox')}
            className={tabClass(tab === 'inbox')}
          >
            {t('intake.title')}
          </button>
          <button
            type="button"
            role="tab"
            aria-label={t('intake.schedulesTab')}
            aria-selected={tab === 'schedules'}
            onClick={() => setTab('schedules')}
            className={tabClass(tab === 'schedules')}
          >
            {t('intake.schedulesTab')}
            {proposals.length > 0 ? (
              <span className="ml-1.5 rounded-full bg-accent/20 px-1.5 text-2xs text-accent">{proposals.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-label={t('intake.rules.label')}
            aria-selected={tab === 'rules'}
            onClick={() => setTab('rules')}
            className={tabClass(tab === 'rules')}
          >
            {t('intake.rules.label')}
          </button>
        </div>
        <span className="flex-1" />
        <span className="text-2xs text-ink-faint">
          {t('intake.pendingCount', { count: waitingCount })}
        </span>
        <button
          ref={closeRef}
          type="button"
          aria-label={t('intake.close')}
          onClick={close}
          className="rounded px-2 py-1 text-2xs text-ink-dim hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 px-4 py-3">
        {failure ? (
          <p className="mb-3 rounded border border-hairline bg-shell px-3 py-2 text-2xs text-ink">
            {failure}
          </p>
        ) : null}

        {/*
          **拒絕的呈現是彙整的，不是逐則一條訊息。** 投遞者控制投遞的數量，而使用者的注意力是
          這條管線僅有的兩道人類防線之一（另一道是讀本文）。
        */}
        {notices.length > 0 ? (
          <div className="mb-3 flex flex-col gap-1 rounded border border-hairline bg-shell px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-2xs text-ink">
                {t('intake.rejectedHeading', {
                  count: notices.reduce((total, notice) => total + notice.count, 0),
                })}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                aria-label={t('intake.dismissNotices')}
                onClick={() => void window.workspace.intake.dismissNotices().then(reload)}
                className="rounded px-2 py-0.5 text-2xs text-ink-dim hover:bg-hairline/40"
              >
                {t('intake.dismissNotices')}
              </button>
            </div>
            {/*
              **逐則，不是一個總數。**

              一個計數器回答不了「哪一則」「為什麼」「我要怎麼辦」中的任何一個 —— 而使用者
              對一則他自己交辦的工作正是要問這三件事。此前這裡只有那個總數，於是一則交接
              失敗與從未發生過的交接，在畫面上完全相同。

              **類別的說明文案（`intake.rejectReason`）本來就寫好了，只是沒有任何消費者。**
            */}
            <ul className="flex flex-col gap-0.5">
              {notices.map((notice) => (
                <li key={`${notice.key} ${notice.code}`} className="flex items-baseline gap-2">
                  <span className="text-2xs text-ink-dim">
                    {notice.overflow
                      ? t('intake.noticeOverflow')
                      : t(`intake.rejectReason.${notice.code}` as 'intake.rejectReason.MALFORMED')}
                  </span>
                  {notice.origin ? (
                    <span className="text-2xs text-ink-faint">
                      {t('intake.fromOrigin', { origin: notice.origin })}
                    </span>
                  ) : null}
                  {notice.target ? (
                    <span className="text-2xs text-ink-faint">
                      {t('intake.noticeTarget', { target: notice.target })}
                    </span>
                  ) : null}
                  {notice.count > 1 ? (
                    <span className="text-2xs text-ink-faint">
                      {t('intake.noticeRepeated', { count: notice.count })}
                    </span>
                  ) : null}
                  <span className="text-2xs text-ink-faint">{relativeTime(notice.at, now)}</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    aria-label={t('intake.dismissNotice')}
                    onClick={() =>
                      void window.workspace.intake.dismissNotice(notice.key, notice.code).then(reload)
                    }
                    className="rounded px-1 text-2xs text-ink-faint hover:bg-hairline/40"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <SlackLine onOpen={onOpenSlackSettings} />

        {tab === 'rules' ? (
          <RulesEditor />
        ) : tab === 'schedules' ? (
          <SchedulesTab
            proposals={proposals}
            scheduled={scheduled}
            recurrences={recurrences}
            folders={folders}
            folderName={folderName}
            selectionFor={(item) =>
              preselectFolder({
                override: overrides.get(itemKey(item)),
                // A proposal never had a session.
                existingSessionFolderId: undefined,
                resolvedFolderId: item.folderId,
                knownFolderIds,
              })
            }
            onChoose={(item, folderId) => choose(itemKey(item), folderId)}
            onChanged={reload}
          />
        ) : items.length === 0 && opened.length === 0 ? (
          <p className="text-2xs text-ink-faint">{t('intake.empty')}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <IntakeCard
                  key={itemKey(item)}
                  item={item}
                  folders={folders}
                  selection={preselectFolder({
                    override: overrides.get(itemKey(item)),
                    existingSessionFolderId: item.sessionId
                      ? liveSessions.find((session) => session.id === item.sessionId)?.folderId
                      : undefined,
                    resolvedFolderId: item.folderId,
                    knownFolderIds,
                  })}
                  onChoose={(folderId) => choose(itemKey(item), folderId)}
                  onAccept={accept}
                  onChanged={reload}
                />
              ))}
            </ul>
            {opened.length > 0 ? (
              <ul aria-label={t('intake.openedLabel')} className="mt-4 flex flex-col gap-1">
                {opened.map(({ item, folderName }) => (
                  <li
                    key={itemKey(item)}
                    aria-label={t('intake.openedItemLabel', { title: item.title })}
                    className="flex flex-col gap-1 rounded border border-hairline px-3 py-1.5"
                  >
                    {/* 第一列是從哪來、何時、開在哪；標題（若不與本文重複）在其下 —— 理由同待處理的卡片。 */}
                    <div className="flex items-baseline gap-2 whitespace-nowrap">
                      <span className="text-2xs text-ink-faint">
                        {t('intake.fromOrigin', { origin: item.originLabel })}
                      </span>
                      <OccurredAt at={item.occurredAt} />
                      <span className="flex-1" />
                      <span className="text-2xs text-ink-dim">{t('intake.fromSession', { name: folderName })}</span>
                      {/*
                        **逐則清除**：送出之後它會自己離開；這顆鈕給的是其餘的情形 —— 應用程式
                        重啟之後預填已經不在、或使用者決定不送了。它不刪紀錄也不碰 session。
                      */}
                      <button
                        type="button"
                        aria-label={t('intake.clearOpened')}
                        onClick={() => void window.workspace.intake.settle(item.id, item.adapter).then(reload)}
                        className="cursor-pointer rounded px-2 py-0.5 text-2xs text-ink-faint hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      >
                        {t('intake.clearOpened')}
                      </button>
                    </div>
                    {showTitleSeparately(item.title, item.body) ? (
                      <span className="break-words text-2xs text-ink">{item.title}</span>
                    ) : null}
                    {/*
                      **本文要看得見，而且要看得到全部。**

                      到達即接受的交接沒有經過接受閘 —— 於是「按下送出」是唯一的閘，而使用者
                      要能讀到他正要送出的是什麼。呈現方式與待處理項完全相同（純文字、不渲染
                      任何標記、不產生連結）：那條約束的作用域是**本文**，不是**狀態**。

                      **這裡是 first-party 本文唯一的呈現位置** —— 交接從不停留於待處理，
                      所以 `IntakeCard` 那一段永遠不會顯示它。**因此這裡 SHALL NOT 截斷**：
                      截掉它等同讓使用者在看不到全文的情況下按下送出。長本文以**捲動**處理，
                      `max-h-*` 給它一個不把整個收件匣撐開的高度。
                    */}
                    <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-2xs text-ink-faint">
                      {item.body}
                    </p>
                    {/*
                      **長度是一個看得見的訊號**（`agent-intake` 的「呈現 SHALL 附上本文的長度」）。
                      `IntakeCard` 一直都有它，而這一段沒有 —— 於是那條要求在 first-party 這條
                      路徑上**從來沒有載體**。本文的上限放寬之後它更重要：使用者一眼看得出
                      「這則很長」。
                    */}
                    <p className="text-2xs text-ink-faint">
                      {t('intake.bodyLength', { count: item.bodyLength })}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function tabClass(active: boolean): string {
  return (
    'rounded px-2 py-1 text-2xs transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ' +
    (active ? 'bg-accent/10 text-accent' : 'text-ink-dim hover:bg-hairline/40')
  )
}

/**
 * 這件事**發生**的時間，**完整的日期與時刻**（intake-inbox-usability）。
 *
 * 第一版呈現相對的**到達**時間，dogfood 當場踩到：昨天的 Slack 提及寫著「剛剛」—— 它們是啟動時
 * 一次回補進來的。`at` 是主行程算好的有效時間（宣告的發生時間，不晚於到達時間）。
 * 內容已過期（沒有時間）的不呈現。
 */
function OccurredAt({ at }: { at: number }): React.JSX.Element | null {
  if (!at) return null
  const date = new Date(at)
  return (
    <time dateTime={date.toISOString()} className="text-2xs text-ink-faint">
      {formatDateTime(date, OCCURRED_FORMAT)}
    </time>
  )
}

/** 完整的日期與時刻 —— 格式隨使用者選擇的語言（`formatDateTime` 經 `@shared/i18n/locale`）。 */
const OCCURRED_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }

/**
 * A handoff waiting for its time (`scheduled-handoff`): when it opens, from where, into which folder, and its full
 * body as plain text — the user can only judge Run now or Cancel by reading what will run. Earliest first (the
 * caller sorts). Run now opens it through the opener, as a due handoff opens; Cancel is the inbox's ignore.
 */
function ScheduledCard({
  item,
  folderName,
  onChanged,
}: {
  item: IntakeView
  folderName: string | undefined
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const at = new Date(item.scheduledAt ?? 0)
  // An occurrence of a recurrence: its Cancel skips this time only, and says so (`recurring-handoff`).
  const cancelKey = item.recurrence ? 'intake.skipOccurrence' : 'intake.cancelScheduled'
  return (
    <li
      aria-label={t('intake.scheduledItemLabel', { title: item.title })}
      className="flex flex-col gap-1 rounded border border-hairline px-3 py-1.5"
    >
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <time dateTime={at.toISOString()} className="text-2xs text-ink">
          {t('intake.scheduledFor', { time: formatDateTime(at, OCCURRED_FORMAT) })}
        </time>
        <span className="text-2xs text-ink-faint">{t('intake.fromOrigin', { origin: item.originLabel })}</span>
        {folderName ? <span className="text-2xs text-ink-dim">{t('intake.opensInFolder', { name: folderName })}</span> : null}
        <span className="flex-1" />
        <button
          type="button"
          aria-label={t(cancelKey)}
          onClick={() => void window.workspace.intake.dismiss(item.id, item.adapter).then(onChanged)}
          className="cursor-pointer rounded px-2 py-0.5 text-2xs text-ink-dim hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t(cancelKey)}
        </button>
        <button
          type="button"
          aria-label={t('intake.runNow')}
          onClick={() => void window.workspace.intake.runNow(item.id, item.adapter).then(onChanged)}
          className="cursor-pointer rounded bg-accent/10 px-2 py-0.5 text-2xs text-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('intake.runNow')}
        </button>
      </div>
      {item.recurrence ? <RepeatLine repeat={item.recurrence.repeat} until={item.recurrence.until} /> : null}
      {showTitleSeparately(item.title, item.body) ? <span className="break-words text-2xs text-ink">{item.title}</span> : null}
      {/* Plain text, whole, scrolled rather than cut — the same rule as the opened items' body. */}
      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-2xs text-ink-faint">{item.body}</p>
      <p className="text-2xs text-ink-faint">{t('intake.bodyLength', { count: item.bodyLength })}</p>
    </li>
  )
}

/** A repeating handoff's schedule, as written, and its end (`recurring-handoff`). */
function RepeatLine({ repeat, until }: { repeat: string; until?: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <p className="text-2xs text-ink-dim">
      {t('intake.repeats', { repeat })}{' '}
      <span className="text-ink-faint">
        {until === undefined
          ? t('intake.repeatUntilStopped')
          : t('intake.repeatUntil', { time: formatDateTime(new Date(until), OCCURRED_FORMAT) })}
      </span>
    </p>
  )
}

/**
 * Everything planned (`recurring-handoff`, design D6), apart from what waits for the user now: proposals waiting
 * for approval, then every scheduled handoff by time (one-off and occurrences), then the approved recurrences.
 */
function SchedulesTab({
  proposals,
  scheduled,
  recurrences,
  folders,
  folderName,
  selectionFor,
  onChoose,
  onChanged,
}: {
  proposals: readonly IntakeView[]
  scheduled: readonly IntakeView[]
  recurrences: RecurrenceListing
  folders: readonly WorkspaceFolder[]
  folderName: (id: string | undefined) => string | undefined
  selectionFor: (item: IntakeView) => Preselection
  onChoose: (item: IntakeView, folderId: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (proposals.length === 0 && scheduled.length === 0 && recurrences.recurrences.length === 0 && recurrences.available) {
    return <p className="text-2xs text-ink-faint">{t('intake.schedulesEmpty')}</p>
  }
  return (
    <div className="flex flex-col gap-4">
      {proposals.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-2xs font-bold text-ink-dim">{t('intake.proposalsLabel')}</h3>
          <ul aria-label={t('intake.proposalsLabel')} className="flex flex-col gap-3">
            {proposals.map((item) => (
              <ProposalCard
                key={itemKey(item)}
                item={item}
                folders={folders}
                selection={selectionFor(item)}
                onChoose={(folderId) => onChoose(item, folderId)}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {scheduled.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-2xs font-bold text-ink-dim">{t('intake.scheduledLabel')}</h3>
          <ul aria-label={t('intake.scheduledLabel')} className="flex flex-col gap-1">
            {scheduled.map((item) => (
              <ScheduledCard key={itemKey(item)} item={item} folderName={folderName(item.folderId)} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      ) : null}
      {!recurrences.available ? (
        <p role="status" className="rounded border border-hairline bg-shell px-3 py-2 text-2xs text-ink">
          {t('intake.recurrencesUnavailable')}
        </p>
      ) : recurrences.recurrences.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-2xs font-bold text-ink-dim">{t('intake.recurrencesLabel')}</h3>
          <ul aria-label={t('intake.recurrencesLabel')} className="flex flex-col gap-1">
            {recurrences.recurrences.map((recurrence) => (
              <RecurrenceRow
                key={recurrence.id}
                recurrence={recurrence}
                folderName={folderName(recurrence.folderId)}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

/**
 * A repeating handoff waiting for approval: its body whole, its schedule as written, the times it would open and
 * its end, so the user sees when and for how long before approving. Approve opens nothing now; it schedules the
 * first time, in the folder chosen here. Decline is the inbox's ignore.
 */
function ProposalCard({
  item,
  folders,
  selection,
  onChoose,
  onChanged,
}: {
  item: IntakeView
  folders: readonly WorkspaceFolder[]
  selection: Preselection
  onChoose: (folderId: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [failure, setFailure] = useState<string | null>(null)
  const chosen = selection.folderId
  const next = item.recurrence?.next ?? []
  const ended = next.length === 0

  const approve = async (): Promise<void> => {
    setFailure(null)
    const result: ApproveResult = await window.workspace.intake.approveRecurrence(item.id, item.adapter, chosen)
    if (!result.ok) {
      setFailure(
        result.reason === 'FOLDER_GONE'
          ? t('intake.chosenFolderGone')
          : result.reason === 'ended'
            ? t('intake.proposalEnded')
            : result.reason === 'unavailable'
              ? t('intake.recurrencesUnavailable')
              : t('intake.proposalGone'),
      )
    }
    onChanged()
  }

  return (
    <li
      aria-label={t('intake.proposalItemLabel', { title: item.title })}
      className="rounded border border-hairline bg-shell px-3 py-2"
    >
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="text-2xs text-ink-faint">{t('intake.fromOrigin', { origin: item.originLabel })}</span>
        <OccurredAt at={item.occurredAt} />
      </div>
      {showTitleSeparately(item.title, item.body) ? <p className="mt-1 break-words text-sm text-ink">{item.title}</p> : null}
      {/* Plain text, whole, scrolled rather than cut: what will run at every time is what the user approves. */}
      <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-2xs text-ink-dim">{item.body}</p>
      <p className="mt-1 text-2xs text-ink-faint">{t('intake.bodyLength', { count: item.bodyLength })}</p>
      {item.recurrence ? (
        <div className="mt-2">
          <RepeatLine repeat={item.recurrence.repeat} until={item.recurrence.until} />
          {ended ? (
            <p className="text-2xs text-ink-faint">{t('intake.proposalEnded')}</p>
          ) : (
            <p className="text-2xs text-ink-faint">
              {t('intake.repeatNext', { times: next.map((at) => formatDateTime(new Date(at), OCCURRED_FORMAT)).join(', ') })}
            </p>
          )}
        </div>
      ) : null}
      {failure ? <p className="mt-1 text-2xs text-ink">{failure}</p> : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-2xs text-ink-dim">{t('intake.approveInto')}</span>
        <select
          aria-label={t('intake.chooseFolder')}
          value={chosen}
          onChange={(event) => onChoose(event.target.value)}
          className="cursor-pointer rounded border border-hairline bg-shell px-2 py-1 text-2xs text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {chosen === '' ? (
            <option value="" disabled>
              {t('intake.choosePlaceholder')}
            </option>
          ) : null}
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={t('intake.decline')}
          onClick={() => void window.workspace.intake.dismiss(item.id, item.adapter).then(onChanged)}
          className="cursor-pointer rounded px-2 py-1 text-2xs text-ink-dim hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('intake.decline')}
        </button>
        <button
          type="button"
          aria-label={t('intake.approve')}
          disabled={chosen === '' || ended}
          onClick={() => void approve()}
          className="cursor-pointer rounded bg-accent/10 px-2 py-1 text-2xs text-accent disabled:cursor-default disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('intake.approve')}
        </button>
      </div>
    </li>
  )
}

/**
 * One approved recurrence: its schedule, folder, next time or why there is none, and Stop repeating — behind an
 * inline confirmation, because a stopped recurrence cannot be proposed again with the same content from the same
 * session (it is a duplicate).
 */
function RecurrenceRow({
  recurrence,
  folderName,
  onChanged,
}: {
  recurrence: RecurrenceView
  folderName: string | undefined
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const status =
    recurrence.next !== undefined
      ? t('intake.recurrenceNext', { time: formatDateTime(new Date(recurrence.next), OCCURRED_FORMAT) })
      : recurrence.waiting === 'earlier'
        ? t('intake.recurrenceWaitingEarlier')
        : recurrence.waiting === 'full'
          ? t('intake.recurrenceWaitingFull')
          : ''
  return (
    <li
      aria-label={t('intake.recurrenceItemLabel', { title: recurrence.title })}
      className="flex flex-col gap-1 rounded border border-hairline px-3 py-1.5"
    >
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="min-w-0 truncate text-2xs text-ink">{recurrence.title}</span>
        <span className="text-2xs text-ink-dim">{t('intake.opensInFolder', { name: folderName ?? recurrence.targetText })}</span>
        <span className="text-2xs text-ink-faint">{status}</span>
        <span className="flex-1" />
        {confirming ? null : (
          <button
            type="button"
            aria-label={t('intake.stopRepeating')}
            onClick={() => setConfirming(true)}
            className="cursor-pointer rounded px-2 py-0.5 text-2xs text-ink-dim hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {t('intake.stopRepeating')}
          </button>
        )}
      </div>
      <RepeatLine repeat={recurrence.repeat} until={recurrence.until} />
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-2xs text-ink">{t('intake.stopRepeatingConfirm')}</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label={t('intake.stopRepeatingNo')}
            onClick={() => setConfirming(false)}
            className="cursor-pointer rounded px-2 py-0.5 text-2xs text-ink-dim hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {t('intake.stopRepeatingNo')}
          </button>
          <button
            type="button"
            aria-label={t('intake.stopRepeatingYes')}
            onClick={() =>
              void window.workspace.intake.stopRecurrence(recurrence.id).then(() => {
                setConfirming(false)
                onChanged()
              })
            }
            className="cursor-pointer rounded bg-accent/10 px-2 py-0.5 text-2xs text-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {t('intake.stopRepeatingYes')}
          </button>
        </div>
      ) : null}
    </li>
  )
}

function IntakeCard({
  item,
  folders,
  selection,
  onChoose,
  onAccept,
  onChanged,
}: {
  item: IntakeView
  folders: readonly WorkspaceFolder[]
  /** 被選定的 folder（`preselectFolder` 的結果）。`''` ＝ 沒有選定。 */
  selection: Preselection
  onChoose: (folderId: string) => void
  onAccept: (item: IntakeView, folderId: string) => Promise<void>
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const chosen = selection.folderId

  return (
    <li
      aria-label={t('intake.itemLabel', { title: item.title })}
      className="rounded border border-hairline bg-shell px-3 py-2"
    >
      {/*
        **第一列是誰、在哪、何時，不折行；標題（若不與本文重複）在其下。** 同一列放長標題會把
        其餘資訊擠成好幾行；而 Slack 的標題就是本文裡那一則的第一行（dogfood 回報兩件事）。
      */}
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="text-2xs text-ink-dim">{item.actor}</span>
        <span className="text-2xs text-ink-faint">{item.originLabel}</span>
        <OccurredAt at={item.occurredAt} />
        <span className="flex-1" />
        {/*
          識別碼是投遞者挑的，字元集白名單只保證它路徑安全、不保證它不是一句話 ——
          因此以等寬、截短、可辨識為機器識別碼的方式呈現。
        */}
        <code className="min-w-0 max-w-[14rem] truncate font-mono text-2xs text-ink-faint">{item.id}</code>
      </div>
      {/* An occurrence that was opened and waits for the user (`recurring-handoff`): it belongs to a recurrence. */}
      {item.recurrence ? <RepeatLine repeat={item.recurrence.repeat} until={item.recurrence.until} /> : null}
      {/* 標題也是第三方撰寫的 —— 與本文同樣只當文字呈現。 */}
      {showTitleSeparately(item.title, item.body) ? (
        <p className="mt-1 break-words text-sm text-ink">{item.title}</p>
      ) : null}

      {/*
        **本文全文，純文字。** `whitespace-pre-wrap` 保留換行；沒有任何 markdown 渲染，
        因此文中的圖片與連結語法就是字面文字。
      */}
      <p className="mt-2 whitespace-pre-wrap break-words text-2xs text-ink-dim">{item.body}</p>
      <p className="mt-1 text-2xs text-ink-faint">{t('intake.bodyLength', { count: item.bodyLength })}</p>

      <div className="mt-2 flex items-center gap-2">
        {/*
          **將開在哪個 folder —— 使用者在這裡確認或改選。** 原生 select：全鍵盤操作是瀏覽器給的。

          值為空（沒有被選定）時**一律**渲染佔位項：一個不在選項中的值會讓 select 顯示第一個
          選項、送出的卻是那個不存在的值。
        */}
        <span className="text-2xs text-ink-dim">{t('intake.opensInLabel')}</span>
        <select
          aria-label={t('intake.chooseFolder')}
          value={chosen}
          onChange={(event) => onChoose(event.target.value)}
          className="cursor-pointer rounded border border-hairline bg-shell px-2 py-1 text-2xs text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {chosen === '' ? (
            <option value="" disabled>
              {t('intake.choosePlaceholder')}
            </option>
          ) : null}
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        {/*
          **沒有被選定時說明為什麼。** 使用者的改選被移除 ⇒ 說那件事；解析不出 ⇒ 說原因。
          選定之後不再呈現原因 —— 那時要說的是「將開在哪」，而選單已經在說了。
        */}
        {selection.overrideGone ? (
          <span className="text-2xs text-ink-faint">{t('intake.chosenFolderGone')}</span>
        ) : chosen === '' ? (
          <span className="text-2xs text-ink-faint">
            {item.unresolved === 'FOLDER_GONE' ? t('intake.unresolvedFolderGone') : t('intake.unresolved')}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          aria-label={t('intake.dismiss')}
          onClick={() => void window.workspace.intake.dismiss(item.id, item.adapter).then(onChanged)}
          className="cursor-pointer rounded px-2 py-1 text-2xs text-ink-dim hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('intake.dismiss')}
        </button>
        <button
          type="button"
          aria-label={t('intake.accept')}
          disabled={chosen === ''}
          onClick={() => void onAccept(item, chosen)}
          className="cursor-pointer rounded bg-accent/10 px-2 py-1 text-2xs text-accent disabled:cursor-default disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {t('intake.accept')}
        </button>
      </div>
    </li>
  )
}

/**
 * One line about Slack, only while it is set up and not working (`slack-intake-source`, "The inbox says when Slack
 * is not working"). From the outside every failure of the connection looks like nobody mentioning the user: an
 * empty inbox. The user looks here, not at Settings, so the difference must be visible here.
 */
function SlackLine({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<SlackState | null>(null)
  const reload = useCallback(() => {
    void window.workspace.slack.get().then(setState)
  }, [])
  useEffect(reload, [reload])
  useEffect(() => window.workspace.slack.onChanged(reload), [reload])

  if (state === null || !slackNeedsAttention(state)) return null
  const status = statusCopy(state)
  return (
    <div role="status" className="mb-3 flex items-center gap-3 rounded border border-hairline bg-shell px-3 py-2">
      <p className="flex-1 text-2xs text-ink">{t('slack.inboxLine', { status: t(status.key, status.options) })}</p>
      <button
        type="button"
        onClick={onOpen}
        className="rounded px-2 py-0.5 text-2xs text-ink-dim hover:bg-hairline/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {t('slack.openSettings')}
      </button>
    </div>
  )
}
