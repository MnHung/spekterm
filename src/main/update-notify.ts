import { t } from '@shared/i18n'

import type { NotifyBackend } from './intake-notify'

/**
 * The one notification per version (`app-update`, "The user is told once per version"; design U7).
 *
 * The coordinator decides that a version is announced, once; this only says it. It has a backend of its own — the
 * real one in a packaged build, the stub under the probes' gate, as the intake's — because a backend holds one
 * activation handler, and the intake's opens the inbox. Its text is ours (a version that passed `parseVersion`).
 */
export function createUpdateNotifier(options: {
  readonly backend: NotifyBackend
  /** Bring the window forward and open Settings at About. */
  readonly onActivate: () => void
}): (event: { readonly kind: 'ready' | 'available'; readonly version: string }) => void {
  options.backend.onActivate(() => options.onActivate())
  return (event) => {
    if (!options.backend.usable()) return
    const values = { version: event.version }
    options.backend.present(
      event.kind === 'ready'
        ? { title: t('update.notifyReadyTitle', values), body: t('update.notifyReadyBody') }
        : { title: t('update.notifyAvailableTitle', values), body: t('update.notifyAvailableBody') },
      [],
    )
  }
}
