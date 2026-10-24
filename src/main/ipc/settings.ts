import { execFile } from 'node:child_process'
import { ipcMain } from 'electron'
import { DEFAULT_LANGUAGE, isSupportedLanguage, setLanguage } from '@shared/i18n'
import { type ProjectedPreferences, projectPreferences } from '../preferences-store'
import type { PreferencesStore } from '../preferences-store'
import { collator } from '@shared/i18n/locale'
import { isTheme } from '@shared/appearance/zoom'

export const SETTINGS_CHANNELS = {
  get: 'workspace:settings:get',
  setTerminalFont: 'workspace:settings:setTerminalFont',
  setGpuAcceleration: 'workspace:settings:setGpuAcceleration',
  setAgentStatus: 'workspace:settings:setAgentStatus',
    setAgentView: 'workspace:settings:setAgentView',
  setAutoHibernate: 'workspace:settings:setAutoHibernate',
  setLanguage: 'workspace:settings:setLanguage',
  setAutoUpdateCheck: 'workspace:settings:setAutoUpdateCheck',
  setTheme: 'workspace:settings:setTheme',
  setZoom: 'workspace:settings:setZoom',
  stepZoom: 'workspace:settings:stepZoom',
  listMonospaceFonts: 'workspace:settings:listMonospaceFonts',
} as const

/** 列舉系統等寬字型時的逾時 —— 這是使用者開設定對話框時的一次性查詢，不該讓它卡住。 */
const LIST_FONTS_TIMEOUT_MS = 3000

/**
 * 系統的等寬字型清單，給設定對話框的下拉選單用（讓使用者從清單挑，不必硬記字型名）。
 *
 * **目前只支援 Linux（fontconfig）**：`fc-list :spacing=100 family` —— `:spacing=100` 正是 fontconfig
 * 的「monospace」判準，直接拿到等寬字，不必自己在 renderer 量測。其他平台回空陣列，設定對話框退回純
 * 輸入（跨平台字型列舉列為 Phase 6，見 design D9）。
 *
 * 這是使用者觸發的一次性動作（開設定），不是每次載入的熱路徑 —— 因此 spawn 一次 `fc-list` 可接受，
 * 與「分支偵測不 spawn git」那條熱路徑紀律不同。fc-list 不存在或失敗時回空陣列（graceful）。
 */
function listMonospaceFonts(): Promise<string[]> {
  if (process.platform !== 'linux') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'fc-list',
      [':spacing=100', 'family'],
      { timeout: LIST_FONTS_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        const families = new Set<string>()
        for (const line of stdout.split('\n')) {
          // 每行可能是逗號分隔的多語系別名（如 `Noto Sans Mono,Noto Sans Mono ...`）—— 取第一個。
          const name = line.split(',')[0].trim()
          if (name) families.add(name)
        }
        resolve([...families].sort((a, b) => collator().compare(a, b)))
      },
    )
  })
}

/**
 * 使用者偏好的讀寫。
 *
 * **值的驗證在 store**（`setTerminalFont` 會清理 family、夾制 size）—— 一個被入侵或有 bug 的
 * renderer 可送出任意型別，store 的 `sanitizeFamily`／`clampSize` 對非字串／非數字皆退回未設定，
 * 因此這裡不需要另做型別 guard。回傳套用後的偏好，讓 renderer 立即以之更新終端。
 *
 * ## 每一條往 renderer 的回傳都經 `projectPreferences`
 *
 * **不可原樣轉手 `store` 的回傳值。** 那個物件是主行程持有的完整偏好，而這裡是它通往 renderer
 * 的唯一出口 —— 原樣轉手的話，任何日後加進偏好的欄位（**包含機密**）都會零改動、零紅燈地送到
 * renderer，而 renderer 渲染的是不受信任的內容。
 *
 * **五個處理常式都要經過它，不只 `get`** —— 四個 setter 同樣把套用後的偏好回傳，漏掉任一個，
 * 那條路就是一個沒有白名單的出口。這條由 `scripts/settings-projection.test.mjs` 守著。
 */
export function registerSettingsHandlers(
  store: PreferencesStore,
  hooks: {
    autoUpdateCheckChanged?: () => void
    /** The theme was stored: main applies it (`nativeTheme.themeSource`, the window background). */
    themeChanged?: () => void
    /** The zoom was stored: main applies it to the window's zoom factor. */
    zoomChanged?: () => void
  } = {},
): void {
  ipcMain.handle(SETTINGS_CHANNELS.get, (): ProjectedPreferences =>
    projectPreferences(store.get(), store.ui(), store.updates()),
  )

  ipcMain.handle(
    SETTINGS_CHANNELS.setTerminalFont,
    (
      _event,
      fontFamily: string | null,
      fontSize: number | null,
      lineHeight: number | null,
    ): ProjectedPreferences =>
      projectPreferences(store.setTerminalFont(fontFamily, fontSize, lineHeight), store.ui(), store.updates()),
  )

  // 值的驗證同樣在 store（只認真正的布林；其餘一律當成未設定＝預設啟用）。
  ipcMain.handle(
    SETTINGS_CHANNELS.setAgentStatus,
    (_event, enabled: unknown): ProjectedPreferences =>
      projectPreferences(store.setAgentStatus(typeof enabled === 'boolean' ? enabled : null), store.ui(), store.updates()),
  )

  // 值的白名單同樣在 store（只認那兩個字面值；其餘一律當成未設定＝預設的終端 view）。
  /**
   * UI 語言。
   *
   * **主行程先套用，再回傳投影 —— 順序是承重的。** 反過來的話，套用在主行程失敗的那一刻
   * 畫面已經是新語言，而原生對話框與作業系統通知還是舊語言，**而那個分岔不會產生任何錯誤**。
   *
   * 值的白名單在 store（`sanitizeLanguage` 只認受支援的語言）。
   */
  ipcMain.handle(
    SETTINGS_CHANNELS.setLanguage,
    async (_event, language: unknown): Promise<ProjectedPreferences> => {
      const applied = store.setLanguage(isSupportedLanguage(language) ? language : null)
      await setLanguage(applied.language ?? DEFAULT_LANGUAGE)
      return projectPreferences(store.get(), applied, store.updates())
    },
  )

  ipcMain.handle(
    SETTINGS_CHANNELS.setAgentView,
    (_event, view: unknown): ProjectedPreferences =>
      projectPreferences(
        store.setAgentView(view === 'terminal' || view === 'conversation' ? view : null),
        store.ui(),
        store.updates(),
      ),
  )

  ipcMain.handle(
    SETTINGS_CHANNELS.setGpuAcceleration,
    (_event, enabled: boolean | null): ProjectedPreferences =>
      projectPreferences(store.setGpuAcceleration(typeof enabled === 'boolean' ? enabled : null), store.ui(), store.updates()),
  )

    // The value's whitelist lives in the store (non-negative whole seconds; anything else resets it).
  ipcMain.handle(
    SETTINGS_CHANNELS.setAutoHibernate,
    (_event, seconds: unknown): ProjectedPreferences =>
      projectPreferences(store.setAutoHibernate(typeof seconds === 'number' ? seconds : null), store.ui(), store.updates()),
  )

  // `app-update`: on is stored as the default (`null`), off as `false`; anything else is the default.
  ipcMain.handle(SETTINGS_CHANNELS.setAutoUpdateCheck, (_event, enabled: unknown): ProjectedPreferences => {
    const projected = projectPreferences(
      store.get(),
      store.ui(),
      store.setAutoUpdateCheck(enabled === false ? false : null),
    )
    hooks.autoUpdateCheckChanged?.()
    return projected
  })

  // `ui-appearance`: the whitelist is the store's (three theme values; zoom snapped to a step). Main applies
  // the value before answering, so the renderer's `prefers-color-scheme` and zoom have already changed.
  ipcMain.handle(SETTINGS_CHANNELS.setTheme, (_event, theme: unknown): ProjectedPreferences => {
    const applied = store.setTheme(isTheme(theme) ? theme : null)
    hooks.themeChanged?.()
    return projectPreferences(store.get(), applied, store.updates())
  })

  ipcMain.handle(SETTINGS_CHANNELS.setZoom, (_event, percent: unknown): ProjectedPreferences => {
    const applied = store.setZoom(typeof percent === 'number' ? percent : null)
    hooks.zoomChanged?.()
    return projectPreferences(store.get(), applied, store.updates())
  })

  // Stepping is computed here, from the stored zoom, so two quick keys never step from the same value.
  ipcMain.handle(SETTINGS_CHANNELS.stepZoom, (_event, direction: unknown): ProjectedPreferences => {
    const applied = store.stepZoom(direction === 1 || direction === -1 ? direction : 0)
    hooks.zoomChanged?.()
    return projectPreferences(store.get(), applied, store.updates())
  })

  ipcMain.handle(SETTINGS_CHANNELS.listMonospaceFonts, (): Promise<string[]> =>
    listMonospaceFonts(),
  )
}
