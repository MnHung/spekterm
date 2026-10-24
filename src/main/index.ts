import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, powerMonitor, session } from 'electron'
import { DEFAULT_LANGUAGE, i18n, resolveInitialLanguage, setLanguage } from '@shared/i18n'
import { applyContentSecurityPolicy } from './content-security-policy'
import { DirtyStateStore } from './dirty-state'
import { registerAppHandlers } from './ipc/app'
import { registerClipboardHandlers } from './ipc/clipboard'
import { registerConversationHandlers } from './ipc/conversation'
import { registerFsHandlers } from './ipc/fs'
import { registerFolderHandlers } from './ipc/folders'
import { registerIntakeHandlers } from './ipc/intake'
import { registerInsightsHandlers, spawnReportDelegate, spawnScanWorker } from './ipc/insights'
import { registerOpenSpecHandlers } from './ipc/openspec'
import { registerPanelHandlers } from './ipc/panel'
import { broadcastLifecycle, registerHandoffHandlers, registerKeepCloseOffer, revealHandoffBrief } from './ipc/handoff'
import { registerSettingsHandlers } from './ipc/settings'
import { applyTheme, applyZoom, configureAppearance, followZoom, windowBackground } from './appearance'
import { broadcastUpdate, registerUpdateHandlers, sendShowAbout } from './ipc/update'
import { registerSlackHandlers } from './ipc/slack'
import { registerShellHandlers } from './ipc/shell'
import { displayedInFocus, noteWaitBatch, registerWaitHandlers, windowFocused } from './ipc/wait'
import {
  currentRelationsWorld,
  existingTerminalService,
  liveSessionsOf,
  onPtyChange,
  onSessionEnded,
  registerTerminalHandlers,
  remoteTerminalOutput,
  runningAgents,
  setRemoteWatched,
} from './ipc/terminal'
import { broadcastRemoteState, registerRemoteHandlers, requestRenderer } from './ipc/remote'
import { notifyIntakeChanged, onIntakeChanged, onIntakeDismissed } from './intake-changes'
import { RecurrenceKeeper } from './recurrence-keeper'
import { notificationTab } from './recurrence-kind'
import { RecurrenceStore } from './recurrence-store'
import { OpenSpecService } from './openspec-service'
import { AttentionLog } from './remote-attention'
import { createRemoteHost } from './remote-host'
import { RemoteService, resendSessionsOnPrefill } from './remote-service'
import { RemoteStore } from './remote-store'
import { applyNavigationGuards } from './navigation'
import { formatScanSummary, scanRepo } from './openspec'
import { type AskClose, type GuardedWindow, type QuitState, guardWindowClose } from './close-guard'
import { applicationMenuTemplate } from './app-menu'
import { ptyCwdReadable } from './pty-cwd'
import { type WindowPresence, createWindowPresence } from './window-presence'
import { nativeCloseDialog, requestSaveAll } from './close-dialog'
import { createCloseDialogStub, stubCloseRoot } from './close-dialog-stub'
import type { FolderLookup } from './workspace-store'
import { configureAgentEvents } from './agent-events'
import { configureAgentInjection } from './agent-injection'
import { configureAgentOrigin } from './agent-origin'
import { configureAttachments } from './remote-attachments'
import { configureAgentStatus } from './agent-status'
import { contextRoot } from './intake-context'
import { ensureDeliveryRoot } from './intake-archive'
import { COMPLETION_ADAPTER, IntakeNotifier } from './intake-notify'
import { electronNotifyBackend } from './intake-notify-electron'
import { createStubBackend, stubNotifyRoot } from './intake-notify-stub'
import { IntakeService } from './intake-service'
import { IntakeSource, inboxRoot } from './intake-source'
import { configureHandoff, liveSessions } from './handoff-outbox'
import { refreshIntros } from './handoff-injection'
import { refreshRelations } from './handoff-relations'
import { anyWindowReceives, HandoffOpener, OPENER_INTERVAL_MS, whenAnnounced } from './handoff-opener'
import { HandoffService, registerHandoffService } from './handoff-service'
import { HandoffCompletion } from './handoff-completion'
import { inTurnOf, observeWaits, openRequestsOf, pokeWait, refreshWait, subscribeWait } from './agent-wait'
import { hasUnconfirmedSubmission, onPrefillChange } from './intake-prefill'
import { onKeystroke } from './pty-input'
import { isRestored, onRestoreGateOpen, whenRestored } from './restore-gate'
import { SessionControl } from './session-control'
import { cancelCommandEnd, expectCommandEnd, lastProcessChangeAt, runStartedAt } from './session-runs'
import { sessionExists } from '../shared/lineage/existence'
import { configureTicketLineage, handoffTickets, ticketResolutionFor } from './handoff-ticket'
import { ancestryOf } from '../shared/lineage/ancestry'
import { preferredTitle } from '../shared/lineage/label'
import { RoutingStore, routingFile } from './intake-routing'
import { IntakeStore } from './intake-store'
import { PanelStore } from './panel-store'
import { PreferencesStore } from './preferences-store'
import { SecretStore } from './secret-store'
import { type PersistedSession, SessionStore } from './session-store'
import { HANDOFF_ADAPTER } from './handoff-delivery'
import { SlackCursorStore } from './slack-cursor-store'
import { SlackRuntime } from './slack-service'
import { SlackSettingsStore } from './slack-settings-store'
import { createInsightsService } from './insights'
import { configDirs, delegateDirSuffix, resolveArchiveRoot, resolveDelegateCwd, resolveProjectsDir } from './insights-source'
import { createReportService, reportsRoot } from './report'

/** 讀後感請求的模型。報告記錄的是**這個值** —— 實際生效的可能因回退而不同。 */
const REPORT_MODEL = 'claude-sonnet-5'
import { applyUserEnvOnce } from './user-env'
import { WorkspaceStore } from './workspace-store'
import { type UpdateRuntime, startUpdates } from './update-service'
import { openExternalUrl } from './navigation'

const currentDir = dirname(fileURLToPath(import.meta.url))

/** 啟動後多久觸發第一次掃描。夠晚以免與視窗建立搶資源，夠早以免使用者關掉 app 時還沒跑到。 */
const STARTUP_SCAN_DELAY_MS = 5_000

/**
 * How long an agent's session command waits for the window to restore its sessions (`agent-session-control` D9).
 * Bounded: a crashed renderer fires neither `did-navigate` nor `destroyed`.
 */
const COMMAND_GATE_TIMEOUT_MS = 60_000

/**
 * PRD §12 的信任模型。明確寫出而非依賴 Electron 預設值 —— 預設值會隨版本改變，
 * 而 spec 要求「檢查建立視窗時傳入的 webPreferences」時能讀到這兩個值。
 */
const trustModel = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
} as const

/**
 * Set on `before-quit`. A close the user starts comes before any `before-quit`; a quit started by a
 * signal or the OS comes after it — that is how the close guard tells them apart (`close-guard.ts`).
 */
const quitState: QuitState = { quitting: false }

/**
 * The update check of this run (`auto-update`), once `whenReady` has assembled it; `null` before, and in a build
 * that does not check. The close guard reports to its installer who started each close (`CloseOrigin`).
 */
let updates: UpdateRuntime | null = null

app.on('before-quit', () => {
  quitState.quitting = true
})

interface WindowDeps {
  dirty: DirtyStateStore
  store: FolderLookup
  sessions: SessionStore
  /** The acceptance stand-in for the native close dialog; `undefined` = the real one. */
  closeAsk?: AskClose
  /** Told when a window's renderer goes away (destroyed or reloaded), so it must say it is ready again. */
  presence?: WindowPresence
  /** Told the same, for remote watches on that window's sessions (`remote-protocol`). */
  onRendererGone?: () => void
}

/** Each live window's guard, by `webContents.id` — the macOS Quit item asks it to close for a quit. */
const guardedWindows = new Map<number, GuardedWindow>()

/** The live window, if any. Looked up each time: after close → activate, a held reference is stale. */
function liveWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
}

/**
 * The application menu (`app-menu.ts`): none on Linux and Windows, the minimal one on macOS. Set once
 * for the process — **not per window**: a menu set in `createWindow` would be reset by the second window
 * that macOS opens after the first one was closed. Rebuilt when the UI language changes, because the
 * system draws it and its labels come from the dictionaries.
 */
function applyApplicationMenu(): void {
  const template = applicationMenuTemplate({
    platform: process.platform,
    appName: app.getName(),
    onQuit: () => {
      const window = liveWindow()
      const guarded = window ? guardedWindows.get(window.webContents.id) : undefined
      if (guarded) guarded.closeForQuit()
      else app.quit()
    },
  })
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null)
}

function createWindow({ dirty, store, sessions, closeAsk, presence, onRendererGone }: WindowDeps): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // The resolved palette's shell color, so the window does not flash the other palette before the page paints.
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(currentDir, '../preload/index.mjs'),
      ...trustModel,
      // No input shows a spell-check underline. This alone does not stop the dictionary download —
      // that is `setSpellCheckerLanguages([])` in `whenReady`.
      spellcheck: false,
    },
  })

  // 在載入任何內容之前掛上。renderer 從第一幀起就會渲染使用者 repo 裡的不受信任內容。
  applyNavigationGuards(window.webContents)
  // Before loading too: the stored zoom must reach the page's first script (`appearance.ts`).
  followZoom(window.webContents)
  // The one close handler: unsaved changes and running sessions, in one dialog (`close-guard.ts`).
  const contentsId = window.webContents.id
  guardedWindows.set(
    contentsId,
    guardWindowClose(window, {
      dirty,
      liveSessions: (id) => liveSessionsOf(id, store, sessions),
      ask: closeAsk ?? nativeCloseDialog(window),
      saveAll: () => requestSaveAll(window),
      quit: quitState,
      // A close that belongs to a quit finishes the quit once the window is gone — on macOS closing the
      // window alone leaves the application running (`close-guard.ts`).
      onQuitClose: () => window.once('closed', () => app.quit()),
      closeQuitsApp: process.platform !== 'darwin',
      shellsRestartIn: ptyCwdReadable() ? 'lastDirectory' : 'folder',
      onAllowedClose: (origin) => updates?.quitInstaller?.recordOrigin(origin),
    }),
  )

  // 重新載入不會銷毀 webContents，但新頁面沒有任何未存的變更 —— 舊快照必須作廢，
  // 否則關閉時會對著一份不存在的 dirty 集合發問（與 watcher 的釋放同源）。
  window.webContents.on('did-navigate', () => {
    dirty.release(contentsId)
    presence?.rendererGone(contentsId)
    onRendererGone?.()
  })
  window.webContents.once('destroyed', () => {
    dirty.release(contentsId)
    presence?.rendererGone(contentsId)
    guardedWindows.delete(contentsId)
    onRendererGone?.()
  })

  // Turning to a window shows its displayed session: that is looking at it (`session-wait-indicator`).
  window.on('focus', () => windowFocused(window.webContents.id))
  window.on('ready-to-show', () => {
    window.show()
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(currentDir, '../renderer/index.html'))
  }

  return window
}

/**
 * 開發模式的掃描目標。預設掃描 repo 自身 —— 它就是一個含 `openspec/` 的 repo。
 * `SPEKTERM_SCAN_PATH` 可指向任意 repo，供實測其他專案。
 *
 * **這個預設值只在未打包時成立，而擋住它的是呼叫端的 `app.isPackaged` 判斷** ——
 * 打包後 `app.getAppPath()` 指向 asar 內部。今天安全，只因為它不會被呼叫。
 *
 * > 若日後把掃描摘要改成無條件輸出（或把這個函式挪作他用），打包版會去掃 asar 內部的
 * > `openspec/` 並回傳一堆零 —— 而**那看起來像「使用者的 repo 沒有 openspec」**，
 * > 不像一個路徑解析的錯。
 */
function resolveScanTarget(): string {
  return process.env.SPEKTERM_SCAN_PATH ?? app.getAppPath()
}

/**
 * 開發模式下輸出掃描摘要，作為 core 整合的可見驗收依據。
 *
 * 掃描不到 `openspec/` 時 core 回傳空結構而非拋錯，因此路徑給錯只會印出一行零，
 * 不該讓工作台開不起來 —— 這裡的 catch 是為了真正的例外（如權限不足）。
 */
async function logScanSummary(): Promise<void> {
  const target = resolveScanTarget()
  try {
    console.log(formatScanSummary(await scanRepo(target)))
  } catch (error) {
    console.error(`[openspec] scan failed ${target}: ${String(error)}`)
  }
}

/**
 * 使用者互動 shell 的 PATH —— 讓 core spawn 的 `openspec` 在桌面環境啟動時解析得到。
 *
 * **不 await**（實測互動 shell 約 1.3 秒，不該擋住視窗建立）。套用發生在 `user-env.ts` 內部
 * 那個唯一的時點；需要對齊時序的地方 `await whenUserEnvReady()`，它們不負責套用。
 */
void applyUserEnvOnce()

/** 啟動後多久跑第一輪 Slack 回補 —— 不與啟動搶資源。 */
const SLACK_BACKFILL_DELAY_MS = 4000

/**
 * 安裝的 desktop entry 檔名。
 *
 * **實測**：不設 `setDesktopName` 時通知的 `desktop-entry` 提示是 `electron`，與安裝的 entry
 * 對不上 ⇒ 通知拿到 Electron 的預設圖示。而 `agent-intake` 對通知的整條論證建立在
 * 「它看起來像作業系統在替**這個 app** 說話」。
 *
 * 值與 `scripts/lib/desktop-entry.mjs` 的 `ENTRY_NAME` 必須一致 —— 主行程 import 不了
 * `scripts/`（那是建置腳本），因此由 `scripts/desktop-name.test.mjs` 釘住兩者相同。
 */
const DESKTOP_ENTRY_NAME = 'spekterm.desktop'

/**
 * 把主視窗帶到前景。
 *
 * **三個都要**：實測在帶有 window manager 的環境下，單獨 `focus()` 對最小化的視窗
 * 完全無效（`isMinimized()` 維持為真）。
 *
 * **視窗由 `getAllWindows()` 取得而不是持有一份參考** —— `createWindow()` 在這個檔案裡有
 * 兩個呼叫點（`whenReady` 與 `activate`），持有第一個的模組層級參考在 close → activate
 * 之後會指向一個已銷毀的物件。
 */
function bringToFront(): void {
  const window = liveWindow()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * 這一次執行是不是跑在一個**命令列指定的拋棄式 profile** 上。
 *
 * 用途只有一個：決定通知走真實的作業系統，還是走驗收用的替身。
 *
 * **判準不能只是「沒有打包」**：`npm run dev` 也沒有打包，而 dogfood 正是在 dev 裡進行的
 * —— 那時要的是真通知。驗收與 dev 的差別在於**驗收一律以 `--user-data-dir` 指定一個丟完就
 * 刪的 profile**，dev 走的是 `XDG_CONFIG_HOME`。
 *
 * **判準也不能是 `--remote-debugging-port`**：dogfood 期間的效能診斷工具就帶著它。
 *
 * 出貨的產物一律為否（打包之後這條路徑組不出來），因此替身在使用者手上不存在。
 */
function usingThrowawayProfile(): boolean {
  if (app.isPackaged) return false
  return process.argv.some((arg) => arg.startsWith('--user-data-dir='))
}

/**
 * 決定並套用這次啟動的 UI 語言。**必須在建立視窗之前完成** —— 主行程的每一個文案出口
 *（原生對話框、作業系統通知、經 IPC 送達畫面的錯誤）都晚於此。
 *
 * ## 偵測的判準是「偏好檔不存在」，不是「語言欄位未設定」
 *
 * 兩者差在升級路徑上：既有使用者的偏好檔已經存在（裡面有他的字型設定），若以欄位未設定為
 * 判準，**他的 app 會在升級後自己變成作業系統的語言** —— 一次沒有人要求過的行為改變。
 *
 * 而「偏好檔不存在」之所以嚴格等同於「從未啟動過」，靠的是隔離路徑會立刻回寫一份預設檔
 *（見 `PreferencesStore.load()`）。少了那次回寫，「壞過一次偏好檔」也會被當成首次啟動。
 *
 * ## 偵測到的語言**要寫回去**
 *
 * 否則使用者在首次啟動被正確地帶到中文之後，只要他改一次字型（偏好檔因此被寫出、而語言
 * 欄位仍是空的），**下一次啟動就會退回英文** —— 而他從來沒有動過語言。
 *
 * ## 來源是 `getPreferredSystemLanguages()`
 *
 * 它是一個**有序清單**，而我們要回答的正是「第一個我們支援的是哪個」。`getLocale()` 是
 * Chromium 解析後的單一值；`getSystemLocale()` 實測會回 `en-US@posix` 這種帶 modifier 的字串。
 */
async function applyStartupLanguage(preferences: PreferencesStore): Promise<void> {
  const stored = preferences.ui().language
  if (stored) {
    await setLanguage(stored)
    return
  }

  if (preferences.existed()) {
    await setLanguage(DEFAULT_LANGUAGE)
    return
  }

  const detected = resolveInitialLanguage(app.getPreferredSystemLanguages())
  preferences.setLanguage(detected)
  await setLanguage(detected)
}

void app.whenReady().then(async () => {
  // Electron's spell checker downloads a dictionary from a third-party server at startup (measured on
  // Linux: before the window appears, with no input focused), for a feature no part of the app uses.
  // Emptying the languages is what stops it — `spellcheck: false` and `setSpellCheckerEnabled(false)`
  // do not, even in `session-created`. It also stops a profile that registered `en-US` earlier
  // (`workspace-app-shell`; `probe:shell` checks both with a positive control).
  session.defaultSession.setSpellCheckerLanguages([])

  // 通知的應用程式身分 —— 見 `DESKTOP_ENTRY_NAME` 的註解。
  app.setDesktopName?.(DESKTOP_ENTRY_NAME)

  // workspace 設定隨使用者資料目錄走，因此 `--user-data-dir` 可指向暫存 profile，
  // 讓驗收得以反覆重啟應用程式而不污染真實設定。
  const store = new WorkspaceStore(join(app.getPath('userData'), 'workspace.json'))
  store.load()

  // session 的持久化與 workspace 同一個落點，理由也一樣（`--user-data-dir` 可隔離驗收）。
  // 快照另外放一個目錄：它們是每個 session 一個檔的大塊文字，不該讓 sessions.json 這個
  // 每次都整份重寫的小檔跟著漲。
  const sessionStore = new SessionStore(
    join(app.getPath('userData'), 'sessions.json'),
    join(app.getPath('userData'), 'sessions'),
  )
  sessionStore.load()
  // **名字在載入時就決定，不延後到第一次 spawn**（`agent-peer-name`）—— 休眠的母 session 在被
  // 喚醒之前，也要有名字可以告訴它的子 session。既有而尚無名字的 session 於此補上並寫回。
  sessionStore.ensurePeerNames((folderId) =>
    folderId === null ? null : store.list().find((folder) => folder.id === folderId)?.name,
  )
  // A device's attachments (`remote-attachments`): sessions the store no longer has, uploads cut off by the last
  // quit, unsent ones older than a day and anything older than 30 days go before anything reads them.
  const attachments = configureAttachments(app.getPath('userData'))
  attachments.sweep(new Set(sessionStore.view().map(({ session }) => session.id)))

  // 使用者偏好與 workspace 同一個落點，理由也一樣（`--user-data-dir` 可隔離驗收）。
  const preferencesStore = new PreferencesStore(join(app.getPath('userData'), 'preferences.json'))
  preferencesStore.load()
  await applyStartupLanguage(preferencesStore)
  // Before any window: its background and the page's first `prefers-color-scheme` follow the stored theme.
  configureAppearance(preferencesStore)

  // 側欄座標（來源 repo／工作目錄／錨定的 change）。**刻意不與 folder 清單同居於
  // `workspace.json`**：那份檔案的解析是 all-or-nothing，而它損毀的代價是「使用者失去所有 repo」
  // —— 一個偏好性質的欄位不該有機會造成那個結果；而且錨定一次 change 就要重寫一次那份使用者
  // 精心維護的清單（見本 change 的 design D2）。
  const panelStore = new PanelStore(join(app.getPath('userData'), 'panel.json'))
  panelStore.load()

  // agent 狀態橋接的落點（payload 與注入用的 settings 檔）。與偏好同在 userData 之下。
  configureAgentStatus(app.getPath('userData'))
  configureAgentOrigin(app.getPath('userData'))
  configureAgentEvents(app.getPath('userData'))
  configureAgentInjection(app.getPath('userData'))

  // 收件匣：狀態 index、原始投遞的保存處、routing 規則（**本能力自己的檔案，不進 preferences**）。
  const intakeStore = new IntakeStore(join(app.getPath('userData'), 'intake.json'))
  intakeStore.load()
  // **上一次執行接受、而 prompt 尚未送出的，在這裡一次了結**（intake-inbox-usability）。
  // 預填的 prompt 住在 pty 的輸入處，pty 活不過應用程式 —— 被還原的 session 裡已經沒有那一則
  // prompt 可以送出，它們留在收件匣裡只會累積。**必須在任何來源開始投遞之前**：晚了的話，
  // 一則在啟動瞬間到達即接受的交接會被一起了結，本文在使用者看到之前就消失了。
  intakeStore.settleOpened()
  const routingStore = new RoutingStore(routingFile(app.getPath('userData')))
  routingStore.load()
  const intakeService = new IntakeService({
    store: intakeStore,
    archiveRoot: contextRoot(app.getPath('userData')),
  })
  // 單次憑證 → 那一則交接記下的來源（`handoff-lineage` design D2）。**只讀 record 自己的欄位** ——
  // 來源是攝入當下由落點推出的，不是建立 session 時才算。
  configureTicketLineage(({ adapter, id }) => ticketResolutionFor(intakeStore.get(adapter, id)))

  // Slack adapter 的兩份落盤 —— **刻意分成兩份檔案**。連線設定本來就要投影給 renderer
  // （介面要顯示連到哪個工作區、是否已設定、端點是不是預設值），而憑證絕不可以；
  // 放在同一個物件裡，那個投影就直接成了 `secret-scope` 第一條所防的那條出口。
  // 分家之後「把憑證投影出去」需要先跨檔案去拿它 —— 做得到，但不會被不小心做出來。
  const secretStore = new SecretStore(join(app.getPath('userData'), 'secrets.json'))
  secretStore.load()
  const slackSettingsStore = new SlackSettingsStore(join(app.getPath('userData'), 'slack.json'))
  slackSettingsStore.load()
  // 水位是**純粹的最佳化**（design D3(b)）：去重的權威是收件匣自己的紀錄，這份檔案只決定
  // 「要掃多少訊息」。遺失它的代價是多掃一遍，不是重複交付 —— 因此它不做韌性設計。
  const slackCursorStore = new SlackCursorStore(join(app.getPath('userData'), 'slack-cursors.json'))
  slackCursorStore.load()

  // Slack 的執行期。**在註冊 IPC 之前建立** —— 那個 handler 要問它狀態。
  // 它持有的狀態是一條 requirement 的載體：「失效」與「目前沒有待處理項目」必須分得出來，
  // 因為兩者在外部本來是同一個樣子（收件匣是空的）。
  /** 狀態改變的訂閱者 —— IPC 那一層在註冊時掛進來。 */
  const slackStatusListeners = new Set<() => void>()
  const slackRuntime = new SlackRuntime({
    settings: slackSettingsStore,
    secrets: secretStore,
    cursors: slackCursorStore,
    intake: intakeStore,
    onStatusChanged: () => {
      for (const listener of slackStatusListeners) listener()
    },
    inboxRoot: inboxRoot(app.getPath('userData')),
    // 與 `IntakeSource` 的 adapter 同一個值 —— 去重的主鍵是 `(adapter, id)`，
    // 兩邊不一致的話「這個識別碼進來過嗎」永遠答否，而重複交付會靜默地發生。
    inboxAdapter: 'file',
  })

  const dirty = new DirtyStateStore()

  // 在建立視窗、載入任何 renderer 內容之前施加 CSP —— renderer 從第一幀起就會渲染使用者
  // repo 裡的不受信任內容（與 applyNavigationGuards 同屬信任模型的前置防護）。
  // dev／production 政策的切換依「是否載入 Vite dev server」（ELECTRON_RENDERER_URL），**不是**
  // app.isPackaged —— 未打包但載入 file:// build 產物（如 probe 的建置模式）應拿 production 政策，
  // 否則 production 政策永遠不會被任何 probe 覆蓋（見 content-security-policy.ts）。
  applyContentSecurityPolicy(session.defaultSession, Boolean(process.env.ELECTRON_RENDERER_URL))

  registerFolderHandlers(store, panelStore)
  registerFsHandlers(store)
  registerOpenSpecHandlers(store)
  registerShellHandlers()
  // Acting on the window from outside it (`window-presence.ts`). Created here because the renderer-ready
  // IPC is registered here; it only creates a window later, once `windowDeps` below is set.
  let windowDeps: WindowDeps | null = null
  const presence = createWindowPresence({
    existing: () => liveWindow()?.webContents.id ?? null,
    create: () => {
      if (!windowDeps) throw new Error('a window was requested before the window dependencies were set')
      return createWindow(windowDeps).webContents.id
    },
    bringToFront,
  })
  registerAppHandlers(dirty, (contentsId) => presence.rendererReady(contentsId))
  registerConversationHandlers()
  registerTerminalHandlers(store, sessionStore, preferencesStore)
  registerClipboardHandlers()
  // The update check (`app-update`). Its notifications have a backend of their own: a backend holds one activation
  // handler, and the intake's opens the inbox.
  updates = startUpdates({
    packaged: app.isPackaged,
    throwawayProfile: usingThrowawayProfile(),
    userData: app.getPath('userData'),
    version: app.getVersion(),
    preferences: preferencesStore,
    notifyBackend: usingThrowawayProfile()
      ? createStubBackend({ root: join(app.getPath('userData'), 'update-notify-stub') })
      : electronNotifyBackend(),
    onShowAbout: () =>
      void presence.ensure().then(() => {
        const window = liveWindow()
        if (window) sendShowAbout(window)
      }),
    onChange: (view) => broadcastUpdate(view),
  })
  registerUpdateHandlers({
    view: () => updates?.coordinator.view() ?? null,
    check: () => updates?.coordinator.checkNow() ?? Promise.resolve(),
    restart: () => {
      if (!updates?.quitInstaller || !updates.coordinator.ready()) return false
      const window = liveWindow()
      const guarded = window ? guardedWindows.get(window.webContents.id) : undefined
      return guarded ? guarded.closeForRestart() : false
    },
    openRelease: () => {
      const url = updates?.coordinator.releaseUrl()
      if (url) void openExternalUrl(url)
    },
  })
  if (updates) {
    const { coordinator, quitInstaller } = updates
    // The first opening only; the coordinator ignores the later ones (a reload, a new window).
    onRestoreGateOpen(() => coordinator.start())
    powerMonitor.on('resume', () => coordinator.resumed())
    app.on('will-quit', () => {
      coordinator.dispose()
      quitInstaller?.willQuit()
    })
  }
  registerSettingsHandlers(preferencesStore, {
    autoUpdateCheckChanged: () => updates?.coordinator.autoCheckChanged(),
    themeChanged: applyTheme,
    zoomChanged: applyZoom,
  })
  registerSlackHandlers({
    settings: slackSettingsStore,
    secrets: secretStore,
    status: () => slackRuntime.status(),
    onStatusChanged: (notify) => slackStatusListeners.add(notify),
    requestRound: () => void slackRuntime.runRound(),
  })
  registerPanelHandlers(panelStore)
  registerHandoffHandlers(sessionStore)
  /**
   * 通知 —— 決策層在 `intake-notify.ts`，碰作業系統的只有 `intake-notify-electron.ts`。
   *
   * **替身以 `app.isPackaged` 為閘，不用環境變數**：`ptyEnv()` 展開 `process.env`，於是一個
   * 環境變數會進到每一個 pty，而 pty 裡跑的正是被不受信任內容驅動的 agent —— 它寫一個檔案
   * 就能讓視窗搶到前景並打開收件匣。改以 userData 推導路徑之後，出貨的產物裡這條路徑
   * 根本組不出來（探針本來就傳 `--user-data-dir`）。
   */
  const notifyBackend = usingThrowawayProfile()
    ? createStubBackend({ root: stubNotifyRoot(app.getPath('userData')) })
    : electronNotifyBackend()
  const notifier = new IntakeNotifier({ backend: notifyBackend })
  // **接在到達上，不是接在「有東西變了」或 `DeliverOutcome.notify` 上** —— 後兩者會讓
  // 每一次拒絕跳一則桌面通知、每一則真正進來的都不跳（見 `intake-service.ts` 的 `onArrival`）。
  // Through `whenAnnounced`: a scheduled handoff is announced when it opens, not when it is scheduled.
  intakeService.onArrival(whenAnnounced((record) => notifier.arrived(record)))
  /**
   * **永久性失敗也要讓使用者知道** —— 「被拒絕的投遞不發通知」那條規則明文的例外，
   * 其適用範圍由 adapter 自己決定（`IntakeSource` 的 `notifyFailures`）。
   *
   * 接在這裡而不是 `DeliverOutcome.notify` 上：那個旗標對**暫時性**的拒絕同樣為真，
   * 而一份還沒寫完的投遞會在每次補寫時再被讀到 —— 逐次通知沒有上界。
   */
  intakeService.onFailure((failure) => notifier.failed(failure))

  let openInbox: ((tab?: 'inbox' | 'schedules') => void) | null = null
  let requestAutoAccept: ((adapter: string, id: string, folderId: string) => void) | null = null
  let focusSession: ((sessionId: string) => void) | null = null
  let receivers: () => number[] = () => []
  // Created below, once the folder list and preferences it reads are wired; the handlers only reach it later.
  let opener: HandoffOpener | null = null
  /**
   * Repeating handoffs (`recurring-handoff`): the approved recurrences, and the one owner of their upcoming
   * occurrences. Every path that can change one reaches the keeper: the opener's tick and firing, approval, Run now,
   * an accept, and an ignore from either side (`onIntakeDismissed`).
   */
  const recurrenceStore = new RecurrenceStore(join(app.getPath('userData'), 'handoff-recurrences.json'))
  recurrenceStore.load()
  const recurrenceKeeper = new RecurrenceKeeper({
    service: intakeService,
    recurrences: recurrenceStore,
    candidates: () => store.list().map((folder) => ({ id: folder.id, name: folder.name, path: folder.path })),
    opening: (adapter, id) => handoffTickets.isLive(adapter, id) || (opener?.wasRequested(adapter, id) ?? false),
    changed: notifyIntakeChanged,
  })
  recurrenceKeeper.ensureAll()
  onIntakeDismissed((adapter, id) => recurrenceKeeper.afterDismiss(adapter, id))
  registerIntakeHandlers({
    service: intakeService,
    routing: routingStore,
    folders: store,
    contextRoot: contextRoot(app.getPath('userData')),
    // 未設定＝啟用（與 gpuAcceleration 同一條規則）。
    agentEventsEnabled: () => preferencesStore.get().agentEvents !== false,
    onInboxOpened: () => notifier.inboxOpened(),
    registerOpenInbox: (open) => { openInbox = open },
    registerAutoAccept: (request) => { requestAutoAccept = request },
    registerFocusSession: (focus) => { focusSession = focus },
    registerReceivers: (list) => { receivers = list },
    onNewReceiver: () => opener?.tick(),
    runNow: (adapter, id) => opener?.runNow(adapter, id) ?? false,
    recurrences: recurrenceKeeper,
  })

  /**
   * 觸發一則通知 —— **目的地在觸發的當下才決定**。
   *
   * 呈現與觸發之間隔著使用者的時間，項目的狀態在那段時間內會改變（一則交接到達時是待處理，
   * renderer 建好 session 之後才轉為已接受）。因此通知帶的是主鍵，這裡才查狀態。
   *
   * - **恰一則、已接受、且它建立的 session 還在** ⇒ 聚焦那個 session。它在收件匣裡沒有任何
   *   待辦動作；送使用者去收件匣等於要他再點一次。
   * - **其餘一律打開收件匣** —— 包含合併的那一則（它只陳述數量，使用者無從得知涵蓋了什麼；
   *   若其中有待處理項，把他送去一個 session 會讓那些項目從這條通道上消失），以及
   *   **該 session 已被關閉**的情形（SHALL NOT 重建它）。
   *
   * **永久性失敗不是待處理項，它根本沒有主鍵** —— 批次裡有任何一則時，`IntakeNotifier`
   * 就不提供主鍵（見它的 `#flush`），於是這裡一律落在「打開收件匣」那一側。少了那一步，
   * 「一則成功交接 ＋ 一則失敗」落在同一個窗裡會讓主鍵數恰好是 1，使用者被送去那個
   * session，而**那則失敗從這條通道上消失**。
   */
  notifyBackend.onActivate((keys) => {
    // On macOS there may be no window at all (closing it leaves the application running): open one and
    // act once its renderer can hear — otherwise the click does nothing (`window-presence.ts`).
    void presence.ensure().then(() => actOnNotification(keys))
  })

  const actOnNotification = (keys: readonly { adapter: string; id: string }[]): void => {
    // **完成通知**（`handoff-completion`）：帶使用者去那個子 session 的交接單。它不是 intake，
    // 不查收件匣；session 已不存在時 renderer 那一側是無操作。
    if (keys.length === 1 && keys[0].adapter === COMPLETION_ADAPTER) {
      revealHandoffBrief(keys[0].id)
      return
    }
    const single = keys.length === 1 ? intakeService.store.get(keys[0].adapter, keys[0].id) : undefined
    const sessionId = single?.state === 'accepted' ? single.sessionId : undefined
    // **「那個 session 還在不在」由 renderer 判定，不在這裡判。**
    //
    // session 清單的權威在 renderer，而主行程這一份是它**去抖動地**落盤的副本 ——
    // 以它為閘會在「剛建好、還沒落盤」的窗口裡誤判成不存在，而症狀是通知偶爾改去打開收件匣
    // （實測三次有一次）。renderer 那側已經有一道「找不到就什麼都不做」，那才是對的位置。
    if (sessionId) focusSession?.(sessionId)
    // Only proposals ⇒ the Schedules tab, where they are approved (`recurring-handoff`).
    else openInbox?.(notificationTab(keys, (adapter, id) => intakeStore.get(adapter, id)))
  }

  const insights = createInsightsService({
    projectsDir: () => resolveProjectsDir(),
    archiveRoot: () => resolveArchiveRoot(app.getPath('userData')),
    excludeDirSuffix: () => delegateDirSuffix(),
    spawn: spawnScanWorker,
  })
  const reports = createReportService({
    archiveRoot: () => resolveArchiveRoot(app.getPath('userData')),
    configDir: () => configDirs(),
    delegateCwd: () => resolveDelegateCwd(app.getPath('userData')),
    reportsDir: () => reportsRoot(app.getPath('userData')),
    requestedModel: () => REPORT_MODEL,
    // **`configDir` 由 `report.ts` 解析一次後傳進來**，這裡不再自己求值 ——
    // 「委派寫紀錄的位置」與「我們刪紀錄的位置」必須同源。
    spawn: ({ configDir }) =>
      spawnReportDelegate({ cwd: resolveDelegateCwd(app.getPath('userData')), model: REPORT_MODEL, configDir }),
  })
  registerInsightsHandlers(insights, reports)

  // The close confirmation's acceptance stand-in — same gate as the notification stub above.
  const closeAsk = usingThrowawayProfile()
    ? createCloseDialogStub({
        root: stubCloseRoot(app.getPath('userData')),
        closeWindow: () => BrowserWindow.getAllWindows()[0]?.close(),
      }).ask
    : undefined

  applyApplicationMenu()
  i18n.on('languageChanged', applyApplicationMenu)

  /**
   * Remote access (`remote-access`, `remote-protocol`, `remote-notifications`). Off unless the user turned it
   * on; then it listens after the window exists, as Slack starts after it. Everything it does to sessions goes
   * through the window's renderer (`ipc/remote.ts`), and it opens no window of its own.
   */
  const remoteStore = new RemoteStore(join(app.getPath('userData'), 'remote.json'), secretStore)
  remoteStore.load()
  const remoteAttention = new AttentionLog({
    now: Date.now,
    sessionInfo: (sessionId) => {
      const session = sessionStore.view().find((entry) => entry.session.id === sessionId)?.session
      if (!session) return null
      const folder = session.folderId === null ? undefined : store.list().find((f) => f.id === session.folderId)
      return {
        folderName: session.folderId === null ? null : (folder?.name ?? null),
        title: preferredTitle(session) ?? `${session.spawnTarget} ${session.ordinal}`,
      }
    },
    // The session the user is looking at: displayed in the window that has focus. The seen mark asks the same
    // question (`looked-at.ts`), plus a device's conversation watch, which `suppressed` leaves out.
    displayedInFocus,
  })
  let remoteOpenSpec: OpenSpecService | null = null
  const remoteService = new RemoteService({
    store: remoteStore,
    output: remoteTerminalOutput,
    attention: remoteAttention,
    serverInfo: () => ({ name: 'spekterm', version: app.getVersion() }),
    onStateChanged: () => broadcastRemoteState(remoteService),
    host: createRemoteHost({
      window: () => liveWindow()?.webContents.id ?? null,
      folders: store,
      sessions: sessionStore,
      terminal: existingTerminalService,
      output: remoteTerminalOutput,
      intake: intakeService,
      routing: routingStore,
      // Its own instance, so a phone's reads never touch the side panel's watches; read-only. Its changes reach the
      // devices watching that folder (`openspec.watch`, `remote-openspec-browse` D5).
      openspec: () =>
        (remoteOpenSpec ??= new OpenSpecService(store, (folderId) => remoteService.openspecChanged(folderId))),
      attention: remoteAttention,
      request: requestRenderer,
      setRemoteWatched,
      attachments,
      // `sessionControl` is built below in this same synchronous run, before any device can connect or a list be
      // sent; a call that came earlier would throw, not read an empty record (`remote-close-offer` D2).
      offers: {
        offered: (sessionId) => sessionControl.isOffered(sessionId),
        withdraw: (sessionId) => sessionControl.withdraw(sessionId),
      },
    }),
  })
  registerRemoteHandlers(remoteService)
  remoteStore.subscribe(() => {
    if (remoteStore.get().enabled || !remoteOpenSpec) return
    void remoteOpenSpec.dispose()
    remoteOpenSpec = null
  })
  // Every drained batch of every session: attention events, and the session list's wait states.
  observeWaits((sessionId, snapshot, previous) => {
    // The seen mark first, so an unseen turn end reaches the window and the lists in this same tick.
    noteWaitBatch(sessionId, snapshot)
    remoteAttention.onWait(sessionId, snapshot)
    // A subagent's stop moves no wait state but can change the background tasks (`remote-background-tasks` D6).
    if (snapshot.state !== previous || snapshot.backgroundChanged) remoteService.listChanged('sessions')
  })
  // A key typed into a session with an open prompt makes that prompt unanswerable from a device, with no agent
  // event to say so: tell its followers now (`remote-protocol`).
  onKeystroke((sessionId) => {
    if (openRequestsOf(sessionId).length > 0) pokeWait(sessionId)
  })
  intakeService.onArrival(whenAnnounced((record) => remoteAttention.onIntake(record)))
  onIntakeChanged(() => remoteService.listChanged('inbox'))
  resendSessionsOnPrefill({ onPrefillChange, onKeystroke, onIntakeChanged, hasPrefill: hasUnconfirmedSubmission }, (kind) =>
    remoteService.listChanged(kind),
  )
  sessionStore.subscribe(() => remoteService.listChanged('sessions'))
  onPtyChange(() => remoteService.listChanged('sessions'))
  onSessionEnded((sessionId, how) => remoteService.sessionEnded(sessionId, how))
  store.subscribe(() => remoteService.listChanged('sessions'))
  // A folder that leaves the workspace stops being watched for devices too, and a pending `openspec.changed` for it
  // is dropped. The store tells no difference (it fires on every save), so the previous ids are kept here.
  let remoteFolderIds = new Set(store.list().map((folder) => folder.id))
  store.subscribe(() => {
    const ids = new Set(store.list().map((folder) => folder.id))
    for (const id of remoteFolderIds) {
      if (ids.has(id)) continue
      remoteService.openspecReleased(id)
      if (remoteOpenSpec) void remoteOpenSpec.releaseFolder(id)
    }
    remoteFolderIds = ids
  })
  app.on('will-quit', () => {
    void remoteService.stop()
  })

  windowDeps = {
    dirty,
    store,
    sessions: sessionStore,
    closeAsk,
    presence,
    onRendererGone: () => remoteService.windowGone(),
  }
  createWindow(windowDeps)
  void remoteService.apply().catch((error) => {
    console.error(`[remote] failed to start: ${String(error)}`)
  })

  /**
   * 檔案落點：**mkdir → 建立監看並等它就緒 → 掃描既有內容**。
   *
   * 掃描不是優化 —— `createWatcher` 的 `ignoreInitial: true` 寫死且不可覆寫，於是
   * 「app 關著的時候投遞」（正是外部 producer 存在的理由）的東西只有掃描看得到。
   */
  const intakeSource = new IntakeSource({
    root: inboxRoot(app.getPath('userData')),
    adapter: 'file',
    service: intakeService,
  })
  void ensureDeliveryRoot(contextRoot(app.getPath('userData')))
    .then(() => intakeSource.start())
    .catch((error) => {
      console.error(`[intake] failed to start inbox: ${String(error)}`)
    })

  /**
   * 交接 —— 收件匣的第二個 producer。
   *
   * 它與共用落點**共用同一份落點實作**（`IntakeSource`），差別只在 `depth` 與 `deliver`：
   * 交接的落點是每個 session 一層，而它的來源與目標是**投遞內容表達不出來**的東西，
   * 只能經參數供應。
   */
  configureHandoff(app.getPath('userData'))
  const nameOf = (sessionId: string): string | undefined =>
    sessionStore.view().find((entry) => entry.session.id === sessionId)?.session.peerName
  /**
   * 完成報告與生命週期（`handoff-completion`）。**只保存、不傳遞** —— 結果由子 agent 自己以訊息送給
   * 母 session。狀態改變時重算關係檔並推給 renderer（`onChange` 在下面接上，它要 `refreshAllRelations`）。
   */
  let onCompletionChange: ((sessionId: string) => void) | null = null
  const completion = new HandoffCompletion({
    sessions: sessionStore,
    subscribe: subscribeWait,
    onChange: (sessionId) => onCompletionChange?.(sessionId),
    // 完成的那一刻告訴使用者（`handoff-completion`）—— 與收件匣的通知共用同一個窗與上界。
    onReported: (sessionId, title, summary) => {
      notifier.completed(sessionId, title, summary)
      remoteAttention.onReported(sessionId, title, summary)
    },
  })
  /**
   * An agent's session commands (`agent-session-control`). Existence is the relations file's rule
   * (`sessionExists` over the same world), so "listed in the tree" and "may be commanded" cannot come apart.
   */
  const commandWorld = (): { session: PersistedSession; exists: boolean }[] => {
    const world = currentRelationsWorld(store, sessionStore)
    const folders = new Set(world.folders.map((folder) => folder.id))
    return world.view.map((entry) => ({
      session: entry.session,
      exists: sessionExists({
        inList: true,
        exited: false,
        folderInWorkspace: entry.session.folderId === null || folders.has(entry.session.folderId),
        provisional: entry.provisional,
        ptyAlive: world.running.has(entry.session.id),
      }),
    }))
  }
  const sessionControl = new SessionControl({
    sessions: commandWorld,
    running: (sessionId) => runningAgents().includes(sessionId),
    refreshWait: (sessionId) => void refreshWait(sessionId),
    inTurn: (sessionId) => inTurnOf(sessionId),
    subscribeWait: (sessionId, listener) => subscribeWait(sessionId, () => listener()),
    onKeystroke,
    agentEventsEnabled: () => preferencesStore.get().agentEvents !== false,
    runs: { runStartedAt, lastProcessChangeAt, expectCommandEnd, cancelCommandEnd },
    whenReady: async () => {
      const window = liveWindow()
      if (!window) return 'no-window'
      return (await whenRestored(window.webContents.id, COMMAND_GATE_TIMEOUT_MS)) ? 'ready' : 'timeout'
    },
    request: (action) => {
      const window = liveWindow()
      return window ? requestRenderer(window.webContents.id, action) : Promise.resolve({ ok: false, code: 'NO_WINDOW' })
    },
    describe: (sessionId) => {
      const session = commandWorld().find((entry) => entry.exists && entry.session.id === sessionId)?.session
      if (!session) return null
      const item = session.folderId === null ? 'Global' : (store.list().find((f) => f.id === session.folderId)?.name ?? '')
      const label = preferredTitle(session) ?? session.peerName
      return label ? `${item} · ${label}` : item
    },
    reject: (code, label, detail, failure) => intakeService.reject(code, label, detail, { adapter: HANDOFF_ADAPTER, ...failure }),
    reportFailure: (code, detail, failure) =>
      intakeService.reportFailure({ code, ...(detail === undefined ? {} : { detail }), ...failure, at: Date.now() }),
    // Devices read offers from the session list, and nothing else announces one (`remote-close-offer` D1).
    offersChanged: () => remoteService.listChanged('sessions'),
  })
  registerKeepCloseOffer((sessionId) => void sessionControl.withdraw(sessionId))
  // A waiting command dies with its target's process, whatever ended it (D3).
  onPtyChange(() => {
    const running = new Set(runningAgents())
    for (const sessionId of sessionControl.pendingTargets()) if (!running.has(sessionId)) sessionControl.processEnded(sessionId)
  })

  const handoffService = new HandoffService({
    service: intakeService,
    sourceOf: (sessionId) => {
      // **含暫定紀錄** —— 母 session 剛建好、renderer 還沒把它送來持久化的那 ~500ms 裡，它只在
      // 暫定紀錄中。只查 `get()` 的話，那段時間裡投遞的交接會把來源記成「已結束」（探針抓到：
      // 同 folder 的交接其來源的歸屬是 unknown）。
      const session = sessionStore.view().find((entry) => entry.session.id === sessionId)?.session
      if (!session) return null
      const folder = session.folderId === null ? null : store.list().find((f) => f.id === session.folderId)
      // 與分頁、關係檔同一個取用順序（`preferredTitle`）—— 子 session 再交接時，「← 來源」說的是交接標題。
      const title = preferredTitle(session)
      // Over **every** record, provisional ones included (`agent-session-control` D4): existence filters what is
      // shown and targeted, never the walk.
      const records = new Map(sessionStore.view().map((entry) => [entry.session.id, entry.session]))
      const ancestors = ancestryOf(sessionId, (id) => records.get(id))
      return {
        folderId: session.folderId,
        label: session.folderId === null ? 'Global' : (folder?.name ?? session.folderId),
        ...(title ? { title } : {}),
        ...(ancestors.length > 0 ? { ancestors } : {}),
      }
    },
    // **與自我介紹的清單同源** —— 分成兩份的話，agent 手上的選項與接收端認得的選項會分岔。
    candidates: () => store.list().map((folder) => ({ id: folder.id, name: folder.name, path: folder.path })),
    agentEventsEnabled: () => preferencesStore.get().agentEvents !== false,
    onDelivered: () => opener?.tick(),
    acceptReport: (sessionId, summary, identity) => completion.acceptReport(sessionId, summary, identity),
    control: (sourceId, kind, contents, identity, mtimeMs) => sessionControl.deliver(sourceId, kind, contents, identity, mtimeMs),
  })
  /**
   * Every automatic handoff opening (`scheduled-handoff`, design D3). "A window can receive" is one window that
   * both lists the inbox and has restored its sessions; the two come in either order, so both tick.
   */
  opener = new HandoffOpener({
    service: intakeService,
    candidates: () => store.list().map((folder) => ({ id: folder.id, name: folder.name, path: folder.path })),
    agentEventsEnabled: () => preferencesStore.get().agentEvents !== false,
    canReceive: () => anyWindowReceives(receivers(), isRestored),
    requestOpen: (adapter, id, folderId) => requestAutoAccept?.(adapter, id, folderId),
    changed: notifyIntakeChanged,
    keeper: recurrenceKeeper,
  })
  onRestoreGateOpen(() => opener?.tick())
  const openerTimer = setInterval(() => opener?.tick(), OPENER_INTERVAL_MS)
  // Wall-clock due times: after a sleep the first tick opens what fell due meanwhile.
  powerMonitor.on('resume', () => opener?.tick())
  app.on('will-quit', () => clearInterval(openerTimer))

  registerHandoffService(handoffService)
  void handoffService.start().catch((error) => {
    console.error(`[handoff] failed to start: ${String(error)}`)
  })

  /**
   * folder 清單變動時重寫每一個活著的 session 的自我介紹。
   *
   * **少了它，「清單取當下的值」只在 spawn 那一刻成立** —— hook 會在續接、壓縮、清除時重跑，
   * 那些時刻讀到的就是一份過期的清單，而失效是靜默的（agent 交接給一個剛被移除的 repo，
   * 得到一次它看不到的拒絕）。
   */
  store.subscribe(() => {
    // 由交接建立的 session 要保有完成回報那一段 —— 查含暫定紀錄的視圖（剛建好的子 session 還只在那裡）。
    refreshIntros(liveSessions(), store.list(), nameOf, (sessionId) =>
      sessionStore.view().some((entry) => entry.session.id === sessionId && entry.session.lineage !== undefined),
    )
  })

  /**
   * 關係檔的**單一觸發點**（`handoff-lineage` design D6）：session 清單（含暫定紀錄、標籤）、pty 的
   * 誕生與結束、folder 清單 —— 任何一個變了就整份重算，只寫有變的檔。
   */
  const refreshAllRelations = (): void =>
    refreshRelations({
      ...currentRelationsWorld(store, sessionStore),
      agents: runningAgents(),
    })
  sessionStore.subscribe(refreshAllRelations)
  onPtyChange(refreshAllRelations)
  store.subscribe(refreshAllRelations)

  /**
   * 生命週期的訂閱**跟著 pty 走**：pty 在就追蹤，不在就退掉（`clearWait` 會連計時器一起清）。
   * 以 pty 集合的變動為觸發點，與關係檔同一個訊號 —— 喚醒與新建都會經過它。
   */
  const trackCompletion = (): void => {
    const running = new Set(runningAgents())
    for (const { session } of sessionStore.view()) {
      if (running.has(session.id)) completion.track(session.id)
      else completion.untrack(session.id)
    }
  }
  onPtyChange(trackCompletion)
  // 生命週期的呈現狀態是關係的一部分（`session-lineage`）；也要推給畫面（`handoff-completion`）。
  const lifecycleChanged = (): void => {
    refreshAllRelations()
    broadcastLifecycle()
    remoteService.listChanged('handoffs')
    remoteService.listChanged('sessions')
  }
  onCompletionChange = lifecycleChanged
  /**
   * Every running agent session's attention for the window's dots (`session-wait-indicator`). A handoff session's
   * lifecycle reads the same seen mark, so a change there takes the lifecycle's path. It runs after the wait
   * subscribers — `HandoffCompletion` among them wrote the relations with the mark's old value this tick.
   */
  registerWaitHandlers({
    sessions: sessionStore,
    lineageChanged: lifecycleChanged,
    remoteChanged: () => remoteService.listChanged('sessions'),
  })

  /**
   * 啟動後跑一輪 Slack 的回補。
   *
   * **這是本能力的主幹，不是加速器**（design D1）：桌面應用程式大多數時間是關著的，而 Slack 的
   * 即時通道沒有重送佇列 —— 以即時為主等於把最常見的情形（關機八小時）交給一個補不了的機制。
   *
   * **不 await** —— 它不得阻塞啟動。因此它也不得拋錯：`runSlackRound` 以回傳值呈現失敗，
   * 一個漏出去的 rejection 在主行程裡是致命的（主行程一死，所有 pty 陪葬）。
   * 延遲觸發是為了不與啟動搶資源，比照上面那趟對話存檔的掃描。
   */
  setTimeout(() => {
    // `start()` 立刻跑第一輪，並開始週期輪詢。
    // **週期輪詢不是備援** —— 即時路徑是加速器且可能根本不可用（design D1），
    // 而少了它這個能力只在啟動的那一刻有效（實測踩過）。
    slackRuntime.start()
  }, SLACK_BACKFILL_DELAY_MS)

  /**
   * 啟動後跑一趟增量掃描 —— **與使用者要不要看無關**。
   *
   * 來源的保留期是 30 天。只在使用者開啟呈現介面時掃的話，他一個月沒開過，那一個月的來源就
   * 已經被刪掉了，而存檔裡永遠不會有它 —— **那正是這個能力要解決的問題本身**。
   *
   * 延遲觸發是為了不與啟動搶資源；掃描本身跑在獨立行程裡，不影響互動。
   */
  setTimeout(() => {
    void insights.refresh().catch(() => {
      // 失敗的狀態由 service 自己記著（renderer 問得到）。這裡不需要也不該有文案。
    })
  }, STARTUP_SCAN_DELAY_MS)

  // 未打包的執行一律視為開發模式（`electron-vite dev` 與直接 `electron .` 皆涵蓋）。
  if (!app.isPackaged) {
    void logScanSummary()
  }

  // macOS: activating the application with no window (the Dock icon, opening it again) reopens it; the
  // renderer restores the sessions as dormant, as after a restart (`workspace-app-shell`).
  app.on('activate', () => {
    if (!liveWindow() && windowDeps) createWindow(windowDeps)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
