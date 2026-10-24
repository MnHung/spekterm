import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, type Language, languageLabel } from '@shared/i18n'
import { DEFAULT_ZOOM, THEMES, type Theme, ZOOM_STEPS } from '@shared/appearance/zoom'
import { usePreferences } from '../../PreferencesProvider'
import { FieldError, HINT_CLASS, INPUT_CLASS, LABEL_CLASS, useWrite } from '../fields'

/**
 * General: the UI language, the theme and the interface zoom (`terminal-preferences`, `ui-appearance`).
 * **No restore here** (`settings-sections` D5): restoring the language to English would leave a reader of
 * another language in an interface they cannot read. Each choice applies when it is made.
 */
export function GeneralSection(): React.JSX.Element {
  const { t } = useTranslation()
  const { language, updateLanguage, theme, updateTheme, zoom, updateZoom } = usePreferences()
  const languageWrite = useWrite()
  const themeWrite = useWrite()
  const zoomWrite = useWrite()
  return (
    <>
      <label className={LABEL_CLASS} htmlFor="settings-language">
        {t('settings.language')}
      </label>
      {/*
        選項的標籤是各語言的**自稱**，且不隨當前 UI 語言改變（`languageLabel` 走 `getFixedT`）——
        一個看不懂當前語言的使用者，必須能在清單裡認出自己的語言。
      */}
      <select
        id="settings-language"
        value={language}
        aria-label={t('settings.language')}
        onChange={(event) => void languageWrite.run(() => updateLanguage(event.target.value as Language))}
        className={`${INPUT_CLASS} block w-full`}
      >
        {SUPPORTED_LANGUAGES.map((code) => (
          <option key={code} value={code}>
            {languageLabel(code)}
          </option>
        ))}
      </select>
      <p className={HINT_CLASS}>{t('settings.languageHint')}</p>
      <FieldError message={languageWrite.failure} />

      <label className={LABEL_CLASS} htmlFor="settings-theme">
        {t('settings.theme')}
      </label>
      <select
        id="settings-theme"
        value={theme}
        aria-label={t('settings.theme')}
        onChange={(event) => void themeWrite.run(() => updateTheme(event.target.value as Theme))}
        className={`${INPUT_CLASS} block w-full`}
      >
        {THEMES.map((value) => (
          <option key={value} value={value}>
            {t(`settings.themeChoice.${value}`)}
          </option>
        ))}
      </select>
      <p className={HINT_CLASS}>{t('settings.themeHint')}</p>
      <FieldError message={themeWrite.failure} />

      <label className={LABEL_CLASS} htmlFor="settings-zoom">
        {t('settings.zoom')}
      </label>
      <select
        id="settings-zoom"
        value={zoom}
        aria-label={t('settings.zoom')}
        onChange={(event) => void zoomWrite.run(() => updateZoom(Number(event.target.value)))}
        className={`${INPUT_CLASS} block w-full`}
      >
        {ZOOM_STEPS.map((step) => (
          <option key={step} value={step}>
            {step === DEFAULT_ZOOM
              ? t('settings.zoomDefault', { percent: step })
              : t('settings.zoomStep', { percent: step })}
          </option>
        ))}
      </select>
      <p className={HINT_CLASS}>{t('settings.zoomHint')}</p>
      <FieldError message={zoomWrite.failure} />
    </>
  )
}
