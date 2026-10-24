import type { GraphData } from '@spekjs/core'
import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron'
import type { DirtyEntry } from '../main/dirty-state'
import type { InsightsSnapshot } from '../main/insights'
import type { GenerateResult, ReportPreview } from '../main/report'
import type { Report, ReportMeta } from '../main/report-store'
import type { FsResult, WriteResponse } from '../main/ipc/fs'
import type { PanelSnapshot } from '../main/panel-store'
import type { FollowUpdate as ConversationUpdate } from '../main/transcript-follow-service'
import type { DrainResult, WaitState } from '../main/agent-events'
import type { SessionLineage } from '../shared/lineage/types'
import type {
  ApproveResult,
  IntakeAcceptResult,
  IntakeRulesSnapshot,
  IntakeSnapshot,
} from '../main/ipc/intake'

/** 等待選擇時「正在被問什麼」。**沒有選項** —— 作答一律回終端 view。 */
type PendingRequest = DrainResult['pending']
import type { RestoredSession } from '../main/ipc/terminal'
import type { HandoffBriefView, LifecycleView } from '../main/ipc/handoff'
import type { AttentionView } from '../main/ipc/wait'
import type { DirEntry, FileContent } from '../main/fs-service'
import type { SlackState, SlackTokenKind, SlackWriteResult } from '../main/slack-state'
import type { ProjectedPreferences } from '../main/preferences-store'
import type { UpdateView } from '../main/update-coordinator'
import type { SessionStatusSnapshot } from '../main/session-status'
import type { RendererSession } from '../main/session-store'
import type {
  ChangeDetailView,
  ChangesData,
  OverviewData,
  SpecDetailView,
  SpecSummary,
  SpecVersionView,
  WorktreeOption,
} from '../main/openspec-service'
import type { ExitReason, SpawnTarget } from '../main/terminal'

/** The reasons a renderer is told about. `disposed` never reaches it (the session did not end). */
type TerminalExitReason = Exclude<ExitReason, 'disposed'>
import type { WatchBatch } from '../main/watch-service'
import type { WorkspaceFolder } from '../main/workspace-store'
import type { RemoteStateView } from '../main/remote-service'
import type { HostAction as RemoteAction } from '../main/remote-protocol'
import type { RendererOutcome as RemoteOutcome } from '../main/remote-host'

/**
 * A remote session action, narrowed here before the renderer sees it (`docs/lessons/slack.md` §10): the
 * main process is trusted, but a shape check on both sides of a channel is how this repo keeps a typo on
 * one side from becoming `undefined` on the other.
 */
function narrowRemoteAction(raw: unknown): RemoteAction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'create' && (o.folderId === null || typeof o.folderId === 'string') && (o.target === 'claude' || o.target === 'shell')) {
    return { kind: 'create', folderId: o.folderId as string | null, target: o.target }
  }
  if (o.kind === 'wake' && typeof o.sessionId === 'string') return { kind: 'wake', sessionId: o.sessionId }
  if (o.kind === 'rename' && typeof o.sessionId === 'string' && typeof o.name === 'string') {
    return { kind: 'rename', sessionId: o.sessionId, name: o.name }
  }
  if ((o.kind === 'hibernate' || o.kind === 'close') && typeof o.sessionId === 'string' && typeof o.force === 'boolean') {
    return { kind: o.kind, sessionId: o.sessionId, force: o.force }
  }
  if ((o.kind === 'offer-close' || o.kind === 'withdraw-close') && typeof o.sessionId === 'string') {
    return { kind: o.kind, sessionId: o.sessionId }
  }
  if (o.kind === 'accept' && typeof o.adapter === 'string' && typeof o.id === 'string' && typeof o.folderId === 'string') {
    return { kind: 'accept', adapter: o.adapter, id: o.id, folderId: o.folderId }
  }
  return null
}

/**
 * 主行程能力一律以具名白名單暴露（PRD §12）。
 * 不要把 ipcRenderer 整個交給 renderer —— 那等於繞過白名單。
 *
 * `fs` 之下的每一個能力，都必須先由 `filesystem-access` 規格定義其邊界要求，才能出現在
 * 這裡。這條約束的形式是白名單，不是清單：**任何函式進入這個介面之前，都必須先有邊界要求**。
 *
 * 寫入類的五個能力（`writeFile` / `createFile` / `createDirectory` / `deleteEntry` /
 * `rename`）於 `file-editing-and-crud` 引入，其邊界要求見該 change 的 `design.md` D1–D8。
 * **這裡沒有 `symlink`，而且不能有** —— renderer 一旦能建立符號連結，就能自己製造中間目錄段
 * 的 TOCTOU race，而 Node 沒有 `openat()` 可以擋（design D3）。
 */
const workspaceApi = {
  fs: {
    listDir: (folderId: string, relPath: string): Promise<FsResult<DirEntry[]>> =>
      ipcRenderer.invoke('workspace:fs:listDir', folderId, relPath),
    /** 遞迴列舉。回傳 **folder-relative** 路徑，可直接餵給其他 `fs.*` 操作。 */
    listFiles: (folderId: string, relPath: string): Promise<FsResult<string[]>> =>
      ipcRenderer.invoke('workspace:fs:listFiles', folderId, relPath),
    readFile: (folderId: string, relPath: string): Promise<FsResult<FileContent>> =>
      ipcRenderer.invoke('workspace:fs:readFile', folderId, relPath),
    /** `baseMtimeMs` 省略即為明確要求覆寫，主行程會略過衝突比對。 */
    writeFile: (
      folderId: string,
      relPath: string,
      text: string,
      baseMtimeMs?: number,
    ): Promise<FsResult<WriteResponse>> =>
      ipcRenderer.invoke('workspace:fs:writeFile', folderId, relPath, text, baseMtimeMs),
    createFile: (folderId: string, relPath: string): Promise<FsResult<void>> =>
      ipcRenderer.invoke('workspace:fs:createFile', folderId, relPath),
    createDirectory: (folderId: string, relPath: string): Promise<FsResult<void>> =>
      ipcRenderer.invoke('workspace:fs:createDirectory', folderId, relPath),
    deleteEntry: (folderId: string, relPath: string): Promise<FsResult<void>> =>
      ipcRenderer.invoke('workspace:fs:deleteEntry', folderId, relPath),
    rename: (folderId: string, fromRelPath: string, toRelPath: string): Promise<FsResult<void>> =>
      ipcRenderer.invoke('workspace:fs:rename', folderId, fromRelPath, toRelPath),
    watch: (folderId: string, relPath: string): Promise<FsResult<void>> =>
      ipcRenderer.invoke('workspace:fs:watch', folderId, relPath),
    unwatch: (folderId: string, relPath: string): Promise<FsResult<void>> =>
      ipcRenderer.invoke('workspace:fs:unwatch', folderId, relPath),
    /** 回傳取消訂閱的函式。renderer 拿不到 ipcRenderer，因此也無從自行解除其他監聽器。 */
    onWatchEvent: (listener: (batch: WatchBatch) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, batch: WatchBatch): void => {
        listener(batch)
      }
      ipcRenderer.on('workspace:fs:watchEvent', handler)
      return () => {
        ipcRenderer.off('workspace:fs:watchEvent', handler)
      }
    },
  },
  /**
   * OpenSpec 結構的唯讀存取。`fs.*` 是「檔案」的詞彙，這裡是「spec 與 change」的詞彙。
   *
   * method 的形狀刻意對齊 spek 前端既有的 `ApiAdapter`（`openspec-side-panel` 的 design D1）
   * —— 差別只在每個 method 的第一個參數是 `folderId`。日後若真要接 `@spekjs/ui`，換的是 UI，
   * 不是這道接縫。
   *
   * **`slug` 與 `topic` 是不受信任的輸入**：它們會被 core 拿去拼接檔案路徑。主行程一律先在
   * 掃描結果裡查表，只對確實存在的 identifier 呼叫 core（design D6）—— 這裡不做任何驗證，
   * preload 與 renderer 同屬一個行程樹，在這裡檢查等同沒有檢查。
   */
  openspec: {
    getOverview: (folderId: string): Promise<FsResult<OverviewData>> =>
      ipcRenderer.invoke('workspace:openspec:getOverview', folderId),
    getSpecs: (folderId: string): Promise<FsResult<SpecSummary[]>> =>
      ipcRenderer.invoke('workspace:openspec:getSpecs', folderId),
    getSpec: (folderId: string, topic: string): Promise<FsResult<SpecDetailView>> =>
      ipcRenderer.invoke('workspace:openspec:getSpec', folderId, topic),
    getSpecAtChange: (
      folderId: string,
      topic: string,
      slug: string,
    ): Promise<FsResult<SpecVersionView>> =>
      ipcRenderer.invoke('workspace:openspec:getSpecAtChange', folderId, topic, slug),
    getChanges: (folderId: string): Promise<FsResult<ChangesData>> =>
      ipcRenderer.invoke('workspace:openspec:getChanges', folderId),
    getChange: (folderId: string, slug: string): Promise<FsResult<ChangeDetailView>> =>
      ipcRenderer.invoke('workspace:openspec:getChange', folderId, slug),
    getGraphData: (folderId: string): Promise<FsResult<GraphData>> =>
      ipcRenderer.invoke('workspace:openspec:getGraphData', folderId),
    /**
     * 該 folder 所屬 repo 各工作目錄的 folder-relative 根（folder 自身為空字串）。
     * renderer 拿它判斷一個檔案是不是落在某個工作目錄的 `openspec/` 底下（反向交叉導覽）。
     */
    getWorktreeRoots: (folderId: string): Promise<FsResult<string[]>> =>
      ipcRenderer.invoke('workspace:openspec:getWorktreeRoots', folderId),
    /**
     * 該 folder 所屬 repo **可供選擇**的工作目錄（Files 身分的樹根選擇器）。
     *
     * 與 `getWorktreeRoots` 的差別在於它**含邊界外的工作目錄**（`relPath` 為 `null`，呈現為停用）
     * 並帶分支／HEAD 供顯示。folder 自身那一筆的 `key` 省略 —— 比照 `terminal.create`。
     */
    getWorktrees: (folderId: string): Promise<FsResult<WorktreeOption[]>> =>
      ipcRenderer.invoke('workspace:openspec:getWorktrees', folderId),
    /** 該 folder 的 OpenSpec 結構已變更（agent 改了檔）。回傳取消訂閱的函式。 */
    onChanged: (listener: (folderId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, folderId: string): void => {
        listener(folderId)
      }
      ipcRenderer.on('workspace:openspec:changed', handler)
      return () => {
        ipcRenderer.off('workspace:openspec:changed', handler)
      }
    },
  },
  folders: {
    list: (): Promise<WorkspaceFolder[]> => ipcRenderer.invoke('workspace:folders:list'),
    add: (): Promise<WorkspaceFolder[]> => ipcRenderer.invoke('workspace:folders:add'),
    remove: (id: string): Promise<WorkspaceFolder[]> =>
      ipcRenderer.invoke('workspace:folders:remove', id),
    /**
     * 重排 folder 的順序，回傳重排後的清單。
     *
     * **以識別碼指定要移動的 folder，不以它此刻的位置** —— renderer 手上的清單是主行程推送的
     * 複本，隨時可能已經過期；以位置指定時，一個飛行中的索引可能已經指向另一個 folder。
     */
    reorder: (id: string, toIndex: number, pinned: boolean): Promise<WorkspaceFolder[]> =>
      ipcRenderer.invoke('workspace:folders:reorder', id, toIndex, pinned),
    /**
     * 切換置頂狀態，回傳更新後的清單。
     *
     * 與 `reorder` **互為表裡**：那邊是「使用者拖到／按到某個位置，置頂狀態由落點推導」，
     * 這邊是「使用者按了圖釘，位置由狀態推導」（跨越分界的最小移動）。兩條路徑在主行程收斂
     * 於同一個維持不變式的地方。
     */
    setPinned: (id: string, pinned: boolean): Promise<WorkspaceFolder[]> =>
      ipcRenderer.invoke('workspace:folders:setPinned', id, pinned),
    /**
     * folder 清單的推送更新 — sent when a folder's git branch changes or its `openspec/` appears or
     * vanishes (the user switches branch or runs `openspec init` in a terminal).
     * 回傳取消訂閱的函式：renderer 拿不到 `ipcRenderer`，因此也無從自行解除其他監聽器。
     */
    onChanged: (listener: (folders: WorkspaceFolder[]) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, folders: WorkspaceFolder[]): void => {
        listener(folders)
      }
      ipcRenderer.on('workspace:folders:changed', handler)
      return () => {
        ipcRenderer.off('workspace:folders:changed', handler)
      }
    },
  },
  app: {
    /**
     * 推送未存變更的快照。主行程在 `close` 事件中同步讀取它 —— 那一刻已經來不及發問。
     * 每次 dirty 集合變動都要推一次，包括變回空集合。
     */
    setDirtyState: (entries: DirtyEntry[]): void => {
      ipcRenderer.send('workspace:app:setDirtyState', entries)
    },
    /** 使用者在關閉對話框選了「儲存全部」。回傳取消訂閱的函式。 */
    onSaveAllRequest: (listener: () => void): (() => void) => {
      const handler = (): void => {
        listener()
      }
      ipcRenderer.on('workspace:app:saveAllRequest', handler)
      return () => {
        ipcRenderer.off('workspace:app:saveAllRequest', handler)
      }
    },
    /** 回報「儲存全部」的結果。`ok` 為 false 時主行程取消關閉。 */
    sendSaveAllResult: (ok: boolean): void => {
      ipcRenderer.send('workspace:app:saveAllResult', ok)
    },
    /**
     * The listeners that outside actions talk to are mounted (the inbox, handoff briefs, focusing a
     * session). A notification click that had to open a window waits for this before acting.
     */
    rendererReady: (): void => {
      ipcRenderer.send('workspace:app:rendererReady')
    },
  },
  shell: {
    /** 協定的驗證在主行程。此處只是把 URL 交過去。 */
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('workspace:shell:openExternal', url),
  },
  /**
   * 系統剪貼簿的文字讀寫。終端的複製貼上沒有它就不成立。
   *
   * **這道能力沒有 workspace 邊界可言** —— 剪貼簿裡可能是使用者剛複製的密碼。它與 `fs.*`
   * 那種「只能碰已加入的 folder」是**不同性質**的東西，不要照著 fs 的直覺去推論它的安全性。
   *
   * 可接受性建立在兩道前提上（`terminal-clipboard` 的 design D2）：
   *
   * 1. **renderer 不會變成別人的頁面** —— `navigation.ts` 的導航防護是這道能力的**前提**。
   *    少了它，使用者 repo 裡一個 markdown 連結就能把遠端頁面帶進這個 renderer，而那個
   *    頁面會拿到 `readText`。
   * 2. **只在使用者明確要求貼上時讀取**（右鍵選單／快捷鍵／中鍵）—— 不主動讀、不背景輪詢、
   *    不在啟動時讀。
   */
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke('workspace:clipboard:readText'),
    writeText: (text: string): void => {
      ipcRenderer.send('workspace:clipboard:writeText', text)
    },
  },
  /**
   * 使用者偏好的讀寫。
   *
   * 值的驗證在主行程的 store（清理 family、夾制 size）—— preload 與 renderer 同屬一個行程樹，
   * 在這裡檢查等同沒有檢查。每個方法回傳套用後的偏好，供 renderer 立即更新終端。
   *
   * **型別是 `ProjectedPreferences` 而非 `TerminalPreferences`，這道窄化是承重的。**
   * renderer 的偏好型別是自這裡回推的（`shell/types.ts`），所以**這裡寫寬了，主行程那邊的
   * 逐欄位白名單就只剩執行期效果** —— renderer 仍然寫得出讀未送出欄位的程式碼，而它永遠是
   * `undefined`，症狀是一個安靜地永遠走 else 分支的判斷。實測過：把這裡改回寬的型別，
   * 「renderer 讀 `agentEvents`」這個對照組不會變紅。
   */
  settings: {
    get: (): Promise<ProjectedPreferences> => ipcRenderer.invoke('workspace:settings:get'),
    setTerminalFont: (
      fontFamily: string | null,
      fontSize: number | null,
      lineHeight: number | null,
    ): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setTerminalFont', fontFamily, fontSize, lineHeight),
    /**
     * 開／關 GPU 加速（＝終端的 webgl renderer）。`null` ＝回到預設（＝啟用）。
     *
     * 與 `setTerminalFont` 分開 —— 它不是字型偏好。字型偏好不受此影響，反之亦然。
     */
    setGpuAcceleration: (enabled: boolean | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setGpuAcceleration', enabled),
    /** 與 agent 的狀態橋接。只影響其後建立或重建的 session（注入發生在 spawn 當下）。 */
    setAgentStatus: (enabled: boolean | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setAgentStatus', enabled),
    /**
     * agent session 以哪一種 view 呈現。`null` ＝回到預設（＝終端）。
     *
     * **它是全域的** —— 切換任何一個 agent session 的 view，所有 agent session 一起改變。
     */
        setAgentView: (view: 'terminal' | 'conversation' | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setAgentView', view),
    /** Automatic hibernation threshold in seconds; `0` = off, `null` = back to the default (24 hours). */
    setAutoHibernate: (seconds: number | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setAutoHibernate', seconds),
    /** The automatic update check (`app-update`). `null` = the default (on); `false` = off. */
    setAutoUpdateCheck: (enabled: false | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setAutoUpdateCheck', enabled),
    /** The theme (`ui-appearance`). `null` = the default (System). */
    setTheme: (theme: 'system' | 'light' | 'dark' | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setTheme', theme),
    /** The interface zoom in percent, snapped to a step by main. `null` = the default (100%). */
    setZoom: (percent: number | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setZoom', percent),
    /** Zoom one step in (`1`) or out (`-1`) from the stored zoom, or reset (`0`). */
    stepZoom: (direction: -1 | 0 | 1): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:stepZoom', direction),
    /**
     * UI 語言。`null` ＝清為預設（＝英文）。
     *
     * **主行程會先套用到它自己的 i18n，再回傳投影** —— 呼叫端要 await 它之後才改 renderer 的
     * 語言。反過來的話，套用失敗的那一刻畫面已是新語言而原生對話框與通知還是舊語言。
     */
    setLanguage: (language: string | null): Promise<ProjectedPreferences> =>
      ipcRenderer.invoke('workspace:settings:setLanguage', language),
    /** 系統的等寬字型清單，給設定對話框的下拉選單（Linux 走 fontconfig；其他平台回空陣列）。 */
    listMonospaceFonts: (): Promise<string[]> =>
      ipcRenderer.invoke('workspace:settings:listMonospaceFonts'),
  },
  /**
   * terminal 的邊界要求見 `terminal-agent-sessions` 的 `design.md` D5：`create` **只收
   * folderId、不收路徑**，cwd 恆為該 folder 的根目錄 —— renderer 在語彙上無從把初始 cwd
   * 指向 workspace 之外。
   *
   * **此邊界只約束「初始 cwd」。** session 一旦啟動即為真實 shell，其內執行的命令不受此
   * 邊界限制（使用者可以 `cd` 到任何地方 —— 那正是終端的用途）。這與 `fs` 白名單的沙箱
   * 語意**不同**，不要把它當成沙箱來推論。
   */
  /**
   * 對話 view 的內容。**與 `terminal` 分家是刻意的** —— 它們是同一個 session 的兩種呈現，
   * 但資料來源完全不同：終端來自 pty 的位元組，對話來自 agent 自己寫下的結構化紀錄。
   */
  conversation: {
    /** 告訴主行程「對話 view 現在盯著哪個 session」（`null` ＝ 不盯）。 */
    watch: (sessionId: string | null): void => {
      ipcRenderer.send('workspace:conversation:watch', sessionId)
    },
    /** 內容更新的推送。回傳取消訂閱的函式。 */
    onUpdate: (listener: (update: ConversationUpdate) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, update: ConversationUpdate): void => {
        listener(update)
      }
      ipcRenderer.on('workspace:conversation:update', handler)
      return () => {
        ipcRenderer.off('workspace:conversation:update', handler)
      }
    },
    /** 等待狀態的推送（能不能送）。回傳取消訂閱的函式。 */
    onWait: (
      listener: (sessionId: string, state: WaitState, pending: PendingRequest) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        sessionId: string,
        state: WaitState,
        pending: PendingRequest,
      ): void => {
        listener(sessionId, state, pending)
      }
      ipcRenderer.on('workspace:conversation:wait', handler)
      return () => {
        ipcRenderer.off('workspace:conversation:wait', handler)
      }
    },
    /**
     * 送出一則訊息。
     *
     * **閘在主行程** —— renderer 這側的停用只是 UI 提示，不是把關者（與 fs 邊界同哲學）。
     * 被拒絕時回傳當下的等待狀態，好讓畫面說得出原因。
     */
    send: (sessionId: string, text: string): Promise<{ ok: boolean; reason?: WaitState }> =>
      ipcRenderer.invoke('workspace:conversation:send', sessionId, text),
  },
  terminal: {
    /**
     * 建立一個 session。`worktreeKey` 指定它開在哪個工作目錄（git worktree），省略＝ folder 根。
     *
     * **那是一個不可逆的識別碼，不是路徑** —— renderer 仍然沒有任何詞彙可以表達一個任意位置；
     * 主行程只對查表命中的值解析出路徑，查無對應即拒絕（`terminal-sessions`）。
     */
    create: (
      /** `null` ＝ 全域 session（不隸屬任何 folder）。renderer 不因此獲得任何路徑詞彙。 */
      folderId: string | null,
      spawnTarget: SpawnTarget,
      worktreeKey?: string,
      /**
       * 交接的單次憑證（由主行程於自動接受或接受時簽發）。**renderer 只能原樣轉交** —— 它不是
       * 「宣告這個 session 的來源」，主行程查它綁定的那一則交接自己記下的來源。
       */
      ticket?: string,
    ): Promise<FsResult<{ sessionId: string; lineage?: SessionLineage }>> =>
      ipcRenderer.invoke('workspace:terminal:create', folderId, spawnTarget, worktreeKey, ticket),
    /**
     * 喚醒一個休眠的 session（重建後尚無 pty）。
     *
     * **只收 sessionId** —— 續接用的對話識別碼與最後的工作目錄都在主行程手上，renderer 連
     * 這兩個詞彙都沒有（session-persistence 的「持久化不得把路徑詞彙交給 renderer」）。
     */
    wake: (sessionId: string): Promise<FsResult<{ sessionId: string }>> =>
      ipcRenderer.invoke('workspace:terminal:wake', sessionId),
    /** 啟動時取回要重建的 session（含各自的終端畫面快照）。 */
    restore: (): Promise<RestoredSession[]> => ipcRenderer.invoke('workspace:terminal:restore'),
    /** 推送 session 清單以供持久化。payload **不含任何路徑，也不含對話識別碼**。 */
    persist: (sessions: RendererSession[]): void => {
      ipcRenderer.send('workspace:terminal:persist', sessions)
    },
    /** 推送終端畫面快照（僅 shell 目標 —— claude 續接時會自行重現對話）。 */
    snapshot: (sessionId: string, data: string): void => {
      ipcRenderer.send('workspace:terminal:snapshot', sessionId, data)
    },
    /**
     * 告訴主行程「狀態列現在盯著哪個 session」（`null` ＝ 不盯）。
     *
     * 狀態列需要的幾件事只有主行程取得到（pty 的 cwd、git 工作區狀態、agent 回報的用量），
     * 而它們都要輪詢 —— **只對 focused 的那一個求值**，成本才綁得住。
     */
    watchStatus: (sessionId: string | null): void => {
      ipcRenderer.send('workspace:terminal:watchStatus', sessionId)
    },
    /** 上述輪詢的推送。回傳取消訂閱的函式。 */
    onStatus: (listener: (status: SessionStatusSnapshot) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, status: SessionStatusSnapshot): void => {
        listener(status)
      }
      ipcRenderer.on('workspace:terminal:status', handler)
      return () => {
        ipcRenderer.off('workspace:terminal:status', handler)
      }
    },
    /** renderer → pty，單向 fire-and-forget：逐鍵輸入不必等一次 round-trip 的回應。 */
    write: (sessionId: string, data: string): void => {
      ipcRenderer.send('workspace:terminal:write', sessionId, data)
    },
    resize: (sessionId: string, cols: number, rows: number): void => {
      ipcRenderer.send('workspace:terminal:resize', sessionId, cols, rows)
    },
        kill: (sessionId: string): void => {
      ipcRenderer.send('workspace:terminal:kill', sessionId)
    },
    /**
     * Put a running session back to dormant (`session-hibernation`). Without a token it is the user's
     * request; with one it answers `onHibernateRequest` and the main process checks its policy again.
     * The session becomes dormant when its exit arrives with reason `hibernated`, not when this resolves.
     */
    hibernate: (sessionId: string, token?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:terminal:hibernate', sessionId, token),
    /** Tell the main process which session this renderer displays (`null` = none). It is never hibernated automatically. */
    displayed: (sessionId: string | null): void => {
      ipcRenderer.send('workspace:terminal:displayed', sessionId)
    },
    /** The main process asks for an idle session to be hibernated. Returns an unsubscribe function. */
    onHibernateRequest: (listener: (sessionId: string, token: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, sessionId: string, token: string): void => {
        listener(sessionId, token)
      }
      ipcRenderer.on('workspace:terminal:hibernateRequest', handler)
      return () => {
        ipcRenderer.off('workspace:terminal:hibernateRequest', handler)
      }
    },
    /** pty → renderer 的輸出。回傳取消訂閱的函式。 */
    onData: (listener: (sessionId: string, chunk: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, sessionId: string, chunk: string): void => {
        listener(sessionId, chunk)
      }
      ipcRenderer.on('workspace:terminal:data', handler)
      return () => {
        ipcRenderer.off('workspace:terminal:data', handler)
      }
    },
        /**
     * pty 結束。回傳取消訂閱的函式。
     *
     * `hibernated` is not an ending: the session stays and becomes dormant (`session-hibernation`).
     */
    onExit: (
      listener: (sessionId: string, exitCode: number, reason: TerminalExitReason) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        sessionId: string,
        exitCode: number,
        reason: TerminalExitReason,
      ): void => {
        listener(sessionId, exitCode, reason)
      }
      ipcRenderer.on('workspace:terminal:exit', handler)
      return () => {
        ipcRenderer.off('workspace:terminal:exit', handler)
      }
    },
  },
  /**
   * 側欄座標（`side-panel-source`）：rail 上的每個項目各記著「我站在這裡時，側欄看什麼」。
   *
   * **自成一個 namespace，不掛在 `folders.*` 之下** —— 那個 namespace 是 workspace 清單的 CRUD，
   * 而座標的鍵在設計上是一個**不透明字串**（rail 的項目集合日後可能納入 linked worktree），
   * 掛過去會讓「鍵就是一個 folder」這個今日的巧合看起來像契約。
   *
   * **落盤的內容不得含任何路徑**（延續 `terminal-sessions` 與 `session-persistence` 的邊界
   * 論證）：工作目錄以不可逆識別碼表示，而驗證在主行程的**寫入入口** —— preload 與 renderer
   * 同屬一個行程樹，在這裡檢查等同沒有檢查。
   */
  /**
   * 交接出來的 session（`handoff-brief` / `handoff-completion`）。**自己一個 namespace** —— 不掛在
   * terminal 之下：那裡的每一個成員都對應一顆 pty，這裡一個位元組都不寫進 pty。
   *
   * `brief` 只收 session 識別碼；主行程只對存在且帶交接單的 session 回應。
   */
  /** Every running agent session's attention state (`session-wait-indicator`). Read-only: the main process owns it. */
  wait: {
    list: (): Promise<AttentionView[]> => ipcRenderer.invoke('workspace:wait:list'),
    onChanged: (listener: (views: AttentionView[]) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, views: AttentionView[]): void => listener(views)
      ipcRenderer.on('workspace:wait:changed', handler)
      return () => ipcRenderer.removeListener('workspace:wait:changed', handler)
    },
  },
  handoff: {
    brief: (sessionId: string): Promise<HandoffBriefView | null> =>
      ipcRenderer.invoke('workspace:handoff:brief', sessionId),
    /** 所有交接 session 的生命週期（`handoff-completion`）。唯讀 —— 權威在主行程。 */
    lifecycle: (): Promise<LifecycleView[]> => ipcRenderer.invoke('workspace:handoff:lifecycle'),
    onLifecycle: (listener: (views: LifecycleView[]) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, views: LifecycleView[]): void => listener(views)
      ipcRenderer.on('workspace:handoff:lifecycleChanged', handler)
      return () => ipcRenderer.removeListener('workspace:handoff:lifecycleChanged', handler)
    },
    /** 觸發了完成通知：帶使用者去這個 session 的交接單。只收一個 session 識別碼。 */
    onReveal: (listener: (sessionId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, sessionId: string): void => listener(sessionId)
      ipcRenderer.on('workspace:handoff:reveal', handler)
      return () => ipcRenderer.removeListener('workspace:handoff:reveal', handler)
    },
    /**
     * The user kept a session its agent offered to close (`remote-close-offer` D4): the main process owns the offer,
     * and paired devices read it from there. Only a session id; the most it can do is withdraw an offer.
     */
    keepCloseOffer: (sessionId: string): void => ipcRenderer.send('workspace:handoff:keepCloseOffer', sessionId),
  },
  panel: {
    /**
     * 全部座標。`coordinates` 的鍵為 folder 識別碼；全域項目的座標在 `global`，**與它並列**
     * 而不是它的一個鍵 —— folder 識別碼不受格式約束，共用鍵空間會碰撞（design D1c）。
     */
    get: (): Promise<PanelSnapshot> => ipcRenderer.invoke('workspace:panel:get'),
    /** 送出完整的一份（fire-and-forget，主行程 debounce 後落盤）。 */
    persist: (snapshot: PanelSnapshot): void => {
      ipcRenderer.send('workspace:panel:persist', snapshot)
    },
  },
  /**
   * 對話計量。**刻意不掛在 `fs` 之下** —— `filesystem-access` 有一條 scenario 逐一列舉了
   * `fs` 上允許存在的成員，多一個就違反它、且有探針斷言。而「掃描器讀檔案」很容易讓人
   * 直覺往 `fs` 裡放。
   *
   * 這裡送回 renderer 的只有彙總結果：沒有列、沒有路徑、沒有訊息內文的完整清單。
   */
  insights: {
    /** 取當下的彙總與掃描狀態。不觸發掃描。`range` 省略即全部期間。 */
    get: (range?: { from?: number; to?: number }): Promise<InsightsSnapshot> =>
      ipcRenderer.invoke('workspace:insights:get', range),
    /** 觸發一次增量掃描，完成後回傳新的彙總。已在掃的話直接回傳當下狀態。 */
    refresh: (range?: { from?: number; to?: number }): Promise<InsightsSnapshot> =>
      ipcRenderer.invoke('workspace:insights:refresh', range),

    /**
     * 讀後感（`conversation-report`）。
     *
     * `reportPreview` 回的是**實際將送出**的那一份的數字（截斷之後），授權畫面用它。
     * `reportGenerate` 的 `authorized` 代表「使用者剛剛按下了那一次的同意」——
     * 它不是一個記住的設定，每一趟都要重新取得。
     */
    reportPreview: (range?: { from?: number; to?: number }): Promise<ReportPreview> =>
      ipcRenderer.invoke('workspace:insights:reportPreview', range),
    reportList: (): Promise<ReportMeta[]> => ipcRenderer.invoke('workspace:insights:reportList'),
    reportRead: (name: string): Promise<Report | null> => ipcRenderer.invoke('workspace:insights:reportRead', name),
    reportGenerate: (request: { from?: number; to?: number; authorized: boolean }): Promise<GenerateResult> =>
      ipcRenderer.invoke('workspace:insights:reportGenerate', request),
  },
  /**
   * 收件匣（`agent-intake`）。
   *
   * **這裡送回 renderer 的一律沒有路徑** —— 收件匣的目錄、原始投遞的保存處、context 檔的位置
   * 都不經這條通道。renderer 拿到的是 `intakeId`、通用欄位、與一個**已解析好的 `folderId`**
   * （那是它既有的合法詞彙）。
   *
   * `accept` 只回一個**指示**：要在哪個 folder 建立 agent session。建立本身由 renderer 走它
   * 既有的 create 路徑 —— session 清單的權威在 renderer，主行程自行建立的 session 會在 500ms
   * 之後被抹掉而 pty 還活著。建好之後以 `attach` 回報，主行程才寫 context 檔並排定預填。
   */
  /**
   * Slack adapter 的連線設定。
   *
   * **憑證只以布林出現在回傳值裡，介面上沒有讀取憑證的方法。** 這是 `secret-scope` 第一條
   * requirement 的形狀：renderer 取得的限於**衍生的事實**（是否已設定、連到哪個工作區、
   * 端點是不是預設值），SHALL NOT 包含機密本身或其任何可還原的片段。
   *
   * **沒有設定「要偵測誰」與「哪個工作區」的方法，那是刻意的**（design D14）：兩者自憑證推導。
   * 一個填錯的「要偵測誰」，症狀是什麼都不會發生 —— 與「沒有人提及我」和「連線已失效」
   * 在畫面上完全相同，而讓後兩者可區分正是那條能力花了一整條 requirement 在做的事。
   *
   * **端點自己一個方法，不併進一個吃整份設定的 setter** —— `secret-scope` 要求它只能由使用者
   * 明確操作改動，而一個吃整份物件的 setter 會讓任何一次「改回看範圍」順帶有能力改掉它。
   */
  slack: {
    get: (): Promise<SlackState> => ipcRenderer.invoke('workspace:slack:get'),
    /** `null` ＝清除該份憑證。 */
    setToken: (kind: SlackTokenKind, value: string | null): Promise<SlackWriteResult> =>
      ipcRenderer.invoke('workspace:slack:setToken', kind, value),
    /** `null` ＝清回預設。 */
    setLookbackDays: (days: number | null): Promise<SlackWriteResult> =>
      ipcRenderer.invoke('workspace:slack:setLookbackDays', days),
    /** `null` = back to the default endpoint; a value that is not an acceptable https address is refused. */
    setApiBaseUrl: (url: string | null): Promise<SlackWriteResult> =>
      ipcRenderer.invoke('workspace:slack:setApiBaseUrl', url),
    /**
     * 狀態改變了。
     *
     * **不是可有可無的**：回補在啟動數秒後才跑完，只在掛載時取一次的話，使用者看到的永遠是
     * 「還沒檢查過」，而**憑證失效永遠不會出現在畫面上** —— 那條 requirement 會以一個
     * 看起來正常的介面失敗。（`probe:slack` 抓到的就是這個。）
     */
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('workspace:slack:changed', handler)
      return () => ipcRenderer.removeListener('workspace:slack:changed', handler)
    },
  },
  intake: {
    list: (): Promise<IntakeSnapshot> => ipcRenderer.invoke('workspace:intake:list'),
    /** `folderId` ＝ 使用者在卡片上確認的 folder。**缺了它主行程就拒絕** —— 不退回 routing 的結果。 */
    accept: (id: string, adapter: string, folderId: string): Promise<IntakeAcceptResult> =>
      ipcRenderer.invoke('workspace:intake:accept', id, adapter, folderId),
    attach: (id: string, adapter: string, sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:intake:attach', id, adapter, sessionId),
    dismiss: (id: string, adapter: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:intake:dismiss', id, adapter),
    /** Open a scheduled handoff now (`scheduled-handoff`'s Run now). */
    runNow: (id: string, adapter: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:intake:runNow', id, adapter),
    /** Approve a repeating proposal into a folder (`recurring-handoff`). Opens no session. */
    approveRecurrence: (id: string, adapter: string, folderId: string): Promise<ApproveResult> =>
      ipcRenderer.invoke('workspace:intake:approveRecurrence', id, adapter, folderId),
    /** Stop a recurrence: its upcoming occurrence is removed, nothing further is created. */
    stopRecurrence: (recurrenceId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:intake:stopRecurrence', recurrenceId),
    /** 把一則已開好的項目從收件匣清除。不刪紀錄、不碰它的 session。 */
    settle: (id: string, adapter: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:intake:settle', id, adapter),
    dismissNotices: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('workspace:intake:dismissNotices'),
    dismissNotice: (key: string, code: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:intake:dismissNotice', key, code),
    rules: (): Promise<IntakeRulesSnapshot> => ipcRenderer.invoke('workspace:intake:rules'),
    setRules: (config: IntakeRulesSnapshot): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:intake:setRules', config),
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('workspace:intake:changed', handler)
      return () => ipcRenderer.removeListener('workspace:intake:changed', handler)
    },
    /** 使用者打開了收件匣 —— 通知上界的重置點。無回應通道。 */
    opened: (): void => ipcRenderer.send('workspace:intake:opened'),
    /** Open the inbox, on the given tab when it is closed (`recurring-handoff`: only proposals ⇒ Schedules). */
    onOpenInbox: (listener: (tab: 'inbox' | 'schedules') => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, tab: unknown): void => listener(tab === 'schedules' ? 'schedules' : 'inbox')
      ipcRenderer.on('workspace:intake:openInbox', handler)
      return () => ipcRenderer.removeListener('workspace:intake:openInbox', handler)
    },
    /** 主行程：這一則到達時即被接受，請在該 folder 建立 session 並回報 sessionId。 */
    onAutoAccept: (
      listener: (adapter: string, id: string, folderId: string, ticket?: string) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        adapter: string,
        id: string,
        folderId: string,
        ticket?: string,
      ): void => listener(adapter, id, folderId, typeof ticket === 'string' ? ticket : undefined)
      ipcRenderer.on('workspace:intake:autoAccept', handler)
      return () => ipcRenderer.removeListener('workspace:intake:autoAccept', handler)
    },
    /** 主行程：把焦點移到某個 session（使用者觸發了一則已建立 session 的通知）。 */
    onFocusSession: (listener: (sessionId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, sessionId: string): void => listener(sessionId)
      ipcRenderer.on('workspace:intake:focusSession', handler)
      return () => ipcRenderer.removeListener('workspace:intake:focusSession', handler)
    },
    onPrefill: (listener: (sessionId: string, state: 'pending' | 'sent' | 'timedOut') => void): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        sessionId: string,
        state: 'pending' | 'sent' | 'timedOut',
      ): void =>
        listener(sessionId, state)
      ipcRenderer.on('workspace:intake:prefill', handler)
      return () => ipcRenderer.removeListener('workspace:intake:prefill', handler)
    },
  },
  /**
   * Remote access (`remote-access`): the dialog's state and controls, and the bridge through which a paired
   * device's session actions reach this renderer, which owns the session list (`remote-protocol`).
   *
   * The state is a field whitelist built in the main process — no credential, hash or key. The pairing code
   * is the one secret in it, inside the pairing link, because the dialog must show it.
   */
  remote: {
    state: (): Promise<RemoteStateView> => ipcRenderer.invoke('workspace:remote:state'),
    setEnabled: (enabled: boolean): Promise<RemoteStateView> => ipcRenderer.invoke('workspace:remote:setEnabled', enabled),
    setPort: (port: number): Promise<{ ok: boolean; state: RemoteStateView }> =>
      ipcRenderer.invoke('workspace:remote:setPort', port),
    /** `null` ＝ clear it. */
    setAdditionalAddress: (address: string | null): Promise<{ ok: boolean; state: RemoteStateView }> =>
      ipcRenderer.invoke('workspace:remote:setAdditionalAddress', address),
    startPairing: (): Promise<RemoteStateView['pairing']> => ipcRenderer.invoke('workspace:remote:startPairing'),
    /** The pairing view closed: its code stops working. */
    cancelPairing: (): void => ipcRenderer.send('workspace:remote:cancelPairing'),
    revoke: (deviceId: string): Promise<RemoteStateView> => ipcRenderer.invoke('workspace:remote:revoke', deviceId),
    reset: (): Promise<RemoteStateView> => ipcRenderer.invoke('workspace:remote:reset'),
    dismissNotice: (): void => ipcRenderer.send('workspace:remote:dismissNotice'),
    onChanged: (listener: (state: RemoteStateView) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: RemoteStateView): void => listener(state)
      ipcRenderer.on('workspace:remote:changed', handler)
      return () => ipcRenderer.removeListener('workspace:remote:changed', handler)
    },
    /** A paired device asks for a session action; answer with `reply` (the main process waits 15 s). */
    onRequest: (listener: (requestId: string, action: RemoteAction) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, requestId: unknown, raw: unknown): void => {
        const action = narrowRemoteAction(raw)
        if (typeof requestId !== 'string') return
        if (!action) {
          ipcRenderer.send('workspace:remote:reply', requestId, { ok: false, code: 'BAD_PARAMS' })
          return
        }
        listener(requestId, action)
      }
      ipcRenderer.on('workspace:remote:request', handler)
      return () => ipcRenderer.removeListener('workspace:remote:request', handler)
    },
    reply: (requestId: string, outcome: RemoteOutcome): void =>
      ipcRenderer.send('workspace:remote:reply', requestId, outcome),
  },
  /**
   * The update check (`app-update`). No URL, version or path goes from here to the main process: "Download" opens
   * the link the main process built, and "Restart to update" acts on the update it holds.
   */
  update: {
    /** `null` when this build does not check for updates (development mode). */
    get: (): Promise<UpdateView | null> => ipcRenderer.invoke('workspace:update:get'),
    check: (): Promise<UpdateView | null> => ipcRenderer.invoke('workspace:update:check'),
    /** `false` when nothing is ready, or a close question is already open. */
    restart: (): Promise<boolean> => ipcRenderer.invoke('workspace:update:restart'),
    openRelease: (): Promise<void> => ipcRenderer.invoke('workspace:update:openRelease'),
    onChanged: (listener: (view: UpdateView | null) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, view: UpdateView | null): void => {
        listener(view)
      }
      ipcRenderer.on('workspace:update:changed', handler)
      return () => {
        ipcRenderer.off('workspace:update:changed', handler)
      }
    },
    /** The update notification was activated: show Settings at About. */
    onShowAbout: (listener: () => void): (() => void) => {
      const handler = (): void => {
        listener()
      }
      ipcRenderer.on('workspace:update:showAbout', handler)
      return () => {
        ipcRenderer.off('workspace:update:showAbout', handler)
      }
    },
  },
} as const

export type WorkspaceApi = typeof workspaceApi

if (!process.contextIsolated) {
  throw new Error('contextIsolation must be enabled, otherwise the preload allowlist is meaningless')
}

contextBridge.exposeInMainWorld('workspace', workspaceApi)
