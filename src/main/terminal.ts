import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { type IPty, spawn } from 'node-pty'
import { clearAgentStatus, prepareInjection } from './agent-status'
import { clearAgentEvents, prepareEventInjection } from './agent-events'
import { noteWrite, type WriteOrigin } from './pty-input'
import { noteProcessEnd, noteProcessStart } from './session-runs'
import { prepareAttachmentAccess } from './remote-attachments'
import { type Injection, type InjectionContribution, composeInjection } from './agent-injection'
import { isWithin } from './fs-boundary'
import { readPtyCwd } from './pty-cwd'
import { type FileIdentity, type ShellFacts, fileIdentity, readShellFacts } from './hibernation-policy'
import { isUuid } from './session-store'
import { getUserEnv, whenUserEnvReady } from './user-env'
import type { FolderLookup } from './workspace-store'
import { t } from '@shared/i18n'

/** 新 session 的 spawn 目標。兩者都經 login shell 啟動（design D6）。 */
export type SpawnTarget = 'claude' | 'shell'

export type TerminalCode =
  | 'UNKNOWN_FOLDER'
  | 'UNKNOWN_SESSION'
  | 'UNKNOWN_WORKTREE'
  | 'FOLDER_UNAVAILABLE'
  | 'SPAWN_FAILED'

export class TerminalError extends Error {
  constructor(
    readonly code: TerminalCode,
    message: string,
  ) {
    super(message)
    this.name = 'TerminalError'
  }
}

/**
 * pty 事件的出口。與 `WatchService` 同源：管理器不依賴 Electron，推送的出口由建構端注入，
 * 因此可由單元測試直接驅動（餵它一個假的 sink，斷言收到的事件）。
 */
/**
 * pty 為什麼結束了。**這個區分是承重的**（session-persistence）。
 *
 * - `self` —— pty 自己死了（使用者打了 `exit`、claude 收工、命令啟動失敗）。這是**真的**
 *   session 結束：它不再被持久化，重開 app 不該把一個死掉的分頁重建回來。
 * - `killed` —— 使用者關掉了這個 session。同上。
 * - `disposed` —— **關視窗或 reload 時我們自己殺的。** pty 死是設計（不留孤兒行程），
 *   **session 沒有結束** —— 它正要被持久化下來，等下次開啟時重建。
 *
  * 少了這個區分，關視窗時每個 pty 的 exit 都會被當成「session 結束了」而把它從持久化裡抹掉
 * —— 那就是「關掉 app 之後 session 全部不見」本人，只是換了一種寫法。
 *
 * - `hibernated` — the session was put back to dormant (`session-hibernation`). Like `disposed`, the
 *   session does not end and persistence is untouched; unlike it, the renderer must be told, because
 *   that renderer keeps the session and shows it dormant.
 */
export type ExitReason = 'self' | 'killed' | 'disposed' | 'hibernated'

/** How a session's process ended, as a paired device is told (`remote-protocol`, `remote-hibernate-close` D5). */
export type SessionEnd = 'exited' | 'hibernated' | 'closed'

/**
 * Total over `ExitReason`, so a new reason does not compile until it is placed. `killed` is a close: only
 * `kill()` sets it, and only the close IPC calls that. `disposed` is unreachable for a device: `windowGone`
 * stops every watch before the disposed ptys' exits arrive.
 */
export const SESSION_END: Record<ExitReason, SessionEnd> = {
  self: 'exited',
  hibernated: 'hibernated',
  killed: 'closed',
  disposed: 'exited',
}

export interface TerminalSink {
  data(sessionId: string, chunk: string): void
  exit(sessionId: string, exitCode: number, reason: ExitReason): void
  /**
   * claude 的對話識別碼確定了（新建時是剛產生的；續接失敗自癒後是**換過的那一個**）。
   *
   * 這個事件存在的理由：對話 id 是**主行程的知識**，renderer 從來沒有這個詞彙，但它必須被
   * 持久化，而持久化的落點也在主行程 —— 於是這個 sink 只通知擁有者「該把它記下來了」。
   */
  conversation(sessionId: string, conversationId: string): void
  /** A new pty now serves the session (a spawn, a wake, or a heal). Remote terminal positions restart. */
  spawned?(sessionId: string): void
  /** The session's pty took a new size. */
  resized?(sessionId: string, cols: number, rows: number): void
}

/** pty 初始尺寸。renderer 掛載後會 fit 並 resize 校正，這只是 spawn 當下的暫定值。 */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

/**
 * 續接失敗的判定窗口：pty 在這段時間內以**非零碼**結束，視為 `claude --resume` 沒接上
 * （實測：`No conversation found with session ID: …` 之後 exit 1，發生在啟動階段、數百毫秒內）。
 *
 * **判準只看「時間 + 結束碼」，不解析 claude 的輸出** —— 不去 parse 別人的錯誤訊息。
 *
 * 代價（已知且有界）：一個**續接成功後隨即崩潰**的 claude 會被誤判為續接失敗，於是自癒成一個
 * 全新的對話，舊對話的指標就此遺失（那份對話仍在磁碟上，使用者仍可在 shell 裡 `claude --resume`
 * 用選單找回來）。窗口取得短，是為了壓低這個誤判的機率。
 */
const RESUME_FAILURE_WINDOW_MS = 3000

/** 桌面啟動的 GUI app 常缺使用者 shell 的 PATH，故一律經 login shell（design D6）。 */
function resolveShell(): string {
  return process.env.SHELL || '/bin/bash'
}

/**
 * 「我正跑在一個 Claude Code session 裡」的標記。**spekterm 的終端是頂層終端，不是誰的子行程**
 * —— 這些標記不得洩漏進 pty。
 *
 * **為什麼這是承重的（實測）**：spekterm 若由一個 agent 啟動（`npm run dev` 是 agent 幫忙跑的 ——
 * dogfooding 時的常態），Electron 會繼承那個 Claude Code session 的 env，pty 再整份繼承下去。
 * 於是裡面每一個 `claude` 都認為自己是**巢狀的子 session**，而**巢狀的 claude 不寫 transcript**
 * —— `--resume` 於是必然失敗，`session-persistence` 的核心承諾（續接對話）**靜默地失效**。
 *
 * 而自癒機制會把這個失敗**蓋掉**：使用者拿到一個能用的 claude，只是對話永遠是全新的。
 * **最糟的那種 bug —— 它看起來像正常運作。**
 *
 * 二分實測出的元兇只有 **`CLAUDE_CODE_CHILD_SESSION`** 一個（單獨拿掉它，transcript 就寫出來了；
 * 單獨拿掉 `CLAUDECODE` 或 `CLAUDE_CODE_ENTRYPOINT` 都無效）。其餘一併移除，是因為它們表達的是
 * 同一件事——「這個行程隸屬於某個 Claude Code session」——而那對 spekterm 的 pty 一律不成立。
 *
 * **絕不以 `CLAUDE*` 前綴一概剝除**：`CLAUDE_CODE_OAUTH_TOKEN` 是認證用的，剝掉它 claude 會登不進去。
 * 名單是明確列舉的，且不含任何帶 KEY／TOKEN 的名字。
 *
 * **這組標記無論來自哪裡都要剝除**，包含使用者環境（見下方 `ptyEnv`）。此前這裡寫著「使用者自己
 * 在 `~/.zshrc` 設定的變數不受影響 —— 我們 spawn 的是 login shell，它會重新 source 那些檔案」；
 * 那句話對 **claude 目標從來就不成立**（它是非互動 shell，不讀 rc），而在使用者環境被合併進來
 * 之後更會誤導：rc 若設了這裡面的名字，剝除之後**沒有東西會把它還原**。那是刻意的 —— 一個宣稱
 * 自己隸屬於某個 Claude Code session 的 pty，對 spekterm 一律不成立。
 */
const NESTED_CLAUDE_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_AGENT',
  'CLAUDE_JOB_DIR',
] as const

/**
 * pty 的環境：主行程的環境 ＋ 使用者互動 shell 的環境，然後蓋回我們承重的兩件事。
 *
 * **合併順序就是優先順序，而使用者的值在中間是刻意的。** 「等同使用者的 shell 環境」就是這個
 * 意思 —— 他在自己的終端機裡跑同一個東西時看到什麼，這裡就該是什麼。放在最後蓋回來的只有兩樣：
 * `TERM`（我們決定終端模擬的能力集）與「巢狀 Claude Code」的標記剝除（見上）。
 *
 * **`PATH` 不在 `user` 裡**（`getUserEnv()` 已經把它拿掉）—— 它早就併進 `process.env.PATH` 了，
 * 而那份是**超集**：使用者的項目前置、產物自身注入的在後。讓使用者的原始 `PATH` 在這裡覆蓋回去，
 * 會把後者丟掉。
 *
 * 這對**兩種** spawn 目標都適用：使用者在 login shell session 裡手動打 `claude`，會踩到一模一樣的坑。
 */
export function ptyEnv(
  source: NodeJS.ProcessEnv = process.env,
  user: Readonly<Record<string, string>> = getUserEnv(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, ...user, TERM: 'xterm-256color' }
  for (const key of NESTED_CLAUDE_ENV) delete env[key]
  // **本應用程式替 session 設定的專屬變數一律不從外層繼承**（`agent-peer-name`）。
  //
  // 開發時 spekterm 常在另一個 spekterm 的 session 裡被啟動（`npm run dev`），於是 `process.env`
  // 帶著外層那個 session 的 `SPEKTERM_PEER_NAME`、`SPEKTERM_HANDOFF_DIR`、`SPEKTERM_EVENT_DIR`…
  // 內層只要有一條路沒帶自己的值（例如某個注入被關掉），就拿到**外層仍在執行**的那個名字與落點 ——
  // 兩個 agent 同名、交接寫進別人的目錄，而沒有任何東西會紅。各 session 的值在這之後由呼叫端合併。
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPEKTERM_')) delete env[key]
  }
  return env
}

/** 固定名字經這個環境變數交給 agent CLI（`agent-peer-name`）。 */
export const PEER_NAME_ENV = 'SPEKTERM_PEER_NAME'

/**
 * 同一個 session 的前一顆 pty 的結束。
 *
 * **模組層級**，因為 renderer 重新載入時舊的 `TerminalService` 被 dispose、新的被建立 —— 前一顆
 * pty 屬於舊的那個服務，新的服務要能等到它。
 */
const lastExit = new Map<string, Promise<void>>()

/** 等前一顆 pty 結束的上限。逾時照樣 spawn（記錄下來）—— 卡住的是一個看不見的舊行程，不是使用者。 */
export const PREVIOUS_PTY_WAIT_MS = 3_000

async function previousExited(sessionId: string): Promise<void> {
  const pending = lastExit.get(sessionId)
  if (!pending) return
  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    pending.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), PREVIOUS_PTY_WAIT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (timedOut) console.error('[terminal] the previous pty of this session did not exit in time; spawning anyway')
}

/**
 * login shell 模式：互動 login shell（`-l`）。
 * claude 模式：以 login shell 執行 `claude`（`-l -c <命令>`）——讓 nvm／Homebrew 等
 * 由 profile 載入的 PATH 生效，`claude` 才找得到；claude 收工後 session 隨之結束。
 *
 * **`conversationId` 會被拼接進一個字串命令，因此它必須是 UUID** —— 呼叫端已驗證，這裡再擋一次
 * （這種東西不值得只擋一層）。新建對話用 `--session-id`（由我們指定 id，於是它可被持久化並在
 * 下次續接）；續接用 `--resume`（實測：它**沿用**原 id，不會換號 —— `--fork-session` 才換）。
 */
function spawnArgs(
  target: SpawnTarget,
  conversation: ClaudeConversation | undefined,
  injection: Injection | null,
  peerName?: string,
): string[] {
  // claude 目標**恆有**一個對話（`create()` 不是續接就是新建）—— 沒有「不帶 id 的 claude」。
  if (target !== 'claude' || !conversation) return ['-l']

  const { id, mode } = conversation
  if (!isUuid(id)) throw new TerminalError('SPAWN_FAILED', t('terminalError.invalidConversationId'))

  const flag = mode === 'resume' ? '--resume' : '--session-id'
  // 注入的片段已在 `agent-status` 內 shell-quote 過；`null` 代表不注入（偏好關閉，或使用者有
  // 自訂 statusline 而我們串不上 —— 那時寧可不做，也不弄壞他現有的）。
  const settings = injection ? `${injection.commandFragment} ` : ''
  // **名字不拼進命令字串** —— 它含 folder 名稱，而那是使用者檔案系統上的任意字串。命令裡只有這個
  // 固定片段，值由環境變數交付（雙引號內的展開結果不會被 shell 再解析一次）。**不經
  // `composeInjection`**：那些功能全關時它回 `null`，名字會跟著消失（`agent-peer-name`）。
  const name = peerName ? ` --name="$${PEER_NAME_ENV}"` : ''
  return ['-l', '-c', `claude ${settings}${flag} ${id}${name}`]
}

interface ClaudeConversation {
  id: string
  mode: 'resume' | 'new'
}

export interface SpawnOptions {
  /**
   * 重建一個既有 session 時沿用它的識別碼。**分頁、focus、順序、錨定全掛在這個 id 上**，
   * 它不能因為重建而改變（design D1）。
   */
  sessionId?: string
  /** claude：續接這個對話。非 UUID 一律忽略並以全新對話開始 —— 絕不拼接未經驗證的值。 */
  resumeConversationId?: string
  /**
   * claude：固定名字（`agent-peer-name`）。**由呼叫端決定並落盤**，這裡只負責交付 —— 名字要在
   * session 建立時就決定（休眠的 session 也要有），而 `TerminalService` 不認識 session 清單。
   */
  peerName?: string
  /** shell：最後已知的工作目錄。夾制於下方 `worktreeRoots` 所定義的範圍內；越界或不可用時退回根目錄。 */
  cwd?: string
  /**
   * 該 folder 所屬 repo 的工作目錄根（絕對路徑）—— cwd 夾制的合法範圍，folder 根之外的部分。
   *
   * **由呼叫端供應，`TerminalService` 不自行查詢** —— 列舉住在 OpenSpec 資料層，而這個服務
   * 不該認識它（見 `ipc/openspec.ts` 的 `worktreesFor`）。
   */
  worktreeRoots?: readonly string[]
}

export interface SpawnResult {
  sessionId: string
  /** claude 目標實際使用的對話識別碼。 */
  conversationId?: string
}

interface Session {
  pty: IPty
  /**
   * 這個 session 不隸屬於任何 workspace folder（見 `global-session`）。
   *
   * 它的 `folderPath` 是家目錄 —— 那是**起點**，不是**邊界**：兩道 cwd 夾制對它一律放行
   * （只保留存在性檢查）。既有夾制的正當性來自「session 宣稱自己屬於某個 folder」，而它沒有
   * 這個宣稱；夾制在這裡唯一的效果會是「使用者 `cd` 到別處之後重開 app 莫名跳回家目錄」。
   */
  global: boolean
  folderPath: string
  /**
   * 這顆 pty 誕生時的工作目錄。
   *
   * **`#heal()` 需要它**：自癒重生的 pty 若一律回到 `folderPath`，一個開在 worktree 的 session
   * 就會**靜默地**站到別的地方 —— 而自癒是主線情境（沒跟 agent 講過話的 session，`--resume`
   * 必定失敗），且它對 renderer **完全不可見**。與旁邊那條「繼承將死那顆 pty 的 cols／rows」
   * 同一個理由、同一個位置。
   */
  cwd: string
  /**
   * cwd 夾制的合法根集合（spawn 當下的快照）。
   *
   * **由 session 自己記住，不由 `cwdOf` 的呼叫端供應** —— `refreshCwd` 走的是同步路徑
   * （關視窗、reload 時的 `flush`），而工作目錄的列舉是非同步的。
   *
   * 快照可能過期（spawn 之後才新建的 worktree 不在其中）。後果是「`cd` 到那個新 worktree 後，
   * 位置不被記錄」⇒ 重建時退回 folder 根 —— 與本 change 之前的行為相同，降級方向安全。
   */
  worktreeRoots: readonly string[]
  target: SpawnTarget
  conversation?: ClaudeConversation
  startedAt: number
  /** 自癒已經用掉了 —— 至多一次（否則 `claude` 沒安裝時會無限重試）。 */
  healed: boolean
    /** claude 目標的固定名字。**自癒要沿用它** —— 那是 pty 誕生時要做的事的又一例。 */
  peerName?: string
  /**
   * Shell target: the identity of the shell binary it was spawned as (`session-hibernation`). A pty
   * whose process no longer matches has replaced itself (`exec vim`) and never qualifies as idle.
   */
  shellIdentity: FileIdentity | null
}

/**
 * `cwd` 是否落在 folder 根、或該 repo 任一工作目錄之下。
 *
 * **兩道夾制共用它**（`#initialCwd` 與 `cwdOf`）—— 只放寬其中一道是沒有用的：記錄側若仍夾制回
 * folder 邊界內，邊界外 worktree 的位置**從一開始就不會被寫進 `sessions.json`**，於是重建側收到
 * 的是 `undefined`，看起來一切正常。失效方向是靜默的。
 */
function withinAny(folderPath: string, worktreeRoots: readonly string[], cwd: string): boolean {
  if (isWithin(folderPath, cwd)) return true
  return worktreeRoots.some((root) => isWithin(root, cwd))
}

/**
 * `cwd` 是否落在該 session 的合法範圍之內 —— **兩道夾制唯一的判定入口**。
 *
 * 全域 session 沒有路徑邊界可夾（見 `Session.global`），一律放行；其餘沿用 `withinAny`。
 * 把 global 的分支收在這裡，是為了讓「兩道必須用同一個判定」這件事由結構保證：
 * 只放寬其中一道等於沒放寬 —— 記錄側若仍夾制，越界的位置**從一開始就不會被寫進
 * `sessions.json`**，重建側收到 `undefined` 而一切看起來正常（靜默失效）。
 */
function cwdAllowed(
  scope: { global: boolean; folderPath: string; worktreeRoots: readonly string[] },
  cwd: string,
): boolean {
  if (scope.global) return true
  return withinAny(scope.folderPath, scope.worktreeRoots, cwd)
}

/**
 * 多 session 的 pty 管理器。每個 session 對應一個 node-pty 行程，其生命週期由**擁有者**
 * （某個 `webContents`）在 ipc 層界定：擁有者銷毀或重新載入時，`dispose()` 殺光全部
 * （design D1、D2）。
 *
 * `#sessions` 恆等於「**還活著**的 pty」：`onExit` 一觸發就從 Map 移除——pty 已死，它的
 * 輸出早已串流至 renderer，主行程再留著實例沒有意義。renderer 端仍會在 UI 保留這個
 * 已結束的 session（標示 exited、輸出仍可讀），那是 renderer 的清單，與此 Map 無關。
 */
export class TerminalService {
  readonly #sessions = new Map<string, Session>()

  /**
   * 我們主動殺掉的 pty 及其原因。
   *
   * **原因必須掛在 pty 上、由真正的 `onExit` 讀出來**，不能在 `kill()`／`dispose()` 當下就直接
   * 回報結束 —— 那樣「exit 事件」就不再是「這個行程真的死了」的證據，而「不留孤兒行程」的驗收
   * 正是靠它。`kill()` 是非同步的：呼叫它的當下 pty 還活著。
   */
  readonly #reasons = new WeakMap<IPty, ExitReason>()

  constructor(
    private readonly store: FolderLookup,
    private readonly sink: TerminalSink,
    /**
     * 是否啟用與 agent 的狀態橋接。**在 spawn 的當下求值**（不是建構時）—— 偏好可在執行期改變，
     * 而注入是每個 session 各自決定的。切換偏好只影響其後建立或重建的 session，這是誠實的限制。
     */
    private readonly agentStatusEnabled: () => boolean = () => false,
    /**
     * 是否啟用與 agent 的事件橋接。**與狀態橋接各自獨立求值** —— 關掉其中一個 SHALL NOT
     * 使另一個失效（`claude-status-bridge` 的合成條款）。
     */
    private readonly agentEventsEnabled: () => boolean = () => false,
    /** 合成後的設定檔落點。各功能共用同一份（接縫只有一個）。 */
    private readonly settingsFile: () => string = () => '',
    /**
     * 交接的注入貢獻（自我介紹 ＋ 投遞落點）。
     *
     * **以回呼而非旗標傳入**：它要 workspace 的 folder 清單與 userData 的位置，而 pty 的服務
     * 不該認得那兩樣東西。與其餘貢獻者一樣**在 spawn 的當下求值**。
     */
    private readonly prepareHandoff: (sessionId: string) => InjectionContribution | null = () => null,
    /**
     * session 結束 —— 交接的落點要清掉，**而清掉之前要先把裡面既有的項目處理完**。
     *
     * **以回呼傳入而不是直接 import `clearOutbox`**：那個順序（先處理、再清除）住在
     * `handoff-service`，pty 的服務不該知道它。直接清會讓一則已經投遞、尚未被讀到的交接
     * 隨 session 的結束而消失，而投遞端與使用者兩邊都不會知道。
     */
    private readonly endHandoff: (sessionId: string) => void = () => {},
  ) {}

  /**
   * pty 當下的工作目錄，**未經 folder 邊界夾制、且不限 spawn 目標** —— 供狀態列**呈現**用。
   *
   * 與 `cwdOf()` 的差別是刻意的：那個是為了**持久化**（重建時要 `cd` 回去），因此夾制在 folder
   * 邊界內；狀態列要的是**事實** —— 使用者 `cd` 到 workspace 之外，狀態列就該誠實地說他在那裡。
   * 這裡交出去的是一個顯示用的字串，不是可定址的檔案系統詞彙（`folder.path` 早已同樣送給 renderer）。
   */
  liveCwdOf(sessionId: string): string | undefined {
    const session = this.#sessions.get(sessionId)
    return session ? readPtyCwd(session.pty.pid) : undefined
  }

  /**
   * agent session 的紀錄來源座標：pty **誕生時**的工作目錄與當下的對話識別碼。
   *
   * **誕生時的 cwd，不是當下的** —— agent 的紀錄落點由它啟動那一刻的工作目錄決定，其後即使
   * 使用者 `cd` 走也不會換檔（實測）。用 `liveCwdOf()` 會在 shell 目標混用時算出一個不存在的位置。
   *
   * 非 agent 目標回 `null`：shell session 沒有紀錄可跟。
   */
  agentSourceOf(sessionId: string): { cwd: string; conversationId: string } | null {
    const session = this.#sessions.get(sessionId)
    if (!session || session.target !== 'claude' || !session.conversation) return null
    return { cwd: session.cwd, conversationId: session.conversation.id }
  }

  /** 還活著的 pty 數量。驗收「關閉／dispose 後確實清理」用得上。 */
  /** 目前持有 pty 的 claude session（關係檔的範圍：「是否在執行」即由它回答）。 */
  runningAgents(): string[] {
    return [...this.#sessions].filter(([, session]) => session.target === 'claude').map(([id]) => id)
  }

    get sessionCount(): number {
    return this.#sessions.size
  }

  /** Sessions that currently hold a pty. */
  liveSessionIds(): string[] {
    return [...this.#sessions.keys()]
  }

  /**
   * What automatic hibernation needs to know about a live session (`session-hibernation`, design D4).
   * `null` when the session holds no pty.
   */
  idleFactsOf(sessionId: string): { target: SpawnTarget; shell: ShellFacts } | null {
    const session = this.#sessions.get(sessionId)
    if (!session) return null
    if (session.target !== 'shell') return { target: session.target, shell: 'unknown' }
    return { target: 'shell', shell: readShellFacts(session.pty.pid, session.shellIdentity) }
  }

  /**
   * 在指定 folder 開一個 session。**只接受 folderId，不接受來自 renderer 的任何路徑**——於是
   * renderer 在語彙上無從把初始 cwd 指向 workspace 之外（design D5）。
   *
   * `options.cwd` 不破壞這條：它由**主行程自己**（持久化層）供應，而且在這裡被夾制回 folder
   * 邊界內。renderer 呼叫得到的 IPC 從來沒有 cwd 這個參數（session-persistence 的
   * 「持久化不得把路徑詞彙交給 renderer」）。
   */
  /**
   * **建立前先等使用者環境就緒**（`terminal-sessions` 的「啟動後立即建立的 session 同樣拿到完整
   * 環境」）。解析於 module load 就開始，而使用者要看到視窗、點下建立入口才會走到這裡 ——
   * 實測解析約 1.2 秒，通常早就跑完；最壞是 `user-env.ts` 的 5 秒逾時。
   *
   * **不變式與呼叫端是否 `await` 無關** —— `await` 在這裡面，漏掉 await 的呼叫端只是拿不到回傳值
   * 的時序，環境該齊的一樣齊。（本 repo 的 eslint 沒有 type-checked 設定也沒有
   * `no-floating-promises`，所以「型別會擋住漏掉的呼叫端」只對「會用到回傳值」的呼叫點成立。）
   *
   * 取得失敗或放棄時 `whenUserEnvReady()` 一樣會 resolve —— **session 照常建立**，只是環境不完整。
   * 一個因為環境查不到而建不出來的 session，比一個環境不完整的 session 更糟。
   */
  async create(
    folderId: string | null,
    target: SpawnTarget,
    options: SpawnOptions = {},
  ): Promise<SpawnResult> {
    await whenUserEnvReady()

    // **全域 session：位置是主行程的常數，renderer 什麼都選不了**（`global-session`）。
    // 於是可達的初始工作目錄集合恰好擴大一個元素，而它不由任何 renderer 送來的字串決定 ——
    // 這條路徑上沒有新的路徑詞彙、沒有新的識別碼空間、沒有新的查表。
    const global = folderId === null
    const folderPath = global ? os.homedir() : this.#folderPathOf(folderId)

    const sessionId = options.sessionId ?? randomUUID()
    // 同一個 session 的前一顆 pty（renderer 重新載入時被非同步地殺掉）還沒結束的話，兩個同名的
    // agent 會並存 —— 實測 CLI 不會替其中一個改名，於是那段期間名字是歧義的。
    await previousExited(sessionId)

    // 續接的 id 不合法時**不是錯誤，是「沒有東西可以續接」** —— 以全新對話開始，而不是把一個
    // 未經驗證的字串拼進命令，也不是讓這個 session 就此死掉（design D8、spec 的「不合法的對話
    // 識別碼不進入命令」）。
    const resumable = target === 'claude' && isUuid(options.resumeConversationId)
    if (target === 'claude' && options.resumeConversationId && !resumable) {
      console.error('[terminal] the persisted conversation id is invalid; starting a fresh conversation')
    }

    const conversation: ClaudeConversation | undefined =
      target !== 'claude'
        ? undefined
        : resumable
          ? { id: options.resumeConversationId as string, mode: 'resume' }
          : { id: randomUUID(), mode: 'new' }

    const worktreeRoots = options.worktreeRoots ?? []
    this.#spawn(sessionId, folderPath, target, conversation, {
      cwd: this.#initialCwd({ global, folderPath, worktreeRoots }, options.cwd),
      worktreeRoots,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      healed: false,
      global,
      peerName: target === 'claude' ? options.peerName : undefined,
    })

    return { sessionId, conversationId: conversation?.id }
  }

  /** 查表解析 folder 的路徑；查無或路徑失效即拒絕（**不退回任何預設位置**）。 */
  #folderPathOf(folderId: string): string {
    const folder = this.store.list().find((candidate) => candidate.id === folderId)
    if (!folder) throw new TerminalError('UNKNOWN_FOLDER', t('terminalError.unknownFolder', { folderId }))
    if (folder.status !== 'ok') {
      throw new TerminalError('FOLDER_UNAVAILABLE', t('terminalError.folderUnavailable', { path: folder.path }))
    }
    return folder.path
  }

  /**
   * 重建的工作目錄 —— **夾制於 folder 根或該 repo 任一工作目錄之下**。
   *
   * 越界（使用者關 app 前 `cd` 到別處了）或已不存在時退回 folder 根。`folderPath`、
   * `worktreeRoots` 與 `/proc` 讀回的 cwd 都已經是解析過 symlink 的真實路徑，故可直接比對。
   *
   * **這是重建路徑的寬容，建立路徑不得沿用它**：識別碼查無對應時 `create` 要**拒絕**
   * （`terminal-sessions` 明文），而這裡對「路徑消失」是退回根目錄 —— 同一個問題，
   * 兩條路徑的正確行為相反。
   */
  #initialCwd(
    scope: { global: boolean; folderPath: string; worktreeRoots: readonly string[] },
    cwd: string | undefined,
  ): string {
    const fallback = scope.folderPath
    if (!cwd) return fallback
    // 全域 session 於此一律放行（見 `cwdAllowed`）—— 只剩下面那道存在性檢查。
    if (!cwdAllowed(scope, cwd)) return fallback
    try {
      if (!fs.statSync(cwd).isDirectory()) return fallback
    } catch {
      return fallback
    }
    return cwd
  }

  #spawn(
    sessionId: string,
    folderPath: string,
    target: SpawnTarget,
    conversation: ClaudeConversation | undefined,
    options: {
      cwd: string
      cols: number
      rows: number
      healed: boolean
      global: boolean
      worktreeRoots?: readonly string[]
      peerName?: string
    },
  ): void {
    const { cwd, cols, rows, healed, global } = options
    // 注入只對 agent 目標有意義。**兩個功能合成為單一份設定** —— 接縫只有一個，
    // 各寫各的會讓後寫的蓋掉先寫的，而兩者都會回報自己已啟用（`agent-injection`）。
    // **註冊順序是承重的，而承重的不是正確性 —— 是對照組的鑑別力。**
    // 合成器現在會把同一個 hook 事件的命令串接（`agent-injection`），所以順序不影響結果。
    // 但「把合成改回逐鍵覆蓋」這個 mutation 必須讓 `probe:agent-view` 的
    // 「注入的 hook 真的被執行」變紅 —— 而覆蓋語意下**勝出的是最後一個**。
    // 事件橋接若排在最後，覆蓋之後它仍然勝出，**對照組不會紅，而 bug 還在**。
    // 因此：**事件橋接排在任何其他也貢獻 `SessionStart` 的功能之前。**
    const injection =
      target === 'claude'
        ? composeInjection(this.settingsFile(), [
            prepareInjection(sessionId, this.agentStatusEnabled()),
            prepareEventInjection(sessionId, this.agentEventsEnabled()),
            // Reading a device's attachments without a prompt; only with events, as replies need them.
            prepareAttachmentAccess(this.agentEventsEnabled()),
            // **排在事件橋接之後** —— 見上方註解：對照組的鑑別力取決於這個順序。
            this.prepareHandoff(sessionId),
          ])
        : null
    let pty: IPty
    try {
      const peerName = target === 'claude' ? options.peerName : undefined
      pty = spawn(resolveShell(), spawnArgs(target, conversation, injection, peerName), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        // TERM 明確設定以對齊前端 xterm；其餘環境自 process.env 繼承，但抹掉「巢狀 Claude Code」
        // 的標記（見 `ptyEnv` —— 少了那一步，裡面的 claude 不寫 transcript，續接永遠失敗）。
        // encoding 不設，node-pty 預設 utf8，onData 交付 string。
        env: { ...ptyEnv(), ...injection?.env, ...(peerName ? { [PEER_NAME_ENV]: peerName } : {}) },
      })
    } catch (error) {
      // 罕見：底層 pty 配置不出來時 node-pty 才會同步拋錯。
      //
      // **shell 路徑無效不走這裡。** 實測：node-pty 對 execvp 失敗不同步拋錯 —— 它成功
      // 回傳一個 pty，該 pty 隨即以非零碼 exit，`execvp(3) failed.` 由 onData 送出。
      // 於是「shell 路徑錯」與「claude 找不到」殊途同歸，都經 onExit 呈現。
      throw new TerminalError('SPAWN_FAILED', t('terminalError.spawnFailed', { reason: String(error) }))
    }

    this.#sessions.set(sessionId, {
      pty,
      global,
      folderPath,
      cwd,
      worktreeRoots: options.worktreeRoots ?? [],
      target,
      conversation,
      startedAt: Date.now(),
            healed,
      peerName: options.peerName,
      shellIdentity: target === 'shell' ? fileIdentity(resolveShell()) : null,
    })

    this.sink.spawned?.(sessionId)
    noteProcessStart(sessionId)

    let exited!: () => void
    lastExit.set(sessionId, new Promise<void>((resolve) => { exited = resolve }))

        pty.onData((chunk) => {
      // A hibernating pty's last words would land in the dormant view ahead of the resumed
      // conversation (`session-hibernation`, design D1). Marked per pty, so the pty a later wake
      // creates under the same session id is unaffected.
      if (this.#reasons.get(pty) === 'hibernated') return
      this.sink.data(sessionId, chunk)
    })
    pty.onExit(({ exitCode }) => {
      exited()
      const session = this.#sessions.get(sessionId)
      // 這一輪的 pty 已經不是當下這個 session 的 pty（自癒已重新 spawn 過）—— 忽略遲到的 exit。
      if (session && session.pty !== pty) return

      const reason = this.#reasons.get(pty) ?? 'self'
      // 自癒只針對「pty 自己死了」—— 使用者關掉的、或我們收工時殺掉的，都不該被復活。
      if (reason === 'self' && session && this.#heal(sessionId, session, exitCode)) return

      this.#sessions.delete(sessionId)
      noteProcessEnd(sessionId)
      this.sink.exit(sessionId, exitCode, reason)
    })
  }

  /**
   * 續接失敗的自癒：以一個**全新的**對話識別碼重開一個 claude，session 的身分不變。
   *
   * **為什麼是「換一個新 id」而不是「沿用舊 id 重開」**：實測 `claude --session-id <已存在的 id>`
   * 會直接報 `Error: Session ID … is already in use.` —— 於是 `claude --resume X || claude
   * --session-id X` 這種寫法是個陷阱。換新 id 則永遠不可能撞號（design D2）。
   *
   * **為什麼這是主線而不是例外**：實測「開了 claude session、還沒跟它講話就關掉 app」時，claude
   * 根本不會寫 transcript —— 那是很常見的行為（開個分頁準備等一下用），而它必然使 `--resume` 失敗。
   *
   * 回傳 true＝已自癒（不要把這次 exit 送給 renderer，那個 session 還活著）。
   */
  #heal(sessionId: string, session: Session, exitCode: number): boolean {
    if (session.target !== 'claude') return false
    if (session.conversation?.mode !== 'resume') return false
    if (session.healed) return false
    if (exitCode === 0) return false
    if (Date.now() - session.startedAt >= RESUME_FAILURE_WINDOW_MS) return false

    const conversation: ClaudeConversation = { id: randomUUID(), mode: 'new' }
    try {
      this.#spawn(sessionId, session.folderPath, session.target, conversation, {
        // **沿用將死那顆 pty 的工作目錄**（見 `Session.cwd`）—— 不是回到 folder 根。
        cwd: session.cwd,
        worktreeRoots: session.worktreeRoots,
        // **繼承將死那顆 pty 的尺寸。**
        //
        // 自癒對 renderer **完全不可見**（`status` 一直是 `running`，它收不到任何事件）——
        // 於是「pty 誕生時把終端當下的尺寸告訴它」那個 effect 不會重跑，而 `fit()` 又因為
        // 「尺寸沒變」一律回 `null`。少了這一行，自癒出來的 pty **一輩子停在 80×24**：claude
        // 以 80 欄排版、畫面縮成一小塊，要手動拖動視窗才恢復。
        //
        // **而自癒是主線情境**（沒跟 claude 講過話的 session，續接必定失敗）—— 這條路上的 pty
        // 尺寸壞掉，比 wake 那條更常被看到。`IPty` 的 `cols`／`rows` 記著它最後一次被 resize
        // 的尺寸，正是我們要的。
        cols: session.pty.cols,
        rows: session.pty.rows,
        healed: true,
        // **歸屬也要繼承。** 少了它，自癒出來的全域 session 會被當成隸屬於某個 folder，
        // 於是它的 cwd 從此受路徑夾制 —— 而自癒對 renderer 完全不可見，沒有任何訊號。
        // 這一行與上面的 `cwd`／`cols`／`rows` 是同一種疏漏，那三個都是漏掉後才補的。
        global: session.global,
        // 名字同理：自癒出來的 agent 若沒有名字，告知給母子 session 的地址就此失效，而它不可見。
        peerName: session.peerName,
      })
    } catch {
      // 連新的 pty 都配置不出來 —— 讓原本的失敗照常呈現。
      this.#sessions.delete(sessionId)
      this.sink.exit(sessionId, exitCode, 'self')
      return true
    }

    this.sink.conversation(sessionId, conversation.id)
    return true
  }

  /**
   * pty 當下的工作目錄（shell 目標才有意義）。取不到、或落在合法範圍之外時 `undefined`。
   *
   * **這是第二道、與 `#initialCwd` 獨立的夾制**，兩道必須用同一個判定。只放寬重建側是沒有用的：
   * 這裡若仍夾制回 folder 邊界內，使用者 `cd` 到邊界外 worktree 的位置**根本不會被寫進
   * `sessions.json`**，重建側於是收到 `undefined` 而一切看起來正常（靜默失效）。
   *
   * 合法範圍現在涵蓋該 repo 的工作目錄，於是 `sessions.json` 裡可能出現 folder 邊界外的絕對
   * 路徑 —— **那是主行程擁有的欄位**（`RendererSession` 會把 `cwd` 剝掉），不違反
   * 「持久化不得把路徑詞彙交給 renderer」。
   */
  cwdOf(sessionId: string): string | undefined {
    const session = this.#sessions.get(sessionId)
    if (!session || session.target !== 'shell') return undefined
    const cwd = readPtyCwd(session.pty.pid)
    if (!cwd || !cwdAllowed(session, cwd)) return undefined
    // 全域 session 不受路徑夾制，但仍須通過存在性檢查 —— 重建側的 `#initialCwd` 也會再驗一次，
    // 這裡先擋是為了不把一個已消失的目錄寫進 `sessions.json`。
    if (session.global) {
      try {
        if (!fs.statSync(cwd).isDirectory()) return undefined
      } catch {
        return undefined
      }
    }
    return cwd
  }

  /**
   * renderer → pty。未知或已結束的 session 靜默忽略（renderer 可能有時序落差）。
   *
   * Every write is reported to `pty-input.ts`, which keeps the time of the last keystroke: a device may
   * answer an open prompt only while nothing was typed since it appeared. A device answer's own keys pass
   * `origin: 'answer'`.
   */
  write(sessionId: string, data: string, origin?: WriteOrigin): void {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    noteWrite(sessionId, data, origin)
    try {
      session.pty.write(data)
    } catch {
      // pty 剛好在此刻結束——輸入丟棄即可。
    }
  }

  /** 同步 pty 尺寸。node-pty 對 0 尺寸會拋錯，故先夾制到至少 1x1。 */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    const safeCols = Math.max(1, Math.floor(cols))
    const safeRows = Math.max(1, Math.floor(rows))
    try {
      session.pty.resize(safeCols, safeRows)
    } catch {
      // 尺寸事件與 pty 結束競態時的殘留呼叫，忽略。
      return
    }
    this.sink.resized?.(sessionId, safeCols, safeRows)
  }

  /** The pty's current size, or `null` when the session has no pty. */
  sizeOf(sessionId: string): { cols: number; rows: number } | null {
    const session = this.#sessions.get(sessionId)
    return session ? { cols: session.pty.cols, rows: session.pty.rows } : null
  }

    /**
   * 明確關閉一個 session。已結束者（不在 Map）為 no-op。
   *
   * Returns whether the session had a pty. A dormant session has none, so nothing here runs for it —
   * the caller ends its drop point and clears its events itself (`session-hibernation`, design D2).
   */
  kill(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId)
    if (!session) return false
    this.#sessions.delete(sessionId)
    this.#reasons.set(session.pty, 'killed')
    // 不留下一份沒有主人的狀態 —— 否則同一個 id 日後若被重建，會先看到一份過期的資料。
    clearAgentStatus(sessionId)
    // **只由 pty 的結束觸發。** agent 回報的「對話結束」不是這個訊號（實測 `/clear` 就會發它，
    // 而 pty 還活著）—— 接上去的話，使用者清一次對話，等待狀態就此永遠停在未知。
    clearAgentEvents(sessionId)
    // 交接的落點同理 —— 但它多一步：清除之前先把裡面既有的項目處理完（見 `endHandoff`）。
        this.endHandoff(sessionId)
    try {
      session.pty.kill()
    } catch {
      // 已死的 pty，kill 可能拋錯，無妨。
    }
    return true
  }

  /**
   * Put a running session back to dormant (`session-hibernation`, design D2): **a per-session
   * `dispose`, not a `kill`**. The pty ends with reason `hibernated`; nothing the session owns on disk
   * is touched — not its persisted record (a `killed` exit would drop it), not its handoff drop point,
   * not its agent status or events. The session must come back exactly as a restored one does.
   *
   * Returns whether the session had a pty to end.
   */
  hibernate(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId)
    if (!session) return false
    this.#sessions.delete(sessionId)
    this.#reasons.set(session.pty, 'hibernated')
    try {
      session.pty.kill()
    } catch {
      // An already-dead pty may throw; its exit still reports the reason.
    }
    return true
  }

  /**
   * 殺光所有 pty。擁有者銷毀或重新載入時呼叫（design D2）——不留孤兒行程。
   *
   * 它們的 exit 會以 `disposed` 回報 —— **那不是 session 結束**，持久化必須原封不動。
   */
  dispose(): void {
    for (const session of this.#sessions.values()) {
      this.#reasons.set(session.pty, 'disposed')
      try {
        session.pty.kill()
      } catch {
        // 個別 pty 已死不影響其餘清理。
      }
    }
    this.#sessions.clear()
  }
}
