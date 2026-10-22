import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { CloseOrigin } from './close-guard'
import type { InstallOutcome, UpdateState } from './update-state'

/**
 * Installing a downloaded update into the AppImage, at the quit (`app-update`; design U4 of `auto-update`).
 *
 * **Copy next to it, then one atomic rename** — there is never a moment when the path the app is started from holds
 * no complete file, and the new image is not run during the install. `electron-updater`'s installer is not used
 * (see `update-installer.ts`).
 *
 * Measured (task 1.1): renaming over the running AppImage leaves the running app unharmed to its exit (it holds the
 * old inode); **`app.relaunch` starts nothing inside an AppImage**, so the restart goes through a detached shell
 * that waits for this process to exit and then `exec`s the new file.
 *
 * All of it is synchronous: it runs in `will-quit`, the last moment the process is sure to have.
 */

export interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

export function fileIdentity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

export type InstallFs = Pick<
  typeof fs,
  | 'statSync'
  | 'copyFileSync'
  | 'chmodSync'
  | 'openSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'rmSync'
  | 'existsSync'
  | 'readdirSync'
>

/**
 * Where the new version goes: the same path when its name carries no version (`install:desktop`'s
 * `Spekterm.AppImage`), else a file named for the new version beside it — the user's versioned naming is kept, as
 * `electron-updater` does.
 */
export function installDestination(appImage: string, version: string): string {
  return /\d+\.\d+\.\d+/.test(path.basename(appImage))
    ? path.join(path.dirname(appImage), `Spekterm-${version}.AppImage`)
    : appImage
}

export function stagingPath(destination: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.installing`)
}

const STAGING = /^\.Spekterm.*\.AppImage\.installing$/

/** Why an install did not happen — a code, worded by the renderer's dictionary (`update.install.*`). */
export type InstallFailure = 'download-missing' | 'appimage-missing' | 'appimage-replaced' | 'copy-failed' | 'replace-failed'

export const INSTALL_FAILURES: readonly InstallFailure[] = [
  'download-missing',
  'appimage-missing',
  'appimage-replaced',
  'copy-failed',
  'replace-failed',
]

export type InstallResult =
  | { readonly ok: true; readonly destination: string }
  | { readonly ok: false; readonly reason: InstallFailure; readonly detail?: string }

function code(error: unknown): string {
  return String((error as NodeJS.ErrnoException | null)?.code ?? 'error')
}

export function installUpdate(input: {
  readonly appImage: string
  /** `$APPIMAGE` as it was when the app started; `null` if it could not be read then. */
  readonly startIdentity: FileIdentity | null
  readonly version: string
  readonly file: string
  readonly fs?: InstallFs
}): InstallResult {
  const io = input.fs ?? fs
  try {
    if (!io.statSync(input.file).isFile()) return { ok: false, reason: 'download-missing' }
  } catch {
    return { ok: false, reason: 'download-missing' }
  }
  let current: fs.Stats
  try {
    current = io.statSync(input.appImage)
  } catch {
    return { ok: false, reason: 'appimage-missing' }
  }
  if (!input.startIdentity || !sameFile(fileIdentity(current), input.startIdentity)) {
    // Someone installed another build meanwhile (`install:desktop`): theirs stays.
    return { ok: false, reason: 'appimage-replaced' }
  }

  const destination = installDestination(input.appImage, input.version)
  const staging = stagingPath(destination)
  try {
    io.copyFileSync(input.file, staging)
    io.chmodSync(staging, current.mode & 0o7777)
    const fd = io.openSync(staging, 'r')
    try {
      io.fsyncSync(fd)
    } finally {
      io.closeSync(fd)
    }
  } catch (error) {
    io.rmSync(staging, { force: true })
    return { ok: false, reason: 'copy-failed', detail: code(error) }
  }
  try {
    io.renameSync(staging, destination)
  } catch (error) {
    io.rmSync(staging, { force: true })
    return { ok: false, reason: 'replace-failed', detail: code(error) }
  }
  if (destination !== input.appImage) {
    // Only now that the new file is in place.
    try {
      io.unlinkSync(input.appImage)
    } catch (error) {
      console.error(`[update] the old AppImage was not removed: ${code(error)}`)
    }
  }
  // ~130 MB that would otherwise stay in the updater cache until the next version's download.
  io.rmSync(input.file, { force: true })
  return { ok: true, destination }
}

/** A staging file a `SIGKILL` left behind (startup). */
export function removeLeftoverStaging(appImage: string, io: InstallFs = fs): void {
  const dir = path.dirname(appImage)
  let names: string[]
  try {
    names = io.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) if (STAGING.test(name)) io.rmSync(path.join(dir, name), { force: true })
}

/** Waits for `$1` to exit, then becomes the new AppImage. */
export const RELAUNCH_SCRIPT = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"'

export type SpawnRelauncher = (target: string) => void

export function shellRelauncher(options: {
  readonly pid: number
  /** Built from `process.env`, never `process.env` itself (`secret-scope.test.mjs`). */
  readonly env: NodeJS.ProcessEnv
  readonly spawn?: typeof spawnProcess
}): SpawnRelauncher {
  const run = options.spawn ?? spawnProcess
  return (target) => {
    const child = run('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'sh', String(options.pid), target], {
      detached: true,
      stdio: 'ignore',
      env: { ...options.env },
    })
    child.on('error', (error) => console.error(`[update] the relaunch did not start: ${String(error)}`))
    child.unref()
  }
}

export interface QuitInstallerDeps {
  readonly appImage: string
  readonly startIdentity: FileIdentity | null
  readonly ready: () => { readonly version: string; readonly file: string } | null
  readonly autoCheck: () => boolean
  readonly state: { update(patch: Partial<Record<keyof UpdateState, unknown>>): void }
  readonly relaunch: SpawnRelauncher
  readonly fs?: InstallFs
}

/**
 * The quit's half of the update: who started the quit, and the one-shot `will-quit` install.
 *
 * Installs when the quit is a restart, or one the user started by closing the window with the automatic check on
 * (`app-update`, "An update not applied by hand is applied at the next quit the user starts"). Never at a quit a
 * signal started, nor at a quit no close of the guard preceded.
 */
export class QuitInstaller {
  #origin: CloseOrigin | null = null
  #done = false

  constructor(private readonly deps: QuitInstallerDeps) {}

  /** From the close guard. The first record wins: a `before-quit` that follows a user's close stays a user's quit. */
  recordOrigin(origin: CloseOrigin): void {
    if (this.#origin === null) this.#origin = origin
  }

  willQuit(): void {
    if (this.#done) return
    this.#done = true
    const origin = this.#origin
    if (origin !== 'restart' && origin !== 'user') return
    if (origin === 'user' && !this.deps.autoCheck()) return
    const ready = this.deps.ready()
    if (!ready) return

    const result = installUpdate({
      appImage: this.deps.appImage,
      startIdentity: this.deps.startIdentity,
      version: ready.version,
      file: ready.file,
      fs: this.deps.fs,
    })
    const outcome: InstallOutcome = result.ok
      ? { version: ready.version, ok: true }
      : { version: ready.version, ok: false, reason: result.reason }
    try {
      this.deps.state.update({ installOutcome: outcome })
    } catch (error) {
      console.error(`[update] the install outcome was not saved: ${String(error)}`)
    }
    if (!result.ok) console.error(`[update] not installed: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`)
    if (origin !== 'restart') return

    const io = this.deps.fs ?? fs
    const target = result.ok ? result.destination : io.existsSync(this.deps.appImage) ? this.deps.appImage : null
    if (target) this.deps.relaunch(target)
  }
}
