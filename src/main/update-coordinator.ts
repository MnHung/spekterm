import { compareVersions, formatVersion, parseVersion, releasePageUrl } from './update-version'
import type { InstallOutcome, UpdateState } from './update-state'

/**
 * The update check's one owner (`app-update`; design U1, U3, U5, U7 of `auto-update`).
 *
 * It decides **when** to check, what a check's answer means, when to download, and when to tell the user. It
 * does not know how a check is made or a file is installed: a backend checks (and, on Linux, downloads), and
 * `update-install.ts` installs at the quit. **No Electron import and no network module**, so every timing and
 * switch rule is unit-tested with a fake clock (`update-coordinator.test.ts`).
 *
 * Rules that are easy to lose:
 *
 * - **No check while an update is ready** — scheduled or "Check now". `electron-updater` empties its cache when it
 *   finds a different version, and the file the quit is about to install would go with it (the review's B1).
 * - **Only a version passes** (U2): an answer that does not parse is a failed check, and nothing is downloaded.
 * - **Off means nothing happens without a click** (U5): the switch gates scheduled checks only; "Check now" checks
 *   and downloads whatever the switch.
 */

/** Why a check or download failed. Ours, short, and a dictionary key in the renderer — never a third party's text. */
export type UpdateFailure = 'network' | 'rate-limited' | 'unexpected-answer' | 'checksum' | 'other'

export class UpdateFailureError extends Error {
  constructor(
    readonly failure: UpdateFailure,
    detail: string,
  ) {
    super(detail)
    this.name = 'UpdateFailureError'
  }
}

/**
 * The latest release's version as the backend read it (not yet parsed), or `null` when the latest release has no
 * update for this platform yet (a release still being assembled — up to date, not a failure).
 */
export type CheckAnswer = { readonly latest: string } | null

export interface InstallingBackend {
  readonly kind: 'installing'
  check(): Promise<CheckAnswer>
  /** Downloads the version the last check found; resolves with the verified file's path. */
  download(onProgress: (percent: number) => void): Promise<string>
}

export interface TellingBackend {
  readonly kind: 'telling'
  check(): Promise<CheckAnswer>
}

export type UpdateBackend = InstallingBackend | TellingBackend

export type UpdateStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'available'; readonly version: string }
  | { readonly kind: 'failed'; readonly failure: UpdateFailure }

/** What the renderer is told. No path and no URL: `openRelease` and `restart` act on the main process's own. */
export interface UpdateView {
  readonly mode: UpdateBackend['kind']
  readonly status: UpdateStatus
  readonly lastCheckedAt: number | null
  /** The outcome of the install the previous run attempted, shown once. */
  readonly lastInstall: InstallOutcome | null
}

export interface UpdateTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface UpdateCoordinatorDeps {
  backend: UpdateBackend
  /** `app.getVersion()`. */
  currentVersion: string
  state: { get(): UpdateState; update(patch: Partial<Record<keyof UpdateState, unknown>>): void }
  /** The automatic check switch, read when it matters (the preferences store is the authority). */
  autoCheck: () => boolean
  notify: (event: { readonly kind: 'ready' | 'available'; readonly version: string }) => void
  onChange: (view: UpdateView) => void
  timers: UpdateTimers
  /** After the first restore-gate opening. The spec's lower bound is one minute. */
  firstDelayMs: number
  intervalMs: number
}

export const UPDATE_FIRST_DELAY_MS = 60_000
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

export class UpdateCoordinator {
  #status: UpdateStatus = { kind: 'idle' }
  #lastCheckedAt: number | null
  readonly #lastInstall: InstallOutcome | null
  #readyFile: string | null = null
  #started = false
  #disposed = false
  #firstTimer: unknown = null
  #intervalTimer: unknown = null
  /** Notified in this run even if persisting `notifiedVersion` failed: once per version, at worst once per run. */
  readonly #notifiedHere = new Set<string>()

  constructor(private readonly deps: UpdateCoordinatorDeps) {
    const state = deps.state.get()
    this.#lastCheckedAt = state.lastCheckedAt ?? null
    this.#lastInstall = state.installOutcome ?? null
    // Shown once: this run keeps it in memory, the file forgets it.
    if (this.#lastInstall) this.#persist({ installOutcome: undefined })
  }

  view(): UpdateView {
    return {
      mode: this.deps.backend.kind,
      status: this.#status,
      lastCheckedAt: this.#lastCheckedAt,
      lastInstall: this.#lastInstall,
    }
  }

  /** The update the quit may install: the version and the verified file. */
  ready(): { readonly version: string; readonly file: string } | null {
    if (this.#status.kind !== 'ready' || this.#readyFile === null) return null
    return { version: this.#status.version, file: this.#readyFile }
  }

  /** The release page of the version shown as ready or available, built from that version (U2). */
  releaseUrl(): string | null {
    const status = this.#status
    if (status.kind !== 'ready' && status.kind !== 'available') return null
    const version = parseVersion(status.version)
    return version ? releasePageUrl(version) : null
  }

  /** The first restore-gate opening. Later openings (a reload, a new window) are ignored. */
  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    this.#scheduleFirst()
    this.#intervalTimer = this.deps.timers.setInterval(() => void this.#scheduledCheck(), this.deps.intervalMs)
  }

  /** The switch was turned on or off. On schedules a check after the first delay; off needs nothing cancelled. */
  autoCheckChanged(): void {
    if (!this.#started || this.#disposed) return
    if (this.deps.autoCheck()) this.#scheduleFirst()
  }

  /** The computer woke up: check if the last check is older than the period. */
  resumed(): void {
    if (!this.#started || this.#disposed) return
    const last = this.#lastCheckedAt
    if (last !== null && this.deps.timers.now() - last < this.deps.intervalMs) return
    void this.#scheduledCheck()
  }

  /** "Check now": whatever the switch; downloads what it finds on an installing build. */
  checkNow(): Promise<void> {
    return this.#run()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#firstTimer !== null) this.deps.timers.clearTimeout(this.#firstTimer)
    if (this.#intervalTimer !== null) this.deps.timers.clearInterval(this.#intervalTimer)
    this.#firstTimer = null
    this.#intervalTimer = null
  }

  #scheduleFirst(): void {
    if (this.#firstTimer !== null) this.deps.timers.clearTimeout(this.#firstTimer)
    this.#firstTimer = this.deps.timers.setTimeout(() => {
      this.#firstTimer = null
      void this.#scheduledCheck()
    }, this.deps.firstDelayMs)
  }

  #scheduledCheck(): Promise<void> {
    if (!this.deps.autoCheck()) return Promise.resolve()
    return this.#run()
  }

  #busy(): boolean {
    const kind = this.#status.kind
    // `ready` counts as busy: no check may run under the file the quit will install.
    return kind === 'checking' || kind === 'downloading' || kind === 'ready'
  }

  async #run(): Promise<void> {
    if (this.#disposed || this.#busy()) return
    this.#set({ kind: 'checking' })
    let answer: CheckAnswer
    try {
      answer = await this.deps.backend.check()
    } catch (error) {
      this.#checked()
      this.#fail(error)
      return
    }
    this.#checked()
    if (answer === null) {
      this.#set({ kind: 'up-to-date' })
      return
    }
    const latest = parseVersion(answer.latest)
    const current = parseVersion(this.deps.currentVersion)
    if (!latest || !current) {
      this.#fail(new UpdateFailureError('unexpected-answer', `not a version: ${String(answer.latest).slice(0, 40)}`))
      return
    }
    if (compareVersions(latest, current) <= 0) {
      this.#set({ kind: 'up-to-date' })
      return
    }
    const version = formatVersion(latest)
    const backend = this.deps.backend
    if (backend.kind === 'telling') {
      this.#set({ kind: 'available', version })
      this.#announce('available', version)
      return
    }
    this.#set({ kind: 'downloading', version, percent: 0 })
    let file: string
    try {
      file = await backend.download((percent) => {
        const rounded = Math.max(0, Math.min(100, Math.floor(percent)))
        const status = this.#status
        if (status.kind === 'downloading' && status.percent !== rounded) {
          this.#set({ kind: 'downloading', version, percent: rounded })
        }
      })
    } catch (error) {
      this.#fail(error)
      return
    }
    this.#readyFile = file
    this.#set({ kind: 'ready', version })
    this.#announce('ready', version)
  }

  #checked(): void {
    this.#lastCheckedAt = this.deps.timers.now()
    this.#persist({ lastCheckedAt: this.#lastCheckedAt })
  }

  #fail(error: unknown): void {
    const failure = error instanceof UpdateFailureError ? error.failure : 'other'
    console.error(`[update] ${failure}: ${error instanceof Error ? error.message : String(error)}`)
    this.#set({ kind: 'failed', failure })
  }

  #announce(kind: 'ready' | 'available', version: string): void {
    if (this.#notifiedHere.has(version) || this.deps.state.get().notifiedVersion === version) return
    this.#notifiedHere.add(version)
    this.#persist({ notifiedVersion: version })
    this.deps.notify({ kind, version })
  }

  #persist(patch: Partial<Record<keyof UpdateState, unknown>>): void {
    try {
      this.deps.state.update(patch)
    } catch (error) {
      console.error(`[update] state not saved: ${String(error)}`)
    }
  }

  #set(status: UpdateStatus): void {
    if (this.#disposed) return
    this.#status = status
    this.deps.onChange(this.view())
  }
}
