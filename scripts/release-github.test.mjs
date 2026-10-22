import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { parseUpdateInfo, publishRelease, sha512Base64 } from './release-github.mjs'

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const VERSION = '0.2.18'
const COMMIT = 'a'.repeat(40)

/** A repo root with `release/` holding what `files` says, and a notes file. */
function fixture(files = { appImage: true, info: true, dmg: false }) {
  const root = mkdtempSync(join(tmpdir(), 'spekterm-release-github-'))
  roots.push(root)
  mkdirSync(join(root, 'release'))
  const appImage = join(root, 'release', `Spekterm-${VERSION}.AppImage`)
  writeFileSync(appImage, 'the AppImage')
  const sha512 = sha512Base64(appImage)
  if (!files.appImage) rmSync(appImage)
  if (files.info) {
    const version = files.infoVersion ?? VERSION
    const checksum = files.infoSha ?? sha512
    writeFileSync(
      join(root, 'release', 'latest-linux.yml'),
      `version: ${version}\nfiles:\n  - url: Spekterm-${VERSION}.AppImage\n    sha512: ${checksum}\n    size: 12\n` +
        `path: Spekterm-${VERSION}.AppImage\nsha512: ${checksum}\nreleaseDate: '2026-10-21T00:00:00.000Z'\n`,
    )
  }
  if (files.dmg) writeFileSync(join(root, 'release', `Spekterm-${VERSION}-arm64.dmg`), 'the dmg')
  const notes = join(root, 'notes.md')
  writeFileSync(notes, 'spekterm 0.2.18 updates itself.\n')
  return { root, notes }
}

/** git answers for a release commit; `overrides` changes one answer by its first argument(s). */
function fakeGit(overrides = {}) {
  const calls = []
  const runner = (args) => {
    calls.push(args)
    const key = args.slice(0, 2).join(' ')
    if (key in overrides) return overrides[key]
    if (args[0] === 'rev-parse' && args.includes('HEAD^')) return ok('')
    if (key === 'show HEAD:package.json') return ok(JSON.stringify({ version: VERSION }))
    if (key === 'log -1') return ok(`chore(release): ${VERSION}\n`)
    if (args[0] === 'diff') return ok('package-lock.json\npackage.json\n')
    if (key === 'rev-parse HEAD') return ok(`${COMMIT}\n`)
    if (args[0] === 'fetch') return ok('')
    if (args[0] === 'merge-base') return ok('')
    return { status: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` }
  }
  return { runner, calls }
}

/** gh with a release that `exists` (and is a draft if `draft`), recording every call. */
function fakeGh({ exists = false, draft = false, fail = null } = {}) {
  const calls = []
  const runner = (args) => {
    calls.push(args)
    if (fail && args[1] === fail) return { status: 1, stdout: '', stderr: `${fail} failed` }
    if (args[1] === 'view') return exists ? ok(`${draft}\n`) : { status: 1, stdout: '', stderr: 'release not found' }
    return ok('')
  }
  return { runner, calls }
}

function ok(stdout) {
  return { status: 0, stdout, stderr: '' }
}

describe('parseUpdateInfo', () => {
  it('reads the top-level fields', () => {
    assert.deepEqual(
      parseUpdateInfo("version: 0.2.18\nfiles:\n  - url: a\n    sha512: inner\npath: Spekterm-0.2.18.AppImage\nsha512: outer==\nreleaseDate: '2026'\n"),
      { version: '0.2.18', path: 'Spekterm-0.2.18.AppImage', sha512: 'outer==' },
    )
  })
})

describe('publishRelease: refusals', () => {
  it('refuses a HEAD that is not the release commit', () => {
    const { root, notes } = fixture()
    const git = fakeGit({ 'log -1': ok('feat: something\n'), 'log --format=%h': ok('') })
    const gh = fakeGh()
    const result = publishRelease({ repoRoot: root, notesFile: notes, git: git.runner, gh: gh.runner })
    assert.equal(result.ok, false)
    assert.match(result.reason, /not the release commit of 0\.2\.18/)
    assert.deepEqual(gh.calls, [])
  })

  it('refuses an unpushed release commit and creates nothing', () => {
    const { root, notes } = fixture()
    const gh = fakeGh()
    const result = publishRelease({
      repoRoot: root,
      notesFile: notes,
      git: fakeGit({ 'merge-base --is-ancestor': { status: 1, stdout: '', stderr: '' } }).runner,
      gh: gh.runner,
    })
    assert.match(result.reason, /not on origin\/master/)
    assert.deepEqual(gh.calls, [])
  })

  it('refuses the AppImage without its metadata, naming the file', () => {
    const { root, notes } = fixture({ appImage: true, info: false })
    const gh = fakeGh()
    const result = publishRelease({ repoRoot: root, notesFile: notes, git: fakeGit().runner, gh: gh.runner })
    assert.match(result.reason, /latest-linux\.yml is missing/)
    assert.deepEqual(gh.calls, [])
  })

  it('refuses metadata of another version or another build', () => {
    for (const files of [
      { appImage: true, info: true, infoVersion: '0.2.17' },
      { appImage: true, info: true, infoSha: 'bm90IHRoaXMgYnVpbGQ=' },
    ]) {
      const { root, notes } = fixture(files)
      const gh = fakeGh()
      const result = publishRelease({ repoRoot: root, notesFile: notes, git: fakeGit().runner, gh: gh.runner })
      assert.equal(result.ok, false, JSON.stringify(files))
      assert.deepEqual(gh.calls, [])
    }
  })

  it('refuses a new release without notes', () => {
    const { root } = fixture()
    const gh = fakeGh()
    const result = publishRelease({ repoRoot: root, git: fakeGit().runner, gh: gh.runner })
    assert.match(result.reason, /--notes-file/)
    assert.equal(gh.calls.filter((args) => args[1] === 'create').length, 0)
  })
})

describe('publishRelease: publishing', () => {
  it('creates a draft with the AppImage and its metadata, publishes it after, then fetches the tags', () => {
    const { root, notes } = fixture()
    const git = fakeGit()
    const gh = fakeGh()
    const result = publishRelease({ repoRoot: root, notesFile: notes, git: git.runner, gh: gh.runner })
    assert.deepEqual(result, {
      ok: true,
      version: VERSION,
      uploaded: [`Spekterm-${VERSION}.AppImage`, 'latest-linux.yml'],
      created: true,
    })
    const create = gh.calls.find((args) => args[1] === 'create')
    assert.deepEqual(create.slice(0, 9), ['release', 'create', 'v0.2.18', '--draft', '--target', COMMIT, '--title', 'spekterm 0.2.18', '--notes-file'])
    const order = gh.calls.map((args) => args[1])
    assert.deepEqual(order, ['view', 'create', 'edit'], 'published only after the draft carried every asset')
    assert.deepEqual(gh.calls.at(-1), ['release', 'edit', 'v0.2.18', '--draft=false'])
    assert.deepEqual(git.calls.at(-1), ['fetch', '--quiet', '--tags', 'origin'])
  })

  it('does not publish a draft whose upload failed', () => {
    const { root, notes } = fixture()
    const gh = fakeGh({ fail: 'create' })
    const result = publishRelease({ repoRoot: root, notesFile: notes, git: fakeGit().runner, gh: gh.runner })
    assert.equal(result.ok, false)
    assert.equal(gh.calls.filter((args) => args[1] === 'edit').length, 0)
  })

  it('adds the dmg to an existing release and changes nothing else', () => {
    const { root } = fixture({ appImage: false, info: false, dmg: true })
    const gh = fakeGh({ exists: true })
    const result = publishRelease({ repoRoot: root, git: fakeGit().runner, gh: gh.runner })
    assert.equal(result.ok, true)
    assert.deepEqual(
      gh.calls.map((args) => args[1]),
      ['view', 'upload'],
    )
    assert.deepEqual(gh.calls[1].slice(0, 4), ['release', 'upload', 'v0.2.18', '--clobber'])
    assert.match(gh.calls[1][4], /Spekterm-0\.2\.18-arm64\.dmg$/)
  })

  it('publishes an existing release a previous run left a draft', () => {
    const { root } = fixture()
    const gh = fakeGh({ exists: true, draft: true })
    publishRelease({ repoRoot: root, git: fakeGit().runner, gh: gh.runner })
    assert.deepEqual(
      gh.calls.map((args) => args[1]),
      ['view', 'upload', 'edit'],
    )
  })
})
