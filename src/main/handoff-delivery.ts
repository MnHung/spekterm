import { createHash } from 'node:crypto'

import { firstMatchAfter, MAX_REPEAT_SEARCH_YEARS, parseCron } from './cron'
import { type DeliveryProvenance, type HandoffSource, MAX_FIELD_LENGTH, normalizeAuthored } from './intake-schema'

/** 交接的 adapter 名。去重的主鍵之一（`(adapter, id)`）。 */
export const HANDOFF_ADAPTER = 'handoff'

/** 來源座標的種類。**不是列舉的一員** —— 收件匣對不認得的種類一律放行。 */
export const HANDOFF_ORIGIN_KIND = 'session'

/** 摘要取前這麼多個 hex 字元。碰撞在這個用途上不具意義（同一個 session 之內的區辨）。 */
const DIGEST_CHARS = 16

export interface HandoffPayload {
  target: string
  title: string
  body: string
  /**
   * The `at` the agent wrote, as written. Absent: open on arrival. Parsed by `parseScheduledAt`. With `repeat` it is
   * the recurrence's start, not the time the handoff opens (`recurring-handoff`).
   */
  at?: string
  /** A cron expression: the handoff repeats once the user approves it (`recurring-handoff`). Parsed by `parseCron`. */
  repeat?: string
  /** When a repeating handoff ends, as written. Parsed by `parseUntil`. */
  until?: string
}

export type PayloadResult =
  | { ok: true; value: HandoffPayload }
  | { ok: false; reason: 'MALFORMED' | 'FIELD_TYPE'; field?: string }

/**
 * How far ahead a handoff may be scheduled (`scheduled-handoff`). A time further out is more likely a mistyped
 * month or year than a plan, and it would wait unnoticed. **The introduction derives its number from this
 * constant** (`handoff-intro-source` guards literals).
 */
export const MAX_SCHEDULE_AHEAD_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The one form `at` may take: ISO 8601 extended, seconds and a fraction optional, **an offset mandatory**.
 * `Date.parse` alone is not the check (measured on Node 22): it accepts `2026-02-30` (rolls over to 2 March),
 * `T24:00`, an offset-less time as local time, `+0800` and a space separator.
 */
const SCHEDULE_FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/

export type ScheduleResult =
  | { kind: 'absent' }
  | { kind: 'scheduled'; at: number }
  | { kind: 'invalid'; rule: string }

/**
 * One time in the strict form (`SCHEDULE_FORM`), checked component by component, as an instant. Shared by `at` and
 * `until`; the bound and the comparison with now are each field's own rule.
 */
function parseInstant(text: string): { ok: true; at: number } | { ok: false; rule: string } {
  const m = SCHEDULE_FORM.exec(text)
  if (!m) {
    return {
      ok: false,
      rule: /(Z|[+-]\d{2}:\d{2})$/.test(text) ? 'not YYYY-MM-DDTHH:MM[:SS] with an offset' : 'no offset (Z or ±HH:MM)',
    }
  }
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  const second = m[6] === undefined ? 0 : Number(m[6])
  if (month < 1 || month > 12) return { ok: false, rule: 'month out of range' }
  if (day < 1 || day > daysInMonth(year, month)) return { ok: false, rule: 'day does not exist in that month' }
  if (hour > 23) return { ok: false, rule: 'hour out of range' }
  if (minute > 59 || second > 59) return { ok: false, rule: 'minute or second out of range' }
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return { ok: false, rule: 'offset out of range' }
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return { ok: false, rule: 'not a time' }
  return { ok: true, at: ms }
}

/** A repeating handoff: the expression in its canonical form, and its start and end when set. */
export interface Recurrence {
  repeat: string
  startAt?: number
  until?: number
}

export type RecurrenceResult = { kind: 'absent' } | { kind: 'repeating'; recurrence: Recurrence } | { kind: 'invalid'; rule: string }

/**
 * Reads `repeat` and `until` (`recurring-handoff`, design D3) against the same reading of the clock as `at`.
 * `startAt` is the already-parsed start (`parseScheduledAt` of `at`, only when later than now). Every refusal names
 * its rule; the receipt carries it.
 */
export function parseRecurrence(payload: HandoffPayload, startAt: number | undefined, now: number): RecurrenceResult {
  if (payload.repeat === undefined) {
    return payload.until === undefined ? { kind: 'absent' } : { kind: 'invalid', rule: 'until: only with repeat' }
  }
  const cron = parseCron(payload.repeat)
  if (!cron.ok) return { kind: 'invalid', rule: `repeat: ${cron.rule}` }
  let until: number | undefined
  if (payload.until !== undefined) {
    const instant = parseInstant(payload.until)
    if (!instant.ok) return { kind: 'invalid', rule: `until: ${instant.rule}` }
    if (instant.at <= now || (startAt !== undefined && instant.at <= startAt)) {
      return { kind: 'invalid', rule: 'until: not later than now and the start' }
    }
    until = instant.at
  }
  // The start is inclusive: a time exactly at it is the first.
  const first = firstMatchAfter(cron.schedule, startAt === undefined ? now : startAt - 1)
  if (first === null) return { kind: 'invalid', rule: `repeat: no time within ${MAX_REPEAT_SEARCH_YEARS} years` }
  if (until !== undefined && first > until) return { kind: 'invalid', rule: 'until: no time between the start and until' }
  return {
    kind: 'repeating',
    recurrence: {
      repeat: payload.repeat.trim().split(/[ \t]+/).join(' '),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(until !== undefined ? { until } : {}),
    },
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/**
 * Reads `at` against **one** reading of the clock, taken once per delivery (`scheduled-handoff`, design D2): a
 * time not later than `now` is "absent" — the handoff behaves as one without `at`, and nothing downstream
 * compares its time again.
 */
export function parseScheduledAt(at: string | undefined, now: number): ScheduleResult {
  if (at === undefined) return { kind: 'absent' }
  const instant = parseInstant(at)
  if (!instant.ok) return { kind: 'invalid', rule: instant.rule }
  const ms = instant.at
  if (ms <= now) return { kind: 'absent' }
  if (ms - now > MAX_SCHEDULE_AHEAD_DAYS * DAY_MS) return { kind: 'invalid', rule: `more than ${MAX_SCHEDULE_AHEAD_DAYS} days ahead` }
  return { kind: 'scheduled', at: ms }
}

/**
 * 完成報告的摘要上限（`handoff-completion`）。它是給人一眼看完的東西 —— 詳細的內容由 agent 經訊息
 * 或寫檔交給母 session。**自我介紹由這個常數推導**（`handoff-intro-source` 守衛擋字面值）。
 */
export const MAX_REPORT_LENGTH = 4_000

/**
 * 落點裡的一份投遞是哪一種東西。**種類欄位缺席 ⇒ 交接**（既有格式不變）。
 *
 * - `report` —— 完成報告（`handoff-completion`）。
 * - 其餘值 —— 不認得，拒絕且可見。
 * - `malformed` —— 讀不成一個 JSON 物件：**不消費**，可能只是寫到一半（與交接同一條處置）。
 */
export type OutboxKind = 'handoff' | 'report' | CommandKind | 'unknown' | 'malformed'

/** The agent's session commands (`agent-session-control`). */
export type CommandKind = 'close' | 'hibernate' | 'rename'

const COMMAND_KINDS: readonly string[] = ['close', 'hibernate', 'rename'] satisfies CommandKind[]

export function isCommandKind(kind: OutboxKind): kind is CommandKind {
  return COMMAND_KINDS.includes(kind)
}

export function outboxKindOf(contents: string): OutboxKind {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch {
    return 'malformed'
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'malformed'
  const kind = (raw as Record<string, unknown>).kind
  if (kind === undefined) return 'handoff'
  if (kind === 'report') return 'report'
  return typeof kind === 'string' && COMMAND_KINDS.includes(kind) ? (kind as CommandKind) : 'unknown'
}

export type ReportResult =
  | { ok: true; summary: string }
  | { ok: false; reason: 'FIELD_TYPE' | 'EMPTY' | 'TOO_LONG'; length?: number }

/**
 * 讀出完成報告的摘要。**走與其他非第三方欄位相同的攝入正規化** —— 它會呈現在畫面上，也會寫進另一個
 * agent 讀的關係檔。正規化之後為空 ⇒ 拒絕；超過上限 ⇒ 拒絕，**不截斷**：截斷後的摘要看起來是完整的，
 * 而它的結尾從未抵達。
 */
export function parseReport(contents: string): ReportResult {
  const raw = JSON.parse(contents) as Record<string, unknown>
  if (typeof raw.summary !== 'string') return { ok: false, reason: 'FIELD_TYPE' }
  const summary = normalizeAuthored(raw.summary)
  if (summary.trim() === '') return { ok: false, reason: 'EMPTY' }
  if (summary.length > MAX_REPORT_LENGTH) return { ok: false, reason: 'TOO_LONG', length: summary.length }
  return { ok: true, summary }
}

export interface SessionCommand {
  kind: CommandKind
  /** A fixed name, or absent for the agent's own session. */
  target?: string
  /** Rename only: flattened to one line, possibly empty (hands naming back). */
  name?: string
}

export type CommandResult =
  | { ok: true; command: SessionCommand }
  | { ok: false; reason: 'FIELD_TYPE'; field: string }
  | { ok: false; reason: 'TOO_LONG'; length: number }

/**
 * Reads a session command (`agent-session-control`, design D1). **Only `target` and `name` are read**: anything
 * else, a field claiming a source above all, has no effect — the source is the drop point the file landed in.
 *
 * The name is flattened as a source title is (`sourceTitle`'s rule) and counted in code points, the unit that rule
 * slices by. A longer one is refused, not shortened: a shortened label looks whole.
 */
export function parseCommand(kind: CommandKind, contents: string): CommandResult {
  const raw = JSON.parse(contents) as Record<string, unknown>
  const target = raw.target
  if (target !== undefined && (typeof target !== 'string' || target === '')) return { ok: false, reason: 'FIELD_TYPE', field: 'target' }
  if (kind !== 'rename') return { ok: true, command: { kind, ...(target !== undefined ? { target } : {}) } }
  if (typeof raw.name !== 'string') return { ok: false, reason: 'FIELD_TYPE', field: 'name' }
  const name = normalizeAuthored(raw.name).replace(/\n+/g, ' ').trim()
  const length = [...name].length
  if (length > MAX_FIELD_LENGTH) return { ok: false, reason: 'TOO_LONG', length }
  return { ok: true, command: { kind, ...(target !== undefined ? { target } : {}), name } }
}

/**
 * 讀出 agent 寫下的那三個欄位。
 *
 * **只讀這三個**，其餘一律不看 —— 尤其是任何自稱來源或自稱目標的欄位：來源由投遞落在哪個目錄
 * 決定、目標由查表解析，兩者都不能是投遞內容說了算。
 */
export function parseHandoffPayload(contents: string): PayloadResult {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch {
    // **不消費** —— 可能只是寫到一半（與共用落點同一條處置）。
    return { ok: false, reason: 'MALFORMED' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'MALFORMED' }
  }
  const source = raw as Record<string, unknown>
  const target = source.target
  const body = source.body
  if (typeof target !== 'string' || typeof body !== 'string') {
    return { ok: false, reason: 'FIELD_TYPE' }
  }
  const title = typeof source.title === 'string' ? source.title : ''
  const optional: Record<string, string> = {}
  for (const field of ['at', 'repeat', 'until'] as const) {
    const value = source[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return { ok: false, reason: 'FIELD_TYPE', field }
    optional[field] = value
  }
  return { ok: true, value: { target, title, body, ...optional } }
}

/**
 * 交接的識別碼 —— 由**來源 session ＋ 投遞內容的摘要**推導。
 *
 * **不由檔名推導，也不由 payload 的某個欄位指定。** 兩者是同一件事：檔名同樣由 agent 挑選，
 * 於是唯一性被丟回給它 —— 而它沒有依據可循。同一個 session 兩次交接若用了同一個檔名，第二則
 * 會成為重複（同內容靜默丟棄、不同內容拒絕且不建 session），**而 agent 已經回報它交接出去了**。
 *
 * **也不於接收時隨機產生**：落點的「先建立監看、再掃描」會讓同一份投遞被讀兩次，隨機 id 使它
 * 成為兩則交接、**開出兩個 session**，而既有的去重完全看不見。
 *
 * 內容摘要同時滿足兩端：重送冪等、不同內容自然不同。摘要**取自正規化後的三個欄位而非原始
 * 位元組** —— 否則同一份內容改一個空白就變成另一則交接。
 */
export function handoffIntakeId(sessionId: string, payload: HandoffPayload, scheduledAt?: number, recurrence?: Recurrence): string {
  // The schedule joins the digest only when present, so every handoff id from before scheduling is unchanged,
  // and the same body at two times is two handoffs. A recurrence likewise (`recurring-handoff`).
  const fields: unknown[] = [payload.target, payload.title, payload.body]
  if (scheduledAt !== undefined) fields.push(scheduledAt)
  if (recurrence !== undefined) fields.push({ repeat: recurrence.repeat, start: recurrence.startAt ?? null, until: recurrence.until ?? null })
  const digest = createHash('sha256')
    .update(JSON.stringify(fields), 'utf8')
    .digest('hex')
    .slice(0, DIGEST_CHARS)
  return `${sessionId}-${digest}`
}

export interface DeliveryInput {
  sessionId: string
  payload: HandoffPayload
  /** 原始投遞的文字 —— 保存用，供日後診斷（含 agent 寫下的 `target` 原字串）。 */
  contents: string
  /** 來源的座標識別碼：來源 folder，全域 session 則為保留字。 */
  originId: string
  /** 來源的標籤（folder 名稱 / `Global` / 已結束）。 */
  originLabel: string
  /** 查表解析出的目標。 */
  targetFolderId: string
  /** 來源 session 與它於此刻的快照（`session-lineage`）。識別碼不合法時缺席。 */
  source?: HandoffSource
  /** When the handoff opens, if later than the read time (`parseScheduledAt`). Never with `recurrence`. */
  scheduledAt?: number
  /** A repeating handoff: a proposal, opened by nothing but the user's approval (`recurring-handoff`). */
  recurrence?: Recurrence
}

/** 交給 `deliver()` 的兩樣東西：投遞的文字，以及接收端算出來的 provenance。 */
export function buildDelivery(input: DeliveryInput): {
  contents: string
  provenance: DeliveryProvenance
} {
  let original: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(input.contents)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      original = parsed as Record<string, unknown>
    }
  } catch {
    // 走到這裡表示上游已經解析成功過，這裡不可能失敗；失敗也只是少了保存用的原始欄位。
  }

  return {
    // **原始欄位一併保留**（`target` 會被 `parseIntake` 當成未知欄位丟棄，但它留在保存處，
    // 而「agent 當初寫的是哪個字串」正是診斷一次查無時唯一有用的東西）。
    // 我們指定的 `id` 覆蓋 payload 裡任何自稱的 id。
    contents: JSON.stringify({
      ...original,
      id: handoffIntakeId(input.sessionId, input.payload, input.scheduledAt, input.recurrence),
      title: input.payload.title,
      body: input.payload.body,
      actor: input.originLabel,
    }),
    provenance: {
      origin: { kind: HANDOFF_ORIGIN_KIND, id: input.originId, label: input.originLabel },
      targetFolderId: input.targetFolderId,
      // 本文由使用者自己 session 裡的 agent 撰寫 —— 它就是那件要做的事，
      // 不是一份要 agent 先抄一遍的第三方文字。
      firstPartyBody: true,
      ...(input.source ? { source: input.source } : {}),
      // Kept so the target can be resolved again when the handoff opens (`handoff-opener.ts`).
      targetText: normalizeAuthored(input.payload.target),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.recurrence
        ? {
            repeat: input.recurrence.repeat,
            ...(input.recurrence.startAt !== undefined ? { repeatStart: input.recurrence.startAt } : {}),
            ...(input.recurrence.until !== undefined ? { repeatUntil: input.recurrence.until } : {}),
          }
        : {}),
      // A proposal is not opened by the opener: only approval schedules it (`recurring-handoff`, D3).
      autoOpen: input.recurrence === undefined,
    },
  }
}
