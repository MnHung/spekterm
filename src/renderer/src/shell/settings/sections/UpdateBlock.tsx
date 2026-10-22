import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { relativeTime } from '@shared/i18n/locale'
import { usePreferences } from '../../PreferencesProvider'
import { BUTTON_CLASS, FieldError, HINT_CLASS, useWrite } from '../fields'

type UpdateView = NonNullable<Awaited<ReturnType<typeof window.workspace.update.get>>>
type UpdateStatus = UpdateView['status']

/**
 * The update status and controls in About (`app-update`, "Settings shows the update status and the controls").
 *
 * Shown only when the main process checks for updates — a packaged build, or a probe's feed; in development mode
 * `get()` answers `null` and nothing is rendered. Every text is the dictionary's: the main process sends a status and
 * a version, never a release's own words.
 */
export function UpdateBlock(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { autoUpdateCheck, updateAutoUpdateCheck } = usePreferences()
  const [view, setView] = useState<UpdateView | null>(null)
  const autoCheck = useWrite()

  useEffect(() => {
    let live = true
    void window.workspace.update.get().then((next) => {
      if (live) setView(next)
    })
    const off = window.workspace.update.onChanged((next) => setView(next))
    return () => {
      live = false
      off()
    }
  }, [])

  if (!view) return null
  const status = view.status

  return (
    <section role="group" aria-label={t('update.heading')} className="mt-6">
      <h3 className="text-xs text-ink-faint">{t('update.heading')}</h3>
      <StatusLine status={status} />
      {view.lastCheckedAt !== null ? (
        <p className={HINT_CLASS}>{t('update.lastChecked', { when: relativeTime(view.lastCheckedAt) })}</p>
      ) : null}
      {view.lastInstall ? (
        <p className={HINT_CLASS}>
          {view.lastInstall.ok
            ? t('update.lastInstallOk', { version: view.lastInstall.version })
            : t('update.lastInstallFailed', {
                version: view.lastInstall.version,
                reason: t(`update.install.${view.lastInstall.reason ?? 'copy-failed'}`),
              })}
        </p>
      ) : null}

      <div className="mt-2 flex gap-2">
        {status.kind === 'ready' ? (
          <button type="button" className={BUTTON_CLASS} onClick={() => void window.workspace.update.restart()}>
            {t('update.restart')}
          </button>
        ) : status.kind === 'available' ? (
          <button type="button" className={BUTTON_CLASS} onClick={() => void window.workspace.update.openRelease()}>
            {t('update.download')}
          </button>
        ) : null}
        {status.kind !== 'ready' ? (
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={status.kind === 'checking' || status.kind === 'downloading'}
            onClick={() => void window.workspace.update.check()}
          >
            {t('update.checkNow')}
          </button>
        ) : null}
      </div>

      <label className="mt-4 flex items-center gap-2">
        <input
          type="checkbox"
          checked={autoUpdateCheck}
          aria-label={t('update.autoCheck')}
          // `null` = the default (on): turning it back on leaves no `true` in the preferences file.
          onChange={(event) => void autoCheck.run(() => updateAutoUpdateCheck(event.target.checked ? null : false))}
          className="accent-accent"
        />
        <span className="text-sm text-ink">{t('update.autoCheck')}</span>
      </label>
      <p className={HINT_CLASS}>
        {t(view.mode === 'installing' ? 'update.autoCheckHintInstalling' : 'update.autoCheckHintTelling')}
      </p>
      <FieldError message={autoCheck.failure} />
    </section>
  )
}

function StatusLine({ status }: { status: UpdateStatus }): React.JSX.Element {
  const { t } = useTranslation()
  let text: string
  if (status.kind === 'checking') text = t('update.status.checking')
  else if (status.kind === 'up-to-date') text = t('update.status.upToDate')
  else if (status.kind === 'downloading') {
    text = t('update.status.downloading', { version: status.version, percent: status.percent })
  } else if (status.kind === 'ready') text = t('update.status.ready', { version: status.version })
  else if (status.kind === 'available') text = t('update.status.available', { version: status.version })
  else if (status.kind === 'failed') text = t('update.status.failed', { reason: t(FAILURE_KEYS[status.failure]) })
  else text = t('update.status.idle')
  return (
    <p role="status" className="mt-1 text-sm text-ink">
      {text}
    </p>
  )
}

const FAILURE_KEYS = {
  network: 'update.failure.network',
  'rate-limited': 'update.failure.rateLimited',
  'unexpected-answer': 'update.failure.unexpectedAnswer',
  checksum: 'update.failure.checksum',
  other: 'update.failure.other',
} as const satisfies Record<Extract<UpdateStatus, { kind: 'failed' }>['failure'], string>
