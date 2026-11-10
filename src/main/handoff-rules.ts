import fs from 'node:fs'
import path from 'node:path'

import { MAX_REPEAT_SEARCH_YEARS } from './cron'
import { commandsFile, repeatingFile } from './handoff-outbox'
import { MAX_FIELD_LENGTH } from './intake-schema'

/**
 * The repeating and commands rules files (`intro-layered-rules`, design D1/D2).
 *
 * The introduction carries, for each of these rarer actions, one sentence that it exists and where its rules are;
 * these files carry **every rule that refuses or delays it**. That keeps the introduction far below the CLI's
 * injected-context cuts (`docs/lessons/handoff.md` §16) as capabilities are added, the way the teammates and schedules
 * files already do. A rule here counts as stated because the introduction sends the agent here before the only action
 * it constrains (`agent-handoff-source`); a refusal under one of these rules names the file in its receipt.
 *
 * **Every number comes from the constant the check uses** (`scripts/handoff-intro-source.test.mjs` forbids the
 * literals in this file). The year bound is a single digit, so no string here may contain that digit at all.
 *
 * English, outside the dictionaries, as the introduction: the reader is an agent.
 */

/** The repeating rules: everything about `repeat` and `until` beyond "it exists and the user approves it". */
export function repeatingRules(timeZone?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  return [
    'A repeating handoff is a handoff with "repeat" added (and optionally "until"), written into your outbox by the same rules as any handoff (a new file name ending in .json, written atomically):',
    '{"target": "<repo>", "title": "<one line>", "body": "<the handoff>", "repeat": "<cron>", "at": "<optional start>", "until": "<optional end>"}.',
    `repeat: cron "minute hour day month weekday" in ${zone}, e.g. "0 21 * * 3" (Wed 21:00). "at" is its start and "until" its end, both optional; "until" has the format of "at" and no day bound.`,
    'Fields: * or a list of n, a-b, */s, a-b/s; JAN-DEC, SUN-SAT; weekday 0 or 7 is Sunday; day and weekday both set: either matches.',
    `Rejected (receipt "rejected", code REPEAT_INVALID): a minute that is not one number, seconds, @macros, L W # ?, a schedule with no time in ${MAX_REPEAT_SEARCH_YEARS} years; "until" without "repeat", "until" not after now and the start, or with no time before it.`,
    'The user approves it first (receipt "proposed"; you are not told whether it is given); then each time opens a new session until it ends or is stopped.',
    'It opens only while spekterm runs; times missed while spekterm was closed run once at the next start.',
    'To change or stop one later, use the schedules file your introduction names.',
  ].join(' ')
}

/**
 * The commands rules: which sessions a command may name, when it takes effect, what cancels it, the rename limit,
 * the wake's follow-up, and what its receipt means (`agent-session-control`). Stated for a session with a relations
 * file: every claude session that gets an introduction has one (`handoff-injection.ts`).
 */
export function commandRules(): string {
  return [
    'A session command is a JSON file written into your outbox by the same rules as a handoff (a new file name ending in .json, written atomically):',
    '{"kind": "close"}, {"kind": "hibernate"}, {"kind": "rename", "name": "<new label>"} or {"kind": "wake", "target": "<name>"}.',
    'With no "target" a command acts on your own session. "target": "<name>" takes a name from your relations file: close, hibernate and rename only one in your "children" tree; wake also your parent and siblings.',
    'A name that matches no session is refused (CONTROL_TARGET_NOT_FOUND); any other session is refused (CONTROL_NOT_ALLOWED).',
    'Close removes the session. Hibernate ends its process but keeps it, dormant. Wake starts a dormant one at once, without asking the user.',
    "Close and hibernate wait for the target's turn to end (so make one on yourself your last action), and are dropped if the user types into it first.",
    'Close and hibernate of a running target need agent event reporting on; with it off they are refused (CONTROL_UNAVAILABLE), and can succeed once the user turns it on.',
    'Closing your own session only offers the user to close or keep it, once your reply ends.',
    `Rename takes effect at once and changes only the label. "name" is at most ${MAX_FIELD_LENGTH} characters, on one line; a longer one is refused (TOO_LONG). An empty name gives naming back to the terminal title. No name used for messaging changes.`,
    'A woken session can be messaged once your relations file shows it "running": true and its name shows in ListAgents.',
    'Do not wake a parent only to report: a report needs no running parent. Not running a minute after an accepted wake: it was put back to sleep; ask the user before waking it again.',
    'A receipt says a command was accepted, not that it was carried out. Your relations file shows the result: a closed session is gone, a hibernated one has "running": false, a renamed one the new "title".',
  ].join(' ')
}

/**
 * Writes one rules file whole (a temporary name, then a rename), only when the content on disk differs, so a deleted
 * file comes back at the next write point. Never throws: a file that cannot be written costs the agent the rules,
 * and a delivery it writes anyway is still checked, its receipt naming this file.
 */
export function writeRulesFile(file: string, rules: string): void {
  if (!file) return
  try {
    const text = `${JSON.stringify({ rules }, null, 2)}\n`
    let previous: string | null = null
    try {
      previous = fs.readFileSync(file, 'utf8')
    } catch {
      // Not there yet.
    }
    if (previous === text) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    console.error(`[handoff] a rules file could not be written: ${String(error)}`)
  }
}

/** Both rules files, at their locations under the handoff root. Called at startup and at every intro write point. */
export function writeHandoffRules(timeZone?: string): void {
  writeRulesFile(repeatingFile(), repeatingRules(timeZone))
  writeRulesFile(commandsFile(), commandRules())
}
