import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_LANGUAGE, i18n, type Language, setLanguage } from '@shared/i18n'
import { effectiveHibernateSeconds } from '@shared/hibernation/settings'
import { DEFAULT_ZOOM, type Theme } from '@shared/appearance/zoom'
import { createPreferencesQueue } from './preferences-queue'
import type { TerminalPreferences } from './types'

export interface PreferencesApi {
  /** 當前終端偏好。載入完成前為空物件（＝全用預設）。 */
  terminal: TerminalPreferences
  /**
   * Changes part of the terminal font. A field left out keeps its applied value; `null` clears it to the default.
   *
   * The three fields are one write in the main process, so the ones left out are read **when the write runs**,
   * from what the previous write applied (`preferences-queue.ts`). Every update below goes through that queue
   * and rejects when the write fails, leaving the state as it was.
   */
  updateTerminalFont: (change: FontChange) => Promise<void>
  /** 開／關 GPU 加速。`null` ＝回到預設（＝啟用）。同上，呼叫端要 await。 */
  updateGpuAcceleration: (enabled: boolean | null) => Promise<void>
  /**
   * GPU 加速當下是否**應該**啟用 —— **未設定即為啟用**（省略＝預設，與其他偏好同一條規則）。
   *
   * 這是一個衍生值而非另一個 state：把「undefined 代表啟用」這個判斷收在一處，呼叫端就不會
   * 各自寫一次 `?? true`（漏掉一處就是「偏好沒設定時 GPU 沒開」）。
   */
  gpuEnabled: boolean
  /**
   * 開／關與 agent 的狀態橋接。`null` ＝回到預設（＝啟用）。同上，呼叫端要 await。
   *
   * **它只影響其後建立或重建的 session** —— 注入發生在 spawn 當下。這是誠實的限制，
   * 設定介面必須說明，否則使用者會以為這個開關壞了。
   */
  updateAgentStatus: (enabled: boolean | null) => Promise<void>
  /** 狀態橋接當下是否**應該**啟用 —— 未設定即為啟用（同 `gpuEnabled`）。 */
  agentStatusEnabled: boolean
  /** The automatic update check (`app-update`). `null` = the default (on), `false` = off. Callers await it. */
  updateAutoUpdateCheck: (enabled: false | null) => Promise<void>
  /** Whether the update check runs on its own — **unset is on**, the same rule as `gpuEnabled`. */
  autoUpdateCheck: boolean
  /**
   * 切換 agent session 的呈現方式。**這是全域的** —— 切一個，所有 agent session 一起改變。
   *
   * 同上，呼叫端要 await。**此前這是 renderer 的本地 state 更新（同步、不可能失敗）**，
   * 現在是一次 IPC 往返 ＋ 主行程的同步寫檔：多了一種失效方式，被拒絕時畫面靜默地不動。
   */
  updateAgentView: (view: 'terminal' | 'conversation' | null) => Promise<void>
  /**
   * 切換 UI 語言。**它是一次 IPC 往返，且主行程會先套用到它自己的 i18n。**
   *
   * 順序是承重的：反過來的話，套用在主行程失敗的那一刻畫面已是新語言，而原生對話框與
   * 作業系統通知還是舊語言 —— **而那個分岔不會產生任何錯誤**。
   */
  updateLanguage: (language: Language) => Promise<void>
  /** 當前的 UI 語言 —— **未設定即為英文**（同 `gpuEnabled` 那條「把預設收在一處」）。 */
  language: Language
  /**
   * 當前的呈現方式 —— **未設定即為終端**。
   *
   * 與 `gpuEnabled` 同一條理由：把「undefined 代表什麼」收在一處，呼叫端就不會各自寫一次
   * `?? 'terminal'`。漏掉一處的症狀是「偏好設了對話 view，但某個地方還是終端」，
   * 而那不會有任何型別錯誤。
   */
    agentView: 'terminal' | 'conversation'
  /** Automatic hibernation threshold in seconds; `0` = off, `null` = back to the default. Callers await it. */
  updateAutoHibernate: (seconds: number | null) => Promise<void>
  /** The threshold in effect, in seconds — **unset is 24 hours**, `0` is off (one place decides that). */
  autoHibernateSeconds: number
  /**
   * The theme choice (`ui-appearance`); `null` = the default (System). Main applies it before answering.
   * **Colors are never decided from this value** — they follow `prefers-color-scheme` (`useColorScheme`).
   */
  updateTheme: (theme: Theme | null) => Promise<void>
  /** The stored theme choice — **unset is System**. */
  theme: Theme
  /** Set the zoom in percent; `null` = the default (100%). Main snaps and applies it. */
  updateZoom: (percent: number | null) => Promise<void>
  /** Zoom one step in (`1`), out (`-1`) or reset (`0`), from the stored zoom (computed in main). */
  stepZoom: (direction: -1 | 0 | 1) => Promise<void>
  /** The stored zoom in percent — **unset is 100%**. */
  zoom: number
}

export interface FontChange {
  fontFamily?: string | null
  fontSize?: number | null
  lineHeight?: number | null
}

const PreferencesContext = createContext<PreferencesApi | null>(null)

/**
 * 使用者偏好的持有者（終端的字型與 GPU 加速）。
 *
 * **掛在終端掛載之上**（`AppShell` 樹的最外層）—— 偏好是一次非同步 IPC，越早載入，終端越可能在
 * 建立前就拿到偏好，減少「先以預設字型起、偏好到達再套用」的閃動。ActivityBar 的設定介面與所有
 * `TerminalView` 都消費這個 context。
 */
export function PreferencesProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [terminal, setTerminal] = useState<TerminalPreferences>({})
  const queueRef = useRef(createPreferencesQueue<TerminalPreferences>({}, setTerminal))
  const enqueue = queueRef.current.enqueue

  useEffect(() => {
    void window.workspace.settings.get().then((next) => {
      queueRef.current.reset(next)
      setTerminal(next)
      // **renderer 以基準語言初始化，偏好抵達後才切換** —— 因此非英文的使用者會看到一瞬的
      // 英文。這與「先以預設字型起、偏好到達再套用」是同一條先例（見本檔開頭）。
      void setLanguage(next.language ?? DEFAULT_LANGUAGE)
    })
  }, [])

  /**
   * 文件宣告的語言跟著 UI 語言走。
   *
   * `index.html` 的靜態 `lang="en"` 是第一次繪製的值（那一瞬本來就是英文）；這裡在語言
   * 確定之後覆寫它。訂閱 `languageChanged` 而非在切換處各寫一次 —— 語言有兩個改變來源
   *（啟動時套用偏好、使用者切換），漏掉任一個都不會有紅燈。
   */
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.lang = i18n.language || DEFAULT_LANGUAGE
    }
    apply()
    i18n.on('languageChanged', apply)
    return () => i18n.off('languageChanged', apply)
  }, [])

  // 主行程回傳套用後的偏好（已清理／夾制）—— 直接以它更新本地 state，renderer 與磁碟一致。
  const updateTerminalFont = useCallback(
    (change: FontChange) =>
      enqueue((applied) =>
        window.workspace.settings.setTerminalFont(
          'fontFamily' in change ? (change.fontFamily ?? null) : (applied.fontFamily ?? null),
          'fontSize' in change ? (change.fontSize ?? null) : (applied.fontSize ?? null),
          'lineHeight' in change ? (change.lineHeight ?? null) : (applied.lineHeight ?? null),
        ),
      ).then(() => undefined),
    [enqueue],
  )

  const updateGpuAcceleration = useCallback(
    (enabled: boolean | null) =>
      enqueue(() => window.workspace.settings.setGpuAcceleration(enabled)).then(() => undefined),
    [enqueue],
  )

  const updateAgentStatus = useCallback(
    (enabled: boolean | null) =>
      enqueue(() => window.workspace.settings.setAgentStatus(enabled)).then(() => undefined),
    [enqueue],
  )

  const updateAutoUpdateCheck = useCallback(
    (enabled: false | null) =>
      enqueue(() => window.workspace.settings.setAutoUpdateCheck(enabled)).then(() => undefined),
    [enqueue],
  )

  const updateAgentView = useCallback(
    (view: 'terminal' | 'conversation' | null) =>
      enqueue(() => window.workspace.settings.setAgentView(view)).then(() => undefined),
    [enqueue],
  )

  const updateAutoHibernate = useCallback(
    (seconds: number | null) =>
      enqueue(() => window.workspace.settings.setAutoHibernate(seconds)).then(() => undefined),
    [enqueue],
  )

  const updateTheme = useCallback(
    (theme: Theme | null) => enqueue(() => window.workspace.settings.setTheme(theme)).then(() => undefined),
    [enqueue],
  )

  const updateZoom = useCallback(
    (percent: number | null) => enqueue(() => window.workspace.settings.setZoom(percent)).then(() => undefined),
    [enqueue],
  )

  const stepZoom = useCallback(
    (direction: -1 | 0 | 1) =>
      enqueue(() => window.workspace.settings.stepZoom(direction)).then(() => undefined),
    [enqueue],
  )

  const updateLanguage = useCallback(
    (language: Language) =>
      enqueue(async () => {
        const next = await window.workspace.settings.setLanguage(language)
        // 主行程已經套用到它自己的 i18n 了 —— 這一步只讓 renderer 跟上。
        await setLanguage(next.language ?? DEFAULT_LANGUAGE)
        return next
      }).then(() => undefined),
    [enqueue],
  )

  const api = useMemo<PreferencesApi>(
    () => ({
      terminal,
      updateTerminalFont,
      updateGpuAcceleration,
      updateAgentStatus,
            updateAgentView,
      updateLanguage,
      updateAutoHibernate,
      updateAutoUpdateCheck,
      updateTheme,
      updateZoom,
      stepZoom,
      theme: terminal.theme ?? 'system',
      zoom: terminal.zoom ?? DEFAULT_ZOOM,
      autoUpdateCheck: terminal.autoUpdateCheck !== false,
      autoHibernateSeconds: effectiveHibernateSeconds(terminal.autoHibernateSeconds),
      language: terminal.language ?? DEFAULT_LANGUAGE,
      gpuEnabled: terminal.gpuAcceleration ?? true,
      // 未設定＝啟用（與 GPU 加速同一條規則）。
      agentStatusEnabled: terminal.agentStatus !== false,
      // 未設定＝終端（同一條規則，見上方的欄位說明）。
      agentView: terminal.agentView ?? 'terminal',
    }),
    [
      terminal,
      updateTerminalFont,
      updateGpuAcceleration,
      updateAgentStatus,
            updateAgentView,
      updateLanguage,
      updateAutoHibernate,
      updateAutoUpdateCheck,
      updateTheme,
      updateZoom,
      stepZoom,
    ],
  )

  return <PreferencesContext.Provider value={api}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): PreferencesApi {
  const api = useContext(PreferencesContext)
  if (!api) throw new Error('usePreferences must be used inside a PreferencesProvider')
  return api
}
