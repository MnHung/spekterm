import type { IntakeVerified } from './intake-schema'

/**
 * What a record is to a repeating handoff (`recurring-handoff`, design D6). **Read from the record, never from
 * "has a scheduled time"**: an occurrence whose opening failed is pending with no scheduled time, and must not
 * look like a proposal.
 */
export type RecurrenceRole = 'proposal' | 'occurrence'

export function recurrenceRoleOf(verified: Pick<IntakeVerified, 'repeat' | 'recurrenceId'> | undefined): RecurrenceRole | undefined {
  if (verified?.repeat === undefined) return undefined
  return verified.recurrenceId === undefined ? 'proposal' : 'occurrence'
}

export function isProposalRecord(record: { content: { verified: IntakeVerified } | null } | undefined): boolean {
  return recurrenceRoleOf(record?.content?.verified) === 'proposal'
}

/**
 * Which inbox tab a triggered notification opens (`recurring-handoff`, design D6): the Schedules tab when every item
 * it stands for is a proposal — judged by content, not state, since the user may have dealt with it already —
 * otherwise the items tab. A merged batch with a failure carries no keys and opens the items tab.
 */
export function notificationTab(
  keys: readonly { adapter: string; id: string }[],
  get: (adapter: string, id: string) => { content: { verified: IntakeVerified } | null } | undefined,
): 'inbox' | 'schedules' {
  return keys.length > 0 && keys.every((key) => isProposalRecord(get(key.adapter, key.id))) ? 'schedules' : 'inbox'
}
