/**
 * The theme and the interface zoom (`ui-appearance`, change `ui-theme-zoom-and-session-summary`), run by
 * `probe:workspace` at its end.
 *
 * Two facts of the virtual display shape every section:
 *
 * - **It resolves System to light** (measured), and `GTK_THEME=Adwaita:dark` turns it dark. The seeded profiles pin
 *   Dark (`lib/probe-language.mjs`), so a check that the stored theme decides the palette is discriminating only
 *   when the stored value differs from what System would give: Dark persisted over a restart, System at start
 *   under `GTK_THEME`.
 * - **Chromium remembers a zoom per page URL**, and unpackaged the URL is stable. "The stored zoom survives a
 *   restart" is therefore green even when main never applies the preference, unless Chromium's memory and the
 *   file disagree: the restart section lets Chromium record 150% and then writes 125% into the file.
 *
 * Every zoom section resets to 100% in a `finally`: later sections click at real mouse coordinates.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { check, connectToApp, pollFor } from './lib/cdp.mjs'
import { copy, label } from './lib/copy.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { awaitMounted, mountedExpression } from './lib/mounted.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { ptyPids, SHELL_PATH } from './lib/pty-pids.mjs'
import { quitAndWait } from './lib/quit.mjs'
import { closeSettings, openSettings, selectValue, setSelect } from './lib/settings.mjs'

const MOUNTED = mountedExpression()

const SPEC = (topic) =>
  `# ${topic} Specification\n\n## Purpose\n\nWhat ${topic} is for.\n\n## Requirements\n\n### Requirement: ${topic} works\n\n` +
  `The system SHALL make ${topic} work.\n\n#### Scenario: Normal\n\n- **WHEN** the user acts\n- **THEN** the system answers\n`
const DELTA =
  '## MODIFIED Requirements\n\n### Requirement: core works\n\nThe system SHALL work differently.\n\n' +
  '#### Scenario: Normal\n\n- **WHEN** the user acts\n- **THEN** the system answers\n'

// ── Renderer reads ───────────────────────────────────────────────────────────

const DARK_SCHEME = `matchMedia('(prefers-color-scheme: dark)').matches`
const STAGE_BG = `getComputedStyle(document.querySelector('main${label('stage.label')}')).backgroundColor`
const TERMINAL_BG = `(() => {
  const host = [...document.querySelectorAll('section${label('stage.terminal')} .xterm')]
    .find((el) => el.getBoundingClientRect().width > 0)
  // xterm 6 paints its background on the scrollable element, not on \`.xterm-viewport\` (measured).
  const surface = host?.querySelector('.xterm-scrollable-element')
  return surface ? getComputedStyle(surface).backgroundColor : null
})()`
const EDITOR_BG = `(() => {
  const el = document.querySelector('section${label('files.label')} .monaco-editor .monaco-editor-background')
  return el ? getComputedStyle(el).backgroundColor : null
})()`
const EDITOR_LINES = `document.querySelector('section${label('files.label')} .monaco-editor .view-lines')?.innerText ?? null`
const TERMINAL_RECT = `(() => {
  const host = [...document.querySelectorAll('section${label('stage.terminal')} .xterm')]
    .find((el) => el.getBoundingClientRect().width > 0)
  if (!host) return null
  const r = host.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`
/** The color xterm drew a span of exactly `text` in (DOM renderer), and the terminal's background. */
const SPAN_COLOR = (text) => `(() => {
  const host = [...document.querySelectorAll('section${label('stage.terminal')} .xterm')]
    .find((el) => el.getBoundingClientRect().width > 0)
  const span = [...(host?.querySelectorAll('.xterm-rows span') ?? [])].find((s) => s.textContent === ${JSON.stringify(text)})
  if (!span) return null
  return { color: getComputedStyle(span).color, background: getComputedStyle(host.querySelector('.xterm-scrollable-element')).backgroundColor }
})()`
const GRAPH_COLORS = `(() => {
  const svg = document.querySelector('section${label('openspec.label')} .nodes')?.closest('svg')
  const circle = svg?.querySelector('.nodes circle')
  const text = svg?.querySelector('.labels text')
  if (!circle || !text) return null
  return { circle: circle.getAttribute('fill'), text: text.getAttribute('fill') + '|' + text.getAttribute('stroke') }
})()`
const CLICK_GRAPH = `(() => {
  const tab = [...document.querySelectorAll('[role="tablist"]${label('openspec.views')} button[role="tab"]')]
    .find((el) => el.innerText.trim().endsWith(${JSON.stringify(copy('viz.graph'))}))
  if (!tab) return false
  tab.click()
  return true
})()`
const REGION_WIDTHS = `(() => {
  const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)
  return {
    innerWidth,
    activityBar: width(document.querySelector('nav${label('activityBar.label')}')),
    rail: width(document.querySelector('aside${label('rail.label')}')),
    terminal: width(document.querySelector('section${label('stage.terminal')}')),
    sidePanel: width(document.querySelector('section${label('openspec.sidePanel')}')),
  }
})()`

const OPEN_SPAWN_MENU = (folderName) =>
  `document.querySelector(${JSON.stringify(`button${label('rail.newSessionIn', { name: folderName })}`)})?.click() ?? false`
const CLICK_SHELL_ITEM = `(() => {
  const item = [...(document.querySelector('[role="menu"]')?.querySelectorAll('button') ?? [])]
    .find((b) => b.innerText.includes(${JSON.stringify(copy('sessions.spawnShell'))}))
  if (!item) return false
  item.click()
  return true
})()`
// A rail item's row is labelled by the item's name.
const SELECT_FOLDER = (name) =>
  `document.querySelector(${JSON.stringify(`aside${label('rail.label')} [role="button"][aria-label="${name}"]`)})?.click() ?? false`
const OPEN_FILES = `(() => {
  const tab = [...document.querySelectorAll('[role="tablist"]${label('panelSwitch.label')} button[role="tab"]')]
    .find((b) => b.innerText.includes(${JSON.stringify(copy('panelSwitch.files'))}))
  if (!tab) return false
  tab.click()
  return true
})()`
const OPEN_OPENSPEC = OPEN_FILES.replace(JSON.stringify(copy('panelSwitch.files')), JSON.stringify(copy('panelSwitch.openSpec')))
const OPEN_FILE = (name) => `(() => {
  const row = [...document.querySelectorAll('section${label('files.label')} [role="treeitem"]')]
    .find((r) => r.innerText.includes(${JSON.stringify(name)}))
  if (!row) return false
  row.click()
  return true
})()`
const FOCUS_EDITOR = `(() => {
  const ta = document.querySelector('section${label('files.label')} textarea')
  if (!ta) return false
  ta.focus()
  return document.activeElement === ta
})()`

// ── Input ────────────────────────────────────────────────────────────────────

async function realClick(client, at) {
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
}

async function pressCtrlS(client) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', { type, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 })
  }
  await sleep(300)
}

async function pressEnter(client) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r' } : {}),
    })
  }
}

/** A line to the shell: the Enter is a real key event (xterm reads Enter on keydown, not from inserted text). */
async function typeLine(client, text) {
  await client.send('Input.insertText', { text })
  await pressEnter(client)
}

// ── Colors ───────────────────────────────────────────────────────────────────

const rgb = (value) => (value?.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number)
function contrast(a, b) {
  const luminance = ([r, g, bl]) => {
    const [x, y, z] = [r, g, bl].map((c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * x + 0.7152 * y + 0.0722 * z
  }
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

const LIGHT = { stage: 'rgb(247, 248, 250)', terminal: 'rgb(251, 252, 253)', editor: 'rgb(255, 255, 255)' }
const DARK = { stage: 'rgb(15, 18, 22)', terminal: 'rgb(7, 9, 12)', editor: 'rgb(20, 24, 29)' }
/** The light ANSI set's bright yellow (`TERMINAL_THEMES.light.brightYellow`, `#b45309`). */
const LIGHT_BRIGHT_YELLOW = 'rgb(180, 83, 9)'

/**
 * @param {{ results: unknown[], port: number, mkTemp: (prefix: string) => string }} options
 */
export async function runAppearanceSections({ results, port, mkTemp }) {
  console.log('\nThe theme and the interface zoom (ui-appearance)')
  // A value, not a `SPEKTERM_*` name: the pty environment drops the app's own variables.
  const marker = `appearance-probe-${process.pid}-${Date.now()}`
  const base = mkTemp('spekterm-appearance-')
  const repo = join(base, 'repo-look')
  mkdirSync(join(repo, 'openspec', 'specs', 'core'), { recursive: true })
  mkdirSync(join(repo, 'openspec', 'changes', 'look-change', 'specs', 'core'), { recursive: true })
  writeFileSync(join(repo, 'notes.txt'), 'plain text\nsecond line\n')
  writeFileSync(join(repo, 'openspec', 'config.yaml'), 'schema: spec-driven\n')
  writeFileSync(join(repo, 'openspec', 'specs', 'core', 'spec.md'), SPEC('core'))
  writeFileSync(join(repo, 'openspec', 'changes', 'look-change', '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-01\n')
  writeFileSync(join(repo, 'openspec', 'changes', 'look-change', 'proposal.md'), '# Look\n\n## Why\n\nBecause.\n')
  writeFileSync(join(repo, 'openspec', 'changes', 'look-change', 'specs', 'core', 'spec.md'), DELTA)

  const profileWith = (preferences) => {
    const profile = mkTemp('spekterm-appearance-profile-')
    writeFileSync(
      join(profile, 'workspace.json'),
      JSON.stringify({ version: 1, folders: [{ id: 'look', path: repo, addedAt: '2026-10-01T00:00:00.000Z' }] }),
    )
    if (preferences) writeFileSync(join(profile, 'preferences.json'), JSON.stringify(preferences))
    else seedLanguage(profile)
    return profile
  }
  const readPreferences = (profile) => JSON.parse(readFileSync(join(profile, 'preferences.json'), 'utf8'))

  async function launch(profile, env = {}) {
    const child = spawn('electron', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...electronExtraArgs(), '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SHELL: SHELL_PATH, APPEARANCE_PROBE_MARKER: marker, ...env },
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const client = await connectToApp(port)
    await awaitMounted(client, { expression: MOUNTED })
    const read = (expression) => client.evaluate(expression)
    const until = (expression, settled, what, timeoutMs = 8_000) =>
      pollFor({ read: () => read(expression), settled, timeoutMs, label: what })
    return {
      client,
      read,
      until,
      stderr: () => stderr,
      async close() {
        client.close()
        await quitAndWait(child)
      },
    }
  }

  async function newShell(app) {
    await app.read(SELECT_FOLDER('repo-look'))
    await app.read(OPEN_SPAWN_MENU('repo-look'))
    await app.until(`Boolean(document.querySelector('[role="menu"]'))`, Boolean, 'the spawn menu')
    await app.read(CLICK_SHELL_ITEM)
    await app.until(TERMINAL_RECT, (value) => value !== null, 'a shown terminal')
    return pollFor({ read: () => ptyPids(marker), settled: (pids) => pids.length === 1, timeoutMs: 8_000, label: 'one pty' })
  }

  async function chooseTheme(app, theme) {
    await openSettings(app.client, 'general')
    await setSelect(app.client, 'settings.theme', theme)
    await app.until(selectValue('settings.theme'), (value) => value === theme, `Settings shows ${theme}`)
    await closeSettings(app.client)
  }

  /** `cols` as the pty sees it, read through the shell into a file. */
  async function ptyCols(app, tag) {
    await realClick(app.client, await app.read(TERMINAL_RECT))
    await sleep(200)
    const file = join(base, `cols-${tag}.txt`)
    await typeLine(app.client, `stty size | cut -d' ' -f2 > ${file}`)
    const text = await pollFor({
      read: () => {
        try {
          return readFileSync(file, 'utf8')
        } catch {
          return ''
        }
      },
      settled: (value) => /\d/.test(value),
      timeoutMs: 8_000,
      label: `cols (${tag})`,
    })
    return Number(text.trim() || 0)
  }

  // ── Theme: Light applies at once; the terminal, the editor and Graph follow ──
  {
    // GPU off: the DOM renderer draws spans whose color can be read (the WebGL one draws pixels).
    const profile = profileWith({ version: 1, terminal: { gpuAcceleration: false }, ui: { language: 'en', theme: 'dark' } })
    const app = await launch(profile)
    try {
      const [pid] = await newShell(app)
      await app.read(OPEN_FILES)
      await app.until(OPEN_FILE('notes.txt'), Boolean, 'notes.txt in the tree')
      await app.until(FOCUS_EDITOR, Boolean, 'the editor')
      await app.client.send('Input.insertText', { text: 'EDITED ' })
      await app.until(EDITOR_LINES, (value) => value?.includes('EDITED'), 'the unsaved edit')
      const before = { stage: await app.read(STAGE_BG), terminal: await app.read(TERMINAL_BG), editor: await app.read(EDITOR_BG) }
      check(
        results,
        '[ui-appearance] precondition: the seeded profile starts dark',
        before.stage === DARK.stage && before.terminal === DARK.terminal && before.editor === DARK.editor,
        JSON.stringify(before),
      )

      await chooseTheme(app, 'light')
      const after = await app.until(
        `({ stage: ${STAGE_BG}, terminal: ${TERMINAL_BG}, editor: ${EDITOR_BG}, dark: ${DARK_SCHEME} })`,
        (value) => value.stage === LIGHT.stage && value.terminal === LIGHT.terminal && value.editor === LIGHT.editor,
        'the light palette',
      )
      const pidsAfter = ptyPids(marker)
      const lines = await app.read(EDITOR_LINES)
      check(
        results,
        '[ui-appearance] choosing Light applies at once: the stage, the terminal and the editor turn light',
        after.stage === LIGHT.stage && after.terminal === LIGHT.terminal && after.editor === LIGHT.editor && after.dark === false,
        JSON.stringify(after),
      )
      check(
        results,
        '[ui-appearance] the session keeps running and the unsaved edit is still there',
        pidsAfter.length === 1 && pidsAfter[0] === pid && lines?.includes('EDITED') === true,
        `pty ${pid} → ${pidsAfter.join(',')}; editor has the edit: ${lines?.includes('EDITED')}`,
      )
      // Save it: an unsaved edit makes the quit ask, and the first SIGTERM would not end the app.
      await app.until(FOCUS_EDITOR, Boolean, 'the editor again')
      await pressCtrlS(app.client)
      await app.until(`document.querySelector('[role="dialog"]') === null`, Boolean, 'no dialog after saving')

      // The light terminal's 16 colors and contrast floor. `\033[93m` is bright yellow (xterm's default `#ffff00`
      // is 1.07:1 on the light background); `\033[38;2;255;255;128m` is a true color that bypasses the 16.
      await realClick(app.client, await app.read(TERMINAL_RECT))
      await sleep(200)
      await typeLine(app.client, `printf '\\033[93mYEL\\033[0m \\033[38;2;255;255;128mTRUE\\033[0m\\n'`)
      const yellow = await app.until(SPAN_COLOR('YEL'), (value) => value !== null, 'the bright yellow span')
      const truecolor = await app.until(SPAN_COLOR('TRUE'), (value) => value !== null, 'the true-color span')
      check(
        results,
        '[ui-appearance] ANSI colors come from the light palette in Light',
        yellow?.color === LIGHT_BRIGHT_YELLOW && contrast(yellow.color, yellow.background) >= 3,
        `bright yellow ${yellow?.color} on ${yellow?.background} (${yellow ? contrast(yellow.color, yellow.background).toFixed(2) : '-'}:1)`,
      )
      check(
        results,
        '[ui-appearance] output colored for a dark terminal stays readable in Light (≥ 4.5:1)',
        truecolor !== null && truecolor.background === LIGHT.terminal && contrast(truecolor.color, truecolor.background) >= 4.5,
        `#ffff80 drawn as ${truecolor?.color} on ${truecolor?.background} (${truecolor ? contrast(truecolor.color, truecolor.background).toFixed(2) : '-'}:1)`,
      )

      // Graph redraws while shown.
      await app.read(OPEN_OPENSPEC)
      await app.until(CLICK_GRAPH, Boolean, 'the Graph view entry')
      const lightGraph = await app.until(GRAPH_COLORS, (value) => value !== null, 'Graph nodes', 12_000)
      await chooseTheme(app, 'dark')
      const darkGraph = await app.until(GRAPH_COLORS, (value) => value !== null && value.text !== lightGraph?.text, 'Graph redrawn')
      check(
        results,
        '[ui-appearance] Graph shown while the theme changes is redrawn with the new palette',
        lightGraph !== null && darkGraph !== null && darkGraph.text !== lightGraph.text && darkGraph.circle !== lightGraph.circle,
        `light ${JSON.stringify(lightGraph)} → dark ${JSON.stringify(darkGraph)}`,
      )
    } finally {
      await app.close()
    }

    // Dark was chosen last; the virtual display's System is light, so a dark start is the stored preference.
    const stored = readPreferences(profile).ui?.theme
    const again = await launch(profile)
    try {
      await openSettings(again.client, 'general')
      const general = {
        language: await again.read(selectValue('settings.language')),
        theme: await again.read(selectValue('settings.theme')),
        zoom: await again.read(selectValue('settings.zoom')),
      }
      check(
        results,
        '[ui-appearance] Settings → General holds the language, the theme and the zoom',
        general.language === 'en' && general.theme !== null && general.zoom === '100',
        JSON.stringify(general),
      )
      const shown = await again.read(selectValue('settings.theme'))
      const dark = await again.read(DARK_SCHEME)
      check(
        results,
        '[ui-appearance] Dark survives a restart on a system whose appearance is light',
        stored === 'dark' && shown === 'dark' && dark === true && (await again.read(STAGE_BG)) === DARK.stage,
        `file=${stored} Settings=${shown} prefers-dark=${dark}`,
      )
      await closeSettings(again.client)
    } finally {
      await again.close()
    }
  }

  // ── Theme: an older file and an unknown value read as System; System follows a dark system at start ──
  for (const [name, ui] of [
    ['an older preferences file', { language: 'en' }],
    ['an unknown stored value', { language: 'en', theme: 'sepia' }],
  ]) {
    const profile = profileWith({ version: 1, terminal: { fontSize: 15 }, ui })
    const app = await launch(profile)
    try {
      await openSettings(app.client, 'general')
      const shown = await app.read(selectValue('settings.theme'))
      const dark = await app.read(DARK_SCHEME)
      const quarantined = readdirSync(profile).some((file) => file.includes('.corrupt-'))
      await openSettings(app.client, 'terminal')
      const fontSize = await app.read(`document.querySelector(${JSON.stringify(`[role="dialog"] input${label('settings.fontSize')}`)})?.value ?? null`)
      check(
        results,
        `[ui-appearance] ${name} reads as System; other preferences unchanged, nothing quarantined`,
        shown === 'system' && dark === false && !quarantined && fontSize === '15',
        `Settings=${shown} prefers-dark=${dark} (System on the virtual display is light) quarantined=${quarantined} fontSize=${fontSize}`,
      )
      await closeSettings(app.client)
    } finally {
      await app.close()
    }
  }
  {
    const profile = profileWith({ version: 1, terminal: {}, ui: { language: 'en' } })
    const app = await launch(profile, { GTK_THEME: 'Adwaita:dark' })
    try {
      const dark = await app.read(DARK_SCHEME)
      check(
        results,
        '[ui-appearance] System follows the operating system: a dark system at start gives the dark palette',
        dark === true && (await app.read(STAGE_BG)) === DARK.stage,
        `GTK_THEME=Adwaita:dark → prefers-dark=${dark}`,
      )
    } finally {
      await app.close()
    }
  }

  // ── Zoom: Settings sets it, the terminal measures again, the stored value wins over Chromium's memory ──
  {
    const profile = profileWith()
    let app = await launch(profile)
    try {
      await newShell(app)
      const colsBefore = await ptyCols(app, '100')
      await openSettings(app.client, 'general')
      await setSelect(app.client, 'settings.zoom', '150')
      const dpr = await app.until('devicePixelRatio', (value) => value === 1.5, 'devicePixelRatio 1.5')
      await closeSettings(app.client)
      await sleep(400)
      const colsAfter = await ptyCols(app, '150')
      check(
        results,
        '[ui-appearance] zooming makes everything larger and the pty is told its new size',
        dpr === 1.5 && colsBefore > 0 && colsAfter > 0 && colsAfter < colsBefore,
        `devicePixelRatio=${dpr}; pty cols ${colsBefore} → ${colsAfter}`,
      )
    } finally {
      await app.close()
    }

    // Chromium recorded 150% for this page; the file now says 125%.
    const chromium = (() => {
      try {
        return JSON.stringify(JSON.parse(readFileSync(join(profile, 'Preferences'), 'utf8')).partition?.per_host_zoom_levels ?? {})
      } catch {
        return ''
      }
    })()
    check(
      results,
      '[ui-appearance] precondition: Chromium remembers a zoom for the page (the restart check can disagree)',
      chromium.includes('index.html'),
      chromium.slice(0, 200),
    )
    const preferences = readPreferences(profile)
    writeFileSync(join(profile, 'preferences.json'), JSON.stringify({ ...preferences, ui: { ...preferences.ui, zoom: 125 } }))
    app = await launch(profile)
    try {
      const started = await app.read('devicePixelRatio')
      // The page's first script, after a reload: a probe script registered for new documents records the ratio
      // before any of the page's own code runs.
      await app.client.send('Page.enable')
      await app.client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__firstRatio = devicePixelRatio' })
      await app.client.send('Page.reload')
      await sleep(500)
      await awaitMounted(app.client, { expression: MOUNTED })
      const first = await app.read('window.__firstRatio ?? null')
      check(
        results,
        '[ui-appearance] the stored zoom decides at start, whatever Chromium remembers',
        started === 1.25,
        `stored 125%, Chromium remembered 150% → devicePixelRatio ${started}`,
      )
      check(
        results,
        "[ui-appearance] a reload keeps the stored zoom from the page's first script",
        first === 1.25 && (await app.read('devicePixelRatio')) === 1.25,
        `first script saw ${first}`,
      )
    } finally {
      await app.client.evaluate('window.workspace.settings.setZoom(null)').catch(() => undefined)
      await app.close()
    }
  }

  // ── Zoom: the largest step keeps every region at its minimum on a 1280-px window ──
  //
  // **Started at 175%**, not zoomed to it: the layout keeps its proportions on a resize, so zooming from 100% shrinks
  // the rail below its minimum and the clamp hides a stage minimum too small for its own two columns. At start the
  // rail takes its default 260 px, and only the stage's minimum can give the columns their room. Control: the old
  // 360-px stage minimum turns this red.
  {
    const profile = profileWith({ version: 1, terminal: {}, ui: { language: 'en', theme: 'dark', zoom: 175 } })
    const app = await launch(profile)
    try {
      await app.read(SELECT_FOLDER('repo-look'))
      await app.until('devicePixelRatio', (value) => value === 1.75, 'devicePixelRatio 1.75')
      const widths = await app.until(REGION_WIDTHS, (value) => value.sidePanel !== null, 'the regions', 4_000)
      const outer = await app.read('outerWidth')
      check(
        results,
        '[ui-appearance] at 175% on a 1280-px window every region keeps its minimum width (side panel expanded)',
        widths.activityBar >= 52 && widths.rail >= 180 && widths.terminal >= 240 && widths.sidePanel >= 240,
        `${JSON.stringify(widths)} (CSS px; window ${Math.round(outer)} device px)`,
      )
    } finally {
      await app.client.evaluate('window.workspace.settings.setZoom(null)').catch(() => undefined)
      await app.close()
    }
  }
}
