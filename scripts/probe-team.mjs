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
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { check, connectToApp, pollFor } from './lib/cdp.mjs'
import { copy, label } from './lib/copy.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { awaitMounted } from './lib/mounted.mjs'
import { PROBE_PORTS, STUB_PORTS } from './lib/ports.mjs'
import { runSections } from './lib/sections.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { SETTINGS_DIALOG, clickSelector, openSettings } from './lib/settings.mjs'
import { STUB_DEVICE_SECRET, startStubTeamServer } from './lib/stub-team-server.mjs'
import { pairRemote } from './lib/remote-client.mjs'
import { makeStubAgent } from './lib/stub-agent.mjs'

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

async function launch(profile, port = PORT, env = {}) {
  seedLanguage(profile)
  const child = spawn('electron', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...electronExtraArgs(), '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SHELL: '/bin/sh', ...env },
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
async function withRig(context, body, { profile = mkTemp('spekterm-team-profile-'), stub: existing, env } = {}) {
  const stub = existing ?? (await startStubTeamServer({ port: STUB_PORT }))
  context.stub = stub
  const app = await launch(profile, PORT, env)
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


// ---- Teammate handoffs (`teammate-handoff`) ----

/** A delivery written the way an agent writes one: a temporary name, then a rename into its outbox. */
function writeDelivery(profile, sessionId, name, payload) {
  const dir = join(profile, 'handoff', 'outbox', sessionId)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(payload))
  renameSync(join(dir, `.${name}.tmp`), target)
  return target
}

const receiptOf = (profile, sessionId, name) => {
  const file = join(profile, 'handoff', 'receipts', sessionId, name)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const awaitReceipt = (profile, sessionId, name, settled, what) =>
  pollFor({ read: async () => receiptOf(profile, sessionId, name), settled: (r) => r !== null && settled(r), timeoutMs: 45_000, label: what })

const inboxSnapshot = (app) =>
  app.client.evaluate(`window.workspace.intake.list().then((v) => JSON.stringify(v))`, { awaitPromise: true }).then((json) => JSON.parse(String(json)))

/** The activity bar's inbox badge, read from its own subtree. */
const BADGE_TEXT = `(() => {
  const button = document.querySelector('${label('activityBar.handoffs')}')
  if (!button) return null
  const badge = button.querySelector('[role="status"]')
  return badge ? badge.textContent : ''
})()`

const intakeNotifications = (profile) => {
  const file = join(profile, 'notify-stub', 'notifications.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

function fireIntakeNotification(profile, nth) {
  const root = join(profile, 'notify-stub')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'trigger'), String(nth))
}

const OUTGOING_ROW = (name, title) => label('intake.outgoing.itemLabel', { name, title })
const rowText = (app, name, title) => app.client.evaluate(`document.querySelector(${JSON.stringify(OUTGOING_ROW(name, title))})?.textContent ?? ''`)
/** The texts of the row's paragraphs: the body is one of them, as the user sees it. */
const rowParagraphs = (app, name, title) =>
  app.client.evaluate(`[...(document.querySelector(${JSON.stringify(OUTGOING_ROW(name, title))})?.querySelectorAll('p') ?? [])].map((p) => p.textContent)`)

async function clickInRow(app, name, title, key) {
  return pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(OUTGOING_ROW(name, title))})?.querySelector('${label(key)}')
        if (!button) return false
        button.click()
        return true
      })()`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: `${copy(key)} on “${title}”`,
  })
}

const OPEN_INBOX = `(() => {
  const dialog = document.querySelector('[role="dialog"]${label('intake.label')}')
  if (dialog) return true
  document.querySelector('${label('activityBar.handoffs')}')?.click()
  return !!document.querySelector('[role="dialog"]${label('intake.label')}')
})()`

const selectedTab = (app) =>
  app.client.evaluate(`document.querySelector('[role="tablist"]${label('intake.label')} [role="tab"][aria-selected="true"]')?.getAttribute('aria-label') ?? ''`)

async function openOutgoing(app) {
  await pollFor({ read: () => app.client.evaluate(OPEN_INBOX), settled: Boolean, timeoutMs: 15_000, label: 'inbox open' })
  await pollFor({
    read: () => app.client.evaluate(`(() => { const t = document.querySelector('[role="tab"]${label('intake.outgoingTab')}'); t?.click(); return !!t })()`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'Outgoing tab',
  })
}

const BODY = 'Please review db/0042 before Friday.\u0007\u202e\n' + 'Context line. '.repeat(120)
const SHOWN_BODY = BODY.split('\u0007').join('').split('\u202e').join('')

async function runTeammateSend(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    const sid = randomUUID()
    writeDelivery(profile, sid, 'a.json', { to: 'Alex', title: 'review the migration', body: BODY })
    const awaiting = await awaitReceipt(profile, sid, 'a.json', (r) => r.status !== 'held', 'the receipt after reading')
    check(results, 'a valid teammate handoff gets an awaiting-confirmation receipt', awaiting.status === 'awaiting-confirmation' && typeof awaiting.ref === 'string', JSON.stringify(awaiting))
    const badge = await pollFor({ read: () => app.client.evaluate(BADGE_TEXT), settled: (text) => text === '1', timeoutMs: 15_000, label: 'the badge counts it' })
    check(results, 'a teammate handoff waiting for confirmation counts in the badge', badge === '1', String(badge))
    check(results, 'nothing is sent before the user presses Send', stub.count('handoff.send') === 0, `sends ${stub.count('handoff.send')}`)
    const snapshot = await inboxSnapshot(app)
    check(results, 'a teammate handoff opens no session and is no inbox item', snapshot.items.length === 0, JSON.stringify(snapshot.items).slice(0, 120))

    const sent = await pollFor({ read: async () => intakeNotifications(profile), settled: (list) => list.length > 0, timeoutMs: 20_000, label: 'notified' })
    const note = JSON.stringify(sent[0])
    check(results, 'the notification names the recipient and not the body', note.includes('Alex') && !note.includes('db/0042'), note.slice(0, 200))
    fireIntakeNotification(profile, 1)
    const tab = await pollFor({ read: () => selectedTab(app), settled: (value) => value === copy('intake.outgoingTab'), timeoutMs: 15_000, label: 'opened on Outgoing' })
    check(results, 'activating the notification opens the inbox on the Outgoing tab', tab === copy('intake.outgoingTab'), tab)
    const text = await pollFor({ read: () => rowText(app, 'Alex', 'review the migration'), settled: (t) => t.includes('Context line.'), timeoutMs: 15_000, label: 'the row' })
    check(results, 'the Outgoing row shows the recipient, the title and the whole body with its length', text.includes('@alex') && text.includes(SHOWN_BODY.slice(-40)) && text.includes(copy('intake.bodyLength', { count: SHOWN_BODY.length })), text.slice(0, 160))

    await clickInRow(app, 'Alex', 'review the migration', 'intake.outgoing.send')
    await pollFor({ read: async () => stub.count('handoff.send'), settled: (n) => n === 1, timeoutMs: 15_000, label: 'sent' })
    const request = stub.sends[0]
    // Cross-process: the request the server received against a paragraph of the row as the renderer drew it.
    const paragraphs = await rowParagraphs(app, 'Alex', 'review the migration')
    check(results, 'the body sent equals, character for character, the body the Outgoing tab showed', paragraphs.includes(request.payload?.body) && request.payload.body === SHOWN_BODY, `${request.payload?.body?.length} vs ${SHOWN_BODY.length}`)
    check(results, 'the request carries the member handle and enc none', request.to === 'alex' && request.payload?.enc === 'none', JSON.stringify({ to: request.to, enc: request.payload?.enc }))
    const done = await awaitReceipt(profile, sid, 'a.json', (r) => r.status === 'sent', 'sent receipt')
    check(results, 'the receipt states sent, and does not say the teammate received it', done.status === 'sent' && done.to === 'alex' && !/received|accepted/.test(done.reason ?? ''), JSON.stringify(done))
    const after = await pollFor({ read: () => app.client.evaluate(BADGE_TEXT), settled: (t) => t === '', timeoutMs: 15_000, label: 'badge cleared' })
    check(results, 'after Send the badge no longer counts it', after === '', String(after))

    // A lost answer: the connection drops before the answer, and the same clientId is sent again.
    let dropped = false
    stub.state.respond = (m, _p, socket) => {
      if (m !== 'handoff.send' || dropped) return undefined
      dropped = true
      setTimeout(() => socket.terminate(), 20)
      return 'silent'
    }
    writeDelivery(profile, sid, 'b.json', { to: 'alex', title: 'second', body: 'the second one' })
    await openOutgoing(app)
    await clickInRow(app, 'Alex', 'second', 'intake.outgoing.send')
    const resent = await pollFor({ read: async () => stub.sends.filter((p) => p.payload?.title === 'second'), settled: (list) => list.length >= 2, timeoutMs: 45_000, label: 'resent after reconnecting' })
    check(
      results,
      'a lost answer is resent with the same clientId',
      resent.length >= 2 && resent[0].clientId === resent[1].clientId,
      `${resent.map((p) => p.clientId).join(' / ')} | hello ${stub.count('hello')} tcp ${stub.connections.tcp} | receipt ${JSON.stringify(receiptOf(profile, sid, 'b.json'))} | ${(await teamView(app)).status}`,
    )
    const second = await awaitReceipt(profile, sid, 'b.json', (r) => r.status === 'sent', 'second sent')
    check(results, 'the resent handoff ends sent', second.status === 'sent', JSON.stringify(second))
  })
}

async function runTeammateRateLimitAndRefusal(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    const sid = randomUUID()
    stub.state.respond = (m) => (m === 'handoff.send' ? { ok: false, e: { code: 'RATE_LIMITED', message: 'limit', detail: { retryAt: Date.now() + 60 * 60_000 } } } : undefined)
    writeDelivery(profile, sid, 'r.json', { to: 'alex', title: 'limited', body: 'b' })
    await awaitReceipt(profile, sid, 'r.json', (r) => r.status === 'awaiting-confirmation', 'awaiting')
    await openOutgoing(app)
    await clickInRow(app, 'Alex', 'limited', 'intake.outgoing.send')
    const held = await awaitReceipt(profile, sid, 'r.json', (r) => r.code === 'RATE_LIMITED', 'rate limited')
    check(results, 'a rate-limited handoff is held with the time it is tried again', held.status === 'held' && typeof held.at === 'string', JSON.stringify(held))
    const prefix = copy('intake.outgoing.rateLimited', { time: '' }).trim()
    const text = await pollFor({ read: () => rowText(app, 'Alex', 'limited'), settled: (t) => t.includes(prefix), timeoutMs: 15_000, label: 'rate limit shown' })
    check(results, 'the Outgoing tab shows it waiting until that time', text.includes(prefix), text.slice(0, 200))
    await clickInRow(app, 'Alex', 'limited', 'intake.outgoing.discard')
    const discarded = await awaitReceipt(profile, sid, 'r.json', (r) => r.status === 'discarded', 'discarded')
    check(results, 'a rate-limited handoff can still be discarded', discarded.status === 'discarded', JSON.stringify(discarded))
    const sends = stub.count('handoff.send')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    check(results, 'a discarded handoff is not sent again', stub.count('handoff.send') === sends, `${sends} → ${stub.count('handoff.send')}`)

    stub.state.respond = (m) => (m === 'handoff.send' ? { ok: false, e: { code: 'RECIPIENT_UNKNOWN', message: 'gone' } } : undefined)
    writeDelivery(profile, sid, 'u.json', { to: 'alex', title: 'refused one', body: 'b' })
    await awaitReceipt(profile, sid, 'u.json', (r) => r.status === 'awaiting-confirmation', 'awaiting')
    await clickInRow(app, 'Alex', 'refused one', 'intake.outgoing.send')
    const refused = await awaitReceipt(profile, sid, 'u.json', (r) => r.status === 'rejected', 'refused')
    check(results, 'a server refusal reaches the receipt with its code', refused.code === 'RECIPIENT_UNKNOWN' && refused.permanent === true, JSON.stringify(refused))
    const reason = copy('intake.outgoing.refused.RECIPIENT_UNKNOWN', { name: 'Alex' })
    const row = await pollFor({ read: () => rowText(app, 'Alex', 'refused one'), settled: (t) => t.includes(reason), timeoutMs: 15_000, label: 'refusal shown' })
    check(results, 'a refused send stays in Outgoing with its reason', row.includes(reason), row.slice(0, 200))

    // Discard before sending: nothing reaches the server.
    stub.state.respond = undefined
    const before = stub.count('handoff.send')
    writeDelivery(profile, sid, 'd.json', { to: 'alex', title: 'thrown away', body: 'b' })
    await awaitReceipt(profile, sid, 'd.json', (r) => r.status === 'awaiting-confirmation', 'awaiting')
    await clickInRow(app, 'Alex', 'thrown away', 'intake.outgoing.discard')
    const gone = await awaitReceipt(profile, sid, 'd.json', (r) => r.status === 'discarded', 'discarded')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    check(results, 'Discard sends nothing and the receipt says discarded', gone.status === 'discarded' && stub.count('handoff.send') === before, `sends ${before} → ${stub.count('handoff.send')}`)
  })
}

async function runTeammateRefusedBeforeAsking(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    const sid = randomUUID()
    writeDelivery(profile, sid, 'none.json', { to: 'alex', title: 't', body: 'b' })
    const noTeam = await awaitReceipt(profile, sid, 'none.json', (r) => r.status === 'rejected', 'no team')
    check(results, 'without a team a teammate handoff is refused, not permanent', noTeam.code === 'TEAM_UNAVAILABLE' && noTeam.permanent === false, JSON.stringify(noTeam))

    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    const connectedAt = Date.now()
    writeDelivery(profile, sid, 'who.json', { to: 'nobody', title: 't', body: 'b' })
    const unknown = await awaitReceipt(profile, sid, 'who.json', (r) => r.status === 'rejected', 'unknown handle')
    check(results, 'a handle that is not a teammate’s is refused without asking', unknown.code === 'TEAMMATE_NOT_FOUND' && unknown.permanent === true, JSON.stringify(unknown))
    const snapshot = await inboxSnapshot(app)
    check(results, 'nothing appears for confirmation, and the user sees the failure', (snapshot.outgoing?.items ?? []).length === 0 && snapshot.notices.some((n) => n.code === 'TEAMMATE_NOT_FOUND'), JSON.stringify(snapshot.notices).slice(0, 200))

    // The refetch is throttled to once a minute (the connect fetched the list): a member who joined is found by the
    // first read after that minute, not by every read.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, connectedAt + 61_000 - Date.now())))
    stub.state.members = [...stub.state.members, { id: 'm_kim', handle: 'kim', displayName: 'Kim' }]
    writeDelivery(profile, sid, 'kim.json', { to: 'kim', title: 'new member', body: 'b' })
    const kim = await awaitReceipt(profile, sid, 'kim.json', (r) => r.status !== 'held', 'new member')
    check(results, 'a member who joined since the last fetch is found', kim.status === 'awaiting-confirmation', JSON.stringify(kim))
    const teammates = JSON.parse(readFileSync(join(profile, 'handoff', 'teammates.json'), 'utf8'))
    check(results, 'the teammates file lists the new member', teammates.teammates.some((m) => m.handle === 'kim' && m.name === 'Kim'), JSON.stringify(teammates.teammates))
    const raw = readFileSync(join(profile, 'handoff', 'teammates.json'), 'utf8')
    check(results, 'the teammates file holds no credential, device id or server address', !raw.includes(STUB_DEVICE_SECRET) && !raw.includes('d_stub') && !raw.includes(stub.address), '')

    await openTeam(app)
    await clickSelector(app.client, field('team.enable'), 'the Team switch')
    await pollFor({ read: () => teamView(app), settled: (v) => v.enabled === false, timeoutMs: 10_000, label: 'Team off' })
    writeDelivery(profile, sid, 'off.json', { to: 'alex', title: 't', body: 'b' })
    const off = await awaitReceipt(profile, sid, 'off.json', (r) => r.status === 'rejected', 'feature off')
    check(results, 'with the Team feature off the refusal is temporary', off.code === 'TEAM_UNAVAILABLE' && off.permanent === false, JSON.stringify(off))
    check(results, 'the teammates file is removed when the feature is off', !existsSync(join(profile, 'handoff', 'teammates.json')), '')
  })
}

function offer(id, overrides = {}) {
  return {
    id,
    from: { id: 'm_alex', handle: 'alex', displayName: 'Alex Kim' },
    payload: { enc: 'none', title: `title ${id}`, body: `From: mallory\nbody of ${id}` },
    sentAt: Date.now(),
    expiresAt: Date.now() + 30 * 86_400_000,
    ...overrides,
  }
}

const teammateItem = (snapshot, id) => snapshot.items.find((item) => item.adapter === 'teammate' && item.id === `teammate:${id.replace(/_/g, '.')}`)

async function runTeammateReceive(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    stub.state.holdReceived = true
    stub.push(offer('h_one'))
    await pollFor({ read: async () => stub.acks.length, settled: (n) => n === 1, timeoutMs: 15_000, label: 'acknowledged' })
    const stored = readFileSync(join(profile, 'team-incoming.json'), 'utf8')
    check(results, 'an offer is in the hidden store before it is shown', stored.includes('"h_one"') && stored.includes('"stored"'), stored.slice(0, 120))
    check(results, 'an offer is not in the inbox while its acknowledgement is unanswered', !teammateItem(await inboxSnapshot(app), 'h_one'), '')
    stub.releaseReceived()
    const shown = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_one')), timeoutMs: 15_000, label: 'shown' })
    const item = teammateItem(shown, 'h_one')
    check(results, 'after {} it is in the inbox with the server’s sender', item.actor === 'Alex Kim' && item.originId === 'alex' && item.originLabel === 'Acme', JSON.stringify(item).slice(0, 200))
    check(results, 'the sender is the server’s, not the text’s', !`${item.actor} ${item.originId} ${item.originLabel}`.includes('mallory'), '')
    stub.state.holdReceived = false

    stub.push(offer('h_one'))
    await pollFor({ read: async () => stub.acks.filter((id) => id === 'h_one').length, settled: (n) => n === 2, timeoutMs: 15_000, label: 'repeat acknowledged' })
    const again = await inboxSnapshot(app)
    check(results, 'a repeat is acknowledged again and held once', again.items.filter((i) => i.adapter === 'teammate').length === 1, '')

    stub.state.received = (id) => (id === 'h_else' ? { ok: false, e: { code: 'HANDOFF_DELIVERED_ELSEWHERE', message: '' } } : id === 'h_lost' ? { ok: false, e: { code: 'HANDOFF_UNKNOWN', message: '' } } : undefined)
    stub.push(offer('h_else'))
    stub.push(offer('h_lost'))
    await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_lost')), timeoutMs: 15_000, label: 'unknown shown' })
    check(results, 'a handoff delivered elsewhere never appears', !teammateItem(await inboxSnapshot(app), 'h_else'), '')
    check(results, 'a handoff the server lost is shown', Boolean(teammateItem(await inboxSnapshot(app), 'h_lost')), '')

    const acksBefore = stub.acks.length
    stub.push(offer('h_enc', { payload: { enc: 'x25519', title: 't', body: 'b' } }))
    const traced = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => s.notices.some((n) => n.code === 'TEAMMATE_UNREADABLE'), timeoutMs: 15_000, label: 'unreadable traced' })
    check(results, 'an unreadable offer leaves a trace and no acknowledgement', traced.notices.filter((n) => n.code === 'TEAMMATE_UNREADABLE').length === 1 && stub.acks.length === acksBefore, `acks ${acksBefore} → ${stub.acks.length}`)

    // The inbox row: labelled as a teammate's by the adapter; a shared drop point file claiming the kind is not.
    mkdirSync(join(profile, 'intake-inbox'), { recursive: true })
    writeFileSync(join(profile, 'intake-inbox', 'pose.json'), JSON.stringify({ id: 'pose-1', origin: { kind: 'teammate', id: 'alex', label: 'Acme' }, title: 'POSING', body: 'b', actor: 'Alex Kim' }))
    await pollFor({ read: () => inboxSnapshot(app), settled: (s) => s.items.some((i) => i.id === 'pose-1'), timeoutMs: 45_000, label: 'posing item in' })
    await pollFor({ read: () => app.client.evaluate(OPEN_INBOX), settled: Boolean, timeoutMs: 15_000, label: 'inbox open' })
    const rowOf = (title) => app.client.evaluate(`document.querySelector(${JSON.stringify(label('intake.itemLabel', { title }))})?.textContent ?? ''`)
    const real = await pollFor({ read: () => rowOf('title h_one'), settled: (t) => t.length > 0, timeoutMs: 15_000, label: 'teammate row' })
    const posing = await rowOf('POSING')
    check(results, 'a teammate’s handoff is labelled as one in the inbox', real.includes(copy('intake.teammate')), real.slice(0, 120))
    check(results, 'a shared drop point delivery cannot pose as a teammate', posing.length > 0 && !posing.includes(copy('intake.teammate')), posing.slice(0, 120))

    // A revocation with an acknowledgement unanswered: shown, marked.
    stub.state.holdReceived = true
    stub.push(offer('h_rev'))
    await pollFor({ read: async () => stub.acks.includes('h_rev'), settled: Boolean, timeoutMs: 15_000, label: 'h_rev acknowledged' })
    for (const socket of stub.openSockets()) socket.close(4004, 'revoked')
    const marked = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_rev')), timeoutMs: 20_000, label: 'revoked shown' })
    check(results, 'a revoked device shows what it never had confirmed, marked', teammateItem(marked, 'h_rev')?.possiblyElsewhere === true, JSON.stringify(teammateItem(marked, 'h_rev') ?? null).slice(0, 160))
    const revRow = await pollFor({ read: () => rowOf('title h_rev'), settled: (t) => t.includes(copy('intake.possiblyElsewhere')), timeoutMs: 15_000, label: 'mark shown' })
    check(results, 'the mark is shown on the row', revRow.includes(copy('intake.possiblyElsewhere')), revRow.slice(0, 160))
  })
}

async function runTeammateAccept(_mode, context) {
  const profile = mkTemp('spekterm-team-accept-')
  const repo = mkTemp('spekterm-team-repo-')
  writeFileSync(join(profile, 'workspace.json'), JSON.stringify({ version: 1, folders: [{ id: 'f1', path: repo, name: basename(repo), addedAt: '2026-11-03T00:00:00.000Z' }] }))
  writeFileSync(join(profile, 'intake-routing.json'), JSON.stringify({ version: 1, rules: [], fallbackFolderId: null }))
  const configDir = mkTemp('spekterm-team-config-')
  const stubAgent = makeStubAgent(mkTemp, configDir, { readyDelaySeconds: 2 })
  const env = { CLAUDE_CONFIG_DIR: configDir, HOME: stubAgent.home, PATH: `${stubAgent.bin}:${process.env.PATH}` }
  await withRig(
    context,
    async (app, stub) => {
      await joinMember(app, stub)
      await awaitStatus(app, 'connected', 'connected')
      const long = `${'A long teammate body. '.repeat(700)}`.slice(0, 15_000)
      stub.push(offer('h_acc', { payload: { enc: 'none', title: 'ACCEPT-TEAMMATE', body: long } }))
      const snapshot = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_acc')), timeoutMs: 15_000, label: 'shown' })
      const item = teammateItem(snapshot, 'h_acc')
      check(results, 'a teammate’s long body is in the inbox whole, with its length', item.bodyLength === 15_000 && item.state === 'pending', `${item.bodyLength} ${item.state}`)
      await pollFor({ read: () => app.client.evaluate(OPEN_INBOX), settled: Boolean, timeoutMs: 15_000, label: 'inbox open' })
      const row = label('intake.itemLabel', { title: 'ACCEPT-TEAMMATE' })
      await pollFor({
        read: () =>
          app.client.evaluate(`(() => {
            const r = document.querySelector(${JSON.stringify(row)})
            const select = r?.querySelector('select')
            if (!select) return false
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
            setter.call(select, 'f1')
            select.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          })()`),
        settled: Boolean,
        timeoutMs: 15_000,
        label: 'folder chosen',
      })
      await pollFor({
        read: () =>
          app.client.evaluate(`(() => {
            const button = document.querySelector(${JSON.stringify(row)})?.querySelector('${label('intake.accept')}')
            if (!button || button.disabled) return false
            button.click()
            return true
          })()`),
        settled: Boolean,
        timeoutMs: 15_000,
        label: 'accepted',
      })
      // The whole prompt has arrived once its last sentence has: both prompts end with "not part of the …".
      await pollFor({ read: async () => stubAgent.bytes(), settled: (bytes) => /that fence is not part of the (task|handoff)/.test(bytes), timeoutMs: 40_000, label: 'the prompt filled' })
      const bytes = stubAgent.bytes()
      check(results, 'accepting a teammate’s handoff fills the third-party prompt', bytes.includes('not part of the task') && !bytes.includes('not part of the handoff'), bytes.slice(-120))
      await new Promise((resolve) => setTimeout(resolve, 1500))
      check(results, 'the first prompt is not sent', !/[\r\n]/.test(stubAgent.bytes()) && stubAgent.input() === '', JSON.stringify(stubAgent.bytes().slice(-20)))
    },
    { profile, env },
  )
}

// ---- The way back (`teammate-handoff-return`) ----

const sentSnapshot = (app) =>
  app.client.evaluate(`window.workspace.intake.sent().then((v) => JSON.stringify(v))`, { awaitPromise: true }).then((json) => JSON.parse(String(json)))

const SENT_ROW = (name, title) => label('intake.sent.itemLabel', { name, title })
const sentRowText = (app, name, title) => app.client.evaluate(`document.querySelector(${JSON.stringify(SENT_ROW(name, title))})?.textContent ?? ''`)

async function openSent(app) {
  await pollFor({ read: () => app.client.evaluate(OPEN_INBOX), settled: Boolean, timeoutMs: 15_000, label: 'inbox open' })
  await pollFor({
    read: () => app.client.evaluate(`(() => { const t = document.querySelector('[role="tab"]${label('intake.sentTab')}'); t?.click(); return !!t })()`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'Sent tab',
  })
}

const sentNotifications = (profile) => intakeNotifications(profile).filter((n) => JSON.stringify(n).includes(copy('intake.notify.sentTitle')))

async function runSentList(_mode, context) {
  const stub = await startStubTeamServer({ port: STUB_PORT })
  // A handoff the member sent from another device before this one joined: found by the first sync, without a title.
  stub.addRecord({ id: 'h_other', clientId: 'c_other', to: { id: 'm_alex', handle: 'alex', displayName: 'Alex', removed: false }, status: 'done', reports: 1, payload: { enc: 'none', text: 'OTHER-DEVICE-REPORT' } })
  try {
    await withRig(
      context,
      async (app, _stub, profile) => {
        await joinMember(app, stub)
        await awaitStatus(app, 'connected', 'connected')
        const first = await pollFor({ read: () => sentSnapshot(app), settled: (v) => v.items.some((i) => i.id === 'h_other'), timeoutMs: 20_000, label: 'synced' })
        const other = first.items.find((i) => i.id === 'h_other')
        check(results, 'the first sync lists a handoff sent from another device, without a title', first.supported === true && other?.title === undefined && other?.status === 'done', JSON.stringify(first).slice(0, 240))
        check(results, 'the Sent list carries no clientId or device id', !JSON.stringify(first).includes('c_other') && !JSON.stringify(first).includes('d_other'), '')

        // A handoff sent from this device: Send, then the server's changes reach the list as events.
        const sid = randomUUID()
        writeDelivery(profile, sid, 's.json', { to: 'alex', title: 'SENT-TITLE', body: 'the work' })
        await awaitReceipt(profile, sid, 's.json', (r) => r.status === 'awaiting-confirmation', 'awaiting')
        await openOutgoing(app)
        await clickInRow(app, 'Alex', 'SENT-TITLE', 'intake.outgoing.send')
        await awaitReceipt(profile, sid, 's.json', (r) => r.status === 'sent', 'sent')
        // The Outgoing notification for this handoff is presented first: a later one in its window would coalesce.
        await pollFor({ read: async () => intakeNotifications(profile), settled: (list) => list.some((n) => JSON.stringify(n).includes(copy('intake.notify.outgoingTitle'))), timeoutMs: 20_000, label: 'outgoing notification presented' })
        const id = stub.sends.find((p) => p.payload?.title === 'SENT-TITLE') ? stub.record(stub.sends.find((p) => p.payload?.title === 'SENT-TITLE').clientId)?.id : null
        await openSent(app)
        const pending = await pollFor({ read: () => sentRowText(app, 'Alex', 'SENT-TITLE'), settled: (t) => t.includes(copy('intake.sent.status.pending')), timeoutMs: 15_000, label: 'pending row' })
        check(results, 'a handoff sent from this device is listed with its title and status', pending.includes(copy('intake.sent.status.pending')), pending.slice(0, 200))
        const notifiedBefore = sentNotifications(profile).length

        stub.setStatus(id, { status: 'delivered', deliveredAt: Date.now() })
        stub.setStatus(id, { status: 'taken' })
        const REPORT = 'Exported the billing CSV.\nSee https://example.invalid/pr/7 <b>bold</b>'
        stub.setStatus(id, { status: 'done', reports: 1, payload: { enc: 'none', text: REPORT } })
        const done = await pollFor({ read: () => sentRowText(app, 'Alex', 'SENT-TITLE'), settled: (t) => t.includes(copy('intake.sent.status.done')), timeoutMs: 15_000, label: 'done row' })
        const paragraphs = await app.client.evaluate(`[...(document.querySelector(${JSON.stringify(SENT_ROW('Alex', 'SENT-TITLE'))})?.querySelectorAll('p') ?? [])].map((p) => p.textContent)`)
        // Cross-process: the report the server holds against the row's paragraph as the renderer drew it.
        check(results, 'the report is shown as plain text, character for character', done.includes(copy('intake.sent.status.done')) && paragraphs.includes(REPORT), JSON.stringify(paragraphs).slice(0, 240))
        const notes = await pollFor({ read: async () => sentNotifications(profile), settled: (list) => list.length > notifiedBefore, timeoutMs: 20_000, label: 'notified' })
        const note = JSON.stringify(notes.at(-1))
        check(results, 'done notifies the sending device once, with the title and the reduced report', notes.length === notifiedBefore + 1 && note.includes('SENT-TITLE') && note.includes('Exported') && !note.includes('example.invalid') && !note.includes('<b>'), note.slice(0, 240))
        const badge = await app.client.evaluate(BADGE_TEXT)
        check(results, 'the Sent list does not count in the inbox badge', badge === '', String(badge))

        // Activating it opens the inbox on the Sent tab (the inbox closed first: an open inbox is left alone).
        await pollFor({ read: () => app.client.evaluate(`(() => { const b = document.querySelector('${label('intake.close')}'); b?.click(); return !document.querySelector('[role="dialog"]${label('intake.label')}') })()`), settled: Boolean, timeoutMs: 10_000, label: 'inbox closed' })
        fireIntakeNotification(profile, intakeNotifications(profile).length)
        const sentTab = await pollFor({ read: () => selectedTab(app), settled: (value) => value === copy('intake.sentTab'), timeoutMs: 15_000, label: 'opened on Sent' })
        check(results, 'activating a Sent notification opens the inbox on the Sent tab', sentTab === copy('intake.sentTab'), sentTab)

        // Another device of the member: its record arrives as an event and does not notify.
        stub.setStatus('h_other', { status: 'done', reports: 2, payload: { enc: 'none', text: 'OTHER-2' } })
        await pollFor({ read: () => sentSnapshot(app), settled: (v) => v.items.some((i) => i.id === 'h_other' && i.reports === 2), timeoutMs: 15_000, label: 'other updated' })
        // Past the 4-second coalescing window: a notification raised now would be presented by then (a 3-second wait
        // was green on the mutation that notifies every device — `notify-every-device`).
        await new Promise((resolve) => setTimeout(resolve, 6000))
        check(results, 'a handoff sent from another device does not notify this one', sentNotifications(profile).length === notes.length, `${notes.length} → ${sentNotifications(profile).length}`)

        // A recipient who left the team: the row says so.
        stub.setStatus('h_other', { to: { id: 'm_alex', handle: 'alex', displayName: 'Alex', removed: true } })
        const left = await pollFor({ read: () => sentRowText(app, 'Alex', copy('intake.sent.noTitle')), settled: (t) => t.includes(copy('intake.sent.recipientLeft')), timeoutMs: 15_000, label: 'recipient left shown' })
        check(results, 'a recipient who left the team is shown as no longer on it', left.includes(copy('intake.sent.recipientLeft')), left.slice(0, 200))

        // A 1011 close: the app reconnects and syncs again from its stored cursor.
        const syncsBefore = stub.frames.filter((f) => f.m === 'handoff.sync').length
        stub.closeAll(1011, 'feed')
        const resynced = await pollFor({ read: async () => stub.frames.filter((f) => f.m === 'handoff.sync').slice(syncsBefore), settled: (list) => list.length > 0, timeoutMs: 45_000, label: 'resynced' })
        check(results, 'after a 1011 close the app reconnects and syncs from its stored cursor', resynced.length > 0 && resynced[0].p.after > 0, JSON.stringify(resynced[0]?.p ?? null))
        await awaitStatus(app, 'connected', 'reconnected')
        stub.setStatus(id, { status: 'done', reports: 2, payload: { enc: 'none', text: 'SECOND-REPORT' } })
        const second = await pollFor({ read: () => sentSnapshot(app), settled: (v) => v.items.some((i) => i.id === id && i.text === 'SECOND-REPORT'), timeoutMs: 15_000, label: 'events after resync' })
        check(results, 'events reach the list again after the resync', second.items.some((i) => i.id === id && i.reports === 2), '')
      },
      { stub },
    )
  } finally {
    await stub.close()
  }
}

/** Accepts a teammate's item into folder f1 (the routing has no rule, so the folder is chosen on the card). */
async function acceptTeammateItem(app, title) {
  await pollFor({ read: () => app.client.evaluate(OPEN_INBOX), settled: Boolean, timeoutMs: 15_000, label: 'inbox open' })
  const row = label('intake.itemLabel', { title })
  await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const r = document.querySelector(${JSON.stringify(row)})
        const select = r?.querySelector('select')
        if (!select) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        setter.call(select, 'f1')
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'folder chosen',
  })
  await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(row)})?.querySelector('${label('intake.accept')}')
        if (!button || button.disabled) return false
        button.click()
        return true
      })()`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'accepted',
  })
}

async function runReportBack(_mode, context) {
  const profile = mkTemp('spekterm-team-return-')
  const repo = mkTemp('spekterm-team-return-repo-')
  writeFileSync(join(profile, 'workspace.json'), JSON.stringify({ version: 1, folders: [{ id: 'f1', path: repo, name: basename(repo), addedAt: '2026-11-03T00:00:00.000Z' }] }))
  writeFileSync(join(profile, 'intake-routing.json'), JSON.stringify({ version: 1, rules: [], fallbackFolderId: null }))
  const configDir = mkTemp('spekterm-team-return-config-')
  // `busySeconds`: after a submitted prompt the agent works a while (busy) before it stops — as a real one does.
  const stubAgent = makeStubAgent(mkTemp, configDir, { readyDelaySeconds: 2, busySeconds: 3 })
  const env = { CLAUDE_CONFIG_DIR: configDir, HOME: stubAgent.home, PATH: `${stubAgent.bin}:${process.env.PATH}` }
  await withRig(
    context,
    async (app, stub) => {
      await joinMember(app, stub)
      await awaitStatus(app, 'connected', 'connected')
      stub.push(offer('h_ret', { payload: { enc: 'none', title: 'RETURN-ME', body: 'please do the thing' } }))
      const snapshot = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_ret')), timeoutMs: 15_000, label: 'shown' })
      check(results, 'an acknowledged teammate item may be declined', (snapshot.declinable ?? []).includes(teammateItem(snapshot, 'h_ret').id), JSON.stringify(snapshot.declinable ?? null))
      await acceptTeammateItem(app, 'RETURN-ME')
      await pollFor({ read: async () => stubAgent.bytes(), settled: (bytes) => /that fence is not part of the task/.test(bytes), timeoutMs: 40_000, label: 'the prompt filled' })
      // The introduction the agent got at its first start already carries the teammate report paragraph.
      const hookDir = join(stubAgent.home, 'hook-stdout')
      const introAtStart = await pollFor({
        read: async () => (existsSync(hookDir) ? readdirSync(hookDir).filter((n) => n.startsWith('SessionStart-')).map((n) => readFileSync(join(hookDir, n), 'utf8')).join('\n') : ''),
        settled: (text) => text.includes('additionalContext'),
        timeoutMs: 15_000,
        label: 'first SessionStart output',
      })
      check(results, 'the linked session\'s first introduction tells it its reports go to the teammate', introAtStart.includes("opened by a teammate's handoff") && !introAtStart.includes('your parent session or the user'), introAtStart.slice(0, 160))
      await new Promise((resolve) => setTimeout(resolve, 1500))
      check(results, 'a filled prompt alone reports nothing', stub.updates.length === 0, JSON.stringify(stub.updates))

      // The user sends the prompt: the agent starts working, and `taken` is reported.
      const accepted = teammateItem(await inboxSnapshot(app), 'h_ret')
      const sessionId = accepted?.sessionId
      await app.client.evaluate(`window.workspace.terminal.write(${JSON.stringify(sessionId)}, '\\r')`)
      const taken = await pollFor({ read: async () => stub.updates.slice(), settled: (list) => list.some((u) => u.status === 'taken'), timeoutMs: 20_000, label: 'taken reported' })
      check(results, 'taken is reported once the user sent the prompt and the agent started', taken[0]?.id === 'h_ret' && taken[0]?.status === 'taken' && taken[0]?.payload === undefined, JSON.stringify(taken))

      // The agent reports: `done` with the summary, through the agent's own drop point.
      const SUMMARY = 'Did the thing; pushed branch fix/thing.'
      writeDelivery(profile, sessionId, 'r1.json', { kind: 'report', summary: SUMMARY })
      const done = await pollFor({ read: async () => stub.updates.slice(), settled: (list) => list.some((u) => u.status === 'done'), timeoutMs: 30_000, label: 'done reported' })
      // Cross-process: the text the server received against the summary the agent wrote.
      check(results, 'the agent\'s report reaches the server as done, character for character', done.find((u) => u.status === 'done')?.payload?.text === SUMMARY, JSON.stringify(done))
      const accept = await awaitReceipt(profile, sessionId, 'r1.json', () => true, 'report receipt')
      check(results, 'the agent\'s report receipt is accepted', accept.status === 'accepted', JSON.stringify(accept))
      // The recipient is told too, as for any adopted report; presented before the next step so nothing coalesces.
      const completed = await pollFor({ read: async () => intakeNotifications(profile), settled: (list) => list.some((n) => JSON.stringify(n).includes(copy('handoffLifecycle.notify.title'))), timeoutMs: 20_000, label: 'completion notified' })
      const completionNote = JSON.stringify(completed.find((n) => JSON.stringify(n).includes(copy('handoffLifecycle.notify.title'))))
      check(results, 'the linked session\'s report notifies the recipient, naming the handoff and the summary', completionNote.includes('RETURN-ME') && completionNote.includes('pushed branch'), completionNote.slice(0, 240))

      // The server refuses further reports: reporting stops, the user sees it, the next report is refused.
      const notesBeforeStop = intakeNotifications(profile).length
      stub.state.respond = (m) => (m === 'handoff.update' ? { ok: false, e: { code: 'TOO_MANY_REPORTS', message: 'limit', detail: { limit: 10 } } } : undefined)
      writeDelivery(profile, sessionId, 'r2.json', { kind: 'report', summary: 'second report' })
      const traced = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => s.notices.some((n) => n.code === 'TEAMMATE_REPORT_NOT_SENT'), timeoutMs: 30_000, label: 'stop traced' })
      check(results, 'a stop with an unsent report leaves a trace in the inbox', traced.notices.some((n) => n.code === 'TEAMMATE_REPORT_NOT_SENT'), JSON.stringify(traced.notices).slice(0, 200))
      // The report that hit the limit was announced as a completion a moment before: the stop's notification shares its
      // window, and the user gets either the named one (alone) or the coalesced one, which opens the inbox.
      const stopNotes = await pollFor({
        read: async () => intakeNotifications(profile).slice(notesBeforeStop),
        settled: (list) => list.length > 0,
        timeoutMs: 20_000,
        label: 'stop notified',
      })
      const stopNote = JSON.stringify(stopNotes)
      const named = stopNote.includes(copy('intake.notify.teammateReportTitle')) && stopNote.includes('RETURN-ME')
      const merged = stopNote.includes(copy('intake.notify.merged'))
      check(results, 'the stop raises a notification: named alone, or coalesced with the completion', named || merged, stopNote.slice(0, 240))
      const updatesAtStop = stub.updates.length
      writeDelivery(profile, sessionId, 'r3.json', { kind: 'report', summary: 'third report' })
      const refused = await awaitReceipt(profile, sessionId, 'r3.json', () => true, 'refused receipt')
      check(results, 'a report after the stop is refused at once and not sent', refused.status === 'rejected' && refused.code === 'TEAMMATE_REPORT_STOPPED' && stub.updates.length === updatesAtStop, JSON.stringify(refused))
      stub.state.respond = undefined

      // Declining another item, with a reason.
      stub.push(offer('h_dec', { payload: { enc: 'none', title: 'DECLINE-ME', body: 'not mine' } }))
      await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_dec')), timeoutMs: 15_000, label: 'second shown' })
      // Accepting closed the inbox (the new session took the stage): open it again.
      await pollFor({ read: () => app.client.evaluate(OPEN_INBOX), settled: Boolean, timeoutMs: 15_000, label: 'inbox open again' })
      const decRow = label('intake.itemLabel', { title: 'DECLINE-ME' })
      await pollFor({ read: () => app.client.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(decRow)})?.querySelector('${label('intake.decline')}'); b?.click(); return !!b })()`), settled: Boolean, timeoutMs: 15_000, label: 'Decline…' })
      await pollFor({ read: () => app.client.evaluate(`(() => { const t = document.querySelector(${JSON.stringify(decRow)})?.querySelector('textarea'); t?.focus(); return !!t && document.activeElement === t })()`), settled: Boolean, timeoutMs: 10_000, label: 'reason field' })
      const REASON = 'Not my area — ask the billing team'
      await app.client.send('Input.insertText', { text: REASON })
      await pollFor({ read: () => app.client.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(decRow)})?.querySelector('${label('intake.declineConfirm')}'); if (!b || b.disabled) return false; b.click(); return true })()`), settled: Boolean, timeoutMs: 10_000, label: 'Decline' })
      const declined = await pollFor({ read: async () => stub.updates.slice(), settled: (list) => list.some((u) => u.id === 'h_dec'), timeoutMs: 20_000, label: 'declined reported' })
      check(results, 'declining with a reason reaches the server', declined.find((u) => u.id === 'h_dec')?.status === 'declined' && declined.find((u) => u.id === 'h_dec')?.payload?.text === REASON, JSON.stringify(declined.find((u) => u.id === 'h_dec')))
      const after = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => teammateItem(s, 'h_dec')?.state !== 'pending', timeoutMs: 15_000, label: 'left the list' })
      // Ignoring another item tells the sender nothing.
      stub.push(offer('h_ign', { payload: { enc: 'none', title: 'IGNORE-ME', body: 'b' } }))
      await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_ign')), timeoutMs: 15_000, label: 'third shown' })
      const ignRow = label('intake.itemLabel', { title: 'IGNORE-ME' })
      await pollFor({ read: () => app.client.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(ignRow)})?.querySelector('${label('intake.dismiss')}'); b?.click(); return !!b })()`), settled: Boolean, timeoutMs: 15_000, label: 'Ignore' })
      await pollFor({ read: () => inboxSnapshot(app), settled: (s) => teammateItem(s, 'h_ign')?.state !== 'pending', timeoutMs: 15_000, label: 'ignored' })
      await new Promise((resolve) => setTimeout(resolve, 2500))
      check(results, 'ignoring a teammate item sends nothing to the server', !stub.updates.some((u) => u.id === 'h_ign'), JSON.stringify(stub.updates.filter((u) => u.id === 'h_ign')))
      check(results, 'a declined item leaves the pending list', teammateItem(after, 'h_dec')?.state === 'dismissed' || !teammateItem(after, 'h_dec'), JSON.stringify(teammateItem(after, 'h_dec') ?? null).slice(0, 120))
    },
    { profile, env },
  )
}

async function runNoWayBack(_mode, context) {
  await withRig(context, async (app, stub) => {
    // A 0.2-style server: no `handoff.update`, no `handoff.sync`.
    stub.state.operations = ['device.rename', 'device.leave', 'team.members', 'handoff.send', 'handoff.received']
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    stub.push(offer('h_old', { payload: { enc: 'none', title: 'OLD-SERVER', body: 'b' } }))
    const snapshot = await pollFor({ read: () => inboxSnapshot(app), settled: (s) => Boolean(teammateItem(s, 'h_old')), timeoutMs: 15_000, label: 'shown' })
    check(results, 'a server without handoff.update offers no Decline', (snapshot.declinable ?? []).length === 0, JSON.stringify(snapshot.declinable ?? null))
    await pollFor({ read: () => app.client.evaluate(OPEN_INBOX), settled: Boolean, timeoutMs: 15_000, label: 'inbox open' })
    const row = await pollFor({ read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(label('intake.itemLabel', { title: 'OLD-SERVER' }))})?.innerHTML ?? ''`), settled: (h) => h.length > 0, timeoutMs: 15_000, label: 'row' })
    check(results, 'the row has no Decline button', !row.includes(`aria-label="${copy('intake.decline')}"`) && row.includes(`aria-label="${copy('intake.dismiss')}"`), '')
    const sent = await sentSnapshot(app)
    check(results, 'the Sent list says the server does not offer it, and nothing was synced', sent.supported === false && stub.count('handoff.sync') === 0, JSON.stringify(sent))
  })
}

// ---- The relay switch (`phone-relay`) ----

const RELAY_OPERATIONS = ['relay.grant', 'relay.grants', 'relay.revoke', 'relay.refuse']
const relaySwitch = field('team.relay.enable')
const hasRelaySwitch = (app) => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(relaySwitch)}))`)
const workspaceCall = (app, expression) => app.client.evaluate(`${expression}.then((v) => JSON.stringify(v ?? null))`, { awaitPromise: true }).then((json) => JSON.parse(String(json)))

async function setRemote(app, on) {
  if (on) await workspaceCall(app, `window.workspace.remote.setPort(${STUB_PORTS.teamRemoteListener})`)
  await workspaceCall(app, `window.workspace.remote.setEnabled(${on})`)
  await pollFor({
    read: () => workspaceCall(app, 'window.workspace.remote.state()'),
    settled: (state) => state.enabled === on && (on ? state.listen.status === 'listening' : true),
    timeoutMs: 10_000,
    label: `remote access ${on ? 'on' : 'off'}`,
  })
}

async function awaitSwitch(app, shown, what) {
  return pollFor({ read: () => hasRelaySwitch(app), settled: (value) => value === shown, timeoutMs: 10_000, label: what })
}

async function runRelaySwitch(_mode, context) {
  await withRig(context, async (app, stub, profile) => {
    // A server without the relay: no switch, whatever remote access is.
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'connected')
    await setRemote(app, true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    check(results, 'a server without the relay shows no relay switch', !(await hasRelaySwitch(app)), (await sectionText(app)).slice(0, 200))

    // The server lists the relay from the next hello on.
    stub.state.operations = [...stub.state.operations, ...RELAY_OPERATIONS]
    await setRemote(app, false)
    await workspaceCall(app, 'window.workspace.team.reconnect()')
    await awaitStatus(app, 'connected', 'connected again')
    await pollFor({ read: () => teamView(app), settled: (v) => v.membership?.operations.includes('relay.grant'), timeoutMs: 10_000, label: 'operations list the relay' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    check(results, 'with remote access off and the relay off, no relay switch', !(await hasRelaySwitch(app)), '')
    await setRemote(app, true)
    const shown = await awaitSwitch(app, true, 'the relay switch appears')
    check(results, 'with the server offering it and remote access on, the relay switch is shown, off', shown && !(await teamView(app)).relay?.on && stub.count('relay.grant') === 0, `${JSON.stringify((await teamView(app)).relay)} grants asked ${stub.count('relay.grant')}`)

    // One paired phone; turning the relay on asks for one grant named after it.
    const state = await workspaceCall(app, 'window.workspace.remote.state()')
    const pairing = await workspaceCall(app, 'window.workspace.remote.startPairing()')
    const code = new URL(pairing.link).searchParams.get('c')
    const phone = await pairRemote({ port: STUB_PORTS.teamRemoteListener, fingerprint: state.fingerprint }, { code, deviceName: 'Probe Pixel' })
    check(results, 'a phone pairs directly', phone.response.ok === true, JSON.stringify(phone.response).slice(0, 160))
    phone.client.close()
    await clickSelector(app.client, relaySwitch, 'the relay switch')
    const granted = await pollFor({ read: () => [...stub.state.grants.values()], settled: (names) => names.length === 1, timeoutMs: 10_000, label: 'one grant requested' })
    check(results, 'turning the relay on asks the server for one grant, named after the phone', JSON.stringify(granted) === JSON.stringify(['Probe Pixel']), JSON.stringify(granted))
    const line = await awaitText(app, copy('team.relay.phones', { withGrant: 1, paired: 1 }), 'the phone count')
    check(results, 'the section says how many phones can connect through the server', line.includes(copy('team.relay.phones', { withGrant: 1, paired: 1 })), '')
    const ipc = JSON.stringify(await teamView(app))
    const grantSecret = `grant-secret-${[...stub.state.grants.keys()][0]}`
    check(results, 'the renderer’s team state carries no grant id or secret', !ipc.includes(grantSecret) && !ipc.includes([...stub.state.grants.keys()][0]), ipc.slice(0, 200))
    check(results, 'the grant secret is in the secret store', readFileSync(join(profile, 'secrets.json'), 'utf8').includes(grantSecret), '')
    check(results, 'the membership file holds no grant secret', !readFileSync(join(profile, 'team.json'), 'utf8').includes(grantSecret), '')

    // Remote access off: the switch stays, with the reason; nothing revoked.
    await setRemote(app, false)
    const reason = await awaitText(app, copy('team.relay.blockedRemoteOff'), 'the remote-access reason line')
    check(results, 'with the relay on and remote access off, the switch stays with the reason', (await hasRelaySwitch(app)) && reason.includes(copy('team.relay.blockedRemoteOff')), '')
    check(results, 'turning remote access off revokes nothing', stub.count('relay.revoke') === 0 && stub.state.grants.size === 1, `revokes ${stub.count('relay.revoke')}`)

    // The relay off: the grant is revoked.
    await setRemote(app, true)
    await clickSelector(app.client, relaySwitch, 'the relay switch')
    await pollFor({ read: () => stub.state.grants.size, settled: (n) => n === 0, timeoutMs: 10_000, label: 'the grant revoked' })
    check(results, 'turning the relay off revokes the grant', stub.count('relay.revoke') >= 1 && stub.state.grants.size === 0, `revokes ${stub.count('relay.revoke')}`)

    // On again, then leave and join again: the relay starts off. Left through the same IPC as the section's Leave
    // (the button and its confirmation are `runLeave`'s); what is checked here is the setting after a new join.
    await clickSelector(app.client, relaySwitch, 'the relay switch')
    await pollFor({ read: () => teamView(app), settled: (v) => v.relay?.on === true, timeoutMs: 10_000, label: 'relay on again' })
    stub.state.deviceCount = 2
    const left = await workspaceCall(app, 'window.workspace.team.leave()')
    check(results, 'leaving succeeds', left?.ok === true, JSON.stringify(left))
    await awaitStatus(app, 'unjoined', 'left')
    await joinMember(app, stub)
    await awaitStatus(app, 'connected', 'joined again')
    const again = await pollFor({ read: () => teamView(app), settled: (v) => v.relay !== undefined, timeoutMs: 10_000, label: 'relay view after joining again' })
    check(results, 'after leaving and joining again the relay is off', again.relay?.on === false, JSON.stringify(again.relay))
    await setRemote(app, false)
  })
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
  { name: 'runTeammateSend', run: runTeammateSend },
  { name: 'runTeammateRateLimitAndRefusal', run: runTeammateRateLimitAndRefusal },
  { name: 'runTeammateRefusedBeforeAsking', run: runTeammateRefusedBeforeAsking },
  { name: 'runTeammateReceive', run: runTeammateReceive },
  { name: 'runTeammateAccept', run: runTeammateAccept },
  { name: 'runSentList', run: runSentList },
  { name: 'runReportBack', run: runReportBack },
  { name: 'runNoWayBack', run: runNoWayBack },
  { name: 'runRelaySwitch', run: runRelaySwitch },
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
