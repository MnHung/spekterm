/**
 * The update check's acceptance (`app-update`; design U9 of `auto-update`), run by `probe:workspace` at its end.
 *
 * An unpackaged build checks for updates only when a probe configured `<userData>/update-feed.json` (the gate is
 * the throwaway profile, `src/main/update-feed.ts`). Every section here serves its own feed from `127.0.0.1`: a
 * `generic` feed (`latest-linux.yml` + a fake "AppImage") for the installing backend, and a stand-in for GitHub's
 * latest-release endpoint for the telling one. The fake AppImages are shell scripts that append a line to a marker
 * file when run — so "the relaunch started the new version, once" is read from disk.
 *
 * Isolation (task 1.x of `auto-update`): `XDG_CACHE_HOME` points at a scratch directory and the feed's
 * `app-update.yml` names a cache directory of its own, so a run never touches the maintainer's
 * `~/.cache/spekterm-updater`. `APPDIR` is removed from the app's environment (an outer AppImage's would otherwise
 * be inherited); `APPIMAGE` is the section's fake.
 *
 * What this cannot carry, and the coverage table says so: the real AppImage (`probe:package` checks that a packaged
 * build really asks GitHub), the real release (dogfood), and "no check while ready" (the next check is six hours
 * away; the coordinator's unit test carries it).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { check, connectToApp, pollFor } from './lib/cdp.mjs'
import { copy, label } from './lib/copy.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { awaitMounted, describeMounted, mountedExpression } from './lib/mounted.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { quitAndWait } from './lib/quit.mjs'
import { SETTINGS_DIALOG, clickSelector, closeSettings, openSettings } from './lib/settings.mjs'

const NEW_VERSION = '9.9.9'
const MOUNTED = mountedExpression()
const UPDATE_SECTION = `${SETTINGS_DIALOG} section${label('update.heading')}`
const STATUS_TEXT = `document.querySelector(${JSON.stringify(`${UPDATE_SECTION} [role="status"]`)})?.textContent ?? null`
const BUTTON_TEXTS = `[...document.querySelectorAll(${JSON.stringify(`${UPDATE_SECTION} button`)})].map((b) => b.textContent.trim())`
const INBOX_OPEN = `Boolean(document.querySelector('[role="dialog"]${label('intake.label')}'))`
const ABOUT_SHOWN = `document.querySelector(${JSON.stringify(`${SETTINGS_DIALOG} [role="tab"][id="settings-tab-about"]`)})?.getAttribute('aria-selected') === 'true'`
const SESSION_ROWS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li > ul > li > div[role="button"]')].length`
const OPEN_SPAWN_MENU = (folderName) => `(() => {
  const button = document.querySelector('button[aria-label="${copy('rail.newSessionIn', { name: '%NAME%' })}"]'
    .replace('%NAME%', ${JSON.stringify(folderName)}))
  if (!button) return false
  button.click()
  return true
})()`
const CLICK_SHELL_ITEM = `(() => {
  const item = [...(document.querySelector('[role="menu"]')?.querySelectorAll('button') ?? [])]
    .find((b) => b.innerText.includes(${JSON.stringify(copy('sessions.spawnShell'))}))
  if (!item) return false
  item.click()
  return true
})()`

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sha512Base64 = (buffer) => createHash('sha512').update(buffer).digest('base64')

/** A real click on the update block's button whose text is `text`. */
async function clickUpdateButton(client, text) {
  const at = await pollFor({
    read: () =>
      client.evaluate(`(() => {
        const button = [...document.querySelectorAll(${JSON.stringify(`${UPDATE_SECTION} button`)})]
          .find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)
        if (!button) return null
        button.scrollIntoView({ block: 'nearest' })
        const r = button.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`),
    settled: (value) => value !== null,
    timeoutMs: 5_000,
    label: `the "${text}" button`,
  })
  if (!at) return false
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    })
  }
  return true
}

/**
 * @param {{ results: unknown[], port: number, mkTemp: (prefix: string) => string }} options
 */
export async function runUpdateSections({ results, port, mkTemp }) {
  console.log('\nThe update check (app-update)')
  const scratch = mkTemp('spekterm-update-scratch-')
  const folder = join(scratch, 'repo-update')
  mkdirSync(folder)

  // ── The feed: one route per section name.
  const newScript = (marker) => `#!/bin/sh\necho "new ${NEW_VERSION}" >> "${marker}"\n`
  const feeds = new Map()
  const requests = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push(path)
    const [, name, file] = path.split('/')
    const feed = feeds.get(name)
    const body = feed?.[file]
    if (body === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Type': file.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const requestsFor = (name) => requests.filter((path) => path.startsWith(`/${name}/`)).length

  /** A section's directories, feed, fake AppImage and profile. */
  function sectionSetup(name, { badSha = false, autoCheck = true, telling = false } = {}) {
    const root = join(scratch, name)
    const bin = join(root, 'bin')
    const cache = join(root, 'cache')
    mkdirSync(bin, { recursive: true })
    mkdirSync(cache, { recursive: true })
    const marker = join(root, 'marker')
    const appImage = join(bin, 'Spekterm.AppImage')
    writeFileSync(appImage, `#!/bin/sh\necho "old" >> "${marker}"\n`)
    chmodSync(appImage, 0o755)
    const fileName = `Spekterm-${NEW_VERSION}.AppImage`
    const content = Buffer.from(newScript(marker))
    const sha512 = badSha ? sha512Base64(Buffer.from('another build')) : sha512Base64(content)
    feeds.set(name, {
      'latest-linux.yml':
        `version: ${NEW_VERSION}\nfiles:\n  - url: ${fileName}\n    sha512: ${sha512}\n    size: ${content.length}\n` +
        `path: ${fileName}\nsha512: ${sha512}\nreleaseDate: '2026-10-21T00:00:00.000Z'\n`,
      [fileName]: content,
      latest: JSON.stringify({ tag_name: `v${NEW_VERSION}`, name: 'Click here', html_url: 'https://evil.example/' }),
    })
    const updateConfig = join(root, 'app-update.yml')
    writeFileSync(updateConfig, `provider: generic\nurl: ${base}/${name}/\nupdaterCacheDirName: spekterm-probe-updater\n`)

    const profile = mkTemp('spekterm-update-profile-')
    seedLanguage(profile)
    if (!autoCheck) {
      const preferences = JSON.parse(readFileSync(join(profile, 'preferences.json'), 'utf8'))
      writeFileSync(join(profile, 'preferences.json'), JSON.stringify({ ...preferences, updates: { autoUpdateCheck: false } }))
    }
    writeFileSync(
      join(profile, 'workspace.json'),
      JSON.stringify({ version: 1, folders: [{ id: 'f-update', path: folder, addedAt: '2026-10-21T00:00:00.000Z' }] }),
    )
    writeFileSync(
      join(profile, 'update-feed.json'),
      JSON.stringify(
        telling
          ? { releaseApiUrl: `${base}/${name}/latest`, firstDelayMs: 500 }
          : { updateConfigPath: updateConfig, firstDelayMs: 500 },
      ),
    )
    const env = { ...process.env, XDG_CACHE_HOME: cache }
    delete env.APPDIR
    delete env.ARGV0
    delete env.OWD
    if (telling) delete env.APPIMAGE
    else env.APPIMAGE = appImage
    const markers = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [])
    const closeStub = join(profile, 'close-stub')
    const notifyStub = join(profile, 'update-notify-stub')
    const dialogs = () => {
      try {
        return readFileSync(join(closeStub, 'dialogs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch {
        return []
      }
    }
    const notifications = () => {
      try {
        return readFileSync(join(notifyStub, 'notifications.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch {
        return []
      }
    }
    return {
      appImage,
      profile,
      env,
      markers,
      dialogs,
      notifications,
      oldHash: sha256(appImage),
      newHash: createHash('sha256').update(content).digest('hex'),
      answer: (role) => {
        mkdirSync(closeStub, { recursive: true })
        writeFileSync(join(closeStub, 'answer'), role)
      },
      closeWindow: () => writeFileSync(join(closeStub, 'close'), String(Date.now())),
      activateNotification: () => writeFileSync(join(notifyStub, 'trigger'), String(Date.now())),
    }
  }

  async function launch(setup) {
    const child = spawn(
      'electron',
      [`--remote-debugging-port=${port}`, `--user-data-dir=${setup.profile}`, ...electronExtraArgs(), '.'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: setup.env },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
    const client = await connectToApp(port)
    const mounted = await awaitMounted(client, { expression: MOUNTED })
    return {
      client,
      mounted,
      stderr: () => stderr,
      waitForExit: (timeoutMs) => Promise.race([exited, sleep(timeoutMs).then(() => false)]),
      async close() {
        client.close()
        await quitAndWait(child)
      },
    }
  }

  const statusIs = (client, text, timeoutMs = 20_000) =>
    pollFor({
      read: () => client.evaluate(STATUS_TEXT),
      settled: (value) => value === text,
      timeoutMs,
      label: `the update status reads "${text}"`,
    })
  const readyText = copy('update.status.ready', { version: NEW_VERSION })

  let app = null
  try {
    // ── Without a probe's feed an unpackaged build has no update check at all: no answer, no controls, no request.
    const none = sectionSetup('none')
    rmSync(join(none.profile, 'update-feed.json'))
    app = await launch(none)
    await openSettings(app.client, 'about')
    await sleep(3_000)
    const noView = await app.client.evaluate('window.workspace.update.get()')
    const noBlock = await app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(UPDATE_SECTION)}))`)
    check(results, 'update: an unpackaged build without a probe feed checks nothing and shows no update controls',
      noView === null && noBlock === false && requestsFor('none') === 0,
      `view=${JSON.stringify(noView)} block=${noBlock} requests=${requestsFor('none')}`)
    await app.close()
    app = null

    // ── Downloads, notifies once, asks before a restart, Cancel leaves everything, the notification opens About.
    const one = sectionSetup('restart')
    app = await launch(one)
    check(results, 'update: the app starts with a probe feed', app.mounted?.ok === true, describeMounted(app.mounted))
    await openSettings(app.client, 'about')
    let status = await statusIs(app.client, readyText)
    check(results, 'update: a newer release is downloaded and becomes ready (About)', status === readyText, String(status))
    const firstNotifications = await pollFor({
      read: one.notifications,
      settled: (list) => list.length >= 1,
      timeoutMs: 5_000,
      label: 'the update notification',
    })
    check(results, 'update: one notification names the version',
      firstNotifications.length === 1 && JSON.stringify(firstNotifications[0]).includes(NEW_VERSION),
      JSON.stringify(firstNotifications))
    const restoreOffered = await app.client.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(`${SETTINGS_DIALOG} button`)})].some((b) => b.textContent.trim() === ${JSON.stringify(copy('settings.restoreDefaults'))})`,
    )
    check(results, 'update: About, with the update controls, offers no restore of defaults', restoreOffered === false,
      `restore offered=${restoreOffered}`)
    check(results, 'update: About offers Restart to update and no Check now while ready',
      JSON.stringify(await app.client.evaluate(BUTTON_TEXTS)) === JSON.stringify([copy('update.restart')]),
      JSON.stringify(await app.client.evaluate(BUTTON_TEXTS)))

    // A running shell, then Restart → Cancel.
    await closeSettings(app.client)
    await app.client.evaluate(OPEN_SPAWN_MENU('repo-update'))
    await pollFor({ read: () => app.client.evaluate(CLICK_SHELL_ITEM), settled: Boolean, timeoutMs: 5_000, label: 'the shell item' })
    await pollFor({ read: () => app.client.evaluate(SESSION_ROWS), settled: (n) => n === 1, timeoutMs: 10_000, label: 'one session' })
    // The session list reaches the main process by a debounced push.
    await sleep(1_000)
    one.answer('cancel')
    await openSettings(app.client, 'about')
    await clickUpdateButton(app.client, copy('update.restart'))
    const asked = await pollFor({ read: one.dialogs, settled: (list) => list.length >= 1, timeoutMs: 8_000, label: 'the restart dialog' })
    const prompt = asked[0]
    check(results, 'update: Restart to update with a running session asks, in restart words, Cancel the default',
      JSON.stringify(prompt?.roles) === '["quit","cancel"]' && prompt?.defaultRole === 'cancel' &&
        Boolean(prompt?.detail?.includes(copy('closeConfirm.consequenceRestart'))),
      JSON.stringify({ roles: prompt?.roles, defaultRole: prompt?.defaultRole, detail: prompt?.detail }))
    await sleep(1_000)
    check(results, 'update: Cancel leaves the AppImage byte-identical and the session running',
      sha256(one.appImage) === one.oldHash && (await app.client.evaluate(SESSION_ROWS)) === 1 && one.markers().length === 0,
      `same=${sha256(one.appImage) === one.oldHash} sessions=${await app.client.evaluate(SESSION_ROWS)} markers=${one.markers().length}`)

    // The notification opens About, closing the inbox first.
    await closeSettings(app.client)
    await clickSelector(app.client, `nav${label('activityBar.label')} button${label('activityBar.handoffs')}`, 'the Handoffs entry')
    await pollFor({ read: () => app.client.evaluate(INBOX_OPEN), settled: Boolean, timeoutMs: 5_000, label: 'the inbox' })
    one.activateNotification()
    const opened = await pollFor({
      read: () => app.client.evaluate(`({ about: ${ABOUT_SHOWN}, inbox: ${INBOX_OPEN} })`),
      settled: (value) => value.about === true && value.inbox === false,
      timeoutMs: 8_000,
      label: 'About after the notification',
    })
    check(results, 'update: activating the notification opens Settings at About and closes the inbox',
      opened.about === true && opened.inbox === false, JSON.stringify(opened))

    // A signal does not install; the next start finds the download again and does not notify again.
    await app.close()
    check(results, 'update: a quit by SIGTERM with an update ready leaves the AppImage unchanged',
      sha256(one.appImage) === one.oldHash && one.markers().length === 0, `same=${sha256(one.appImage) === one.oldHash}`)
    app = await launch(one)
    await openSettings(app.client, 'about')
    status = await statusIs(app.client, readyText)
    await sleep(1_000)
    check(results, 'update: after a restart the cached update is ready again with no second notification',
      status === readyText && one.notifications().length === 1, `status=${status} notifications=${one.notifications().length}`)

    // Restart → Restart: the file is replaced and the new version runs, once.
    one.answer('quit')
    await sleep(1_000)
    await clickUpdateButton(app.client, copy('update.restart'))
    const exited = await app.waitForExit(15_000)
    const markers = await pollFor({ read: one.markers, settled: (list) => list.length >= 1, timeoutMs: 10_000, label: 'the relaunch' })
    await sleep(2_000)
    check(results, 'update: Restart replaces the AppImage and starts the new version exactly once after the exit',
      exited === true && sha256(one.appImage) === one.newHash && JSON.stringify(one.markers()) === JSON.stringify([`new ${NEW_VERSION}`]),
      `exited=${exited} new=${sha256(one.appImage) === one.newHash} markers=${JSON.stringify(markers)}`)
    app = null

    // ── Closing the window installs and starts nothing.
    const two = sectionSetup('quit')
    app = await launch(two)
    await openSettings(app.client, 'about')
    status = await statusIs(app.client, readyText)
    two.closeWindow()
    const quitExited = await app.waitForExit(15_000)
    await sleep(2_000)
    check(results, 'update: closing the window installs the ready update and starts no instance',
      status === readyText && quitExited === true && sha256(two.appImage) === two.newHash && two.markers().length === 0,
      `status=${status} exited=${quitExited} new=${sha256(two.appImage) === two.newHash} markers=${two.markers().length}`)
    app = null

    // ── The switch off: no request; Check now still downloads; closing the window does not install.
    const three = sectionSetup('off', { autoCheck: false })
    app = await launch(three)
    await openSettings(app.client, 'about')
    await sleep(3_000)
    check(results, 'update: with the automatic check off, no request is made past the first check window',
      requestsFor('off') === 0, `${requestsFor('off')} requests`)
    await clickUpdateButton(app.client, copy('update.checkNow'))
    status = await statusIs(app.client, readyText)
    check(results, 'update: Check now checks and downloads with the switch off', status === readyText, String(status))
    three.closeWindow()
    const offExited = await app.waitForExit(15_000)
    await sleep(1_000)
    check(results, 'update: with the switch off, closing the window leaves the AppImage unchanged',
      offExited === true && sha256(three.appImage) === three.oldHash, `exited=${offExited} same=${sha256(three.appImage) === three.oldHash}`)
    app = null

    // ── A download that does not match its checksum is not offered.
    const four = sectionSetup('badsha', { badSha: true })
    app = await launch(four)
    await openSettings(app.client, 'about')
    const failed = copy('update.status.failed', { reason: copy('update.failure.checksum') })
    status = await statusIs(app.client, failed)
    check(results, 'update: a corrupted download fails and no restart is offered',
      status === failed && !(await app.client.evaluate(BUTTON_TEXTS)).includes(copy('update.restart')),
      `status=${status} buttons=${JSON.stringify(await app.client.evaluate(BUTTON_TEXTS))}`)
    await app.close()
    app = null

    // ── A build that cannot install tells, with Download, and keeps none of the release's own text.
    const five = sectionSetup('telling', { telling: true })
    app = await launch(five)
    await openSettings(app.client, 'about')
    const available = copy('update.status.available', { version: NEW_VERSION })
    status = await statusIs(app.client, available)
    const texts = await app.client.evaluate(`document.querySelector(${JSON.stringify(UPDATE_SECTION)})?.textContent ?? ''`)
    check(results, 'update: a build that cannot install shows the version as available, with Download',
      status === available && (await app.client.evaluate(BUTTON_TEXTS)).includes(copy('update.download')) &&
        !texts.includes('Click here') && !texts.includes('evil.example'),
      `status=${status} buttons=${JSON.stringify(await app.client.evaluate(BUTTON_TEXTS))}`)
    await app.close()
    app = null
  } finally {
    if (app) await app.close()
    server.close()
  }
}

/**
 * Run alone while iterating (`probe:workspace` runs it at its end): after `npm run build`,
 * `xvfb-run -a node scripts/probe-workspace-update.mjs`.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { PROBE_PORTS } = await import('./lib/ports.mjs')
  const results = []
  const temps = []
  const mkTemp = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    temps.push(dir)
    return dir
  }
  try {
    await runUpdateSections({ results, port: PROBE_PORTS.workspace.main, mkTemp })
  } finally {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length}`)
  process.exit(results.every(Boolean) ? 0 : 1)
}
