import { t } from '@shared/i18n'

/**
 * The agent in this session asked to close it, and its turn ended (`agent-session-control` D12).
 *
 * **Nothing closes until the user says so**: the agent's last reply may be what matters most, and a close at the
 * end of its turn would take it away the moment it appears. So the content stays readable underneath: the card's
 * container lets every pointer event through (selection, scrolling) and only the two buttons take them. It takes
 * no focus, so the user keeps typing where they were — and typing into this session withdraws the offer.
 *
 * **Not `role="dialog"`**: that role suppresses the keyboard shortcuts while it exists, and this card is not
 * modal.
 */
export function CloseOffer({ onClose, onKeep }: { onClose: () => void; onKeep: () => void }): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={t('sessions.closeOffer.label')}
      className="pointer-events-none flex max-w-[80%] flex-wrap items-center justify-center gap-2 rounded border border-hairline bg-shell/95 px-4 py-2 text-center text-2xs text-ink shadow"
    >
      <span>{t('sessions.closeOffer.text')}</span>
      <button
        type="button"
        onClick={onClose}
        className="pointer-events-auto shrink-0 cursor-pointer rounded border border-hairline bg-panel px-3 py-1 text-xs text-ink hover:bg-hover focus:outline focus:outline-2 focus:outline-accent"
      >
        {t('sessions.closeOffer.close')}
      </button>
      <button
        type="button"
        onClick={onKeep}
        className="pointer-events-auto shrink-0 cursor-pointer rounded border border-hairline px-3 py-1 text-xs text-ink-faint hover:bg-hover focus:outline focus:outline-2 focus:outline-accent"
      >
        {t('sessions.closeOffer.keep')}
      </button>
    </div>
  )
}
