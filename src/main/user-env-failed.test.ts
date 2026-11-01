import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, it } from 'node:test'
import { applyUserEnvOnce, userEnvFailed } from './user-env'

/**
 * A resolution that ran and failed reads as failed (`restore-running-sessions` D3: an automatic start refuses
 * agents then). Its own file because `applyUserEnvOnce()` resolves once per process; the skipped case is
 * `user-env-skipped.test.ts`.
 */

const bashPath = '/bin/bash'
let home: string
let origHome: string | undefined
let origShell: string | undefined

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-userenv-failed-')))
  // A login shell reads `.bash_profile`: exiting there makes the query exit non-zero.
  fs.writeFileSync(path.join(home, '.bash_profile'), 'exit 3\n')
  origHome = process.env.HOME
  origShell = process.env.SHELL
  process.env.HOME = home
  process.env.SHELL = bashPath
})

after(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origShell === undefined) delete process.env.SHELL
  else process.env.SHELL = origShell
  fs.rmSync(home, { recursive: true, force: true })
})

it('a resolution whose shell exits non-zero reads as failed', async () => {
  assert.ok(fs.existsSync(bashPath), `${bashPath} is required by this test`)
  assert.equal(userEnvFailed(), false, 'not failed before the resolution ran')
  await applyUserEnvOnce()
  assert.equal(userEnvFailed(), true)
})
