import fs from 'node:fs'
import path from 'node:path'

import { receiptReason, receiptReasonWithRules } from './agent-protocol-copy'
import { commandsFile, repeatingFile } from './handoff-outbox'
import { isPermanentRejection } from './intake-rejection'
import type { SourceOutcome } from './intake-source'
import { isProposalRecord } from './recurrence-kind'

/**
 * The receipt spekterm writes for every file it reads from an agent's outbox (`handoff-receipt`, design D8).
 *
 * It states **what was done when the file was read** — accepted, scheduled, a duplicate, refused, or held back —
 * never whether the target session started or finished the work (that is the child's own report). Its own status
 * type, not `IntakeRejection`: the six statuses are the agent's vocabulary, and `held` / `READ_FAILED` exist
 * only here.
 */

export type ReceiptStatus =
  | 'accepted'
  | 'scheduled'
  | 'proposed'
  | 'duplicate'
  | 'rejected'
  | 'held'
  // A teammate handoff (`teammate-handoff`): waiting for the user, stored by the team server, or discarded.
  | 'awaiting-confirmation'
  | 'sent'
  | 'discarded'

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
  /** `scheduled`, and `held` `RATE_LIMITED`: when it opens or is tried again, ISO 8601 UTC. */
  at?: string
  /**
   * A teammate handoff's own reference (`teammate-handoff`, design D6): a later rewrite replaces only a receipt
   * carrying it, never another delivery's that reused the file name.
   */
  ref?: string
  /**
   * `scheduled`, `proposed`, and `duplicate` of a known handoff: the item's id — a proposal's stays its recurrence's
   * once approved. A cancel's receipt states the id it named. It is what a cancel names (`handoff-cancel`).
   */
  id?: string
  /** `sent`: the recipient's handle, as the members list spells it. */
  to?: string
  /** `sent`: the team server's id for the handoff. */
  handoffId?: string
}

/** How many receipts a session keeps: an agent that writes many files cannot grow the directory without bound. */
export const MAX_RECEIPTS = 100

/** The codes whose detail is system-written (a field name, a rule, workspace paths) and helps the agent. */
const DETAILED = new Set(['FIELD_TYPE', 'TOO_LONG', 'SCHEDULE_INVALID', 'REPEAT_INVALID', 'TARGET_AMBIGUOUS', 'CANCEL_NOT_FOUND'])

/** A session command's refusals whose rule is in the commands rules file, not the introduction. */
const COMMAND_RULE_CODES = new Set(['CONTROL_NOT_ALLOWED', 'CONTROL_TARGET_NOT_FOUND', 'CONTROL_UNAVAILABLE', 'TOO_LONG', 'FIELD_TYPE'])

/**
 * The rules file a refusal points to (`intro-layered-rules` design D5), or null when its rule is in the introduction
 * (or it breaks no rule: no window, a failed command). The code alone cannot tell a rename's `TOO_LONG` from a
 * handoff's: the subject `session-control.ts` puts on every command refusal can.
 */
function rulesFileFor(code: string, subject: string | undefined): string | null {
  const file = code === 'REPEAT_INVALID' ? repeatingFile() : subject === 'command' && COMMAND_RULE_CODES.has(code) ? commandsFile() : ''
  return file || null
}

export function receiptFor(file: string, outcome: SourceOutcome, now: number): Receipt {
  const base = { file: path.basename(file), writtenAt: new Date(now).toISOString() }
  if ('failed' in outcome) return { ...base, status: 'held', code: 'READ_FAILED', reason: receiptReason('READ_FAILED') }
  if (outcome.ok) {
    const idOf = outcome.receiptId ?? outcome.record?.id
    const withId = idOf !== undefined ? { id: idOf } : {}
    if (outcome.duplicate) return { ...base, status: 'duplicate', ...withId }
    // A teammate handoff waits for the user (`teammate-handoff`); later steps rewrite this receipt by its `ref`.
    if (outcome.awaiting) return { ...base, status: 'awaiting-confirmation', ref: outcome.awaiting.ref }
    // A repeating handoff waits for the user's approval (`recurring-handoff`); the agent is not told later whether
    // it was given.
    if (isProposalRecord(outcome.record)) return { ...base, status: 'proposed', ...withId }
    const scheduledAt = outcome.record?.content?.verified.scheduledAt
    if (scheduledAt !== undefined) return { ...base, status: 'scheduled', at: new Date(scheduledAt).toISOString(), ...withId }
    return { ...base, status: 'accepted', ...(outcome.receiptId !== undefined ? { id: outcome.receiptId } : {}) }
  }
  const code = outcome.code ?? 'MALFORMED'
  // A same-content resend changed nothing; it is not a refusal.
  if (code === 'DUPLICATE' && !outcome.notify) {
    return { ...base, status: 'duplicate', ...(outcome.receiptId !== undefined ? { id: outcome.receiptId } : {}) }
  }
  const rules = rulesFileFor(code, outcome.failure?.subject)
  const words = rules ? receiptReasonWithRules(code, rules) : receiptReason(code)
  const reason = DETAILED.has(code) && outcome.detail ? `${words} (${outcome.detail})` : words
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

/**
 * Rewrites a teammate handoff's receipt as its sending proceeds (`teammate-handoff`, design D6). **It never creates
 * the directory**: one that is gone belongs to an ended session, and is not brought back. It writes only over a
 * receipt carrying the same `ref` — a file the agent reused for another delivery keeps that delivery's receipt, and
 * a receipt that is gone (trimmed, or deleted by the agent) is not written again. A `held` receipt with the same
 * code and time is left as it is. Returns whether it wrote.
 */
export function rewriteReceipt(dir: string, receipt: Receipt): boolean {
  const stats = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (!stats?.isDirectory()) return false
  const target = path.join(dir, receipt.file)
  const previous = readReceipt(target)
  if (!previous || previous.ref === undefined || previous.ref !== receipt.ref) return false
  if (previous.status === receipt.status && previous.code === receipt.code && previous.at === receipt.at && receipt.status === 'held') {
    return false
  }
  const tmp = path.join(dir, `.${receipt.file}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, target)
  return true
}
