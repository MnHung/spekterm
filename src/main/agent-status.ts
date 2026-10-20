import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { InjectionContribution } from './agent-injection'

/**
 * 與 agent 的狀態橋接 —— 讓 claude **自己**把它算好的狀態交給我們。
 *
 * ## 為什麼是這條路（三選一，實測後只有一條成立）
 *
 * context 用量的**百分比**、花費、rate limit、模型顯示名，只有 agent 自己算得出來。
 *
 * - **解析終端畫面**：否決。脆弱，而且那一行本來就被終端寬度截斷 —— 我們要的正是被切掉的部分。
 * - **解析 transcript**（`~/.claude/projects/*.jsonl`）：**實測否決**。裡面有 model id、effort、
 *   token usage、cwd、gitBranch，但**沒有花費、沒有 rate limit、也沒有 context window 大小**；
 *   而 `message.model` 是 `claude-opus-4-8` —— **`[1m]` 後綴被拿掉了**，1M 與 200k 兩種變體長得
 *   一模一樣，**百分比的分母算不出來**。
 * - **`--settings` 注入 `statusLine`**：**採用**。那是 CLI 的公開旗標，不是內部檔案格式。
 *
 * 實測確認：`--settings` 吃 inline JSON 也吃檔案路徑、是**疊加**（只有 `statusLine` 被我們指定，
 * 其餘設定不受影響）、注入的命令**看得到我們設給 pty 的環境變數**，而 payload 內含
 * `context_window.context_window_size` —— **於是不需要維護一張會過期的「模型 → context window」
 * 對照表**（那種表失效的樣子是「一個看起來很正常的錯誤百分比」）。
 *
 * ## 這推翻了「別綁 claude 的內部佈局」嗎
 *
 * 沒有，而區別是承重的：`session-restore` 那條教訓的情境是「猜錯 → 撞號 → session 死掉」，
 * **降級方向是災難性的**；這裡猜錯的下場是**狀態列少幾個欄位**。要問的是「失效時會怎樣」。
 */

/** 落盤與注入設定所在的目錄（userData 之下）。由 `configure()` 指定，主行程啟動時設定一次。 */
let statusRoot: string | null = null

export function configureAgentStatus(userDataPath: string): void {
  statusRoot = path.join(userDataPath, 'agent-status')
}

function payloadPath(sessionId: string): string | null {
  return statusRoot ? path.join(statusRoot, `${sessionId}.json`) : null
}

/**
 * 注入用的 statusLine 命令。
 *
 * 三件事，缺一不可：
 * 1. **原子寫入**（先寫暫存再 `mv`）—— 我們一邊輪詢一邊 parse，非原子的寫入會讓我們讀到半個 JSON。
 * 2. **落點由環境變數決定** —— 於是同一份設定檔可以給所有 session 共用，命令本身不必知道自己
 *    屬於哪個 session。
 * 3. **串接使用者原本的 statusline** —— 否則啟用這個功能等於把他自己那條弄不見。
 */
const STATUS_LINE_COMMAND = [
  'i=$(cat)',
  'if [ -n "$SPEKTERM_STATUS_FILE" ]; then printf %s "$i" > "$SPEKTERM_STATUS_FILE.tmp" && mv "$SPEKTERM_STATUS_FILE.tmp" "$SPEKTERM_STATUS_FILE"; fi',
  'if [ -n "$SPEKTERM_STATUS_CHAIN" ]; then printf %s "$i" | sh -c "$SPEKTERM_STATUS_CHAIN"; fi',
].join('; ')

/**
 * 使用者原有的 statusline 命令。
 *
 * - `none` —— 他沒設定過。那個位置本來就是空的（agent 內建的模式提示行**不是** statusLine，
 *   實測兩種設定下皆存在），接管它**損失為零**。
 * - `chain` —— 他設定了，而我們讀得出來：串接它。
 * - `unknown` —— 他設定了，但我們讀不出來（格式不認得、檔案損毀）。**此時不得注入**：
 *   注入會讓他失去自己那條，不注入只是少一個他還不知道存在的功能。兩種失敗的代價不對等。
 */
type UserStatusLine = { kind: 'none' } | { kind: 'chain'; command: string } | { kind: 'unknown' }

export function readUserStatusLine(home: string = os.homedir()): UserStatusLine {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')
  } catch {
    // 檔案不存在＝沒有自訂。這是最常見的情況，不是失敗。
    return { kind: 'none' }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'unknown' }
    const statusLine = (parsed as { statusLine?: unknown }).statusLine
    if (statusLine === undefined || statusLine === null) return { kind: 'none' }
    if (typeof statusLine !== 'object') return { kind: 'unknown' }

    const { type, command } = statusLine as { type?: unknown; command?: unknown }
    if (type !== 'command' || typeof command !== 'string' || command.trim() === '') {
      // 認得的形式只有「執行一個命令」。其他形式（未來可能有）我們串不上 —— 不注入。
      return { kind: 'unknown' }
    }
    return { kind: 'chain', command }
  } catch {
    // 設定檔壞了。我們無從得知他原本有沒有 statusline，保守起見當作有。
    return { kind: 'unknown' }
  }
}

/**
 * 為一個 claude session 準備狀態回報的**貢獻**（不是完整的注入）。
 *
 * 回傳 `null` 代表**這個功能不參與**（偏好關閉、環境未就緒，或使用者有自訂 statusline 但我們
 * 串不上）。**它不會使其他功能一併不注入** —— 合成由 `agent-injection` 負責，各功能獨立。
 *
 * **`statusLine` 必須自己串接使用者原有的命令**（它是單一值，接管等於弄掉他的那條）。
 * 這與 `hooks` 相反 —— 後者由 CLI 自己合併，不必我們處理。**這個差異是各貢獻者自己的事。**
 */
export function prepareInjection(sessionId: string, enabled: boolean): InjectionContribution | null {
  if (!enabled || !statusRoot) return null

  const user = readUserStatusLine()
  if (user.kind === 'unknown') return null

  const target = payloadPath(sessionId)
  if (!target) return null

  try {
    fs.mkdirSync(statusRoot, { recursive: true })
    // 上一輪的殘留會讓狀態列先顯示一份過期的資料，直到 agent 第一次回報為止。
    fs.rmSync(target, { force: true })
  } catch {
    return null
  }

  const env: Record<string, string> = { SPEKTERM_STATUS_FILE: target }
  if (user.kind === 'chain') env.SPEKTERM_STATUS_CHAIN = user.command

  return { settings: { statusLine: { type: 'command', command: STATUS_LINE_COMMAND } }, env }
}

/**
 * agent 回報的狀態。**每個欄位都可能缺席** —— 實測 `rate_limits` 在全新 session（還沒打過 API）
 * 的 payload 中就不存在。缺席即不呈現該段，不得因此讓整條狀態列失效。
 */
export interface AgentStatus {
  model?: string
  effort?: string
  thinking?: boolean
  contextPercent?: number
  contextTokens?: number
  /** The context window's size in tokens, as the agent reports it (never from a table of our own). */
  contextSize?: number
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
  fiveHourPercent?: number
  sevenDayPercent?: number
  /** 用量上限重置的時刻（unix epoch 秒）。呈現層自行格式化為使用者當地時間。 */
  fiveHourResetsAt?: number
  sevenDayResetsAt?: number
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 讀取並解析某個 session 的 payload。任何失敗都靜默回 `undefined`（缺席與損毀是同一件事）。 */
export function readAgentStatus(sessionId: string): AgentStatus | undefined {
  const target = payloadPath(sessionId)
  if (!target) return undefined

  let parsed: Record<string, never>
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined

  const pick = (key: string): Record<string, never> | undefined => {
    const value = parsed[key]
    return typeof value === 'object' && value !== null ? value : undefined
  }

  const model = pick('model')
  const context = pick('context_window')
  const cost = pick('cost')
  const limits = pick('rate_limits')
  const fiveHour = limits ? (limits.five_hour as Record<string, never> | undefined) : undefined
  const sevenDay = limits ? (limits.seven_day as Record<string, never> | undefined) : undefined

  // 百分比優先取 agent 自己算的；沒有就以它回報的 window 大小現算。
  // **分母恆來自 payload** —— 我們不維護「模型 → context window」的對照表。
  const used = context ? num(context.used_percentage) : undefined
  const total = context ? num(context.total_input_tokens) : undefined
  const size = context ? num(context.context_window_size) : undefined
  const contextPercent =
    used ?? (total !== undefined && size !== undefined && size > 0 ? (total / size) * 100 : undefined)

  return {
    model: model && typeof model.display_name === 'string' ? model.display_name : undefined,
    effort: (() => {
      const effort = pick('effort')
      return effort && typeof effort.level === 'string' ? effort.level : undefined
    })(),
    thinking: (() => {
      const thinking = pick('thinking')
      return thinking && typeof thinking.enabled === 'boolean' ? thinking.enabled : undefined
    })(),
    contextPercent,
    contextTokens: total,
    contextSize: size,
    costUsd: cost ? num(cost.total_cost_usd) : undefined,
    linesAdded: cost ? num(cost.total_lines_added) : undefined,
    linesRemoved: cost ? num(cost.total_lines_removed) : undefined,
    fiveHourPercent: fiveHour ? num(fiveHour.used_percentage) : undefined,
    sevenDayPercent: sevenDay ? num(sevenDay.used_percentage) : undefined,
    fiveHourResetsAt: fiveHour ? num(fiveHour.resets_at) : undefined,
    sevenDayResetsAt: sevenDay ? num(sevenDay.resets_at) : undefined,
  }
}

/** session 結束時清掉它的 payload —— 不留下一份沒有主人的狀態。 */
export function clearAgentStatus(sessionId: string): void {
  const target = payloadPath(sessionId)
  if (!target) return
  try {
    fs.rmSync(target, { force: true })
    fs.rmSync(`${target}.tmp`, { force: true })
  } catch {
    // 清不掉就算了 —— 下次 spawn 同一個 id 時會再清一次。
  }
}

export interface GitWorkingState {
  branch?: string
  dirty?: boolean
  /** linked worktree 的名稱（`…/worktrees/<name>`）。主 worktree 為 undefined。 */
  worktree?: string
}

/**
 * 某個工作目錄的 git 狀態。
 *
 * **這裡 spawn `git`，而 `repo-branch` 明文要求「偵測 SHALL NOT 呼叫任何外部程式」** ——
 * 兩者不衝突：那條規範的對象是「**每個 folder、每次載入**都要做」的判定（rail 的每一列），
 * 而這裡只對**當前 focused 的那一個**目錄求值。**不得擴大到 rail** —— 那會讓 workspace 一大就卡。
 *
 * `--porcelain=v2 --branch` 一次給出分支與是否有變更（分支在 `# branch.head` 這行，
 * 任何非 `#` 開頭的行都代表有變更），省掉第二次 spawn。
 */
export function readGitWorkingState(cwd: string): GitWorkingState {
  const status = spawnSync('git', ['status', '--porcelain=v2', '--branch'], {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
    // 大 repo 的 status 輸出可能很長，而我們只需要分支與「有沒有任何一行」。
    maxBuffer: 4 * 1024 * 1024,
  })
  if (status.status !== 0 || typeof status.stdout !== 'string') return {}

  let branch: string | undefined
  let dirty = false
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim()
      branch = name === '(detached)' ? undefined : name
    } else if (line.trim() !== '' && !line.startsWith('#')) {
      dirty = true
    }
  }

  const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
  })
  let worktree: string | undefined
  if (gitDir.status === 0 && typeof gitDir.stdout === 'string') {
    const match = /\/worktrees\/([^/\n]+)/.exec(gitDir.stdout.trim())
    if (match) worktree = match[1]
  }

  return { branch, dirty, worktree }
}
