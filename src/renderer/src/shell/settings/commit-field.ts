/**
 * When a typed value in Settings applies (`settings-sections` design D2), as pure decisions.
 *
 * A typed field applies on Enter or blur, and only if it differs from the stored value. These functions decide
 * what that means for the field's text; the components decide when to ask.
 */
export type CommitDecision<T> =
  /** Nothing to write: the field holds the stored value. */
  | { action: 'none' }
  /** Write this; `null` clears the setting to its default. */
  | { action: 'commit'; value: T | null }
  /** The text is not a value: show the stored one again. */
  | { action: 'reject' }

/**
 * A number field.
 *
 * **`badInput` comes first.** A number input reports `""` for text it cannot parse (`1e`, `--`). Taking that as
 * "empty = default" would silently clear the stored value, so bad input is rejected.
 */
export function decideNumberCommit(input: {
  text: string
  badInput: boolean
  stored: number | null | undefined
  integer: boolean
}): CommitDecision<number> {
  if (input.badInput) return { action: 'reject' }
  const text = input.text.trim()
  const stored = input.stored ?? null
  if (text === '') return stored === null ? { action: 'none' } : { action: 'commit', value: null }
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return { action: 'reject' }
  const value = input.integer ? Math.round(parsed) : parsed
  return value === stored ? { action: 'none' } : { action: 'commit', value }
}

/**
 * A draft field whose current value is shown elsewhere (the Slack endpoint keeps it as the placeholder): an
 * empty draft changes nothing, so clicking in and out never resets a custom value. Its own reset control is
 * the way back to the default.
 */
export function decideDraftCommit(text: string, stored: string | null | undefined): CommitDecision<string> {
  const draft = text.trim()
  if (draft === '' || draft === (stored ?? '')) return { action: 'none' }
  return { action: 'commit', value: draft }
}

/** What a number field shows for its stored value: after Esc, after a write, after a rejection. */
export function textOf(stored: number | null | undefined): string {
  return stored == null ? '' : String(stored)
}
