import type { CancelledBy, IntakeStore } from './intake-store'

/**
 * The one "the inbox changed" signal (`remote-protocol`'s inbox requirement).
 *
 * Every state change, from the desktop or from a paired device, calls `notifyIntakeChanged()`, and both the
 * desktop's inbox and the remote server listen to it. Before this, each IPC handler called a `broadcast()` in
 * its own closure — a change made anywhere else reached neither side, and `IntakeStore.setState` fires no
 * subscription of its own.
 */

const listeners = new Set<() => void>()

export function onIntakeChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyIntakeChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error(`[intake] change listener failed: ${String(error)}`)
    }
  }
}

const dismissListeners = new Set<(adapter: string, id: string) => void>()

/**
 * Called after an item is ignored, by either side. The recurrence keeper listens: ignoring an occurrence skips one
 * time, and its next occurrence is created at once (`recurring-handoff`). The keeper's own removals go to the
 * store directly, so this does not recurse.
 */
export function onIntakeDismissed(listener: (adapter: string, id: string) => void): () => void {
  dismissListeners.add(listener)
  return () => dismissListeners.delete(listener)
}

/**
 * Ignore an item: the desktop's ignore, a device's ignore and an agent's cancel (`handoff-cancel`) are this one
 * function. `by` marks an agent's cancel, saved with the state.
 */
export function dismissIntake(store: Pick<IntakeStore, 'setState'>, adapter: string, id: string, by?: CancelledBy): void {
  store.setState(adapter, id, 'dismissed', undefined, by)
  for (const listener of [...dismissListeners]) {
    try {
      listener(adapter, id)
    } catch (error) {
      console.error(`[intake] dismiss listener failed: ${String(error)}`)
    }
  }
  notifyIntakeChanged()
}
