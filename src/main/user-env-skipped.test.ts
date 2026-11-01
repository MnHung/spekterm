import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { applyUserEnvOnce, isQueryableShell, userEnvFailed } from './user-env'

/**
 * A skipped resolution (a shell the app does not query) is **not** a failure (`restore-running-sessions` D3):
 * those users always run with the desktop's environment, and reading it as failed would mean their agents never
 * start again on their own. Its own file because `applyUserEnvOnce()` resolves once per process.
 */

const unsupported = '/usr/bin/some-unsupported-shell'
let origShell: string | undefined

before(() => {
  origShell = process.env.SHELL
  process.env.SHELL = unsupported
})

after(() => {
  if (origShell === undefined) delete process.env.SHELL
  else process.env.SHELL = origShell
})

it('a skipped resolution does not read as failed', async () => {
  // Precondition: the shell really is one the resolution skips — otherwise this would test nothing.
  assert.equal(isQueryableShell(unsupported), false)
  await applyUserEnvOnce()
  assert.equal(userEnvFailed(), false)
})
