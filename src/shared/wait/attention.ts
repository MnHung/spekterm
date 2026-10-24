import type { WaitValue } from '../lineage/lifecycle'

/**
 * Whether a running agent session needs the user (`session-wait-indicator`) — the one derivation the status dot,
 * the rail item dot and the main process's projection share.
 *
 * - `choice`: the agent waits on a choice nobody has answered.
 * - `waiting`: the agent is not in a turn, and its last turn end has not been looked at.
 * - `working`: the agent reports work within a turn in progress.
 * - `idle`: the agent is not in a turn, and its last turn end has been looked at (or none happened since it started).
 * - `unknown`: the wait state is unknown — it cannot claim to be anything else.
 */
export type Attention = 'choice' | 'waiting' | 'working' | 'idle' | 'unknown'

export interface AttentionInput {
  wait: WaitValue
  /** A turn is in progress (`inTurnOf`): an own prompt submission, or a keystroke, since the last turn end. */
  inTurn: boolean
  /** The main process's seen mark for the last turn end (`wait-seen.ts`). */
  seen: boolean
  /**
   * Every open request was typed over after its tool started. The agent reports nothing for a denial at the desktop,
   * so a keystroke is the only sign that the user answered it.
   */
  choiceTypedOver: boolean
}

export function attentionOf({ wait, inTurn, seen, choiceTypedOver }: AttentionInput): Attention {
  if (wait === 'unknown') return 'unknown'
  if (wait === 'awaiting-choice' && !choiceTypedOver) return 'choice'
  // A background subagent's tool start can arrive after the turn's end and set the state to busy with no turn in
  // progress: that is not work the user is waiting on, so it reads as the turn-ended row.
  if (wait === 'busy' && inTurn) return 'working'
  return seen ? 'idle' : 'waiting'
}

/** What a rail item ranks: the attention of its running agent sessions and the pty facts of the rest. */
export type RowState = Attention | 'error' | 'running' | 'dormant' | 'ended'

/** The order of urgency of the session states; the rail item dot and the header summary rank by it. */
export const URGENCY: Record<RowState, number> = {
  choice: 0,
  waiting: 0,
  error: 1,
  working: 2,
  running: 3,
  unknown: 3,
  idle: 4,
  dormant: 5,
  ended: 5,
}

/** The most urgent of a rail item's session states, or `null` for an item with no session. The first of a tie wins. */
export function mostUrgent(states: readonly RowState[]): RowState | null {
  let best: RowState | null = null
  for (const state of states) {
    if (best === null || URGENCY[state] < URGENCY[best]) best = state
  }
  return best
}
