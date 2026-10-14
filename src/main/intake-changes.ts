import type { IntakeStore } from './intake-store'

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

/** Ignore an item: the desktop's ignore and a device's ignore are this one function. */
export function dismissIntake(store: Pick<IntakeStore, 'setState'>, adapter: string, id: string): void {
  store.setState(adapter, id, 'dismissed')
  notifyIntakeChanged()
}
