import { useTranslation } from 'react-i18next'
import { t as translate } from '@shared/i18n'
import { AUTO_HIBERNATE_PRESETS, DEFAULT_AUTO_HIBERNATE_SECONDS } from '@shared/hibernation/settings'
import { usePreferences } from '../../PreferencesProvider'
import { FieldError, HINT_CLASS, INPUT_CLASS, LABEL_CLASS, RestoreDefaults, useWrite } from '../fields'

/** Agents & sessions: agent status reporting, automatic hibernation, and the agent session view. */
export function AgentsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    agentStatusEnabled,
    updateAgentStatus,
    autoHibernateSeconds,
    updateAutoHibernate,
    agentView,
    updateAgentView,
  } = usePreferences()
  const status = useWrite()
  const hibernate = useWrite()
  const view = useWrite()

  return (
    <>
      {/*
        與 agent 的狀態橋接。**提示文字要說出「只影響其後建立或重建的 session」** —— 注入發生在 spawn 當下，
        少了這句話，使用者切換後看不到變化會以為開關壞了。
      */}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={agentStatusEnabled}
          aria-label={t('settings.agentStatus')}
          onChange={(event) => void status.run(() => updateAgentStatus(event.target.checked ? null : false))}
          className="accent-accent"
        />
        <span className="text-sm text-ink">{t('settings.agentStatus')}</span>
      </label>
      <p className={HINT_CLASS}>{t('settings.agentStatusHint')}</p>
      <FieldError message={status.failure} />

      <label className={LABEL_CLASS} htmlFor="settings-auto-hibernate">
        {t('settings.autoHibernate')}
      </label>
      {/*
        A stored value that is not one of the offered choices (a probe seeds seconds) is listed as itself rather
        than snapped to the nearest choice — otherwise opening Settings would show a choice that is not stored.
      */}
      <select
        id="settings-auto-hibernate"
        value={String(autoHibernateSeconds)}
        aria-label={t('settings.autoHibernate')}
        onChange={(event) => {
          const seconds = Number(event.target.value)
          // The default stays unset in the file, like the switches; anything else is stored.
          void hibernate.run(() => updateAutoHibernate(seconds === DEFAULT_AUTO_HIBERNATE_SECONDS ? null : seconds))
        }}
        className={`${INPUT_CLASS} block w-full`}
      >
        {hibernateChoices(autoHibernateSeconds).map((seconds) => (
          <option key={seconds} value={String(seconds)}>
            {hibernateLabel(seconds)}
          </option>
        ))}
      </select>
      <p className={HINT_CLASS}>{t('settings.autoHibernateHint')}</p>
      <FieldError message={hibernate.failure} />

      {/* The same global preference as the switch beside an agent session's tabs (`agent-conversation-view`). */}
      <fieldset className="mt-4">
        <legend className="text-xs text-ink-faint">{t('settings.agentView')}</legend>
        <div role="radiogroup" aria-label={t('settings.agentView')} className="mt-1 flex gap-4">
          {(['terminal', 'conversation'] as const).map((option) => (
            <label key={option} className="flex items-center gap-2">
              <input
                type="radio"
                name="settings-agent-view"
                value={option}
                checked={agentView === option}
                onChange={() => void view.run(() => updateAgentView(option === 'terminal' ? null : option))}
                className="accent-accent"
              />
              <span className="text-sm text-ink">
                {option === 'terminal' ? t('settings.agentViewTerminal') : t('settings.agentViewConversation')}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className={HINT_CLASS}>{t('settings.agentViewHint')}</p>
      <FieldError message={view.failure} />

      <RestoreDefaults
        onRestore={() =>
          updateAgentStatus(null)
            .then(() => updateAutoHibernate(null))
            .then(() => updateAgentView(null))
        }
      />
    </>
  )
}

/** The offered thresholds, plus the current one when it is not among them. */
function hibernateChoices(current: number): number[] {
  const presets: number[] = [...AUTO_HIBERNATE_PRESETS]
  return presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b)
}

/**
 * "Off", or the threshold in whole days (from two days up), hours, or otherwise seconds — so the offered choices
 * read "24 hours" and "3 days".
 */
function hibernateLabel(seconds: number): string {
  if (seconds === 0) return translate('settings.autoHibernateOff')
  if (seconds >= 2 * 86_400 && seconds % 86_400 === 0) {
    return translate('settings.autoHibernateDays', { count: seconds / 86_400 })
  }
  if (seconds % 3_600 === 0) return translate('settings.autoHibernateHours', { count: seconds / 3_600 })
  return translate('settings.autoHibernateSeconds', { count: seconds })
}
