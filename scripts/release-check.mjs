#!/usr/bin/env node
/**
 * The macOS release check — the first step of `dist:mac` (`build-identity`: "The macOS packaging command
 * builds only a release commit").
 *
 * ## Why the Mac build accepts only a release commit
 *
 * `dist:linux` bumps and commits the version; `dist:mac` never bumps. It packages whatever version the
 * checked-out commit declares — and master moves on after a bump while that declaration stays the same.
 * A Mac build from any later commit would therefore claim a version whose source it does not have. A clean
 * working tree is not enough to prevent that: it proves "this artifact is one commit", not "this commit is
 * the release".
 *
 * ## What counts as the release commit
 *
 * - its subject is the release subject for the version it declares;
 * - relative to its parent it changes exactly the version files. The subject alone can be reused by hand
 *   (or survive an amend that added a file); the file list cannot.
 *
 * The bump creates no tags (`build-identity`), so the commit — not a tag — identifies a release. A
 * detached checkout of it is accepted: unlike the bump, this step creates no commit that could be lost.
 *
 * ## Every refusal says what to do
 *
 * Tests assert the reason's text, not just a failure: run on Linux, every refusal would otherwise be the
 * platform refusal, and a suite of fixtures that are each "refused" would pass while testing nothing.
 *
 * The repo root (argv[2]) and the platform (`--platform=`) can be overridden — the tests build git
 * fixtures and run the check as macOS on a Linux machine.
 */

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReleaseCommit } from './lib/release-files.mjs'

/**
 * @param {{ repoRoot: string, platform?: string }} options
 * @returns {{ ok: true, version: string, commit: string } | { ok: false, reason: string }}
 */
export function checkRelease({ repoRoot, platform = process.platform }) {
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason:
        `The macOS package can only be built on macOS (this is ${platform}).\n` +
        '  Build it on a Mac, from a checkout of the release commit.',
    }
  }

  const git = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  let status
  try {
    status = git(['status', '--porcelain', '--untracked-files=all']).trim()
  } catch {
    return { ok: false, reason: `${repoRoot} is not a git working copy.` }
  }
  if (status) {
    return {
      ok: false,
      reason:
        `The working tree has changes (untracked files count):\n${status}\n` +
        '  A release is built from a clean checkout of its release commit.\n' +
        '  To try a build that is not a release: npm run build && node scripts/package-mac.mjs',
    }
  }

  return checkReleaseCommit(git, {
    hint: '  To try a build that is not a release: npm run build && node scripts/package-mac.mjs',
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const platformArg = args.find((arg) => arg.startsWith('--platform='))
  const rootArg = args.find((arg) => !arg.startsWith('--'))
  const result = checkRelease({
    repoRoot: rootArg ?? dirname(dirname(fileURLToPath(import.meta.url))),
    platform: platformArg ? platformArg.slice('--platform='.length) : process.platform,
  })
  if (!result.ok) {
    console.error(`[release] ${result.reason}`)
    process.exit(1)
  }
  console.log(`[release] ${result.version} — release commit ${result.commit.slice(0, 7)}, clean`)
}
