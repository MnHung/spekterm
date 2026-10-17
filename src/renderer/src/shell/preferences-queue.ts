/**
 * The preferences' write queue (`settings-sections` design D3).
 *
 * **An entry is a function of the last applied preferences, not a call with its arguments already bound.** The
 * font family, size and line height are one write of three values. A size change followed quickly by a family
 * change would otherwise bind the family write to the size from before the first write, and undo it. Running the
 * entries in order does not prevent that; reading the arguments when an entry's turn comes does.
 *
 * A rejected entry reaches only its own caller. The applied value, and so the next entry's input, stay as they
 * were, and the queue goes on.
 */
export interface PreferencesQueue<T> {
  /** Runs `write` after every earlier entry has settled, with the value the last successful write returned. */
  enqueue(write: (applied: T) => Promise<T>): Promise<T>
  /** Replaces the applied value without a write (the first load). */
  reset(value: T): void
}

export function createPreferencesQueue<T>(initial: T, onApplied: (next: T) => void): PreferencesQueue<T> {
  let applied = initial
  let tail: Promise<unknown> = Promise.resolve()

  return {
    enqueue(write) {
      const run = tail.then(async () => {
        const next = await write(applied)
        applied = next
        onApplied(next)
        return next
      })
      // The chain must outlive a rejection; the rejection itself goes to this entry's caller.
      tail = run.catch(() => undefined)
      return run
    },
    reset(value) {
      applied = value
    },
  }
}
