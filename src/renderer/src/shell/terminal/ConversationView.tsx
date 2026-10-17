import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MarkdownView } from '../files/MarkdownView'
import { useSessions } from './sessions'
import { CloseOffer } from './CloseOffer'
import { WakeButton } from './TerminalView'

/**
 * agent session 的結構化呈現。
 *
 * ## 內容來自 agent 自己寫下的紀錄，不來自終端畫面
 *
 * 終端 buffer 是「第幾行第幾格是什麼字元、什麼顏色」，不是「這是一則 assistant 訊息」。
 * 本 view 的每一則都來自主行程對 agent 紀錄的投影（`agent-transcript-stream`）。
 *
 * ## 訊息整則出現，且 SHALL NOT 模擬逐字產生
 *
 * 內容抵達時該訊息早已完整，agent 可能已在進行下一件事。一個模擬的產生過程宣稱了一個**沒有
 * 來源**的進度 —— 那與解析終端畫面是同一種錯誤的兩個方向（一個猜過去發生了什麼，一個演出一件
 * 沒有發生的事）。
 *
 * 出現時的轉場**允許**，但其時長是一個常數，**不隨訊息長度改變** —— 一旦隨長度變化，
 * 它就開始宣稱進度了。因此動畫寫在 CSS 類別裡，這裡沒有任何依內容計算的延遲。
 */

type ViewEvent = ConversationUpdate['events'][number]
type ConversationUpdate = Parameters<Parameters<Window['workspace']['conversation']['onUpdate']>[0]>[0]
type WaitState = Parameters<Parameters<Window['workspace']['conversation']['onWait']>[0]>[1]
type PendingRequest = Parameters<Parameters<Window['workspace']['conversation']['onWait']>[0]>[2]

interface Props {
  sessionId: string
  /** 這個 session 是否為當下顯示的那一個。只有它才訂閱內容。 */
  active: boolean
  /** 休眠的 session 尚未有 pty，也就還沒有紀錄可跟。 */
  dormant: boolean
  /**
   * Covered by the maximized side panel: still displayed (it keeps its subscriptions), but the user
   * cannot see it, so it takes no focus — otherwise `Enter` could wake a session nobody sees. When
   * the cover goes, it takes focus (`workspace-layout`, design M2).
   */
  covered?: boolean
}

/*
 * agent 的輸出是**不受信任的內容**，與檔案樹渲染任意 `.md` 同一條理由 —— 因此重用既有的
 * `MarkdownView`，不另接一份 `react-markdown`。它已經承擔了兩件承重的事：原始 HTML 降級為
 * 純文字（絕不加 `rehype-raw`），以及**連結一律不在 app 內導航**（外部交給主行程再驗一次協定，
 * 其餘不可點）。少了後者，agent 輸出裡一個連結就能把 renderer 帶去遠端頁面，
 * 而 preload 會跟著注入 —— 那個頁面將取得完整的 `window.workspace.fs`。
 */

function Row({ event }: { event: ViewEvent }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (event.kind === 'user') {
    return (
      <div className="conversation-enter rounded border border-hairline bg-panel px-3 py-2">
        <div className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">
          {event.meta ? t('conversation.metaMessage') : t('conversation.userMessage')}
        </div>
        <MarkdownView text={event.text} dense />
      </div>
    )
  }
  if (event.kind === 'text') {
    return (
      <div className="conversation-enter px-3 py-2">
        <MarkdownView text={event.text} dense />
      </div>
    )
  }
  if (event.kind === 'thinking') {
    return (
      <details className="conversation-enter px-3 py-1 text-ink-faint">
        <summary className="cursor-pointer text-2xs uppercase tracking-wide">
          {t('conversation.thinking')}
        </summary>
        <div className="mt-1 whitespace-pre-wrap text-xs">{event.text}</div>
      </details>
    )
  }
  if (event.kind === 'tool') {
    return (
      <div className="conversation-enter flex items-baseline gap-2 px-3 py-1 text-xs">
        <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 font-medium">{event.name}</span>
        {/* 辨識參數可能是一個路徑 —— 呈現為**不可導覽的純文字**（見主行程的邊界說明）。 */}
        {event.arg ? <span className="truncate text-ink-faint">{event.arg}</span> : null}
      </div>
    )
  }
  // tool_result：只呈現存在與否 + 是否失敗。內容可能極長，展開才讀。
  return (
    <details className="conversation-enter px-3 py-1 text-xs text-ink-faint">
      <summary className="cursor-pointer">
        {event.error ? t('conversation.toolFailed') : t('conversation.toolResult')}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-2xs">{event.text}</pre>
    </details>
  )
}

export function ConversationView({ sessionId, active, dormant, covered = false }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [events, setEvents] = useState<ViewEvent[]>([])
  const [status, setStatus] = useState<ConversationUpdate['status']>('attaching')
  const [truncated, setTruncated] = useState(false)
  // **初始值是未知，不是就緒。** 尚未收到任何事件時我們什麼都不知道，而未知一律拒絕送出。
  const [wait, setWait] = useState<WaitState>('unknown')
  const [pending, setPending] = useState<PendingRequest>(null)
  /** 已送出、但尚未出現在 agent 紀錄中的訊息。 */
  const [unconfirmed, setUnconfirmed] = useState<{ text: string; at: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [blocked, setBlocked] = useState<WaitState | null>(null)
    const bottomRef = useRef<HTMLDivElement | null>(null)
  const { wake, takeQuietArrival, isFocusHeld, closeOffered, close, keepCloseOffer } = useSessions()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const wakeButtonRef = useRef<HTMLButtonElement | null>(null)

  // The same focus rule as the terminal view (`session-persistence`): a displayed dormant session's
  // Wake button takes focus, so `Enter` wakes it; once it is running, its composer does.
  //
  // Covered by the maximized side panel it takes no focus; uncovered again, it takes it — the Wake
  // button when dormant, the composer otherwise (design M2: restoring returns focus to the session).
  //
  // A transition a device caused (it hibernated this session, or closed the one this view replaces) holds the
  // focus for that commit, whatever the trigger (`isFocusHeld`, `remote-hibernate-close` D4); `heldFor` keeps the
  // answer for StrictMode's second run in development, which comes after the hold is cleared.
  const wasDormant = useRef(dormant)
  const wasCovered = useRef(covered)
  const heldFor = useRef<string | null>(null)
  useEffect(() => {
    // Any other evaluation — the view leaving the screen included — ends what was held, so a later activation
    // with the same values (the user selecting it again) focuses.
    const evaluation = `${dormant}|${active}|${covered}`
    if (heldFor.current !== evaluation) heldFor.current = null
    const was = wasDormant.current
    const uncovered = wasCovered.current && !covered
    wasDormant.current = dormant
    wasCovered.current = covered
    // A session woken for a paired device does not take the composer's focus (`remote-protocol`).
    const quiet = was && !dormant && takeQuietArrival(sessionId, 'conversation')
    if (!active || covered) return
    if (isFocusHeld(sessionId)) heldFor.current = evaluation
    if (heldFor.current === evaluation) return
    if (dormant) wakeButtonRef.current?.focus()
    else if (quiet) return
    else if (was || uncovered) rootRef.current?.querySelector('textarea')?.focus()
  }, [active, dormant, covered, sessionId, takeQuietArrival, isFocusHeld])


  useEffect(() => {
    if (!active || dormant) return undefined
    // 訂閱先於 watch —— 反過來的話，主行程對「已存在的紀錄」立刻推送的那一份會落空。
    const off = window.workspace.conversation.onUpdate((update) => {
      if (update.sessionId !== sessionId) return
      setStatus(update.status)
      setTruncated(update.truncated)
      setEvents((previous) => (update.reset ? update.events : [...previous, ...update.events]))
      // 送出的內容一旦出現在紀錄中，「未確認」的標示即消失 —— 那才是它真的到達 agent 的證據。
      setUnconfirmed((current) =>
        current && update.events.some((e) => e.kind === 'user' && e.text.trim() === current.text.trim())
          ? null
          : current,
      )
    })
    const offWait = window.workspace.conversation.onWait((id, state, request) => {
      if (id !== sessionId) return
      setWait(state)
      setPending(request)
    })
    window.workspace.conversation.watch(sessionId)
    return () => {
      window.workspace.conversation.watch(null)
      offWait()
      off()
    }
  }, [sessionId, active, dormant])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  if (dormant) {
    // **休眠 SHALL NOT 呈現為一份空的對話** —— 那與「這個 session 真的還沒講話」無法區分，
    // 而兩者的正確處置不同。
    return (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-ink-faint">
        <span>{t('conversation.dormant')}</span>
        <WakeButton ref={wakeButtonRef} onWake={() => wake(sessionId)} />
      </div>
    )
  }

  if (status === 'unavailable') {
    // 讀不到內容時**不呈現輸入框** —— 我們連這個 session 的狀態都拿不到，送出必定被拒絕，
    // 給一個註定按不動的入口比不給更糟。指向終端 view 才是使用者能做的事。
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-ink-faint">
        <span>{t('conversation.unavailable')}</span>
        <span className="text-xs">{t('conversation.unavailableHint')}</span>
      </div>
    )
  }

  /*
    **輸入框在 `attaching` 與 `ok` 兩種狀態下都必須存在。**

    此前 `attaching` 是一個整頁的早退，於是新建的 session（紀錄檔還不存在）看到的是一片
    「Catching up…」而**沒有輸入框** —— 而打不了字，agent 就永遠不會寫出紀錄。**那是死鎖。**
    一個以「還沒有內容」為條件而藏起輸入入口的實作，恰好把使用者鎖在他唯一能脫離該狀態的動作外。
  */
  return (
        <div ref={rootRef} className="flex h-full flex-col overflow-y-auto py-2 text-sm">
      {/* Sticky, so it stays in view while the conversation scrolls under it (D12 of `agent-session-control`). */}
      {closeOffered(sessionId) && (
        <div className="pointer-events-none sticky top-0 z-10 flex justify-center pb-2">
          <CloseOffer onClose={() => close(sessionId)} onKeep={() => keepCloseOffer(sessionId)} />
        </div>
      )}
      {/* 內容不完整時**明示** —— 一份看起來完整、實際少了開頭的對話會誤導判斷。 */}
      {truncated && (
        <div className="mx-3 mb-2 rounded border border-hairline px-3 py-1 text-xs text-ink-faint">
          {t('conversation.earlierNotLoaded')}
        </div>
      )}
      {events.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-ink-faint">
          {status === 'attaching' ? t('conversation.attaching') : t('conversation.empty')}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {events.map((event, index) => (
          <Row key={`${event.uuid}:${index}`} event={event} />
        ))}
      </div>
      <div ref={bottomRef} />

      {/*
        **送出 ≠ agent 收到。** 在它出現於紀錄中之前一律標示為未確認 —— 直接畫成一則已送達的
        訊息的話，兩者一致時看不出差別，不一致時使用者會看見一則從未發生的訊息。
      */}
      {unconfirmed && (
        <div className="conversation-enter mx-0 rounded border border-dashed border-hairline px-3 py-2 opacity-70">
          <div className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">
            {t('conversation.unconfirmed')}
          </div>
          <div className="whitespace-pre-wrap break-words text-sm">{unconfirmed.text}</div>
        </div>
      )}

      <Composer
        sessionId={sessionId}
        wait={wait}
        pending={pending}
        draft={draft}
        onDraft={setDraft}
        blocked={blocked}
        onBlocked={setBlocked}
        onSent={(text) => setUnconfirmed({ text, at: Date.now() })}
      />
    </div>
  )
}

/**
 * 送出入口。
 *
 * **可用與否由 agent 自己回報的等待狀態決定，不由畫面推測。** 而這裡的停用只是 UI 提示 ——
 * **真正的閘在主行程**（preload 與 renderer 同屬一個行程樹，在這裡檢查等同沒有檢查）。
 *
 * 忙碌時**仍然允許送出** —— agent 本來就接受在它工作時打字（會排隊），拒絕會很難用。
 * 真正拒絕的只有兩種：等待選擇（只接受選項）與未知。
 */
function Composer({
  sessionId,
  wait,
  pending,
  draft,
  onDraft,
  blocked,
  onBlocked,
  onSent,
}: {
  sessionId: string
  wait: WaitState
  pending: PendingRequest
  draft: string
  onDraft: (value: string) => void
  blocked: WaitState | null
  onBlocked: (value: WaitState | null) => void
  onSent: (text: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const sendable = wait === 'ready' || wait === 'busy'

  /*
    **輸入框本身不停用，停用的只有送出。**

    一個永遠灰掉、而且不說明原因的輸入框，與「壞掉」在畫面上無法區分 —— dogfood 第一次就
    撞上了（當時的成因是注入的 hook 命令有 shell 語法錯，於是狀態永遠是未知）。而規格說的是
    「拒絕送出**並說明原因**」，不是「不給打字」。

    使用者仍然打得出草稿，並且**看得到為什麼送不出去** —— 那是他判斷「要不要切去終端」的依據。
  */
  /*
    **等待選擇時只說「正在被問什麼」，不提供作答入口。**

    agent 回報的事件**不含它呈現給使用者的選項**（實測：payload 帶的是「要不要改變權限規則」
    的建議）。在這裡作答只能靠猜終端畫面上的編號 —— 而猜錯的後果不是「沒有反應」，是**替使用者
    做出一個他從未同意的決定**。知道「正在被問什麼」本身即為價值：使用者不必先切回終端才發現
    agent 卡住了。
  */
  const reason =
    wait === 'awaiting-choice'
      ? pending?.tool
        ? t('conversation.pendingRequest', { tool: pending.tool })
        : t('conversation.pendingRequestBare')
      : wait === 'unknown'
        ? t('conversation.waitingForState')
        : null

  const submit = (): void => {
    if (!draft.trim()) return
    void window.workspace.conversation.send(sessionId, draft).then((result) => {
      if (result.ok) {
        onSent(draft)
        onDraft('')
        onBlocked(null)
        return
      }
      // 被主行程拒絕 —— **說出原因並指向終端 view**，不要靜默地什麼都不發生。
      onBlocked(result.reason ?? 'unknown')
    })
  }

  return (
    <div className="sticky bottom-0 mt-2 border-t border-hairline bg-shell px-3 pt-2 pb-3">
      {/* 被拒絕過 ⇒ 以警示色說；尚未送出但已知送不出去 ⇒ 以次要色**主動**說。 */}
      {blocked ? (
        <div className="mb-1 text-xs text-danger">
          {blocked === 'awaiting-choice' ? t('conversation.blockedChoice') : t('conversation.blockedUnknown')}
        </div>
      ) : (
        reason && <div className="mb-1 text-xs text-ink-faint">{reason}</div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          className="min-h-[2.25rem] flex-1 resize-y rounded border border-hairline bg-panel px-2 py-1 text-sm text-ink outline-none focus:border-accent/50"
          aria-label={t('conversation.composer')}
          rows={2}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            // `Enter` 送出、`Shift+Enter` 換行 —— 與 agent 自己的輸入框一致。
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded border border-hairline px-3 py-1 text-xs text-ink-dim hover:border-accent/40 hover:text-accent focus:border-accent/40 focus:outline-none disabled:cursor-default disabled:opacity-50"
          aria-label={t('conversation.send')}
          disabled={!sendable || draft.trim() === ''}
          onClick={submit}
        >
          {t('conversation.send')}
        </button>
      </div>
      {wait === 'awaiting-choice' && pending?.arg && (
        <div className="mt-1 truncate text-2xs text-ink-faint">{pending.arg}</div>
      )}
      {wait === 'busy' && <div className="mt-1 text-2xs text-ink-faint">{t('conversation.busy')}</div>}
    </div>
  )
}
