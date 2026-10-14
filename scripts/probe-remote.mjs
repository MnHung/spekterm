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
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { check, connectToApp, pollFor, pressKey } from './lib/cdp.mjs'
import { copy, label } from './lib/copy.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { awaitMounted } from './lib/mounted.mjs'
import { PROBE_PORTS, STUB_PORTS } from './lib/ports.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { helloRemote, openRemote, pairRemote, parsePairingLink } from './lib/remote-client.mjs'
import { runSections } from './lib/sections.mjs'
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

const DIALOG = `[role="dialog"]${label('remote.title')}`
const SETTINGS_DIALOG = `[role="dialog"]${label('settings.title')}`
const ACTIVITY = `nav${label('activityBar.label')}`

async function openRemoteDialog(app) {
  await clickSelector(app.client, `${ACTIVITY} button${label('activityBar.settings')}`, 'the Settings entry')
  await clickSelector(app.client, `${SETTINGS_DIALOG} button${label('remote.section.open')}`, 'the remote access section control')
  await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`), settled: Boolean, timeoutMs: 10_000, label: 'the dialog' })
}

async function closeRemoteDialog(app) {
  await clickSelector(app.client, `${DIALOG} button${label('remote.close')}`, 'the dialog close button')
  await pollFor({ read: () => app.client.evaluate(`!document.querySelector(${JSON.stringify(DIALOG)})`), settled: Boolean, timeoutMs: 10_000, label: 'the dialog closed' })
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
function fireEvent(profile, sessionId, body) {
  const dir = join(profile, 'agent-events', sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${process.hrtime.bigint()}-probe.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(body))
  renameSync(`${file}.tmp`, file)
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
    await closeRemoteDialog(second.app)
    await clickSelector(second.app.client, `${ACTIVITY} button${label('activityBar.settings')}`)
    const line = await pollFor({
      read: () => second.app.client.evaluate(`document.querySelector(${JSON.stringify(`${SETTINGS_DIALOG} [role="group"]${label('remote.section.label')}`)})?.textContent ?? ''`),
      settled: (t) => t.length > 0,
      timeoutMs: 10_000,
      label: 'the Settings line',
    })
    check(
      results,
      'a port in use is stated in the dialog and the Settings line does not say it is running',
      conflict.includes(copy('remote.state.inUse', { port: LISTEN_A })) && line.includes(copy('remote.state.inUse', { port: LISTEN_A })) && !line.includes(copy('remote.section.on', { devices: 1, connected: 0 })),
      line,
    )
    await clickSelector(second.app.client, `${SETTINGS_DIALOG} button${label('remote.section.open')}`)
    await setPortInDialog(second.app, LISTEN_B)
    const recovered = await pollFor({ read: () => dialogText(second.app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_B })), timeoutMs: 15_000, label: 'recovered' })
      const recoveredAccepts = await accepts(LISTEN_B)
    check(results, 'changing to a free port recovers', recovered.includes(copy('remote.state.listening', { port: LISTEN_B })) && recoveredAccepts, `accepts=${recoveredAccepts}`)
  } finally {
    await new Promise((resolve) => holder.close(resolve))
    await second.app.close()
  }
}

/** remote-access: pairing, credentials, revoke, reset, the renderer's view, a key that went missing. */
async function runPairing(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
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
  const second = await startPairing(app)
  const other = await pairRemote(target, { code: second.code, deviceName: 'Probe Tablet' })
  await clickSelector(app.client, `${DIALOG} button${label('remote.revoke', { name: 'Probe Pixel' })}`, 'Revoke Probe Pixel')
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

  await clickSelector(app.client, `${ACTIVITY} button${label('activityBar.settings')}`)
  const offLine = await pollFor({ read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(SECTION)})?.textContent ?? ''`), settled: (t) => t.includes(copy('remote.section.off')), timeoutMs: 10_000, label: 'Settings says off' })
  check(results, 'the Settings section states that remote access is off', offLine.includes(copy('remote.section.off')), offLine)
  await clickSelector(app.client, `${SETTINGS_DIALOG} button${label('remote.section.open')}`)
  const opened = await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`), settled: Boolean, timeoutMs: 10_000, label: 'the dialog from Settings' })
  check(results, 'the Settings section control opens the remote access dialog', opened === true, '')
  await setPortInDialog(app, LISTEN_A)
  await toggleEnabled(app)
  await pollFor({ read: () => dialogText(app), settled: (t) => t.includes(copy('remote.state.listening', { port: LISTEN_A })), timeoutMs: 15_000, label: 'listening' })
  await closeRemoteDialog(app)

  check(results, 'no indicator while no device is connected', !(await app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(INDICATOR)}))`)), '')
  const a = await phone(app, 'Phone A')
  const shown = await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(INDICATOR)}))`), settled: Boolean, timeoutMs: 10_000, label: 'the indicator' })
  check(results, 'a connected device shows the indicator', shown === true, '')
  await clickSelector(app.client, INDICATOR, 'the indicator')
  const fromIndicator = await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`), settled: Boolean, timeoutMs: 10_000, label: 'the dialog from the indicator' })
  check(results, 'the indicator opens the remote access dialog', fromIndicator === true, '')
  await closeRemoteDialog(app)

  const b = await phone(app, 'Phone B')
  b.client.close()
  await clickSelector(app.client, `${ACTIVITY} button${label('activityBar.settings')}`)
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

  // Waiting on a choice: refused, nothing written.
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

  // A choice inside the delay: busy at the gate, awaiting-choice at the re-check.
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
  const { app, stub } = await start(context, profile, { readyDelaySeconds: 1 })
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
  check(results, 'an adopted report raises a handoff event whose summary lacks the URL', Boolean(handoffEvent) && !handoffEvent.d.summary.includes('example.com') && handoffEvent.d.summary.includes('Fixed it'), JSON.stringify(handoffEvent?.d))
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

/** remote-protocol: OpenSpec is readable and only readable. */
async function runOpenSpec(_mode, _config, context) {
  const repos = makeRepos()
  const profile = seedProfile(repos, { remote: { enabled: true, port: LISTEN_A } })
  const { app } = await start(context, profile)
  const { client } = await phone(app)
  const change = await call(client, 'openspec.change', { folderId: 'f', slug: 'add-thing' })
  check(results, 'reading an active change returns its artifacts with their content', JSON.stringify(change.r ?? '').includes('REMOTE-PROPOSAL-MARKER'), JSON.stringify(change.e ?? '').slice(0, 200))
  const escape = await call(client, 'openspec.change', { folderId: 'f', slug: '../../../etc' })
  check(results, 'a path-shaped identifier is not found', escape.e?.code === 'NOT_FOUND', JSON.stringify(escape.e))
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

const SECTIONS = [
  { name: 'runListener', run: runListener },
  { name: 'runPairing', run: runPairing },
  { name: 'runIndicator', run: runIndicator },
  { name: 'runSessions', run: runSessions },
  { name: 'runConversation', run: runConversation },
  { name: 'runTerminal', run: runTerminal },
  { name: 'runIntakeHandoff', run: runIntakeHandoff },
  { name: 'runReaccept', run: runReaccept },
  { name: 'runOpenSpec', run: runOpenSpec },
  { name: 'runAttention', run: runAttention },
  { name: 'runHibernation', run: runHibernation },
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
