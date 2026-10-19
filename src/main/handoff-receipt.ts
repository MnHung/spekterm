import fs from 'node:fs'
import path from 'node:path'

import { receiptReason } from './agent-protocol-copy'
import { isPermanentRejection } from './intake-rejection'
import type { SourceOutcome } from './intake-source'

/**
 * The receipt spekterm writes for every file it reads from an agent's outbox (`handoff-receipt`, design D8).
 *
 * It states **what was done when the file was read** — accepted, scheduled, a duplicate, refused, or held back —
 * never whether the target session started or finished the work (that is the child's own report). Its own status
 * type, not `IntakeRejection`: the five statuses are the agent's vocabulary, and `held` / `READ_FAILED` exist
 * only here.
 */

export type ReceiptStatus = 'accepted' | 'scheduled' | 'duplicate' | 'rejected' | 'held'

export interface Receipt {
  /** The delivery's file name. */
  file: string
  status: ReceiptStatus
  /** ISO 8601, UTC. */
  writtenAt: string
  code?: string
  reason?: string
  /** `rejected` only: whether the same content will be refused again, by `isPermanentRejection`. */
  permanent?: boolean
  /** `scheduled` only: when it opens, ISO 8601 UTC. */
  at?: string
}

/** How many receipts a session keeps: an agent that writes many files cannot grow the directory without bound. */
export const MAX_RECEIPTS = 100

/** The codes whose detail is system-written (a field name, a rule, workspace paths) and helps the agent. */
const DETAILED = new Set(['FIELD_TYPE', 'TOO_LONG', 'SCHEDULE_INVALID', 'TARGET_AMBIGUOUS'])

export function receiptFor(file: string, outcome: SourceOutcome, now: number): Receipt {
  const base = { file: path.basename(file), writtenAt: new Date(now).toISOString() }
  if ('failed' in outcome) return { ...base, status: 'held', code: 'READ_FAILED', reason: receiptReason('READ_FAILED') }
  if (outcome.ok) {
    if (outcome.duplicate) return { ...base, status: 'duplicate' }
    const scheduledAt = outcome.record?.content?.verified.scheduledAt
    if (scheduledAt !== undefined) return { ...base, status: 'scheduled', at: new Date(scheduledAt).toISOString() }
    return { ...base, status: 'accepted' }
  }
  const code = outcome.code ?? 'MALFORMED'
  // A same-content resend changed nothing; it is not a refusal.
  if (code === 'DUPLICATE' && !outcome.notify) return { ...base, status: 'duplicate' }
  const reason = DETAILED.has(code) && outcome.detail ? `${receiptReason(code)} (${outcome.detail})` : receiptReason(code)
  if (!outcome.consume) return { ...base, status: 'held', code, reason }
  return { ...base, status: 'rejected', code, reason, permanent: isPermanentRejection({ code, notify: outcome.notify }) }
}

/**
 * Writes a receipt into `dir`, whole: to a dot-prefixed temporary name, then renamed, so a reader in another
 * process never sees half of one. A `held` receipt is rewritten only when its status or code changes — the
 * periodic re-read would otherwise rewrite it every 30 seconds. Then trims the directory to `MAX_RECEIPTS`.
 */
export function writeReceipt(dir: string, receipt: Receipt): void {
  prepareDir(dir)
  const target = path.join(dir, receipt.file)
  if (receipt.status === 'held') {
    const previous = readReceipt(target)
    if (previous?.status === 'held' && previous.code === receipt.code) return
  }
  const tmp = path.join(dir, `.${receipt.file}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, target)
  trim(dir)
}

/**
 * The directory's location is told to the agent, which can write there: a non-directory in its place is replaced
 * (as `prepareOutbox` does), and nothing below follows a link.
 */
function prepareDir(dir: string): void {
  const existing = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (existing && !existing.isDirectory()) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

function readReceipt(file: string): Partial<Receipt> | null {
  try {
    const stats = fs.lstatSync(file)
    if (!stats.isFile()) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Receipt>
  } catch {
    return null
  }
}

/** Keeps the newest `MAX_RECEIPTS` regular files; removes only regular files, never following a link. */
function trim(dir: string): void {
  const files: { file: string; mtimeMs: number }[] = []
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const file = path.join(dir, name)
    const stats = fs.lstatSync(file, { throwIfNoEntry: false })
    if (stats?.isFile()) files.push({ file, mtimeMs: stats.mtimeMs })
  }
  if (files.length <= MAX_RECEIPTS) return
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { file } of files.slice(MAX_RECEIPTS)) fs.rmSync(file, { force: true })
}
