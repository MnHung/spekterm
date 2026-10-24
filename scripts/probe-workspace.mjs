/**
 * 驗證 workspace-folders、filesystem-access 與 workspace-layout 的 spec scenario。
 *
 * 以 `--user-data-dir` 指向暫存 profile：workspace 設定隨使用者資料目錄走，因此可以
 * 反覆重啟應用程式、餵它一份損毀的設定檔，而不污染開發者真實的設定。
 *
 * 邊界的驗證一律**透過 renderer 實際呼叫 preload 暴露的 API** —— 那才是真正的攻擊面。
 * 純函式層面的窮舉（兄弟目錄前綴、symlink 逃逸）由 `npm test` 的單元測試負責。
 *
 * 用法：npm run probe:workspace
 * 結束碼 0 表示全部 scenario 通過。
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { check, connectToApp, dragMouse, pollFor, pollUntil, pressKey, retryAction } from './lib/cdp.mjs'
import { copy, copyIn, label, patternOf, prefixOf, suffixOf } from './lib/copy.mjs'
import { awaitMounted, describeMounted, mountedExpression } from './lib/mounted.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { quitAndWait } from './lib/quit.mjs'
import { PROBE_PORTS } from './lib/ports.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { SETTINGS_DIALOG, awaitApplied, closeSettings, inSettings, openSettings, showSection } from './lib/settings.mjs'
import { runUpdateSections } from './probe-workspace-update.mjs'
import { runAppearanceSections } from './probe-workspace-appearance.mjs'

const DEBUG_PORT = PROBE_PORTS.workspace.main
const results = []
const temps = []

function mkTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

/** 在 fixture 上跑真的 git —— 見 makeFixture 中的說明。 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// ── fixture ─────────────────────────────────────────────────────────────────

/** 三種 folder 狀態 + 一個指向 workspace 之外的 symlink（供越界測試）。 */
function makeFixture() {
  const base = mkTemp('spekterm-workspace-fixture-')

  const withOpenSpec = join(base, 'repo-openspec')
  mkdirSync(join(withOpenSpec, 'openspec'), { recursive: true })
  mkdirSync(join(withOpenSpec, 'sub'), { recursive: true })
  writeFileSync(join(withOpenSpec, 'readme.md'), '# x\n')

  // **真的 git repo，不是手寫的 .git/HEAD。**
  //
  // 產品讀的是 `.git/HEAD`，所以手寫一個檔案「看起來」也能驗 —— 但那是**原地覆寫**，而真的
  // `git checkout` 是**寫 HEAD.lock 再 rename 上去**（實測 HEAD 的 inode 每次都變）。對 watcher
  // 來說這是兩種不同的事件：整個「chokidar 在 rename 之後仍然收得到 change」的論證（design D8），
  // 若只用手寫檔案驗收，就**從來沒有被真的測過**。探針自己 spawn git 是可以的 —— 「不得 spawn
  // 外部程式」是加在**產品**身上的約束（由單元測試以 child_process 攔截驗證），不是加在探針身上。
  git(withOpenSpec, ['init', '-q', '-b', 'master'])
  git(withOpenSpec, ['config', 'user.email', 'probe@spekterm.test'])
  git(withOpenSpec, ['config', 'user.name', 'probe'])
  git(withOpenSpec, ['add', '.'])
  git(withOpenSpec, ['commit', '-qm', 'init'])

  const outside = join(base, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'do not read\n')
  symlinkSync(outside, join(withOpenSpec, 'escape-link'))

  const plain = join(base, 'repo-plain')
  mkdirSync(plain, { recursive: true })

  // 建立後刪除：模擬「app 關閉期間 folder 被移走」
  const missing = join(base, 'repo-missing')
  mkdirSync(missing, { recursive: true })
  rmSync(missing, { recursive: true })

  return { withOpenSpec, plain, missing }
}

function seedProfile(folders) {
  const profile = mkTemp('spekterm-workspace-profile-')
  writeFileSync(
    join(profile, 'workspace.json'),
    JSON.stringify(
      {
        version: 1,
        folders: folders.map(([id, path]) => ({ id, path, addedAt: '2026-07-10T00:00:00.000Z' })),
      },
      null,
      2,
    ),
  )
  return profile
}

// ── app 啟動 ────────────────────────────────────────────────────────────────

/**
 * 「掛載完成」不等於「可以操作」。視窗以 show:false 建立、待 ready-to-show 才顯示；
 * 在頁面仍是 hidden 的期間 Chromium 會節流 rAF，而版面元件的尺寸更新走 rAF /
 * ResizeObserver —— 此時送出的滑鼠事件會被接收，版面卻不會動。
 * 因此必須等到 visible 且兩個分界都就位，才開始互動。
 */
// **這支額外要求兩件事**：兩個分界器都在、rail 量得出寬度 —— 它驗的就是版面本身，
// 「掛載了但版面還沒成形」對它而言與沒掛載無異。
//
// **兩個，不是三個**：活動列已不是可調整的區域（`workspace-layout`），它與 rail 之間沒有分界。
const MOUNTED = mountedExpression({
  extra: {
    separators: `document.querySelectorAll('[role="separator"]').length === 2`,
    railWidth: `document.querySelector('aside[aria-label="${copy('rail.label')}"]')?.getBoundingClientRect().width > 0`,
  },
})

/**
 * @param {string} profileDir
 * @param {{ seed?: boolean, env?: Record<string,string> }} [options]
 *   `seed: false` 只給**驗證語言偵測機制本身**的那一段用 —— 它要的正是「偏好檔不存在」。
 *   `env` 用來驅動作業系統回報的偏好語言（實測：`LANGUAGE` 才是驅動者，見該段的註解）。
 */
async function launch(profileDir, { seed = true, env: envOverride } = {}) {
  // 被測 app 的語言是**被指定的**：全新的 profile 會觸發首次啟動的語言偵測，
  // 而在一台非英文的機器上，那會讓每一條 `aria-label` 選擇器選不到元素。
  // 既有的 `preferences.json` 不動（損毀韌性與舊檔那兩段自己佈置它）。
  if (seed) seedLanguage(profileDir)

  const electron = spawn(
    process.platform === 'win32' ? 'electron.cmd' : 'electron',
    [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, ...electronExtraArgs(), '.'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...envOverride }, shell: process.platform === 'win32' },
  )
  let stderr = ''
  electron.stderr.on('data', (chunk) => (stderr += chunk))

  const client = await connectToApp(DEBUG_PORT)
  const mounted = await awaitMounted(client, { expression: MOUNTED })

  return {
    client,
    mounted,
    stderr: () => stderr,
    /**
     * 關閉這個 app。
     *
     * **等到主行程確實結束才返回，理由與 `probe-terminal` 的 `quitGracefully` 相同**
     * （issue #8）—— 而這支的風險更高：`close()` 之後隨即以**同一個 profile** 重啟，
     * 緊接著就是「清單與使用者排定的順序於重啟後一致」與「終端字型偏好於重啟後還原」
     * 兩條斷言。**被斷言的正是舊行程收尾時寫下的那份檔案。**
     *
     * 此前是 `SIGTERM` ＋ 固定 600ms，九支裡最弱的一個（連 `pkill` 都沒有）。
     */
    async close() {
      client.close()
      await quitAndWait(electron)
    },
  }
}

// ── renderer 內的量測 ───────────────────────────────────────────────────────

/**
 * rail 上的 folder 列。
 *
 * **以「移除」按鈕識別一列**（每個 folder 列都有，session 子列沒有）。它一度是以那顆 `◈`
 * 指示鈕識別的 —— 而 `◈` 已隨 rail-legibility-and-repo-row 移除（它的 onClick 裡只有
 * stopPropagation，是一顆按不下去的假按鈕，且不在雛型裡）。探針的斷言會隨規格過期。
 */
const RAIL_ROWS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] li')]
  .map((li) => {
    const remove = li.querySelector('button[aria-label$="${suffixOf('rail.removeFolder')}"]')
    if (!remove) return null
    const name = remove.getAttribute('aria-label').match(/^${patternOf('rail.removeFolder')}$/)?.[1]
    return {
      name,
      text: li.innerText,
      // rail 不再為「含有 openspec」這個常態發聲 —— 這兩個都必須恆為 false／不存在。
      hasOpenSpecButton: !!li.querySelector('button[aria-label^="${copy('panelSwitch.openSpec')}"]'),
      hasDiamond: li.innerText.includes('◈'),
    }
  })
  .filter(Boolean)`

/**
 * rail 上每一個可點擊的控制項是否都有實際作用。
 *
 * 「不呈現不可操作的控制項」是 workspace-layout 的一條 requirement —— 一個長得像按鈕、按下去
 * 卻什麼都不發生的元素，會反覆消耗使用者的注意力去確認它是不是壞了。這裡以「所有按鈕都必須
 * 具備 aria-label，且不得是已知的純指示用途」來近似；`◈` 那顆的特徵是 disabled 或無任何行為。
 */
const RAIL_BUTTONS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] button')]
  .map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled }))`

const LAYOUT = `(() => {
  const width = (selector) => document.querySelector(selector)?.getBoundingClientRect().width ?? -1
  const separators = [...document.querySelectorAll('[role="separator"]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  const toggle = document.querySelector('main[aria-label="${copy('stage.label')}"] header button[aria-expanded]')
  return {
    separators,
    rail: width('aside[aria-label="${copy('rail.label')}"]'),
    railMidY: (() => {
      const r = document.querySelector('aside[aria-label="${copy('rail.label')}"]')?.getBoundingClientRect()
      return r ? Math.round(r.y + r.height / 2) : -1
    })(),
    activityBar: width('nav[aria-label="${copy('activityBar.label')}"]'),
    sidePanel: width('section[aria-label="${copy('openspec.sidePanel')}"]'),
    terminal: width('section[aria-label="${copy('stage.terminal')}"]'),
    toggleLabel: toggle?.getAttribute('aria-label') ?? null,
    toggleExpanded: toggle?.getAttribute('aria-expanded') ?? null,
  }
})()`

// label 取自 `aria-label`（`terminal-rendering-and-preferences` 起）—— 入口的無障礙名稱由它供應，
// 先前那個 `.sr-only` span 已移除。`aria-label` 同時是探針的選擇器（自字典取字串，不硬編）。
const ACTIVITY_BAR = `[...document.querySelectorAll('nav[aria-label="${copy('activityBar.label')}"] button')].map((b) => ({
  label: b.getAttribute('aria-label') ?? '',
  disabled: b.disabled,
  current: b.getAttribute('aria-current'),
  title: b.getAttribute('title') ?? '',
}))`

/**
 * 反覆量測直到版面達到預期，或逾時後回傳最後一次結果（讓斷言照常失敗）。
 * 固定 sleep 在慢機器上會偽性失敗，在快機器上則白等。
 */
async function layoutUntil(client, predicate, timeoutMs = 4_000) {
  return pollFor({
    read: () => client.evaluate(LAYOUT),
    settled: predicate,
    timeoutMs,
    interval: 80,
    label: 'layoutUntil（等版面達到預期）',
  })
}

/**
 * 透過真正的 preload API 呼叫 listDir，回報成功或錯誤訊息。
 *
 * fs 的失敗以結果物件回報而非拋出 —— Electron 的 IPC 序列化只保留 message，
 * 會丟掉 `code` 與 `detail`，而 UI 需要它們。
 */
const callListDir = (folderId, relPath) => `(async () => {
  const result = await window.workspace.fs.listDir(${JSON.stringify(folderId)}, ${JSON.stringify(relPath)})
  return result.ok
    ? { ok: true, entries: result.value }
    : { ok: false, message: result.code + ': ' + result.message }
})()`

/** 頂層的 repo 列（**不含 session 子列** —— 子列在 DOM 上同樣是 `li > div[role="button"]`）。 */
/**
 * rail 上**屬於 folder** 的那些 `<li>`。
 *
 * **不能用 DOM 位置索引** —— rail 的第一列是 `global-session` 的全域項目，其後還有一條分隔線
 * `<li>`，兩者都不是 folder。以位置索引會讓每一個 rect 偏移，而拖曳測試的期望值全是相對位置，
 * 症狀會是「落點莫名其妙差一格」而不是一條乾脆的紅燈。
 *
 * 識別方式與 `RAIL_ROWS` 一致：**有移除按鈕的才是 folder**（全域項目不可移除）。
 */
const FOLDER_LIS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li')]
  .filter((li) => li.querySelector('button[aria-label$="${suffixOf('rail.removeFolder')}"]'))`

const FOLDER_ROW_RECT = (index) => `(() => {
  const li = ${FOLDER_LIS}[${index}]
  const row = li?.querySelector(':scope > div[role="button"]')
  if (!row) return null
  const r = row.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`

/** 整個 repo 區塊（`<li>`，含展開的 session 子列）—— 拖曳的命中判定以它為準。 */
const FOLDER_BLOCK_RECT = (index) => `(() => {
  const li = ${FOLDER_LIS}[${index}]
  if (!li) return null
  const r = li.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(r.y), height: Math.round(r.height) }
})()`

const SESSION_ROW_RECT = (index) => `(() => {
  const rows = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li > ul > li > div[role="button"]')]
  const row = rows[${index}]
  if (!row) return null
  const r = row.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`

const SESSION_ROW_LABELS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li > ul > li > div[role="button"]')]
  .map((row) => row.innerText.split('\\n')[0].trim())`

/** 當前選中的 repo —— 主舞台的 header 就是它。 */
const SELECTED_FOLDER = `(() => {
  const header = document.querySelector('main[aria-label="${copy('stage.label')}"] header')
  return header ? header.innerText.split('\\n')[0].trim() : null
})()`

/**
 * 一次**真的**按下再放開，中間不移動。
 *
 * 不能用 `.click()`：合成事件不走 mousedown → mouseup 這條路，而拖曳排序的「未位移就視為點擊」
 * 正是靠這兩顆事件之間有沒有位移來判定的。用合成 click 驗它，等於什麼都沒驗。
 */
async function realPressRelease(client, at) {
  const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
}

/** 靜止時的游標 —— 可拖曳且可點擊的項目必須是 `pointer`，不是 `grab`（呈現契約）。 */
const CURSOR_OF = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  return el ? getComputedStyle(el).cursor : null
})()`

const RAIL_ROW_SELECTOR = `aside[aria-label="${copy('rail.label')}"] > ul > li > div[role="button"]`
const RAIL_SESSION_SELECTOR = `aside[aria-label="${copy('rail.label')}"] > ul > li > ul > li > div[role="button"]`

/** 自 rail 建立一個 login shell 的 session（拖曳的驗收需要一個**展開著子列**的 repo）。 */
const OPEN_SPAWN_MENU = (folderName) => `(() => {
  const button = document.querySelector('button[aria-label="${copy('rail.newSessionIn', { name: '%NAME%' })}"]'
    .replace('%NAME%', ${JSON.stringify(folderName)}))
  if (!button) return false
  button.click()
  return true
})()`

const CLICK_MENU_ITEM = (label) => `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return false
  const item = [...menu.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(label)}))
  if (!item) return false
  item.click()
  return true
})()`

// 不以 aria-label 選取：它會隨收合狀態改變，而狀態的更新比 DOM 寬度晚一個 frame，
// 依 label 選取會在競態下找不到按鈕，讓「展開」靜默地沒有發生。
// 以 aria-expanded 選取而非「header 的第一顆按鈕」—— 身分切換的分頁排在它前面。
const CLICK_TOGGLE = `(() => {
  const button = document.querySelector('main[aria-label="${copy('stage.label')}"] header button[aria-expanded]')
  if (!button) return false
  button.click()
  return true
})()`

// ── 主流程 ──────────────────────────────────────────────────────────────────

const fixture = makeFixture()
const profile = seedProfile([
  ['f-openspec', fixture.withOpenSpec],
  ['f-plain', fixture.plain],
  ['f-missing', fixture.missing],
])

let exitCode = 1
let app = null

try {
  app = await launch(profile)
  if (!check(results, '應用程式啟動且 rail 掛載', app.mounted?.ok === true,
    app.mounted?.ok ? '' : `${describeMounted(app.mounted)} ${app.stderr().slice(0, 300)}`)) {
    throw new Error('rail 未掛載，後續斷言無意義')
  }

  // ── workspace-folders：rail 呈現三種 folder 狀態 ──────────────────────────
  console.log('\nrail 呈現每個 folder 的名稱與身分')
  // **必須輪詢，不能只 evaluate 一次。** folder 列來自一次非同步的 `folders.list()`，它比
  // rail 的 `<aside>` 晚一步才渲染 —— 機器一忙就會讀到 0 列，而後面每一條都跟著紅（看起來
  // 像 rail 壞了，其實只是還沒畫出來）。`probe:openspec` 記過同一個坑，這支一直沒被觸發，
  // 直到狀態列讓啟動多做了一點事才現形。
  const rows = await pollUntil(app.client, RAIL_ROWS, (v) => v.length === 3, 10_000)
  check(results, 'rail 為每個 folder 呈現一列', rows.length === 3, `${rows.length} 列`)
  check(results, '順序與設定檔一致',
    rows.map((r) => r.name).join(',') === 'repo-openspec,repo-plain,repo-missing',
    rows.map((r) => r.name).join(', '))

  const [openSpecRow, plainRow, missingRow] = rows

  // 「含有 openspec」是**常態**，rail 不為它發聲 —— 每一列都喊一次的訊息不傳達任何資訊。
  check(results, '含 openspec 的 folder：rail 不為此呈現任何標示',
    openSpecRow?.hasOpenSpecButton === false &&
      openSpecRow?.hasDiamond === false &&
      !openSpecRow?.text.includes('OpenSpec'),
    openSpecRow?.text.replace(/\n/g, ' · '))

  // 缺少 openspec 是**異常**，才發聲（弱訊號）。
  check(results, '不含 openspec 的 folder：以弱訊號標示',
    plainRow?.text.includes(copy('rail.noOpenspec')),
    plainRow?.text.replace(/\n/g, ' · '))

  check(results, '路徑失效的 folder：明確標示', missingRow?.text.includes(copy('rail.missingBadge')),
    missingRow?.text.replace(/\n/g, ' · '))

  // ── repo-branch：rail 呈現分支 ───────────────────────────────────────────
  check(results, 'rail 呈現 folder 的 git 分支', openSpecRow?.text.includes('master'),
    openSpecRow?.text.replace(/\n/g, ' · '))
  check(results, '非 git repo 不使該列失效（沒有分支是合法狀態）',
    plainRow?.name === 'repo-plain' && !plainRow?.text.includes('master'),
    plainRow?.text.replace(/\n/g, ' · '))

  // ── workspace-layout：rail 不呈現不可操作的控制項 ─────────────────────────
  const buttons = await app.client.evaluate(RAIL_BUTTONS)
  check(results, 'rail 上不存在 ◈ 那顆按不下去的假按鈕',
    buttons.every((b) => !b.label?.startsWith('OpenSpec')),
    buttons.map((b) => b.label).filter(Boolean).slice(0, 5).join(', '))

  const folders = await app.client.evaluate('window.workspace.folders.list()')
  check(results, 'hasOpenSpec 與 status 由主行程重算',
    folders[0].hasOpenSpec === true && folders[1].hasOpenSpec === false && folders[2].status === 'missing',
    folders.map((f) => `${f.name}:${f.status}/${f.hasOpenSpec}`).join(' '))
  check(results, '分支為衍生狀態，由主行程供應',
    folders[0].branch === 'master' && folders[1].branch === null && folders[2].branch === null,
    folders.map((f) => `${f.name}:${f.branch ?? '(無)'}`).join(' '))

  // ── repo-branch：在 app 之外切 branch，rail 自己更新 ──────────────────────
  //
  // 這是這條能力的**核心價值**：使用者就在旁邊的 terminal 裡操作這些 repo。一個切完 branch
  // 還顯示舊分支的 rail，比不顯示分支更糟 —— 它看起來像是真的。
  //
  // **用真的 `git checkout`**，不是改寫 HEAD 檔案。git 是寫 `HEAD.lock` 再 rename 上去（實測
  // HEAD 的 inode 每次都變），這對 watcher 是與原地覆寫**不同的事件** —— design D8 的整個論證
  // （chokidar 在 rename 之後仍然收得到）只有這樣才算真的被驗過。
  git(fixture.withOpenSpec, ['checkout', '-q', '-b', 'feat/x'])
  const switched = await pollUntil(
    app.client,
    `${RAIL_ROWS}[0].text`,
    (text) => typeof text === 'string' && text.includes('feat/x'),
  )
  check(results, '於 app 之外切換分支後，rail 自己更新（不需重啟）',
    typeof switched === 'string' && switched.includes('feat/x') && !switched.includes('master'),
    String(switched).replace(/\n/g, ' · '))

  // detached HEAD：rail 不得空白、不得進入錯誤狀態（同樣走真的 git）
  const sha = git(fixture.withOpenSpec, ['rev-parse', 'HEAD'])
  const shortSha = sha.slice(0, 7)
  git(fixture.withOpenSpec, ['checkout', '-q', '--detach', sha])
  const detached = await pollUntil(
    app.client,
    `${RAIL_ROWS}[0].text`,
    (text) => typeof text === 'string' && text.includes(shortSha),
  )
  check(results, 'detached HEAD 呈現短 sha，rail 不失效',
    typeof detached === 'string' && detached.includes(shortSha),
    `短 sha=${shortSha} → ${String(detached).replace(/\n/g, ' · ')}`)

  // ── repo-branch：folder 於執行期間變成 git repo ───────────────────────────
  //
  // 這條需要**第二層** watcher：實測監看一個「尚不存在」的 `.git/HEAD` 收不到任何事件
  // （連父目錄都不存在，chokidar 無從 attach）。folder 根目錄恆常存在，故以它等 `.git` 出現。
  git(fixture.plain, ['init', '-q', '-b', 'main'])
  const appeared = await pollUntil(
    app.client,
    `${RAIL_ROWS}[1].text`,
    (text) => typeof text === 'string' && text.includes('main'),
  )
  check(results, 'folder 於執行期間變成 git repo，rail 開始呈現分支',
    typeof appeared === 'string' && appeared.includes('main'),
    String(appeared).replace(/\n/g, ' · '))

  // ── filesystem-access：透過真正的 preload API ────────────────────────────
  console.log('\n檔案系統邊界（經 renderer 實際呼叫 preload API）')
  const listRoot = await app.client.evaluate(callListDir('f-openspec', '.'))
  check(results, '以相對路徑列出目錄', listRoot.ok && listRoot.entries.some((e) => e.name === 'openspec' && e.kind === 'directory'),
    listRoot.ok ? listRoot.entries.map((e) => `${e.name}:${e.kind}`).join(' ') : listRoot.message)
  check(results, '回報符號連結為 symlink 而非其指向的種類',
    listRoot.ok && listRoot.entries.find((e) => e.name === 'escape-link')?.kind === 'symlink',
    `列目錄成功=${listRoot.ok}；escape-link 的 kind=${listRoot.entries?.find((e) => e.name === 'escape-link')?.kind ?? '(不在清單裡)'}`)

  const listSub = await app.client.evaluate(callListDir('f-openspec', 'sub'))
  check(results, '可列出子目錄', listSub.ok && listSub.entries.length === 0,
    `列目錄成功=${listSub.ok}；項目數=${listSub.entries?.length ?? '(無 entries)'}`)

  for (const [name, relPath] of [
    ['絕對路徑', '/etc'],
    ['上層參照逃逸', '../'],
    ['symlink 逃逸', 'escape-link'],
    ['symlink 逃逸（穿透到檔案）', 'escape-link/secret.txt'],
  ]) {
    const attempt = await app.client.evaluate(callListDir('f-openspec', relPath))
    check(results, `拒絕${name}`, attempt.ok === false, attempt.ok ? '竟然成功了' : '')
  }

  const unknown = await app.client.evaluate(callListDir('nope', '.'))
  check(results, '拒絕未註冊的 folderId', unknown.ok === false)

  const unavailable = await app.client.evaluate(callListDir('f-missing', '.'))
  check(results, '拒絕路徑失效的 folder', unavailable.ok === false)

  const notADir = await app.client.evaluate(callListDir('f-openspec', 'readme.md'))
  check(results, '目標是檔案時回報錯誤而非空清單', notADir.ok === false)

  // ── workspace-layout：分界、夾制、鍵盤、收合 ─────────────────────────────
  console.log('\n版面：分界可拖動、受夾制、可鍵盤操作、side panel 可收合')
  const before = await app.client.evaluate(LAYOUT)
  // **兩處，不是三處** —— 活動列與 rail 之間 SHALL NOT 有分界（`workspace-layout`）。
  // 這條同時是「活動列與 rail 之間不存在分界」那條 scenario 的載體。
  check(results, '兩處分界皆存在且具 separator 角色（活動列與 rail 之間沒有）',
    before.separators.length === 2,
    `${before.separators.length} 個 role="separator"`)

  const railSeparator = before.separators[0]
  await dragMouse(app.client, railSeparator, { x: railSeparator.x + 80, y: railSeparator.y })
  const widened = await layoutUntil(app.client, (l) => l.rail > before.rail + 60)
  check(results, '拖動分界改變兩側寬度', widened.rail > before.rail + 60,
    `rail ${Math.round(before.rail)}px → ${Math.round(widened.rail)}px`)

  await dragMouse(app.client, widened.separators[0], { x: 0, y: railSeparator.y })
  const clamped = await layoutUntil(app.client, (l) => Math.abs(l.rail - 180) < 2)
  check(results, '拖過最小寬度時被夾制而不歸零', Math.abs(clamped.rail - 180) < 2,
    `rail = ${Math.round(clamped.rail)}px（minSize 180px）`)

  const focused = await app.client.evaluate(
    `(() => { const s = document.querySelectorAll('[role="separator"]')[0]; s.focus(); return document.activeElement === s })()`,
  )
  check(results, '分界可取得鍵盤焦點', focused === true)
  for (let i = 0; i < 5; i++) await pressKey(app.client, 'ArrowRight')
  const afterKeys = await layoutUntil(app.client, (l) => l.rail > clamped.rail)
  check(results, '方向鍵可調整寬度', afterKeys.rail > clamped.rail,
    `rail ${Math.round(clamped.rail)}px → ${Math.round(afterKeys.rail)}px`)

  // 先把 side panel 拖到一個明顯的寬度，才能證明展開後「還原的是收合前的寬度」
  const inner = afterKeys.separators[1]
  const widthBeforeResize = afterKeys.sidePanel
  await dragMouse(app.client, inner, { x: inner.x - 70, y: inner.y })
  const sized = await layoutUntil(app.client, (l) => l.sidePanel > widthBeforeResize + 50)

  check(results, '點擊收合前 aria-expanded 為 true', sized.toggleExpanded === 'true')

  check(results, '收合鈕存在且可點擊', (await app.client.evaluate(CLICK_TOGGLE)) === true)
  // 寬度先到 0，aria-expanded 由 onResize → setState 更新，晚一個 frame。兩者都要等。
  const collapsed = await layoutUntil(app.client, (l) => l.sidePanel === 0 && l.toggleExpanded === 'false')
  check(results, 'side panel 收合後主舞台其餘部分佔滿',
    collapsed.sidePanel === 0 && collapsed.terminal > sized.terminal,
    `sidePanel=${Math.round(collapsed.sidePanel)}px, terminal ${Math.round(sized.terminal)} → ${Math.round(collapsed.terminal)}px`)
  check(results, '收合後 aria-expanded 為 false', collapsed.toggleExpanded === 'false')

  check(results, '展開鈕存在且可點擊', (await app.client.evaluate(CLICK_TOGGLE)) === true)
  const expanded = await layoutUntil(
    app.client,
    (l) => Math.abs(l.sidePanel - sized.sidePanel) < 2 && l.toggleExpanded === 'true',
  )
  check(results, '展開後還原收合前的寬度', Math.abs(expanded.sidePanel - sized.sidePanel) < 2,
    `${Math.round(sized.sidePanel)}px → ${Math.round(expanded.sidePanel)}px`)

  // ── workspace-layout：活動列 ─────────────────────────────────────────────
  console.log('\n活動列')
  const activity = await app.client.evaluate(ACTIVITY_BAR)
  // **以 `aria-label` 定位，不用位置索引。** 舊版用 `activity[0]` / `slice(1,3)` / `activity[3]`
  // 去指名四個入口；新增第五個之後那不只會紅，更糟的是**會在驗錯的元素上變綠** ——
  // 新入口若插在 Settings 之前，`activity[3]` 就變成新入口，而「Settings 為可用狀態」照樣通過。
  const byLabel = (key) => activity.find((item) => item.label === copy(key))
  check(results, '呈現雛型的全部入口＋對話計量', activity.length === 5, `${activity.length} 個`)
  check(results, 'Sessions 可用且預設選取',
    byLabel('activityBar.sessions')?.disabled === false && byLabel('activityBar.sessions')?.current === 'page',
    JSON.stringify(byLabel('activityBar.sessions')))
  // Only the entry the user is in is marked: an implementation that marks every enabled entry (as it once
  // did) passes the check above.
  check(results, 'Only Sessions is marked current while nothing is open',
    activity.filter((item) => item.current === 'page').map((item) => item.label).join(',') === copy('activityBar.sessions'),
    activity.map((item) => `${item.label}=${item.current}`).join(', '))
  // **尚未實作的入口自 `agent-intake-inbox` 起只剩 Search。** Settings 已實作（終端字型設定）、
  // 對話計量亦然，而 Handoffs 已由收件匣接上 —— 那不是對雛型的偏離，是兌現它（雛型枚舉的
  // 入口集合本來就有 Handoffs，它此前為停用只因為背後的能力尚未存在）。
  const pending = ['activityBar.search'].map((key) => byLabel(key))
  check(results, '尚未實作的入口停用且附提示',
    pending.every((item) => item?.disabled && item.title.includes(suffixOf('activityBar.comingSoon'))),
    pending.map((i) => `${i?.label}(disabled=${i?.disabled})`).join(', '))
  // **反面一起驗**：只驗「Search 是停用的」的話，一個把整排都關掉的實作照樣通過。
  check(results, 'Handoffs 入口為可用狀態（收件匣已接上）',
    byLabel('activityBar.handoffs')?.disabled === false,
    `${byLabel('activityBar.handoffs')?.label}(disabled=${byLabel('activityBar.handoffs')?.disabled})`)
  check(results, 'Settings 入口為可用狀態（已實作，不再是 placeholder）',
    byLabel('activityBar.settings')?.disabled === false,
    `${byLabel('activityBar.settings')?.label}(disabled=${byLabel('activityBar.settings')?.disabled})`)
  check(results, '對話計量入口為可用狀態',
    byLabel('insights.label')?.disabled === false,
    `${byLabel('insights.label')?.label}(disabled=${byLabel('insights.label')?.disabled})`)

  // ── workspace-layout：活動列為固定寬度，且不可調整 ───────────────────────
  //
  // **`before` 必須在初始 viewport（1280）量。** 若在放大後的視窗量，一個仍是
  // `maxSize="120px"` 的 `Panel` 可能已經被夾在上限上 —— 「寬度不變」於是在**未修的程式碼上
  // 照樣通過**，正是這個 repo 最常見的假綠形狀。此處的量測在任何 viewport 覆寫之前。
  const beforeWiden = await app.client.evaluate(LAYOUT)
  const innerBefore = await app.client.evaluate('window.innerWidth')

  // **用 `Emulation.setDeviceMetricsOverride`，不是 `Browser.setWindowBounds`** —— 後者在
  // Electron 實測無效且不報錯（見本檔下方狀態列那一段的註解）。
  // **CDP 呼叫包 try/catch**：這支探針沒有段落隔離（`lib/sections.mjs` 只有 terminal /
  // keyboard / openspec 三支使用），一次未捕捉的 throw 會帶走其後全部的斷言。
  try {
    await app.client.send('Emulation.setDeviceMetricsOverride', {
      width: 2200, height: 800, deviceScaleFactor: 0, mobile: false,
    })
  } catch {
    // 不支援就讓下面兩條前置斷言說話，不要在這裡吞掉。
  }
  const innerAfter = await pollUntil(app.client, 'window.innerWidth', (w) => w > innerBefore, 8000)
  check(results, '（前置）viewport 確實變寬了', innerAfter > innerBefore,
    `${innerBefore} → ${innerAfter}`)

  // **第二條前置，而它才是真正的鑑別力來源**：`window.innerWidth` 變了只證明覆寫送到了，
  // 不證明版面重算過（Group 的重算走 ResizeObserver）。rail 是 `preserve-relative-size` 的
  // `Panel`，它**必須**跟著變寬 —— 少了這條，「活動列寬度不變」在「版面根本沒重算」時照樣全綠。
  const wideLayout = await layoutUntil(app.client, (l) => l.rail > beforeWiden.rail + 20)
  check(results, '（前置）版面確實重算了（rail 隨視窗等比變寬）',
    wideLayout.rail > beforeWiden.rail + 20,
    `rail ${Math.round(beforeWiden.rail)}px → ${Math.round(wideLayout.rail)}px`)

  check(results, '視窗放大後活動列寬度不變',
    Math.abs(wideLayout.activityBar - beforeWiden.activityBar) < 1,
    `activityBar ${Math.round(beforeWiden.activityBar)}px → ${Math.round(wideLayout.activityBar)}px`)

  try {
    await app.client.send('Emulation.clearDeviceMetricsOverride')
  } catch {
    // 同上。
  }
  await pollUntil(app.client, 'window.innerWidth', (w) => w === innerBefore, 8000)

  // 活動列的右緣拖不動它。**對照組就在同一支的上方**：`'拖動分界改變兩側寬度'` 已證明
  // `dragMouse` 送得出真拖曳 —— 少了那句，「拖曳根本沒打中任何東西」也會讓這條通過。
  const restored = await layoutUntil(app.client, (l) => Math.abs(l.rail - beforeWiden.rail) < 4)
  const edge = { x: Math.round(restored.activityBar), y: Math.round(restored.railMidY) }
  await dragMouse(app.client, edge, { x: edge.x + 60, y: edge.y })
  const afterEdgeDrag = await app.client.evaluate(LAYOUT)
  check(results, '活動列的寬度不可由使用者調整',
    Math.abs(afterEdgeDrag.activityBar - beforeWiden.activityBar) < 1,
    `activityBar ${Math.round(beforeWiden.activityBar)}px → ${Math.round(afterEdgeDrag.activityBar)}px`)

  // ── terminal-preferences：Settings 入口開啟終端字型設定介面
  //
  // 以**真按下放開**觸發（合成 `.click()` 不走 mousedown → mouseup，見 realPressRelease 的註解）。
  // 介面以 `role="dialog"` 呈現 —— 那不只是無障礙標記，導航快捷鍵正是以它的存在整體不生效。
  const SETTINGS_RECT = `(() => {
    const b = document.querySelector('nav[aria-label="${copy('activityBar.label')}"] button[aria-label="${copy('activityBar.settings')}"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`
  const FONT_DIALOG = `(() => {
    const d = document.querySelector('[role="dialog"][aria-label="${copy('settings.title')}"]')
    if (!d) return null
    return {
      family: !!d.querySelector('select[aria-label="${copy('settings.fontFamily')}"]'),
      size: !!d.querySelector('input[aria-label="${copy('settings.fontSize')}"]'),
      lineHeight: !!d.querySelector('input[aria-label="${copy('settings.lineHeight')}"]'),
      gpu: !!d.querySelector('input[aria-label="${copy('settings.gpuAcceleration')}"]'),
      preview: !!d.querySelector('[aria-label="${copy('settings.preview')}"]'),
      // **預覽不得含 block element／box-drawing 字元。** 終端的框線由 GPU renderer 依 cell 邊界
      // 程式化繪製、**不經字型**，而預覽是純 DOM、用的就是字型 —— 留著它們，預覽會顯示終端不會
      // 有的縫，使用者會據此去調一個並不存在的問題。預覽的職責是「這個**字型**長什麼樣」。
      previewHasBoxDrawing: /[\u2500-\u257F\u2580-\u259F]/.test(
        d.querySelector('[aria-label="${copy('settings.preview')}"]')?.textContent ?? '',
      ),
      // 這個介面已不只是終端偏好：agent 狀態橋接的開關住在這裡，本輪再加一段唯讀的建置身分。
      // 條文已隨之改寫（terminal-preferences 的「偏好設定介面」），而標題也必須反映實際範圍
      // —— 一個寫著 Terminal 卻內含應用程式版本的對話框，會讓使用者在找版本時不會打開它。
      // （註解在 template literal 之內：**不能寫反引號**，它會把字串提前關掉。）
      about: !!d.querySelector('[role="group"][aria-label="${copy('settings.about')}"]'),
      // **agent 狀態橋接的開關**。這條 scenario 在 terminal-preferences 裡自訂立起就存在，
      // 而它**此前是零載體**（那個鍵名在整個 scripts 目錄中零命中）—— 於是「對話框提供該開關」
      // 與「對話框根本沒有它」在每一輪全綠的驗收中無法區分。
      // （註解在 template literal 之內：**不能寫反引號**，它會把字串提前關掉。）
      agentStatus: !!d.querySelector('input[aria-label="${copy('settings.agentStatus')}"]'),
      // 預設為啟用（＝未設定）。**這是那條 scenario 的第二句 AND**，而它與第一句是兩件事：
      // 開關存在但預設是關的，等於「agent 狀態橋接預設啟用」那條被靜默違反。
      agentStatusChecked:
        d.querySelector('input[aria-label="${copy('settings.agentStatus')}"]')?.checked ?? null,
      // 第三句 AND：介面要說明它只影響其後建立或重建的 session。
      agentStatusHint: (d.textContent ?? '').includes('${copy('settings.agentStatusHint').slice(0, 40)}'),
      title: d.getAttribute('aria-label'),
    }
  })()`

  const settingsAt = await app.client.evaluate(SETTINGS_RECT)
  if (settingsAt) await realPressRelease(app.client, settingsAt)

  // ── settings-sections: the list of sections, one shown at a time, a size that does not move
  //
  // Settings is a list of sections beside the one shown (`terminal-preferences`). Each section is visited
  // once here, and the card is measured in each: a dialog sized by its content would change size between
  // General (one select) and Remote access, and only a measurement in every section shows that.
  const SECTION_TABS = `[...document.querySelectorAll(${JSON.stringify(inSettings(`[role="tablist"]${label('settings.sections.label')} [role="tab"]`))})].map((tab) => ({
    text: tab.textContent.trim(),
    selected: tab.getAttribute('aria-selected') === 'true',
  }))`
  const tabs = await pollUntil(app.client, SECTION_TABS, (v) => v.length > 0, 4000).catch(() => [])
  const expectedSections = ['general', 'terminal', 'agents', 'integrations', 'remote', 'about'].map((id) =>
    copy(`settings.sections.${id}`))
  check(results, 'Settings lists its six sections and shows one of them',
    JSON.stringify(tabs.map((tab) => tab.text)) === JSON.stringify(expectedSections) &&
      tabs.filter((tab) => tab.selected).length === 1,
    JSON.stringify(tabs))

  const CARD_SIZE = `(() => {
    const d = document.querySelector(${JSON.stringify(SETTINGS_DIALOG)})
    if (!d) return null
    const r = d.getBoundingClientRect()
    return { width: Math.round(r.width), height: Math.round(r.height) }
  })()`
  const sizes = {}
  const sectionFacts = {}
  for (const id of ['general', 'terminal', 'agents', 'integrations', 'remote', 'about']) {
    await showSection(app.client, id)
    sizes[id] = await app.client.evaluate(CARD_SIZE)
    sectionFacts[id] = await app.client.evaluate(FONT_DIALOG)
  }
  const distinctSizes = new Set(Object.values(sizes).map((size) => JSON.stringify(size)))
  check(results, 'Switching sections keeps the dialog\'s width and height',
    distinctSizes.size === 1 && sizes.general?.width > 0, JSON.stringify(sizes))

  // The facts of each section are read where that section is shown: one section at a time is the layout.
  const dialog = sectionFacts.terminal
  check(results, '觸發 Settings 開啟終端偏好設定介面（含 family／size／行高／GPU 加速與預覽）',
    dialog?.family === true && dialog?.size === true && dialog?.lineHeight === true &&
      dialog?.gpu === true && dialog?.preview === true,
    JSON.stringify(dialog))

  // The preview comes directly after the font fields, before GPU acceleration: three unrelated settings
  // once stood between the fields and the preview of them.
  const FIELD_ORDER = `(() => {
    const d = document.querySelector(${JSON.stringify(SETTINGS_DIALOG)})
    if (!d) return null
    const named = [
      ['family', 'select[aria-label="${copy('settings.fontFamily')}"]'],
      ['size', 'input[aria-label="${copy('settings.fontSize')}"]'],
      ['lineHeight', 'input[aria-label="${copy('settings.lineHeight')}"]'],
      ['preview', 'pre[aria-label="${copy('settings.preview')}"]'],
      ['gpu', 'input[aria-label="${copy('settings.gpuAcceleration')}"]'],
    ].map(([name, selector]) => [name, d.querySelector(selector)])
    if (named.some(([, element]) => !element)) return named.filter(([, element]) => !element).map(([name]) => 'missing ' + name)
    return named
      .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(([name]) => name)
  })()`
  await showSection(app.client, 'terminal')
  const order = await app.client.evaluate(FIELD_ORDER)
  check(results, 'The preview follows the font fields directly (family, size, line height, preview, then GPU)',
    JSON.stringify(order) === JSON.stringify(['family', 'size', 'lineHeight', 'preview', 'gpu']),
    JSON.stringify(order))

  check(results, '設定介面涵蓋終端偏好以外的區段（唯讀的建置身分），且標題不侷限於終端',
    sectionFacts.about?.about === true && !/terminal/i.test(sectionFacts.about?.title ?? ''),
    `about=${sectionFacts.about?.about} title="${sectionFacts.about?.title}"`)

  // **三句 AND 各驗一次。** 那條 scenario 寫的是「呈現該開關 AND 其預設為啟用 AND 介面說明它
  // 只影響其後的 session」—— 只驗第一句的話，另兩句被違反時不會有任何東西變紅。
  const agents = sectionFacts.agents
  check(results, '設定對話框提供 agent 狀態橋接的開關',
    agents?.agentStatus === true, `agentStatus=${agents?.agentStatus}`)
  check(results, '該開關的預設為啟用',
    agents?.agentStatusChecked === true, `checked=${agents?.agentStatusChecked}`)
  check(results, '介面說明它只影響其後建立或重建的 session',
    agents?.agentStatusHint === true, `hint=${agents?.agentStatusHint}`)

  check(results, '預覽的範例文字不含框線字元（那些字元在終端不經字型）',
    dialog?.previewHasBoxDrawing === false,
    dialog?.previewHasBoxDrawing ? '預覽含 box-drawing —— 它會顯示終端不會有的縫' : '（不含）')

  // 字型 family 以**下拉選單**呈現系統的等寬字，且含「系統預設」選項（dogfood：硬打字型名太難用）。
  //
  // **`count >= 2` 而不是 `>= 1`**：只有「系統預設」那一個選項時 count 就是 1 —— 若 `listMonospaceFonts`
  // 整個壞掉（回空陣列），`>= 1` 照樣會過，那就驗不到「以**系統的等寬字**為選項」這件事（verify 稽核
  // 抓到的假綠）。真實選項至少要有一個，且必須是非空字串。
  const FONT_OPTIONS = `(() => {
    const s = document.querySelector('[role="dialog"] select[aria-label="${copy('settings.fontFamily')}"]')
    if (!s) return null
    const values = [...s.options].map((o) => o.value)
    return { count: values.length, firstValue: values[0], sample: values.slice(1, 4) }
  })()`
  // **必須輪詢**：字型清單是一次非同步 IPC（主行程還要 spawn `fc-list`），區段出現的那一刻它
  // 還沒回來 —— 只 evaluate 一次會讀到「只有系統預設」而誤判為空（實測踩過）。
  const options = await pollUntil(app.client, FONT_OPTIONS, (v) => v?.count >= 2, 6000).catch(
    () => null,
  )
  check(results, '字型 family 為下拉選單：首項為系統預設（空值），其後為系統的等寬字型',
    options?.firstValue === '' &&
      options?.count >= 2 &&
      options.sample.every((v) => typeof v === 'string' && v.length > 0),
    JSON.stringify(options))

  // ── terminal-preferences：預覽隨選取即時更新
  //
  // **只驗「預覽存在」是不夠的**（verify 稽核抓到）：spec 說的是「隨選取即時更新」。選一個真實的
  // 字型，斷言預覽 computed 的 `font-family` 真的變成它 —— 那才是使用者「套用前就看得到」的依據。
  //
  // A chosen family now applies at once (`settings-sections`), so it is put back to the system default
  // afterwards: the later sections of this probe read the stored preferences.
  const PREVIEW_FONT = `(() => {
    const p = document.querySelector('[role="dialog"] [aria-label="${copy('settings.preview')}"]')
    return p ? getComputedStyle(p).fontFamily : null
  })()`
  const chooseFamily = (value) => app.client.evaluate(`(() => {
    const s = document.querySelector('[role="dialog"] select[aria-label="${copy('settings.fontFamily')}"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(s, ${JSON.stringify(value)})
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const previewBefore = await app.client.evaluate(PREVIEW_FONT)
  const picked = options?.sample?.[0]
  if (picked) await chooseFamily(picked)
  const previewAfter = picked
    ? await pollUntil(app.client, PREVIEW_FONT, (v) => String(v).includes(picked), 3000).catch(() =>
      app.client.evaluate(PREVIEW_FONT))
    : null
  check(results, '預覽隨選取即時更新（以選定的字型呈現）',
    Boolean(picked) && previewAfter !== previewBefore && String(previewAfter).includes(picked),
    `選 ${picked}：${previewBefore} → ${previewAfter}`)
  if (picked) {
    await chooseFamily('')
    await awaitApplied(app.client, 'window.workspace.settings.get()', (prefs) => prefs?.fontFamily === undefined,
      'the font family is back to the system default')
  }

  // Focus inside Settings (the family select) receives Esc; the frame closes on it.
  await app.client.evaluate(`document.querySelector('[role="dialog"] select[aria-label="${copy('settings.fontFamily')}"]')?.focus()`)
  await pressKey(app.client, 'Escape')
  const dismissed = await pollUntil(app.client, `document.querySelector('[role="dialog"]') === null`, (v) => v === true, 3000)
    .catch(() => false)
  check(results, 'Esc 關閉終端字型設定介面', dismissed === true)

  // Settings reopens on the section shown last in this run (Terminal, above), not on General.
  await realPressRelease(app.client, await app.client.evaluate(SETTINGS_RECT))
  const reopened = await pollUntil(app.client, SECTION_TABS, (v) => v.some((tab) => tab.selected), 4000).catch(() => [])
  check(results, 'Settings reopens on the last section shown (Terminal)',
    reopened.find((tab) => tab.selected)?.text === copy('settings.sections.terminal'),
    JSON.stringify(reopened.filter((tab) => tab.selected)))
  await closeSettings(app.client)

  // ── workspace-layout：可拖曳項目的游標宣告其主要可供性 ─────────────────────
  //
  // rail 的列**點一下是有作用的**（選中這個 repo／切換 focused session），拖曳是偶爾為之 ——
  // `grab`（張開的手）宣告的是「這個東西只能被拖」，那是錯的可供性。
  console.log('\n拖曳排序與游標')

  // 先在 repo-openspec 底下開一個 session —— 拖曳的驗收**必須有一個展開著 session 子列的 repo**
  // （命中判定以整個區塊為準，而巢狀的兩種拖曳必須互不誤觸；子列收合著就測不到這件事）。
  check(results, '自 rail 開啟 spawn 選單', (await app.client.evaluate(OPEN_SPAWN_MENU('repo-openspec'))) === true)
  await pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
  await app.client.evaluate(CLICK_MENU_ITEM(copy('sessions.spawnShell')))
  await pollUntil(app.client, SESSION_ROW_LABELS, (v) => v.length === 1, 10_000)

  check(results, '自 rail 開啟 spawn 選單', (await app.client.evaluate(OPEN_SPAWN_MENU('repo-openspec'))) === true)
  await pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
  await app.client.evaluate(CLICK_MENU_ITEM(copy('sessions.spawnShell')))
  const sessionRows = await pollUntil(app.client, SESSION_ROW_LABELS, (v) => v.length === 2, 10_000)
  check(results, 'repo-openspec 底下有兩個 session 子列', sessionRows.length === 2, JSON.stringify(sessionRows))

  check(results, 'repo 列靜止時的游標為 pointer（不是 grab）',
    (await app.client.evaluate(CURSOR_OF(RAIL_ROW_SELECTOR))) === 'pointer',
    String(await app.client.evaluate(CURSOR_OF(RAIL_ROW_SELECTOR))))
  check(results, 'session 子列靜止時的游標為 pointer（不是 grab）',
    (await app.client.evaluate(CURSOR_OF(RAIL_SESSION_SELECTOR))) === 'pointer',
    String(await app.client.evaluate(CURSOR_OF(RAIL_SESSION_SELECTOR))))

  // ── workspace-layout：未位移的按下視為點擊（repo 列現在也掛著 onMouseDown）
  //
  // 這條守的是「加了拖曳之後，點擊還在不在」。**必須送真的 mousedown → mouseup**：合成的
  // `.click()` 不走那條路，用它驗等於什麼都沒驗。
  const orderBeforeClick = (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',')
  await realPressRelease(app.client, await app.client.evaluate(FOLDER_ROW_RECT(0)))
  await sleep(300)
  const selectedByClick = await app.client.evaluate(SELECTED_FOLDER)
  check(results, '於 repo 列按下再放開（未位移）＝點擊，選中該 repo 且順序不變',
    selectedByClick?.includes('repo-openspec') &&
      (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',') === orderBeforeClick,
    `選中=${selectedByClick} 順序=${(await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(', ')}`)

  // ── global-session：rail 上那個不隸屬任何 folder 的固定項目
  //
  // **它不在 `RAIL_ROWS` 裡**（那份以「有移除按鈕」識別 folder 列）—— 那正是它的鑑別點之一：
  // 它不可移除。因此這一段以它自己的 `aria-label` 定位。
  const GLOBAL_ROW = `document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul > li > div[aria-label="${copy('rail.globalName')}"]')`

  check(results, 'rail 呈現全域項目，且它是第一個項目',
    await app.client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] > ul > li > div[role="button"]')]
      return rows[0]?.getAttribute('aria-label') === ${JSON.stringify(copy('rail.globalName'))}
    })()`),
    String(await app.client.evaluate(`${GLOBAL_ROW}?.getAttribute('aria-label')`)))

  // 全域項目沒有 repo 可讀 —— 它那一列不得出現分支。fixture 的三個 repo 都有分支，因此
  // 「rail 上有分支文字」這件事本身是成立的，這條問的是**那一列**有沒有。
  check(results, '全域項目不呈現 git 分支',
    await app.client.evaluate(`(() => {
      const row = ${GLOBAL_ROW}
      if (!row) return false
      const branches = ${JSON.stringify(['main', 'master'])}
      return !branches.some((b) => row.innerText.includes(b))
    })()`),
    String(await app.client.evaluate(`${GLOBAL_ROW}?.innerText`)))

  check(results, '全域項目不提供移除入口',
    await app.client.evaluate(`(() => {
      const li = ${GLOBAL_ROW}?.closest('li')
      return !!li && !li.querySelector('button[aria-label$="${suffixOf('rail.removeFolder')}"]')
    })()`))

  // **「它不是被合成出來的一筆 folder」的鑑別點在磁碟上，不在畫面上。**
  // 使用者今日的變通（把 `~` 加進 workspace）在畫面上長得很像，差別是那樣會有一筆真的 folder。
  const persisted = JSON.parse(readFileSync(join(profile, 'workspace.json'), 'utf8'))
  const persistedHasHome = persisted.folders.some((f) => f.path === homedir())
  check(results, 'workspace 的持久化設定中沒有代表全域項目的條目',
    persisted.folders.length === 3 && !persistedHasHome,
    `條目數=${persisted.folders.length}（期望 3）；含家目錄=${persistedHasHome}`)

  // 拖曳它：順序不變（它不是 workspace 的成員，沒有順序可言）。
  const orderBeforeGlobalDrag = (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',')
  const globalRect = await app.client.evaluate(`(() => {
    const r = ${GLOBAL_ROW}?.getBoundingClientRect()
    return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null
  })()`)
  if (globalRect) {
    const lastBlock = await app.client.evaluate(FOLDER_BLOCK_RECT(2))
    await dragMouse(app.client, globalRect, { x: globalRect.x, y: lastBlock.top + lastBlock.height })
    await sleep(400)
  }
  check(results, '全域項目不可被拖曳排序（順序不變）',
    (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',') === orderBeforeGlobalDrag,
    (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(','))

  // ── workspace-layout：拖曳 repo 改變 rail 的順序
  //
  // 起點是 repo-openspec 的**標題列**（拖曳的起點只掛在那裡），落點以**整個區塊**判定。
  //
  // **落點的期望值一律以「指示線畫在哪裡」為準，不以實作的內部索引為準。** 這裡曾經反過來 ——
  // 探針把準心移到區塊頂端 3px 去遷就一個 off-by-one（往下拖時東西會落在指示線的下一格，拖到
  // 第二個 repo 的下半部就飛到清單末端），於是驗收永遠是綠的，而使用者的拖曳是錯的。
  const railNames = async () => (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',')
  const dragBlockToY = async (index, y) => {
    const from = await app.client.evaluate(FOLDER_ROW_RECT(index))
    await dragMouse(app.client, from, { x: from.x, y })
    await sleep(400)
  }

  // (a) 拖到 plain 的**上半** ＝ 指示線在 plain 之前 ＝ openspec 現在的位置 → 放開是無操作。
  const plainBlockA = await app.client.evaluate(FOLDER_BLOCK_RECT(1))
  await dragBlockToY(0, plainBlockA.top + 3)
  check(results, '拖到下一個 repo 的上半（＝插在它之前）＝ 原地不動',
    (await railNames()) === 'repo-openspec,repo-plain,repo-missing',
    await railNames())

  // (b) 拖到 plain 的**下半** ＝ 指示線在 plain 之後 → openspec 落到 plain 與 missing 之間。
  //     **這條才是那個 off-by-one 的照妖鏡**：修正前它會越過 missing、飛到清單末端。
  const plainBlockB = await app.client.evaluate(FOLDER_BLOCK_RECT(1))
  await dragBlockToY(0, plainBlockB.top + plainBlockB.height - 3)
  const afterDrag = await pollUntil(app.client, RAIL_ROWS, (rows) => rows[0]?.name === 'repo-plain', 4000)
  check(results, '拖曳 repo 改變 rail 的順序，且落點與指示線一致（不多跳一格）',
    afterDrag.map((r) => r.name).join(',') === 'repo-plain,repo-openspec,repo-missing',
    `${afterDrag.map((r) => r.name).join(', ')}（多跳一格的話會是 repo-plain, repo-missing, repo-openspec）`)

  // (c) 拖到 rail 的**最下方** → 落到清單末端（末端必須拖得到）。
  const missingBlock = await app.client.evaluate(FOLDER_BLOCK_RECT(2))
  await dragBlockToY(1, missingBlock.top + missingBlock.height - 3)
  check(results, '拖到最下方 → 落到清單末端',
    (await railNames()) === 'repo-plain,repo-missing,repo-openspec',
    await railNames())

  // (d) 拖回中間，順便把順序帶回 (b) 的結果 —— 下面的重啟斷言以它為期望值。
  const missingBlockD = await app.client.evaluate(FOLDER_BLOCK_RECT(1))
  await dragBlockToY(2, missingBlockD.top + 3)
  check(results, '往上拖：落在指示線之處',
    (await railNames()) === 'repo-plain,repo-openspec,repo-missing',
    await railNames())

  // 選中的是**那個 repo**，不是那個位置 —— 它移動之後，主舞台呈現的仍該是它。
  check(results, '被移動的 repo 於新位置仍為選中',
    (await app.client.evaluate(SELECTED_FOLDER))?.includes('repo-openspec'),
    String(await app.client.evaluate(SELECTED_FOLDER)))

  check(results, '展開中的 repo 連同其 session 子列一起移動',
    (await app.client.evaluate(SESSION_ROW_LABELS)).length === 2 &&
      // **以 folder 清單索引，不以 DOM 位置** —— rail 的第一列是全域項目、其後還有分隔線。
      (await app.client.evaluate(`${FOLDER_LIS}[1].querySelectorAll('ul li').length`)) === 2,
    'session 子列必須跟著它所屬的 repo 走')

  // ── 於 session 子列上拖曳，**只移動 session，repo 的順序不動**
  //
  // 兩種拖曳在 DOM 上是巢狀的。起點若沒有互斥（repo 的 onMouseDown 掛在整個 `<li>` 上），
  // 一次拖曳會**同時移動 session 與 repo** —— 而 fixture 若沒有展開的子列，這個 bug 會躲過
  // 整輪全綠的驗收。
  const railOrderBeforeSessionDrag = (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',')
  const sessionsBefore = await app.client.evaluate(SESSION_ROW_LABELS)
  const sessionFrom = await app.client.evaluate(SESSION_ROW_RECT(1))
  const sessionTo = await app.client.evaluate(SESSION_ROW_RECT(0))
  await dragMouse(app.client, sessionFrom, { x: sessionTo.x, y: sessionTo.y - 4 })
  const sessionsAfter = await pollUntil(
    app.client,
    SESSION_ROW_LABELS,
    (v) => v[0] === sessionsBefore[1],
    4000,
  )
  check(results, '於 session 子列上拖曳只移動 session',
    JSON.stringify(sessionsAfter) === JSON.stringify([...sessionsBefore].reverse()),
    `${JSON.stringify(sessionsBefore)} → ${JSON.stringify(sessionsAfter)}`)
  check(results, '於 session 子列上拖曳時，repo 的順序不變',
    (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',') === railOrderBeforeSessionDrag,
    (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(', '))

  // ── rail-pinning：置頂 ────────────────────────────────────────────────────
  //
  // 這一段的順序前提：上面拖曳段結束時是 `repo-plain, repo-openspec, repo-missing`，且
  // repo-openspec 底下有兩個 session 子列（展開）。
  console.log('\n置頂')

  const PINNED_UL = `document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.pinnedList')}"]')`
  const REST_UL = `document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.folderList')}"]')`

  /**
   * The folder names of each section, from the row's aria-label (the item's name). Its title is the path plus the
   * most urgent session state (session-wait-indicator), so it no longer reads as a name.
   */
  const SECTIONS = `(() => {
    const namesOf = (ul) => [...(ul?.querySelectorAll(':scope > li > div[role="button"]') ?? [])]
      .filter((row) => row.getAttribute('aria-label') !== ${JSON.stringify(copy('rail.globalName'))})
      .map((row) => row.getAttribute('aria-label') ?? '')
    return { pinned: namesOf(${PINNED_UL}), rest: namesOf(${REST_UL}) }
  })()`

  // `copy()` 在 Node 端就把 name 代進去 —— 不要寫成 `.replace('%NAME%', '${name}')`：那個
  // `'${name}'` 位於 `${...}` 之內，是一段**字面**的 `${name}`，不會被代換（實測踩過）。
  const PIN_BUTTON = (name) =>
    `document.querySelector('button[aria-label="${copy('rail.pinFolder', { name })}"]')`
  const UNPIN_BUTTON = (name) =>
    `document.querySelector('button[aria-label="${copy('rail.unpinFolder', { name })}"]')`

  const sections = async () => app.client.evaluate(SECTIONS)

  check(results, '初始狀態：沒有任何 repo 被置頂，全部都在其餘段',
    JSON.stringify(await sections()) ===
      JSON.stringify({ pinned: [], rest: ['repo-plain', 'repo-openspec', 'repo-missing'] }),
    JSON.stringify(await sections()))

  // **既有行為的回歸守衛**：沒有任何置頂 folder 時，分界的位置與置頂能力加進來之前相同 ——
  // 緊接在全域項目之後。置頂段此時只有全域項目那一列。
  check(results, '尚無置頂的 folder 時，分隔線緊接於全域項目之後',
    await app.client.evaluate(`(() => {
      const rows = [...(${PINNED_UL}?.querySelectorAll(':scope > li') ?? [])]
      return rows.length === 1 &&
        rows[0].querySelector('div[role="button"]')?.getAttribute('aria-label') ===
          ${JSON.stringify(copy('rail.globalName'))}
    })()`),
    JSON.stringify(await sections()))

  // ── 入口一：圖釘按鈕（rail-pinning「以控制項切換置頂」）
  //
  // **兩個入口各自要有自己的斷言，不得以其中一個推論另一個** —— 它們是兩條獨立的程式路徑。
  check(results, '未置頂的列上有圖釘按鈕（hover 才顯示，但存在於 DOM）',
    (await app.client.evaluate(`Boolean(${PIN_BUTTON('repo-plain')})`)) === true)
  await app.client.evaluate(`${PIN_BUTTON('repo-plain')}.click()`)
  const afterPin = await pollUntil(app.client, SECTIONS, (v) => v.pinned.length === 1, 4000)
  check(results, '以圖釘按鈕置頂：該 repo 移入置頂段',
    JSON.stringify(afterPin) ===
      JSON.stringify({ pinned: ['repo-plain'], rest: ['repo-openspec', 'repo-missing'] }),
    JSON.stringify(afterPin))

  // 落點：置頂 → 置頂段的**末端**（既有置頂者的相對順序不變）。
  await app.client.evaluate(`${PIN_BUTTON('repo-missing')}.click()`)
  const afterSecondPin = await pollUntil(app.client, SECTIONS, (v) => v.pinned.length === 2, 4000)
  check(results, '第二次置頂落在置頂段末端，既有置頂者的順序不變',
    JSON.stringify(afterSecondPin) ===
      JSON.stringify({ pinned: ['repo-plain', 'repo-missing'], rest: ['repo-openspec'] }),
    JSON.stringify(afterSecondPin))

  // ── 圖釘的可見性依它當下扮演的角色（rail-pinning）
  //
  // 置頂 ⇒ 它是**狀態指示**，恆常呈現；未置頂 ⇒ 它只是入口，hover 才出現。
  // **以 computed opacity 判定，不以 class**（class 是樣式不是契約，而且 hover 變體的字串
  // 也含 `opacity`）。
  const OPACITY_OF = (selector) => `(() => {
    const el = ${selector}
    return el ? getComputedStyle(el).opacity : null
  })()`

  // **先把指標移開。** 上面那些拖曳把它留在某一列上，而未置頂的圖釘是 `group-hover` 才顯示的
  // —— 不移開的話「未懸停時不呈現」量到的是 1，那條斷言會紅，而原因與實作無關。
  await app.client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0,
  })
  await sleep(200)
  check(results, '置頂的列在未懸停時仍呈現圖釘（它是狀態，不只是入口）',
    (await app.client.evaluate(OPACITY_OF(UNPIN_BUTTON('repo-plain')))) === '1',
    String(await app.client.evaluate(OPACITY_OF(UNPIN_BUTTON('repo-plain')))))
  check(results, '未置頂的列在未懸停時不呈現圖釘',
    (await app.client.evaluate(OPACITY_OF(PIN_BUTTON('repo-openspec')))) === '0',
    String(await app.client.evaluate(OPACITY_OF(PIN_BUTTON('repo-openspec')))))

  // rail-pinning: hidden controls do not narrow the name, and keyboard focus in the row shows them. The
  // controls were invisible before this too, yet kept their place and left the name a few characters wide:
  // the assertion is on the name's box reaching under them, not on their opacity.
  const ROW_LAYOUT = (name) => `(() => {
    const pin = ${PIN_BUTTON(name)}
    const row = pin?.closest('[role="button"]')
    if (!row) return null
    const nameBox = [...row.querySelectorAll('div')].find((d) => d.textContent === ${JSON.stringify(name)})
    const controls = [...row.querySelectorAll('button')].filter((b) => !b.hasAttribute('aria-expanded'))
    return {
      nameRight: Math.round(nameBox?.getBoundingClientRect().right ?? -1),
      controlsLeft: Math.round(Math.min(...controls.map((b) => b.getBoundingClientRect().left))),
      opacities: controls.map((b) => getComputedStyle(b).opacity),
    }
  })()`
  const hiddenLayout = await app.client.evaluate(ROW_LAYOUT('repo-openspec'))
  check(results, 'Hidden row controls do not narrow the name',
    hiddenLayout !== null && hiddenLayout.nameRight > hiddenLayout.controlsLeft &&
      hiddenLayout.opacities.every((o) => o === '0'),
    JSON.stringify(hiddenLayout))
  // Keyboard focus, not a click's: focus the row, then Tab into its first control.
  await app.client.evaluate(`${PIN_BUTTON('repo-openspec')}.closest('[role="button"]').focus()`)
  // `lib/cdp.mjs`'s `pressKey` sends Tab with key code 0, which moves no focus; this one is the real key.
  for (const type of ['keyDown', 'keyUp']) {
    await app.client.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  }
  const focusedLayout = await pollUntil(app.client, ROW_LAYOUT('repo-openspec'),
    (v) => v !== null && v.opacities.every((o) => o === '1'), 2000)
  check(results, 'Keyboard focus in the row shows its controls',
    focusedLayout !== null && focusedLayout.opacities.every((o) => o === '1'),
    JSON.stringify(focusedLayout))
  await app.client.evaluate('document.activeElement?.blur()')

  // ── 取消置頂的落點：其餘段的**首端**
  await app.client.evaluate(`${UNPIN_BUTTON('repo-plain')}.click()`)
  const afterUnpin = await pollUntil(app.client, SECTIONS, (v) => v.pinned.length === 1, 4000)
  check(results, '取消置頂落在其餘段首端，其餘 folder 的相對順序不變',
    JSON.stringify(afterUnpin) ===
      JSON.stringify({ pinned: ['repo-missing'], rest: ['repo-plain', 'repo-openspec'] }),
    JSON.stringify(afterUnpin))

  // ── 入口二：folder 標題列的右鍵選單（rail-pinning「以右鍵選單切換置頂」）
  const openFolderMenu = async (index) => {
    const at = await app.client.evaluate(FOLDER_ROW_RECT(index))
    await app.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: at.x, y: at.y, button: 'right', clickCount: 1, buttons: 2,
    })
    await app.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: at.x, y: at.y, button: 'right', clickCount: 1, buttons: 0,
    })
    return pollUntil(app.client, `Boolean(document.querySelector('[role="menu"]'))`, (v) => v === true, 4000)
  }

  const MENU_LABELS = `[...document.querySelectorAll('[role="menu"] button[role="menuitem"]')]
    .map((el) => el.textContent.trim())`

  // index 1 ＝ folder 清單的第二個 ＝ repo-plain（置頂段 repo-missing 是第 0 個）。
  await openFolderMenu(1)
  const menuLabels = await app.client.evaluate(MENU_LABELS)
  check(results, 'folder 標題列的右鍵選單含置頂與移除',
    Array.isArray(menuLabels) &&
      menuLabels.includes(copy('rail.pinAction')) &&
      menuLabels.includes(copy('rail.removeAction')),
    JSON.stringify(menuLabels))

  // **選單必須能全鍵盤操作 —— 那是前提，不是加分項。** 焦點落在第一項、方向鍵循環、Enter 觸發。
  const FOCUSED_MENU_ITEM = `document.activeElement?.getAttribute('role') === 'menuitem'
    ? document.activeElement.textContent.trim() : null`
  check(results, '右鍵選單開啟時焦點落在第一個項目',
    (await app.client.evaluate(FOCUSED_MENU_ITEM)) === menuLabels[0],
    String(await app.client.evaluate(FOCUSED_MENU_ITEM)))
  await pressKey(app.client, 'ArrowDown')
  await sleep(150)
  check(results, '右鍵選單以方向鍵移動焦點',
    (await app.client.evaluate(FOCUSED_MENU_ITEM)) === menuLabels[1],
    String(await app.client.evaluate(FOCUSED_MENU_ITEM)))
  // **循環**：最後一項再按 ↓ 要繞回第一項。R4 明寫「方向鍵循環」，而只驗相鄰移動的話，
  // 一個「到底就停住」的實作照樣全綠。
  await pressKey(app.client, 'ArrowDown')
  await sleep(150)
  check(results, '右鍵選單的方向鍵於末端繞回第一項（循環）',
    (await app.client.evaluate(FOCUSED_MENU_ITEM)) === menuLabels[0],
    `${JSON.stringify(menuLabels)} → ${String(await app.client.evaluate(FOCUSED_MENU_ITEM))}`)

  await pressKey(app.client, 'Enter')
  const afterMenuPin = await pollUntil(app.client, SECTIONS, (v) => v.pinned.length === 2, 4000)
  check(results, '以右鍵選單置頂（與圖釘按鈕是兩條路徑，各自驗）',
    JSON.stringify(afterMenuPin) ===
      JSON.stringify({ pinned: ['repo-missing', 'repo-plain'], rest: ['repo-openspec'] }),
    JSON.stringify(afterMenuPin))

  // ── global-session：全域項目的停用圖釘
  //
  // **停用的判定不得用 `tabIndex`**（disabled 的 `<button>` 其 `tabIndex` 仍回報 0），
  // **也不得用 `dispatchEvent(new MouseEvent('click'))`**（合成事件**會**觸發 listener）。
  // 用 `:disabled` 命中、`.focus()` 之後 activeElement 沒變、以及 `.click()` 不改變任何東西。
  const GLOBAL_PIN = `document.querySelector('button[aria-label="${copy('rail.globalPinned', { name: copy('rail.globalName') })}"]')`
  const globalPinState = await app.client.evaluate(`(() => {
    const el = ${GLOBAL_PIN}
    if (!el) return null
    const before = document.activeElement
    el.focus()
    const took = document.activeElement === el
    return {
      disabled: el.matches(':disabled'),
      ariaDisabled: el.getAttribute('aria-disabled'),
      focusable: took,
      title: el.getAttribute('title'),
      cursor: getComputedStyle(el).cursor,
      restored: before === document.activeElement || !took,
    }
  })()`)
  check(results, '全域項目呈現一個停用的置頂指示，且附有說明',
    globalPinState !== null &&
      globalPinState.disabled === true &&
      globalPinState.ariaDisabled === 'true' &&
      globalPinState.focusable === false &&
      typeof globalPinState.title === 'string' && globalPinState.title.length > 0,
    JSON.stringify(globalPinState))
  check(results, '停用的置頂指示其游標不是 pointer（它不是一個入口）',
    globalPinState?.cursor !== 'pointer', String(globalPinState?.cursor))

  const sectionsBeforeGlobalPin = await sections()
  await app.client.evaluate(`${GLOBAL_PIN}.click()`)
  await sleep(300)
  check(results, '觸發全域項目的置頂指示不改變任何東西（它不可取消）',
    JSON.stringify(await sections()) === JSON.stringify(sectionsBeforeGlobalPin),
    JSON.stringify(await sections()))

  check(results, '全域項目位於置頂段（與置頂的 repo 同一側）',
    await app.client.evaluate(`(() => {
      const first = ${PINNED_UL}?.querySelector(':scope > li > div[role="button"]')
      return first?.getAttribute('aria-label') === ${JSON.stringify(copy('rail.globalName'))}
    })()`))

  // 全域項目**不提供右鍵選單** —— 它既不可移除、置頂也不可切換，一個只有停用項目的選單正是
  // `workspace-layout` 禁止的那種東西。
  const globalAt = await app.client.evaluate(`(() => {
    const r = ${GLOBAL_ROW}?.getBoundingClientRect()
    return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null
  })()`)
  await app.client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: globalAt.x, y: globalAt.y, button: 'right', clickCount: 1, buttons: 2,
  })
  await app.client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: globalAt.x, y: globalAt.y, button: 'right', clickCount: 1, buttons: 0,
  })
  await sleep(400)
  check(results, '全域項目不提供右鍵選單',
    (await app.client.evaluate(`Boolean(document.querySelector('[role="menu"]'))`)) === false)

  // ── workspace-layout：停用的控制項宣告自身的停用狀態
  check(results, 'rail 上每一個停用的控制項都不可聚焦且附有說明',
    await app.client.evaluate(`(() => {
      const rail = document.querySelector('aside[aria-label="${copy('rail.label')}"]')
      const disabled = [...rail.querySelectorAll('button:disabled')]
      if (disabled.length === 0) return false
      return disabled.every((el) => {
        el.focus()
        const focusable = document.activeElement === el
        const title = el.getAttribute('title')
        return !focusable && typeof title === 'string' && title.length > 0
      })
    })()`),
    '停用的控制項：不可聚焦 + 有 title')

  // ── rail-pinning：跨越分界的拖曳
  //
  // 此刻：置頂段 = [repo-missing, repo-plain]、其餘段 = [repo-openspec]，
  // folder 清單順序 = repo-missing, repo-plain, repo-openspec。
  const DIVIDER_RECT = `(() => {
    const rail = document.querySelector('aside[aria-label="${copy('rail.label')}"]')
    const el = [...rail.children].find((c) => c.getAttribute('aria-hidden') === 'true')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), top: Math.round(r.top), bottom: Math.round(r.bottom) }
  })()`

  /**
   * 拖曳中的插入指示線。
   *
   * 兩個落點相距不到 10px，因此**要分得出是哪一個**：分界之上的落點畫在分界自己的疊加元素上，
   * 分界之下的落點畫在第一個未置頂列的上緣（`border-t-2`）。以 computed style 判定，不以 class
   * （class 是樣式不是契約，而 hover 變體的字串也含同樣的片段）。
   */
  const DROP_INDICATOR = `(() => {
    const rail = document.querySelector('aside[aria-label="${copy('rail.label')}"]')
    const divider = [...rail.children].find((c) => c.getAttribute('aria-hidden') === 'true')
    const dRect = divider?.getBoundingClientRect()
    // 分界上的指示線以**幾何位置**分辨在它之上還是之下 —— 那正是這條要驗的「兩個落點可辨」。
    const onDivider = [...(divider?.querySelectorAll('span') ?? [])]
      .map((sp) => (sp.getBoundingClientRect().top < dRect.top ? 'above' : 'below'))
    const onRows = [...rail.querySelectorAll('ul > li')]
      .map((li, i) => ({ i, width: getComputedStyle(li).borderTopWidth }))
      .filter((r) => r.width !== '0px')
      .map((r) => r.i)
    return { onDivider, onRows }
  })()`

  const holdDrag = async (from, to, steps = 6) => {
    const base = { button: 'left', buttons: 1, clickCount: 1 }
    await app.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from, button: 'none', buttons: 0 })
    await app.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, ...base })
    for (let step = 1; step <= steps; step++) {
      await app.client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + ((to.x - from.x) * step) / steps),
        y: Math.round(from.y + ((to.y - from.y) * step) / steps),
        ...base,
      })
    }
  }
  const releaseAt = async (to) => {
    await app.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1,
    })
    await sleep(400)
  }

  // ── 指示線：分界的兩側各自到得了，且彼此可辨
  {
    const divider = await app.client.evaluate(DIVIDER_RECT)
    const from = await app.client.evaluate(FOLDER_ROW_RECT(2)) // repo-openspec（唯一未置頂）

    await holdDrag(from, { x: divider.x, y: divider.top - 3 })
    const above = await app.client.evaluate(DROP_INDICATOR)
    check(results, '拖到分界之上：指示線畫在分界**之上**（＝落在置頂段的最後一格）',
      JSON.stringify(above?.onDivider) === JSON.stringify(['above']), JSON.stringify(above))
    await releaseAt({ x: divider.x, y: divider.top - 3 })

    // 放開之後它被置頂了 —— 換一個仍未置頂的來測另一側。
    const back = await app.client.evaluate(SECTIONS)
    check(results, '拖到分界之上放開 ⇒ 該 repo 被置頂',
      back.pinned.includes('repo-openspec'), JSON.stringify(back))

    // 還原：把它拖回分界之下。
    const divider2 = await app.client.evaluate(DIVIDER_RECT)
    const openspecIndex = (await app.client.evaluate(RAIL_ROWS)).findIndex((r) => r.name === 'repo-openspec')
    const from2 = await app.client.evaluate(FOLDER_ROW_RECT(openspecIndex))
    await holdDrag(from2, { x: divider2.x, y: divider2.bottom + 3 })
    const below = await app.client.evaluate(DROP_INDICATOR)
    // 此刻**所有 folder 都被置頂**（上一步把最後一個未置頂的也拖上去了），於是列空間的最後
    // 一列就是分界本身 —— 指示線必須畫在分界**之下**。
    // 這一格曾經完全沒有指示線：`dropAtEnd` 掛在「最後一個 folder」上，而那時沒有任何 folder
    // 拿得到它，於是當下**唯一**的 unpin 手勢是看不見的。
    check(results, '拖到分界之下：指示線畫在分界**之下**，與上一條的位置可辨',
      JSON.stringify(below?.onDivider) === JSON.stringify(['below']) &&
        Array.isArray(below?.onRows) && below.onRows.length === 0,
      JSON.stringify(below))
    await releaseAt({ x: divider2.x, y: divider2.bottom + 3 })

    // 「拖到自己原本的位置 ⇒ 無操作，且**不呈現指示線**」——
    // 一條說「放開會移動」的線，放開卻什麼都不動，是在騙人（`workspace-layout` 明載）。
    // 這條此前**全 repo 沒有任何載體**（`grep border-t-accent scripts/*.mjs` 零命中），
    // 而置頂讓指示線變成承重的。
    const selfIndex = (await app.client.evaluate(RAIL_ROWS)).findIndex((r) => r.name === 'repo-openspec')
    const selfFrom = await app.client.evaluate(FOLDER_ROW_RECT(selfIndex))
    const selfBlock = await app.client.evaluate(FOLDER_BLOCK_RECT(selfIndex))
    await holdDrag(selfFrom, { x: selfFrom.x, y: selfBlock.top + 3 })
    const selfDrop = await app.client.evaluate(DROP_INDICATOR)
    check(results, '拖到自己原本的位置：不呈現任何插入指示線',
      Array.isArray(selfDrop?.onDivider) && selfDrop.onDivider.length === 0 &&
        Array.isArray(selfDrop?.onRows) && selfDrop.onRows.length === 0,
      JSON.stringify(selfDrop))
    await releaseAt({ x: selfFrom.x, y: selfBlock.top + 3 })
  }

  // ── **只改變置頂狀態、序位不變**的拖曳不得被當成無操作
  //
  // 這是整條落點語意最要緊的性質：把置頂段的最後一個拖到分界之下，它在 folder 清單裡的序位
  // **前後同值** —— 任何以 folder 序位判定「有沒有移動」的閘門（renderer 的、主行程的）都會
  // 把它吞掉，而畫面上只是「拖了半天它沒有被取消置頂」。
  {
    const before = await app.client.evaluate(SECTIONS)
    const orderBefore = (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',')
    const lastPinned = before.pinned[before.pinned.length - 1]
    const lastPinnedIndex = (await app.client.evaluate(RAIL_ROWS)).findIndex((r) => r.name === lastPinned)
    const divider = await app.client.evaluate(DIVIDER_RECT)
    const from = await app.client.evaluate(FOLDER_ROW_RECT(lastPinnedIndex))

    await dragMouse(app.client, from, { x: divider.x, y: divider.bottom + 3 })
    const after = await pollUntil(app.client, SECTIONS, (v) => !v.pinned.includes(lastPinned), 4000)
    const orderAfter = (await app.client.evaluate(RAIL_ROWS)).map((r) => r.name).join(',')

    check(results, '置頂段最後一個拖到分界之下 ⇒ 取消置頂（且未被當成無操作）',
      !after.pinned.includes(lastPinned) && after.rest[0] === lastPinned,
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    check(results, '該次拖曳的 folder 序位前後同值 —— 變的只有置頂狀態',
      orderAfter === orderBefore, `${orderBefore} → ${orderAfter}`)
  }

  // ── 分界不使其餘段內的落點偏移
  //
  // 有置頂 folder 存在時，rail 的列空間比 folder 清單多**兩**列（全域項目 + 分界），而偏移量
  // 隨置頂數變動。一個寫死的「加一」在「沒有任何 folder 被置頂」時完全正確 —— 這一段就是要在
  // **有**置頂者的情況下再驗一次落點。
  {
    const sectionsNow = await app.client.evaluate(SECTIONS)
    check(results, '前提 —— 此刻確實有置頂的 folder，其餘段也有兩個（否則這條沒有鑑別力）',
      sectionsNow.pinned.length >= 1 && sectionsNow.rest.length === 2,
      JSON.stringify(sectionsNow))

    const restNames = () => app.client.evaluate(`${SECTIONS}.rest`)
    const before = await restNames()
    const firstRestIndex = (await app.client.evaluate(RAIL_ROWS)).findIndex((r) => r.name === before[0])
    const secondRestIndex = (await app.client.evaluate(RAIL_ROWS)).findIndex((r) => r.name === before[1])
    const target = await app.client.evaluate(FOLDER_BLOCK_RECT(secondRestIndex))
    const from = await app.client.evaluate(FOLDER_ROW_RECT(firstRestIndex))

    // 拖到第二個未置頂 repo 的**下半** ⇒ 落在它之後。
    await dragMouse(app.client, from, { x: from.x, y: target.top + target.height - 3 })
    const after = await pollUntil(app.client, `${SECTIONS}.rest`, (v) => v[0] === before[1], 4000)
    check(results, '有置頂 folder 時，其餘段內的拖曳落點仍與指示線一致（分界不使它偏移）',
      JSON.stringify(after) === JSON.stringify([before[1], before[0]]),
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    check(results, '其餘段內的拖曳不改變置頂段',
      JSON.stringify((await app.client.evaluate(SECTIONS)).pinned) === JSON.stringify(sectionsNow.pinned),
      JSON.stringify((await app.client.evaluate(SECTIONS)).pinned))
  }

  // ── 還原成「repo-missing, repo-plain 置頂；repo-openspec 未置頂」
  //     下面的重啟斷言以這個狀態為期望值。
  {
    const want = ['repo-missing', 'repo-plain']
    for (const name of want) {
      const current = await app.client.evaluate(SECTIONS)
      if (current.pinned.includes(name)) continue
      await app.client.evaluate(`${PIN_BUTTON('%N%').replace('%N%', name)}.click()`)
      await pollUntil(app.client, SECTIONS, (v) => v.pinned.includes(name), 4000)
    }
    const current = await app.client.evaluate(SECTIONS)
    for (const name of current.pinned.filter((n) => !want.includes(n))) {
      await app.client.evaluate(`${UNPIN_BUTTON('%N%').replace('%N%', name)}.click()`)
      await pollUntil(app.client, SECTIONS, (v) => !v.pinned.includes(name), 4000)
    }
    // 置頂段內的順序也要是 want 的順序 —— 重啟斷言比對的是完整的清單。
    const finalSections = await app.client.evaluate(SECTIONS)
    check(results, '置頂段的最終狀態符合下游重啟斷言的前提',
      JSON.stringify(finalSections) ===
        JSON.stringify({ pinned: want, rest: ['repo-openspec'] }),
      JSON.stringify(finalSections))
  }

  // ── 分界的位置（global-session）
  const DIVIDER_BETWEEN = `(() => {
    const rail = document.querySelector('aside[aria-label="${copy('rail.label')}"]')
    const kids = [...rail.children]
    const pinnedIndex = kids.indexOf(${PINNED_UL})
    const restIndex = kids.indexOf(${REST_UL})
    const dividerIndex = kids.findIndex((el) => el.getAttribute('aria-hidden') === 'true')
    return { pinnedIndex, dividerIndex, restIndex }
  })()`
  const divider = await app.client.evaluate(DIVIDER_BETWEEN)
  check(results, '分隔線劃在置頂段與其餘 folder 之間',
    divider !== null && divider.pinnedIndex < divider.dividerIndex && divider.dividerIndex < divider.restIndex,
    JSON.stringify(divider))


  // ── status-bar：主視窗底部的狀態列 ────────────────────────────────────────
  //
  // 這條列是**雛型早已定義、卻從未實作**的元素（`.statusbar`）。它的驗收有兩個面向：版面上的
  // 存在與穩定（`workspace-layout`），以及內容（`status-bar`）。
  //
  // **不驗 agent 回報的那幾段** —— 那需要一個真的會照著注入命令寫檔的 agent，由 `probe:terminal`
  // 以 stub 承載。這裡驗的是「第一手欄位」與「缺 agent 狀態時照樣可用」。
  console.log('\n狀態列')

  const STATUS_BAR = `(() => {
    const bar = document.querySelector('footer[aria-label="${copy('statusBar.label')}"]')
    if (!bar) return null
    const rect = bar.getBoundingClientRect()
    return {
      text: bar.textContent ?? '',
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      viewportWidth: window.innerWidth,
      // 單行：內容再長也不得換行或橫向捲動（高度是版面契約的一部分）。
      scrollsHorizontally: bar.scrollWidth > bar.clientWidth + 1,
    }
  })()`

  const bar = await pollUntil(app.client, STATUS_BAR, (v) => v !== null, 5000)
  check(results, '狀態列存在於主視窗底部', bar !== null)
  check(results, '狀態列橫跨整個視窗寬度', bar.width === bar.viewportWidth,
    `${bar.width} / ${bar.viewportWidth}`)
  check(results, '狀態列呈現當前 repo 的名稱', bar.text.includes('repo-openspec'), bar.text)

  // **不得呈現恆定不變的欄位** —— 雛型的 `UTF-8` 與版本號是佔位內容，不是版面契約。
  // 一個永遠顯示同一個值的欄位不傳遞任何資訊，只佔位置。
  check(results, '狀態列不含字元編碼或版本號字樣',
    !/UTF-8/i.test(bar.text) && !/\b\d+\.\d+\.\d+\b/.test(bar.text), bar.text)

  /*
    ── status-bar × global-session：focused session 為全域 session 時的脈絡

    它沒有所屬 repo，因此**以全域身分標示取代 repo 名稱**；而 session 計數必須涵蓋它
    （以 folder 為條件計算會讓它恆為 0，而它明明有 session）。
  */
  const GLOBAL_PLUS_RECT = `(() => {
    const btn = document.querySelector('[aria-label="${copy('rail.newSessionIn', { name: copy('rail.globalName') })}"]')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`
  const MENU_SHELL_RECT = `(() => {
    const menu = document.querySelector('[role="menu"]')
    if (!menu) return null
    const item = [...menu.querySelectorAll('button[role="menuitem"]')]
      .find((b) => b.innerText.trim() === ${JSON.stringify(copy('sessions.spawnShell'))})
    if (!item) return null
    const r = item.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`

  const TERMINAL_RECT = `(() => {
    const el = document.querySelector('section[aria-label="${copy('stage.terminal')}"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`

  const plusRect = await pollUntil(app.client, GLOBAL_PLUS_RECT, (v) => v !== null, 6000)
  check(results, '前提：全域項目有建立 session 的入口', plusRect !== null)
  if (plusRect) {
    await realPressRelease(app.client, plusRect)
    const shellItem = await pollUntil(app.client, MENU_SHELL_RECT, (v) => v !== null, 4000)
    if (shellItem) await realPressRelease(app.client, shellItem)

    const globalBar = await pollUntil(
      app.client,
      STATUS_BAR,
      (v) => v !== null && v.text.includes(copy('rail.globalName')),
      10_000,
    )
    check(results, '全域 session focused 時，狀態列以全域身分標示取代 repo 名稱',
      globalBar !== null && globalBar.text.includes(copy('rail.globalName')),
      globalBar?.text)
    check(results, '狀態列不呈現任何 folder 的名稱',
      globalBar !== null && !globalBar.text.includes('repo-openspec') &&
        !globalBar.text.includes('repo-plain'),
      globalBar?.text)
    // 計數以 rail 項目為基準 —— 以 folder 為條件會讓它恆為 0。
    // **不能用 `\b1\b`** —— 狀態列的文字是連續的（`shell 1` 緊接 `1/3 sessions` 會變成
    // `shell 11/3`），那個 word boundary 匹配不到。判準改為「此項目/總數」那一段的形狀。
    check(results, '狀態列的 session 計數涵蓋全域項目（非零）',
      globalBar !== null && /1\/\d+\s/.test(globalBar.text), globalBar?.text)

    /*
      全域項目的側欄來源**預設是未選定的** —— 於是那幾個依附於來源的欄位一個都不該出現。

      少了這兩條，一個「把來源當成 folder 自己」的實作會在這裡標示一個使用者從未選過的 repo，
      而前面三條斷言（全域身分、無 folder 名、計數）**全都照樣通過** —— 它們看的是別的欄位。
    */
    check(results, '來源未選定時，狀態列不標示側欄來源',
      globalBar !== null && !globalBar.text.includes(prefixOf('statusBar.panelSource')),
      globalBar?.text)
    check(results, '來源未選定時，狀態列不呈現 spec 與 change 數',
      globalBar !== null && !globalBar.text.includes(suffixOf('statusBar.openspecCounts')),
      globalBar?.text)

    /*
      **`cd` 進一個 git repo 之後，分支照常呈現。**

      全域 session 的 cwd 恆為家目錄，而產品**在 cwd 恰為家目錄時跳過 git 偵測**（dotfiles-as-git-repo
      是常見設定，於整個家目錄跑 `spawnSync` 會週期性阻塞主行程）。這一條驗的是那道跳過**只是跳過**，
      不是把偵測整個關掉 —— 少了它，「乾脆永遠不偵測」的實作與正確的實作在自動化上完全相同。

      判準是**當下真正的分支**（`git rev-parse` 現場問），不是寫死的 `master`：前面的段落會切 branch。
    */
    const terminal = await pollUntil(app.client, TERMINAL_RECT, (v) => v !== null, 8000)
    check(results, '前提：全域 session 的終端在畫面上', terminal !== null)
    if (terminal) {
      /*
        **打字必須是可重試的動作，不能是一次性的。**

        這個 session 是**剛剛才建立**的 —— 原本的作法是點一下終端、`sleep(200)`、然後直接把
        `cd` 打進去。那個 200ms 沒有任何就緒判準：pty 若還沒走到 prompt（機器一忙就會），
        那一行字就打進虛空，而其後 15 秒的輪詢只會等到逾時，紅燈上看到的是「狀態列沒有分支」
        —— **與「產品沒有偵測分支」完全無法區分**。實測於 `test:e2e` 全跑時偶發過。

        改走 `retryAction`：`cd` 到同一個目錄是冪等的，重打幾次無害，而判準（狀態列出現分支）
        本來就是這條斷言要的東西。這也是這個 repo 的既有紀律 —— 帶副作用的等待走 `retryAction`，
        不要手寫「送一次然後 sleep」。
      */
      const typeCd = async () => {
        await realPressRelease(app.client, terminal)
        await sleep(200)
        await app.client.send('Input.insertText', { text: `cd ${fixture.withOpenSpec}` })
        // Enter 必須是一次真的按鍵事件 —— 併進 insertText 的 `\r` 抵達得了 pty，但 shell
        // **從未執行那一行**（xterm 的換行是在 keydown 上判讀的）。
        const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' })
        await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
      }

      /*
        **前置條件要自己建立：這個 fixture 此刻是 detached HEAD**（上一段的驗收把它切過去了），
        而 `readGitWorkingState` 對 detached **刻意回 `undefined`**（`# branch.head (detached)`）——
        於是狀態列本來就不會有分支，紅燈會被誤讀成「偵測沒有恢復」。

        **這與 rail 不同源**：rail 的 `branch-service` 在 detached 時呈現短 sha，狀態列的這一條
        不是。兩個判準各自正確，但**不可互相假設** —— 第一版就是照抄 rail 那條的作法而紅的。

        判準仍然現場問，不寫死：`-b master` 是 fixture 建的，但那是另一段的細節。
      */
      git(fixture.withOpenSpec, ['checkout', '-q', 'master'])
      const branchNow = git(fixture.withOpenSpec, ['rev-parse', '--abbrev-ref', 'HEAD'])
      // 狀態輪詢是 2 秒一次，`cd` 之後要等它下一輪；`act` 之間留足一輪的時間再重打。
      /*
        **診斷：這條紅的時候要分得出「字沒進 pty」與「進了但狀態列沒更新」。**

        兩者的紅燈長得一模一樣（狀態列沒有分支），而處置完全相反。終端的可見文字是唯一能
        區分它們的證據：`cd …` 有沒有被 shell 回顯、prompt 有沒有換行。
      */
      const TERMINAL_TEXT = `(() => {
        const el = document.querySelector('section[aria-label="${copy('stage.terminal')}"]')
        // xterm 在 xvfb 上走 DOM renderer，字住在 .xterm-rows；抓整個 section 會撈到它注入的
        // <style>（實測現場拿到的是一整串 CSS，那不是終端內容）。
        const screen = el?.querySelector('.xterm-rows') ?? el?.querySelector('.xterm-screen')
        // 不要在這裡寫 regex literal：這段住在一個 template literal 裡，換行的跳脫序列會先
        // 被解析成真正的換行，而 regex literal 不能跨行（實測 SyntaxError: missing /）。
        // 這段註解本身也不得出現反引號 —— 它會把外層的 template literal 提前關掉。
        const lines = (screen?.innerText ?? '').split(String.fromCharCode(10))
        return lines.filter((l) => l.trim() !== '').slice(-6).join(' | ').slice(-300)
      })()`

      const afterCd = await retryAction({
        act: typeCd,
        read: () => app.client.evaluate(STATUS_BAR),
        settled: (v) => v !== null && v.text.includes(branchNow),
        attemptWindowMs: 8_000,
        timeoutMs: 24_000,
        label: `全域 session cd 進 ${fixture.withOpenSpec} 後狀態列呈現分支`,
        evidence: async () => {
          const screen = await app.client.evaluate(TERMINAL_TEXT)
          // 「pty 還活著嗎」是這裡最要緊的一問：終端沒有任何輸出時，
          // 「shell 沒被 spawn 起來」與「spawn 了但沒印 prompt」處置完全不同。
          const session = await app.client.evaluate(`(() => {
            const rows = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] ul li ul li div[role="button"]')]
            return rows.map((r) => r.getAttribute('title')).slice(0, 6)
          })()`)
          const term = await app.client.evaluate(`(() => {
            const el = document.querySelector('section[aria-label="${copy('stage.terminal')}"]')
            const rows = el?.querySelector('.xterm-rows')
            return {
              hasXterm: Boolean(el?.querySelector('.xterm')),
              rowCount: rows ? rows.children.length : null,
              nonEmptyRows: rows ? [...rows.children].filter((r) => r.textContent.trim() !== '').length : null,
            }
          })()`)
          return `終端文字=${JSON.stringify(screen)}；終端狀態=${JSON.stringify(term)}；session=${JSON.stringify(session)}`
        },
      })
      check(results, '全域 session cd 進 git repo 後，狀態列呈現該處的分支',
        afterCd !== null && afterCd.text.includes(branchNow),
        `分支=${branchNow} 狀態列=${afterCd?.text}`)
      check(results, 'cd 之後仍以全域身分標示（沒有變成某個 folder）',
        afterCd !== null && afterCd.text.includes(copy('rail.globalName')), afterCd?.text)
    }

    // **把狀態還原** —— 後面的斷言假設 focused 的是 repo-openspec（既有紀律：插入的段落
    // 要自行還原它改動的狀態，否則下一段會以「那一段壞了」的樣貌失敗）。
    /*
      **不寫成字面的 aria-label 選擇器** —— `aria-label-source` 守衛（正確地）只看形式，
      不區分「文案」與「fixture 的資料」。以屬性比對取代字面選擇器。

      **說明寫在模板字串外面**：字串內不得出現反引號，它會提前把字串結束掉，而
      `node --check` 有時抓不到（外層恰好仍合法），要到執行時才炸。
    */
    const openspecRow = await pollUntil(
      app.client,
      `(() => {
        const rail = document.querySelector('aside[aria-label="${copy('rail.label')}"]')
        const row = rail && [...rail.querySelectorAll('div[role="button"]')]
          .find((el) => el.getAttribute('aria-label') === 'repo-openspec')
        if (!row) return null
        const r = row.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`,
      (v) => v !== null,
      6000,
    )
    if (openspecRow) await realPressRelease(app.client, openspecRow)
    await pollUntil(app.client, STATUS_BAR, (v) => v?.text.includes('repo-openspec') === true, 8000)
  }

  // 側欄收合不得影響它 —— 它不隸屬於任何一欄。
  await app.client.evaluate(
    `document.querySelector('[aria-label="${copy('panelSwitch.openSpec')}"]')?.click()`,
  )
  await sleep(300)
  const afterCollapse = await app.client.evaluate(STATUS_BAR)
  check(results, '收合 side panel 後狀態列仍在且高度不變',
    afterCollapse !== null && afterCollapse.height === bar.height,
    `${bar.height} → ${afterCollapse?.height}`)

  // 視窗變窄時：維持單行、不橫向捲動，且 repo 名稱仍看得見（由右往左省略）。
  //
  // **「縮放有沒有真的發生」必須自成一條斷言。** 一開始我把 CDP 的視窗縮放包在 `.catch(() => {})`
  // 裡——那樣它在 Electron 上若不支援，下面兩條就會**用原本的寬度通過**，是個假綠。
  // **用 `Emulation.setDeviceMetricsOverride`，不是 `Browser.setWindowBounds`** ——
  // 後者在 Electron 實測**無效且不報錯**（量到 1280 → 1280）。前者改的是 viewport，會真的
  // 觸發一次重排，正是我們要驗的東西。
  const widthBefore = await app.client.evaluate('window.innerWidth')
  try {
    await app.client.send('Emulation.setDeviceMetricsOverride', {
      width: 720, height: 700, deviceScaleFactor: 0, mobile: false,
    })
  } catch {
    // 不支援就讓下面那條前置斷言說話，不要在這裡吞掉。
  }
  await sleep(600)
  const narrow = await app.client.evaluate(STATUS_BAR)
  const widthAfter = await app.client.evaluate('window.innerWidth')
  check(results, '（前置）視窗確實縮小了', widthAfter < widthBefore, `${widthBefore} → ${widthAfter}`)
  check(results, '視窗變窄時狀態列維持單行、不橫向捲動',
    narrow !== null && narrow.scrollsHorizontally === false,
    String(narrow?.scrollsHorizontally))
  check(results, '視窗變窄時 repo 名稱仍可見',
    narrow !== null && narrow.text.includes('repo-openspec'), narrow?.text)
  try {
    await app.client.send('Emulation.clearDeviceMetricsOverride')
  } catch {
    // 同上。
  }
  await sleep(400)

  // ── terminal-preferences：偏好經主行程清理／夾制後回傳，並落盤 ───────────────
  //
  // 送一個**超出範圍**的 size 與一個**含雙引號**的 family —— 主行程 SHALL 夾制／清理，SHALL NOT
  // 原樣寫入（雙引號會破壞 xterm 的 CSS font-family 字串）。回傳值就是套用後的偏好。
  const applied = await app.client.evaluate(
    `window.workspace.settings.setTerminalFont('Bad"Font', 999, 1.2)`,
  )
  check(results, '寫入偏好時，主行程夾制 size、清理 family、保留合法行高',
    applied?.fontFamily === 'BadFont' && applied?.fontSize === 32 && applied?.lineHeight === 1.2,
    JSON.stringify(applied))

  // 定成一組合法的值，供下面的重啟斷言使用。
  await app.client.evaluate(`window.workspace.settings.setTerminalFont('Fira Code', 15, 1.1)`)

  // ── 單一工作目錄的 git repo 不呈現工作目錄選擇器 ──────────────────────────
  //
  // **這一條的載體只有這裡。** `side-panel-worktree` 要求「清單恰有一筆時不呈現選擇器」，而它
  // 真正防的缺陷是：代表 folder 自身的那一筆若以「合成一筆 + 翻譯其餘各筆」產生，**每一個
  // folder 即其 repo 主工作目錄的普通 repo**（最常見的情形）都會得到兩筆 —— 第二筆是使用者
  // 當下所在的位置，卻標著「位於此 folder 之外」。
  //
  // 其他探針走不到這條路徑：`probe:files` 的 fixture 非 git（列舉為空陣列），`probe:openspec`
  // 的 fixture 有三個工作目錄。**`repo-openspec` 是唯一「真 git repo + 恰好一個工作目錄」的
  // fixture**，於是這裡是那個缺陷唯一會現形的地方。
  console.log('\nFiles：單一工作目錄不呈現工作目錄選擇器')

  await app.client.evaluate(`(() => {
    const row = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] div[role="button"]')]
      .find((el) => el.innerText.includes('repo-openspec'))
    if (!row) return false
    row.click()
    return true
  })()`)
  await sleep(300)
  // **身分 tab 沒有無障礙標籤** —— 它只有 `title` 與文字。而 `panelSwitch.files` 與
  // `files.label` 的字典值**是同一個字串**，於是以該標籤屬性選取會命中 Files 面板那個
  // `<section>`（對它 `click()` 什麼都不會發生）。必須以 tablist 限定再取文字。
  const CLICK_FILES_TAB = `(() => {
    const tab = [...document.querySelectorAll(
      '[role="tablist"][aria-label="${copy('panelSwitch.label')}"] button[role="tab"]',
    )].find((b) => b.innerText.includes(${JSON.stringify(copy('panelSwitch.files'))}))
    if (!tab) return false
    if (tab.getAttribute('aria-selected') === 'true') return true
    tab.click()
    return true
  })()`

  await app.client.evaluate(CLICK_FILES_TAB)
  const filesShown = await pollUntil(
    app.client,
    `document.querySelector('[role="tablist"][aria-label="${copy('panelSwitch.label')}"] button[role="tab"][aria-selected="true"]')?.innerText ?? null`,
    (v) => typeof v === 'string' && v.includes(copy('panelSwitch.files')),
    8000,
  )
  check(results, '（前置）切至 Files 身分', typeof filesShown === 'string', String(filesShown))

  // 樹畫出來了才算數 —— 選擇器與樹同時渲染，只確認 section 存在會在清單抵達前就斷言。
  await pollUntil(
    app.client,
    `document.querySelectorAll('section[aria-label="${copy('files.label')}"] [role="treeitem"]').length`,
    (n) => n > 0,
    10_000,
  )
  const soloPicker = await app.client.evaluate(
    `(() => {
      const btn = document.querySelector(
        'section[aria-label="${copy('files.label')}"] button[aria-label="${copy('files.worktree.change')}"]',
      )
      return btn ? btn.innerText.trim() : null
    })()`,
  )
  check(
    results,
    '真 git repo 但只有一個工作目錄時，不呈現工作目錄選擇器',
    soloPicker === null,
    String(soloPicker),
  )

  await app.close()

  // ── workspace-folders：重啟後還原**使用者排定的順序** ─────────────────────
  //
  // 這條同時守住兩件事：清單跨重啟還原，且順序是**使用者排出來的**（不是加入的先後）——
  // 上面那次拖曳把 repo-plain 換到了第一個。
  console.log('\n重啟後還原')
  app = await launch(profile)
  // **輪詢，不要量一次就斷言。** `app.mounted` 只保證 rail 的 `<aside>` 掛上了，而**列本身來自
  // 一次非同步的 `folders.list()`，晚一步才渲染** —— 一啟動就量會讀到空陣列，於是順序比對失敗，
  // 而 detail 也是空的（**看起來像「順序錯了」，其實是還沒畫出來**）。實測：連跑兩輪
  // `test:e2e`，第二輪在這裡紅。上面第一次啟動時（`RAIL_ROWS` 的 `length === 3`）本來就是輪詢的，
  // 這條重啟路徑漏了 —— 同一個教訓 CLAUDE.md 已為 `probe:openspec` 記過一次。
  //
  // 輪詢的是「列渲染出來了沒」，**不是**「順序對不對」：順序錯的話 length 仍是 3，下面照樣紅。
  //
  // **上面那個「還沒畫出來」的歸因，當時沒有排除另一個解釋**：`close()` 此前只送 SIGTERM 再
  // 固定等 600ms，於是**舊主行程可能還在寫 `workspace.json`**，而下面兩條斷言讀的正是它。
  // 兩個 Electron 行程短暫共用同一個 userData，後寫的贏 —— 症狀同樣是「順序不對」。
  // 關閉改為等到行程確實結束之後（`quitAndWait`，issue #8 同族），若這條不再偶發變紅，
  // 上面那段歸因要回頭更正。
  const afterRestart = await pollUntil(app.client, RAIL_ROWS, (rows) => rows.length === 3, 10_000)
  // 期望值來自上面「置頂」那一段的最終狀態：repo-missing 與 repo-plain 置頂（依序），
  // repo-openspec 未置頂。置頂改變了 folder 清單的順序，因此這條的期望值也隨之改變。
  check(results, '清單與使用者排定的順序於重啟後一致',
    afterRestart.map((r) => r.name).join(',') === 'repo-missing,repo-plain,repo-openspec',
    afterRestart.length === 0
      ? 'rail 一列都沒有 —— 列未及渲染，不是順序錯了'
      : afterRestart.map((r) => r.name).join(', '))

  // ── rail-pinning：置頂狀態跨重啟存活
  //
  // **這條與上面那條是兩件事。** 順序對了不代表置頂狀態被保存 —— 一個把 `pinned` 寫進磁碟卻
  // 在載入時丟掉的實作，順序照樣正確（前綴不變式使兩者恰好一致），而 rail 會把全部 folder
  // 都畫在下半段。
  const sectionsAfterRestart = await app.client.evaluate(`(() => {
    const named = (ul) => [...(ul?.querySelectorAll(':scope > li > div[role="button"]') ?? [])]
      .map((row) => row.getAttribute('aria-label'))
    return {
      pinned: named(document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.pinnedList')}"]')),
      rest: named(document.querySelector('aside[aria-label="${copy('rail.label')}"] > ul[aria-label="${copy('rail.folderList')}"]')),
    }
  })()`)
  check(results, '置頂狀態於重啟後還原',
    JSON.stringify(sectionsAfterRestart) ===
      JSON.stringify({
        pinned: [copy('rail.globalName'), 'repo-missing', 'repo-plain'],
        rest: ['repo-openspec'],
      }),
    JSON.stringify(sectionsAfterRestart))

  // ── terminal-preferences：字型偏好跨重啟還原 ──────────────────────────────
  const prefsAfterRestart = await app.client.evaluate('window.workspace.settings.get()')
  check(results, '終端字型偏好於重啟後還原',
    prefsAfterRestart?.fontFamily === 'Fira Code' &&
      prefsAfterRestart?.fontSize === 15 &&
      prefsAfterRestart?.lineHeight === 1.1,
    JSON.stringify(prefsAfterRestart))
  await app.close()

  // ── terminal-preferences：偏好設定檔損毀不得阻止啟動 ──────────────────────
  //
  // 與 workspace.json 同一條紀律：無法信任的內容改名保留、以**預設**偏好啟動，絕不讓 app 開不起來。
  const badPrefsProfile = mkTemp('spekterm-badprefs-')
  writeFileSync(join(badPrefsProfile, 'preferences.json'), '{ not json at all')
  app = await launch(badPrefsProfile)
  check(results, '偏好設定檔損毀時應用程式仍正常啟動', app.mounted?.ok === true, describeMounted(app.mounted))
  const defaultPrefs = await app.client.evaluate('window.workspace.settings.get()')
  check(results, '損毀的偏好以預設啟動（空偏好）',
    defaultPrefs && Object.keys(defaultPrefs).length === 0, JSON.stringify(defaultPrefs))
  const keptPrefs = readdirSync(badPrefsProfile).filter((n) => n.includes('preferences.json.corrupt-'))
    check(results, '損毀的偏好原檔改名保留而非刪除', keptPrefs.length === 1, keptPrefs[0] ?? '(無)')
  await app.close()

  // ── terminal-preferences: automatic hibernation (session-hibernation) ─────
  //
  // Through the user's path (the Settings dialog), not the preload method: the renderer's state is
  // only updated there (`docs/lessons/probes.md`).
  console.log('\nautomatic hibernation preference')
  const HIB_SELECT = `document.querySelector('[role="dialog"] select[aria-label="${copy('settings.autoHibernate')}"]')`
  const HIB_SHOWN = `${HIB_SELECT}?.selectedOptions[0]?.textContent ?? null`
  // Automatic hibernation lives in the Agents & sessions section, and applies when chosen: no Save.
  const openHibernateSettings = async () => {
    await openSettings(app.client, 'agents')
    await pollUntil(app.client, `Boolean(${HIB_SELECT})`, (value) => value === true, 4000)
  }
  const hours24 = copy('settings.autoHibernateHours_other', { count: 24 })

  const hibProfile = mkTemp('spekterm-hibernate-pref-')
  app = await launch(hibProfile)
  await openHibernateSettings()
  const shownDefault = await app.client.evaluate(HIB_SHOWN)
  check(results, 'with no stored value Settings shows automatic hibernation after 24 hours', shownDefault === hours24, String(shownDefault))
  await app.client.evaluate(`(() => {
    const select = ${HIB_SELECT}
    select.value = '0'
        select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const shownAfterChange = await pollUntil(app.client, HIB_SHOWN, (value) => value === copy('settings.autoHibernateOff'), 3000)
  // The choice applies on its own; Settings stays open. Wait for the file before closing the app.
  const readStoredHibernate = () => {
    try {
      return JSON.parse(readFileSync(join(hibProfile, 'preferences.json'), 'utf8')).terminal?.autoHibernateSeconds ?? null
    } catch {
      return 'unreadable'
    }
  }
  const storedOff = await pollFor({
    read: readStoredHibernate,
    settled: (value) => value === 0,
    timeoutMs: 6000,
    label: 'the saved threshold reaches the preferences file',
  })
  await app.close()
  app = await launch(hibProfile)
  await openHibernateSettings()
  const shownOff = await app.client.evaluate(HIB_SHOWN)
  check(
    results,
    'turning automatic hibernation off survives a restart (stored as 0, shown as Off)',
    storedOff === 0 && shownOff === copy('settings.autoHibernateOff'),
        `stored=${JSON.stringify(storedOff)} shown=${JSON.stringify(shownOff)} (after the change: ${JSON.stringify(shownAfterChange)}; file: ${(() => { try { return readFileSync(join(hibProfile, 'preferences.json'), 'utf8').replace(/\s+/g, ' ') } catch { return 'unreadable' } })()})`,
  )
  await closeSettings(app.client)
  await app.close()

  const badHibProfile = mkTemp('spekterm-hibernate-bad-')
  writeFileSync(
    join(badHibProfile, 'preferences.json'),
    JSON.stringify({ version: 1, terminal: { autoHibernateSeconds: -5, fontSize: 15 }, ui: { language: 'en' } }),
  )
  app = await launch(badHibProfile)
  const badPrefs = await app.client.evaluate('window.workspace.settings.get()')
  await openHibernateSettings()
  const shownBad = await app.client.evaluate(HIB_SHOWN)
  check(
    results,
    'a negative stored threshold falls back to 24 hours, and the other preferences are unaffected',
    badPrefs?.autoHibernateSeconds === undefined && badPrefs?.fontSize === 15 && shownBad === hours24,
    `prefs=${JSON.stringify(badPrefs)} shown=${JSON.stringify(shownBad)}`,
  )
  await closeSettings(app.client)
  await app.close()


  // ── ui-localization：語言 ────────────────────────────────────────────────
  //
  // **這一段的前提與其他每一段相反。** 其餘段落都在基準語言下執行（profile 被種入
  // `ui.language = 'en'`），因為 `copy()` 組出的 `aria-label` 選擇器讀的是那份字典；
  // 這裡要驗的正是「語言真的會變」，所以它是唯一一段會用 `copyIn('zh-TW', …)` 的。
  console.log('\nUI 語言')
  const langProfile = mkTemp('spekterm-language-')
  app = await launch(langProfile)

  /**
   * rail 的標題文字，**以指定語言的 `aria-label` 定位**。
   *
   * **`aria-label` 同時是選擇器，而它自己也會被翻譯** —— 切成中文之後，以英文標籤組出的
   * 那個 `aside` 選擇器就選不到任何東西了。這不是缺陷，是這個 repo 的結構性
   * 事實在多語之下的直接後果：驗收在哪一種語言下執行，選擇器就得用哪一種語言的字典。
   * （第一版寫死英文的選擇器，四條斷言一起回 `null` —— 而 `null` 看起來像「介面沒變」，
   * 不像「選不到元素」。）
   */
  const railHeading = (language) =>
    `document.querySelector('aside[aria-label="${copyIn(language, 'rail.label')}"] h2')?.textContent ?? null`
  const railHeadingText = railHeading('en')
  check(results, '種入的語言生效：介面為基準語言',
    (await app.client.evaluate(railHeadingText)) === copy('rail.heading'),
    String(await app.client.evaluate(railHeadingText)))

  // 語言選項的標籤是各語言的**自稱**，且不隨當前 UI 語言改變 —— 一個看不懂當前語言的
  // 使用者，必須能在清單裡認出自己的語言。
  const optionLabels = `(() => {
    const select = document.querySelector('[aria-label="${copy('settings.language')}"]')
    return select ? [...select.options].map((o) => o.textContent) : null
  })()`

  await app.client.evaluate(`document.querySelector('[aria-label="${copy('activityBar.settings')}"]')?.click()`)
  const labelsInEnglish = await pollUntil(app.client, optionLabels, (v) => Array.isArray(v), 5_000)
  check(results, '語言選項以各自語言的自稱呈現',
    JSON.stringify(labelsInEnglish) === JSON.stringify(['English', '繁體中文']),
    JSON.stringify(labelsInEnglish))

  // 切換語言 —— 走產品自己的入口（`updateLanguage` → IPC → 主行程先套用 → renderer 跟上）。
  await app.client.evaluate(`(() => {
    const select = document.querySelector('[aria-label="${copy('settings.language')}"]')
    select.value = 'zh-TW'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)

  const railHeadingZh = await pollUntil(
    app.client, railHeading('zh-TW'), (v) => v === copyIn('zh-TW', 'rail.heading'), 10_000)
  check(results, '切換語言後介面文字立即改變',
    railHeadingZh === copyIn('zh-TW', 'rail.heading'), String(railHeadingZh))

  const optionLabelsZh = `(() => {
    const select = document.querySelector('[aria-label="${copyIn('zh-TW', 'settings.language')}"]')
    return select ? [...select.options].map((o) => o.textContent) : null
  })()`
  check(results, '語言選項的自稱不隨當前 UI 語言改變',
    JSON.stringify(await app.client.evaluate(optionLabelsZh)) === JSON.stringify(labelsInEnglish),
    JSON.stringify(await app.client.evaluate(optionLabelsZh)))

  check(results, '文件宣告的語言與 UI 一致',
    (await app.client.evaluate('document.documentElement.lang')) === 'zh-TW',
    String(await app.client.evaluate('document.documentElement.lang')))

  // **語言必須抵達主行程。** 這條訊息由主行程產生、經 IPC 送達畫面 —— 漏掉傳播的話，
  // 畫面是中文而這一句仍是英文，**而那不會產生任何錯誤**。
  const fsFailure = await app.client.evaluate(
    "window.workspace.fs.listDir('no-such-folder-id', '').then((r) => r.ok ? null : r.message)")
  check(results, '主行程送達畫面的訊息隨語言改變',
    typeof fsFailure === 'string' && fsFailure.includes(copyIn('zh-TW', 'fsError.unknownFolder', { folderId: 'no-such-folder-id' })),
    String(fsFailure))

  await app.close()

  // 跨重啟保留。
  app = await launch(langProfile)
  check(results, '語言選擇跨重啟保留',
    (await app.client.evaluate(railHeading('zh-TW'))) === copyIn('zh-TW', 'rail.heading'),
    String(await app.client.evaluate(railHeading('zh-TW'))))
  await app.close()

  // ── ui-localization：首次啟動的語言取自作業系統 ───────────────────────────
  //
  // **驅動的是 `LANGUAGE` 而不是 `LANG`**（實測 2026-09-18、Electron 43，Linux）：
  // `LANGUAGE` 有值時 `app.getPreferredSystemLanguages()` 一律跟它走，`LANG` 只剩
  // `getSystemLocale()` 在看，而 `--lang` 連 `getLocale()` 都蓋不掉。兩者一起設成一致的值，
  // 免得這段驗收自己重演開發機上「兩個變數互相矛盾」的狀態。
  console.log('\n首次啟動的語言偵測')
  const detectZh = mkTemp('spekterm-detect-zh-')
  app = await launch(detectZh, { seed: false, env: { LANG: 'zh_TW.UTF-8', LANGUAGE: 'zh_TW:zh' } })
  check(results, '首次啟動採用作業系統的偏好語言',
    (await app.client.evaluate(railHeading('zh-TW'))) === copyIn('zh-TW', 'rail.heading'),
    String(await app.client.evaluate(railHeading('zh-TW'))))
  await app.close()

  const detectEn = mkTemp('spekterm-detect-en-')
  app = await launch(detectEn, { seed: false, env: { LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en' } })
  check(results, '作業系統的偏好語言為英文時以英文啟動',
    (await app.client.evaluate(railHeadingText)) === copy('rail.heading'),
    String(await app.client.evaluate(railHeadingText)))
  await app.close()

  // **既有偏好不因升級而改變語言。** 判準是「偏好檔存不存在」而不是「語言欄位有沒有設定」
  // —— 以後者為判準的話，既有使用者升級之後 app 會自己變成他作業系統的語言。
  const legacyProfile = mkTemp('spekterm-legacy-prefs-')
  writeFileSync(join(legacyProfile, 'preferences.json'),
    JSON.stringify({ version: 1, terminal: { fontSize: 15 } }))
  app = await launch(legacyProfile, { seed: false, env: { LANG: 'zh_TW.UTF-8', LANGUAGE: 'zh_TW:zh' } })
  check(results, '沒有 ui 區塊的既有偏好檔不觸發偵測',
    (await app.client.evaluate(railHeadingText)) === copy('rail.heading'),
    String(await app.client.evaluate(railHeadingText)))
  check(results, '既有偏好的其餘欄位照常生效',
    (await app.client.evaluate('window.workspace.settings.get()'))?.fontSize === 15,
    JSON.stringify(await app.client.evaluate('window.workspace.settings.get()')))
  await app.close()

  // **偏好被隔離之後也不得觸發偵測。** 隔離是把原檔改名保留，於是那個路徑就不存在了 ——
  // 而「不存在」正是偵測的判準。少了回寫，壞過一次偏好檔的使用者會莫名其妙換了語言。
  const quarantinedProfile = mkTemp('spekterm-quarantined-')
  writeFileSync(join(quarantinedProfile, 'preferences.json'), '{ not json at all')
  app = await launch(quarantinedProfile, { seed: false, env: { LANG: 'zh_TW.UTF-8', LANGUAGE: 'zh_TW:zh' } })
  await app.close()
  app = await launch(quarantinedProfile, { seed: false, env: { LANG: 'zh_TW.UTF-8', LANGUAGE: 'zh_TW:zh' } })
  check(results, '偏好被隔離後的下一次啟動不觸發偵測',
    (await app.client.evaluate(railHeadingText)) === copy('rail.heading'),
    String(await app.client.evaluate(railHeadingText)))
  await app.close()
  app = null

  // ── workspace-folders：設定檔損毀 ────────────────────────────────────────
  console.log('\n設定檔損毀降級')
  const corruptProfile = mkTemp('spekterm-corrupt-')
  writeFileSync(join(corruptProfile, 'workspace.json'), '{ this is not json')
  app = await launch(corruptProfile)
  check(results, '損毀時應用程式仍正常啟動', app.mounted?.ok === true, describeMounted(app.mounted))
  const emptyFolders = await app.client.evaluate('window.workspace.folders.list()')
  check(results, '以空 workspace 啟動', Array.isArray(emptyFolders) && emptyFolders.length === 0,
    Array.isArray(emptyFolders) ? `${emptyFolders.length} 個 folder` : `不是陣列：${JSON.stringify(emptyFolders)}`)
  const kept = readdirSync(corruptProfile).filter((name) => name.includes('workspace.json.corrupt-'))
  check(results, '原檔改名保留而非刪除', kept.length === 1, kept[0] ?? '(無)')
  await app.close()
  app = null

  // ── 捲動的驗收**不在這支探針**（見 `openspec/changes/global-session/tasks.md` 13.4）
  //
  // 這裡曾經有一整段：seed 30 個 folder 讓 rail 溢出、送 `Ctrl+↓`、量選中項目是否落在容器內。
  // **fixture 是好的**（實測 scrollHeight 1258 > clientHeight 680），但**快捷鍵在這支探針的
  // 環境裡始終沒有抵達 handler** —— 診斷斷言顯示按 20 次之後 `aria-current` 仍在第一列，
  // 而 `scrollTop` 卻變成了 578：那個捲動是 `Ctrl+↓` **未被 preventDefault 時瀏覽器的原生
  // 捲動**，不是產品的 `scrollIntoView`。
  //
  // **留著那段等於留一盞測不到自己宣稱在測的東西的綠燈**（「往回捲到 scrollTop 0」在原生捲動
  // 下照樣通過），因此整段移除。正確的載體是 `probe:keyboard` —— 那裡的鍵盤驅動已被 134 條
  // 斷言證明有效 —— 搭配 `Emulation.setDeviceMetricsOverride` 壓矮 viewport，讓既有的 3-repo
  // fixture 就溢出。

  // ── app-update: the update check, against local feeds (probe-workspace-update.mjs) ──
  await runUpdateSections({ results, port: DEBUG_PORT, mkTemp })

  // ── ui-appearance: the theme and the interface zoom (probe-workspace-appearance.mjs) ──
  await runAppearanceSections({ results, port: DEBUG_PORT, mkTemp })

  exitCode = results.every(Boolean) ? 0 : 1
} catch (error) {
  console.error(`\nprobe 失敗：${error.message}`)
  if (app) console.error(app.stderr().slice(0, 600))
} finally {
  if (app) await app.close()
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${exitCode === 0 ? '全部通過' : '有檢查未通過'}（${results.filter(Boolean).length}/${results.length}）`)
process.exit(exitCode)
