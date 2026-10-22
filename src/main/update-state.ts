import fs from 'node:fs'
import path from 'node:path'

import { INSTALL_FAILURES, type InstallFailure } from './update-install'
import { formatVersion, parseVersion } from './update-version'

/**
 * What the updater remembers across restarts (`auto-update`, design U6): `<userData>/update-state.json`.
 *
 * - `notifiedVersion`: the version the user was last notified of, so a version is announced once, ever.
 * - `lastCheckedAt`: shown in About, and the resume rule's "older than the period".
 * - `installOutcome`: written in `will-quit` just before the relaunch, read once by the next start (a failure is
 *   shown in About, then cleared). Hence every write is synchronous.
 *
 * Nothing in it is worth a quarantine: an unreadable or malformed file is an empty state, whose worst effect is
 * one repeated notification. Writes put the file down first and assign after, so a failed write does not keep a
 * value in memory that the next successful write would then persist.
 */

export interface InstallOutcome {
  readonly version: string
  readonly ok: boolean
  /** Why it was not installed; worded by the renderer's dictionary. */
  readonly reason?: InstallFailure
}

export interface UpdateState {
  readonly notifiedVersion?: string
  readonly lastCheckedAt?: number
  readonly installOutcome?: InstallOutcome
}

function sanitizeVersion(value: unknown): string | undefined {
  const version = parseVersion(value)
  return version ? formatVersion(version) : undefined
}

function sanitizeOutcome(value: unknown): InstallOutcome | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const version = sanitizeVersion(source.version)
  if (!version || typeof source.ok !== 'boolean') return undefined
  const reason = INSTALL_FAILURES.find((known) => known === source.reason)
  return reason ? { version, ok: source.ok, reason } : { version, ok: source.ok }
}

export function parseUpdateState(raw: string): UpdateState {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const state: { -readonly [K in keyof UpdateState]: UpdateState[K] } = {}
  const notifiedVersion = sanitizeVersion(source.notifiedVersion)
  if (notifiedVersion) state.notifiedVersion = notifiedVersion
  if (typeof source.lastCheckedAt === 'number' && Number.isFinite(source.lastCheckedAt) && source.lastCheckedAt > 0) {
    state.lastCheckedAt = source.lastCheckedAt
  }
  const installOutcome = sanitizeOutcome(source.installOutcome)
  if (installOutcome) state.installOutcome = installOutcome
  return state
}

export class UpdateStateStore {
  #state: UpdateState = {}

  constructor(private readonly filePath: string) {}

  load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[update] state unreadable, starting empty: ${String(error)}`)
      }
      this.#state = {}
      return
    }
    this.#state = parseUpdateState(raw)
  }

  get(): UpdateState {
    return this.#state
  }

  /**
   * Merge `patch` (an `undefined` value removes the field) and persist, synchronously. Throws when the write
   * fails, and the state in memory is then unchanged.
   */
  update(patch: Partial<Record<keyof UpdateState, UpdateState[keyof UpdateState] | undefined>>): void {
    const next: Record<string, unknown> = { ...this.#state }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    const tmp = `${this.filePath}.tmp`
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.filePath)
    this.#state = next as UpdateState
  }
}
