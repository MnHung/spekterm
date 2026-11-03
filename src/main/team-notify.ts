import { t } from '@shared/i18n'

import { type NotifyBackend, reduceForNotification } from './intake-notify'
import type { StopReason } from './team-outcome'

/**
 * The one notification per stop that needs the user (`team-membership`, design D10). A backend of its own — a backend
 * holds one activation handler, and the intake's opens the inbox — with the probe's stub under the same gate. The
 * team's name is server-supplied text, so it is reduced like any third-party field before it reaches the desktop's
 * notification service (`agent-intake`).
 */
export function createTeamNotifier(options: {
  readonly backend: NotifyBackend
  /** Bring the window forward and open Settings on Team. */
  readonly onActivate: () => void
}): (reason: StopReason, teamName: string) => void {
  options.backend.onActivate(() => options.onActivate())
  return (reason, teamName) => {
    if (!options.backend.usable()) return
    const team = reduceForNotification(teamName)
    options.backend.present({ title: t('team.notify.title', { team }), body: t(`team.notify.${reason}`) }, [])
  }
}
