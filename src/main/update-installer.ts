import fs from 'node:fs'
import path from 'node:path'

import { AppImageUpdater } from 'electron-updater'

import { type CheckAnswer, type InstallingBackend, UpdateFailureError, type UpdateFailure } from './update-coordinator'

/**
 * The installing backend (`auto-update`, design U1): the only module that imports `electron-updater`.
 *
 * **It checks, downloads and verifies — it never installs.** `install()` and `quitAndInstall()` are not called
 * from here or anywhere (`update-installer.test.ts` reads this file to keep it so). Their installer deletes the
 * AppImage before moving the new one in, keeps a stale file path after it empties its cache for a newer version,
 * and installs at every quit with exit code 0, a logout included (measured: `SIGTERM` quits with 0).
 * `update-install.ts` installs instead, by copy and atomic rename.
 */

export interface BackendChoiceInput {
  readonly platform: NodeJS.Platform
  /** `app.isPackaged`, or a probe's feed (`update-feed.ts`), which stands in for it. */
  readonly eligible: boolean
  /** `process.env.APPIMAGE` — set by the AppImage runtime for the image it starts. */
  readonly appImage: string | undefined
  /** `process.env.APPDIR` — `appimage_extracted_*` for `--appimage-extract-and-run`. */
  readonly appDir: string | undefined
  readonly fs?: Pick<typeof fs, 'statSync' | 'accessSync'>
}

export type BackendChoice =
  | { readonly kind: 'installing'; readonly appImage: string }
  | { readonly kind: 'telling'; readonly why: string }

/**
 * Whether this build can replace its own file (`app-update`, "A Linux AppImage that can be replaced downloads the
 * update in the background"). Anything that is not certain to succeed only tells.
 */
export function chooseUpdateBackend(input: BackendChoiceInput): BackendChoice {
  const io = input.fs ?? fs
  if (input.platform !== 'linux') return { kind: 'telling', why: `platform ${input.platform}` }
  if (!input.eligible) return { kind: 'telling', why: 'not packaged' }
  const appImage = input.appImage
  if (!appImage || !path.isAbsolute(appImage) || appImage.includes('\0')) {
    return { kind: 'telling', why: 'not started from an AppImage' }
  }
  if (input.appDir && path.basename(input.appDir).startsWith('appimage_extracted_')) {
    // The runtime removes the flag from argv; the extracted directory's name is the only sign of it.
    return { kind: 'telling', why: 'started with --appimage-extract-and-run' }
  }
  try {
    if (!io.statSync(appImage).isFile()) return { kind: 'telling', why: 'the AppImage is not a regular file' }
    io.accessSync(path.dirname(appImage), fs.constants.W_OK)
  } catch {
    return { kind: 'telling', why: 'the AppImage or its directory cannot be written' }
  }
  return { kind: 'installing', appImage }
}

/** An error from `electron-updater`, in our words (measured codes: task 1.3 of `auto-update`). */
export function updaterFailure(error: unknown): UpdateFailure {
  const code = (error as { code?: unknown } | null)?.code
  const status = (error as { statusCode?: unknown } | null)?.statusCode
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ERR_CHECKSUM_MISMATCH') return 'checksum'
  if (status === 403 || status === 429) return 'rate-limited'
  // A refused connection carries no code, only Chromium's `net::ERR_*` name in the message.
  if (/net::ERR_/.test(message)) return 'network'
  return 'other'
}

export function isChannelFileMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
}

export interface InstallingBackendOptions {
  /** A probe's `app-update.yml` (unpackaged only); a packaged build reads its own from `resources`. */
  readonly updateConfigPath?: string
}

export function createInstallingBackend(options: InstallingBackendOptions = {}): InstallingBackend {
  const updater = new AppImageUpdater()
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.autoRunAppAfterInstall = false
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  if (options.updateConfigPath) {
    updater.forceDevUpdateConfig = true
    updater.updateConfigPath = options.updateConfigPath
  }
  updater.logger = {
    info: (message?: unknown) => console.log(`[update] ${String(message)}`),
    warn: (message?: unknown) => console.warn(`[update] ${String(message)}`),
    error: (message?: unknown) => console.error(`[update] ${String(message).slice(0, 500)}`),
  }
  // Every failure arrives twice, as an `error` event and as a rejection (measured). The rejection is the one
  // reported; the listener only keeps an unheard `error` event from throwing.
  updater.on('error', () => {})

  return {
    kind: 'installing',
    async check(): Promise<CheckAnswer> {
      let result
      try {
        result = await updater.checkForUpdates()
      } catch (error) {
        if (isChannelFileMissing(error)) return null
        throw new UpdateFailureError(updaterFailure(error), errorText(error))
      }
      if (!result) throw new UpdateFailureError('other', 'the updater is not active')
      return { latest: result.updateInfo.version }
    },
    async download(onProgress): Promise<string> {
      let downloaded: string | null = null
      const progress = (info: { percent: number }): void => onProgress(info.percent)
      const done = (info: { downloadedFile: string }): void => {
        downloaded = info.downloadedFile
      }
      updater.on('download-progress', progress)
      updater.on('update-downloaded', done)
      try {
        const files = await updater.downloadUpdate()
        const file = downloaded ?? files[0]
        if (typeof file !== 'string' || !path.isAbsolute(file)) {
          throw new UpdateFailureError('other', 'the download reported no file')
        }
        return file
      } catch (error) {
        if (error instanceof UpdateFailureError) throw error
        throw new UpdateFailureError(updaterFailure(error), errorText(error))
      } finally {
        updater.off('download-progress', progress)
        updater.off('update-downloaded', done)
      }
    },
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
