/**
 * desktop-packaging：驗證**打包產物本身**。
 *
 * 其餘九支探針驗的是 `electron .` 載入 `out/` 的那份執行 —— 那**不是被出貨的東西**。
 * 出貨的是一個 asar：主行程、preload 與 renderer 全部住在一個唯讀的虛擬檔案系統裡，
 * 而其中一個相依（node-pty 的 `.node`）**在那裡面根本無法載入**。這支探針是唯一會發現
 * 那件事的東西。
 *
 * ## 四條斷言，以及為什麼是這四條
 *
 * | 斷言 | 打包可能怎麼弄壞它 |
 * |---|---|
 * | AppImage 存在且可執行 | 目標設定被改掉、`directories.output` 改了 |
 * | 產物脫離 repo 仍可執行 | `files` 漏了東西，於是產物靠著 repo 工作副本才跑得起來 |
 * | `document.title` 為產品名 | ESM 進入點在 asar 內解析失敗、`loadFile` 的相對路徑跑掉 |
 * | 建立 session 後真的有一個 pty | **`asarUnpack` 漏掉 node-pty ⇒ `dlopen` 失敗** |
 * | production CSP 生效 | `onHeadersReceived` 對 asar 內的 `file://` 不觸發 |
 *
 * ## pty 的判準是「行程 + 副作用」，不是「畫面上的輸出」
 *
 * 直覺會想斷言「終端畫面出現了指令的輸出」。**不採用**，理由不是省事：
 *
 * 1. **讀畫面的手法綁死 renderer 種類。** `.xterm-rows` 只存在於 DOM renderer，GPU renderer
 *    把畫面畫進 `<canvas>` 之後它就消失了 —— 而它讀不到時**回空字串**，於是斷言會以一種
 *    看起來像產品壞掉的方式紅掉。`probe:terminal` 為此改走「產品自己的複製路徑」（拖曳選取
 *    → 右鍵複製 → 讀剪貼簿），那是一整套帶著座標校準的機制。
 * 2. **而那一整套機制驗的東西與打包無關。** pty → 主行程 → IPC → renderer → xterm 這條路徑
 *    **全是 JavaScript**，全部住在 asar 內，而「asar 內的 JS 載入正常」已經由
 *    `document.title` 那條斷言證明了。打包唯一能弄壞的是 **native 模組的載入**。
 *
 * 因此判準是：**pty 行程真的存在**（`dlopen` 成功、`forkpty` 成功），且**它底下的 shell 真的
 * 執行了我們送進去的指令**（雙向可用）。後者以「指令在磁碟上留下的副作用」判定 ——
 * 一個不受 renderer 種類影響、也不會在讀不到時靜默回空的判準。
 *
 * ## 為什麼不併進 `npm run test:e2e`
 *
 * 它得先跑一次完整打包（數分鐘）。`test:e2e` 已經十幾分鐘 —— 再加上去會把它推到沒有人願意
 * 跑的長度，而一個沒有人跑的驗收等於不存在。這支屬於**換版前跑一次**的層級。
 *
 * 用法：npm run probe:package
 *       PROBE_PACKAGE_APPIMAGE=<path> node scripts/run-probe.mjs package   # 迭代時重用既有產物
 * 結束碼 0 表示全部 scenario 通過。
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { check, connectToApp, pollFor, pollUntil, retryAction } from './lib/cdp.mjs'
import { menuEvidence } from './lib/menu-evidence.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { copy } from './lib/copy.mjs'
import { MOUNTED_WITHOUT_VISIBILITY as MOUNTED, awaitMounted, describeMounted } from './lib/mounted.mjs'
import { PROBE_PORTS } from './lib/ports.mjs'
import { openSettings } from './lib/settings.mjs'
import { seedLanguage } from './lib/probe-language.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEBUG_PORT = PROBE_PORTS.package.main
const STARTUP_TIMEOUT_MS = 60_000

/** pty 的 shell。固定寫死，才數得出它的行程（見 `ptyPids`）。 */
const SHELL_PATH = '/bin/sh'

/**
 * 把一個獨一無二的字串塞進 app 的環境，pty 會整份繼承 —— 於是讀 `/proc` 底下每個行程的
 * `environ` 就認得出「這一輪」開出來的 pty，不會把別處跑著的 shell 算進來。
 *
 * **名字不得以 `SPEKTERM_` 開頭。** `ptyEnv()` 會剝掉所有 `SPEKTERM_` 開頭的變數（`agent-peer-name`：
 * 那是本應用程式替 session 設定的專屬變數，不從外層繼承）—— 標記曾經就叫 `SPEKTERM_PROBE_MARKER`，
 * 於是在那次改動之後 pty 裡根本沒有它，「產生了一個真實 pty」這條恆紅，而產品完全沒壞。
 */
const MARKER_VAR = 'PROBE_PACKAGE_MARKER'
const marker = `spekterm-package-${process.pid}-${process.hrtime.bigint()}`

// ── 產物 ────────────────────────────────────────────────────────────────────

/**
 * 挑出**當前宣告的版本**所對應的產物。
 *
 * **不用排序挑最後一個。** 版本逐次遞增之後 `release/` 會並存多份，而字典序不是版本序
 * （`Spekterm-0.1.10` 排在 `Spekterm-0.1.9` **之前**）—— 依檔名排序會在第十次打包起挑錯。
 * 更根本的是：規格在乎的不是「哪一個最近被寫」也不是「哪一個排在最後」，而是**哪一個對應
 * 當前宣告的版本**。以版本建構檔名回答的正是那個問題。
 *
 * 找不到即回 `null`，由呼叫端明確失敗 —— 這裡不做任何退而求其次的猜測。
 */
function findAppImage() {
  const override = process.env.PROBE_PACKAGE_APPIMAGE
  if (override) return override

  const releaseDir = join(repoRoot, 'release')
  if (!existsSync(releaseDir)) return null

  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const expected = join(releaseDir, `Spekterm-${version}.AppImage`)
  return existsSync(expected) ? expected : null
}

/**
 * AppImage 執行時會把自己掛載到 `/tmp/.mount_XXXXXX`。強殺行程可能留下掛載點，
 * 而殘留的掛載點會讓後續的打包或執行以看似無關的方式失敗。
 */
function mountPoints() {
  try {
    return new Set(readdirSync('/tmp').filter((name) => name.startsWith('.mount_')))
  } catch {
    return new Set()
  }
}

/**
 * 帶著 marker 的 pty shell 行程。
 *
 * 認定方式與 `probe:terminal` 同源：pty 自主行程繼承 env（marker 在裡面），而 `cmdline` 的
 * 第一段是被 spawn 的可執行檔。**讀 `/proc` 而不是 `ps`** —— 後者會截斷長 argv。
 */
function ptyPids() {
  const pids = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (!readFileSync(`/proc/${entry}/environ`, 'utf8').includes(marker)) continue
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
      // `cmdline` 以 NUL 分隔。**這裡必須是 escape 序列，不能是字面的 NUL 位元組** ——
      // 後者會讓 `git diff` 與 `grep` 對整個檔案瞎掉，而 grep 是回空 + exit 1，連
      // 「binary file」都不說（見 CLAUDE.md；本檔在初版就踩了一次）。
      if (cmdline.split('\0')[0] === SHELL_PATH) pids.push(Number(entry))
    } catch {
      // 行程在我們讀它的途中結束了 —— 那就不算數。
    }
  }
  return pids
}

/**
 * 這一輪啟動的 AppImage 掛載在哪裡：**啟動之後比啟動之前多出來的那一個掛載點**。
 *
 * 另外兩個看起來更直接的做法都實測失敗過，別換回去：
 *
 * - **列舉 `/tmp/.mount_*`** —— 使用者自己正在跑的 Spekterm 也有一個掛載點，會抓錯。
 * - **讀行程的 `APPDIR` 或 `/proc/<pid>/exe`** —— 探針若在一個由 Spekterm 開出來的終端裡被
 *   執行，它繼承的 `APPDIR` 是**那一份**產物的，而 runtime 不會覆寫它；Electron 的行程又把
 *   自己設成不可 dump，`environ` 與 `exe` 都讀不到。掛載表裡的來源只記檔名，與使用者那份同名。
 *
 * 集合相減之後必須**恰好一個** —— 多於一個代表同一時間有別的 AppImage 被啟動，那時寧可紅也不猜。
 */
function newMountPoints(before) {
  return [...mountPoints()].filter((name) => !before.has(name)).map((name) => join('/tmp', name))
}

async function waitForPty(expected, timeoutMs = 20_000) {
  return pollFor({
    read: () => ptyPids(),
    settled: (pids) => pids.length === expected,
    timeoutMs,
    interval: 200,
    label: `waitForPty（期待 ${expected} 個 pty）`,
  })
}

// ── 頁面上的量測 ─────────────────────────────────────────────────────────────

const RECT_OF = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/** rail 上那個不隸屬任何 folder 的固定項目的「建立 session」入口。 */
const GLOBAL_NEW_SESSION_RECT = RECT_OF(
  `aside[aria-label="${copy('rail.label')}"] [aria-label="${copy('rail.newSessionIn', { name: copy('rail.globalName') })}"]`,
)

const TERMINAL_RECT = RECT_OF(`section[aria-label="${copy('stage.terminal')}"]`)

/**
 * 設定介面「關於」段呈現的建置身分（`build-identity`）。
 *
 * 讀的是**畫面上的文字**，不是任何內部狀態 —— 規格在乎的是「使用者看得到自己跑的是哪一版」。
 */
const BUILD_IDENTITY = `(() => {
  const s = document.querySelector('[role="group"][aria-label="${copy('settings.about')}"]')
  if (!s) return null
  const text = s.textContent ?? ''
  return {
    text,
    version: text.match(/\\d+\\.\\d+\\.\\d+/)?.[0] ?? null,
    hasBuiltAt: text.includes('${copy('settings.aboutBuilt')}'),
    hasCommit: text.includes('${copy('settings.aboutCommit')}'),
    development: text.includes('${copy('settings.aboutDevelopment')}'),
  }
})()`

const MENU_ITEM_RECT = (text) => `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const item = [...menu.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(text)}))
  if (!item) return null
  const r = item.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/**
 * CSP violation 收集器 —— 違規事件的 `originalPolicy` 就是**實際施加到這個 renderer 的**
 * 完整政策字串。
 *
 * **注入時機有兩個相反的夾制，而「越早越好」是錯的**（實測踩過，紅了一輪）：
 *
 * - 必須在觸發違規的請求**之前** —— 它只捕捉其後派送的違規。
 * - 但也必須在**頁面導航完成之後**。Electron 的 renderer 起初是 `about:blank`，隨後才導航到
 *   asar 內的 `index.html`；在那之前注入，listener 會**隨著舊 context 一起消失**。
 *
 * 失效方式是最難解讀的那種：政策明明生效（inline script 確實被擋），但收集器讀到空字串，
 * 於是斷言以「CSP 不存在」的形狀紅掉 —— 指向一個根本不存在的安全退化。
 */
const CSP_ARM = `(() => {
  window.__csp = ''
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp = e.originalPolicy || window.__csp
  })
  return true
})()`

/** `connect-src 'self'` 一定擋下它，於是我們拿得到實際政策。 */
const TRIGGER_CSP = `fetch('https://example.com/csp-probe').catch(() => {})`

async function realClick(client, rect) {
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    })
  }
}

/**
 * 送一行指令給終端。
 *
 * **Enter 必須是一次真正的按鍵事件** —— 實測（`probe:terminal`）把 `\r` 併進 `insertText`
 * 的文字裡，字元確實送達 pty、終端上也看得到回顯，但 shell 從未執行那一行：xterm 的換行是在
 * keydown 上判讀的，不是從 textarea 的內容剖析出來的。
 */
async function typeLine(client, text) {
  await client.send('Input.insertText', { text })
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/** 輪詢一個**磁碟上的**條件（`pollUntil` 求值的是頁面裡的 expression，這裡要的不是那個）。 */
async function pollDisk(predicate, timeoutMs, label = 'pollDisk（磁碟上的條件）') {
  return pollFor({ read: () => predicate(), settled: (value) => value === true, timeoutMs, label })
}

// ── 驗收 ────────────────────────────────────────────────────────────────────

const results = []
const workDir = mkdtempSync('/tmp/spekterm-package-probe-')
const profileDir = join(workDir, 'profile')
const mountsBefore = mountPoints()

let app = null
let stderr = ''

console.log('desktop-packaging 驗收：\n')

try {
  const source = findAppImage()
  if (!source) {
    throw new Error(
      '找不到 AppImage —— 先跑 `npm run dist:linux`，或以 PROBE_PACKAGE_APPIMAGE 指定路徑',
    )
  }

  // 「產出可執行的 AppImage」：檔案存在，且對擁有者可執行。
  const mode = statSync(source).mode
  check(results, '打包指令產出可執行的 AppImage', (mode & 0o111) !== 0,
    `${source}（mode ${(mode & 0o777).toString(8)}）`)

  /**
   * build-identity：〈檔名含當次的版本〉。
   *
   * **以列舉判定，不以建構判定。** `findAppImage()` 是用宣告的版本**組出**期望檔名的 ——
   * 拿它的回傳值去斷言「檔名含該版本」，被觀察值就是被建構值，**不可能紅**。
   * 這裡改為列舉 `release/` 之下實際存在的產物，於是 `artifactName` 若被改成不含版本，
   * 這條會失敗。
   */
  const declaredVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const releaseNames = existsSync(join(repoRoot, 'release'))
    ? readdirSync(join(repoRoot, 'release')).filter((name) => name.endsWith('.AppImage'))
    : []
  const versionedNames = releaseNames.filter((name) => name.includes(declaredVersion))
  check(results, '產物的檔名帶有該次打包的版本', versionedNames.length > 0,
    `宣告版本 ${declaredVersion}；release/ 之下的產物：${releaseNames.join(', ') || '（無）'}`)

  /**
   * build-identity：〈遞增不倚賴任何額外的人工步驟〉。
   *
   * **這條的上界要讀到**：走 `PROBE_PACKAGE_APPIMAGE` 時 `dist:linux` 根本沒跑，它會讀到上一輪
   * 留下的狀態而照樣綠。真正擋住「`release-bump` 被從 `dist:linux` 拿掉」的是
   * `scripts/packaging-config.test.mjs` 的秒級靜態守衛。
   */
  const headSubject = execFileSync('git', ['log', '-1', '--no-color', '--format=%s'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
  }).trim()
  check(results, '打包指令自身遞增版本並提交（未依賴人工步驟）',
    headSubject === `chore(release): ${declaredVersion}`,
    `HEAD="${headSubject}"，package.json=${declaredVersion}`)

  /**
   * **複製到 repo 之外再執行** —— 這正是「與 repo 脫鉤」那條 requirement 的驗收方式。
   * 就地執行 `release/…` 驗不到它：產物仍待在工作副本裡，任何對 repo 檔案的殘留相依
   * 都會**照常滿足**，於是 `files` 漏了東西也看不出來。
   */
  const appImage = join(workDir, 'Spekterm.AppImage')
  copyFileSync(source, appImage)
  chmodSync(appImage, 0o755)

  // pty 自主行程繼承 env：SHELL 決定 spawn 什麼，marker 讓我們清點得出它的行程。
  const env = { ...process.env, SHELL: SHELL_PATH, [MARKER_VAR]: marker }
  // production CSP 的前提是「沒有 dev server」。`electron-vite dev` 會把這個變數洩漏到 shell，
  // 而繼承到它的話，打包產物會拿到 **dev 政策** —— 那條斷言就會以最難解讀的方式紅掉。
  delete env.ELECTRON_RENDERER_URL
  // 同理：探針若在一個由 AppImage 版 Spekterm 開出來的終端裡執行，這幾個變數描述的是**那一份**
  // 產物（實測 runtime 不會覆寫繼承來的 `APPDIR`）。
  for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[name]

  // 被測 app 的語言是**被指定的**：全新的 profile 會觸發首次啟動的語言偵測，
  // 而在一台非英文的機器上，那會讓每一條 `aria-label` 選擇器選不到元素。
  seedLanguage(profileDir)

  const child = spawn(
    appImage,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      ...electronExtraArgs(),
    ],
    { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], env, detached: true },
  )
  app = child
  child.stderr?.on('data', (chunk) => (stderr += chunk))
  child.stdout?.on('data', (chunk) => (stderr += chunk))

  const client = await connectToApp(DEBUG_PORT, { targetTimeoutMs: STARTUP_TIMEOUT_MS })

  /**
   * 視窗載入成功同時證明了 **ESM 進入點在 asar 內解析成功**：`package.json` 宣告
   * `type: "module"`，主行程產物是 ESM、preload 是 `.mjs` —— 解析失敗的話 app 根本開不起來。
   */
  const title = await pollUntil(client, 'document.title', (value) => Boolean(value))
  check(results, '打包產物開啟視窗並載入 renderer', title === 'spekterm', `title="${title}"`)
  check(results, '產物脫離 repo 仍可執行', !appImage.startsWith(repoRoot), appImage)

  await awaitMounted(client, { expression: MOUNTED })

  // ── 授權文字（project-license）────────────────────────────────────────────
  /**
   * MIT 要求散布的副本附上授權聲明 —— spekterm 自己的，與被打包的第三方套件的。
   * 驗的是**執行中的產物**的根目錄，不是 `release/` 裡那個檔案被解開的樣子。
   */
  const appDirs = newMountPoints(mountsBefore)
  check(results, '找得到這一輪產物的掛載點', appDirs.length === 1, `新增的掛載點：${JSON.stringify(appDirs)}`)
  const appDir = appDirs[0]
  const shippedLicense = appDir && existsSync(join(appDir, 'LICENSE')) ? readFileSync(join(appDir, 'LICENSE')) : null
  check(results, '產物根目錄的 LICENSE 與版控中的逐位元組相同',
    shippedLicense !== null && shippedLicense.equals(readFileSync(join(repoRoot, 'LICENSE'))),
    shippedLicense === null ? `${appDir ?? '(無掛載點)'}/LICENSE 不存在` : `${shippedLicense.length} bytes`)
  const summaryPath = appDir ? join(appDir, 'THIRD_PARTY_LICENSES.txt') : null
  const summary = summaryPath && existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : ''
  // 點名的五個：三個被打進 renderer bundle、兩個原樣出貨 —— 兩種來源各自漏掉都會紅。
  const REQUIRED = ['react', 'monaco-editor', '@xterm/xterm', 'i18next', 'node-pty']
  const lines = summary.split('\n')
  const missingPackages = REQUIRED.filter((name) => {
    const at = lines.findIndex((line, index) => line.startsWith(`${name}@`) && lines[index + 1]?.startsWith('License: '))
    // 條目之後（隔一條分隔線）緊接的是授權本文，不是「沒有授權檔」的註記。
    return at === -1 || lines[at + 3]?.includes('does not include a license file')
  })
  check(results, '產物根目錄的第三方授權彙總涵蓋被打包與原樣出貨的套件，且各帶授權本文',
    summary !== '' && missingPackages.length === 0,
    summary === '' ? `${summaryPath ?? '(無掛載點)'} 不存在` : `缺少或無本文：${missingPackages.join(', ') || '無'}`)
  check(results, '第三方授權彙總保留了內嵌第三方原始碼的聲明',
    summary.includes('@license DOMPurify'),
    'monaco-editor 內嵌的 DOMPurify —— 它不是獨立套件，打包後的程式碼裡已沒有這段註解')
  // Electron's and Chromium's own texts ship beside the binary, not in the summary (`project-license`).
  // On Linux electron-builder puts them at the root; the macOS bundle needs the `afterPack` hook for it.
  const electronLicences = ['LICENSE.electron.txt', 'LICENSES.chromium.html']
  const missingElectron = electronLicences.filter((name) => !appDir || !existsSync(join(appDir, name)))
  check(results, 'the AppImage root carries Electron\'s and Chromium\'s licence texts',
    missingElectron.length === 0, `missing: ${missingElectron.join(', ') || 'none'}`)


  // ── production CSP ────────────────────────────────────────────────────────
  // **導航完成之後**才武裝收集器（見 `CSP_ARM` 的說明）—— 此時 MOUNTED 已成立。
  await client.evaluate(CSP_ARM)
  await client.evaluate(TRIGGER_CSP)
  const policy = await pollUntil(client, 'window.__csp ?? ""', (value) => Boolean(value), 8000)
  const scriptSrc = String(policy)
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src'))

  check(results, '打包產物的 renderer 收到 production CSP',
    scriptSrc === "script-src 'self'" && !String(policy).includes('ws:'),
    `script-src="${scriptSrc ?? '(缺)'}"`)

  // ── pty ───────────────────────────────────────────────────────────────────
  /**
   * **走全域項目，不加任何 folder** —— 它不需要 workspace 裡有東西，於是這一段完全不必碰
   * 檔案對話框（那是原生 UI，CDP 打不到）。
   */
  // **預算 21 秒的推導**：一輪 ＝ 等入口的 15 秒 ＋ 等項目的 6 秒；收斂前是一輪（不重試）。
  // 入口的窗口比其他站點寬，是因為這一支等的是**真正的 AppImage** 冷啟動。
  let clicked = null
  const shellItem = await retryAction({
    act: async () => {
      const plus = await pollUntil(client, GLOBAL_NEW_SESSION_RECT, (value) => value !== null, 15_000)
      if (!plus) throw new Error('rail 上找不到全域項目的建立 session 入口')
      clicked = plus
      await realClick(client, plus)
    },
    read: () => client.evaluate(MENU_ITEM_RECT(copy('sessions.spawnShell'))),
    settled: (value) => value !== null,
    attemptWindowMs: 6000,
    timeoutMs: 21_000,
    label: 'rail 上全域項目的 spawn 選單',
    evidence: () => menuEvidence(client, { expected: copy('sessions.spawnShell'), clicked }),
  })
  if (!shellItem) throw new Error('spawn 選單沒有出現（重試預算 21s 耗盡）')
  await realClick(client, shellItem)

  const pids = await waitForPty(1)
  check(results, '打包產物中建立的 session 產生了一個真實 pty', pids.length === 1,
    `pty 行程數 = ${pids.length}${pids.length === 0 ? '（native 模組載入失敗、或 pty 配置失敗時就是這個徵狀）' : ''}`)

  /**
   * **掃描行程要在打包產物裡 fork 得起來。**
   *
   * `utilityProcess.fork` 載入的是 `out/main/insights-worker.js`，而打包後它在 **asar 之內**。
   * 這條的失效方式正是 `agent-conversation-insights` 的 design D15 記著的那一種：
   * **dev 正常、打包後 `MODULE_NOT_FOUND`** —— 而 app 照樣開得起來、視窗照樣有、pty 照樣能建，
   * 上面那十一條**一條都不會紅**。`test:e2e` 又不含這一支，於是那個失效沒有任何載體。
   *
   * 判準是「掃描跑完了，而且不是因為行程死掉」：`workerExited` 正是 fork 失敗的回報。
   * 來源目錄在這個環境裡通常不存在（探針換過 HOME），那會回報 `source-unavailable` ——
   * **那是成功的一種**：它代表行程起得來、跑完了、把結果送回來了。
   */
  const scan = await pollFor({
    read: () => client.evaluate('window.workspace.insights.refresh().then((s) => ({ phase: s.phase, error: s.error, source: s.sourceAvailable }))', { awaitPromise: true }),
    settled: (value) => value?.phase !== 'running',
    timeoutMs: 30_000,
    interval: 500,
    label: '打包產物中的掃描行程回報結果',
  }).catch((error) => ({ phase: 'timeout', error: error.message, source: null }))
  check(results, '打包產物中的掃描行程 fork 得起來並回報結果',
    scan.phase === 'idle' && scan.error === null,
    `${JSON.stringify(scan)}${scan.error === 'workerExited' ? '（workerExited 正是 asar 內載入失敗的徵狀 —— 比照 node-pty 加進 asarUnpack）' : ''}`)

  // **先把焦點交給終端** —— 剛才點的是選單，`insertText` 會送到那裡去。
  const terminal = await pollUntil(client, TERMINAL_RECT, (value) => value !== null, 6000)
  if (terminal) await realClick(client, terminal)

  /**
   * 雙向可用的判準：指令留在磁碟上的副作用。
   *
   * 它同時排除了「回顯」這個假陽性 —— 字元送達 pty 但 shell 沒有執行時，畫面上一樣看得到
   * 那行字，而檔案不會出現。
   */
  const witness = join(workDir, 'pty-witness.txt')
  const witnessWritten = () =>
    existsSync(witness) && readFileSync(witness, 'utf8').trim() === marker

  await typeLine(client, `printf %s ${marker} > ${witness}`)
  const witnessOk = await pollDisk(witnessWritten, 15_000)
  check(results, '該 session 的 shell 執行了送進去的指令', witnessOk,
    witnessOk ? witness : '副作用未出現（pty 存在，但送進去的指令沒有被執行）')

  /**
   * build-identity：執行中的 app 說得出自己的建置身分。
   *
   * **包在自己的 try/catch 裡**（tasks 7.6a）—— 這支探針是單一 `try` 區塊、沒有段落隔離，
   * 而這一段是需要開對話框的 UI 互動。一次 throw 會連帶帶走上面 pty 與 CSP 那兩條既有斷言。
   */
  try {
    // The build identity is in Settings' About section (`settings-sections`).
    await openSettings(client, 'about')
    const identity = await pollUntil(client, BUILD_IDENTITY, (value) => value !== null, 6000)

    check(results, '設定介面呈現建置身分（版本／建置時刻／commit）',
      identity?.version != null && identity.hasBuiltAt === true && identity.hasCommit === true,
      JSON.stringify(identity))

    /**
     * **兩者一致是承重的。** 各自正確但彼此不同時，使用者依然無法確認手上跑的是不是剛才那份
     * 產物 —— 那等於沒有回答任何問題。
     *
     * 比對的是 **`release/` 的來源檔名**，不是 `workDir` 裡那一份：上面把它複製成
     * `Spekterm.AppImage`，版本已經被剝掉了。
     */
    check(results, '執行中的 app 呈現的版本與產物檔名的版本相同',
      identity?.version != null && versionedNames.some((name) => name.includes(identity.version)),
      `app=${identity?.version} 檔名=${versionedNames.join(', ')}`)

    /**
     * 〈產物脫離 repo 執行時建置身分仍完整〉—— 上面已把產物複製到 `workDir`（repo 之外）。
     *
     * **這條的鑑別力有限，要如實讀**：在「建置時注入」的設計之下，「執行時去問 git」根本表達
     * 不出來，因此它接近恆真。它擋得住的是**日後有人把注入改成執行期推導**，而那正是這個設計
     * 唯一真正的替代方案。
     */
    check(results, '產物脫離 repo 執行時建置身分仍完整',
      identity?.hasCommit === true && identity.development === false,
      `執行位置=${appImage}；${JSON.stringify(identity)}`)
  } catch (error) {
    check(results, '設定介面呈現建置身分（版本／建置時刻／commit）', false, error.message)
  }

  client.close()
} catch (error) {
  console.error(`\nprobe 失敗：${error.message}`)
  if (stderr.trim()) console.error(`AppImage stderr:\n${stderr.trim().slice(0, 1200)}`)
  results.push(false)
} finally {
  // 連根拔除 —— 每個子行程的 argv 都帶著獨一無二的 --user-data-dir。
  try {
    if (app?.pid) process.kill(-app.pid, 'SIGKILL')
  } catch {
    // 行程已自行結束
  }
  try {
    execFileSync('pkill', ['-9', '-f', profileDir], { stdio: 'ignore' })
  } catch {
    // pkill 找不到目標時回非零 —— 那正是我們要的狀態
  }

  await sleep(500)

  /**
   * 卸載這一輪新增的 AppImage 掛載點。
   *
   * **兩個實測出來的講究**（初版兩個都漏了，於是留下六個殘留目錄）：
   *
   * - **`-u` 不夠，要 `-uz`（lazy）。** AppImage 正常結束時會自己卸載，但我們是
   *   `SIGKILL` 它 —— 那一瞬間 fd 還沒關，一般卸載會以 device busy 失敗。lazy 卸載
   *   立刻把它從目錄樹分離，等引用歸零再真正收掉。
   * - **卸載之後目錄不會消失。** 掛載點是 AppImage 自己建的空目錄；沒人刪它，`/tmp`
   *   會慢慢長出一堆空殼。
   */
  for (const name of mountPoints()) {
    if (mountsBefore.has(name)) continue
    const mountPath = join('/tmp', name)
    try {
      execFileSync('fusermount', ['-uz', mountPath], { stdio: 'ignore' })
    } catch {
      // 已被 AppImage 自己卸載
    }
    try {
      rmSync(mountPath, { recursive: false, force: true })
    } catch {
      // 還有引用沒歸零 —— 留一個空目錄，無害
    }
  }

  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    // 掛載點可能還在收尾 —— 留著也只是一個暫存目錄
  }
}

const passed = results.filter(Boolean).length
console.log(`\n${results.every(Boolean) ? '全部通過' : '有檢查未通過'}（${passed}/${results.length}）`)
process.exit(results.every(Boolean) && results.length > 0 ? 0 : 1)
