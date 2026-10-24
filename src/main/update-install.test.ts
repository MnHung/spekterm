import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import type { CloseOrigin } from './close-guard'
import {
  type InstallFs,
  QuitInstaller,
  RELAUNCH_SCRIPT,
  fileIdentity,
  installDestination,
  installUpdate,
  removeLeftoverStaging,
  shellRelauncher,
} from './update-install'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

/** A bin directory with the running AppImage and a cache with the downloaded one. */
function layout(name = 'Spekterm.AppImage') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spekterm-update-install-'))
  dirs.push(root)
  fs.mkdirSync(path.join(root, 'bin'))
  fs.mkdirSync(path.join(root, 'cache'))
  const appImage = path.join(root, 'bin', name)
  fs.writeFileSync(appImage, 'old version', { mode: 0o700 })
  const file = path.join(root, 'cache', 'Spekterm-0.2.18.AppImage')
  fs.writeFileSync(file, 'new version')
  return { root, appImage, file, startIdentity: fileIdentity(fs.statSync(appImage)) }
}

function failing(method: keyof InstallFs): InstallFs {
  return new Proxy(fs, {
    get(target, key) {
      if (key === method) {
        return () => {
          throw Object.assign(new Error(`${String(key)} failed`), { code: 'EIO' })
        }
      }
      return Reflect.get(target, key)
    },
  }) as InstallFs
}

describe('installDestination', () => {
  it('keeps a versionless name and renames a versioned one', () => {
    assert.equal(installDestination('/home/me/.local/bin/Spekterm.AppImage', '0.2.18'), '/home/me/.local/bin/Spekterm.AppImage')
    assert.equal(installDestination('/home/me/Apps/Spekterm-0.2.17.AppImage', '0.2.18'), '/home/me/Apps/Spekterm-0.2.18.AppImage')
  })
})

describe('installUpdate', () => {
  it('replaces a versionless AppImage in place, keeps its mode, and empties the cache', () => {
    const { appImage, file, startIdentity } = layout()
    const result = installUpdate({ appImage, startIdentity, version: '0.2.18', file })
    assert.deepEqual(result, { ok: true, destination: appImage })
    assert.equal(fs.readFileSync(appImage, 'utf8'), 'new version')
    assert.equal(fs.statSync(appImage).mode & 0o777, 0o700)
    assert.equal(fs.existsSync(file), false)
    assert.deepEqual(fs.readdirSync(path.dirname(appImage)), ['Spekterm.AppImage'])
  })

  it('writes a versioned AppImage under the new name and removes the old one after', () => {
    const { appImage, file, startIdentity } = layout('Spekterm-0.2.17.AppImage')
    const result = installUpdate({ appImage, startIdentity, version: '0.2.18', file })
    const destination = path.join(path.dirname(appImage), 'Spekterm-0.2.18.AppImage')
    assert.deepEqual(result, { ok: true, destination })
    assert.deepEqual(fs.readdirSync(path.dirname(appImage)), ['Spekterm-0.2.18.AppImage'])
  })

  it('touches nothing when the downloaded file is gone', () => {
    const { appImage, file, startIdentity } = layout()
    fs.rmSync(file)
    assert.deepEqual(installUpdate({ appImage, startIdentity, version: '0.2.18', file }), {
      ok: false,
      reason: 'download-missing',
    })
    assert.equal(fs.readFileSync(appImage, 'utf8'), 'old version')
  })

  it('does not overwrite an AppImage replaced since startup', () => {
    const { appImage, file, startIdentity } = layout()
    fs.writeFileSync(`${appImage}.new`, 'a newer build from install:desktop')
    fs.renameSync(`${appImage}.new`, appImage)
    const result = installUpdate({ appImage, startIdentity, version: '0.2.18', file })
    assert.equal(result.ok, false)
    assert.equal(fs.readFileSync(appImage, 'utf8'), 'a newer build from install:desktop')
  })

  for (const method of ['copyFileSync', 'fsyncSync', 'renameSync'] as const) {
    it(`leaves the AppImage byte-identical and no staging file when ${method} fails`, () => {
      const { appImage, file, startIdentity } = layout()
      const result = installUpdate({ appImage, startIdentity, version: '0.2.18', file, fs: failing(method) })
      assert.equal(result.ok, false)
      assert.deepEqual(result.ok ? null : result.detail, 'EIO')
      assert.equal(fs.readFileSync(appImage, 'utf8'), 'old version')
      assert.deepEqual(fs.readdirSync(path.dirname(appImage)), ['Spekterm.AppImage'])
    })
  }
})

describe('removeLeftoverStaging', () => {
  it('removes only our staging files', () => {
    const { appImage } = layout()
    const dir = path.dirname(appImage)
    fs.writeFileSync(path.join(dir, '.Spekterm.AppImage.installing'), 'x')
    fs.writeFileSync(path.join(dir, '.Spekterm-0.2.18.AppImage.installing'), 'x')
    fs.writeFileSync(path.join(dir, 'Spekterm.AppImage.installing'), 'install:desktop’s')
    removeLeftoverStaging(appImage)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Spekterm.AppImage', 'Spekterm.AppImage.installing'])
  })
})

describe('shellRelauncher', () => {
  it('spawns a detached shell that waits for this pid, with a copy of the environment', () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const env = { PATH: '/usr/bin' }
    const relaunch = shellRelauncher({
      pid: 4242,
      env,
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options })
        return { on: () => {}, unref: () => {} }
      }) as never,
    })
    relaunch('/home/me/.local/bin/Spekterm.AppImage')
    assert.equal(calls[0].command, fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
    assert.deepEqual(calls[0].args, ['-c', RELAUNCH_SCRIPT, 'sh', '4242', '/home/me/.local/bin/Spekterm.AppImage'])
    assert.equal(calls[0].options.detached, true)
    assert.equal(calls[0].options.stdio, 'ignore')
    assert.deepEqual(calls[0].options.env, env)
    assert.notEqual(calls[0].options.env, env)
  })

  it('falls back to /bin/sh where there is no bash', () => {
    const commands: string[] = []
    const relaunch = shellRelauncher({
      pid: 4242,
      env: {},
      exists: () => false,
      spawn: ((command: string) => {
        commands.push(command)
        return { on: () => {}, unref: () => {} }
      }) as never,
    })
    relaunch('/home/me/.local/bin/Spekterm.AppImage')
    assert.deepEqual(commands, ['/bin/sh'])
  })

  for (const shell of ['/bin/bash', '/bin/sh']) {
    it(`under ${shell} the script execs the target only after the pid exited, without the inherited descriptors`, {
      skip: !fs.existsSync(shell),
    }, () => {
      const { root } = layout()
      const marker = path.join(root, 'marker')
      const target = path.join(root, 'target.sh')
      const heldFile = path.join(root, 'held')
      fs.writeFileSync(heldFile, '')
      fs.writeFileSync(target, `#!/bin/sh\nfor f in /proc/$$/fd/*; do echo "\${f##*/} $(readlink "$f")"; done > "${marker}"\n`, { mode: 0o755 })
      // Descriptors in stdio slots are inherited without close-on-exec, as Electron's are: 3–4 and 36.
      const held = fs.openSync(heldFile, 'r')
      try {
        const stdio = ['ignore', 'ignore', 'ignore', held, held, ...Array<'ignore'>(31).fill('ignore'), held]
        // A pid that does not exist: the loop ends at once.
        const { status } = spawnSync(shell, ['-c', RELAUNCH_SCRIPT, 'sh', '2147483646', target], { stdio: stdio as never })
        assert.equal(status, 0)
      } finally {
        fs.closeSync(held)
      }
      // Only the held file's descriptors count: the target's shell holds its script and a pipe of its own.
      const inherited = fs.readFileSync(marker, 'utf8').split('\n').filter((line) => line.endsWith(` ${heldFile}`))
        .map((line) => Number(line.split(' ')[0])).sort((a, b) => a - b)
      assert.deepEqual(inherited, shell === '/bin/bash' ? [] : [36])
    })
  }
})

describe('QuitInstaller', () => {
  function installer(options: { origins: CloseOrigin[]; autoCheck?: boolean; ready?: boolean; name?: string }) {
    const files = layout(options.name)
    const relaunched: string[] = []
    const outcomes: unknown[] = []
    const quit = new QuitInstaller({
      appImage: files.appImage,
      startIdentity: files.startIdentity,
      ready: () => (options.ready === false ? null : { version: '0.2.18', file: files.file }),
      autoCheck: () => options.autoCheck ?? true,
      state: { update: (patch) => outcomes.push(patch.installOutcome) },
      relaunch: (target) => relaunched.push(target),
    })
    for (const origin of options.origins) quit.recordOrigin(origin)
    return { ...files, quit, relaunched, outcomes }
  }

  it('a restart installs and relaunches the new file, once', () => {
    const h = installer({ origins: ['restart'] })
    h.quit.willQuit()
    h.quit.willQuit()
    assert.equal(fs.readFileSync(h.appImage, 'utf8'), 'new version')
    assert.deepEqual(h.relaunched, [h.appImage])
    assert.deepEqual(h.outcomes, [{ version: '0.2.18', ok: true }])
  })

  it('a restart relaunches the renamed file of a versioned AppImage', () => {
    const h = installer({ origins: ['restart'], name: 'Spekterm-0.2.17.AppImage' })
    h.quit.willQuit()
    assert.deepEqual(h.relaunched, [path.join(path.dirname(h.appImage), 'Spekterm-0.2.18.AppImage')])
  })

  it('a failed restart install relaunches the old version and records why', () => {
    const h = installer({ origins: ['restart'] })
    fs.rmSync(h.file)
    h.quit.willQuit()
    assert.equal(fs.readFileSync(h.appImage, 'utf8'), 'old version')
    assert.deepEqual(h.relaunched, [h.appImage])
    assert.deepEqual(h.outcomes, [{ version: '0.2.18', ok: false, reason: 'download-missing' }])
  })

  it('a user quit installs and relaunches nothing', () => {
    const h = installer({ origins: ['user'] })
    h.quit.willQuit()
    assert.equal(fs.readFileSync(h.appImage, 'utf8'), 'new version')
    assert.deepEqual(h.relaunched, [])
  })

  it('a user quit with the switch off installs nothing', () => {
    const h = installer({ origins: ['user'], autoCheck: false })
    h.quit.willQuit()
    assert.equal(fs.readFileSync(h.appImage, 'utf8'), 'old version')
    assert.deepEqual(h.outcomes, [])
  })

  it('a signal quit, or a quit with no guarded close, installs nothing', () => {
    for (const origins of [['signal'], []] as CloseOrigin[][]) {
      const h = installer({ origins })
      h.quit.willQuit()
      assert.equal(fs.readFileSync(h.appImage, 'utf8'), 'old version', JSON.stringify(origins))
      assert.deepEqual(h.relaunched, [])
    }
  })

  it('the first origin wins: a later signal does not cancel a user quit', () => {
    const h = installer({ origins: ['user', 'signal'] })
    h.quit.willQuit()
    assert.equal(fs.readFileSync(h.appImage, 'utf8'), 'new version')
  })

  it('nothing ready ⇒ nothing done', () => {
    const h = installer({ origins: ['restart'], ready: false })
    h.quit.willQuit()
    assert.equal(fs.readFileSync(h.appImage, 'utf8'), 'old version')
    assert.deepEqual(h.relaunched, [])
  })
})
