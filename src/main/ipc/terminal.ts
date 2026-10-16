import { type WebContents, ipcMain } from 'electron'
import { effectiveHibernateSeconds } from '@shared/hibernation/settings'
import { t } from '@shared/i18n'
import { preferredTitle } from '../../shared/lineage/label'
import type { LiveSession } from '../close-prompt'
import { clearAgentEvents } from '../agent-events'
import { clearAgentStatus } from '../agent-status'
import { clearWait, forgetRequests, subscribeWait, waitStateOf } from '../agent-wait'
import { HibernationTracker } from '../hibernation'
import { tickPeriodMs } from '../hibernation-policy'
import { forgetSubmission, hasUnconfirmedSubmission } from '../intake-prefill'
import { broadcastLifecycle } from './handoff'
import { createSession } from '../session-create'
import { lifecycleViewOf } from '../handoff-lifecycle-view'
import type { RelationsWorld } from '../handoff-relations'
import type { PreferencesStore } from '../preferences-store'
import { SessionStatusService } from '../session-status'
import type { RendererSession, SessionLineage, SessionStore } from '../session-store'
import { SESSION_END, type SessionEnd, type SpawnTarget, TerminalError, TerminalService } from '../terminal'
import { agentSettingsFile } from '../agent-injection'
import { prepareHandoffInjection } from '../handoff-injection'
import { endHandoffSession } from '../handoff-service'
import type { FolderLookup } from '../workspace-store'
import { worktreesFor } from './openspec'
import { pickCreateWorktree, pickWorktree } from '../worktree-pick'
import type { FsResult } from './fs'
import { disposeConversationFor } from './conversation'
import { attachmentStore } from '../remote-attachments'
import { RemoteOutput } from '../remote-output'

/**
 * Recent pty output for remote terminal watches (`remote-protocol`). Fed from the same `data` path that
 * feeds the renderer, so a phone sees what the desktop sees. It buffers only while remote access is on.
 */
export const remoteTerminalOutput = new RemoteOutput()

export const TERMINAL_CHANNELS = {
  /** renderer → main：現在盯著哪個 session（`null` ＝ 停止）。狀態列只對 focused 的那一個求值。 */
  watchStatus: 'workspace:terminal:watchStatus',
  /** main → renderer：該 session 的 cwd／git 狀態／agent 回報的用量。 */
  status: 'workspace:terminal:status',
  create: 'workspace:terminal:create',
  /** 喚醒一個休眠的（已重建但還沒有 pty 的）session。 */
  wake: 'workspace:terminal:wake',
  write: 'workspace:terminal:write',
  resize: 'workspace:terminal:resize',
  kill: 'workspace:terminal:kill',
  /** renderer 啟動時取回要重建的 session（含各自的終端畫面快照）。 */
  restore: 'workspace:terminal:restore',
  /** renderer 推送 session 清單（**不含任何路徑、不含對話識別碼**）。 */
  persist: 'workspace:terminal:persist',
  /** renderer 推送終端畫面快照。 */
  snapshot: 'workspace:terminal:snapshot',
    /** 主行程 → renderer 的單向推送。與 fs 的 watchEvent 同類。 */
  data: 'workspace:terminal:data',
  exit: 'workspace:terminal:exit',
  /** renderer → main: put a running session back to dormant (`session-hibernation`). */
  hibernate: 'workspace:terminal:hibernate',
  /** renderer → main: the session this renderer displays (`null` = none). Automatic hibernation never takes it. */
  displayed: 'workspace:terminal:displayed',
  /** main → renderer: an idle session should be hibernated; the renderer runs its hibernate path with the token. */
  hibernateRequest: 'workspace:terminal:hibernateRequest',
} as const

/** 重建一個 session 所需的一切。`scrollback` 只有 shell 目標會有（design D3）。 */
export interface RestoredSession extends RendererSession {
  scrollback?: string
  /** 主行程寫下的交接來源（唯讀）。renderer 靠它畫樹與標示；它不含路徑。 */
  lineage?: SessionLineage
}

/**
 * metadata 的落盤 debounce。`title` 會隨 claude 的任務進展**持續**變動 —— 每次都同步寫一次檔
 * 是浪費。快照走自己的檔案，不受這個節流影響。
 */
const PERSIST_DEBOUNCE_MS = 500

/**
 * 失敗以結果物件跨越 IPC，不以拋出 —— Electron 序列化 Error 只保留 message，`code` 會遺失
 * （與 `ipc/fs.ts` 的 `toResult` 同源；那一份是該模組私有的）。
 */
async function toResult<T>(run: () => T | Promise<T>): Promise<FsResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    if (error instanceof TerminalError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'UNKNOWN', message: String(error) }
  }
}

/** 每個 renderer 一份 pty 集合。key 是 `webContents.id`（與 watcher 的擁有者記帳同構）。 */
const services = new Map<number, TerminalService>()
/** The renderer that owns each service — automatic hibernation asks it to run the hibernate path. */
const owners = new Map<number, WebContents>()

/** Activity, displayed sessions and request tokens for automatic hibernation (`session-hibernation`). */
const hibernation = new HibernationTracker({
  now: Date.now,
  subscribeWait,
  waitStateOf,
  hasUnconfirmedSubmission,
})

/** The session a window displays, as its renderer last reported it. */
export function displayedSessionOf(contentsId: number): string | null {
  return hibernation.displayedBy(contentsId)
}

/** A remote watch counts as displayed for automatic hibernation (`session-hibernation`). */
export function setRemoteWatched(watchKey: string, sessionId: string | null): void {
  hibernation.setRemoteWatched(watchKey, sessionId)
}

/** 所有服務中目前持有 pty 的 claude session —— 關係檔的「是否在執行」。 */
export function runningAgents(): string[] {
  return [...services.values()].flatMap((service) => service.runningAgents())
}

/**
 * The window's sessions that hold a pty, for the close confirmation (`workspace-app-shell`, design C2
 * of `maximize-panel-and-confirm-close`).
 *
 * **Synchronous and main-only**: the `close` handler has to decide inside its own call, so nothing
 * here waits on the renderer. Dormant and exited sessions hold no pty and are absent by construction.
 * Order: the global item first, then folders in rail order, then the store's order.
 */
export function liveSessionsOf(contentsId: number, store: FolderLookup, sessions: SessionStore): LiveSession[] {
  const service = services.get(contentsId)
  if (!service) return []
  const records = new Map(sessions.view().map(({ session }) => [session.id, session]))
  // **The renderer's latest push wins for the name.** The store only receives it after the persist
  // debounce, so a session created or renamed in the last half second would otherwise be listed
  // without its ordinal or under its old name. Only display fields are taken, and only when they
  // have the right type — the push is the renderer's word, used here for a label and nothing else.
  for (const entry of pending.get(contentsId)?.incoming ?? []) {
    const stored = records.get(entry?.id)
    if (!stored) continue
    records.set(stored.id, {
      ...stored,
      ...(typeof entry.ordinal === 'number' ? { ordinal: entry.ordinal } : {}),
      // Absent in the push means cleared (a custom name removed), not "unknown".
      title: typeof entry.title === 'string' ? entry.title : undefined,
      customTitle: typeof entry.customTitle === 'string' ? entry.customTitle : undefined,
    })
  }
  const folders = store.list()
  const rank = (folderId: string | null | undefined): number =>
    folderId === null ? -1 : folders.findIndex((folder) => folder.id === folderId)

  return service
    .liveSessionIds()
    .map((id) => {
      const record = records.get(id)
      const facts = service.idleFactsOf(id)
      const target = facts?.target ?? record?.spawnTarget ?? 'shell'
      let working: boolean | null = null
      if (target === 'shell') {
        if (facts?.shell === 'busy') working = true
        else if (facts?.shell === 'idle') working = false
      } else {
        const state = waitStateOf(id)
        if (state === 'busy' || state === 'awaiting-choice') working = true
        else if (state === 'ready') working = false
      }
      const folderId = record?.folderId
      // The tab's own fallback is `<target> <ordinal>`; a record the renderer has not pushed yet
      // carries no ordinal, so it falls back to the target alone.
      const fallback = record?.ordinal ? `${target} ${record.ordinal}` : target
      return {
        rank: rank(folderId),
        session: {
          railLabel: folderId === null ? t('rail.globalName') : (railLabelOf(store, folderId ?? null) ?? ''),
          label: (record && preferredTitle(record)) ?? fallback,
          working,
        },
      }
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ session }) => session)
}

/** 計算關係所需的當下狀態（`handoff-relations.ts`）。 */
export function currentRelationsWorld(store: FolderLookup, sessions: SessionStore): RelationsWorld {
  return {
    view: sessions.view(),
    folders: store.list(),
    running: new Set(runningAgents()),
    // 子／兄弟的生命週期與最新結果（`handoff-completion`）—— 母 session 錯過訊息時的補償。
    lifecycle: new Map(lifecycleViewOf(sessions).map((view) => [view.sessionId, view])),
  }
}

/**
 * pty 誕生或結束 —— 關係檔的觸發點之一（`handoff-lineage` design D6 的單一觸發點由呼叫端接上）。
 */
const ptyListeners = new Set<() => void>()

export function onPtyChange(listener: () => void): () => void {
  ptyListeners.add(listener)
  return () => ptyListeners.delete(listener)
}

function ptyChanged(): void {
  for (const listener of ptyListeners) {
    try {
      listener()
    } catch (error) {
      console.error(`[terminal] pty listener failed: ${String(error)}`)
    }
  }
}

/**
 * A session's process ended, and how (`remote-hibernate-close` D5): a paired device watching its conversation
 * is told. Not for `disposed` — a window reload ends remote watches itself (`windowGone`).
 */
const endListeners = new Set<(sessionId: string, how: SessionEnd) => void>()

export function onSessionEnded(listener: (sessionId: string, how: SessionEnd) => void): () => void {
  endListeners.add(listener)
  return () => endListeners.delete(listener)
}

function sessionEnded(sessionId: string, how: SessionEnd): void {
  for (const listener of endListeners) {
    try {
      listener(sessionId, how)
    } catch (error) {
      console.error(`[terminal] session-end listener failed: ${String(error)}`)
    }
  }
}

/**
 * 取得**已存在**的 service，不建立新的。
 *
 * 對話 view 的通道需要問 session 的來源座標，而那個問題只在 session 已經存在時才有意義 ——
 * 若這裡改成「沒有就建一個」，一個對著不存在的 renderer 的空 service 會被留下來。
 */
export function existingTerminalService(contentsId: number): TerminalService | undefined {
  return services.get(contentsId)
}

/** 每個 renderer 一份狀態輪詢（只盯它當下 focused 的那一個 session）。 */
const statusServices = new Map<number, SessionStatusService>()

function statusServiceFor(service: TerminalService, contents: WebContents): SessionStatusService {
  const existing = statusServices.get(contents.id)
  if (existing) return existing

  const status = new SessionStatusService(
    (sessionId) => service.liveCwdOf(sessionId),
    contents,
    TERMINAL_CHANNELS.status,
  )
  statusServices.set(contents.id, status)
  return status
}

/** rail 項目的名稱（名字的前綴）。`null` ＝ 全域；查無時回空字串（`peer-name` 會用代替字）。 */
function railLabelOf(store: FolderLookup, folderId: string | null): string | null {
  if (folderId === null) return null
  return store.list().find((folder) => folder.id === folderId)?.name ?? ''
}

function serviceFor(
  store: FolderLookup,
  sessions: SessionStore,
  preferences: PreferencesStore,
  contents: WebContents,
): TerminalService {
  const existing = services.get(contents.id)
  if (existing) return existing

    const service = new TerminalService(store, {
    data: (sessionId, chunk) => {
      hibernation.output(sessionId)
      remoteTerminalOutput.data(sessionId, chunk)
      if (contents.isDestroyed()) return
      contents.send(TERMINAL_CHANNELS.data, sessionId, chunk)
    },
    spawned: (sessionId) => remoteTerminalOutput.spawned(sessionId),
    resized: (sessionId, cols, rows) => remoteTerminalOutput.resized(sessionId, cols, rows),
    exit: (sessionId, exitCode, reason) => {
      hibernation.untrack(sessionId)
      remoteTerminalOutput.exited(sessionId, SESSION_END[reason])
      if (reason !== 'disposed') sessionEnded(sessionId, SESSION_END[reason])
      // The pty held any filled-in prompt; with it gone there is nothing left to confirm.
      forgetSubmission(sessionId)
      // Nor can any permission prompt of it still be on screen (`agent-event-bridge`). Without this a reload
      // left a request open, and a device saw it as answerable.
      forgetRequests(sessionId)
      if (reason === 'hibernated') {
        // **Before `ptyChanged()`**: the relations refresh it triggers must see the wait state reset.
        // A hibernated session has no state to show (`lifecycleOf` maps `unknown` to idle), as a
        // restored one does; keeping the last `ready` would show a hibernated child as "waiting".
        clearWait(sessionId)
        ptyChanged()
        // The renderer's lifecycle marks only update on this broadcast; without it the tab would
        // keep "waiting for you" although the relations file is right.
        broadcastLifecycle()
        // **Not removed from persistence** — hibernation is not an ending (design D2).
        if (contents.isDestroyed()) return
        contents.send(TERMINAL_CHANNELS.exit, sessionId, exitCode, reason)
        return
      }
      // **在 `disposed` 提早 return 之前** —— renderer 重新載入時所有 pty 都以 `disposed` 結束，
      // 掛在那之後的話，關係檔裡的「是否在執行」永遠不會被刷新。
      ptyChanged()
      // **`disposed` 是關視窗／reload 時我們自己殺的 —— 那不是 session 結束。**
      //
      // 少了這道分支，關一次視窗就會把整份持久化清空（每個 pty 都會 exit，每個 exit 都被當成
      // 「這個 session 死了，別再留著它」）—— 也就是這個 change 要修的那個 bug 本人，換了個寫法。
      //
      // 也不可把它推給 renderer：reload 後的新頁面**已經用同樣的 id 重建了這些 session**（休眠），
      // 一則遲到的 exit 會把剛重建好的分頁標成已結束。
      if (reason === 'disposed') return

      // 真的結束了（pty 自己死掉、或使用者關掉）—— 立刻把它連同快照從磁碟上抹掉。不能等 renderer
      // 的下一次 persist：若使用者就在此時關掉 app，那筆已死的 session 會被當成休眠的重建回來。
            sessions.remove(sessionId)
      if (contents.isDestroyed()) return
      contents.send(TERMINAL_CHANNELS.exit, sessionId, exitCode, reason)
    },
    // 對話識別碼是**主行程的知識**（renderer 沒有這個詞彙），因此直接落盤，不經 renderer 轉手。
    conversation: (sessionId, conversationId) => {
      sessions.update(sessionId, { claudeSessionId: conversationId })
    },
  },
  // 未設定＝啟用（與 gpuAcceleration 同一條規則）。在 spawn 當下求值。
  () => preferences.get().agentStatus !== false,
  // **事件橋接獨立求值。** 兩者共用同一個接縫，但啟用狀態彼此獨立 —— 關掉狀態列
  // SHALL NOT 連帶關掉對話 view 的輸入能力（`claude-status-bridge` 的合成條款）。
  () => preferences.get().agentEvents !== false,
  agentSettingsFile,
  // 交接的注入貢獻。**排在事件橋接之後**（見 `terminal.ts` 的註冊順序註解）。
  // Always on: handoff is a core capability and has no switch. It stays independent of the two
  // switches above — with events off it still runs, and each handoff takes the visible
  // "prefill impossible" rejection.
  (sessionId) =>
    prepareHandoffInjection(sessionId, store.list(), {
      name: sessions.view().find((entry) => entry.session.id === sessionId)?.session.peerName,
      world: currentRelationsWorld(store, sessions),
      // 由交接建立 ⇒ 自我介紹帶上完成回報那一段（`handoff-completion`）。來源在 spawn 之前就已寫進暫定紀錄。
      reportable: sessions.view().some((entry) => entry.session.id === sessionId && entry.session.lineage !== undefined),
    }),
  // 交接的落點於 session 結束時收掉 —— **先處理完裡面既有的項目，再清除**（順序住在服務裡）。
  endHandoffSession,
  )
    services.set(contents.id, service)
  owners.set(contents.id, contents)

  /**
   * What a renderer leaves behind when it goes — **one body for both ways it can go**. The two paths used
   * to be written out separately, and the destroyed one lacked `disposeConversationFor`: the conversation
   * tracking of a closed window outlived it. On Linux that lasted only until the process ended with its
   * window; on macOS the process keeps running and a window can be closed and reopened many times.
   */
  const releaseRenderer = (): void => {
    hibernation.setDisplayed(contents.id, null)
    // 尚未被 renderer 送來持久化的 session 永遠不會被送來了（新頁面不知道它們）。
    sessions.dropProvisional()
    disposeConversationFor(contents.id)
    // reload 之後 renderer 會重新告訴我們要盯誰；先停掉，否則它會繼續對一個已消失的頁面推送。
    statusServices.get(contents.id)?.dispose()
    statusServices.delete(contents.id)
    flush(service, sessions)
    service.dispose()
  }

  contents.once('destroyed', () => {
    owners.delete(contents.id)
    services.delete(contents.id)
    releaseRenderer()
  })

  // 重新載入不會銷毀 webContents，因此 'destroyed' 不會觸發 —— 舊 pty 會變成孤兒行程，
  // 且新頁面的 xterm 永遠收不到它們的輸出（listener 綁在已消失的舊 renderer 上）。必須在
  // 'did-navigate' 殺光（design D2）。沿用 watcher 的教訓：用 'did-navigate'（已 commit），
  // 不是 'did-start-navigation'（那對被擋下的導航也會觸發）。
  contents.on('did-navigate', releaseRenderer)

  return service
}

/** 待落盤的 metadata（每個 renderer 一份）。 */
const pending = new Map<number, { timer: NodeJS.Timeout; incoming: RendererSession[] }>()

/**
 * 每個 shell session 的最後 cwd。**由主行程自己讀 `/proc`**，renderer 從未經手 —— 它連
 * 「工作目錄」這個詞彙都沒有（session-persistence 的「持久化不得把路徑詞彙交給 renderer」）。
 */
function refreshCwd(service: TerminalService, sessions: SessionStore): void {
  for (const session of sessions.list()) {
    if (session.spawnTarget !== 'shell') continue
    const cwd = service.cwdOf(session.id)
    if (cwd) sessions.update(session.id, { cwd })
  }
}

/**
 * 重建路徑的解析 —— **與 `pickCreateWorktree` 的差別是「查無對應」的處置，那是刻意的**。
 *
 * 建立時查無對應要拒絕（使用者剛選了一個工作目錄，開錯地方是說謊）；**重建時查無對應是正常的**
 * ——那個 worktree 可能在應用程式沒開的時候被移除了。此時退回 folder 根且不使重建失敗
 * （`session-persistence` 明文）。**而對話不會因此丟失**：`claude --resume` 的查找是 git repo
 * 關聯的，跨工作目錄仍找得到（實測，見該 change 的 proposal）。
 */
async function resolveWorktreeForRebuild(
  store: FolderLookup,
  contents: WebContents,
  folderId: string | null,
  worktreeKey?: string,
): Promise<{ cwd?: string; worktreeRoots: string[] }> {
  // 全域 session 不隸屬任何 repo —— 沒有工作目錄可列舉。`strict: false`（重建路徑）於是回
  // `{ worktreeRoots: [] }`，`create` 接著以家目錄為初始 cwd。
  const worktrees = folderId === null ? [] : await worktreesFor(store, contents, folderId)
  return pickWorktree(worktrees, worktreeKey, { strict: false })
}

/** 把待落盤的東西立刻寫下去。關視窗與 reload 都必須先走這裡，否則最後一次改動就飛了。 */
function flush(service: TerminalService, sessions: SessionStore): void {
  for (const [contentsId, entry] of pending) {
    clearTimeout(entry.timer)
    sessions.replace(entry.incoming)
    pending.delete(contentsId)
  }
  refreshCwd(service, sessions)
}

export function registerTerminalHandlers(
  store: FolderLookup,
  sessions: SessionStore,
  preferences: PreferencesStore,
): void {
  ipcMain.on(TERMINAL_CHANNELS.watchStatus, (event, sessionId: unknown) => {
    const service = serviceFor(store, sessions, preferences, event.sender)
    const target: string | null = typeof sessionId === 'string' ? sessionId : null
    statusServiceFor(service, event.sender).watch(target)
  })

  ipcMain.handle(
    TERMINAL_CHANNELS.create,
    (event, folderId: string | null, target: SpawnTarget, worktreeKey?: string, ticket?: unknown) =>
    toResult(async () => {
      // **識別碼 → 路徑的解析在這裡完成，不在 `TerminalService` 裡**：列舉住在 OpenSpec 資料層，
      // 而 terminal 服務不該認識它。`worktreesFor` 走的是**與側欄同一個實例與同一組參數** ——
      // 繞過它直接呼叫 core 會因 `includeJj` 預設不同而讓可達的位置集合大於使用者看得到的那組。
      //
      // **全域 session 的工作目錄集合是空的**（它不隸屬任何 repo）—— 於是「帶識別碼即拒絕」
      // 不是一條新的特例，而是既有的「查無對應即拒絕、不退回預設位置」在空集合上的自然結果。
      // 型別互斥擋不到這裡：IPC 的另一端是不受信任的輸入。
      const { cwd, worktreeRoots } = await pickCreateWorktree(
        (id) => worktreesFor(store, event.sender, id),
        folderId,
        worktreeKey,
      )
      // 識別碼、來源與名字在 spawn 之前就落在暫定紀錄裡 —— 順序的理由見 `session-create.ts`。
      const result = await createSession({
        sessions,
        folderId,
        target,
        railLabel: railLabelOf(store, folderId),
        ticket,
        spawn: (sessionId, peerName) =>
          serviceFor(store, sessions, preferences, event.sender).create(folderId, target, {
            sessionId,
            cwd,
            worktreeRoots,
                        peerName,
          }),
      })

      if (result.conversationId) {
        sessions.update(result.sessionId, { claudeSessionId: result.conversationId })
      }
      hibernation.track(result.sessionId, target)
      ptyChanged()
      return { sessionId: result.sessionId, ...(result.lineage ? { lineage: result.lineage } : {}) }
    }),
  )

  // 喚醒＝以持久化的續接資訊重新 spawn，**沿用同一個 sessionId**（分頁、名字、順序、錨定都掛在
  // 它身上，不能因為重建而改變）。renderer 只給 sessionId —— 對話識別碼與 cwd 都在主行程手上。
  ipcMain.handle(TERMINAL_CHANNELS.wake, (event, sessionId: string) =>
    toResult(async () => {
      const persisted = sessions.get(sessionId)
      if (!persisted) throw new TerminalError('UNKNOWN_SESSION', `unknown session: ${sessionId}`)

      const { cwd: worktreeCwd, worktreeRoots } = await resolveWorktreeForRebuild(
        store,
        event.sender,
        persisted.folderId,
        persisted.worktreeKey,
      )

      // **claude 用識別碼解析出的位置，不用觀測值**（design D4）：它的 pty cwd 不會漂移
      // （agent 的 `cd` 發生在子行程），而識別碼記錄的是使用者的**選擇**。
      // **shell 相反** —— 使用者真的會 `cd`，所以用記錄的最後位置；沒有記錄時退回建立時的位置。
      const cwd = persisted.spawnTarget === 'shell' ? (persisted.cwd ?? worktreeCwd) : worktreeCwd

      const service = serviceFor(store, sessions, preferences, event.sender)
      const result = await service.create(persisted.folderId, persisted.spawnTarget, {
        sessionId: persisted.id,
        resumeConversationId: persisted.claudeSessionId,
        cwd,
        worktreeRoots,
        peerName: persisted.peerName,
      })
            if (result.conversationId) {
        sessions.update(sessionId, { claudeSessionId: result.conversationId })
      }
      hibernation.track(sessionId, persisted.spawnTarget)
      ptyChanged()
      return { sessionId: result.sessionId }
    }),
  )

  ipcMain.handle(TERMINAL_CHANNELS.restore, (event): RestoredSession[] => {
    // folder 已被移出 workspace → 它的 session 不再有歸屬，從持久化移除（design D11）。
    //
    // **全域 session 不適用**：它本來就不隸屬任何 folder，移除任何 repo 都動不到它。少了這道
    // 判斷，`known.has(null)` 恆為 false ⇒ 每一次 restore 都會把全部的全域 session 清光，
    // 而那正是這個 change 要交付的東西。
    const known = new Set(store.list().map((folder) => folder.id))
    for (const session of sessions.list()) {
      if (session.folderId === null) continue
      if (!known.has(session.folderId)) sessions.remove(session.id)
    }

    // 建立 service（若尚未存在）—— 於是 did-navigate／destroyed 的清理鉤子在第一次重建時就掛上。
    serviceFor(store, sessions, preferences, event.sender)

    // `lineage` **要**送（renderer 靠它畫樹與標示，它不含路徑）；`peerName` 不送（renderer 用不到）。
    return sessions.list().map(({ claudeSessionId: _c, cwd: _w, peerName: _n, ...rest }) => ({
      ...rest,
      // claude 續接時會自行重現先前的對話 —— 再重播一次快照，使用者會看到兩份歷史（design D3）。
      scrollback:
        rest.spawnTarget === 'shell' ? (sessions.readScrollback(rest.id) ?? undefined) : undefined,
    }))
  })

  ipcMain.on(TERMINAL_CHANNELS.persist, (event, incoming: RendererSession[]) => {
    if (!Array.isArray(incoming)) return
    const service = serviceFor(store, sessions, preferences, event.sender)
    const contentsId = event.sender.id

    const existing = pending.get(contentsId)
    if (existing) clearTimeout(existing.timer)

    const timer = setTimeout(() => {
      pending.delete(contentsId)
      sessions.replace(incoming)
      refreshCwd(service, sessions)
    }, PERSIST_DEBOUNCE_MS)
    pending.set(contentsId, { timer, incoming })
  })

  ipcMain.on(TERMINAL_CHANNELS.snapshot, (event, sessionId: string, data: string) => {
    if (typeof sessionId !== 'string' || typeof data !== 'string') return
    sessions.writeScrollback(sessionId, data)

    // 快照大約每兩秒來一次（session 有輸出時）—— 順道把 cwd 一起刷新，於是「使用者 cd 過去、
    // 然後 app 被強制結束」也留得住最後的位置，不必倚賴關窗時的收尾。
    const service = serviceFor(store, sessions, preferences, event.sender)
    const cwd = service.cwdOf(sessionId)
    if (cwd) sessions.update(sessionId, { cwd })
  })

  // write／resize／kill 是單向 fire-and-forget（design D4）：逐鍵輸入若每次都等一次
  // round-trip 的回應是浪費。
  ipcMain.on(TERMINAL_CHANNELS.write, (event, sessionId: string, data: string) => {
    serviceFor(store, sessions, preferences, event.sender).write(sessionId, data)
  })

  ipcMain.on(TERMINAL_CHANNELS.resize, (event, sessionId: string, cols: number, rows: number) => {
    serviceFor(store, sessions, preferences, event.sender).resize(sessionId, cols, rows)
  })

    ipcMain.on(TERMINAL_CHANNELS.kill, (event, sessionId: string) => {
    const hadPty = serviceFor(store, sessions, preferences, event.sender).kill(sessionId)
    if (!hadPty && typeof sessionId === 'string') {
      // A dormant session has no pty, so `kill()` did none of its cleanup. Restored sessions always
      // leaked their drop point this way; hibernation makes closing a dormant session routine.
      // Only in this case, so a live session's drop point is not scanned twice.
      clearAgentStatus(sessionId)
      clearAgentEvents(sessionId)
      endHandoffSession(sessionId)
    }
    // A closed session's attachments go, live or dormant (`remote-attachments`); hibernation does not come here.
    if (typeof sessionId === 'string') attachmentStore()?.removeSession(sessionId)
    sessions.remove(sessionId)
  })

  ipcMain.on(TERMINAL_CHANNELS.displayed, (event, sessionId: unknown) => {
    // Make sure the service exists, so its cleanup hooks also clear this report.
    serviceFor(store, sessions, preferences, event.sender)
    hibernation.setDisplayed(event.sender.id, typeof sessionId === 'string' ? sessionId : null)
  })

  /**
   * Hibernate a session. Without a token it is the user's request and always proceeds (the displayed
   * or a working session included). With one it is an automatic request from `requestIdleHibernation`,
   * and the policy is checked again here: the session may have been displayed or started working
   * during the round trip (design D3).
   */
  ipcMain.handle(TERMINAL_CHANNELS.hibernate, (event, sessionId: unknown, token: unknown) => {
    if (typeof sessionId !== 'string') return { ok: false }
    const service = serviceFor(store, sessions, preferences, event.sender)
    if (token !== undefined) {
            if (typeof token !== 'string') return { ok: false }
      const facts = service.idleFactsOf(sessionId)
      if (!facts || !hibernation.authorize(sessionId, token, facts.shell, thresholdMs(preferences))) return { ok: false }
    }
    return { ok: service.hibernate(sessionId) }
  })

  scheduleIdleHibernation(preferences)
}

function thresholdMs(preferences: PreferencesStore): number {
  return effectiveHibernateSeconds(preferences.get().autoHibernateSeconds) * 1000
}

/**
 * One evaluation of the automatic-hibernation policy: ask each renderer to hibernate its eligible
 * sessions. The renderer runs the same path as a manual hibernation (it must serialize a shell's
 * screen first) and returns the token, which `hibernate` checks again.
 */
function requestIdleHibernation(preferences: PreferencesStore): void {
  hibernation.newTick()
  const threshold = thresholdMs(preferences)
  if (threshold <= 0) return
  for (const [contentsId, service] of services) {
    const contents = owners.get(contentsId)
    if (!contents || contents.isDestroyed()) continue
    for (const sessionId of service.liveSessionIds()) {
      const facts = service.idleFactsOf(sessionId)
      if (!facts || !hibernation.eligible(sessionId, facts.shell, threshold)) continue
      contents.send(TERMINAL_CHANNELS.hibernateRequest, sessionId, hibernation.issueToken(sessionId))
    }
  }
}

/**
 * The periodic evaluation. The preference is read on every tick, so a change applies without a
 * restart; the period follows the threshold (a quarter of it, 1–60 s), so a probe seeding a threshold
 * of seconds does not wait a minute.
 */
function scheduleIdleHibernation(preferences: PreferencesStore): void {
  const next = (): void => {
    const timer = setTimeout(() => {
      try {
        requestIdleHibernation(preferences)
      } catch (error) {
        console.error(`[terminal] automatic hibernation failed: ${String(error)}`)
      }
      next()
    }, tickPeriodMs(effectiveHibernateSeconds(preferences.get().autoHibernateSeconds)))
    // The app's lifetime is the windows', not this timer's.
    timer.unref()
  }
  next()
}
