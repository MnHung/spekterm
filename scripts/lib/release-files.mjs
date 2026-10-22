/**
 * What a release commit is, shared by the step that creates one (`release-bump.mjs`, Linux), the step
 * that only accepts one (`release-check.mjs`, macOS) and the step that publishes one (`release-github.mjs`).
 *
 * One list on purpose: if the bump started committing a third file and the check still expected two, every
 * macOS release would be refused — or, the other way round, a hand-made commit touching one more file would
 * pass as a release.
 */

/** The version is declared in these files, and the bump rewrites all of them — the commit must cover each. */
export const VERSION_FILES = ['package.json', 'package-lock.json']

/** The subject of the commit that bumps the version to `version`. */
export function releaseSubject(version) {
  return `chore(release): ${version}`
}

/**
 * Whether HEAD is the release commit of the version it declares: its subject is that version's release subject,
 * and relative to its parent it changes exactly `VERSION_FILES`. The subject alone can be reused by hand (or
 * survive an amend that added a file); the file list cannot.
 *
 * Platform-independent and indifferent to the working tree: `release-check.mjs` adds the macOS and clean-tree
 * rules on top; publishing a release (`release-github.mjs`) needs neither — the maintainer's tree is rarely clean.
 *
 * @param {(args: string[]) => string} git  runs git in the repository (`LC_ALL=C`), throws on a non-zero exit
 * @param {{ hint?: string }} [options]  a line appended to the subject refusal (what to try instead)
 * @returns {{ ok: true, version: string, commit: string } | { ok: false, reason: string }}
 */
export function checkReleaseCommit(git, { hint = '' } = {}) {
  try {
    git(['rev-parse', '--verify', '--quiet', 'HEAD^'])
  } catch {
    return {
      ok: false,
      reason:
        'The parent of HEAD is not available (a shallow clone?) — the check compares the release commit with it.\n' +
        '  Fetch more history: git fetch --deepen=1',
    }
  }

  const version = JSON.parse(git(['show', 'HEAD:package.json'])).version
  const subject = git(['log', '-1', '--format=%s', 'HEAD']).trim()
  const expected = releaseSubject(version)
  if (subject !== expected) {
    const release = git(['log', '--format=%h', '-n', '1', '--fixed-strings', `--grep=${expected}`]).trim()
    return {
      ok: false,
      reason:
        `HEAD is not the release commit of ${version} (its subject is "${subject}", not "${expected}").\n` +
        (release
          ? `  Check out the release commit: git checkout ${release}\n`
          : `  No commit "${expected}" was found; a release starts with \`npm run dist:linux\` on Linux.\n`) +
        hint,
    }
  }

  const changed = git(['diff', '--no-color', '--name-only', 'HEAD^', 'HEAD']).split('\n').filter(Boolean).sort()
  if (JSON.stringify(changed) !== JSON.stringify([...VERSION_FILES].sort())) {
    return {
      ok: false,
      reason:
        `HEAD has the release subject but changes ${changed.join(', ') || 'nothing'}, not exactly ` +
        `${VERSION_FILES.join(' and ')}.\n` +
        '  A release commit changes only the version declarations; this one was made or amended by hand.',
    }
  }

  return { ok: true, version, commit: git(['rev-parse', 'HEAD']).trim() }
}
