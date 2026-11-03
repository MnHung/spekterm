import fs from 'node:fs'
import path from 'node:path'

import { MAX_FIELD_LENGTH, MAX_TEAMMATE_BODY_LENGTH, normalizeAuthored } from './intake-schema'
import type { TeamMember } from './team-store'
import { MAX_OUTGOING_WAITING } from './teammate-outbox'

/**
 * The teammates file, `<userData>/handoff/teammates.json` (`teammate-handoff`, design D8).
 *
 * The introduction carries one short paragraph that sends the agent here before it writes a teammate handoff; this
 * file carries **every rule that refuses or holds one**, and the list of teammates. That keeps the introduction's
 * size independent of the team, and keeps text each teammate chose (display names) out of `additionalContext`,
 * where it would sit beside spekterm's own rules: here it is data in a file the agent reads.
 *
 * **Every number comes from the constant the check uses** (`scripts/handoff-intro-source.test.mjs` forbids the
 * literals in this file too): a stated limit that drifted from the applied one is a dead end for the agent.
 *
 * It never holds the device credential, the device id or the server address.
 */

/** A display name as the file states it: normalized, one line, at most the server's 64 code points. */
const MAX_NAME_CODE_POINTS = 64

export interface TeammatesInput {
  /** The user's own handle. */
  you: string
  connected: boolean
  /** When the members were last fetched (epoch ms). */
  fetchedAt?: number
  members: readonly TeamMember[]
}

/** The rules, in the agent's words. English, outside the dictionaries, as the introduction. */
export function teammateRules(): string {
  return [
    'A teammate handoff goes to a person on your team instead of a repo. Write it into your outbox like any handoff, by the same rules (a new file name ending in .json, written atomically), with "to" in place of "target":',
    '{"to": "<handle>", "title": "<one line>", "body": "<the handoff>"}.',
    '"to" together with "target" is rejected, and so is "to" with "at", "repeat" or "until": a teammate handoff cannot be scheduled.',
    '"to" is a handle from "teammates" below, compared case-insensitively. A handle not on the team is rejected, and so is your own ("you").',
    `title: at most ${MAX_FIELD_LENGTH} characters. body: at most ${MAX_TEAMMATE_BODY_LENGTH} characters. Both are counted after invisible and control characters are removed; a longer one is rejected, not shortened.`,
    'Nothing is sent until the user confirms it on the desktop: it waits in the Outgoing tab of their inbox, where they send or discard it. Its text cannot be edited there.',
    `At most ${MAX_OUTGOING_WAITING} wait for confirmation; a further one is held (receipt "held", code OUTGOING_FULL), stays in your outbox, and is read again once one of them is sent or discarded.`,
    'Its receipt first states "awaiting-confirmation", then "sent" (the team server stored it for the teammate - not that they have seen or accepted it), "discarded" (the user discarded it; nothing was sent) or "rejected" (with the code, such as RECIPIENT_UNKNOWN).',
    'While a confirmed one waits to be sent, its receipt is "held" with code NOT_CONNECTED, RATE_LIMITED (with "at", when it is tried again) or RETRYING.',
    'If the user is not on a team, or the Team feature is off, it is rejected with TEAM_UNAVAILABLE; that can succeed later.',
    "Describe what is needed and why, from your side: the teammate's agent works in its own checkout, and cannot see your files or this session.",
  ].join(' ')
}

/** The file's content. The user's own handle is "you", and not listed among the teammates. */
export function teammatesContent(input: TeammatesInput): Record<string, unknown> {
  const own = input.you.toLowerCase()
  return {
    rules: teammateRules(),
    you: input.you,
    connected: input.connected,
    ...(input.fetchedAt !== undefined ? { fetchedAt: new Date(input.fetchedAt).toISOString() } : {}),
    teammates: input.members
      .filter((member) => member.handle.toLowerCase() !== own)
      .map((member) => ({ handle: member.handle, name: displayName(member.displayName) })),
  }
}

function displayName(raw: string): string {
  const flat = normalizeAuthored(raw).replace(/\n+/g, ' ').trim()
  return [...flat].slice(0, MAX_NAME_CODE_POINTS).join('')
}

/**
 * Writes the file whole (a temporary name, then a rename), or removes it when there is no membership or the
 * feature is off (`input` null). Only an actual change is written. Never throws: a file that cannot be written
 * costs the agent the list, and a teammate handoff it writes anyway is still checked.
 */
export function writeTeammatesFile(file: string, input: TeammatesInput | null): void {
  if (!file) return
  try {
    if (input === null) {
      fs.rmSync(file, { force: true })
      return
    }
    const text = `${JSON.stringify(teammatesContent(input), null, 2)}\n`
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
    console.error(`[team] could not write the teammates file: ${String(error)}`)
  }
}
