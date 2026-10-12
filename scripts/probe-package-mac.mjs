/**
 * desktop-packaging on macOS: the acceptance of **the bundle inside the dmg**, run on a Mac.
 *
 * The Linux probe (`probe-package.mjs`) cannot be pointed at macOS: it launches through `xvfb-run`,
 * identifies processes by reading `/proc/<pid>/environ`, and finds the AppImage's mount point. None of
 * that exists here. This probe keeps the Linux probe's judgments (renderer, CSP, a real pty that runs a
 * command, the build identity) and reads them through macOS means.
 *
 * ## Two measured facts the probe is shaped around
 *
 * - **`open` passes the caller's environment on** (`man open`: "Opened applications inherit environment
 *   variables just as if you had launched the application directly through its full path"). Launched
 *   from this script's shell, the app would inherit its `PATH` — exactly the substitute for a desktop
 *   launch that `desktop-packaging` forbids. The launch therefore starts from the minimal environment
 *   launchd gives a Finder or Dock launch, and **a control proves it minimal**: `claude` must not
 *   resolve in it, or the agent check below proves nothing.
 * - **`ps -E` does not show another process's environment** on macOS 13 (measured with a marker on
 *   `/bin/sleep`). This run's processes are found by their **arguments** — the unique
 *   `--user-data-dir` — and their descendants by walking parent pids.
 *
 * ## What the probe meets that the Linux probe does not
 *
 * A packaged app never uses the close-dialog or notification stand-ins (`usingThrowawayProfile()` is
 * false when packaged), and an agent session started here may raise macOS privacy prompts naming
 * Spekterm. The agent section therefore runs last.
 *
 * Usage (on a Mac; not through `run-probe.mjs`, which wraps probes in `xvfb-run`):
 *   npm run probe:package:mac
 *   PROBE_PACKAGE_MAC_DMG=<dmg or .app> npm run probe:package:mac   # a trial or control build
 * Exit code 0 means every check passed. A check that could not run is reported as "not run" and fails.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { check, connectToApp, pollFor, pollUntil, retryAction } from './lib/cdp.mjs'
import { copy } from './lib/copy.mjs'
import { menuEvidence } from './lib/menu-evidence.mjs'
import { MOUNTED_WITHOUT_VISIBILITY as MOUNTED, awaitMounted } from './lib/mounted.mjs'
import { PROBE_PORTS } from './lib/ports.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { quitPidAndWait } from './lib/quit.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEBUG_PORT = PROBE_PORTS.packageMac.main
const STARTUP_TIMEOUT_MS = 60_000

/** The minimum macOS the docs state; `Info.plist` must declare the same. */
const MINIMUM_MACOS = '12.0'

/** What a Finder or Dock launch gets from launchd — and nothing of this script's shell. */
function desktopEnvironment() {
  const user = userInfo()
  return {
    HOME: homedir(),
    USER: user.username,
    LOGNAME: user.username,
    SHELL: user.shell || '/bin/zsh',
    TMPDIR: process.env.TMPDIR ?? '/tmp/',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  }
}

function envArgs(env) {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`)
}

// ── the bundle ───────────────────────────────────────────────────────────────

/**
 * The dmg for the declared version — named from `package.json`, as the Linux probe does, never "the
 * newest file". `PROBE_PACKAGE_MAC_DMG` points at any dmg or `.app` (the controls are not release builds).
 */
function findBundleSource() {
  const override = process.env.PROBE_PACKAGE_MAC_DMG
  if (override) return override
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const expected = join(repoRoot, 'release', `Spekterm-${version}-arm64.dmg`)
  return existsSync(expected) ? expected : null
}

/** Copy the app out of the dmg (or take the `.app` as given) into `workDir`; returns the app's path. */
function stageApp(source, workDir) {
  const target = join(workDir, 'Spekterm.app')
  if (source.endsWith('.app')) {
    execFileSync('ditto', [source, target])
    return target
  }
  const mountPoint = join(workDir, 'dmg')
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, source], { stdio: 'ignore' })
  try {
    execFileSync('ditto', [join(mountPoint, 'Spekterm.app'), target])
  } finally {
    execFileSync('hdiutil', ['detach', '-quiet', mountPoint])
  }
  return target
}

// ── processes ────────────────────────────────────────────────────────────────

function processTable() {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }))
}

/** The app's main process: the bundle's own executable, launched with this run's profile. */
function mainProcess(appPath, profileDir) {
  // `ps` may show the real path: macOS's `/var` is a link to `/private/var` (measured: the same run printed
  // either form). Compare against both.
  const executables = [appPath, realpathSync(appPath)].map((path) => join(path, 'Contents', 'MacOS', 'Spekterm'))
  return processTable().find((p) => executables.some((e) => p.command.startsWith(`${e} `)) && p.command.includes(profileDir)) ?? null
}

function descendants(rootPid) {
  const table = processTable()
  const found = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const p of table) {
      if (p.ppid === parent) {
        found.push(p)
        queue.push(p.pid)
      }
    }
  }
  return found
}

// ── page helpers (as in the Linux probe) ─────────────────────────────────────

const RECT_OF = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

const GLOBAL_NEW_SESSION_RECT = RECT_OF(
  `aside[aria-label="${copy('rail.label')}"] [aria-label="${copy('rail.newSessionIn', { name: copy('rail.globalName') })}"]`,
)
const TERMINAL_RECT = RECT_OF(`section[aria-label="${copy('stage.terminal')}"]`)
const SETTINGS_RECT = RECT_OF(
  `nav[aria-label="${copy('activityBar.label')}"] button[aria-label="${copy('activityBar.settings')}"]`,
)
const MENU_ITEM_RECT = (text) => `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const item = [...menu.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(text)}))
  if (!item) return null
  const r = item.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`
const BUILD_IDENTITY = `(() => {
  const s = document.querySelector('[role="group"][aria-label="${copy('settings.about')}"]')
  if (!s) return null
  const text = s.textContent ?? ''
  return {
    text,
    version: text.match(/\\d+\\.\\d+\\.\\d+/)?.[0] ?? null,
    hasCommit: text.includes('${copy('settings.aboutCommit')}'),
    development: text.includes('${copy('settings.aboutDevelopment')}'),
    dirty: text.includes('${copy('settings.aboutDirty')}'),
  }
})()`
const CSP_ARM = `(() => {
  window.__csp = ''
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp = e.originalPolicy || window.__csp
  })
  return true
})()`
const TRIGGER_CSP = `fetch('https://example.com/csp-probe').catch(() => {})`

async function realClick(client, rect) {
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    })
  }
}

async function typeLine(client, text) {
  await client.send('Input.insertText', { text })
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

async function pollDisk(predicate, timeoutMs, label) {
  return pollFor({ read: () => predicate(), settled: (value) => value === true, timeoutMs, label })
}

/** Open a session of the given kind under the global rail item, through the real spawn menu. */
async function spawnGlobalSession(client, itemCopy) {
  let clicked = null
  const item = await retryAction({
    act: async () => {
      const plus = await pollUntil(client, GLOBAL_NEW_SESSION_RECT, (value) => value !== null, 15_000)
      if (!plus) throw new Error('the global rail item has no new-session entry')
      clicked = plus
      await realClick(client, plus)
    },
    read: () => client.evaluate(MENU_ITEM_RECT(itemCopy)),
    settled: (value) => value !== null,
    attemptWindowMs: 6000,
    timeoutMs: 21_000,
    label: `spawn menu (${itemCopy})`,
    evidence: () => menuEvidence(client, { expected: itemCopy, clicked }),
  })
  if (!item) throw new Error(`the spawn menu did not offer ${itemCopy}`)
  await realClick(client, item)
}

// ── UI scripting (System Events) ─────────────────────────────────────────────
//
// The menu's key equivalents are handled by the operating system before the renderer sees a key, which is
// exactly the layer under test — so keys and menu clicks go through System Events, not CDP. That needs the
// Accessibility and Automation permissions for the program this script runs from (an SSH session's is
// `/usr/libexec/sshd-keygen-wrapper`). Without them `osascript` waits two minutes and fails with -1712
// (measured), so the pre-flight asks once, briefly, and the sections that need it report "not run".

function osa(script, timeoutMs = 20_000) {
  const run = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: timeoutMs })
  return { ok: run.status === 0, out: (run.stdout ?? '').trim(), err: (run.stderr ?? '').trim() }
}

const proc = (pid) => `(first process whose unix id is ${pid})`
const listOf = (out) => (out ? out.split(', ').filter((name) => name !== 'missing value') : [])

function uiScriptingAllowed() {
  return osa('tell application "System Events" to get name of first process', 15_000).ok
}

function bringFront(pid) {
  osa(`tell application "System Events" to set frontmost of ${proc(pid)} to true`)
}

/**
 * Press `Cmd+<key>` in the app under test — **only if it is the frontmost app**. A key equivalent goes to
 * whatever is in front; on a machine where the user's own Spekterm is running, a `Cmd+Q` that missed would
 * quit their app and end their sessions. Refusing is the safe failure.
 */
function keystroke(pid, key) {
  bringFront(pid)
  const front = osa('tell application "System Events" to get unix id of first process whose frontmost is true')
  if (!front.ok || Number(front.out) !== pid) {
    throw new Error(`refusing to press Cmd+${key}: the frontmost process is ${front.out || '(unknown)'}, not the app under test (${pid})`)
  }
  return osa(`tell application "System Events" to keystroke "${key}" using {command down}`)
}

/** The names of the items of menu-bar item `index` (1 is the Apple menu, 2 the app menu, 3 Edit). */
function menuItems(pid, index) {
  return listOf(osa(`tell application "System Events" to tell ${proc(pid)} to get name of every menu item of menu 1 of menu bar item ${index} of menu bar 1`).out)
}

function clickMenuItem(pid, index, name) {
  return osa(`tell application "System Events" to tell ${proc(pid)} to click menu item "${name}" of menu 1 of menu bar item ${index} of menu bar 1`)
}

/** The buttons of the sheet the close confirmation shows on the window, or `[]` when none is shown. */
function sheetButtons(pid) {
  return listOf(osa(`tell application "System Events" to tell ${proc(pid)} to get name of every button of sheet 1 of window 1`).out)
}

function clickSheetButton(pid, name) {
  return osa(`tell application "System Events" to tell ${proc(pid)} to click button "${name}" of sheet 1 of window 1`)
}

function clickCloseButton(pid) {
  return osa(`tell application "System Events" to tell ${proc(pid)} to click (first button of window 1 whose subrole is "AXCloseButton")`)
}

function windowCount(pid) {
  const run = osa(`tell application "System Events" to tell ${proc(pid)} to count windows`)
  return run.ok ? Number(run.out) : null
}

/**
 * Send the quit Apple event — what the Dock's Quit and logout send — to this process only.
 * `tell application "<path>" to quit` resolves to the bundle identifier and may reach the user's own running
 * Spekterm instead; `NSRunningApplication.terminate` addresses one process.
 */
function quitAppleEvent(pid) {
  const run = spawnSync('osascript', ['-l', 'JavaScript', '-e',
    `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); app.isNil() ? 'none' : String(app.terminate)`],
  { encoding: 'utf8', timeout: 20_000 })
  return { ok: run.status === 0 && run.stdout.trim() === 'true', out: run.stdout.trim(), err: (run.stderr ?? '').trim() }
}

function setClipboard(text) {
  execFileSync('pbcopy', { input: text })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitExit(pid, timeoutMs = 15_000) {
  return pollFor({ read: () => !alive(pid), settled: (gone) => gone === true, timeoutMs, label: `pid ${pid} to exit` })
}

async function waitSheet(pid, timeoutMs = 8000) {
  return pollFor({ read: () => sheetButtons(pid), settled: (buttons) => buttons.length > 0, timeoutMs, label: 'the close sheet' })
}

// ── the run ──────────────────────────────────────────────────────────────────

const results = []
const workDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'spekterm-package-mac-'))
let appPath = null
const launched = []

/** A section that throws records one failure; a section whose dependency is missing records "not run". */
async function section(name, body, { needs } = {}) {
  console.log(`\n${name}:\n`)
  if (needs && !needs.ok) {
    check(results, `${name} — not run`, false, needs.why)
    return
  }
  try {
    await body()
  } catch (error) {
    check(results, `${name} ran to the end`, false, error.message)
  }
}

/** A plain folder with one file, for the editor; no `openspec/`, so the side panel shows Files. */
function makeFixtureRepo() {
  const repo = join(workDir, 'repo-plain')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'notes.txt'), 'first line\n')
  return repo
}

/**
 * Launch the staged app from a desktop launch's environment with its own profile; returns its main pid and
 * a CDP client. `folders` seeds the workspace the way the other probes do.
 */
async function launch({ folders = [] } = {}) {
  // **One instance at a time.** Every launch uses the same debugging port; a second instance cannot bind
  // it, and the CDP client would silently drive the first one (measured: an agent session opened in the
  // first app while the probe looked for it under the second).
  for (const earlier of launched) {
    if (alive(earlier.pid)) await quitPidAndWait(earlier.pid)
  }
  const profile = mkdtempSync(join(workDir, 'profile-'))
  seedLanguage(profile)
  if (folders.length > 0) {
    writeFileSync(join(profile, 'workspace.json'), JSON.stringify({
      version: 1,
      folders: folders.map(([id, path]) => ({ id, path, addedAt: '2026-10-08T00:00:00.000Z' })),
    }))
  }
  execFileSync('env', ['-i', ...envArgs(desktopEnvironment()), 'open', '-n', '-a', appPath, '--args',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`])
  const client = await connectToApp(DEBUG_PORT, { targetTimeoutMs: STARTUP_TIMEOUT_MS })
  const pid = (await pollFor({
    read: () => mainProcess(appPath, profile),
    settled: (value) => value !== null,
    timeoutMs: 10_000,
    label: 'the app\'s main process',
  }))?.pid ?? null
  if (!pid) throw new Error('the app\'s main process was not found by its profile argument')
  launched.push({ pid, profile })
  await awaitMounted(client, { expression: MOUNTED })
  return { client, pid, profile }
}

/**
 * A pty's shell: the shell with at most `-l` / `-i` flags. **Not one with `-c`** — the app's own query of the
 * user's environment runs `zsh -i -l -c …` as its child too, and once counted as "the new shell" (measured).
 */
const isShell = (p) => /(^|\/)-?(zsh|bash|sh)(\s+-[il]+)*\s*$/.test(p.command)

/** A new shell session under the global item; resolves with its pid once its shell answers a command. */
async function openShell(client, pid) {
  const before = new Set(descendants(pid).filter(isShell).map((p) => p.pid))
  await spawnGlobalSession(client, copy('sessions.spawnShell'))
  const fresh = await pollFor({
    read: () => descendants(pid).filter((p) => isShell(p) && !before.has(p.pid)),
    settled: (list) => list.length > 0,
    timeoutMs: 20_000,
    label: 'a new shell among the app\'s descendants',
  })
  const terminal = await pollUntil(client, TERMINAL_RECT, (value) => value !== null, 6000)
  if (terminal) await realClick(client, terminal)
  // Wait until the shell runs commands — the user's rc may still be starting (see the pty section).
  const ready = join(workDir, `ready-${Date.now()}`)
  await retryAction({
    act: () => typeLine(client, `touch ${ready}`),
    read: () => existsSync(ready),
    settled: (value) => value === true,
    attemptWindowMs: 3000,
    timeoutMs: 20_000,
    label: 'the new shell answers',
  })
  return fresh[0]?.pid ?? null
}

const EDITOR_TEXT = `document.querySelector('.monaco-editor .view-lines')?.innerText.replace(/\\u00a0/g, ' ') ?? null`
const FOCUS_EDITOR = `(() => {
  const textarea = document.querySelector('.monaco-editor textarea')
  if (!textarea) return false
  textarea.focus()
  return document.activeElement === textarea
})()`
const SELECT_FOLDER = (name) => `(() => {
  const row = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] div[role="button"]')]
    .find((el) => el.innerText.includes(${JSON.stringify(name)}))
  if (!row) return false
  row.click()
  return true
})()`
const CLICK_ROW = (relPath) => `(() => {
  const row = document.querySelector('[role="treeitem"][title=${JSON.stringify(relPath)}]')
  if (!row) return false
  row.click()
  return true
})()`
const TAB_RECT = RECT_OF(`[aria-label="${copy('sessions.tabs')}"] [role="tab"]`)
const RENAME_INPUT = `document.querySelector('[aria-label="${copy('sessions.nameLabel')}"]')`

/** Open `notes.txt` of the fixture repo in the editor and put the caret in it. */
async function openFixtureFile(client) {
  await pollUntil(client, SELECT_FOLDER('repo-plain'), (ok) => ok === true, 10_000)
  await pollUntil(client, CLICK_ROW('notes.txt'), (ok) => ok === true, 10_000)
  await pollUntil(client, EDITOR_TEXT, (text) => Boolean(text), 10_000)
  await client.evaluate(FOCUS_EDITOR)
}

const occurrences = (text, word) => (text ?? '').split(word).length - 1

console.log('desktop-packaging on macOS:')

if (process.platform !== 'darwin') {
  console.error('This probe runs on macOS only (it checks the bundle inside the dmg).')
  process.exit(1)
}

try {
  const source = findBundleSource()
  if (!source) throw new Error('no dmg for the declared version — run `npm run dist:mac`, or set PROBE_PACKAGE_MAC_DMG')
  console.log(`  bundle: ${source}`)
  appPath = stageApp(source, workDir)

  await section('The bundle', async () => {
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' })
    check(results, 'the dmg\'s copy verifies strictly and in depth', verify.status === 0,
      verify.status === 0 ? 'valid' : verify.stderr.trim().split('\n').at(-1))

    const resources = join(appPath, 'Contents', 'Resources')
    check(results, 'no placeholder application ships', !existsSync(join(resources, 'default_app.asar')),
      join('Contents', 'Resources', 'default_app.asar'))

    const shipped = readFileSync(join(resources, 'LICENSE'), { flag: 'r' })
    check(results, 'the bundle\'s LICENSE is byte-identical to version control',
      shipped.equals(readFileSync(join(repoRoot, 'LICENSE'))), `${shipped.length} bytes`)
    const licences = ['THIRD_PARTY_LICENSES.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html']
    const missing = licences.filter((name) => !existsSync(join(resources, name)))
    check(results, 'Contents/Resources carries the third-party summary and Electron\'s and Chromium\'s licences',
      missing.length === 0, `missing: ${missing.join(', ') || 'none'}`)
    const atTop = readdirSync(join(appPath, 'Contents')).filter((name) => /licen[cs]e/i.test(name))
    check(results, 'the top of Contents/ holds no licence file', atTop.length === 0, atTop.join(', ') || 'none')

    const minimum = execFileSync('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
    check(results, `the bundle declares macOS ${MINIMUM_MACOS} as its minimum, as the docs state`,
      minimum === MINIMUM_MACOS, `LSMinimumSystemVersion=${minimum}`)
  })

  // The control for the launch environment: if `claude` resolves here, the agent check proves nothing.
  const resolvesHere = spawnSync('env', ['-i', ...envArgs(desktopEnvironment()), '/bin/sh', '-c', 'command -v claude'], { encoding: 'utf8' })
  check(results, 'the launch environment is minimal: claude does not resolve in it',
    resolvesHere.stdout.trim() === '', resolvesHere.stdout.trim() || 'not found, as intended')

  const repo = makeFixtureRepo()
  const first = await launch({ folders: [['fixture-plain', repo]] })
  const { client, pid: mainPid } = first

  await section('The renderer and the policy', async () => {
    const title = await pollUntil(client, 'document.title', (value) => Boolean(value))
    check(results, 'the dmg\'s copy opens its window and loads the renderer', title === 'spekterm', `title="${title}"`)
    await client.evaluate(CSP_ARM)
    await client.evaluate(TRIGGER_CSP)
    const policy = String(await pollUntil(client, 'window.__csp ?? ""', (value) => Boolean(value), 8000))
    const scriptSrc = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'))
    check(results, 'the renderer receives the production policy',
      scriptSrc === "script-src 'self'" && !policy.includes('ws:'), `script-src="${scriptSrc ?? '(missing)'}"`)
  })

  let shellPid = null
  await section('A pty in the dmg\'s copy', async () => {
    const before = new Set(descendants(mainPid).filter(isShell).map((p) => p.pid))
    await spawnGlobalSession(client, copy('sessions.spawnShell'))
    const fresh = await pollFor({
      read: () => descendants(mainPid).filter((p) => isShell(p) && !before.has(p.pid)),
      settled: (list) => list.length > 0,
      timeoutMs: 20_000,
      label: 'a new shell among the app\'s descendants',
    })
    shellPid = fresh[0]?.pid ?? null
    check(results, 'a shell session creates a real pty process among the app\'s descendants', fresh.length > 0,
      fresh.map((p) => `${p.pid} ${p.command}`).join('; ') || 'no new shell')

    const terminal = await pollUntil(client, TERMINAL_RECT, (value) => value !== null, 6000)
    if (terminal) await realClick(client, terminal)
    /**
     * **Sent again until it shows** — the user's own shell (zsh with their rc, as a desktop launch gets it)
     * may still be starting when the first line arrives, and a line typed then is lost (measured: the
     * first line vanished, the second ran). Re-sending is safe: the command writes the same file each time.
     * The judgment is unchanged — a side effect on disk, which echo alone never produces.
     */
    const marker = `spekterm-mac-${process.pid}-${Date.now()}`
    const witness = join(workDir, 'pty-witness.txt')
    const ran = await retryAction({
      act: () => typeLine(client, `printf %s ${marker} > ${witness}`),
      read: () => existsSync(witness) && readFileSync(witness, 'utf8') === marker,
      settled: (value) => value === true,
      attemptWindowMs: 3000,
      timeoutMs: 20_000,
      label: 'the pty witness',
    })
    check(results, 'the shell ran the command sent to it', ran === true, ran ? witness : 'no side effect')

    const resolved = join(workDir, 'claude-path.txt')
    await typeLine(client, `command -v claude > ${resolved}`)
    const found = await pollDisk(() => existsSync(resolved) && readFileSync(resolved, 'utf8').trim() !== '', 10_000, 'claude resolved in the session')
    check(results, 'a session of the desktop-launched app resolves claude', found,
      found ? readFileSync(resolved, 'utf8').trim() : 'command -v claude printed nothing')
  })

  await section('The build identity', async () => {
    const settingsAt = await pollUntil(client, SETTINGS_RECT, (value) => value !== null, 6000)
    if (settingsAt) await realClick(client, settingsAt)
    const identity = await pollUntil(client, BUILD_IDENTITY, (value) => value !== null, 6000)
    const declared = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
    const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    check(results, 'Settings shows the version of the dmg\'s file name, the release commit, and a clean tree',
      identity?.version === declared && identity.text.includes(head) && identity.dirty === false && identity.development === false,
      JSON.stringify({ declared, head, identity }))
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  })

  // ── what needs UI scripting ─────────────────────────────────────────────────
  const scripting = uiScriptingAllowed()
    ? { ok: true }
    : { ok: false, why: 'System Events is not allowed: grant Accessibility and Automation to the program this runs from (docs/lessons/macos.md)' }

  await section('The macOS menu', async () => {
    const app = menuItems(mainPid, 2)
    const edit = menuItems(mainPid, 3)
    const appExpected = ['appMenu.about', 'appMenu.hide', 'appMenu.hideOthers', 'appMenu.showAll', 'appMenu.quit']
      .map((key) => copy(key, { name: 'Spekterm' }))
    const editExpected = ['appMenu.undo', 'appMenu.redo', 'appMenu.cut', 'appMenu.copy', 'appMenu.paste', 'appMenu.selectAll']
      .map((key) => copy(key))
    // macOS adds its own items to a menu named Edit (dictation, emoji); they are the system's, not ours.
    // They come in the system's language, not the app's (the build Mac's is Traditional Chinese).
    const SYSTEM_EDIT_ITEMS = /^(Start Dictation|Emoji & Symbols|AutoFill|Writing Tools|啟動聽寫|表情符號和其他符號|自動填寫|書寫工具)/
    const extra = [...app.filter((n) => !appExpected.includes(n)), ...edit.filter((n) => !editExpected.includes(n) && !SYSTEM_EDIT_ITEMS.test(n))]
    check(results, 'the menu holds the application menu and the Edit menu with exactly the defined items',
      appExpected.every((n) => app.includes(n)) && editExpected.every((n) => edit.includes(n)) && extra.length === 0,
      JSON.stringify({ app, edit, extra }))
    // Each menu's key equivalents, read one menu at a time: a query that fails must fail the check, not
    // return an empty list that would pass it.
    const cmdChars = []
    for (const index of [2, 3]) {
      const read = osa(`tell application "System Events" to tell ${proc(mainPid)} to get value of attribute "AXMenuItemCmdChar" of every menu item of menu 1 of menu bar item ${index} of menu bar 1`)
      if (!read.ok) throw new Error(`reading the key equivalents of menu ${index} failed: ${read.err}`)
      cmdChars.push(...listOf(read.out))
    }
    check(results, 'no menu item is bound to Cmd+W', cmdChars.length > 0 && !cmdChars.includes('W'),
      `key equivalents: ${cmdChars.join(' ') || '(none read)'}`)

    await client.evaluate(`window.workspace.settings.setLanguage('zh-TW')`, { awaitPromise: true })
    const translated = await pollFor({
      read: () => menuItems(mainPid, 3),
      settled: (names) => names.includes('貼上'),
      timeoutMs: 5000,
      label: 'the Edit menu in zh-TW',
    })
    check(results, 'the menu follows the UI language without a restart', translated.includes('貼上'), JSON.stringify(translated))
    await client.evaluate(`window.workspace.settings.setLanguage('en')`, { awaitPromise: true })
  }, { needs: scripting })

  await section('Copy and paste in a text field', async () => {
    const tab = await pollUntil(client, TAB_RECT, (value) => value !== null, 6000)
    const x = Math.round(tab.x + tab.width / 2)
    const y = Math.round(tab.y + tab.height / 2)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 })
    }
    await realClick(client, await pollUntil(client, MENU_ITEM_RECT(copy('sessions.rename')), (value) => value !== null, 4000))
    await pollUntil(client, `${RENAME_INPUT} !== null`, (value) => value === true, 4000)
    await client.send('Input.insertText', { text: 'alpha' })
    setClipboard('stale')
    keystroke(mainPid, 'a')
    const selected = await pollUntil(client, `(() => { const el = ${RENAME_INPUT}; return el ? el.selectionEnd - el.selectionStart : -1 })()`,
      (n) => n === 5, 3000)
    keystroke(mainPid, 'c')
    const copied = await pollFor({
      read: () => execFileSync('pbpaste', { encoding: 'utf8' }),
      settled: (text) => text === 'alpha',
      timeoutMs: 3000,
      label: 'the clipboard after Cmd+C',
    })
    await client.evaluate(`(() => { const el = ${RENAME_INPUT}; el.setSelectionRange(el.value.length, el.value.length); return true })()`)
    keystroke(mainPid, 'v')
    const value = await pollUntil(client, `${RENAME_INPUT}?.value ?? null`, (v) => v !== 'alpha', 3000)
    check(results, 'Cmd+A, Cmd+C and Cmd+V work in a text field, and paste once', value === 'alphaalpha',
      `value="${value}"; selected after Cmd+A=${selected}; clipboard after Cmd+C=${JSON.stringify(copied)}`)
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }, { needs: scripting })

  await section('Paste in the terminal', async () => {
    const terminal = await pollUntil(client, TERMINAL_RECT, (value) => value !== null, 6000)
    if (terminal) await realClick(client, terminal)
    const witness = join(workDir, 'paste-witness.txt')
    setClipboard(`printf %s P >> ${witness}`)
    keystroke(mainPid, 'v')
    // **Enter again until the line runs.** A System Events keystroke is delivered asynchronously, and the
    // terminal pastes through a round trip to the main process; on a loaded Mac the text arrived after an
    // immediate Enter and sat unexecuted (measured on macOS 27 right after its update). An empty Enter is
    // harmless, and a doubled paste still shows: it is one line, `P%sP`.
    const written = await retryAction({
      act: () => typeLine(client, ''),
      read: () => existsSync(witness),
      settled: (value) => value === true,
      attemptWindowMs: 2000,
      timeoutMs: 15_000,
      label: 'the pasted command ran',
    })
    const content = written ? readFileSync(witness, 'utf8') : null
    check(results, 'Cmd+V in the terminal pastes once', content === 'P',
      `content=${JSON.stringify(content)} (pasted twice, the line runs as one command and writes "P%sP")`)
  }, { needs: scripting })

  await section('Paste in the editor', async () => {
    await openFixtureFile(client)
    setClipboard('PASTEWORD')
    keystroke(mainPid, 'v')
    const text = await pollUntil(client, EDITOR_TEXT, (t) => occurrences(t, 'PASTEWORD') > 0, 5000)
    check(results, 'Cmd+V in the editor pastes once', occurrences(text, 'PASTEWORD') === 1,
      `${occurrences(text, 'PASTEWORD')} occurrence(s)`)
  }, { needs: scripting })

  // From here the file is unsaved and a shell runs: the close confirmation has both to ask about.
  await section('Cmd+Q asks, and cancel keeps everything', async () => {
    for (const where of ['editor', 'terminal']) {
      if (where === 'editor') await client.evaluate(FOCUS_EDITOR)
      else await realClick(client, await pollUntil(client, TERMINAL_RECT, (value) => value !== null, 6000))
      keystroke(mainPid, 'q')
      const buttons = await waitSheet(mainPid)
      // The question must be the one that names the running session, not only the unsaved file: with the
      // Quit role, Cmd+Q went through before-quit first and asked about the file alone (measured on the
      // pre-change build, where a check for "a Cancel button" passed).
      check(results, `Cmd+Q with focus in the ${where} asks before quitting`,
        buttons.includes(copy('closeConfirm.quitWithoutSaving')) && buttons.includes(copy('closeConfirm.cancel')),
        JSON.stringify(buttons))
      clickSheetButton(mainPid, copy('closeConfirm.cancel'))
      await pollFor({ read: () => sheetButtons(mainPid), settled: (b) => b.length === 0, timeoutMs: 5000, label: 'the sheet closes' })
    }
    check(results, 'cancelling keeps the app, the window and the same shell process',
      alive(mainPid) && windowCount(mainPid) === 1 && shellPid !== null && alive(shellPid),
      `app=${alive(mainPid)} windows=${windowCount(mainPid)} shell=${shellPid}:${shellPid !== null && alive(shellPid)}`)
  }, { needs: scripting })

  await section('Closing the window keeps the application; activating it reopens', async () => {
    clickCloseButton(mainPid)
    const buttons = await waitSheet(mainPid)
    check(results, 'on macOS the close dialog speaks of the window, not of quitting',
      buttons.includes(copy('closeConfirm.closeWithoutSaving')) && !buttons.includes(copy('closeConfirm.quitWithoutSaving')),
      JSON.stringify(buttons))
    clickSheetButton(mainPid, copy('closeConfirm.closeWithoutSaving'))
    const closed = await pollFor({ read: () => windowCount(mainPid), settled: (n) => n === 0, timeoutMs: 8000, label: 'the window closes' })
    check(results, 'after confirming, the sessions end and the application keeps running with no window (also after a cancelled Cmd+Q)',
      closed === 0 && alive(mainPid) && !(shellPid !== null && alive(shellPid)),
      `windows=${closed} app=${alive(mainPid)} shell gone=${!(shellPid !== null && alive(shellPid))}`)

    execFileSync('open', ['-a', appPath])
    const reopened = await pollFor({ read: () => windowCount(mainPid), settled: (n) => n === 1, timeoutMs: 15_000, label: 'the window reopens' })
    const shells = descendants(mainPid).filter(isShell)
    const persisted = JSON.parse(readFileSync(join(first.profile, 'sessions.json'), 'utf8'))
    const count = persisted.sessions?.length ?? 0
    check(results, 'activating the application opens a window whose sessions are dormant',
      reopened === 1 && shells.length === 0 && count > 0, `windows=${reopened} live shells=${shells.length} persisted=${count}`)
    const appMenu = menuItems(mainPid, 2)
    check(results, 'the second window still has the menu (Quit and Edit)',
      appMenu.includes(copy('appMenu.quit', { name: 'Spekterm' })) && menuItems(mainPid, 3).includes(copy('appMenu.paste')),
      JSON.stringify(appMenu))
  }, { needs: scripting })

  await section('A quit during the open dialog finishes when answered', async () => {
    const reconnected = await connectToApp(DEBUG_PORT, { targetTimeoutMs: 20_000 })
    await awaitMounted(reconnected, { expression: MOUNTED })
    await openShell(reconnected, mainPid)
    clickCloseButton(mainPid)
    await waitSheet(mainPid)
    const quitItem = copy('appMenu.quit', { name: 'Spekterm' })
    const enabled = osa(`tell application "System Events" to tell ${proc(mainPid)} to get enabled of menu item "${quitItem}" of menu 1 of menu bar item 2 of menu bar 1`).out
    keystroke(mainPid, 'q')
    const sheetAfterKey = sheetButtons(mainPid)
    clickSheetButton(mainPid, copy('closeConfirm.closeWindow'))
    const gone = await waitExit(mainPid)
    check(results, 'Cmd+Q pressed while the close dialog is open, then answering close, quits the application', gone === true,
      `exited=${gone}; Quit item enabled while the sheet is open=${enabled}; sheet after Cmd+Q=${JSON.stringify(sheetAfterKey)}`)
    reconnected.close()
  }, { needs: scripting })

  await section('Cmd+Q with nothing to ask quits at once', async () => {
    const { client: c, pid } = await launch()
    keystroke(pid, 'q')
    const gone = await waitExit(pid)
    check(results, 'Cmd+Q with no running session and nothing unsaved quits without a dialog', gone === true, `exited=${gone}`)
    c.close()
  }, { needs: scripting })

  await section('Quit with no window quits at once', async () => {
    const { client: c, pid } = await launch()
    clickCloseButton(pid)
    await pollFor({ read: () => windowCount(pid), settled: (n) => n === 0, timeoutMs: 8000, label: 'the window closes' })
    clickMenuItem(pid, 2, copy('appMenu.quit', { name: 'Spekterm' }))
    const gone = await waitExit(pid)
    check(results, 'Quit from the menu with no window quits', gone === true, `exited=${gone}`)
    c.close()
  }, { needs: scripting })

  // The quit Apple event — what the Dock's Quit and logout send. Needs Automation for the app itself.
  await section('A quit request from the operating system', async () => {
    {
      const { client: c, pid } = await launch()
      await openShell(c, pid)
      quitAppleEvent(pid)
      const gone = await waitExit(pid)
      check(results, 'an OS quit with a running session asks nothing and exits', gone === true && sheetButtons(pid).length === 0,
        `exited=${gone}`)
      c.close()
    }
    {
      const { client: c, pid } = await launch({ folders: [['fixture-plain', repo]] })
      await openFixtureFile(c)
      await c.send('Input.insertText', { text: 'UNSAVED ' })
      quitAppleEvent(pid)
      const buttons = await waitSheet(pid)
      check(results, 'an OS quit with an unsaved file asks about the file', buttons.includes(copy('unsaved.discard')),
        JSON.stringify(buttons))
      clickSheetButton(pid, copy('unsaved.discard'))
      const gone = await waitExit(pid)
      check(results, 'answering "don\'t save" finishes the quit', gone === true, `exited=${gone}`)
      c.close()
    }
  }, { needs: scripting })

  // Last: a real `claude` may raise macOS privacy prompts naming Spekterm and take focus.
  await section('An agent session from a desktop launch', async () => {
    const { client: c, pid } = await launch()
    await spawnGlobalSession(c, copy('sessions.spawnClaude'))
    const agent = await pollFor({
      read: () => descendants(pid).find((p) => /(^|\/)claude(\s|$)/.test(p.command)) ?? null,
      settled: (value) => value !== null,
      timeoutMs: 20_000,
      label: 'a claude process among the app\'s descendants',
    })
    check(results, 'an agent session starts claude from a desktop launch', agent !== null,
      agent ? agent.command.slice(0, 120)
        : `no claude process; descendants: ${descendants(pid).map((p) => p.command.slice(0, 80)).join(' | ')}`)
    c.close()
  })

  client.close()
} catch (error) {
  console.error(`\nprobe failed: ${error.message}`)
  results.push(false)
} finally {
  for (const { pid, profile } of launched) {
    if (alive(pid)) await quitPidAndWait(pid)
    // Every helper and pty carries the profile in its arguments.
    spawnSync('pkill', ['-9', '-f', profile], { stdio: 'ignore' })
  }
  await sleep(300)
  rmSync(workDir, { recursive: true, force: true })
}

const passed = results.filter(Boolean).length
console.log(`\n${passed === results.length ? 'All passed' : 'FAILED'} (${passed}/${results.length})`)
process.exit(passed === results.length ? 0 : 1)
