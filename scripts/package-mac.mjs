#!/usr/bin/env node
/**
 * Package the macOS artifact from an Electron archive checked against a pinned checksum — the packaging step
 * of `dist:mac` (`desktop-packaging`: "The Electron binary in a macOS artifact matches a pinned checksum").
 *
 * ## Why this step exists instead of `electron-builder --mac`
 *
 * electron-builder's own `electronDownload.checksums` does not reject a wrong checksum: with a mirror
 * configured, `createDownloadOpts` keeps only `mirror` and drops `checksums` (measured — a build with an
 * altered hash succeeded; see the change's design). Left alone it falls back to the `SHASUMS256.txt` that
 * the same server delivers, so a mirror would vouch for its own file. The GitHub download is too slow from
 * the build machine to finish, so a mirror is the normal case there, not the exception.
 *
 * ## Why `@electron/get`, and why `checksums.json`
 *
 * `@electron/get` is what `electron`'s own postinstall uses: the same mirror rules (`ELECTRON_MIRROR`,
 * `npm_config_electron_mirror`, the custom-directory template) and the same cache. It verifies against the
 * `checksums` map on every call — a cache hit that does not match is downloaded again, and a download that
 * does not match throws. The map comes from `node_modules/electron/checksums.json`, which npm installed under
 * the lockfile's integrity check and which moves with the pinned `electron` version.
 *
 * The verified zip is handed to electron-builder as `electronDist`. That path skips electron-builder's
 * cleanup after unpacking, which `after-pack.cjs` makes up for.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArtifact } from '@electron/get'

const PLATFORM = 'darwin'
const ARCH = 'arm64'

/** The installed `electron` version and the checksums its package publishes. */
export function pinnedElectron(repoRoot) {
  const electronDir = join(repoRoot, 'node_modules', 'electron')
  const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'))
  const checksums = JSON.parse(readFileSync(join(electronDir, 'checksums.json'), 'utf8'))
  return { version, checksums }
}

/** The archive name `checksums.json` keys this platform's Electron under. */
export function archiveName(version) {
  return `electron-v${version}-${PLATFORM}-${ARCH}.zip`
}

/**
 * Fetch (or take from the cache) the macOS Electron archive, verified against `checksums`.
 * `downloader` and `cacheRoot` exist for the tests; production uses `@electron/get`'s defaults.
 *
 * @returns {Promise<string>} the archive's path
 */
export async function fetchElectronZip({ version, checksums, downloader, cacheRoot }) {
  const name = archiveName(version)
  if (!checksums[name]) throw new Error(`checksums.json has no entry for ${name}`)
  return downloadArtifact({
    version,
    platform: PLATFORM,
    arch: ARCH,
    artifactName: 'electron',
    checksums,
    ...(downloader ? { downloader } : {}),
    ...(cacheRoot ? { cacheRoot } : {}),
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const { version, checksums } = pinnedElectron(repoRoot)
  let zip
  try {
    zip = await fetchElectronZip({ version, checksums })
  } catch (error) {
    console.error(`[package-mac] the Electron archive ${archiveName(version)} was not accepted: ${error.message}`)
    process.exit(1)
  }
  console.log(`[package-mac] ${archiveName(version)} matches the pinned checksum`)
  // electron-builder deletes the archive's licence texts from its output for macOS; `after-pack.cjs` puts
  // them into the bundle from here — the archive just verified, not a second, unverified copy.
  const licences = mkdtempSync(join(tmpdir(), 'spekterm-electron-licences-'))
  try {
    execFileSync('unzip', ['-q', '-o', '-j', zip, 'LICENSE', 'LICENSES.chromium.html', '-d', licences])
    // Arguments after `--` reach electron-builder: a trial or control build (`-- --dir`,
    // `-- -c.mac.identity=null`). A release goes through `dist:mac`, which passes none.
    // `--publish never`: electron-builder publishes by itself when it sees CI and a tag, and the GitHub
    // provider inferred from `repository` is real since `auto-update`. Releases go through `release:github`.
    const extra = process.argv.slice(2).filter((arg) => arg !== '--')
    execFileSync(join(repoRoot, 'node_modules', '.bin', 'electron-builder'), ['--mac', '--publish', 'never', `-c.electronDist=${zip}`, ...extra], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_LICENCES_DIR: licences },
    })
  } finally {
    rmSync(licences, { recursive: true, force: true })
  }
}
