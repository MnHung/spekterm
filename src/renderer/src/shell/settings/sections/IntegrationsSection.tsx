import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SlackState, SlackTokenKind } from '../../types'
import { decideDraftCommit } from '../commit-field'
import { NumberField, useFieldText } from '../fields'
import { REALTIME_COPY, statusCopy } from '../slack-status'

/**
 * Slack 連線設定 —— Settings' Integrations section (`slack-intake-source`; `settings-sections` design D7). It
 * used to be the inbox's third tab, where each knob followed its own save model. Storage stays its own: the
 * settings file and the secret store, never the preferences.
 *
 * ## 介面上沒有讀取憑證的方法
 *
 * 憑證在 `SlackState` 裡只是 `configured: { appToken: boolean, userToken: boolean }`。
 * 輸入框是**唯寫**的：送出後清空，重新載入時不回填 —— 於是「已設定」這個事實看得到，
 * 值本身連在 DOM 裡都不存在。
 *
 * ## 沒有「要偵測誰」與「哪個工作區」的輸入框
 *
 * 兩者自憑證推導（design D14）。一個填錯的「要偵測誰」，其症狀是**什麼都不會發生** ——
 * 與「沒有人提及我」和「連線已失效」在畫面上完全相同，而讓後兩者可區分正是這條能力花了
 * 一整條 requirement 在做的事。因此這裡只呈現推導出來的身分，不提供編輯。
 *
 * ## 端點非預設值時必須看得見
 *
 * 憑證的目的地是一個資料欄位（使用者的裁決，見 design D11），那個代價只有在他看得見時才可接受
 * —— **一個沉默的端點欄位比沒有這個欄位更糟**。因此非預設值時呈現一段明確的警示文字，
 * 而不只是把值填在輸入框裡。
 */

type SlackWrite = Awaited<ReturnType<Window['workspace']['slack']['setApiBaseUrl']>>

const FIELD_CLASS = 'min-w-0 flex-1 rounded border border-hairline bg-shell px-2 py-1 text-2xs text-ink'
const SMALL_BUTTON_CLASS =
  'shrink-0 rounded px-2 py-1 text-2xs text-ink-dim hover:bg-hairline/40 disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent'

export function IntegrationsSection({ onOpenRoutingRules }: { onOpenRoutingRules: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<SlackState | null>(null)
  const [drafts, setDrafts] = useState<Record<SlackTokenKind, string>>({
    appToken: '',
    userToken: '',
  })
  const [endpointDraft, setEndpointDraft] = useState('')
  const [endpointRefused, setEndpointRefused] = useState(false)
  const [tokenFailed, setTokenFailed] = useState(false)
  const [lookbackText, setLookbackText] = useFieldText(state?.effective.lookbackDays)
  // The routing hint appears only while no fallback is set; the rules can change only in the inbox, which
  // closes Settings, so one read on mount is current.
  const [hasFallback, setHasFallback] = useState<boolean | null>(null)

  const reload = useCallback(() => {
    void window.workspace.slack.get().then(setState)
  }, [])

  useEffect(reload, [reload])

  /**
   * 訂閱狀態改變。
   *
   * **回補在啟動數秒後才跑完** —— 只在掛載時取一次的話，使用者看到的永遠是「還沒檢查過」，
   * 而憑證失效永遠不會出現在畫面上。那條 requirement 會以一個看起來正常的介面失敗，
   * 而這正是 `probe:slack` 抓到的（狀態停在「Set up, but it has not checked yet」）。
   */
  useEffect(() => window.workspace.slack.onChanged(reload), [reload])

  useEffect(() => {
    void window.workspace.intake.rules().then((snapshot) => setHasFallback(snapshot.fallbackFolderId !== null))
  }, [])

  /** A write's answer: the new state, or a failure the section shows (`settings-sections` D4). */
  const settle = (result: SlackWrite): boolean => {
    if (result.ok) setState(result.state)
    return result.ok
  }

  /** A token is stored only through its own Save or Enter, never on blur: a half-pasted secret must not be kept. */
  const applyToken = (kind: SlackTokenKind, value: string | null): void => {
    void window.workspace.slack.setToken(kind, value).then((result) => {
      setTokenFailed(!settle(result))
      // **送出後清空** —— 輸入框是唯寫的，值不留在 DOM 裡。
      if (result.ok) setDrafts((current) => ({ ...current, [kind]: '' }))
    })
  }

  const applyEndpoint = (value: string | null): void => {
    void window.workspace.slack.setApiBaseUrl(value).then((result) => {
      setEndpointRefused(!settle(result))
      if (result.ok) setEndpointDraft('')
    })
  }

  if (state === null) return <p className="text-2xs text-ink-faint">{t('common.loading')}</p>

  const status = statusCopy(state)
  const storedEndpoint = state.usesDefaultEndpoint ? null : state.effective.apiBaseUrl
  const identity =
    state.settings.selfUserId !== undefined && state.settings.teamId !== undefined
      ? t('slack.connectedAs', { user: state.settings.selfUserId, team: state.settings.teamId })
      : t('slack.notConnected')

  return (
    <section className="flex flex-col gap-4" aria-label={t('slack.title')}>
      <div>
        <h4 className="text-xs font-bold text-ink">{t('slack.label')}</h4>
        <p className="mt-1 text-2xs text-ink-dim">{t('slack.description')}</p>
      </div>

      {/* 憑證 —— 唯寫的輸入框，狀態只以「已設定／未設定」呈現。 */}
      <div className="flex flex-col gap-2">
        {(['appToken', 'userToken'] as const).map((kind) => (
          <div key={kind} className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-2xs text-ink">{t(`slack.${kind}`)}</span>
            <span className="w-16 shrink-0 text-2xs text-ink-faint">
              {state.configured[kind] ? t('slack.tokenSet') : t('slack.tokenUnset')}
            </span>
            <input
              type="password"
              value={drafts[kind]}
              placeholder={t('slack.tokenPlaceholder')}
              aria-label={t(`slack.${kind}`)}
              onChange={(event) => setDrafts((current) => ({ ...current, [kind]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && drafts[kind].trim() !== '') applyToken(kind, drafts[kind])
              }}
              className={FIELD_CLASS}
            />
            <button
              type="button"
              aria-label={t('slack.saveToken', { name: t(`slack.${kind}`) })}
              disabled={drafts[kind].trim() === ''}
              onClick={() => applyToken(kind, drafts[kind])}
              className={SMALL_BUTTON_CLASS}
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              aria-label={t('slack.clearToken', { name: t(`slack.${kind}`) })}
              disabled={!state.configured[kind]}
              onClick={() => applyToken(kind, null)}
              className={SMALL_BUTTON_CLASS}
            >
              {t('common.clear')}
            </button>
          </div>
        ))}
        <p className="text-2xs text-ink-faint">{t('slack.tokenHint')}</p>
        {tokenFailed ? (
          <p role="alert" className="text-2xs text-danger">
            {t('settings.writeFailed')}
          </p>
        ) : null}
      </div>

      {/*
        狀態。**「失效」與「目前沒有待處理項目」必須在畫面上不同** —— 兩者在外部本來是同一個
        樣子（收件匣是空的），而使用者分不出來就會在一件已經壞掉的事情上繼續等。
        因此這裡呈現四種情形而不是一個布林，且失效的呈現**恰為一則並帶次數**
        （「而非多則」單獨在零則時也成立，那是一條紅不起來的斷言）。
      */}
      <div className="flex flex-col gap-1" aria-label={t('slack.status')}>
        <span className="text-2xs font-bold text-ink">{t('slack.status')}</span>
        <span className="text-2xs text-ink-dim">{t(status.key, status.options)}</span>
        {state.status.failure !== undefined ? (
          <span className="text-2xs text-ink-faint">
            {t('slack.statusFailureCount', { count: state.status.failure.count })}
          </span>
        ) : null}
        {state.status.deferred > 0 ? (
          <span className="text-2xs text-ink">{t('slack.statusDeferred', { count: state.status.deferred })}</span>
        ) : null}
        {state.status.delivered > 0 ? (
          <span className="text-2xs text-ink-faint">
            {t('slack.statusDelivered', { count: state.status.delivered })}
          </span>
        ) : null}
      </div>

      {/* 即時路徑 —— **它是加速器**，off 與 degraded 必須分得出來（前者沒開，後者壞了）。 */}
      <div className="flex flex-col gap-1" aria-label={t('slack.realtimeLabel')}>
        <span className="text-2xs font-bold text-ink">{t('slack.realtimeLabel')}</span>
        <span className="text-2xs text-ink-dim">{t(REALTIME_COPY[state.status.realtime])}</span>
      </div>

      {/* 身分 —— 推導出來的，沒有輸入框。 */}
      <div className="flex flex-col gap-1">
        <span className="text-2xs font-bold text-ink">{t('slack.identity')}</span>
        <span className="text-2xs text-ink-dim">{identity}</span>
      </div>

      {/* 回看範圍 —— applies on Enter or blur: typing "14" used to store "1" first. */}
      <div className="flex flex-col gap-1">
        <NumberField
          id="slack-lookback"
          label={t('slack.lookback')}
          text={lookbackText}
          onText={setLookbackText}
          stored={state.effective.lookbackDays}
          integer
          min={1}
          max={30}
          placeholder=""
          onCommit={(days) =>
            window.workspace.slack.setLookbackDays(days).then((result) => {
              if (!settle(result)) throw new Error(result.ok ? '' : result.code)
            })
          }
        />
        <span className="text-2xs text-ink-faint">
          {t('slack.lookbackDays', { count: state.effective.lookbackDays })}
        </span>
        <p className="text-2xs text-ink-faint">{t('slack.lookbackHint')}</p>
      </div>

      {/*
        端點。**非預設值時的警示是一條 requirement，不是裝飾。** The field is a draft: empty changes nothing, so
        clicking in and out never resets a custom endpoint; Reset is the way back to the default. An address that
        is not https is refused, and the stored endpoint stays.
      */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="w-32 shrink-0 text-2xs text-ink">{t('slack.endpoint')}</span>
          <input
            type="text"
            value={endpointDraft}
            placeholder={state.effective.apiBaseUrl}
            aria-label={t('slack.endpoint')}
            onChange={(event) => setEndpointDraft(event.target.value)}
            onBlur={() => {
              const decision = decideDraftCommit(endpointDraft, storedEndpoint)
              if (decision.action === 'commit') applyEndpoint(decision.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const decision = decideDraftCommit(endpointDraft, storedEndpoint)
                if (decision.action === 'commit') applyEndpoint(decision.value)
              }
              if (event.key === 'Escape' && endpointDraft !== '') {
                event.stopPropagation()
                setEndpointDraft('')
                setEndpointRefused(false)
              }
            }}
            className={FIELD_CLASS}
          />
          <button
            type="button"
            aria-label={t('slack.resetEndpoint')}
            disabled={state.usesDefaultEndpoint}
            onClick={() => applyEndpoint(null)}
            className={SMALL_BUTTON_CLASS}
          >
            {t('common.reset')}
          </button>
        </div>
        <p className="text-2xs text-ink-faint">
          {state.usesDefaultEndpoint ? t('slack.endpointDefault') : t('slack.endpointCustom')}
        </p>
        <p className="text-2xs text-ink-faint">{t('slack.endpointHint')}</p>
        {endpointRefused ? (
          <p role="alert" className="text-2xs text-danger">
            {t('slack.endpointRefused')}
          </p>
        ) : null}
      </div>

      {/* routing 的 fallback —— 第一次使用時規則多半是空的，而那時每一則提及都解析不出 folder。 */}
      {hasFallback === false ? (
        <div className="flex items-center gap-3 rounded border border-hairline bg-shell px-3 py-2">
          <p className="flex-1 text-2xs text-ink">{t('slack.routingHint')}</p>
          <button type="button" onClick={onOpenRoutingRules} className={SMALL_BUTTON_CLASS}>
            {t('slack.openRoutingRules')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
