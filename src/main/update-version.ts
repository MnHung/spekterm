/**
 * The one thing taken from a release: its version (`app-update`, "Only a version is taken from a release";
 * design U2 of `auto-update`).
 *
 * A release's name, notes and URLs are third-party text and never reach the screen or `shell.openExternal`:
 * everything the app shows or opens for an update is built here from a version that passed `parseVersion`.
 */

export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/

/** `x.y.z` or `vx.y.z`; anything else (a pre-release suffix, junk, a number too large to be exact) is `null`. */
export function parseVersion(text: unknown): Version | null {
  if (typeof text !== 'string') return null
  const match = VERSION.exec(text)
  if (!match) return null
  const [major, minor, patch] = match.slice(1).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch }
}

/** Numeric, field by field: `1.10.0` is newer than `1.9.9`. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

/** The release page, built from the version — never a URL the release's answer carried. */
export function releasePageUrl(version: Version): string {
  return `https://github.com/spekhq/spekterm/releases/tag/v${formatVersion(version)}`
}
