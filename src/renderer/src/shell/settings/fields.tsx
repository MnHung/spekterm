import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { decideNumberCommit, textOf } from './commit-field'

export const INPUT_CLASS =
  'mt-1 rounded border border-hairline bg-stage px-2 py-1 font-mono text-sm text-ink outline-none focus:border-accent'
export const BUTTON_CLASS =
  'rounded border border-hairline px-2 py-[3px] text-xs hover:bg-stage focus:outline-none focus-visible:ring-1 focus-visible:ring-accent'
export const LABEL_CLASS = 'mt-4 block text-xs text-ink-faint first:mt-0'
export const HINT_CLASS = 'mt-1 text-xs text-ink-faint'

/** A write's failure, next to its field (`settings-sections` D4). The text is the dictionary's, never the error's. */
export function FieldError({ message }: { message: string | null }): React.JSX.Element | null {
  if (message === null) return null
  return (
    <p role="alert" className="mt-1 text-xs text-danger">
      {message}
    </p>
  )
}

/**
 * Runs a write and turns its failure into the dictionary's message; the cause goes to the console only, since
 * it is English and can carry the user-data path.
 */
export function useWrite(): {
  failure: string | null
  run: (write: () => Promise<unknown>) => Promise<boolean>
} {
  const { t } = useTranslation()
  const [failure, setFailure] = useState<string | null>(null)
  const run = async (write: () => Promise<unknown>): Promise<boolean> => {
    try {
      await write()
      setFailure(null)
      return true
    } catch (error) {
      console.error(`[settings] a write failed: ${String(error)}`)
      setFailure(t('settings.writeFailed'))
      return false
    }
  }
  return { failure, run }
}

/**
 * The text of a typed field, following its stored value: a value that changed elsewhere (a restore, a clamp, a
 * failed write) replaces what the field shows. Adjusted during render, in the owner's own state, so a parent
 * that previews the text (the font preview) holds it without being updated from a child's render.
 */
export function useFieldText(stored: number | null | undefined): [string, (next: string) => void] {
  const [text, setText] = useState(textOf(stored))
  const [shownStored, setShownStored] = useState(stored)
  if (shownStored !== stored) {
    setShownStored(stored)
    setText(textOf(stored))
  }
  return [text, setText]
}

/**
 * A number field that applies on Enter or blur (`settings-sections` D2). Its text belongs to the caller
 * (`useFieldText`), so a preview can read it before it applies.
 *
 * - **Esc with an unapplied edit restores the stored value and stops there**, so it does not also close Settings.
 * - **`badInput` is read before the value**: a number input reports `""` for text it cannot parse, and taking that
 *   as "empty = default" would clear the stored value.
 */
export function NumberField({
  id,
  label,
  text,
  onText,
  stored,
  integer,
  min,
  max,
  step,
  placeholder,
  onCommit,
}: {
  id: string
  label: string
  text: string
  onText: (next: string) => void
  stored: number | null | undefined
  integer: boolean
  min: number
  max: number
  step?: number
  placeholder: string
  onCommit: (value: number | null) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { failure, run } = useWrite()
  const [invalid, setInvalid] = useState(false)

  const commit = (input: HTMLInputElement): void => {
    const decision = decideNumberCommit({ text: input.value, badInput: input.validity.badInput, stored, integer })
    if (decision.action === 'reject') {
      setInvalid(true)
      onText(textOf(stored))
      return
    }
    setInvalid(false)
    if (decision.action === 'none') return
    void run(() => onCommit(decision.value)).then((ok) => {
      if (!ok) onText(textOf(stored))
    })
  }

  return (
    <>
      <label className={LABEL_CLASS} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={text}
        aria-label={label}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onText(event.target.value)}
        onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget)
          // Read the element, not the `text` state: a write that has just applied resets that state a frame later,
          // and an edit typed in between would otherwise let Esc fall through and close Settings.
          const element = event.currentTarget
          if (event.key === 'Escape' && (element.value !== textOf(stored) || element.validity.badInput)) {
            event.stopPropagation()
            setInvalid(false)
            onText(textOf(stored))
            // A number input keeps unparseable text out of `value`; clearing the element resets it too.
            element.value = textOf(stored)
          }
        }}
        className={`${INPUT_CLASS} block w-24`}
      />
      <FieldError message={invalid ? t('settings.invalidNumber') : failure} />
    </>
  )
}

/**
 * Restore a section's defaults, after a confirmation in place (`settings-sections` D5). Esc while it asks cancels
 * the question and stops there.
 */
export function RestoreDefaults({ onRestore }: { onRestore: () => Promise<unknown> }): React.JSX.Element {
  const { t } = useTranslation()
  const [asking, setAsking] = useState(false)
  const { failure, run } = useWrite()
  return (
    <div
      className="mt-6 border-t border-hairline pt-3"
      onKeyDown={(event) => {
        if (asking && event.key === 'Escape') {
          event.stopPropagation()
          setAsking(false)
        }
      }}
    >
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-ink">{t('settings.restoreConfirm')}</p>
          <button
            type="button"
            autoFocus
            className={`${BUTTON_CLASS} text-danger`}
            onClick={() => {
              setAsking(false)
              void run(onRestore)
            }}
          >
            {t('settings.restore')}
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={() => setAsking(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button type="button" className={`${BUTTON_CLASS} text-ink-faint`} onClick={() => setAsking(true)}>
          {t('settings.restoreDefaults')}
        </button>
      )}
      <FieldError message={failure} />
    </div>
  )
}
