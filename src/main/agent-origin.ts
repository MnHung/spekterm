import fs from 'node:fs'
import path from 'node:path'

import { type InjectionContribution, shellQuote } from './agent-injection'
import { phoneOriginNote } from './agent-protocol-copy'

/**
 * Telling the agent that a prompt came from the user's phone (`remote-phone-context`, part A).
 *
 * ## How
 *
 * The note reaches the agent as **hook context of that one prompt**, never as text added to the message: the
 * message the agent records, both conversation views and a device's `r.text` stay what was typed. Measured
 * (CLI 2.1.304, `docs/lessons/transcript.md`): a `UserPromptSubmit` hook's `additionalContext` reaches the agent,
 * also for a message queued while it works and for a slash command, and is recorded as an `attachment` of subtype
 * `hook_additional_context` — a shape the conversation projection does not show.
 *
 * The hook command is the same for every prompt, so the desktop **arms a mark** in a file of the session just
 * before it writes a device's submit key, and the command **takes** it: renames it (atomic, so one submission at
 * most), reads its deadline, removes it, and prints the note only before the deadline. A mark nobody takes — a key
 * that did not take, a submission the agent does not report — lapses after `ORIGIN_TTL_S`, so it cannot mark a
 * desktop prompt much later.
 *
 * ## The command's two rules
 *
 * - **It always exits 0.** A `UserPromptSubmit` hook exiting 2 blocks the user's prompt; any other non-zero exit
 *   shows an error. An unreadable mark is no mark.
 * - **It prints nothing without a mark.** The agent adds whatever such a hook prints to the prompt.
 */

/** How long an armed mark waits for a submission to take it. */
export const ORIGIN_TTL_S = 10

/** The pty environment variable naming a session's mark. */
export const ORIGIN_FILE_ENV = 'SPEKTERM_ORIGIN_FILE'

let originRoot: string | null = null

export function configureAgentOrigin(userDataPath: string): void {
  originRoot = path.join(userDataPath, 'agent-origin')
}

function markPath(sessionId: string): string | null {
  return originRoot ? path.join(originRoot, sessionId) : null
}

/** The note as the hook prints it: hook context, not plain text (the documented, structured form). */
export function originNoteJson(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: phoneOriginNote() },
  })
}

/**
 * The hook command. **The whole `if…fi` is one string**: split across `; `-joined elements, `then` is followed by
 * a `;` — a syntax error that fails on every run, silently (`docs/lessons/transcript.md`).
 */
export const ORIGIN_COMMAND =
  'cat >/dev/null; ' +
  `if [ -n "$${ORIGIN_FILE_ENV}" ] && mv "$${ORIGIN_FILE_ENV}" "$${ORIGIN_FILE_ENV}.$$" 2>/dev/null; then ` +
  `d=$(cat "$${ORIGIN_FILE_ENV}.$$" 2>/dev/null); rm -f "$${ORIGIN_FILE_ENV}.$$"; ` +
  `if [ "$(date +%s)" -le "\${d:-0}" ] 2>/dev/null; then printf %s ${shellQuote(originNoteJson())}; fi; ` +
  'fi; exit 0'

/**
 * The contribution for one agent session; `null` = not taking part. `enabled` is the agent-events preference: a
 * device can only reply when the wait state is known.
 */
export function prepareOriginInjection(sessionId: string, enabled: boolean): InjectionContribution | null {
  if (!enabled || !originRoot) return null
  const target = markPath(sessionId)
  if (!target) return null
  try {
    fs.mkdirSync(originRoot, { recursive: true })
    // A mark left by an earlier process of this session must not mark the new one's first prompt.
    clearOrigin(sessionId)
  } catch {
    return null
  }
  return { settings: {}, hooks: { UserPromptSubmit: [ORIGIN_COMMAND] }, env: { [ORIGIN_FILE_ENV]: target } }
}

/**
 * Arms the session's mark: the next submission the agent reports within `ORIGIN_TTL_S` carries the note. Call it
 * immediately before a device's submit key. `false` when it could not be written — then there is simply no note.
 */
export function armOrigin(sessionId: string, now: number = Date.now()): boolean {
  const target = markPath(sessionId)
  if (!target) return false
  const temporary = `${target}.arming`
  try {
    fs.writeFileSync(temporary, String(Math.floor(now / 1000) + ORIGIN_TTL_S), 'utf8')
    fs.renameSync(temporary, target)
    return true
  } catch {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // Nothing to do: the next arm or the session's end tries again.
    }
    return false
  }
}

/** Removes the session's mark and whatever a hook killed between its `mv` and its `rm` left (`<id>.<pid>`). */
export function clearOrigin(sessionId: string): void {
  const target = markPath(sessionId)
  if (!target || !originRoot) return
  try {
    const prefix = `${sessionId}.`
    for (const name of fs.readdirSync(originRoot)) {
      if (name === sessionId || name.startsWith(prefix)) fs.rmSync(path.join(originRoot, name), { force: true })
    }
  } catch {
    // A missing directory has no mark.
  }
}
