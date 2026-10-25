/**
 * 單一 agent session 的紀錄跟進 —— 純邏輯層。
 *
 * 吃「檔案大小 + 讀到的位元組」，吐「要送給呈現層的事件」。不碰檔案系統、不建立監看：
 * 那些是 service 層的事。
 *
 * ## 與 `transcript-archive` 是兩條路，不是同一條
 *
 * archive 的增量單位是**整個來源檔案**（size/mtime 變了就重讀重寫），跑在獨立行程、掃全部專案，
 * 而它萃取的是**計量用**的列。這裡要的是單一檔案、逐行追加、低延遲，而且投影是**要呈現的內容**。
 * 兩者共用的是「來源格式的知識」與「白名單處理記錄類型」的紀律，**不共用投影，也不共用生命週期**。
 *
 * ## 位元組偏移，不是字元偏移
 *
 * 檔案大小是位元組數。以字元數當偏移，遇到任何非 ASCII 內容就會錯位，而錯位之後解析出來的
 * 是**看起來像壞掉的 JSON**，不是「少了幾則」—— 徵狀與「來源被改寫」無法區分。
 * 因此未完成的尾段以 `Buffer` 保留：一次讀取的邊界可能落在一個多位元組字元的中間。
 */

import path from 'node:path'

import { resolveProjectsDir, type SourceEnv } from './insights-source'
import { encodeProjectDir } from './transcript-project'
import { toolInput, type ToolInputValue } from './transcript-tool-input'

/**
 * 算出來源紀錄的位置。
 *
 * **算得出來，因此不必用搜尋的** —— session 的起始工作目錄由我們決定，對話識別碼由我們產生或
 * 續接。搜尋（例如「挑最近被修改的那一個」）在多個 session 並行時會抓錯，而失效方式是**把 A 的
 * 對話呈現在 B 的畫面上**：那比沒有內容更糟，因為它看起來完全正常。
 *
 * **但這只是初始值。** agent 回報的事件帶著它自己的紀錄位置，那才是權威 —— 使用者在 agent 之內
 * 清空或切換對話時識別碼會變，而那**發生在 pty 之內**，我們收不到任何自己發出的訊號
 * （實測：`/clear` 會換一份紀錄，且 pty 未結束）。service 層負責以事件回報的位置覆蓋本函式的結果。
 */
export function transcriptPathFor(cwd: string, conversationId: string, env: SourceEnv = {}): string {
  return path.join(resolveProjectsDir(env), encodeProjectDir(cwd), `${conversationId}.jsonl`)
}

/** 跟進的位置。`pending` 是尚未終止的最後一行（見上）。 */
export interface FollowState {
  offset: number
  pending: Buffer
}

export function initialFollowState(): FollowState {
  return { offset: 0, pending: Buffer.alloc(0) }
}

/**
 * 這一輪該讀哪一段。
 *
 * 三種情況顯式分開 —— 來源是追加式的，但**不是只會追加**：
 *
 * - `reset` —— 檔案比我們讀到的位置短。它被改寫或換掉了（實測：agent 於使用者清空對話時
 *   換一份紀錄；而同一個位置也可能被新的內容重用）。**沿用舊偏移會從一段內容的中間開始讀**。
 * - `append` —— 正常路徑。
 * - `idle` —— 大小沒變。監看事件比內容變化頻繁（`alwaysStat`、輪詢），這條是主要出口。
 */
export type ReadPlan = { kind: 'append'; from: number } | { kind: 'reset' } | { kind: 'idle' }

export function planRead(state: FollowState, size: number): ReadPlan {
  if (size < state.offset) return { kind: 'reset' }
  if (size > state.offset) return { kind: 'append', from: state.offset }
  return { kind: 'idle' }
}

const NEWLINE = 0x0a

/**
 * 把讀到的位元組併入狀態，切出**完整的**行。
 *
 * 未終止的尾段留在 `pending`，**不解析** —— 我們可能讀在寫入的中間。這與 `agent-status` 的
 * 原子寫入是同族問題，但這裡沒有原子寫入可用：來源不是我們寫的。
 */
export function consume(
  state: FollowState,
  chunk: Buffer,
  reset: boolean,
): { state: FollowState; lines: string[] } {
  const base = reset ? Buffer.alloc(0) : state.pending
  const buf = Buffer.concat([base, chunk])
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== NEWLINE) continue
    const line = buf.subarray(start, i).toString('utf8').trim()
    if (line) lines.push(line)
    start = i + 1
  }
  const offsetBase = reset ? 0 : state.offset
  return {
    state: { offset: offsetBase + chunk.length, pending: buf.subarray(start) },
    lines,
  }
}

/**
 * Where a message the user did not type came from (`remote-tool-detail` D4). Only the kind and the name are
 * selected: the origin's `from` is a socket path for a session and an internal id for a subagent.
 */
export type MessageOrigin =
  | { kind: 'peer'; sender: 'session' | 'subagent' | 'other'; name?: string }
  | { kind: 'task-notification' }

/** 一則要呈現的內容。**每一種都只帶呈現得到的欄位** —— 見下方的邊界說明。 */
export type ViewEvent =
  | { kind: 'user'; uuid: string; at: number; text: string; meta: boolean; origin?: MessageOrigin }
  | { kind: 'text'; uuid: string; at: number; text: string }
  | { kind: 'thinking'; uuid: string; at: number; text: string }
  | {
      kind: 'tool'
      uuid: string
      at: number
      id: string
      name: string
      arg: string | null
      /** The tool's arguments, white-listed per tool and bounded (`transcript-tool-input.ts`). */
      input?: Record<string, ToolInputValue>
      /** Each shortened field of `input` → its original length (or item count). Absent when nothing was cut. */
      inputTruncated?: Record<string, number>
    }
  | {
      kind: 'result'
      uuid: string
      at: number
      id: string
      text: string
      error: boolean
      /** The images the result holds, in order, without their bytes (`resultImagesOf()`). Absent when none. */
      images?: ResultImageSummary[]
    }

/** One image a tool result holds, as an entry lists it (`remote-result-images` D1). */
export interface ResultImageSummary {
  mediaType: string
  size: number
}

/**
 * 記錄類型是**白名單**。
 *
 * 來源是 agent 的內部格式而非公開介面：實測單一檔案就有十餘種頂層 `type`，多數是隨版本陸續長
 * 出來的。黑名單式的排除會在下一次更新時把新類型當成資料處理。本條使失效方向恆為「少呈現一種
 * 東西」，而不是「呈現錯的東西」。
 *
 * `attachment` is admitted for **one subtype only** (`queuedPrompt()`): a message the user typed while the
 * agent ran tools. Every other attachment still yields nothing.
 */
const RECORD_TYPES = new Set(['user', 'assistant', 'attachment'])

/**
 * 內容區塊同樣是白名單。`thinking` 保留（使用者要看得到 agent 在想什麼），但與 `text` 分開 ——
 * 呈現層才決定要不要收合。
 */
const BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use'])

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 工具的單一辨識參數。**只取這一個** —— 完整參數含檔案路徑，見 `project()` 的邊界說明。 */
function identifyingArg(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'description']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const NAME_LIMIT = 80

/**
 * A record's origin as a client may show it, or `undefined` (`remote-tool-detail` D4).
 *
 * The sender's kind is read from **which fields exist**, not from the form of `from` (`docs/lessons/transcript.md`
 * §1): a subagent hand-back carries `senderTaskId` (checked first; measured, never together with the session
 * markers), a session's message `verifiedPeerPid` or `msg_id`. Any other origin kind adds nothing.
 */
export function originOf(origin: unknown): MessageOrigin | undefined {
  const o = record(origin)
  if (!o) return undefined
  if (o.kind === 'task-notification') return { kind: 'task-notification' }
  if (o.kind !== 'peer') return undefined
  const sender =
    typeof o.senderTaskId === 'string' ? 'subagent' : o.verifiedPeerPid !== undefined || o.msg_id !== undefined ? 'session' : 'other'
  // eslint-disable-next-line no-control-regex
  const name = typeof o.name === 'string' ? o.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, NAME_LIMIT) : ''
  return name ? { kind: 'peer', sender, name } : { kind: 'peer', sender }
}

/**
 * The text a not-typed message is shown with (`remote-tool-detail` D4a).
 *
 * A session's message is recorded inside the agent's wrapper, which names the sender's socket path; the origin also
 * holds the message itself (`body`). That field is the text, **as is** — not through `unwrapPaste` or
 * `commandLine`, which restore what the user typed. No wrapper is parsed: without a usable `body` the text stays as
 * recorded. A subagent's report keeps its recorded text: the agent's preamble is where its warnings appear.
 */
function deliveredText(text: string, rawOrigin: unknown, origin: MessageOrigin | undefined): string {
  if (origin?.kind !== 'peer' || origin.sender !== 'session') return text
  const body = record(rawOrigin)?.body
  return typeof body === 'string' && body.trim() ? body : text
}

/**
 * A mid-turn delivery as a `user` entry, or `null`.
 *
 * The agent does not write a message typed while it runs tools as a `user` record (measured, CLI 2.1.300): it
 * writes an `attachment` record of subtype `queued_command`, when it absorbs the message into the running turn.
 * The same subtype carries messages from other sessions and background-task notices. Exactly three shapes are
 * admitted, each by its `commandMode` **and** its origin's kind:
 *
 * - `prompt` + `human` — the user's message, `meta: false`. **The text is returned unchanged**: a client confirms
 *   its message arrived by matching this text against what it sent.
 * - `prompt` + `peer` — a message from another session or a subagent, `meta: true` with its origin.
 * - `task-notification` + `task-notification` — a background-task notice, `meta: true` with its origin.
 *
 * Anything else is not shown: the white-list's failure direction (a notice with no origin included).
 */
function queuedEntry(r: Record<string, unknown>): { text: string; meta: boolean; origin?: MessageOrigin } | null {
  const attachment = record(r.attachment)
  if (!attachment || attachment.type !== 'queued_command') return null
  const prompt = attachment.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) return null
  const kind = record(attachment.origin)?.kind
  if (attachment.commandMode === 'prompt' && kind === 'human') return { text: prompt, meta: false }
  const peer = attachment.commandMode === 'prompt' && kind === 'peer'
  const notice = attachment.commandMode === 'task-notification' && kind === 'task-notification'
  if (!peer && !notice) return null
  const origin = originOf(attachment.origin)
  return { text: deliveredText(prompt, attachment.origin, origin), meta: true, ...(origin ? { origin } : {}) }
}

/**
 * The record says the user did not type it (`agent-transcript-stream`).
 *
 * `isMeta` alone is not enough: background-task notices are written with `promptSource: "system"` and a
 * non-human `origin`, and a compacted conversation's summary with `isCompactSummary`, none of them flagged
 * `isMeta` (measured, CLI 2.1.300). **These only add reasons to mark a record**: a record with none of the
 * fields (older CLI versions, slash commands, `!` input) keeps the `isMeta` verdict.
 */
function notTypedByUser(r: Record<string, unknown>): boolean {
  if (r.isMeta === true || r.isCompactSummary === true || r.promptSource === 'system') return true
  const kind = record(r.origin)?.kind
  return typeof kind === 'string' && kind !== 'human'
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const t = (block as Record<string, unknown>).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

/** The image media types a result's image is counted for: the ones the API accepts (`remote-result-images` D1). */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Unwrapped standard base64. `Buffer.byteLength(data, 'base64')` is the decoded size only for this form. */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** A counted image block: its media type and its recorded base64. */
export interface ResultImage {
  mediaType: string
  data: string
}

function imageOf(block: unknown): ResultImage | null {
  const b = record(block)
  if (!b || b.type !== 'image') return null
  const source = record(b.source)
  if (!source || source.type !== 'base64') return null
  const mediaType = source.media_type
  const data = source.data
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) return null
  if (typeof data !== 'string' || data.length % 4 !== 0 || !CANONICAL_BASE64.test(data)) return null
  return { mediaType, data }
}

/**
 * The images each tool result of a record holds (`remote-result-images` D1).
 *
 * **The one reading** shared by the entry's `images`, the image index and the read: separate walks would drift,
 * and a position a device names would then pick another picture with no error. Only a `user` record that is not a
 * subagent's counts — an `api-request-blob` record holds the same id and blocks in the same shape (measured).
 * Results without a counted image are returned too, with an empty list.
 */
export function resultImagesOf(raw: unknown): { toolUseId: string; images: ResultImage[] }[] {
  const r = record(raw)
  if (!r || r.type !== 'user' || r.isSidechain === true) return []
  const content = record(r.message)?.content
  if (!Array.isArray(content)) return []
  const out: { toolUseId: string; images: ResultImage[] }[] = []
  for (const block of content) {
    const b = record(block)
    if (!b || b.type !== 'tool_result') continue
    const images: ResultImage[] = []
    if (Array.isArray(b.content)) {
      for (const inner of b.content) {
        const image = imageOf(inner)
        if (image) images.push(image)
      }
    }
    out.push({ toolUseId: str(b.tool_use_id) ?? '', images })
  }
  return out
}

/**
 * 一則來源記錄 → 零或多個呈現事件。
 *
 * ## 邊界：這裡是「不含檔案系統位置」那條 requirement 的執行點
 *
 * 來源記錄**本身就帶絕對路徑**（頂層的 `cwd`，以及工具參數裡的 `file_path` 等）。本函式以
 * **白名單**組出每一個事件 —— 只有明確列出的欄位會被帶出去。**不可改成「複製整則、再刪掉幾個
 * 欄位」**：那是黑名單，會在來源新增一個帶路徑的欄位時靜默失效，而失效的徵狀是 renderer 拿到
 * 一個它沒有詞彙可以表達的位置。
 *
 * 工具參數只取**單一辨識參數**，其值本身可能仍是路徑 —— 呈現層負責把它當成不可導覽的純文字，
 * 或由主行程另外翻成 folder-relative（見 `SpecInfo.path` 的同族處置）。
 *
 * ## subagent 不在這裡
 *
 * 實測：subagent 的內容一個位元組都不在主紀錄裡（主檔的 `isSidechain: true` 為 0），它們住在
 * 另一個目錄。防禦性地略過帶該旗標的記錄，但**不要據此以為 subagent 會被呈現** —— 它不會，
 * 而那是刻意的範圍決定。
 */
/**
 * A message that is exactly one paste, as the agent records it (measured, CLI 2.1.300):
 * `\n\n<pasted_content id="X">\n<the text>\n</pasted_content id="X">\n`. A long reply is taken as a paste, so
 * without this the conversation showed the markers and the reply never matched what was sent ("not
 * confirmed"). Only the whole-message shape is unwrapped; a paste among typed text is shown as recorded.
 */
const ONE_PASTE = /^\n*<pasted_content id="([^"\n]+)">\n([\s\S]*)\n<\/pasted_content id="\1">\n?$/

/**
 * A slash command as the agent records it — only its markers, in **either order** (a skill: message, name, args; a
 * built-in such as `/clear`: name first, indented), whitespace between — restored to the line the user typed, or
 * `null` for any other content (`agent-transcript-stream`; measured, CLI 2.1.304). Only the name and the arguments
 * are read; `<command-message>` repeats the name. The CLI records the arguments verbatim, trimmed at both ends, so
 * a device reply written as `/name args` matches its entry. A built-in's `<local-command-stdout>` record is not this.
 */
const COMMAND_MARKER = /<(command-message|command-name|command-args)>([\s\S]*?)<\/\1>/g

export function commandLine(content: string): string | null {
  let name: string | null = null
  let args = ''
  let names = 0
  const rest = content.replace(COMMAND_MARKER, (_whole, tag: string, inner: string) => {
    if (tag === 'command-name') {
      names += 1
      name = inner.trim()
    } else if (tag === 'command-args') {
      args = inner.trim()
    }
    return ''
  })
  if (names !== 1 || rest.trim() !== '' || name === null) return null
  const command: string = name
  if (!/^\/\S+$/.test(command)) return null
  return args ? `${command} ${args}` : command
}

export function unwrapPaste(content: string): string {
  const match = ONE_PASTE.exec(content)
  return match ? match[2] : content
}

export function project(raw: unknown): ViewEvent[] {
  if (raw === null || typeof raw !== 'object') return []
  const r = raw as Record<string, unknown>
  const type = str(r.type)
  if (type === null || !RECORD_TYPES.has(type)) return []
  if (r.isSidechain === true) return []

  const uuid = str(r.uuid) ?? ''
  const at = Date.parse(str(r.timestamp) ?? '') || 0
  if (type === 'attachment') {
    const entry = queuedEntry(r)
    return entry === null ? [] : [{ kind: 'user', uuid, at, ...entry }]
  }
  const message = r.message
  if (message === null || typeof message !== 'object') return []
  const content = (message as Record<string, unknown>).content

  if (type === 'user') {
    // 使用者的訊息可能是字串，也可能是帶 `tool_result` 的陣列 —— 後者不是使用者打的字。
    if (typeof content === 'string') {
      const meta = notTypedByUser(r)
      const origin = meta ? originOf(r.origin) : undefined
      const text = deliveredText(commandLine(content) ?? unwrapPaste(content), r.origin, origin)
      return text.trim()
        ? [{ kind: 'user', uuid, at, text, meta, ...(origin ? { origin } : {}) }]
        : []
    }
    if (!Array.isArray(content)) return []
    const images = resultImagesOf(r)
    const out: ViewEvent[] = []
    let index = 0
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_result') continue
      const listed = images[index++]?.images ?? []
      out.push({
        kind: 'result',
        uuid,
        at,
        id: str(b.tool_use_id) ?? '',
        text: resultText(b.content),
        error: b.is_error === true,
        ...(listed.length > 0
          ? { images: listed.map((i) => ({ mediaType: i.mediaType, size: Buffer.byteLength(i.data, 'base64') })) }
          : {}),
      })
    }
    return out
  }

  if (!Array.isArray(content)) return []
  const out: ViewEvent[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const bt = str(b.type)
    if (bt === null || !BLOCK_TYPES.has(bt)) continue
    if (bt === 'text') {
      const text = str(b.text)
      if (text?.trim()) out.push({ kind: 'text', uuid, at, text })
    } else if (bt === 'thinking') {
      const text = str(b.thinking)
      if (text?.trim()) out.push({ kind: 'thinking', uuid, at, text })
    } else {
      const name = str(b.name)
      if (name) {
        const selected = toolInput(name, b.input)
        out.push({
          kind: 'tool',
          uuid,
          at,
          id: str(b.id) ?? '',
          name,
          arg: identifyingArg(b.input),
          ...(selected ? { input: selected.input } : {}),
          ...(selected && Object.keys(selected.truncated).length > 0 ? { inputTruncated: selected.truncated } : {}),
        })
      }
    }
  }
  return out
}

/** Parses one line; `null` when it is not JSON (a half-written or damaged line must not stop the follow). */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** 解析一行並投影。解析失敗即忽略 —— 半行、損毀的行不該讓整條跟進停擺。 */
export function projectLine(line: string): ViewEvent[] {
  return project(parseLine(line))
}

/**
 * 初次附掛的量體上限。
 *
 * **以事件數為單位，不以位元組為單位** —— 規格在乎的是「呈現層要一次收下多少則」，而位元組數
 * 與則數的關係取決於內容（實測本機單一紀錄最大 6.4 MB / 4357 列，比值差距極大）。
 *
 * 超過時**只送最近的一段並明示**：一份看起來完整、實際少了開頭的對話，會讓使用者據此做出錯誤
 * 判斷 —— 那比明說「較早的沒有載入」更糟。
 */
export const INITIAL_ATTACH_LIMIT = 400

export interface Attachment {
  events: ViewEvent[]
  /** 較早的內容是否被省略。呈現層 SHALL 據此明示。 */
  truncated: boolean
}

export function attachmentOf(events: readonly ViewEvent[], limit = INITIAL_ATTACH_LIMIT): Attachment {
  if (events.length <= limit) return { events: [...events], truncated: false }
  return { events: events.slice(events.length - limit), truncated: true }
}

/** 呈現事件的時間排序鍵。同一則記錄投影出的多個事件保持原順序。 */
export function sortKey(event: ViewEvent): number {
  return num(event.at)
}
