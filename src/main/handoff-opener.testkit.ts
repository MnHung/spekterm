import { HandoffOpener, type HandoffOpenerDeps } from './handoff-opener'
import type { TargetCandidate } from './handoff-target'

/**
 * Tests only: the opener a `HandoffService` test needs for `onDelivered`, with a window that can always receive
 * and opening requests recorded — so the service's tests keep asserting "a session was requested".
 */
export function testOpener(
  service: HandoffOpenerDeps['service'],
  candidates: () => TargetCandidate[],
  onOpen: (adapter: string, id: string, folderId: string) => void,
  options: {
    eventsEnabled?: () => boolean
    canReceive?: () => boolean
    now?: () => number
    keeper?: HandoffOpenerDeps['keeper']
  } = {},
): HandoffOpener {
  return new HandoffOpener({
    service,
    candidates,
    agentEventsEnabled: options.eventsEnabled ?? (() => true),
    canReceive: options.canReceive ?? (() => true),
    requestOpen: onOpen,
    changed: () => {},
    ...(options.now ? { now: options.now } : {}),
    ...(options.keeper ? { keeper: options.keeper } : {}),
  })
}
