/**
 * workspace-app-shell: "The app's own code connects only where its allow-list says".
 *
 * The website states what the app connects to (https://spekterm.com/docs/reference/data-and-network/,
 * source `site/src/content/docs/docs/reference/data-and-network.md` and its zh-tw counterpart). This
 * test keeps that page honest about the app's own code: every network-capable API referenced in the main
 * process, the preload, or the code they share, and every package or built-in module they import, must be
 * on the lists below. **When a list changes, revisit that page in both languages.**
 *
 * What it cannot see, and the page says so: programs the app starts (`claude`, `openspec`, the login
 * shell), Electron's own internals (the spell checker's download was one — `probe:shell` covers Chromium's
 * startup connections), and native modules.
 *
 * `shell.openExternal` is deliberately not listed: it hands a URL the user clicked to their browser.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { scanSource } from './lib/network-surface.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['src/main', 'src/preload', 'src/shared']

/** `{ file, api }` — where a network-capable API may be referenced, and why. */
const API_ALLOW = [
  // Slack's Web API, only after the user saved credentials (slack-intake-source).
  { file: 'src/main/slack-api.ts', api: 'fetch' },
  // Slack's Socket Mode, only after the user saved an app-level token.
  { file: 'src/main/slack-realtime.ts', api: 'WebSocket' },
  // The app's own page from the dev server (development only; production uses `loadFile`).
  { file: 'src/main/index.ts', api: 'loadURL' },
  // The update check of a build that only tells (`app-update`): GitHub's latest-release endpoint, from a packaged
  // build with the automatic check on, or after "Check now".
  { file: 'src/main/update-net.ts', api: 'net' },
  { file: 'src/main/update-net.ts', api: 'fetch' },
]

/**
 * Packages and built-in modules the app's own code may import anywhere (`node:` prefix normalized away).
 * Network modules (`net`, `tls`, `http`, `https`, `http2`, `dgram`) and network packages are never on it —
 * they are only ever on `MODULE_ALLOW_FILES`, scoped to the one file that needs them.
 */
const MODULE_ALLOW = new Set([
  'electron',
  'chokidar',
  'i18next',
  'node-pty',
  '@spekjs/core',
  '@spekjs/core/graph-node-id',
  // The side panel's artifact order, applied to OpenSpec answers for devices (`remote-openspec.ts`): a pure sort.
  '@spekjs/core/artifact-order',
  '@shared/hibernation/settings',
  '@shared/i18n',
  '@shared/i18n/languages',
  '@shared/i18n/locale',
  '@shared/insights/cue-rules.json',
  'child_process',
  'crypto',
  'fs',
  'fs/promises',
  'os',
  'path',
  'url',
])

/**
 * `{ file, module }` — a module allowed in one file only. The remote access listener is the only place a
 * server is created (`remote-access`; `scripts/server-source.test.mjs`): `https` for TLS and `ws` for the
 * WebSocket server. It accepts connections and makes none; the data and network page says so.
 */
const MODULE_ALLOW_FILES = [
  { file: 'src/main/remote-server.ts', module: 'https' },
  { file: 'src/main/remote-server.ts', module: 'ws' },
  // The update check and download of a Linux AppImage (`app-update`): GitHub Releases of spekhq/spekterm only,
  // through Electron's `net`. It never installs (`update-install.ts` does).
  { file: 'src/main/update-installer.ts', module: 'electron-updater' },
]

function sourceFiles() {
  const walk = (dir) =>
    readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    )
  return ROOTS.flatMap(walk).filter(
    (file) => /\.(ts|tsx|mts)$/.test(file) && !/\.(test|testkit)\.ts$|\.d\.ts$/.test(file),
  )
}

function scanRepository() {
  const apis = []
  const modules = []
  for (const file of sourceFiles()) {
    const result = scanSource(file, readFileSync(join(repoRoot, file), 'utf8'))
    const rel = relative(repoRoot, join(repoRoot, file))
    apis.push(...result.apis.map((hit) => ({ ...hit, file: rel })))
    modules.push(...result.modules.map((hit) => ({ ...hit, file: rel })))
  }
  return { apis, modules }
}

/** The verdict for a scan against the allow-lists — shared by the real run and the control groups. */
function verdict(
  { apis, modules },
  { apiAllow = API_ALLOW, moduleAllow = MODULE_ALLOW, moduleAllowFiles = MODULE_ALLOW_FILES } = {},
) {
  const allowed = (hit) => apiAllow.some((entry) => entry.file === hit.file && entry.api === hit.api)
  const unlistedApis = apis.filter((hit) => !allowed(hit)).map((hit) => `${hit.file}:${hit.line} ${hit.api}`)
  const moduleAllowed = (hit) =>
    moduleAllow.has(hit.module) || moduleAllowFiles.some((entry) => entry.file === hit.file && entry.module === hit.module)
  const unlistedModules = modules.filter((hit) => !moduleAllowed(hit)).map((hit) => `${hit.file}:${hit.line} ${hit.module}`)
  const staleApis = apiAllow
    .filter((entry) => !apis.some((hit) => hit.file === entry.file && hit.api === entry.api))
    .map((entry) => `${entry.file} ${entry.api}`)
  const staleModules = [
    ...[...moduleAllow].filter((name) => !modules.some((hit) => hit.module === name)),
    ...moduleAllowFiles
      .filter((entry) => !modules.some((hit) => hit.file === entry.file && hit.module === entry.module))
      .map((entry) => `${entry.file} ${entry.module}`),
  ]
  return { unlistedApis, unlistedModules, staleApis, staleModules }
}

test('the scan reaches the source (a scan of nothing would pass everything)', () => {
  const files = sourceFiles()
  assert.ok(files.length > 50, `only ${files.length} files under ${ROOTS.join(', ')}`)
  assert.ok(files.includes('src/main/slack-api.ts'))
})

test("the app's own code references network APIs only where the allow-list says", () => {
  const { unlistedApis, staleApis } = verdict(scanRepository())
  assert.deepEqual(unlistedApis, [], `not on the allow-list — add it and revisit the data and network page:\n${unlistedApis.join('\n')}`)
  assert.deepEqual(staleApis, [], `allow-list entries that match nothing — remove them:\n${staleApis.join('\n')}`)
})

test("the app's own code imports only allow-listed packages and built-in modules", () => {
  const { unlistedModules, staleModules } = verdict(scanRepository())
  assert.deepEqual(unlistedModules, [], `not on the allow-list — add it and revisit the data and network page:\n${unlistedModules.join('\n')}`)
  assert.deepEqual(staleModules, [], `allow-list entries that match nothing — remove them:\n${staleModules.join('\n')}`)
})

// Control groups: each shape must be reported. A scanner that misses one passes the real run while the
// shape it misses ships.

const FILE = 'src/main/example.ts'
const scanOf = (text) => {
  const result = scanSource(FILE, text)
  return {
    apis: result.apis.map((hit) => ({ ...hit, file: FILE })),
    modules: result.modules.map((hit) => ({ ...hit, file: FILE })),
  }
}
const ONLY_ELECTRON = new Set(['electron'])

for (const [name, text] of [
  ['an unlisted fetch call', `await fetch('https://example.com')`],
  ['a fetch passed by reference', `const impl = options.impl ?? fetch`],
  ['an aliased fetch', `const f = fetch`],
  ['fetch destructured from globalThis', `const { fetch: f } = globalThis`],
  ['globalThis.fetch', `globalThis.fetch('https://example.com')`],
  ["globalThis['fetch']", `globalThis['fetch']('https://example.com')`],
  ['a WebSocket construction', `new WebSocket('wss://example.com')`],
  ['net imported from electron', `import { net } from 'electron'\nnet.request('https://example.com')`],
  ['session.fetch', `ses.fetch('https://example.com')`],
  ['loadURL to a remote page', `win.loadURL('https://example.com')`],
  ['a non-empty spell-checker language list', `session.defaultSession.setSpellCheckerLanguages(['en-US'])`],
  ['a spell-checker language list from a variable', `session.defaultSession.setSpellCheckerLanguages(languages)`],
  ['a dictionary download URL', `ses.setSpellCheckerDictionaryDownloadURL('https://example.com/')`],
  ['the auto updater', `import { autoUpdater } from 'electron'\nautoUpdater.checkForUpdates()`],
]) {
  test(`control: ${name} is reported`, () => {
    const { unlistedApis } = verdict(scanOf(text), { apiAllow: [], moduleAllow: ONLY_ELECTRON })
    assert.equal(unlistedApis.length > 0, true, `not reported: ${text}`)
  })
}

for (const [name, text] of [
  ["a bare 'https' import", `import https from 'https'`],
  ["a 'node:https' import", `import { request } from 'node:https'`],
  ['a require of a network package', `const WebSocketClient = require('ws')`],
  ['a dynamic import of a network package', `const undici = await import('undici')`],
  ['a re-export of a network module', `export { connect } from 'node:net'`],
]) {
  test(`control: ${name} is reported`, () => {
    const { unlistedModules } = verdict(scanOf(text), { apiAllow: [], moduleAllow: ONLY_ELECTRON })
    assert.equal(unlistedModules.length > 0, true, `not reported: ${text}`)
  })
}

test('control: the fix itself — an empty spell-checker language list — is not reported', () => {
  const { unlistedApis } = verdict(scanOf(`session.defaultSession.setSpellCheckerLanguages([])`), {
    apiAllow: [],
    moduleAllow: ONLY_ELECTRON,
  })
  assert.deepEqual(unlistedApis, [])
})

test('control: types, private names, and relative imports are not reported', () => {
  const text = [
    `import { x } from './local'`,
    `type Impl = typeof fetch`,
    `let socket: WebSocket | null = null`,
    `class A { #fetch = 1; fetchImpl = 2 }`,
    `import { type WebSocket as Socket } from 'electron'`,
    `import type { WebSocket } from 'electron'`,
  ].join('\n')
  const { unlistedApis, unlistedModules } = verdict(scanOf(text), { apiAllow: [], moduleAllow: ONLY_ELECTRON })
  assert.deepEqual(unlistedApis, [])
  assert.deepEqual(unlistedModules, [])
})

test('control: an allow-listed file using a second API is reported', () => {
  const { unlistedApis } = verdict(scanOf(`const f = fetch\nnew WebSocket('wss://example.com')`), {
    apiAllow: [{ file: FILE, api: 'fetch' }],
    moduleAllow: ONLY_ELECTRON,
  })
  assert.deepEqual(unlistedApis.map((hit) => hit.split(' ')[1]), ['WebSocket'])
})

test('control: a stale allow-list entry is reported', () => {
  const { staleApis, staleModules } = verdict(scanOf(`const a = 1`), {
    apiAllow: [{ file: FILE, api: 'fetch' }],
    moduleAllow: new Set(['electron']),
    moduleAllowFiles: [],
  })
  assert.deepEqual(staleApis, [`${FILE} fetch`])
  assert.deepEqual(staleModules, ['electron'])
})

test('control: a module scoped to one file is reported in another file', () => {
  const { unlistedModules } = verdict(scanOf(`import { createServer } from 'node:https'`), {
    apiAllow: [],
    moduleAllow: ONLY_ELECTRON,
    moduleAllowFiles: [{ file: 'src/main/remote-server.ts', module: 'https' }],
  })
  assert.deepEqual(unlistedModules, [`${FILE}:1 https`])
})

test('control: the same module in the file it is scoped to is not reported', () => {
  const { unlistedModules } = verdict(scanOf(`import { createServer } from 'node:https'`), {
    apiAllow: [],
    moduleAllow: ONLY_ELECTRON,
    moduleAllowFiles: [{ file: FILE, module: 'https' }],
  })
  assert.deepEqual(unlistedModules, [])
})

test('control: a stale file-scoped entry is reported', () => {
  const { staleModules } = verdict(scanOf(`import { app } from 'electron'`), {
    apiAllow: [],
    moduleAllow: ONLY_ELECTRON,
    moduleAllowFiles: [{ file: FILE, module: 'https' }],
  })
  assert.deepEqual(staleModules, [`${FILE} https`])
})

test('control: a type-only import does not hide a value import of the same name', () => {
  const { unlistedApis } = verdict(scanOf(`import { type WebSocket } from 'ws'\nnew WebSocket('wss://example.com')`), {
    apiAllow: [],
    moduleAllow: new Set(['electron', 'ws']),
  })
  assert.equal(unlistedApis.length, 1)
})
