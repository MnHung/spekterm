/**
 * 驗證 file-explorer、file-viewer、workspace-layout 的身分切換，以及 workspace-app-shell
 * 重新確立的編輯器 requirement。
 *
 * 兩種模式各跑一次：`electron .`（正式建置）與 `electron-vite dev`（開發模式）。編輯器的
 * worker 在兩者的載入路徑不同（`file://` 對 `http://`），而 requirement 要求兩者皆成立。
 *
 * **worker 存活不以「看到語法高亮」判定** —— tokenization 在主執行緒完成，worker 沒載入
 * 也照樣有顏色。改為觀察一項只可能由 worker 算出的結果：Monaco 內建的 link provider
 * 呼叫 worker 的 `$computeLinks`，命中的 URL 會被畫上 `.detected-link` decoration。
 *
 * 用法：npm run probe:files
 * 結束碼 0 表示全部 scenario 通過。
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { check, connectToApp, pollFor, pollUntil } from './lib/cdp.mjs'
import { copy, copyIn } from './lib/copy.mjs'
import { awaitMounted, describeMounted } from './lib/mounted.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { quitAndWait } from './lib/quit.mjs'
import { PROBE_PORTS } from './lib/ports.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { showSection } from './lib/settings.mjs'

const BUILD_PORT = PROBE_PORTS.files.build
const DEV_PORT = PROBE_PORTS.files.dev
const MAX_FILE_BYTES = 2 * 1024 * 1024

const results = []
const temps = []

function mkTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

// ── fixture ─────────────────────────────────────────────────────────────────

const README = `# 標題

外部連結：[example](https://example.com/docs)

危險連結：[xss](javascript:alert(1))

遠端圖片（CSP 放行 https —— markdown 的正常內容，應能載入而不觸發 img-src 違規）：![img](https://example.com/img.png)

<script>window.__pwned = true</script>

| 欄 A | 欄 B |
|------|------|
| 1    | 2    |
`

function makeFixture() {
  const base = mkTemp('spekterm-files-fixture-')

  const repo = join(base, 'repo-openspec')
  mkdirSync(join(repo, 'openspec'), { recursive: true })
  mkdirSync(join(repo, 'sub', 'deep'), { recursive: true })

  writeFileSync(join(repo, 'README.md'), README)
  // 含 URL —— worker 的 link provider 會把它標成 .detected-link
  writeFileSync(join(repo, 'sample.ts'), '// 參考 https://example.com/spec\nexport const answer = 42\n')
  writeFileSync(join(repo, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  // 副檔名對不到任何語言 —— 應以純文字呈現，而非拒絕開啟
  writeFileSync(join(repo, 'notes.unknownext'), 'plain text\nsecond line\n')

  const binary = Buffer.alloc(4096, 0x61)
  binary[10] = 0
  writeFileSync(join(repo, 'binary.bin'), binary)

  writeFileSync(join(repo, 'sub', 'nested.txt'), 'nested\n')
  writeFileSync(join(repo, 'sub', 'deep', 'hidden.txt'), 'hidden\n')

  // 樹上兩個節點、磁碟上同一個目錄。少了它，watcher 的別名 bug 會躲過所有驗收。
  symlinkSync(join(repo, 'sub'), join(repo, 'link-to-sub'))

  // 指向 workspace 之外 —— 展開它必須失敗並說明原因
  const outside = join(base, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'do not read\n')
  symlinkSync(outside, join(repo, 'escape-link'))

  // **能分辨兩個 collator 的檔名。**
  //
  // 實測：`Intl.Collator('en')` 把漢字排在拉丁字母**之後**，`zh-TW` 排在**之前**。
  // **純 ASCII 的檔名在兩個 locale 下順序完全相同** —— 若 fixture 只種三個 ASCII 檔名，
  // 「排序隨語言改變」那條斷言會恆真，而它看起來跟通過一模一樣。
  writeFileSync(join(repo, 'zebra-sort.txt'), 'z\n')
  writeFileSync(join(repo, '中文排序.txt'), 'zh\n')
  writeFileSync(join(repo, 'apple-sort.txt'), 'a\n')

  const plain = join(base, 'repo-plain')
  mkdirSync(plain, { recursive: true })

  return { repo, plain, outside }
}

function seedProfile(folders) {
  const profile = mkTemp('spekterm-files-profile-')
  writeFileSync(
    join(profile, 'workspace.json'),
    JSON.stringify({
      version: 1,
      folders: folders.map(([id, path]) => ({ id, path, addedAt: '2026-07-10T00:00:00.000Z' })),
    }),
  )
  return profile
}

// ── app 啟動 ────────────────────────────────────────────────────────────────

// vite 的輸出帶顏色。以 fromCharCode 組出 ESC，避免在 regex 字面量裡放控制字元。
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (text) => text.replace(ANSI_PATTERN, '')

/**
 * 開發模式只起 renderer 的 dev server，electron 由探針自己 spawn。
 *
 * 不用 `electron-vite dev` 直接把 electron 拉起來：它產生的 electron 是**孫行程**，
 * 殺掉 `npx` 殺不到它（實測留下殭屍行程佔著 debugging port）；而它轉發 CLI 參數的管道
 * （`ELECTRON_CLI_ARGS`）在本機實測未生效 —— `--user-data-dir` 沒進到 electron 的 argv，
 * 探針因此會讀到開發者真實的 workspace 設定。
 *
 * 自己 spawn 則兩者皆可控，且驗的仍是真正的開發模式載入路徑：主行程看到
 * `ELECTRON_RENDERER_URL` 就會 `loadURL(http://…)`，worker 走 dev server 而非 `file://`。
 */
async function startRendererDevServer() {
  // `detached: true` 讓 npx 成為新的 process group leader —— `npx` 會 spawn `node`、
  // `node` 再 spawn vite，殺 npx（SIGTERM）殺不到底下的 vite（同 `.bin/electron` 的孫行程
  // 問題）。整組同一個 pgid 之後，收尾時 `process.kill(-pid)` 就能連根拔除。
  const child = spawn('npx', ['electron-vite', 'dev', '--rendererOnly'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: true,
  })

  const url = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('renderer dev server 未就緒')), 90_000)
    const onData = (chunk) => {
      output += stripAnsi(String(chunk))
      const match = output.match(/Local:\s+(http:\/\/[^\s/]+\/?)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1].replace(/\/$/, ''))
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })

  return { child, url }
}

async function launch({ port, profileDir, rendererUrl }) {
  // 被測 app 的語言是**被指定的**：全新的 profile 會觸發首次啟動的語言偵測，
  // 而在一台非英文的機器上，那會讓每一條 `aria-label` 選擇器選不到元素。
  // 既有的 `preferences.json` 不動（損毀韌性與舊檔那兩段自己佈置它）。
  seedLanguage(profileDir)

  const child = spawn(
    'electron',
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, ...electronExtraArgs(), '.'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: rendererUrl ? { ...process.env, ELECTRON_RENDERER_URL: rendererUrl } : process.env,
    },
  )

  let stderr = ''
  child.stderr?.on('data', (chunk) => (stderr += chunk))
  child.stdout?.on('data', (chunk) => (stderr += chunk))

  const client = await connectToApp(port, { targetTimeoutMs: 30_000 })
  const mounted = await awaitMounted(client)

  return {
    client,
    mounted,
    stderr: () => stderr,
    /** Wait for the app to exit by itself (no signal sent). `true` when it did in time. */
    async waitForExit(timeoutMs = 10_000) {
      if (child.exitCode !== null || child.signalCode !== null) return true
      const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
      // An event wait, not a poll — the same reasoning as `quitAndWait`.
      return Promise.race([exited, sleep(timeoutMs, false)])
    },
    async close() {
      client.close()
      await quitAndWait(child)
      // `node_modules/.bin/electron` 是個 node wrapper，它自己再 spawn 真正的 electron
      // 二進位。殺掉 wrapper 不會帶走那個真 electron —— 它會變孤兒，繼續佔著 debugging
      // port（尤其面板留有未存變更時，關閉會觸發原生對話框 design D15，擋住 SIGTERM）。
      // 以獨一無二的 profile 路徑把整棵行程樹（wrapper + 真 electron + renderer + gpu）
      // 連根拔除 —— 每個子行程的 argv 都帶著 `--user-data-dir=<profileDir>`。
      try {
        execFileSync('pkill', ['-9', '-f', profileDir], { stdio: 'ignore' })
      } catch {
        // pkill 找不到符合的行程時回非零碼，那正是我們要的結果（已經沒了）。
      }
      await sleep(200)
    },
  }
}

// ── renderer 內的量測 ───────────────────────────────────────────────────────

const SELECT_FOLDER = (name) => `(() => {
  const row = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] div[role="button"]')]
    .find((el) => el.innerText.includes(${JSON.stringify(name)}))
  if (!row) return false
  row.click()
  return true
})()`

// 身分切換的 tablist 必須指名 —— 側欄的 OpenSpec 身分自己也有一個 tablist（四個視圖），
// 全域的 [role="tablist"] 會把兩者混在一起（session 分頁列是第三個）。
const SWITCH = `[role="tablist"][aria-label="${copy('panelSwitch.label')}"]`

const TABS = `[...document.querySelectorAll('${SWITCH} button[role="tab"]')].map((tab) => ({
  label: tab.innerText.trim(),
  selected: tab.getAttribute('aria-selected') === 'true',
  disabled: tab.disabled,
  title: tab.getAttribute('title') ?? '',
}))`

const CLICK_TAB = (label) => `(() => {
  const tab = [...document.querySelectorAll('${SWITCH} button[role="tab"]')]
    .find((el) => el.innerText.trim().startsWith(${JSON.stringify(label)}))
  if (!tab) return false
  tab.click()
  return true
})()`

const IDENTITY = `(() => {
  if (document.querySelector('section[aria-label="${copy('files.label')}"]')) return 'files'
  if (document.querySelector('section[aria-label="${copy('openspec.label')}"]')) return 'openspec'
  return null
})()`

const ROWS = `[...document.querySelectorAll('[role="treeitem"]')].map((row) => ({
  path: row.getAttribute('title'),
  level: Number(row.getAttribute('aria-level')),
  expanded: row.getAttribute('aria-expanded'),
  text: row.innerText.replace(/\\n/g, ' ').trim(),
}))`

const ROW_PATHS = `[...document.querySelectorAll('[role="treeitem"]')].map((r) => r.getAttribute('title'))`

const CLICK_ROW = (relPath) => `(() => {
  const row = document.querySelector('[role="treeitem"][title=${JSON.stringify(relPath)}]')
  if (!row) return false
  row.click()
  return true
})()`

// 項目數的文案是複數形式（`1 item` / `N items`）—— 以字典的複數版組出 regex，
// `(\\d+)` 正好落在 `{{count}}` 的位置成為擷取群組。
const ITEM_COUNT = `(() => {
  const header = document.querySelector('section[aria-label="${copy('files.label')}"] header')
  const match = header?.innerText.match(/${copy('files.itemCount_other', { count: '(\\d+)' })}/)
  return match ? Number(match[1]) : -1
})()`

/**
 * 失敗的列其 title 會變成錯誤訊息，因此以名稱定位而非 title。
 * 名稱在第二個 span —— 第一個是展開／收合的字符，直接比對 innerText 會被它擋掉。
 * 目錄的名稱帶結尾斜線，比對前去掉。
 */
const ROW_NAME_MATCH = (name) =>
  `(el) => (el.children[1]?.textContent ?? '').replace(/\\/$/, '') === ${JSON.stringify(name)}`

const ROW_BY_NAME = (name) => `(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find(${ROW_NAME_MATCH(name)})
  return row ? { text: row.innerText.replace(/\\n/g, ' ').trim(), expanded: row.getAttribute('aria-expanded') } : null
})()`

const CLICK_ROW_BY_NAME = (name) => `(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find(${ROW_NAME_MATCH(name)})
  if (!row) return false
  row.click()
  return true
})()`

/**
 * 點一下、等 React 把離散事件的更新 flush 完（那發生在 microtask），再讀列。
 *
 * 這是「內容來自快取」與「等 listDir 回來才呈現」的乾淨判別式：React 的更新在 microtask
 * 佇列中完成，而 IPC 的回應必須經過 macrotask —— 幾個 microtask 之後就看得到子項，
 * 就表示它不可能是這一次 IPC 的結果。
 */
const CLICK_ROW_THEN_READ = (relPath) => `(async () => {
  const row = document.querySelector('[role="treeitem"][title=${JSON.stringify(relPath)}]')
  if (!row) return null
  row.click()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  return [...document.querySelectorAll('[role="treeitem"]')].map((r) => r.getAttribute('title'))
})()`

/** 展開後、在 listDir 回來之前收合：載入的結果不該讓內容突然出現。 */
const EXPAND_THEN_COLLAPSE = (relPath) => `(async () => {
  const find = () => document.querySelector('[role="treeitem"][title=${JSON.stringify(relPath)}]')
  const first = find()
  if (!first) return false
  first.click()
  // 等 React 掛上「已展開」的新處理常式，但不等 IPC ——後者要 macrotask
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  const second = find()
  if (!second) return false
  second.click()
  return true
})()`

// Monaco 以 &nbsp; 渲染空白，直接比對字串會被 U+00A0 騙過去
const EDITOR_TEXT = `document.querySelector('.monaco-editor .view-lines')?.innerText.replace(/\\u00a0/g, ' ') ?? null`

/** 隱形輸入區的 readonly 屬性。editContext 關閉後（見 editor wrapper），它會正確反映唯讀狀態。 */
const INPUT_AREA_READONLY = `(() => {
  const ta = document.querySelector('.monaco-editor textarea')
  return ta ? ta.readOnly : null
})()`

/** side panel 內文，用來偵測衝突／過期橫幅之類的文字提示。 */
const SIDE_PANEL_TEXT = `document.querySelector('section[aria-label="${copy('openspec.sidePanel')}"]')?.innerText ?? ''`

/**
 * build-identity：開發模式的建置身分。
 *
 * **這一條只能掛在這支探針上。** `probe:workspace` 只有一種啟動路徑（`electron .` 載入 build
 * 產物），依 `electron.vite.config.ts` 它拿到的一律是**完整建置身分** —— 把「應標示為開發模式」
 * 掛在那裡必為假綠。這支自己起 `electron-vite dev --rendererOnly`，renderer 來自 dev server，
 * `command === 'serve'`，是唯一拿得到開發身分的地方（design D8）。
 */
const SETTINGS_EL = `document.querySelector('nav[aria-label="${copy('activityBar.label')}"] button[aria-label="${copy('activityBar.settings')}"]')`

const BUILD_IDENTITY = `(() => {
  const s = document.querySelector('[role="group"][aria-label="${copy('settings.about')}"]')
  if (!s) return null
  const text = s.textContent ?? ''
  return {
    text,
    development: text.includes('${copy('settings.aboutDevelopment')}'),
    // 開發模式**不得**呈現建置時刻 —— 放進行程啟動時刻就是冒充成打包產物。
    hasBuiltAt: text.includes('${copy('settings.aboutBuilt')}'),
  }
})()`

/** 某一列樹節點是否帶著未存變更的標記。 */
const ROW_IS_DIRTY = (relPath) => `(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find((r) => r.getAttribute('title') === ${JSON.stringify(relPath)})
  return row ? Boolean(row.querySelector('[aria-label="${copy('files.unsaved')}"]')) : null
})()`

/** 點面板 header 的「‹ 返回」，自檔案檢視換頁回檔案樹。 */
const BACK_TO_TREE = `(() => {
  const btn = [...document.querySelectorAll('section[aria-label="${copy('files.label')}"] header button')].find((b) => b.textContent.includes('${copy('common.back')}'))
  if (!btn) return false
  btn.click()
  return true
})()`

/** 點某個選單項（依文字）。選單已開啟且定位正確時，用選擇器點可見的項目即可。 */
const CLICK_MENU_ITEM = (label) => `(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === ${JSON.stringify(label)})
  if (!item) return false
  item.click()
  return true
})()`

/** quick open 的狀態。`null` ＝ 未開啟。 */
const QUICK_OPEN = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="${copy('quickOpen.label')}"]')
  if (!dialog) return null
  const input = dialog.querySelector('input')
  const options = [...dialog.querySelectorAll('[role="option"]')]
  return {
    query: input ? input.value : null,
    count: options.length,
    titles: options.map((o) => o.getAttribute('title')),
    message: dialog.querySelector('p') ? dialog.querySelector('p').innerText.trim() : null,
  }
})()`

/** 聚焦檔案樹的第一列（側欄之內一個真實可聚焦的元素）。 */
const FOCUS_FILE_TREE = `(() => {
  const row = document.querySelector('section[aria-label="${copy('files.label')}"] [role="treeitem"]')
  if (!row) return false
  row.focus()
  return document.activeElement === row
})()`

/** 命名／確認對話框是否開啟。 */
const NAME_DIALOG_PRESENT = `Boolean(document.querySelector('section[aria-label="${copy('files.label')}"] input'))`

async function pressCtrlP(client) {
  const key = { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80, modifiers: 2 }
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  await sleep(300)
}

async function pressEsc(client) {
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  await sleep(300)
}

/** 對話框輸入名稱並確定。 */
const SUBMIT_NAME_DIALOG = (name) => `(() => {
  const input = document.querySelector('[role="dialog"] input, section[aria-label="${copy('files.label')}"] input')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(name)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`

/** 點確認刪除對話框裡的確認鈕。 */
const CONFIRM_DELETE = `(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '${copy('common.delete')}' && b.closest('.absolute'))
  if (!btn) return false
  btn.click()
  return true
})()`

/** 點 markdown 檢視的 [預覽│原始碼] 切換鈕（帶 aria-pressed 的才是模式鈕）。 */
const CLICK_MODE = (label) => `(() => {
  const btn = [...document.querySelectorAll('section[aria-label="${copy('files.label')}"] button[aria-pressed]')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)})
  if (!btn) return false
  btn.click()
  return true
})()`

/** 某個模式鈕當前是否為選定（aria-pressed）。 */
const MODE_PRESSED = (label) => `(() => {
  const btn = [...document.querySelectorAll('section[aria-label="${copy('files.label')}"] button[aria-pressed]')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)})
  return btn ? btn.getAttribute('aria-pressed') === 'true' : null
})()`

/** markdown 預覽區（渲染後）的純文字。 */
const PREVIEW_TEXT = `document.querySelector('.markdown')?.innerText ?? null`

const FOCUS_EDITOR = `(() => {
  const textarea = document.querySelector('.monaco-editor textarea')
  if (!textarea) return false
  textarea.focus()
  return document.activeElement === textarea
})()`

const RELOAD = `(() => { location.reload(); return true })()`

/** 輪詢磁碟上的一個條件（存檔、CRUD 都以磁碟為最終真相，而非 UI 時序）。 */
async function pollDisk(predicate, { timeoutMs = 4000, label = 'pollDisk（磁碟上的條件）' } = {}) {
  const settledValue = await pollFor({
    read: () => predicate(),
    settled: (value) => value === true,
    timeoutMs,
    interval: 100,
    label,
  })
  return settledValue === true
}

/**
 * 送**真的**滑鼠按鍵（trusted event），而非 `element.dispatchEvent(new MouseEvent(...))`。
 *
 * 兩者不等價：合成 contextmenu 不會走完整的 pointer/mouse/contextmenu 序列，也不觸發
 * React 19 對 trusted discrete 事件的同步 effect flush —— 用合成事件測選單，會漏掉
 * 「開啟選單的事件冒泡到 window 把自己關掉」這類只在真實輸入下發生的 bug。
 */
async function realMouse(client, x, y, button) {
  const buttons = button === 'right' ? 2 : button === 'left' ? 1 : 0
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons, clickCount: 1 })
}

/** 取某元素的 viewport 座標（供 realMouse）。回傳 `null` 代表元素不存在。 */
async function coordsOf(client, expression) {
  return client.evaluate(`(() => {
    const el = ${expression}
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
  })()`)
}

const ROW_EL = (relPath) =>
  `[...document.querySelectorAll('[role="treeitem"]')].find((r) => r.getAttribute('title') === ${JSON.stringify(relPath)})`
const PLUS_BTN = `document.querySelector('section[aria-label="${copy('files.label')}"] header button[aria-label="${copy('files.newAtRoot')}"]')`

/** 選單是否存在且完整落在 viewport 內。'missing' / 'in' / 'out'。 */
const MENU_PLACEMENT = `(() => {
  const m = document.querySelector('[role="menu"]')
  if (!m) return 'missing'
  const r = m.getBoundingClientRect()
  return (r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight) ? 'in' : 'out'
})()`

/** 送 Ctrl+S。editContext 關閉後，按鍵經隱形 textarea 交給 Monaco 的存檔命令。 */
async function sendCtrlS(client) {
  const ctrl = { modifiers: 2 } // Ctrl
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...ctrl,
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 83,
  })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrl, key: 's', code: 'KeyS' })
}

const PANEL_TEXT = `document.querySelector('section[aria-label="${copy('openspec.sidePanel')}"]')?.innerText ?? ''`

const SIDE_PANEL_WIDTH = `document.querySelector('section[aria-label="${copy('openspec.sidePanel')}"]')?.getBoundingClientRect().width ?? -1`

const CLICK_COLLAPSE = `(() => {
  const button = document.querySelector('main[aria-label="${copy('stage.label')}"] header button[aria-expanded]')
  if (!button) return false
  button.click()
  return true
})()`

/** 只可能由 worker 算出：Monaco 的 link provider 呼叫 worker 端的 $computeLinks。 */
const DETECTED_LINKS = `document.querySelectorAll('.detected-link').length`

/** tokenization 在主執行緒完成，因此這只證明「有高亮」，不證明 worker 存活。 */
const TOKEN_CLASSES = `(() => {
  const spans = [...document.querySelectorAll('.view-line span[class^="mtk"]')]
  return new Set(spans.map((s) => s.className)).size
})()`

const MARKDOWN = `(() => {
  const root = document.querySelector('.markdown')
  if (!root) return null
  return {
    headings: root.querySelectorAll('h1').length,
    tables: root.querySelectorAll('table').length,
    scriptElements: root.querySelectorAll('script').length,
    pwned: Boolean(window.__pwned),
    text: root.innerText,
    anchors: [...root.querySelectorAll('a')].map((a) => a.getAttribute('href')),
  }
})()`

/**
 * CSP violation 收集器 —— 必須在會觸發違規的請求**之前**注入（它只捕捉其後派送的違規）。違規
 * 事件的 `originalPolicy` 即**實際施加到這個 renderer 的**完整政策字串 —— 據此端到端驗證政策，
 * 而非只驗政策生成函式。
 */
const CSP_ARM = `(() => {
  window.__csp = []
  window.__cspPolicy = ''
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push(e.violatedDirective)
    window.__cspPolicy = e.originalPolicy || window.__cspPolicy
  })
  return true
})()`

const CSP_VIOLATIONS = `window.__csp ?? []`
const CSP_POLICY = `window.__cspPolicy ?? ''`

/**
 * 觸發一個**一定被擋**的請求以捕捉 `originalPolicy` —— fetch 一個遠端主機，`connect-src 'self'`
 * （dev 為 `'self' ws:`）擋下它並派送 connect-src 違規。圖片現在放行（`img-src https:`），不再是
 * 政策的觸發源，故改由這個一定被擋的 fetch 擷取實際政策。
 */
const TRIGGER_CSP = `fetch('https://example.com/csp-probe').catch(() => {})`

/** 動態插入一張遠端 https 圖片，回報是否引發 `img-src` 違規（現在應為 false —— 圖片放行）。 */
const TRY_REMOTE_IMAGE = `(async () => {
  const img = document.createElement('img')
  img.src = 'https://example.com/remote-probe.png'
  document.body.appendChild(img)
  await new Promise((r) => setTimeout(r, 400))
  img.remove()
  return (window.__csp ?? []).includes('img-src')
})()`

/** 直接試著導航。will-navigate 應阻止它，location 不變。 */
const TRY_NAVIGATE = `(async () => {
  const before = location.href
  location.href = 'https://example.com/'
  await new Promise((r) => setTimeout(r, 400))
  return { before, after: location.href }
})()`

const TRY_WINDOW_OPEN = `(() => {
  const opened = window.open('https://example.com/')
  if (opened) opened.close?.()
  return opened === null
})()`

const OPEN_EXTERNAL = (url) => `(async () => {
  try {
    await window.workspace.shell.openExternal(${JSON.stringify(url)})
    return { rejected: false }
  } catch (error) {
    return { rejected: true, message: String(error) }
  }
})()`

const READ_FILE = (folderId, relPath) => `window.workspace.fs.readFile(${JSON.stringify(folderId)}, ${JSON.stringify(relPath)})`

// ── 建置模式的完整驗收 ──────────────────────────────────────────────────────

async function probeBuild(fixture, profile) {
  const app = await launch({ port: BUILD_PORT, profileDir: profile })
  try {
    if (!check(results, '應用程式啟動（建置模式）', app.mounted?.ok === true,
      app.mounted?.ok ? '' : `${describeMounted(app.mounted)} ${app.stderr().slice(0, 300)}`)) {
      throw new Error('未掛載，後續斷言無意義')
    }

    // ── file-explorer：尚未選擇 folder ──────────────────────────────────────
    console.log('\n尚未選擇 folder')
    const emptyText = await pollUntil(app.client, PANEL_TEXT, (text) => text.length > 0)
    check(results, '未選中任何 folder 時呈現說明此狀態的提示', (emptyText ?? '').includes(copy('stage.noRepo')),
      emptyText.split('\n').filter(Boolean)[0])

    // ── workspace-layout：身分切換 ──────────────────────────────────────────
    console.log('\nside panel 的兩個同層互斥身分')
    // 必須輪詢 —— folder 列來自一次非同步的 `folders.list()`，晚於 rail 本身的掛載。
    const picked = await pollUntil(app.client, SELECT_FOLDER('repo-openspec'), (ok) => ok === true, 8000)
    check(results, '選中含 openspec 的 folder', picked === true)

    const tabs = await app.client.evaluate(TABS)
    check(results, '身分切換入口呈現兩個分頁', tabs.length === 2, tabs.map((t) => t.label).join(', '))
    // 預設身分自 `openspec-side-panel` 起是 OpenSpec（雛型的預設）。Phase 2 暫以 Files 為預設，
    // 理由是 OpenSpec 身分還沒有內容 —— 該理由已不復存在。
    check(results, '預設身分為 OpenSpec', (await app.client.evaluate(IDENTITY)) === 'openspec')
    check(results, '當前身分於入口上可辨識', tabs.find((t) => t.label.includes('OpenSpec'))?.selected === true)
    check(results, '含 openspec 時 OpenSpec 入口可用', tabs.find((t) => t.label.includes('OpenSpec'))?.disabled === false)

    check(results, '可切換至 Files 身分', (await app.client.evaluate(CLICK_TAB('▤'))) === true)
    check(results, '一次只顯示一個身分', (await app.client.evaluate(IDENTITY)) === 'files')
    await app.client.evaluate(CLICK_TAB('◈'))
    check(results, '可切回 OpenSpec 身分', (await app.client.evaluate(IDENTITY)) === 'openspec')

    check(results, '收合 side panel', (await app.client.evaluate(CLICK_COLLAPSE)) === true)
    await pollUntil(app.client, SIDE_PANEL_WIDTH, (width) => width === 0)
    await app.client.evaluate(CLICK_TAB('▤'))
    const reexpanded = await pollUntil(app.client, SIDE_PANEL_WIDTH, (width) => width > 0)
    check(results, '收合狀態下觸發任一身分皆重新展開', reexpanded > 0, `${Math.round(reexpanded)}px`)

    // ── workspace-layout：OpenSpec 為條件式身分 ─────────────────────────────
    await app.client.evaluate(SELECT_FOLDER('repo-plain'))
    const plainTabs = await pollUntil(app.client, TABS, (list) => list.find((t) => t.label.includes('OpenSpec'))?.disabled === true)
    const openSpecTab = plainTabs.find((t) => t.label.includes('OpenSpec'))
    check(results, '不含 openspec 時 OpenSpec 入口停用', openSpecTab?.disabled === true)
    check(results, '停用的入口附說明', (openSpecTab?.title ?? '').includes(copy('panelSwitch.openSpecDisabled')), openSpecTab?.title)
    await app.client.evaluate(CLICK_TAB('◈'))
    check(results, '停用的身分不可被切換至', (await app.client.evaluate(IDENTITY)) === 'files')
    check(results, 'Files 身分恆可用', plainTabs.find((t) => t.label.includes('Files'))?.disabled === false)

    // ── file-explorer：樹與 lazy load ───────────────────────────────────────
    console.log('\n檔案樹：lazy load、排序、項目數')
    await app.client.evaluate(SELECT_FOLDER('repo-openspec'))
    const rootRows = await pollUntil(app.client, ROWS, (rows) => rows.length >= 6)

    check(results, '呈現根目錄的直接子項目',
      rootRows.some((r) => r.path === 'README.md') && rootRows.some((r) => r.path === 'sub'),
      JSON.stringify(rootRows.map((r) => r.path)))

    // **相對時間的 locale 必須跟著 UI 的語言走**（`ui-localization`）。這條非驗不可：
    // `Intl.RelativeTimeFormat` 的 locale 若脫鉤，畫面上就會在一片英文裡混出「3 分鐘前」，
    // 而**其餘每一條斷言都照樣是綠的** —— 樹畫得出來、路徑對得上，只有那一欄是別的語言。
    const mtimeText = rootRows.find((r) => r.path === 'README.md')?.text ?? ''
    check(
      results,
      '檔案樹的相對時間以 UI 的語言呈現',
      /\b(just now|\d+ (seconds?|minutes?|hours?|days?|months?|years?) ago)\b/.test(mtimeText),
      mtimeText,
    )
    check(results, '未展開的目錄不載入其子項目', !rootRows.some((r) => r.path === 'sub/nested.txt'),
      rootRows.map((r) => r.path).join(' '))

    const kinds = rootRows.map((r) => (r.expanded === null ? 'file' : 'dir'))
    const firstFile = kinds.indexOf('file')
    check(results, '目錄排在檔案之前', firstFile === -1 || !kinds.slice(firstFile).includes('dir'),
      rootRows.map((r) => r.path).join(' '))

    const countBefore = await app.client.evaluate(ITEM_COUNT)
    check(results, '面板呈現可見項目數', countBefore === rootRows.length, `${countBefore} vs ${rootRows.length} 列`)

    check(results, '展開子目錄', (await app.client.evaluate(CLICK_ROW('sub'))) === true)
    const expandedRows = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('sub/nested.txt'))
    check(results, '展開時才載入該目錄內容', expandedRows.includes('sub/nested.txt'))
    check(results, '孫目錄仍未載入', !expandedRows.includes('sub/deep/hidden.txt'))

    const countAfter = await app.client.evaluate(ITEM_COUNT)
    check(results, '展開後項目數增加', countAfter > countBefore, `${countBefore} → ${countAfter}`)


    // ── file-explorer：外部變更 ─────────────────────────────────────────────
    console.log('\n外部變更（監看集合 = 展開集合）')
    writeFileSync(join(fixture.repo, 'created.txt'), 'x')
    const withCreated = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('created.txt'))
    check(results, '外部新增的檔案出現在樹上', withCreated.includes('created.txt'))

    unlinkSync(join(fixture.repo, 'created.txt'))
    const withoutCreated = await pollUntil(app.client, ROW_PATHS, (paths) => !paths.includes('created.txt'))
    check(results, '外部刪除的檔案自樹上消失', !withoutCreated.includes('created.txt'))

    writeFileSync(join(fixture.repo, 'sub', 'deep', 'unseen.txt'), 'x')
    await sleep(700)
    const stillUnseen = await app.client.evaluate(ROW_PATHS)
    check(results, '未展開的目錄之變更不觸發更新', !stillUnseen.some((p) => p?.includes('unseen.txt')))

    await app.client.evaluate(CLICK_ROW('sub'))
    await pollUntil(app.client, ROW_PATHS, (paths) => !paths.includes('sub/nested.txt'))
    writeFileSync(join(fixture.repo, 'sub', 'after-collapse.txt'), 'x')
    await sleep(700)
    const afterCollapse = await app.client.evaluate(ROW_PATHS)
    check(results, '收合後停止監看該目錄', !afterCollapse.some((p) => p?.includes('after-collapse.txt')),
      afterCollapse.filter(Boolean).join(' '))
    unlinkSync(join(fixture.repo, 'sub', 'after-collapse.txt'))

    // ── file-explorer：快取、背景校正、載入中收合 ───────────────────────────
    console.log('\n快取與競態')
    // 進入本段時 sub 已收合，且其內容曾被載入過 —— 仍在快取中
    const immediate = await app.client.evaluate(CLICK_ROW_THEN_READ('sub'))
    check(results, '再次展開立即以快取呈現，不等待載入', immediate?.includes('sub/nested.txt') === true,
      immediate ? `microtask 後讀到 ${immediate.filter((p) => p?.startsWith('sub/')).join(' ')}` : '(找不到列)')

    // 收合期間的變更：該目錄未被監看，chokidar 的 ignoreInitial 也不會補報
    await app.client.evaluate(CLICK_ROW('sub'))
    await pollUntil(app.client, ROW_PATHS, (paths) => !paths.includes('sub/nested.txt'))
    writeFileSync(join(fixture.repo, 'sub', 'while-collapsed.txt'), 'x')
    await sleep(400)
    await app.client.evaluate(CLICK_ROW('sub'))
    const corrected = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('sub/while-collapsed.txt'))
    check(results, '收合期間發生的變更於再次展開後被校正', corrected.includes('sub/while-collapsed.txt'))
    unlinkSync(join(fixture.repo, 'sub', 'while-collapsed.txt'))

    // 展開後、在 listDir 回來之前收合。以從未載入過的 sub/deep 驅動。
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('sub/deep'))
    check(results, '展開後立刻收合 sub/deep', (await app.client.evaluate(EXPAND_THEN_COLLAPSE('sub/deep'))) === true)
    await sleep(600)
    const raced = await app.client.evaluate(ROW_PATHS)
    check(results, '載入完成前收合，內容不會突然出現', !raced.includes('sub/deep/hidden.txt'),
      raced.filter((p) => p?.startsWith('sub/deep')).join(' ') || '(無子項顯現)')

    // ── file-explorer：folder 內的 symlink 目錄 ─────────────────────────────
    console.log('\nsymlink 目錄（樹上兩個節點、磁碟同一個目錄）')
    await app.client.evaluate(CLICK_ROW('sub')) // 收合，讓 link-to-sub 單獨受測
    await pollUntil(app.client, ROW_PATHS, (paths) => !paths.includes('sub/nested.txt'))

    check(results, '展開 folder 內指向其他目錄的 symlink', (await app.client.evaluate(CLICK_ROW('link-to-sub'))) === true)
    const viaLink = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('link-to-sub/nested.txt'))
    check(results, 'symlink 節點之下呈現目標目錄的內容', viaLink.includes('link-to-sub/nested.txt'))

    writeFileSync(join(fixture.repo, 'sub', 'via-link.txt'), 'x')
    const linkUpdated = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('link-to-sub/via-link.txt'))
    check(results, '事件以訂閱者的路徑表達（symlink 節點會更新）', linkUpdated.includes('link-to-sub/via-link.txt'),
      linkUpdated.includes('sub/via-link.txt') ? '竟以真實路徑回報' : '')

    // 兩個節點同時訂閱同一個目錄，收合其一不得停掉另一個的監看
    await app.client.evaluate(CLICK_ROW('sub'))
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('sub/nested.txt'))
    await app.client.evaluate(CLICK_ROW('link-to-sub'))
    await pollUntil(app.client, ROW_PATHS, (paths) => !paths.includes('link-to-sub/nested.txt'))

    writeFileSync(join(fixture.repo, 'sub', 'alias-check.txt'), 'x')
    const aliasSafe = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('sub/alias-check.txt'))
    check(results, '收合 symlink 別名不會停掉真實目錄的監看', aliasSafe.includes('sub/alias-check.txt'))

    unlinkSync(join(fixture.repo, 'sub', 'via-link.txt'))
    unlinkSync(join(fixture.repo, 'sub', 'alias-check.txt'))
    await app.client.evaluate(CLICK_ROW('sub'))
    await pollUntil(app.client, ROW_PATHS, (paths) => !paths.includes('sub/nested.txt'))

    // 指向 workspace 之外的 symlink：不得展開，且要說明原因
    check(results, '點擊越界的 symlink 目錄', (await app.client.evaluate(CLICK_ROW_BY_NAME('escape-link'))) === true)
    const escapeRow = await pollUntil(app.client, ROW_BY_NAME('escape-link'), (row) => (row?.text ?? '').includes(copy('files.failure.expandEscapesRoot')))
    check(results, '展開越界 symlink 失敗並說明超出 workspace 邊界', (escapeRow?.text ?? '').includes(copy('files.failure.expandEscapesRoot')),
      escapeRow?.text)
    const noSecret = await app.client.evaluate(ROW_PATHS)
    check(results, '越界 symlink 之下不呈現任何項目', !noSecret.some((p) => p?.includes('secret.txt')))

    // ── filesystem-access：renderer 重新載入後監看集合重建 ──────────────────
    console.log('\nrenderer 重新載入')
    await app.client.evaluate(RELOAD)
    await sleep(500)
    const remounted = await awaitMounted(app.client)
    check(results, '重新載入後 renderer 重新掛載', remounted?.ok === true, describeMounted(remounted))

    await app.client.evaluate(SELECT_FOLDER('repo-openspec'))
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('README.md'))
    writeFileSync(join(fixture.repo, 'after-reload.txt'), 'x')
    const afterReload = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('after-reload.txt'))
    check(results, '重新載入後監看集合重建，樹仍隨磁碟更新', afterReload.includes('after-reload.txt'))
    unlinkSync(join(fixture.repo, 'after-reload.txt'))

    // ── file-viewer：拒絕條件 ───────────────────────────────────────────────
    console.log('\n檔案檢視：拒絕條件')
    const tooLarge = await app.client.evaluate(READ_FILE('f-openspec', 'big.txt'))
    check(results, 'readFile 拒絕過大的檔案並回報大小與上限',
      tooLarge.ok === false && tooLarge.code === 'TOO_LARGE' && tooLarge.detail?.limit === MAX_FILE_BYTES,
      `${tooLarge.code} size=${tooLarge.detail?.size} limit=${tooLarge.detail?.limit}`)

    const binary = await app.client.evaluate(READ_FILE('f-openspec', 'binary.bin'))
    check(results, 'readFile 拒絕二進位檔案', binary.ok === false && binary.code === 'BINARY', binary.code)

    const escaped = await app.client.evaluate(READ_FILE('f-openspec', '../repo-plain'))
    check(results, 'readFile 拒絕逃逸出邊界的路徑', escaped.ok === false, escaped.code)

    await app.client.evaluate(CLICK_ROW('big.txt'))
    const bigText = await pollUntil(app.client, PANEL_TEXT, (text) => (text ?? '').includes(copy('viewer.tooLarge')))
    check(results, 'UI 呈現「檔案過大」與上限', bigText.includes(copy('viewer.tooLarge')) && /2\.0 MB/.test(bigText),
      bigText.split('\n').filter(Boolean).slice(-2).join(' · '))
    check(results, '過大的檔案不呈現任何內容片段', !/aaaa/.test(bigText))

    await app.client.evaluate(`document.querySelector('section[aria-label="${copy('files.label')}"] header button')?.click()`)
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('binary.bin'))
    await app.client.evaluate(CLICK_ROW('binary.bin'))
    const binaryText = await pollUntil(app.client, PANEL_TEXT, (text) => (text ?? '').includes(copy('viewer.binary')))
    check(results, 'UI 呈現「二進位檔案」', binaryText.includes(copy('viewer.binary')))

    // ── file-viewer：未知副檔名 ─────────────────────────────────────────────
    console.log('\n檔案檢視：未知副檔名')
    await app.client.evaluate(`document.querySelector('section[aria-label="${copy('files.label')}"] header button')?.click()`)
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('notes.unknownext'))
    await app.client.evaluate(CLICK_ROW('notes.unknownext'))

    const plainText = await pollUntil(app.client, EDITOR_TEXT, (text) => Boolean(text))
    check(results, '未知副檔名的文字檔以純文字呈現於編輯器中', /plain text/.test(plainText ?? ''),
      (plainText ?? '(未掛載編輯器)').split('\n')[0])
    const plainTokens = await app.client.evaluate(TOKEN_CLASSES)
    check(results, '純文字只有單一 token 樣式（未套用任何語言）', plainTokens === 1, `${plainTokens} 種`)

    // ── file-editing：編輯 → dirty → 存檔 ───────────────────────────────────
    // 過去這一段斷言「輸入區唯讀」，但 Monaco 的 native EditContext 讓那個 textarea
    // 恆為 readonly —— 對可編輯的編輯器一樣會通過，是假驗收。改以「真的打字、真的存檔、
    // 回讀磁碟」驗證，這是只有可編輯的編輯器才過得了的觀測。
    console.log('\n檔案編輯：dirty 狀態與存檔')
    check(results, '編輯器的輸入區可編輯（非唯讀）',
      (await app.client.evaluate(INPUT_AREA_READONLY)) === false)

    await app.client.evaluate(FOCUS_EDITOR)
    const beforeEdit = await app.client.evaluate(EDITOR_TEXT)
    await app.client.send('Input.insertText', { text: 'EDIT ' })
    const afterEdit = await pollUntil(app.client, EDITOR_TEXT, (text) => /EDIT /.test(text ?? ''))
    check(results, '於編輯器輸入時內容隨之改變',
      beforeEdit !== afterEdit && /EDIT /.test(afterEdit ?? ''),
      `內容有變=${beforeEdit !== afterEdit}；含 EDIT=${/EDIT /.test(afterEdit ?? '')}`)

    // ── maximize-panel-and-confirm-close: maximizing does not remount the side panel ──
    // The unsaved edit, the open file and the undo history survive maximize + restore. Undo is the
    // discriminating part: a remounted editor would show the same buffer (dirty buffers outlive
    // it) but with an empty undo stack.
    const MAXIMIZE_ENTRY = `document.querySelector('[aria-label="${copy('stage.maximizeSidePanel')}"], [aria-label="${copy('stage.restoreSidePanel')}"]')`
    await app.client.evaluate(`${MAXIMIZE_ENTRY}?.click()`)
    const maximizedFiles = await pollUntil(app.client, `${MAXIMIZE_ENTRY}?.getAttribute('aria-pressed') === 'true'`, (v) => v === true)
    await app.client.evaluate(`${MAXIMIZE_ENTRY}?.click()`)
    const restoredFiles = await pollUntil(app.client, `${MAXIMIZE_ENTRY}?.getAttribute('aria-pressed') === 'false'`, (v) => v === true)
    const afterRestore = await app.client.evaluate(EDITOR_TEXT)
    await app.client.evaluate(FOCUS_EDITOR)
    for (const type of ['rawKeyDown', 'keyUp']) {
      await app.client.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
    }
    const undone = await pollUntil(app.client, EDITOR_TEXT, (text) => !/EDIT /.test(text ?? ''))
    check(results, '[maximize] maximize + restore keep the open file, its unsaved edit and its undo history',
      maximizedFiles === true && restoredFiles === true && afterRestore === afterEdit && !/EDIT /.test(undone ?? ''),
      `maximized=${maximizedFiles} restored=${restoredFiles} same content=${afterRestore === afterEdit} undone=${!/EDIT /.test(undone ?? '')}`)
    // Put the edit back: the steps below expect it.
    await app.client.evaluate(FOCUS_EDITOR)
    await app.client.send('Input.insertText', { text: 'EDIT ' })
    await pollUntil(app.client, EDITOR_TEXT, (text) => /EDIT /.test(text ?? ''))

    // 返回檔案樹 —— 未存的變更必須活過這次換頁，且該列要標記出來（file-explorer / D9）。
    await app.client.evaluate(BACK_TO_TREE)
    const rowDirty = await pollUntil(app.client, ROW_IS_DIRTY('notes.unknownext'), (v) => v === true)
    check(results, '未存的變更返回樹後於該列標記', rowDirty === true)

    // 再次開啟，內容應是未存的 buffer 而非磁碟原文 —— 證明變更跨換頁存活。
    await app.client.evaluate(CLICK_ROW('notes.unknownext'))
    const reopened = await pollUntil(app.client, EDITOR_TEXT, (text) => Boolean(text))
    check(results, '再次開啟仍呈現未存的內容', /EDIT /.test(reopened ?? ''))

    await app.client.evaluate(FOCUS_EDITOR)
    await sendCtrlS(app.client)
    const savedDisk = await pollDisk(() =>
      /EDIT /.test(readFileSync(join(fixture.repo, 'notes.unknownext'), 'utf8')))
    check(results, '存檔後磁碟上的內容確實被寫入', savedDisk,
      savedDisk ? '' : readFileSync(join(fixture.repo, 'notes.unknownext'), 'utf8').slice(0, 20))

    // 自寫事件的抑制：我們剛存的檔不該回頭警告「檔案已在磁碟上變更」。
    await sleep(400)
    const panelAfterSave = await app.client.evaluate(SIDE_PANEL_TEXT)
    check(results, '存檔不觸發自身的外部變更提示',
      !panelAfterSave.includes(copy('viewer.stale')))

    // 回到樹，存檔後標記應消失。
    await app.client.evaluate(BACK_TO_TREE)
    const rowClean = await pollUntil(app.client, ROW_IS_DIRTY('notes.unknownext'), (v) => v === false)
    check(results, '存檔後該列的未存標記消失', rowClean === false)

    // ── file-editing：存檔與外部變更的衝突 ─────────────────────────────────
    console.log('\n檔案編輯：存檔衝突')
    await app.client.evaluate(CLICK_ROW('notes.unknownext'))
    await pollUntil(app.client, EDITOR_TEXT, (text) => Boolean(text))
    await app.client.evaluate(FOCUS_EDITOR)
    await app.client.send('Input.insertText', { text: 'MINE ' })
    await pollUntil(app.client, EDITOR_TEXT, (text) => /MINE /.test(text ?? ''))
    // agent 在使用者存檔之前改了同一個檔（新的 mtime）
    const externalContent = 'changed-by-agent\n'
    writeFileSync(join(fixture.repo, 'notes.unknownext'), externalContent)
    await sleep(50)
    await app.client.evaluate(FOCUS_EDITOR)
    await sendCtrlS(app.client)
    const conflictShown = await pollUntil(app.client, SIDE_PANEL_TEXT, (text) => (text ?? '').includes(copy('viewer.conflict')))
    check(results, '存檔時偵測到外部改動並呈現衝突', conflictShown.includes(copy('viewer.conflict')))
    check(results, '衝突時未以我的內容覆寫磁碟',
      readFileSync(join(fixture.repo, 'notes.unknownext'), 'utf8') === externalContent)

    // ── file-operations：新增 / 刪除 ────────────────────────────────────────
    console.log('\n檔案操作：新增與刪除')
    await app.client.evaluate(`document.querySelector('section[aria-label="${copy('files.label')}"] header button')?.click()`)
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.length > 0)

    // 真的點「＋」（右上角）—— 這個位置正是會讓選單溢出 viewport 的邊角案例。
    const plusPos = await coordsOf(app.client, PLUS_BTN)
    check(results, '面板 header 提供根目錄的新增入口', plusPos !== null)
    await realMouse(app.client, plusPos.x, plusPos.y, 'left')
    await pollUntil(app.client, `document.querySelectorAll('[role="menuitem"]').length`, (n) => n > 0)
    check(results, '根目錄新增選單落在 viewport 內（不溢出右緣）',
      (await app.client.evaluate(MENU_PLACEMENT)) === 'in')
    await app.client.evaluate(CLICK_MENU_ITEM(copy('files.newFile')))
    await pollUntil(app.client, `Boolean(document.querySelector('section[aria-label="${copy('files.label')}"] input'))`, (v) => v)
    await app.client.evaluate(SUBMIT_NAME_DIALOG('probe-new.txt'))
    const created = await pollDisk(() => existsSync(join(fixture.repo, 'probe-new.txt')))
    check(results, '新增的檔案出現在磁碟上', created)
    check(results, '新增的檔案出現在樹上',
      (await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('probe-new.txt'))).includes('probe-new.txt'))

    // 刪除：**真的右鍵** → 刪除 → 確認。合成 contextmenu 測不出「右鍵選單被自己開啟的
    // 事件冒泡關掉」這個 bug —— 必須用 trusted 事件。
    const newRowPos = await coordsOf(app.client, ROW_EL('probe-new.txt'))
    await realMouse(app.client, newRowPos.x, newRowPos.y, 'right')
    await pollUntil(app.client, `document.querySelectorAll('[role="menuitem"]').length`, (n) => n > 0)
    check(results, '右鍵樹列的選單出現且落在 viewport 內',
      (await app.client.evaluate(MENU_PLACEMENT)) === 'in')
    await app.client.evaluate(CLICK_MENU_ITEM(copy('common.delete')))
    const confirmVisible = await pollUntil(app.client, SIDE_PANEL_TEXT, (text) => (text ?? '').includes(copy('files.deleteIrreversible')))
    check(results, '刪除前呈現確認', confirmVisible.includes(copy('files.deleteIrreversible')))
    await app.client.evaluate(CONFIRM_DELETE)
    const deleted = await pollDisk(() => !existsSync(join(fixture.repo, 'probe-new.txt')))
    check(results, '確認後檔案自磁碟移除', deleted)
    // **等畫面也把這次刪除消化完，再進下一段。** 磁碟判準不涵蓋 UI 的狀態：確認還在畫面上、
    // 或 watcher 事件晚一步抵達而觸發重繪時，下一段第一個動作（按「+」）就會落空 ——
    // 選單開不出來（或剛開就被重繪關掉），而 `pollUntil` 只看當下狀態，於是那個等待窗口
    // 一定耗盡。**實測踩過一次**：那一段六個等待連續耗盡（各 20.2s），最後 `coordsOf` 回
    // null 讓整支探針以 `reading 'x'` 中斷，而單跑同一支是全綠的。
    // 新增那條用的是樹（`ROW_PATHS`）、刪除卻退成磁碟 —— 不對稱的那一邊就是缺口。
    await pollUntil(app.client, ROW_PATHS, (paths) => !paths.includes('probe-new.txt'))

    // ── file-operations：對有未存變更的檔案改名 / 刪除 ─────────────────────
    // 建一個檔並編輯使其 dirty，改名時 buffer 要跟著新路徑走，刪除時要先警告未存變更。
    console.log('\n檔案操作：有未存變更時的改名與刪除')
    const plusPos2 = await coordsOf(app.client, PLUS_BTN)
    await realMouse(app.client, plusPos2.x, plusPos2.y, 'left')
    await pollUntil(app.client, `document.querySelectorAll('[role="menuitem"]').length`, (n) => n > 0)
    await app.client.evaluate(CLICK_MENU_ITEM(copy('files.newFile')))
    await pollUntil(app.client, `Boolean(document.querySelector('section[aria-label="${copy('files.label')}"] input'))`, (v) => v)
    await app.client.evaluate(SUBMIT_NAME_DIALOG('w2.txt'))
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('w2.txt'))

    await app.client.evaluate(CLICK_ROW('w2.txt'))
    await pollUntil(app.client, EDITOR_TEXT, (text) => text !== null)
    await app.client.evaluate(FOCUS_EDITOR)
    await app.client.send('Input.insertText', { text: 'DIRTY-W2' })
    await pollUntil(app.client, EDITOR_TEXT, (text) => /DIRTY-W2/.test(text ?? ''))
    await app.client.evaluate(BACK_TO_TREE)
    const w2Dirty = await pollUntil(app.client, ROW_IS_DIRTY('w2.txt'), (v) => v === true)
    check(results, '有未存變更的檔案於樹上標記', w2Dirty === true)

    // 改名 → 未存的變更跟著新路徑
    const w2Pos = await coordsOf(app.client, ROW_EL('w2.txt'))
    await realMouse(app.client, w2Pos.x, w2Pos.y, 'right')
    await pollUntil(app.client, `document.querySelectorAll('[role="menuitem"]').length`, (n) => n > 0)
    await app.client.evaluate(CLICK_MENU_ITEM(copy('files.rename')))
    await pollUntil(app.client, `Boolean(document.querySelector('section[aria-label="${copy('files.label')}"] input'))`, (v) => v)
    await app.client.evaluate(SUBMIT_NAME_DIALOG('w2-renamed.txt'))
    const renamed = await pollDisk(() =>
      existsSync(join(fixture.repo, 'w2-renamed.txt')) && !existsSync(join(fixture.repo, 'w2.txt')))
    check(results, '改名後磁碟上為新名稱、舊名稱消失', renamed)
    const movedDirty = await pollUntil(app.client, ROW_IS_DIRTY('w2-renamed.txt'), (v) => v === true)
    check(results, '未存的變更跟隨改名後的新路徑', movedDirty === true)

    // 刪除有未存變更的檔案 → 確認訊息要指出未存變更
    const w2rPos = await coordsOf(app.client, ROW_EL('w2-renamed.txt'))
    await realMouse(app.client, w2rPos.x, w2rPos.y, 'right')
    await pollUntil(app.client, `document.querySelectorAll('[role="menuitem"]').length`, (n) => n > 0)
    await app.client.evaluate(CLICK_MENU_ITEM(copy('common.delete')))
    const unsavedWarn = await pollUntil(app.client, SIDE_PANEL_TEXT, (text) => (text ?? '').includes(copy('files.deleteUnsaved')))
    check(results, '刪除有未存變更的檔案時確認訊息指出未存變更', unsavedWarn.includes(copy('files.deleteUnsaved')))
    await app.client.evaluate(CONFIRM_DELETE)
    const removedDirty = await pollDisk(() => !existsSync(join(fixture.repo, 'w2-renamed.txt')))
    check(results, '確認後有未存變更的檔案自磁碟移除', removedDirty)
    const bufferGone = await pollUntil(app.client, ROW_IS_DIRTY('w2-renamed.txt'), (v) => v === null)
    check(results, '刪除後其未存的變更一併消失', bufferGone === null)

    // ── file-viewer：markdown 渲染、安全性、預覽/原始碼切換 ─────────────────
    console.log('\n檔案檢視：markdown 的渲染、安全性與模式切換')
    await app.client.evaluate(BACK_TO_TREE) // 正在看檔案則回到樹；已在樹則無作用
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('README.md'))
    // README 含一張遠端圖片。在它渲染**之前** arm CSP 收集器 —— 收集器只捕捉其後派送的違規。
    await app.client.evaluate(CSP_ARM)
    await app.client.evaluate(CLICK_ROW('README.md'))
    const md = await pollUntil(app.client, MARKDOWN, (value) => value !== null)

    check(results, 'markdown 以渲染後的樣貌呈現', md?.headings === 1 && md?.tables === 1,
      `h1=${md?.headings} table=${md?.tables}`)
    check(results, '原始 HTML 不被當作 HTML 執行', md?.scriptElements === 0 && md?.pwned === false,
      `scriptElements=${md?.scriptElements} pwned=${md?.pwned}`)
    check(results, 'script 標籤以純文字呈現', /<script>/.test(md?.text ?? ''))
    check(results, 'javascript: 連結不可點（未渲染為 anchor）',
      !(md?.anchors ?? []).some((href) => /^javascript:/i.test(href ?? '')), (md?.anchors ?? []).join(' '))
    check(results, '外部連結保留為 anchor', (md?.anchors ?? []).includes('https://example.com/docs'))

    // ── workspace-app-shell：CSP 施加於 renderer（建置模式）──────────────────
    // 圖片放行（img-src https:），不再引發違規，故改用一個一定被擋的 fetch（connect-src 'self'
    // 擋下）捕捉實際施加的政策。inline script 的阻擋**不能**用 CDP 動態插入 script 驗 ——
    // `Runtime.evaluate` 注入的程式碼繞過 script-src（DevTools 的設計），會給假陰性；改從 violation
    // 的 originalPolicy 端到端讀出實際政策，斷言 script-src 僅 'self'。
    await app.client.evaluate(TRIGGER_CSP)
    const policy = await pollUntil(app.client, CSP_POLICY, (p) => p.length > 0, 3000)
    check(results, 'CSP 確實施加於 renderer（connect-src 擋下遠端 fetch）', policy.length > 0,
      policy ? policy.slice(0, 64) : '(未捕捉到政策)')
    check(results, 'CSP 的 script-src 僅 self —— inline script 一律不執行',
      /script-src 'self';/.test(policy) && !/script-src[^;]*unsafe-inline/.test(policy),
      policy.match(/script-src[^;]*/)?.[0] ?? '(政策未捕捉)')
    check(results, 'CSP 放行遠端 https 圖片（markdown 的正常內容可載入）', /img-src[^;]*https:/.test(policy),
      policy.match(/img-src[^;]*/)?.[0] ?? '(政策未捕捉)')
    // README 的遠端圖片不該引發 img-src 違規（放行）
    const imgViolations = await app.client.evaluate(CSP_VIOLATIONS)
    check(results, 'markdown 的遠端圖片未被 CSP 阻擋', !imgViolations.includes('img-src'),
      imgViolations.length ? imgViolations.join(',') : '(無違規，正確)')

    // 預設為預覽模式（渲染後的樣貌）
    check(results, 'markdown 預設呈現預覽模式', (await app.client.evaluate(MODE_PRESSED(copy('viewer.preview')))) === true)

    // 切換至原始碼 → 呈現可編輯的原始 markdown 文字，預覽區退場
    await app.client.evaluate(CLICK_MODE(copy('viewer.source')))
    const source = await pollUntil(app.client, EDITOR_TEXT, (text) => /# 標題/.test(text ?? ''))
    check(results, '切換至原始碼模式呈現原始 markdown', /# 標題/.test(source ?? ''))
    check(results, '原始碼模式為可編輯的編輯器（非唯讀）',
      (await app.client.evaluate(INPUT_AREA_READONLY)) === false)

    // 於原始碼模式編輯 → 切回預覽，修改要反映在預覽中
    await app.client.evaluate(FOCUS_EDITOR)
    await app.client.send('Input.insertText', { text: 'MDEDIT ' })
    await pollUntil(app.client, EDITOR_TEXT, (text) => /MDEDIT /.test(text ?? ''))
    await app.client.evaluate(CLICK_MODE(copy('viewer.preview')))
    const previewText = await pollUntil(app.client, PREVIEW_TEXT, (text) => /MDEDIT/.test(text ?? ''))
    check(results, '原始碼模式的修改反映於預覽', /MDEDIT/.test(previewText ?? ''))

    // ── workspace-app-shell：導航防護 ───────────────────────────────────────
    console.log('\n導航防護（preload 白名單不得落入遠端頁面）')
    const navigation = await app.client.evaluate(TRY_NAVIGATE)
    check(results, 'renderer 無法導航離開應用程式來源', navigation.before === navigation.after,
      `${navigation.after}`)
    check(results, 'renderer 無法開啟新視窗', (await app.client.evaluate(TRY_WINDOW_OPEN)) === true)

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      const attempt = await app.client.evaluate(OPEN_EXTERNAL(url))
      check(results, `主行程拒絕以系統瀏覽器開啟 ${url.split(':')[0]}:`, attempt.rejected === true)
    }

    // ── 迴歸：被阻擋的導航不得摧毀 watcher ───────────────────────────────────
    // `will-navigate` 與 `did-start-navigation` 對同一次導航都會觸發，preventDefault 只是
    // 隨後取消它。曾經以 did-start-navigation 當「重新載入」的訊號 —— 於是一次被擋掉的
    // 導航就讓所有 watcher 靜默消失，檔案樹與檢視器從此不再更新。
    // 導航測試期間面板停在 README.md 的檢視上，先回到樹才看得到列
    await app.client.evaluate(BACK_TO_TREE)
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('README.md'))

    writeFileSync(join(fixture.repo, 'watch-after-nav.txt'), 'x')
    const afterNav = await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('watch-after-nav.txt'))
    check(results, '被阻擋的導航不摧毀 watcher', afterNav.includes('watch-after-nav.txt'))
    unlinkSync(join(fixture.repo, 'watch-after-nav.txt'))

    // ── file-viewer：外部變更提示 ───────────────────────────────────────────
    console.log('\n檢視中的檔案於磁碟被改動')
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('sample.ts'))
    await app.client.evaluate(CLICK_ROW('sample.ts'))

    // ── workspace-app-shell：編輯器與 worker（建置模式）─────────────────────
    console.log('\n編輯器：語法高亮與 worker 往返（建置模式）')
    const tokens = await pollUntil(app.client, TOKEN_CLASSES, (count) => count > 1)
    check(results, '編輯器載入且語法元素有多於一種呈現樣式', tokens > 1, `${tokens} 種 token class`)

    const links = await pollUntil(app.client, DETECTED_LINKS, (count) => count > 0)
    check(results, 'worker 完成一次往返（URL 被標為連結）', links > 0, `${links} 個 .detected-link`)

    writeFileSync(join(fixture.repo, 'sample.ts'), '// 已被外部改動 https://example.com/spec\n')
    const staleText = await pollUntil(app.client, PANEL_TEXT, (text) => (text ?? '').includes(copy('viewer.stale')))
    check(results, '檢視中的檔案被外部修改時提示過期', staleText.includes(copy('viewer.stale')))

    unlinkSync(join(fixture.repo, 'sample.ts'))
    const deletedText = await pollUntil(app.client, PANEL_TEXT, (text) => (text ?? '').includes(copy('viewer.deleted')))
    check(results, '檢視中的檔案被外部刪除時明確標示', deletedText.includes(copy('viewer.deleted')))

    // ── quick open ─────────────────────────────────────────────────────────
    //
    // **命名對話框那條不是理論邊角**：它渲染於側欄的 DOM 子樹之內（不是移到文件頂層），
    // 於是「按鍵行經側欄容器」這個觸發條件在使用者正打字命名時**恰好成立**。
    console.log('\nquick open')

    await app.client.evaluate(`document.querySelector('section[aria-label="${copy('files.label')}"] header button')?.click()`)
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.length > 0)

    check(results, 'quick open 前置 —— 檔案樹取得焦點',
      (await pollUntil(app.client, FOCUS_FILE_TREE, (v) => v === true, 8000)) === true)

    await pressCtrlP(app.client)
    const listed = await pollUntil(app.client, QUICK_OPEN, (v) => v !== null && v.count > 0, 8000)
    check(results, '檔案樹持有焦點時 Ctrl+P 開啟入口並列出檔案', listed !== null && listed.count > 0,
      JSON.stringify(listed && listed.titles))

    check(results, '清單只含檔案，不含目錄',
      listed !== null && listed.titles.every((t) => t !== 'sub' && t !== 'sub/deep'),
      JSON.stringify(listed && listed.titles))

    // 保守列舉（fixture 非 git）**不得跟隨越界 symlink**：`escape-link` 指向 workspace 之外，
    // 而邊界的包含判定是**字面**比較 —— `escape-link/secret.txt` 必定通過它。擋得住的只有
    // 「不下鑽 symlink」。這條在 probe 層比在單元測試層更真實：走的是產品完整的那條路。
    check(results, '清單不含經越界 symlink 才到得了的檔案',
      listed !== null && listed.titles.every((t) => !t.includes('secret.txt')),
      JSON.stringify(listed && listed.titles))

    await app.client.send('Input.insertText', { text: 'while-open' })
    const beforeCreate = await pollUntil(app.client, QUICK_OPEN,
      (v) => v !== null && v.query === 'while-open', 8000)
    check(results, '無相符項目時呈現說明而非無說明的空白',
      beforeCreate !== null && beforeCreate.count === 0 && beforeCreate.message !== null,
      JSON.stringify(beforeCreate))

    writeFileSync(join(fixture.repo, 'while-open.txt'), 'x')
    await sleep(1500)
    const afterCreate = await app.client.evaluate(QUICK_OPEN)
    check(results, '開啟期間新建的檔案不出現於當次清單（清單為靜態）',
      afterCreate !== null && afterCreate.count === 0, JSON.stringify(afterCreate))

    await pressEsc(app.client)
    await sleep(300)
    await app.client.evaluate(FOCUS_FILE_TREE)
    await pressCtrlP(app.client)
    await pollUntil(app.client, QUICK_OPEN, (v) => v !== null, 8000)
    await app.client.send('Input.insertText', { text: 'while-open' })
    const afterReopen = await pollUntil(app.client, QUICK_OPEN,
      (v) => v !== null && v.query === 'while-open', 8000)
    check(results, '關閉再開啟後該檔案出現（每次重取，不快取）',
      afterReopen !== null && afterReopen.count === 1, JSON.stringify(afterReopen))
    await pressEsc(app.client)
    await sleep(300)

    const plusForDialog = await coordsOf(app.client, PLUS_BTN)
    await realMouse(app.client, plusForDialog.x, plusForDialog.y, 'left')
    await pollUntil(app.client, `document.querySelectorAll('[role="menuitem"]').length`, (n) => n > 0)
    await app.client.evaluate(CLICK_MENU_ITEM(copy('files.newFile')))
    check(results, 'quick open 前置 —— 命名對話框開啟',
      (await pollUntil(app.client, NAME_DIALOG_PRESENT, (v) => v === true, 6000)) === true)

    await pressCtrlP(app.client)
    const quickOpenUnderDialog = await app.client.evaluate(QUICK_OPEN)
    const dialogStillOpen = await app.client.evaluate(NAME_DIALOG_PRESENT)
    check(results, '命名對話框開啟時 Ctrl+P 為無操作且對話框維持開啟',
      quickOpenUnderDialog === null && dialogStillOpen === true,
      `quick open=${JSON.stringify(quickOpenUnderDialog)}；對話框仍開著=${dialogStillOpen}`)
    await pressEsc(app.client)
    await sleep(400)

    // ── ui-localization：排序與相對時間隨 UI 語言 ──────────────────────────
    console.log('\n排序與相對時間的 locale')
    const sortOrder = `[...document.querySelectorAll('[role="treeitem"]')]
      .map((r) => r.getAttribute('title'))
      .filter((t) => t && t.endsWith('-sort.txt') || t === '中文排序.txt')`

    const orderInEnglish = await pollUntil(app.client, sortOrder, (v) => Array.isArray(v) && v.length === 3, 8000)
    check(results, '前置：三個能分辨 collator 的檔名都在樹上',
      Array.isArray(orderInEnglish) && orderInEnglish.length === 3, JSON.stringify(orderInEnglish))

    // 相對時間以當前語言呈現 —— 檔案樹的每一列都在顯示它。
    const relativeInEnglish = await app.client.evaluate(
      `document.querySelector('[role="treeitem"][title="README.md"]')?.textContent ?? ''`)

    /**
     * 切換語言 —— **必須走產品自己的入口（設定對話框的選單）**。
     *
     * 直接呼叫 `window.workspace.settings.setLanguage(...)` 只會改**主行程**的語言：
     * renderer 自己那份 i18n 是由 `PreferencesProvider` 在 IPC resolve 之後才套用的。
     * 以 preload 的方法驅動，畫面一個字都不會變，而斷言看起來就像「排序沒有隨語言改變」。
     */
    const switchLanguageTo = async (language) => {
      await app.client.evaluate(`document.querySelector('[aria-label="${copy('activityBar.settings')}"]')?.click()`)
      // The language is in the General section; Settings reopens on the last section shown, so ask for it.
      await showSection(app.client, 'general')
      await pollUntil(app.client,
        `document.querySelector('[aria-label="${copy('settings.language')}"]') !== null`, (v) => v === true, 8000)
      await app.client.evaluate(`(() => {
        const select = document.querySelector('[aria-label="${copy('settings.language')}"]')
        select.value = ${JSON.stringify(language)}
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await pollUntil(app.client, 'document.documentElement.lang', (v) => v === language, 8000)
      await pressEsc(app.client)
    }
    await switchLanguageTo('zh-TW')

    const orderInChinese = await pollUntil(
      app.client, sortOrder, (v) => Array.isArray(v) && v.length === 3 && JSON.stringify(v) !== JSON.stringify(orderInEnglish), 8000)
    check(results, '檔名的排序隨 UI 語言改變',
      JSON.stringify(orderInChinese) !== JSON.stringify(orderInEnglish),
      `en=${JSON.stringify(orderInEnglish)} zh=${JSON.stringify(orderInChinese)}`)

    const relativeInChinese = await app.client.evaluate(
      `document.querySelector('[role="treeitem"][title="README.md"]')?.textContent ?? ''`)
    check(results, '相對修改時間隨 UI 語言改變',
      relativeInChinese !== relativeInEnglish && relativeInChinese.length > 0,
      `en=${JSON.stringify(relativeInEnglish.slice(-24))} zh=${JSON.stringify(relativeInChinese.slice(-24))}`)

    // 切回基準語言 —— **此後的段落全部以英文的選擇器定位元素**。
    // 注意選單本身的 `aria-label` 現在是中文的，因此這裡的選擇器也要是中文的。
    await app.client.evaluate(`document.querySelector('[aria-label="${copyIn('zh-TW', 'activityBar.settings')}"]')?.click()`)
    await pollUntil(app.client,
      `document.querySelector('[aria-label="${copyIn('zh-TW', 'settings.language')}"]') !== null`, (v) => v === true, 8000)
    await app.client.evaluate(`(() => {
      const select = document.querySelector('[aria-label="${copyIn('zh-TW', 'settings.language')}"]')
      select.value = 'en'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await pollUntil(app.client, 'document.documentElement.lang', (v) => v === 'en', 8000)
    await pressEsc(app.client)
  } finally {
    await app.close()
  }
}

// ── 開發模式：只驗 worker 的載入路徑 ────────────────────────────────────────

// ── Closing the window with unsaved changes (workspace-app-shell) ───────────
//
// The native dialog is replaced by the stand-in in src/main/close-dialog-stub.ts (throwaway profiles
// only): prompts are read from close-stub/dialogs.jsonl, answers written to "answer", and writing
// "close" makes the main process close the window the way the close button does. Before it, the
// unsaved-changes requirement had no automated carrier at all.

const SESSION_TABS = `[...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')].map((tab) => ({
  label: tab.innerText.trim(),
  title: tab.getAttribute('title') ?? '',
}))`
const NEW_SESSION_EL = `document.querySelector('[aria-label="${copy('sessions.new')}"]')`
const SPAWN_SHELL_EL = `[...(document.querySelector('[role="menu"]')?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes(${JSON.stringify(copy('sessions.spawnShell'))}))`
const TERMINAL_EL = `document.querySelector('section[aria-label="${copy('stage.terminal')}"]')`

async function probeCloseConfirm(fixture) {
  console.log('\nClosing the window with unsaved changes')
  const target = 'close-target.txt'
  const original = 'close target\n'
  writeFileSync(join(fixture.repo, target), original)
  const profile = seedProfile([['f-openspec', fixture.repo]])
  const root = join(profile, 'close-stub')
  const dialogs = () => {
    try {
      return readFileSync(join(root, 'dialogs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const answer = (role) => writeFileSync(join(root, 'answer'), role)
  const triggerClose = () => writeFileSync(join(root, 'close'), String(Date.now()))
  const waitDialogs = (count) =>
    pollFor({ read: dialogs, settled: (value) => value.length >= count, timeoutMs: 8000, interval: 100, label: `prompts ≥ ${count}` })
  const responsive = async (client) => {
    try {
      return (await client.evaluate('1 + 1')) === 2
    } catch {
      return false
    }
  }
  const fileLine = `repo-openspec/${target}`

  let app = null
  try {
    app = await launch({ port: BUILD_PORT, profileDir: profile, rendererUrl: null })
    await pollUntil(app.client, SELECT_FOLDER('repo-openspec'), (value) => value === true, 10_000)
    await app.client.evaluate(CLICK_TAB('▤'))
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes(target))
    await app.client.evaluate(CLICK_ROW(target))
    await pollUntil(app.client, EDITOR_TEXT, (text) => /close target/.test(text ?? ''))
    await app.client.evaluate(FOCUS_EDITOR)
    await app.client.send('Input.insertText', { text: 'UNSAVED ' })
    await pollUntil(app.client, EDITOR_TEXT, (text) => /UNSAVED /.test(text ?? ''))
    // The dirty snapshot reaches the main process by a push; give it a moment.
    await sleep(500)

    // ── Unsaved changes only: held, the unsaved-changes dialog as before; cancel keeps them.
    answer('cancel')
    triggerClose()
    const first = (await waitDialogs(1))[0]
    await sleep(500)
    const upAfterCancel = await responsive(app.client)
    const stillDirty = /UNSAVED /.test((await app.client.evaluate(EDITOR_TEXT)) ?? '')
    check(results, 'Closing with unsaved changes is held and asks (unsaved-changes dialog, Save All default)',
      JSON.stringify(first?.roles) === '["saveAll","discard","cancel"]' && first?.defaultRole === 'saveAll' &&
        Boolean(first?.detail?.includes(fileLine)),
      JSON.stringify({ roles: first?.roles, defaultRole: first?.defaultRole, detail: first?.detail }))
    check(results, 'Cancelling keeps the window and the unsaved changes',
      upAfterCancel && stillDirty, `responsive=${upAfterCancel} dirty=${stillDirty}`)

    // ── Unsaved changes and a running shell: exactly one dialog listing both, cancel the default.
    const entry = await coordsOf(app.client, NEW_SESSION_EL)
    await realMouse(app.client, entry.x, entry.y, 'left')
    const item = await pollFor({
      read: () => coordsOf(app.client, SPAWN_SHELL_EL),
      settled: (value) => value !== null,
      timeoutMs: 4000,
      interval: 100,
      label: 'spawn menu shell item',
    })
    await realMouse(app.client, item.x, item.y, 'left')
    const tabs = await pollUntil(app.client, SESSION_TABS,
      (value) => value.length === 1 && value[0].title.includes(copy('sessions.statusRunning')), 10_000)
    const before = dialogs().length
    triggerClose()
    const shared = (await waitDialogs(before + 1))[before]
    await sleep(800)
    const promptCount = dialogs().length
    check(results, 'Unsaved changes and running sessions share one dialog (one prompt, both listed, cancel default)',
      promptCount === before + 1 && shared?.defaultRole === 'cancel' && shared?.cancelRole === 'cancel' &&
        Boolean(shared?.detail?.includes(fileLine)) &&
        Boolean(shared?.detail?.includes(copy('closeConfirm.line', { item: 'repo-openspec', label: tabs[0]?.label ?? '' }))),
      `prompts ${before} → ${promptCount} ${JSON.stringify({ roles: shared?.roles, defaultRole: shared?.defaultRole, detail: shared?.detail })}`)
    const tabsAfter = await app.client.evaluate(SESSION_TABS)
    await app.client.evaluate(FOCUS_EDITOR)
    const dirtyAfter = /UNSAVED /.test((await app.client.evaluate(EDITOR_TEXT)) ?? '')
    check(results, 'Cancelling the shared dialog keeps both (window open, unsaved changes, session running)',
      (await responsive(app.client)) && dirtyAfter && Boolean(tabsAfter[0]?.title.includes(copy('sessions.statusRunning'))),
      `dirty=${dirtyAfter} tab=${JSON.stringify(tabsAfter[0])}`)

    // ── End the shell, then "Don't Save": the window closes, the file on disk is untouched.
    const terminal = await coordsOf(app.client, TERMINAL_EL)
    await realMouse(app.client, terminal.x + 40, terminal.y, 'left')
    await app.client.send('Input.insertText', { text: 'exit' })
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' })
    await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
    await pollUntil(app.client, SESSION_TABS, (value) => !value[0]?.title.includes(copy('sessions.statusRunning')), 8000)
    answer('discard')
    const beforeDiscard = dialogs().length
    triggerClose()
    const discarded = (await waitDialogs(beforeDiscard + 1))[beforeDiscard]
    const exited = await app.waitForExit(10_000)
    const disk = readFileSync(join(fixture.repo, target), 'utf8')
    check(results, "Choosing Don't Save closes the window and leaves the file on disk unchanged",
      exited && disk === original && discarded?.defaultRole === 'saveAll',
      `exited=${exited} disk=${JSON.stringify(disk)} prompt=${JSON.stringify(discarded?.roles)}`)
  } finally {
    if (app) await app.close()
  }
}

async function probeDev(fixture, profile) {
  writeFileSync(join(fixture.repo, 'sample.ts'), '// 參考 https://example.com/spec\nexport const answer = 42\n')

  console.log('\n編輯器：語法高亮與 worker 往返（開發模式）')
  const server = await startRendererDevServer()
  let app = null
  try {
    app = await launch({ port: DEV_PORT, profileDir: profile, rendererUrl: server.url })

    if (!check(results, `應用程式啟動（開發模式，renderer 由 ${server.url} 提供）`, app.mounted?.ok === true,
      app.mounted?.ok ? '' : `${describeMounted(app.mounted)} ${app.stderr().slice(-300)}`)) {
      return
    }

    const folders = await app.client.evaluate('window.workspace.folders.list()')
    check(results, '開發模式使用探針的暫存 profile', folders.length === 2,
      folders.map((f) => f.name).join(', ') || '(空)')

    await app.client.evaluate(SELECT_FOLDER('repo-openspec'))
    // 預設身分是 OpenSpec（`openspec-side-panel` 起）—— 檔案樹要先切到 Files 身分才存在。
    await app.client.evaluate(CLICK_TAB('▤'))
    await pollUntil(app.client, ROW_PATHS, (paths) => paths.includes('sample.ts'))
    await app.client.evaluate(CLICK_ROW('sample.ts'))

    const tokens = await pollUntil(app.client, TOKEN_CLASSES, (count) => count > 1)
    check(results, '開發模式下編輯器提供語法高亮', tokens > 1, `${tokens} 種 token class`)

    const links = await pollUntil(app.client, DETECTED_LINKS, (count) => count > 0)
    check(results, '開發模式下 worker 完成一次往返', links > 0, `${links} 個 .detected-link`)

    // app 能掛載、worker 能往返，本身已證明 dev CSP 未擋掉 Vite 的 inline preamble 與 HMR
    // websocket。這裡確認 dev 政策確實**施加了**，且與 production 一致地放行遠端 https 圖片。
    await app.client.evaluate(CSP_ARM)
    await app.client.evaluate(TRIGGER_CSP)
    const devPolicy = await pollUntil(app.client, CSP_POLICY, (p) => p.length > 0, 3000)
    check(results, '開發模式下 CSP 確實施加（connect-src 擋下遠端 fetch）', devPolicy.length > 0,
      devPolicy ? devPolicy.slice(0, 64) : '(未捕捉到政策)')
    check(results, '開發模式下 CSP 放行遠端 https 圖片', /img-src[^;]*https:/.test(devPolicy),
      devPolicy.match(/img-src[^;]*/)?.[0] ?? '(政策未捕捉)')
    check(results, '開發模式下遠端圖片未被 CSP 阻擋', (await app.client.evaluate(TRY_REMOTE_IMAGE)) === false,
      'img-src 違規應為 false')

    // build-identity：〈開發模式的身分可與打包產物區分〉—— 見 BUILD_IDENTITY 的註解。
    const settingsAt = await coordsOf(app.client, SETTINGS_EL)
    if (settingsAt) await realMouse(app.client, settingsAt.x, settingsAt.y, 'left')
    // The build identity is the About section of Settings (`settings-sections`).
    await showSection(app.client, 'about')
    const identity = await pollUntil(app.client, BUILD_IDENTITY, (value) => value !== null, 4000)
    check(results, '開發模式的建置身分標示為開發，且不冒充建置時刻',
      identity?.development === true && identity.hasBuiltAt === false,
      JSON.stringify(identity))
  } finally {
    if (app) await app.close()
    // 殺整個 process group（npx → node → vite），而非只殺 npx wrapper。負號 = 整組。
    try {
      process.kill(-server.child.pid, 'SIGKILL')
    } catch {
      // 已經結束就會 ESRCH，那正是要的結果。
    }
    await sleep(300)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const fixture = makeFixture()
const profile = seedProfile([
  ['f-openspec', fixture.repo],
  ['f-plain', fixture.plain],
])

let exitCode = 1
try {
  await probeBuild(fixture, profile)
  await probeCloseConfirm(fixture)
  await probeDev(fixture, profile)
  exitCode = results.every(Boolean) ? 0 : 1
} catch (error) {
  console.error(`\nprobe 失敗：${error.message}`)
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${results.filter(Boolean).length}/${results.length} 通過`)
process.exit(exitCode)
