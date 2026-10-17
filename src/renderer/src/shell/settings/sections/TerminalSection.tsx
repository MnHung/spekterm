import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePreferences } from '../../PreferencesProvider'
import {
  FieldError,
  HINT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  NumberField,
  RestoreDefaults,
  useFieldText,
  useWrite,
} from '../fields'

/**
 * Terminal: font family, size and line height, **the preview directly after them**, and GPU acceleration.
 *
 * Each field applies on its own (`settings-sections` D2). The three font fields are one write in the main process;
 * the provider fills the fields a change leaves out from what the previous write applied, so choosing a family
 * keeps the stored size, never a typed size that has not applied.
 */
export function TerminalSection(): React.JSX.Element {
  const { t } = useTranslation()
  const { terminal, updateTerminalFont, gpuEnabled, updateGpuAcceleration } = usePreferences()
  const [fonts, setFonts] = useState<string[]>([])
  const [sizeText, setSizeText] = useFieldText(terminal.fontSize)
  const [lineHeightText, setLineHeightText] = useFieldText(terminal.lineHeight)
  const family = useWrite()
  const gpu = useWrite()

  useEffect(() => {
    void window.workspace.settings.listMonospaceFonts().then(setFonts)
  }, [])

  const familyValue = terminal.fontFamily ?? ''
  // 目前選定的 family 若不在列舉清單裡（例如在另一台機器設的、或 fc-list 沒抓到），補進去讓它
  // 仍能顯示與保留 —— `<select>` 只能選有列出的選項，漏了就等於把使用者的設定弄丟。
  const familyOptions = familyValue && !fonts.includes(familyValue) ? [familyValue, ...fonts] : fonts

  // 預覽：與終端同一套字型解析（引號包住含空白的名字 + 系統鏈退路），讀的是**輸入中**的大小與行高。
  //
  // **範例刻意不含 box-drawing。** 終端的框線由 GPU renderer 依 cell 邊界程式化繪製、不經字型；
  // 預覽是純 DOM、用的就是字型。留著框線，預覽會顯示終端不會有的縫，使用者將據此去調一個並不存在的問題。
  const previewFamily = familyValue ? `"${familyValue.replaceAll('"', '')}", ui-monospace, monospace` : 'ui-monospace, monospace'
  const parsedSize = Number.parseInt(sizeText, 10)
  const previewSize = Number.isFinite(parsedSize) ? Math.min(32, Math.max(8, parsedSize)) : 15
  const parsedLineHeight = Number.parseFloat(lineHeightText)
  const previewLineHeight = Number.isFinite(parsedLineHeight) ? Math.min(2, Math.max(1, parsedLineHeight)) : 1.0

  return (
    <>
      <label className={LABEL_CLASS} htmlFor="settings-font-family">
        {t('settings.fontFamily')}
      </label>
      <select
        id="settings-font-family"
        value={familyValue}
        aria-label={t('settings.fontFamily')}
        onChange={(event) =>
          void family.run(() => updateTerminalFont({ fontFamily: event.target.value === '' ? null : event.target.value }))
        }
        className={`${INPUT_CLASS} block w-full`}
      >
        <option value="">{t('settings.fontFamilyPlaceholder')}</option>
        {familyOptions.map((font) => (
          <option key={font} value={font}>
            {font}
          </option>
        ))}
      </select>
      <FieldError message={family.failure} />

      <NumberField
        id="settings-font-size"
        label={t('settings.fontSize')}
        text={sizeText}
        onText={setSizeText}
        stored={terminal.fontSize}
        integer
        min={8}
        max={32}
        placeholder={t('settings.fontSizePlaceholder')}
        onCommit={(value) => updateTerminalFont({ fontSize: value })}
      />

      <NumberField
        id="settings-line-height"
        label={t('settings.lineHeight')}
        text={lineHeightText}
        onText={setLineHeightText}
        stored={terminal.lineHeight}
        integer={false}
        min={1}
        max={2}
        step={0.1}
        placeholder={t('settings.lineHeightPlaceholder')}
        onCommit={(value) => updateTerminalFont({ lineHeight: value })}
      />

      <p className={LABEL_CLASS}>{t('settings.preview')}</p>
      <pre
        aria-label={t('settings.preview')}
        className="mt-1 overflow-x-auto whitespace-pre rounded border border-hairline bg-shell px-2 py-2 text-ink"
        style={{ fontFamily: previewFamily, fontSize: `${previewSize}px`, lineHeight: previewLineHeight }}
      >
        {t('settings.previewSample')}
      </pre>

      {/*
        GPU 加速的逃生口。**預設開啟** —— 這裡呈現的是「關掉它」的能力。自動降級只擋得住「渲染資源取不到」；
        擋不住「取得了、但驅動有缺陷而畫出錯的內容」—— 那只有使用者看得出來，也只有他關得掉。
      */}
      <label className="mt-4 flex items-center gap-2">
        <input
          type="checkbox"
          checked={gpuEnabled}
          aria-label={t('settings.gpuAcceleration')}
          // `null` ＝回到預設（＝啟用）—— 沒有關掉它時，不在偏好檔裡留下一個 `true`。
          onChange={(event) => void gpu.run(() => updateGpuAcceleration(event.target.checked ? null : false))}
          className="accent-accent"
        />
        <span className="text-sm text-ink">{t('settings.gpuAcceleration')}</span>
      </label>
      <p className={HINT_CLASS}>{t('settings.gpuAccelerationHint')}</p>
      <FieldError message={gpu.failure} />

      <RestoreDefaults
        onRestore={() =>
          updateTerminalFont({ fontFamily: null, fontSize: null, lineHeight: null }).then(() => updateGpuAcceleration(null))
        }
      />
    </>
  )
}
