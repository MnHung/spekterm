import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chooseUpdateBackend, isChannelFileMissing, updaterFailure } from './update-installer'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) {
    fs.chmodSync(dir, 0o755)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
function scratchAppImage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spekterm-update-choice-'))
  dirs.push(dir)
  const file = path.join(dir, 'Spekterm.AppImage')
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
  return file
}

describe('chooseUpdateBackend', () => {
  const base = { platform: 'linux' as const, eligible: true, appDir: '/tmp/.mount_SpekteAbc123' }

  it('installs from a packaged AppImage whose directory is writable', () => {
    const appImage = scratchAppImage()
    assert.deepEqual(chooseUpdateBackend({ ...base, appImage }), { kind: 'installing', appImage })
  })

  it('only tells in every other case', () => {
    const appImage = scratchAppImage()
    const cases: Array<[string, Parameters<typeof chooseUpdateBackend>[0]]> = [
      ['macOS', { ...base, platform: 'darwin', appImage }],
      ['not packaged', { ...base, eligible: false, appImage }],
      ['no APPIMAGE', { ...base, appImage: undefined }],
      ['relative APPIMAGE', { ...base, appImage: 'Spekterm.AppImage' }],
      ['missing file', { ...base, appImage: path.join(path.dirname(appImage), 'gone.AppImage') }],
      ['a directory', { ...base, appImage: path.dirname(appImage) }],
      ['extract-and-run', { ...base, appImage, appDir: '/tmp/appimage_extracted_0123456789abcdef' }],
    ]
    for (const [name, input] of cases) assert.equal(chooseUpdateBackend(input).kind, 'telling', name)
  })

  it('only tells when the directory is not writable', { skip: process.getuid?.() === 0 }, () => {
    const appImage = scratchAppImage()
    fs.chmodSync(path.dirname(appImage), 0o555)
    assert.equal(chooseUpdateBackend({ ...base, appImage }).kind, 'telling')
  })
})

describe('updaterFailure', () => {
  it('maps the measured errors', () => {
    const coded = (code: string) => Object.assign(new Error('x'), { code })
    assert.equal(updaterFailure(coded('ERR_CHECKSUM_MISMATCH')), 'checksum')
    assert.equal(updaterFailure(new Error('net::ERR_CONNECTION_REFUSED')), 'network')
    assert.equal(updaterFailure(Object.assign(new Error('HttpError: 403'), { statusCode: 403 })), 'rate-limited')
    assert.equal(updaterFailure(new Error('something else')), 'other')
    assert.equal(isChannelFileMissing(coded('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')), true)
    assert.equal(isChannelFileMissing(new Error('404')), false)
  })
})

describe('update-installer.ts', () => {
  it('never calls electron-updater installer', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-installer.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(code, /\binstall\s*\(|quitAndInstall/)
    assert.match(code, /autoInstallOnAppQuit = false/)
  })
})
