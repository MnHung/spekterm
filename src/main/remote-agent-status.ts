import type { AgentStatus } from './agent-status'

/**
 * The model and usage a device receives for the conversation it watches (`remote-phone-context`, part B;
 * `docs/remote-protocol.md`, `conversation.status`).
 *
 * ## An event of the watch, not a field of the session list
 *
 * Context and cost change with every API call. A session list field would resend the whole list to every device
 * several times a turn, and the desktop would have to poll every running session's payload to notice. The status
 * bar settled the same trade-off: one session, the one being looked at — here the watched conversation.
 *
 * ## Field by field
 *
 * Each value is copied by name from `readAgentStatus`, itself a field-by-field reader of the agent's payload, so a
 * field the payload gains later (the payload carries `cwd`, `transcript_path`, `scratchpad_dir`, `session_id`…)
 * reaches a device only once it is named here and in the protocol document.
 */

export interface UsageWindow {
  percent: number
  /** Epoch milliseconds, as `scheduledAt`; the payload's seconds × 1000. */
  resetsAt?: number
}

export interface UsageView {
  sessionId: string
  model?: string
  effort?: string
  context?: { percent?: number; size?: number }
  costUsd?: number
  rateLimits?: { fiveHour?: UsageWindow; sevenDay?: UsageWindow }
}

const TEXT_MAX = 80

function text(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
  return cleaned === '' ? undefined : cleaned
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageWindow(percent: number | undefined, resetsAt: number | undefined): UsageWindow | undefined {
  const p = finite(percent)
  if (p === undefined) return undefined
  const at = finite(resetsAt)
  // The status bar treats a reset time that is not positive as absent; a client would show 1970.
  return at !== undefined && at > 0 ? { percent: p, resetsAt: at * 1000 } : { percent: p }
}

/** Builds the view; every value absent when the agent did not report it. */
export function usageView(sessionId: string, status: AgentStatus | undefined): UsageView {
  const view: UsageView = { sessionId }
  if (!status) return view
  const model = text(status.model)
  if (model) view.model = model
  const effort = text(status.effort)
  if (effort) view.effort = effort
  const percent = finite(status.contextPercent)
  const size = finite(status.contextSize)
  if (percent !== undefined || size !== undefined) {
    view.context = {}
    if (percent !== undefined) view.context.percent = percent
    if (size !== undefined) view.context.size = size
  }
  const cost = finite(status.costUsd)
  if (cost !== undefined) view.costUsd = cost
  const fiveHour = usageWindow(status.fiveHourPercent, status.fiveHourResetsAt)
  const sevenDay = usageWindow(status.sevenDayPercent, status.sevenDayResetsAt)
  if (fiveHour || sevenDay) {
    view.rateLimits = {}
    if (fiveHour) view.rateLimits.fiveHour = fiveHour
    if (sevenDay) view.rateLimits.sevenDay = sevenDay
  }
  return view
}

/** How often a watch reads its session's payload: the status bar's tick. */
export const USAGE_POLL_MS = 2_000

export interface UsageTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const REAL_TIMERS: UsageTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
}

/**
 * Polls one session's payload for one watch: sends the view at once (possibly the session id alone), then again
 * whenever it differs from the last one sent. An unreadable payload is "nothing reported", and the poll goes on — a
 * new session's first report comes later. **Only `stop()` stops it.**
 */
export function watchUsage(
  sessionId: string,
  read: (sessionId: string) => AgentStatus | undefined,
  send: (view: UsageView) => void,
  every: number = USAGE_POLL_MS,
  timers: UsageTimers = REAL_TIMERS,
): { stop(): void } {
  let last: string | null = null
  const tick = () => {
    const view = usageView(sessionId, read(sessionId))
    const encoded = JSON.stringify(view)
    if (encoded === last) return
    last = encoded
    send(view)
  }
  tick()
  const handle = timers.setInterval(tick, every)
  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      timers.clearInterval(handle)
    },
  }
}
