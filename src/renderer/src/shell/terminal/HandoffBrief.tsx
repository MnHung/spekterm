import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime } from '@shared/i18n/locale'
import { useLineage, useSourceDescription } from './lineage'
import { useSessions, type SessionState } from './sessions'

/**
 * 交接單（`handoff-brief`）：由交接建立的 session 隨時打得開的那一份 —— 標題、來源、到達時間、
 * 本文全文，以及最新的結果（`handoff-completion`）。
 *
 * **它存在的理由**：交接的本文原本只呈現於收件匣「已開好」那一段，而第一則 prompt 一送出它就離開
 * 那裡 —— 使用者回頭想知道「這個 session 在做哪件事」時只能去問 agent。
 *
 * 入口有兩個（「← 來源」旁的按鈕、分頁右鍵選單），所以由一個 Provider 持有「現在打開哪一個」。
 */

interface HandoffBriefApi {
  open(sessionId: string): void
}

const HandoffBriefContext = createContext<HandoffBriefApi | null>(null)

export function useHandoffBrief(): HandoffBriefApi {
  const api = useContext(HandoffBriefContext)
  if (!api) throw new Error('useHandoffBrief must be used within HandoffBriefProvider')
  return api
}

export function HandoffBriefProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const sessions = useSessions()
  const [openId, setOpenId] = useState<string | null>(null)
  const open = useCallback((sessionId: string) => setOpenId(sessionId), [])
  const api = useMemo(() => ({ open }), [open])

  /**
   * 觸發了完成通知（`handoff-completion`）：選中那個子 session 並打開它的交接單。已不存在 ⇒ 無操作。
   * **訂閱只建立一次**，變動的東西放在 ref（`docs/lessons/handoff.md` 第六節）。
   */
  const lineage = useLineage()
  const latest = useRef({ sessions, lineage })
  useEffect(() => {
    latest.current = { sessions, lineage }
  })
  useEffect(
    () =>
      window.workspace.handoff.onReveal((sessionId) => {
        const { sessions: api_, lineage: jump } = latest.current
        const target = api_.all().find((candidate) => candidate.id === sessionId)
        if (!target) return
        jump.jumpTo(target.folderId, target.id)
        setOpenId(sessionId)
      }),
    [],
  )
  // session 被關掉時對話框跟著消失 —— 它的交接單已經不在了。
  const session = openId ? sessions.all().find((candidate) => candidate.id === openId) : undefined

  return (
    <HandoffBriefContext.Provider value={api}>
      {children}
      {session?.lineage?.brief && <HandoffBriefDialog session={session} onClose={() => setOpenId(null)} />}
    </HandoffBriefContext.Provider>
  )
}

type Loaded = { state: 'loading' } | { state: 'ready'; body: string | null; report?: { summary: string; reportedAt: number } }

const BUTTON_CLASS = 'rounded border border-hairline px-2 py-[3px] text-xs hover:bg-stage'

function HandoffBriefDialog({ session, onClose }: { session: SessionState; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const source = useSourceDescription(session)
  const brief = session.lineage?.brief
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const closeRef = useRef<HTMLButtonElement>(null)

  // **每次打開都重新取** —— 結果（`handoff-completion`）在對話框關著的時候可能已經更新。
  useEffect(() => {
    let cancelled = false
    void window.workspace.handoff.brief(session.id).then((view) => {
      if (cancelled) return
      setLoaded({ state: 'ready', body: view?.body ?? null, ...(view?.report ? { report: view.report } : {}) })
    })
    return () => {
      cancelled = true
    }
  }, [session.id])

  useEffect(() => closeRef.current?.focus(), [])

  const title = brief?.title.trim() ? brief.title : t('handoffBrief.untitled')

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 px-4 text-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div
        role="dialog"
        aria-label={t('handoffBrief.dialog', { title })}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded border border-hairline bg-panel p-3 shadow-lg"
      >
        <p className="text-ink">{title}</p>
        <p className="mt-1 text-xs text-ink-faint">
          {source?.onActivate ? (
            <button
              type="button"
              onClick={() => {
                source.onActivate?.()
                onClose()
              }}
              className="cursor-pointer hover:text-accent"
            >
              {source.label}
            </button>
          ) : (
            source?.label
          )}
          {brief && <span> · {t('handoffBrief.receivedAt', { time: formatDateTime(new Date(brief.receivedAt)) })}</span>}
        </p>

        {/* **純文字**：`whitespace-pre-wrap` 保留換行，沒有任何 markdown 渲染 —— 與收件匣呈現本文的方式相同。 */}
        <section aria-label={t('handoffBrief.bodyLabel')} className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {loaded.state === 'loading' ? (
            <p className="text-xs text-ink-faint">{t('handoffBrief.loading')}</p>
          ) : loaded.body === null ? (
            <p className="text-xs text-ink-faint">{t('handoffBrief.bodyUnavailable')}</p>
          ) : (
            <p className="whitespace-pre-wrap break-words text-2xs text-ink-dim">{loaded.body}</p>
          )}
        </section>

        <section aria-label={t('handoffBrief.resultLabel')} className="mt-3 border-t border-hairline pt-2">
          <p className="text-xs text-ink">{t('handoffBrief.resultLabel')}</p>
          {loaded.state === 'ready' && loaded.report ? (
            <>
              <p className="mt-1 text-2xs text-ink-faint">
                {t('handoffBrief.reportedAt', { time: formatDateTime(new Date(loaded.report.reportedAt)) })}
              </p>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-2xs text-ink-dim">
                {loaded.report.summary}
              </p>
            </>
          ) : (
            <p className="mt-1 text-2xs text-ink-faint">{t('handoffBrief.noResult')}</p>
          )}
        </section>

        <div className="mt-3 flex justify-end">
          <button ref={closeRef} type="button" onClick={onClose} className={BUTTON_CLASS}>
            {t('handoffBrief.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
