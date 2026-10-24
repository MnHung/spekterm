#!/usr/bin/env node
/**
 * 單支探針的啟動器 —— 決定它畫到哪個螢幕，然後把它跑起來。
 *
 * 為什麼要有這一層：螢幕的選擇（虛擬／實體）與 `xvfb-run` 的存在檢查，對 9 支探針是同一件事。
 * 收在這裡，`package.json` 的每一條 `probe:*` 與 `scripts/run-probes.mjs` 就共用同一份決策 ——
 * 而不是在十個地方各寫一次（其中一個遲早會不一樣）。
 *
 * 探針本身**不需要知道**自己畫在哪個螢幕上：`DISPLAY` 由 `xvfb-run` 設定並被子行程繼承。
 * 它們唯一要問的是 `electronExtraArgs()`（軟體 GL 的旗標），因為那必須進 electron 的 argv。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { withDisplay, useVirtualDisplay } from './lib/display.mjs'
import { portsOf } from './lib/ports.mjs'
import { NO_BUILD, PreflightError, ensureBuildArtifacts, ensurePortsFree } from './lib/preflight.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const name = process.argv[2]

if (!name) {
  console.error('用法：node scripts/run-probe.mjs <探針名稱>')
  process.exit(2)
}

const script = join('scripts', `probe-${name}.mjs`)
if (!existsSync(join(root, script))) {
  console.error(`找不到探針：${script}`)
  process.exit(2)
}

/**
 * 建置：預設做，兩種情況不做。
 *
 * **兩個旋鈕刻意分開，不共用一個環境變數**：
 *
 * - `PROBE_SKIP_BUILD=1` 是**給人用的逃生口** —— 只改探針腳本時，每次多付一次建置是純浪費。
 *   它生效時必須**吵**：跳過建置卻改了產品程式碼，驗到的是舊產物，那是一盞假綠。
 * - `SPEKTERM_PROBE_BUILT` 是 `run-probes.mjs` 用的**內部參數** —— 它自己建置一次之後才對每一支
 *   探針各 spawn 一次本檔案。少了它，完整驗收一輪會建置九次。它不印警告，因為那一輪**確實建過**。
 *
 * 合成一個旋鈕的話，完整驗收就會走上「跳過建置」那條路，而那條路的語意是「你自己負責產物是新的」
 * —— 完整驗收不該有那種責任。
 *
 * 豁免名單（`NO_BUILD`）住在 `lib/preflight.mjs`，因為**產物檢查與跳過建置必須用同一份** ——
 * 兩邊各留一份的話，症狀是「某支探針在產物不存在時依然空轉 30 秒」。
 */
function buildIfNeeded() {
  if (NO_BUILD.has(name)) return
  if (process.env.SPEKTERM_PROBE_BUILT === '1') return

  if (process.env.PROBE_SKIP_BUILD === '1') {
    const candidates = [join(root, 'out', 'main', 'index.js'), join(root, 'out', 'renderer', 'index.html')]
    const stamps = candidates.filter((p) => existsSync(p)).map((p) => statSync(p).mtime)
    const newest = stamps.length > 0 ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : null
    console.warn(`[probe:${name}] PROBE_SKIP_BUILD=1 —— 本輪未重新建置，驗到的是既有產物`)
    console.warn(`[probe:${name}] out/ 最後建置於：${newest ? newest.toISOString() : '(找不到產物)'}`)
    return
  }

  const built = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

buildIfNeeded()

/**
 * 前置條件 —— **放在建置之後**：`PROBE_SKIP_BUILD` 與 `SPEKTERM_PROBE_BUILT` 兩個旁路的語意都是
 * 「你自己負責產物是新的」，而**那兩個旁路正是產物可能不存在的來源**。
 *
 * 失敗時只印訊息、不丟 stack trace（比照上面缺 `xvfb` 的處理）：前置條件不成立是**環境**問題，
 * 一坨堆疊只會把那句可執行的指示淹掉。
 */
try {
  ensureBuildArtifacts(name, { root })
  await ensurePortsFree(portsOf(name), { name })
} catch (error) {
  if (!(error instanceof PreflightError)) throw error
  console.error(error.message)
  process.exit(1)
}

// `probe:native` 自己就是一個 Electron 主行程（它 require node-pty，必須在 Electron 裡跑），
// 不像其餘八支那樣「以 node 執行、再由它 spawn electron」。
const runsAsElectron = name === 'native'
let command
let args
try {
  ;[command, args] = withDisplay(
    runsAsElectron ? join(root, 'node_modules', '.bin', 'electron') : process.execPath,
    [script],
  )
} catch (error) {
  // 缺少 xvfb 是**環境**問題，不是程式的內部錯誤 —— 印可執行的指示，不要丟一坨 stack trace。
  console.error(error.message)
  process.exit(1)
}

if (!useVirtualDisplay()) {
  console.log(`[probe:${name}] PROBE_DISPLAY=physical —— 這一輪會佔用你的螢幕`)
}

// PATH 要含 `node_modules/.bin`：探針以裸名 `electron` spawn（此前靠 npm script 提供），
// 而這支 runner 不保證是經 npm 起的。
const env = {
  ...process.env,
  PATH: `${join(root, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
}
// `GTK_THEME` in the developer's shell decides System on the virtual display (`ui-appearance`); see run-probes.mjs.
delete env.GTK_THEME

const child = spawn(command, args, { cwd: root, stdio: 'inherit', env })
child.on('error', (err) => {
  console.error(`無法啟動探針：${err.message}`)
  process.exit(1)
})
child.on('close', (code) => process.exit(code ?? 1))
