import fs from 'node:fs'
import path from 'node:path'

/**
 * The acceptance probes' update feed (`auto-update`, design U9): `<userData>/update-feed.json`.
 *
 * An unpackaged build never checks for updates — except when a probe configured this file. **The gate is the
 * throwaway profile (`index.ts`'s `usingThrowawayProfile`: unpackaged and started with `--user-data-dir`), never
 * an environment variable**: `ptyEnv()` spreads `process.env` into every pty, where an agent could point the
 * updater at a feed of its own. A packaged build does not open the file at all.
 *
 * Every URL must be on the loopback interface: the file is for a local stub, not a way to reach another host.
 */

export const UPDATE_FEED_FILE = 'update-feed.json'

export interface UpdateFeed {
  /** An `app-update.yml` (generic provider) for the installing backend; `forceDevUpdateConfig` goes with it. */
  readonly updateConfigPath?: string
  /** The telling backend's stand-in for GitHub's latest-release endpoint. */
  readonly releaseApiUrl?: string
  /** Shorter than the real first delay, so a section does not wait a minute. */
  readonly firstDelayMs?: number
}

function loopbackUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function readUpdateFeed(options: {
  readonly throwawayProfile: boolean
  readonly userData: string
  readonly readFile?: (file: string) => string
}): UpdateFeed | null {
  if (!options.throwawayProfile) return null
  const read = options.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'))
  let value: unknown
  try {
    value = JSON.parse(read(path.join(options.userData, UPDATE_FEED_FILE)))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const feed: { -readonly [K in keyof UpdateFeed]: UpdateFeed[K] } = {}
  if (typeof source.updateConfigPath === 'string' && path.isAbsolute(source.updateConfigPath)) {
    feed.updateConfigPath = source.updateConfigPath
  }
  const releaseApiUrl = loopbackUrl(source.releaseApiUrl)
  if (releaseApiUrl) feed.releaseApiUrl = releaseApiUrl
  if (typeof source.firstDelayMs === 'number' && Number.isFinite(source.firstDelayMs) && source.firstDelayMs >= 0) {
    feed.firstDelayMs = source.firstDelayMs
  }
  return feed.updateConfigPath || feed.releaseApiUrl ? feed : null
}
