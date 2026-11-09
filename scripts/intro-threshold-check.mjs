#!/usr/bin/env node
/**
 * The release check for the introduction's CLI threshold — the first step of `dist:linux`
 * (`agent-handoff-source`, `build-identity`, `intro-layered-rules` design D7).
 *
 * The CLI decides how much of the introduction reaches the agent, and any release of it can change that silently.
 * `scripts/intro-threshold.json` records the threshold measured with one CLI version; a release built while another
 * version is installed has not been checked against it. So this refuses when:
 *
 * - `claude --version` (the semver at its start) differs from the recorded version;
 * - no `claude` is found;
 * - the record has uncommitted changes (a measured but uncommitted record is not the one released, and it would mark
 *   the build dirty).
 *
 * It runs **before** `release-bump.mjs`, so a refusal bumps nothing and commits nothing. No override: re-measure with
 * `npm run measure:intro`, review the record, commit it, and run `dist:linux` again.
 *
 * `--cli <path>` and `--repo <dir>` override the CLI and the repository (the tests use a stub and a git fixture).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cliVersion } from './measure-intro-threshold.mjs'

const RECORD = 'scripts/intro-threshold.json'

/** The reason to refuse, or null when the release may proceed. */
export function checkRelease({ cli = 'claude', repo = join(dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const recordPath = join(repo, RECORD)
  if (!existsSync(recordPath)) return `${RECORD} is missing. Run \`npm run measure:intro\` and commit the record.`
  const recorded = JSON.parse(readFileSync(recordPath, 'utf8')).cliVersion
  const installed = cliVersion(cli)
  if (!installed) {
    return `no Claude Code found (\`${cli} --version\` failed), so the introduction's threshold cannot be checked. Install it, run \`npm run measure:intro\`, commit the record, and release again.`
  }
  if (installed !== recorded) {
    return (
      `Claude Code ${installed} is installed, but the introduction's threshold was measured with ${recorded}. ` +
      'Run `npm run measure:intro`, check that `node --test scripts/intro-threshold.test.mjs` passes, commit the record, and release again.'
    )
  }
  const status = spawnSync('git', ['status', '--porcelain', '--', RECORD], { cwd: repo, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (status.status !== 0) return `git could not report the state of ${RECORD}: ${status.stderr.trim()}`
  if (status.stdout.trim()) return `${RECORD} has uncommitted changes. Review and commit it, then release again.`
  return null
}

function argValue(argv, name) {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reason = checkRelease({
    cli: argValue(process.argv, '--cli') ?? 'claude',
    ...(argValue(process.argv, '--repo') ? { repo: argValue(process.argv, '--repo') } : {}),
  })
  if (reason) {
    console.error(`intro-threshold-check: refused before the version bump.\n${reason}`)
    process.exit(1)
  }
}
