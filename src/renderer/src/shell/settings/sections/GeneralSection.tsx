import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, type Language, languageLabel } from '@shared/i18n'
import { usePreferences } from '../../PreferencesProvider'
import { FieldError, HINT_CLASS, INPUT_CLASS, LABEL_CLASS, useWrite } from '../fields'

/**
 * General: the UI language. **No restore here** (`settings-sections` D5): restoring the language to English
 * would leave a reader of another language in an interface they cannot read.
 */
export function GeneralSection(): React.JSX.Element {
  const { t } = useTranslation()
  const { language, updateLanguage } = usePreferences()
  const { failure, run } = useWrite()
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
        onChange={(event) => void run(() => updateLanguage(event.target.value as Language))}
        className={`${INPUT_CLASS} block w-full`}
      >
        {SUPPORTED_LANGUAGES.map((code) => (
          <option key={code} value={code}>
            {languageLabel(code)}
          </option>
        ))}
      </select>
      <p className={HINT_CLASS}>{t('settings.languageHint')}</p>
      <FieldError message={failure} />
    </>
  )
}
