/**
 * remote-access / remote-protocol / remote-notifications / session-hibernation's watched rule
 * (`mobile-remote-bridge`).
 *
 * **The probe is the phone.** It talks to the real listener through `lib/remote-client.mjs`, which pins the
 * certificate by its fingerprint exactly as the Android app must, and it pairs with the code the dialog shows —
 * read from the dialog's link field, driven with real mouse events. Nothing is seeded that a user could not
 * have: `workspace.json`, `preferences.json`, and `remote.json`'s on/off and port.
 *
 * **Listener ports come from `lib/ports.mjs` and are never the product default 47615**: a maintainer's own
 * Spekterm with remote access on holds that one, and the probe would talk to it.
 *
 * Every section launches its own app on its own throwaway profile, so `PROBE_ONLY` runs one alone.
 *
 * What it cannot see, written down rather than left as a false green:
 * - a phone's TLS stack (Conscrypt) accepting the certificate — the Android work checks it on a device;
 * - the window having focus when the virtual display gives it none — `runAttention` checks first and records
 *   the gap; the unit test with the focus source injected carries the rule.
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { check, connectToApp, pollFor, pressKey, retryAction } from './lib/cdp.mjs'
import { copy, label } from './lib/copy.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { awaitMounted } from './lib/mounted.mjs'
import { PROBE_PORTS, STUB_PORTS } from './lib/ports.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { helloRemote, openRemote, pairRemote, parsePairingLink } from './lib/remote-client.mjs'
import { runSections } from './lib/sections.mjs'
import { showSection } from './lib/settings.mjs'
import { makeStubAgent } from './lib/stub-agent.mjs'

const PORT = PROBE_PORTS.remote.main
const RESTART_PORT = PROBE_PORTS.remote.restart
const LISTEN_A = STUB_PORTS.remoteListener
const LISTEN_B = STUB_PORTS.remoteListenerAlt
const PROFILE_PREFIX = 'spekterm-remote-profile-'

const results = []
const temps = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The credential a pairing answer carries — and only that (the answer also names the chosen protocol). */
const credentialOf = (r) => ({ deviceId: r?.deviceId, deviceSecret: r?.deviceSecret })

function mkTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

/** Three folders: F (with an OpenSpec change), G, and E (stays empty of sessions). */
function makeRepos() {
  const f = mkTemp('spekterm-remote-repo-f-')
  const g = mkTemp('spekterm-remote-repo-g-')
  const e = mkTemp('spekterm-remote-repo-e-')
  mkdirSync(join(f, 'openspec', 'changes', 'add-thing'), { recursive: true })
  writeFileSync(join(f, 'openspec', 'changes', 'add-thing', 'proposal.md'), '# Add thing\n\nREMOTE-PROPOSAL-MARKER\n')
  mkdirSync(join(f, 'openspec', 'specs', 'thing'), { recursive: true })
  writeFileSync(join(f, 'openspec', 'specs', 'thing', 'spec.md'), '# thing\n\n### Requirement: A thing\n\nIt SHALL be.\n')
  return { f, g, e, names: { f: basename(f), g: basename(g), e: basename(e) } }
}

function seedProfile(repos, { remote, preferences, extraFolders = [] } = {}) {
  const profile = mkTemp(PROFILE_PREFIX)
  writeFileSync(
    join(profile, 'workspace.json'),
    JSON.stringify({
      version: 1,
      folders: [
        { id: 'f', path: repos.f, addedAt: '2026-10-13T00:00:00.000Z' },
        { id: 'g', path: repos.g, addedAt: '2026-10-13T00:00:01.000Z' },
        { id: 'e', path: repos.e, addedAt: '2026-10-13T00:00:02.000Z' },
        ...extraFolders,
      ],
    }),
  )
  if (remote) writeFileSync(join(profile, 'remote.json'), JSON.stringify({ version: 1, remote: { devices: [], ...remote } }))
  if (preferences) writeFileSync(join(profile, 'preferences.json'), JSON.stringify({ version: 1, ui: { language: 'en' }, ...preferences }))
  return profile
}

async function launch({ profile, stub, configDir, port = PORT }) {
  seedLanguage(profile)
  const child = spawn('electron', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...electronExtraArgs(), '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SHELL: '/bin/sh',
      CLAUDE_CONFIG_DIR: configDir,
      HOME: stub.home,
      PATH: `${stub.bin}:${process.env.PATH}`,
    },
  })
  let output = ''
  let closing = false
  child.stderr?.on('data', (chunk) => (output += chunk))
  child.stdout?.on('data', (chunk) => (output += chunk))
  // An app that ends on its own mid-section is the finding; say so with its last words.
  child.on('exit', (code, signal) => {
    if (!closing) console.log(`  (the app exited by itself: code=${code} signal=${signal})\n${output.slice(-3000)}`)
  })
  const client = await connectToApp(port, { targetTimeoutMs: 30_000 })
  await awaitMounted(client)
  return {
    client,
    profile,
    port,
    output: () => output,
    async close() {
      closing = true
      try {
        await client.close()
      } catch {
        // already gone
      }
      child.kill()
      await sleep(1_200)
    },
  }
}

/** A fresh stub agent and the app on a profile. */
async function start(context, profile, stubOptions = {}, port = PORT) {
  const configDir = mkTemp('spekterm-remote-config-')
  const stub = makeStubAgent(mkTemp, configDir, stubOptions)
  const app = await launch({ profile, stub, configDir, port })
  Object.assign(context, { app, stub, configDir, profile })
  return { app, stub, configDir }
}

// ── Driving the window ──────────────────────────────────────────────────────────────────────────────────────

async function centerOf(client, selector, what) {
  return pollFor({
    read: () =>
      client.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        // A tall dialog scrolls: bring the target on screen before aiming at it.
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
      })()`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: what ?? `element ${selector}`,
  })
}

async function realClick(client, at) {
  const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
}

async function clickSelector(client, selector, what) {
  const at = await centerOf(client, selector, what)
  if (!at) throw new Error(`not on screen: ${what ?? selector}`)
  await realClick(client, at)
}

/** A button inside `scope` by its visible text (for buttons whose label is their text). */
async function clickButtonText(client, scope, text) {
  const at = await pollFor({
    read: () =>
      client.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(scope)})
        const button = [...(root?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
        if (!button) return null
        button.scrollIntoView({ block: 'center' })
        const r = button.getBoundingClientRect()
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
      })()`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: `button "${text}"`,
  })
  if (!at) throw new Error(`no button "${text}"`)
  await realClick(client, at)
}

/** Click a field, select what it holds, type. */
async function typeInto(client, selector, text) {
  await clickSelector(client, selector)
  await client.evaluate(`document.querySelector(${JSON.stringify(selector)})?.select()`)
  await client.send('Input.insertText', { text })
}

const SETTINGS_DIALOG = `[role="dialog"]${label('settings.title')}`
/**
 * The remote access controls: Settings' Remote access section (`settings-sections`). They used to be a dialog of
 * their own; the name `DIALOG` stays for the scope every step below reads and clicks in.
 */
const DIALOG = `${SETTINGS_DIALOG} #settings-panel-remote`
/** The marker on the Remote access entry of Settings' section list while the listener failed to start. */
const REMOTE_FAILED_MARK = `${SETTINGS_DIALOG} #settings-tab-remote ${label('settings.sections.remoteFailed')}`
const ACTIVITY = `nav${label('activityBar.label')}`

const settingsOpen = (app) => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(SETTINGS_DIALOG)}))`)

/** Opens Settings (unless open) on its Remote access section. */
async function openRemoteDialog(app) {
  if (!(await settingsOpen(app))) {
    await clickSelector(app.client, `${ACTIVITY} button${label('activityBar.settings')}`, 'the Settings entry')
  }
  await showSection(app.client, 'remote')
  await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`), settled: Boolean, timeoutMs: 10_000, label: 'the remote access section' })
}

/** Closes Settings with its close control. */
async function closeRemoteDialog(app) {
  await clickSelector(app.client, `${SETTINGS_DIALOG} button${label('common.close')}`, 'the Settings close control')
  await pollFor({ read: () => app.client.evaluate(`!document.querySelector(${JSON.stringify(SETTINGS_DIALOG)})`), settled: Boolean, timeoutMs: 10_000, label: 'Settings closed' })
}

const dialogText = (app) => app.client.evaluate(`document.querySelector(${JSON.stringify(DIALOG)})?.textContent ?? ''`)
const dialogFingerprint = (app) => app.client.evaluate(`document.querySelector(${JSON.stringify(`${DIALOG} p${label('remote.fingerprint')}`)})?.textContent ?? ''`)

async function toggleEnabled(app) {
  await clickSelector(app.client, `${DIALOG} input${label('remote.enable')}`, 'the switch')
}

async function setPortInDialog(app, port) {
  await typeInto(app.client, `${DIALOG} input${label('remote.port')}`, String(port))
  await clickButtonText(app.client, DIALOG, copy('remote.applyPort'))
}

/** Starts pairing in the open dialog and reads the link from its text field. */
async function startPairing(app) {
  await clickButtonText(app.client, DIALOG, copy('remote.pair'))
  const link = await pollFor({
    read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(`${DIALOG} input${label('remote.pairingLink')}`)})?.value ?? ''`),
    settled: (value) => value.startsWith('spekterm://pair'),
    timeoutMs: 10_000,
    label: 'the pairing link',
  })
  return parsePairingLink(link)
}

/** Opens the dialog, pairs a device, closes the dialog. Leaves the pairing connection open. */
async function pairDevice(app, deviceName) {
  await openRemoteDialog(app)
  const link = await startPairing(app)
  const target = { port: link.port, fingerprint: link.fingerprint }
  const { client, response } = await pairRemote(target, { code: link.code, deviceName })
  // A used code ends the pairing view by itself; closing the dialog ends it in any case.
  await closeRemoteDialog(app)
  return { target, client, response, link, credential: credentialOf(response.r) }
}

/** Whether a TCP connection to the port is accepted at all. */
function accepts(port) {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

/** `Ctrl+Shift+H`: hibernate the focused session (`session-hibernation`). */
async function pressHibernate(client) {
  const key = { key: 'H', code: 'KeyH', windowsVirtualKeyCode: 72, nativeVirtualKeyCode: 72, modifiers: 10 }
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

async function call(client, m, p = {}) {
  return client.call(m, p)
}

const SELECTED_FOLDER = `(() => {
  const header = document.querySelector('main[aria-label="${copy('stage.label')}"] header')
  return header ? header.innerText.split('\\n')[0].trim() : null
})()`

const WAKE_FOCUSED = `(document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent === ${JSON.stringify(copy('sessions.wake'))})`

const SELECTED_TAB = `document.querySelector('[role="tablist"][aria-label="${copy('sessions.tabs')}"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null`

/** Where keyboard focus is: in a visible terminal, in the side panel, or elsewhere. */
const FOCUS = `(() => {
  const el = document.activeElement
  if (!el) return 'none'
  const xterm = el.closest('.xterm')
  if (xterm) return xterm.closest('.hidden') ? 'hidden-terminal' : 'terminal'
  if (el.closest('[role="tablist"][aria-label="${copy('panelSwitch.label')}"]')) return 'side-panel'
  return el.tagName.toLowerCase()
})()`

async function selectFolder(app, name) {
  await clickSelector(app.client, `aside[aria-label="${copy('rail.label')}"] [role="button"][aria-label="${name}"]`, `the rail row ${name}`)
  return pollFor({ read: () => app.client.evaluate(SELECTED_FOLDER), settled: (n) => n === name, timeoutMs: 10_000, label: `${name} selected` })
}

/** Puts keyboard focus on a side-panel control: somewhere a stolen focus would leave. */
async function focusSidePanel(app) {
  // An enabled one: a folder without OpenSpec disables that identity, and a disabled button takes no focus.
  await clickSelector(app.client, `[role="tablist"][aria-label="${copy('panelSwitch.label')}"] [role="tab"]:not([disabled])`, 'a side panel control')
  return pollFor({ read: () => app.client.evaluate(FOCUS), settled: (f) => f === 'side-panel', timeoutMs: 5_000, label: 'focus in the side panel' })
}

/** Creates a session from the desktop's own entry. */
async function desktopCreate(app, kind) {
  await clickSelector(app.client, `button${label('sessions.new')}`, 'the new-session entry')
  await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim().toLowerCase().includes(${JSON.stringify(kind)}))
        if (!item) return false
        item.click()
        return true
      })()`),
    settled: Boolean,
    timeoutMs: 10_000,
    label: `the ${kind} menu item`,
  })
}

const persistedSessions = (profile) => {
  try {
    return JSON.parse(readFileSync(join(profile, 'sessions.json'), 'utf8')).sessions ?? []
  } catch {
    return []
  }
}

/** The pty's process for a session, found by its conversation id or a unique marker in its command line. */
function pidsWith(needle) {
  const found = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(needle)) found.push(Number(entry))
    } catch {
      // gone
    }
  }
  return found
}

const cwdOf = (pid) => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/**
 * Sockets of the app's processes that are neither listening nor on the debugging or listener port: what
 * an outbound connection would look like. Reads each process's own network namespace table.
 */
function outboundSockets(profile, excludedPorts) {
  const found = []
  for (const pid of pidsWith(`--user-data-dir=${profile}`)) {
    let inodes
    try {
      inodes = new Set(
        readdirSync(`/proc/${pid}/fd`)
          .map((fd) => {
            try {
              return readlinkSync(`/proc/${pid}/fd/${fd}`)
            } catch {
              return ''
            }
          })
          .map((link) => link.match(/^socket:\[(\d+)\]$/)?.[1])
          .filter(Boolean),
      )
    } catch {
      continue
    }
    for (const table of ['tcp', 'tcp6']) {
      let text
      try {
        text = readFileSync(`/proc/${pid}/net/${table}`, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 10 || !inodes.has(parts[9])) continue
        const state = parts[3]
        if (state === '0A') continue // LISTEN
        const localPort = parseInt(parts[1].split(':').at(-1), 16)
        const remotePort = parseInt(parts[2].split(':').at(-1), 16)
        if (excludedPorts.includes(localPort) || excludedPorts.includes(remotePort)) continue
        found.push(`${pid} ${table} ${parts[1]} → ${parts[2]} st=${state}`)
      }
    }
  }
  return [...new Set(found)]
}

/** Writes an agent event into a session's drop point, as the injected hook would. */
/**
 * The last event file name's nanoseconds. Names are **wall-clock** nanoseconds, as the real hook writes them
 * (`date +%s%N`): a request's time is read from its file name and compared with the time of the session's
 * last keystroke (`remote-answer.ts`). Strictly increasing, so the drain's order is the firing order.
 */
let lastEventNs = 0n

function fireEvent(profile, sessionId, body) {
  const dir = join(profile, 'agent-events', sessionId)
  mkdirSync(dir, { recursive: true })
  const wall = BigInt(Date.now()) * 1_000_000n
  lastEventNs = wall > lastEventNs ? wall : lastEventNs + 1n
  const file = join(dir, `${lastEventNs}-probe.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(body))
  renameSync(`${file}.tmp`, file)
  return file
}

/** The conversation id the main process gave a session (the stub keys its receipts by it). */
async function conversationOf(profile, sessionId) {
  return pollFor({
    read: () => persistedSessions(profile).find((s) => s.id === sessionId)?.claudeSessionId ?? null,
    settled: Boolean,
    timeoutMs: 15_000,
    label: `the conversation id of ${sessionId}`,
  })
}

/** A paired, authenticated client for the section's app (pairs through the dialog). */
async function phone(app, name = 'Probe Phone') {
  const paired = await pairDevice(app, name)
  check(results, `prerequisite: ${name} pairs`, paired.response.ok === true, JSON.stringify(paired.response.e ?? ''))
  return paired
}

async function list(client) {
  const response = await call(client, 'sessions.list')
  return response.r
}

/** Creates a session from the client and waits until it runs. */
async function remoteCreate(client, folderId, target) {
  const response = await call(client, 'sessions.create', { folderId, target })
  return response
}

// ── Sections ───────────────────────────────────────────────────────────────────────────────────────────────

/** remote-access: off by default, on from the dialog, port change, off, restart, listen failure. */
async function runListener(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos)
  const { app } = await start(context, profile)

  const freshA = await accepts(LISTEN_A)
  const freshB = await accepts(LISTEN_B)
  check(results, 'a fresh profile: nothing listens on the listener ports', !freshA && !freshB, `A=${freshA} B=${freshB}`)
  await openRemoteDialog(app)
  const fieldPort = await pollFor({
    read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(`${DIALOG} input${label('remote.port')}`)})?.value ?? null`),
    settled: (value) => value !== null,
    timeoutMs: 10_000,
    label: 'the port field',
  })
  check(results, 'the port defaults to 47615', fieldPort === '47615', `field=${fieldPort}`)
  await setPortInDialog(app, LISTEN_A)
  await toggleEnabled(app)
  const listening = await pollFor({ read: () => dialogText(app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_A })), timeoutMs: 15_000, label: 'listening on A' })
  check(results, 'turning remote access on starts the listener (the dialog says so)', listening.includes(copy('remote.state.listening', { port: LISTEN_A })), '')
  const shown = await dialogFingerprint(app)
  let tlsOk
  try {
    const client = await openRemote({ port: LISTEN_A, fingerprint: shown })
    tlsOk = true
    client.close()
  } catch (error) {
    tlsOk = String(error)
  }
  check(results, 'a TLS connection pinned to the fingerprint the dialog shows succeeds', tlsOk === true, `fingerprint=${shown} ${tlsOk}`)

  await setPortInDialog(app, LISTEN_B)
  await pollFor({ read: () => dialogText(app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_B })), timeoutMs: 15_000, label: 'listening on B' })
  const movedB = await accepts(LISTEN_B)
  const movedA = await accepts(LISTEN_A)
  check(results, 'changing the port moves the listener', movedB && !movedA, `new=${movedB} old=${movedA}`)

  // The port applies through its button or Enter, never on blur (`remote-access`): a typed port that focus left
  // stays unapplied and marked, and the listener does not move. Esc in the field restores the stored port.
  await typeInto(app.client, `${DIALOG} input${label('remote.port')}`, String(LISTEN_A))
  await app.client.evaluate(`document.querySelector(${JSON.stringify(`${DIALOG} input${label('remote.port')}`)})?.blur()`)
  await sleep(500)
  const leftText = await dialogText(app)
  const leftB = await accepts(LISTEN_B)
  const leftA = await accepts(LISTEN_A)
  check(
    results,
    'leaving the port field does not change the port: the old port still listens and the field says it is not applied',
    leftB && !leftA && leftText.includes(copy('remote.portNotApplied')),
    `old=${leftB} typed=${leftA} marked=${leftText.includes(copy('remote.portNotApplied'))}`,
  )
  await clickSelector(app.client, `${DIALOG} input${label('remote.port')}`)
  await pressKey(app.client, 'Escape')
  const restored = await pollFor({
    read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(`${DIALOG} input${label('remote.port')}`)})?.value ?? null`),
    settled: (value) => value === String(LISTEN_B),
    timeoutMs: 5_000,
    label: 'the stored port back in the field',
  }).catch(() => null)
  check(
    results,
    'Esc in the port field restores the stored port and leaves Settings open',
    restored === String(LISTEN_B) && (await settingsOpen(app)),
    `field=${restored}`,
  )
  await closeRemoteDialog(app)

  const paired = await phone(app)
  await openRemoteDialog(app)
  await toggleEnabled(app)
  const closed = await Promise.race([paired.client.closed, sleep(10_000).then(() => null)])
  await sleep(300)
  check(results, 'turning remote access off closes a connected device and releases the port', closed !== null && !(await accepts(LISTEN_B)), `close=${JSON.stringify(closed)}`)
  await toggleEnabled(app)
  await pollFor({ read: () => dialogText(app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_B })), timeoutMs: 15_000, label: 'on again' })
  await closeRemoteDialog(app)
  await app.close()

  const second = await start(context, profile, {}, RESTART_PORT)
  let reconnected
  try {
    const result = await helloRemote(paired.target, paired.credential)
    reconnected = result.response.ok === true
    result.client.close()
  } catch (error) {
    reconnected = String(error)
  }
  check(results, 'on again after a restart, with the same certificate', reconnected === true, String(reconnected))

  const holder = createNetServer()
  await new Promise((resolve) => holder.listen(LISTEN_A, resolve))
  try {
    await openRemoteDialog(second.app)
    await setPortInDialog(second.app, LISTEN_A)
    const conflict = await pollFor({ read: () => dialogText(second.app), settled: (t) => t.includes(copy('remote.state.inUse', { port: LISTEN_A })), timeoutMs: 15_000, label: 'the conflict shown' })
    const line = await second.app.client.evaluate(
      `document.querySelector(${JSON.stringify(`${DIALOG} [role="group"]${label('remote.section.label')}`)})?.textContent ?? ''`,
    )
    // Another section shown: the failure must still be visible, on the section list.
    await showSection(second.app.client, 'about')
    const marked = await pollFor({
      read: () => second.app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(REMOTE_FAILED_MARK)}))`),
      settled: Boolean,
      timeoutMs: 10_000,
      label: 'the section list marks Remote access',
    }).catch(() => false)
    check(
      results,
      'a port in use is stated in the section, its summary does not say it is running, and the section list marks it',
      conflict.includes(copy('remote.state.inUse', { port: LISTEN_A })) &&
        line.includes(copy('remote.state.inUse', { port: LISTEN_A })) &&
        !line.includes(copy('remote.section.on', { devices: 1, connected: 0 })) &&
        marked === true,
      `line=${line} marked=${marked}`,
    )
    await openRemoteDialog(second.app)
    await setPortInDialog(second.app, LISTEN_B)
    const recovered = await pollFor({ read: () => dialogText(second.app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_B })), timeoutMs: 15_000, label: 'recovered' })
    const recoveredAccepts = await accepts(LISTEN_B)
    const unmarked = await pollFor({
      read: () => second.app.client.evaluate(`!document.querySelector(${JSON.stringify(REMOTE_FAILED_MARK)})`),
      settled: Boolean,
      timeoutMs: 10_000,
      label: 'the mark gone',
    }).catch(() => false)
    check(
      results,
      'changing to a free port recovers, and the section list no longer marks it',
      recovered.includes(copy('remote.state.listening', { port: LISTEN_B })) && recoveredAccepts && unmarked === true,
      `accepts=${recoveredAccepts} unmarked=${unmarked}`,
    )
  } finally {
    await new Promise((resolve) => holder.close(resolve))
    await second.app.close()
  }
}

/** A documentation-range host name (`remote-protocol`: the address answers). */
const ADDITIONAL_ADDRESS = 'desk.example.test'

/** remote-access: pairing, credentials, revoke, reset, the renderer's view, a key that went missing. */
async function runPairing(_mode, _config, context) {
  const repos = makeRepos()
  // The additional address is the one entry of the address list the probe controls (the rest are this
  // machine's interfaces), so the answers are checked by it.
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A, additionalAddress: ADDITIONAL_ADDRESS } })
  const { app } = await start(context, profile)

  await openRemoteDialog(app)
  const link = await startPairing(app)
  const target = { port: link.port, fingerprint: link.fingerprint }
  const first = await pairRemote(target, { code: link.code, deviceName: 'Probe Pixel' })
  const listed = await pollFor({ read: () => dialogText(app), settled: (t) => t.includes('Probe Pixel'), timeoutMs: 10_000, label: 'the device listed' })
  check(results, 'a device pairs with the code from the dialog and is listed by name', first.response.ok === true && listed.includes('Probe Pixel'), JSON.stringify(first.response.e ?? ''))
  const again = await pairRemote(target, { code: link.code, deviceName: 'Second Try' }).catch((error) => ({ response: { e: { code: String(error) } } }))
  check(results, 'a pairing code works once', again.response.e?.code === 'PAIRING_FAILED', JSON.stringify(again.response.e))

  const closedLink = await startPairing(app)
  await clickButtonText(app.client, DIALOG, copy('remote.pairDone'))
  await sleep(300)
  const afterClose = await pairRemote(target, { code: closedLink.code, deviceName: 'Late' }).catch((error) => ({ response: { e: { code: String(error) } } }))
  check(results, 'closing the pairing view invalidates its code', afterClose.response.e?.code === 'PAIRING_FAILED', JSON.stringify(afterClose.response.e))

  // Leaving the section ends the pairing view (`remote-access`): its code is refused after a switch to another
  // section, with Settings still open.
  const leftLink = await startPairing(app)
  await showSection(app.client, 'about')
  await sleep(300)
  const afterLeave = await pairRemote(target, { code: leftLink.code, deviceName: 'Left' }).catch((error) => ({ response: { e: { code: String(error) } } }))
  check(results, 'leaving the section invalidates the pairing code', afterLeave.response.e?.code === 'PAIRING_FAILED', JSON.stringify(afterLeave.response.e))
  await openRemoteDialog(app)

  const secret = first.response.r?.deviceSecret ?? '(none)'
  const holders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          if (readFileSync(full).includes(secret)) holders.push(full)
        } catch {
          // unreadable
        }
      }
    }
  }
  walk(profile)
  check(results, 'no file under the user data directory contains the device credential', secret !== '(none)' && holders.length === 0, holders.join(', '))

  const state = await app.client.evaluate(`window.workspace.remote.state().then((s) => JSON.stringify(s))`)
  const hashLike = /"[0-9a-f]{64}"/.test(state)
  check(
    results,
    'the remote state the renderer receives carries no credential, hash or private key',
    !state.includes(secret) && !hashLike && !state.includes('PRIVATE KEY') && !state.includes('secretHash'),
    state.slice(0, 200),
  )

  const wrong = await helloRemote(target, { deviceId: first.response.r?.deviceId, deviceSecret: 'wrong' })
  const wrongClosed = await Promise.race([wrong.client.closed, sleep(5_000).then(() => null)])
  check(results, 'a wrong credential is refused and the connection closed', wrong.response.e?.code === 'AUTH_FAILED' && wrongClosed !== null, JSON.stringify(wrong.response.e))

  const silent = await openRemote(target)
  const started = Date.now()
  const silentClosed = await Promise.race([silent.closed, sleep(15_000).then(() => null)])
  check(results, 'a silent connection is closed after ten seconds', silentClosed?.code === 4001, `after ${Date.now() - started} ms, ${JSON.stringify(silentClosed)}`)

  const connected = await helloRemote(target, credentialOf(first.response.r))
  check(
    results,
    'the pair and hello answers carry the current addresses, ending with the additional address',
    first.response.r?.addresses?.at(-1) === ADDITIONAL_ADDRESS && connected.response.r?.addresses?.at(-1) === ADDITIONAL_ADDRESS,
    `pair=${JSON.stringify(first.response.r?.addresses)} hello=${JSON.stringify(connected.response.r?.addresses)}`,
  )
  const second = await startPairing(app)
  const other = await pairRemote(target, { code: second.code, deviceName: 'Probe Tablet' })
  // Revoking asks first (`remote-access`). Declining keeps the device, connected; Esc cancels the question and
  // leaves Settings open; only the confirmation revokes.
  const REVOKE_PIXEL = `${DIALOG} button${label('remote.revoke', { name: 'Probe Pixel' })}`
  const CONFIRM_PIXEL = `${DIALOG} button${label('remote.revokeConfirmButton', { name: 'Probe Pixel' })}`
  await clickSelector(app.client, REVOKE_PIXEL, 'Revoke Probe Pixel')
  await clickButtonText(app.client, DIALOG, copy('common.cancel'))
  const declinedClose = await Promise.race([connected.client.closed, sleep(1_500).then(() => null)])
  const declinedRetry = await helloRemote(target, credentialOf(first.response.r))
  const stillListed = (await dialogText(app)).includes('Probe Pixel')
  check(
    results,
    'declining a revoke keeps the device: still listed, still connected, and its credential still accepted',
    declinedClose === null && declinedRetry.response.ok === true && stillListed,
    `close=${JSON.stringify(declinedClose)} retry=${JSON.stringify(declinedRetry.response.e ?? 'ok')} listed=${stillListed}`,
  )
  declinedRetry.client.close()
  await clickSelector(app.client, REVOKE_PIXEL, 'Revoke Probe Pixel')
  await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(CONFIRM_PIXEL)}))`), settled: Boolean, timeoutMs: 5_000, label: 'the revoke question' })
  await pressKey(app.client, 'Escape')
  const escaped = await pollFor({ read: () => app.client.evaluate(`!document.querySelector(${JSON.stringify(CONFIRM_PIXEL)})`), settled: Boolean, timeoutMs: 5_000, label: 'the question gone' }).catch(() => false)
  check(
    results,
    'Esc on the revoke question cancels it and leaves Settings open',
    escaped === true && (await settingsOpen(app)) && (await dialogText(app)).includes('Probe Pixel'),
    `cancelled=${escaped}`,
  )
  await clickSelector(app.client, REVOKE_PIXEL, 'Revoke Probe Pixel')
  await clickSelector(app.client, CONFIRM_PIXEL, 'Confirm revoking Probe Pixel')
  const revokedClose = await Promise.race([connected.client.closed, sleep(5_000).then(() => null)])
  const revokedRetry = await helloRemote(target, credentialOf(first.response.r))
  const otherRetry = await helloRemote(target, credentialOf(other.response.r))
  check(
    results,
    'revoking one device closes it at once and refuses it, while the other still connects',
    revokedClose?.code === 4004 && revokedRetry.response.e?.code === 'AUTH_FAILED' && otherRetry.response.ok === true,
    `close=${JSON.stringify(revokedClose)} retry=${JSON.stringify(revokedRetry.response.e)} other=${otherRetry.response.ok}`,
  )
  otherRetry.client.close()

  const before = await dialogFingerprint(app)
  await clickButtonText(app.client, DIALOG, copy('remote.reset'))
  await clickButtonText(app.client, DIALOG, copy('remote.resetConfirm'))
  const after = await pollFor({ read: () => dialogFingerprint(app), settled: (fp) => fp !== '' && fp !== before, timeoutMs: 15_000, label: 'a new fingerprint' })
  const newTarget = { port: LISTEN_A, fingerprint: after }
  const oldDevice = await helloRemote(newTarget, credentialOf(other.response.r))
  let oldPinFails = false
  try {
    const stale = await openRemote(target)
    stale.close()
  } catch {
    oldPinFails = true
  }
  check(
    results,
    'a reset changes the certificate and revokes every device',
    after !== before && oldPinFails && oldDevice.response.e?.code === 'AUTH_FAILED',
    `${before} → ${after}; old device ${JSON.stringify(oldDevice.response.e)}`,
  )

  // A key that no longer exists: pair once more, then remove the key between runs.
  const third = await startPairing(app)
  const kept = await pairRemote(newTarget, { code: third.code, deviceName: 'Kept' })
  await closeRemoteDialog(app)
  await app.close()
  const secretsFile = join(profile, 'secrets.json')
  const secrets = JSON.parse(readFileSync(secretsFile, 'utf8'))
  delete secrets.secrets['remote.tlsKey']
  writeFileSync(secretsFile, JSON.stringify(secrets))
  const relaunched = await start(context, profile, {}, RESTART_PORT)
  await openRemoteDialog(relaunched.app)
  const notice = await pollFor({ read: () => dialogText(relaunched.app), settled: (t) => t.includes(copy('remote.resetNotice.key-missing')), timeoutMs: 15_000, label: 'the reset notice' })
  const resetFp = await dialogFingerprint(relaunched.app)
  const refused = await helloRemote({ port: LISTEN_A, fingerprint: resetFp }, credentialOf(kept.response.r))
  check(
    results,
    'a missing key resets remote access, the dialog says why, and the old device is refused',
    notice.includes(copy('remote.resetNotice.key-missing')) && resetFp !== after && refused.response.e?.code === 'AUTH_FAILED',
    JSON.stringify(refused.response.e),
  )
  await closeRemoteDialog(relaunched.app)
  await relaunched.app.close()
}

/** remote-access: the indicator, and the Settings section. */
async function runIndicator(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos)
  const { app } = await start(context, profile)
  const INDICATOR = `${ACTIVITY} button${label('remote.indicator')}`
  const SECTION = `${SETTINGS_DIALOG} [role="group"]${label('remote.section.label')}`

  await openRemoteDialog(app)
  const offLine = await pollFor({ read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(SECTION)})?.textContent ?? ''`), settled: (t) => t.includes(copy('remote.section.off')), timeoutMs: 10_000, label: 'Settings says off' })
  check(results, 'the Settings section states that remote access is off', offLine.includes(copy('remote.section.off')), offLine)
  // The controls are in the section itself (`terminal-preferences`): the switch is there, and Settings is the
  // only dialog open.
  // The summary renders before the state arrives ("Off" either way); the controls come with the state.
  const holds = await pollFor({
    read: () =>
      app.client.evaluate(`({
        switch: Boolean(document.querySelector(${JSON.stringify(`${DIALOG} input${label('remote.enable')}`)})),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
      })`),
    settled: (value) => value.switch,
    timeoutMs: 10_000,
    label: 'the switch in the section',
  }).catch(() => ({ switch: false, dialogs: -1 }))
  check(results, 'the remote access section holds the switch, and no other dialog is open', holds.switch && holds.dialogs === 1, JSON.stringify(holds))
  await setPortInDialog(app, LISTEN_A)
  await toggleEnabled(app)
  await pollFor({ read: () => dialogText(app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_A })), timeoutMs: 15_000, label: 'listening' })
  await closeRemoteDialog(app)

  check(results, 'no indicator while no device is connected', !(await app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(INDICATOR)}))`)), '')
  const a = await phone(app, 'Phone A')
  const shown = await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(INDICATOR)}))`), settled: Boolean, timeoutMs: 10_000, label: 'the indicator' })
  check(results, 'a connected device shows the indicator', shown === true, '')
  // Leave Settings on another section first: Settings reopens on the last one shown, so an indicator that only
  // opened Settings would otherwise pass.
  await clickSelector(app.client, `${ACTIVITY} button${label('activityBar.settings')}`, 'the Settings entry')
  await showSection(app.client, 'about')
  await closeRemoteDialog(app)
  await clickSelector(app.client, INDICATOR, 'the indicator')
  const fromIndicator = await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`), settled: Boolean, timeoutMs: 10_000, label: 'Settings on Remote access from the indicator' }).catch(() => false)
  check(results, 'the indicator opens Settings on its remote access section', fromIndicator === true, '')
  await closeRemoteDialog(app)

  const b = await phone(app, 'Phone B')
  b.client.close()
  await openRemoteDialog(app)
  const counted = copy('remote.section.on', { devices: 2, connected: 1 })
  const onLine = await pollFor({ read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(SECTION)})?.textContent ?? ''`), settled: (t) => t.includes(counted), timeoutMs: 10_000, label: 'Settings counts devices' })
  check(results, 'the Settings section states on, two devices, one connected', onLine.includes(counted), onLine)
  await pressKey(app.client, 'Escape')

  a.client.close()
  const gone = await pollFor({ read: () => app.client.evaluate(`!document.querySelector(${JSON.stringify(INDICATOR)})`), settled: Boolean, timeoutMs: 10_000, label: 'the indicator gone' })
  check(results, 'the indicator goes away with the last connection', gone === true, '')
  await app.close()
}

/** remote-protocol: the session list, and create/wake that never take the desktop. */
async function runSessions(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile, { busySeconds: 3 })
  const { client } = await phone(app)

  const first = await list(client)
  check(
    results,
    'the session list carries the folders in rail order',
    JSON.stringify(first.folders.map((f) => f.name)) === JSON.stringify([repos.names.f, repos.names.g, repos.names.e]) && first.window === true,
    JSON.stringify(first.folders.map((f) => f.name)),
  )

  await selectFolder(app, repos.names.f)
  const from = client.events.length
  await desktopCreate(app, 'claude')
  const created = await client.waitEvent('sessions.changed', { from, match: (d) => d.sessions.some((s) => s.folderId === 'f' && s.target === 'claude'), label: 'the desktop session in the list' })
  const fSession = created?.d.sessions.find((s) => s.folderId === 'f')
  check(results, 'a session created on the desktop appears in the list with its folder and label', Boolean(fSession?.label), JSON.stringify(fSession))

  // busy, then waiting for input
  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === fSession?.id)?.wait, settled: (w) => w === 'ready', timeoutMs: 20_000, label: 'the agent ready' })
  const before = client.events.length
  await call(client, 'terminal.input', { sessionId: fSession.id, data: 'work\r' })
  const busy = await client.waitEvent('sessions.changed', { from: before, match: (d) => d.sessions.find((s) => s.id === fSession.id)?.wait === 'busy', timeoutMs: 10_000, label: 'listed working' })
  const waiting = await client.waitEvent('sessions.changed', { from: client.events.indexOf(busy) + 1, match: (d) => d.sessions.find((s) => s.id === fSession.id)?.wait === 'ready', timeoutMs: 15_000, label: 'listed waiting' })
  check(results, 'a finished turn is listed as working, then waiting for input', Boolean(busy) && Boolean(waiting) && client.events.indexOf(waiting) > client.events.indexOf(busy), `busy=${Boolean(busy)} waiting=${Boolean(waiting)}`)

  // The desktop displays F's session with focus in its terminal.
  const focusBefore = await pollFor({ read: () => app.client.evaluate(FOCUS), settled: (f) => f === 'terminal', timeoutMs: 10_000, label: 'focus in F terminal' })
  const tabBefore = await app.client.evaluate(SELECTED_TAB)

  const inG = await remoteCreate(client, 'g', 'claude')
  await sleep(1_500)
  const railAfterG = await app.client.evaluate(SELECTED_FOLDER)
  const listed = (await list(client)).sessions.find((s) => s.id === inG.r?.sessionId)
  check(
    results,
    'a session created from a device is a desktop session in its folder, and the rail selection is unchanged',
    inG.ok === true && listed?.folderId === 'g' && railAfterG === repos.names.f,
    `rail=${railAfterG} listed=${JSON.stringify(listed)} ${JSON.stringify(inG.e ?? '')}`,
  )

  const inF = await remoteCreate(client, 'f', 'shell')
  await sleep(1_500)
  const tabAfter = await app.client.evaluate(SELECTED_TAB)
  const focusAfter = await app.client.evaluate(FOCUS)
  check(
    results,
    'creating in the displayed folder leaves the displayed session and keyboard focus where they were',
    inF.ok === true && tabAfter === tabBefore && focusBefore === 'terminal' && focusAfter === 'terminal',
    `tab ${tabBefore} → ${tabAfter}; focus ${focusBefore} → ${focusAfter}`,
  )

  await selectFolder(app, repos.names.e)
  const sideFocus = await focusSidePanel(app)
  const inE = await remoteCreate(client, 'e', 'shell')
  await sleep(1_500)
  const focusInE = await app.client.evaluate(FOCUS)
  const eWatch = inE.ok ? await call(client, 'terminal.watch', { sessionId: inE.r.sessionId }) : null
  await call(client, 'terminal.unwatch')
  check(
    results,
    'creating in an empty displayed folder does not take focus, and its terminal is not 80 columns',
    sideFocus === 'side-panel' && focusInE === 'side-panel' && eWatch?.r?.cols !== undefined && eWatch.r.cols !== 80,
    `focus=${focusInE} cols=${eWatch?.r?.cols}`,
  )

  // Turning to the quietly created session in G: select G, then its new tab.
  await selectFolder(app, repos.names.g)
  const gLabel = listed?.label
  await pollFor({
    read: () => app.client.evaluate(`[...document.querySelectorAll('[role="tablist"][aria-label="${copy('sessions.tabs')}"] [role="tab"]')].map((t) => t.textContent.trim())`),
    settled: (labels) => labels.some((l) => l.includes(gLabel ?? '(none)')),
    timeoutMs: 10_000,
    label: 'the G tab',
  })
  const gFocus = await pollFor({ read: () => app.client.evaluate(FOCUS), settled: (f) => f === 'terminal', timeoutMs: 10_000, label: 'focus in the G terminal' })
  const gWatch = await call(client, 'terminal.watch', { sessionId: inG.r.sessionId })
  await call(client, 'terminal.unwatch')
  check(
    results,
    'a quietly created session takes focus once the user turns to it, and its terminal is not 80 columns',
    gFocus === 'terminal' && gWatch.r?.cols !== 80,
    `focus=${gFocus} cols=${gWatch.r?.cols}`,
  )

  // Waking: hibernate G's session, display it dormant, focus elsewhere, wake from the device.
  await pressHibernate(app.client)
  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === inG.r.sessionId)?.running, settled: (r) => r === false, timeoutMs: 15_000, label: 'G hibernated' })
  // The desktop shows a session turning dormant by focusing its Wake button; let that happen first, or it
  // takes focus from the side panel after we put it there and the check reads the wrong cause.
  await pollFor({ read: () => app.client.evaluate(WAKE_FOCUSED), settled: Boolean, timeoutMs: 10_000, label: 'the dormant screen with its Wake button focused' })
  await focusSidePanel(app)
  const woke = await call(client, 'sessions.wake', { sessionId: inG.r.sessionId })
  const running = await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === inG.r.sessionId)?.running, settled: Boolean, timeoutMs: 15_000, label: 'G running again' })
  await sleep(800)
  const conv = await conversationOf(profile, inG.r.sessionId)
  check(results, 'waking a dormant session from a device starts its process and lists it running', woke.ok === true && running === true && pidsWith(conv ?? '(none)').length > 0, JSON.stringify(woke.e ?? ''))
  check(results, 'waking the displayed dormant session from a device does not take focus', (await app.client.evaluate(FOCUS)) === 'side-panel', await app.client.evaluate(FOCUS))

  // Restored after a relaunch.
  await sleep(800)
  await app.close()
  const relaunched = await start(context, profile, {}, RESTART_PORT)
  const restored = await pollFor({ read: () => persistedSessions(profile).map((s) => s.id), settled: (ids) => ids.includes(inG.r.sessionId), timeoutMs: 10_000, label: 'restored' })
  const railHas = await relaunched.app.client.evaluate(`document.querySelector('aside[aria-label="${copy('rail.label')}"]')?.textContent ?? ''`)
  check(results, 'a session created from a device is restored after a restart', restored.includes(inG.r.sessionId) && railHas.includes(gLabel ?? '(none)'), `persisted=${restored.includes(inG.r.sessionId)} rail=${railHas.includes(gLabel ?? '(none)')}`)
  await relaunched.app.close()
}

/** remote-protocol: the conversation, replies, resume, and errors that keep the connection. */
async function runConversation(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile)
  const paired = await phone(app)
  const { client } = paired

  const agent = await remoteCreate(client, 'f', 'claude')
  const sessionId = agent.r.sessionId
  const conv = await conversationOf(profile, sessionId)
  await pollFor({ read: () => stub.ready(), settled: Boolean, timeoutMs: 15_000, label: 'the stub ready' })
  const watch = await call(client, 'conversation.watch', { sessionId })
  const hello = await client.waitEvent('conversation.update', { match: (d) => JSON.stringify(d.events).includes(`STUB-HELLO-${conv}`), timeoutMs: 15_000, label: 'the stub reply' })
  check(results, 'a watched agent session delivers its reply as an entry', watch.ok === true && Boolean(hello), JSON.stringify(watch.e ?? ''))

  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.wait, settled: (w) => w === 'ready', timeoutMs: 15_000, label: 'ready' })
  const long = `REMOTE-LONG-${'x'.repeat(600)}`
  const longFrom = client.events.length
  const sent = await call(client, 'conversation.send', { sessionId, text: long })
  const entry = await client.waitEvent('conversation.update', { match: (d) => JSON.stringify(d.events).includes('REMOTE-LONG-'), timeoutMs: 15_000, label: 'the reply as an entry' })
  const blocks = stub.sessionBlocks(conv)
  const keyBlock = blocks.findIndex((block) => block.text.includes('\n') && !block.text.includes('REMOTE-LONG-'))
  const gap = keyBlock > 0 ? blocks[keyBlock].atMs - blocks[keyBlock - 1].atMs : -1
  check(
    results,
    'a long reply reaches the agent with the submit key at least 400 ms after the text, and appears in the conversation',
    sent.r?.outcome === 'submitted' && keyBlock > 0 && gap >= 400 && Boolean(entry),
    `outcome=${sent.r?.outcome} gap=${gap.toFixed?.(0)}ms blocks=${blocks.length}`,
  )

  // Waiting on a choice: refused, nothing written. The stub's own turn for the long reply ends first: its turn
  // end would otherwise land after the request and close it (the agent's own turn end closes its own requests).
  await turnAfter(client, longFrom, 'the long reply')
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm x' } })
  await client.waitEvent('conversation.wait', { match: (d) => d.state === 'awaiting-choice', timeoutMs: 10_000, label: 'awaiting a choice' })
  const bytesBefore = stub.sessionInputs()[conv]?.bytes.length ?? 0
  const refused = await call(client, 'conversation.send', { sessionId, text: 'yes please' })
  await sleep(800)
  check(
    results,
    'a reply while the agent waits on a choice is refused with that reason, and nothing is written',
    refused.e?.code === 'WAIT_STATE' && refused.e?.detail?.state === 'awaiting-choice' && (stub.sessionInputs()[conv]?.bytes.length ?? 0) === bytesBefore,
    JSON.stringify(refused.e),
  )

  // A choice inside the delay: busy at the gate, awaiting-choice at the re-check. The refused prompt ends with
  // the agent's own turn end first: a tool start no longer closes an open request (`agent-event-bridge`).
  fireEvent(profile, sessionId, { hook_event_name: 'Stop' })
  fireEvent(profile, sessionId, { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
  await client.waitEvent('conversation.wait', { match: (d) => d.state === 'busy', timeoutMs: 10_000, label: 'busy' })
  const sending = call(client, 'conversation.send', { sessionId, text: 'HELD-BACK' })
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'Edit' })
  const held = await sending
  await sleep(800)
  const heldBytes = stub.sessionInputs()[conv]?.bytes ?? ''
  check(
    results,
    'a choice that appears during the delay keeps the submit key back',
    held.r?.outcome === 'filled-not-submitted' && heldBytes.endsWith('HELD-BACK'),
    `outcome=${held.r?.outcome} tail=${JSON.stringify(heldBytes.slice(-12))}`,
  )
  // Submit the held text by hand (the stub agent does not edit lines) and return to ready for what follows.
  await call(client, 'terminal.input', { sessionId, data: '\r' })
  await client.waitEvent('conversation.update', { match: (d) => JSON.stringify(d.events).includes('HELD-BACK'), timeoutMs: 10_000, label: 'the held text as an entry' })

  const other = await remoteCreate(client, 'g', 'claude')
  const unwatched = await call(client, 'conversation.send', { sessionId: other.r.sessionId, text: 'hi' })
  check(results, 'a reply to a conversation the connection does not watch is refused', unwatched.e?.code === 'NOT_WATCHING', JSON.stringify(unwatched.e))

  // Resume: the last entry received, two more written while disconnected.
  await client.waitEvent('conversation.wait', { match: (d) => d.state === 'ready', timeoutMs: 10_000, label: 'ready again' })
  const updates = client.eventsOf('conversation.update').flatMap((e) => e.d.events)
  const lastUuid = updates.at(-1)?.uuid
  client.drop()
  const desktopSide = await helloRemote(paired.target, paired.credential)
  await call(desktopSide.client, 'terminal.input', { sessionId, data: 'RESUME-ONE\r' })
  await sleep(1_200)
  await call(desktopSide.client, 'terminal.input', { sessionId, data: 'RESUME-TWO\r' })
  await sleep(1_500)
  desktopSide.client.close()
  const back = await helloRemote(paired.target, paired.credential)
  await call(back.client, 'conversation.watch', { sessionId, afterUuid: lastUuid })
  const resumed = await back.client.waitEvent('conversation.update', { timeoutMs: 10_000, label: 'the resumed update' })
  const texts = (resumed?.d.events ?? []).map((e) => e.text)
  check(
    results,
    'resuming the conversation sends only the entries written since, not replacing',
    resumed?.d.reset === false && texts.length === 2 && texts[0] === 'RESUME-ONE' && texts[1] === 'RESUME-TWO',
    `reset=${resumed?.d.reset} texts=${JSON.stringify(texts)} after=${lastUuid}`,
  )

  const shell = await remoteCreate(back.client, 'f', 'shell')
  const noConversation = await call(back.client, 'conversation.watch', { sessionId: shell.r.sessionId })
  check(results, 'a shell session has no conversation', noConversation.e?.code === 'NO_CONVERSATION', JSON.stringify(noConversation.e))
  const missing = await call(back.client, 'conversation.watch', { sessionId: 'no-such-session' })
  const stillOk = await call(back.client, 'sessions.list')
  check(results, 'a failed operation keeps the connection: not found, then a valid operation succeeds', missing.e?.code === 'NOT_FOUND' && stillOk.ok === true, JSON.stringify(missing.e))
  const unknown = await call(back.client, 'fs.writeFile', { path: '/tmp/x', content: 'x' })
  const unknown2 = await call(back.client, 'no.such.thing')
  check(
    results,
    'an unknown operation, such as writing a file, is refused without effect and the connection stays open',
    unknown.e?.code === 'UNKNOWN_OPERATION' && unknown2.e?.code === 'UNKNOWN_OPERATION' && back.client.isOpen(),
    JSON.stringify(unknown.e),
  )
  const oldVersion = await helloRemote(paired.target, { ...paired.credential, protocol: [99] })
  check(results, 'an unsupported protocol version is refused, naming the supported ones', oldVersion.response.e?.code === 'UNSUPPORTED_VERSION' && JSON.stringify(oldVersion.response.e?.detail?.supported) === '[1]', JSON.stringify(oldVersion.response.e))
  back.client.close()
  await app.close()
}

/** remote-protocol: terminal text, input, size, resume, wake, and a renderer reload. */
async function runTerminal(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app } = await start(context, profile)
  const { client } = await phone(app)

  await selectFolder(app, repos.names.f)
  const shell = await remoteCreate(client, 'f', 'shell')
  const sessionId = shell.r.sessionId
  // Display it, so the desktop sizes its terminal.
  await clickSelector(app.client, `[role="tablist"][aria-label="${copy('sessions.tabs')}"] [role="tab"]`)
  await sleep(1_500)
  await call(client, 'terminal.input', { sessionId, data: 'for i in $(seq 1 3000); do echo N$i; done\r' })
  const watch = await call(client, 'terminal.watch', { sessionId })
  await pollFor({
    read: () => watch.r.data + client.eventsOf('terminal.data').map((e) => e.d.data).join(''),
    settled: (text) => /N3000\r?\n/.test(text),
    timeoutMs: 20_000,
    label: 'the sequence finished',
  })
  const text = watch.r.data + client.eventsOf('terminal.data').map((e) => e.d.data).join('')
  const numbers = [...text.matchAll(/^N(\d+)\r?$/gm)].map((m) => Number(m[1]))
  const exact = numbers.length === 3000 && numbers.every((n, i) => n === i + 1)
  check(results, 'output between snapshot and stream is not lost: every number exactly once, in order', exact, `count=${numbers.length} first=${numbers[0]} last=${numbers.at(-1)}`)

  const from = client.events.length
  await call(client, 'terminal.input', { sessionId, data: 'echo OUT_$((6*7)); stty size\r' })
  const echoed = await pollFor({
    read: () => client.eventsOf('terminal.data', from).map((e) => e.d.data).join(''),
    settled: (t) => /OUT_42/.test(t) && /\n\d+ \d+\r?\n/.test(t),
    timeoutMs: 10_000,
    label: 'the command ran',
  })
  const [rows, cols] = (echoed.match(/\n(\d+) (\d+)\r?\n/) ?? []).slice(1).map(Number)
  check(results, 'input from a client reaches the session and its output comes back', /OUT_42/.test(echoed), '')
  check(results, 'the snapshot carries the terminal size', watch.r.cols === cols && watch.r.rows === rows, `snapshot ${watch.r.cols}x${watch.r.rows}, stty ${cols}x${rows}`)

  const sizeFrom = client.events.length
  await app.client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false })
  const resized = await client.waitEvent('terminal.size', { from: sizeFrom, timeoutMs: 10_000, label: 'a size event' })
  await app.client.send('Emulation.clearDeviceMetricsOverride')
  check(results, 'a desktop resize is delivered', Boolean(resized) && resized.d.cols !== watch.r.cols, JSON.stringify(resized?.d))

  // Beyond the ring.
  await call(client, 'terminal.input', { sessionId, data: "yes 0123456789 | head -c 400000; echo; echo RING_$((2*3))\r" })
  await pollFor({ read: () => client.eventsOf('terminal.data').map((e) => e.d.data).join('').includes('RING_6'), settled: Boolean, timeoutMs: 20_000, label: 'the flood done' })
  await call(client, 'terminal.unwatch')
  const old = await call(client, 'terminal.watch', { sessionId, from: { gen: watch.r.gen, offset: 0 } })
  check(results, 'a position older than the ring replaces and is marked incomplete', old.r?.replacing === true && old.r?.complete === false, JSON.stringify({ replacing: old.r?.replacing, complete: old.r?.complete }))
  const heldPosition = { gen: old.r.gen, offset: old.r.offset }

  // Hibernate and wake: an old position is not continued.
  await call(client, 'terminal.unwatch')
  await pressHibernate(app.client)
  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.running, settled: (r) => r === false, timeoutMs: 15_000, label: 'hibernated' })
  const wakeAnswer = await call(client, 'sessions.wake', { sessionId })
  const woken = await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.running, settled: Boolean, timeoutMs: 15_000, label: 'woken' })
  check(results, 'prerequisite: the shell wakes from the device', woken === true, `${JSON.stringify(wakeAnswer)} status=${await app.client.evaluate(SELECTED_TAB)}`)
  await sleep(800)
  const afterWake = await call(client, 'terminal.watch', { sessionId, from: heldPosition })
  check(results, 'a position from before a wake is not continued: replacing', afterWake.r?.replacing === true && afterWake.r?.gen !== heldPosition.gen, JSON.stringify({ gen: afterWake.r?.gen, replacing: afterWake.r?.replacing }))

  const endFrom = client.events.length
  await app.client.send('Page.reload')
  const ended = await client.waitEvent('terminal.ended', { from: endFrom, timeoutMs: 15_000, label: 'the watch ended' })
  await awaitMounted(app.client)
  check(results, 'reloading the interface ends remote watches and keeps the connection', Boolean(ended) && client.isOpen(), JSON.stringify(ended?.d))
  await app.close()
}

/** remote-protocol: inbox list/accept/ignore from a device, and a handoff's report. */
async function runIntakeHandoff(_mode, _config, context) {
  const repos = makeRepos()
  const gone = join(mkTemp('spekterm-remote-gone-'), 'not-there')
  const profile = seedProfile(repos, {
    remote: { enabled: true, port: LISTEN_A },
    extraFolders: [{ id: 'gone', path: gone, addedAt: '2026-10-13T00:00:03.000Z' }],
  })
  // Busy for a while after a submission, so the child's start is seen as one (`remote-prefill-send`, below).
  const { app, stub } = await start(context, profile, { readyDelaySeconds: 1, busySeconds: 2 })
  const { client } = await phone(app)
  const watchAttention = await call(client, 'attention.watch')
  check(results, 'prerequisite: the attention stream is watched', watchAttention.ok === true, JSON.stringify(watchAttention.e ?? ''))

  const drop = (name, payload) => {
    const inbox = join(profile, 'intake-inbox')
    mkdirSync(inbox, { recursive: true })
    const target = join(inbox, `${name}.json`)
    writeFileSync(`${target}.tmp`, JSON.stringify(payload))
    renameSync(`${target}.tmp`, target)
  }
  const intake = (id, title) => ({ id, origin: { kind: 'slack', id: 'C1', label: '#dev' }, title, body: `BODY-${id}`, actor: 'someone' })

  drop('first', intake('i1', 'REMOTE-INTAKE-ONE'))
  const arrived = await client.waitEvent('attention', { match: (d) => d.kind === 'intake' && d.intake?.id === 'i1', timeoutMs: 20_000, label: 'the intake event' })
  check(results, 'an inbox arrival raises an intake event', Boolean(arrived) && arrived.d.title === 'REMOTE-INTAKE-ONE', JSON.stringify(arrived?.d))
  const inbox = await call(client, 'inbox.list')
  const item = inbox.r.items.find((i) => i.id === 'i1')
  check(results, 'the inbox list carries the item with its full body', item?.body === 'BODY-i1', JSON.stringify(item))

  const noFolder = await call(client, 'inbox.accept', { adapter: item.adapter, id: 'i1' })
  const pendingAfterNoFolder = (await call(client, 'inbox.list')).r.items.some((i) => i.id === 'i1' && i.state === 'pending')
  check(results, 'accepting without a folder is refused, and the item stays pending', noFolder.e?.code === 'FOLDER_REQUIRED' && pendingAfterNoFolder, JSON.stringify(noFolder.e))
  const failed = await call(client, 'inbox.accept', { adapter: item.adapter, id: 'i1', folderId: 'gone' })
  const pendingAfterFailure = (await call(client, 'inbox.list')).r.items.some((i) => i.id === 'i1' && i.state === 'pending')
  check(results, 'a creation failure leaves the item pending', failed.ok === false && pendingAfterFailure, `${JSON.stringify(failed.e)} pending=${pendingAfterFailure}`)

  const accepted = await call(client, 'inbox.accept', { adapter: item.adapter, id: 'i1', folderId: 'g' })
  const acceptedConv = accepted.ok ? await conversationOf(profile, accepted.r.sessionId) : null
  const prompted = await pollFor({ read: () => stub.sessionInputs()[acceptedConv ?? '']?.bytes ?? '', settled: (b) => b.length > 0, timeoutMs: 20_000, label: 'the prompt filled in' })
  await sleep(1_500)
  const pid = pidsWith(acceptedConv ?? '(none)')[0]
  const stateAfter = (await call(client, 'inbox.list')).r.items.find((i) => i.id === 'i1')?.state
  check(
    results,
    'accepting a third-party item opens a session in the chosen folder with the prompt filled in and not sent',
    accepted.ok === true && cwdOf(pid) === repos.g && prompted.length > 0 && !/[\r\n]/.test(stub.sessionInputs()[acceptedConv]?.bytes ?? '') && stateAfter !== 'pending',
    `cwd=${cwdOf(pid)} state=${stateAfter} bytes=${JSON.stringify((stub.sessionInputs()[acceptedConv]?.bytes ?? '').slice(-30))}`,
  )

  drop('second', intake('i2', 'REMOTE-INTAKE-TWO'))
  drop('third', intake('i3', 'REMOTE-INTAKE-THREE'))
  await pollFor({ read: async () => (await call(client, 'inbox.list')).r.items.map((i) => i.id), settled: (ids) => ids.includes('i2') && ids.includes('i3'), timeoutMs: 20_000, label: 'two more items' })
  await call(client, 'inbox.ignore', { adapter: item.adapter, id: 'i2' })
  await clickSelector(app.client, `${ACTIVITY} button${label('activityBar.handoffs')}`)
  const desktopInbox = await pollFor({ read: () => app.client.evaluate(`document.querySelector('[role="dialog"]${label('intake.label')}')?.textContent ?? ''`), settled: (t) => t.includes('REMOTE-INTAKE-THREE'), timeoutMs: 10_000, label: 'the desktop inbox' })
  const clientHasI2 = (await call(client, 'inbox.list')).r.items.some((i) => i.id === 'i2')
  check(results, 'ignoring from a device updates the desktop', !desktopInbox.includes('REMOTE-INTAKE-TWO') && !clientHasI2, `desktop=${desktopInbox.includes('REMOTE-INTAKE-TWO')} client=${clientHasI2}`)
  const ignoreFrom = client.events.length
  await app.client.evaluate(`window.workspace.intake.dismiss('i3', ${JSON.stringify(item.adapter)})`)
  const without = await client.waitEvent('inbox.changed', { from: ignoreFrom, match: (d) => !d.items.some((i) => i.id === 'i3'), timeoutMs: 10_000, label: 'the list without i3' })
  check(results, 'ignoring on the desktop updates the client', Boolean(without), '')
  await pressKey(app.client, 'Escape')

  // A handoff: a parent agent hands off to G, the child reports with a URL in its summary.
  const parent = await remoteCreate(client, 'f', 'claude')
  const outbox = await pollFor({
    read: () => {
      try {
        return readdirSync(join(profile, 'handoff', 'outbox')).includes(parent.r.sessionId) ? join(profile, 'handoff', 'outbox', parent.r.sessionId) : null
      } catch {
        return null
      }
    },
    settled: Boolean,
    timeoutMs: 20_000,
    label: 'the parent outbox',
  })
  const handoffFrom = client.events.length
  writeFileSync(join(outbox, 'h1.json.partial'), JSON.stringify({ target: repos.names.g, title: 'REMOTE-HANDOFF', body: 'do the thing' }))
  renameSync(join(outbox, 'h1.json.partial'), join(outbox, 'h1.json'))
  const child = await pollFor({
    read: () => persistedSessions(profile).find((s) => s.lineage?.parentId === parent.r.sessionId && typeof s.claudeSessionId === 'string') ?? null,
    settled: Boolean,
    timeoutMs: 30_000,
    label: 'the child session',
  })
  await pollFor({ read: () => stub.sessionInputs()[child?.claudeSessionId ?? '']?.lines.length ?? 0, settled: (n) => n >= 1, timeoutMs: 30_000, label: 'the child got its prompt' })
  const reportFrom = client.events.length
  stub.command(child.claudeSessionId, ['fire PreToolUse', stub.report.stage('Fixed it, see https://example.com/pr/1'), stub.report.commit(), 'sleep 1', 'fire Stop'].join('\n'))
  const done = await client.waitEvent('handoffs.changed', { from: reportFrom, match: (d) => d.some((v) => v.sessionId === child.id && v.state === 'done'), timeoutMs: 30_000, label: 'the lifecycle done' })
  const brief = await call(client, 'handoffs.brief', { sessionId: child.id })
  const handoffEvent = await client.waitEvent('attention', { match: (d) => d.kind === 'handoff-done' && d.sessionId === child.id, timeoutMs: 15_000, label: 'the handoff-done event' })
  check(results, 'a reported handoff is read as done with its report', Boolean(done) && brief.r?.report?.summary?.includes('Fixed it'), JSON.stringify(brief.r ?? brief.e))
  /*
    The desktop submits a handoff's prompt itself, so no device is offered it (`remote-prefill-send` D2). Control
    group: list a submit-mode fill before the fallback (drop `!view.offered` in `listedPrefill`) → the list sent
    with the fill carries it (red).
  */
  const listsWithChild = client.events.slice(handoffFrom).filter((e) => e.k === 'sessions.changed' && e.d.sessions.some((s) => s.id === child.id))
  check(
    results,
    "the desktop's own submit of a handoff's prompt is never listed as a fill waiting to be sent",
    listsWithChild.length > 0 && !listsWithChild.some((e) => e.d.sessions.find((s) => s.id === child.id)?.prefill),
    `lists=${listsWithChild.length} withFill=${listsWithChild.filter((e) => e.d.sessions.find((s) => s.id === child.id)?.prefill).length}`,
  )
  check(results, 'an adopted report raises a handoff event whose summary lacks the URL', Boolean(handoffEvent) && !handoffEvent.d.summary.includes('example.com') && handoffEvent.d.summary.includes('Fixed it'), JSON.stringify(handoffEvent?.d))
  await app.close()
}

/**
 * scheduled-handoff on a device: a scheduled handoff is listed with `scheduledAt`, raises no `intake` event while it
 * waits and one when it opens, `inbox.accept` opens it now and `inbox.ignore` cancels it. The due one is scheduled
 * a little ahead, so this section waits for the desktop's 30-second opener once.
 */
async function runScheduled(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile, { readyDelaySeconds: 1 })
  const { client } = await phone(app)
  const watched = await call(client, 'attention.watch')
  check(results, 'prerequisite: the attention stream is watched', watched.ok === true, JSON.stringify(watched.e ?? ''))

  const parent = await remoteCreate(client, 'f', 'claude')
  const outbox = await pollFor({
    read: () => {
      try {
        return readdirSync(join(profile, 'handoff', 'outbox')).includes(parent.r.sessionId) ? join(profile, 'handoff', 'outbox', parent.r.sessionId) : null
      } catch {
        return null
      }
    },
    settled: Boolean,
    timeoutMs: 20_000,
    label: 'the parent outbox',
  })
  const write = (name, payload) => {
    writeFileSync(join(outbox, `${name}.partial`), JSON.stringify(payload))
    renameSync(join(outbox, `${name}.partial`), join(outbox, name))
  }
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString()
  const childrenOf = () => persistedSessions(profile).filter((s) => s.lineage?.parentId === parent.r.sessionId)

  write('later.json', { target: repos.names.g, title: 'SCHED-LATER', body: 'later work', at: tomorrow })
  write('cancel.json', { target: repos.names.g, title: 'SCHED-CANCEL', body: 'never mind', at: tomorrow })
  const listed = await pollFor({
    read: async () => (await call(client, 'inbox.list')).r.items.filter((i) => typeof i.scheduledAt === 'number'),
    settled: (items) => items.length === 2,
    timeoutMs: 20_000,
    label: 'two scheduled items',
  })
  const later = listed.find((i) => i.title === 'SCHED-LATER')
  check(results, 'a scheduled handoff is listed with scheduledAt, pending, and no session is created', later?.scheduledAt === Date.parse(tomorrow) && later?.state === 'pending' && childrenOf().length === 0, JSON.stringify(later))
  check(results, 'no intake event is raised while it waits', !client.eventsOf('attention').some((e) => e.d.kind === 'intake'), JSON.stringify(client.eventsOf('attention').map((e) => e.d.kind)))

  const cancel = listed.find((i) => i.title === 'SCHED-CANCEL')
  await call(client, 'inbox.ignore', { adapter: cancel.adapter, id: cancel.id })
  const afterIgnore = (await call(client, 'inbox.list')).r.items.some((i) => i.id === cancel.id)
  check(results, 'inbox.ignore cancels a scheduled handoff', !afterIgnore, '')

  const runFrom = client.events.length
  const accepted = await call(client, 'inbox.accept', { adapter: later.adapter, id: later.id, folderId: later.folderId })
  const opened = await pollFor({ read: () => childrenOf().length, settled: (n) => n === 1, timeoutMs: 20_000, label: 'the run-now child' })
  const changed = await client.waitEvent('inbox.changed', { from: runFrom, match: (d) => d.items.some((i) => i.id === later.id && i.scheduledAt === undefined), timeoutMs: 10_000, label: 'the list without scheduledAt' })
  check(results, 'inbox.accept on a scheduled handoff opens it now, and the list loses scheduledAt', accepted.ok === true && opened === 1 && Boolean(changed), JSON.stringify(accepted.e ?? ''))

  // Due shortly: the desktop's opener opens it within its 30-second tick, and only then raises the intake event.
  const dueAt = new Date(Date.now() + 15_000).toISOString()
  write('due.json', { target: repos.names.g, title: 'SCHED-DUE', body: 'due soon', at: dueAt })
  const waiting = await pollFor({ read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.title === 'SCHED-DUE') ?? null, settled: Boolean, timeoutMs: 20_000, label: 'the due item listed' })
  check(results, 'the due handoff waits as scheduled before its time', typeof waiting?.scheduledAt === 'number' && !client.eventsOf('attention').some((e) => e.d.kind === 'intake'), JSON.stringify(waiting))
  const dueFrom = client.events.length
  const event = await client.waitEvent('attention', { match: (d) => d.kind === 'intake' && d.intake?.id === waiting.id, timeoutMs: 75_000, label: 'the intake event when it opens' })
  const dueChanged = await client.waitEvent('inbox.changed', { from: dueFrom, match: (d) => d.items.some((i) => i.id === waiting.id && i.scheduledAt === undefined), timeoutMs: 15_000, label: 'the list after it opened' })
  check(results, 'opening at its time sends connected clients the list without scheduledAt', Boolean(dueChanged), '')
  const children = await pollFor({ read: () => childrenOf().length, settled: (n) => n === 2, timeoutMs: 20_000, label: 'the due child' })
  check(results, 'a scheduled handoff raises its intake event when it opens, and opens a new session', Boolean(event) && children === 2 && Date.now() >= Date.parse(dueAt), `children=${children}`)
  void stub
  await app.close()
}

/**
 * recurring-handoff on a device: a proposal is listed with its `recurrence` mark (role, expression, end, next
 * times); accepting it from the device is refused with `APPROVE_ON_DESKTOP` and leaves it pending; once approved on
 * the desktop, its occurrence is listed with `scheduledAt`, and ignoring it from the device skips to the next time.
 * The operations do not grow.
 */
async function runRecurring(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app } = await start(context, profile, { readyDelaySeconds: 1 })
  const paired = await phone(app)
  const { client } = paired
  const operations = paired.response.r?.operations ?? []
  check(results, 'no operation is added for repeating handoffs', !operations.some((op) => /recurr|approve/i.test(op)), JSON.stringify(operations))

  const parent = await remoteCreate(client, 'f', 'claude')
  const outbox = await pollFor({
    read: () => {
      try {
        return readdirSync(join(profile, 'handoff', 'outbox')).includes(parent.r.sessionId) ? join(profile, 'handoff', 'outbox', parent.r.sessionId) : null
      } catch {
        return null
      }
    },
    settled: Boolean,
    timeoutMs: 20_000,
    label: 'the parent outbox',
  })
  const until = new Date(Date.now() + 60 * 24 * 3600_000).toISOString()
  writeFileSync(join(outbox, 'weekly.partial'), JSON.stringify({ target: repos.names.g, title: 'RECUR-WEEKLY', body: 'weekly review', repeat: '0 21 * * 3', until }))
  renameSync(join(outbox, 'weekly.partial'), join(outbox, 'weekly.json'))
  const proposal = await pollFor({
    read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.title === 'RECUR-WEEKLY') ?? null,
    settled: Boolean,
    timeoutMs: 20_000,
    label: 'the proposal listed',
  })
  const next = proposal?.recurrence?.next ?? []
  check(
    results,
    'a proposal carries its recurrence mark: role, expression, end, up to three Wednesday 21:00 times, no scheduledAt',
    proposal?.recurrence?.role === 'proposal' && proposal.recurrence.repeat === '0 21 * * 3' && proposal.recurrence.until === Date.parse(until) &&
      next.length === 3 && next.every((t) => new Date(t).getDay() === 3 && new Date(t).getHours() === 21) && proposal.scheduledAt === undefined,
    JSON.stringify(proposal?.recurrence),
  )

  const refused = await call(client, 'inbox.accept', { adapter: proposal.adapter, id: proposal.id, folderId: 'g' })
  const still = (await call(client, 'inbox.list')).r.items.find((i) => i.id === proposal.id)
  check(results, 'accepting a proposal from a device is refused with APPROVE_ON_DESKTOP and it stays pending', refused.e?.code === 'APPROVE_ON_DESKTOP' && still?.state === 'pending', JSON.stringify(refused.e ?? ''))

  // Approved on the desktop (its own IPC, as the overlay's Approve).
  const approved = await app.client.evaluate(`window.workspace.intake.approveRecurrence(${JSON.stringify(proposal.id)}, ${JSON.stringify(proposal.adapter)}, 'g')`)
  const occurrence = await pollFor({
    read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.recurrence?.role === 'occurrence' && i.state === 'pending') ?? null,
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'the occurrence listed',
  })
  check(results, 'approved on the desktop: the device lists one occurrence with scheduledAt and its expression', approved?.ok === true && typeof occurrence?.scheduledAt === 'number' && occurrence.recurrence.repeat === '0 21 * * 3', JSON.stringify({ approved, occurrence: occurrence?.recurrence }))

  await call(client, 'inbox.ignore', { adapter: occurrence.adapter, id: occurrence.id })
  const following = await pollFor({
    read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.recurrence?.role === 'occurrence' && i.state === 'pending') ?? null,
    settled: (item) => item !== null && item.id !== occurrence.id,
    timeoutMs: 15_000,
    label: 'the next occurrence listed',
  })
  check(results, 'ignoring an occurrence from a device skips one time: the next one, a week later, is listed', following?.scheduledAt === occurrence.scheduledAt + 7 * 24 * 3600_000, JSON.stringify({ was: occurrence.scheduledAt, now: following?.scheduledAt }))
  await app.close()
}

/**
 * remote-protocol: a prompt a device's accept left unsent is listed and sent from the device (`remote-prefill-send`).
 * The stub stays busy for a few seconds after a submission, so the start is seen (design, Risks: a start and the
 * next ready in one drained batch are never seen as a start, by the desktop's Enter either).
 */
async function runPrefillSubmit(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  // `queryModes`: the stub asks for two terminal modes as the real CLI does; the terminal's answers must not mark a
  // fill typed into (control group: drop the DECRPM alternative from `REPORT` in pty-input.ts → the first check is red).
  const { app, stub } = await start(context, profile, { readyDelaySeconds: 1, busySeconds: 4, queryModes: true })
  const { client } = await phone(app)
  const drop = (id) => {
    const inbox = join(profile, 'intake-inbox')
    mkdirSync(inbox, { recursive: true })
    const target = join(inbox, `${id}.json`)
    writeFileSync(`${target}.tmp`, JSON.stringify({ id, origin: { kind: 'slack', id: 'C1', label: '#dev' }, title: `PREFILL-${id}`, body: `BODY-${id}`, actor: 'someone' }))
    renameSync(`${target}.tmp`, target)
  }
  const prefillIn = (d, sessionId) => d.sessions.find((s) => s.id === sessionId)?.prefill
  /** The UTF-8 bytes of a string as the stub records them, one character per byte. */
  const asBytes = (text) => Buffer.from(text, 'utf8').toString('latin1')
  const accept = async (id) => {
    drop(id)
    const item = await pollFor({ read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.id === id) ?? null, settled: Boolean, timeoutMs: 20_000, label: `item ${id}` })
    const from = client.events.length
    const accepted = await call(client, 'inbox.accept', { adapter: item.adapter, id, folderId: 'g' })
    const sessionId = accepted.r?.sessionId
    const conv = await conversationOf(profile, sessionId)
    await pollFor({ read: () => stub.sessionInputs()[conv ?? '']?.bytes ?? '', settled: (b) => b.length > 0, timeoutMs: 20_000, label: `the prompt of ${id} filled in` })
    const listed = await client.waitEvent('sessions.changed', { from, match: (d) => Boolean(prefillIn(d, sessionId)), timeoutMs: 10_000, label: `the fill of ${id} listed` })
    return { item, sessionId, conv, prefill: listed ? prefillIn(listed.d, sessionId) : undefined }
  }
  /** What the stub received, without the terminal's answers to its mode queries (DECRPM). */
  // eslint-disable-next-line no-control-regex
  const withoutAnswers = (text) => text.replace(/\x1b\[\?\d+;\d+\$y/g, '')
  const bytesOf = (conv) => withoutAnswers(stub.sessionInputs()[conv]?.bytes ?? '')

  // One: listed, refused for a stale id and for a reply, then sent.
  const one = await accept('p1')
  await sleep(1_500)
  check(
    results,
    "a device's accept of a third-party item lists the filled-in prompt with its exact text, its item, not edited, and no submit key",
    one.prefill?.text !== undefined && bytesOf(one.conv) === asBytes(one.prefill.text) && one.prefill.intake?.id === 'p1' &&
      one.prefill.intake?.adapter === one.item.adapter && one.prefill.edited === false && typeof one.prefill.id === 'string',
    `prefill=${JSON.stringify(one.prefill)} bytes=${JSON.stringify(bytesOf(one.conv).slice(-24))}`,
  )
  const stale = await call(client, 'sessions.submitPrefill', { sessionId: one.sessionId, prefillId: 'not-this-one' })
  await call(client, 'conversation.watch', { sessionId: one.sessionId })
  const reply = await call(client, 'conversation.send', { sessionId: one.sessionId, text: 'ALSO-THIS' })
  await sleep(1_000)
  check(
    results,
    'a stale fill id is refused, a reply into the filled-in prompt is refused, and neither writes anything',
    stale.e?.code === 'PREFILL_GONE' && reply.e?.code === 'PREFILL_PENDING' && reply.e?.detail?.prefillId === one.prefill?.id &&
      bytesOf(one.conv) === asBytes(one.prefill?.text ?? ''),
    `stale=${JSON.stringify(stale.e ?? stale.r)} reply=${JSON.stringify(reply.e ?? reply.r)} tail=${JSON.stringify(bytesOf(one.conv).slice(-12))}`,
  )
  const blocksBefore = stub.sessionBlocks(one.conv).length
  const sentFrom = client.events.length
  const submitted = await call(client, 'sessions.submitPrefill', { sessionId: one.sessionId, prefillId: one.prefill?.id })
  const withdrawn = await client.waitEvent('sessions.changed', { from: sentFrom, match: (d) => d.sessions.some((s) => s.id === one.sessionId) && !prefillIn(d, one.sessionId), timeoutMs: 10_000, label: 'the fill withdrawn' })
  const settled = await pollFor({ read: async () => (await call(client, 'inbox.list')).r.items.some((i) => i.id === 'p1'), settled: (listed) => !listed, timeoutMs: 10_000, label: 'the item settled' })
  // One block, the key alone (the tty's line discipline reads it as a newline, as in runConversation).
  const keyBlocks = stub.sessionBlocks(one.conv).slice(blocksBefore)
  const lines = stub.sessionInputs()[one.conv]?.lines ?? []
  check(
    results,
    'submitting from a device writes the submit key alone, the agent records the prompt, the item leaves the inbox, and the fill leaves the list',
    submitted.r?.outcome === 'confirmed' && keyBlocks.length === 1 && /^[\r\n]$/.test(keyBlocks[0].text) && lines.length === 1 &&
      withoutAnswers(lines[0]) === one.prefill?.text && Boolean(withdrawn) && settled === false,
    `outcome=${JSON.stringify(submitted.r ?? submitted.e)} blocks=${JSON.stringify(keyBlocks.map((b) => b.text))} lines=${lines.length} sameText=${withoutAnswers(lines[0] ?? '') === one.prefill?.text} withdrawn=${Boolean(withdrawn)} listed=${settled}`,
  )

  // Two: typed into after the fill — edited, refused for a submit and still for a reply.
  const two = await accept('p2')
  const typedFrom = client.events.length
  await call(client, 'terminal.input', { sessionId: two.sessionId, data: 'x' })
  const edited = await client.waitEvent('sessions.changed', { from: typedFrom, match: (d) => prefillIn(d, two.sessionId)?.edited === true, timeoutMs: 6_000, label: 'the fill edited' })
  const editedBytes = bytesOf(two.conv)
  const refused = await call(client, 'sessions.submitPrefill', { sessionId: two.sessionId, prefillId: two.prefill?.id })
  await call(client, 'conversation.watch', { sessionId: two.sessionId })
  const replyTwo = await call(client, 'conversation.send', { sessionId: two.sessionId, text: 'ALSO-THIS' })
  await sleep(1_000)
  check(
    results,
    'a fill typed into is listed edited; its submit is refused, a reply still is, and neither writes anything',
    Boolean(edited) && refused.e?.code === 'PREFILL_EDITED' && replyTwo.e?.code === 'PREFILL_PENDING' && bytesOf(two.conv) === editedBytes,
    `edited=${Boolean(edited)} submit=${JSON.stringify(refused.e ?? refused.r)} reply=${JSON.stringify(replyTwo.e ?? replyTwo.r)}`,
  )

  // Three: sent with Enter through the desktop's own terminal write — the fill leaves the list.
  const three = await accept('p3')
  const enterFrom = client.events.length
  await app.client.evaluate(`window.workspace.terminal.write(${JSON.stringify(three.sessionId)}, '\\r')`)
  const enterGone = await client.waitEvent('sessions.changed', { from: enterFrom, match: (d) => d.sessions.some((s) => s.id === three.sessionId) && !prefillIn(d, three.sessionId), timeoutMs: 10_000, label: 'the fill gone after the desktop Enter' })
  check(results, 'sending at the desktop withdraws the fill from the session list', Boolean(enterGone), '')

  // Four: cleared on the desktop — the fill goes, and its submit is refused.
  const four = await accept('p4')
  const clearFrom = client.events.length
  await app.client.evaluate(`window.workspace.intake.settle('p4', ${JSON.stringify(four.item.adapter)})`)
  const clearGone = await client.waitEvent('sessions.changed', { from: clearFrom, match: (d) => d.sessions.some((s) => s.id === four.sessionId) && !prefillIn(d, four.sessionId), timeoutMs: 6_000, label: 'the fill gone after clearing' })
  const fourBytes = bytesOf(four.conv)
  const clearedSubmit = await call(client, 'sessions.submitPrefill', { sessionId: four.sessionId, prefillId: four.prefill?.id })
  await sleep(1_000)
  check(
    results,
    'clearing the item at the desktop withdraws the fill, and its submit is refused without writing',
    Boolean(clearGone) && clearedSubmit.e?.code === 'PREFILL_GONE' && bytesOf(four.conv) === fourBytes,
    `gone=${Boolean(clearGone)} submit=${JSON.stringify(clearedSubmit.e ?? clearedSubmit.r)}`,
  )
  await app.close()
}

/**
 * remote-protocol: accepting again after the prefill timed out reuses the earlier session. The stub agent
 * becomes ready only after the 30 s prefill limit, so the item returns to pending while its session lives.
 * The only step of this probe that costs half a minute.
 */
async function runReaccept(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile, { readyDelaySeconds: 40 })
  const { client } = await phone(app)
  const inbox = join(profile, 'intake-inbox')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'late.json.tmp'), JSON.stringify({ id: 'late', origin: { kind: 'slack', id: 'C1', label: '#dev' }, title: 'REMOTE-LATE', body: 'BODY-late', actor: 'someone' }))
  renameSync(join(inbox, 'late.json.tmp'), join(inbox, 'late.json'))
  const item = await pollFor({ read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.id === 'late') ?? null, settled: Boolean, timeoutMs: 20_000, label: 'the item' })
  const first = await call(client, 'inbox.accept', { adapter: item.adapter, id: 'late', folderId: 'g' })
  const back = await pollFor({
    read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.id === 'late')?.state,
    settled: (state) => state === 'pending',
    timeoutMs: 45_000,
    label: 'back to pending after the prefill limit',
  })
  const again = await call(client, 'inbox.accept', { adapter: item.adapter, id: 'late', folderId: 'g' })
  const inG = (await list(client)).sessions.filter((s) => s.folderId === 'g').length
  const conv = first.ok ? await conversationOf(profile, first.r.sessionId) : null
  const prompted = await pollFor({ read: () => stub.sessionInputs()[conv ?? '']?.bytes ?? '', settled: (b) => b.length > 0, timeoutMs: 30_000, label: 'the prompt once ready' })
  check(
    results,
    'accepting again after the prefill limit reuses the earlier session, which receives the prompt once ready',
    back === 'pending' && again.ok === true && again.r?.sessionId === first.r?.sessionId && inG === 1 && prompted.length > 0,
    `back=${back} first=${first.r?.sessionId} again=${again.r?.sessionId} sessionsInG=${inG} prompted=${prompted.length}`,
  )
  await app.close()
}

/**
 * A git repository F whose OpenSpec change lives in a linked worktree **outside** the folder (`remote-openspec-browse`
 * D2/D3), a plain folder G with one change (a single working tree), and an empty E. Its own fixture: `makeRepos()`
 * serves every other section.
 *
 * The change's files get mtimes in the reverse of display order (tasks newest): core orders artifacts by mtime and
 * falls back to the narrative order on ties, so files written in one go would come out in display order with no
 * sorting at all — the order assertion would be green for the wrong reason.
 */
function makeOpenSpecRepos() {
  const f = mkTemp('spekterm-remote-os-f-')
  const worktree = mkTemp('spekterm-remote-os-wt-')
  const g = mkTemp('spekterm-remote-os-g-')
  const e = mkTemp('spekterm-remote-os-e-')
  const git = (...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.com', ...args], { cwd: f, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(f, 'openspec', 'specs', 'thing'), { recursive: true })
  writeFileSync(join(f, 'openspec', 'specs', 'thing', 'spec.md'), '# thing\n\n### Requirement: A thing\n\nIt SHALL be.\n')
  // An archived change that touched the spec, so the spec has a history entry to check.
  const archived = join(f, 'openspec', 'changes', 'archive', '2026-10-01-make-thing')
  mkdirSync(join(archived, 'specs', 'thing'), { recursive: true })
  writeFileSync(join(archived, 'proposal.md'), '# Make thing\n')
  writeFileSync(join(archived, 'specs', 'thing', 'spec.md'), '## ADDED Requirements\n')
  git('add', '-A')
  git('commit', '-qm', 'specs')
  git('worktree', 'add', '-q', '-b', 'feat', worktree)
  const change = join(worktree, 'openspec', 'changes', 'add-thing')
  mkdirSync(join(change, 'specs', 'thing'), { recursive: true })
  writeFileSync(join(change, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-17\n')
  writeFileSync(join(change, 'proposal.md'), '# Add thing\n\nREMOTE-PROPOSAL-MARKER\n')
  writeFileSync(join(change, 'design.md'), '# Design\n')
  writeFileSync(join(change, 'specs', 'thing', 'spec.md'), '## ADDED Requirements\n')
  writeFileSync(join(change, 'tasks.md'), '## 1. Build (`src/main/thing.ts`)\n\n- [x] 1.1 Done\n- [ ] 1.2 Open\n')
  const now = Date.now() / 1000
  ;['proposal.md', 'design.md', 'specs/thing/spec.md', 'tasks.md'].forEach((file, i) => utimesSync(join(change, file), now - 400 + i * 100, now - 400 + i * 100))
  mkdirSync(join(g, 'openspec', 'changes', 'solo'), { recursive: true })
  writeFileSync(join(g, 'openspec', 'changes', 'solo', 'proposal.md'), '# Solo\n')
  return { f, g, e, worktree, tasks: join(change, 'tasks.md'), names: { f: basename(f), g: basename(g), e: basename(e) } }
}

/** Every string in a result except repository-authored text: `content`, task `text`, a task section's `title`. */
function metadataStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => metadataStrings(item, out))
  else if (value && typeof value === 'object') {
    const section = Array.isArray(value.tasks) && 'title' in value
    for (const [key, item] of Object.entries(value)) {
      if (key === 'content' || key === 'text' || (section && key === 'title')) continue
      metadataStrings(item, out)
    }
  }
  return out
}

const sortedKeys = (o) => Object.keys(o ?? {}).sort().join(',')

/**
 * remote-protocol: OpenSpec is readable and only readable, in the documented shapes, and a watch announces changes.
 *
 * Control groups, run by hand (`remote-openspec-browse` 5.2), each red at its own check:
 * - the host passing the service's views through: the key sets (and the label, tasks and order checks with them);
 *   the path check stays green — the service already strips paths, so that check guards a regression there;
 * - no `sortArtifacts`: the order check alone (`tasks,specs,design,proposal`, core's mtime order);
 * - the change written into the folder instead of a worktree: the aggregation prerequisite;
 * - the host's change callback left a no-op: the event check, after its 20 s retry budget.
 */
async function runOpenSpec(_mode, _config, context) {
  const repos = makeOpenSpecRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile)
  const { client } = await phone(app)

  const changes = await call(client, 'openspec.changes', { folderId: 'f' })
  const listed = changes.r?.active?.find((c) => c.slug === 'add-thing')
  // Core silently stops aggregating when there is one working tree, and then every check below is green for nothing.
  check(results, 'prerequisite: the worktree change is aggregated (listed as not in the main working tree)', listed?.worktree?.isMain === false, JSON.stringify(changes.r ?? changes.e).slice(0, 300))
  const change = await call(client, 'openspec.change', { folderId: 'f', slug: 'add-thing' })
  const specs = await call(client, 'openspec.specs', { folderId: 'f' })
  const spec = await call(client, 'openspec.spec', { folderId: 'f', topic: 'thing' })
  const artifacts = change.r?.artifacts ?? []
  const byId = Object.fromEntries(artifacts.map((a) => [a.id, a]))

  const keys = [
    sortedKeys(changes.r),
    sortedKeys(listed),
    sortedKeys(change.r),
    ...artifacts.map((a) => `${a.kind}:${sortedKeys(a)}`),
    sortedKeys(specs.r?.[0]),
    sortedKeys(spec.r),
    sortedKeys(spec.r?.history?.[0]),
  ]
  check(results, 'the four OpenSpec results carry exactly the documented keys', JSON.stringify(keys) === JSON.stringify([
    'active,archived',
    'archivedDate,createdDate,description,hasDesign,hasProposal,hasSpecs,hasTasks,slug,status,taskStats,timestamp,worktree',
    'archivedDate,artifacts,createdDate,slug,status,worktree',
    ...artifacts.map((a) => `${a.kind}:${{ markdown: 'content,id,kind,title', data: 'content,id,kind,title', tasks: 'id,kind,tasks,title', specs: 'id,kind,specs,title' }[a.kind]}`),
    'relatedChangeCount,topic',
    'content,history,origin,topic',
    'date,description,slug,status,timestamp',
  ]), JSON.stringify(keys))
  check(results, 'a change in another working tree is labeled with its branch and read by its slug', JSON.stringify(listed?.worktree) === '{"branch":"feat","isMain":false}' && JSON.stringify(change.r?.worktree) === '{"branch":"feat","isMain":false}' && byId.design?.content === '# Design\n', JSON.stringify({ listed: listed?.worktree, read: change.r?.worktree, design: byId.design }))
  // Core's mtime order would put tasks first; both orders the side panel can show (the schema's, or the narrative
  // fallback when the OpenSpec CLI is not found) start with the proposal and end with the tasks.
  const order = artifacts.map((a) => a.id)
  check(results, "a change's artifacts arrive in the side panel's order, not core's mtime order", order[0] === 'proposal' && order.at(-1) === 'tasks' && order.length === 4, order.join(','))
  check(results, 'reading an active change returns its artifacts with their content', byId.proposal?.content?.includes('REMOTE-PROPOSAL-MARKER') === true, JSON.stringify(change.e ?? byId.proposal ?? '').slice(0, 200))
  const tasks = byId.tasks?.tasks
  check(results, 'a tasks artifact arrives as its parsed task list', !('content' in (byId.tasks ?? {})) && tasks?.sections?.[0]?.tasks?.map((t) => `${t.text}:${t.completed}`).join('|') === '1.1 Done:true|1.2 Open:false', JSON.stringify(byId.tasks))

  const solo = await call(client, 'openspec.changes', { folderId: 'g' })
  check(results, 'a repository with one working tree labels nothing', solo.r?.active?.length === 1 && !('worktree' in solo.r.active[0]), JSON.stringify(solo.r ?? solo.e))

  const leaks = [repos.f, repos.worktree, stub.home, process.env.HOME].filter(Boolean)
  const strings = metadataStrings([changes.r, change.r, specs.r, spec.r, solo.r])
  const leaked = strings.filter((text) => leaks.some((path) => text.includes(path)))
  check(results, 'no path reaches a device from a repository with a worktree outside the folder', strings.length > 20 && leaked.length === 0, `strings=${strings.length} leaked=${JSON.stringify(leaked)}`)

  const escape = await call(client, 'openspec.change', { folderId: 'f', slug: '../../../etc' })
  check(results, 'a path-shaped identifier is not found', escape.e?.code === 'NOT_FOUND', JSON.stringify(escape.e))

  // The watchers become ready a moment after they are created, so the write is repeated until it is seen.
  const watched = await call(client, 'openspec.watch', { folderId: 'f' })
  check(results, 'prerequisite: the folder is watched', watched.ok === true, JSON.stringify(watched.e ?? ''))
  let writes = 0
  const announced = await retryAction({
    act: () => appendFileSync(repos.tasks, `- [ ] 1.${3 + writes++} Added from the probe\n`),
    read: () => client.eventsOf('openspec.changed').filter((event) => event.d?.folderId === 'f').length,
    settled: (count) => count > 0,
    attemptWindowMs: 3_000,
    timeoutMs: 20_000,
    label: 'openspec.changed after a tasks.md write in the worktree',
  })
  const reread = await call(client, 'openspec.change', { folderId: 'f', slug: 'add-thing' })
  const newTask = reread.r?.artifacts?.find((a) => a.id === 'tasks')?.tasks?.sections?.[0]?.tasks?.some((t) => t.text.startsWith('1.3 Added from the probe'))
  check(results, 'writing a task file in a worktree announces the watched folder, and a re-read shows it', announced > 0 && newTask === true, `events=${announced} writes=${writes} newTask=${newTask}`)
  await app.close()
}

/** remote-notifications: the attention stream, resuming, spans, suppression, and no outbound connection. */
async function runAttention(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app } = await start(context, profile)
  const paired = await phone(app)
  const { client } = paired
  const agent = await remoteCreate(client, 'f', 'claude')
  const sessionId = agent.r.sessionId
  await conversationOf(profile, sessionId)
  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.wait, settled: (w) => w === 'ready', timeoutMs: 20_000, label: 'ready' })

  const first = await call(client, 'attention.watch')
  check(results, 'prerequisite: the attention stream is watched', first.ok === true, JSON.stringify(first.e ?? ''))
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })
  const choice = await client.waitEvent('attention', { match: (d) => d.kind === 'choice', timeoutMs: 10_000, label: 'a choice event' })
  check(results, 'a permission prompt raises a choice event naming the tool', choice?.d.tool === 'Bash' && choice.d.sessionId === sessionId, JSON.stringify(choice?.d))
  fireEvent(profile, sessionId, { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
  fireEvent(profile, sessionId, { hook_event_name: 'PreToolUse', tool_name: 'Edit' })
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'Edit' })
  const second = await client.waitEvent('attention', { match: (d) => d.kind === 'choice' && d.tool === 'Edit', timeoutMs: 10_000, label: 'the second prompt' })
  check(results, 'a second prompt right after an answered one raises its own event', Boolean(second), '')
  fireEvent(profile, sessionId, { hook_event_name: 'PreToolUse', tool_name: 'Read' })
  fireEvent(profile, sessionId, { hook_event_name: 'Stop' })
  const waiting = await client.waitEvent('attention', { match: (d) => d.kind === 'waiting', timeoutMs: 10_000, label: 'a waiting event' })
  check(results, 'a finished turn (start and stop in one batch) raises a waiting event', Boolean(waiting), '')

  // Disconnected: two events, no outbound connection, then exactly those two on resume.
  const lastPos = client.eventsOf('attention').at(-1).d.pos
  client.drop()
  await sleep(500)
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'MISSED-ONE' })
  await sleep(900)
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'MISSED-TWO' })
  await sleep(900)
  const outbound = outboundSockets(profile, [PORT, LISTEN_A])
  check(results, 'an event with no device connected opens no outbound connection', outbound.length === 0, outbound.join('; '))
  const back = await helloRemote(paired.target, paired.credential)
  const resumed = await call(back.client, 'attention.watch', { after: lastPos })
  check(
    results,
    'events that occurred while disconnected arrive on reconnect, exactly, in order, complete',
    resumed.r?.complete === true && JSON.stringify(resumed.r.events.map((e) => e.tool)) === JSON.stringify(['MISSED-ONE', 'MISSED-TWO']),
    JSON.stringify({ complete: resumed.r?.complete, tools: resumed.r?.events.map((e) => e.tool) }),
  )

  // While watching: exactly once.
  const liveFrom = back.client.events.length
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'LIVE' })
  await back.client.waitEvent('attention', { from: liveFrom, match: (d) => d.tool === 'LIVE', timeoutMs: 10_000, label: 'the live event' })
  await sleep(1_000)
  check(results, 'an event during watching is neither lost nor repeated', back.client.eventsOf('attention', liveFrom).filter((e) => e.d.tool === 'LIVE').length === 1, '')
  const spanPos = back.client.eventsOf('attention').at(-1).d.pos

  // A port change keeps the span.
  await openRemoteDialog(app)
  await setPortInDialog(app, LISTEN_B)
  await pollFor({ read: () => dialogText(app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_B })), timeoutMs: 15_000, label: 'on B' })
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'AFTER-PORT' })
  await sleep(1_000)
  const onB = await helloRemote({ ...paired.target, port: LISTEN_B }, paired.credential)
  const afterPort = await call(onB.client, 'attention.watch', { after: spanPos })
  check(results, 'changing the port does not end the span', afterPort.r?.complete === true && afterPort.r.events.some((e) => e.tool === 'AFTER-PORT'), JSON.stringify({ complete: afterPort.r?.complete, tools: afterPort.r?.events.map((e) => e.tool) }))
  const beforeOff = onB.client.eventsOf('attention').at(-1)?.d.pos ?? afterPort.r.events.at(-1).pos

  // Off and on: a new span; nothing from while off.
  await toggleEnabled(app)
  await sleep(500)
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'WHILE-OFF' })
  await sleep(1_000)
  await toggleEnabled(app)
  await pollFor({ read: () => dialogText(app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_B })), timeoutMs: 15_000, label: 'on again' })
  fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'AFTER-ON' })
  await sleep(1_000)
  const fresh = await helloRemote({ ...paired.target, port: LISTEN_B }, paired.credential)
  const afterOff = await call(fresh.client, 'attention.watch', { after: beforeOff })
  check(
    results,
    'a position from before remote access was turned off is not continued: only events since, incomplete',
    afterOff.r?.complete === false && JSON.stringify(afterOff.r.events.map((e) => e.tool)) === JSON.stringify(['AFTER-ON']),
    JSON.stringify({ complete: afterOff.r?.complete, tools: afterOff.r?.events.map((e) => e.tool) }),
  )
  await closeRemoteDialog(app)

  // Suppression: needs the window to have focus.
  const focused = await app.client.evaluate('document.hasFocus()')
  if (focused) {
    await selectFolder(app, repos.names.f)
    await clickSelector(app.client, `[role="tablist"][aria-label="${copy('sessions.tabs')}"] [role="tab"]`)
    await sleep(800)
    const supFrom = fresh.client.events.length
    fireEvent(profile, sessionId, { hook_event_name: 'PreToolUse', tool_name: 'Read' })
    fireEvent(profile, sessionId, { hook_event_name: 'Stop' })
    const suppressed = await fresh.client.waitEvent('attention', { from: supFrom, match: (d) => d.kind === 'waiting', timeoutMs: 10_000, label: 'the suppressed event' })
    check(results, 'the displayed session in a focused window raises a suppressed event', suppressed?.d.suppressed === true, JSON.stringify(suppressed?.d))
  } else {
    console.log('  (the virtual display gives the window no focus: suppression is carried by remote-attention.test.ts — a recorded gap)')
  }
  await app.close()
}

/** session-hibernation: a session a paired device watches counts as displayed. */
async function runHibernation(_mode, _config, context) {
  const repos = makeRepos()
  const THRESHOLD_S = 4
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A }, preferences: { terminal: { autoHibernateSeconds: THRESHOLD_S } } })
  const { app } = await start(context, profile)
  const { client } = await phone(app)
  // A session the desktop does not display: G's, while F is selected.
  await selectFolder(app, repos.names.f)
  const agent = await remoteCreate(client, 'g', 'claude')
  const sessionId = agent.r.sessionId
  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.wait, settled: (w) => w === 'ready', timeoutMs: 20_000, label: 'ready' })
  await call(client, 'conversation.watch', { sessionId })
  await sleep((THRESHOLD_S + 4) * 1000)
  const stillRunning = (await list(client)).sessions.find((s) => s.id === sessionId)?.running
  check(results, 'a watched session does not hibernate', stillRunning === true, `running=${stillRunning}`)
  await call(client, 'conversation.unwatch')
  const hibernated = await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.running, settled: (r) => r === false, timeoutMs: (THRESHOLD_S + 15) * 1000, label: 'hibernated' })
  check(results, 'a session hibernates once the device stops watching', hibernated === false, `running=${hibernated}`)
  await app.close()
}

/** What a session's stub received, as text (every byte, Enter included). */
const received = (stub, conv) => stub.sessionInputs()[conv]?.bytes ?? ''

/**
 * What the stub received once it has stopped receiving. It logs one byte at a time, and after each line it runs
 * the hook commands (a second or so) without reading the tty, so bytes can wait unread. A length unchanged for
 * one second is the baseline; a shorter window read a pause as the end (seen: the next keys were missing).
 */
async function settledReceived(stub, conv, atLeast = 0) {
  let previous = -1
  let stable = 0
  return pollFor({
    read: () => received(stub, conv),
    settled: (text) => {
      stable = text.length === previous ? stable + 1 : 0
      previous = text.length
      return text.length >= atLeast && stable >= 2
    },
    interval: 500,
    timeoutMs: 20_000,
    label: 'the stub done receiving',
  })
}

/**
 * A turn the stub runs for one input line ends with its own submission and turn end. Waiting for its end keeps
 * them from landing after the next events the probe fires (the agent's own turn end closes its own requests).
 *
 * **Wait for ready only, from before the send.** The state was ready before, so a ready update after `from`
 * comes only from a drain that read the turn's events. A busy update is not a usable step: the submission and
 * the turn end often land in one drain, and then no busy is ever sent (seen: a 15 s wait ran out, and a ready
 * looked up from a missing busy matched an old event).
 */
async function turnAfter(client, from, label) {
  const ended = await client.waitEvent('conversation.wait', { from, match: (d) => d.state === 'ready', timeoutMs: 15_000, label: `${label}: ready` })
  check(results, `prerequisite: ${label} ended its turn`, Boolean(ended), '')
}

/** An agent session from the phone, ready, its conversation watched. */
async function watchedAgent(client, profile, stub, folderId = 'f') {
  const agent = await remoteCreate(client, folderId, 'claude')
  const sessionId = agent.r.sessionId
  const conv = await conversationOf(profile, sessionId)
  await pollFor({ read: () => stub.ready(), settled: Boolean, timeoutMs: 15_000, label: 'the stub ready' })
  await call(client, 'conversation.watch', { sessionId })
  await client.waitEvent('conversation.wait', { match: (d) => d.state === 'ready', timeoutMs: 15_000, label: 'ready' })
  return { sessionId, conv }
}

/** remote-protocol: renaming a session from a device. */
async function runRename(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app } = await start(context, profile, { announceTitle: 'STUB-TITLE' })
  const paired = await phone(app)
  const { client } = paired
  const operations = paired.response.r?.operations ?? []
  check(
    results,
    'the authentication answer lists the operations, the new ones included, and not authentication',
    ['sessions.rename', 'sessions.hibernate', 'sessions.close', 'sessions.keep', 'attachments.put', 'conversation.answer'].every((op) =>
      operations.includes(op),
    ) &&
      !operations.includes('hello') && !operations.includes('pair'),
    JSON.stringify(operations),
  )

  await selectFolder(app, repos.names.f)
  await desktopCreate(app, 'claude')
  const sessionId = await pollFor({
    read: async () => (await list(client)).sessions.find((s) => s.folderId === 'f' && s.target === 'claude')?.id ?? null,
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'the desktop session',
  })
  await pollFor({
    read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.label,
    settled: (l) => l === 'STUB-TITLE',
    timeoutMs: 15_000,
    label: 'the agent\'s title as the label',
  })
  const focusBefore = await pollFor({ read: () => app.client.evaluate(FOCUS), settled: (f) => f === 'terminal', timeoutMs: 10_000, label: 'focus in the terminal' })
  await selectFolder(app, repos.names.g)
  const railBefore = await app.client.evaluate(SELECTED_FOLDER)

  const from = client.events.length
  const renamed = await call(client, 'sessions.rename', { sessionId, name: 'Fix\nthe login' })
  const listed = await client.waitEvent('sessions.changed', { from, match: (d) => d.sessions.some((s) => s.id === sessionId && s.label === 'Fixthe login'), timeoutMs: 10_000, label: 'the new label listed' })
  const persisted = await pollFor({ read: () => persistedSessions(profile).find((s) => s.id === sessionId)?.customTitle, settled: (t) => t === 'Fixthe login', timeoutMs: 10_000, label: 'the name persisted' })
  await selectFolder(app, repos.names.f)
  const tab = await pollFor({ read: () => app.client.evaluate(SELECTED_TAB), settled: (t) => t?.includes('Fixthe login'), timeoutMs: 10_000, label: 'the tab shows the name' })
  check(
    results,
    'renaming from a device changes the tab, the rail and the list, cleans the name, and keeps the selection',
    renamed.ok === true && Boolean(listed) && persisted === 'Fixthe login' && Boolean(tab?.includes('Fixthe login')) && railBefore === repos.names.g,
    `ok=${renamed.ok} tab=${tab} rail=${railBefore} ${JSON.stringify(renamed.e ?? '')}`,
  )
  check(results, 'renaming takes no keyboard focus', focusBefore === 'terminal', `focus before=${focusBefore}`)

  const backFrom = client.events.length
  const cleared = await call(client, 'sessions.rename', { sessionId, name: '   ' })
  const back = await client.waitEvent('sessions.changed', { from: backFrom, match: (d) => d.sessions.some((s) => s.id === sessionId && s.label === 'STUB-TITLE'), timeoutMs: 10_000, label: 'the agent title again' })
  check(results, 'an empty name hands naming back to the agent\'s title', cleared.ok === true && Boolean(back), JSON.stringify(cleared.e ?? ''))

  const unknown = await call(client, 'sessions.rename', { sessionId: 'no-such-session', name: 'x' })
  check(results, 'renaming an unknown session is refused as not found', unknown.e?.code === 'NOT_FOUND', JSON.stringify(unknown.e))

  await call(client, 'sessions.rename', { sessionId, name: 'Kept name' })
  await pollFor({ read: () => persistedSessions(profile).find((s) => s.id === sessionId)?.customTitle, settled: (t) => t === 'Kept name', timeoutMs: 10_000, label: 'persisted before the restart' })
  await app.close()
  const relaunched = await start(context, profile, { announceTitle: 'STUB-TITLE' }, RESTART_PORT)
  const rail = await pollFor({
    read: () => relaunched.app.client.evaluate(`document.querySelector('aside[aria-label="${copy('rail.label')}"]')?.textContent ?? ''`),
    settled: (t) => t.includes('Kept name'),
    timeoutMs: 15_000,
    label: 'the name after a restart',
  })
  check(results, 'a name given from a device is restored after a restart', rail.includes('Kept name'), '')
  await relaunched.app.close()
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** remote-attachments: upload, send, refusals, removal with the session. */
async function runAttachments(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile)
  const { client } = await phone(app)
  const { sessionId, conv } = await watchedAgent(client, profile, stub)

  const image = Buffer.concat([PNG_HEAD, Buffer.alloc(700 * 1024, 3)])
  const chunk = 512 * 1024
  const first = await call(client, 'attachments.put', { sessionId, name: '../../photo shot.png', size: image.length, offset: 0, data: image.subarray(0, chunk).toString('base64') })
  const second = await call(client, 'attachments.put', {
    sessionId, name: 'x', size: image.length, offset: chunk, attachmentId: first.r?.attachmentId, data: image.subarray(chunk).toString('base64'),
  })
  check(results, 'a photo in two chunks becomes an attachment', first.r?.complete === false && second.r?.complete === true, JSON.stringify([first.e ?? first.r, second.e ?? second.r]))

  const sent = await call(client, 'conversation.send', { sessionId, text: 'ATTACH-PROBE', attachments: [first.r?.attachmentId] })
  const bytes = await pollFor({ read: () => received(stub, conv), settled: (t) => t.includes('read it with the Read tool'), timeoutMs: 10_000, label: 'the reply with its sentence' })
  const named = /`([^`]+)`/.exec(bytes)?.[1] ?? ''
  const store = join(profile, 'remote-attachments', sessionId, 'sent')
  const holds = (() => {
    try {
      return readFileSync(named).equals(image)
    } catch {
      return false
    }
  })()
  check(
    results,
    'a reply with an attachment reaches the agent naming the stored file inside a sentence, and the answer carries that exact text',
    sent.r?.outcome === 'submitted' && named.startsWith(`${store}/`) && holds && bytes.includes(sent.r?.text ?? '(none)') &&
      !bytes.split('\r').join('\n').split('\n').some((line) => line.startsWith('/')),
    `named=${named} holds=${holds} text=${JSON.stringify(sent.r?.text)}`,
  )

  const again = await call(client, 'conversation.send', { sessionId, text: 'AGAIN', attachments: [first.r?.attachmentId] })
  check(results, 'an attachment cannot be sent twice', again.e?.code === 'NOT_FOUND' && !received(stub, conv).includes('AGAIN'), JSON.stringify(again.e))

  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(40, 0)])
  const refused = await call(client, 'attachments.put', { sessionId, name: 'photo.png', size: elf.length, offset: 0, data: elf.toString('base64') })
  check(results, 'a binary that is not an accepted kind is refused', refused.e?.code === 'UNSUPPORTED_TYPE', JSON.stringify(refused.e))

  const shell = await remoteCreate(client, 'f', 'shell')
  const toShell = await call(client, 'attachments.put', { sessionId: shell.r.sessionId, name: 'a.txt', size: 1, offset: 0, data: 'YQ==' })
  check(results, 'an upload for a shell session is refused as having no conversation', toShell.e?.code === 'NO_CONVERSATION', JSON.stringify(toShell.e))

  // Hibernating keeps them; closing a dormant session removes them.
  const dir = join(profile, 'remote-attachments', sessionId)
  await selectFolder(app, repos.names.f)
  await clickSelector(app.client, `[role="tablist"][aria-label="${copy('sessions.tabs')}"] [role="tab"]`)
  await pressHibernate(app.client)
  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.running, settled: (r) => r === false, timeoutMs: 15_000, label: 'hibernated' })
  const kept = existsSync(dir)
  await app.client.evaluate(`window.workspace.terminal.kill(${JSON.stringify(sessionId)})`)
  const gone = await pollFor({ read: () => existsSync(dir), settled: (e) => e === false, timeoutMs: 10_000, label: 'the directory removed' })
  check(results, 'hibernating keeps a session\'s attachments, and closing it while dormant removes them', kept && gone === false, `kept=${kept}`)

  // Closing a running session removes them too.
  const live = await watchedAgent(client, profile, stub, 'g')
  const small = await call(client, 'attachments.put', { sessionId: live.sessionId, name: 'n.txt', size: 2, offset: 0, data: 'aGk=' })
  const liveDir = join(profile, 'remote-attachments', live.sessionId)
  const had = existsSync(liveDir) && small.r?.complete === true
  await app.client.evaluate(`window.workspace.terminal.kill(${JSON.stringify(live.sessionId)})`)
  const liveGone = await pollFor({ read: () => existsSync(liveDir), settled: (e) => e === false, timeoutMs: 10_000, label: 'the live directory removed' })
  check(results, 'closing a running session removes its attachments', had && liveGone === false, `had=${had}`)
  await app.close()
}

/** remote-protocol: the open prompt in the wait updates, and answers to it. */
async function runAnswer(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile)
  const { client } = await phone(app)
  const { sessionId, conv } = await watchedAgent(client, profile, stub)
  const ask = (tool, id, input, extra = {}) => {
    fireEvent(profile, sessionId, { hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: input, ...extra })
    fireEvent(profile, sessionId, { hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input, ...extra })
  }
  const promptWhere = (match, label) =>
    client.waitEvent('conversation.wait', { from: client.events.length, match: (d) => d.prompt && match(d.prompt), timeoutMs: 10_000, label })

  // A command: stated with allow; denied with Esc; the agent then takes a reply.
  const cmd = promptWhere((p) => p.kind === 'permission' && p.tool === 'Bash', 'the command prompt')
  ask('Bash', 'b1', { command: 'echo hi' })
  const command = await cmd
  check(
    results,
    'a permission prompt is stated with its identity, its tool and argument, allow once, and as answerable',
    command?.d.prompt.canAllow === true && command.d.prompt.answerable === true && command.d.prompt.arg === 'echo hi' && Boolean(command.d.prompt.id),
    JSON.stringify(command?.d.prompt),
  )
  const deniedFrom = client.events.length
  const denied = await call(client, 'conversation.answer', { sessionId, promptId: command?.d.prompt.id, decision: 'deny' })
  await client.waitEvent('conversation.wait', { from: deniedFrom, match: (d) => d.state === 'ready' && d.prompt === null, timeoutMs: 10_000, label: 'ready after the denial' })
  const replyFrom = client.events.length
  const reply = await call(client, 'conversation.send', { sessionId, text: 'AFTER-DENY' })
  await turnAfter(client, replyFrom, 'the reply after the denial')
  const afterDeny = await settledReceived(stub, conv)
  check(
    results,
    'a denial from a device writes Esc and no submit key, and the agent then takes a reply',
    denied.r?.outcome === 'sent' && (afterDeny.includes('\x1bAFTER-DENY\r') || afterDeny.includes('\x1bAFTER-DENY\n')) && reply.r?.outcome === 'submitted',
    `answer=${JSON.stringify(denied.r ?? denied.e)} reply=${JSON.stringify(reply.r ?? reply.e)} tail=${JSON.stringify(afterDeny.slice(-16))}`,
  )

  // A question: its options, the planned keys one at a time, confirmed against the recorded answers.
  const questions = [
    { question: 'Fruit?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: '' }, { label: 'Banana', description: '' }] },
    { question: 'Toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Salt', description: '' }, { label: 'Sugar', description: '' }, { label: 'Honey', description: '' }] },
  ]
  const qp = promptWhere((p) => p.kind === 'question', 'the question prompt')
  ask('AskUserQuestion', 'q1', { questions })
  const question = await qp
  check(
    results,
    'a question is stated with its options in order, several-choice marked, and answerable',
    question?.d.prompt.answerable === true && question.d.prompt.questions[1].multiSelect === true &&
      question.d.prompt.questions[1].options.map((o) => o.label).join() === 'Salt,Sugar,Honey',
    JSON.stringify(question?.d.prompt),
  )
  const beforeKeys = (await settledReceived(stub, conv)).length
  const blocksBefore = stub.sessionBlocks(conv).length
  const answering = call(client, 'conversation.answer', { sessionId, promptId: question?.d.prompt.id, decision: 'answer', selections: [[1], [2, 0]] })
  // The keys take four gaps of 250 ms; the recorded answers come after the last one.
  await sleep(1_300)
  fireEvent(profile, sessionId, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: { questions, answers: { 'Fruit?': 'Banana', 'Toppings?': 'Salt, Honey' } } })
  const answered = await answering
  const keys = (await settledReceived(stub, conv, beforeKeys + 5)).slice(beforeKeys)
  const blocks = stub.sessionBlocks(conv).slice(blocksBefore)
  check(
    results,
    'a question\'s answer reaches the agent as the option keys, one write each, no submit key, and is confirmed',
    keys === '213\t1' && blocks.length === 5 && answered.r?.outcome === 'confirmed',
    `keys=${JSON.stringify(keys)} blocks=${blocks.length} outcome=${JSON.stringify(answered.r ?? answered.e)}`,
  )
  fireEvent(profile, sessionId, { hook_event_name: 'Stop' })

  // A prompt that was replaced: the old identity is refused, nothing written.
  const ep = promptWhere((p) => p.tool === 'Edit', 'the first prompt')
  ask('Edit', 'e1', { file_path: 'a.ts' })
  const old = await ep
  const wp = promptWhere((p) => p.tool === 'Write', 'the replacing prompt')
  fireEvent(profile, sessionId, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'e1' })
  ask('Write', 'w1', { file_path: 'b.ts' })
  const replacing = await wp
  const beforeGone = (await settledReceived(stub, conv)).length
  const gone = await call(client, 'conversation.answer', { sessionId, promptId: old?.d.prompt.id, decision: 'allow' })
  check(
    results,
    'an answer to a prompt that was replaced is refused as gone, and nothing is written',
    gone.e?.code === 'PROMPT_GONE' && replacing?.d.prompt.id !== old?.d.prompt.id && (await settledReceived(stub, conv)).length === beforeGone,
    JSON.stringify(gone.e),
  )

  // A key typed into the session makes the open prompt unanswerable, and an answer is refused.
  const typedFrom = client.events.length
  await call(client, 'terminal.input', { sessionId, data: 'x' })
  const unanswerable = await client.waitEvent('conversation.wait', { from: typedFrom, match: (d) => d.prompt?.answerable === false, timeoutMs: 10_000, label: 'unanswerable after a key' })
  const afterKey = await call(client, 'conversation.answer', { sessionId, promptId: replacing?.d.prompt.id, decision: 'allow' })
  check(
    results,
    'a prompt typed into is no longer answerable, and an answer to it is refused as gone',
    Boolean(unanswerable) && afterKey.e?.code === 'PROMPT_GONE',
    JSON.stringify(afterKey.e),
  )
  fireEvent(profile, sessionId, { hook_event_name: 'Stop' })

  // Two open requests: stated with the count, not answerable, refused.
  const two = promptWhere((p) => p.open === 2, 'two open')
  ask('Read', 'r1', { file_path: '/h/a' })
  ask('Read', 'r2', { file_path: '/h/b' })
  const both = await two
  const bothAnswer = await call(client, 'conversation.answer', { sessionId, promptId: both?.d.prompt.id, decision: 'deny' })
  check(
    results,
    'two open requests are stated with the first and the count, not answerable, and an answer is refused',
    both?.d.prompt.arg === '/h/a' && both.d.prompt.answerable === false && bothAnswer.e?.code === 'PROMPT_GONE',
    JSON.stringify({ prompt: both?.d.prompt, e: bothAnswer.e }),
  )
  fireEvent(profile, sessionId, { hook_event_name: 'Stop' })

  // A multi-key answer cut off by another request is partial.
  const pp = promptWhere((p) => p.kind === 'question' && p.answerable, 'the second question')
  ask('AskUserQuestion', 'q2', { questions })
  const second = await pp
  const beforePartial = (await settledReceived(stub, conv)).length
  const answeredFrom = client.events.length
  const partial = call(client, 'conversation.answer', { sessionId, promptId: second?.d.prompt.id, decision: 'answer', selections: [[0], [1]] })
  // The first key marks the request answered, and the follower says so at once.
  await client.waitEvent('conversation.wait', { from: answeredFrom, match: (d) => d.prompt?.id === second?.d.prompt.id && d.prompt.answerable === false, timeoutMs: 10_000, label: 'the first key written' })
  ask('Bash', 'b9', { command: 'next' })
  const cut = await partial
  const partialKeys = (await settledReceived(stub, conv)).slice(beforePartial)
  check(results, 'an answer interrupted by another request is partial', cut.r?.outcome === 'partial' && partialKeys.length < 4, `${JSON.stringify(cut.r ?? cut.e)} keys=${JSON.stringify(partialKeys)}`)
  fireEvent(profile, sessionId, { hook_event_name: 'Stop' })

  // The plan approval: its text and approvals, no allow; approving asks before edits and is confirmed.
  const planp = promptWhere((p) => p.kind === 'plan', 'the plan prompt')
  ask('ExitPlanMode', 'pl1', { plan: 'PLAN-TEXT' })
  const plan = await planp
  const allowPlan = await call(client, 'conversation.answer', { sessionId, promptId: plan?.d.prompt.id, decision: 'allow' })
  const beforePlan = (await settledReceived(stub, conv)).length
  const approvedFrom = client.events.length
  const approving = call(client, 'conversation.answer', { sessionId, promptId: plan?.d.prompt.id, decision: 'approve' })
  await client.waitEvent('conversation.wait', { from: approvedFrom, match: (d) => d.prompt?.answerable === false, timeoutMs: 10_000, label: 'the approval key written' })
  fireEvent(profile, sessionId, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'pl1', permission_mode: 'default' })
  const approved = await approving
  await settledReceived(stub, conv, beforePlan + 1)
  check(
    results,
    'a plan approval is stated with the plan and its approvals, cannot be allowed, and approving sends its key and is confirmed',
    plan?.d.prompt.plan === 'PLAN-TEXT' && plan.d.prompt.choices.join() === 'approve,approve-auto,deny' && allowPlan.e?.code === 'NOT_ANSWERABLE' &&
      received(stub, conv).slice(beforePlan) === '2' && approved.r?.outcome === 'confirmed',
    JSON.stringify({ allow: allowPlan.e, approved: approved.r ?? approved.e, keys: received(stub, conv).slice(beforePlan) }),
  )
  await app.close()
}

/** The Wake button exists in the displayed session's view: the session is shown dormant. */
const WAKE_SHOWN = `[...document.querySelectorAll('main button')].some((b) => b.textContent === ${JSON.stringify(copy('sessions.wake'))} && b.offsetParent !== null)`

/** A session's running state as the client's list has it. */
const runningOf = async (client, sessionId) => (await list(client)).sessions.find((s) => s.id === sessionId)?.running

const ENDED = (client, kind, sessionId, from, label) =>
  client.waitEvent(kind, { from, match: (d) => d.sessionId === sessionId, timeoutMs: 15_000, label })

/** remote-hibernate-close: hibernating and closing from a device, busy refusals, endings, and focus (terminal view). */
async function runHibernateClose(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile)
  const { client } = await phone(app)

  // A shell running a command: refused with the reason, then hibernated when forced.
  await selectFolder(app, repos.names.f)
  const shell = (await remoteCreate(client, 'g', 'shell')).r.sessionId
  await call(client, 'terminal.watch', { sessionId: shell })
  const jobFrom = client.events.length
  await call(client, 'terminal.input', { sessionId: shell, data: 'echo SLEEP_$((6*7)); sleep 120\r' })
  await client.waitEvent('terminal.data', { from: jobFrom, match: (d) => d.sessionId === shell && d.data.includes('SLEEP_42'), timeoutMs: 10_000, label: 'the command started' })
  await sleep(700)
  const refused = await call(client, 'sessions.hibernate', { sessionId: shell })
  check(
    results,
    'a shell running a command is not hibernated without forcing, and the busy error names the job',
    refused.e?.code === 'SESSION_BUSY' && refused.e?.detail?.reason === 'job' && (await runningOf(client, shell)) === true,
    JSON.stringify(refused.e ?? refused.r),
  )
  const forcedFrom = client.events.length
  const forced = await call(client, 'sessions.hibernate', { sessionId: shell, force: true })
  const termEnded = await ENDED(client, 'terminal.ended', shell, forcedFrom, 'the shell terminal watch ended')
  const dormant = await pollFor({ read: () => runningOf(client, shell), settled: (r) => r === false, timeoutMs: 15_000, label: 'the shell dormant' })
  check(
    results,
    'forcing hibernates the working shell: listed not running, still persisted, its terminal watch ended as hibernated',
    forced.ok === true && dormant === false && persistedSessions(profile).some((s) => s.id === shell) && termEnded?.d.reason === 'hibernated',
    `ok=${forced.ok} running=${dormant} ended=${termEnded?.d.reason}`,
  )
  const woke = await call(client, 'sessions.wake', { sessionId: shell })
  const awake = await pollFor({ read: () => runningOf(client, shell), settled: Boolean, timeoutMs: 15_000, label: 'the shell running again' })
  check(results, 'the hibernated shell wakes', woke.ok === true && awake === true, JSON.stringify(woke.e ?? ''))
  await sleep(1_000)
  const idleHibernate = await call(client, 'sessions.hibernate', { sessionId: shell })
  await pollFor({ read: () => runningOf(client, shell), settled: (r) => r === false, timeoutMs: 15_000, label: 'the idle shell dormant' })
  const again = await call(client, 'sessions.hibernate', { sessionId: shell })
  check(
    results,
    'an idle shell hibernates without forcing, and hibernating it again while dormant succeeds with no change',
    idleHibernate.ok === true && again.ok === true && (await runningOf(client, shell)) === false && persistedSessions(profile).some((s) => s.id === shell),
    JSON.stringify([idleHibernate.e ?? 'ok', again.e ?? 'ok']),
  )

  // An idle agent: no forcing; both watches end as hibernated.
  const idle = await watchedAgent(client, profile, stub, 'g')
  await call(client, 'terminal.watch', { sessionId: idle.sessionId })
  const idleFrom = client.events.length
  const idleDone = await call(client, 'sessions.hibernate', { sessionId: idle.sessionId })
  const convEnded = await ENDED(client, 'conversation.ended', idle.sessionId, idleFrom, 'the conversation watch ended')
  const idleTermEnded = await ENDED(client, 'terminal.ended', idle.sessionId, idleFrom, 'the terminal watch ended')
  check(
    results,
    'an idle agent hibernates without forcing, and both its watches end as hibernated',
    idleDone.ok === true && convEnded?.d.reason === 'hibernated' && idleTermEnded?.d.reason === 'hibernated',
    `ok=${idleDone.ok} conversation=${convEnded?.d.reason} terminal=${idleTermEnded?.d.reason}`,
  )

  // An agent waiting on a choice: refused, then closed when forced.
  const asking = await watchedAgent(client, profile, stub, 'f')
  await call(client, 'sessions.rename', { sessionId: asking.sessionId, name: 'CLOSE-ME' })
  await call(client, 'terminal.watch', { sessionId: asking.sessionId })
  const put = await call(client, 'attachments.put', { sessionId: asking.sessionId, name: 'n.txt', size: 2, offset: 0, data: 'aGk=' })
  const attachmentDir = join(profile, 'remote-attachments', asking.sessionId)
  const choiceFrom = client.events.length
  fireEvent(profile, asking.sessionId, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'hc1', tool_input: { command: 'rm -rf build' } })
  fireEvent(profile, asking.sessionId, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await client.waitEvent('conversation.wait', { from: choiceFrom, match: (d) => d.state === 'awaiting-choice', timeoutMs: 10_000, label: 'the agent waiting on a choice' })
  const busyClose = await call(client, 'sessions.close', { sessionId: asking.sessionId })
  check(
    results,
    'an agent waiting on a choice is not closed without forcing, and the busy error names the choice',
    busyClose.e?.code === 'SESSION_BUSY' && busyClose.e?.detail?.reason === 'choice' && (await runningOf(client, asking.sessionId)) === true,
    JSON.stringify(busyClose.e ?? busyClose.r),
  )
  const closeFrom = client.events.length
  const closed = await call(client, 'sessions.close', { sessionId: asking.sessionId, force: true })
  const closedConv = await ENDED(client, 'conversation.ended', asking.sessionId, closeFrom, 'the closed conversation watch ended')
  const closedTerm = await ENDED(client, 'terminal.ended', asking.sessionId, closeFrom, 'the closed terminal watch ended')
  const gone = await client.waitEvent('sessions.changed', { from: closeFrom, match: (d) => !d.sessions.some((s) => s.id === asking.sessionId), timeoutMs: 10_000, label: 'the closed session unlisted' })
  const unpersisted = await pollFor({ read: () => persistedSessions(profile).some((s) => s.id === asking.sessionId), settled: (p) => p === false, timeoutMs: 10_000, label: 'the closed session unpersisted' })
  const railText = await pollFor({
    read: () => app.client.evaluate(`document.querySelector('aside[aria-label="${copy('rail.label')}"]')?.textContent ?? ''`),
    settled: (t) => !t.includes('CLOSE-ME'),
    timeoutMs: 10_000,
    label: 'the rail without the closed session',
  })
  check(
    results,
    'forcing closes the agent: gone from the list, persistence, the rail and its attachments, both watches ended as closed',
    closed.ok === true && Boolean(gone) && unpersisted === false && !railText.includes('CLOSE-ME') && put.r?.complete === true && !existsSync(attachmentDir) &&
      closedConv?.d.reason === 'closed' && closedTerm?.d.reason === 'closed',
    `ok=${closed.ok} listed=${!gone} persisted=${unpersisted} rail=${railText.includes('CLOSE-ME')} dir=${existsSync(attachmentDir)} conversation=${closedConv?.d.reason} terminal=${closedTerm?.d.reason}`,
  )

  // A dormant session closes with no check.
  const dormantClose = await call(client, 'sessions.close', { sessionId: shell })
  const dormantGone = await pollFor({ read: async () => (await list(client)).sessions.some((s) => s.id === shell), settled: (l) => l === false, timeoutMs: 10_000, label: 'the dormant shell unlisted' })
  check(
    results,
    'a dormant session is closed from a device: gone from the list and persistence',
    dormantClose.ok === true && dormantGone === false && !persistedSessions(profile).some((s) => s.id === shell),
    JSON.stringify(dormantClose.e ?? ''),
  )

  for (const m of ['sessions.hibernate', 'sessions.close']) {
    const unknown = await call(client, m, { sessionId: 'no-such-session', force: true })
    check(results, `${m} of an unknown session is not found`, unknown.e?.code === 'NOT_FOUND', JSON.stringify(unknown.e))
  }

  // Focus: E displays the first of two shells, keyboard focus is in the side panel.
  const x1 = (await remoteCreate(client, 'e', 'shell')).r.sessionId
  const x2 = (await remoteCreate(client, 'e', 'shell')).r.sessionId
  await selectFolder(app, repos.names.e)
  const labels = Object.fromEntries((await list(client)).sessions.map((s) => [s.id, s.label]))
  await pollFor({ read: () => app.client.evaluate(SELECTED_TAB), settled: (t) => t?.includes(labels[x1]), timeoutMs: 10_000, label: 'the first shell displayed' })
  const panelFocus = await focusSidePanel(app)
  await call(client, 'sessions.hibernate', { sessionId: x1, force: true })
  await pollFor({ read: () => runningOf(client, x1), settled: (r) => r === false, timeoutMs: 15_000, label: 'the displayed shell dormant' })
  const shownDormant = await pollFor({ read: () => app.client.evaluate(WAKE_SHOWN), settled: Boolean, timeoutMs: 10_000, label: 'the dormant screen shown' })
  await sleep(800)
  const focusAfterHibernate = await app.client.evaluate(FOCUS)
  check(
    results,
    'hibernating the displayed session from a device shows it dormant without taking focus, and the rail selection is unchanged',
    panelFocus === 'side-panel' && shownDormant === true && focusAfterHibernate === 'side-panel' && (await app.client.evaluate(SELECTED_FOLDER)) === repos.names.e,
    `before=${panelFocus} dormant=${shownDormant} after=${focusAfterHibernate}`,
  )

  await call(client, 'sessions.close', { sessionId: x1 })
  const replaced = await pollFor({ read: () => app.client.evaluate(SELECTED_TAB), settled: (t) => t?.includes(labels[x2]), timeoutMs: 10_000, label: 'the other shell displayed' })
  await sleep(800)
  const focusAfterClose = await app.client.evaluate(FOCUS)
  check(
    results,
    'closing the displayed session from a device displays the other without taking focus, and the rail selection is unchanged',
    Boolean(replaced?.includes(labels[x2])) && focusAfterClose === 'side-panel' && (await app.client.evaluate(SELECTED_FOLDER)) === repos.names.e,
    `tab=${replaced} focus=${focusAfterClose}`,
  )

  await selectFolder(app, repos.names.g)
  await selectFolder(app, repos.names.e)
  const turnedTo = await pollFor({ read: () => app.client.evaluate(FOCUS), settled: (f) => f === 'terminal', timeoutMs: 10_000, label: 'focus in the replacement terminal' })
  check(results, 'the session shown in place of a closed one takes focus once the user selects its item again', turnedTo === 'terminal', `focus=${turnedTo}`)

  // A device's hibernation leaves nothing behind: the user's own later hibernation focuses the Wake button.
  await call(client, 'sessions.hibernate', { sessionId: x2, force: true })
  await pollFor({ read: () => runningOf(client, x2), settled: (r) => r === false, timeoutMs: 15_000, label: 'x2 dormant' })
  await call(client, 'sessions.wake', { sessionId: x2 })
  await pollFor({ read: () => runningOf(client, x2), settled: Boolean, timeoutMs: 15_000, label: 'x2 running' })
  await sleep(1_000)
  await pressHibernate(app.client)
  const wakeFocused = await pollFor({ read: () => app.client.evaluate(WAKE_FOCUSED), settled: Boolean, timeoutMs: 10_000, label: 'the Wake button focused' })
  check(results, 'after a device hibernated and woke a session, the user hibernating it on the desktop focuses its Wake button', wakeFocused === true, `focus=${await app.client.evaluate(FOCUS)}`)

  // Closed on the desktop while watched: the client is told.
  const deskWatched = await watchedAgent(client, profile, stub, 'g')
  await call(client, 'terminal.watch', { sessionId: deskWatched.sessionId })
  const deskFrom = client.events.length
  await app.client.evaluate(`window.workspace.terminal.kill(${JSON.stringify(deskWatched.sessionId)})`)
  const deskConv = await ENDED(client, 'conversation.ended', deskWatched.sessionId, deskFrom, 'the desktop-closed conversation watch ended')
  const deskTerm = await ENDED(client, 'terminal.ended', deskWatched.sessionId, deskFrom, 'the desktop-closed terminal watch ended')
  check(
    results,
    'closing a watched session on the desktop ends both watches as closed',
    deskConv?.d.reason === 'closed' && deskTerm?.d.reason === 'closed',
    `conversation=${deskConv?.d.reason} terminal=${deskTerm?.d.reason}`,
  )

  // A process that exits on its own.
  const exiting = (await remoteCreate(client, 'f', 'shell')).r.sessionId
  await call(client, 'terminal.watch', { sessionId: exiting })
  await sleep(1_000)
  const exitFrom = client.events.length
  await call(client, 'terminal.input', { sessionId: exiting, data: 'exit\r' })
  const exitEnded = await ENDED(client, 'terminal.ended', exiting, exitFrom, 'the exited terminal watch ended')
  check(results, 'a shell that exits on its own ends the terminal watch as exited', exitEnded?.d.reason === 'exited', `reason=${exitEnded?.d.reason}`)
  await app.close()
}

/** remote-hibernate-close: the same focus rules with the conversation view as the agent's view. */
async function runHibernateCloseConversation(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A }, preferences: { terminal: { agentView: 'conversation' } } })
  const { app } = await start(context, profile)
  const { client } = await phone(app)
  await selectFolder(app, repos.names.f)
  const c1 = (await remoteCreate(client, 'e', 'claude')).r.sessionId
  const c2 = (await remoteCreate(client, 'e', 'claude')).r.sessionId
  for (const id of [c1, c2]) {
    await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === id)?.wait, settled: (w) => w === 'ready', timeoutMs: 20_000, label: `${id} ready` })
  }
  const labels = Object.fromEntries((await list(client)).sessions.map((s) => [s.id, s.label]))
  // The second one dormant and not displayed, so it shows its Wake button when it takes the first one's place.
  await call(client, 'sessions.hibernate', { sessionId: c2 })
  await pollFor({ read: () => runningOf(client, c2), settled: (r) => r === false, timeoutMs: 15_000, label: 'c2 dormant' })
  await selectFolder(app, repos.names.e)
  await pollFor({ read: () => app.client.evaluate(SELECTED_TAB), settled: (t) => t?.includes(labels[c1]), timeoutMs: 10_000, label: 'c1 displayed' })
  const panelFocus = await focusSidePanel(app)

  await call(client, 'sessions.hibernate', { sessionId: c1 })
  await pollFor({ read: () => runningOf(client, c1), settled: (r) => r === false, timeoutMs: 15_000, label: 'c1 dormant' })
  const shownDormant = await pollFor({ read: () => app.client.evaluate(WAKE_SHOWN), settled: Boolean, timeoutMs: 10_000, label: 'the dormant conversation shown' })
  await sleep(800)
  const afterHibernate = await app.client.evaluate(FOCUS)
  check(
    results,
    'hibernating the displayed session in the conversation view from a device does not take focus',
    panelFocus === 'side-panel' && shownDormant === true && afterHibernate === 'side-panel',
    `before=${panelFocus} dormant=${shownDormant} after=${afterHibernate}`,
  )

  await call(client, 'sessions.close', { sessionId: c1 })
  const replaced = await pollFor({ read: () => app.client.evaluate(SELECTED_TAB), settled: (t) => t?.includes(labels[c2]), timeoutMs: 10_000, label: 'c2 displayed' })
  await sleep(800)
  const afterClose = await app.client.evaluate(FOCUS)
  check(
    results,
    'closing the displayed session in the conversation view from a device shows the dormant one in its place without taking focus',
    Boolean(replaced?.includes(labels[c2])) && afterClose === 'side-panel' && (await app.client.evaluate(WAKE_SHOWN)) === true,
    `tab=${replaced} focus=${afterClose}`,
  )

  await selectFolder(app, repos.names.g)
  await selectFolder(app, repos.names.e)
  const turnedTo = await pollFor({ read: () => app.client.evaluate(WAKE_FOCUSED), settled: Boolean, timeoutMs: 10_000, label: 'the Wake button focused after reselection' })
  check(results, 'in the conversation view, selecting the item again focuses the replacement\'s Wake button', turnedTo === true, `focus=${await app.client.evaluate(FOCUS)}`)
  await app.close()
}

/** remote-hibernate-close: a conversation watch ended by a hibernation stops counting as displayed. */
async function runWatchEndAutoHibernate(_mode, _config, context) {
  const repos = makeRepos()
  const THRESHOLD_S = 4
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A }, preferences: { terminal: { autoHibernateSeconds: THRESHOLD_S } } })
  const { app } = await start(context, profile)
  const { client } = await phone(app)
  await selectFolder(app, repos.names.f)
  const sessionId = (await remoteCreate(client, 'g', 'claude')).r.sessionId
  await pollFor({ read: async () => (await list(client)).sessions.find((s) => s.id === sessionId)?.wait, settled: (w) => w === 'ready', timeoutMs: 20_000, label: 'ready' })
  // A wake reads the persisted record, which the window pushes on a 500 ms debounce that every change of the
  // starting agent resets: a hibernation before it lands leaves a session that cannot be woken (seen here).
  await pollFor({ read: () => persistedSessions(profile).some((x) => x.id === sessionId), settled: Boolean, timeoutMs: 15_000, label: 'persisted' })
  await call(client, 'conversation.watch', { sessionId })
  const from = client.events.length
  await call(client, 'sessions.hibernate', { sessionId })
  const ended = await ENDED(client, 'conversation.ended', sessionId, from, 'the watch ended')
  await pollFor({ read: () => runningOf(client, sessionId), settled: (r) => r === false, timeoutMs: 15_000, label: 'hibernated' })
  // Woken and left alone: no unwatch is sent, so only the ending can have withdrawn the watch's report.
  // The wake must be seen to happen: a session that never woke reads "not running" too.
  const wakeFrom = client.events.length
  const woke = await call(client, 'sessions.wake', { sessionId })
  const ran = await client.waitEvent('sessions.changed', {
    from: wakeFrom,
    match: (d) => d.sessions.some((s) => s.id === sessionId && s.running),
    timeoutMs: 15_000,
    label: 'running again',
  })
  const asleep = await client.waitEvent('sessions.changed', {
    from: ran ? client.events.indexOf(ran) + 1 : client.events.length,
    match: (d) => d.sessions.some((s) => s.id === sessionId && !s.running),
    timeoutMs: (THRESHOLD_S + 25) * 1000,
    label: 'hibernated automatically',
  })
  check(
    results,
    'a session hibernated while watched hibernates automatically again after waking',
    ended?.d.reason === 'hibernated' && woke.ok === true && Boolean(ran) && Boolean(asleep),
    `ended=${ended?.d.reason} woke=${JSON.stringify(woke.e ?? 'ok')} ran=${Boolean(ran)} asleep=${Boolean(asleep)}`,
  )
  await app.close()
}

/**
 * remote-close-offer: a device sees an agent's offer to close its own session, and answers it. Every assertion reads a
 * `sessions.changed` event that arrived after its action, never a fresh `sessions.list`: a missing announcement must
 * turn it red.
 */
async function runCloseOffer(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile)
  const { client } = await phone(app)
  await call(client, 'attention.watch')

  // Created on the desktop, so it is displayed and its offer card is on screen.
  await selectFolder(app, repos.names.f)
  const before = new Set((await list(client)).sessions.map((s) => s.id))
  await desktopCreate(app, 'claude')
  const S = await pollFor({
    read: async () => (await list(client)).sessions.find((s) => s.target === 'claude' && !before.has(s.id))?.id ?? null,
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'the desktop agent listed',
  })
  await conversationOf(profile, S)
  await pollFor({ read: () => stub.ready(), settled: Boolean, timeoutMs: 15_000, label: 'the stub ready' })

  const sessionIn = (d) => d.sessions.find((s) => s.id === S)
  const changed = (from, match, what) =>
    client.waitEvent('sessions.changed', { from, match: (d) => match(sessionIn(d)), timeoutMs: 15_000, label: what })
  // The agent's close of its own session: written into its own drop point, as an agent does.
  const outbox = join(profile, 'handoff', 'outbox', S)
  let n = 0
  const stage = () => {
    mkdirSync(outbox, { recursive: true })
    const partial = join(outbox, `.control-${++n}.partial`)
    writeFileSync(partial, JSON.stringify({ kind: 'close' }))
    return partial
  }
  const commit = (partial) => renameSync(partial, join(outbox, `control-${Date.now()}-${n}.json`))
  const turnStart = () => fireEvent(profile, S, { hook_event_name: 'UserPromptSubmit', prompt: 'wrap up' })
  const stop = () => fireEvent(profile, S, { hook_event_name: 'Stop' })
  /** A turn in which the agent closes itself, ending in an offer the list marks. */
  const offer = async (what) => {
    const from = client.events.length
    turnStart()
    commit(stage())
    await sleep(800)
    stop()
    return changed(from, (s) => s?.closeOffered === true, what)
  }
  const CARD = `[role="group"]${label('sessions.closeOffer.label')}`
  const cardShown = () =>
    app.client.evaluate(`[...document.querySelectorAll(${JSON.stringify(CARD)})].some((g) => g.getBoundingClientRect().width > 0)`)
  const clickCard = async (text) => {
    const at = await pollFor({
      read: () =>
        app.client.evaluate(`(() => {
          const group = [...document.querySelectorAll(${JSON.stringify(CARD)})].find((g) => g.getBoundingClientRect().width > 0)
          const button = [...(group?.querySelectorAll('button') ?? [])].find((b) => b.textContent === ${JSON.stringify(text)})
          const r = button?.getBoundingClientRect()
          return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
        })()`),
      settled: Boolean,
      timeoutMs: 10_000,
      label: `the card's ${text}`,
    })
    if (!at) throw new Error(`no card button ${text}`)
    await realClick(app.client, at)
  }

  // ── an offer made with no other change: the command is read after the turn ended. The list is also recomputed
  // every 5 s while a device is connected, which delivers the mark without `offersChanged`, only later: so the
  // assertion is on time (measured: ~160 ms with it, 1.4–2.1 s without). Three tries: a reconcile tick landing inside
  // the window by chance each time is ~0.3%. ──
  const LATE_WITHIN_MS = 700
  const lateTry = async () => {
    const from = client.events.length
    turnStart()
    const partial = stage()
    await sleep(1_000)
    stop()
    const ready = await changed(from, (s) => s?.wait === 'ready' && s.closeOffered === undefined, 'S ready and unmarked after its turn')
    await sleep(600)
    const commitFrom = client.events.length
    const commitAt = Date.now()
    commit(partial)
    const marked = await changed(commitFrom, (s) => s?.closeOffered === true, 'the late-read offer marked').catch(() => null)
    return { from, ready: Boolean(ready), running: marked ? sessionIn(marked.d)?.running : null, ms: marked ? marked.receivedAt - commitAt : null }
  }
  const tries = []
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) {
      const from = client.events.length
      await call(client, 'sessions.keep', { sessionId: S })
      await changed(from, (s) => s !== undefined && s.closeOffered === undefined, 'S unmarked between tries')
    }
    tries.push(await lateTry())
  }
  const lateCard = await pollFor({ read: cardShown, settled: Boolean, timeoutMs: 10_000, label: 'the card on the desktop' }).catch(() => false)
  check(
    results,
    'an offer read after the turn ended reaches the client with no other change, at once: marked and running, and the desktop shows the card',
    tries.every((t) => t.ready && t.running === true && t.ms !== null && t.ms < LATE_WITHIN_MS) && lateCard === true,
    JSON.stringify({ tries: tries.map(({ ready, running, ms }) => ({ ready, running, ms })), card: lateCard }),
  )
  await sleep(2_000)
  const attentionForS = client.eventsOf('attention', tries.at(-1).from).filter((event) => event.d.sessionId === S)
  check(
    results,
    'an offered turn raises exactly one waiting event, and no other attention event, for the session',
    attentionForS.length === 1 && attentionForS[0].d.kind === 'waiting',
    JSON.stringify(attentionForS.map((event) => event.d.kind)),
  )

  // ── keeping from the device withdraws it on both sides ──
  const keepFrom = client.events.length
  const kept = await call(client, 'sessions.keep', { sessionId: S })
  const keptEvent = await changed(keepFrom, (s) => s !== undefined && s.closeOffered === undefined, 'S unmarked after keep').catch(() => null)
  const cardGone = await pollFor({ read: cardShown, settled: (shown) => shown === false, timeoutMs: 10_000, label: 'the card gone' }).catch(() => true)
  check(
    results,
    "a device's keep succeeds, clears the mark and the desktop's card, and the session runs on",
    kept.ok === true && sessionIn(keptEvent?.d ?? { sessions: [] })?.running === true && cardGone === false,
    JSON.stringify({ kept: kept.e ?? kept.r, event: keptEvent ? sessionIn(keptEvent.d) : null, card: cardGone }),
  )

  // ── the usual offer (the command inside the turn) is marked; the desktop's Keep clears the mark ──
  const usual = await offer('the usual offer marked').catch(() => null)
  check(results, 'a close written inside the turn is marked when the turn ends', Boolean(usual), '')
  await pollFor({ read: cardShown, settled: Boolean, timeoutMs: 10_000, label: 'the card shown' })
  const desktopKeepFrom = client.events.length
  await clickCard(copy('sessions.closeOffer.keep'))
  const desktopKept = await changed(desktopKeepFrom, (s) => s !== undefined && s.closeOffered === undefined, 'S unmarked after the desktop Keep').catch(() => null)
  check(results, "the desktop's Keep clears the mark for devices", Boolean(desktopKept) && sessionIn(desktopKept.d).running === true, '')

  // ── typing into the session clears the mark ──
  await offer('offered before typing')
  const typeFrom = client.events.length
  await app.client.evaluate(`window.workspace.terminal.write(${JSON.stringify(S)}, 'y')`)
  const typedAway = await changed(typeFrom, (s) => s !== undefined && s.closeOffered === undefined, 'S unmarked after typing').catch(() => null)
  check(results, 'typing into the session clears the mark for devices', Boolean(typedAway), '')

  // ── keeping a session with no offer has no effect ──
  const noneFrom = client.events.length
  const keptNone = await call(client, 'sessions.keep', { sessionId: S })
  await sleep(1_000)
  const after = sessionIn(await list(client))
  check(
    results,
    'keeping a session with no offer succeeds with no change',
    keptNone.ok === true && after?.running === true && after.closeOffered === undefined &&
      client.eventsOf('sessions.changed', noneFrom).every((event) => sessionIn(event.d)?.closeOffered === undefined),
    JSON.stringify({ keep: keptNone.e ?? keptNone.r, after }),
  )

  // ── hibernated on the desktop and woken: the old offer does not come back ──
  await offer('offered before hibernating')
  const hibernateFrom = client.events.length
  await pressHibernate(app.client)
  await changed(hibernateFrom, (s) => s?.running === false, 'S dormant')
  const wakeFrom = client.events.length
  await clickButtonText(app.client, 'main', copy('sessions.wake'))
  const woken = await changed(wakeFrom, (s) => s?.running === true, 'S running again').catch(() => null)
  await sleep(1_500)
  const markedSince = client.eventsOf('sessions.changed', hibernateFrom).filter((event) => sessionIn(event.d)?.closeOffered === true)
  check(
    results,
    'an offered session hibernated and woken carries no old offer',
    Boolean(woken) && sessionIn(woken.d).closeOffered === undefined && markedSince.length === 0,
    JSON.stringify({ woken: woken ? sessionIn(woken.d) : null, marked: markedSince.length }),
  )

  // ── closing an offered, waiting session from the device closes it, without forcing ──
  await pollFor({ read: () => stub.ready(), settled: Boolean, timeoutMs: 15_000, label: 'the stub ready again' })
  const toClose = await offer('offered before closing').catch(() => null)
  const closeFrom = client.events.length
  const closed = await call(client, 'sessions.close', { sessionId: S })
  const gone = await changed(closeFrom, (s) => s === undefined, 'S unlisted').catch(() => null)
  check(
    results,
    'closing an offered session that waits for input succeeds without forcing, and it leaves the list',
    sessionIn(toClose?.d ?? { sessions: [] })?.wait === 'ready' && closed.ok === true && Boolean(gone),
    JSON.stringify({ offered: toClose ? sessionIn(toClose.d) : null, close: closed.e ?? closed.r }),
  )
}

/**
 * session-wait-indicator: the list's `seen` follows the desktop's seen mark.
 *
 * The stub starts without its startup `Stop` and reports its start four seconds after spawn, by when a shell is
 * displayed: a start reported while shown is seen at once, and the baseline could then not tell a start from a
 * turn end. Turns are driven with stub commands, so no keystroke reaches the session (a device's terminal input
 * would count as one).
 */
async function runSeen(_mode, _config, context) {
  // The section before may leave its app running; a second app on the same port would answer for this one.
  if (context.app) await context.app.close()
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile, { startupStop: false, readyDelaySeconds: 4 })
  const { client } = await phone(app)
  await selectFolder(app, repos.names.f)
  await desktopCreate(app, 'claude')
  await desktopCreate(app, 'shell')
  const conversation = (await pollFor({ read: () => stub.peerNames(), settled: (l) => l.length >= 1, timeoutMs: 20_000, label: 'the agent started' })).at(-1)?.conversation
  const agentOf = (sessions) => sessions.find((s) => s.folderId === 'f' && s.target === 'claude')
  const shellOf = (sessions) => sessions.find((s) => s.folderId === 'f' && s.target === 'shell')

  const started = await pollFor({ read: async () => agentOf((await list(client)).sessions), settled: (s) => s?.wait === 'ready', timeoutMs: 20_000, label: 'the agent ready' })
  check(results, 'a started agent is listed ready and seen (the baseline)', started?.wait === 'ready' && started.seen === true, JSON.stringify(started))
  const id = started?.id

  const from = client.events.length
  stub.command(conversation, 'fire UserPromptSubmit\nsleep 1\nfire Stop')
  const busy = await client.waitEvent('sessions.changed', { from, match: (d) => agentOf(d.sessions)?.wait === 'busy', timeoutMs: 10_000, label: 'listed working' })
  const unseen = await client.waitEvent('sessions.changed', { from, match: (d) => agentOf(d.sessions)?.wait === 'ready' && agentOf(d.sessions)?.seen === false, timeoutMs: 15_000, label: 'listed not seen' })
  check(results, 'a turn that ends unwatched and not displayed is listed ready and not seen', Boolean(unseen), JSON.stringify(unseen ? agentOf(unseen.d.sessions) : null))
  check(
    results,
    'the seen field is absent while the agent works, and on a shell',
    Boolean(busy) && !('seen' in agentOf(busy.d.sessions)) && !('seen' in (shellOf(busy.d.sessions) ?? { seen: 'no shell' })),
    JSON.stringify({ busy: busy ? agentOf(busy.d.sessions) : null, shell: busy ? shellOf(busy.d.sessions) : null }),
  )

  await call(client, 'terminal.watch', { sessionId: id })
  await sleep(1_500)
  const terminalWatched = agentOf((await list(client)).sessions)
  await call(client, 'terminal.unwatch')
  check(results, 'a terminal watch does not mark the session seen', terminalWatched?.seen === false, JSON.stringify(terminalWatched))

  const watchFrom = client.events.length
  await call(client, 'conversation.watch', { sessionId: id })
  const seen = await client.waitEvent('sessions.changed', { from: watchFrom, match: (d) => agentOf(d.sessions)?.seen === true, timeoutMs: 10_000, label: 'listed seen' })
  check(results, "watching a session's conversation lists it seen", Boolean(seen), JSON.stringify(agentOf((await list(client)).sessions)))
  const tabs = await pollFor({
    read: () => app.client.evaluate(`[...document.querySelectorAll('[role="tablist"][aria-label="${copy('sessions.tabs')}"] [role="tab"]')].map((t) => t.getAttribute('title') ?? '')`),
    settled: (titles) => titles[0]?.includes(copy('sessions.attentionIdle')),
    timeoutMs: 10_000,
    label: 'the desktop tab idle',
  })
  check(results, "a device's conversation watch clears the waiting state on the desktop", tabs[0]?.includes(copy('sessions.attentionIdle')), JSON.stringify(tabs))

  const turnFrom = client.events.length
  stub.command(conversation, 'fire UserPromptSubmit\nsleep 1\nfire Stop')
  const watchedBusy = await client.waitEvent('sessions.changed', { from: turnFrom, match: (d) => agentOf(d.sessions)?.wait === 'busy', timeoutMs: 10_000, label: 'working during the watch' })
  // The first ready listing **after** the busy one: the listing before the turn is ready and seen too.
  const firstReady = watchedBusy
    ? await client.waitEvent('sessions.changed', { from: client.events.indexOf(watchedBusy) + 1, match: (d) => agentOf(d.sessions)?.wait === 'ready', timeoutMs: 15_000, label: 'ready after the watched turn' })
    : null
  check(
    results,
    'a turn that ends during a conversation watch is seen the first time it is listed ready',
    Boolean(watchedBusy) && agentOf(firstReady?.d.sessions ?? [])?.seen === true,
    JSON.stringify({ busy: Boolean(watchedBusy), ready: firstReady ? agentOf(firstReady.d.sessions) : null }),
  )
  await call(client, 'conversation.unwatch')
  await app.close()
}

/**
 * remote-background-tasks: a device sees the background work of an agent session, from the agent's own reports
 * (`Stop` and `SubagentStop`). Every assertion but the `/clear` one reads a `sessions.changed` event that arrived after
 * its action: a missing announcement must turn it red.
 */
async function runBackground(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile)
  const { client } = await phone(app)
  await selectFolder(app, repos.names.f)
  const before = new Set((await list(client)).sessions.map((s) => s.id))
  await desktopCreate(app, 'claude')
  const S = await pollFor({
    read: async () => (await list(client)).sessions.find((s) => s.target === 'claude' && !before.has(s.id))?.id ?? null,
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'the desktop agent listed',
  })
  await conversationOf(profile, S)
  await pollFor({ read: () => stub.ready(), settled: Boolean, timeoutMs: 15_000, label: 'the stub ready' })
  // The stub's own startup events are drained before the first report.
  await sleep(1_000)

  const sessionIn = (d) => d.sessions.find((s) => s.id === S)
  const changed = (from, match, what) =>
    client.waitEvent('sessions.changed', { from, match: (d) => match(sessionIn(d)), timeoutMs: 15_000, label: what })
  const idsOf = (s) => (s?.background ?? []).map((task) => task.id).join(',')
  const C = { id: 'agent-c', type: 'subagent', status: 'running', description: 'Probe agent', agent_type: 'general-purpose' }
  const SH = { id: 'shell-d', type: 'shell', status: 'running', description: 'Run the dev server', command: 'npm run dev -- --port 5173' }
  const DONE = { id: 'shell-x', type: 'shell', status: 'completed', command: 'true' }
  const stop = (tasks) => fireEvent(profile, S, { hook_event_name: 'Stop', background_tasks: tasks })

  // ── a turn ends with a subagent and a shell in flight, and a finished shell ──
  let from = client.events.length
  fireEvent(profile, S, { hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
  stop([C, SH, DONE])
  const listed = await changed(from, (s) => idsOf(s) === 'agent-c,shell-d', 'S carries C and the shell').catch(() => null)
  const listedTasks = listed ? sessionIn(listed.d).background : null
  check(
    results,
    'a turn end lists the subagent and the shell in flight, labelled, and not the finished shell',
    JSON.stringify(listedTasks) ===
      JSON.stringify([
        { id: 'agent-c', kind: 'agent', label: 'Probe agent' },
        { id: 'shell-d', kind: 'shell', label: 'Run the dev server' },
      ]),
    JSON.stringify(listedTasks),
  )

  // ── a subagent's stop changes no wait state; its list reaches the device at once. The list is also recomputed every
  // 5 s while a device is connected, which delivers it without the `backgroundChanged` wiring, only later: so the
  // assertion is on time (measured: 178–381 ms with it, 4.4–5.0 s without, red at this assertion only). Each try first
  // lists C again (otherwise the debounce or the JSON dedup would merge the two changes). ──
  const SUBAGENT_WITHIN_MS = 1_000
  const tries = []
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) {
      from = client.events.length
      stop([C, SH])
      await changed(from, (s) => idsOf(s) === 'agent-c,shell-d', 'C listed again')
      await sleep(600)
    }
    from = client.events.length
    const at = Date.now()
    fireEvent(profile, S, { hook_event_name: 'SubagentStop', agent_id: C.id, agent_type: 'general-purpose', background_tasks: [C, SH] })
    const alone = await changed(from, (s) => idsOf(s) === 'shell-d', 'S carries the shell alone').catch(() => null)
    tries.push(alone ? alone.receivedAt - at : null)
  }
  check(
    results,
    "a subagent's stop reaches the client at once, without the subagent",
    tries.every((ms) => ms !== null && ms < SUBAGENT_WITHIN_MS),
    JSON.stringify({ ms: tries }),
  )

  // ── /clear leaves the list alone: read once the event was drained ──
  const clearFile = fireEvent(profile, S, { hook_event_name: 'SessionStart', source: 'clear' })
  await pollFor({ read: () => !existsSync(clearFile), settled: Boolean, timeoutMs: 10_000, label: 'the SessionStart drained' })
  const afterClear = sessionIn(await list(client))
  check(results, 'a cleared conversation leaves the background tasks listed', idsOf(afterClear) === 'shell-d', JSON.stringify(afterClear?.background))

  // ── a turn end with nothing in flight removes the field ──
  from = client.events.length
  stop([])
  const emptied = await changed(from, (s) => s !== undefined && !('background' in s), 'S without background').catch(() => null)
  check(results, 'a turn end with nothing in flight removes the background field', Boolean(emptied), '')

  // ── hibernation removes it ──
  from = client.events.length
  stop([SH])
  const relisted = await changed(from, (s) => idsOf(s) === 'shell-d', 'the shell listed before hibernating').catch(() => null)
  from = client.events.length
  await pressHibernate(app.client)
  const dormant = await changed(from, (s) => s?.running === false, 'S dormant').catch(() => null)
  check(
    results,
    'a hibernated session carries no background field',
    Boolean(relisted) && Boolean(dormant) && !('background' in sessionIn(dormant.d)),
    JSON.stringify(dormant ? sessionIn(dormant.d) : null),
  )
  await app.close()
}

/**
 * remote-phone-context: a device's prompt carries the phone-origin note outside the message, and a watched
 * conversation carries the agent's reported model and usage and its skills; a `/skill args` reply is confirmed.
 *
 * The note is the stdout of the second `UserPromptSubmit` command (the event bridge's is first and prints nothing).
 * Control groups, run: replace `mv` with `cp` in `ORIGIN_COMMAND` (the mark is never taken) → the desktop prompt
 * after the reply carries the note (red); drop the `mv` condition's success (`mv … && false`) → the reply has no
 * note (red).
 */
async function runPhoneContext(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app, stub } = await start(context, profile, { slashCommands: true, skillListing: ['probe-skill', 'pdf'] })
  const { client } = await phone(app)
  const agent = await remoteCreate(client, 'f', 'claude')
  const sessionId = agent.r.sessionId
  const conv = await conversationOf(profile, sessionId)
  await pollFor({ read: () => stub.ready(), settled: Boolean, timeoutMs: 15_000, label: 'the stub ready' })
  await sleep(1_000)
  const watchFrom = client.events.length
  await call(client, 'conversation.watch', { sessionId })
  await client.waitEvent('conversation.wait', { from: watchFrom, match: (d) => d.state === 'ready', timeoutMs: 15_000, label: 'ready' })
  const note = () => stub.hookStdout('UserPromptSubmit', 2)
  const parsedNote = () => {
    try {
      return JSON.parse(note()).hookSpecificOutput
    } catch {
      return null
    }
  }
  const userEntry = (from, needle) =>
    client.waitEvent('conversation.update', { from, match: (d) => d.events.some((e) => e.kind === 'user' && e.text.includes(needle)), timeoutMs: 15_000, label: `the entry ${needle}` })

  // ── the note: a device reply carries it, outside the message; the next desktop prompt does not ──
  let from = client.events.length
  const sent = await call(client, 'conversation.send', { sessionId, text: 'PHONE-REPLY' })
  const replyEntry = await userEntry(from, 'PHONE-REPLY')
  const replyNote = parsedNote()
  const replyText = replyEntry?.d.events.find((e) => e.kind === 'user' && e.text.includes('PHONE-REPLY'))?.text
  check(
    results,
    'a device reply reaches the agent with the phone-origin note as hook context, and its entry equals the reply text',
    sent.r?.outcome === 'submitted' && replyNote?.hookEventName === 'UserPromptSubmit' && /from their phone/.test(replyNote?.additionalContext ?? '') &&
      replyText === sent.r?.text && !replyText.includes('phone'),
    `outcome=${sent.r?.outcome} note=${JSON.stringify(note().slice(0, 80))} entry=${JSON.stringify(replyText)}`,
  )
  await turnAfter(client, from, 'the phone reply')
  from = client.events.length
  await app.client.evaluate(`window.workspace.terminal.write(${JSON.stringify(sessionId)}, 'DESK-PROMPT\\r')`)
  await userEntry(from, 'DESK-PROMPT')
  check(results, 'the next prompt typed at the desktop carries no note', note() === '', JSON.stringify(note().slice(0, 80)))
  await turnAfter(client, from, 'the desktop prompt')

  // ── usage: sent at the watch's start, again on a new report, never in the session list ──
  const statuses = () => client.eventsOf('conversation.status').map((e) => e.d)
  const first = statuses()[0]
  check(results, 'a watch starts with the agent status event, empty before any report', first?.sessionId === sessionId && Object.keys(first).length === 1, JSON.stringify(first))
  const payload = (percent) => ({
    session_id: 'x', cwd: '/home/me/secret', transcript_path: '/home/me/t.jsonl', version: '9.9.9',
    model: { display_name: 'Probe Model' }, effort: { level: 'high' },
    context_window: { used_percentage: percent, context_window_size: 200000 },
    cost: { total_cost_usd: 0.5 },
    rate_limits: { five_hour: { used_percentage: 7, resets_at: 1760000000 } },
  })
  from = client.events.length
  stub.command(conv, stub.statusLine(payload(20)))
  const reported = await client.waitEvent('conversation.status', { from, match: (d) => d.model === 'Probe Model', timeoutMs: 8_000, label: 'the reported status' })
  check(
    results,
    "a watched conversation receives the agent's model, context, cost and rate limit, and no path",
    JSON.stringify(reported?.d) === JSON.stringify({ sessionId, model: 'Probe Model', effort: 'high', context: { percent: 20, size: 200000 }, costUsd: 0.5, rateLimits: { fiveHour: { percent: 7, resetsAt: 1760000000000 } } }),
    JSON.stringify(reported?.d),
  )
  from = client.events.length
  const raisedAt = Date.now()
  stub.command(conv, stub.statusLine(payload(55)))
  const raised = await client.waitEvent('conversation.status', { from, match: (d) => d.context?.percent === 55, timeoutMs: 8_000, label: 'the raised context' })
  const usageInList = client.eventsOf('sessions.changed').some((e) => e.d.sessions.some((x) => 'model' in x || 'context' in x || 'costUsd' in x || 'rateLimits' in x))
  check(
    results,
    'a new report reaches the watching client within a few seconds, and no session list carries usage',
    Boolean(raised) && raised.receivedAt - raisedAt < 5_000 && !usageInList,
    `ms=${raised ? raised.receivedAt - raisedAt : null} usageInList=${usageInList}`,
  )

  // ── skills: the listing, a later addition, and a slash reply confirmed ──
  const skills = () => client.eventsOf('conversation.skills').map((e) => e.d.skills)
  const firstSkills = skills()[0]
  check(
    results,
    "a watched conversation receives the agent's skills with their descriptions",
    JSON.stringify(firstSkills) === JSON.stringify([{ name: 'probe-skill', description: 'STUB-SKILL probe-skill' }, { name: 'pdf', description: 'STUB-SKILL pdf' }]),
    JSON.stringify(skills()),
  )
  from = client.events.length
  stub.command(conv, stub.skillListing(['probe-new']))
  const added = await client.waitEvent('conversation.skills', { from, timeoutMs: 8_000, label: 'the added skill' })
  check(results, 'a later listing adds a skill', JSON.stringify(added?.d.skills?.map((x) => x.name)) === JSON.stringify(['probe-skill', 'pdf', 'probe-new']), JSON.stringify(added?.d))
  from = client.events.length
  const slash = await call(client, 'conversation.send', { sessionId, text: '  /probe-skill   SLASH-ARGS  two ' })
  const slashEntry = await userEntry(from, 'SLASH-ARGS')
  const slashText = slashEntry?.d.events.find((e) => e.kind === 'user' && e.text.includes('SLASH-ARGS'))?.text
  check(
    results,
    'a slash reply is written in the shown form, and its entry equals the reply text',
    slash.r?.text === '/probe-skill SLASH-ARGS  two' && slashText === slash.r?.text,
    `r.text=${JSON.stringify(slash.r?.text)} entry=${JSON.stringify(slashText)}`,
  )

  // ── a device's send of a filled-in prompt carries the note ──
  await turnAfter(client, from, 'the slash reply')
  const inbox = join(profile, 'intake-inbox')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'pc1.json.tmp'), JSON.stringify({ id: 'pc1', origin: { kind: 'slack', id: 'C1', label: '#dev' }, title: 'PC-ITEM', body: 'PC-BODY', actor: 'someone' }))
  renameSync(join(inbox, 'pc1.json.tmp'), join(inbox, 'pc1.json'))
  const item = await pollFor({ read: async () => (await call(client, 'inbox.list')).r.items.find((i) => i.id === 'pc1') ?? null, settled: Boolean, timeoutMs: 20_000, label: 'the item' })
  from = client.events.length
  const accepted = await call(client, 'inbox.accept', { adapter: item.adapter, id: 'pc1', folderId: 'g' })
  const target = accepted.r?.sessionId
  const listed = await client.waitEvent('sessions.changed', { from, match: (d) => Boolean(d.sessions.find((x) => x.id === target)?.prefill), timeoutMs: 20_000, label: 'the fill listed' })
  const prefill = listed?.d.sessions.find((x) => x.id === target)?.prefill
  // The stub keeps one hook stdout per command for all its sessions: a desktop prompt first clears the slash reply's
  // note, so the note read below can only be the submit's.
  from = client.events.length
  await app.client.evaluate(`window.workspace.terminal.write(${JSON.stringify(sessionId)}, 'DESK-AGAIN\\r')`)
  await userEntry(from, 'DESK-AGAIN')
  const clearedBefore = note() === ''
  await sleep(1_000)
  const submitted = await call(client, 'sessions.submitPrefill', { sessionId: target, prefillId: prefill?.id })
  await sleep(1_500)
  check(
    results,
    "a device's send of a filled-in prompt carries the phone-origin note",
    clearedBefore && submitted.r?.outcome !== undefined && /from their phone/.test(parsedNote()?.additionalContext ?? ''),
    `clearedBefore=${clearedBefore} outcome=${JSON.stringify(submitted.r ?? submitted.e)} note=${JSON.stringify(note().slice(0, 60))}`,
  )
  await app.close()
}

const SECTIONS = [
  { name: 'runListener', run: runListener },
  { name: 'runPairing', run: runPairing },
  { name: 'runIndicator', run: runIndicator },
  { name: 'runSessions', run: runSessions },
  { name: 'runConversation', run: runConversation },
  { name: 'runTerminal', run: runTerminal },
  { name: 'runIntakeHandoff', run: runIntakeHandoff },
  { name: 'runReaccept', run: runReaccept },
  { name: 'runPrefillSubmit', run: runPrefillSubmit },
  { name: 'runScheduled', run: runScheduled },
  { name: 'runRecurring', run: runRecurring },
  { name: 'runOpenSpec', run: runOpenSpec },
  { name: 'runAttention', run: runAttention },
  { name: 'runHibernation', run: runHibernation },
  { name: 'runRename', run: runRename },
  { name: 'runAttachments', run: runAttachments },
  { name: 'runAnswer', run: runAnswer },
  { name: 'runHibernateClose', run: runHibernateClose },
  { name: 'runHibernateCloseConversation', run: runHibernateCloseConversation },
  { name: 'runWatchEndAutoHibernate', run: runWatchEndAutoHibernate },
  { name: 'runCloseOffer', run: runCloseOffer },
  { name: 'runSeen', run: runSeen },
  { name: 'runBackground', run: runBackground },
  { name: 'runPhoneContext', run: runPhoneContext },
].map((section) => ({
  ...section,
  // A section that hangs leaves its app behind; the profile prefix finds it (character class: not this command).
  onTimeout: async () => {
    spawn('pkill', ['-9', '-f', `spekterm[-]remote-profile-`], { stdio: 'ignore' })
    await sleep(1_000)
  },
}))

const outcome = await runSections({
  sections: SECTIONS,
  build: { port: PORT, rendererUrl: null },
  dev: null,
  results,
  afterMode: async (_mode, context) => {
    if (context.app) await context.app.close()
  },
  cleanup: () => {
    spawn('pkill', ['-9', '-f', `spekterm[-]remote-profile-`], { stdio: 'ignore' })
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  },
})

process.exit(outcome.ok ? 0 : 1)
