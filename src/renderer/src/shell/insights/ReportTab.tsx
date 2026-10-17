import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { GenerateResult, ReportPreview } from '../../../../main/report'
import type { Report, ReportMeta } from '../../../../main/report-store'
import { formatDate, formatDateTime, formatNumber } from '@shared/i18n/locale'

/**
 * 讀後感分頁。
 *
 * ## 為什麼與數字分開一頁
 *
 * 儀表板永遠是「現在」且範圍可切換；報告是「某天針對某段期間跑的一份」。疊在同一頁上，
 * 散文會被當成跟旁邊的長條圖一樣新 —— 於是使用者的習慣改變之後，數字會動而那段文字不會，
 * **它會靜靜地繼續講三個月前的那個人**。
 *
 * ## 切到這一頁不觸發任何委派
 *
 * 一趟委派會產生實際費用。開啟即觸發等於替使用者花錢。
 */

const fmtDate = (t: number): string => formatDate(new Date(t))
const fmtRange = (from: number | null, to: number | null): string =>
  from === null || to === null ? '—' : `${fmtDate(from)} – ${fmtDate(to)}`

export function ReportTab({ range }: { range: { from?: number } | undefined }): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<ReportMeta[] | null>(null)
  const [open, setOpen] = useState<Report | null>(null)
  const [preview, setPreview] = useState<ReportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    // **`.catch` 不是防禦性程式設計** —— 少了它主行程一拋錯畫面就一動也不動，
    // 而使用者看到的是「點了沒反應」。
    void window.workspace.insights
      .reportList()
      .then(setList)
      .catch(() => setList([]))
  }, [])

  useEffect(reload, [reload])

  const ask = useCallback(() => {
    setError(null)
    void window.workspace.insights
      .reportPreview(range)
      .then(setPreview)
      .catch(() => setError('busy'))
  }, [range])

  const confirm = useCallback(() => {
    setPreview(null)
    setBusy(true)
    void window.workspace.insights
      .reportGenerate({ ...range, authorized: true })
      .then((result: GenerateResult) => {
        setBusy(false)
        if (result.ok) {
          setOpen(result.report)
          reload()
        } else {
          setError(result.code)
        }
      })
      .catch(() => {
        setBusy(false)
        setError('delegateFailed')
      })
  }, [range, reload])

  if (open) return <ReportBody report={open} onBack={() => setOpen(null)} selectedFrom={range?.from} />

  return (
    <section aria-label={t('insights.report.label')} className="mx-auto max-w-4xl">
      <p className="mb-4 text-xs leading-relaxed text-ink-dim">{t('insights.report.blurb')}</p>

      {error ? <Note text={t(`insights.report.error.${error}` as 'insights.report.error.busy')} tone="danger" /> : null}
      {busy ? <Note text={t('insights.report.generating')} /> : null}

      <button
        type="button"
        onClick={ask}
        disabled={busy}
        aria-label={t('insights.report.generate')}
        className="mb-4 rounded border border-hairline px-3 py-1 text-xs text-ink-dim hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {t('insights.report.generate')}
      </button>

      {list !== null && list.length === 0 ? <Note text={t('insights.report.empty')} /> : null}

      {list && list.length > 0 ? (
        <ul aria-label={t('insights.report.listLabel')} className="flex flex-col border-t border-hairline">
          {list.map((meta) => (
            <li key={meta.generatedAt} className="border-b border-hairline py-2">
              <button
                type="button"
                aria-label={t('insights.report.open')}
                onClick={() => {
                  void window.workspace.insights
                    .reportRead(`${meta.generatedAt}.json`)
                    .then((r) => r && setOpen(r))
                    .catch(() => setError('unparsableReply'))
                }}
                className="w-full cursor-pointer text-left hover:text-accent"
              >
                <span className="text-xs font-bold text-ink">{fmtDate(meta.generatedAt)}</span>
                <span className="ml-2 font-mono text-2xs text-ink-faint">
                  {fmtRange(meta.from, meta.to)} · {meta.messages} · {meta.requestedModel}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {preview ? <AuthorizeDialog preview={preview} onConfirm={confirm} onCancel={() => setPreview(null)} /> : null}
    </section>
  )
}

/**
 * 授權對話框。
 *
 * **呈現的是範圍，不是內容。** 一個「送出前讓你捲一遍」的預覽就是 `conversation-insights`
 * 明令不得存在的那個全文檢視器。而這些數字是**截斷之後、實際將送出的那一份**的數字 ——
 * 授權「30 天、3,839 則」卻只送了 11 天，是一次有瑕疵的授權。
 */
function AuthorizeDialog({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: ReportPreview
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // **Esc cancels this dialog, not the whole overlay.** The overlay closes on Escape from a window
  // listener; this one runs first (capture) and stops the key there.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])
  const rows: [string, string][] = [
    [t('insights.report.authorize.period'), fmtRange(preview.from, preview.to)],
    [t('insights.report.authorize.projects'), String(preview.projects)],
    [t('insights.report.authorize.messages'), formatNumber(preview.messages)],
    [t('insights.report.authorize.chars'), formatNumber(preview.chars)],
    [t('insights.report.authorize.model'), preview.requestedModel],
  ]
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('insights.report.authorize.title')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-stage/80 p-6"
    >
      <div className="w-full max-w-md border border-hairline bg-shell p-4">
        <h3 className="mb-2 text-sm font-bold text-ink">{t('insights.report.authorize.title')}</h3>
        <p className="mb-3 text-2xs leading-relaxed text-ink-dim">{t('insights.report.authorize.blurb')}</p>
        {/* **以什麼身分執行** —— 委派用的是使用者自己的 claude 登入，shell 環境裡的憑證不會被
            交出去。憑證只存在於環境變數的使用者因此會失敗，而授權畫面是他唯一會停下來讀的地方。 */}
        <p className="mb-3 text-2xs leading-relaxed text-ink-dim">{t('insights.report.authorize.identity')}</p>
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-faint">{label}</dt>
              <dd className="font-mono text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        {preview.truncated ? (
          <p className="mb-3 text-2xs leading-relaxed text-danger">{t('insights.report.authorize.truncated')}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('insights.report.authorize.cancel')}
            className="rounded border border-hairline px-3 py-1 text-xs text-ink-dim hover:text-ink"
          >
            {t('insights.report.authorize.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-label={t('insights.report.authorize.confirm')}
            className="rounded border border-accent bg-accent-soft px-3 py-1 text-xs font-bold text-accent"
          >
            {t('insights.report.authorize.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ReportBody({
  report,
  onBack,
  selectedFrom,
}: {
  report: Report
  onBack: () => void
  selectedFrom: number | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  // 儀表板的範圍與這份報告的期間不同時要看得出來 —— 那是分頁存在的全部理由，
  // 不能只做在版面上而不做在標示上。
  const mismatched = selectedFrom !== undefined && report.from !== null && Math.abs(selectedFrom - report.from) > 86_400_000
  const meta: [string, string][] = [
    [t('insights.report.meta.generatedAt'), formatDateTime(new Date(report.generatedAt))],
    [
      t('insights.report.meta.period'),
      `${fmtRange(report.from, report.to)}${report.truncated ? ` · ${t('insights.report.meta.truncated')}` : ''}`,
    ],
    [t('insights.report.meta.model'), report.requestedModel],
    [
      t('insights.report.meta.corpus'),
      t('insights.report.meta.corpusValue', { messages: report.messages, chars: report.chars }),
    ],
    [
      t('insights.report.meta.discarded'),
      report.discarded === 0
        ? t('insights.report.meta.discardedNone')
        : t('insights.report.meta.discardedValue', { count: report.discarded }),
    ],
    [t('insights.report.meta.cost'), report.costUsd === null ? '—' : `$${report.costUsd.toFixed(4)}`],
    [
      t('insights.report.meta.delegateRecord'),
      report.delegateRecordDeleted ? t('insights.report.meta.delegateDeleted') : t('insights.report.meta.delegateKept'),
    ],
  ]
  return (
    <section aria-label={t('insights.report.label')} className="mx-auto max-w-4xl">
      <button
        type="button"
        onClick={onBack}
        aria-label={t('insights.report.back')}
        className="mb-3 cursor-pointer text-2xs text-ink-dim hover:text-accent"
      >
        ← {t('insights.report.back')}
      </button>

      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-hairline pb-3 text-2xs">
        {meta.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-faint">{label}</dt>
            <dd className="font-mono text-ink-dim">{value}</dd>
          </div>
        ))}
      </dl>

      {mismatched ? <Note text={t('insights.report.rangeNote', { period: fmtRange(report.from, report.to) })} /> : null}

      <ul className="flex flex-col">
        {report.claims.map((claim, i) => (
          <li key={`${claim.quote}-${i}`} className="border-b border-hairline py-3 last:border-b-0">
            <p className="text-xs leading-relaxed text-ink">{claim.claim}</p>
            <p className="mt-1 border-l-2 border-hairline pl-2 font-mono text-2xs text-ink-dim">{claim.quote}</p>
            <p className="mt-1 text-2xs text-ink-faint">
              {claim.date}
              {claim.projectLabel ? ` · ${claim.projectLabel}` : ''} ·{' '}
              {t('insights.report.occurrences', { count: claim.occurrences })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Note({ text, tone }: { text: string; tone?: 'danger' }): React.JSX.Element {
  return (
    <p className={`mb-3 max-w-2xl text-xs leading-relaxed ${tone === 'danger' ? 'text-danger' : 'text-ink-dim'}`}>{text}</p>
  )
}
