import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { closableNow, type LifecycleState } from '@shared/lineage/lifecycle'
import { useLineage } from './lineage'
import { sessionTitle } from './session-badge'
import { useSessions, type SessionState } from './sessions'

/**
 * 交接 session 的生命週期在畫面上（`handoff-completion`）。**權威在主行程** —— 這裡只持有投影
 * （`window.workspace.handoff.lifecycle`／`onLifecycle`），沒有任何「把某個 session 標成已完成」的途徑。
 */

interface LifecycleEntry {
  state: LifecycleState
  summary?: string
  reportedAt?: number
}

interface LifecycleApi {
  of(sessionId: string): LifecycleEntry | undefined
  /** 打開「收掉已完成」的確認對話框，列出這些 session（呼叫端先篩成已完成的）。 */
  confirmClose(sessionIds: readonly string[]): void
}

const LifecycleContext = createContext<LifecycleApi | null>(null)

export function useLifecycle(): LifecycleApi {
  const api = useContext(LifecycleContext)
  if (!api) throw new Error('useLifecycle must be used within LifecycleProvider')
  return api
}

export function LifecycleProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [entries, setEntries] = useState<ReadonlyMap<string, LifecycleEntry>>(new Map())
  const [closing, setClosing] = useState<readonly string[] | null>(null)

  // **訂閱只建立一次**（`docs/lessons/handoff.md` 第六節）：依賴陣列裡放一個每次重繪都重建的東西，
  // 就會在退訂與重新訂閱之間的窗口裡掉訊息。
  useEffect(() => {
    let alive = true
    const apply = (views: { sessionId: string; state: LifecycleState; summary?: string; reportedAt?: number }[]): void => {
      if (!alive) return
      setEntries(new Map(views.map(({ sessionId, ...rest }) => [sessionId, rest])))
    }
    const unsubscribe = window.workspace.handoff.onLifecycle(apply)
    void window.workspace.handoff.lifecycle().then(apply)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // 確認對話框在確認的那一刻要讀**當下**的值 —— 放進 ref，而不是讓 callback 在開啟時就把它閉包住。
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  const of = useCallback((sessionId: string) => entries.get(sessionId), [entries])
  const confirmClose = useCallback((sessionIds: readonly string[]) => setClosing(sessionIds), [])
  const api = useMemo(() => ({ of, confirmClose }), [of, confirmClose])

  return (
    <LifecycleContext.Provider value={api}>
      {children}
      {closing && (
        <CloseCompletedDialog
          listed={closing}
          entryOf={(sessionId) => entries.get(sessionId)}
          isDoneNow={(sessionId) => entriesRef.current.get(sessionId)?.state === 'done'}
          onDone={() => setClosing(null)}
        />
      )}
    </LifecycleContext.Provider>
  )
}

/** 狀態的標記：圖示在畫面上，完整文字在 `aria-label`／`title`。`idle` 不佔位。 */
export function LifecycleMark({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const entry = useLifecycle().of(sessionId)
  if (!entry || entry.state === 'idle') return null
  const text = t(`handoffLifecycle.${entry.state}`)
  const glyph = entry.state === 'done' ? '✓' : entry.state === 'working' ? '●' : '○'
  return (
    <span
      role="img"
      aria-label={text}
      title={entry.summary ? `${text} — ${entry.summary}` : text}
      className={'shrink-0 px-0.5 text-2xs leading-none ' + (entry.state === 'done' ? 'text-accent' : 'text-ink-faint')}
    >
      {glyph}
    </span>
  )
}

/** 某些 session 之中此刻為已完成、且存在的那些。 */
export function useCompletedAmong(): (candidates: readonly SessionState[]) => SessionState[] {
  const lifecycle = useLifecycle()
  const lineage = useLineage()
  return useCallback(
    (candidates) =>
      candidates.filter(
        (session) => session.lineage !== undefined && lineage.exists(session) && lifecycle.of(session.id)?.state === 'done',
      ),
    [lifecycle, lineage],
  )
}

const BUTTON_CLASS = 'rounded border border-hairline px-2 py-[3px] text-xs hover:bg-stage'

function CloseCompletedDialog({
  listed,
  entryOf,
  isDoneNow,
  onDone,
}: {
  listed: readonly string[]
  entryOf: (sessionId: string) => LifecycleEntry | undefined
  isDoneNow: (sessionId: string) => boolean
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessions()
  const lineage = useLineage()
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])

  const all = sessions.all()
  const rows = listed
    .map((id) => all.find((session) => session.id === id))
    .filter((session): session is SessionState => session !== undefined)

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-scrim px-4 text-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDone()
      }}
    >
      <div
        role="dialog"
        aria-label={t('handoffLifecycle.closeDialog', { count: rows.length })}
        className="flex max-h-[80vh] w-full max-w-xl flex-col rounded border border-hairline bg-panel p-3 shadow-lg"
      >
        <p className="text-ink">{t('handoffLifecycle.closeDialog', { count: rows.length })}</p>
        <p className="mt-1 text-xs text-ink-faint">{t('handoffLifecycle.closeHint')}</p>
        <ul aria-label={t('handoffLifecycle.closeList')} className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {rows.map((session) => {
            const summary = entryOf(session.id)?.summary
            return (
              <li key={session.id} className="border-t border-hairline py-1.5 first:border-t-0">
                <p className="text-xs text-ink">
                  {t('lineage.item', { repo: lineage.itemName(session.folderId) ?? '', title: sessionTitle(session) })}
                </p>
                {/* **最新結果以純文字列出** —— 完成報告可以被別的 agent 偽造，關閉之前讓使用者看得到它說了什麼。 */}
                {summary && <p className="mt-0.5 whitespace-pre-wrap break-words text-2xs text-ink-faint">{summary}</p>}
              </li>
            )
          })}
        </ul>
        <div className="mt-3 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onDone} className={`${BUTTON_CLASS} text-ink-faint`}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              // **確認的那一刻重新判定**：列出的 ∩ 此刻仍為已完成的。
              for (const sessionId of closableNow(listed, isDoneNow)) sessions.close(sessionId)
              onDone()
            }}
            className={`${BUTTON_CLASS} text-danger`}
          >
            {t('handoffLifecycle.closeConfirm', { count: rows.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
