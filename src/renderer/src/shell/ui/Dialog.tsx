import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The shared modal frame (`settings-sections` design D8): backdrop, card, title, close control, Esc and focus.
 *
 * - **`role="dialog"` is load-bearing**: navigation shortcuts are suppressed while one exists
 *   (`keyboard-navigation`), and the probes find dialogs by it and by their label.
 * - **Esc stops at the card.** The inbox and the metrics close on a window Escape listener; a key that reached
 *   them would close what is under this dialog too. A field or a confirmation inside consumes Esc first by
 *   stopping it on its own keydown, before it reaches the card.
 * - **Tab is kept inside by a keydown on the card**, never by pulling focus back on `focusin`. A focus pull
 *   would take focus from a layer opened above this one.
 * - Focus moves in on open and goes back to where it was on close: left on `<body>`, the next shortcut that
 *   needs a focused element does nothing.
 */
export function Dialog({
  title,
  onClose,
  cardClassName,
  initialFocus,
  children,
}: {
  title: string
  onClose: () => void
  /** Size and layout of the card; the frame adds the surface. */
  cardClassName: string
  /** The element to focus on open; the first focusable one otherwise. */
  initialFocus?: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const target = initialFocus?.current ?? cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
    // Once per opening: the initial focus is a mount-time choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !cardRef.current) return
    const focusables = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.offsetParent !== null,
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    // `fixed`, not `absolute`: an opener inside a narrow panel would otherwise confine the backdrop to it.
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-scrim px-4 text-sm">
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
        className={`flex flex-col overflow-hidden rounded border border-hairline bg-panel shadow-lg ${cardClassName}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
            className="rounded px-2 py-0.5 text-ink-faint hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
