import fs from 'node:fs'
import path from 'node:path'

import type { InjectionContribution } from './agent-injection'

/**
 * 事件橋接 —— 讓 agent **自己**說出它正在等什麼。
 *
 * ## 為什麼需要它（而不是看畫面、也不是猜）
 *
 * 送字進 pty 是容易的；**知道「現在能不能送」不是**。agent 的介面不是只有一個輸入框 ——
 * 許可提示、選擇類請求、slash 選單都會佔用同一個輸入焦點。在錯的時機送出，後果不是「沒有反應」
 * 而是「答案被打進錯的地方」，包含**替使用者做出一個他從未同意的決定**。
 *
 * ## 取哪幾個 hook —— 每一條都由實測推導（2026-09-06、CLI 2.1.263）
 *
 * | hook | 用途 | 為什麼是它 |
 * |---|---|---|
 * | `PermissionRequest` | 等待選擇的**權威**訊號 | 實測早於畫面上的提示 22ms |
 * | `PostToolUse` | **離開**等待選擇 | 進入與離開不是同一個事件 |
 * | `PreToolUse` | 忙碌 | |
 * | `Notification` | 次要訊號 | **必須依 `notification_type` 分派**，見下 |
 * | `Stop` | 就緒 | |
 * | `SessionStart` / `SessionEnd` | 重新定位 | 帶著 `transcript_path` |
 * | `UserPromptSubmit` | busy | the only start signal for a text-only answer; see below |
 * | `PostToolUseFailure` | busy | an approved tool that fails sends this, not `PostToolUse` |
 * | `StopFailure` | ready | a turn whose requests kept failing ends with this, not `Stop` |
 *
 * ### `UserPromptSubmit`, measured (2026-10-15, CLI 2.1.300)
 *
 * Reported at submission, also mid-turn and during a text-only answer. Not reported for `!` input, `/cost`
 * or `/clear`. **Not reported for text typed into an open permission prompt or question** — the text and
 * Enter answer the prompt. That last fact is what makes busy safe here: a submission cannot arrive while a
 * prompt is open, so it cannot move the state out of awaiting-choice early. Re-measure it on a CLI upgrade
 * (`docs/lessons/transcript.md`).
 *
 * **The hook command must print nothing**: the agent adds a `UserPromptSubmit` hook's stdout to the prompt.
 *
 * ### What reports nothing (known gaps, `agent-event-bridge`)
 *
 * A denied permission prompt (Esc or "No") and an interrupted turn send no event at all. The state stays what
 * the turn last reported until the next event, usually the user's next prompt.
 *
 * ### 兩個實測出來的陷阱，兩個都會靜默地把狀態算成「可以送出」
 *
 * 1. **`Notification` 不是 idle 的同義詞。** `permission_prompt` 與 `idle_prompt` **都走它**。
 *    不看那個欄位的實作，會把許可提示讀成「就緒」。
 * 2. **許可的 `Notification` 延遲 6 秒才送**（實測 14624ms 對畫面的 8622ms），且可被環境變數
 *    整個關掉。那六秒內狀態仍是上一個值＝**忙碌**，而忙碌是允許送出的。
 *    **同一個災難換一條路走進來，且這條路不需要任何實作錯誤** —— 這正是採用 `PermissionRequest`
 *    的理由。
 *
 * ## 落點為什麼不能沿用狀態回報那一份
 *
 * 狀態回報的 payload 是「當下狀態的快照」，可以一個檔案反覆覆寫。**事件是發生過的事，覆寫會
 * 丟事件。** 因此每一則事件各自一個檔，寫入以「先寫暫存再更名」達成原子性，讀取端讀完即刪
 * （於是去重由結構保證，不必維護一份已讀清單）。
 */

/** 落盤根目錄。由 `configure()` 指定，主行程啟動時設定一次。 */
let eventsRoot: string | null = null

export function configureAgentEvents(userDataPath: string): void {
  eventsRoot = path.join(userDataPath, 'agent-events')
}

function sessionDir(sessionId: string): string | null {
  return eventsRoot ? path.join(eventsRoot, sessionId) : null
}

/**
 * 注入的 hook 命令。
 *
 * 三件事，缺一不可：
 * 1. **每則事件各自一個檔** —— 覆寫會丟事件（見上）。
 * 2. **原子寫入**（先寫暫存再 `mv`）—— 我們一邊輪詢一邊 parse，非原子的寫入會讓我們讀到半個 JSON。
 * 3. **落點由環境變數決定** —— 於是同一份設定可以給所有 session 共用。
 *
 * 事件的種類**不編碼在命令裡**：payload 自帶 `hook_event_name`。一份「每個 hook 各自一條命令」
 * 的設定會在新增 hook 時要求同步兩個地方，而漏掉其中一個不會有任何徵狀。
 */
export const EVENT_COMMAND = [
  'i=$(cat)',
  // **整個 `if…fi` 必須在同一個元素裡。** 拆開來再以 `'; '` 相接，`then` 後面會被塞進一個分號
  // （`then; f=…`）—— 那是 shell 的語法錯誤，於是 hook **每一次都失敗**。
  //
  // 而它的失效是完全靜默的：agent 不會抱怨一個寫壞的 hook，我們只會看到一個空的事件目錄，
  // 等待狀態永遠是「未知」，輸入框永遠停用 —— 沒有任何錯誤訊息指向真正的原因。
  // 這正是 `EVENT_COMMAND_IS_VALID` 那條測試存在的理由：**它真的把這個命令跑一次**。
  'if [ -n "$SPEKTERM_EVENT_DIR" ]; then f="$SPEKTERM_EVENT_DIR/$(date +%s%N)-$$"; printf %s "$i" > "$f.tmp" && mv "$f.tmp" "$f.json"; fi',
].join('; ')

/** 我們註冊的 hook。**清單是白名單**，讀取端對不在其中的 `hook_event_name` 一律落回未知。 */
export const HOOKED_EVENTS = [
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd',
] as const

/**
 * 為一個 agent session 準備事件橋接的貢獻。回傳 `null` ＝ 不參與（偏好關閉、或環境未就緒）。
 *
 * **這裡不需要讀使用者的設定。** 狀態回報那一支必須讀（`statusLine` 是單一值，接管會弄掉他的），
 * 而 hooks 由 CLI 自己合併 —— 實測兩邊都定義同一個 hook 時**兩者都會被呼叫**。
 */
export function prepareEventInjection(sessionId: string, enabled: boolean): InjectionContribution | null {
  if (!enabled) return null
  const dir = sessionDir(sessionId)
  if (!dir) return null

  try {
    // 上一輪的殘留會讓等待狀態先呈現一份過期的值。
    //
    // **這個「刪掉再重建」在這裡沒事，是因為這個目錄沒有任何人在監看** —— 事件的讀取走
    // `drainEvents` 的 `readdirSync` 輪詢（見下方），而輪詢認的是路徑。
    // **若日後改以 watcher 讀取，這個寫法會讓監看靜默失效**：watch 綁的是目錄這個對象，
    // 刪掉重建之後它留在舊對象上，且那次替換不發出任何目錄事件。
    // 交接的落點踩過這個坑，處置見 `handoff-outbox.ts` 的 `prepareOutbox`。
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }

  // **命令交給合成器，巢狀的 matcher 結構由它產生** —— 我們不是這個事件唯一的貢獻者
  // （自我介紹也用 `SessionStart`），而自己組一份 `settings.hooks` 會讓後註冊的把我們蓋掉。
  const hooks = Object.fromEntries(HOOKED_EVENTS.map((name) => [name, [EVENT_COMMAND]]))
  return { settings: {}, hooks, env: { SPEKTERM_EVENT_DIR: dir } }
}

/** session 結束時清除落點。**agent 回報的「對話結束」不是這個訊號** —— 見 `WaitState`。 */
export function clearAgentEvents(sessionId: string): void {
  const dir = sessionDir(sessionId)
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清不掉不影響任何事：下一次 spawn 會再清一次。
  }
}

/**
 * 等待狀態。
 *
 * **`unknown` 是「其餘一切」，不是一份列舉。** 以列舉實作的判定會在 agent 新增一種等待方式時
 * 靜默落進別的分支 —— 而落錯的方向若是「就緒」或「忙碌」，兩者都允許送出。
 */
export type WaitState = 'ready' | 'busy' | 'awaiting-choice' | 'unknown'

export interface AgentEvent {
  name: string
  /** agent 自己回報的紀錄位置。定位的**權威來源**（見 `transcript-follow`）。 */
  transcriptPath: string | null
  notificationType: string | null
  toolName: string | null
  /**
   * 工具的**單一辨識參數**。與 `transcript-follow` 的投影同一條紀律：完整參數含絕對路徑，
   * 只取一個給人看的值，而呈現層把它當成不可導覽的純文字。
   */
  toolArg: string | null
  /**
   * Set when a subagent reported the event, not the agent itself. Subagent hook events share the stream
   * (measured: a subagent's `PreToolUse` after the turn's `Stop`). An identifier, not a path.
   */
  agentId: string | null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 解析一則事件。**以白名單取欄位** —— payload 的基底就帶著四個以上的絕對路徑
 * （紀錄位置、工作目錄、暫存目錄，工具類再加參數裡的檔案路徑）。
 *
 * 黑名單（「複製整則再刪幾個欄位」）會在 agent 新增一個帶路徑的欄位時靜默失效，而失效的徵狀是
 * renderer 拿到一個它沒有詞彙可以表達的位置。**`transcriptPath` 是唯一被保留的路徑，且它
 * SHALL NOT 送往 renderer** —— 它只在主行程內用於定位。
 */
export function parseEvent(raw: unknown): AgentEvent | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = str(o.hook_event_name)
  if (name === null) return null
  return {
    name,
    transcriptPath: str(o.transcript_path),
    notificationType: str(o.notification_type),
    toolName: str(o.tool_name),
    toolArg: identifyingArg(o.tool_input),
    agentId: str(o.agent_id),
  }
}

/** 工具的單一辨識參數。**只取這一個** —— 完整參數含檔案路徑，見 `parseEvent` 的邊界說明。 */
function identifyingArg(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'plan', 'description']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 200)
  }
  return null
}

/**
 * 事件 → 下一個等待狀態。純函式。
 *
 * **`Notification` 依 `notification_type` 分派，這一行是本模組最承重的一行。**
 *
 * ## 它不吃當前狀態，而那是刻意的
 *
 * 每一條分支都回傳一個確定的值，**沒有任何一條會沿用前一個狀態**。這讓「新出現的等待方式被
 * 當成上一個狀態」在結構上表達不出來 —— 而那個錯誤的方向很可能是「就緒」或「忙碌」，
 * **兩者都允許送出**。
 *
 * 簽名上少一個參數，就少一條把它寫成 `default: return current` 的路。
 */
export function nextWaitState(event: AgentEvent): WaitState {
  switch (event.name) {
    case 'PermissionRequest':
      // 權威訊號：實測早於畫面上的提示。
      return 'awaiting-choice'
    case 'PostToolUse':
      // **離開**等待選擇。少了它，狀態會停在等待選擇，其後每一則自由文字都送不出去
      // —— 使用者看到的是「送出入口壞了」。
      return 'busy'
    case 'PreToolUse':
      return 'busy'
    case 'PostToolUseFailure':
      // An approved tool that failed. Without it the state stays awaiting-choice until the turn ends.
      return 'busy'
    case 'UserPromptSubmit':
      // The only start signal for a text-only answer. Safe because it is not reported for text typed into
      // an open prompt (see the module comment).
      return 'busy'
    case 'Notification':
      if (event.notificationType === 'permission_prompt') return 'awaiting-choice'
      if (event.notificationType === 'idle_prompt') return 'ready'
      // 認得 hook 但不認得它的種類 —— 落回未知，不沿用當前值。
      return 'unknown'
    case 'Stop':
      return 'ready'
    case 'StopFailure':
      // The agent's own failed turn: it stopped and waits for input. **A subagent's is unknown** — whether
      // subagents report it was not measured, and it could arrive while the agent waits on a choice, where
      // ready would allow sending into the prompt.
      return event.agentId === null ? 'ready' : 'unknown'
    case 'SessionStart':
      return 'ready'
    case 'SessionEnd':
      // **這不代表 session 結束**（實測：使用者清空對話時它就會發，而 pty 還活著）。
      // 它的意思是「這一段對話結束了，接下來可能換一份紀錄」—— 狀態因此不確定。
      return 'unknown'
    default:
      // 不認得的事件形狀。**不沿用 `current`** —— 沿用會讓一個新的等待方式被當成上一個狀態，
      // 而上一個狀態很可能是允許送出的。
      return 'unknown'
  }
}

export interface DrainResult {
  state: WaitState
  /** 最後一次事件回報的紀錄位置（若有）。 */
  transcriptPath: string | null
  /** 讀到的事件數。 */
  count: number
  /**
   * 等待選擇時，agent 正在請求什麼。
   *
   * **只有「請求的對象」與「辨識參數」，沒有選項** —— 實測許可請求的 payload 不含它呈現給
   * 使用者的那幾個選項（它帶的是「要不要改變權限規則」的建議）。因此本能力只說得出
   * 「正在被問什麼」，作答一律回終端 view（見 `agent-input-bridge`）。
   */
  pending: { tool: string; arg: string | null } | null
  /**
   * The batch contains the agent's turn-completion event (`Stop`). **Not derivable from `state`**: a turn
   * that starts and ends within one batch folds to `ready` → `ready` (`remote-notifications`).
   */
  turnEnded: boolean
  /**
   * The tool of the batch's last `PermissionRequest`, or `null`. **Not derivable from `state` either**: an
   * answered prompt followed by the next one (`PostToolUse` → `PreToolUse` → `PermissionRequest`) folds to
   * `awaiting-choice` → `awaiting-choice`. Only `PermissionRequest` counts — the `Notification` the agent
   * sends for the same prompt would raise it twice.
   */
  choiceRaised: { tool: string; arg: string | null } | null
}

/**
 * 讀走並清空一個 session 的事件。
 *
 * **依檔名排序** —— 檔名前綴是奈秒時戳，於是順序即發生順序。同一奈秒內的兩則事件其順序由
 * 後綴（pid）決定，那是任意的但穩定；本狀態機沒有任何一對事件會因為順序顛倒而得到相反的結論。
 *
 * 讀完即刪，於是**去重由結構保證**，不必維護一份已讀清單（而那份清單會需要自己的持久化與清理）。
 *
 * ## The pending request is carried, not recomputed per event
 *
 * `currentPending` is the request held before this drain. While the state stays awaiting-choice, an event
 * that names no tool keeps it, and **every return path returns it** — the empty drain and the two early
 * returns included. The prompt's own `Notification` arrives about six seconds after `PermissionRequest`
 * and names no tool, and most drains (every 400 ms) find nothing; recomputing from the last event erased the
 * tool both ways (`agent-event-bridge`).
 */
export function drainEvents(
  sessionId: string,
  current: WaitState,
  currentPending: DrainResult['pending'] = null,
): DrainResult {
  const held = current === 'awaiting-choice' ? currentPending : null
  const unchanged: DrainResult = {
    state: current,
    transcriptPath: null,
    count: 0,
    pending: held,
    turnEnded: false,
    choiceRaised: null,
  }
  const dir = sessionDir(sessionId)
  if (!dir) return unchanged

  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    // 目錄不存在 ＝ 未注入或已清除。**不改變狀態** —— 呼叫端的初始值本來就是未知。
    return unchanged
  }

  let state = current
  let transcriptPath: string | null = null
  let count = 0
  let pending: DrainResult['pending'] = held
  let turnEnded = false
  let choiceRaised: DrainResult['choiceRaised'] = null
  for (const name of names) {
    const file = path.join(dir, name)
    let event: AgentEvent | null
    try {
      event = parseEvent(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
      // 損毀的單筆被忽略，其餘照常處理 —— 且不向使用者呈現解析錯誤。
      event = null
    }
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // 刪不掉的話下一輪會再讀到它一次。狀態機對重複的同一則事件是冪等的。
    }
    if (!event) continue
    count += 1
    state = nextWaitState(event)
    if (event.name === 'Stop') turnEnded = true
    if (event.name === 'PermissionRequest') choiceRaised = { tool: event.toolName ?? '', arg: event.toolArg }
    if (event.transcriptPath) transcriptPath = event.transcriptPath
    // 離開等待選擇時清掉 —— 否則畫面會留著一個已經被回答完的請求。While it stays, only an event that
    // names a tool replaces the request.
    if (state !== 'awaiting-choice') pending = null
    else if (event.toolName !== null) pending = { tool: event.toolName, arg: event.toolArg }
    else pending ??= { tool: '', arg: null }
  }
  return { state, transcriptPath, count, pending, turnEnded, choiceRaised }
}

/**
 * 送出的編碼。
 *
 * ## 兩條實測結論（2026-09-06、CLI 2.1.263，以**讀回 agent 的紀錄**驗證它實際收到什麼）
 *
 * 1. **`\n`（0x0A）是訊息內的換行，`\r`（0x0D）才是送出。** 送「多行本文 + `\r`」得到**恰好
 *    一則**訊息且換行完整保留；bracketed paste 包與不包結果相同，**因此不需要它**。
 * 2. **原始控制位元組會讓整則訊息無聲消失。** 送含 `\x01` / `\x07` / `\t` 的本文再送 `\r`，
 *    紀錄檔**根本沒有被建立** —— 訊息從未送達，而畫面上沒有任何錯誤。
 *
 * 第 2 條的失效方向比「訊息被誤解」更難察覺：使用者只會以為自己沒按到送出。因此過濾是必須的，
 * 而不是防禦性的。
 *
 * 保留 `\n`，其餘 C0 控制字元（含 `\t` 與 `\r`）與 DEL 一律移除。
 *
 * **regex 以 escape 序列寫成，不寫字面的控制位元組** —— 後者會讓 `git diff` 與 `grep` 對整個
 * 檔案瞎掉（本 repo 已在四個檔案上踩過，其中包含警告這件事的那份文件自己）。
 */
export function encodeInput(text: string): string {
  // eslint-disable-next-line no-control-regex
  const sanitized = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
  return `${sanitized}\r`
}

/**
 * **預填**的編碼 —— 寫進 agent 的輸入處，但**不送出**。
 *
 * 與 `encodeInput` 的差別只有兩點，而兩點都是刻意的：
 *
 * 1. **不附 `\r`** —— 送出由使用者為之，那是 intake 那條管線唯一的人類閘門。
 * 2. **連 `\n` 一起濾掉** —— `\n` 是訊息內的換行，留著它不會送出，但**單行是編碼器的性質，
 *    不是呼叫端的義務**。「呼叫端記得只傳單行」是紀律；濾掉它才是結構。
 *
 * 實測（2026-09-11、CLI 2.1.267）：不附 `\r` 的寫入落在輸入框裡、可編輯、**且不送出** ——
 * 寫入後等 16 秒，transcript 檔案根本沒有被建立。見 `docs/lessons/transcript.md`。
 */
export function encodePrefill(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, '')
}
