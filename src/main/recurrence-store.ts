import fs from 'node:fs'
import path from 'node:path'

import { parseHandoffSource, type IntakeAuthored, type IntakeVerified } from './intake-schema'

/**
 * The approved repeating handoffs (`recurring-handoff`, design D1), in `<userData>/handoff-recurrences.json`.
 *
 * A recurrence outlives every record it produces and has no time bound, so it is not an inbox record: a record is
 * opened at most once. Its occurrences are ordinary scheduled handoff records, kept by `RecurrenceKeeper`.
 *
 * ## An unreadable file is not an empty store
 *
 * A missing file is an empty store. A file that is not JSON, or has a version this build does not know (a newer
 * build wrote it, then the user rolled back), **marks the store unavailable**: nothing reads it as empty, nothing
 * writes it. Read as empty, the keeper would take every occurrence for an orphan of a stopped recurrence, and the
 * next approval would overwrite every recurrence the user approved.
 *
 * Writes go to disk first and are assigned after: a failed write must not leave a value in memory that the next
 * successful write would then persist.
 */

export const RECURRENCE_VERSION = 1

/** The content an occurrence is made from: the proposal's, copied, so the recurrence does not depend on it. */
export interface RecurrenceContent {
  verified: IntakeVerified
  authored: IntakeAuthored
}

export interface Recurrence {
  /** The proposal's id. */
  id: string
  /** The cron expression, canonical form. */
  repeat: string
  intake: RecurrenceContent
  /** The folder the user approved it into, as its absolute path: resolved again for each occurrence. */
  targetText: string
  approvedAt: number
  startAt?: number
  until?: number
  /** The time of the last occurrence created. */
  lastOccurrenceAt?: number
  /** Tombstone: the user stopped it. Its unopened occurrence is removed; nothing further is created. */
  stoppedAt?: number
  /** Its next time fell after `until`: it has ended. An occurrence created before that still opens. */
  endedAt?: number
}

interface PersistedRecurrences {
  version: number
  entries: Recurrence[]
}

function isInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function str(value: unknown): value is string {
  return typeof value === 'string'
}

/** The content, field by field: only what an occurrence needs, each with its type. */
function parseContent(raw: unknown): RecurrenceContent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { verified: v, authored: a } = raw as { verified?: Record<string, unknown>; authored?: Record<string, unknown> }
  if (typeof v !== 'object' || v === null || typeof a !== 'object' || a === null) return null
  if (!str(v.adapter) || !str(v.originKind) || !str(v.originId)) return null
  if (!str(a.title) || !str(a.body) || !str(a.actor) || !str(a.originLabel)) return null
  const source = parseHandoffSource(v.source)
  return {
    verified: {
      adapter: v.adapter,
      originKind: v.originKind,
      originId: v.originId,
      ...(v.firstPartyBody === true ? { firstPartyBody: true } : {}),
      ...(source ? { source } : {}),
    },
    authored: { title: a.title, body: a.body, actor: a.actor, originLabel: a.originLabel },
  }
}

function parseEntry(raw: unknown): Recurrence | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (!str(e.id) || !str(e.repeat) || !str(e.targetText) || !isInstant(e.approvedAt)) return null
  const intake = parseContent(e.intake)
  if (!intake) return null
  return {
    id: e.id,
    repeat: e.repeat,
    intake,
    targetText: e.targetText,
    approvedAt: e.approvedAt,
    ...(isInstant(e.startAt) ? { startAt: e.startAt } : {}),
    ...(isInstant(e.until) ? { until: e.until } : {}),
    ...(isInstant(e.lastOccurrenceAt) ? { lastOccurrenceAt: e.lastOccurrenceAt } : {}),
    ...(isInstant(e.stoppedAt) ? { stoppedAt: e.stoppedAt } : {}),
    ...(isInstant(e.endedAt) ? { endedAt: e.endedAt } : {}),
  }
}

/** `null` ⇒ the file is unreadable (the store is unavailable); a missing file is handled by the caller. */
export function parseRecurrenceFile(text: string): Recurrence[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const file = raw as Partial<PersistedRecurrences>
  if (file.version !== RECURRENCE_VERSION || !Array.isArray(file.entries)) return null
  return file.entries.map(parseEntry).filter((entry): entry is Recurrence => entry !== null)
}

export class RecurrenceStore {
  #entries = new Map<string, Recurrence>()
  #available = true

  constructor(private readonly filePath: string) {}

  load(): void {
    let text: string
    try {
      text = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.#available = false
      console.error(`[recurrence] cannot read ${this.filePath}: ${String(error)}`)
      return
    }
    const entries = parseRecurrenceFile(text)
    if (!entries) {
      this.#available = false
      console.error(`[recurrence] ${this.filePath} is not a recurrence file this version can read; left untouched`)
      return
    }
    for (const entry of entries) this.#entries.set(entry.id, entry)
  }

  /** False when the file could not be read: nothing is created, changed or written. */
  get available(): boolean {
    return this.#available
  }

  get(id: string): Recurrence | undefined {
    return this.#entries.get(id)
  }

  list(): Recurrence[] {
    return [...this.#entries.values()]
  }

  /** Writes the store with `entry` in it, then keeps it. Throws when unavailable or when the write fails. */
  put(entry: Recurrence): void {
    if (!this.#available) throw new Error('the recurrence file could not be read; it is not written')
    const next = new Map(this.#entries)
    next.set(entry.id, entry)
    const payload: PersistedRecurrences = { version: RECURRENCE_VERSION, entries: [...next.values()] }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, this.filePath)
    this.#entries = next
  }
}
