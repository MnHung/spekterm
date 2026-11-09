/**
 * The release check (`intro-layered-rules` D7): a stub CLI and a git fixture, run as `dist:linux` runs it.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CHECK = join(here, 'intro-threshold-check.mjs')
const STUB = join(here, 'lib', 'stub-claude-threshold.mjs')

const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

/** A repository with a committed record of `version`. */
function fixture(version = '2.1.319') {
  const repo = mkdtempSync(join(tmpdir(), 'intro-check-'))
  dirs.push(repo)
  git(repo, 'init', '-q', '-b', 'master')
  mkdirSync(join(repo, 'scripts'))
  writeFileSync(join(repo, 'scripts', 'intro-threshold.json'), `${JSON.stringify({ cliVersion: version, cases: [] })}\n`)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'record')
  return repo
}

function check(repo, { cli = STUB, version = '2.1.319' } = {}) {
  const r = spawnSync(process.execPath, [CHECK, '--cli', cli, '--repo', repo], { encoding: 'utf8', env: { ...process.env, STUB_VERSION: version } })
  return { status: r.status, out: r.stderr }
}

test('the recorded version installed, the record committed: passes', () => {
  assert.equal(check(fixture()).status, 0)
})

test('the version is read from the start of --version, with text after "(Claude Code)"', () => {
  // The stub prints "<version> (Claude Code)"; a different suffix does not change the parse.
  assert.equal(check(fixture('3.0.1'), { version: '3.0.1' }).status, 0)
})

test('a different CLI version: refused, naming both versions and the command', () => {
  const r = check(fixture('2.1.317'), { version: '2.1.319' })
  assert.equal(r.status, 1)
  assert.match(r.out, /refused before the version bump/)
  assert.match(r.out, /Claude Code 2\.1\.319 is installed, but .* measured with 2\.1\.317/)
  assert.match(r.out, /npm run measure:intro/)
})

test('no CLI: refused', () => {
  const r = check(fixture(), { cli: join(tmpdir(), 'no-such-claude') })
  assert.equal(r.status, 1)
  assert.match(r.out, /no Claude Code found/)
})

test('an uncommitted record: refused', () => {
  const repo = fixture()
  writeFileSync(join(repo, 'scripts', 'intro-threshold.json'), `${JSON.stringify({ cliVersion: '2.1.319', cases: [1] })}\n`)
  const r = check(repo)
  assert.equal(r.status, 1)
  assert.match(r.out, /uncommitted changes/)
})

test('a refusal creates no commit', () => {
  const repo = fixture('2.1.317')
  const before = git(repo, 'rev-parse', 'HEAD')
  assert.equal(check(repo).status, 1)
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
})
