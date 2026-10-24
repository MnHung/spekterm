/**
 * `keyboard-navigation` 的驗收。
 *
 * 一律透過 CDP 連進真正執行中的 app —— 不在產品程式碼裡塞測試分支。dev 與 build 兩種模式都跑。
 *
 * ## 這支探針能證明什麼、不能證明什麼
 *
 * `Input.dispatchKeyEvent` 是把事件**注入 Chromium 的輸入管線**，它**繞過**作業系統與瀏覽器的
 * accelerator 層。因此：
 *
 * - **能證明**：handler 的邏輯正確（切對了 session／repo、順序是位置序而非 MRU、對話框開著時
 *   讓位），以及**被攔下的按鍵沒有流進 pty**。
 * - **不能證明**：一顆**真實鍵盤**送出的 `Ctrl+Tab` 抵達得了 renderer（若 Chromium 把它保留給
 *   分頁切換，這支探針照樣全綠）。那道缺口只能由真人按一次鍵補上 —— 它列在 change 的 tasks 第 7 節，
 *   **不假裝這裡涵蓋了它**。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { check, connectToApp, dragMouse, pollFor, pollUntil, retryAction } from './lib/cdp.mjs'
import { menuEvidence } from './lib/menu-evidence.mjs'
import { sectionConsole } from './lib/instrument.mjs'
import { copy, prefixOf } from './lib/copy.mjs'
import { MOUNTED, awaitMounted, describeMounted } from './lib/mounted.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { runSections } from './lib/sections.mjs'
import { PROBE_PORTS } from './lib/ports.mjs'
import { seedLanguage } from './lib/probe-language.mjs'

const BUILD_PORT = PROBE_PORTS.keyboard.build
const DEV_PORT = PROBE_PORTS.keyboard.dev

/** 可預測、無 profile 雜訊，且處處存在。 */
const SHELL_PATH = '/bin/sh'

const results = []
const temps = []

function mkTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** pty 寫檔的觀測落點。刻意在 repo 之外 —— repo 內有 chokidar 在監看。 */
let ptyOutDir = null

function makeFixture() {
  const base = mkTemp('spekterm-keyboard-fixture-')
  const repos = ['repo-a', 'repo-b', 'repo-c'].map((name) => {
    const repo = join(base, name)
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'notes.txt'), `${name} 的內容\n第二行\n`)
    return [name, repo]
  })
  ptyOutDir = join(base, 'probe-out')
  mkdirSync(ptyOutDir, { recursive: true })
  return repos
}

/**
 * 送一顆 Enter（不打任何字）。
 *
 * **這是「讀檔」判定按鍵是否進 pty 的關鍵一步，而它不直觀。** tty 處於 **canonical mode**，
 * 輸入會停在**行緩衝**裡 —— **沒有換行，`cat` 永遠讀不到那些位元組**，檔案自然是空的
 * （實測：`cat -A > f` 與 `stdbuf -o0 cat -A > f` 都拿不到，不是緩衝設定的問題，是行紀律）。
 * 按完待測的鍵之後補一顆 Enter，那一行才會被送進 `cat`，也才會落檔。
 */
async function pressEnter(client) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * 等 pty 寫出的檔案出現並滿足條件，回傳內容。
 *
 * 判定「按鍵有沒有流進 pty」為什麼要走磁碟：**畫面上那串 caret 記法（`^[[A`）不是 `cat` 印的，
 * 是 tty 自己的 echo**（canonical mode 的 `echoctl`）—— 實測**完全不跑 `cat`，畫面照樣有它**。
 * 於是「讀畫面」讀到的是 tty 的行為，而 `cat -A > file` 讓那些位元組真的落到磁碟上，
 * 且**渲染方式怎麼變都不影響它**。
 */
async function waitForPtyFile(name, settled, timeoutMs = 8000) {
  const path = join(ptyOutDir, name)
  return pollFor({
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : ''),
    settled,
    timeoutMs,
    interval: 150,
    label: `waitForPtyFile(${name})`,
  })
}

function seedProfile(repos) {
  const profile = mkTemp('spekterm-keyboard-profile-')
  writeFileSync(
    join(profile, 'workspace.json'),
    JSON.stringify({
      version: 1,
      folders: repos.map(([name, path], index) => ({
        id: `f${index + 1}`,
        path,
        addedAt: '2026-07-12T00:00:00.000Z',
        name,
      })),
    }),
  )
  return profile
}

// ── app 啟動 ────────────────────────────────────────────────────────────────

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (text) => text.replace(ANSI_PATTERN, '')

async function startRendererDevServer() {
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
      env: {
        ...process.env,
        SHELL: SHELL_PATH,
        ...(rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl } : {}),
      },
    },
  )

  const client = await connectToApp(port, { targetTimeoutMs: 30_000 })
  const mounted = await awaitMounted(client)

  return {
    client,
    mounted,
    async destroy() {
      try {
        client.close()
      } catch {
        // 已關閉
      }
      child.kill('SIGKILL')
      try {
        execFileSync('pkill', ['-9', '-f', profileDir], { stdio: 'ignore' })
      } catch {
        // 沒有殘留 —— 正是我們要的。
      }
      await sleep(200)
    },
  }
}

// ── renderer 內的量測（一律 role／aria，不掛 data-*）─────────────────────────

const SELECT_FOLDER = (name) => `(() => {
  const rows = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] li > div[role="button"]')]
  const row = rows.find((r) => r.innerText.includes(${JSON.stringify(name)}))
  if (!row) return false
  row.click()
  return true
})()`

/** 當前選中的 repo（rail 上被標示的那一列）。 */
const SELECTED_FOLDER = `(() => {
  const row = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] li > div[role="button"]')]
    .find((r) => r.getAttribute('aria-current') === 'true' || r.dataset.selected === 'true')
  // **以 aria-label 取名稱，不以 innerText 的第一行** —— 該列展開時，第一行是那顆 ▾ 展開鈕。
  // 這條退路此前從未被走到（產品沒有 aria-current），global-session 加上它之後才第一次生效。
  // （此處不得使用反引號 —— 這一段住在模板字串裡。這是本 change 第三次踩到它。）
  if (row) return row.getAttribute('aria-label') ?? row.innerText.split('\\n')[0].trim()
  // 退路：主舞台的 repo header 就是當前 repo
  const header = document.querySelector('main[aria-label="${copy('stage.label')}"] header')
  return header ? header.innerText.split('\\n')[0].trim() : null
})()`

const TABS = `[...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')].map((tab) => ({
  label: tab.innerText.replace(/\\s+/g, ' ').trim(),
  selected: tab.getAttribute('aria-selected') === 'true',
}))`

/** The focused session's status tooltip (it names the dormant and exited states). */
const FOCUSED_STATUS = `(() => {
  const tab = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
    .find((t) => t.getAttribute('aria-selected') === 'true')
  return tab ? (tab.getAttribute('title') ?? '') : null
})()`

const FOCUSED_TAB = `(() => {
  const tab = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
    .find((t) => t.getAttribute('aria-selected') === 'true')
  return tab ? tab.innerText.replace(/\\s+/g, ' ').trim() : null
})()`

const RECT_OF = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

const NEW_SESSION_RECT = RECT_OF(`[aria-label="${copy('sessions.new')}"]`)
const TERMINAL_RECT = RECT_OF(`section[aria-label="${copy('stage.terminal')}"]`)

/**
 * rail 上**全域項目**的建立 session 入口。
 *
 * 與 `NEW_SESSION_RECT` 是兩個東西：後者是主舞台的按鈕，而**零 folder 時沒有選中的 repo**，
 * 主舞台根本不呈現它。寫法取自 `probe-package.mjs`（那支同樣在零 folder 下建 session）。
 */
const GLOBAL_NEW_SESSION_RECT = RECT_OF(
  `aside[aria-label="${copy('rail.label')}"] [aria-label="${copy('rail.newSessionIn', { name: copy('rail.globalName') })}"]`,
)

/** 狀態列的文字。空狀態與有脈絡兩種情形都由它讀出（寫法取自 `probe-openspec.mjs`）。 */
const STATUS_BAR_TEXT = `(() => {
  const bar = document.querySelector('footer[aria-label="${copy('statusBar.label')}"]')
  return bar ? (bar.textContent ?? '') : null
})()`

/** 側欄在 Files 身分下的文字 —— 無來源時的提示由它讀出。 */
const FILES_PANEL_TEXT = `(() => {
  const panel = document.querySelector('section[aria-label="${copy('files.label')}"]')
  return panel ? (panel.textContent ?? '') : null
})()`

/** 有沒有對話框或選單開著 —— 快捷鍵的抑制條件（`KeyboardNavigation.tsx`）。 */
const SUPPRESSORS = `document.querySelectorAll('[role="dialog"], [role="menu"]').length`

const MENU_ITEM_RECT = (label) => `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const item = [...menu.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(label)}))
  if (!item) return null
  const r = item.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

const TAB_RECT = (index) => `(() => {
  const tabs = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
  const tab = tabs[${index}]
  if (!tab) return null
  const r = tab.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/**
 * 只讀「當前顯示中」的那個終端 —— 其餘 session 的終端仍掛載，只是 display:none。
 *
 * **讀不到就丟錯，絕不回空字串**（與 `probe-terminal.mjs` 的同名 expression 同源，兩份都要改）。
 *
 * **這支探針是假綠的重災區**：它的核心保證「被攔下的按鍵沒有流進 pty」全是否定式斷言
 * （`leaked.length === 0`）—— 空字串 ⇒ `leaked` 必為空 ⇒ **通過**。也就是說，終端完全讀不到時
 * 它們照樣是綠的，而它們自稱在測的東西一個字都沒測到。
 */
const TERMINAL_TEXT = `(() => {
  const host = [...document.querySelectorAll('section[aria-label="${copy('stage.terminal')}"] > div')]
    .find((d) => !d.classList.contains('hidden'))
  if (!host) throw new Error('TERMINAL_TEXT: 找不到顯示中的終端容器（沒有 session？還是版面變了？）')
  const rows = host.querySelector('.xterm-rows')
  if (!rows) throw new Error('TERMINAL_TEXT: 終端容器在，但讀不到 .xterm-rows —— 渲染方式換了？這條觀測管道已失效，不可當成「畫面上沒有東西」')
  return rows.innerText
})()`

const DIALOG_OPEN = `Boolean(document.querySelector('[role="dialog"]'))`

const MENU_STATE = `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const r = menu.getBoundingClientRect()
  const items = [...menu.querySelectorAll('button[role="menuitem"]')]
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y) },
    items: items.map((b) => b.innerText.trim()),
    focused: items.findIndex((b) => b === document.activeElement),
  }
})()`

const IDENTITY_FILES = `(() => {
  const btn = [...document.querySelectorAll('[role="tablist"][aria-label="${copy('panelSwitch.label')}"] button[role="tab"]')]
    .find((b) => b.innerText.includes('Files'))
  if (!btn) return false
  btn.click()
  return true
})()`

const OPEN_FILE = (name) => `(() => {
  const row = [...document.querySelectorAll('section[aria-label="${copy('files.label')}"] [role="treeitem"]')]
    .find((r) => r.innerText.includes(${JSON.stringify(name)}))
  if (!row) return false
  row.click()
  return true
})()`

const EDITOR_TEXTAREA_FOCUSED = `(() => {
  const ta = document.querySelector('section[aria-label="${copy('files.label')}"] textarea')
  if (!ta) return false
  ta.focus()
  return document.activeElement === ta
})()`

/**
 * quick open 的狀態。`null` ＝ 入口未開啟。
 *
 * `titles` 是每一列的 `title` 屬性 —— 那是**完整的 folder-relative 路徑**（權威值）；
 * `shown` 是呈現的文字 —— 它剝掉了工作目錄前綴。兩者要分開看，因為「呈現剝前綴而權威不剝」
 * 正是 `side-panel-worktree` 立下的紀律，只驗一邊的話兩種錯誤實作都會通過。
 */
const QUICK_OPEN = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="${copy('quickOpen.label')}"]')
  if (!dialog) return null
  const input = dialog.querySelector('input')
  const options = [...dialog.querySelectorAll('[role="option"]')]
  return {
    query: input ? input.value : null,
    inputFocused: document.activeElement === input,
    count: options.length,
    selected: options.findIndex((o) => o.getAttribute('aria-selected') === 'true'),
    titles: options.map((o) => o.getAttribute('title')),
    shown: options.map((o) => o.innerText.replace(/\\s+/g, ' ').trim()),
  }
})()`

/** 聚焦檔案樹的第一列 —— 那是側欄之內一個真實可聚焦的元素（它帶 tabIndex）。 */
const FOCUS_FILE_TREE = `(() => {
  const row = document.querySelector('section[aria-label="${copy('files.label')}"] [role="treeitem"]')
  if (!row) return false
  row.focus()
  return document.activeElement === row
})()`

/**
 * 當前在檔案檢視器中開啟的檔案（麵包屑文字）。`null` ＝ 仍在檔案樹。
 *
 * **判準是「檔案樹還在不在」，不是「麵包屑有沒有文字」** —— 麵包屑在兩種狀態下都存在，
 * 以它的文字判定會讓「未開啟任何檔案」恆為假（實測：那條斷言因此紅了，而產品是對的）。
 * 檔案樹與檢視器是互斥渲染的，那才是兩種狀態真正的差別。
 */
const OPENED_FILE = `(() => {
  const panel = document.querySelector('section[aria-label="${copy('files.label')}"]')
  if (!panel) return null
  if (panel.querySelector('[role="treeitem"]')) return null
  const nav = panel.querySelector('nav')
  if (!nav) return null
  const text = nav.innerText.replace(/\\s+/g, ' ').trim()
  return text === '' ? null : text
})()`

/**
 * rail 上 repo 的呈現順序。
 *
 * **選擇器必須限定為頂層的 `<li>`** —— session 子列在 DOM 上同樣是 `li > div[role="button"]`
 * （它們巢狀在 folder 的 `<li>` 之內）。少了 `> ul >` 這一段，repo 一有 session，順序就會變成
 * `["▾", "shell 1", "shell 2", …]`（實測：這條斷言因此以「產品把 repo 排錯了」的樣貌紅掉）。
 *
 * 名稱取自 `title`（＝folder 的絕對路徑）的 basename，不取 `innerText` —— 後者的第一行是展開
 * 鈕的 `▾`，不是名稱。
 */
/**
 * rail 上 **folder** 的順序。
 *
 * **排除全域項目**（`global-session`）—— 它恆為第一列，但它不是 workspace 的成員，也沒有路徑
 * 可供 basename 取用（它的 `title` 是一句說明）。少了這道過濾，這份清單的第一項會變成那句
 * 說明的整串文字，而每一條順序斷言都會以「順序錯了」的樣貌失敗。
 */
/**
 * rail 的**捲動容器**。
 *
 * rail 現在有兩個並列的 `<ul>`：置頂段（**不捲動** —— 它位於捲動容器之外，因此不必也不可能
 * 遮擋容器內的目標）與其餘段。以 `aside > ul` 取得會拿到**第一個**，也就是不捲動的那一個 ——
 * 而那個失效的方向是混合的：`scrollHeight > clientHeight` 這類前置會**大聲失敗**，但所有
 * 「SHALL NOT 捲動」的斷言會**安靜地變綠**（沒有東西在動，位置當然不變）。因此以 aria-label
 * 指名，不靠位置。
 */
const RAIL_SCROLL_UL = `document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.folderList')}"]')`

/** rail 上每一列的標題列 —— 跨**兩個** `<ul>`，`querySelectorAll` 回文件順序＝呈現順序。 */
const RAIL_ROW_SEL = `aside[aria-label="${copy('rail.label')}"] > ul > li > div[role="button"]`

const RAIL_ORDER = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li > div[role="button"]')]
  .filter((row) => row.getAttribute('aria-label') !== ${JSON.stringify(copy('rail.globalName'))})
  // The row's aria-label is the item's name; its title is the path plus the most urgent session state
  // (session-wait-indicator), so it no longer reads as a name.
  .map((row) => row.getAttribute('aria-label') ?? '')`

/**
 * rail 兩段各自的項目 —— 置頂狀態就是「它在哪一段」，那正是使用者看到的事實。
 * 置頂段的第一個恆為全域項目。
 */
const RAIL_SECTIONS = `(() => {
  const named = (ul) => [...(ul?.querySelectorAll(':scope > li > div[role="button"]') ?? [])]
    .map((row) => row.getAttribute('aria-label'))
  return {
    pinned: named(document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.pinnedList')}"]')),
    rest: named(document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.folderList')}"]')),
  }
})()`

/** rail 上**全部**項目的 aria-label（含全域項目）—— 導航序以它為準。 */
const RAIL_ITEMS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li > div[role="button"]')]
  .map((row) => row.getAttribute('aria-label'))`

/** 當前選中的 rail 項目（以 aria-label 表示）。 */
const SELECTED_ITEM = `(() => {
  const rows = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li > div[role="button"]')]
  // **以 aria-current 判斷，不以 class** —— 未選中的列帶著 hover:bg-hover/60，而那個字串
  // 也包含 bg-hover：以 class 判斷會恆回第一列，讓期望值為第一列的斷言變成假綠。
  // （此處不得使用反引號 —— 這整段住在一個模板字串裡，反引號會提前把它結束掉。）
  const hit = rows.find((row) => row.getAttribute('aria-current') === 'true')
  return hit ? hit.getAttribute('aria-label') : null
})()`

/** rail 上某個 repo 的 session 子列順序 —— 它必須與分頁列一致（兩個視圖共用同一順序）。 */
const RAIL_SESSIONS = (folderName) => `(() => {
  const list = document.querySelector('ul[aria-label="${copy('rail.folderSessions', { name: '%NAME%' })}"]'
    .replace('%NAME%', ${JSON.stringify(folderName)}))
  if (!list) return null
  return [...list.querySelectorAll('li > div[role="button"]')]
    .map((row) => row.innerText.split('\\n')[0].trim())
})()`

/**
 * Monaco **真的選取了文字**嗎。
 *
 * **不能用 `window.getSelection()`** —— Monaco 的選取不是 DOM selection，它自己畫（與 xterm
 * 同源的坑，`terminal-clipboard` 已經踩過）。它把選取畫成 view overlay 上的 `.selected-text`
 * 元素，那是唯一從外部觀察得到的憑據。
 */
/** Is the side panel maximized? Read from the header entry's `aria-pressed` (either label). */
const SIDE_PANEL_MAXIMIZED = `document.querySelector('[aria-label="${copy('stage.maximizeSidePanel')}"], [aria-label="${copy('stage.restoreSidePanel')}"]')?.getAttribute('aria-pressed') === 'true'`

const EDITOR_LINES = `document.querySelector('section[aria-label="${copy('files.label')}"] .monaco-editor .view-lines')?.innerText ?? null`

const EDITOR_HAS_SELECTION = `Boolean(
  document.querySelector('section[aria-label="${copy('files.label')}"] .monaco-editor .selected-text')
)`

/**
 * > **這裡原本有一條「`Shift+←` 照常抵達對話框的輸入框並選取了文字」的斷言，已移除 —— CDP
 * > 驅動不了它。** 原生 `<input>` 的文字選取是**瀏覽器的預設動作**：`rawKeyDown` 刻意跳過預設
 * > 動作，而 `keyDown` 的編輯命令在 Linux 上來自平台的 key-binding 層，**合成事件繞過它**
 * > （實測：兩種送法的選取長度都恆為 0，與 app 有沒有攔截這顆鍵無關）。留著它就是一盞永遠紅、
 * > 而且測不到自己宣稱在測的東西的燈。
 * >
 * > 「讓位不是『不做事』，而是**完全不攔**」由**編輯器**那一條承擔（見下方 `EDITOR_HAS_SELECTION`）
 * > —— Monaco 在 JS 裡自己處理 keydown，不靠預設動作，因此 CDP 驅動得了它，而且對照組證明它
 * > 有鑑別力：拿掉讓路的判準，那條就變紅。比照 `probe:terminal` 對 OSC 8 `linkHandler` 的處理。
 */

// ── 輸入 ────────────────────────────────────────────────────────────────────

const center = (rect) => ({
  x: Math.round(rect.x + rect.width / 2),
  y: Math.round(rect.y + rect.height / 2),
})

async function realMouse(client, x, y, button = 'left') {
  const buttons = button === 'right' ? 2 : 1
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons, clickCount: 1 })
}

async function realClick(client, rect) {
  const at = center(rect)
  await realMouse(client, at.x, at.y, 'left')
}

/** CDP 的 modifiers 是位元遮罩：Alt=1、Ctrl=2、Meta=4、Shift=8。 */
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  t: { key: 't', code: 'KeyT', vk: 84 },
    w: { key: 'w', code: 'KeyW', vk: 87 },
  h: { key: 'H', code: 'KeyH', vk: 72 },
  m: { key: 'M', code: 'KeyM', vk: 77 },
  p: { key: 'p', code: 'KeyP', vk: 80 },
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  // The zoom keys (`ui-appearance`). With Shift, the main row's `-` is `_` on a US layout.
  equal: { key: '=', code: 'Equal', vk: 187 },
  minus: { key: '-', code: 'Minus', vk: 189 },
  underscore: { key: '_', code: 'Minus', vk: 189 },
  digit0: { key: '0', code: 'Digit0', vk: 48 },
}

/**
 * 送一顆按鍵。`mods` 形如 `['ctrl']`、`['ctrl', 'shift']`。
 *
 * **`rawKeyDown` 而非 `keyDown`**：帶修飾鍵而不產生文字的按鍵，Chromium 的輸入管線走的是
 * raw 事件；用 `keyDown` 並附 `text` 會多出一個 `char` 事件（在終端上就是多打了一個字）。
 *
 * **但 `Enter` 是例外，它必須是 `keyDown` + `text`。** `<button>` 是靠 Enter 的**預設動作**
 * 被觸發的，而 `rawKeyDown` 刻意跳過預設動作 —— 用它送 Enter，按鈕不會有反應（實測：選單裡
 * 按 Enter 完全沒建立 session）。這與 `probe:terminal` 的「Enter 必須是一次真的按鍵事件」
 * 同源：**送不出預設動作的按鍵，等於沒按。**
 */
async function pressKey(client, name, mods = []) {
  const spec = KEYS[name]
  const modifiers = mods.reduce((mask, m) => mask | MOD[m], 0)
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers,
  }

  if (name === 'Enter') {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r' })
  } else {
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(250)
}

async function typeLine(client, text) {
  await client.send('Input.insertText', { text })
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * 開一個 spawn 選單並點其中一項。
 *
 * 兩個站點（分頁列的「+ session」、rail 上全域項目的建立入口）共用它 —— 它們此前是兩份幾乎
 * 一樣的程式碼，各自等入口、各自等項目、各自 throw，而**都不重試**。
 *
 * @param {object} spec `{ entry, entryWindowMs, itemWindowMs, budgetMs, name }`
 */
async function openSpawnMenu(client, itemLabel, { entry, entryWindowMs, itemWindowMs, budgetMs, name }) {
  let clicked = null

  const item = await retryAction({
    act: async () => {
      const btn = await pollUntil(client, entry, (value) => value !== null, entryWindowMs)
      if (!btn) throw new Error(`找不到${name}`)
      clicked = btn
      await realClick(client, btn)
    },
    read: () => client.evaluate(MENU_ITEM_RECT(itemLabel)),
    settled: (value) => value !== null,
    attemptWindowMs: itemWindowMs,
    timeoutMs: budgetMs,
    label: `${name}的 spawn 選單（${itemLabel}）`,
    evidence: () => menuEvidence(client, { expected: itemLabel, clicked }),
  })

  if (!item) throw new Error(`選單中找不到 ${itemLabel}（重試預算 ${budgetMs / 1000}s 耗盡）`)
  await realClick(client, item)
}

async function createSession(client) {
  // **預算 13 秒的推導**：一輪 ＝ 等入口的 10 秒 ＋ 等項目的 3 秒；收斂前是一輪（不重試）。
  return openSpawnMenu(client, copy('sessions.spawnShell'), {
    entry: NEW_SESSION_RECT,
    entryWindowMs: 10_000,
    itemWindowMs: 3000,
    budgetMs: 13_000,
    name: '「+ session」按鈕',
  })
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * quick open（`Ctrl+P`）的驗收。
 *
 * 觸發條件是「按鍵事件行經側欄容器」＝「焦點在側欄之內」。因此每一條斷言之前都要先確定
 * 焦點落在哪裡 —— 那不是前置作業，那就是待測的性質本身。
 *
 * **插在 runMode 的最後**：本段會建立檔案、開啟檔案、切換身分，前面每一條既有斷言都在它之前
 * 跑完（既有紀律：新段落插在既有段落之後，內部用相對數字）。
 */
async function runQuickOpen(label, app, repos) {
  const [, repoAPath] = repos[0]
  mkdirSync(join(repoAPath, 'src'), { recursive: true })
  mkdirSync(join(repoAPath, 'docs'), { recursive: true })
  writeFileSync(join(repoAPath, 'src', 'alpha.ts'), 'x')
  writeFileSync(join(repoAPath, 'src', 'beta.ts'), 'x')
  writeFileSync(join(repoAPath, 'docs', 'alpha-notes.md'), 'x')

  check(results, `${label}：quick open 前置 —— 選中 repo-a`,
    (await app.client.evaluate(SELECT_FOLDER('repo-a'))) === true)
  await sleep(400)
  check(results, `${label}：quick open 前置 —— 切至 Files 身分`,
    (await app.client.evaluate(IDENTITY_FILES)) === true)
  await sleep(800)

  const treeFocused = await pollUntil(app.client, FOCUS_FILE_TREE, (v) => v === true, 8000)
  check(results, `${label}：quick open 前置 —— 檔案樹取得焦點`, treeFocused === true)

  await pressKey(app.client, 'p', ['ctrl'])
  const opened = await pollUntil(app.client, QUICK_OPEN, (v) => v !== null, 8000)
  check(results, `${label}：檔案樹持有焦點時 Ctrl+P 開啟 quick open`,
    opened !== null && opened.inputFocused === true, JSON.stringify(opened))

  await app.client.send('Input.insertText', { text: 'alpha' })
  const filtered = await pollUntil(app.client, QUICK_OPEN,
    (v) => v !== null && v.query === 'alpha' && v.count > 0, 8000)
  check(results, `${label}：輸入片段即時篩選出相符的檔案`,
    filtered !== null && filtered.count === 2, JSON.stringify(filtered))
  check(results, `${label}：檔名命中排在路徑中段命中之前`,
    filtered !== null && filtered.titles[0] === 'src/alpha.ts', JSON.stringify(filtered && filtered.titles))

  await pressKey(app.client, 'ArrowDown')
  const moved = await app.client.evaluate(QUICK_OPEN)
  check(results, `${label}：↓ 移動選取`, moved !== null && moved.selected === 1, JSON.stringify(moved))

  await pressKey(app.client, 'p', ['ctrl'])
  await sleep(400)
  const reentered = await app.client.evaluate(QUICK_OPEN)
  check(results, `${label}：開啟期間再按 Ctrl+P 不重新開啟、不清空查詢`,
    reentered !== null && reentered.query === 'alpha' && reentered.selected === 1,
    JSON.stringify(reentered))

  await pressKey(app.client, 'Escape')
  await sleep(400)
  const quickOpenAfterEsc = await app.client.evaluate(QUICK_OPEN)
  const openedAfterEsc = await app.client.evaluate(OPENED_FILE)
  check(results, `${label}：Esc 關閉入口且未開啟任何檔案`,
    quickOpenAfterEsc === null && openedAfterEsc === null,
    `quick open=${JSON.stringify(quickOpenAfterEsc)}；開啟的檔案=${JSON.stringify(openedAfterEsc)}`)

  await pressKey(app.client, 'p', ['ctrl'])
  const reopened = await pollUntil(app.client, QUICK_OPEN, (v) => v !== null, 8000)
  check(results, `${label}：關閉後可再次以同一顆快捷鍵開啟（焦點已歸還側欄）`,
    reopened !== null, JSON.stringify(reopened))

  await app.client.send('Input.insertText', { text: 'beta' })
  await pollUntil(app.client, QUICK_OPEN, (v) => v !== null && v.count === 1, 8000)
  await pressKey(app.client, 'Enter')
  const viewing = await pollUntil(app.client, OPENED_FILE, (v) => v !== null && v.includes('beta.ts'), 8000)
  check(results, `${label}：Enter 於側欄的 Files 檢視開啟選取的檔案`,
    viewing !== null, JSON.stringify(viewing))
  check(results, `${label}：開啟後入口已關閉`, (await app.client.evaluate(QUICK_OPEN)) === null)

  await pressKey(app.client, 'p', ['ctrl'])
  const afterOpen = await pollUntil(app.client, QUICK_OPEN, (v) => v !== null, 8000)
  check(results, `${label}：開啟檔案後可再次以同一顆快捷鍵開啟（記住的元素已消失，焦點退回側欄容器）`,
    afterOpen !== null, JSON.stringify(afterOpen))
  await pressKey(app.client, 'Escape')
  await sleep(300)

  // ── 終端持有焦點時讓路給 pty
  //
  // **兩條斷言缺一不可。** 只驗「入口沒開」的話，一個「攔下按鍵但不開入口」的錯誤實作照樣
  // 通過；只驗「按鍵抵達 pty」的話，一個「兩件事都做」的實作也會通過。
  //
  // 載體是 `cat -A`（不是 `cat -v`）—— 既有紀律。`Ctrl+P` ＝ `0x10`，`-v` 會把它印成 `^P`。
  await createSession(app.client)
  const term = await pollUntil(app.client, TERMINAL_RECT, (v) => v !== null, 10_000)
  await sleep(2000)
  await realClick(app.client, term)
  await sleep(200)

  const keyLog = join(ptyOutDir, 'quickopen-keys.txt')
  await typeLine(app.client, `cat -A > ${keyLog}`)
  await sleep(1200)

  await pressKey(app.client, 'p', ['ctrl'])
  await sleep(500)
  check(results, `${label}：終端持有焦點時 Ctrl+P 不開啟 quick open`,
    (await app.client.evaluate(QUICK_OPEN)) === null)

  // tty 處於 canonical mode，沒有換行那些位元組不會離開行緩衝 —— 補一顆 Enter 才會落檔。
  await pressEnter(app.client)
  const ptyText = await waitForPtyFile('quickopen-keys.txt', (v) => v.includes('^P'), 8000)
  check(results, `${label}：Ctrl+P 照常抵達 pty（讓路，而非攔下不用）`,
    ptyText.includes('^P'), JSON.stringify(ptyText))
}

async function runMode(label, { port, rendererUrl }) {
  console.log(`\n── ${label} ──`)

  const repos = makeFixture()
  const profile = seedProfile(repos)
  const app = await launch({ port, profileDir: profile, rendererUrl })

  try {
    check(results, `${label}：app 掛載`, app.mounted?.ok === true, describeMounted(app.mounted))

    // ── renderer 的 console 錯誤進得了收集器
    //
    // **這一條驗的是驗收工具自己**，不是產品 —— 它是 `probe-execution-scope` 的一部分。放在這裡
    // 而不是 `probe:shell`，是因為出貨的讀取路徑是「`sections.mjs` 於段落結束時印出」，而
    // `probe-shell` 沒有段落機制；在那裡只能驗一個沒有人在用的存取器。
    //
    // **標記在 connect 之後發出，而那不構成假綠** —— 這一點是實測過的，不是推論：Chromium 的
    // `Runtime` 與 `Log` 兩個 domain 都會緩衝訊息並在 `enable` 時重播（見 `lib/cdp.mjs` 的
    // `subscribeConsole`），所以「enable 之前」與「enable 之後」走的是同一條管道。若當初推論
    // 「enable 之後才開始收」而據此設計驗收，反而會漏掉真正重要的那半段。
    await app.client.evaluate(`console.error('PROBE_CONSOLE_SENTINEL'); void 0`)
    const collected = await pollFor({
      read: () => sectionConsole(),
      settled: (entries) => entries.some((e) => e.text.includes('PROBE_CONSOLE_SENTINEL')),
      timeoutMs: 3000,
      interval: 100,
      label: 'console 收集器收到標記',
    })
    check(
      results,
      `${label}：renderer 的 console 錯誤進得了探針的收集器`,
      collected.some((e) => e.text.includes('PROBE_CONSOLE_SENTINEL') && e.level === 'error'),
      `本段收到 ${collected.length} 則：${JSON.stringify(collected.map((e) => e.text.slice(0, 40)))}`,
    )

    // ── 還沒選中任何 repo 時，Ctrl+T 為無操作
    //
    // 這個狀態下「+ session」按鈕根本不在 DOM 裡 —— 驗的是它不會炸，也不會憑空生出一個選單。
    await pressKey(app.client, 't', ['ctrl'])
    await sleep(500)
    const menuWithoutRepo = await app.client.evaluate(MENU_STATE)
    const mountedWithoutRepo = await app.client.evaluate(MOUNTED)
    check(
      results,
      `${label}：沒有選中的 repo 時，Ctrl+T 為無操作且 app 不崩潰`,
      menuWithoutRepo === null && mountedWithoutRepo?.ok === true,
      `選單=${JSON.stringify(menuWithoutRepo)}；${describeMounted(mountedWithoutRepo) || '掛載正常'}`,
    )

    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    // ── 三個 session，標籤為 shell 1 / 2 / 3（login shell 不採用 pty 的標題，標籤是穩定的）
    for (let i = 0; i < 3; i++) {
      await createSession(app.client)
      await pollUntil(app.client, TABS, (value) => value.length === i + 1, 10_000)
    }
    const tabs = await app.client.evaluate(TABS)
    check(
      results,
      `${label}：repo-a 有三個 session`,
      tabs.length === 3,
      JSON.stringify(tabs.map((t) => t.label)),
    )

    // ── Ctrl+Tab：下一個 session（位置序、可循環）
    await realClick(app.client, await app.client.evaluate(TAB_RECT(0)))
    await sleep(200)

    await pressKey(app.client, 'Tab', ['ctrl'])
    const afterNext = await pollUntil(app.client, FOCUSED_TAB, (v) => v?.includes('shell 2'), 4000)
    check(
      results,
      `${label}：Ctrl+Tab 切至下一個 session`,
      afterNext?.includes('shell 2'),
      String(afterNext),
    )

    await pressKey(app.client, 'Tab', ['ctrl', 'shift'])
    const afterPrev = await pollUntil(app.client, FOCUSED_TAB, (v) => v?.includes('shell 1'), 4000)
    check(
      results,
      `${label}：Ctrl+Shift+Tab 切至上一個 session`,
      afterPrev?.includes('shell 1'),
      String(afterPrev),
    )

    // 於首端往回 → 循環到最後一個
    await pressKey(app.client, 'Tab', ['ctrl', 'shift'])
    const wrapped = await pollUntil(app.client, FOCUSED_TAB, (v) => v?.includes('shell 3'), 4000)
    check(results, `${label}：於首端往回會循環到最後一個`, wrapped?.includes('shell 3'), String(wrapped))

    // ── **位置序，不是 MRU** —— 這條是唯一能把兩者區分開的斷言
    //
    // 先聚焦第三個、再聚焦第一個，然後按 Ctrl+Tab：
    //   位置序 → 第二個（第一個的下一個）
    //   MRU   → 第三個（上一個待過的）
    // 少了這條，寫成 MRU 的實作也會全綠。
    await realClick(app.client, await app.client.evaluate(TAB_RECT(2)))
    await sleep(200)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(0)))
    await sleep(200)
    await pressKey(app.client, 'Tab', ['ctrl'])
    const positional = await pollUntil(app.client, FOCUSED_TAB, (v) => v !== null, 4000)
    check(
      results,
      `${label}：Ctrl+Tab 依分頁位置序，而非最近使用順序`,
      positional?.includes('shell 2'),
      `${positional}（MRU 的話會是 shell 3）`,
    )

    // ── 被攔下的按鍵**不得抵達 pty**
    //
    // **斷言必須有正對照組。** 先送一顆**不帶 Ctrl** 的 ↑，證明方向鍵本來就到得了 pty
    //（`cat -v` 會把它印成 `^[[A`）；否則「沒看到 ^[[1;5A」可能只是因為那條路本來就不通。
    const term = await pollUntil(app.client, TERMINAL_RECT, (value) => value !== null, 10_000)
    await sleep(2000) // 等 shell 畫出 prompt
    await realClick(app.client, term)
    await sleep(200)
    // **載體是 `cat -A`，不是 `cat -v` —— 這個差別是承重的。**
    //
    // `-v` 只處理 nonprinting 字元，**它不 escape Tab**（那要 `-T`）。而 `Ctrl+Tab` 未被攔截時
    // 送出的正是 `\x09`（Tab ＝ Ctrl+I）—— 實測：送 `\x09` 到 pty，`cat -v` 那邊出現的是**字面的
    // tab**，`^I` **永不出現**。於是舊版那條 `leaked` 裡的 `'^I'` **從來沒有機會命中**：
    // **`Ctrl+Tab` 若外洩進 pty，這支探針抓不到**，而 `Ctrl+Tab` 正是本能力的頭號快捷鍵。
    // `-A` ＝ `-vET`，Tab 才會顯示為 `^I`（行尾則顯示為 `$`）。
    await typeLine(app.client, `cat -A > ${join(ptyOutDir, 'keys.txt')}`)
    await sleep(1000)

    await pressKey(app.client, 'ArrowUp') // 對照組：不帶 Ctrl
    await pressEnter(app.client) // 沖掉 tty 的行緩衝，那一行才會進 cat
    const controlText = await waitForPtyFile('keys.txt', (value) => value.includes('^[[A'))
    check(
      results,
      `${label}：對照組 —— 未攔截的方向鍵確實抵達 pty`,
      controlText.includes('^[[A'),
      `（沒有這條，下一條的「沒看到垃圾」證明不了任何事）檔案=${JSON.stringify(controlText.slice(-24))}`,
    )

    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await pressKey(app.client, 'Tab', ['ctrl'])
    await pressKey(app.client, 'Tab', ['ctrl', 'shift'])
    await sleep(1200)

    // 切回原本那個 session 才送得出沖行緩衝的 Enter
    await realClick(app.client, await app.client.evaluate(TAB_RECT(1)))
    await sleep(400)
    await pressEnter(app.client)
    await sleep(600)
    const ptyText = await waitForPtyFile('keys.txt', () => true, 1500)
    const leaked = ['^[[1;5A', '^[[1;5B', '^I'].filter((seq) => ptyText.includes(seq))
    check(
      results,
      `${label}：被攔下的按鍵沒有流進 pty`,
      // **`ptyText !== ''` 不是贅字，是哨兵。** 這是一條**否定式**斷言 —— 觀測管道整個失效時
      // `leaked` 必為空，於是它會在「什麼都沒觀測到」的情況下發綠燈。必須先證明「這條管道
      // 讀得到東西」，「沒讀到垃圾」才有意義。（`Shift+arrow` 那條一直有這個哨兵，這條沒有。）
      leaked.length === 0 && ptyText !== '',
      leaked.length
        ? `外洩：${leaked.join(' ')}`
        : `（檔案 ${ptyText.length} 字元，其中不含被攔下的序列）`,
    )

    // ── Ctrl+↓ / Ctrl+↑：切換 repo（可循環）
    const before = await app.client.evaluate(SELECTED_FOLDER)
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    const nextRepo = await pollUntil(app.client, SELECTED_FOLDER, (v) => v?.includes('repo-b'), 4000)
    check(
      results,
      `${label}：Ctrl+↓ 切至下一個 repo`,
      nextRepo?.includes('repo-b'),
      `${before} → ${nextRepo}`,
    )

    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    const prevRepo = await pollUntil(app.client, SELECTED_FOLDER, (v) => v?.includes('repo-a'), 4000)
    check(results, `${label}：Ctrl+↑ 切回上一個 repo`, prevRepo?.includes('repo-a'), String(prevRepo))

    /*
      **這條斷言隨規格更新過。**

      此前它是「於首端往上會循環到最後一個 repo」—— 那在 rail 的項目集合恰等於 folder 清單時
      成立。`global-session` 之後，rail 的第一個項目是那個不隸屬任何 folder 的全域項目，於是
      自第一個 folder 往上抵達的是**它**，再往上才循環到最後一個 repo。

      兩步都驗：少了第一步，「循環」與「跳過全域項目」在結果上分不開。
    */
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    const atGlobalFromFirst = await pollUntil(
      app.client,
      SELECTED_ITEM,
      (v) => v === copy('rail.globalName'),
      4000,
    )
    check(
      results,
      `${label}：自第一個 folder 往上抵達全域項目`,
      atGlobalFromFirst === copy('rail.globalName'),
      String(atGlobalFromFirst),
    )

    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    const wrappedRepo = await pollUntil(app.client, SELECTED_FOLDER, (v) => v?.includes('repo-c'), 4000)
    check(
      results,
      `${label}：自全域項目往上會循環到最後一個 repo`,
      wrappedRepo?.includes('repo-c'),
      String(wrappedRepo),
    )

    // ── 切回 repo：focused session 落在**最後聚焦過**的那一個，且滑鼠與鍵盤落點相同
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 6000)
    await sleep(400)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(2)))
    await sleep(300)
    const parked = await app.client.evaluate(FOCUSED_TAB)

    // 以鍵盤切走再切回
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await sleep(400)
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    const byKeyboard = await pollUntil(app.client, FOCUSED_TAB, (v) => v !== null, 4000)
    check(
      results,
      `${label}：以鍵盤切走再切回，focused session 回到離開時的那一個`,
      byKeyboard === parked && byKeyboard?.includes('shell 3'),
      `離開時=${parked} 回來時=${byKeyboard}`,
    )

    // 以滑鼠切走再切回 —— 落點必須相同（同一個動作不該有兩種行為）
    await pollUntil(app.client, SELECT_FOLDER('repo-b'), (value) => value === true, 6000)
    await sleep(400)
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 6000)
    const byMouse = await pollUntil(app.client, FOCUSED_TAB, (v) => v !== null, 4000)
    check(
      results,
      `${label}：以滑鼠切走再切回，落點與鍵盤相同`,
      byMouse === byKeyboard,
      `鍵盤=${byKeyboard} 滑鼠=${byMouse}`,
    )

    // ── Ctrl+T：開啟建立 session 的入口
    //
    // **位置必須與滑鼠觸發時相同。** 這條才是「走既有入口、不另闢路徑」（design D9）唯一測得
    // 出來的後果 —— 一個自己算座標的實作也會「開得起來」，但選單會錨在別的地方。
    const menuByMouse = await (async () => {
      await realClick(app.client, await app.client.evaluate(NEW_SESSION_RECT))
      const state = await pollUntil(app.client, MENU_STATE, (v) => v !== null, 4000)
      await pressKey(app.client, 'Escape')
      await pollUntil(app.client, MENU_STATE, (v) => v === null, 4000)
      return state
    })()

    await pressKey(app.client, 't', ['ctrl'])
    const menuByKey = await pollUntil(app.client, MENU_STATE, (v) => v !== null, 4000)
    check(
      results,
      `${label}：Ctrl+T 開啟 spawn 選單，且位置與滑鼠觸發時相同`,
      menuByKey !== null &&
        menuByKey.rect.x === menuByMouse.rect.x &&
        menuByKey.rect.y === menuByMouse.rect.y,
      `鍵盤=${JSON.stringify(menuByKey?.rect)} 滑鼠=${JSON.stringify(menuByMouse?.rect)}`,
    )

    check(
      results,
      `${label}：選單開啟時焦點落在第一個選項`,
      menuByKey?.focused === 0,
      `焦點索引=${menuByKey?.focused} 選項=${JSON.stringify(menuByKey?.items)}`,
    )

    // 選單開著時，導航快捷鍵必須讓位 —— 否則使用者正用方向鍵挑選項，Ctrl+Tab 就把畫面切走了
    const focusedBeforeMenu = await app.client.evaluate(FOCUSED_TAB)
    await pressKey(app.client, 'Tab', ['ctrl'])
    await sleep(400)
    const focusedUnderMenu = await app.client.evaluate(FOCUSED_TAB)
    const menuStillOpen = await app.client.evaluate(MENU_STATE)
    check(
      results,
      `${label}：spawn 選單開啟時，導航快捷鍵不生效`,
      focusedUnderMenu === focusedBeforeMenu && menuStillOpen !== null,
      `focused ${focusedBeforeMenu} → ${focusedUnderMenu}；選單仍開著=${menuStillOpen !== null}`,
    )

    // ↓ 到末端會循環回第一項
    await pressKey(app.client, 'ArrowDown')
    const moved = await app.client.evaluate(MENU_STATE)
    await pressKey(app.client, 'ArrowDown')
    const wrappedMenu = await app.client.evaluate(MENU_STATE)
    check(
      results,
      `${label}：選單以 ↓ 移動並於末端循環`,
      moved?.focused === 1 && wrappedMenu?.focused === 0,
      `第一次↓=${moved?.focused} 第二次↓=${wrappedMenu?.focused}（共 ${moved?.items.length} 項）`,
    )

    // Enter 觸發當前選項 —— 移到「進 login shell」再按
    const tabsBeforeEnter = (await app.client.evaluate(TABS)).length
    await pressKey(app.client, 'ArrowDown') // 回到第二項＝「進 login shell」
    await pressKey(app.client, 'Enter')
    const tabsAfterEnter = await pollUntil(
      app.client,
      TABS,
      (value) => value.length === tabsBeforeEnter + 1,
      10_000,
    )
    check(
      results,
      `${label}：以 Enter 觸發選項，真的建立了一個 session`,
      tabsAfterEnter.length === tabsBeforeEnter + 1 &&
        (await app.client.evaluate(MENU_STATE)) === null,
      JSON.stringify(tabsAfterEnter.map((t) => t.label)),
    )

    // ── 被攔下的 Ctrl+T 不得流進 pty（對照組：不帶 Ctrl 的 t 會抵達）
    const termForT = await pollUntil(app.client, TERMINAL_RECT, (value) => value !== null, 10_000)
    await sleep(2000)
    await realClick(app.client, termForT)
    await sleep(200)
    await typeLine(app.client, `cat -A > ${join(ptyOutDir, 'ctrlt.txt')}`)
    await sleep(1000)

    // **判準是 pty 寫出的檔案。** 舊版比對「終端內容有沒有變」—— 那是因為畫面上本來就到處是 t
    // （連命令列自己都有），不能直接找 t。改讀檔之後判準乾淨得多：**每按一次 Enter，`cat` 就多寫
    // 一行；那一行裡有沒有 t，就是「這顆鍵有沒有進 pty」。**
    await pressKey(app.client, 't') // 對照組：不帶 Ctrl
    await pressEnter(app.client)
    const afterPlainT = await waitForPtyFile('ctrlt.txt', (value) => value.includes('t'))
    check(
      results,
      `${label}：對照組 —— 未攔截的 t 確實抵達 pty`,
      afterPlainT.includes('t'),
      `（沒有這條，下一條的「沒有 t」證明不了任何事）檔案=${JSON.stringify(afterPlainT.slice(-16))}`,
    )

    const beforeCtrlT = afterPlainT
    await pressKey(app.client, 't', ['ctrl'])
    await sleep(1000)
    await pressKey(app.client, 'Escape') // 關掉它開出來的選單
    await pollUntil(app.client, MENU_STATE, (v) => v === null, 4000)
    // **焦點要先還給終端，Enter 才送得進 pty。** 選單關掉之後焦點不在終端上（CLAUDE.md 既有的
    // 教訓：「自右鍵選單貼上之後按 Enter 不會執行 —— 焦點還在選單那邊」）。少了這一步，下面那顆
    // Enter 會落空、檔案不會增長 —— 而「沒有新增內容」正是哨兵擋下的東西（實測：它擋下了）。
    await realClick(app.client, termForT)
    await sleep(200)
    await pressEnter(app.client) // 沖行緩衝 —— Ctrl+T 若外洩，那顆 t 就在這一行裡
    await sleep(600)
    const afterCtrlT = await waitForPtyFile('ctrlt.txt', (value) => value.length > beforeCtrlT.length, 4000)
    const addedByCtrlT = afterCtrlT.slice(beforeCtrlT.length)
    check(
      results,
      `${label}：被攔下的 Ctrl+T 沒有流進 pty`,
      // **`length > before` 是哨兵**：它證明那顆 Enter 真的讓 cat 多寫了一行 —— 否則「沒有 t」
      // 只是因為根本什麼都沒寫進來（否定式斷言的老問題）。
      !addedByCtrlT.includes('t') && afterCtrlT.length > beforeCtrlT.length,
      `Ctrl+T 之後新增的內容=${JSON.stringify(addedByCtrlT)}（應只有行尾標記，不含 t）`,
    )

    // ── 0 個 / 1 個 session 時，Ctrl+Tab 為無操作且不得產生錯誤
    //
    // 沒有這兩條，`cycle()` 的邊界（空清單、單元素）就沒人守 —— 而它們正是最容易寫成
    // 除以零、索引越界或無窮迴圈的地方。
    await pollUntil(app.client, SELECT_FOLDER('repo-b'), (value) => value === true, 6000)
    await sleep(400)
    const emptyTabs = await app.client.evaluate(TABS)
    await pressKey(app.client, 'Tab', ['ctrl'])
    await pressKey(app.client, 'Tab', ['ctrl', 'shift'])
    await sleep(400)
    // **issue #19 指名的那一條** —— 它原本沒有 detail，於是三個條件哪個不成立無從得知。
    const tabsAfterCtrlTab = await app.client.evaluate(TABS)
    const mountedAfterCtrlTab = await app.client.evaluate(MOUNTED)
    check(
      results,
      `${label}：repo 沒有 session 時，Ctrl+Tab 為無操作且 app 不崩潰`,
      emptyTabs.length === 0 &&
        tabsAfterCtrlTab.length === 0 &&
        mountedAfterCtrlTab?.ok === true,
      `按之前 ${emptyTabs.length} 個分頁 → 之後 ${tabsAfterCtrlTab.length} 個；` +
        `${describeMounted(mountedAfterCtrlTab) || '掛載正常'}`,
    )

    await createSession(app.client)
    await pollUntil(app.client, TABS, (value) => value.length === 1, 10_000)
    const soleFocused = await app.client.evaluate(FOCUSED_TAB)
    await pressKey(app.client, 'Tab', ['ctrl'])
    await sleep(400)
    const stillSole = await app.client.evaluate(FOCUSED_TAB)
    // **先求值成變數，detail 取自這一次。** 寫成 `(await evaluate(MOUNTED))?.ok === true` 塞在條件
    // 運算式裡，掛載子條件不成立時 detail 一個字都說不出來 —— 而**這條斷言正是 issue #19 那七條
    // 之一**，`shell 1 → shell 1` 只證明了另一個子條件成立。
    const mountedAfterSoleTab = await app.client.evaluate(MOUNTED)
    check(
      results,
      `${label}：repo 只有一個 session 時，Ctrl+Tab 為無操作`,
      stillSole === soleFocused && mountedAfterSoleTab?.ok === true,
      `${soleFocused} → ${stillSole}；${describeMounted(mountedAfterSoleTab) || '掛載正常'}`,
    )

    // ── 最後聚焦的 session 被關掉之後，切回該 repo 落在第一個 session
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 6000)
    await sleep(400)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(2)))
    await sleep(300)

    // 關掉當前 focused（第三個）的那個分頁
    await app.client.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
      const group = tabs[2]?.closest('div[role="presentation"]')
      const close = group?.querySelector('[aria-label^="${prefixOf('sessions.closeSession')}"]')
      if (!close) return false
      close.click()
      return true
    })()`)
    await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)

    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await sleep(400)
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    const afterClosedFocus = await pollUntil(app.client, FOCUSED_TAB, (v) => v !== null, 4000)
    check(
      results,
      `${label}：最後聚焦的 session 被關閉後，切回該 repo 落在第一個 session`,
      afterClosedFocus?.includes('shell 1'),
      String(afterClosedFocus),
    )

    // ── 對話框開啟時，導航快捷鍵讓位（每一種對話框各驗一次）
    const focusedBeforeDialog = await app.client.evaluate(FOCUSED_TAB)

    // (1) session 命名對話框
    const tab0 = center(await app.client.evaluate(TAB_RECT(0)))
    await realMouse(app.client, tab0.x, tab0.y, 'right')
    await pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === true, 4000)

    await pressKey(app.client, 'Tab', ['ctrl'])
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await sleep(400)
    const duringNameDialog = await app.client.evaluate(FOCUSED_TAB)
    const repoDuringDialog = await app.client.evaluate(SELECTED_FOLDER)
    const dialogStillOpen = await app.client.evaluate(DIALOG_OPEN)
    check(
      results,
      `${label}：session 命名對話框開啟時，導航快捷鍵不生效`,
      duringNameDialog === focusedBeforeDialog &&
        repoDuringDialog?.includes('repo-a') &&
        dialogStillOpen === true,
            `focused=${duringNameDialog} repo=${repoDuringDialog} 對話框=${dialogStillOpen}`,
    )
    // Ctrl+Shift+H shares the dialog rule (session-hibernation); its positive control is checkHibernateShortcut.
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    await sleep(400)
    const statusDuringNameDialog = await app.client.evaluate(FOCUSED_STATUS)
    check(results, `${label}：Ctrl+Shift+H does nothing while the session-rename dialog is open`, !statusDuringNameDialog?.includes(copy('sessions.statusDormant')), `status=${JSON.stringify(statusDuringNameDialog)}`)
    // Ctrl+Shift+M too (maximize-panel-and-confirm-close); its positive control is checkMaximizeShortcut.
    await pressKey(app.client, 'm', ['ctrl', 'shift'])
    await sleep(400)
    const maximizedDuringDialog = await app.client.evaluate(SIDE_PANEL_MAXIMIZED)
    const dialogAfterM = await app.client.evaluate(DIALOG_OPEN)
    check(results, `${label}：Ctrl+Shift+M does nothing while the session-rename dialog is open`, maximizedDuringDialog === false && dialogAfterM === true, `maximized=${maximizedDuringDialog} dialog=${dialogAfterM}`)


    // 關掉它（Esc）
    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === false, 4000)

    // (2) files 的對話框（本 change 才補上 role="dialog"，這條就是在守它）
    check(results, `${label}：切至 Files 身分`, (await app.client.evaluate(IDENTITY_FILES)) === true)
    await sleep(500)
    const fileRow = await pollUntil(
      app.client,
      `(() => {
        const rows = [...document.querySelectorAll('section[aria-label="${copy('files.label')}"] [role="treeitem"]')]
        const row = rows.find((r) => r.innerText.includes('notes.txt'))
        if (!row) return null
        const r = row.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })()`,
      (v) => v !== null,
      8000,
    )
    const rowAt = center(fileRow)
    await realMouse(app.client, rowAt.x, rowAt.y, 'right')
    await pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    const filesDialog = await pollUntil(app.client, DIALOG_OPEN, (value) => value === true, 4000)
    check(results, `${label}：files 的對話框帶有 role="dialog"`, filesDialog === true)

    const focusedBeforeFilesDialog = await app.client.evaluate(FOCUSED_TAB)
    await pressKey(app.client, 'Tab', ['ctrl'])
    await sleep(400)
    const duringFilesDialog = await app.client.evaluate(FOCUSED_TAB)
    check(
      results,
      `${label}：files 的對話框開啟時，導航快捷鍵不生效`,
      duringFilesDialog === focusedBeforeFilesDialog,
            `之前=${focusedBeforeFilesDialog} 之後=${duringFilesDialog}`,
    )
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    await sleep(400)
    const statusDuringFilesDialog = await app.client.evaluate(FOCUSED_STATUS)
    check(results, `${label}：Ctrl+Shift+H does nothing while a Files dialog is open`, !statusDuringFilesDialog?.includes(copy('sessions.statusDormant')), `status=${JSON.stringify(statusDuringFilesDialog)}`)


    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === false, 4000)

    // (3) 終端字型設定對話框（`terminal-preferences`）
    //
    // 抑制以 `[role="dialog"]` 的**存在**判定，因此任何遵守這個慣例的新對話框都自動被尊重 ——
    // 但代價是「漏掉 role 的對話框會靜默失效」，所以每一種對話框都要各驗一次（這條紀律寫在
    // `keyboard-navigation` 的 spec 裡）。這是第三個受測載體。
    const settingsAt = center(
      await app.client.evaluate(`(() => {
        const b = document.querySelector('nav[aria-label="${copy('activityBar.label')}"] button[aria-label="${copy('activityBar.settings')}"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })()`),
    )
    await realClick(app.client, { x: settingsAt.x, y: settingsAt.y, width: 1, height: 1 })
    const settingsDialogOpen = await pollUntil(
      app.client,
      `Boolean(document.querySelector('[role="dialog"][aria-label="${copy('settings.title')}"]'))`,
      (value) => value === true,
      4000,
    ).catch(() => false)
    check(results, `${label}：終端字型設定對話框帶有 role="dialog"`, settingsDialogOpen === true)

    const focusedBeforeSettings = await app.client.evaluate(FOCUSED_TAB)
    const repoBeforeSettings = await app.client.evaluate(SELECTED_FOLDER)
    await pressKey(app.client, 'Tab', ['ctrl'])
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await sleep(400)
    const duringSettings = await app.client.evaluate(FOCUSED_TAB)
    const repoDuringSettings = await app.client.evaluate(SELECTED_FOLDER)
    check(
      results,
      `${label}：終端字型設定對話框開啟時，導航快捷鍵不生效`,
      duringSettings === focusedBeforeSettings && repoDuringSettings === repoBeforeSettings,
            `focused=${duringSettings} repo=${repoDuringSettings}`,
    )
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    await sleep(400)
    const statusDuringSettings = await app.client.evaluate(FOCUSED_STATUS)
    check(results, `${label}：Ctrl+Shift+H does nothing while the Settings dialog is open`, !statusDuringSettings?.includes(copy('sessions.statusDormant')), `status=${JSON.stringify(statusDuringSettings)}`)


    await pressKey(app.client, 'Escape')
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === false, 4000)

    // ── 編輯器持有焦點時，快捷鍵仍生效（Monaco 會吃鍵 —— capture 階段才攔得到）
    check(results, `${label}：開啟檔案`, (await app.client.evaluate(OPEN_FILE('notes.txt'))) === true)
    const editorFocused = await pollUntil(
      app.client,
      EDITOR_TEXTAREA_FOCUSED,
      (value) => value === true,
      10_000,
    )
    check(results, `${label}：編輯器取得焦點`, editorFocused === true)

    const beforeEditorKey = await app.client.evaluate(FOCUSED_TAB)
    await pressKey(app.client, 'Tab', ['ctrl'])
    const afterEditorKey = await pollUntil(
      app.client,
      FOCUSED_TAB,
      (v) => v !== beforeEditorKey,
      4000,
    )
    check(
      results,
      `${label}：編輯器持有焦點時，Ctrl+Tab 仍切換 session`,
      afterEditorKey !== beforeEditorKey && afterEditorKey !== null,
      `${beforeEditorKey} → ${afterEditorKey}`,
    )

    // ── Ctrl+Shift+W 關閉當前 session ──────────────────────────────────────
    //
    // 這個 app 沒有對應 Ctrl+T 的關閉快捷鍵，只能點分頁的 ✕。選 Shift 版而非 `Ctrl+W`：後者是
    // zsh／bash 的高頻刪字鍵，且沒有 `Ctrl+T` 的「GNOME Terminal 早已拿走」豁免；`Ctrl+Shift+<字母>`
    // 編碼不出來，pty 內收不到，代價為零（本 change 的 design D1）。
    //
    // **放在 runMode 最後** —— 前面的既有測試對 `shell 1` 等具名分頁有假設（序號不重用，關掉就
    // 回不來，見 CLAUDE.md）。這段跑完 runMode 就 teardown，不會污染任何後續斷言。用相對數字
    // （nBefore/nAfter），不寫死絕對值。
    //
    // 先切回 OpenSpec 身分並選 repo-a —— 前一段既有測試把身分切成了 Files、focus 在編輯器。
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 6000)
    await sleep(400)
    const tabsBeforeClose = await app.client.evaluate(TABS)
    check(
      results,
      `${label}：Ctrl+Shift+W 前置條件（repo-a 至少有 2 個 session）`,
      tabsBeforeClose.length >= 2,
      `tabs=${tabsBeforeClose.length}`,
    )
    const nBeforeClose = tabsBeforeClose.length

    // (1) 關掉當前 focused
    const focusedBeforeClose = await app.client.evaluate(FOCUSED_TAB)
    await pressKey(app.client, 'w', ['ctrl', 'shift'])
    const tabsAfterClose = await pollUntil(
      app.client,
      TABS,
      (list) => list.length === nBeforeClose - 1,
      6000,
    )
    check(
      results,
      `${label}：Ctrl+Shift+W 關閉當前 focused 的 session`,
      tabsAfterClose.length === nBeforeClose - 1 &&
        !tabsAfterClose.some((t) => t.label === focusedBeforeClose),
      `之前 focused=${focusedBeforeClose}、之後 tabs=${JSON.stringify(tabsAfterClose.map((t) => t.label))}`,
    )

    // (2) 終端持有焦點時仍生效，且按鍵不進 pty（capture 攔截的核心保證）
    //     對照組：純 w 進 pty 會改變終端內容 —— 這條的鑑別力承擔了「Ctrl+Shift+W 沒進 pty」
    //     的證明（若它進 pty，終端會多一個 w）。
    const termRect = await pollUntil(app.client, TERMINAL_RECT, (v) => v !== null, 6000)
    await realClick(app.client, termRect)
    await sleep(400)
    await typeLine(app.client, `cat -A > ${join(ptyOutDir, 'ctrlshiftw.txt')}`)
    await sleep(800)
    await pressKey(app.client, 'w')
    await pressEnter(app.client)
    const echoedW = await waitForPtyFile('ctrlshiftw.txt', (v) => v.includes('w'))
    check(
      results,
      `${label}：對照組 —— 未攔截的 w 確實抵達 pty`,
      echoedW.includes('w'),
      `（沒有這條，下一條的意義降為零）檔案=${JSON.stringify(echoedW.slice(-16))}`,
    )

    // 攔截組：終端仍持有焦點，按 Ctrl+Shift+W —— 應該關掉當前 session
    const focusedInTerm = await app.client.evaluate(FOCUSED_TAB)
    const nBeforeTermW = (await app.client.evaluate(TABS)).length
    await pressKey(app.client, 'w', ['ctrl', 'shift'])
    const tabsAfterTermW = await pollUntil(
      app.client,
      TABS,
      (list) => list.length === nBeforeTermW - 1,
      6000,
    )
    check(
      results,
      `${label}：終端持有焦點時 Ctrl+Shift+W 仍關閉 session`,
      tabsAfterTermW.length === nBeforeTermW - 1 &&
        !tabsAfterTermW.some((t) => t.label === focusedInTerm),
      `focused=${focusedInTerm}、剩=${JSON.stringify(tabsAfterTermW.map((t) => t.label))}`,
    )

    // (3) 對話框開啟時不生效 —— 沿用 `[role="dialog"]` 判定
    const nBeforeCreate = (await app.client.evaluate(TABS)).length
    await createSession(app.client)
    await pollUntil(app.client, TABS, (list) => list.length === nBeforeCreate + 1, 8000)
    const tab0RectForDialog = center(await app.client.evaluate(TAB_RECT(0)))
    await realMouse(app.client, tab0RectForDialog.x, tab0RectForDialog.y, 'right')
    await pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === true, 4000)

    const tabsBeforeCtrlShiftWinDialog = await app.client.evaluate(TABS)
    await pressKey(app.client, 'w', ['ctrl', 'shift'])
    await sleep(400)
    const tabsAfterCtrlShiftWinDialog = await app.client.evaluate(TABS)
    const dialogStillOpenForW = await app.client.evaluate(DIALOG_OPEN)
    check(
      results,
      `${label}：對話框開啟時 Ctrl+Shift+W 不生效`,
      tabsAfterCtrlShiftWinDialog.length === tabsBeforeCtrlShiftWinDialog.length &&
        dialogStillOpenForW === true,
      `前=${tabsBeforeCtrlShiftWinDialog.length} 後=${tabsAfterCtrlShiftWinDialog.length} 對話框=${dialogStillOpenForW}`,
    )
  } finally {
    await app.destroy()
  }
}

/**
 * 「workspace 只有一個 folder 時，切換 repo 為無操作」。
 *
 * 這條需要一個**只有一個 folder** 的 workspace，因此得另外起一個 app 實例 —— 它守的是
 * `cycle()` 在單元素清單上的邊界（`(0 + 1) % 1 === 0`，繞回自己）。
 */
/**
 * `Ctrl+Shift+H` hibernates the focused session of the selected rail item (session-hibernation):
 * from the terminal (the key never reaches it), on the global item, with focus in the editor; a
 * no-op without a selection, without a session, and on a dormant or an exited one.
 */
async function checkHibernateShortcut(label, { port, rendererUrl }) {
  const repos = makeFixture()
  const profile = seedProfile(repos)
  const app = await launch({ port, profileDir: profile, rendererUrl })
  const dormantText = copy('sessions.statusDormant')

  try {
    // No selection (cold start): a no-op, and no error.
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    const mountedCold = await app.client.evaluate(MOUNTED)
    check(results, `${label}：Ctrl+Shift+H with no item selected is a no-op`, mountedCold?.ok === true && (await app.client.evaluate(TABS)).length === 0, describeMounted(mountedCold))

    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)
    await createSession(app.client)
    await pollUntil(app.client, TABS, (list) => list.length === 1, 8000)
    await realClick(app.client, await pollUntil(app.client, TERMINAL_RECT, (v) => v !== null, 6000))
    await sleep(400)
    // A listener on the terminal's own input element: an intercepted key never reaches it.
    const armed = await app.client.evaluate(`(() => {
      const target = document.activeElement
      if (!target || target.tagName !== 'TEXTAREA') return false
      window.__hibernateKeyReached = false
      target.addEventListener('keydown', (event) => { if (event.key.toLowerCase() === 'h') window.__hibernateKeyReached = true })
      return true
    })()`)
    check(results, `${label}：precondition: the terminal has focus`, armed === true, `activeElement is a textarea=${armed}`)

    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    const hibernated = await pollUntil(app.client, FOCUSED_STATUS, (status) => Boolean(status?.includes(dormantText)), 6000)
    const reached = await app.client.evaluate('window.__hibernateKeyReached')
    check(
      results,
      `${label}：Ctrl+Shift+H from the terminal hibernates the focused session, and the key does not reach the terminal`,
      Boolean(hibernated?.includes(dormantText)) && reached === false,
      `status=${JSON.stringify(hibernated)} key reached the terminal=${reached}`,
    )

    // On a dormant session: a no-op (still dormant, nothing else changed).
    const tabsBeforeAgain = await app.client.evaluate(TABS)
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    await sleep(400)
    check(
      results,
      `${label}：Ctrl+Shift+H on a dormant session is a no-op`,
      Boolean((await app.client.evaluate(FOCUSED_STATUS))?.includes(dormantText)) &&
        JSON.stringify(await app.client.evaluate(TABS)) === JSON.stringify(tabsBeforeAgain),
      `status=${JSON.stringify(await app.client.evaluate(FOCUSED_STATUS))}`,
    )

    // On an exited session: a no-op (still exited).
    await createSession(app.client)
    await pollUntil(app.client, TABS, (list) => list.length === 2, 8000)
    await realClick(app.client, await pollUntil(app.client, TERMINAL_RECT, (v) => v !== null, 6000))
    await sleep(400)
    await typeLine(app.client, 'exit')
    const exitedText = copy('sessions.statusExited')
    await pollUntil(app.client, FOCUSED_STATUS, (status) => Boolean(status?.includes(exitedText)), 8000)
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    await sleep(400)
    const afterExited = await app.client.evaluate(FOCUSED_STATUS)
    check(results, `${label}：Ctrl+Shift+H on an exited session is a no-op`, Boolean(afterExited?.includes(exitedText)), `status=${JSON.stringify(afterExited)}`)

    // An item without sessions: a no-op, and no error.
    await pollUntil(app.client, SELECT_FOLDER('repo-b'), (value) => value === true, 6000)
    await sleep(300)
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    const mountedEmpty = await app.client.evaluate(MOUNTED)
    check(results, `${label}：Ctrl+Shift+H on an item without sessions is a no-op`, mountedEmpty?.ok === true && (await app.client.evaluate(TABS)).length === 0, describeMounted(mountedEmpty))

    // The global item.
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 6000)
    await sleep(300)
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    await pollUntil(app.client, SELECTED_ITEM, (value) => value === copy('rail.globalName'), 4000)
    await openSpawnMenu(app.client, copy('sessions.spawnShell'), {
      entry: GLOBAL_NEW_SESSION_RECT,
      entryWindowMs: 10_000,
      itemWindowMs: 3000,
      budgetMs: 13_000,
      name: 'the global item new-session entry',
    })
    await pollUntil(app.client, TABS, (list) => list.length === 1, 8000)
    await sleep(500)
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    const globalStatus = await pollUntil(app.client, FOCUSED_STATUS, (status) => Boolean(status?.includes(dormantText)), 6000)
    check(results, `${label}：Ctrl+Shift+H hibernates the focused global session`, Boolean(globalStatus?.includes(dormantText)), `status=${JSON.stringify(globalStatus)}`)

    // With focus in the side panel's editor.
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 6000)
    await sleep(300)
    await createSession(app.client)
    await pollUntil(app.client, TABS, (list) => list.length === 3, 8000)
    await sleep(500)
    check(results, `${label}：switch to the Files identity`, (await app.client.evaluate(IDENTITY_FILES)) === true)
    await pollUntil(app.client, OPEN_FILE('notes.txt'), (value) => value === true, 8000)
    const editorFocused = await pollUntil(app.client, EDITOR_TEXTAREA_FOCUSED, (value) => value === true, 10_000)
    check(results, `${label}：precondition: the editor has focus`, editorFocused === true)
    await pressKey(app.client, 'h', ['ctrl', 'shift'])
    const editorStatus = await pollUntil(app.client, FOCUSED_STATUS, (status) => Boolean(status?.includes(dormantText)), 6000)
    check(results, `${label}：Ctrl+Shift+H takes effect with focus in the editor`, Boolean(editorStatus?.includes(dormantText)), `status=${JSON.stringify(editorStatus)}`)
  } finally {
    await app.destroy()
  }
}

/**
 * `Ctrl+Shift+M` maximizes / restores the side panel (`maximize-panel-and-confirm-close`): with no
 * item selected; from the terminal (the key never reaches it); from the editor while maximized it
 * restores and the editor's content is unchanged. The dialog case is in `runMode`.
 */
async function checkMaximizeShortcut(label, { port, rendererUrl }) {
  const repos = makeFixture()
  const profile = seedProfile(repos)
  const app = await launch({ port, profileDir: profile, rendererUrl })

  try {
    // No selection (cold start): the header is there, so the shortcut works.
    const mountedCold = await pollUntil(app.client, MOUNTED, (value) => value?.ok === true, 10_000)
    await pressKey(app.client, 'm', ['ctrl', 'shift'])
    const coldMax = await pollUntil(app.client, SIDE_PANEL_MAXIMIZED, (value) => value === true, 4000)
    check(results, `${label}：Ctrl+Shift+M works with no rail item selected`, mountedCold?.ok === true && coldMax === true, `maximized=${coldMax} ${describeMounted(mountedCold)}`)
    await pressKey(app.client, 'm', ['ctrl', 'shift'])
    const coldRestored = await pollUntil(app.client, SIDE_PANEL_MAXIMIZED, (value) => value === false, 4000)
    check(results, `${label}：Ctrl+Shift+M again restores`, coldRestored === false, `maximized=${coldRestored}`)

    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)
    await createSession(app.client)
    await pollUntil(app.client, TABS, (list) => list.length === 1, 8000)
    await realClick(app.client, await pollUntil(app.client, TERMINAL_RECT, (v) => v !== null, 6000))
    await sleep(400)
    const armed = await app.client.evaluate(`(() => {
      const target = document.activeElement
      if (!target || target.tagName !== 'TEXTAREA') return false
      window.__maximizeKeyReached = false
      target.addEventListener('keydown', (event) => { if (event.key.toLowerCase() === 'm') window.__maximizeKeyReached = true })
      return true
    })()`)
    check(results, `${label}：precondition: the terminal has focus (maximize)`, armed === true, `activeElement is a textarea=${armed}`)
    await pressKey(app.client, 'm', ['ctrl', 'shift'])
    const maximized = await pollUntil(app.client, SIDE_PANEL_MAXIMIZED, (value) => value === true, 4000)
    const reached = await app.client.evaluate('window.__maximizeKeyReached')
    check(
      results,
      `${label}：Ctrl+Shift+M from the terminal maximizes the side panel, and the key does not reach the terminal`,
      maximized === true && reached === false,
      `maximized=${maximized} key reached the terminal=${reached}`,
    )

    // With focus in the editor while maximized: restores, content unchanged.
    check(results, `${label}：switch to the Files identity (maximize)`, (await app.client.evaluate(IDENTITY_FILES)) === true)
    await pollUntil(app.client, OPEN_FILE('notes.txt'), (value) => value === true, 8000)
    const editorFocused = await pollUntil(app.client, EDITOR_TEXTAREA_FOCUSED, (value) => value === true, 10_000)
    const linesBefore = await pollUntil(app.client, EDITOR_LINES, (value) => typeof value === 'string' && value.length > 0, 6000)
    check(results, `${label}：precondition: maximized with the editor focused`, editorFocused === true && (await app.client.evaluate(SIDE_PANEL_MAXIMIZED)) === true, `editor focused=${editorFocused}`)
    await pressKey(app.client, 'm', ['ctrl', 'shift'])
    const restored = await pollUntil(app.client, SIDE_PANEL_MAXIMIZED, (value) => value === false, 4000)
    const linesAfter = await app.client.evaluate(EDITOR_LINES)
    check(
      results,
      `${label}：Ctrl+Shift+M with focus in the editor restores, and the editor content is unchanged`,
      restored === false && linesAfter === linesBefore,
      `maximized=${restored} content same=${linesAfter === linesBefore}`,
    )
  } finally {
    await app.destroy()
  }
}

async function checkSingleFolder(label, { port, rendererUrl }) {
  const [only] = makeFixture()
  const profile = seedProfile([only])
  const app = await launch({ port, profileDir: profile, rendererUrl })

  try {
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    const before = await app.client.evaluate(SELECTED_FOLDER)
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    await sleep(400)
    const after = await app.client.evaluate(SELECTED_FOLDER)
    const mountedAfterSwitch = await app.client.evaluate(MOUNTED)

    check(
      results,
      `${label}：workspace 只有一個 folder 時，切換 repo 為無操作且 app 不崩潰`,
      after === before && mountedAfterSwitch?.ok === true,
      `${before} → ${after}；${describeMounted(mountedAfterSwitch) || '掛載正常'}`,
    )

    // ── 排序快捷鍵在**單一項目**上的邊界（spec 的 scenario，否則零覆蓋）
    //
    // 這正是最容易寫成索引越界或無窮迴圈的地方 —— 而它在多項目的 fixture 上永遠測不到。
    //
    // **這裡曾經是一盞假綠，而且它撐過了一整輪 9/9。** 原本一次送 `Shift+↓` 再送 `Shift+↑`，
    // 只斷言 `RAIL_ORDER` 不變。置頂能力加進來之後，唯一的那個 folder **永遠與分界相鄰**：
    // `Shift+↑` 會跨過分界**把它置頂**，而 folder 清單的順序**確實沒有變**（`RAIL_ORDER` 只列
    // folder 名稱）—— 斷言照過，fixture 的置頂狀態卻被靜默改掉。
    // 兩個方向因此拆開，各自連**置頂狀態**一起斷言。
    const orderBefore = await app.client.evaluate(RAIL_ORDER)
    const railOrderNow = async () => JSON.stringify(await app.client.evaluate(RAIL_ORDER))

    // 往下：它下面沒有東西（分界在它上面）⇒ 真正的無操作。
    await pressKey(app.client, 'ArrowDown', ['shift'])
    await sleep(400)
    const afterDown = await app.client.evaluate(RAIL_SECTIONS)
    const mountedAfterDown = await app.client.evaluate(MOUNTED)
    check(
      results,
      `${label}：只有一個 folder 且該次移動不跨越分界時，排序快捷鍵為無操作且 app 不崩潰`,
      (await railOrderNow()) === JSON.stringify(orderBefore) &&
        JSON.stringify(afterDown?.rest) === JSON.stringify(['repo-a']) &&
        mountedAfterDown?.ok === true,
      `${JSON.stringify(orderBefore)} / ${JSON.stringify(afterDown)}；${describeMounted(mountedAfterDown) || '掛載正常'}`,
    )

    // 往上：跨過分界 ⇒ 置頂。**順序仍然不變** —— 那正是上面那盞假綠的來源，因此這條斷言的
    // 鑑別力全部落在置頂狀態上。
    await pressKey(app.client, 'ArrowUp', ['shift'])
    const afterUp = await pollUntil(
      app.client,
      RAIL_SECTIONS,
      (v) => v !== null && v.pinned.length === 2,
      4000,
    )
    const mountedAfterUp = await app.client.evaluate(MOUNTED)
    check(
      results,
      `${label}：只有一個 folder 時 Shift+↑ 仍跨得過分界（置頂），且順序不變、app 不崩潰`,
      JSON.stringify(afterUp?.pinned) === JSON.stringify([copy('rail.globalName'), 'repo-a']) &&
        JSON.stringify(afterUp?.rest) === JSON.stringify([]) &&
        (await railOrderNow()) === JSON.stringify(orderBefore) &&
        mountedAfterUp?.ok === true,
      `${JSON.stringify(afterUp)}；${describeMounted(mountedAfterUp) || '掛載正常'}`,
    )

    // 還原成未置頂 —— 這一段其後的斷言以它為前提。
    await pressKey(app.client, 'ArrowDown', ['shift'])
    await pollUntil(app.client, RAIL_SECTIONS, (v) => v !== null && v.pinned.length === 1, 4000)

    await createSession(app.client)
    const soleTab = await pollUntil(app.client, TABS, (value) => value.length === 1, 10_000)
    await pressKey(app.client, 'ArrowRight', ['shift'])
    await pressKey(app.client, 'ArrowLeft', ['shift'])
    await sleep(400)
    const stillSole = await app.client.evaluate(TABS)
    const mountedAfterTabReorder = await app.client.evaluate(MOUNTED)
    check(
      results,
      `${label}：repo 只有一個 session 時，排序快捷鍵為無操作且 app 不崩潰`,
      stillSole.length === 1 &&
        stillSole[0].label === soleTab[0].label &&
        mountedAfterTabReorder?.ok === true,
      `${JSON.stringify(stillSole.map((t) => t.label))}；${describeMounted(mountedAfterTabReorder) || '掛載正常'}`,
    )
  } finally {
    await app.destroy()
  }
}

/**
 * 排序快捷鍵（`Shift+↑↓` 排 repo、`Shift+←→` 排 session）。
 *
 * 自己起一個 app 實例：這組驗收要在**已知的初始順序**上做，混進上面那條長流程裡會被它切換
 * repo／關分頁的一連串動作污染。
 */
async function checkReordering(label, { port, rendererUrl }) {
  const repos = makeFixture()
  const profile = seedProfile(repos)
  const app = await launch({ port, profileDir: profile, rendererUrl })

  try {
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    // ── Shift+↓ / Shift+↑：移動選中的 repo
    const initialOrder = await app.client.evaluate(RAIL_ORDER)
    check(
      results,
      `${label}：rail 的初始順序為加入的先後`,
      JSON.stringify(initialOrder) === JSON.stringify(['repo-a', 'repo-b', 'repo-c']),
      JSON.stringify(initialOrder),
    )

    await pressKey(app.client, 'ArrowDown', ['shift'])
    const movedDown = await pollUntil(
      app.client,
      RAIL_ORDER,
      (value) => value[0] === 'repo-b',
      4000,
    )
    check(
      results,
      `${label}：Shift+↓ 把選中的 repo 往下移動一格`,
      JSON.stringify(movedDown) === JSON.stringify(['repo-b', 'repo-a', 'repo-c']),
      JSON.stringify(movedDown),
    )

    // **選中的是那個 repo，不是那個位置。**
    check(
      results,
      `${label}：移動後仍是同一個 repo 被選中`,
      (await app.client.evaluate(SELECTED_FOLDER))?.includes('repo-a'),
      String(await app.client.evaluate(SELECTED_FOLDER)),
    )

    await pressKey(app.client, 'ArrowUp', ['shift'])
    const movedBack = await pollUntil(app.client, RAIL_ORDER, (value) => value[0] === 'repo-a', 4000)
    check(
      results,
      `${label}：Shift+↑ 把它移回原位`,
      JSON.stringify(movedBack) === JSON.stringify(['repo-a', 'repo-b', 'repo-c']),
      JSON.stringify(movedBack),
    )

    // ── 分界本身算一格：往上跨過它就是置頂（rail-pinning）
    //
    // **這一格取代了此前那條「已在頂端時 Shift+↑ 為無操作」。** 置頂能力加進來之後，
    // 第一個 folder 的上方不再是端點 —— 那裡是分界。此前那條斷言只看「順序不變」，
    // 而跨界時順序**確實不變**（動的是置頂狀態）：它會保持綠燈，同時**讓 fixture 的置頂狀態
    // 被靜默改掉**，其後每一條斷言都建立在被污染的狀態上（實測發生過，這就是那次的修正）。
    await pressKey(app.client, 'ArrowUp', ['shift'])
    const pinnedByKey = await pollUntil(
      app.client,
      RAIL_SECTIONS,
      (v) => v.pinned.length === 2,
      4000,
    )
    check(
      results,
      `${label}：Shift+↑ 跨過分界 ⇒ 該 repo 被置頂（順序不變，動的是置頂狀態）`,
      JSON.stringify(pinnedByKey.pinned) === JSON.stringify(['Global', 'repo-a']) &&
        JSON.stringify(pinnedByKey.rest) === JSON.stringify(['repo-b', 'repo-c']),
      JSON.stringify(pinnedByKey),
    )

    // ── 端點**不循環** —— 這是與導航快捷鍵刻意不同的地方（design D3）
    //
    // 少了這條，一個「照抄 cycle()」的實作也會全綠 —— 而它會把第一名丟到最後一名。
    // **端點是「置頂段的第一個」**，而且要一併斷言置頂狀態沒變 —— 只看順序的話，一個
    // 「循環到末端並順手取消置頂」的實作在這裡是分不出來的。
    await pressKey(app.client, 'ArrowUp', ['shift'])
    await sleep(500)
    const atTop = await app.client.evaluate(RAIL_ORDER)
    const atTopSections = await app.client.evaluate(RAIL_SECTIONS)
    check(
      results,
      `${label}：已在置頂段頂端時 Shift+↑ 為無操作（不循環、置頂狀態也不變）`,
      JSON.stringify(atTop) === JSON.stringify(['repo-a', 'repo-b', 'repo-c']) &&
        JSON.stringify(atTopSections.pinned) === JSON.stringify(['Global', 'repo-a']),
      `${JSON.stringify(atTop)} / ${JSON.stringify(atTopSections)}（循環的話會變成 repo-b, repo-c, repo-a）`,
    )

    // ── 往下跨過分界 ⇒ 取消置頂。順帶把 fixture 還原成「全部未置頂」，後面的段落以它為前提。
    await pressKey(app.client, 'ArrowDown', ['shift'])
    const unpinnedByKey = await pollUntil(
      app.client,
      RAIL_SECTIONS,
      (v) => v.pinned.length === 1,
      4000,
    )
    check(
      results,
      `${label}：Shift+↓ 跨過分界 ⇒ 取消置頂，且序位不變（不被當作無操作）`,
      JSON.stringify(unpinnedByKey.pinned) === JSON.stringify(['Global']) &&
        JSON.stringify(unpinnedByKey.rest) === JSON.stringify(['repo-a', 'repo-b', 'repo-c']),
      JSON.stringify(unpinnedByKey),
    )

    // ── Shift+→ / Shift+←：移動 focused session
    for (let i = 0; i < 3; i++) {
      await createSession(app.client)
      await pollUntil(app.client, TABS, (value) => value.length === i + 1, 10_000)
    }

    await realClick(app.client, await app.client.evaluate(TAB_RECT(0)))
    await pollUntil(app.client, FOCUSED_TAB, (v) => v?.includes('shell 1'), 4000)

    await pressKey(app.client, 'ArrowRight', ['shift'])
    const tabsMoved = await pollUntil(
      app.client,
      TABS,
      (value) => value[0]?.label.includes('shell 2'),
      4000,
    )
    check(
      results,
      `${label}：Shift+→ 把 focused session 往右移動一格`,
      tabsMoved.map((t) => t.label.replace(/\s+/g, ' ').trim()).join(' | ').startsWith('shell 2 | shell 1'),
      JSON.stringify(tabsMoved.map((t) => t.label)),
    )

    check(
      results,
      `${label}：移動後仍是同一個 session 被 focused`,
      (await app.client.evaluate(FOCUSED_TAB))?.includes('shell 1'),
      String(await app.client.evaluate(FOCUSED_TAB)),
    )

    // 兩個視圖共用同一個順序 —— rail 的 session 子列必須跟著改
    const railSessions = await app.client.evaluate(RAIL_SESSIONS('repo-a'))
    const tabOrder = (await app.client.evaluate(TABS)).map((t) => t.label)
    check(
      results,
      `${label}：rail 的 session 子列呈現相同的新順序`,
      railSessions !== null &&
        JSON.stringify(railSessions) === JSON.stringify(tabOrder),
      `rail=${JSON.stringify(railSessions)} 分頁=${JSON.stringify(tabOrder)}`,
    )

    await pressKey(app.client, 'ArrowLeft', ['shift'])
    const tabsBack = await pollUntil(
      app.client,
      TABS,
      (value) => value[0]?.label.includes('shell 1'),
      4000,
    )
    check(
      results,
      `${label}：Shift+← 把它移回原位`,
      tabsBack[0]?.label.includes('shell 1'),
      JSON.stringify(tabsBack.map((t) => t.label)),
    )

    await pressKey(app.client, 'ArrowLeft', ['shift'])
    await sleep(500)
    const atLeftEnd = await app.client.evaluate(TABS)
    check(
      results,
      `${label}：已在最左時 Shift+← 為無操作（不循環到末端）`,
      atLeftEnd[0]?.label.includes('shell 1'),
      `${JSON.stringify(atLeftEnd.map((t) => t.label))}（循環的話 shell 1 會跑到最後）`,
    )

    // ── 終端持有焦點時仍生效，且該按鍵**不得抵達 pty**
    //
    // 終端是這個 app 的常態焦點 —— 這條若失敗，這兩顆快捷鍵等於不存在。
    const term = await pollUntil(app.client, TERMINAL_RECT, (value) => value !== null, 10_000)
    await sleep(2000)
    await realClick(app.client, term)
    await sleep(200)
    await typeLine(app.client, `cat -A > ${join(ptyOutDir, 'shiftarrow.txt')}`)
    await sleep(1000)

    const orderBeforeTerminalKey = await app.client.evaluate(RAIL_ORDER)
    await pressKey(app.client, 'ArrowDown', ['shift'])
    const orderFromTerminal = await pollUntil(
      app.client,
      RAIL_ORDER,
      (value) => value[0] === 'repo-b',
      4000,
    )
    check(
      results,
      `${label}：終端持有焦點時，Shift+↓ 仍移動 repo`,
      JSON.stringify(orderFromTerminal) === JSON.stringify(['repo-b', 'repo-a', 'repo-c']),
      `${JSON.stringify(orderBeforeTerminalKey)} → ${JSON.stringify(orderFromTerminal)}`,
    )

    // `cat -A` 會把 Shift+arrow 寫成 `^[[1;2A`–`^[[1;2D`。上面那條「對照組：未攔截的方向鍵
    // 確實抵達 pty」在 runMode 已經驗過，這裡驗的是被攔下的那幾顆沒有外洩。
    await pressKey(app.client, 'ArrowRight', ['shift'])
    await pressKey(app.client, 'ArrowLeft', ['shift'])
    await pressEnter(app.client) // 沖行緩衝 —— 外洩的序列就在這一行裡
    await sleep(800)
    const ptyText = await waitForPtyFile('shiftarrow.txt', () => true, 2000)
    const leaked = ['^[[1;2A', '^[[1;2B', '^[[1;2C', '^[[1;2D'].filter((seq) => ptyText.includes(seq))
    check(
      results,
      `${label}：被攔下的 Shift+arrow 沒有流進 pty`,
      // `ptyText !== ''` 是哨兵（這條一直都有，另外兩條否定式斷言先前沒有）。
      leaked.length === 0 && ptyText !== '',
      leaked.length ? `外洩：${leaked.join(' ')}` : `（檔案 ${ptyText.length} 字元，未混入控制序列）`,
    )

    await pressKey(app.client, 'ArrowUp', ['shift']) // 還原 rail 的順序
    await pollUntil(app.client, RAIL_ORDER, (value) => value[0] === 'repo-a', 4000)

    // ── 對話框開啟時不排序，且該按鍵**照常抵達對話框的輸入框**
    //
    // 後半段是這條的重點：讓位不只是「不做事」，而是**完全不攔** —— 使用者在輸入框裡按
    // `Shift+←` 就是要選字。
    const tab0 = center(await app.client.evaluate(TAB_RECT(0)))
    await realMouse(app.client, tab0.x, tab0.y, 'right')
    await pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === true, 4000)

    const orderBeforeDialog = await app.client.evaluate(RAIL_ORDER)
    const tabsBeforeDialog = (await app.client.evaluate(TABS)).map((t) => t.label)
    await pressKey(app.client, 'ArrowDown', ['shift'])
    await pressKey(app.client, 'ArrowRight', ['shift'])
    await sleep(400)

    const orderDuringDialog = await app.client.evaluate(RAIL_ORDER)
    check(
      results,
      `${label}：對話框開啟時，排序快捷鍵不生效`,
      JSON.stringify(orderDuringDialog) === JSON.stringify(orderBeforeDialog) &&
        JSON.stringify((await app.client.evaluate(TABS)).map((t) => t.label)) ===
          JSON.stringify(tabsBeforeDialog) &&
        (await app.client.evaluate(DIALOG_OPEN)) === true,
      JSON.stringify(orderDuringDialog),
    )

    await pressKey(app.client, 'Escape')
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === false, 4000)

    // ── 編輯器持有焦點時，Shift+arrow **仍是文字選取**（排序快捷鍵讓路）
    //
    // 這是本 change 最容易靜默壞掉的地方：判準若寫成「activeElement 是不是 textarea」，
    // 快捷鍵會在終端上完全失效；漏掉這個例外，編輯器裡連選一個字元都做不到。
    // **兩個方向都要驗** —— 上面驗了終端那一邊。
    check(results, `${label}：切至 Files 身分`, (await app.client.evaluate(IDENTITY_FILES)) === true)
    await sleep(500)
    check(results, `${label}：開啟檔案`, (await app.client.evaluate(OPEN_FILE('notes.txt'))) === true)
    const editorFocused = await pollUntil(
      app.client,
      EDITOR_TEXTAREA_FOCUSED,
      (value) => value === true,
      10_000,
    )
    check(results, `${label}：編輯器取得焦點`, editorFocused === true)

    const orderBeforeEditor = await app.client.evaluate(RAIL_ORDER)
    const tabsBeforeEditor = (await app.client.evaluate(TABS)).map((t) => t.label)
    await pressKey(app.client, 'ArrowRight', ['shift'])
    await pressKey(app.client, 'ArrowRight', ['shift'])
    const selected = await pollUntil(app.client, EDITOR_HAS_SELECTION, (value) => value === true, 4000)

    check(
      results,
      `${label}：編輯器持有焦點時，Shift+→ 仍是文字選取`,
      selected === true,
      selected === true ? '' : '（編輯器沒有選取到任何文字 —— 排序快捷鍵把它吃掉了）',
    )
    check(
      results,
      `${label}：編輯器持有焦點時，Shift+→ 不排序`,
      JSON.stringify(await app.client.evaluate(RAIL_ORDER)) === JSON.stringify(orderBeforeEditor) &&
        JSON.stringify((await app.client.evaluate(TABS)).map((t) => t.label)) ===
          JSON.stringify(tabsBeforeEditor),
      JSON.stringify(await app.client.evaluate(RAIL_ORDER)),
    )

    // ── global-session：rail 的項目序涵蓋那個不隸屬任何 folder 的固定項目
    //
    // **插在 runMode 的最後、finally 之前** —— 前面每一段對 session 與選中狀態都有假設，
    // 而這一段會改變選中的項目（既有紀律：新段落放最後，且用相對數字）。
    const GLOBAL = copy('rail.globalName')

    // 上一段把焦點留在編輯器裡，而排序快捷鍵在那裡刻意讓路 —— 點一下 rail 把焦點移出去。
    await app.client.evaluate(SELECT_FOLDER('repo-a'))
    await sleep(300)

    const items = await app.client.evaluate(RAIL_ITEMS)
    check(results, `${label}：全域項目是 rail 的第一個項目`,
      items[0] === GLOBAL && items.length === 4, JSON.stringify(items))

    // 選中第一個 folder，往上一格 ⇒ 抵達全域項目。
    await app.client.evaluate(SELECT_FOLDER('repo-a'))
    await sleep(300)
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    const atGlobal = await pollUntil(app.client, SELECTED_ITEM, (v) => v === GLOBAL, 4000)
    check(results, `${label}：自第一個 folder 按 Ctrl+↑ 抵達全域項目`,
      atGlobal === GLOBAL, String(atGlobal))

    // 於全域項目按 Ctrl+T ⇒ spawn 選單開啟（四顆 session 快捷鍵之一，作用域必須涵蓋它）。
    await pressKey(app.client, 't', ['ctrl'])
    const menuOpen = await pollUntil(app.client, MENU_STATE, (v) => v !== null, 4000)
    check(results, `${label}：於全域項目按 Ctrl+T 開啟 spawn 選單`,
      menuOpen !== null && menuOpen.items.length >= 2, JSON.stringify(menuOpen))
    await pressKey(app.client, 'Escape')
    await sleep(200)

    // Shift+↑↓ 對它無操作 —— 它不是 workspace 的成員，沒有順序可言。
    const orderBeforeGlobalMove = await app.client.evaluate(RAIL_ORDER)
    await pressKey(app.client, 'ArrowDown', ['shift'])
    await sleep(400)
    check(results, `${label}：選中全域項目時 Shift+↓ 無操作`,
      JSON.stringify(await app.client.evaluate(RAIL_ORDER)) === JSON.stringify(orderBeforeGlobalMove) &&
        (await app.client.evaluate(SELECTED_ITEM)) === GLOBAL,
      JSON.stringify(await app.client.evaluate(RAIL_ORDER)))

    // 自最後一個 folder 往下 ⇒ 循環回全域項目。
    await app.client.evaluate(SELECT_FOLDER('repo-c'))
    await sleep(300)
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    const wrapped = await pollUntil(app.client, SELECTED_ITEM, (v) => v === GLOBAL, 4000)
    check(results, `${label}：自最後一個 folder 按 Ctrl+↓ 循環回全域項目`,
      wrapped === GLOBAL, String(wrapped))

    /*
      **四顆 session 快捷鍵在全域項目上都要真的能用，而驗它們需要全域項目真的有 session。**

      此前這一段按完 `Ctrl+T` 就 `Escape`，於是全域項目在整支探針裡 session 數**恆為 0** ——
      「於全域項目內切換 session」那條 scenario 因此不可能被驗到，而對照表卻宣稱它有載體
      （獨立稽核抓到的假載體）。這裡改為真的建兩個 login shell，再依序驗切換、排序、關閉。

      **用相對數字**，且排在全域段落的最後（既有紀律）。
    */
    const globalTabsBefore = (await app.client.evaluate(TABS)).length
    for (let i = 0; i < 2; i += 1) {
      await pressKey(app.client, 't', ['ctrl'])
      await sleep(500)
      await pressKey(app.client, 'ArrowDown')
      await pressKey(app.client, 'Enter')
      await sleep(1500)
    }
    const globalTabs = await pollUntil(
      app.client, TABS, (v) => v.length === globalTabsBefore + 2, 15_000)
    check(results, `${label}：於全域項目建立兩個 session（後三條的前提）`,
      globalTabs.length === globalTabsBefore + 2,
      JSON.stringify(globalTabs.map((tab) => tab.label)))

    // 剛建好時 focused 是最後一個 ⇒ Ctrl+Tab 循環回第一個（於是下一條的 Shift+→ 有得移動）。
    const globalFocusedBefore = await app.client.evaluate(FOCUSED_TAB)
    await pressKey(app.client, 'Tab', ['ctrl'])
    const globalFocusedAfter = await pollUntil(
      app.client, FOCUSED_TAB, (v) => v !== globalFocusedBefore, 4000)
    check(results, `${label}：於全域項目內以 Ctrl+Tab 切換 session`,
      globalFocusedAfter !== null && globalFocusedAfter !== globalFocusedBefore,
      `${globalFocusedBefore} → ${globalFocusedAfter}`)

    const globalOrderBefore = (await app.client.evaluate(TABS)).map((tab) => tab.label)
    await pressKey(app.client, 'ArrowRight', ['shift'])
    const globalOrderAfter = await pollUntil(
      app.client,
      TABS,
      (v) => JSON.stringify(v.map((tab) => tab.label)) !== JSON.stringify(globalOrderBefore),
      4000,
    )
    check(results, `${label}：於全域項目內以 Shift+→ 調整 session 順序`,
      globalOrderAfter !== null &&
        JSON.stringify(globalOrderAfter.map((tab) => tab.label)) !== JSON.stringify(globalOrderBefore) &&
        globalOrderAfter.length === globalOrderBefore.length,
      `${JSON.stringify(globalOrderBefore)} → ${JSON.stringify(globalOrderAfter?.map((tab) => tab.label))}`)

    await pressKey(app.client, 'w', ['ctrl', 'shift'])
    const globalAfterClose = await pollUntil(
      app.client, TABS, (v) => v.length === globalTabsBefore + 1, 8000)
    check(results, `${label}：於全域項目內以 Ctrl+Shift+W 關閉當前 session`,
      globalAfterClose !== null && globalAfterClose.length === globalTabsBefore + 1,
      JSON.stringify(globalAfterClose?.map((tab) => tab.label)))

    /*
      **folder 的排序索引以 folder 清單為基準，不以 rail 的列位置。**

      以列位置計算的失效是兩個方向都錯，而且**三個以上 folder 才看得出來**：兩個時夾制會把
      越界的目標拉回末端，結果與正確實作相同（既有的 off-by-one 就是這樣躲過每一輪驗收的）。
    */
    await app.client.evaluate(SELECT_FOLDER('repo-a'))
    await sleep(300)
    const beforeDown = await app.client.evaluate(RAIL_ORDER)
    await pressKey(app.client, 'ArrowDown', ['shift'])
    const afterDown = await pollUntil(app.client, RAIL_ORDER, (v) => v[0] !== beforeDown[0], 4000)
    check(results, `${label}：第一個 folder 按 Shift+↓ 恰好移動一格`,
      JSON.stringify(afterDown) === JSON.stringify([beforeDown[1], beforeDown[0], beforeDown[2]]),
      `${JSON.stringify(beforeDown)} → ${JSON.stringify(afterDown)}`)

    // 第二個 folder 往上一格 —— 以列位置計算時它會算出等於自己的目標而**靜默無操作**。
    const beforeUp = await app.client.evaluate(RAIL_ORDER)
    await pressKey(app.client, 'ArrowUp', ['shift'])
    const afterUp = await pollUntil(app.client, RAIL_ORDER, (v) => v[0] !== beforeUp[0], 4000)
    check(results, `${label}：第二個 folder 按 Shift+↑ 恰好移動一格（不靜默無操作）`,
      JSON.stringify(afterUp) === JSON.stringify([beforeUp[1], beforeUp[0], beforeUp[2]]),
      `${JSON.stringify(beforeUp)} → ${JSON.stringify(afterUp)}`)

    // ── global-session：鍵盤導航時目標捲入可視範圍（第九次 dogfooding 的第二個回饋）
    //
    // **載體選在這裡而不是 `probe:workspace`**：那支探針送不進 `Ctrl+↓`（實測 `aria-current`
    // 不動而 `scrollTop` 卻變了 —— 那是**未被 preventDefault 時瀏覽器的原生捲動**，不是產品的
    // `scrollIntoView`）。這支的鍵盤驅動則已由前面上百條斷言證明有效。
    //
    // **rail 溢出以壓矮 viewport 達成**，不以「多塞十幾個 folder」—— 後者要改 fixture，而
    // fixture 是全域的，前面每一條絕對斷言都會跟著壞。
    //
    // **高度要重新量，不能沿用。** 置頂段（含全域項目）移出捲動容器之後，捲動容器的內容少了
    // 一列 —— 在原本的 300px 下實測 `max` 只剩 17px，連「把某一列切一半」都造不出來（那條
    // 前提因此變紅）。壓到 240px 之後 `max` 回到可用的範圍。
    await app.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 240,
      deviceScaleFactor: 0,
      mobile: false,
    })
    await sleep(600)

    const RAIL_SCROLLER = `(() => {
      const ul = ${RAIL_SCROLL_UL}
      if (!ul) return null
      return { scrollHeight: ul.scrollHeight, clientHeight: ul.clientHeight, scrollTop: Math.round(ul.scrollTop) }
    })()`

    /** 選中的那一列是否**完整**落在捲動容器內 —— 這是本要求的不變式。 */
    const SELECTED_FULLY_VISIBLE = `(() => {
      const scroller = ${RAIL_SCROLL_UL}
      const rows = [...document.querySelectorAll('${RAIL_ROW_SEL}')]
      const row = rows.find((r) => r.getAttribute('aria-current') === 'true')
      if (!scroller || !row) return null
      // **列與容器要成對取得。** rail 有兩個 <ul>：置頂段（不捲動）與其餘段。選中的若是置頂的
      // repo 或全域項目，它在另一個容器裡 —— 拿其餘段的 rect 去量必然「不可見」，那會對正確的
      // 實作亮紅燈。
      const own = row.closest('ul')
      const a = own.getBoundingClientRect()
      const b = row.getBoundingClientRect()
      return {
        label: row.getAttribute('aria-label'),
        pinnedSection: own !== scroller,
        visible: b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5,
        scrollTop: Math.round(scroller.scrollTop),
      }
    })()`

    const scroller = await pollUntil(app.client, RAIL_SCROLLER, (v) => v !== null, 8000)
    // **`clientHeight > 0` 不是多餘的。** 置頂段沒有上限，它可以把其餘段擠成零高度 —— 而一個
    // 零高度容器的 `scrollHeight > clientHeight` **恆為真**，於是這條前提會通過，其後每一條
    // 「捲動」斷言卻什麼都沒量到。
    check(results, `${label}：壓矮 viewport 後 rail 確實溢出，且捲動容器有非零高度（否則整段沒有鑑別力）`,
      scroller !== null && scroller.clientHeight > 0 && scroller.scrollHeight > scroller.clientHeight + 10,
      JSON.stringify(scroller))

    // 走到最後一個 repo —— 在這個高度下它必然落在初始視野之外。
    await app.client.evaluate(SELECT_FOLDER('repo-a'))
    await sleep(300)
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await sleep(200)
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await sleep(600)

    const scrolled = await app.client.evaluate(SELECTED_FULLY_VISIBLE)
    check(results, `${label}：前提 —— Ctrl+↓ 確實把選中的項目帶離了初始視野`,
      scrolled !== null && scrolled.scrollTop > 0, JSON.stringify(scrolled))
    check(results, `${label}：Ctrl+↓ 切換後，選中的項目完整落在 rail 的可視範圍內`,
      scrolled !== null && scrolled.visible === true, JSON.stringify(scrolled))

    // 往回走同樣要捲。**先把容器強制捲到底才有鑑別力** —— 少了這一步，對照組（拿掉
    // `scrollIntoView`）的 `scrollTop` 恆為 0，於是頂端附近的項目本來就完整可見，那條斷言
    // 兩種實作都會過（獨立稽核抓到的 m9）。強制捲動是直接指派 `scrollTop`，不送滑鼠事件 ——
    // 於是它不會誤觸下面那條「以滑鼠操作時不捲」的例外。
    const FORCE_RAIL_BOTTOM = `(() => {
      const ul = ${RAIL_SCROLL_UL}
      if (!ul) return null
      ul.scrollTop = ul.scrollHeight
      return Math.round(ul.scrollTop)
    })()`

    const forcedBottom = await app.client.evaluate(FORCE_RAIL_BOTTOM)
    check(results, `${label}：前提 —— rail 捲得到底（往回捲那條的鑑別力來自這裡）`,
      typeof forcedBottom === 'number' && forcedBottom > 0, JSON.stringify(forcedBottom))

    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    await sleep(200)
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    await sleep(600)
    const back = await app.client.evaluate(SELECTED_FULLY_VISIBLE)
    check(results, `${label}：Ctrl+↑ 往回切換後，選中的項目仍完整落在可視範圍內`,
      back !== null && back.visible === true, JSON.stringify(back))
    check(results, `${label}：Ctrl+↑ 往回切換確實把容器捲了回去（對照組：無 scrollIntoView 時停在底部）`,
      back !== null && back.scrollTop < forcedBottom,
      `forced=${forcedBottom} → ${JSON.stringify(back)}`)

    // ── 例外：以滑鼠直接點擊時**不**捲動
    //
    // `block: 'nearest'` 只保證「**完全**可見就不捲」，部分可見的它會捲最小的量把它補齊 ——
    // 於是點下緣那半截的列時，那一列會在游標底下跳走，下一次點擊得重新瞄準。這一段先把容器
    // 造一個半截的列，再送**真滑鼠事件**點它（合成事件驅動不了這條路徑）。
    //
    // **不能只是「捲到底再找找看」**（實測：那樣找到的是 `null`）—— 捲到底時被裁掉的是
    // session **子列**，而標題列（`div[role="button"]`，也就是選取的單位）恰好整排都完整可見。
    // 因此改為**主動算**：把捲動位置設到讓某一列剛好被視窗邊緣切一半，先試上緣、再試下緣。
    // 直接指派 `scrollTop` 不送滑鼠事件，於是它自己不會誤觸這條例外。
    const CUT_A_RAIL_ROW = `(() => {
      const ul = ${RAIL_SCROLL_UL}
      if (!ul) return null
      // 只看**其餘段裡**的列 —— 置頂段的列不在這個容器內，拿它們算切半的捲動位置會算錯。
      const rows = [...ul.querySelectorAll(':scope > li > div[role="button"]')]
      const max = ul.scrollHeight - ul.clientHeight
      for (const row of rows) {
        if (row.getAttribute('aria-current') === 'true') continue
        const height = row.getBoundingClientRect().height
        const contentTop =
          row.getBoundingClientRect().top - ul.getBoundingClientRect().top + ul.scrollTop
        for (const want of [contentTop + height / 2, contentTop + height / 2 - ul.clientHeight]) {
          const target = Math.round(want)
          if (target < 0 || target > max) continue
          ul.scrollTop = target
          const a = ul.getBoundingClientRect()
          const b = row.getBoundingClientRect()
          const top = Math.max(a.top, b.top)
          const bottom = Math.min(a.bottom, b.bottom)
          const cut = b.top < a.top - 0.5 || b.bottom > a.bottom + 0.5
          if (bottom - top >= 8 && cut) {
            return {
              label: row.getAttribute('aria-label'),
              x: Math.round(b.left + b.width * 0.35),
              y: Math.round((top + bottom) / 2),
              scrollTop: Math.round(ul.scrollTop),
            }
          }
        }
      }
      return null
    })()`

    const partial = await app.client.evaluate(CUT_A_RAIL_ROW)
    check(results, `${label}：前提 —— 造得出一個「部分可見且未選中」的 rail 列`,
      partial !== null, JSON.stringify(partial))

    if (partial) {
      await realMouse(app.client, partial.x, partial.y, 'left')
      await sleep(700)
      const afterClick = await app.client.evaluate(SELECTED_FULLY_VISIBLE)
      check(results, `${label}：前提 —— 那一下點擊確實選中了它（否則下一條沒有意義）`,
        afterClick !== null && afterClick.label === partial.label,
        `${JSON.stringify(partial.label)} → ${JSON.stringify(afterClick)}`)
      check(results, `${label}：以滑鼠選取部分可見的項目時 rail 不捲動（它不在游標底下跳走）`,
        afterClick !== null && afterClick.scrollTop === partial.scrollTop,
        `scrollTop ${partial.scrollTop} → ${afterClick && afterClick.scrollTop}`)
    }

    await app.client.send('Emulation.clearDeviceMetricsOverride', {})
    await sleep(300)

    // ── 分頁列的橫向捲動 —— 第二條 dogfood 回饋的**另一半**，此前零自動化覆蓋
    //
    // 同一顆 `Ctrl+Tab` 要捲兩個容器：rail（縱向，上面那幾條）與分頁列（橫向，這裡）。
    // **壓窄 viewport 讓分頁列溢出**，不去多開 session —— 後者要動 fixture，而 fixture 是
    // 全域的，前面每一條絕對斷言都會跟著壞。
    await app.client.send('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 700,
      deviceScaleFactor: 0,
      mobile: false,
    })
    await sleep(600)
    await app.client.evaluate(SELECT_FOLDER('repo-a'))
    await sleep(400)

    const TAB_SCROLLER = `(() => {
      const el = document.querySelector('[role="tablist"][aria-label="${copy('sessions.tabs')}"]')
      if (!el) return null
      const tabs = [...el.querySelectorAll('[role="tab"]')]
      const index = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
      const a = el.getBoundingClientRect()
      const b = index === -1 ? null : tabs[index].getBoundingClientRect()
      return {
        count: tabs.length,
        index,
        scrollWidth: Math.round(el.scrollWidth),
        clientWidth: Math.round(el.clientWidth),
        overflows: el.scrollWidth > el.clientWidth + 4,
        scrollLeft: Math.round(el.scrollLeft),
        visible: b === null ? null : b.left >= a.left - 0.5 && b.right <= a.right + 0.5,
      }
    })()`

    const FORCE_TABS_LEFT = `(() => {
      const el = document.querySelector('[role="tablist"][aria-label="${copy('sessions.tabs')}"]')
      if (!el) return null
      el.scrollLeft = 0
      return Math.round(el.scrollLeft)
    })()`

    // **壓窄視窗未必就夠**（實測 640px 下 3 個分頁仍塞得下）—— 不夠就補幾個 session。
    // 補的路徑走**鍵盤**（`Ctrl+T` → ↓ → Enter）而不是點「+」：窄視窗下那顆按鈕可能已被推出
    // 畫面，而鍵盤路徑與寬度無關。這一段排在 runMode 的最末，多出來的 session 不污染任何人。
    let tabs = await pollUntil(app.client, TAB_SCROLLER, (v) => v !== null, 8000)
    for (let i = 0; i < 4 && tabs !== null && !tabs.overflows; i += 1) {
      await pressKey(app.client, 't', ['ctrl'])
      await sleep(500)
      await pressKey(app.client, 'ArrowDown')
      await pressKey(app.client, 'Enter')
      await sleep(1500)
      tabs = await app.client.evaluate(TAB_SCROLLER)
    }

    check(results, `${label}：前提 —— 分頁列確實溢出（否則整段沒有鑑別力）`,
      tabs !== null && tabs.overflows === true && tabs.count >= 2,
      JSON.stringify(tabs))

    if (tabs && tabs.overflows && tabs.count >= 2) {
      // 先走到第一個分頁 —— 於是「捲到最左」是一個確定的狀態，而不是碰運氣。
      for (let i = 0; i < tabs.count && tabs.index !== 0; i += 1) {
        await pressKey(app.client, 'Tab', ['ctrl'])
        await sleep(250)
        tabs = await app.client.evaluate(TAB_SCROLLER)
      }
      check(results, `${label}：前提 —— Ctrl+Tab 走得到第一個分頁`,
        tabs !== null && tabs.index === 0, JSON.stringify(tabs))

      // 強制捲回最左：於是**最後一個**分頁必然落在視野之外（溢出的定義就是這件事）。
      await app.client.evaluate(FORCE_TABS_LEFT)
      await sleep(300)

      // 往前循環一格 ＝ 跳到最後一個分頁。位置序可循環（`keyboard-navigation`）。
      await pressKey(app.client, 'Tab', ['ctrl', 'shift'])
      await sleep(700)
      const wrapped = await app.client.evaluate(TAB_SCROLLER)
      check(results, `${label}：前提 —— Ctrl+Shift+Tab 自第一個分頁循環到最後一個`,
        wrapped !== null && wrapped.index === wrapped.count - 1, JSON.stringify(wrapped))
      check(results, `${label}：切換至視野外的 session 時，分頁列橫向捲動使該分頁完整可見`,
        wrapped !== null && wrapped.visible === true, JSON.stringify(wrapped))
      check(results, `${label}：分頁列確實橫向捲動了（對照組：無 scrollIntoView 時 scrollLeft 停在 0）`,
        wrapped !== null && wrapped.scrollLeft > 0, JSON.stringify(wrapped))

      // ── 例外**僅及於被直接操作的那一個容器**
      //
      // 以滑鼠點 rail 的 session 子列，會使**分頁列**的 focused 分頁改變 —— 而那個分頁可能在
      // 橫向視野之外。使用者直接操作的是 rail，不是分頁列，因此分頁列 SHALL 捲動。
      //
      // **此前零覆蓋**：那條「以滑鼠操作時不捲動」的例外只驗了 rail 這一側，而一個把例外寫成
      // 全域旗標（而不是 per-container）的實作，會讓分頁列跟著不捲 —— 全綠。
      const RAIL_SUBROW_RECT = (index) => `(() => {
        const list = document.querySelector('ul[aria-label="${copy('rail.folderSessions', { name: 'repo-a' })}"]')
        const row = [...(list?.querySelectorAll(':scope > li > div[role="button"]') ?? [])][${index}]
        if (!row) return null
        const r = row.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`

      // **焦點要先移開目標，否則點下去選取不變 ⇒ 依規格本來就不該捲**（實測踩過：前後
      // `index` 都是 3，斷言以「沒捲」失敗，而那是正確行為）。先循環回第一個分頁，
      // 再把分頁列捲到最左 —— 於是目標（最後一個）既非 focused、也在視野之外。
      await pressKey(app.client, 'Tab', ['ctrl'])
      await sleep(400)
      await app.client.evaluate(FORCE_TABS_LEFT)
      await sleep(300)
      const beforeClick = await app.client.evaluate(TAB_SCROLLER)
      // 分頁數在這一段是動態的（上面「不夠就補幾個 session」），因此取當下的值 ——
      // `SESSION_COUNT` 是另一個段落的常數，這裡看不到它。
      const lastRow = await app.client.evaluate(RAIL_SUBROW_RECT((beforeClick?.count ?? 1) - 1))
      check(results, `${label}：前提 —— 最後一個分頁既非 focused 又落在視野之外，且它的 rail 子列點得到`,
        beforeClick !== null && beforeClick.scrollLeft === 0 &&
          beforeClick.index !== beforeClick.count - 1 && lastRow !== null,
        `${JSON.stringify(beforeClick)} / ${JSON.stringify(lastRow)}`)

      // **`realClick` 會對傳入的 rect 再取一次 `center()`** —— 而上面回的已經是中心點，
      // `width` 是 undefined ⇒ NaN ⇒ CDP 回「Invalid parameters」並讓整個段落拋出例外。
      // 直接送座標。
      if (lastRow) await realMouse(app.client, lastRow.x, lastRow.y, 'left')
      const afterClick = await pollUntil(
        app.client,
        TAB_SCROLLER,
        (v) => v !== null && v.index === v.count - 1,
        4000,
      )
      check(results, `${label}：以滑鼠點 rail 子列時，分頁列仍捲動（例外僅及於被直接操作的容器）`,
        afterClick !== null && afterClick.visible === true && afterClick.scrollLeft > 0,
        `${JSON.stringify(beforeClick)} → ${JSON.stringify(afterClick)}`)
    }

    await app.client.send('Emulation.clearDeviceMetricsOverride', {})
    await sleep(300)

    await runQuickOpen(label, app, repos)
  } finally {
    await app.destroy()
  }
}

/**
 * **零 folder 的 workspace** —— 五條 scenario 的共同載體，橫跨四個 capability：
 *
 * | capability | scenario |
 * |---|---|
 * | `global-session` | 尚無任何 folder 時仍呈現 |
 * | `keyboard-navigation` | rail 只有全域項目時為無操作 |
 * | `status-bar` | workspace 為空且無任何 session 時 |
 * | `status-bar` | workspace 為空但有全域 session 時不呈現空狀態 |
 * | `file-explorer` | 沒有可用的側欄來源 |
 *
 * **這一段的成本核心是那一次零 folder 冷啟動，五條共用它** —— 分開驗就是五次啟動，而它們
 * 的前置條件完全相同。
 *
 * **失效方向是假綠，這是本段存在的唯一理由**：種有 folder 的環境**區分不了「恆常呈現」與
 * 「有 folder 時才呈現」**。一個「rail 為空就不渲染任何東西」的實作，照樣通過 `runMode` 那條
 * 「全域項目是 rail 的第一個項目」。
 */
async function checkEmptyWorkspace(label, { port, rendererUrl }) {
  // **不呼叫 `makeFixture()`** —— 這一段要的就是「磁碟上沒有任何 repo、清單裡沒有任何 folder」。
  const profile = seedProfile([])
  const app = await launch({ port, profileDir: profile, rendererUrl })

  try {
    const GLOBAL = copy('rail.globalName')

    // ── 前提：沒有任何東西抑制快捷鍵
    //
    // **這不是背景檢查，是 D4 的承重前提**：快捷鍵在對話框或選單開啟時一律被抑制，而零 folder
    // 是罕被執行的啟動狀態。若那時有引導性的對話框，「按了沒反應」與「規格要求的無操作」在
    // 結果上完全相同 —— 下面那條無操作斷言會以假綠的形式通過。
    const suppressors = await pollUntil(app.client, SUPPRESSORS, (v) => v !== null, 10_000)
    check(results, `${label}：零 folder 啟動時沒有任何對話框或選單抑制快捷鍵`,
      suppressors === 0, `[role="dialog"], [role="menu"] 共 ${suppressors} 個`)

    // ── global-session：尚無任何 folder 時仍呈現全域項目
    //
    // **`length === 1` 是這條的全部重點。** runMode 那條「全域項目是 rail 的第一個項目」跑在
    // 種了三個 folder 的 fixture 上，它對「rail 為空就不渲染任何東西」的實作照樣是綠的。
    const items = await pollUntil(app.client, RAIL_ITEMS, (v) => v !== null, 10_000)
    check(results, `${label}：尚無任何 folder 時 rail 仍呈現全域項目，且它是唯一的項目`,
      items.length === 1 && items[0] === GLOBAL, JSON.stringify(items))

    // ── status-bar：workspace 為空且無任何 session 時呈現空狀態
    //
    // **判準是「屬於那兩句之一」，不寫死哪一句** —— 規格要的是「呈現空狀態文字」，而實作依
    // 有沒有選中項目在 `noRepo` / `noSession` 之間選。綁死其中一句，會讓一次無關的選中狀態
    // 調整把這條弄紅。
    const EMPTY_TEXTS = [copy('statusBar.noRepo'), copy('statusBar.noSession')]
    const barEmpty = await pollUntil(app.client, STATUS_BAR_TEXT, (v) => v !== null, 10_000)
    check(results, `${label}：workspace 為空且無任何 session 時，狀態列存在且呈現空狀態文字`,
      barEmpty !== null && EMPTY_TEXTS.some((t) => barEmpty.includes(t)),
      JSON.stringify(barEmpty))

    // ── keyboard-navigation：rail 只有全域項目時 Ctrl+↑↓ 為無操作
    //
    // **兩步，而順序是承重的。** 第一步是「這顆鍵在此狀態下是活的」的證據 —— 少了它，第二步
    // 在快捷鍵完全失效時（例如有東西抑制了它）**依然全綠**，因為「選中項不變」在兩種情形下
    // 都成立。上面那條抑制檢查是同一件事的另一面，兩條都留著。
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    const selectedFirst = await pollUntil(app.client, SELECTED_ITEM, (v) => v === GLOBAL, 4000)
    check(results, `${label}：尚未選中任何項目時 Ctrl+↓ 選中全域項目（前提：快捷鍵未被抑制）`,
      selectedFirst === GLOBAL, String(selectedFirst))

    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    await sleep(400)
    const afterDown = await app.client.evaluate(SELECTED_ITEM)
    const mountedAfterDown = await app.client.evaluate(MOUNTED)
    check(results, `${label}：rail 只有全域項目時 Ctrl+↓ 為無操作且 app 不崩潰`,
      afterDown === GLOBAL && mountedAfterDown?.ok === true,
      `${selectedFirst} → ${afterDown}；${describeMounted(mountedAfterDown) || '掛載正常'}`)

    // 相反方向的邊界 —— 條文管的是「這兩個快捷鍵」，而 `(0 - 1 + 1) % 1` 是會出事的那一類算式。
    await pressKey(app.client, 'ArrowUp', ['ctrl'])
    await sleep(400)
    const afterUp = await app.client.evaluate(SELECTED_ITEM)
    const mountedAfterUp = await app.client.evaluate(MOUNTED)
    check(results, `${label}：rail 只有全域項目時 Ctrl+↑ 為無操作且 app 不崩潰`,
      afterUp === GLOBAL && mountedAfterUp?.ok === true,
      `${afterDown} → ${afterUp}；${describeMounted(mountedAfterUp) || '掛載正常'}`)

    // ── file-explorer：沒有可用的側欄來源
    //
    // **「來源未選定」與「沒有 folder 可選」是兩個狀態**，而既有載體（「來源未選定時 Files
    // 不呈現任何檔案列」）跑在有 folder 的 fixture 上 —— 它驗的是前者。
    await app.client.evaluate(IDENTITY_FILES)
    const filesText = await pollUntil(app.client, FILES_PANEL_TEXT, (v) => v !== null, 6000)
    check(results, `${label}：沒有任何 folder 可作為側欄來源時，Files 身分呈現說明此狀態的提示`,
      filesText !== null && filesText.includes(copy('files.noSource')),
      JSON.stringify(filesText))

    // ── status-bar：workspace 為空但有全域 session 時不呈現空狀態
    //
    // **走 rail 上全域項目的建立入口**，不走 `createSession()`（它找的是主舞台的按鈕，而零
    // folder 時沒有選中的 repo）。也**刻意不走 `Ctrl+T`** —— 那會讓這條依賴上面剛驗過的
    // 快捷鍵，兩條斷言就不再獨立。
    // **預算 16 秒的推導**：一輪 ＝ 等入口的 10 秒 ＋ 等項目的 6 秒；收斂前是一輪（不重試）。
    await openSpawnMenu(app.client, copy('sessions.spawnShell'), {
      entry: GLOBAL_NEW_SESSION_RECT,
      entryWindowMs: 10_000,
      itemWindowMs: 6000,
      budgetMs: 16_000,
      name: 'rail 上全域項目的建立 session 入口',
    })

    const globalTabs = await pollUntil(app.client, TABS, (v) => v.length === 1, 15_000)
    const barWithSession = await pollUntil(
      app.client, STATUS_BAR_TEXT,
      (v) => v !== null && !EMPTY_TEXTS.some((t) => v.includes(t)), 10_000)
    check(results,
      `${label}：workspace 為空但有全域 session 時，狀態列呈現該 session 的脈絡而非空狀態`,
      globalTabs.length === 1 &&
        barWithSession !== null &&
        !EMPTY_TEXTS.some((t) => barWithSession.includes(t)) &&
        barWithSession.includes(copy('statusBar.sessions', { here: 1, total: 1 })),
      `分頁=${globalTabs.length} 狀態列=${JSON.stringify(barWithSession)}`)
  } finally {
    await app.destroy()
  }
}

/**
 * **捲動位置的所有權** —— 導航才捲，其餘一律不捲。
 *
 * 三條斷言在此，各自針對 `keyboard-navigation` 的一種失效方向：
 *
 * 1. **與導航無關的更新 SHALL NOT 捲動**（新增的 requirement）。使用者手動捲到的位置是他的
 *    意圖，而背景中運作的 agent 持續更新 session 狀態 —— 一次都不能拿來搶走它。
 * 2. **`Shift+↑↓` 移動 rail 項目後它仍可見**、3. **`Shift+←→` 移動 session 後它仍可見**
 *    —— 兩條既有 scenario 此前**零載體**，而它們一直是靠「重繪就捲」那個缺陷順帶成立的。
 *
 * **自成一段，不併進 `runMode`**：這一段要結束 session（破壞性）、要八個 session（`runMode`
 * 的絕對斷言全部以三個 fixture repo 的既有狀態為前提），而 `runMode` 是這支探針最重的段落、
 * build 與 dev 各跑一次 —— 再往它身上加料會逼近段落窗口，而**逾時的段落不走 finally，其後
 * 的斷言會整批消失**。獨立一段也讓它能以 `PROBE_ONLY=checkScrollAnchoring` 單獨迭代。
 */
async function checkScrollAnchoring(label, { port, rendererUrl }) {
  const repos = makeFixture()
  const profile = seedProfile(repos)
  const app = await launch({ port, profileDir: profile, rendererUrl })

  const RAIL_UL = RAIL_SCROLL_UL
  const TAB_LIST = `document.querySelector('[role="tablist"][aria-label="${copy('sessions.tabs')}"]')`

  const RAIL_STATE = `(() => {
    const ul = ${RAIL_UL}
    if (!ul) return null
    return {
      // 同上：零高度容器的 overflows 恆為真，因此把高度一起帶出來給斷言檢查。
    clientHeight: ul.clientHeight,
    overflows: ul.clientHeight > 0 && ul.scrollHeight > ul.clientHeight + 4,
      scrollTop: Math.round(ul.scrollTop),
      max: Math.round(ul.scrollHeight - ul.clientHeight),
    }
  })()`

  /**
   * focused session 的 **rail 子列**。
   *
   * 子列沒有任何 aria 屬性標示 focused（只有一組 class，而 class 是樣式不是契約），因此
   * **以分頁列的 `aria-selected` 取得序位**，再取同序位的子列 —— 兩者都是 `forFolder()` 的
   * 順序，序位一致。找不到就回 `null`：前提斷言因此會**紅**，而不是靜默落進「不可見」。
   */
  const FOCUSED_ROW = `(() => {
    const ul = ${RAIL_UL}
    const tabs = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
    const index = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
    const list = document.querySelector('ul[aria-label="${copy('rail.folderSessions', { name: 'repo-a' })}"]')
    if (!ul || !list || index === -1) return null
    const row = [...list.querySelectorAll(':scope > li > div[role="button"]')][index]
    if (!row) return null
    const a = ul.getBoundingClientRect()
    const b = row.getBoundingClientRect()
    return {
      index,
      title: row.getAttribute('title'),
      hidden: b.bottom <= a.top + 0.5 || b.top >= a.bottom - 0.5,
      scrollTop: Math.round(ul.scrollTop),
    }
  })()`

  /** 選中的 rail **項目標題列**（`Shift+↑↓` 的目標，與上面那個是兩個不同的東西）。 */
  const SELECTED_HEADER = `(() => {
    const scroller = ${RAIL_UL}
    const rows = [...document.querySelectorAll('${RAIL_ROW_SEL}')]
    const row = rows.find((r) => r.getAttribute('aria-current') === 'true')
    if (!scroller || !row) return null
    // 列與容器成對取得 —— 置頂的 repo 與全域項目在另一個 <ul> 裡（見 RAIL_SCROLL_UL）。
    const ul = row.closest('ul')
    const a = ul.getBoundingClientRect()
    const b = row.getBoundingClientRect()
    return {
      label: row.getAttribute('aria-label'),
      pinnedSection: ul !== scroller,
      visible: b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5,
      hidden: b.bottom <= a.top + 0.5 || b.top >= a.bottom - 0.5,
      scrollTop: Math.round(scroller.scrollTop),
      contentTop: Math.round(b.top - a.top + ul.scrollTop),
      max: Math.round(scroller.scrollHeight - scroller.clientHeight),
      order: rows.map((r) => r.getAttribute('aria-label')),
    }
  })()`

  const TAB_STATE = `(() => {
    const el = ${TAB_LIST}
    if (!el) return null
    const tabs = [...el.querySelectorAll('[role="tab"]')]
    const index = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
    const a = el.getBoundingClientRect()
    const b = index === -1 ? null : tabs[index].getBoundingClientRect()
    return {
      count: tabs.length,
      index,
      overflows: el.scrollWidth > el.clientWidth + 4,
      scrollLeft: Math.round(el.scrollLeft),
      title: index === -1 ? null : tabs[index].getAttribute('title'),
      visible: b === null ? null : b.left >= a.left - 0.5 && b.right <= a.right + 0.5,
      hidden: b === null ? null : b.right <= a.left + 0.5 || b.left >= a.right - 0.5,
    }
  })()`

  /** 直接指派捲動位置 —— **不送滑鼠事件**，於是它自己不會觸發「以指標操作時不捲」的例外。 */
  const FORCE_RAIL = (value) => `(() => {
    const ul = ${RAIL_UL}
    if (!ul) return null
    ul.scrollTop = ${value}
    return Math.round(ul.scrollTop)
  })()`
  const FORCE_TABS = (value) => `(() => {
    const el = ${TAB_LIST}
    if (!el) return null
    el.scrollLeft = ${value}
    return Math.round(el.scrollLeft)
  })()`

  const SESSION_COUNT = 8
  const RUNNING = copy('sessions.statusRunning')
  const EXITED = copy('sessions.statusExited')

  /**
   * 結束當前 focused 的 session，並**回傳它的狀態是否真的轉為已結束**。
   *
   * **這不是禮貌性的檢查，它是那兩條「捲動位置不變」唯一的活性證明** —— 那是相對判定，
   * 觸發它的機制整個沒發生時它照樣是綠的。而這支探針裡就有一條具體的死法：好幾個段落以
   * `cat -A > file` 把 shell 留在 `cat` 裡，那樣的 session 打 `exit` 只是把四個字寫進檔案，
   * pty 不結束、`onExit` 不觸發、React 一次都不重繪。這裡的 session 全是剛建立、停在 prompt
   * 的 shell，而這個回傳值就是那個前提的證據。
   *
   * 先點一下終端再打字：`Input.insertText` 送到當下的焦點元素。**終端不在 rail 或分頁列之內**，
   * 所以這一下點擊不會設起任何一個捲動容器的 pointer 例外（而隨後打的每一顆鍵都會把它翻回
   * 鍵盤來源）—— 斷言的綠燈因此不可能是 guard 給的。
   */
  const exitFocusedSession = async (read) => {
    const terminal = await app.client.evaluate(TERMINAL_RECT)
    if (terminal) await realClick(app.client, terminal)
    await sleep(200)
    await typeLine(app.client, 'exit')
    return pollUntil(app.client, read, (v) => v !== null && String(v.title).includes(EXITED), 15_000)
  }

  try {
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (v) => v === true, 10_000)
    await sleep(300)

    // 建立 session 於**預設尺寸**下進行 —— 壓縮視窗後「+ session」可能已被推出畫面。
    for (let i = 1; i <= SESSION_COUNT; i += 1) {
      await createSession(app.client)
      await pollUntil(app.client, TAB_STATE, (v) => v !== null && v.count === i, 15_000)
    }
    const seeded = await app.client.evaluate(TAB_STATE)
    check(results, `${label}：前提 —— repo-a 建得起 ${SESSION_COUNT} 個 session`,
      seeded !== null && seeded.count === SESSION_COUNT, JSON.stringify(seeded))

    // ══ rail（縱向）══════════════════════════════════════════════════════════
    //
    // **壓矮 viewport 讓 rail 溢出**，不去多塞 folder —— 後者要改 fixture，而 fixture 是全域的。
    await app.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 300,
      deviceScaleFactor: 0,
      mobile: false,
    })
    await sleep(600)

    const railReady = await pollUntil(app.client, RAIL_STATE, (v) => v !== null && v.overflows, 8000)
    check(results, `${label}：前提 —— 壓矮 viewport 後 rail 確實溢出（否則整段沒有鑑別力）`,
      railReady !== null && railReady.overflows === true && railReady.max > 60,
      JSON.stringify(railReady))

    // ── 移動 rail 項目後它仍可見（既有 scenario，此前零載體）
    //
    // **方向是被實測逼出來的，不是隨手選的。**
    //
    // 第一版是「選 repo-a、捲到底、`Shift+↓`」—— 它在**正確與錯誤的實作上都通過**（對照組
    // 把序位自 key 拿掉，斷言照樣綠）。原因是瀏覽器的 **scroll anchoring**：被移動的那一塊
    // 位於視野**上方**，內容一變動，瀏覽器就自動補償捲動位置，恰好把目標帶進視野 ——
    // **一個看起來像實作做到了的假綠**。
    //
    // 改成「選 repo-c（最後一列）、捲到**頂**、`Shift+↑`」：變動發生在視野**下方**，
    // anchoring 不介入，目標唯有被程式捲動才會可見。`keyboard-navigation` 的表格寫的是
    // `Shift+↑↓`，兩個方向同屬一條 requirement。
    await app.client.evaluate(SELECT_FOLDER('repo-c'))
    await sleep(300)
    await app.client.evaluate(FORCE_RAIL(0))
    await sleep(200)
    const beforeMove = await app.client.evaluate(SELECTED_HEADER)
    check(results, `${label}：前提 —— rail 捲到頂後，選中的最後一個項目落在視野之外`,
      beforeMove !== null && beforeMove.hidden === true, JSON.stringify(beforeMove))

    // **等的是「目標可見」這個穩定狀態，不是「捲動位置變了」** —— 後者實測會抓到中途：
    // 重排與捲動分兩次繪製，量到的可能是第一次的中間值，於是一條正確的實作被判為紅。
    // **一個「開始動了」的條件不等於規格在乎的那個狀態。**
    await pressKey(app.client, 'ArrowUp', ['shift'])
    const afterMove = await pollUntil(
      app.client, SELECTED_HEADER, (v) => v !== null && v.visible === true, 4000)
    check(results, `${label}：以 Shift+↑ 移動選中的 rail 項目後，它被捲回可視範圍`,
      afterMove !== null && afterMove.visible === true,
      `${JSON.stringify(beforeMove)} → ${JSON.stringify(afterMove)}`)

    // ── A key after a click on the rail scrolls the rail again (`useScrollIntoView`: any keydown clears the
    // pointer exception). Click repo-a's row with the rail at the top, so that the next item's row is below the
    // view, then Ctrl+↓. Control: drop the keydown clearing and the rail stays put.
    await app.client.evaluate(FORCE_RAIL(0))
    await sleep(200)
    await realClick(app.client, await app.client.evaluate(RECT_OF(`${RAIL_ROW_SEL}[aria-label="${repos[0][0]}"]`)))
    await sleep(300)
    await app.client.evaluate(FORCE_RAIL(0))
    await sleep(200)
    await pressKey(app.client, 'ArrowDown', ['ctrl'])
    const afterRailClick = await pollUntil(app.client, SELECTED_HEADER, (v) => v !== null && v.label !== 'repo-a' && v.visible === true, 4000)
    check(results, `${label}：after a click on the rail, Ctrl+↓ still scrolls the rail to the selected item`,
      // `scrollTop > 0`: the rail was at the top, so the item became visible by being scrolled to.
      afterRailClick !== null && afterRailClick.label !== 'repo-a' && afterRailClick.visible === true && afterRailClick.scrollTop > 0,
      JSON.stringify(afterRailClick))

    // ── Ctrl+Tab **也要捲 rail** —— 同一顆鍵要捲兩個容器
    //
    // 這條 requirement 的表格裡，`Ctrl+Tab` 那一列寫著「分頁列（橫向）**與** rail（縱向）」。
    // **rail 這一半此前零覆蓋**：`FOCUSED_ROW` 只被用在下面那條「不捲動」的前置上，從來沒有
    // 一條斷言驗過「切過去之後子列真的被捲進來了」。一個只捲分頁列的實作會全綠。
    await app.client.evaluate(SELECT_FOLDER('repo-a'))
    await sleep(400)
    await pressKey(app.client, 'Tab', ['ctrl', 'shift'])
    await sleep(500)
    await app.client.evaluate(FORCE_RAIL(0))
    await sleep(300)
    const subRowHidden = await app.client.evaluate(FOCUSED_ROW)
    check(results, `${label}：前提 —— 切換之前，目標 session 的 rail 子列落在視野之外`,
      subRowHidden !== null && subRowHidden.hidden === true, JSON.stringify(subRowHidden))

    await pressKey(app.client, 'Tab', ['ctrl'])
    const subRowShown = await pollUntil(
      app.client,
      FOCUSED_ROW,
      (v) => v !== null && v.hidden === false,
      4000,
    )
    check(results, `${label}：Ctrl+Tab 切換後，該 session 的 rail 子列被捲入 rail 的可視範圍`,
      subRowShown !== null && subRowShown.hidden === false &&
        subRowShown.scrollTop !== subRowHidden?.scrollTop,
      `${JSON.stringify(subRowHidden)} → ${JSON.stringify(subRowShown)}`)

    // ── 與導航無關的更新不搶走 rail 的捲動位置
    //
    // focused 走到最後一個 session，再把 rail 捲到頂 —— 它的子列於是落在下方視野之外。
    await pressKey(app.client, 'Tab', ['ctrl', 'shift'])
    await sleep(500)
    await app.client.evaluate(FORCE_RAIL(0))
    await sleep(300)
    const rowBefore = await app.client.evaluate(FOCUSED_ROW)
    check(results, `${label}：前提 —— focused session 的 rail 子列找得到，且落在視野之外`,
      rowBefore !== null && rowBefore.hidden === true && String(rowBefore.title).includes(RUNNING),
      JSON.stringify(rowBefore))

    const rowExited = await exitFocusedSession(FOCUSED_ROW)
    check(results, `${label}：前提 —— 該 session 的狀態確實由 Running 轉為 Exited（這條斷言的活性證明）`,
      rowExited !== null && String(rowExited.title).includes(EXITED), JSON.stringify(rowExited))
    check(results, `${label}：session 結束這類與導航無關的更新，SHALL NOT 搶走 rail 的捲動位置`,
      rowExited !== null && rowExited.scrollTop === rowBefore?.scrollTop,
      `scrollTop ${rowBefore && rowBefore.scrollTop} → ${rowExited && rowExited.scrollTop}`)

    // ══ 分頁列（橫向）══════════════════════════════════════════════════════════
    await app.client.send('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 700,
      deviceScaleFactor: 0,
      mobile: false,
    })
    await sleep(600)

    const tabsReady = await pollUntil(
      app.client, TAB_STATE, (v) => v !== null && v.overflows, 8000)
    check(results, `${label}：前提 —— 壓窄 viewport 後分頁列確實溢出`,
      tabsReady !== null && tabsReady.overflows === true, JSON.stringify(tabsReady))

    // ── Shift+→ 移動 session 後它仍可見（既有 scenario，此前零載體）
    //
    // 走到第一個分頁再把分頁列**捲到最右**：focused 分頁於是落在左側視野之外，往右移動一格
    // 後仍在視野之外 —— 與上面那條同一個鑑別力來源。
    let walked = await app.client.evaluate(TAB_STATE)
    for (let i = 0; i < SESSION_COUNT + 1 && walked !== null && walked.index !== 0; i += 1) {
      await pressKey(app.client, 'Tab', ['ctrl'])
      await sleep(250)
      walked = await app.client.evaluate(TAB_STATE)
    }
    check(results, `${label}：前提 —— Ctrl+Tab 走得到第一個分頁`,
      walked !== null && walked.index === 0, JSON.stringify(walked))

    await app.client.evaluate(FORCE_TABS(1e6))
    await sleep(200)
    const tabBeforeMove = await app.client.evaluate(TAB_STATE)
    check(results, `${label}：前提 —— 分頁列捲到最右後，focused 分頁落在視野之外`,
      tabBeforeMove !== null && tabBeforeMove.hidden === true, JSON.stringify(tabBeforeMove))

    await pressKey(app.client, 'ArrowRight', ['shift'])
    const tabAfterMove = await pollUntil(
      app.client, TAB_STATE, (v) => v !== null && v.visible === true, 4000)
    check(results, `${label}：以 Shift+→ 移動 focused session 後，它的分頁被捲回可視範圍`,
      tabAfterMove !== null && tabAfterMove.visible === true,
      `${JSON.stringify(tabBeforeMove)} → ${JSON.stringify(tabAfterMove)}`)

    // ── 與導航無關的更新不搶走分頁列的捲動位置
    //
    // **走到最後一個分頁**再把分頁列捲回最左 —— 第一版只按了一次 `Ctrl+Shift+Tab`，focused
    // 於是落在 index 0，而捲到最左時它**當然可見**：那條前提立刻紅了，並連帶證明它保護的
    // 「scrollLeft 不變」在那個狀態下是 `0 → 0` 的恆真式（正是它存在的理由）。
    let atEnd = await app.client.evaluate(TAB_STATE)
    for (
      let i = 0;
      i < SESSION_COUNT + 1 && atEnd !== null && atEnd.index !== atEnd.count - 1;
      i += 1
    ) {
      await pressKey(app.client, 'Tab', ['ctrl'])
      await sleep(250)
      atEnd = await app.client.evaluate(TAB_STATE)
    }
    check(results, `${label}：前提 —— Ctrl+Tab 走得到最後一個分頁`,
      atEnd !== null && atEnd.index === atEnd.count - 1, JSON.stringify(atEnd))
    await app.client.evaluate(FORCE_TABS(0))
    await sleep(300)
    const tabBefore = await app.client.evaluate(TAB_STATE)
    check(results, `${label}：前提 —— focused 分頁落在視野之外，且該 session 仍在運作`,
      tabBefore !== null && tabBefore.hidden === true && String(tabBefore.title).includes(RUNNING),
      JSON.stringify(tabBefore))

    const tabExited = await exitFocusedSession(TAB_STATE)
    check(results, `${label}：前提 —— 該 session 的狀態確實由 Running 轉為 Exited（這條斷言的活性證明）`,
      tabExited !== null && String(tabExited.title).includes(EXITED), JSON.stringify(tabExited))
    check(results, `${label}：session 結束這類與導航無關的更新，SHALL NOT 搶走分頁列的捲動位置`,
      tabExited !== null && tabExited.scrollLeft === tabBefore?.scrollLeft,
      `scrollLeft ${tabBefore && tabBefore.scrollLeft} → ${tabExited && tabExited.scrollLeft}`)

    // ══ rail-pinning：置頂段 ═════════════════════════════════════════════════
    //
    // **先把 viewport 壓回矮的** —— 上面「分頁列」那一段改過 device metrics，此刻 rail 是不
    // 溢出的；沿用它的話，下面每一條「捲動」斷言都會落在一個不會捲的容器上而恆為真。
    await app.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 300,
      deviceScaleFactor: 0,
      mobile: false,
    })
    await sleep(600)

    const pinButton = (name) =>
      `document.querySelector('button[aria-label="${copy('rail.pinFolder', { name: '%N%' })}"]')`.replace('%N%', name)
    const unpinButton = (name) =>
      `document.querySelector('button[aria-label="${copy('rail.unpinFolder', { name: '%N%' })}"]')`.replace('%N%', name)

    /** 置頂段與分界的幾何 —— 遮擋那一條要以它比對，不能只問「目標在不在視口內」。 */
    const PINNED_GEOM = `(() => {
      const rail = document.querySelector('aside[aria-label="${copy('rail.label')}"]')
      const pinned = rail.querySelector(':scope > ul[aria-label="${copy('rail.pinnedList')}"]')
      const rest = rail.querySelector(':scope > ul[aria-label="${copy('rail.folderList')}"]')
      const divider = [...rail.children].find((c) => c.getAttribute('aria-hidden') === 'true')
      if (!pinned || !rest || !divider) return null
      const first = rest.querySelector(':scope > li > div[role="button"]')
      const p = pinned.getBoundingClientRect()
      const d = divider.getBoundingClientRect()
      const r = rest.getBoundingClientRect()
      const f = first ? first.getBoundingClientRect() : null
      return {
        pinnedTop: Math.round(p.top),
        pinnedBottom: Math.round(p.bottom),
        dividerBottom: Math.round(d.bottom),
        restClientHeight: rest.clientHeight,
        restOverflows: rest.clientHeight > 0 && rest.scrollHeight > rest.clientHeight + 4,
        restScrollTop: Math.round(rest.scrollTop),
        restScrollMax: Math.round(rest.scrollHeight - rest.clientHeight),
        firstRestLabel: first ? first.getAttribute('aria-label') : null,
        firstRestTop: f ? Math.round(f.top) : null,
        firstRestVisible: f ? f.top >= r.top - 0.5 && f.bottom <= r.bottom + 0.5 : null,
        pinnedLabels: [...pinned.querySelectorAll(':scope > li > div[role="button"]')]
          .map((row) => row.getAttribute('aria-label')),
      }
    })()`

    const FORCE_REST_BOTTOM = `(() => {
      const rest = document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.folderList')}"]')
      if (!rest) return null
      rest.scrollTop = rest.scrollHeight
      return Math.round(rest.scrollTop)
    })()`

    // ── 置頂一個**小**的 repo（repo-b），讓其餘段仍留著 repo-a 那 8 個展開的子列 ——
    //    其餘段因此仍然溢出，「兩段行為不同」那條才有鑑別力。
    await app.client.evaluate(`${pinButton('repo-b')}?.click()`)
    const pinnedGeom = await pollUntil(
      app.client,
      PINNED_GEOM,
      (v) => v !== null && v.pinnedLabels.includes('repo-b'),
      6000,
    )
    check(results, `${label}：前提 —— 置頂 repo-b 之後，其餘段仍溢出且有非零高度`,
      pinnedGeom !== null && pinnedGeom.restClientHeight > 0 && pinnedGeom.restOverflows === true,
      JSON.stringify(pinnedGeom))

    // ── 置頂段不隨 rail 捲動，且其餘段的內容確實會被捲走（後者才是鑑別力所在）
    await app.client.evaluate(FORCE_REST_BOTTOM)
    await sleep(300)
    const atBottom = await app.client.evaluate(PINNED_GEOM)
    check(results, `${label}：其餘段捲到底之後，置頂段的位置一個像素都沒動`,
      atBottom !== null && pinnedGeom !== null &&
        atBottom.pinnedTop === pinnedGeom.pinnedTop &&
        atBottom.pinnedBottom === pinnedGeom.pinnedBottom,
      `${JSON.stringify(pinnedGeom)} → ${JSON.stringify(atBottom)}`)
    check(results, `${label}：而同一時刻，最前面的未置頂 folder 已被捲出視野（兩段確實不同）`,
      atBottom !== null && atBottom.restScrollTop > 0 && atBottom.firstRestVisible === false,
      JSON.stringify(atBottom))

    // ── 遮擋：捲入視野的目標不得被置頂段蓋住
    //
    // **以幾何關係斷言**（目標上緣不低於分界下緣），不以「目標落在視口內」—— 後者對一個被
    // 完全蓋住的目標**照樣通過**，而那正是這條要防的失效。目前的結構讓它恆為真（置頂段位於
    // 捲動容器之外），這條因此是**回歸守衛**：改回 `position: sticky` 加 `scroll-padding-top`
    // 就會紅。
    // **選取必須真的改變，否則規格明載 SHALL NOT 捲動** —— 這一段前面已經選著 repo-a，
    // 直接再選一次它是無操作，於是「它被捲進視野」的斷言會以「根本沒有捲」的樣貌失敗。
    // 先選一個別的（repo-c，在捲到底之後本來就可見），再選回 repo-a。
    await app.client.evaluate(SELECT_FOLDER('repo-c'))
    await sleep(300)
    await app.client.evaluate(FORCE_REST_BOTTOM)
    await sleep(200)
    const beforeSelect = await app.client.evaluate(PINNED_GEOM)
    check(results, `${label}：前提 —— 目標（第一個未置頂 folder）此刻確實不可見`,
      beforeSelect !== null && beforeSelect.firstRestVisible === false,
      JSON.stringify(beforeSelect))

    await app.client.evaluate(SELECT_FOLDER('repo-a'))
    await sleep(500)
    const afterSelect = await app.client.evaluate(PINNED_GEOM)
    check(results, `${label}：捲入視野的目標不被置頂段遮擋（其上緣不低於分界的下緣）`,
      afterSelect !== null && afterSelect.firstRestVisible === true &&
        afterSelect.firstRestTop >= afterSelect.dividerBottom,
      JSON.stringify(afterSelect))

    // ── 置頂段內的目標不觸發捲動
    //
    // 選中一個**置頂的** repo（它恆常完整可見）時，其餘段的捲動位置 SHALL NOT 改變。
    // 一個誤用 `scroll-padding-top` 的實作會在這裡把畫面拉回頂端。
    await app.client.evaluate(FORCE_REST_BOTTOM)
    await sleep(300)
    const beforePinnedSelect = await app.client.evaluate(PINNED_GEOM)
    check(results, `${label}：前提 —— 其餘段此刻確實捲離了頂端`,
      beforePinnedSelect !== null && beforePinnedSelect.restScrollTop > 0,
      JSON.stringify(beforePinnedSelect))
    await app.client.evaluate(SELECT_FOLDER('repo-b'))
    await sleep(500)
    const afterPinnedSelect = await app.client.evaluate(PINNED_GEOM)
    check(results, `${label}：切換至置頂的 repo 時，其餘段的捲動位置不變`,
      afterPinnedSelect !== null &&
        afterPinnedSelect.restScrollTop === beforePinnedSelect?.restScrollTop,
      `${beforePinnedSelect && beforePinnedSelect.restScrollTop} → ${afterPinnedSelect && afterPinnedSelect.restScrollTop}`)

    // 先把 repo-b 取消置頂 —— 下面那條裁切的斷言需要**兩個**未置頂的 repo 才拖得起來。
    await app.client.evaluate(`${unpinButton('repo-b')}?.click()`)
    await sleep(300)

    // ── 置頂段撐滿時其餘段仍可用（rail-pinning）
    //
    // 把 repo-a（展開著 8 個 session 子列）置頂 —— 置頂段因此遠高於整個 rail。
    // **沒有那條最小高度夾制的話，其餘段是 `flex: 1 1 0%`：它拿不到剩餘空間就是
    // `clientHeight: 0`，整份未置頂的 folder 清單會消失。**
    await app.client.evaluate(`${pinButton('repo-a')}?.click()`)
    const crowded = await pollUntil(
      app.client,
      PINNED_GEOM,
      (v) => v !== null && v.pinnedLabels.includes('repo-a'),
      6000,
    )
    check(results, `${label}：置頂段撐滿整個 rail 時，其餘段仍保有可用的高度`,
      crowded !== null && crowded.restClientHeight > 0 && crowded.firstRestLabel !== null,
      JSON.stringify(crowded))

    // ── 落點不會命中被裁切的列（rail-pinning）
    //
    // 置頂段此刻**自己在內部捲動**（repo-a 帶著 8 個展開的 session 子列）。它的 `<li>` 區塊
    // 其**未裁切**的 rect 一路延伸到其餘段的下方 —— 命中判定若不與容器的可視區取交集，
    // 游標停在一個**看得見**的未置頂列上時，掃描會先命中那個**看不見**的置頂列，
    // 於是「一個使用者根本沒碰過的 repo 被移動並置頂」。
    const REST_LI = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.folderList')}"] > li')]`
    const REST_NAMES = `${REST_LI}.map((li) => li.querySelector(':scope > div[role="button"]')?.getAttribute('aria-label'))`
    const restRowRect = (index) => `(() => {
      const row = ${REST_LI}[${index}]?.querySelector(':scope > div[role="button"]')
      if (!row) return null
      const r = row.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`
    const restBlockRect = (index) => `(() => {
      const li = ${REST_LI}[${index}]
      if (!li) return null
      const r = li.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), top: Math.round(r.top), height: Math.round(r.height) }
    })()`

    const restBefore = await app.client.evaluate(REST_NAMES)
    const pinnedBefore = crowded?.pinnedLabels ?? []
    check(results, `${label}：前提 —— 置頂段確實在內部捲動，且其餘段有兩列可拖`,
      Array.isArray(restBefore) && restBefore.length === 2 &&
        (await app.client.evaluate(`(() => {
          const p = document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.pinnedList')}"]')
          return p.scrollHeight > p.clientHeight + 4
        })()`)) === true,
      JSON.stringify({ restBefore, pinnedBefore }))

    const dragFrom = await app.client.evaluate(restRowRect(0))
    const dragTargetBlock = await app.client.evaluate(restBlockRect(1))
    if (dragFrom && dragTargetBlock) {
      await dragMouse(app.client, dragFrom, {
        x: dragFrom.x,
        y: dragTargetBlock.top + dragTargetBlock.height - 3,
      })
      await sleep(500)
    }
    const restAfter = await app.client.evaluate(REST_NAMES)
    const pinnedAfter = (await app.client.evaluate(PINNED_GEOM))?.pinnedLabels ?? []
    check(results, `${label}：置頂段內部捲動時，其餘段的拖曳落在它該落的地方`,
      JSON.stringify(restAfter) === JSON.stringify([restBefore[1], restBefore[0]]),
      `${JSON.stringify(restBefore)} → ${JSON.stringify(restAfter)}`)
    check(results, `${label}：而且沒有任何被裁切的置頂列被當成落點（置頂段一列都沒變）`,
      JSON.stringify(pinnedAfter) === JSON.stringify(pinnedBefore),
      `${JSON.stringify(pinnedBefore)} → ${JSON.stringify(pinnedAfter)}`)

    // 還原，避免置頂狀態外洩到別的段落（profile 是共用的）。
    await app.client.evaluate(`${unpinButton('repo-a')}?.click()`)
    await sleep(300)

    await app.client.send('Emulation.clearDeviceMetricsOverride', {})
    await sleep(300)
  } finally {
    await app.destroy()
  }
}

// ── ui-appearance: the zoom keys and Ctrl+wheel ────────────────────────────────

const RATIO = 'devicePixelRatio'
const SETTINGS_ZOOM = `document.querySelector('[role="dialog"] select[aria-label="${copy('settings.zoom')}"]')?.value ?? null`
const GRAPH_TRANSFORM = `document.querySelector('section[aria-label="${copy('openspec.label')}"] svg.spekui-graph > g')?.getAttribute('transform') ?? ''`
const IDENTITY_OPENSPEC = IDENTITY_FILES.replace("innerText.includes('Files')", `innerText.includes(${JSON.stringify(copy('panelSwitch.openSpec'))})`)
const GRAPH_RECT = RECT_OF(`section[aria-label="${copy('openspec.label')}"] svg.spekui-graph`)
const CLICK_GRAPH = `(() => {
  const tab = [...document.querySelectorAll('[role="tablist"][aria-label="${copy('openspec.views')}"] button[role="tab"]')]
    .find((el) => el.innerText.trim().endsWith(${JSON.stringify(copy('viz.graph'))}))
  if (!tab) return false
  tab.click()
  return true
})()`

/** One wheel event at `at`; `ctrl` holds Control. CDP's `deltaY` arrives in CSS pixels (-120 → -80 at 150%). */
async function wheel(client, at, deltaY, { ctrl = true } = {}) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: at.x,
    y: at.y,
    deltaX: 0,
    deltaY,
    modifiers: ctrl ? MOD.ctrl : 0,
  })
}

async function checkZoomInput(label, { port, rendererUrl }) {
  const repos = makeFixture()
  // A repo with OpenSpec content for Graph.
  const specRepo = join(ptyOutDir, '..', 'repo-spec')
  mkdirSync(join(specRepo, 'openspec', 'specs', 'core'), { recursive: true })
  mkdirSync(join(specRepo, 'openspec', 'changes', 'zoom-change', 'specs', 'core'), { recursive: true })
  writeFileSync(join(specRepo, 'openspec', 'config.yaml'), 'schema: spec-driven\n')
  writeFileSync(
    join(specRepo, 'openspec', 'specs', 'core', 'spec.md'),
    '# core Specification\n\n## Purpose\n\nx\n\n## Requirements\n\n### Requirement: core works\n\nThe system SHALL work.\n\n#### Scenario: Normal\n\n- **WHEN** a\n- **THEN** b\n',
  )
  writeFileSync(join(specRepo, 'openspec', 'changes', 'zoom-change', '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-01\n')
  writeFileSync(join(specRepo, 'openspec', 'changes', 'zoom-change', 'proposal.md'), '# Zoom\n\n## Why\n\nBecause.\n')
  writeFileSync(
    join(specRepo, 'openspec', 'changes', 'zoom-change', 'specs', 'core', 'spec.md'),
    '## MODIFIED Requirements\n\n### Requirement: core works\n\nThe system SHALL work differently.\n\n#### Scenario: Normal\n\n- **WHEN** a\n- **THEN** b\n',
  )
  const profile = seedProfile([...repos, ['repo-spec', specRepo]])
  // GPU off: the DOM renderer's rows can be read, which is how "the terminal does not scroll" is seen.
  writeFileSync(
    join(profile, 'preferences.json'),
    JSON.stringify({ version: 1, terminal: { gpuAcceleration: false }, ui: { language: 'en', theme: 'dark' } }),
  )
  const app = await launch({ port, profileDir: profile, rendererUrl })
  // `devicePixelRatio` is a float (1.100000023841858 at 110%): rounded to two places for the comparisons.
  const ratio = (value, what) =>
    pollUntil(app.client, `Math.round(${RATIO} * 100) / 100`, (v) => v === value, 4000).then((v) => {
      if (v !== value) console.log(`  (${what}: devicePixelRatio ${v}, expected ${value})`)
      return v
    })

  try {
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)
    await createSession(app.client)
    const term = await pollUntil(app.client, TERMINAL_RECT, (v) => v !== null, 8000)
    await sleep(1500)
    await realClick(app.client, term)
    await sleep(200)
    await typeLine(app.client, `cat -A > ${join(ptyOutDir, 'zoom-keys.txt')}`)
    await sleep(800)
    await pressKey(app.client, 'ArrowUp') // positive control: an uncaught key reaches the pty
    await pressEnter(app.client)
    const control = await waitForPtyFile('zoom-keys.txt', (value) => value.includes('^[[A'))
    check(results, `${label}：[zoom] precondition: an uncaught key reaches the pty`, control.includes('^[[A'), JSON.stringify(control))

    // From the terminal: in, out, reset; none of them reaches the pty.
    await pressKey(app.client, 'equal', ['ctrl'])
    const zoomedIn = await ratio(1.1, 'Ctrl+=')
    await pressKey(app.client, 'minus', ['ctrl'])
    const zoomedOut = await ratio(1, 'Ctrl+-')
    await pressKey(app.client, 'equal', ['ctrl'])
    await pressKey(app.client, 'equal', ['ctrl'])
    await ratio(1.25, 'Ctrl+= twice')
    await pressKey(app.client, 'digit0', ['ctrl'])
    const reset = await ratio(1, 'Ctrl+0')
    // `Ctrl+Shift+-` is ^_ (undo in readline and zsh): it must not zoom and must reach the pty.
    await pressKey(app.client, 'underscore', ['ctrl', 'shift'])
    await sleep(300)
    const afterUnderscore = await app.client.evaluate(`Math.round(${RATIO} * 100) / 100`)
    await pressEnter(app.client)
    const keys = await waitForPtyFile('zoom-keys.txt', (value) => value.includes('^_'))
    const lines = keys.split('\n').filter(Boolean)
    check(
      results,
      `${label}：[zoom] Ctrl+= / Ctrl+- / Ctrl+0 from the terminal zoom in, out and reset`,
      zoomedIn === 1.1 && zoomedOut === 1 && reset === 1,
      `in ${zoomedIn}, out ${zoomedOut}, reset ${reset}`,
    )
    check(
      results,
      `${label}：[zoom] the zoom keys do not reach the pty`,
      // Only the control's line and the ^_ line: nothing from the five zoom keys.
      lines.length === 2 && lines[0] === '^[[A$' && lines[1] === '^_$',
      JSON.stringify(keys),
    )
    check(
      results,
      `${label}：[zoom] Ctrl+Shift+- does not zoom and reaches the pty as ^_`,
      afterUnderscore === 1 && lines[1] === '^_$',
      `devicePixelRatio ${afterUnderscore}; pty line ${JSON.stringify(lines[1])}`,
    )
    // Leave cat: Ctrl+C.
    await app.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: MOD.ctrl })
    await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: MOD.ctrl })
    await sleep(300)

    // With the naming dialog open: the zoom changes and the dialog stays.
    const tab0 = center(await app.client.evaluate(TAB_RECT(0)))
    await realMouse(app.client, tab0.x, tab0.y, 'right')
    await pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === true, 4000)
    await pressKey(app.client, 'equal', ['ctrl'])
    const inDialog = await ratio(1.1, 'Ctrl+= with the dialog')
    const dialogStays = await app.client.evaluate(DIALOG_OPEN)
    await pressKey(app.client, 'digit0', ['ctrl'])
    await ratio(1, 'reset')
    await pressKey(app.client, 'Escape')
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === false, 4000)
    check(
      results,
      `${label}：[zoom] the zoom keys work while a dialog is open, which stays open`,
      inDialog === 1.1 && dialogStays === true,
      `devicePixelRatio ${inDialog}; dialog open ${dialogStays}`,
    )

    // With Settings open on General: Ctrl+- zooms out and its control shows it.
    await realClick(app.client, await app.client.evaluate(RECT_OF(`nav[aria-label="${copy('activityBar.label')}"] button[aria-label="${copy('activityBar.settings')}"]`)))
    await pollUntil(app.client, SETTINGS_ZOOM, (value) => value !== null, 6000)
    await pressKey(app.client, 'minus', ['ctrl'])
    const inSettings = await ratio(0.9, 'Ctrl+- in Settings')
    const shown = await pollUntil(app.client, SETTINGS_ZOOM, (value) => value === '90', 4000)
    const settingsStays = await app.client.evaluate(DIALOG_OPEN)
    check(
      results,
      `${label}：[zoom] Ctrl+- with Settings open zooms out, Settings stays open and shows the new value`,
      inSettings === 0.9 && shown === '90' && settingsStays === true,
      `devicePixelRatio ${inSettings}; Settings shows ${shown}; open ${settingsStays}`,
    )
    await pressKey(app.client, 'digit0', ['ctrl'])
    await ratio(1, 'reset')
    await pressKey(app.client, 'Escape')
    await pollUntil(app.client, DIALOG_OPEN, (value) => value === false, 4000)

    // From the editor at 150%: Ctrl+0 resets, the content is unchanged.
    for (let step = 0; step < 3; step += 1) await pressKey(app.client, 'equal', ['ctrl'])
    const at150 = await ratio(1.5, 'three steps up')
    check(results, `${label}：[zoom] switch to the Files identity`, (await app.client.evaluate(IDENTITY_FILES)) === true)
    await pollUntil(app.client, OPEN_FILE('notes.txt'), (value) => value === true, 8000)
    await pollUntil(app.client, EDITOR_TEXTAREA_FOCUSED, (value) => value === true, 10_000)
    const editorBefore = await pollUntil(app.client, EDITOR_LINES, (value) => typeof value === 'string' && value.length > 0, 6000)
    await pressKey(app.client, 'digit0', ['ctrl'])
    const fromEditor = await ratio(1, 'Ctrl+0 from the editor')
    const editorAfter = await app.client.evaluate(EDITOR_LINES)
    check(
      results,
      `${label}：[zoom] Ctrl+0 from the editor resets to 100%, the editor's content unchanged`,
      at150 === 1.5 && fromEditor === 1 && editorAfter === editorBefore,
      `150% → ${fromEditor}; content same=${editorAfter === editorBefore}`,
    )

    // Ctrl+wheel over the terminal: one step per notch at 100% and at 150%, and the terminal does not scroll.
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await sleep(200)
    await typeLine(app.client, 'seq 1 300')
    await sleep(800)
    const terminalAt = center(await app.client.evaluate(TERMINAL_RECT))
    await wheel(app.client, terminalAt, -120)
    const wheel100 = await ratio(1.1, 'one notch at 100%')
    for (let step = 0; step < 2; step += 1) await pressKey(app.client, 'equal', ['ctrl'])
    await ratio(1.5, '150%')
    await wheel(app.client, center(await app.client.evaluate(TERMINAL_RECT)), -120)
    const wheel150 = await ratio(1.75, 'one notch at 150%')
    check(
      results,
      `${label}：[zoom] a Ctrl-wheel notch over the terminal zooms one step, at 100% and at 150%`,
      wheel100 === 1.1 && wheel150 === 1.75,
      `100% → ${wheel100}; 150% → ${wheel150}`,
    )
    // "Does not scroll" is read at the top step, where a Ctrl-wheel up cannot change the zoom (and with it the
    // rows): a plain wheel scrolls the rows (the positive control); a Ctrl-wheel then leaves them as they are.
    await sleep(600)
    const scrollAt = center(await app.client.evaluate(TERMINAL_RECT))
    const rowsBottom = await app.client.evaluate(TERMINAL_TEXT)
    await wheel(app.client, scrollAt, -120, { ctrl: false })
    await sleep(500)
    const rowsScrolled = await app.client.evaluate(TERMINAL_TEXT)
    await wheel(app.client, scrollAt, -120)
    await sleep(500)
    const rowsAfter = await app.client.evaluate(TERMINAL_TEXT)
    const atTop = await app.client.evaluate(`Math.round(${RATIO} * 100) / 100`)
    check(results, `${label}：[zoom] precondition: a plain wheel scrolls the terminal`, rowsScrolled !== rowsBottom, `first row ${JSON.stringify(rowsBottom.split('\n')[0])} → ${JSON.stringify(rowsScrolled.split('\n')[0])}`)
    check(
      results,
      `${label}：[zoom] the Ctrl-wheel does not scroll the terminal`,
      atTop === 1.75 && rowsAfter === rowsScrolled,
      `zoom ${atTop}; first row ${JSON.stringify(rowsScrolled.split('\n')[0])} → ${JSON.stringify(rowsAfter.split('\n')[0])}`,
    )
    await pressKey(app.client, 'digit0', ['ctrl'])
    await ratio(1, 'reset')

    // A run of small deltas (a touchpad): together one notch, one step.
    const smallAt = center(await app.client.evaluate(TERMINAL_RECT))
    for (let event = 0; event < 4; event += 1) await wheel(app.client, smallAt, -25)
    const small = await ratio(1.1, 'four small deltas')
    await sleep(500)
    const smallSettled = await app.client.evaluate(`Math.round(${RATIO} * 100) / 100`)
    check(
      results,
      `${label}：[zoom] a run of small Ctrl-wheel movements adding up to one notch zooms one step`,
      small === 1.1 && smallSettled === 1.1,
      `devicePixelRatio ${small} → ${smallSettled}`,
    )
    await pressKey(app.client, 'digit0', ['ctrl'])
    await ratio(1, 'reset')

    // Over a full-screen program (the alternate screen): xterm would turn a wheel into arrow keys.
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await sleep(200)
    await typeLine(app.client, `printf '\\033[?1049h'; cat -A > ${join(ptyOutDir, 'alt-wheel.txt')}`)
    await sleep(800)
    const altAt = center(await app.client.evaluate(TERMINAL_RECT))
    await wheel(app.client, altAt, -120, { ctrl: false }) // positive control: a plain wheel reaches the pty
    await pressEnter(app.client)
    const altControl = await waitForPtyFile('alt-wheel.txt', (value) => /\^\[(\[|O)A/.test(value))
    await wheel(app.client, altAt, -120)
    const altZoom = await ratio(1.1, 'Ctrl-wheel over the alternate screen')
    await pressEnter(app.client)
    await sleep(600)
    const altText = await waitForPtyFile('alt-wheel.txt', () => true, 1500)
    const altLines = altText.split('\n').filter(Boolean)
    check(results, `${label}：[zoom] precondition: a plain wheel over the alternate screen reaches the pty`, /\^\[(\[|O)A/.test(altControl), JSON.stringify(altControl))
    check(
      results,
      `${label}：[zoom] a Ctrl-wheel over a full-screen program zooms and sends nothing to the pty`,
      altZoom === 1.1 && altLines.length === 2 && altLines[1] === '$',
      `devicePixelRatio ${altZoom}; pty lines ${JSON.stringify(altLines)}`,
    )
    await pressKey(app.client, 'digit0', ['ctrl'])
    await ratio(1, 'reset')

    // Over Graph: the interface zooms, the graph's own scale does not.
    await pollUntil(app.client, SELECT_FOLDER('repo-spec'), (value) => value === true, 10_000)
    await pollUntil(app.client, IDENTITY_OPENSPEC, (value) => value === true, 8000)
    await pollUntil(app.client, CLICK_GRAPH, (value) => value === true, 8000)
    const graphAt = center(await pollUntil(app.client, GRAPH_RECT, (v) => v !== null, 10_000))
    await sleep(1500)
    const transformBefore = await app.client.evaluate(GRAPH_TRANSFORM)
    await wheel(app.client, graphAt, -120, { ctrl: false }) // positive control: a plain wheel zooms the graph
    const plainTransform = await pollUntil(app.client, GRAPH_TRANSFORM, (v) => v !== transformBefore, 3000)
    await wheel(app.client, graphAt, -120)
    const graphZoom = await ratio(1.1, 'Ctrl-wheel over Graph')
    await sleep(400)
    const ctrlTransform = await app.client.evaluate(GRAPH_TRANSFORM)
    check(results, `${label}：[zoom] precondition: a plain wheel over Graph zooms the graph`, plainTransform !== transformBefore, `${transformBefore} → ${plainTransform}`)
    check(
      results,
      `${label}：[zoom] a Ctrl-wheel over Graph zooms the interface, not the graph`,
      graphZoom === 1.1 && ctrlTransform === plainTransform,
      `devicePixelRatio ${graphZoom}; graph transform ${plainTransform} → ${ctrlTransform}`,
    )
  } finally {
    await app.client.evaluate('window.workspace.settings.setZoom(null)').catch(() => undefined)
    await app.destroy()
  }
}

/**
 * 五個段落**彼此獨立** —— 每一段各自 `makeFixture()`、`seedProfile()`、`launch()` 與收屍
 * （實際逐段確認，非假設），因此沒有一項需要宣告 `deps`。
 *
 * 此前這裡是六行寫死的呼叫，沒有段落機制 —— 於是任何一段 throw 就吃掉其後全部，而迭代時
 * 想單獨重跑一段只能整支跑（實測一輪 332 秒）。
 */
/** 逾時收屍 —— 逾時的段落不會走到自己的 `finally`。pattern 以字元類別自我豁免。 */
const killStrays = () => {
  try {
    execFileSync('pkill', ['-9', '-f', 'spekterm-keyboard-[p]rofile'], { stdio: 'ignore' })
  } catch {
    // 沒有殘留
  }
}

const SECTIONS = [
  { name: 'runMode', run: runMode, onTimeout: killStrays },
  { name: 'checkSingleFolder', run: checkSingleFolder, onTimeout: killStrays },
  { name: 'checkReordering', run: checkReordering, onTimeout: killStrays },
  { name: 'checkEmptyWorkspace', run: checkEmptyWorkspace, onTimeout: killStrays },
    { name: 'checkScrollAnchoring', run: checkScrollAnchoring, onTimeout: killStrays },
  { name: 'checkHibernateShortcut', run: checkHibernateShortcut, onTimeout: killStrays },
  { name: 'checkMaximizeShortcut', run: checkMaximizeShortcut, onTimeout: killStrays },
  { name: 'checkZoomInput', run: checkZoomInput, onTimeout: killStrays },
]

const outcome = await runSections({
  sections: SECTIONS,
  build: { port: BUILD_PORT, rendererUrl: null },
  dev: { port: DEV_PORT, start: startRendererDevServer },
  results,
  cleanup: () => {
    for (const dir of temps) {
      try {
        execFileSync('rm', ['-rf', dir])
      } catch {
        // 清不掉就算了
      }
    }
  },
})

process.exit(outcome.ok ? 0 : 1)
