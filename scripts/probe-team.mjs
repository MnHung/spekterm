/**
 * `team-membership`'s acceptance: the real app against a stand-in team server (`lib/stub-team-server.mjs`).
 *
 * The unit tests cover the reconnect table, the write orders and the connection; this probe carries what they cannot
 * see: the Settings flows a user goes through, the state the section shows, the notification, and that nothing the
 * renderer holds — its IPC answers or its DOM — contains the device secret.
 *
 * The stub is trusted through the invite's pinned fingerprint, the path a team on a private network uses; the
 * unpinned path (system trust store) is covered by unit tests. **Not covered, and stated**: the real spekterm-server
 * (dogfood, task 7.4), and the desktop notification actually appearing (the stub backend records it).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, connectToApp, pollFor } from './lib/cdp.mjs'
import { copy, label } from './lib/copy.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { awaitMounted } from './lib/mounted.mjs'
import { PROBE_PORTS, STUB_PORTS } from './lib/ports.mjs'
import { runSections } from './lib/sections.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { SETTINGS_DIALOG, clickSelector, openSettings } from './lib/settings.mjs'
import { STUB_DEVICE_SECRET, startStubTeamServer } from './lib/stub-team-server.mjs'

const PORT = PROBE_PORTS.team.main
const RESTART_PORT = PROBE_PORTS.team.restart
const STUB_PORT = STUB_PORTS.team

const results = []
const temps = []

function mkTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

async function launch(profile, port = PORT) {
  seedLanguage(profile)
  const child = spawn('electron', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...electronExtraArgs(), '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SHELL: '/bin/sh' },
  })
  let output = ''
  child.stderr?.on('data', (chunk) => (output += chunk))
  child.stdout?.on('data', (chunk) => (output += chunk))
  const client = await connectToApp(port, { targetTimeoutMs: 30_000 })
  await awaitMounted(client)
  return {
    client,
    output: () => output,
    async close() {
      try {
        await client.close()
      } catch {
        // Already gone.
      }
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 900))
    },
  }
}

/** Each section owns its app and its stub, so a failure never leaves the next one on a busy port. */
async function withRig(context, body, { profile = mkTemp('spekterm-team-profile-'), stub: existing } = {}) {
  const stub = existing ?? (await startStubTeamServer({ port: STUB_PORT }))
  context.stub = stub
  const app = await launch(profile)
  context.app = app
  try {
    await body(app, stub, profile)
  } finally {
    await app.close()
    context.app = null
    if (!existing) await stub.close()
    context.stub = null
  }
}

const SECTION = `${SETTINGS_DIALOG} [role="group"]${label('team.label')}`
const sectionText = (app) => app.client.evaluate(`(document.querySelector(${JSON.stringify(SECTION)})?.textContent ?? '')`)
const teamView = (app) =>
  app.client.evaluate(`window.workspace.team.get().then((v) => JSON.stringify(v))`, { awaitPromise: true }).then((json) => JSON.parse(String(json)))
const field = (key) => `${SECTION} input${label(key)}`

async function openTeam(app) {
  await openSettings(app.client, 'team')
  await pollFor({ read: () => app.client.evaluate(`!!document.querySelector(${JSON.stringify(SECTION)})`), settled: Boolean, timeoutMs: 15_000, label: 'Settings › Team shown' })
}

async function enable(app) {
  const checked = await app.client.evaluate(`document.querySelector(${JSON.stringify(field('team.enable'))})?.checked === true`)
  if (!checked) await clickSelector(app.client, field('team.enable'), 'the Team switch')
  await pollFor({ read: () => teamView(app), settled: (v) => v.enabled === true, timeoutMs: 10_000, label: 'Team on' })
}

async function typeInto(app, key, text) {
  await clickSelector(app.client, field(key), copy(key))
  await app.client.evaluate(`document.querySelector(${JSON.stringify(field(key))})?.select()`)
  await app.client.send('Input.insertText', { text })
}

/**
 * A real click on a Team section button found by its visible text (the section's buttons are named by their text),
 * measured right before the click.
 */
async function clickButton(app, key, vars) {
  const text = copy(key, vars)
  const at = await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const button = [...document.querySelectorAll(${JSON.stringify(`${SECTION} button`)})].find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(text)} && !b.disabled)
        if (!button) return null
        button.scrollIntoView({ block: 'nearest' })
        const r = button.getBoundingClientRect()
        return r.width === 0 ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`),
    settled: (value) => value !== null,
    timeoutMs: 10_000,
    label: `button “${text}”`,
  })
  if (!at) throw new Error(`no button “${text}”`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await app.client.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
  }
}

async function awaitText(app, needle, what) {
  return pollFor({ read: () => sectionText(app), settled: (text) => text.includes(needle), timeoutMs: 20_000, label: what })
}

async function joinMember(app, stub, { handle = 'sam', link = stub.link() } = {}) {
  await openTeam(app)
  await enable(app)
  await typeInto(app, 'team.invite.label', link)
  await clickButton(app, 'team.invite.continue')
  await awaitText(app, copy('team.invite.kindMember', { team: 'Acme' }), 'the invite is shown')
  await typeInto(app, 'team.invite.handle', handle)
  await typeInto(app, 'team.invite.displayName', 'Sam')
  await typeInto(app, 'team.invite.deviceName', 'laptop')
  await clickButton(app, 'team.invite.join')
}

const awaitStatus = (app, status, what) =>
  pollFor({ read: () => teamView(app), settled: (v) => v.status === status, timeoutMs: 20_000, label: what })

const notifications = (profile) => {
  const file = join(profile, 'team-notify-stub', 'notifications.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

// ---- Sections ----

async function runOffAndInvalidLinks(_mode, context) {
  await withRig(context, async (app, stub) => {
    await openTeam(app)
    const off = await sectionText(app)
    check(results, 'the Team section says the feature is off on a fresh profile', off.includes(copy('team.status.off')), off.slice(0, 160))
    check(results, 'the section states the operator can read what passes through', off.includes(copy('team.operatorStatement')), off.slice(0, 200))
    check(results, 'a fresh profile opens no connection to the team server', stub.connections.tcp === 0, `tcp ${stub.connections.tcp}`)
    await enable(app)
    // Each check is named in full: the scenario coverage table finds a carrier by its literal name.
    for (const [name, link, refused] of [
      ['an http address', stub.link({ server: stub.address.replace('wss:', 'https:') }), 'a link with an http address is refused as not a valid invite'],
      ['a path', stub.link({ server: `${stub.address}/other` }), 'a link with a path is refused as not a valid invite'],
      ['user information', stub.link({ server: stub.address.replace('wss://', 'wss://user:pass@') }), 'a link with user information is refused as not a valid invite'],
    ]) {
      await typeInto(app, 'team.invite.label', link)
      // Pasting and leaving the field connects to nothing (the invite link applies only through its own controls).
      await app.client.evaluate(`document.activeElement?.blur()`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      check(results, `pasting a link (${name}) and leaving the field connects to nothing`, stub.connections.tcp === 0, `tcp ${stub.connections.tcp}`)
      await clickButton(app, 'team.invite.continue')
      const text = await awaitText(app, copy('team.joinError.INVALID_LINK'), `invalid link (${name}) refused`)
      check(results, refused, text.includes(copy('team.joinError.INVALID_LINK')), text.slice(0, 200))
    }
    check(results, 'no invalid link reached the server', stub.connections.tcp === 0, `tcp ${stub.connections.tcp}`)
  })
}

async function runJoinMember(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    await openTeam(app)
    await enable(app)
    await typeInto(app, 'team.invite.label', stub.link())
    await app.client.evaluate(`document.activeElement?.blur()`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    check(results, 'pasting a valid invite link and leaving the field connects to nothing', stub.connections.tcp === 0, `tcp ${stub.connections.tcp}`)
    await clickButton(app, 'team.invite.continue')
    await awaitText(app, copy('team.invite.kindMember', { team: 'Acme' }), 'the invite is shown')
    const fields = await app.client.evaluate(
      `[${JSON.stringify(field('team.invite.handle'))}, ${JSON.stringify(field('team.invite.displayName'))}, ${JSON.stringify(field('team.invite.deviceName'))}].map((s) => Boolean(document.querySelector(s)))`,
    )
    check(results, 'a member invite asks for a handle, a display name and the device name', fields.every(Boolean), JSON.stringify(fields))
    await typeInto(app, 'team.invite.handle', 'sam')
    await typeInto(app, 'team.invite.displayName', 'Sam')
    await typeInto(app, 'team.invite.deviceName', 'laptop')
    await clickButton(app, 'team.invite.join')
    const view = await awaitStatus(app, 'connected', 'connected after joining')
    check(results, 'joining with a member invite connects', view.status === 'connected', JSON.stringify(view).slice(0, 200))
    const text = await awaitText(app, stub.address, 'the server address is shown')
    // The device name is an input's value, which `textContent` does not include.
    const device = await app.client.evaluate(`document.querySelector(${JSON.stringify(field('team.device'))})?.value ?? ''`)
    check(results, 'the section shows the server address, the team and the device', text.includes(stub.address) && text.includes('Acme') && device === 'laptop', `${text.slice(0, 200)} | device ${device}`)
    await awaitText(app, 'alex', 'the members are listed')
    check(results, 'the members are listed, the user marked', (await sectionText(app)).includes(copy('team.you')), (await sectionText(app)).slice(0, 300))
    const ipc = JSON.stringify(view)
    const dom = await app.client.evaluate(`document.documentElement.outerHTML`)
    check(results, 'the renderer’s team state contains no device secret', !ipc.includes(STUB_DEVICE_SECRET) && !ipc.includes('d_stub'), ipc.slice(0, 200))
    check(results, 'the DOM contains no device secret', !String(dom).includes(STUB_DEVICE_SECRET), '')
    const secrets = readFileSync(join(profile, 'secrets.json'), 'utf8')
    check(results, 'the secret is in the secret store', secrets.includes(STUB_DEVICE_SECRET), '')
    check(results, 'the membership file holds no secret', !readFileSync(join(profile, 'team.json'), 'utf8').includes(STUB_DEVICE_SECRET), '')
    check(results, 'inspect did not redeem: one join', stub.count('join') === 1 && stub.count('invite.inspect') === 1, `join ${stub.count('join')} inspect ${stub.count('invite.inspect')}`)
  })
}

async function runTakenHandleAndDeviceInvite(_mode, context) {
  await withRig(context, async (app, stub) => {
    stub.state.respond = (m, p) => (m === 'join' && p.handle === 'taken' ? { ok: false, e: { code: 'HANDLE_TAKEN', message: 'taken' } } : undefined)
    await joinMember(app, stub, { handle: 'taken' })
    const text = await awaitText(app, copy('team.joinError.HANDLE_TAKEN'), 'taken handle shown')
    check(results, 'a taken handle is said, and the form stays', text.includes(copy('team.joinError.HANDLE_TAKEN')) && text.includes(copy('team.invite.handle')), text.slice(0, 200))
    await typeInto(app, 'team.invite.handle', 'sam')
    await clickButton(app, 'team.invite.join')
    const view = await awaitStatus(app, 'connected', 'connected with another handle')
    check(results, 'joining again with another handle succeeds', view.status === 'connected', view.status)
  })
  await withRig(context, async (app, stub) => {
    stub.state.inviteKind = 'device'
    await openTeam(app)
    await enable(app)
    await typeInto(app, 'team.invite.label', stub.link())
    await clickButton(app, 'team.invite.continue')
    const text = await awaitText(app, copy('team.invite.kindDevice', { team: 'Acme', name: 'Sam', handle: 'sam' }), 'device invite shown')
    const handleField = await app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(field('team.invite.handle'))}))`)
    check(results, 'a device invite names the member and asks no handle', text.includes('@sam') && !handleField, text.slice(0, 200))
  })
}

async function runPinMismatch(_mode, context) {
  await withRig(context, async (app, stub) => {
    await openTeam(app)
    await enable(app)
    await typeInto(app, 'team.invite.label', stub.link({ fingerprint: 'A'.repeat(64) }))
    await clickButton(app, 'team.invite.continue')
    const text = await awaitText(app, copy('team.joinError.PIN_MISMATCH'), 'pin mismatch shown')
    check(results, 'an invite whose pin does not match says so', text.includes(copy('team.joinError.PIN_MISMATCH')), text.slice(0, 200))
    const bytes = stub.tlsBytes.reduce((sum, n) => sum + n, 0)
    check(results, 'no application data reached the server', bytes === 0 && stub.frames.length === 0, `bytes ${bytes} frames ${stub.frames.length}`)
  })
}

async function runRevoked(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    for (const socket of stub.openSockets()) socket.close(4004, 'revoked')
    const view = await awaitStatus(app, 'unjoined', 'membership discarded')
    check(results, 'a revocation discards the membership and says so', view.reason === 'REVOKED' && view.membership === null, JSON.stringify(view).slice(0, 200))
    const sent = await pollFor({ read: async () => notifications(profile), settled: (list) => list.length > 0, timeoutMs: 10_000, label: 'revocation notified' })
    check(results, 'one notification says the device was removed', sent.length === 1 && String(sent[0].body ?? '').includes(copy('team.notify.REVOKED')), JSON.stringify(sent).slice(0, 200))
    const hellos = stub.count('hello')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    check(results, 'a revoked device makes no further connection', stub.count('hello') === hellos, `hello ${hellos} → ${stub.count('hello')}`)
    check(results, 'the secret is gone from the secret store', !readFileSync(join(profile, 'secrets.json'), 'utf8').includes(STUB_DEVICE_SECRET), '')
  })
}

async function runReplacedAndVersion(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    for (const socket of stub.openSockets()) socket.close(4006, 'replaced')
    const stopped = await awaitStatus(app, 'stopped', 'stopped after 4006')
    check(results, 'a replaced connection stops', stopped.reason === 'REPLACED', JSON.stringify(stopped).slice(0, 160))
    const marked = await app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${SETTINGS_DIALOG} [role="img"]${label('settings.sections.teamFailed')}`)}))`)
    check(results, 'the Settings list marks Team while stopped', marked === true, String(marked))
    const hellos = stub.count('hello')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    check(results, '4006 is not reconnected by itself', stub.count('hello') === hellos, `hello ${hellos} → ${stub.count('hello')}`)
    await clickButton(app, 'team.reconnect')
    const back = await awaitStatus(app, 'connected', 'Reconnect connects')
    check(results, 'Reconnect takes the connection back', back.status === 'connected', back.status)

    stub.state.respond = (m) => (m === 'hello' ? { ok: false, e: { code: 'UNSUPPORTED_VERSION', message: 'v', detail: { supported: [2] } } } : undefined)
    for (const socket of stub.openSockets()) socket.terminate()
    const version = await awaitStatus(app, 'stopped', 'stopped on a version mismatch')
    const text = await awaitText(app, copy('team.stop.UNSUPPORTED_VERSION_spekterm'), 'the older side is named')
    check(results, 'a version mismatch says spekterm is older', version.reason === 'UNSUPPORTED_VERSION' && text.includes(copy('team.stop.UNSUPPORTED_VERSION_spekterm')), text.slice(0, 200))
    check(results, 'each stop notified once', notifications(profile).length === 2, JSON.stringify(notifications(profile)).slice(0, 200))
  })
}

async function runLeave(_mode, context) {
  for (const [count, key, says, quiet] of [
    [1, 'team.leaveLast', 'leaving with 1 device(s) says the member is removed', 'a completed leave (1) shows no team and notifies nothing'],
    [2, 'team.leaveOne', 'leaving with 2 device(s) says only this device leaves', 'a completed leave (2) shows no team and notifies nothing'],
  ]) {
    await withRig(context, async (app, stub, profile) => {
      stub.state.deviceCount = 1
      await joinMember(app, stub)
      await awaitStatus(app, 'connected', 'connected')
      // The count changes after joining: the confirmation must read the list fetched when Leave is pressed.
      stub.state.deviceCount = count
      await clickButton(app, 'team.leave')
      const expected = copy(key, { team: 'Acme', count: count - 1 })
      const text = await awaitText(app, expected, `leave sentence for ${count} device(s)`)
      check(results, says, text.includes(expected), text.slice(0, 300))
      await clickButton(app, 'team.leaveConfirm')
      const view = await awaitStatus(app, 'unjoined', 'left')
      check(results, quiet, view.membership === null && notifications(profile).length === 0, JSON.stringify(view).slice(0, 160))
    })
  }
}

async function runRestartAndRename(_mode, context) {
  const profile = mkTemp('spekterm-team-restart-')
  const stub = await startStubTeamServer({ port: STUB_PORT })
  context.stub = stub
  try {
    await withRig(
      context,
      async (app) => {
        await joinMember(app, stub)
        await awaitStatus(app, 'connected', 'connected')
        await awaitText(app, 'alex', 'members fetched')
        await typeInto(app, 'team.device', 'desk  ')
        await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
        await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
        const view = await pollFor({ read: () => teamView(app), settled: (v) => v.membership?.device === 'desk', timeoutMs: 10_000, label: 'renamed' })
        check(results, 'a renamed device shows the server’s name', view.membership?.device === 'desk', JSON.stringify(view.membership).slice(0, 160))
      },
      { profile, stub },
    )
    await stub.close()
    context.stub = null
    // The server is now unreachable; the same profile starts again.
    const app = await launch(profile, RESTART_PORT)
    context.app = app
    try {
      await openTeam(app)
      const text = await awaitText(app, 'alex', 'members shown offline')
      check(results, 'the members are shown while the server is unreachable', text.includes('alex'), text.slice(0, 200))
      const device = await app.client.evaluate(`document.querySelector(${JSON.stringify(field('team.device'))})?.value ?? ''`)
      check(results, 'the renamed device name survived the restart', device === 'desk', `device ${device}`)
      const view = await pollFor({ read: () => teamView(app), settled: (v) => v.status === 'reconnecting', timeoutMs: 20_000, label: 'reconnecting' })
      check(results, 'an unreachable server is retried, with the next attempt shown', view.status === 'reconnecting' && typeof view.nextAt === 'number', JSON.stringify(view).slice(0, 160))
      await new Promise((resolve) => setTimeout(resolve, 3000))
      check(results, 'retrying an unreachable server sends no notification', notifications(profile).length === 0, JSON.stringify(notifications(profile)))
    } finally {
      await app.close()
      context.app = null
    }
  } finally {
    if (context.stub) await context.stub.close()
    context.stub = null
  }
}

async function runMissingSecret(_mode, context) {
  const profile = mkTemp('spekterm-team-nosecret-')
  writeFileSync(
    join(profile, 'team.json'),
    JSON.stringify({
      version: 1,
      enabled: true,
      membership: {
        server: { address: `wss://localhost:${STUB_PORT}`, fingerprint: 'B'.repeat(64) },
        team: { name: 'Acme' },
        member: { id: 'm_sam', handle: 'sam', displayName: 'Sam', deviceCount: 1 },
        device: { id: 'd_stub', name: 'laptop' },
        operations: ['team.members'],
      },
    }),
  )
  await withRig(
    context,
    async (app, stub) => {
      await openTeam(app)
      const view = await awaitStatus(app, 'stopped', 'stopped without a secret')
      check(results, 'a membership without its secret stops, keeping the membership', view.reason === 'CREDENTIAL_UNAVAILABLE' && view.membership !== null, JSON.stringify(view).slice(0, 200))
      check(results, 'no hello was sent without a secret', stub.connections.tcp === 0, `tcp ${stub.connections.tcp}`)
      check(results, 'no notification of a removal', notifications(profile).length === 0, JSON.stringify(notifications(profile)))
      const text = await sectionText(app)
      check(results, 'the section names the device', text.includes('laptop'), text.slice(0, 300))
    },
    { profile },
  )
}

const SECTIONS = [
  { name: 'runOffAndInvalidLinks', run: runOffAndInvalidLinks },
  { name: 'runJoinMember', run: runJoinMember },
  { name: 'runTakenHandleAndDeviceInvite', run: runTakenHandleAndDeviceInvite },
  { name: 'runPinMismatch', run: runPinMismatch },
  { name: 'runRevoked', run: runRevoked },
  { name: 'runReplacedAndVersion', run: runReplacedAndVersion },
  { name: 'runLeave', run: runLeave },
  { name: 'runRestartAndRename', run: runRestartAndRename },
  { name: 'runMissingSecret', run: runMissingSecret },
]

const outcome = await runSections({
  sections: SECTIONS,
  build: { port: PORT, rendererUrl: null },
  dev: null,
  results,
  afterMode: async (_mode, context) => {
    if (context.app) await context.app.close()
    if (context.stub) await context.stub.close()
  },
  cleanup: () => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  },
})

process.exit(outcome.ok ? 0 : 1)
