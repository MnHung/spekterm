import fs from 'node:fs'
import path from 'node:path'

import type { CloseOrigin } from './close-guard'
import type { NotifyBackend } from './intake-notify'
import type { PreferencesStore } from './preferences-store'
import { type UpdateBackend, UpdateCoordinator, UPDATE_FIRST_DELAY_MS, UPDATE_INTERVAL_MS, type UpdateView } from './update-coordinator'
import { readUpdateFeed } from './update-feed'
import { QuitInstaller, fileIdentity, removeLeftoverStaging, shellRelauncher } from './update-install'
import { chooseUpdateBackend, createInstallingBackend } from './update-installer'
import { releaseFetch } from './update-net'
import { createUpdateNotifier } from './update-notify'
import { createTellingBackend } from './update-release-check'
import { UpdateStateStore } from './update-state'

/**
 * Assembles the update check for this run (`auto-update`): which backend, which feed, the state, the notifier and
 * the quit's installer. `index.ts` only wires its outputs to the window, the IPC and the app's events.
 *
 * **An unpackaged build gets nothing** unless a probe's feed is configured, and then only that feed: an unpackaged
 * build without a release-API stand-in has no telling backend rather than one that would ask GitHub.
 */
export interface UpdateRuntime {
  readonly coordinator: UpdateCoordinator
  /** `null` on a build that only tells. */
  readonly quitInstaller: QuitInstaller | null
}

export function startUpdates(options: {
  readonly packaged: boolean
  readonly throwawayProfile: boolean
  readonly userData: string
  readonly version: string
  readonly preferences: PreferencesStore
  readonly notifyBackend: NotifyBackend
  readonly onShowAbout: () => void
  readonly onChange: (view: UpdateView) => void
}): UpdateRuntime | null {
  const feed = readUpdateFeed({ throwawayProfile: options.throwawayProfile, userData: options.userData })
  if (!options.packaged && !feed) return null

  const choice = chooseUpdateBackend({
    platform: process.platform,
    eligible: options.packaged || Boolean(feed?.updateConfigPath),
    appImage: process.env.APPIMAGE,
    appDir: process.env.APPDIR,
  })
  let backend: UpdateBackend
  if (choice.kind === 'installing') {
    backend = createInstallingBackend({ updateConfigPath: options.packaged ? undefined : feed?.updateConfigPath })
  } else if (options.packaged) {
    backend = createTellingBackend({ request: releaseFetch })
  } else if (feed?.releaseApiUrl) {
    backend = createTellingBackend({ request: releaseFetch, url: feed.releaseApiUrl })
  } else {
    return null
  }
  console.log(`[update] ${backend.kind}${choice.kind === 'telling' ? ` (${choice.why})` : ''}`)

  const state = new UpdateStateStore(path.join(options.userData, 'update-state.json'))
  state.load()
  const notify = createUpdateNotifier({ backend: options.notifyBackend, onActivate: options.onShowAbout })
  const coordinator = new UpdateCoordinator({
    backend,
    currentVersion: options.version,
    state,
    autoCheck: () => options.preferences.autoUpdateCheck(),
    notify,
    onChange: options.onChange,
    timers: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      setInterval: (fn, ms) => setInterval(fn, ms).unref(),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    },
    firstDelayMs: feed?.firstDelayMs ?? UPDATE_FIRST_DELAY_MS,
    intervalMs: UPDATE_INTERVAL_MS,
  })

  let quitInstaller: QuitInstaller | null = null
  if (choice.kind === 'installing') {
    const appImage = choice.appImage
    removeLeftoverStaging(appImage)
    let startIdentity = null
    try {
      startIdentity = fileIdentity(fs.statSync(appImage))
    } catch {
      // Unreadable now: `installUpdate` refuses to overwrite a file it could not identify.
    }
    quitInstaller = new QuitInstaller({
      appImage,
      startIdentity,
      ready: () => coordinator.ready(),
      autoCheck: () => options.preferences.autoUpdateCheck(),
      state,
      relaunch: shellRelauncher({ pid: process.pid, env: { ...process.env } }),
    })
  }
  return { coordinator, quitInstaller }
}

export type { CloseOrigin }
