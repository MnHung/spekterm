import fs from 'node:fs'
import path from 'node:path'

import { isProposal, isScheduled } from '@shared/intake/scheduled'

import { HANDOFF_ADAPTER } from './handoff-delivery'
import type { IntakeView } from './intake-projection'
import type { RecurrenceListing } from './recurrence-keeper'

/**
 * The schedules file, `<userData>/handoff/schedules.json` (`handoff-cancel`, design D6).
 *
 * It lists what an agent can cancel — the Schedules tab's three groups, from the tab's own predicates and the
 * Repeating section's own listing, so it cannot list what the tab does not — and states the cancel rules. The
 * introduction carries one sentence pointing here, as the teammate paragraph points to the teammates file.
 *
 * **Only handoffs written by the user's own agents**: Slack and teammate items are never listed, so no third-party
 * text reaches it. **No path the system derived** (a folder's path, a recurrence's approved folder); text an agent
 * wrote is written as it is.
 */

/** How much of a body an entry carries: enough to tell two untitled items apart, not the whole body. */
export const SCHEDULE_PREVIEW_CODE_POINTS = 200

/** The rules, in the agent's words. English, outside the dictionaries, as the introduction. */
export function scheduleRules(): string {
  return [
    'This file lists the scheduled and repeating handoffs that can be cancelled now, from any session, and is rewritten whenever that changes.',
    'To cancel one, write {"kind": "cancel", "id": "<id>"} into your outbox, by the outbox rules (a new file name ending in .json, written atomically). Only "id" is read.',
    'What a cancel does: a scheduled handoff never opens; an occurrence of a repeating handoff is skipped, and the next time stays; a proposal is declined; a recurrence stops repeating, with no confirmation, and its upcoming occurrence is removed.',
    'A cancel cannot be undone, and the user sees it listed in the inbox. When you did not write the item yourself, confirm with the user which one you are cancelling before you write it: give its title, target and time.',
    'This file is a snapshot. An item whose opening has begun since is refused (receipt "rejected", code CANCEL_NOT_FOUND); a handoff that was opened is not cancelled - close its session instead.',
    'To change one, write the new handoff first and read its receipt; cancel the old one only after the new one is "accepted" or "scheduled".',
    'A changed repeating handoff is a new proposal the user approves again: stop the old recurrence only once the new one appears under "recurrences" here, and until then tell the user the new one is proposed and the old one still runs.',
    'A cancelled handoff written again with the same content from the same session is a duplicate and nothing happens: change something in it, such as its title.',
    'The cancel\'s receipt states "accepted" once it is done, "duplicate" when the item was already cancelled, or "rejected" with the code and a reason; CANCEL_UNAVAILABLE (the repeating handoffs could not be read) can succeed later.',
    'Times are UTC. "target" is the repo\'s name; "source" is where the item came from.',
  ].join(' ')
}

export interface ScheduleFolder {
  id: string
  name: string
}

export interface SchedulesInput {
  /** The inbox's views (`listView`): the same list the Schedules tab filters. */
  items: readonly IntakeView[]
  recurrences: RecurrenceListing
  /** A recurrence's own text, which its view does not carry: the source label and the body. */
  recurrenceContent: (id: string) => { source: string; body: string } | undefined
  folders: readonly ScheduleFolder[]
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

function preview(body: string): string {
  return [...body].slice(0, SCHEDULE_PREVIEW_CODE_POINTS).join('')
}

/** The last segment of a path, by either separator: a name, never the path. */
function lastSegment(text: string): string {
  const parts = text.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? ''
}

export function schedulesContent(input: SchedulesInput): Record<string, unknown> {
  const nameOf = (folderId: string | undefined): string => input.folders.find((folder) => folder.id === folderId)?.name ?? ''
  const handoffs = input.items.filter((item) => item.adapter === HANDOFF_ADAPTER)

  const proposals = handoffs.filter(isProposal).map((item) => ({
    id: item.id,
    title: item.title,
    target: nameOf(item.folderId),
    repeat: item.recurrence?.repeat ?? '',
    ...(item.recurrence?.next && item.recurrence.next.length > 0 ? { next: item.recurrence.next.map(iso) } : {}),
    ...(item.recurrence?.until !== undefined ? { until: iso(item.recurrence.until) } : {}),
    source: item.originLabel,
    preview: preview(item.body),
  }))

  const scheduled = handoffs
    .filter(isScheduled)
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
    .map((item) => {
      const recurrenceId = item.recurrence?.role === 'occurrence' ? recurrenceIdOf(item.id) : undefined
      return {
        id: item.id,
        title: item.title,
        target: nameOf(item.folderId),
        at: iso(item.scheduledAt ?? 0),
        source: item.originLabel,
        preview: preview(item.body),
        ...(recurrenceId !== undefined ? { recurrenceId } : {}),
      }
    })

  const recurrences = input.recurrences.recurrences.map((view) => {
    const content = input.recurrenceContent(view.id)
    return {
      id: view.id,
      title: view.title,
      target: view.folderId !== undefined ? nameOf(view.folderId) : lastSegment(view.targetText),
      ...(view.folderId === undefined ? { targetGone: true } : {}),
      repeat: view.repeat,
      ...(view.next !== undefined ? { next: iso(view.next) } : {}),
      ...(view.until !== undefined ? { until: iso(view.until) } : {}),
      source: content?.source ?? '',
      preview: preview(content?.body ?? ''),
    }
  })

  return { rules: scheduleRules(), recurrencesAvailable: input.recurrences.available, proposals, scheduled, recurrences }
}

/** An occurrence's id is `<recurrence id>-r<time>` (`occurrenceId`). */
function recurrenceIdOf(occurrenceId: string): string | undefined {
  const at = occurrenceId.lastIndexOf('-r')
  return at > 0 ? occurrenceId.slice(0, at) : undefined
}

/**
 * Writes the file whole (a temporary name, then a rename), only when its content changed. Never throws: a file that
 * cannot be written costs the agent the list, and a cancel by an id from a receipt still works. An empty path (the
 * handoff root not configured yet) is logged, never silent.
 */
export function writeSchedulesFile(file: string, content: Record<string, unknown>): void {
  if (!file) {
    console.error('[handoff] the schedules file has no location yet; it is not written')
    return
  }
  try {
    const text = `${JSON.stringify(content, null, 2)}\n`
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
    console.error(`[handoff] could not write the schedules file: ${String(error)}`)
  }
}
