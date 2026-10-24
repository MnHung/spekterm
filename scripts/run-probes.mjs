#!/usr/bin/env node
/**
 * 依序跑完全部探針（`npm run test:e2e` 的實作）。
 *
 * 為什麼要有這支：`package.json` 裡每個 `probe:*` 都是 `npm run build && node …`，
 * 全跑一輪等於 build 九次。這支由 `test:e2e` 先 build 一次，之後直接執行探針本體。
 *
 * 兩件事刻意這樣做：
 *
 * - **不 fail fast。** 探針一輪就要十幾分鐘、期間使用者無法操作電腦（真滑鼠事件、真視窗），
 *   付了這個代價就該拿到完整的一張圖，而不是第一支紅了就停。exit code 仍反映整體結果。
 * - **清掉 `electron-vite dev` 洩漏到 shell 的環境變數。** CSP 的 dev／production 切換依
 *   `ELECTRON_RENDERER_URL` 是否存在（見 CLAUDE.md），跑過 `npm run dev` 的 shell 會把它繼承下去，
 *   於是 build 模式的探針拿到 dev 政策而紅 —— 那是環境串擾，不是產品 bug。
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 依成本遞增排列 —— 便宜的先跑完，才輪到跑好幾分鐘的那幾支。
 *
 * 一律經 `run-probe.mjs`，不直接 spawn 探針 —— 螢幕的選擇（虛擬／實體）與軟體 GL 的旗標收在
 * 那一層，這裡若自己 spawn，兩條路徑遲早會不一樣。
 */
const ALL_PROBES = ['native', 'core', 'identity', 'shell', 'workspace', 'files', 'keyboard', 'insights', 'agent-view', 'intake', 'slack', 'remote', 'openspec', 'terminal']

/**
 * `PROBE_LIST=a,b,c` 縮減本輪要跑的探針。
 *
 * **存在的理由是一個具體的衝突，不是一般性的方便**：`probe:identity` 刻意不傳 `--user-data-dir`
 * （它要驗的正是 `app.getPath('userData')` 實際解析出來的路徑），因此它啟動的 app 與**使用者
 * 正在用的 spekterm 共用同一個 userData** —— 兩邊各自落盤 session 清單、後寫的贏。dogfood 期間
 * 跑完整驗收會弄壞使用者手上那一份。
 *
 * 它縮減的是覆蓋範圍，所以**總結必須把這件事講出來**（見下方「本輪只跑了 N/M 支」）——
 * 一個縮減過的輪次與完整輪次長得一樣，就是下一次錯誤推算的來源。
 */
const PROBES = process.env.PROBE_LIST
  ? process.env.PROBE_LIST.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_PROBES

const unknown = PROBES.filter((name) => !ALL_PROBES.includes(name))
if (unknown.length > 0) {
  console.error(`PROBE_LIST 指定了不存在的探針：${unknown.join(', ')}`)
  process.exit(2)
}

const LEAKED_DEV_ENV = [
  'ELECTRON_RENDERER_URL',
  'NODE_ENV_ELECTRON_VITE',
  'ELECTRON_MAJOR_VER',
  'ELECTRON_CLI_ARGS',
  'ELECTRON_EXEC_PATH',
]

const env = { ...process.env }
const cleaned = LEAKED_DEV_ENV.filter((k) => k in env)
cleaned.forEach((k) => delete env[k])

/**
 * **語言環境正規化。**
 *
 * 探針的 profile 會被種入 UI 語言（見 `lib/probe-language.mjs`），但驗證「首次啟動的語言
 * 取自作業系統」的那一段刻意不種 —— 它讀的是 `app.getPreferredSystemLanguages()`，而那個
 * 值的驅動者是 **`LANGUAGE`**，不是 `LANG`（實測：Electron 43，`LANGUAGE` 有值時 `LANG`
 * 只剩 `getSystemLocale()` 在看，連 `--lang` 都蓋不掉它）。
 *
 * 開發機上這兩個變數**可能互相矛盾**（`LANG=zh_TW.UTF-8` 配 `LANGUAGE=zh_TW:zh` 是常態，
 * 而只改其一就會得到與宣稱相反的結果）。在這裡釘成一致的值，讓「完整驗收」與「單支入口」
 * 不會在不同的語言環境下跑同一段 —— 需要另一種語言的段落自己在子行程的 env 裡覆寫。
 */
// `GTK_THEME` in the developer's shell decides System on the virtual display (`ui-appearance`); the seeded profiles
// pin Dark, and the sections that test System set it themselves.
delete env.GTK_THEME
env.LANG = 'en_US.UTF-8'
env.LANGUAGE = 'en_US:en'

// 探針以裸名 `electron` spawn（靠 npm script 把 `node_modules/.bin` 塞進 PATH）。這支 runner
// 可能不是經 npm 起的 —— 自己補上，否則會是一句沒頭沒腦的 `spawn electron ENOENT`。
env.PATH = `${join(root, 'node_modules', '.bin')}:${env.PATH ?? ''}`

// **內部參數**：`test:e2e` 已經在這支之前建置過一次，而 `run-probe.mjs` 預設會自己建置 ——
// 少了這個旗標，一輪完整驗收會建置九次（每支一次）。它與使用者的 `PROBE_SKIP_BUILD` 是
// **兩個不同的旋鈕**：後者的語意是「你自己負責產物是新的」，完整驗收不該有那種責任。
env.SPEKTERM_PROBE_BUILT = '1'

/**
 * 跑一支探針，並取回它的段落摘要（若該支以段落組織）。
 *
 * **「通過」與「完整執行」是兩件事。** 一支探針可以在中途 throw 之後仍然印出一堆綠燈 ——
 * 那些是它 throw 之前跑到的部分。實測過的代價：`probe:terminal` 的 dev 段耗時 771 秒，卻只跑了
 * 10 個段落中的 1 個，而總結上看不出來；那個數字後來被拿去推導最佳化方案，得出與事實相反的結論。
 */
function run(name) {
  const summaryFile = join(tmpdir(), `spekterm-probe-summary-${name}-${process.pid}.json`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/run-probe.mjs', name], {
      cwd: root,
      stdio: 'inherit',
      env: { ...env, PROBE_SUMMARY_FILE: summaryFile },
    })
    child.on('close', (code) => {
      let summary = null
      try {
        summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
        rmSync(summaryFile, { force: true })
      } catch {
        // 沒有段落機制的探針不寫摘要 —— 那不是錯誤，只是資訊少一點。
      }
      resolve({ passed: code === 0, summary })
    })
    child.on('error', (err) => {
      console.error(`\n無法啟動探針：${err.message}`)
      resolve({ passed: false, summary: null })
    })
  })
}

if (cleaned.length > 0) {
  console.log(`[test:e2e] 已清除自 dev 洩漏的環境變數：${cleaned.join(', ')}`)
}

const results = []
for (const name of PROBES) {
  console.log(`\n${'='.repeat(72)}\n[test:e2e] probe:${name}\n${'='.repeat(72)}`)
  const started = Date.now()
  const { passed, summary } = await run(name)
  results.push({ name, passed, summary, seconds: Math.round((Date.now() - started) / 1000) })
}

console.log(`\n${'='.repeat(72)}\n[test:e2e] 總結\n${'='.repeat(72)}`)
for (const r of results) {
  let note
  if (r.summary) {
    const gaps = [
      r.summary.failed.length > 0 ? `${r.summary.failed.length} 段失敗` : null,
      r.summary.skipped.length > 0 ? `${r.summary.skipped.length} 段未執行` : null,
    ].filter(Boolean)
    note = r.summary.complete ? '  完整執行' : `  **不完整：${gaps.join('、')}**`
  } else {
    note = '  （無段落資訊）'
  }
  console.log(`  ${r.passed ? '通過' : '未通過'}  probe:${r.name.padEnd(10)} ${String(r.seconds).padStart(4)}s${note}`)
}

if (PROBES.length !== ALL_PROBES.length) {
  const missing = ALL_PROBES.filter((name) => !PROBES.includes(name))
  console.log(
    `\n⚠ 本輪只跑了 ${PROBES.length}/${ALL_PROBES.length} 支（PROBE_LIST）—— 未跑：${missing.join(', ')}\n` +
      `  這不是一輪完整驗收。`,
  )
}

const incomplete = results.filter((r) => r.summary && !r.summary.complete)
if (incomplete.length > 0) {
  console.log(
    `\n⚠ 有探針未完整執行：${incomplete.map((r) => r.name).join(', ')}\n` +
      `  **這一輪的耗時不得作為最佳化判斷的依據** —— 未執行的段落沒有付出它們的時間。`,
  )
}

const failed = results.filter((r) => !r.passed)
console.log(
  failed.length === 0
    ? `\n全部通過（${results.length}/${results.length}）`
    : `\n有探針未通過（${results.length - failed.length}/${results.length}）：${failed.map((r) => r.name).join(', ')}`,
)
process.exit(failed.length === 0 ? 0 : 1)
