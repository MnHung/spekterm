#!/usr/bin/env node
/**
 * Publishes a version's GitHub release (`desktop-packaging`, "A release publishes the update metadata with its
 * Linux artifact"; design U10 of `auto-update`):
 *
 *   npm run release:github -- --notes-file <path>
 *
 * ## Why a script and not `gh release create` by hand
 *
 * Linux installs update themselves from the latest release's `latest-linux.yml` (`app-update`). A release that
 * carries the AppImage without that file is a release no running copy ever sees; a release whose file describes
 * another build is one every running copy fails to verify. Both were the default of the hand-made release, which
 * never carried the file. So the AppImage is uploaded **only with** its metadata, checked against it first.
 *
 * ## Invisible until complete
 *
 * `gh release create` with assets publishes the release first and uploads after, and a 130 MB AppImage takes a
 * while: a client checking in between would find the metadata and fail to download the file. A new release is
 * therefore created as a **draft** with every asset, and published only once the upload succeeded — drafts are not
 * returned as the latest release. An existing release (the dmg added from the Mac later) gets its assets added or
 * replaced, and is published if a previous run left it a draft.
 *
 * ## Refusals
 *
 * HEAD must be the release commit of the declared version (`checkReleaseCommit`, without the clean-tree rule
 * `dist:mac` has: the maintainer's tree is rarely clean) and must be on `origin/master` — the tag names that
 * commit. Packaging itself never publishes (`--publish never`, `packaging-config.test.mjs`).
 *
 * `git` and `gh` are run with argument arrays, never a shell string. The repo root (argv) and the runners can be
 * injected: the tests drive every refusal with fixtures.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReleaseCommit } from './lib/release-files.mjs'

/** @typedef {{ status: number, stdout: string, stderr: string }} RunResult */
/** @typedef {(args: string[]) => RunResult} Runner */

/** @param {string} command @param {string} cwd @returns {Runner} */
export function processRunner(command, cwd) {
  return (args) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error) return { status: 127, stdout: '', stderr: String(result.error) }
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

/** The fields of `latest-linux.yml` that bind it to one file. */
export function parseUpdateInfo(text) {
  const field = (name) => new RegExp(`^${name}: *'?([^'\\n]+?)'? *$`, 'm').exec(text)?.[1] ?? null
  return { version: field('version'), path: field('path'), sha512: field('sha512') }
}

export function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

/**
 * @param {{ repoRoot: string, notesFile?: string, git?: Runner, gh?: Runner, log?: (line: string) => void }} options
 * @returns {{ ok: true, version: string, uploaded: string[], created: boolean } | { ok: false, reason: string }}
 */
export function publishRelease({ repoRoot, notesFile, git, gh, log = () => {} }) {
  const runGit = git ?? processRunner('git', repoRoot)
  const runGh = gh ?? processRunner('gh', repoRoot)
  const gitText = (args) => {
    const result = runGit(args)
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
    return result.stdout
  }

  let commit
  try {
    commit = checkReleaseCommit(gitText)
  } catch {
    return { ok: false, reason: `${repoRoot} is not a git working copy.` }
  }
  if (!commit.ok) return commit
  const { version } = commit

  if (runGit(['fetch', '--quiet', 'origin', 'master']).status !== 0) {
    return { ok: false, reason: 'git fetch origin master failed; the release commit must be checked against the remote.' }
  }
  // Only the exit code is read: 0 = an ancestor, 1 = not.
  if (runGit(['merge-base', '--is-ancestor', commit.commit, 'origin/master']).status !== 0) {
    return {
      ok: false,
      reason: `The release commit of ${version} is not on origin/master. Push it first: its tag must name a pushed commit.`,
    }
  }

  const release = join(repoRoot, 'release')
  const appImage = join(release, `Spekterm-${version}.AppImage`)
  const updateInfo = join(release, 'latest-linux.yml')
  const dmg = join(release, `Spekterm-${version}-arm64.dmg`)
  const hasAppImage = existsSync(appImage)
  const hasInfo = existsSync(updateInfo)
  if (hasAppImage && !hasInfo) {
    return { ok: false, reason: `${basename(updateInfo)} is missing: the AppImage is published only with its update metadata.` }
  }
  const assets = []
  if (hasAppImage) {
    const info = parseUpdateInfo(readFileSync(updateInfo, 'utf8'))
    if (info.version !== version) {
      return { ok: false, reason: `${basename(updateInfo)} describes ${info.version ?? 'no version'}, not ${version}.` }
    }
    if (info.path !== basename(appImage)) {
      return { ok: false, reason: `${basename(updateInfo)} names ${info.path ?? 'no file'}, not ${basename(appImage)}.` }
    }
    if (info.sha512 !== sha512Base64(appImage)) {
      return { ok: false, reason: `${basename(updateInfo)}'s checksum is not ${basename(appImage)}'s: they come from different builds.` }
    }
    assets.push(appImage, updateInfo)
  }
  if (existsSync(dmg)) assets.push(dmg)
  if (assets.length === 0) {
    return { ok: false, reason: `No artifact of ${version} in release/ (the AppImage with latest-linux.yml, or the dmg).` }
  }

  const tag = `v${version}`
  const view = runGh(['release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft'])
  const created = view.status !== 0
  if (created) {
    if (!notesFile || !existsSync(notesFile)) {
      return { ok: false, reason: `Release ${tag} does not exist yet: pass --notes-file <path> with its notes.` }
    }
    const create = runGh([
      'release', 'create', tag, '--draft', '--target', commit.commit, '--title', `spekterm ${version}`,
      '--notes-file', notesFile, ...assets,
    ])
    if (create.status !== 0) return { ok: false, reason: `gh release create failed: ${create.stderr.trim()}` }
    log(`[release] draft ${tag} created with ${assets.map((asset) => basename(asset)).join(', ')}`)
  } else {
    const upload = runGh(['release', 'upload', tag, '--clobber', ...assets])
    if (upload.status !== 0) return { ok: false, reason: `gh release upload failed: ${upload.stderr.trim()}` }
    log(`[release] ${tag}: uploaded ${assets.map((asset) => basename(asset)).join(', ')}`)
  }
  if (created || view.stdout.trim() === 'true') {
    const publish = runGh(['release', 'edit', tag, '--draft=false'])
    if (publish.status !== 0) return { ok: false, reason: `gh release edit --draft=false failed: ${publish.stderr.trim()}` }
    log(`[release] ${tag} published`)
  }
  // The tag `gh` created exists only on the remote; the site's build reads the local tags.
  runGit(['fetch', '--quiet', '--tags', 'origin'])
  return { ok: true, version, uploaded: assets.map((asset) => basename(asset)), created }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const notesAt = args.indexOf('--notes-file')
  const notesFile = notesAt >= 0 ? args[notesAt + 1] : undefined
  const rootArg = args.find((arg, index) => !arg.startsWith('--') && index !== notesAt + 1)
  const result = publishRelease({
    repoRoot: rootArg ?? dirname(dirname(fileURLToPath(import.meta.url))),
    notesFile,
    log: (line) => console.log(line),
  })
  if (!result.ok) {
    console.error(`[release] ${result.reason}`)
    process.exit(1)
  }
}
