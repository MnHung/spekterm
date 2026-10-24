/**
 * A tool call's arguments, as a client may show them (`remote-tool-detail` D1–D3).
 *
 * ## A white-list per tool, never a copy
 *
 * Each tool names the fields taken from its recorded input. Building the result by copying the input and deleting
 * fields would let every field the CLI adds later flow out by default — the same rule `project()` keeps for whole
 * records. A tool off the table yields nothing, `mcp__*` included: an MCP server's arguments are whatever its
 * author chose (tokens, query strings with credentials, page scripts).
 *
 * ## Values keep their recorded type
 *
 * Measured (CLI 2.1.30x): Agent's `run_in_background` is a string in every call that sets it, Monitor's `timeout`
 * sometimes. A scalar passes with its own type; a client accepts either.
 *
 * ## Bounds, and the shortening is named
 *
 * Each string at most `STRING_LIMIT` UTF-16 units, one call's strings together at most `CALL_LIMIT`, taken in
 * white-list order. `truncated` maps each top-level field that lost characters or items to its original length (or,
 * for a list that lost items, its original item count).
 */

export const STRING_LIMIT = 4000
export const CALL_LIMIT = 12000
export const FILES_LIMIT = 20
export const QUESTIONS_LIMIT = 4
export const OPTIONS_LIMIT = 8

type Scalar = string | number | boolean
export type ToolInputValue = Scalar | string[] | QuestionView[]
export interface QuestionView {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: { label?: string; description?: string }[]
}

export interface ToolInput {
  input: Record<string, ToolInputValue>
  truncated: Record<string, number>
}

/** Field kinds: a scalar, a list of strings (`files`), or the question tool's nested list. */
type Field = string | { name: 'files'; kind: 'strings' } | { name: 'questions'; kind: 'questions' }

const FILES: Field = { name: 'files', kind: 'strings' }
const QUESTIONS: Field = { name: 'questions', kind: 'questions' }

const AGENT: Field[] = ['description', 'subagent_type', 'prompt', 'run_in_background']

const WHITE_LIST: Record<string, readonly Field[]> = {
  Bash: ['command', 'description', 'run_in_background'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  Write: ['file_path', 'content'],
  Read: ['file_path', 'offset', 'limit'],
  Grep: ['pattern', 'path', 'glob'],
  Glob: ['pattern', 'path'],
  // `to` is filtered below: only a named recipient (D1).
  SendMessage: ['to', 'recipient_kind', 'summary', 'message'],
  Agent: AGENT,
  Task: AGENT,
  Skill: ['skill', 'args'],
  SendUserFile: [FILES, 'caption'],
  AskUserQuestion: [QUESTIONS],
  ToolSearch: ['query'],
  WebSearch: ['query'],
  WebFetch: ['url', 'prompt'],
  Monitor: ['description', 'command'],
  TaskStop: ['task_id'],
  ScheduleWakeup: ['delaySeconds', 'reason'],
  CronCreate: ['cron', 'prompt'],
  Artifact: ['action', 'file_path', 'url', 'description'],
  ExitPlanMode: ['plan'],
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function scalar(value: unknown): Scalar | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/** Cuts `text` to at most `max` UTF-16 units, never between the halves of a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** One call's string budget, spent in white-list order. */
class Budget {
  #left = CALL_LIMIT
  /** Whether this call lost characters so far for the field being built. */
  shortened = false

  take(text: string): string {
    const kept = cut(text, Math.min(STRING_LIMIT, this.#left))
    this.#left -= kept.length
    if (kept.length < text.length) this.shortened = true
    return kept
  }
}

function strings(raw: unknown, budget: Budget): { value: string[]; length: number } | null {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) return null
  const items = raw as string[]
  const value = items.slice(0, FILES_LIMIT).map((item) => budget.take(item))
  const dropped = items.length > FILES_LIMIT
  return { value, length: dropped ? items.length : items.reduce((sum, item) => sum + item.length, 0) }
}

function questions(raw: unknown, budget: Budget): { value: QuestionView[]; length: number; dropped: boolean } | null {
  if (!Array.isArray(raw)) return null
  let dropped = raw.length > QUESTIONS_LIMIT
  let length = 0
  const text = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    length += value.length
    return budget.take(value)
  }
  const value: QuestionView[] = []
  for (const item of raw.slice(0, QUESTIONS_LIMIT)) {
    const q = record(item)
    if (!q) continue
    const view: QuestionView = {}
    const question = text(q.question)
    if (question !== undefined) view.question = question
    const header = text(q.header)
    if (header !== undefined) view.header = header
    if (typeof q.multiSelect === 'boolean') view.multiSelect = q.multiSelect
    if (Array.isArray(q.options)) {
      if (q.options.length > OPTIONS_LIMIT) dropped = true
      view.options = q.options.slice(0, OPTIONS_LIMIT).flatMap((option) => {
        const o = record(option)
        if (!o) return []
        const out: { label?: string; description?: string } = {}
        const label = text(o.label)
        if (label !== undefined) out.label = label
        const description = text(o.description)
        if (description !== undefined) out.description = description
        return [out]
      })
    }
    value.push(view)
  }
  return { value, length: dropped ? raw.length : length, dropped }
}

/** The selected input of one tool call, or `null` when the tool is off the list or nothing was selected. */
export function toolInput(name: string, raw: unknown): ToolInput | null {
  const fields = WHITE_LIST[name]
  const source = record(raw)
  if (!fields || !source) return null
  const budget = new Budget()
  const input: Record<string, ToolInputValue> = {}
  const truncated: Record<string, number> = {}
  for (const field of fields) {
    budget.shortened = false
    if (typeof field !== 'string') {
      const value = source[field.name]
      if (field.kind === 'strings') {
        const taken = strings(value, budget)
        if (!taken) continue
        input.files = taken.value
        if (budget.shortened || taken.value.length < (value as unknown[]).length) truncated.files = taken.length
      } else {
        const taken = questions(value, budget)
        if (!taken) continue
        input.questions = taken.value
        if (budget.shortened || taken.dropped) truncated.questions = taken.length
      }
      continue
    }
    // A recipient that is not a name is a socket path or an internal id (D1): never selected.
    if (name === 'SendMessage' && field === 'to' && source.recipient_kind !== 'name') continue
    const value = scalar(source[field])
    if (value === undefined) continue
    if (typeof value === 'string') {
      input[field] = budget.take(value)
      if (budget.shortened) truncated[field] = value.length
    } else {
      input[field] = value
    }
  }
  return Object.keys(input).length === 0 ? null : { input, truncated }
}
