import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../ui/Dialog'
import { useRemoteState } from '../remote/useRemoteState'
import { AboutSection } from './sections/AboutSection'
import { AgentsSection } from './sections/AgentsSection'
import { GeneralSection } from './sections/GeneralSection'
import { IntegrationsSection } from './sections/IntegrationsSection'
import { RemoteSection } from './sections/RemoteSection'
import { TerminalSection } from './sections/TerminalSection'

export const SETTINGS_SECTIONS = ['general', 'terminal', 'agents', 'integrations', 'remote', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const SECTION_LABEL = {
  general: 'settings.sections.general',
  terminal: 'settings.sections.terminal',
  agents: 'settings.sections.agents',
  integrations: 'settings.sections.integrations',
  remote: 'settings.sections.remote',
  about: 'settings.sections.about',
} as const

/**
 * Settings (`terminal-preferences`; `settings-sections` design D1): a fixed-size dialog with a list of sections
 * beside the one shown. Every change applies when it is made; there is no Save and no Cancel (D2).
 *
 * `role="dialog"` with the `settings.title` label comes from the frame, and both are load-bearing: navigation
 * shortcuts are suppressed while a dialog exists (`keyboard-navigation`), and the probes find Settings by them.
 */
export function SettingsDialog({
  initialSection,
  onSectionShown,
  onClose,
  onOpenRoutingRules,
}: {
  /** The section to open on: the last one shown in this run, or the one a route asks for (Remote access). */
  initialSection: SettingsSection
  /** Reports the section shown, so the next opening starts there. The opener keeps it; nothing is stored. */
  onSectionShown: (section: SettingsSection) => void
  onClose: () => void
  /** Closes Settings and opens the inbox on its routing rules (the Integrations hint). */
  onOpenRoutingRules: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const tabRefs = useRef(new Map<SettingsSection, HTMLButtonElement>())
  const initialTab = useRef<HTMLButtonElement | null>(null)
  const remote = useRemoteState()
  // A listener that failed to start marks Remote access in the list: in a section of its own, a failure at
  // startup would otherwise go unseen until the user opens it (`remote-access`).
  const remoteFailed = remote?.enabled === true && remote.listen.status === 'error'

  const show = (next: SettingsSection, focus = false): void => {
    onSectionShown(next)
    setSection(next)
    if (focus) tabRefs.current.get(next)?.focus()
  }

  const onListKeyDown = (event: React.KeyboardEvent): void => {
    const index = SETTINGS_SECTIONS.indexOf(section)
    const last = SETTINGS_SECTIONS.length - 1
    const target =
      event.key === 'ArrowDown'
        ? SETTINGS_SECTIONS[index === last ? 0 : index + 1]
        : event.key === 'ArrowUp'
          ? SETTINGS_SECTIONS[index === 0 ? last : index - 1]
          : event.key === 'Home'
            ? SETTINGS_SECTIONS[0]
            : event.key === 'End'
              ? SETTINGS_SECTIONS[last]
              : null
    if (target === null) return
    event.preventDefault()
    show(target, true)
  }

  return (
    <Dialog
      title={t('settings.title')}
      onClose={onClose}
      initialFocus={initialTab}
      cardClassName="h-[min(600px,calc(100vh-2rem))] w-[min(760px,100%)]"
    >
      <div className="flex min-h-0 flex-1">
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label={t('settings.sections.label')}
          onKeyDown={onListKeyDown}
          className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-hairline bg-shell p-2"
        >
          {SETTINGS_SECTIONS.map((id) => {
            const selected = id === section
            return (
              <button
                key={id}
                ref={(element) => {
                  if (element) tabRefs.current.set(id, element)
                  if (selected) initialTab.current = element
                }}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => show(id)}
                className={
                  'flex items-center justify-between rounded px-2 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ' +
                  (selected ? 'bg-hover text-ink' : 'text-ink-dim hover:bg-hover/60 hover:text-ink')
                }
              >
                {t(SECTION_LABEL[id])}
                {id === 'remote' && remoteFailed ? (
                  <span
                    role="img"
                    aria-label={t('settings.sections.remoteFailed')}
                    title={t('settings.sections.remoteFailed')}
                    className="h-2 w-2 rounded-full bg-danger"
                  />
                ) : null}
              </button>
            )
          })}
        </div>
        <div
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
          className="min-w-0 flex-1 overflow-y-auto p-4"
        >
          <h3 className="mb-3 text-sm font-semibold text-ink">{t(SECTION_LABEL[section])}</h3>
          {section === 'general' ? <GeneralSection /> : null}
          {section === 'terminal' ? <TerminalSection /> : null}
          {section === 'agents' ? <AgentsSection /> : null}
          {section === 'integrations' ? <IntegrationsSection onOpenRoutingRules={onOpenRoutingRules} /> : null}
          {section === 'remote' ? <RemoteSection /> : null}
          {section === 'about' ? <AboutSection /> : null}
        </div>
      </div>
    </Dialog>
  )
}
