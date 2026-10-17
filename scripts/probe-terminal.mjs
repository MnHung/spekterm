/**
 * `terminal-agent-sessions` 的驗收。
 *
 * 一律透過 CDP 連進真正執行中的 app —— 不在產品程式碼裡塞測試分支，也不為驗收在 UI 上掛
 * `data-*`（分頁以 role/aria 定位）。dev 與 build 兩種模式都跑：前者走 `http://` 的 renderer，
 * 後者走 `file://`。
 *
 * **行程清理是本探針的重點。** pty 的 argv 是 `/bin/sh -l`，**不帶** `--user-data-dir`，
 * 因此收尾的 `pkill -9 -f <profile>` 殺不到它 —— 若 app 沒有自己清乾淨，孤兒 pty 就會留在
 * 行程表上被我們抓到。這正是想要的：孤兒無所遁形。pty 的清點靠注入的 marker（讀
 * `/proc/<pid>/environ`），而非猜 cmdline。
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  check,
  connectToApp,
  dragMouse,
  pollFor,
  pollUntil,
  pressKey,
  retryAction,
  retrySample,
} from './lib/cdp.mjs'
import { menuEvidence } from './lib/menu-evidence.mjs'
import { SHELL_PATH, ptyPids, ptySessionPids } from './lib/pty-pids.mjs'
import { copy, label as ariaLabel, prefixOf } from './lib/copy.mjs'
import { RENDER_PATH_PRELUDE } from './lib/render-path.mjs'
import { sectionConsole } from './lib/instrument.mjs'
import { MOUNTED, awaitMounted, describeMounted } from './lib/mounted.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { quitAndWait } from './lib/quit.mjs'
import { runSections } from './lib/sections.mjs'
import {
  SETTINGS_DIALOG as SETTINGS_DIALOG_SELECTOR,
  awaitApplied,
  clickSelector,
  closeSettings,
  inSettings,
  openSettings,
  pressEscape,
  setField,
  showSection,
} from './lib/settings.mjs'
import { PROBE_PORTS } from './lib/ports.mjs'
import { seedLanguage } from './lib/probe-language.mjs'

const BUILD_PORT = PROBE_PORTS.terminal.build
const DEV_PORT = PROBE_PORTS.terminal.dev

/** 探針固定用 /bin/sh：可預測、無 bash/zsh profile 的雜訊，且處處存在。 */

const results = []
const temps = []

function mkTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function makeFixture() {
  const base = mkTemp('spekterm-terminal-fixture-')
  const repo = join(base, 'repo-a')
  mkdirSync(join(repo, 'openspec'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# repo-a\n')
  // pty 寫檔的觀測落點。**刻意在 repo 之外** —— repo 內有 chokidar 在監看（檔案樹與檢視器），
  // 往那裡寫觀測用的檔案會製造與待測行為無關的事件。
  const out = join(base, 'probe-out')
  mkdirSync(out, { recursive: true })
  return { repo, out }
}

/**
 * `makeFixture()` + 真的 git repo + 兩個 worktree（各帶一個 change）—— **只給 `runWorktree`**。
 *
 * **不併進 `makeFixture()`**：那會污染共用它的其他段落。`runContinuation` 依賴「`add-widget` 是
 * 唯一的 active change」才會自動錨定 → 續寫入口才呈現；worktree 裡多兩個 change 就有三個 active，
 * 自動錨定不觸發、續寫入口不呈現、`realClick(null)` 拋錯（實測踩過，症狀是那一段莫名崩掉）。
 *
 * 工作目錄的列舉走 core，它對非 git 目錄回**空陣列** —— 於是這個 fixture 必須是真 git repo，
 * 否則「在 worktree 開 session」一條都驗不到。比照 `probe-openspec.mjs` 的 `makeWorktreeFixture()`。
 */
function makeWorktreeFixture() {
  const { repo, out } = makeFixture()
  const base = dirname(repo)

  const git = (args, cwd) =>
    execFileSync(
      'git',
      ['-c', 'user.email=probe@spekterm', '-c', 'user.name=probe', '-c', 'color.ui=false', ...args],
      { cwd, stdio: 'pipe' },
    )
  git(['init', '-q', '--initial-branch=master', '.'], repo)
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'init'], repo)

  // 邊界**內**與邊界**外**各一個 —— 後者是本 change 的重點（放寬前它必定被夾制掉）。
  const inside = join(repo, '.claude/worktrees/wt-inside')
  const outside = join(base, 'wt-outside')
  git(['worktree', 'add', '-q', '-b', 'feat-inside', '.claude/worktrees/wt-inside'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-outside', outside], repo)

  // 各放一個 change —— **識別碼要向產品要**（change 的來源徽章帶著它），探針不自己算 sha1：
  // 那會是一份平行實作，core 換演算法時它會靜默地與產品分歧，而斷言照樣全綠（兩邊各用各的）。
  for (const [dir, slug] of [[inside, 'inside-change'], [outside, 'outside-change']]) {
    mkdirSync(join(dir, 'openspec/changes', slug), { recursive: true })
    writeFileSync(join(dir, 'openspec/changes', slug, 'proposal.md'), `# ${slug}\n`)
  }

  return { repo, out, inside, outside }
}

/**
 * 等 pty 寫出的檔案出現並滿足條件，回傳其內容（逾時則回最後讀到的）。
 *
 * **這是比「讀終端畫面」更強的判準，不只是「webgl 之後畫面讀不到」的替代品。**
 * tty 會回顯輸入行 —— 於是 `echo OUT_42` 這種命令，畫面上在**執行之前**就已經有 `OUT_42` 了
 * （CLAUDE.md 記著：驗 cols 時因此讀到還沒產生的值，dev 僥倖通過、build 失敗的經典 flaky）。
 * 檔案只有命令**真的執行**才會出現，回顯不會產生它。
 */
async function waitForFile(path, settled = (value) => value.trim().length > 0, timeoutMs = 8000) {
  return pollFor({
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : ''),
    settled,
    timeoutMs,
    interval: 150,
    label: `waitForFile(${basename(path)})`,
  })
}

/**
 * stub `claude` 啟動時**在磁碟上留下的憑據** —— 用來斷言我們驅動的確實是自己這支，
 * 不是本機真的 claude。
 *
 * **刻意不看終端畫面。** 「終端上有沒有出現某行字」對掛載時機、backlog 的 flush、以及捲動都
 * 很敏感（dev 的 StrictMode 還會把元件重掛一次）—— 把「spawn 的是哪一支 claude」這個穩固的
 * 事實綁在那種訊號上，只會換來一支時綠時紅的探針。檔案存不存在，是磁碟上的事實。
 */
const STUB_CLAUDE_RECEIPT = 'stub-claude-ran'

/** stub 回報的模型顯示名 —— 狀態列上出現它，就是 payload 端到端走通了。 */
const STUB_MODEL_NAME = 'Stub Model (1M context)'

/**
 * 一支 stub `claude`，供「claude 目標的 session 會採用 pty 宣告的標題」這組驗收使用。
 *
 * **為什麼需要它。** 本 change 之後，OSC 標題只對 `claude` spawn 目標生效 —— 於是這組驗收
 * 的載體必須是 claude 目標的 session。但我們無法叫真的 `claude` 去宣告一個**指定**的標題，
 * 也不能要求每台機器都裝了它（一支在沒有 claude 的機器上宣稱驗過 OSC 標題的探針，是在說謊），
 * 更不該讓一支探針真的去啟動一個 Claude Code session。
 *
 * **它為什麼是真實的產品路徑。** 產品的 claude 模式是 `$SHELL -l -c claude`：從 **PATH** 解析
 * `claude`，而 pty 的 env 整份繼承 Electron 行程的 `process.env`。探針本來就自己 spawn Electron，
 * 因此走的是產品**原本那條**路徑 —— 動的是環境，不是被出貨的那份程式碼。
 *
 * **`HOME` 也必須換掉，否則 stub 會被真的 claude 蓋過去（實測踩過）。** `-l` 是 login shell，
 * 它會 source `~/.profile`，而 Ubuntu 的預設 `~/.profile` 裡有 `PATH="$HOME/.local/bin:$PATH"`
 * —— 那一行會把**真** claude 的目錄搶到我們前面，於是探針真的把一個 Claude Code session 跑了
 * 起來（分頁標籤變成它宣告的任務描述）。把 `HOME` 指向暫存目錄後：那裡沒有 `~/.profile` 可以
 * source；而且 stub 就放在該 HOME 的 `.local/bin` 裡 —— **即使 profile 真的 prepend
 * `$HOME/.local/bin`，它指的也是我們這個目錄**。兩道保險。
 *
 * stub 本身就是一個互動 shell（`exec "$SHELL" -i`）：於是 claude 目標的 session 行為與 shell
 * session 完全相同，既有的 `typeLine(printf '\\033]0;…')` 一個字都不用改就能驅動它宣告標題。
 * `SHELL` 是 `/bin/sh`（見 `SHELL_PATH`），它**不會**自己送 OSC 標題 —— 標籤因此是確定的。
 */
/**
 * `resumeFails`：模擬 `claude --resume <不存在的對話>` —— 實測它印一行 `No conversation found…`
 * 然後 **exit 1**。這不是邊角：**開了 claude session、還沒跟它講話就關掉 app，claude 根本不寫
 * transcript**，於是重建時的續接必然失敗。自癒是主線路徑，必須驗得到。
 *
 * stub 同時把每次被呼叫的 argv 記進 `calls()` —— 續接（`--resume <id>`）與新建（`--session-id <id>`）
 * 用的是哪個旗標、哪個 id，只有這樣才驗得出來。
 */
/**
 * 自 stub 記下的一行 argv，取出「這次是新建還是續接、對話識別碼是什麼」。
 *
 * **不要用位置去切。** `claude-status-bridge` 起，spawn 出來的命令前面多了一段
 * `--settings <路徑>`（狀態橋接的注入）—— 寫死 `split(' ')[1]` 取到的會是那個路徑，
 * 而錨定開頭的 `/^--session-id …$/` 則整條對不上。這裡改為在整串裡找旗標，
 * 於是日後再多注入什麼旗標，這些斷言都不必跟著改。
 */
function conversationOf(argv) {
  const match = /--(session-id|resume) ([0-9a-f-]{36})(?:\s|$)/.exec(argv ?? '')
  return match ? { mode: match[1], id: match[2] } : null
}

function makeStubClaude({ resumeFails = false, honorSettings = false, logInput = false, screenMarker = false } = {}) {
  const home = mkTemp('spekterm-terminal-stubhome-')
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })

  const receipt = join(home, STUB_CLAUDE_RECEIPT)
  const callLog = join(home, 'claude-calls.log')
  const claude = join(bin, 'claude')

  // stub 若要驗證狀態橋接，就得**照著我們注入的設定真的跑一次 statusLine** —— 只斷言
  // 「argv 裡有 --settings」證明不了那個命令能用（落點對不對、寫得成不成、env 有沒有到）。
  // JSON 用 node 解（命令字串裡有跳脫的雙引號，用 sh 解會很痛）；payload 是一份仿造的
  // claude 狀態，形狀取自實測（見 agent-status.ts）。
  const payload = join(home, 'payload.json')
  writeFileSync(
    payload,
    JSON.stringify({
      model: { id: 'claude-stub[1m]', display_name: STUB_MODEL_NAME },
      effort: { level: 'high' },
      thinking: { enabled: true },
      context_window: { context_window_size: 1_000_000, total_input_tokens: 250_000 },
      cost: { total_cost_usd: 1.25, total_lines_added: 12, total_lines_removed: 3 },
    }),
  )

  const honor = [
    'settings=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--settings" ]; then settings="$a"; fi; prev="$a"; done',
    'if [ -n "$settings" ]; then',
    `  cmd=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).statusLine.command)' "$settings")`,
    `  cat "${payload}" | sh -c "$cmd" >/dev/null 2>&1`,
    'fi',
  ].join('\n')

  // **把 pty 收到的輸入落盤** —— 供「側欄送出的指示真的抵達且真的送出了」那組驗收。
  // 讀檔是 A 類管道：它能區分**回顯與執行**，而讀畫面本來就分不清（tty 會回顯輸入行）。
  // 這裡更直接 —— 落下來的是 pty 的輸入串流本身，`\r` 有沒有跟著送出一目了然。
  const inputLog = join(home, 'claude-input.log')

  const lines = [
    '#!/bin/sh',
    `: > "${receipt}"`,
    `echo "$@" >> "${callLog}"`,
        honorSettings ? honor : '',
    // `screenMarker`: print `STUB-SCREEN-<conversation id>` on every start, `--resume` included — as
    // the real CLI redraws its conversation on resume. Without it, "the conversation is shown once
    // after waking" cannot tell a correct view (remounted, empty) from one that kept the old screen.
    screenMarker ? `echo "STUB-SCREEN-$(echo "$@" | grep -o '[0-9a-f-]\\{36\\}' | head -1)"` : '',
    // **旗標要掃過整個 `"$@"`，不能看 `$1`。** 這裡一度寫成 `[ "$1" = "--resume" ]`，而
    // `claude-status-bridge` 起，命令前面多了一段 `--settings <路徑>` —— `$1` 從此恆為
    // `--settings`，**這支 stub 於是完全不再模擬續接失敗**：自癒沒有被觸發，第三次呼叫不存在，
    // 「自癒」與其後「被竄改的識別碼」兩組斷言一起倒。失效方向是最壞的那種 —— stub 看起來
    // 一切正常（它就退化成一個普通的互動 shell），紅的卻是產品那邊的斷言。
    resumeFails
      ? [
          'resume=""; prev=""',
          'for a in "$@"; do if [ "$prev" = "--resume" ]; then resume="$a"; fi; prev="$a"; done',
          'if [ -n "$resume" ]; then echo "No conversation found with session ID: $resume"; exit 1; fi',
        ].join('\n')
      : '',
    // **`logInput` 不接互動 shell，只留一個 `cat`。**
    //
    // 這裡原本是 `exec sh -c 'tee -a log | "$SHELL" -i'` —— 而那個 `sh -i` 的 stdin 是**管線
    // 而不是 tty**，它撐不住：實測 stub 在數秒內就結束，session 隨即變成「已結束」。於是這一段
    // 一直是一場**競態** —— 點擊趕在 stub 死掉之前就綠、趕不上就紅（實測基準 2/4，dev 與 build
    // 兩模式皆然，並非 dev 特有）。而症狀是「指示沒抵達 pty」，看起來像產品的續寫壞了。
    //
    // 這一段要驗的只有「指示抵達 pty，且帶著 Enter」—— 那不需要一個能執行命令的 shell，只需要
    // 一個**讀 pty、寫檔、而且不會自己結束**的行程。`cat` 正是它，且它由 pty 直接持有 tty。
    // （pty 預設是 canonical 模式且 ICRNL，於是送出的 `\r` 落到檔案裡是 `\n` —— 兩者本就都收。）
    logInput ? `exec cat >> "${inputLog}"` : 'exec "$SHELL" -i',
  ].filter(Boolean)

  writeFileSync(claude, `${lines.join('\n')}\n`)
  chmodSync(claude, 0o755)

  return {
    home,
    bin,
    receipt,
    inputLog,
    calls: () => {
      try {
        return readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
  }
}

function seedProfile(folders) {
  const profile = mkTemp('spekterm-terminal-profile-')
  writeFileSync(
    join(profile, 'workspace.json'),
    JSON.stringify({
      version: 1,
      folders: folders.map(([id, path]) => ({ id, path, addedAt: '2026-07-11T00:00:00.000Z' })),
    }),
  )
  return profile
}

// ── pty 行程的清點 ──────────────────────────────────────────────────────────
//
// `ptyPids` / `ptySessionPids` 已抽到 `lib/pty-pids.mjs`（`probe-intake` 也要用）。
// **兩者的差別是一條實測結論，不是風格**：一個 claude session 是兩個帶 marker 的行程。


/** 診斷用：帶 marker 的 pty 行程完整命令列。斷言失敗時，光看數字看不出是誰。 */
function ptyCmdlines(marker) {
  return ptyPids(marker).map((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
    } catch {
      return `pid ${pid}（已結束）`
    }
  })
}

async function waitForPtyCount(marker, expected, timeoutMs = 8000) {
  return pollFor({
    read: () => ptyPids(marker),
    settled: (pids) => pids.length === expected,
    timeoutMs,
    interval: 150,
    label: `waitForPtyCount(期待 ${expected} 個 pty)`,
  })
}

// ── app 啟動 ────────────────────────────────────────────────────────────────

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (text) => text.replace(ANSI_PATTERN, '')

/** 見 probe-files.mjs 的同名函式：自己 spawn electron，才控制得了 argv 與收尾。 */
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

async function launch({ port, profileDir, rendererUrl, marker, stub }) {
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
        // pty 自主行程繼承 env：SHELL 決定 spawn 什麼，marker 讓我們清點得出它的行程。
        SHELL: SHELL_PATH,
        SPEK_PROBE_MARKER: marker,
        // claude 模式是 `$SHELL -l -c claude` —— 從 PATH 解析。前置放著 stub `claude` 的目錄，
        // 並把 HOME 一起換掉（否則 `~/.profile` 會把真 claude 搶回前面 —— 見 `makeStubClaude`）。
        HOME: stub.home,
        PATH: `${stub.bin}:${process.env.PATH}`,
        ...(rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl } : {}),
      },
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
    /**
     * 正常關閉（SIGTERM）：要驗的正是 app 自己會不會把 pty 清乾淨。
     *
     * **等到主行程確實結束才返回。** 送出訊號就返回會讓呼叫端接下來的動作與主行程的收尾
     * 競態 —— 而收尾正是它寫 `sessions.json` 的時候（原子寫：暫存檔 ＋ rename）。issue #8：
     * 那次 rename 若落在探針寫入損毀內容之後，損毀內容就被蓋掉，於是該段驗到的是「正常
     * 啟動」而不是它宣稱在驗的「損毀降級」。
     *
     * **順帶修正了一條斷言的前提**：「關閉視窗終止其所有 pty（不留孤兒行程）」此前是在
     * 主行程**可能還活著**的時候就開始數 pty 的。
     */
    async quitGracefully() {
      client.close()
      return quitAndWait(child)
    },
    /** Send a signal without waiting — the close confirmation's "signal during an open dialog". */
    signal(name) {
      child.kill(name)
    },
    /** Wait for the app to exit by itself (no signal sent). Resolves `true` when it did in time. */
    async waitForExit(timeoutMs = 10_000) {
      if (child.exitCode !== null || child.signalCode !== null) return true
      const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
      // An event wait, not a poll — the same reasoning as `quitAndWait`.
      return Promise.race([exited, sleep(timeoutMs, false)])
    },
    /** 收尾：連根拔除 electron 樹。pty 若還在，是 app 的漏網之魚，不是這裡的責任。 */
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
        // 找不到符合的行程 —— 正是我們要的結果。
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

const TABS = `[...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')].map((tab) => ({
  label: tab.innerText.replace(/\\s+/g, ' ').trim(),
  selected: tab.getAttribute('aria-selected') === 'true',
  exited: tab.innerText.includes('${copy('sessions.exitedBadge')}'),
}))`

/**
 * 一段可嵌進 `evaluate` 的前綴：定義 `hostsOf()` 與 `renderPathOf()`。
 *
 * ## 判準是「這個終端當下走哪一條渲染路徑」，**不是**「它底下有幾個 `<canvas>`」
 *
 * 兩條路徑各有**專屬於該終端、且隨路徑切換而建立與移除**的產物：
 *
 * | 渲染路徑 | 憑據 |
 * |---|---|
 * | 程式化繪製（webgl） | 有 `canvas.xterm-link-layer`、無 `.xterm-rows` |
 * | 倚賴 glyph（DOM） | 有 `.xterm-rows`、無 `canvas.xterm-link-layer` |
 *
 * `xterm-link-layer` 是 webgl renderer 自己建立、自己在 dispose 時移除的 render layer，
 * 帶著穩定的 class。
 *
 * ## 為什麼**不能**數 `<canvas>`（這條判準錯了很久）
 *
 * webgl 只會往 DOM 塞 2 個 canvas（link 層 + renderer 主 canvas），但實測**單一終端就量到 3 個**。
 * 第三顆是 **`TextureAtlas._tmpCanvas`** —— glyph 光柵化用的暫存畫布，**不帶任何 GPU context**，
 * 它為了繼承 `font-feature-settings` 才必須掛進 DOM（xterm 原始碼的註解自己說明了）。
 *
 * 而 **atlas 由 `charAtlasCache` 跨終端共享**（同字型設定的終端共用一份，`ownedBy` 陣列）——
 * 於是那**唯一的一顆**會被 `append()` 搬到「最近一次光柵化 glyph 的那個終端」底下並停在那裡。
 * DOM 節點只有一個 parent，所以總數恆為 3：**它從來沒有多出來過，只是換了個 parent。**
 *
 * 數 canvas ＝ **把一個跨終端共用、會遷移的東西當成 per-terminal 的狀態**。它的失效方式是兩個
 * 方向都錯：資源真的洩漏時它可能沉默（殘留落在顯示中的終端上就看不見），一切正常時它卻會間歇地
 * 報錯（切換後顯示中的終端若未再光柵化新字元，`_tmpCanvas` 就停在隱藏的那個底下不動）——
 * 而後者誘使人把它當成 flaky 而忽略它。實測正是如此：真實螢幕 1/4 紅、虛擬螢幕 4/5 紅。
 *
 * **也不要改成「數 canvas 但排除 `_tmpCanvas`」**（例如以尺寸或 `display:none` 過濾）——
 * 那是把判準綁在 xterm 的內部實作細節上，且它會**靜默地**隨 xterm 版本失效。
 */

/** rail 的 session 子列（第 n 個，自 0 起）。 */
const RAIL_SESSION_RECT = (index) => `(() => {
  const rows = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] ul[aria-label^="${prefixOf('rail.folderSessions')}"] li > div[role="button"]')]
  const row = rows[${index}]
  if (!row) return null
  const r = row.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/** rail 上展開／收合 session 子列的 caret。 */
/**
 * 展開／收合 session 子列的箭頭鈕。
 *
 * **它的 aria-label 隨狀態而異，而英文把變數放在句尾**（Expand sessions in <name>）—— 沒有
 * 共同的固定後綴可用，只能兩個前綴都試。中文版的兩個標籤都以「的 session」結尾，一個後綴
 * 選擇器就通吃 —— 那是語言的巧合，不是可以沿用的結構。
 */
const RAIL_CARET_RECT = `(() => {
  const btn = document.querySelector(
    'aside[aria-label="${copy('rail.label')}"] button[aria-label^="${prefixOf('rail.expandSessions')}"], ' +
    'aside[aria-label="${copy('rail.label')}"] button[aria-label^="${prefixOf('rail.collapseSessions')}"]'
  )
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

const RAIL_SESSION_COUNT = `document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] ul[aria-label^="${prefixOf('rail.folderSessions')}"] li').length`

/**
 * rail 上 **folder** 列的「＋」建立入口（hover 才顯示，但 opacity 不影響 rect 與點擊）。
 *
 * **必須排除全域項目那一顆。** rail 的第一列是 `global-session` 的全域項目，它也有一顆同前綴的
 * 建立入口 —— `querySelector` 取第一個匹配，於是不排除的話這裡拿到的是**它**，而所有以為自己
 * 在 folder 上建 session 的斷言都會靜默地建到全域項目底下（症狀是「folder 的 session 數沒變」，
 * 看起來像建立功能壞了）。
 */
const RAIL_NEW_SESSION_RECT = `(() => {
  const all = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] [aria-label^="${prefixOf('rail.newSessionIn')}"]')]
  const btn = all.find((b) => b.getAttribute('aria-label') !== ${JSON.stringify(copy('rail.newSessionIn', { name: copy('rail.globalName') }))})
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/** rail 上第 n 個 session 子列的關閉鈕。 */
const RAIL_CLOSE_SESSION_RECT = (index) => `(() => {
  const rows = [...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] ul[aria-label^="${prefixOf('rail.folderSessions')}"] li')]
  const btn = rows[${index}]?.querySelector('[aria-label^="${prefixOf('sessions.closeSession')}"]')
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/**
 * 主舞台的「+ session」與最後一個分頁之間的水平間距。
 *
 * 先前它被 flex 推到分頁列的另一端（間距數百 px），開第二個分頁後滑鼠得橫越整條列。
 */
/** 選單項是否為停用狀態（無選取內容時的「複製」）。 */
const MENU_ITEM_DISABLED = (label) => `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const item = [...menu.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(label)}))
  return item ? item.disabled : null
})()`

const CLIPBOARD_WRITE = (text) =>
  `window.workspace.clipboard.writeText(${JSON.stringify(text)})`
const CLIPBOARD_READ = `window.workspace.clipboard.readText()`

/** 第 n 個分頁的 rect（用於真右鍵與拖曳）。 */
const TAB_RECT = (index) => `(() => {
  const tabs = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
  const tab = tabs[${index}]
  if (!tab) return null
  const r = tab.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/**
 * 第 n 個分頁**實際生效**的游標。
 *
 * 分頁是「可點擊也可拖曳」的項目 —— 靜止時必須是 `pointer`（點一下會切換 focused session，
 * 那是它主要的可供性），只有拖曳進行中才是 `grabbing`。
 */
const TAB_CURSOR = (index) => `(() => {
  const tabs = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
  const tab = tabs[${index}]
  return tab ? getComputedStyle(tab).cursor : null
})()`

/** 分頁的標籤依序。 */
/**
 * 每個分頁的 tooltip（`<完整標題> — <狀態>`）與狀態燈的實際顏色。
 *
 * **休眠不是結束。** `session-badge` 原本只認得 running／exited —— 於是每個重建出來的休眠
 * session 都亮**紅燈**、tooltip 說它「已結束（代碼 0）」。那是使用者重開 app 之後看到的第一個
 * 畫面，等於在告訴他「你的 session 都死了」（違反「休眠狀態 SHALL 被明確地呈現」）。
 */
const TAB_STATUS = `[...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')].map((tab) => {
  const dot = tab.querySelector('span[aria-hidden="true"]')
  return {
    title: tab.getAttribute('title') ?? '',
    dot: dot ? getComputedStyle(dot).backgroundColor : null,
  }
})`

/** danger 的實際色值（用來斷言休眠**不是**這個顏色）。 */
const DANGER_COLOR = `(() => {
  const probe = document.createElement('span')
  probe.className = 'bg-danger'
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  return color
})()`

const TAB_LABELS = `[...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
  .map((tab) => tab.innerText.replace(/\\s+/g, ' ').trim())`

/** rail 子列的標籤依序（去掉尾巴的 ✕）。 */
const RAIL_LABELS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] ul[aria-label^="${prefixOf('rail.folderSessions')}"] li')]
  .map((li) => li.innerText.replace(/✕/g, '').replace(/\\s+/g, ' ').trim())`

/** 重新命名對話框的輸入框。 */
const RENAME_INPUT_RECT = `(() => {
  const el = document.querySelector('[aria-label="${copy('sessions.nameLabel')}"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/**
 * **有任何對話框開著嗎？**
 *
 * 命名權的斷言（「pty 改名不打斷使用者」）是**否定**的，因此它必須問一個**開放**的問題：畫面上
 * 有沒有**任何**對話框。若改問「那個確認對話框在不在」，它就綁死在一個特定元件的 `aria-label`
 * 上 —— 而該元件已於 session-title-authority 刪除，那種寫法會恆為 false，成為一盞測不到自己
 * 宣稱在測的東西的綠燈。
 */
const ANY_DIALOG_OPEN = `Boolean(document.querySelector('[role="dialog"]'))`

const NEW_BUTTON_GAP = `(() => {
  const tabs = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
  const last = tabs[tabs.length - 1]
  const plus = document.querySelector('[aria-label="${copy('sessions.new')}"]')
  if (!last || !plus) return null
  return Math.round(plus.getBoundingClientRect().left - last.getBoundingClientRect().right)
})()`

const RECT_OF = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/** 選單項以文字定位，回傳其 rect —— 由探針送真滑鼠事件過去，不用 .click()。 */
const MENU_ITEM_RECT = (label) => `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const item = [...menu.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(label)}))
  if (!item) return null
  const r = item.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

const MENU_IN_VIEWPORT = `(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const r = menu.getBoundingClientRect()
  return {
    inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    vw: window.innerWidth,
    vh: window.innerHeight,
  }
})()`

/**
 * **`TERMINAL_TEXT` 已移除（本 change）—— 本檔不再從 DOM 讀終端內容。**
 *
 * 它讀 `.xterm-rows` 的 `innerText`，而那個元素只存在於 DOM renderer —— GPU renderer 把畫面
 * 畫進 `<canvas>`，它隨即消失。更糟的是它的**失效方式**：讀不到時回空字串，於是**否定式**斷言
 * （「畫面上**沒有**分隔線」「被攔下的按鍵**沒有**流進 pty」）會在瞎掉的情況下**繼續發綠燈**。
 *
 * 兩條替代管道，且**都比它強**：
 *
 * - **pty 行為** → **讀檔**（`waitForFile`）：能區分**回顯與執行**，而讀畫面文字本來就分不清。
 * - **畫面內容** → **產品自己的複製路徑**（`readTerminalText`）：跨 renderer 不變，且**把折行
 *   接回邏輯行**，於是 `includes()` 不會在折點斷開（讀 `.xterm-rows` 會）。
 */

/**
 * **`TERMINAL_FONT` 已移除（本 change）—— 那條觀測管道從根本上是錯的。**
 *
 * 它讀 `getComputedStyle('.xterm-rows').fontSize`。GPU renderer 之後 `.xterm-rows` 不存在，
 * 而 DOM 上**沒有任何可替代的字級訊號**（全部實測過）：`.xterm` 與 `.xterm-helper-textarea`
 * 的 computed `fontSize` **恆為瀏覽器預設**（16px／13.3333px）、不跟 `options.fontSize` 走 ——
 * 且它們**剛好接近正確值**，換上去只會得到一條永遠通過的假綠（與 `--text-terminal` 的 `calc()`
 * 陷阱同型：「fallback 剛好等於當時的正確值，畫面上完全看不出來」）。
 *
 * 字級改以 **pty 的 `cols`** 觀測（見 runMode 內的 `readFontCols`）—— 那嚴格更強：它證明字級真的
 * 改變了 pty 的幾何，而不只是「一個 CSS 屬性被設了」。
 */

/** 五級字級 token 求值後的實際 px —— 用來驗「尺度中不存在分不出來的級差」。 */
const TYPE_SCALE = `(() => {
  const resolve = (token) => {
    const el = document.createElement('div')
    el.style.fontSize = 'var(' + token + ')'
    document.body.appendChild(el)
    const px = getComputedStyle(el).fontSize
    el.remove()
    return px
  }
  return {
    '2xs': resolve('--text-2xs'),
    xs: resolve('--text-xs'),
    sm: resolve('--text-sm'),
    base: resolve('--text-base'),
    lg: resolve('--text-lg'),
    terminal: resolve('--text-terminal'),
  }
})()`

const TERMINAL_RECT = RECT_OF(`section[aria-label="${copy('stage.terminal')}"]`)
const NEW_SESSION_RECT = RECT_OF(`[aria-label="${copy('sessions.new')}"]`)
const SEPARATOR_RECT = RECT_OF(`main[aria-label="${copy('stage.label')}"] [role="separator"]`)

const CLOSE_FIRST_TAB = `(() => {
  const btn = document.querySelector('[aria-label^="${prefixOf('sessions.closeSession')}"]')
  if (!btn) return false
  btn.click()
  return true
})()`

const RAIL_SESSION_ROWS = `[...document.querySelectorAll('aside[aria-label="${copy('rail.label')}"] ul[aria-label^="${prefixOf('rail.folderSessions')}"] li')]
  .map((li) => li.innerText.replace(/\\s+/g, ' ').trim())`

// ── 輸入 ────────────────────────────────────────────────────────────────────

const center = (rect) => ({
  x: Math.round(rect.x + rect.width / 2),
  y: Math.round(rect.y + rect.height / 2),
})

/**
 * 送**真的**滑鼠按鍵（trusted event），而非 `element.dispatchEvent(new MouseEvent(...))`。
 *
 * 合成的 contextmenu 不走完整的 pointer/mouse/contextmenu 序列，也不觸發 React 19 對
 * trusted discrete 事件的同步 effect flush —— 用它測選單會漏掉「開啟選單的事件冒泡到
 * window 把自己關掉」這類只在真實輸入下發生的 bug。
 */
async function realMouse(client, x, y, button = 'left') {
  const buttons = button === 'right' ? 2 : button === 'left' ? 1 : 0
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons, clickCount: 1 })
}

async function realClick(client, rect) {
  const at = center(rect)
  await realMouse(client, at.x, at.y, 'left')
}

/**
 * 對某個 session 分頁開啟右鍵選單，並**確認它真的開了**；沒開就重新量測座標再點一次。
 *
 * 「量完就點」是在賭版面不動 —— 而分頁列會動。分頁的標籤會因為 pty 宣告的 OSC 標題、或使用者
 * 自己的改名而改變寬度（一次改名就能讓標籤從一串超長標題縮成 `temp-name`），於是**上一次量到的
 * 座標在幾毫秒內就過期**，點擊落在別的元素上，選單自然開不起來。
 *
 * 症狀是探針在某個看似無關的地方 `TypeError: Cannot read properties of null` —— 因為
 * `MENU_ITEM_RECT(...)` 找不到選單。**不要重用一個量過的 rect 去點第二次。**
 */
async function openTabMenu(client, index) {
  // **預算 8.5 秒的推導**：一輪 ＝ 等選單的 1.5 秒 ＋ 兩輪之間的 0.2 秒；收斂前是固定五輪
  // ⇒ **8.5 秒**（那個 `sleep(200)` 無條件執行、含最後一輪，所以計入是對的）。
  let clicked = null

  const menu = await retryAction({
    act: async () => {
      // **每輪重新量測座標** —— 分頁標籤的寬度會因 pty 宣告的 OSC 標題或使用者改名而改變，
      // 上一次量到的 rect 在幾毫秒內就過期。**不要重用一個量過的 rect 去點第二次。**
      const rect = await client.evaluate(TAB_RECT(index))
      if (!rect) return
      clicked = rect
      const at = center(rect)
      await realMouse(client, at.x, at.y, 'right')
    },
    read: () => client.evaluate(MENU_IN_VIEWPORT),
    settled: (value) => value !== null,
    attemptWindowMs: 1500,
    interval: 200,
    timeoutMs: 8500,
    label: `openTabMenu（分頁 ${index} 的右鍵選單）`,
    evidence: async () => {
      const scene = await menuEvidence(client, { clicked })
      const now = await client.evaluate(TAB_RECT(index))
      // 座標過期是這一處記載的成因，所以現場要能回答「分頁自己有沒有動」。
      const moved = clicked && now ? now.x !== clicked.x || now.width !== clicked.width : null
      return `${scene}；分頁矩形${moved === null ? '取不到' : moved ? '**已改變**' : '未變'}` +
        `（點時 ${JSON.stringify(clicked)} → 現在 ${JSON.stringify(now)}）`
    },
  })

  if (!menu) {
    throw new Error(`分頁 ${index} 的右鍵選單開不起來（重試預算 8.5s 耗盡；座標持續過期或選單溢出 viewport）`)
  }
  return menu
}

/**
 * 送一行指令給終端（xterm 的隱形 textarea → onData → pty）。
 *
 * **Enter 必須是一次真正的按鍵事件。** 實測：把 `\r` 併進 `Input.insertText` 的文字裡，
 * 字元確實送達 pty（終端上看得到回顯），但 shell 從未執行那一行 —— xterm 的換行是在
 * keydown 上判讀的，不是從 textarea 的內容裡剖析出來的。
 */
async function typeLine(client, text) {
  await client.send('Input.insertText', { text })
  await pressEnter(client)
}

/**
 * 走**使用者的路徑**開／關 GPU 加速（開 Settings → 點勾選框；a choice applies at once）。
 *
 * **不可改用 `window.workspace.settings.setGpuAcceleration(...)`** —— 那會繞過
 * `PreferencesProvider`：主行程的 store 更新了，但 renderer 的 state 沒有，於是驅動 renderer 的
 * effect 不會重跑、終端當然不變（既有教訓，`/opsx:verify` 抓過一次，當時一度誤判為產品 bug）。
 */
async function setGpuViaSettings(client, enabled) {
  // Settings applies a choice when it is made (`settings-sections`): click the box only when it has to change,
  // wait for the applied state to come back, then close.
  await openSettings(client, 'terminal')
  const box = inSettings(`input${ariaLabel('settings.gpuAcceleration')}`)
  const checked = await client.evaluate(`document.querySelector(${JSON.stringify(box)})?.checked ?? null`)
  if (checked === null) throw new Error('設定對話框裡找不到 GPU 加速的勾選框')
  if (checked !== enabled) await clickSelector(client, box, 'the GPU acceleration box')
  await awaitApplied(
    client,
    'window.workspace.settings.get().then((p) => p.gpuAcceleration !== false)',
    (value) => value === enabled,
    `GPU acceleration applied as ${enabled}`,
  )
  await closeSettings(client)
}

/**
 * 經**設定對話框**設定終端字型大小 —— 走的是使用者真正的路徑：輸入後按 Enter 即套用（no Save).
 * `size` 傳空字串＝清除偏好（回到字級尺度的預設）。
 */
async function setFontSizeViaSettings(client, size) {
  await openSettings(client, 'terminal')
  await setField(client, 'settings.fontSize', size)
  const expected = size === '' ? null : Number(size)
  await awaitApplied(
    client,
    'window.workspace.settings.get().then((p) => p.fontSize ?? null)',
    (value) => value === expected,
    `font size applied as ${expected}`,
  )
  await closeSettings(client)
}

/**
 * 送一個真的 `Ctrl+C` 給終端 —— 用來清掉輸入行上的殘留。
 *
 * mouse reporting 開啟期間，一次點擊會被 xterm 轉成滑鼠序列送進 pty，那些位元組會落在 shell 的
 * 輸入行上變成垃圾；不清掉的話，下一個 `typeLine` 會被接在它後面而執行失敗。
 *
 * `rawKeyDown` + `text: '\\x03'`：Ctrl+C 要真的抵達 pty（產品刻意不攔它 —— 它必須維持中斷訊號）。
 */
async function pressCtrlC(client) {
  const key = {
    key: 'c',
    code: 'KeyC',
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
    modifiers: 2, // Ctrl
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\x03' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * `Ctrl+D`＝EOF。**用它而不是 `Ctrl+C` 來收掉一個把 stdout 導向檔案的程式。**
 *
 * stdout 是檔案時 stdio 是**全緩衝**的：`Ctrl+C` 讓它非正常結束，那幾十個位元組就跟著緩衝一起
 * 消失，檔案是空的 —— 而「檔案是空的」正好等於我們想斷言的結論。實測踩過：以 `Ctrl+C` 收尾時，
 * **缺陷還在的舊程式碼下那條斷言照樣綠**。EOF 讓它正常結束並 flush。
 */
async function pressCtrlD(client) {
  const key = {
    key: 'd',
    code: 'KeyD',
    windowsVirtualKeyCode: 68,
    nativeVirtualKeyCode: 68,
    modifiers: 2, // Ctrl
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\x04' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/** Enter 必須是一次真的按鍵事件（見 `typeLine` 的註解）。對話框的送出也走這裡。 */
async function pressEnter(client) {
  const key = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * The displayed dormant session's Wake button (session-hibernation). Displaying a dormant session no
 * longer starts it, so every section that used to rely on "select it and it wakes" goes through this.
 * Located by its dictionary text inside the terminal stage and required to have a box (hidden
 * sessions' views are mounted too).
 */
const WAKE_RECT = `(() => {
  const stage = document.querySelector('section[aria-label="${copy('stage.terminal')}"]')
  const button = [...(stage?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent === ${JSON.stringify(copy('sessions.wake'))} && candidate.getBoundingClientRect().width > 0,
  )
  if (!button) return null
  const r = button.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/** Whether the focused element is a Wake button. */
const WAKE_FOCUSED = `document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent === ${JSON.stringify(copy('sessions.wake'))}`

/** Click the displayed dormant session's Wake button (waits for it to appear). */
async function clickWake(client) {
  const rect = await pollUntil(client, WAKE_RECT, (value) => value !== null, 8000)
  if (!rect) throw new Error('no Wake button on the displayed session')
  await realClick(client, rect)
}

/** `Ctrl+Tab` / `Ctrl+Shift+Tab` — the next / previous session of the selected rail item. */
async function pressCtrlTab(client, shift = false) {
  const key = {
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
    modifiers: shift ? 10 : 2,
  }
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * **顯示中終端的文字區**（`.xterm-screen`）—— 選取的準心。
 *
 * **不是 `TERMINAL_RECT`**：那量的是整個 `section`（含分頁列），從它的角落起拖會落在分頁上。
 * `.xterm-screen` 在 DOM 與 GPU 兩種 renderer 下都存在（實測）。
 */
const SCREEN_RECT = `(() => {
  const host = [...document.querySelectorAll('section[aria-label="${copy('stage.terminal')}"] > div')]
    .find((d) => !d.classList.contains('hidden'))
  if (!host) throw new Error('SCREEN_RECT: 找不到顯示中的終端容器')
  const el = host.querySelector('.xterm-screen')
  if (!el) throw new Error('SCREEN_RECT: 終端容器在，但找不到 .xterm-screen')
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`

/**
 * 讀終端上**看得見的**內容 —— 走**產品自己的複製路徑**：拖曳選取 → 右鍵選單的複製 →
 * 讀系統剪貼簿。
 *
 * **為什麼不直接讀 DOM。** `.xterm-rows` 只存在於 DOM renderer；GPU renderer 把畫面畫進
 * `<canvas>`，那個元素隨即消失。而 xterm 的**選取讀的是 buffer、不是 DOM** —— 於是這條管道
 * **跨 renderer 不變**（lab 實測：兩種 renderer 的拖曳結果逐字元相同）。
 *
 * ## 拖曳的方向是**反過來**的，而那不是講究，是必要的（實測，代價慘痛）
 *
 * **終端的左緣正好是 resizable panel 的分界器。** 從 `.xterm-screen` 的左上角起拖，抓到的是
 * **分界器**而不是文字 —— 於是：
 *
 * 1. 選取是空的（拖的根本不是終端）
 * 2. **而且側欄被拉開、終端被擠到視窗右側** —— **版面永久損毀**，其後每一個用舊座標的操作
 *    全部落空。實測：終端從 `x=322 w=607` 變成 `x=920 w=357`，而**一次錯誤的拖曳就讓後面
 *    六個對照變體全部誤報失敗**（我因此追錯了好幾輪 —— 那些「失敗」全是同一次錯誤的殘影）。
 *
 * 因此：**起點在右下角（元素內 3px），終點在左上角（第 0 格內）** —— 按下的點永遠不碰分界器。
 *
 * ## 座標的兩條實測規則
 *
 * - **按下的點必須落在元素內**：落在外面（哪怕 6px）＝ 完全選不到（mousedown 沒打到 xterm）。
 * - **兩端都要落在「該格的前半」**：xterm 把座標**四捨五入到最近的 cell 邊界**（cellW ≈ 9.6，
 *   過半就算下一格）。終點用 `+2` 才會落在第 0 格；用 `+10`（既有那條複製斷言的作法）會
 *   **切掉首行的第一個字元**，而超出左緣（`-12`）反而也會切掉它。
 *
 * ## 它與 `.xterm-rows` 不是「相等」，而是**更正確**
 *
 * 兩者**內容相同**（實測：抽掉空白後 681 字元 vs 681 字元，逐字元相同），差別只在**折行**：
 * `.xterm-rows` 的 `innerText` 給的是**視覺列** —— 一個超過終端寬度的邏輯行會被截成多列；
 * 而 `getSelection()` 把折行**接回來**，給的是**邏輯行**（實測同一畫面：15 邏輯行 vs 22 視覺列）。
 *
 * **於是 `includes()` 這種判準在剪貼簿上比在 `.xterm-rows` 上更可靠**：長路徑或長命令被折行時，
 * 讀 `.xterm-rows` 會在折點斷開而找不到（探針的 fixture 路徑動輒七、八十字元，這一點都不理論）。
 */
/**
 * 輪詢終端內容（走複製路徑）直到滿足條件。
 *
 * `pollUntil` 吃的是 expression，而複製路徑是一串真滑鼠操作 —— 因此自成一個輪詢。
 * 每一輪是一次「拖曳 + 複製」（約 0.5 秒），刻意把間隔放寬。
 */
async function pollTerminalText(client, settled, timeoutMs = 10_000) {
  // **輪詢中的「選不到東西」是「還沒好」，不是「管道壞了」** —— 終端在重播完成之前是空的，
  // 而空的終端沒有東西可選。但**逾時之後仍讀不到，就是真的壞了**：那時要把哨兵的錯誤丟出去，
  // 不可以默默回空字串。`tolerateErrors` 承載的正是這個語意（每次成功讀取即清掉上一個例外，
  // 只有最後一次仍失敗才拋）。
  //
  // **`readTerminalText` 自己現在也會重試，所以這裡是第二道。** 保留它是刻意的：移除等於把語意
  // 押在「內層永遠會容忍」這個**沒有守衛的假設**上，而那個假設一旦被誰改掉，這裡會靜默地變回
  // 「一次失手就中斷整支」。
  return pollFor({
    read: () => readTerminalText(client),
    settled,
    timeoutMs,
    interval: 400,
    label: 'pollTerminalText（讀終端內容）',
    tolerateErrors: true,
  })
}

/**
 * 讀終端畫面上的文字 —— **失手就再試一次**。
 *
 * ## 為什麼重試在這裡，不在呼叫端
 *
 * 這個讀取在拖曳選不到時**刻意拋錯**（見 `attemptReadTerminalText` 末尾），而那道防護是對的：
 * 把「讀不到」當成「畫面上沒有東西」，會讓否定式斷言在探針瞎掉的情況下繼續發綠燈。問題一直在
 * 呼叫端 —— 六個站點三種姿態（一個容忍、三個裸呼叫、其餘不容忍），於是**一次偶發的失手就讓
 * 整支探針從那裡死掉**，代價一輪十幾分鐘，而症狀看起來像被測的功能壞了（issue #6）。
 *
 * 收進這裡之後，六個站點一處都不必改。
 *
 * ## 兩件事是刻意的
 *
 * - **第一次嘗試不做任何重置** —— 它與此前的行為逐字相同。重置只發生在重試之前，於是這個改動
 *   在「沒有失手」的路徑上是零影響（斷言數與行為都不動）。
 * - **窗口取小**（外層 `pollTerminalText` 是 10 秒）。一次擷取約 0.5–1 秒，內層若也取十秒，
 *   兩層相乘會把一次失手的代價從「多半秒」放大成「多十秒」。
 */
async function readTerminalText(client) {
  let attempt = 0
  return retrySample(
    async () => {
      // **重試前要把畫面收回原狀。** 失敗時右鍵選單很可能還開著，下一次嘗試的拖曳就從一個蓋著
      // 選單的畫面開始 —— 那會讓重試**必然失敗**，而一個必然失敗的重試比不重試更糟（它把一次
      // 乾脆的失敗換成三次一樣的失敗，還多花了時間）。
      if (attempt++ > 0) {
        await pressKey(client, 'Escape')
        await pollUntil(client, MENU_IN_VIEWPORT, (value) => value === null, 1000)
      }
      return attemptReadTerminalText(client)
    },
    { timeoutMs: 3000, label: 'readTerminalText（拖曳擷取，失手即重試）' },
  )
}

/** 一次拖曳擷取。**讀不到就拋** —— 那是哨兵，不是失誤。 */
async function attemptReadTerminalText(client) {
  const r = await client.evaluate(SCREEN_RECT)
  // 先污染剪貼簿 —— 否則「讀到上一次的內容」會被誤當成這一次複製成功。
  await client.evaluate(CLIPBOARD_WRITE('__not-copied__'))

  // **反向拖曳**（見上方說明）：右下角（元素內）→ 左上角（第 0 格內）。
  await dragMouse(
    client,
    { x: Math.round(r.x + r.width) - 3, y: Math.round(r.y + r.height) - 3 },
    { x: Math.round(r.x) + 2, y: Math.round(r.y) + 2 },
  )
  await sleep(200)

  // 診斷用：選取到底成立了沒 —— 右鍵選單的「複製」在沒有選取時是停用的。
  const centre = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  await realMouse(client, centre.x, centre.y, 'right')
  const menu = await pollUntil(client, MENU_IN_VIEWPORT, (value) => value !== null, 4000)
  const copyDisabled = await client.evaluate(MENU_ITEM_DISABLED(copy('sessions.copy')))
  const copyRect = await client.evaluate(MENU_ITEM_RECT(copy('sessions.copy')))
  // **這一步以前會拋 `TypeError`。** `copyRect` 為 null 時 `realClick` 會去讀 `null.x`，於是浮上來
  // 的是一句與現場無關的型別錯誤，而不是下面那個帶診斷的哨兵 —— 重試機制會忠實地重試，然後把
  // 那個 TypeError 原封不動拋出去。**失敗的形態變質，比失敗本身更難查。**
  if (!copyRect) {
    throw new Error(
      `readTerminalText: 右鍵選單裡沒有可點的「複製」（選單開了嗎=${menu !== null}，` +
        `disabled=${copyDisabled}）—— 不可當成「畫面上沒有東西」`,
    )
  }
  await realClick(client, copyRect)
  await sleep(300)

  const text = String((await client.evaluate(CLIPBOARD_READ)) ?? '')
  if (text === '__not-copied__') {
    throw new Error(
      `readTerminalText: 複製沒有發生（選單的複製項 disabled=${copyDisabled} —— true 表示拖曳沒有選到任何東西）` +
        ' —— 不可當成「畫面上沒有東西」',
    )
  }
  return text
}

/**
 * 輪詢一個**自訂的取值函式**直到滿足條件（`pollUntil` 只吃 `evaluate` 的字串表達式）。
 *
 * 讀終端內容是一連串真滑鼠動作（拖曳選取 → 右鍵 → 複製 → 讀剪貼簿），量一次就斷言等於賭
 * 「內容此刻已經在畫面上」—— 而 shell 的 prompt 與命令輸出都是非同步抵達的。
 *
 * **這裡刻意不傳 `tolerateErrors`。** 它的 `read` 是呼叫端給的任意函式，其中有些是
 * `client.evaluate`（拋錯的典型原因是 CDP 斷線或 renderer 不在了）—— 容忍那一類只會把
 * 「app 已死」變成「等滿整個窗口再說」。`readTerminalText` 那一類的容忍已經收在它自己身上。
 */
async function pollUntilText(read, settled, timeoutMs = 10_000) {
  return pollFor({ read, settled, timeoutMs, interval: 200, label: 'pollUntilText（自訂取值）' })
}

/**
 * 開一個 spawn 選單並點其中一項。
 *
 * ## 這兩個函式此前有一個可指認的缺陷（不是策略問題）
 *
 * 它們等到**選單容器**出現之後，用**一次 `evaluate`** 讀其中的項目 —— 沒有任何等待。
 * 選單已開、項目那一刻還沒渲染，就直接 throw。issue #19 記載的
 * 「選單中找不到『Login shell』」正是這個形狀。
 *
 * 修法是把等待的標的從**容器**換成**項目**：容器出現而項目未出現，本來就是「還沒好」，
 * 不是「壞了」。預算不變（見各自的推導），改變的只是那段預算花在等什麼。
 *
 * @param {object} spec `{ entry, entryWindowMs, budgetMs, name }`
 */
async function openSpawnMenu(client, itemLabel, { entry, entryWindowMs, budgetMs, name }) {
  let clicked = null

  const itemRect = await retryAction({
    act: async () => {
      // 用 poll 而非一次求值：重新載入之後 rail 與分頁列要等 renderer 重新掛載才出現
      //（實測 dev 模式在 reload 後直接找按鈕會撲空）。
      const btn = await pollUntil(client, entry, (value) => value !== null, entryWindowMs)
      if (!btn) throw new Error(`找不到${name}的建立 session 入口`)
      clicked = btn
      await realClick(client, btn)
    },
    // 選單必須活過開啟它的那次 click（它會冒泡到 window，而選單自己掛著 dismiss listener）。
    read: () => client.evaluate(MENU_ITEM_RECT(itemLabel)),
    settled: (value) => value !== null,
    attemptWindowMs: 3000,
    timeoutMs: budgetMs,
    label: `${name}的 spawn 選單（${itemLabel}）`,
    evidence: () => menuEvidence(client, { expected: itemLabel, clicked }),
  })

  if (!itemRect) {
    throw new Error(`${name}的選單中找不到「${itemLabel}」（重試預算 ${budgetMs / 1000}s 耗盡）`)
  }

  // 項目在，容器必定也在（項目是它底下的 button）—— 呼叫端要的是容器的 viewport 資訊。
  const menu = await client.evaluate(MENU_IN_VIEWPORT)
  await realClick(client, itemRect)
  return menu
}

/** 自 rail 的 folder 列建立 session（該入口 hover 才顯示，但 rect 與點擊不受 opacity 影響）。 */
async function openSessionViaRail(client, itemLabel) {
  // **預算 11 秒的推導**：一輪 ＝ 等入口的 8 秒 ＋ 等項目的 3 秒；收斂前是一輪（不重試）。
  return openSpawnMenu(client, itemLabel, {
    entry: RAIL_NEW_SESSION_RECT,
    entryWindowMs: 8000,
    budgetMs: 11_000,
    name: 'rail',
  })
}

async function openSessionViaMenu(client, itemLabel) {
  // **預算 13 秒的推導**：一輪 ＝ 等入口的 10 秒 ＋ 等項目的 3 秒；收斂前是一輪（不重試）。
  return openSpawnMenu(client, itemLabel, {
    entry: NEW_SESSION_RECT,
    entryWindowMs: 10_000,
    budgetMs: 13_000,
    name: '分頁列',
  })
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function runMode(label, { port, rendererUrl }) {
  console.log(`\n── ${label} ──`)

  const marker = `spek-term-marker-${process.pid}-${Date.now()}`
  const { repo, out } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()
  const app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })

  try {
    check(results, `${label}：app 掛載`, app.mounted?.ok === true, describeMounted(app.mounted))

    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    // 尚無 session 時的空狀態與建立入口
    const emptyTabs = await app.client.evaluate(TABS)
    check(results, `${label}：初始沒有任何 session 分頁`, emptyTabs.length === 0)

    // ── 開一個 login shell session（真事件：按鈕 → 選單 → 選單項）
    const menu = await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    check(
      results,
      `${label}：spawn 選單完整落在 viewport 內`,
      menu?.inside === true,
      menu ? `menu=${JSON.stringify(menu.rect)} viewport=${menu.vw}x${menu.vh}` : '選單未開啟',
    )

    const tabs1 = await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)
    check(
      results,
      `${label}：建立 shell session 後出現一個分頁且為 focused`,
      tabs1.length === 1 && tabs1[0].selected === true,
      JSON.stringify(tabs1),
    )

    const pids1 = await waitForPtyCount(marker, 1)
    check(results, `${label}：pty 行程存在`, pids1.length === 1, `pids=${pids1.join(',')}`)

    // 初始輸出（shell 的第一個 prompt）不得因「create 早於 attach」而遺失
    const rail = await app.client.evaluate(RAIL_SESSION_ROWS)
    check(
      results,
      `${label}：rail 於 folder 之下呈現 session 子列`,
      Array.isArray(rail) && rail.length === 1 && rail[0].includes('shell'),
      JSON.stringify(rail),
    )

    // ── typography-scale：terminal 的字級由尺度推導，不是一個獨立的常數
    //
    // **判準是 pty 的 cols，不是任何 DOM 上的字級。** 這不只是「webgl 之後讀不到 `.xterm-rows`」
    // 的替代品 —— 它嚴格更強：它證明字級真的改變了 **pty 的幾何**，而那正是這條 requirement
    // 在乎的東西（`typography-scale` 的 scenario 明寫「**AND** pty 收到更新後的行列數」）。
    // computed `fontSize` 只證明「一個 CSS 屬性被設了」，證明不到它有沒有傳到 pty。
    //
    // **DOM 上沒有可用的字級訊號（全部實測過，全是死路）**：`.xterm-rows` 在 GPU renderer 下消失；
    // `.xterm` 與 `.xterm-helper-textarea` 的 computed `fontSize` **恆為瀏覽器預設**（16px／13.3333px），
    // 不跟 `options.fontSize` 走 —— 而它們**剛好接近正確值**，是最惡劣的那種假綠；
    // `.xterm-char-measure-element` 在 GPU renderer 下不存在；`.xterm-screen` 的 rect 還在，
    // 但 `= cols × cellW`，而 `cols` 只存在於 xterm 實例上，probe 碰不到（暴露它就是測試鉤子）。
    //
    // 固定容器寬度下「字級 ↑ → cols ↓」，於是四條斷言全部以 cols 的比較承載。鑑別力充足：
    // 實測 cellW 於 fontSize 14／16／22 分別為 8.4348／9.6304／13.2391 —— 每一級都不同。
    const readFontCols = async (tag) => {
      // **每次都要先把焦點還給終端、並清掉輸入行。** 設定對話框送出後焦點不在終端上（實測：
      // 少了這一步，`typeLine` 落空、檔案永遠不出現，斷言讀到 cols=0）。`Ctrl+C` 清掉前一次
      // 可能殘留在輸入行上的字（既有 helper，本來就是為這件事準備的）。
      await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
      await sleep(200)
      await pressCtrlC(app.client)
      await sleep(200)
      const file = join(out, `fontcols-${tag}.txt`)
      await typeLine(app.client, `stty size | cut -d' ' -f2 > ${file}`)
      const text = await waitForFile(file, (value) => /\d/.test(value))
      return Number(text.trim() || 0)
    }

    // **順序是承重的：所有偏好的比較都排在「會拖動版面」的旋鈕測試之前。**
    // cols 是容器寬度的函數 —— 而拖曳分界器再拖回來**不保證回到同一個像素**（實測：cols 由 63
    // 變成 64，一個 off-by-one 讓「清除後回到預設」誤報）。舊的判準比對的是字級，對版面免疫；
    // 換成 cols 之後就不是了。把偏好的三次比較集中在同一個版面狀態下完成，這個敏感度就消失。
    const colsDefault = await readFontCols('default')

    // 把偏好設成程式碼裡的 fallback 常數（14）—— 若終端的預設字級「就是」那個 fallback，
    // 兩者的 cols 會相同，這條就變紅。那正是「`--text-terminal` 根本沒被解析出來」的徵狀。
    await setFontSizeViaSettings(app.client, '14')
    const colsAtFallback = await readFontCols('fallback')
    check(
      results,
      `${label}：terminal 的字級來自字級尺度（--text-terminal），不是寫死的常數`,
      colsDefault > 0 && colsAtFallback > 0 && colsDefault !== colsAtFallback,
      `預設字級的 cols=${colsDefault}；字級=14（程式碼裡的 fallback）時 cols=${colsAtFallback}` +
        `（相同就表示 --text-terminal 沒被解析出來，終端一直用著 fallback）`,
    )

    // ── typography-scale：**字型大小偏好覆蓋尺度推導的預設**
    //
    // **鑑別力來自「與未設偏好時不同」**：只斷言「cols 是某個值」無法區分「偏好生效」與「尺度剛好
    // 也產生同樣的 cols」。
    //
    // 這條之所以在 `probe:terminal` 而不是 `probe:workspace`：**只有這裡有終端**。workspace 那邊
    // 驗的是 store 的來回（夾制／落盤／還原），驗不到「偏好真的改變了終端」（verify 稽核抓到的缺口）。
    //
    // **必須走使用者的路徑（開 Settings → 填 → 存），不能直接打 `settings.*` IPC** —— 那會繞過
    // `PreferencesProvider`：store 更新了但 renderer 的狀態沒有，字型 effect 不會重跑，終端當然
    // 不變（實測踩過，一度誤判為產品 bug）。產品的唯一寫入者就是這個對話框。
    await setFontSizeViaSettings(app.client, '22')
    const colsWithPref = await readFontCols('pref22')
    check(
      results,
      `${label}：字型大小偏好覆蓋尺度推導的預設`,
      colsWithPref > 0 && colsWithPref !== colsDefault,
      `偏好=22px → cols=${colsWithPref}；未設偏好時 cols=${colsDefault}` +
        `（兩者必須不同，否則此條沒有鑑別力）`,
    )

    // **清回預設（同樣走使用者的路徑：把欄位清空即為未設定）。**
    //
    // **判準容許 ±1 欄，而那不是在放水 —— 有實測撐著。** cols 是容器寬度的函數，會被捲軸的
    // 出現／消失之類與字級無關的像素漂移推動一欄（實測：清除後 64、原本 63）。但**一欄的容差
    // 擋不住任何真的字級錯誤**：本輪實測 fontSize 14／16／22 → cols 73／63／45，也就是**每 1px
    // 的字級差會造成 3–5 欄的差**（14→16：10 欄／2px；16→22：18 欄／6px）—— 容差比最小的字級
    // 錯誤還小 3–5 倍。
    //
    // 同時要求它**不等於**剛才那兩個偏好值 —— 「回到預設」不能只是「接近某個數」，它必須明確地
    // 離開偏好的值。
    await setFontSizeViaSettings(app.client, '')
    const colsRestored = await readFontCols('restored')
    check(
      results,
      `${label}：清除字型大小偏好後，字級回到尺度推導的預設`,
      Math.abs(colsRestored - colsDefault) <= 1 &&
        colsRestored !== colsAtFallback &&
        colsRestored !== colsWithPref,
      `清除後 cols=${colsRestored}；原本未設偏好時 cols=${colsDefault}` +
        `（偏好 14px 時=${colsAtFallback}、22px 時=${colsWithPref} —— 必須明確離開這兩個值。` +
        `±1 欄的容差吸收與字級無關的像素漂移；1px 的字級差會造成 3–5 欄）`,
    )

    const scale = await app.client.evaluate(TYPE_SCALE)
    const levels = [scale?.['2xs'], scale?.xs, scale?.sm, scale?.base, scale?.lg]
    check(
      results,
      `${label}：字級尺度的五級互不相同（不存在分不出來的級差）`,
      new Set(levels).size === 5 && levels.every((v) => /^\d+(\.\d+)?px$/.test(String(v))),
      JSON.stringify(scale),
    )

    // ── typography-scale：轉動旋鈕，terminal 跟著走（且會重新量測）
    //
    // 字級決定 cell 尺寸，cell 尺寸決定行列數 —— 字級變了而不重新量測，pty 手上的 cols/rows
    // 就與畫面錯位。字級的重讀掛在 `fit()` 上（它本來就在每次 resize 時被呼叫），所以這裡改完
    // 旋鈕要真的觸發一次 resize（拖動 side panel 的分界），再斷言 pty 的 cols 跟上了。
    //
    // **排在所有偏好比較之後** —— 它會拖動版面（見上方 `readFontCols` 的註解）。它自己的判準
    // 是「明顯變少」（實測 63 → 44），對一兩欄的漂移免疫。
    await app.client.evaluate(`document.documentElement.style.setProperty('--text-base', '24px')`)
    const knobSep = center(await app.client.evaluate(SEPARATOR_RECT))
    await dragMouse(app.client, knobSep, { x: knobSep.x - 40, y: knobSep.y })
    await sleep(400)
    await dragMouse(app.client, { x: knobSep.x - 40, y: knobSep.y }, knobSep)
    await sleep(400)
    const colsAfterKnob = await readFontCols('knob')
    check(
      results,
      `${label}：轉動字級旋鈕後，terminal 的字級隨之改變（fit 重新讀取並量測）`,
      colsAfterKnob > 0 && colsAfterKnob < colsDefault,
      `--text-base 由預設轉到 24px（字級變大 → 同寬容器容得下的欄數變少）：` +
        `cols ${colsDefault} → ${colsAfterKnob}（沒變就表示 fit 沒有重新讀取字級）`,
    )

    // 還原旋鈕與版面 —— 後續斷言依賴原本的字級與分界位置。
    await app.client.evaluate(`document.documentElement.style.removeProperty('--text-base')`)
    await dragMouse(app.client, knobSep, { x: knobSep.x - 40, y: knobSep.y })
    await sleep(400)
    await dragMouse(app.client, { x: knobSep.x - 40, y: knobSep.y }, knobSep)
    await sleep(400)

    // ── 雙向串流：回顯 ≠ 執行
    const terminalRect = await app.client.evaluate(TERMINAL_RECT)
    await realClick(app.client, terminalRect) // 讓 xterm 取得焦點
    await sleep(200)

    // 回顯是字面的 `echo OUT_$((6*7))`（不含 42）；只有真的被執行，輸出才會有 OUT_42。
    //
    // **判準是磁碟上的檔案，不是畫面**：檔案只有命令真的執行才會出現，而畫面分不清回顯與執行。
    // **用 `tee` 而非 `>`** —— 稍後的複製斷言要在畫面上選取 `OUT_42`（它刻意選一個「稍早就確定
    // 在畫面上」的內容），改成純重導向會把它從畫面上拿掉，那條就跟著壞了。
    const echoFile = join(out, 'echo.txt')
    await typeLine(app.client, `echo OUT_$((6*7)) | tee ${echoFile}`)
    const echoed = await waitForFile(echoFile, (value) => value.includes('OUT_42'))
    check(
      results,
      `${label}：輸入送達 pty 且執行結果回傳（OUT_42）`,
      echoed.includes('OUT_42'),
      `檔案內容=${JSON.stringify(echoed.trim().slice(0, 40))}`,
    )
    // ── cwd＝folder 根目錄
    // `$(pwd)` 的展開結果寫進檔案 —— 回顯不會展開它，檔案更不會憑空出現。
    const cwdFile = join(out, 'cwd.txt')
    await typeLine(app.client, `pwd > ${cwdFile}`)
    const cwdText = await waitForFile(cwdFile, (value) => value.trim().length > 0, 12_000)
    check(
      results,
      `${label}：session 的 cwd 為 folder 根目錄`,
      cwdText.trim() === repo,
      `期待 ${repo}；實得 ${JSON.stringify(cwdText.trim())}`,
    )

    // ── 複製與貼上（終端不能複製貼上，等於不能用）
    //
    // 右鍵一律送**真事件**：合成的 contextmenu 測不出「開啟選單的事件冒泡到 window 把自己
    // 關掉」這個只在真實輸入下發生的 bug（CLAUDE.md 已記載）。
    const termAt = center(terminalRect)

    // 貼上：先把一段命令放進系統剪貼簿。**判準是它寫出的檔案** —— 回顯是字面的
    // `echo PASTED_$((3*4))`（不含 12），而檔案只有它真的被送進 pty 並執行才會出現。
    const pasteFile = join(out, 'pasted.txt')
    await app.client.evaluate(CLIPBOARD_WRITE(`echo PASTED_$((3*4)) > ${pasteFile}`))

    await realMouse(app.client, termAt.x, termAt.y, 'right')
    const termMenu = await pollUntil(app.client, MENU_IN_VIEWPORT, (value) => value !== null, 4000)
    check(
      results,
      `${label}：終端的右鍵選單開得起來且完整落在 viewport 內`,
      termMenu?.inside === true,
      termMenu ? JSON.stringify(termMenu.rect) : '選單未開啟',
    )

    // 此刻沒有選取內容 —— 「複製」應為停用（停用而非隱藏）
    const copyDisabled = await app.client.evaluate(MENU_ITEM_DISABLED(copy('sessions.copy')))
    check(
      results,
      `${label}：無選取內容時右鍵選單的「複製」為停用`,
      copyDisabled === true,
      `disabled=${copyDisabled}`,
    )

    const pasteRect = await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.paste')))
    await realClick(app.client, pasteRect)

    // 貼上只是把文字送進 pty 的輸入，還要按下 Enter 才會執行。
    await sleep(300)
    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
    })
    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })

    const pasted = await waitForFile(pasteFile, (value) => value.includes('PASTED_12'))
    check(
      results,
      `${label}：自右鍵選單貼上，內容送達 pty 並被執行`,
      pasted.includes('PASTED_12'),
      `檔案內容=${JSON.stringify(pasted.trim().slice(0, 40))}`,
    )

    // 複製：拖曳選取終端內容 → 右鍵 → 複製 → 自系統剪貼簿讀回
    await app.client.evaluate(CLIPBOARD_WRITE('__not-yet-copied__'))
    await dragMouse(
      app.client,
      { x: terminalRect.x + 10, y: terminalRect.y + 10 },
      { x: terminalRect.x + terminalRect.width - 20, y: terminalRect.y + terminalRect.height - 20 },
    )
    await sleep(200)

    await realMouse(app.client, termAt.x, termAt.y, 'right')
    await pollUntil(app.client, MENU_IN_VIEWPORT, (value) => value !== null, 4000)

    const copyEnabled = await app.client.evaluate(MENU_ITEM_DISABLED(copy('sessions.copy')))
    const copyRect = await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.copy')))
    await realClick(app.client, copyRect)
    await sleep(300)

    // 斷言用 `OUT_42` —— 它是稍早就確定在畫面上的內容，不依賴貼上那一步是否成功。
    const clipboardText = await app.client.evaluate(CLIPBOARD_READ)
    check(
      results,
      `${label}：選取終端內容後複製，其內容寫入系統剪貼簿`,
      copyEnabled === false && typeof clipboardText === 'string' && clipboardText.includes('OUT_42'),
      `複製項 disabled=${copyEnabled}；剪貼簿＝…${String(clipboardText).replace(/\s+/g, ' ').slice(-50)}`,
    )

    // ── terminal-sessions：GPU renderer 只給當下顯示的終端 ────────────────────
    //
    // **判準是渲染路徑**（見 `RENDER_PATH_PRELUDE` —— 那裡記著為什麼不能數 canvas）。
    //
    // **像素級的框線對齊驗不到** —— 由 code review + design + dogfood 承擔（比照 OSC 8
    // linkHandler 的先例）。這條擋的是「GPU renderer 靜默沒有啟用」的回歸：少了它，本檔其餘
    // 斷言全綠也證明不了 GPU renderer 還活著（它們刻意設計成 renderer-agnostic）。
    const gpu = await app.client.evaluate(`(() => {${RENDER_PATH_PRELUDE}
      const active = hostsOf().find((d) => !d.classList.contains('hidden'))
      if (!active) throw new Error('找不到顯示中的終端')
      return { activePath: renderPathOf(active), stray: strayCanvasesIn(active) }
    })()`)
    check(
      results,
      `${label}：顯示中的終端以 GPU renderer 呈現`,
      gpu.activePath === 'programmatic',
      `渲染路徑=${gpu.activePath}（共用暫存畫布 ${gpu.stray} 個 —— 僅供參考，不進判準）`,
    )

    // 清掉選取，免得干擾後續的輸入
    await realMouse(app.client, termAt.x, termAt.y, 'left')
    await sleep(150)

    // ── terminal-sessions：右鍵一律由終端擁有（不因 mouse reporting 而讓位）
    //
    // **這一段此前驗的是相反的事**（「開了 mouse reporting 就讓位給程式」），而那條規則的前提
    // 已被實測否證：`claude` 一啟動就送 `?1000h ?1002h ?1003h ?1006h`，於是 agent session 裡右鍵
    // **永遠**被讓出去；而 pty 內的程式**讀不到系統剪貼簿**（xterm.js 未實作 OSC 52）—— 讓出去的
    // 是一顆什麼都不做的鍵。觸控板又沒有中鍵，於是使用者完全失去滑鼠貼上。
    //
    // 以 shell 送 `DECSET 1000` 模擬「程式接管滑鼠」—— 那正是 claude 做的事，而且**不必真的跑
    // claude**（比照 OSC 標題改用 stub 的理由：動的是 pty 送出的序列，不是被出貨的程式碼）。
    // **`?1006h` 不是裝飾，是這一段能不能觀測的前提。** 只送 `?1000h` 時滑鼠回報走 legacy 編碼，
    // 而 xterm 把那種回報送到 `onBinary`（它可能不是 UTF-8 安全的）—— 我們的 wrapper 只訂閱
    // `onData`，於是**一個位元組都不會進 pty**，「右鍵沒送達」就成了一盞恆綠的燈（實測：左鍵
    // 的通道對照組也一樣是空的）。`claude` 實際送的是 `?1000h ?1002h ?1003h ?1006h`，其中
    // `?1006h` 讓回報改用 SGR（純 ASCII，走 `onData`）—— 模擬它才模擬得到真實情況。
    await typeLine(app.client, `printf '\\033[?1000h\\033[?1006h'`)
    await sleep(400)

    // **「事件沒有送達 pty」的判準是檔案內容，不是畫面。**
    //
    // 直覺的做法是「看 shell 的輸入行有沒有被塞進滑鼠序列」—— 那是**否定式斷言 ＋ 讀畫面**，
    // 正是本檔廢除 `TERMINAL_TEXT` 時記載的假綠形狀（讀不到時回空字串，斷言照樣綠）；何況
    // legacy mouse encoding（`ESC [ M …`）在 readline 裡顯示成什麼是環境相依的。
    //
    // `cat -v` 把收到的 `ESC` 印成 `^[` 並寫進檔案 —— 位元組有沒有到 pty 是事實，不是渲染。
    //
    // **兩個會讓這條變成假綠的細節，都實測踩過（在缺陷還在的舊程式碼下它照樣綠）：**
    //
    // 1. **tty 是行緩衝的（canonical mode）** —— 滑鼠序列不含換行，於是它停在 line discipline
    //    的緩衝裡，`cat` 根本收不到。右鍵之後要按一次 Enter 把那一行送出去。
    // 2. **`cat` 的 stdout 是檔案 ⇒ stdio 全緩衝** —— 用 `Ctrl+C` 收掉它，那幾個位元組跟著緩衝
    //    一起消失。要用 `Ctrl+D`（EOF）讓它正常結束並 flush。
    //
    // 判準取 **`^[[<`**（SGR 編碼的開頭）而不是單純的 `^[`：關掉選單的那次 Escape
    // 在**沒有選單可消費它**時會自己流進 pty，用 `^[` 當判準的話，紅燈會指向錯的成因。
    const mouseBytesFile = join(out, 'right-click-bytes.txt')
    const leftBytesFile = join(out, 'left-click-bytes.txt')

    /** 收掉 `cat`：把 line discipline 的緩衝行送出去，再以 EOF 讓它正常結束並 flush。 */
    const endCat = async () => {
      await pressEnter(app.client)
      await sleep(200)
      await pressCtrlD(app.client)
      await sleep(400)
    }

    // **通道的對照組：同樣的狀態下，左鍵必須抵達 pty。**
    //
    // 沒有它，下面那條「右鍵不抵達」就可能只是在驗「什麼都不會抵達」（`cat` 沒跑起來、行緩衝沒
    // 送出、Ctrl+C 把 stdio 緩衝丟掉 —— 前兩者實測都發生過）。左鍵**不在**我們接管的範圍內，
    // 它在 mouse reporting 開啟時本來就該被 xterm 轉發給程式（`docs/lessons/terminal.md`：
    // 「claude 開了 mouse reporting，xterm 把左鍵轉發給程式」）。
    await typeLine(app.client, `cat -v > ${leftBytesFile}`)
    await sleep(400)
    await realMouse(app.client, termAt.x, termAt.y, 'left')
    await sleep(300)
    await endCat()
    const leftBytes = existsSync(leftBytesFile) ? readFileSync(leftBytesFile, 'utf8') : ''
    check(
      results,
      `${label}：mouse reporting 開啟時左鍵抵達 pty（下一條的通道對照組）`,
      leftBytes.includes('^[[<'),
      `pty 收到 ${leftBytes.length} 位元組：${JSON.stringify(leftBytes.slice(0, 40))}` +
        '（沒有 `^[[<` 就表示這個觀測通道量不到任何滑鼠序列，下一條因此沒有鑑別力）',
    )

    await typeLine(app.client, `cat -v > ${mouseBytesFile}`)
    await sleep(400)

    await realMouse(app.client, termAt.x, termAt.y, 'right')
    const menuUnderMouseMode = await pollUntil(
      app.client,
      MENU_IN_VIEWPORT,
      (value) => value !== null,
      4000,
    ).catch(() => null)
    check(
      results,
      `${label}：mouse reporting 開啟時，右鍵仍開啟終端自己的選單`,
      menuUnderMouseMode?.inside === true,
      menuUnderMouseMode
        ? `選單開啟 rect=${JSON.stringify(menuUnderMouseMode.rect)}`
        : '選單未開啟 —— 右鍵仍被讓給 pty 內的程式',
    )

    // 選單先關掉（Enter 否則會落在選單的第一個項目上），再把那一行送給 `cat`、以 EOF 收掉它。
    // **選單必須確實關掉，否則接下來那次 Enter 會落在選單的項目上。**
    //
    // 沒有選取內容時「複製」是停用的，於是焦點落在**「貼上」**上 —— Enter 就把剪貼簿的內容送進
    // pty。實測踩過：build 模式下 Escape 偶爾沒關掉選單，那次 Enter 於是貼上了剪貼簿裡的一整段
    // 畫面逐字稿（770 位元組），而斷言**照樣綠**（它只看有沒有 `^[[<`）。帶副作用的重試走
    // `retryAction`，關不掉就吵。
    const menuAfterEscape = await retryAction({
      act: () => pressKey(app.client, 'Escape'),
      read: () => app.client.evaluate(MENU_IN_VIEWPORT),
      settled: (value) => value === null,
      attemptWindowMs: 1500,
      interval: 200,
      timeoutMs: 6000,
      label: '關掉終端的右鍵選單（Escape）',
      evidence: () => menuEvidence(app.client, {}),
    })
    if (menuAfterEscape !== null) {
      throw new Error('右鍵選單關不掉（重試預算 6s 耗盡）—— 接下來的 Enter 會落在選單上，量到的不是 pty 收到什麼')
    }
    await endCat()
    const mouseBytes = existsSync(mouseBytesFile) ? readFileSync(mouseBytesFile, 'utf8') : ''
    check(
      results,
      `${label}：mouse reporting 開啟時，右鍵不轉發給 pty 內的程式`,
      mouseBytes.length > 0 && !mouseBytes.includes('^[[<'),
      `pty 收到 ${mouseBytes.length} 位元組：${JSON.stringify(mouseBytes.slice(0, 40))}` +
        `（含 \`^[[<\` 表示 xterm 把滑鼠序列轉發過去了；0 位元組表示 cat 沒收到任何東西 ——` +
        `那樣這條就沒有鑑別力，不可當成通過）`,
    )

    // **對照組**：關掉 mouse reporting，右鍵一樣要開得出選單。
    // 少了它，上面那條可能只是在驗「右鍵永遠開選單」而與 mouse reporting 無關 —— 兩種狀態各驗
    // 一次，「不受 pty 狀態影響」這件事才真的被觀察到。
    await typeLine(app.client, `printf '\\033[?1000l\\033[?1006l'`)
    await sleep(400)

    await realMouse(app.client, termAt.x, termAt.y, 'right')
    const menuAfterReset = await pollUntil(
      app.client,
      MENU_IN_VIEWPORT,
      (value) => value !== null,
      4000,
    ).catch(() => null)
    check(
      results,
      `${label}：mouse reporting 關閉時，右鍵同樣開啟選單（對照組）`,
      menuAfterReset?.inside === true,
      menuAfterReset ? '選單開啟' : '選單未開啟',
    )
    // **收乾淨再往下** —— 右鍵改由終端擁有之後，它的 `contextmenu` 不再冒到 window，於是
    // 「開一個選單會順手關掉另一個」不再成立：兩個 `[role="menu"]` 可以並存，而
    // `MENU_IN_VIEWPORT` 以 `querySelector` 只取第一個。等它真的關掉，別用固定睡眠賭。
    await pressKey(app.client, 'Escape')
    await pollUntil(app.client, MENU_IN_VIEWPORT, (value) => value === null, 2000).catch(() => null)
    await pressCtrlC(app.client)
    await sleep(200)

    // ── clipboard：主行程對畸形輸入防禦，不因非字串而崩潰 ────────────────────
    // `writeText` 是 fire-and-forget 的 ipcMain.on、無回應通道；非字串會讓 clipboard.writeText
    // 拋 TypeError → 主行程未捕捉例外。送幾個非字串，再確認主行程仍正常服務後續 IPC、合法字串
    // 仍寫得進剪貼簿。
    //
    // **headless 侷限**：主行程有無 uncaught exception 不傳到 renderer，此處無法直接觀察；驗證的
    // 是可觀察的保證 —— 畸形輸入後主行程存活、clipboard 通道與其他 IPC 仍正常（其餘由 design D3 承擔）。
    await app.client.evaluate('window.workspace.clipboard.writeText({ evil: true })')
    await app.client.evaluate('window.workspace.clipboard.writeText([1, 2, 3])')
    await app.client.evaluate('window.workspace.clipboard.writeText(undefined)')
    await app.client.evaluate(CLIPBOARD_WRITE('legit-after-malformed'))
    const afterMalformed = await app.client.evaluate(CLIPBOARD_READ)
    const foldersAlive = await app.client.evaluate('window.workspace.folders.list()')
    check(
      results,
      `${label}：非字串的剪貼簿寫入被丟棄，主行程仍正常運作`,
      afterMalformed === 'legit-after-malformed' && Array.isArray(foldersAlive),
      `讀回=${JSON.stringify(afterMalformed)} folders=${Array.isArray(foldersAlive) ? foldersAlive.length : 'N/A'}`,
    )

    // ── 終端連結：OSC 8 超連結經受控接縫（linkHandler → openExternal）**不在此 probe** ──────
    //
    // 這裡曾有一條「以真滑鼠 hover+click 一個 OSC 8 連結，斷言不彈 xterm 內建 confirm／window.open」
    // 的驗收。**對照組證明它是假綠**：把產品的 linkHandler 整個移除、重跑，斷言**仍然全綠** ——
    // 也就是那個 hover+click 根本沒觸發 xterm 的 OSC 8 連結激活（DOM renderer 下連結的 hit-test 與
    // Linkifier2 的 hover 追蹤，注入式滑鼠事件驅動不了），confirm 於是恆為 false，與 linkHandler
    // 設沒設無關。留著它只會給一條「測不到自己宣稱在測的東西」的綠燈。
    //
    // 且即使觸發得了，正向「走了 openExternal」仍不可觀察：openExternal 是 fire-and-forget、且
    // 交由主行程開系統瀏覽器。OSC 8 的行為因此由 code review（linkHandler.activate → openLink →
    // openExternal）+ design D4 保證，比照「探針證明不了真實鍵盤」那道由人補的缺口。

    // ── login shell 的 session **不採用** pty 宣告的標題
    //
    // shell 送的是它預設的 prompt 標題（`使用者@主機:/路徑`），對使用者零識別意義，而且它比
    // session 晚一秒多才到 —— 抵達時分頁的寬度會在眼前暴增，把緊鄰其後的「+ session」入口
    // 往右推走。標籤因此一律停在本地的 `shell N`（session-navigation-and-labels 的 design D4）。
    //
    // **斷言必須成對**：光看「標籤沒變」證明不了什麼（它本來就可能什麼都沒發生）。先確認那串
    // OSC 序列**真的抵達了 pty**，再斷言標籤沒被它改動。
    // `cat -v` 把那串 OSC 以可見形式寫進檔案（它會結束 ⇒ 會 flush，無緩衝問題）。
    const oscFile = join(out, 'osc.txt')
    await typeLine(app.client, `printf '\\033]0;shell-osc-title\\007' | cat -v > ${oscFile}`)

    const oscSeen = await waitForFile(oscFile, (value) => value.includes('^[]0;shell-osc-title^G'))
    check(
      results,
      `${label}：OSC 序列確實抵達 pty（否則此測試空轉）`,
      oscSeen.includes('^[]0;shell-osc-title^G'),
      `檔案內容=${JSON.stringify(oscSeen.trim().slice(0, 40))}`,
    )

    await typeLine(app.client, "printf '\\033]0;shell-osc-title\\007'")
    await sleep(1200) // 給它足夠的時間「改壞」—— 沒有這段等待，「沒變」只是還沒輪到它變

    const shellTabs = await app.client.evaluate(TABS)
    check(
      results,
      `${label}：login shell 的 session 不採用 pty 宣告的標題，標籤維持本地標籤`,
      shellTabs.every((tab) => !tab.label.includes('shell-osc-title')) &&
        shellTabs[0]?.label.includes('shell 1'),
      JSON.stringify(shellTabs.map((t) => t.label)),
    )

    const shellRail = await app.client.evaluate(RAIL_SESSION_ROWS)
    check(
      results,
      `${label}：rail 子列同樣維持本地標籤`,
      shellRail.every((row) => !row.includes('shell-osc-title')),
      JSON.stringify(shellRail),
    )

    // ── resize：pty 必須收到新的欄數
    //
    // 兩次量測用**不同的 marker**，且等的是「marker 後面跟著數字」。命令列本身就含
    // `C1=`（tty 會回顯它），若只等 `C1=` 出現，會在回顯的那一刻就返回 —— 那時 shell
    // 根本還沒執行，數字尚未產生（實測：build 模式因此讀到 0）。與 OUT_42 同一個陷阱：
    // **回顯不等於執行**。
    // **判準是磁碟上的檔案。** 這條正是 CLAUDE.md 記載的那個 flaky 的本人：`stty size` 的結果曾以
    // 「等畫面出現 `COLS=`」判定，而 **tty 會回顯輸入行** —— 畫面上在命令執行之前就已經有 `COLS=` 了，
    // 於是讀到還沒產生的值（build 模式讀成 0、dev 僥倖通過）。當年的緩解是把 marker 設計成
    // 「回顯裡不含答案」；改讀檔之後，這個顧慮從根本上消失 —— 檔案只有命令真的執行才會出現。
    const readCols = async (marker) => {
      const file = join(out, `cols-${marker}.txt`)
      await typeLine(app.client, `stty size | cut -d' ' -f2 > ${file}`)
      const text = await waitForFile(file, (value) => /\d/.test(value))
      return Number(text.trim() || 0)
    }

    const colsBefore = await readCols('C1')

    const sep = await app.client.evaluate(SEPARATOR_RECT)
    const sepAt = center(sep)
    // 把分界往左拖 → terminal 變窄 → fit → pty resize
    await dragMouse(app.client, sepAt, { x: Math.max(300, sepAt.x - 220), y: sepAt.y })
    await sleep(600) // debounce(60ms) + IPC + pty

    const colsAfter = await readCols('C2')

    check(
      results,
      `${label}：終端變窄後 pty 收到更小的欄數`,
      colsBefore > 0 && colsAfter > 0 && colsAfter < colsBefore,
      `${colsBefore} → ${colsAfter}`,
    )

    // ── 第二個 session（多開）
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    const tabs2 = await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)
    check(results, `${label}：可多開 session`, tabs2.length === 2, JSON.stringify(tabs2.map((t) => t.label)))

    const pids2 = await waitForPtyCount(marker, 2)
    check(results, `${label}：兩個 pty 行程並存`, pids2.length === 2, `pids=${pids2.join(',')}`)

    // **只有顯示中的終端持有 GPU 的渲染資源。**
    //
    // **這條必須放在「有第二個 session」之後** —— 放在只有一個 session 的地方，「隱藏的終端」
    // 是 0 個，斷言恆為真而什麼都沒驗到（實測踩過：我第一版就放錯地方，detail 印出
    // 「隱藏的終端 0 個」才發現）。
    //
    // 為什麼是正確性要求而非優化：並存的 webgl context 有上限（實測恰為 16），**超出時最舊的
    // 會被靜默丟棄、不觸發任何事件** —— 於是較舊的終端會無聲地變成空白，而 wrapper 裡的
    // `onContextLoss` 自癒救不了它（它倚賴一個通知，而那裡根本沒有通知）。
    const GPU_PER_TERMINAL = `(() => {${RENDER_PATH_PRELUDE}
      const hosts = hostsOf()
      const hidden = hosts.filter((d) => d.classList.contains('hidden'))
      const shown = hosts.filter((d) => !d.classList.contains('hidden'))
      return {
        總數: hosts.length,
        隱藏數: hidden.length,
        隱藏中仍走程式化繪製: hidden.filter((d) => renderPathOf(d) === 'programmatic').length,
        顯示中皆走程式化繪製: shown.length > 0 && shown.every((d) => renderPathOf(d) === 'programmatic'),
        逐一: hosts.map((d) => ({
          隱藏: d.classList.contains('hidden'),
          路徑: renderPathOf(d),
          // **僅供 detail，不進判準** —— 這正是先前那條錯誤判準所數的東西。留著它是為了讓
          // 「共用暫存畫布停在隱藏終端底下」這個情境在輸出中看得見（而斷言仍是綠的）。
          共用暫存畫布: strayCanvasesIn(d),
        })),
      }
    })()`
    // **輪詢，不要量一次就斷言** —— 釋放發生在 React 的 effect 裡，而上一步（等 pty 出現）
    // 一回來就量，很可能早於那次 flush。等不到才是真的沒釋放。
    const gpuPerTerminal = await pollUntil(
      app.client,
      GPU_PER_TERMINAL,
      (v) => v.隱藏數 > 0 && v.隱藏中仍走程式化繪製 === 0 && v.顯示中皆走程式化繪製,
      5000,
    )
    check(
      results,
      `${label}：GPU 的渲染資源只給顯示中的終端（未顯示的不持有）`,
      gpuPerTerminal.隱藏數 > 0 &&
        gpuPerTerminal.隱藏中仍走程式化繪製 === 0 &&
        gpuPerTerminal.顯示中皆走程式化繪製 === true,
      `終端 ${gpuPerTerminal.總數} 個、隱藏 ${gpuPerTerminal.隱藏數} 個，其中 ` +
        `${gpuPerTerminal.隱藏中仍走程式化繪製} 個仍走程式化繪製；顯示中的皆走程式化繪製=` +
        `${gpuPerTerminal.顯示中皆走程式化繪製}（隱藏數為 0 表示這條沒有鑑別力）` +
        ` 逐一=${JSON.stringify(gpuPerTerminal.逐一)}`,
    )

    // **共用的暫存畫布不構成「持有渲染資源」的證據**（`terminal-sessions` 的 scenario）。
    //
    // 這條守的是先前那個誤判：舊判準數 `<canvas>`，而 `TextureAtlas._tmpCanvas` 是跨終端共用、
    // 會遷移的暫存畫布 —— 它停在最近一次光柵化的那個終端底下。若那是隱藏的終端，舊判準就報錯，
    // 而產品完全正常（實測：真實螢幕 1/4 紅、虛擬螢幕 4/5 紅）。
    //
    // **以注入構造，不等它自然發生。** 等待版沒有鑑別力 —— `_tmpCanvas` 落在哪個終端取決於
    // 「切換後顯示中的終端有沒有再光柵化新字元」，等不到就靜默通過，那是一盞測不到自己宣稱在測
    // 的東西的燈。注入一個**不帶 `xterm-link-layer` class 的 canvas**（那正是共用暫存物在判準
    // 眼中的樣子）則是確定的，而且它對舊判準必定為紅 —— 鑑別力由此保證。
    const strayInjected = await app.client.evaluate(`(() => {${RENDER_PATH_PRELUDE}
      const hidden = hostsOf().find((d) => d.classList.contains('hidden'))
      if (!hidden) throw new Error('沒有隱藏的終端可用於構造')
      const before = renderPathOf(hidden)
      const stray = document.createElement('canvas')
      stray.width = 40
      stray.height = 27
      stray.style.display = 'none'
      stray.dataset.probeStray = 'true'
      hidden.querySelector('.xterm')?.append(stray)
      return { before, after: renderPathOf(hidden), strayCount: strayCanvasesIn(hidden) }
    })()`)
    check(
      results,
      `${label}：共用的暫存畫布不構成「持有渲染資源」的證據`,
      strayInjected.before === 'glyph' &&
        strayInjected.after === 'glyph' &&
        strayInjected.strayCount > 0,
      `注入前=${strayInjected.before} 注入後=${strayInjected.after} ` +
        `不帶 link-layer class 的 canvas=${strayInjected.strayCount} 個` +
        `（strayCount 為 0 表示注入沒生效，這條就沒有鑑別力）`,
    )
    // 清掉，免得它影響後續斷言。
    await app.client.evaluate(
      `[...document.querySelectorAll('canvas[data-probe-stray]')].forEach((c) => c.remove()), true`,
    )

    // 兩個 login shell 的 session 都停在本地標籤，且**序號各自不同** —— 序號是 folder 內遞增的。
    //
    // 「pty 宣告的標題被採用」的對照組不在這裡（shell 一律不採用），而在後面 claude 目標的那一段：
    // 那邊有一個由 pty 宣告標題的 session，與這裡的本地標籤形成真正的對比。
    check(
      results,
      `${label}：未宣告標題的 session 退回本地標籤`,
      tabs2[0]?.label.includes('shell 1') && tabs2[1]?.label.includes('shell 2'),
      JSON.stringify(tabs2.map((t) => t.label)),
    )

    // ── 「+ session」必須緊鄰最後一個分頁（先前被 flex 推到分頁列的另一端）
    const gap = await app.client.evaluate(NEW_BUTTON_GAP)
    check(
      results,
      `${label}：「+ session」緊鄰最後一個分頁`,
      typeof gap === 'number' && gap >= 0 && gap < 40,
      `與最後一個分頁的間距 ${gap}px`,
    )

    // ── 切回第一個 session：先前的輸出仍在（scrollback 未因切換而遺失）
    const firstTabRect = await app.client.evaluate(`(() => {
      const tab = document.querySelector('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')
      if (!tab) return null
      const r = tab.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`)

    // ── 釋放渲染資源＝歸還並存額度，不只是移除 DOM 產物
    //
    // 判準是**該脈絡自身是否已失效**，不是「並存上限被觸發時誰先被回收」。後者的回收順序
    // （最早取得者優先）會讓「有歸還」與「沒歸還」在多數佈局下結果完全相同 —— 追這個缺陷時
    // 兩度得到那種無差別的結果，差點據此推翻一個正確的結論。
    //
    // **探針持有脈絡的參照，這件事是承重的**：它讓觀察不受 GC 時機影響。未歸還額度的實作之所以
    // 多半沒出事，正是因為 GC 碰巧來得及 —— 一個受 GC 時機影響的斷言，測到的是回收器的心情。
    const CAPTURE_GL = `(() => {${RENDER_PATH_PRELUDE}
      window.__probeGl = hostsOf().map((host) => {
        const screen = host.querySelector('.xterm-screen')
        if (!screen) return null
        // 主 canvas 不帶 class，link layer 帶 xterm-link-layer；兩者都已持有脈絡，
        // 因此這裡的 getContext 取回既有的那一個，不會新建（不影響待測狀態）。
        const main = [...screen.querySelectorAll('canvas')].find((c) => !c.classList.contains('xterm-link-layer'))
        return main ? main.getContext('webgl2') : null
      })
      return window.__probeGl.map((gl) => (gl ? !gl.isContextLost() : null))
    })()`
    const glBefore = await app.client.evaluate(CAPTURE_GL)

    await realClick(app.client, firstTabRect)
    await sleep(400)

    const glAfter = await app.client.evaluate(
      `window.__probeGl.map((gl) => (gl ? gl.isContextLost() : null))`,
    )
    // 切換前顯示中的那一個（唯一被抓到脈絡的）此刻已隱藏 —— 它的脈絡必須已失效。
    const releasedIndex = glBefore.findIndex((alive) => alive === true)
    check(
      results,
      `${label}：終端由顯示轉隱藏時歸還其渲染資源的並存額度`,
      releasedIndex >= 0 && glAfter[releasedIndex] === true,
      `切換前 alive=${JSON.stringify(glBefore)} 切換後 lost=${JSON.stringify(glAfter)}` +
        `（切換前沒有任何一個是 alive 就表示這條沒有鑑別力）`,
    )

    // 切過去的那個終端要**重新取得**一份有效的渲染資源 —— 釋放若做過頭（例如連新建的一起
    // lose），症狀就出現在這裡。
    //
    // **這條不是「釋放的是它自己的資源」的載體**（實測）：切換會讓 React 為新顯示的終端重建
    // 脈絡，因此即使釋放時誤傷了它，這裡量到的也是那個**重建後**的新脈絡 —— 綠燈。
    // 那條 scenario 的載體在後面「關閉分頁」那一段，關閉不會觸發任何重建。
    const shownAfter = await app.client.evaluate(`(() => {${RENDER_PATH_PRELUDE}
      const shown = hostsOf().filter((d) => !d.classList.contains('hidden'))
      return shown.map((host) => {
        const screen = host.querySelector('.xterm-screen')
        const main = screen && [...screen.querySelectorAll('canvas')].find((c) => !c.classList.contains('xterm-link-layer'))
        const gl = main ? main.getContext('webgl2') : null
        return gl ? gl.isContextLost() : 'no-context'
      })
    })()`)
    check(
      results,
      `${label}：切過去的終端持有一份有效的渲染資源`,
      shownAfter.length > 0 && shownAfter.every((lost) => lost === false),
      `顯示中的終端 lost=${JSON.stringify(shownAfter)}（應全為 false；no-context 表示它根本沒取得）`,
    )

    // ── 抓不到釋放介面時要出聲（`terminal-sessions` 的 scenario）
    //
    // **以注入構造，不等它自然發生** —— 與上面共用暫存畫布那條同一條紀律：等待版沒有鑑別力。
    // 覆寫 `getExtension` 讓釋放介面取不到，再切走切回（切回會重新取得渲染資源，那正是發聲的
    // 路徑），然後還原。**發聲在取得而非釋放的路徑上**，所以每次切回來都會再叫一次。
    const CTRL_TAB = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 2 }
    const ctrlTab = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await app.client.send('Input.dispatchKeyEvent', { type, ...CTRL_TAB })
      }
    }
    // **對照組先做**：此刻已經歷多次取得／釋放，若正常路徑也在叫，下面那條就分不出
    // 「有出聲」與「一直在出聲」。
    check(
      results,
      `${label}：正常路徑不發出「抓不到釋放介面」的警告`,
      !sectionConsole().some((e) => e.text.includes('cannot capture WebGL context')),
      `本段至此收到 ${sectionConsole().length} 則 console`,
    )

    await app.client.evaluate(`(() => {
      const proto = WebGL2RenderingContext.prototype
      proto.__probeRealGetExtension = proto.getExtension
      proto.getExtension = function (name) {
        return name === 'WEBGL_lose_context' ? null : proto.__probeRealGetExtension.call(this, name)
      }
      return true
    })()`)
    await ctrlTab()
    await sleep(300)
    await ctrlTab()
    const warned = await pollFor({
      read: () => sectionConsole(),
      settled: (entries) => entries.some((e) => e.text.includes('cannot capture WebGL context')),
      timeoutMs: 4000,
      interval: 100,
      label: '取不到釋放介面時的警告',
    })
    await app.client.evaluate(`(() => {
      const proto = WebGL2RenderingContext.prototype
      if (proto.__probeRealGetExtension) {
        proto.getExtension = proto.__probeRealGetExtension
        delete proto.__probeRealGetExtension
      }
      return true
    })()`)
    check(
      results,
      `${label}：抓不到渲染資源的釋放介面時出聲（不靜默略過）`,
      warned.some((e) => e.text.includes('cannot capture WebGL context')),
      `本段收到 ${warned.length} 則：${JSON.stringify(warned.map((e) => e.text.slice(0, 60)))}`,
    )

    // 還原之後再切一次，讓該終端重新取得一份**可釋放**的渲染資源 —— 否則後續段落會在一個
    // 抓不到釋放介面的終端上繼續跑，而那不是待測狀態。
    await ctrlTab()
    await sleep(300)
    await ctrlTab()
    await sleep(300)

    // ── 反覆切換之後，顯示中的終端**仍走程式化繪製**
    //
    // 「終端仍顯示得出來、打得了字」擋不住這個迴歸 —— 退回 glyph 路徑的終端一樣正常。
    // 而「主動釋放之後再也拿不回程式化繪製」正是本能力最可能引入的迴歸。
    for (let i = 0; i < 20; i += 1) await ctrlTab()
    const pathAfterChurn = await pollUntil(
      app.client,
      `(() => {${RENDER_PATH_PRELUDE}
        const hosts = hostsOf()
        return {
          顯示中: hosts.filter((d) => !d.classList.contains('hidden')).map((d) => renderPathOf(d)),
          隱藏中: hosts.filter((d) => d.classList.contains('hidden')).map((d) => renderPathOf(d)),
        }
      })()`,
      (v) => v.顯示中.length > 0 && v.顯示中.every((p) => p === 'programmatic'),
      5000,
    )
    check(
      results,
      `${label}：反覆切換 20 次後顯示中的終端仍走程式化繪製`,
      pathAfterChurn.顯示中.length > 0 && pathAfterChurn.顯示中.every((p) => p === 'programmatic'),
      `顯示中=${JSON.stringify(pathAfterChurn.顯示中)} 隱藏中=${JSON.stringify(pathAfterChurn.隱藏中)}`,
    )

    // 判準走**產品自己的複製路徑**（拖曳選取 → 複製 → 讀剪貼簿），不讀 DOM ——
    // 那條管道跨 renderer 不變（見 `readTerminalText`）。
    const backText = await readTerminalText(app.client)
    check(
      results,
      `${label}：切回 session 後其先前的輸出仍在`,
      backText.includes('OUT_42'),
      backText.replace(/\s+/g, ' ').slice(-60),
    )

    // ── terminal-sessions：切走一個 session，不得改變它的尺寸，也不得動它的內容
    //
    // **上面那條斷言曾經在缺陷存在時全綠**（它讀的是畫面上看得到的部分，而那正是缺陷**沒有**
    // 破壞的部分）。真正發生的事：切走時容器沒有版面盒子，`FitAddon.proposeDimensions()` 把
    // 「沒有盒子」夾成 `{cols: 2, rows: 1}`，於是終端被重排成 2 欄（既有 scrollback 撞上 5000 行
    // 上限而永久遺失）、pty 也真的收到 2 欄（agent 在隱藏期間以 2 欄排版）。實測：`36 68 → 1 2`。
    //
    // 兩條載體，機制一條、行為一條 —— **缺一不可**：機制壞掉不必然造成可見的資料損失（要撞上
    // scrollback 上限才會），而只驗資料損失的話，「隱藏期間 agent 以 2 欄排版」驗不到。
    //
    // ## 尺寸的判準是 **pty 自己持有的 winsize**，不是畫面
    //
    // 畫面讀不出「pty 手上是什麼」，而那正是 agent 用來排版的東西。取樣一律**由 pty 內的 shell
    // 自己做**（`< /dev/tty` 明確讀控制終端，不受背景工作 stdin 重導的影響），不從外部
    // `stty -F /dev/pts/N`：後者開檔不帶 `O_NOCTTY`，有把該 pts 變成探針行程控制終端的風險。
    //
    // **隱藏期間的取樣**要排在切走之前：`sleep N; stty …` 是同一行的循序命令，**不是背景工作**
    // —— 於是不會多出一個 argv 為 `/bin/sh` 的子行程去污染 `ptyPids()` 的清點。
    const shownSizeFile = join(out, 'winsize-shown.txt')
    const hiddenSizeFile = join(out, 'winsize-hidden.txt')
    const backSizeFile = join(out, 'winsize-back.txt')
    const sizeOf = (text) => text.trim().replace(/\s+/g, ' ')

    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `stty size < /dev/tty > ${shownSizeFile}`)
    const shownSize = sizeOf(
      await waitForFile(shownSizeFile, (value) => /\d+\s+\d+/.test(value), 10_000),
    )

    await typeLine(app.client, `sleep 2; stty size < /dev/tty > ${hiddenSizeFile}`)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(1)))
    const hiddenSize = sizeOf(
      await waitForFile(hiddenSizeFile, (value) => /\d+\s+\d+/.test(value), 12_000),
    )
    check(
      results,
      `${label}：session 被切走時其 pty 的尺寸不變`,
      hiddenSize === shownSize && !/^1 2$/.test(hiddenSize),
      `顯示中=「${shownSize}」隱藏中=「${hiddenSize}」` +
        '（「1 2」是 FitAddon 的 MINIMUM_ROWS/COLS —— 那表示「沒有盒子」被當成了一次合法的量測）',
    )

    await realClick(app.client, await app.client.evaluate(TAB_RECT(0)))
    await sleep(600)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `stty size < /dev/tty > ${backSizeFile}`)
    const backSize = sizeOf(
      await waitForFile(backSizeFile, (value) => /\d+\s+\d+/.test(value), 10_000),
    )
    check(
      results,
      `${label}：切回顯示後其 pty 的尺寸仍與可用尺寸相符`,
      backSize === shownSize,
      `顯示中=「${shownSize}」切回後=「${backSize}」`,
    )

    // ## 內容的判準是 **app 自己落盤的那份快照**
    //
    // 它就是 `serialize()` 出來的 buffer（含 scrollback），因此「最舊那一行還在不在」問得到，
    // 而不必把畫面捲到頂（那要送數百個滾輪事件，且捲到底沒到頂時會給出假紅）。**這條路徑順帶
    // 覆蓋了本缺陷唯一跨重啟存活的後果**：被重排成 2 欄的內容會被寫進磁碟，下次開 app 再重播。
    //
    // **劑量要有餘裕**：行寬取自剛才量到的欄數（不折行 ⇒ 一行一列），行數取 900（快照上限是
    // 1000 列）。被重排成 2 欄時每行佔 `ceil(寬/2)` 列 —— 以 68 欄為例是 29 列 × 900 ＝ 26100 列，
    // 是 5000 行上限的 5 倍。終端幾何會隨字級與分界拖曳浮動，餘裕不足時「缺陷還在但這一輪剛好
    // 沒溢出」是可能的。
    const cols = Number(shownSize.split(' ')[1]) || 80
    const lineWidth = Math.max(20, cols - 12)
    const lineCount = 900
    const pad = 'x'.repeat(Math.max(0, lineWidth - 12))
    const reflowRows = Math.ceil(lineWidth / 2) * lineCount
    const snapshotDir = join(profile, 'sessions')
    /** 含 `MARK_900` 的那一份快照 —— 也就是這個 session 的。 */
    const markedSnapshot = () => {
      let entries
      try {
        entries = readdirSync(snapshotDir)
      } catch {
        // 快照目錄要等第一次落盤才會出現。
        return null
      }
      for (const entry of entries) {
        if (!entry.endsWith('.scrollback')) continue
        const text = readFileSync(join(snapshotDir, entry), 'utf8')
        if (text.includes(`MARK_${lineCount} `)) return text
      }
      return null
    }

    await typeLine(
      app.client,
      `i=1; while [ $i -le ${lineCount} ]; do echo "MARK_$i ${pad}"; i=$((i+1)); done`,
    )
    await sleep(SNAPSHOT_SETTLE_MS)
    const beforeSnapshot = await pollFor({
      read: async () => markedSnapshot(),
      settled: (value) => value !== null,
      timeoutMs: 12_000,
      label: '落盤快照（切走之前）',
    })
    // **對照組（觀測管道本身有沒有鑑別力）**：切走之前 `MARK_1` 必須在快照裡 —— 它不在的話，
    // 下面那條「切回之後它還在」就只是在複述一個從一開始就不成立的前提。
    check(
      results,
      `${label}：落盤的快照涵蓋得到最舊的一行（對照組）`,
      beforeSnapshot !== null && beforeSnapshot.includes('MARK_1 '),
      `快照${beforeSnapshot === null ? '找不到' : `長 ${beforeSnapshot.length} 位元組`}；` +
        `行寬=${lineWidth} 行數=${lineCount}（重排成 2 欄約 ${reflowRows} 列 vs 上限 5000）`,
    )

    await realClick(app.client, await app.client.evaluate(TAB_RECT(1)))
    await sleep(1500)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(0)))
    await sleep(600)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    // 快照是 debounce 落盤的，要有新輸出才會再寫一份 —— 否則讀到的是切走之前那一份，
    // 而那份是好的，斷言會恆綠。
    await typeLine(app.client, 'echo TICK')
    await sleep(SNAPSHOT_SETTLE_MS)
    const afterSnapshot = await pollFor({
      read: async () => markedSnapshot(),
      settled: (value) => value !== null && value.includes('TICK'),
      timeoutMs: 12_000,
      label: '落盤快照（切回之後）',
    })
    check(
      results,
      `${label}：切走再切回之後最舊的一行仍在`,
      afterSnapshot !== null && afterSnapshot.includes('MARK_1 '),
      afterSnapshot === null
        ? '切回後的快照找不到'
        : `快照長 ${afterSnapshot.length} 位元組，最舊的標記=` +
          `${(afterSnapshot.match(/MARK_(\d+) /) ?? [])[0] ?? '（一個都沒有）'}`,
    )

    // **把畫面上的已知內容補回來。** 上面那 900 行把 `OUT_42` 推進了 scrollback，而後面
    // 「拖曳排序後切回 session，其終端內容仍在（未變空白）」讀的是**可見範圍**（`readTerminalText`
    // 只讀得到當前畫面）。那條斷言問的是「拖曳有沒有讓終端變空白」，不是「歷史有多長」——
    // 補一行回去，它問的東西不變，而它與本段的耦合是明寫的，不是巧合。
    await typeLine(app.client, 'echo OUT_42')
    await sleep(300)

    // ── rail 的 session 子列：點選即聚焦（此刻 focused 是第一個）
    const railSecond = await app.client.evaluate(RAIL_SESSION_RECT(1))
    await realClick(app.client, railSecond)
    const tabsAfterRail = await pollUntil(
      app.client,
      TABS,
      (value) => value.length === 2 && value[1].selected === true,
      8000,
    )
    check(
      results,
      `${label}：點 rail 的 session 子列即聚焦該 session`,
      tabsAfterRail[1]?.selected === true,
      JSON.stringify(tabsAfterRail.map((t) => `${t.label}${t.selected ? '*' : ''}`)),
    )

    // ── rail 的 session 子列：可收合與展開
    const caret = await app.client.evaluate(RAIL_CARET_RECT)
    await realClick(app.client, caret)
    const collapsed = await pollUntil(app.client, RAIL_SESSION_COUNT, (value) => value === 0, 4000)
    await realClick(app.client, caret)
    const expanded = await pollUntil(app.client, RAIL_SESSION_COUNT, (value) => value === 2, 4000)
    check(
      results,
      `${label}：rail 的 session 子列可收合與展開`,
      collapsed === 0 && expanded === 2,
      `收合後=${collapsed} 展開後=${expanded}`,
    )

    // ── 重新命名：使用者接管 session 的命名權
    //
    // 先聚焦第一個 session（後面要對它送 OSC 標題）。
    await realClick(app.client, await app.client.evaluate(TAB_RECT(0)))
    await sleep(200)

    const tab0 = await app.client.evaluate(TAB_RECT(0))
    const tab0At = center(tab0)
    await realMouse(app.client, tab0At.x, tab0At.y, 'right')

    const tabMenu = await pollUntil(app.client, MENU_IN_VIEWPORT, (value) => value !== null, 4000)
    check(
      results,
      `${label}：分頁的右鍵選單開得起來且完整落在 viewport 內`,
      tabMenu?.inside === true,
      tabMenu ? JSON.stringify(tabMenu.rect) : '選單未開啟',
    )

    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await pollUntil(app.client, RENAME_INPUT_RECT, (value) => value !== null, 4000)

    // 對話框開啟時輸入框已 focus 且全選 —— 直接打字即取代。
    await app.client.send('Input.insertText', { text: 'my-session' })
    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
    })
    await app.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })

    const renamedTabs = await pollUntil(
      app.client,
      TAB_LABELS,
      (value) => value[0]?.includes('my-session'),
      6000,
    )
    const renamedRail = await pollUntil(
      app.client,
      RAIL_LABELS,
      (value) => value[0]?.includes('my-session'),
      6000,
    )
    check(
      results,
      `${label}：重新命名後分頁與 rail 兩處的標籤都更新`,
      renamedTabs[0]?.includes('my-session') && renamedRail[0]?.includes('my-session'),
      `分頁=${JSON.stringify(renamedTabs)} rail=${JSON.stringify(renamedRail)}`,
    )

    // ── 已命名的 login shell session：pty 送出標題時**不該**跳任何對話框
    //
    // shell 根本不採用 pty 的標題（見上），因此「pty 想改名」這個情境對它不存在 —— 使用者不該
    // 被一個「pty 想把它改名為 kewang@host:/tmp/…，要採用嗎？」的對話框打斷，而那個名字他永遠
    // 看不到。**這是 design D4「擋在 setTitle() 而非顯示層」唯一測得出來的後果**：若只改顯示層，
    // 標籤會是對的，但那個對話框照跳不誤。
    await realClick(app.client, terminalRect)
    await sleep(200)
    await typeLine(app.client, "printf '\\033]0;pty-wants-this\\007'")
    await sleep(1500) // 給對話框足夠的時間跳出來 —— 沒有這段等待，「沒跳」只是還沒跳

    const noConflict = await app.client.evaluate(ANY_DIALOG_OPEN)
    const labelAfterOsc = await app.client.evaluate(TAB_LABELS)
    check(
      results,
      `${label}：已命名的 login shell session，pty 送出標題時不跳對話框`,
      noConflict === false && labelAfterOsc[0]?.includes('my-session'),
      `對話框=${noConflict} 標籤=${JSON.stringify(labelAfterOsc)}`,
    )

    // ── 拖曳排序：分頁與 rail 共用同一個順序
    const firstTab = await app.client.evaluate(TAB_RECT(0))
    const secondTab = await app.client.evaluate(TAB_RECT(1))

    // ── 游標：分頁**點一下是有作用的**（切換 focused session），拖曳是偶爾為之 ——
    // 靜止時必須是 `pointer`（食指），不是 `grab`（張開的手，宣告「這東西只能被拖」）。
    const idleCursor = await app.client.evaluate(TAB_CURSOR(0))
    check(
      results,
      `${label}：分頁靜止時的游標為 pointer（不是 grab）`,
      idleCursor === 'pointer',
      String(idleCursor),
    )

    // 拖曳**進行中**才是 `grabbing`。這一半不能省：元素自己的 cursor 會贏過 `useDragReorder`
    // 設在 body 上的 grabbing —— 少了它，滑鼠底下（正是被拖的那一個分頁）會顯示食指。
    await app.client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...center(firstTab),
      button: 'none',
      buttons: 0,
    })
    await app.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...center(firstTab),
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
    await app.client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: center(firstTab).x + 10,
      y: center(firstTab).y,
      button: 'left',
      buttons: 1,
    })
    await sleep(200)
    const draggingCursor = await app.client.evaluate(TAB_CURSOR(0))
    await app.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: center(firstTab).x + 10,
      y: center(firstTab).y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    })
    await sleep(300)
    check(
      results,
      `${label}：拖曳進行中的游標為 grabbing`,
      draggingCursor === 'grabbing',
      String(draggingCursor),
    )

    // 上面那次拖曳沒有跨過任何分頁的中線 —— 順序不變，接著才是真正的拖曳排序。
    //
    // **第三個分頁不是裝飾。** 只有兩個項目時，「落在指示線之處」與「多跳一格」給出的結果**完全
    // 相同** —— 分頁列的拖曳因此長年只用兩個分頁驗收，而那個 off-by-one（往下／往右拖時，東西
    // 落在指示線的下一格）就這樣躲過了每一輪全綠。三個才分得出來。
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    const three = await pollUntil(app.client, TAB_LABELS, (value) => value.length === 3, 10_000)
    check(results, `${label}：分頁列有三個 session（拖曳精度的驗收需要）`, three.length === 3, JSON.stringify(three))

    const beforeThree = await app.client.evaluate(TAB_LABELS)
    const firstTabAgain = await app.client.evaluate(TAB_RECT(0))
    const secondTabAgain = await app.client.evaluate(TAB_RECT(1))

    // 把第一個分頁拖到第二個的右半邊 → 指示線落在第二個之後 → 它應該停在**第二與第三之間**，
    // 而不是被丟到最後。
    await dragMouse(
      app.client,
      center(firstTabAgain),
      { x: Math.round(secondTabAgain.x + secondTabAgain.width - 4), y: center(secondTabAgain).y },
    )
    await sleep(400)

    const afterDrag = await app.client.evaluate(TAB_LABELS)
    const railAfterDrag = await app.client.evaluate(RAIL_LABELS)
    check(
      results,
      `${label}：拖曳分頁改變順序，落點與指示線一致，且 rail 同步呈現相同順序`,
      afterDrag[0] === beforeThree[1] &&
        afterDrag[1] === beforeThree[0] &&
        afterDrag[2] === beforeThree[2] &&
        JSON.stringify(railAfterDrag) === JSON.stringify(afterDrag),
      `拖曳前=${JSON.stringify(beforeThree)} 拖曳後=${JSON.stringify(afterDrag)}（多跳一格的話第一個分頁會跑到最後）rail=${JSON.stringify(railAfterDrag)}`,
    )

    // 關掉多開的那一個，讓後續段落回到它原本預期的兩個 session。
    await app.client.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')]
      const group = tabs[2]?.closest('div[role="presentation"]')
      const close = group?.querySelector('[aria-label^="${prefixOf('sessions.closeSession')}"]')
      if (!close) return false
      close.click()
      return true
    })()`)
    await pollUntil(app.client, TAB_LABELS, (value) => value.length === 2, 8000)

    // ── 自 rail 拖曳，順序同樣改變，分頁列同步
    const railBefore = await app.client.evaluate(RAIL_LABELS)
    const railRow0 = await app.client.evaluate(RAIL_SESSION_RECT(0))
    const railRow1 = await app.client.evaluate(RAIL_SESSION_RECT(1))

    // 把第一列往下拖過第二列的中線
    await dragMouse(app.client, center(railRow0), {
      x: center(railRow1).x,
      y: Math.round(railRow1.y + railRow1.height - 2),
    })
    await sleep(400)

    const railAfterDragFromRail = await app.client.evaluate(RAIL_LABELS)
    const tabsAfterRailDrag = await app.client.evaluate(TAB_LABELS)
    check(
      results,
      `${label}：自 rail 拖曳改變順序，且分頁列同步呈現相同順序`,
      railAfterDragFromRail[0] === railBefore[1] &&
        railAfterDragFromRail[1] === railBefore[0] &&
        JSON.stringify(tabsAfterRailDrag) === JSON.stringify(railAfterDragFromRail),
      `rail 前=${JSON.stringify(railBefore)} rail 後=${JSON.stringify(railAfterDragFromRail)} 分頁=${JSON.stringify(tabsAfterRailDrag)}`,
    )

    // ── 拖曳排序不得毀掉終端的畫面
    //
    // 若終端的**掛載順序**跟著拖曳排序走，React 會用 insertBefore 搬動 xterm 的 DOM 節點，
    // 而 xterm 被移動後畫面會空掉 —— 直到有新輸出或 resize 才重繪（實測：拖曳後點回某個
    // session 是一片空白，隨便打個字才冒出來）。切走再切回，斷言它的歷史內容還在。
    await realClick(app.client, await app.client.evaluate(TAB_RECT(1)))
    await sleep(400)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(0)))
    await sleep(600)

    const textAfterReorder = await readTerminalText(app.client)
    check(
      results,
      `${label}：拖曳排序後切回 session，其終端內容仍在（未變空白）`,
      textAfterReorder.includes('OUT_42'),
      `…${textAfterReorder.replace(/\s+/g, ' ').slice(-70)}`,
    )

    // ── 未位移的按下放開仍是點擊（切換 focus，順序不變）
    const orderBeforeClick = await app.client.evaluate(TAB_LABELS)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(1)))
    await sleep(300)
    const orderAfterClick = await app.client.evaluate(TAB_LABELS)
    const tabsAfterClick = await app.client.evaluate(TABS)
    check(
      results,
      `${label}：未位移的按下放開是點擊（切換 focus，順序不變）`,
      JSON.stringify(orderBeforeClick) === JSON.stringify(orderAfterClick) &&
        tabsAfterClick[1]?.selected === true,
      // 印出實際順序 —— 只斷言布林值的 check()，失敗時什麼線索都不會留下。
      `前=${JSON.stringify(orderBeforeClick)} 後=${JSON.stringify(orderAfterClick)} ` +
        `selected=${JSON.stringify(tabsAfterClick.map((t) => t.selected))}`,
    )

    // ── 關閉一個分頁 → 該 pty 被清掉
    //
    // **順帶承載「釋放的是它自己的資源」**：此刻 focused（顯示中）的是第二個分頁，即將被關閉的
    // 是第一個（隱藏、已退回 glyph 路徑、其節點下沒有 canvas）。因此文件中唯一符合
    // 「`.xterm-screen` 下不帶 link-layer class 的 canvas」的，正是**顯示中那個**的主 canvas ——
    // 一個以 `document` 為查詢範圍的釋放實作會在這裡把它弄壞。
    //
    // **這條不能用「切換」來驗**（實測）：切換後 React 會為新顯示的終端重建一個有效的脈絡，
    // 事後檢查因此看不到破壞 —— 那樣的斷言在誤釋放的實作下**照樣是綠的**。關閉才是能觀察到的
    // 時機：顯示中的那個自始至終沒有換過，沒有任何重建會掩蓋它。
    const glShownBeforeClose = await app.client.evaluate(`(() => {${RENDER_PATH_PRELUDE}
      const shown = hostsOf().filter((d) => !d.classList.contains('hidden'))
      window.__probeGlShown = shown.map((host) => {
        const screen = host.querySelector('.xterm-screen')
        const main = screen && [...screen.querySelectorAll('canvas')].find((c) => !c.classList.contains('xterm-link-layer'))
        return main ? main.getContext('webgl2') : null
      })
      return window.__probeGlShown.map((gl) => (gl ? !gl.isContextLost() : null))
    })()`)

    await app.client.evaluate(CLOSE_FIRST_TAB)
    const tabs3 = await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)

    const glShownAfterClose = await app.client.evaluate(
      `window.__probeGlShown.map((gl) => (gl ? gl.isContextLost() : null))`,
    )
    check(
      results,
      `${label}：釋放的是該終端自己的資源（關閉他者不影響顯示中的終端）`,
      glShownBeforeClose.some((alive) => alive === true) &&
        glShownAfterClose.every((lost) => lost === false || lost === null),
      `關閉前 alive=${JSON.stringify(glShownBeforeClose)} 關閉後 lost=${JSON.stringify(glShownAfterClose)}` +
        `（關閉前沒有任何一個是 alive 就表示這條沒有鑑別力）`,
    )

    const pids3 = await waitForPtyCount(marker, 1)
    check(
      results,
      `${label}：關閉分頁同時終止其 pty`,
      tabs3.length === 1 && pids3.length === 1,
      `tabs=${tabs3.length} pids=${pids3.length}`,
    )

    // ── 自 rail 的 folder 列建立 session（不必先切到主舞台）
    await openSessionViaRail(app.client, copy('sessions.spawnShell'))
    const tabsAfterRailCreate = await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)
    const pidsAfterRailCreate = await waitForPtyCount(marker, 2)
    check(
      results,
      `${label}：自 rail 的 folder 列建立 session`,
      tabsAfterRailCreate.length === 2 &&
        tabsAfterRailCreate[1]?.selected === true &&
        pidsAfterRailCreate.length === 2,
      `tabs=${tabsAfterRailCreate.length} focused=${tabsAfterRailCreate[1]?.selected} pids=${pidsAfterRailCreate.length}`,
    )

    // ── 自 rail 的 session 子列關閉 session
    //
    // **順帶承載「銷毀時歸還並存額度」** —— 這是與上面那條（關閉分頁）不同的一條路徑，而它
    // **只有在這裡驗得到**：
    //
    // - 上面 `:2144` 關掉的是**隱藏**的那一個，它的脈絡早在切換時就已釋放 ⇒ 銷毀路徑做或不做
    //   結果完全相同，那條斷言在銷毀路徑失效時**依然全綠**（實測：拿掉 `xterm.ts` 的
    //   `dispose()` 裡那行 `releaseWebglContext()`，`runMode:build` 仍是全綠）。
    // - 「由顯示轉隱藏」那條（`:1739`）驗的是 `setGpuRenderer(false)`，走的是另一個入口。
    //
    // 此刻即將被關掉的是**當下顯示中**的那一個（上一條斷言剛驗過 `[1].selected === true`），
    // 且中間沒有任何切換 —— 那正是規格描述的失效情境：使用者不切換、直接關閉正在用的 session。
    const glClosingBefore = await app.client.evaluate(`(() => {${RENDER_PATH_PRELUDE}
      const shown = hostsOf().filter((d) => !d.classList.contains('hidden'))
      window.__probeGlClosing = shown.map((host) => {
        const screen = host.querySelector('.xterm-screen')
        const main = screen && [...screen.querySelectorAll('canvas')].find((c) => !c.classList.contains('xterm-link-layer'))
        return main ? main.getContext('webgl2') : null
      })
      return window.__probeGlClosing.map((gl) => (gl ? !gl.isContextLost() : null))
    })()`)

    const railClose = await app.client.evaluate(RAIL_CLOSE_SESSION_RECT(1))
    await realClick(app.client, railClose)
    const tabsAfterRailClose = await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)
    const pidsAfterRailClose = await waitForPtyCount(marker, 1)
    check(
      results,
      `${label}：自 rail 的 session 子列關閉 session 並終止其 pty`,
      tabsAfterRailClose.length === 1 && pidsAfterRailClose.length === 1,
      `tabs=${tabsAfterRailClose.length} pids=${pidsAfterRailClose.length}`,
    )

    const glClosingAfter = await app.client.evaluate(
      `window.__probeGlClosing.map((gl) => (gl ? gl.isContextLost() : null))`,
    )
    const closedIndex = glClosingBefore.findIndex((alive) => alive === true)
    check(
      results,
      `${label}：銷毀當下顯示中的終端時歸還其渲染資源的並存額度`,
      // **「被關掉的就是顯示中的那一個」是判定式的一部分，不是註解裡的說明** —— 取樣點日後
      // 若被挪去關閉隱藏分頁處，這條會紅，而不是靜默地失去鑑別力。
      tabsAfterRailCreate[1]?.selected === true &&
        closedIndex >= 0 &&
        glClosingAfter[closedIndex] === true,
      `關閉的是顯示中的那一個=${tabsAfterRailCreate[1]?.selected} ` +
        `關閉前 alive=${JSON.stringify(glClosingBefore)} 關閉後 lost=${JSON.stringify(glClosingAfter)}` +
        `（關閉前沒有任何一個是 alive 就表示這條沒有鑑別力）`,
    )

    // ── pty 自行結束：標示為已結束，但**不從清單消失**（使用者要讀得到最後的輸出）
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await sleep(200)
    await typeLine(app.client, 'exit')

    const exitedTabs = await pollUntil(
      app.client,
      TABS,
      (value) => value.length === 1 && value[0].exited === true,
      8000,
    )
    const pidsAfterExit = await waitForPtyCount(marker, 0)
    check(
      results,
      `${label}：pty 自行結束後 session 標示為已結束且仍留在清單`,
      exitedTabs.length === 1 && exitedTabs[0].exited === true && pidsAfterExit.length === 0,
      `${JSON.stringify(exitedTabs)} pids=${pidsAfterExit.length}`,
    )

    // 已結束的 session 仍可手動關閉（此時已無 pty 需要終止）
    await app.client.evaluate(CLOSE_FIRST_TAB)
    const tabsAfterCloseExited = await pollUntil(app.client, TABS, (value) => value.length === 0, 8000)
    check(
      results,
      `${label}：已結束的 session 可手動關閉`,
      tabsAfterCloseExited.length === 0,
      `tabs=${tabsAfterCloseExited.length}`,
    )

    // ── claude 目標的 session：pty 宣告的標題**會**被採用
    //
    // 這一整段的載體是 PATH 上的 stub `claude`（見 `makeStubClaude`）—— 產品從 PATH spawn
    // `claude`，那正是它的正常行為，探針動的是環境而非產品程式碼。stub 是個互動 shell，
    // 因此下面的 `printf '\033]0;…'` 就是「pty 內的程式宣告自己的身分」。
    await openSessionViaMenu(app.client, copy('sessions.spawnClaude'))
    const tabsClaude = await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)
    check(
      results,
      `${label}：claude 模式可建立 session`,
      tabsClaude.length === 1,
      JSON.stringify(tabsClaude.map((t) => t.label)),
    )
    // **issue #19 的三條紅燈之一就在這裡** —— 此前它只說得出「不是 true」。
    const mountedAfterClaude = await app.client.evaluate(MOUNTED)
    check(results, `${label}：建立 claude session 後 app 仍運作`, mountedAfterClaude?.ok === true,
      describeMounted(mountedAfterClaude))

    // 尚未宣告標題 → 本地標籤（序號承自 folder 內的計數）
    check(
      results,
      `${label}：claude session 未宣告標題時為本地標籤`,
      tabsClaude[0]?.label.includes('claude'),
      JSON.stringify(tabsClaude.map((t) => t.label)),
    )

    const claudeTermRect = await pollUntil(app.client, TERMINAL_RECT, (value) => value !== null, 10_000)

    // **正對照組：我們驅動的必須是自己那支 stub claude。**
    //
    // 少了這條斷言，一個很難察覺的錯誤會靜悄悄地發生：`~/.profile` 把 `$HOME/.local/bin`
    // prepend 到 PATH，於是**真的 claude** 被 spawn 起來，探針真的開了一個 Claude Code session
    // （實測踩過 —— 分頁標籤變成它宣告的任務描述，四條斷言以看不懂的方式失敗）。
    // **以次數為界的等待是同一個病的第四種形狀**：`60 × 250ms` 是一個 15 秒的預算，而它藏在
    // 乘法裡、沒有任何一處寫下來過。它不帶副作用（不是重試）、每輪沒有淨效果（不是遞增），
    // 所以用既有的 `pollFor` 而不是 `retryAction`。
    //
    // **兩道原始碼守衛都抓不到這個形狀**（等待守衛認 `Date.now()` 的比較，重試守衛認純計數的
    // 界加體內提早退出）—— 已登記為已知缺口，見 `docs/lessons/probes.md`。
    const stubRan = await pollFor({
      read: () => existsSync(stub.receipt),
      settled: (ran) => ran === true,
      timeoutMs: 15_000,
      interval: 250,
      label: `claude stub 的憑據（${stub.receipt}）`,
    })
    check(
      results,
      `${label}：claude 目標 spawn 的是探針的 stub（不是本機真的 claude）`,
      stubRan === true,
      stubRan ? '' : `未見憑據：${stub.receipt}`,
    )

    await sleep(1500) // 等 stub 的 shell 畫出它的第一個 prompt
    await realClick(app.client, claudeTermRect)
    await sleep(200)
    await typeLine(app.client, "printf '\\033]0;claude-osc-title\\007'")

    const claudeTitled = await pollUntil(
      app.client,
      TABS,
      (value) => value.some((tab) => tab.label.includes('claude-osc-title')),
      10_000,
    )
    check(
      results,
      `${label}：claude session 的分頁標籤跟隨 pty 宣告的終端標題`,
      claudeTitled.some((tab) => tab.label.includes('claude-osc-title')),
      JSON.stringify(claudeTitled.map((t) => t.label)),
    )

    const claudeRail = await pollUntil(
      app.client,
      RAIL_SESSION_ROWS,
      (value) => value.some((row) => row.includes('claude-osc-title')),
      6000,
    )
    check(
      results,
      `${label}：rail 子列同步跟隨 pty 宣告的標題`,
      claudeRail.some((row) => row.includes('claude-osc-title')),
      JSON.stringify(claudeRail),
    )

    // ── 命名權：使用者命名 ＝ **永久**接管，pty 其後的標題靜默不予呈現
    //
    // 這一段是 session-title-authority 的主場，**取代了原本「pty 想改名要先問過」那組斷言** ——
    // 那個確認對話框已移除：`claude` 隨任務進展持續改標題，每次都問一遍就是無限打斷（第二次
    // dogfooding 抓到的），而它問的又是一個答案可預測的問題（使用者才剛親手命名）。
    const claudeTab0 = center(await app.client.evaluate(TAB_RECT(0)))
    await realMouse(app.client, claudeTab0.x, claudeTab0.y, 'right')
    await pollUntil(app.client, MENU_IN_VIEWPORT, (value) => value !== null, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await sleep(300) // 對話框開啟時輸入框已 focus 且全選 —— 直接打字即取代
    await app.client.send('Input.insertText', { text: 'my-claude' })
    await pressEnter(app.client)

    const claudeRenamed = await pollUntil(
      app.client,
      TAB_LABELS,
      (value) => value[0]?.includes('my-claude'),
      6000,
    )
    check(
      results,
      `${label}：claude session 可由使用者命名，且優先於 pty 的標題`,
      claudeRenamed[0]?.includes('my-claude'),
      JSON.stringify(claudeRenamed),
    )

    await realClick(app.client, claudeTermRect)
    await sleep(200)

    // **兩個標題，一次打完：先送「同一個」，再送一個「不同的」。**
    //
    // 第一個 `claude-osc-title` 正是 pty 先前宣告過、使用者命名前看到的那個 —— 使用者回報的情境
    // 就是「改名成 b 之後，claude 一直要改回 a」。**舊實作連這個都會再問一次**：「與待裁決的標題
    // 相同就不問」那條短路，在使用者按下「保留我的名字」的瞬間就失效了（待裁決欄位已被清空）。
    //
    // 第二個 `pty-later` 是一個貨真價實的新標題 —— 它同時是下面那個對照組的錨。
    await typeLine(
      app.client,
      "printf '\\033]0;claude-osc-title\\007'; sleep 1; printf '\\033]0;pty-later\\007'",
    )
    await sleep(3000) // 讓兩個標題都抵達，並給任何對話框足夠的時間跳出來

    const noDialogWhileOwned = await app.client.evaluate(ANY_DIALOG_OPEN)
    const labelWhileOwned = await app.client.evaluate(TAB_LABELS)
    check(
      results,
      `${label}：手動命名後 pty 反覆宣告標題，不跳任何對話框且標籤不變`,
      noDialogWhileOwned === false && labelWhileOwned[0]?.includes('my-claude'),
      `對話框=${noDialogWhileOwned} 標籤=${JSON.stringify(labelWhileOwned)}`,
    )

    // ── 清空名稱 ＝ 交還命名權，標籤**立即**回到 pty 最近宣告的標題
    //
    // **這一條同時是上面那條的對照組 —— 少了它，上面就是假綠。** 「沒有對話框」是一個否定斷言：
    // stub 若根本沒把那兩個 OSC 標題送出去（PATH 沒接好、shell 沒起來、命令沒執行），它一樣會
    // 通過。而標籤在清空的瞬間變成 `pty-later`，證明了兩件事：那些標題**真的抵達了** `setTitle()`
    //（於是「沒跳對話框」是真的沒跳，不是根本沒送）；以及接管期間 pty 的標題**持續被記錄**，
    // 交還是即時的，不必空等 pty 下一次宣告（design D3）。
    await openTabMenu(app.client, 0)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await sleep(300)
    await app.client.send('Input.insertText', { text: '' }) // 輸入框已全選 —— 送出空字串＝清空
    await pressEnter(app.client)

    const handedBack = await pollUntil(
      app.client,
      TAB_LABELS,
      (value) => value[0]?.includes('pty-later'),
      6000,
    )
    check(
      results,
      `${label}：清空名稱後標籤立即變為 pty 於接管期間最近宣告的標題`,
      handedBack[0]?.includes('pty-later'),
      JSON.stringify(handedBack),
    )

    // ── 過長的標題被截斷，但完整標題不遺失（tooltip 拿得到）
    //
    // 截斷是**呈現上**的取捨，不是資料的遺失 —— 斷言必須成對：標籤真的被截短了，**而且**
    // 完整標題仍可自該元素的提示取得。只驗前者，一個把標題直接砍掉的實作也會通過。
    const longTitle = 'a-very-long-pty-title-that-definitely-exceeds-the-label-budget'
    await realClick(app.client, claudeTermRect)
    await sleep(200)
    await typeLine(app.client, `printf '\\033]0;${longTitle}\\007'`)

    const truncated = await pollUntil(
      app.client,
      `(() => {
        const tab = document.querySelector('[aria-label="${copy('sessions.tabs')}"] [role="tab"]')
        if (!tab) return null
        return { label: tab.innerText.replace(/\\s+/g, ' ').trim(), title: tab.getAttribute('title') ?? '' }
      })()`,
      (value) => value?.title?.includes('${longTitle}'.slice(0, 20)),
      8000,
    )
    check(
      results,
      `${label}：過長的標題被截斷，但完整標題仍可自提示取得`,
      truncated !== null &&
        !truncated.label.includes(longTitle) &&
        truncated.label.includes('…') &&
        truncated.title.includes(longTitle),
      `標籤=${truncated?.label} 提示=${String(truncated?.title).slice(0, 70)}`,
    )

    // ── 清空名稱 ＝ 交還命名權（claude 的往返已於上面的對照組驗過）
    //
    // login shell 的 session：回到**本地標籤**，即使它的 pty 曾宣告過標題（那些標題一律被丟棄）。
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)

    const shellTab = center(await app.client.evaluate(TAB_RECT(1)))
    await realMouse(app.client, shellTab.x, shellTab.y, 'right')
    await pollUntil(app.client, MENU_IN_VIEWPORT, (value) => value !== null, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await sleep(300)
    await app.client.send('Input.insertText', { text: 'named-shell' })
    await pressEnter(app.client)
    await pollUntil(app.client, TAB_LABELS, (value) => value[1]?.includes('named-shell'), 6000)

    await realMouse(app.client, shellTab.x, shellTab.y, 'right')
    await pollUntil(app.client, MENU_IN_VIEWPORT, (value) => value !== null, 4000)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await sleep(300)
    await app.client.send('Input.insertText', { text: '' })
    await pressEnter(app.client)

    const clearedShell = await pollUntil(
      app.client,
      TAB_LABELS,
      (value) => !value[1]?.includes('named-shell'),
      6000,
    )
    check(
      results,
      `${label}：login shell 的 session 清空名稱後回到本地標籤`,
      clearedShell[1]?.includes('shell'),
      JSON.stringify(clearedShell),
    )

    // ── reload：舊 pty 必須全數釋放（design D2），而 session 會被**重建**（session-persistence）
    //
    // 這是最容易漏的一條：reload 不銷毀 webContents，只掛 'destroyed' 的清理不會觸發，
    // 舊 pty 會變孤兒，且新頁面的 xterm 再也收不到它們的輸出。
    //
    // **判準是「先前那些 pid 不再存在」，不是「pty 的數量為 0」。** session-restore 之後，重建會
    // 立刻為被顯示的那個 session 起一個**新的** pty —— 數量只會在一個幾毫秒的窗口裡回到 0。
    // 這條斷言原本寫的正是「數量為 0」，它於是變成在賭一場競態；而它下面那條「分頁列回到空狀態」
    // 更是直接與新規格相反（我們刻意要把分頁重建回來），卻靠著同一場競態繼續是綠的 ——
    // **探針的斷言會隨規格過期**（同 probe:shell 與 probe:workspace 的教訓）。
    const tabsBeforeReload = await app.client.evaluate(TAB_LABELS)
    const pidsBeforeReload = ptyPids(marker)

    await app.client.send('Page.reload', {})
    await awaitMounted(app.client)

    const orphans = await pollFor({
      read: () => {
        const alive = new Set(ptyPids(marker))
        return pidsBeforeReload.filter((pid) => alive.has(pid))
      },
      settled: (value) => value.length === 0,
      timeoutMs: 10_000,
      interval: 100,
      label: 'reload 後等舊 pty 全數釋放',
    })
    check(
      results,
      `${label}：重新載入釋放先前的所有 pty（不留孤兒）`,
      pidsBeforeReload.length > 0 && orphans.length === 0,
      `先前 pids=${pidsBeforeReload.join(',') || '無'} 殘留=${orphans.join(',') || '無'}`,
    )

    // 重新載入後 session 被重建 —— 分頁、名字、順序原樣回來。
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    const tabsAfterReload = await pollUntil(
      app.client,
      TAB_LABELS,
      (value) => value.length === tabsBeforeReload.length,
      10_000,
    )
    check(
      results,
      `${label}：重新載入後 session 被重建（分頁與名字原樣回來）`,
      JSON.stringify(tabsAfterReload) === JSON.stringify(tabsBeforeReload),
      `之前=${JSON.stringify(tabsBeforeReload)} 之後=${JSON.stringify(tabsAfterReload)}`,
    )

    // ── 關閉視窗：所有 pty 必須被清掉（真的關窗，再回查行程表）
    await sleep(300)
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    const tabsAfterCreate = await pollUntil(
      app.client,
      TABS,
      (value) => value.length === tabsBeforeReload.length + 1,
      8000,
    )
    check(
      results,
      `${label}：重新載入後仍可建立新 session`,
      tabsAfterCreate.length === tabsBeforeReload.length + 1,
      `分頁數=${tabsAfterCreate.length}（重建了 ${tabsBeforeReload.length} 個）`,
    )

    // ── terminal-preferences：GPU 加速可由使用者關閉（逃生口）
    //
    // **插在 runMode 的最後、finally 之前** —— 它會改變偏好與 renderer 狀態，而前面每個段落對
    // session 與版面都有明確的假設（`shell-affordance-tweaks` 的教訓：插入段的位置是承重的）。
    //
    // **走使用者的路徑**（開 Settings → 點勾選 → 存），不打 IPC —— 見 `setGpuViaSettings`。
    const GPU_STATE = `(() => {${RENDER_PATH_PRELUDE}
      const host = hostsOf().find((d) => !d.classList.contains('hidden'))
      if (!host) throw new Error('找不到顯示中的終端')
      return { path: renderPathOf(host), stray: strayCanvasesIn(host) }
    })()`

    // **先在終端裡放一段已知的內容，再切 renderer** —— 否則這條斷言沒有鑑別力。
    //
    // 這一段緊接在「重新載入後仍可建立新 session」之後，於是顯示中的是一個**剛建立、幾乎空白**的
    // session：畫面上只有 shell 的第一個 prompt，而那個 prompt 是**非同步抵達**的。原本的判準是
    // 「複製回來的文字非空」—— 它其實只是在確認 prompt 畫出來了沒，實測因此間歇性失敗（讀到 35 個
    // 全是空白的字元）。**症狀看起來像「關掉 GPU 就把內容弄丟了」，其實是斷言在問一個沒有內容的終端。**
    //
    // 換成一個自己寫進去的標記，兩件事同時解決：內容確定存在（等到它出現才往下走），而且判準從
    // 「有沒有東西」變成「**那一段特定的內容還在不在**」—— 那才是 spec 說的「不遺失既有內容」。
    // 標記用 `echo GPUMARK_$((6*7))`：**回顯裡不含答案**，`GPUMARK_42` 只有真的執行了才會出現。
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, 'echo GPUMARK_$((6*7))')
    const beforeGpuOff = await pollUntilText(
      () => readTerminalText(app.client),
      (text) => text.includes('GPUMARK_42'),
      10_000,
    )
    check(
      results,
      `${label}：切換 renderer 前，終端裡確實有一段已知內容`,
      beforeGpuOff.includes('GPUMARK_42'),
      `讀回=${JSON.stringify(beforeGpuOff.slice(-60))}`,
    )

    await setGpuViaSettings(app.client, false)
    const gpuOff = await pollUntil(app.client, GPU_STATE, (v) => v.path === 'glyph', 5000)
    check(
      results,
      `${label}：關閉 GPU 加速後，終端退回不倚賴 GPU 的渲染路徑`,
      gpuOff.path === 'glyph',
      `渲染路徑=${gpuOff.path}（共用暫存畫布 ${gpuOff.stray} 個 —— 不進判準）`,
    )

    // 關掉 GPU **不得遺失終端既有的內容**（spec 明文要求）。判準走複製路徑 —— 它跨 renderer 不變。
    const afterGpuOff = await pollUntilText(
      () => readTerminalText(app.client),
      (text) => text.includes('GPUMARK_42'),
      8000,
    )
    check(
      results,
      `${label}：關閉 GPU 加速不遺失終端既有的內容`,
      afterGpuOff.includes('GPUMARK_42'),
      `退回 DOM renderer 後讀回=${JSON.stringify(afterGpuOff.slice(-60))}`,
    )

    // 開回來 —— 並確認它真的又是 GPU 了（不是「關了就回不去」）。
    await setGpuViaSettings(app.client, true)
    const gpuOn = await pollUntil(app.client, GPU_STATE, (v) => v.path === 'programmatic', 5000)
    check(
      results,
      `${label}：重新開啟 GPU 加速後，終端回到 GPU renderer`,
      gpuOn.path === 'programmatic',
      `渲染路徑=${gpuOn.path}（共用暫存畫布 ${gpuOn.stray} 個 —— 不進判準）`,
    )

    await app.quitGracefully()
    const pidsAfterQuit = await waitForPtyCount(marker, 0, 10_000)
    check(
      results,
      `${label}：關閉視窗終止其所有 pty（不留孤兒行程）`,
      pidsAfterQuit.length === 0,
      `殘留 pids=${pidsAfterQuit.join(',') || '無'}`,
    )
  } finally {
    await app.destroy()
    // app 該清的沒清，才會有殘留 —— 檢查完之後，探針自己收拾乾淨，不留垃圾給下一輪。
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經沒了
      }
    }
  }
}

/** 快照是 debounce 2 秒後才落盤的 —— 要等過它，否則量到的是「還沒寫」而不是「寫錯了」。 */
const SNAPSHOT_SETTLE_MS = 3200

/** 等到帶 marker 的 pty 全部消失（app 自己清乾淨，或我們自己收拾）。 */
async function waitPtysGone(marker, timeoutMs = 10_000) {
  const pids = await pollFor({
    read: () => ptyPids(marker),
    settled: (value) => value.length === 0,
    timeoutMs,
    interval: 100,
    label: 'waitPtysGone（等所有 pty 消失）',
  })
  return pids.length === 0
}

/**
 * session 跨「關閉並重新開啟應用程式」存活（session-persistence）。
 *
 * **與 `runMode` 分開走一遍完整生命週期**：建立 session → 關掉 app → 以**同一個 profile** 重新
 * 啟動 → 斷言重建。分開是因為那支已經有 108 條斷言、且對真滑鼠座標與時序極其敏感，而這裡要
 * 反覆重啟 app；把兩者攪在一起，任何一邊的 flake 都會汙染另一邊的結論。
 */
async function runRestore(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（session 重建）──`)

  const marker = `spek-restore-${process.pid}-${Date.now()}`
  const { repo, out } = makeFixture()
  const sub = join(repo, 'packages', 'app')
  mkdirSync(sub, { recursive: true })
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()

  let app = null
  try {
    // ── 第一次啟動：建立兩個 session，讓它們留下足以辨識的痕跡
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    await openSessionViaMenu(app.client, copy('sessions.spawnClaude'))
    await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)

    // claude 目標：以我們指定的對話識別碼啟動（--session-id）—— 於是它可以被持久化並在下次續接。
    await waitForPtyCount(marker, 1)
    const firstCalls = stub.calls()
    const first = conversationOf(firstCalls[0])
    const conversation = first?.id ?? ''
    check(
      results,
      `${label}：新建的 claude session 以我們指定的對話識別碼啟動`,
      firstCalls.length === 1 && first?.mode === 'session-id',
      `argv=${JSON.stringify(firstCalls)}`,
    )

    // 使用者命名 —— 重建後必須原樣回來。
    await openTabMenu(app.client, 0)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await sleep(300)
    await app.client.send('Input.insertText', { text: 'agent-a' })
    await pressEnter(app.client)
    await pollUntil(app.client, TAB_LABELS, (value) => value[0]?.includes('agent-a'), 6000)

    // shell 目標：cd 到子目錄、留一行可辨識的輸出 —— 兩者都要跨重啟活下來。
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `cd ${sub}`)
    // **用 `tee`**：`MARK_42` 必須留在**畫面**上（它正是要被快照序列化、稍後重播的東西），
    // 而判準走**檔案**（檔案只有命令真的執行才會出現，畫面分不清回顯與執行）。
    await typeLine(app.client, `echo MARK_$((6*7)) | tee ${join(out, 'mark.txt')}`)
    await waitForFile(join(out, 'mark.txt'), (v) => v.includes('MARK_42'))

    const labelsBefore = await app.client.evaluate(TAB_LABELS)

    // 快照是 debounce 落盤的 —— 不等它，驗到的會是「還沒寫」。
    await sleep(SNAPSHOT_SETTLE_MS)

    await app.quitGracefully()
    check(
      results,
      `${label}：關閉應用程式終止其所有 pty`,
      await waitPtysGone(marker),
      `殘留 pids=${ptyPids(marker).join(',') || '無'}`,
    )


    // ── 第二次啟動：同一個 profile
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)

    const labelsAfter = await pollUntil(
      app.client,
      TAB_LABELS,
      (value) => value.length === labelsBefore.length,
      10_000,
    )
    check(
      results,
      `${label}：重新開啟後 session 原樣重建（分頁、使用者取的名字、順序）`,
      JSON.stringify(labelsAfter) === JSON.stringify(labelsBefore),
      `之前=${JSON.stringify(labelsBefore)} 之後=${JSON.stringify(labelsAfter)}`,
    )

    // **休眠不是結束。** 這條驗的是使用者重開 app 之後看到的第一個畫面。
    const danger = await app.client.evaluate(DANGER_COLOR)
    const status = await app.client.evaluate(TAB_STATUS)
    const dormantTab = status[1] // 分頁 1（shell）此刻仍休眠 —— 只有被顯示的那個會被喚醒
    check(
      results,
      `${label}：休眠的 session 不被呈現為「已結束」`,
      !dormantTab?.title?.includes(copy('sessions.statusExited')) && dormantTab?.dot !== danger,
      `tooltip=${JSON.stringify(dormantTab?.title)} 狀態燈=${dormantTab?.dot}（danger=${danger}）`,
    )

        // **No session has a pty** (session-hibernation): selecting the item displays its focused session
    // dormant. The wait gives a wake-on-display implementation time to show itself.
    await sleep(2000)
    const awake = ptySessionPids(marker)
    check(
      results,
      `${label}：opening the application starts no session (selecting the item does not wake its focused session)`,
      awake.length === 0,
      `pty count=${awake.length} (rebuilt ${labelsAfter.length}) cmdlines=${JSON.stringify(ptyCmdlines(marker))}`,
    )

    // The Wake button starts it — and only it.
    await clickWake(app.client)
    const wokenByButton = await pollFor({
      read: () => ptySessionPids(marker),
      settled: (pids) => pids.length === 1,
      timeoutMs: 10_000,
      interval: 150,
      label: 'the Wake button starts the displayed session',
    })
    check(
      results,
      `${label}：the Wake button starts the displayed dormant session`,
      wokenByButton.length === 1,
      `pty count=${wokenByButton.length}`,
    )

        // 被喚醒的是 claude —— 它續接**同一個**對話（--resume，沿用原 id）。
    // The stub logs its start a moment after its pid appears: wait for the second call.
    const resumeCalls = await pollFor({
      read: () => stub.calls(),
      settled: (calls) => calls.length >= 2,
      timeoutMs: 10_000,
      interval: 150,
      label: 'the woken claude logs its start',
    })
    check(
      results,
      `${label}：重建的 claude session 續接同一個對話（--resume 同一個 id）`,
      resumeCalls.length === 2 &&
        conversationOf(resumeCalls[1])?.mode === 'resume' &&
        conversationOf(resumeCalls[1])?.id === conversation,
      `argv=${JSON.stringify(resumeCalls)}`,
    )

    // claude **不重播快照** —— 它自己會重現對話，重播會讓使用者看到兩份歷史。
    //
    // **這是一條否定式斷言**（「畫面上**沒有**分隔線」）—— 讀不到終端時它會靜默通過。
    // `readTerminalText` 複製不成就丟錯（哨兵內建），這裡再明寫一次「內容非空」：
    // 「沒有分隔線」只有在「確實讀到了東西」的前提下才有意義。
    const claudeText = await readTerminalText(app.client)
    check(
      results,
      `${label}：claude session 不重播快照（否則歷史會出現兩份）`,
      !claudeText.includes(copy('sessions.replaySeparator')) && claudeText.trim() !== '',
      `終端內容（${claudeText.length} 字元）=${JSON.stringify(claudeText.slice(0, 80))}`,
    )

    // ── **再關一次、再開一次，全程不碰那個休眠的 shell session。**
    //
    // 驗兩件事：(1) 未喚醒的休眠 session 於再次重啟後仍然存在；(2) 它**不會把重播的歷史再序列化
    // 回自己的快照** —— 那個 xterm 裡此刻已經有「歷史 + 分隔線」了，若關窗時照樣 serialize，
    // 下次重播就會再追加一條分隔線。使用者一路不碰它，每重開一次就多一條。
    await app.quitGracefully()
    await waitPtysGone(marker)

    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    const labelsAgain = await pollUntil(
      app.client,
      TAB_LABELS,
      (value) => value.length === labelsBefore.length,
      10_000,
    )
    check(
      results,
      `${label}：未喚醒的休眠 session 於再次重啟後仍然存在`,
      JSON.stringify(labelsAgain) === JSON.stringify(labelsBefore),
      `分頁=${JSON.stringify(labelsAgain)}`,
    )

    /*
      **「存在」與「仍為休眠」是兩件事，而上一條只驗了前者。**

      分頁標籤相同只證明它沒有消失 —— 一個「重建時把全部 session 都喚醒」的實作在那條斷言下
      **照樣全綠**，而那正是「開啟應用程式至多啟動一個 session」要防的事。

      這裡在點擊之前先量一次 pty 數：只有被顯示的那一個該有 pty。緊接其後的等待是
      `pids.length === 2`，若它們早就都醒了，那個等待會**立刻收斂** —— 於是連下一條也一起假綠。
    */
        // The wait gives a wake-on-display (or wake-everything) implementation time to show itself.
    await sleep(2000)
    const dormantPids = ptySessionPids(marker)
    check(
      results,
      `${label}：after another restart no session has started`,
      dormantPids.length === 0,
      `pty count=${dormantPids.length} (tabs ${labelsAgain.length})`,
    )

    // ── Ctrl+Tab onto the dormant shell: it is displayed, and still has no pty.
    // By keyboard on purpose: the focus rule is what lets Enter wake it without a click.
    await pressCtrlTab(app.client)
    const wakeFocused = await pollUntil(app.client, WAKE_FOCUSED, (value) => value === true, 8000)
    await sleep(800)
        const afterSwitch = ptySessionPids(marker)
    // The switch must have happened, or "no pty" says nothing: the shell's tab is the selected one.
    const switchedTabs = await app.client.evaluate(TABS)
    check(
      results,
      `${label}：displaying a dormant session by keyboard does not start it`,
      afterSwitch.length === 0 && switchedTabs[1]?.selected === true,
      `pty count=${afterSwitch.length} selected=${JSON.stringify(switchedTabs.map((tab) => tab.selected))}`,
    )
    check(
      results,
      `${label}：the Wake button of a dormant session switched to by keyboard has focus`,
      wakeFocused === true,
      `activeElement=${JSON.stringify(await app.client.evaluate('document.activeElement?.outerHTML?.slice(0, 120)'))}`,
    )

        // Enter wakes it — no click in between.
    await pressEnter(app.client)
    // The pty exists before the renderer hears the wake succeeded; typing in between reaches nothing
    // (there is no terminal to focus yet). Wait for the tab to show it running.
    await awaitRunning(app.client, 1)
    const woken = await pollFor({
      read: () => ptySessionPids(marker),
      settled: (pids) => pids.length === 1,
      timeoutMs: 10_000,
      interval: 150,
      label: 'Enter wakes the displayed dormant session',
    })
    check(
      results,
      `${label}：Enter wakes the displayed dormant session`,
      woken.length === 1,
      `pty count=${woken.length}`,
    )

    // Typing reaches it with no click either: focus moved from the Wake button to the terminal.
    // The file is written only if the command ran, and its content is where the shell started.
    const rebornCwdFile = join(out, 'reborn-cwd.txt')
    await typeLine(app.client, `pwd > ${rebornCwdFile}`)
    const cwdText = await waitForFile(rebornCwdFile, (value) => value.trim().startsWith('/'), 10_000)
    check(
      results,
      `${label}：typing after a keyboard wake reaches the session`,
      cwdText.trim().startsWith('/'),
      `file content=${JSON.stringify(cwdText.trim())}`,
    )

    // 上次的畫面被重播，且與 live 明確區分。
    const replayed = await pollTerminalText(app.client, (value) => value.includes('MARK_42'), 10_000)
    // **順序也要驗，不能只驗「這些字串都在」。**
    //
    // 只斷言 `includes('MARK_42')` 的版本，對一個把畫面弄壞的實作照樣是綠的：`?1049l` 曾把游標
    // 拉回左上角，於是分隔線蓋掉了歷史的第二行、live 的 prompt 又蓋掉第三行 —— `MARK_42` 仍然
    // 「存在」（雖然它變成了 `RK_42` 且跑到分隔線後面）。**歷史必須完整，且整段在分隔線之前。**
    const historyEnd = replayed.indexOf(copy('sessions.replaySeparator'))
    const history = historyEnd === -1 ? '' : replayed.slice(0, historyEnd)
    check(
      results,
      `${label}：重建的 shell session 完整顯示上次的畫面`,
      history.includes('MARK_42') && history.includes('echo MARK_'),
      `分隔線之前的內容=${JSON.stringify(history.slice(-120))}`,
    )
    check(
      results,
      `${label}：重播的歷史與 live 內容明確區分`,
      historyEnd !== -1,
      '缺少分隔 —— 使用者會以為那個 shell 還活著',
    )

    // 經過兩次「重建但不喚醒」之後，分隔線仍然**恰好一條**。
    const separators = replayed.split(copy('sessions.replaySeparator')).length - 1
    check(
      results,
      `${label}：休眠期間不把重播的歷史再序列化回快照（分隔線不累積）`,
      separators === 1,
      `分隔線數量=${separators}（每重開一次就多一條，表示休眠中的終端把自己的重播內容寫回了快照）`,
    )

        // shell 於**最後已知的工作目錄**重生（不是 folder 根目錄）。
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    check(
      results,
      `${label}：重建的 shell session 於最後已知的工作目錄重生`,
      cwdText.trim() === sub,
      `期待 ${sub}；實得 ${JSON.stringify(cwdText.trim())}`,
    )

    // 喚醒之後，pty 最終要拿到終端真正的尺寸（而不是 spawn 時的 80 欄）。
    //
    // **這條擋的是「完全沒有人告訴 pty 尺寸」的回歸，它證明不了那個競態被修好了。**
    // dogfooding 抓到的 bug 是：`active` 的 effect 先 `fit()` 成功（量到 63）→ 送出 resize →
    // **pty 還不存在，被丟掉** → 而 `lastCols` 已記成 63，之後 ResizeObserver 的 `fit()` 一律回
    // `null`，於是 pty 一輩子停在 80 欄。但**走不走到這條路，取決於 xterm 何時量到字元尺寸** ——
    // 探針一直走另一條（`fit()` 當下回 null → ResizeObserver 事後補救成功）。**對照組證實：把修正
    // 拿掉，這條斷言照樣是綠的。** 真正的防護是 `TerminalView` 裡「pty 一誕生就告訴它當下尺寸」
    // 的那個 effect，它由 code review 與 design 承擔（比照 OSC 8 linkHandler 的先例）。
    //
    // 判準是「**不等於 spawn 的預設值 80**」，不是「大於 80」—— 探針視窗裡終端的真實寬度是 60 幾欄。
    // 判準走檔案（回顯與執行的區別由檔案的存在與否承擔，不再倚賴「回顯裡不含答案」的巧思）。
    const wakeColsFile = join(out, 'wake-cols.txt')
    await typeLine(app.client, `stty size | cut -d' ' -f2 > ${wakeColsFile}`)
    const colsText = await waitForFile(wakeColsFile, (value) => /\d/.test(value), 10_000)
    const cols = Number(colsText.trim() || 0)
    check(
      results,
      `${label}：喚醒的 session 其 pty 最終取得終端的真實尺寸（不是 spawn 時的 80 欄）`,
      cols > 0 && cols !== 80,
      `pty 的欄數=${cols}（停在 80 就表示喚醒之後沒有人告訴過它真正的尺寸）`,
    )

    // ── 已結束的 session 不持久化
    await typeLine(app.client, 'exit')
    await pollUntil(
      app.client,
      TABS,
      (value) => value.some((tab) => tab.label?.includes(copy('sessions.exitedBadge')) || true),
      3000,
    ).catch(() => {})
    await sleep(800)
    await app.quitGracefully()
    await waitPtysGone(marker)

    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    const afterExit = await pollUntil(app.client, TAB_LABELS, (value) => value.length >= 1, 10_000)
    check(
      results,
      `${label}：已結束的 session 不被持久化（重開後不出現）`,
      afterExit.length === 1 && afterExit[0].includes('agent-a'),
      `分頁=${JSON.stringify(afterExit)}`,
    )
    await app.quitGracefully()
    await waitPtysGone(marker)
    app = null

    // ── 損毀韌性：整份無法解析 → app 照常啟動、無 session、原檔保留
    //
    // **這一族的斷言在前提不成立時仍然可能通過**：讀到一份正常的檔案，同樣會得到「照常啟動、
    // 沒有隔離檔」。issue #8 就是這麼發生的 —— 主行程收尾時的原子寫（暫存檔 ＋ rename）落在
    // 這次 `writeFileSync` 之後，損毀內容被蓋掉，於是這一段驗到的是「正常啟動」。
    // 關閉端已改為等到主行程確實結束（`quitGracefully`），下面兩條不變式讓它**下次再發生時
    // 看得見**。
    const corruptContent = '{ 損毀的內容'
    writeFileSync(join(profile, 'sessions.json'), corruptContent)

    // 不變式一：啟動之前，磁碟上那一份確實仍是損毀的。
    const onDiskBeforeLaunch = readFileSync(join(profile, 'sessions.json'), 'utf8')
    check(
      results,
      `${label}：重新啟動前，持久化檔案確實仍是損毀的（否則下一條驗的是正常啟動）`,
      onDiskBeforeLaunch === corruptContent,
      `磁碟上讀回=${JSON.stringify(onDiskBeforeLaunch.slice(0, 40))}`,
    )

    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(1200)
    const tabsAfterCorrupt = await app.client.evaluate(TAB_LABELS)
    const quarantined = readdirSync(profile).filter((entry) => entry.includes('.corrupt-'))
    check(
      results,
      `${label}：持久化檔案損毀時應用程式照常啟動，且原檔保留`,
      tabsAfterCorrupt.length === 0 && quarantined.length === 1,
      `分頁=${tabsAfterCorrupt.length} 隔離檔=${quarantined.join(',') || '無'}`,
    )

    // 不變式二：被隔離的那一份，內容就是我們寫進去的那一份。
    //
    // **上一條不變式只覆蓋一半的時序** —— 覆蓋若發生在它之後、啟動之前，它照樣是綠的。
    // 這一條在任何時序下都成立，而它證明的正是這一段宣稱在驗的東西：**被隔離的是那份損毀的
    // 檔案**，不是別的東西。
    const quarantinedContent =
      quarantined.length === 1 ? readFileSync(join(profile, quarantined[0]), 'utf8') : null
    check(
      results,
      `${label}：被隔離的正是我們寫進去的那一份損毀內容`,
      quarantinedContent === corruptContent,
      quarantined.length === 1
        ? `隔離檔=${quarantined[0]} 內容=${JSON.stringify(quarantinedContent?.slice(0, 40))}`
        : `沒有唯一的隔離檔（${quarantined.length} 個）—— 這條沒有鑑別力`,
    )
    await app.quitGracefully()
    await waitPtysGone(marker)
    app = null
  } finally {
    if (app) await app.destroy()
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經走了
      }
    }
  }
}

/**
 * 續接失敗的自癒，以及「非正常結束仍保有最近一次快照」。
 *
 * 這兩條各自需要一個**不同的 stub**（`resumeFails`）或一次**非正常的死法**（SIGKILL），因此獨立
 * 一段，不與上面那段共用 app。
 */
async function runHealAndCrash(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（自癒與非正常結束）──`)

  const marker = `spek-heal-${process.pid}-${Date.now()}`
  const { repo, out } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  // 這支 stub 對 `--resume` 一律以非零碼結束 —— 正是「從未與該 session 對話過」時 claude 的行為。
  const stub = makeStubClaude({ resumeFails: true })

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    await openSessionViaMenu(app.client, copy('sessions.spawnClaude'))
    await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)
    await waitForPtyCount(marker, 1)
    const created = conversationOf(stub.calls()[0])?.id ?? ''

    await openTabMenu(app.client, 0)
    await realClick(app.client, await app.client.evaluate(MENU_ITEM_RECT(copy('sessions.rename'))))
    await sleep(300)
    await app.client.send('Input.insertText', { text: 'healme' })
    await pressEnter(app.client)
    await pollUntil(app.client, TAB_LABELS, (value) => value[0]?.includes('healme'), 6000)

    await app.quitGracefully()
    await waitPtysGone(marker)

        // ── 重新開啟：--resume 會失敗（沒有對話可續）→ 必須自癒成一個全新的對話
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await pollUntil(app.client, TAB_LABELS, (value) => value.length === 1, 10_000)
    await clickWake(app.client)


    const healed = await pollFor({
      read: () => stub.calls(),
      settled: (calls) => calls.length >= 3,
      timeoutMs: 15_000,
      interval: 200,
      label: '等 stub claude 的第三次呼叫（--resume 失敗後的自癒）',
    })

    check(
      results,
      `${label}：續接失敗時以全新的對話識別碼自癒（不沿用舊 id —— 那會撞號）`,
      healed.length === 3 &&
        conversationOf(healed[1])?.mode === 'resume' &&
        conversationOf(healed[1])?.id === created &&
        conversationOf(healed[2])?.mode === 'session-id' &&
        conversationOf(healed[2])?.id !== created,
      `argv=${JSON.stringify(healed)}`,
    )

    // 身分不變：分頁還在、名字還在、session 可用。
    const healedLabels = await app.client.evaluate(TAB_LABELS)
    check(
      results,
      `${label}：自癒不改變 session 的身分（分頁與名字不變）`,
      healedLabels.length === 1 && healedLabels[0].includes('healme'),
      `分頁=${JSON.stringify(healedLabels)}`,
    )
    check(
      results,
      `${label}：自癒後的 session 有一個活著的 pty`,
      ptySessionPids(marker).length === 1,
      `已喚醒 ${ptySessionPids(marker).length} 個 session`,
    )

    // 啟動的嘗試不超過兩次 —— claude 若根本起不來，不可反覆重試。
    await sleep(1500)
    check(
      results,
      `${label}：自癒至多一次（啟動的嘗試不超過兩次）`,
      stub.calls().length === 3,
      `argv=${JSON.stringify(stub.calls())}`,
    )

    // **自癒重生的 pty 也必須拿到終端的真實尺寸。**
    //
    // 自癒對 renderer **完全不可見**（`status` 一直是 `running`）—— 那個「pty 誕生時推尺寸」的
    // effect 不會重跑，`fit()` 又因「尺寸沒變」回 `null`。少了「繼承將死那顆 pty 的尺寸」，自癒
    // 出來的 pty 一輩子停在 80×24。**而自癒是主線情境**（沒跟 claude 講過話的 session，續接必定
    // 失敗），這條路上的尺寸壞掉比 wake 那條更常被看到。
    //
    // stub claude 自己 `exec "$SHELL" -i`，所以這個 session 是個可以打字的互動 shell。
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    const healedColsFile = join(out, 'healed-cols.txt')
    await typeLine(app.client, `stty size | cut -d' ' -f2 > ${healedColsFile}`)
    const healedCols = Number(
      (await waitForFile(healedColsFile, (value) => /\d/.test(value), 10_000)).trim() || 0,
    )
    check(
      results,
      `${label}：自癒重生的 pty 也採用終端的真實尺寸（不是 spawn 時的 80 欄）`,
      healedCols > 0 && healedCols !== 80,
      `pty 的欄數=${healedCols}（停在 80 就表示自癒那條路沒有把尺寸帶過去）`,
    )

    // ── 被竄改的對話識別碼絕不可被拼進命令
    await app.quitGracefully()
    await waitPtysGone(marker)

    const persisted = JSON.parse(readFileSync(join(profile, 'sessions.json'), 'utf8'))
    const pwned = join(repo, 'pwned')
    persisted.sessions[0].claudeSessionId = `x; touch ${pwned}`
    writeFileSync(join(profile, 'sessions.json'), JSON.stringify(persisted))

        app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await clickWake(app.client)
    await waitForPtyCount(marker, 1)
    await sleep(800)

    const afterTamper = stub.calls().slice(3)
    check(
      results,
      `${label}：被竄改的對話識別碼不進入命令，該 session 以全新對話重建`,
      !existsSync(pwned) &&
        afterTamper.length === 1 &&
        conversationOf(afterTamper[0])?.mode === 'session-id',
      `注入的檔案存在=${existsSync(pwned)} argv=${JSON.stringify(afterTamper)}`,
    )

    // ── 非正常結束（SIGKILL）：最近一次快照仍在
    await app.quitGracefully()
    await waitPtysGone(marker)

    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await pollUntil(app.client, TABS, (value) => value.length === 1, 10_000)

    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `echo CRASH_$((8*8)) | tee ${join(out, 'crash.txt')}`)
    await waitForFile(join(out, 'crash.txt'), (v) => v.includes('CRASH_64'))

    // 滾動快照是 debounce 落盤的 —— 等過它，然後**不給 app 任何收尾的機會**。
    await sleep(SNAPSHOT_SETTLE_MS)
    await app.destroy()
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經走了
      }
    }
    app = null
    await sleep(500)

    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await pollUntil(app.client, TAB_LABELS, (value) => value.length === 2, 10_000)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(1)))

    const crashText = await pollTerminalText(app.client, (value) => value.includes('CRASH_64'), 10_000)
    check(
      results,
      `${label}：應用程式被強制結束後，最近一次快照仍可還原畫面`,
      String(crashText).includes('CRASH_64'),
      // 這條擋住「只在關閉視窗時才序列化」的實作 —— SIGKILL 收不到任何收尾的機會。
      `終端內容=${JSON.stringify(String(crashText).slice(-120))}`,
    )
  } finally {
    if (app) await app.destroy()
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經走了
      }
    }
  }
}

/**
 * 關掉 app 時終端正處於 **alternate screen**（開著 vim）或**滑鼠追蹤**模式 —— 重播不得讓**新的**
 * shell 卡在那個模式裡。
 *
 * 歷史是死的文字，live 不該繼承它的狀態。卡住的症狀很難懂：新 shell 的輸出**看不見**（它被畫到
 * 另一個緩衝區去了），使用者只會覺得「終端壞了」。
 */
async function runAltScreen(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（alternate screen 的殘留）──`)

  const marker = `spek-alt-${process.pid}-${Date.now()}`
  const { repo, out } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))

    // 進入 alternate screen（`?1049h`）並開啟滑鼠追蹤（`?1003h`）—— 這正是 vim 開著時的狀態。
    await typeLine(
      app.client,
      `printf '\\033[?1049h\\033[?1003h'; echo INSIDE_ALT | tee ${join(out, 'alt.txt')}`,
    )
    await waitForFile(join(out, 'alt.txt'), (v) => v.includes('INSIDE_ALT'))

    await sleep(SNAPSHOT_SETTLE_MS)
    await app.quitGracefully()
    await waitPtysGone(marker)

    // ── 重開：新的 shell 必須是可用的
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
        await pollUntil(app.client, TABS, (value) => value.length === 1, 10_000)
    await clickWake(app.client)
    await waitForPtyCount(marker, 1)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))

    // 回顯不含答案 —— 只有真的執行了才會出現 `ALT_OK_81`。
    await typeLine(app.client, 'echo ALT_OK_$((9*9))')
    const text = String(
      await pollTerminalText(app.client, (value) => value.includes('ALT_OK_81'), 10_000),
    )

    // **判準是「normal buffer 的歷史看得見」，不是「新 shell 的輸出看得見」。**
    //
    // 後者是個假綠（對照組證明過）：卡在 alternate buffer 裡的 shell，它的輸出**照樣看得見**
    // —— 只是被畫在 vim 的那塊畫面上。使用者失去的是**歷史與 scrollback**（normal buffer 被
    // 蓋住了）。真正有鑑別力的是那行 `printf` —— 它在 normal buffer 裡，只有真的離開了
    // alternate buffer 才看得到它。
    check(
      results,
      `${label}：關閉時處於 alternate screen，重建後離開它（歷史與 scrollback 都還在）`,
      text.includes('printf') && text.includes('ALT_OK_81'),
      `終端內容=${JSON.stringify(text.slice(-160))}`,
    )
  } finally {
    if (app) await app.destroy()
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經走了
      }
    }
  }
}

/**
 * **休眠的 session 絕不能只是一塊空白終端**（session-persistence 明文要求）。
 *
 * 這條原本是零覆蓋的 —— 而它是壞的：休眠提示是 host div 的 React child，xterm 的 `.xterm`
 * （`position: relative`）由 `handle.open(host)` 在 effect 裡 append，**排在 React children 之後**。
 * 兩者都是 `z-index: auto` → 依 tree order 繪製 → **xterm 蓋在提示上**，而 `.xterm-viewport`
 * 的背景是不透明的。休眠的 claude 分頁於是看起來就是一塊空白終端。
 *
 * **載體：folder 的路徑失效。** 休眠的 session 一被顯示就會醒過來，那個提示只是一瞬間 ——
 * 除非它**醒不過來**。路徑失效時 `create` 以 FOLDER_UNAVAILABLE 拒絕，session 停在休眠態並
 * 呈現原因。這給了一個穩定可觀察的休眠畫面，同時也驗到了「喚醒失敗要說明原因，而不是靜默
 * 地什麼都不發生」。
 *
 * 判準是 `elementFromPoint` —— 只有真的畫在最上層才拿得到它。斷言「DOM 裡有這個節點」是驗不到
 * 堆疊順序的（它一直都在，只是被蓋住）。
 */
async function runDormantHint(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（休眠的呈現）──`)

  const marker = `spek-hint-${process.pid}-${Date.now()}`
  const { repo } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()

  // 直接種一份持久化的 session，然後把 repo 目錄整個刪掉 —— folder 仍在 workspace 裡，但路徑失效。
  writeFileSync(
    join(profile, 'sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: '9f1e7a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
          folderId: 'f1',
          spawnTarget: 'claude',
          ordinal: 1,
          customTitle: 'ghost',
        },
      ],
    }),
  )
  rmSync(repo, { recursive: true, force: true })

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await pollUntil(app.client, TABS, (value) => value.length === 1, 10_000)

        // 顯示它 → 按「喚醒」 → folder 路徑失效 → 停在休眠態並說明原因。
    await clickWake(app.client)
    const hint = await pollUntil(
      app.client,
      `(() => {
        const term = document.querySelector('section[aria-label="${copy('stage.terminal')}"]')
        if (!term) return null
        const box = term.getBoundingClientRect()
        // 終端正中央實際被畫在最上層的是誰？
        const top = document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height / 2),
        )
                // The failure card holds a Wake button (the retry), which sits at the center: read the card.
        const card = top?.closest('.z-10') ?? top
        return top ? { text: card.innerText ?? '', className: String(top.className ?? '') } : null
      })()`,
            // Wait for the failure itself: right after Wake the card still shows the dormant state.
      (value) => Boolean(value?.text?.includes(prefixOf('sessions.wakeFailed'))),
      12_000,
    ).catch(() => null)

    check(
      results,
      `${label}：休眠的 session 不呈現為一塊空白終端（提示畫在最上層）`,
      Boolean(hint?.text) && !hint.className.includes('xterm'),
      `終端中央最上層的元素=${JSON.stringify(hint)}`,
    )
    check(
      results,
      `${label}：喚醒失敗時說明原因，而不是靜默地什麼都不發生`,
      Boolean(hint?.text?.includes(prefixOf('sessions.wakeFailed'))),
      `提示內容=${JSON.stringify(hint?.text)}`,
    )
    check(
      results,
      `${label}：喚醒失敗的 session 不留下任何 pty`,
      ptyPids(marker).length === 0,
      `殘留 pids=${ptyPids(marker).join(',') || '無'}`,
    )
  } finally {
    if (app) await app.destroy()
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經走了
      }
    }
  }
}


/**
 * agent 狀態橋接（`claude-status-bridge`）。
 *
 * 這一段驗的是 spekterm 這半：**注入是否發生、注入的命令能不能用、關掉之後是否真的不注入**。
 * agent 那半（payload 的欄位怎麼算出來的）不是我們的實作，也不該由這裡負責。
 *
 * stub claude 會照著我們注入的 `--settings` 真的跑一次 statusLine 命令（見 `makeStubClaude`）——
 * 只斷言「argv 裡有 --settings」證明不了那個命令能用：落點對不對、寫不寫得成、環境變數有沒有
 * 傳到，都要它真的跑過一次才知道。
 */
async function runAgentStatus(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（agent 狀態橋接）──`)

  const { repo } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude({ honorSettings: true })

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, stub })
    // 選中 folder，分頁列（與「+」）才存在。
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)

    // 預設啟用 —— 不動任何偏好，直接建一個 claude session。
    await openSessionViaMenu(app.client, copy('sessions.spawnClaude'))
    const injected = await pollUntil(
      app.client,
      'true',
      () => stub.calls().some((line) => line.includes('--settings')),
      10_000,
    ).then(() => stub.calls())
    check(results, '預設啟用：spawn claude 時注入 --settings',
      injected.some((line) => line.includes('--settings')), injected.join(' | '))

    // 端到端：stub 跑了注入的命令 → payload 落到我們指定的位置 → 狀態列呈現它的欄位。
    const statusText = await pollUntil(
      app.client,
      `document.querySelector('footer[aria-label="${copy('statusBar.label')}"]')?.textContent ?? ''`,
      (text) => text.includes(STUB_MODEL_NAME),
      15_000,
    )
    check(results, '注入的命令可用：agent 的狀態抵達狀態列',
      statusText.includes(STUB_MODEL_NAME), statusText)
    check(results, '狀態列以 payload 回報的 window 大小算出 context 百分比',
      statusText.includes('25%'), statusText)

    // 關掉偏好 → **其後**建立的 session 不再被注入。
    //
    // **這裡直接打 settings IPC 是正確的**，與「驗字型偏好必須走設定對話框」那條教訓不衝突：
    // 字型的權威在 renderer 的 PreferencesProvider state（effect 靠它驅動），繞過它就驗不到；
    // 而注入是**主行程在 spawn 當下**讀偏好 store 決定的 —— store 就是權威。
    await app.client.evaluate('window.workspace.settings.setAgentStatus(false)')
    const before = stub.calls().length
    await openSessionViaMenu(app.client, copy('sessions.spawnClaude'))
    const after = await pollUntil(
      app.client,
      'true',
      () => stub.calls().length > before,
      10_000,
    ).then(() => stub.calls())
    /*
      **判準是「設定裡沒有狀態列命令」，不是「命令列上沒有 `--settings`」。**

      `agent-transcript-view` 起，同一個接縫有兩個功能在用（狀態回報與事件回報），而規格明文
      要求兩者的啟用狀態**彼此獨立**：關掉狀態列 SHALL NOT 連帶關掉事件回報。於是關掉偏好之後
      `--settings` 仍然在，只是那份設定裡**沒有 `statusLine`**。

      此前這條斷言以 argv 判定，於是它把「沒有狀態列」與「沒有那個旗標」混為一談 ——
      **一旦第二個功能接上同一個接縫，它就會紅，而產品其實是對的。**
      改以設定檔的內容判定，同時也是更強的斷言：它驗的是注入的東西本身。
    */
    const disabledSettingsPath = (after[after.length - 1]?.match(/--settings (\S+)/) ?? [])[1]
    const disabledSettings = disabledSettingsPath
      ? JSON.parse(readFileSync(disabledSettingsPath, 'utf8'))
      : {}
    check(results, '關閉偏好後，其後建立的 session 不再被注入狀態列命令',
      after.length > before && !('statusLine' in disabledSettings),
      `注入的設定含有：${Object.keys(disabledSettings).join(', ') || '(無)'}`)
  } finally {
    if (app) await app.destroy()
  }
}


/**
 * 續寫入口把指示送進 pty（`artifact-continuation`）。
 *
 * **判準走讀檔，不讀畫面**：stub claude 以 `tee` 把 pty 的輸入串流落盤（見 `makeStubClaude`
 * 的 `logInput`）。這比讀終端內容強兩層 —— 它跨 renderer 不變，而且**看得到 `\r`**：
 * spec 要求的是「送出並執行」，不是「填進去」，而那個差別就只是一個字元。
 */
async function runContinuation(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（續寫入口送出指示）──`)

  const { repo } = makeFixture()
  // 恰一個 active change → 側欄自動錨定它；只有 proposal → **還缺 design／specs**，入口才會出現。
  const slug = 'add-widget'
  mkdirSync(join(repo, 'openspec', 'changes', slug), { recursive: true })
  writeFileSync(join(repo, 'openspec', 'changes', slug, 'proposal.md'), '# Add widget\n\n## Why\n\nBecause.\n')

  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude({ logInput: true })
  const marker = `spek-term-cont-${process.pid}-${Date.now()}`

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await openSessionViaMenu(app.client, copy('sessions.spawnClaude'))
    // **等 pty 真的存在，再點續寫入口。**
    //
    // 續寫是把指示寫進 focused session 的 pty，而 pty 的誕生是非同步的 —— 分頁一出現就點下去，
    // 那則指示會抵達一個還不存在的 pty，被主行程直接丟棄：輸入串流裡什麼都沒有，10 秒後
    // `waitForFile` 逾時回空字串。**症狀是「指示沒送出」，看起來像產品的續寫壞了。**
    // 這一段此前根本沒有傳 marker（於是也無從等待），實測失敗率 2/4。
    // 與「先訂閱、再列目錄」同源：**要作用於一個東西，先確認它已經存在。**
    const ptys = await waitForPtyCount(marker, 1, 15_000)
    check(results, `${label}：續寫入口按下前，session 的 pty 已存在`, ptys.length === 1,
      `pty 行程 ${ptys.length} 個`)

    const CONTINUE_RECT = RECT_OF(`[aria-label="${copy('openspec.continueArtifact')}"]`)
    const btn = await pollUntil(app.client, CONTINUE_RECT, (v) => v !== null, 15_000)
    check(results, `${label}：change 尚缺 artifact 時，側欄呈現續寫入口`, btn !== null)

    await realClick(app.client, btn)

    // 讀檔：pty 的輸入串流裡必須有這則指示，而且**帶著 Enter**（＝真的送出，不是只填入）。
    const sent = await waitForFile(stub.inputLog, (value) => value.includes(slug), 10_000)
    check(results, `${label}：指示抵達 pty，且指名了側欄當下的 change`, sent.includes(slug),
      JSON.stringify(sent))
    check(results, `${label}：指示以 Enter 結尾（送出，而不是只填入）`,
      /\r|\n/.test(sent.slice(sent.indexOf(slug))), JSON.stringify(sent.slice(-40)))
  } finally {
    if (app) await app.destroy()
  }
}

/**
 * 某個 change 之來源工作目錄的識別碼 —— **向產品要，不自己算**。
 *
 * 走的是側欄真正在用的那條路徑（`getChanges` 的來源徽章）。探針若自己對路徑做 sha1，
 * 那就是一份平行實作：core 換演算法時它會**靜默地**與產品分歧，而斷言仍然全綠 ——
 * 因為兩邊各自用自己的 key。
 *
 * 這也正是產品的入口取得 key 的方式（design D1：從側欄的 change 觸發）。
 */
async function worktreeKeyOfChange(client, folderId, slug) {
  return await client.evaluate(
    `(async () => {
      const res = await window.workspace.openspec.getChanges(${JSON.stringify(folderId)})
      if (!res || res.ok !== true) return null
      const hit = res.value.active.find((c) => c.slug === ${JSON.stringify(slug)})
      return hit && hit.worktree ? hit.worktree.key : null
    })()`,
    { awaitPromise: true },
  )
}

/**
 * session 開在 git worktree（`session-in-worktree`）。
 *
 * **這一段獨立於 `runMode`**：它要一個帶 worktree 的 fixture，而且要直接打 IPC —— 產品上
 * 「在 worktree 開 shell」沒有 UI（design D1 的入口只開 claude session，Open Question 明說
 * 本 change 不做 shell 的入口）。這是 IPC 層的驗收，不是使用者路徑。
 *
 * **cwd 一律走讀檔**（`pwd > 檔案` 再讀檔），不讀畫面：tty 會回顯輸入行，「畫面上出現了那個
 * 路徑」分不清回顯與執行。
 */
async function runWorktree(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（session 開在 worktree）──`)

  const { repo, out, inside, outside } = makeWorktreeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()
  const marker = `spek-term-wt-${process.pid}-${Date.now()}`

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)

    // 主行程列舉出來的工作目錄 —— **識別碼由它產生，探針不自己算**（那會變成一份平行實作）。
    const roots = await app.client.evaluate(
      `window.workspace.openspec.getWorktreeRoots('f1').then((r) => r.ok ? r.value : null)`,
      { awaitPromise: true },
    )
    check(results, `${label}：主行程列出了工作目錄的 folder-relative 根`,
      Array.isArray(roots) && roots.includes('') && roots.includes('.claude/worktrees/wt-inside'),
      JSON.stringify(roots))

    /** 以 IPC 直接建 session，回傳結果物件（成功或失敗都拿得到）。 */
    const createIn = (target, key) =>
      app.client.evaluate(
        `window.workspace.terminal.create('f1', ${JSON.stringify(target)}, ${JSON.stringify(key)})`,
        { awaitPromise: true },
      )

    // ── 反面先做：偽造的識別碼必須被拒，且不產生 pty ─────────────────────
    //
    // **先做反面**，因為它斷言「pty 數不變」—— 排在正面之後的話，基準會被前面建立的 session 墊高。
    const before = (await waitForPtyCount(marker, 0, 1500)).length
    const rejected = await createIn('shell', 'deadbeef')
    check(results, `${label}：查無對應的工作目錄識別碼被拒`,
      rejected?.ok === false && rejected?.code === 'UNKNOWN_WORKTREE', JSON.stringify(rejected))
    await sleep(800)
    const after = (await waitForPtyCount(marker, before, 1500)).length
    check(results, `${label}：被拒時不產生 pty`, after === before, `前 ${before} 後 ${after}`)

    // ── 邊界內的 worktree ────────────────────────────────────────────────
    const insideKey = await worktreeKeyOfChange(app.client, 'f1', 'inside-change')
    check(results, `${label}：取得邊界內 worktree 的識別碼`, typeof insideKey === 'string', String(insideKey))

    const madeInside = await createIn('shell', insideKey)
    check(results, `${label}：於邊界內的 worktree 建立 session`, madeInside?.ok === true,
      JSON.stringify(madeInside))
    await waitForPtyCount(marker, before + 1, 15_000)

    // **寫入也走 IPC** —— 這些 session 是繞過 renderer 建的，畫面上沒有它們的分頁，
    // `typeLine` 送到的會是 focused 的那個終端（實測：讀回空字串）。整段都是 IPC 層驗收，
    // 不假裝走使用者路徑。
    const writeTo = (sessionId, line) =>
      app.client.evaluate(
        `window.workspace.terminal.write(${JSON.stringify(sessionId)}, ${JSON.stringify(line + '\r')})`,
      )

    const insideCwd = join(out, 'cwd-inside.txt')
    await writeTo(madeInside.value.sessionId, `pwd > ${insideCwd}`)
    const insideText = await waitForFile(insideCwd, (value) => value.trim().length > 0, 12_000)
    check(results, `${label}：pty 的 cwd 就在該 worktree`, insideText.trim() === inside,
      `期待 ${inside}；實得 ${JSON.stringify(insideText.trim())}`)

    // ── 邊界外的 worktree —— 放寬前它必定被夾制掉 ────────────────────────
    const outsideKey = await worktreeKeyOfChange(app.client, 'f1', 'outside-change')
    const madeOutside = await createIn('shell', outsideKey)
    check(results, `${label}：於 folder 邊界外的 worktree 建立 session`, madeOutside?.ok === true,
      JSON.stringify(madeOutside))
    await waitForPtyCount(marker, before + 2, 15_000)

    const outsideCwd = join(out, 'cwd-outside.txt')
    await writeTo(madeOutside.value.sessionId, `pwd > ${outsideCwd}`)
    const outsideText = await waitForFile(outsideCwd, (value) => value.trim().length > 0, 12_000)
    check(results, `${label}：pty 的 cwd 就在邊界外的那個 worktree`, outsideText.trim() === outside,
      `期待 ${outside}；實得 ${JSON.stringify(outsideText.trim())}`)

    // ── 重建與自癒的 cwd —— **這一段驗不到，刻意不放假斷言** ──────────────
    //
    // 上面那些 session 是**繞過 renderer** 以 IPC 建的（產品沒有「在 worktree 開 shell」的 UI），
    // 而持久化靠 renderer 推送清單 —— 於是它們從來不進 `sessions.json`，關掉再開什麼都不會重建。
    // 曾在這裡寫過「重開後 pty 仍在該 worktree」，實測必然紅（pty 0 個），因為前提就不成立。
    //
    // 這兩件事各自有更適合的載體：
    //
    // - **自癒後的 cwd** —— `terminal.test.ts` 的「自癒重生的 pty 仍在原本的工作目錄」，
    //   而且**對照組驗過**（把 `#heal` 改回 folder 根，那條如期變紅）。
    // - **重建後的 cwd** —— 走使用者路徑才有持久化，見 `probe:openspec` 的續寫入口段落。
    //
    // 與其在這裡放一條「因為前提不成立而恆紅（或更糟：恆綠）」的斷言，不如把缺口寫明。
  } finally {
    if (app) await app.destroy()
  }
}

/**
 * 各段落。**這支探針會開真的視窗、送真的滑鼠事件** —— 跑完整支要好幾分鐘，而且那段期間
 * **使用者無法操作自己的電腦**（視窗會搶走焦點、滑鼠被驅動）。
 *
 * 因此提供 `PROBE_ONLY` 讓迭代時只跑被改到的那一段。**不設就跑全部**，完整驗收與 CI 的行為不變。
 *
 *   PROBE_ONLY=runMode                    只跑 runMode（build + dev 兩模式）
 *   PROBE_ONLY=runMode:build              只跑 runMode 的 build 模式
 *   PROBE_ONLY=runRestore,runAltScreen    跑這兩段
 *   PROBE_ONLY=runWorktree                只跑「session 開在 worktree」
 */
/**
 * 全域 session —— 不隸屬任何 folder，位置為家目錄（`global-session`）。
 *
 * **走使用者的路徑**（rail 的全域列 → ＋ → 選 shell），不繞道打 IPC：那條路徑上有一整串東西
 * （選中項目、分頁列為它服務、歸屬鍵是 `null`），繞過去就等於沒驗到它們。
 */
async function runGlobalSession(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（全域 session）──`)

  const { repo, out } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()
  const marker = `spek-term-global-${process.pid}-${Date.now()}`

  // rail 上那個不隸屬任何 folder 的固定項目。**以屬性比對取名，不寫字面選擇器** ——
  // `aria-label-source` 守衛只看形式，不區分「文案」與「fixture 的資料」。
  const GLOBAL_ROW_RECT = `(() => {
    const rail = document.querySelector('aside[aria-label="${copy('rail.label')}"]')
    const row = rail && [...rail.querySelectorAll('div[role="button"]')]
      .find((el) => el.getAttribute('aria-label') === ${JSON.stringify(copy('rail.globalName'))})
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`

  const GLOBAL_NEW_SESSION_RECT = `(() => {
    const btn = document.querySelector('aside[aria-label="${copy('rail.label')}"] [aria-label="${copy('rail.newSessionIn', { name: copy('rail.globalName') })}"]')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, `!!document.querySelector('aside[aria-label="${copy('rail.label')}"]')`, (v) => v === true, 10_000)

    // **不先選任何 folder** —— 全域項目不需要 workspace 裡有東西，這一段也刻意不碰 folder。
    const plus = await pollUntil(app.client, GLOBAL_NEW_SESSION_RECT, (v) => v !== null, 8000)
    await realClick(app.client, plus)
    const menuItem = await pollUntil(
      app.client,
      MENU_ITEM_RECT(copy('sessions.spawnShell')),
      (v) => v !== null,
      4000,
    )
    await realClick(app.client, menuItem)

    const pids = await waitForPtyCount(marker, 1, 12_000)
    check(results, `${label}：於全域項目建立 session（產生一個 pty）`,
      pids.length === 1, `pty 數 = ${pids.length}`)

    // **先把焦點交給終端** —— 剛才點的是選單，`Input.insertText` 會送到那裡去。
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))

    // **以讀檔驗 cwd，不讀終端畫面**（renderer-agnostic，且能區分回顯與執行）。
    const cwdFile = join(stub.home, 'global-cwd.txt')
    await typeLine(app.client, `pwd > ${cwdFile}`)
    const recorded = await pollUntilText(
      () => (existsSync(cwdFile) ? readFileSync(cwdFile, 'utf8').trim() : ''),
      (v) => v.length > 0,
      8000,
    )
    check(results, `${label}：全域 session 的 cwd 為家目錄`,
      recorded === stub.home, `${recorded} vs ${stub.home}`)

    // 分頁列為全域項目服務 —— 它的 session 不與任何 folder 的混列。
    const tabs = await app.client.evaluate(TAB_LABELS)
    check(results, `${label}：分頁列呈現全域項目的 session`,
      Array.isArray(tabs) && tabs.length === 1, JSON.stringify(tabs))

    // 切到 folder ⇒ 分頁列不再含全域 session（folder 尚無 session）。
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (v) => v === true, 8000)
    const folderTabs = await pollUntil(app.client, TAB_LABELS, (v) => v.length === 0, 6000)
    check(results, `${label}：切到 folder 後分頁列不含全域 session`,
      Array.isArray(folderTabs) && folderTabs.length === 0, JSON.stringify(folderTabs))

    /*
      ── 跨重啟：全域 session 一併重建、於**最後的目錄**重生，而冷啟動**不喚醒**它

      這一段此前不存在，而 tasks 13.2 宣稱它存在（獨立稽核抓到）。它一次承載五條 scenario：
      重建、重建於全域項目之下、shell 於家目錄之外的目錄重生、冷啟動不預設選中全域項目、
      冷啟動不因全域項目恆存而喚醒 session。

      **`out` 刻意選在每一個 workspace folder 之外** —— 全域 session 的 cwd 明文不受路徑夾制，
      而落在某個 folder 裡的目錄證明不了這件事（夾制過的實作也會通過）。
    */
    await pollUntil(app.client, GLOBAL_ROW_RECT, (v) => v !== null, 6000)
    await realClick(app.client, await app.client.evaluate(GLOBAL_ROW_RECT))
    await pollUntil(app.client, TAB_LABELS, (v) => v.length === 1, 6000)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `cd ${out}`)
    const beforeFile = join(stub.home, 'global-before-restart.txt')
    await typeLine(app.client, `pwd > ${beforeFile}`)
    const movedTo = await pollUntilText(
      () => (existsSync(beforeFile) ? readFileSync(beforeFile, 'utf8').trim() : ''),
      (v) => v.length > 0,
      8000,
    )
    check(results, `${label}：前提 —— 全域 shell 已 cd 到每個 folder 之外的目錄`,
      movedTo === out, `${movedTo} vs ${out}`)

    await sleep(SNAPSHOT_SETTLE_MS)
    await app.quitGracefully()
    // **等舊行程真的死透再開新的。** 這既是一條斷言（關閉終止其所有 pty），也是必要的間隔 ——
    // 前一個 Electron 還占著 debugging port 時，新的那個連上去會是 `CDP WebSocket 連線失敗`，
    // 而那個失敗是 **throw 而不是紅燈**，整支探針從那裡中斷（issue #7 的形態）。
    check(results, `${label}：關閉應用程式終止全域 session 的 pty`,
      await waitPtysGone(marker), `殘留 pids=${ptyPids(marker).join(',') || '無'}`)
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, `!!document.querySelector('aside[aria-label="${copy('rail.label')}"]')`, (v) => v === true, 10_000)

    /*
      **冷啟動：不選中全域項目、也不喚醒它的 session。**

      少了前者，重建的 session 會**立刻被顯示**，而「顯示即喚醒」會讓開 app 就起一個 pty ——
      那正是 `session-restore` 的「開 app 只起一個 claude」要防的事，只是換成全域項目恆存所以
      恆有東西可喚醒。分頁列為空是「沒有選中全域項目」的憑據（它明明有一個 session）。
    */
    await sleep(1500)
    const coldTabs = await app.client.evaluate(TAB_LABELS)
    check(results, `${label}：冷啟動不預設選中全域項目（分頁列為空，儘管它有一個 session）`,
      Array.isArray(coldTabs) && coldTabs.length === 0, JSON.stringify(coldTabs))
    check(results, `${label}：冷啟動不因全域項目恆存而喚醒它的 session（沒有任何 pty）`,
      ptyPids(marker).length === 0, `pty 數 = ${ptyPids(marker).length}`)

    await realClick(app.client, await app.client.evaluate(GLOBAL_ROW_RECT))
    const rebuilt = await pollUntil(app.client, TAB_LABELS, (v) => v.length === 1, 8000)
        check(results, `${label}：關掉 app 再開，全域 session 原樣重建於全域項目之下`,
      Array.isArray(rebuilt) && rebuilt.length === 1, JSON.stringify(rebuilt))

    // Selecting the global item displays its session dormant — it does not start it.
    await sleep(1500)
    check(results, `${label}：selecting the global item does not start its sessions`,
      ptyPids(marker).length === 0, `pty count = ${ptyPids(marker).length}`)

    // Wake ⇒ the pty is born in the **last known** directory, not the home directory.
    await clickWake(app.client)
    await waitForPtyCount(marker, 1, 15_000)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    const afterFile = join(stub.home, 'global-after-restart.txt')
    await typeLine(app.client, `pwd > ${afterFile}`)
    const respawned = await pollUntilText(
      () => (existsSync(afterFile) ? readFileSync(afterFile, 'utf8').trim() : ''),
      (v) => v.length > 0,
      10_000,
    )
    check(results, `${label}：全域 shell session 於最後的目錄重生（家目錄之外，未被夾制回去）`,
      respawned === out, `${respawned} vs ${out}（家目錄是 ${stub.home}）`)
  } finally {
    if (app) await app.destroy()
    rmSync(profile, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
    rmSync(stub.home, { recursive: true, force: true })
  }
}

/**
 * 每一行的實際寬度（px），以行首的 `UW<n>` 標記索引。
 *
 * **這是本檔唯一刻意依賴 DOM renderer 的觀測點**（`.xterm-rows` 只存在於 DOM renderer）。
 * 其餘觀測管道都是 renderer-agnostic 的，這裡是例外，理由如下：
 *
 * - 要驗的是 **cell 的佔用**，那是 core 的 `unicodeService` 決定的資料，**兩個 renderer 讀的是
 *   同一份 buffer** —— 在 DOM renderer 下量到就是量到，不是「只在這個 renderer 成立」。
 *   `terminal-sessions` 的 spec 已明文本要求可由自動化驗收建立（與「畫素層級的正確性」那條相反）。
 * - 因此段落開頭會先以**產品自己的設定路徑**關掉 GPU 加速，結束時再開回來。
 *
 * **不另建 harness 去量 xterm**：另建的 harness 若為了方便而放寬 `webPreferences`
 * （例如開 `nodeIntegration` 好用 ipc 回報結果），會讓 addon 走到 Node 的 `Buffer` 分支而踩上
 * upstream xtermjs/xterm.js#6079 的 trie 損毀 —— 星形平面會**靜默地**全部變成一格。
 * 產品是 `nodeIntegration: false`，所以驗收必須在產品自己的 renderer 裡做（design D8）。
 */
const widthRowsExpr = (prefix) => `(() => {
  const rows = [...document.querySelectorAll('.xterm-rows > div')]
  const out = {}
  for (const row of rows) {
    const text = row.textContent || ''
    const m = text.match(/^${prefix}(\\d+) /)
    if (!m) continue
    const spans = [...row.querySelectorAll('span')]
    if (!spans.length) continue
    const left = row.getBoundingClientRect().left
    const right = spans[spans.length - 1].getBoundingClientRect().right
    out[${JSON.stringify(prefix)} + m[1]] = right - left
  }
  return out
})()`

/**
 * 代表性字元集，按**類別**組織（spec 的「涵蓋範圍」段落要求，且明文禁止以個別字元推論整體）。
 *
 * `期望` 欄不是規範推論，是**實測 agent 的排版**：讓 claude 畫一張框線表格、自分隔線取欄寬、
 * 逐列數 padding 反推它為每個符號保留幾格（design D1）。
 *
 * 兩個容易誤導的格子，正是「不得縮減類別」的理由：
 * - 內建 v6 對**膚色修飾**碰巧也給 2（把兩個 code point 各算一格相加）—— 只用它驗會給現況發綠燈。
 * - 內建 v6 對**星形平面 CJK** 是正確的 —— 它的缺陷限於 emoji。
 */
const WIDTH_CASES = [
  { id: 'UW1', label: 'ASCII（窄字元對照）', text: 'A', want: 1 },
  { id: 'UW2', label: 'BMP 寬字元（CJK）', text: '一', want: 2 },
  { id: 'UW3', label: '星形平面寬字元（CJK 擴充 B）', text: '\u{20000}', want: 2 },
  { id: 'UW4', label: 'BMP emoji', text: '✅', want: 2 },
  { id: 'UW5', label: '星形平面 emoji', text: '\u{1F680}', want: 2 },
  { id: 'UW6', label: '基底＋VS16', text: '⚠️', want: 2 },
  { id: 'UW7', label: 'ZWJ 序列', text: '\u{1F468}‍\u{1F469}‍\u{1F467}', want: 2 },
  { id: 'UW8', label: '膚色修飾', text: '\u{1F44D}\u{1F3FD}', want: 2 },
  { id: 'UW9', label: '半形片假名（窄字元對照）', text: 'ﾊ', want: 1 },
]

/** 量測用的檔案內容。每行 `UW<n> <字元>X`，`UW0 X` 是不含測試字元的基準行。 */
function widthFixtureText() {
  const lines = ['UW0 X']
  for (const c of WIDTH_CASES) lines.push(c.id + ' ' + c.text + 'X')
  return lines.join('\n') + '\n'
}

/**
 * 自量到的 px 換算成 cell 數。
 *
 * 標定完全走**純 ASCII**（`UW0 X` 與 `UW1 AX` 差恰好一個 cell），因此不預設任何非 ASCII 字元的
 * 寬度 —— 若改用「中文＝2 格」來標定，那個假設本身就是待驗的東西之一。
 */
function cellsOf(rows, id) {
  // `UW1 AX` 比 `UW0 X` 恰好多一個 ASCII 字元 —— 兩者的差就是一個 cell 的 px。
  const cell = rows.UW1 - rows.UW0
  if (!(cell > 0)) return null
  // 基準行不含測試字元，因此「該行比基準多出來的寬度」就是那個字元佔的格數。**不要再加 1**
  // （初版加了，於是每一列都恰好多一格 —— 連 ASCII 的 `A` 都量成 2，而那顯然不可能）。
  return Math.round((rows[id] - rows.UW0) / cell)
}

async function runUnicodeWidth(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（字元寬度與 pty 一致）──`)

  const marker = `spek-width-${process.pid}-${Date.now()}`
  const { repo } = makeFixture()
  // `launch` 無條件用 stub 的 HOME 與 PATH（見其 env 區塊）—— 本段用的是 shell session，
  // 不會實際叫到 claude，但仍要提供一份，否則 launch 讀不到 `stub.home`。
  const stub = makeStubClaude()
  // 測試內容**寫成檔案讓終端 cat**，不用 Input.insertText 打 emoji —— 後者會把「輸入路徑處不
  // 處理得了這些字元」這個與本要求無關的變因混進來。終端收到的是純 ASCII 的一行 cat 命令。
  writeFileSync(join(repo, 'width.txt'), widthFixtureText())
  const profile = seedProfile([['f1', repo]])

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await waitForPtyCount(marker, 1)

    // DOM renderer 才有 `.xterm-rows`（見 UNICODE_WIDTH_ROWS 的說明）。走使用者的設定路徑。
    await setGpuViaSettings(app.client, false)
    await typeLine(app.client, 'cat width.txt')

    const rows = await pollUntilText(
      () => app.client.evaluate(widthRowsExpr('UW')),
      (value) => value && value.UW0 > 0 && value.UW9 > 0,
      15_000,
    )

    const cell = rows.UW1 - rows.UW0
    check(results, `${label}：量測基準成立（純 ASCII 標定出一個 cell 的寬度）`,
      cell > 0, `cell=${cell}px  UW0=${rows.UW0}  UW1=${rows.UW1}`)

    // ── spec：代表性字元集的 cell 佔用逐類別正確 ────────────────────────────
    const measured = WIDTH_CASES.map((c) => ({ ...c, got: cellsOf(rows, c.id) }))
    const wrong = measured.filter((m) => m.got !== m.want)
    check(results, `${label}：代表性字元集的 cell 佔用逐類別符合 pty 的排版`,
      wrong.length === 0,
      measured.map((m) => `${m.label}=${m.got}(期望${m.want})`).join('  '))

    // ── spec：多 code point 組成的 cluster 佔一個字的寬度 ────────────────────
    //
    // **與上一條不可合併**：`addon-unicode11` 在純 emoji 上全過，卻把 ZWJ 家庭判成 6 格、
    // 膚色修飾判成 4 格。合併等於把選型的整個裁決從驗收中移除（design D1）。
    const clusters = measured.filter((m) => ['UW6', 'UW7', 'UW8'].includes(m.id))
    check(results, `${label}：多 code point 的 cluster（VS16／ZWJ／膚色修飾）各佔兩格`,
      clusters.every((m) => m.got === 2),
      clusters.map((m) => `${m.label}=${m.got}`).join('  '))

    // ── spec：含 emoji 的行與純 ASCII 的行等寬 ──────────────────────────────
    //
    // 上面兩條量的是單一字元；這一條量的是**表格形式的可觀察後果** —— 那才是使用者看到的東西。
    await typeLine(app.client, 'printf "UWT1 |%s|\\nUWT2 |%s|\\n" "AA" "✅"')
    const tableRows = await pollUntilText(
      () => app.client.evaluate(widthRowsExpr('UWT')),
      (value) => value && value.UWT1 > 0 && value.UWT2 > 0,
      15_000,
    )
    check(results, `${label}：含 emoji 的行與同排版的純 ASCII 行等寬`,
      Math.abs(tableRows.UWT1 - tableRows.UWT2) < 1,
      `ASCII 行=${tableRows.UWT1}px  emoji 行=${tableRows.UWT2}px`)

    // ── spec：重播的歷史沿用同一份寬度判定 ──────────────────────────────────
    //
    // 關掉 app 讓畫面快照落盤，再以同一個 profile 重開 —— shell session 會被重建並重播那份
    // 快照。**重播的內容必須與產生當下等寬**：buffer 的 cell 佔用是寫入當下決定的，若寬度判定
    // 在 replay 之後才生效，這裡就會看到「歷史是歪的、新輸出是對的」（design D5）。
    await app.quitGracefully()
    await waitPtysGone(marker)
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)

    // 重建的 session 預設休眠，要被顯示才會喚醒並重播。點它的分頁。
    const firstTab = await pollUntil(app.client, TAB_RECT(0), (value) => value !== null, 10_000)
    await realClick(app.client, firstTab)
    await setGpuViaSettings(app.client, false)

    const replayed = await pollUntilText(
      () => app.client.evaluate(widthRowsExpr('UW')),
      (value) => value && value.UW0 > 0 && value.UW9 > 0,
      20_000,
    )
    const replayedWrong = WIDTH_CASES.map((c) => ({ ...c, got: cellsOf(replayed, c.id) })).filter(
      (m) => m.got !== m.want,
    )
    check(results, `${label}：重播的歷史沿用同一份寬度判定`,
      replayedWrong.length === 0,
      replayedWrong.map((m) => `${m.label}=${m.got}(期望${m.want})`).join('  ') || '全部相符')

    // 還原狀態，否則其後的段落會在「GPU 已關閉」的前提下跑（既有紀律）。
    await setGpuViaSettings(app.client, true)
  } finally {
    if (app) await app.destroy()
  }
}

/** Hibernate the session of tab `index` through its context menu (session-hibernation). */
async function hibernateTab(client, index) {
  await openTabMenu(client, index)
    const item = await client.evaluate(MENU_ITEM_RECT(copy('sessions.hibernate')))
  if (!item) {
    const items = await client.evaluate(`[...(document.querySelector('[role="menu"]')?.querySelectorAll('button') ?? [])].map((b) => b.innerText)`)
    throw new Error(`tab ${index} offers no Hibernate item (menu=${JSON.stringify(items)} tabs=${JSON.stringify(await client.evaluate(TAB_STATUS))})`)
  }
  await realClick(client, item)
}

/** Whether tab `index`'s context menu offers Hibernate. Closes the menu again. */
async function tabOffersHibernate(client, index) {
  await openTabMenu(client, index)
    const item = await client.evaluate(MENU_ITEM_RECT(copy('sessions.hibernate')))
  // Dismissed by a press outside it (the menu closes on any mousedown elsewhere); the press lands on
  // the same tab, which is already the selected one.
  await realClick(client, await client.evaluate(TAB_RECT(index)))
  await pollUntil(client, `document.querySelector('[role="menu"]') === null`, (value) => value === true, 4000)
  return item !== null
}

/** Wait until tab `index` no longer shows the dormant state (the renderer has the woken session as running). */
async function awaitRunning(client, index) {
  await pollUntil(
    client,
    TAB_STATUS,
    (value) => value[index] !== undefined && !value[index].title.includes(copy('sessions.statusDormant')),
    10_000,
  )
}

/** The pid of the only session leader carrying `marker` that is not in `known`. */
async function newSessionPid(marker, known) {
  const pids = await pollFor({
    read: () => ptySessionPids(marker).filter((pid) => !known.includes(pid)),
    settled: (value) => value.length === 1,
    timeoutMs: 10_000,
    interval: 150,
    label: 'the new session pty',
  })
  return pids[0]
}

const alive = (pid) => existsSync(`/proc/${pid}`)

/**
 * Manual hibernation (session-hibernation): what it ends, what it keeps, and that waking takes the
 * restore path — for a session created in this run (whose replay the startup restore never filled)
 * and for a restored one.
 */
async function runHibernate(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（manual hibernation）──`)

  const marker = `spek-hibernate-${process.pid}-${Date.now()}`
  const { repo, out } = makeFixture()
  const sub = join(repo, 'packages', 'app')
  mkdirSync(sub, { recursive: true })
  const profile = seedProfile([['f1', repo]])
    const stub = makeStubClaude({ screenMarker: true })

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    // ── A shell created in this run: cd, print a marker, hibernate at once (no snapshot settle).
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)
    const firstPid = await newSessionPid(marker, [])
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `cd ${sub}`)
    await typeLine(app.client, `echo HIB_$((5*5)) | tee ${join(out, 'hib.txt')}`)
    await waitForFile(join(out, 'hib.txt'), (value) => value.includes('HIB_25'))
    const labelsBefore = await app.client.evaluate(TAB_LABELS)

    await hibernateTab(app.client, 0)
    const gone = await pollFor({
      read: () => alive(firstPid),
      settled: (value) => value === false,
      timeoutMs: 10_000,
      interval: 150,
      label: 'the hibernated pty ends',
    })
    const statusAfter = await pollUntil(
      app.client,
      TAB_STATUS,
      (value) => value[0]?.title?.includes(copy('sessions.statusDormant')),
      6000,
    )
    const labelsAfter = await app.client.evaluate(TAB_LABELS)
    check(
      results,
      `${label}：hibernating a shell ends its process and keeps the tab (same place and label, shown dormant)`,
      gone === false &&
        JSON.stringify(labelsAfter) === JSON.stringify(labelsBefore) &&
        Boolean(statusAfter[0]?.title?.includes(copy('sessions.statusDormant'))),
      `pid ${firstPid} alive=${gone} labels ${JSON.stringify(labelsBefore)} → ${JSON.stringify(labelsAfter)} tooltip=${JSON.stringify(statusAfter[0]?.title)}`,
    )

    // The dormant shell states what was not kept.
    const note = await pollUntil(
      app.client,
      `document.querySelector('section[aria-label="${copy('stage.terminal')}"]')?.innerText ?? ''`,
      (value) => value.includes(copy('sessions.dormantShell')),
      6000,
    )
    check(
      results,
      `${label}：a dormant shell states what a shell does not keep`,
      note.includes(copy('sessions.dormantShell')),
      `stage text=${JSON.stringify(note.slice(0, 160))}`,
    )

    // A dormant session offers no Hibernate item.
    check(results, `${label}：a dormant session's menu offers no Hibernate item`, !(await tabOffersHibernate(app.client, 0)), 'item present')

    // ── Wake: the screen as it was at the moment of hibernation, above the separator; same directory.
        await clickWake(app.client)
    const wokenPid = await newSessionPid(marker, [firstPid])
    await awaitRunning(app.client, 0)
    const replayed = await pollTerminalText(app.client, (value) => value.includes('HIB_25'), 10_000)
    const separatorAt = replayed.indexOf(copy('sessions.replaySeparator'))
    const markerAt = replayed.indexOf('HIB_25')
    check(
      results,
      `${label}：output produced just before hibernation is kept, above the separator (session created in this run)`,
      markerAt !== -1 && separatorAt !== -1 && markerAt < separatorAt,
      `marker at ${markerAt}, separator at ${separatorAt}: ${JSON.stringify(replayed.slice(-200))}`,
    )

    const cwdFile = join(out, 'hib-cwd.txt')
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `pwd > ${cwdFile}`)
    const cwd = await waitForFile(cwdFile, (value) => value.trim().startsWith('/'), 10_000)
    check(
      results,
      `${label}：a woken shell starts where it was`,
      cwd.trim() === sub && readlinkSync(`/proc/${wokenPid}/cwd`) === sub,
      `pwd=${JSON.stringify(cwd.trim())} /proc cwd=${alive(wokenPid) ? readlinkSync(`/proc/${wokenPid}/cwd`) : 'gone'} expected ${sub}`,
    )

    // ── Hibernated and woken repeatedly: each Wake really wakes.
    const cycles = []
    let previous = wokenPid
        for (const round of [1, 2]) {
      // A Wake that did nothing leaves the tab dormant, with no Hibernate item: record it, do not throw.
      const statusNow = (await app.client.evaluate(TAB_STATUS))[0]?.title ?? ''
      if (statusNow.includes(copy('sessions.statusDormant'))) {
        cycles.push(false)
        break
      }
      await hibernateTab(app.client, 0)
      await pollFor({ read: () => alive(previous), settled: (value) => value === false, timeoutMs: 10_000, interval: 150, label: `cycle ${round}: pty ends` })
            await clickWake(app.client)
      previous = await newSessionPid(marker, []).catch(() => null)
      await awaitRunning(app.client, 0)
      cycles.push(previous !== null && alive(previous))
    }
    check(
      results,
      `${label}：a session can be hibernated and woken repeatedly`,
      cycles.every(Boolean),
      `awake after each wake=${JSON.stringify(cycles)}`,
    )

    // ── The user can hibernate the displayed session while it runs a job.
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, 'sleep 30')
    await sleep(500)
    const busyPid = previous
    await hibernateTab(app.client, 0)
    const busyGone = await pollFor({ read: () => alive(busyPid), settled: (value) => value === false, timeoutMs: 10_000, interval: 150, label: 'displayed busy shell hibernates' })
    check(results, `${label}：the user can hibernate the displayed session while it runs a job`, busyGone === false, `pid ${busyPid} alive=${busyGone}`)

    // ── An exited session offers no Hibernate item.
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)
    await newSessionPid(marker, [])
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, 'exit')
    await pollUntil(app.client, TABS, (value) => value[1]?.exited === true, 8000)
    check(results, `${label}：an exited session's menu offers no Hibernate item`, !(await tabOffersHibernate(app.client, 1)), 'item present')

    // ── A hibernated session survives a restart as dormant.
    await sleep(800)
    await app.quitGracefully()
    await waitPtysGone(marker)
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    const restored = await pollUntil(app.client, TAB_LABELS, (value) => value.length === 1, 10_000)
    await sleep(1500)
    const restoredStatus = await app.client.evaluate(TAB_STATUS)
    check(
      results,
      `${label}：a hibernated session survives a restart as dormant`,
      JSON.stringify(restored) === JSON.stringify(labelsBefore) &&
        ptySessionPids(marker).length === 0 &&
        Boolean(restoredStatus[0]?.title?.includes(copy('sessions.statusDormant'))),
      `labels=${JSON.stringify(restored)} ptys=${ptySessionPids(marker).length} tooltip=${JSON.stringify(restoredStatus[0]?.title)}`,
    )

    // ── A restored session: what replays after its hibernation is the hibernation's screen, not
    // the startup history (the restore map is filled at startup; hibernation must replace it).
        await clickWake(app.client)
    await newSessionPid(marker, [])
    await awaitRunning(app.client, 0)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, `echo AGAIN_$((6*6)) | tee ${join(out, 'again.txt')}`)
    await waitForFile(join(out, 'again.txt'), (value) => value.includes('AGAIN_36'))
    const beforeSecond = ptySessionPids(marker)
    await hibernateTab(app.client, 0)
    await pollFor({ read: () => beforeSecond.some(alive), settled: (value) => value === false, timeoutMs: 10_000, interval: 150, label: 'restored session hibernates' })
    await clickWake(app.client)
    await newSessionPid(marker, [])
    const again = await pollTerminalText(app.client, (value) => value.includes('AGAIN_36'), 10_000)
    const lastSeparator = again.lastIndexOf(copy('sessions.replaySeparator'))
    check(
      results,
      `${label}：a restored session replays the screen at its hibernation, not the startup history`,
      again.lastIndexOf('AGAIN_36') !== -1 && again.lastIndexOf('AGAIN_36') < lastSeparator,
            `marker at ${again.lastIndexOf('AGAIN_36')}, last separator at ${lastSeparator}: ${JSON.stringify(again.slice(-200))}`,
    )

        // ── claude: hibernate, wake ⇒ the same conversation, resumed; its screen shown once.
    const beforeClaude = ptySessionPids(marker)
    await openSessionViaMenu(app.client, copy('sessions.spawnClaude'))
    await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)
    const claudePid = await newSessionPid(marker, beforeClaude)
    const created = conversationOf(stub.calls().at(-1))
    const screenMarker = `STUB-SCREEN-${created?.id}`
    await pollTerminalText(app.client, (value) => value.includes(screenMarker), 10_000)
    await hibernateTab(app.client, 1)
    await pollFor({ read: () => alive(claudePid), settled: (value) => value === false, timeoutMs: 10_000, interval: 150, label: 'claude hibernates' })
    const claudeStage = await pollUntil(
      app.client,
      `document.querySelector('section[aria-label="${copy('stage.terminal')}"]')?.innerText ?? ''`,
      (value) => value.includes(copy('sessions.dormantClaude')),
      6000,
    )
    check(
      results,
      `${label}：a dormant claude session carries no shell note`,
      claudeStage.includes(copy('sessions.dormantClaude')) && !claudeStage.includes(copy('sessions.dormantShell')),
      `stage text=${JSON.stringify(claudeStage.slice(0, 160))}`,
    )
        const callsBefore = stub.calls().length
    await clickWake(app.client)
    await awaitRunning(app.client, 1)
    const afterWake = await pollFor({
      read: () => stub.calls(),
      settled: (calls) => calls.length > callsBefore,
      timeoutMs: 10_000,
      interval: 150,
      label: 'the woken claude starts',
    })
    const resumed = conversationOf(afterWake.at(-1))
    check(
      results,
      `${label}：a hibernated claude session resumes the same conversation`,
      resumed?.mode === 'resume' && resumed.id === created?.id,
      `created=${JSON.stringify(created)} last call=${JSON.stringify(resumed)}`,
    )
    const claudeText = await pollTerminalText(app.client, (value) => value.includes(screenMarker), 10_000)
    const shown = claudeText.split(screenMarker).length - 1
    check(
      results,
      `${label}：a woken claude session does not show its history twice`,
      shown === 1,
      `"${screenMarker}" appears ${shown} times: ${JSON.stringify(claudeText.slice(0, 200))}`,
    )
  } finally {
    if (app) await app.destroy()
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經走了
      }
    }
  }
}

/** Seed the automatic-hibernation threshold (seconds) into a profile, with the base language. */
function seedHibernation(profile, seconds) {
  writeFileSync(
    join(profile, 'preferences.json'),
    JSON.stringify({ version: 1, terminal: { autoHibernateSeconds: seconds }, ui: { language: 'en' } }),
  )
}

/**
 * Automatic hibernation of shells (session-hibernation): an idle undisplayed shell is hibernated
 * after the threshold; the displayed one, one running a foreground job, one with a background job,
 * and one that replaced itself are not. The threshold is seeded as seconds (the tick follows it).
 */
async function runAutoHibernateShell(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（automatic hibernation, shells）──`)

  const THRESHOLD_S = 6
  const marker = `spek-autohib-${process.pid}-${Date.now()}`
  const { repo } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  seedHibernation(profile, THRESHOLD_S)
  const stub = makeStubClaude()

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    const pids = []
    const open = async (count, command) => {
      await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
      await pollUntil(app.client, TABS, (value) => value.length === count, 8000)
      const pid = await newSessionPid(marker, pids)
      pids.push(pid)
      if (command) {
        await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
        await typeLine(app.client, command)
      }
      return pid
    }
    const idlePid = await open(1, null)
    const foregroundPid = await open(2, 'sleep 600')
    const backgroundPid = await open(3, 'sleep 600 &')
    const replacedPid = await open(4, 'exec sleep 600')
    const displayedPid = await open(5, null)

    const idleGone = await pollFor({
      read: () => alive(idlePid),
      settled: (value) => value === false,
      timeoutMs: (THRESHOLD_S + 10) * 1000,
      interval: 250,
      label: 'the idle undisplayed shell is hibernated',
    })
    check(results, `${label}：an idle shell that is not displayed is hibernated after the threshold`, idleGone === false, `pid ${idleGone ? 'still alive' : 'gone'}`)

    // Give every other session at least one full threshold plus two ticks past its last activity.
    await sleep((THRESHOLD_S + 3) * 1000)
    const kept = {
      foreground: alive(foregroundPid),
      background: alive(backgroundPid),
      replaced: alive(replacedPid),
      displayed: alive(displayedPid),
    }
    check(results, `${label}：a shell running a foreground job stays running`, kept.foreground, JSON.stringify(kept))
    check(results, `${label}：a shell with a background job stays running`, kept.background, JSON.stringify(kept))
    check(results, `${label}：a shell replaced by another program stays running`, kept.replaced, JSON.stringify(kept))
    check(results, `${label}：the displayed session never hibernates automatically`, kept.displayed, JSON.stringify(kept))

    // ── Showing a session restarts the clock. F goes undisplayed at t0; shown and left again shortly
    // before its deadline; still running past the original deadline, hibernated after the new one.
    const showPid = await open(6, null)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(4)))
    const t0 = Date.now()
    await sleep((THRESHOLD_S - 2) * 1000)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(5)))
    await sleep(500)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(4)))
    const t1 = Date.now()
    await sleep(Math.max(0, t0 + (THRESHOLD_S + 2) * 1000 - Date.now()))
    const pastOriginal = alive(showPid)
    const laterGone = await pollFor({
      read: () => alive(showPid),
      settled: (value) => value === false,
      timeoutMs: Math.max(1000, t1 + (THRESHOLD_S + 6) * 1000 - Date.now()),
      interval: 250,
      label: 'hibernated after the restarted deadline',
    })
    check(
      results,
      `${label}：showing a session restarts the clock`,
      pastOriginal && laterGone === false,
      `alive past the original deadline=${pastOriginal}, hibernated after the new one=${laterGone === false}`,
    )

    // ── Turned off in Settings (no restart): an idle undisplayed shell stays running. A choice applies when
    // it is made (`settings-sections`); there is no Save.
    await openSettings(app.client, 'agents')
    const hibernateSelect = inSettings(`select${ariaLabel('settings.autoHibernate')}`)
    const shownValue = await app.client.evaluate(`document.querySelector(${JSON.stringify(hibernateSelect)})?.selectedOptions[0]?.textContent ?? null`)
    await app.client.evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(hibernateSelect)})
      select.value = '0'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await awaitApplied(
      app.client,
      'window.workspace.settings.get().then((p) => p.autoHibernateSeconds ?? null)',
      (value) => value === 0,
      'automatic hibernation applied as off',
    )
    await closeSettings(app.client)
    check(results, `${label}：Settings shows a stored threshold outside the choices as itself`, shownValue === copy('settings.autoHibernateSeconds_other', { count: THRESHOLD_S }), `shown=${JSON.stringify(shownValue)}`)

    const offPid = await open(7, null)
    await realClick(app.client, await app.client.evaluate(TAB_RECT(4)))
    await sleep((THRESHOLD_S + 4) * 1000)
    check(results, `${label}：turned off in Settings, an idle undisplayed shell stays running (no restart)`, alive(offPid), `pid ${offPid} alive=${alive(offPid)}`)
  } finally {
    if (app) await app.destroy()
    for (const pid of ptyPids(marker)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已經走了
      }
    }
  }
}

/**
 * 十個段落**彼此獨立** —— 每一段各自 `makeFixture()`、`seedProfile()`、`launch()` 與收屍，
 * 沒有任何一段沿用前一段的狀態。因此沒有一項需要宣告 `deps`。
 *
 * **這是實際逐段確認的結果，不是假設**：`runWorktree` 是唯一不呼叫 `makeFixture()` 的段落
 * （它自建 worktree fixture），其餘九段都自帶。日後若有段落開始沿用前段的 context，
 * **必須同時補上 `deps`** —— 否則前段失敗時它會照跑，然後紅在一個與根因無關的地方。
 */
/**
 * 逾時收屍：**逾時的段落不會走到自己的 `finally`**，它建立的 electron 沒有其他人會收。
 * pattern 用字元類別自我豁免 —— `pkill -f` 比對的是整條 command line，會匹配到自己那一條
 * （`docs/lessons/probes.md`：症狀是背景命令的輸出檔是空的、exit 1，看起來像 probe 失敗，
 * 其實 probe 一秒都沒跑）。
 *
 * pty 不必另外處理：master fd 由主行程持有，主行程一死 pty 必然陪葬。
 */
const killStrays = () => {
  try {
    execFileSync('pkill', ['-9', '-f', 'spekterm-terminal-[p]rofile'], { stdio: 'ignore' })
  } catch {
    // 沒有殘留 —— 那正是我們要的
  }
}

// ── Close confirmation (maximize-panel-and-confirm-close, workspace-app-shell) ─────────────────
//
// The native dialog is replaced by the stand-in in src/main/close-dialog-stub.ts (throwaway
// profiles only): prompts are read from close-stub/dialogs.jsonl, answers written to "answer",
// a "hold" file keeps a prompt open, and writing "close" makes the main process close the window
// the way the close button does.

function closeStub(profile) {
  const root = join(profile, 'close-stub')
  const lines = (name) => {
    try {
      return readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  return {
    dialogs: () => lines('dialogs.jsonl'),
    closes: () => lines('closes.jsonl').length,
    answer: (role) => writeFileSync(join(root, 'answer'), role),
    hold: (on) => (on ? writeFileSync(join(root, 'hold'), '') : rmSync(join(root, 'hold'), { force: true })),
    close: () => writeFileSync(join(root, 'close'), String(Date.now())),
  }
}

async function waitDialogs(stub, count, timeoutMs = 8000) {
  return pollFor({
    read: () => stub.dialogs(),
    settled: (value) => value.length >= count,
    timeoutMs,
    interval: 100,
    label: `close-stub prompts ≥ ${count}`,
  })
}

async function waitCloses(stub, count, timeoutMs = 8000) {
  return pollFor({
    read: () => stub.closes(),
    settled: (value) => value >= count,
    timeoutMs,
    interval: 100,
    label: `close-stub triggers consumed ≥ ${count}`,
  })
}

/**
 * Wait until the renderer's record of `count` sessions (with their ordinals) has reached the main
 * process. A session closed within milliseconds of its creation is listed by its target alone
 * ("shell"), because the tab's ordinal is only known once the renderer has pushed it; the persisted
 * file is the observable sign that the push arrived (it is written from that push).
 */
async function waitPersisted(profile, count) {
  return pollFor({
    read: () => {
      try {
        const parsed = JSON.parse(readFileSync(join(profile, 'sessions.json'), 'utf8'))
        return (parsed.sessions ?? []).filter((session) => session.ordinal > 0).length
      } catch {
        return 0
      }
    },
    settled: (value) => value >= count,
    timeoutMs: 8000,
    interval: 100,
    label: `sessions.json lists ${count} sessions with ordinals`,
  })
}

/** Is the app still answering CDP? */
async function responsive(client) {
  try {
    return (await client.evaluate('1 + 1')) === 2
  } catch {
    return false
  }
}

async function runCloseConfirm(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（close confirmation）──`)

  const marker = `spek-close-${process.pid}-${Date.now()}`
  const { repo } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()
  const close = closeStub(profile)
  const line = (item, name, working = false) =>
    copy(working ? 'closeConfirm.lineWorking' : 'closeConfirm.line', { item, label: name })

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    await sleep(300)

    // ── One running shell, the close button, cancel.
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 1, 8000)
    const firstPid = await newSessionPid(marker, [])
    const [firstLabel] = await app.client.evaluate(TAB_LABELS)
    await waitPersisted(profile, 1)
    close.answer('cancel')
    close.close()
    const asked = await waitDialogs(close, 1)
    await sleep(500)
    const stillUp = await responsive(app.client)
    const prompt = asked[0]
    check(
      results,
      `${label}: closing with a running session asks first (window kept, one session listed by item and label)`,
      asked.length === 1 &&
        stillUp &&
        prompt?.message === copy('closeConfirm.message_one', { count: 1 }) &&
        Boolean(prompt?.detail?.includes(line('repo-a', firstLabel))),
      `prompts=${asked.length} responsive=${stillUp} message=${JSON.stringify(prompt?.message)} detail=${JSON.stringify(prompt?.detail)} tab=${JSON.stringify(firstLabel)}`,
    )
    check(
      results,
      `${label}: the safe answer is the default (default and cancel answers are both cancel)`,
      prompt?.defaultRole === 'cancel' && prompt?.cancelRole === 'cancel' && JSON.stringify(prompt?.roles) === '["quit","cancel"]',
      JSON.stringify({ roles: prompt?.roles, defaultRole: prompt?.defaultRole, cancelRole: prompt?.cancelRole }),
    )
    check(
      results,
      `${label}: cancelling keeps every session running (same process)`,
      stillUp && alive(firstPid) && ptySessionPids(marker).includes(firstPid),
      `responsive=${stillUp} pid ${firstPid} alive=${alive(firstPid)} pids=${JSON.stringify(ptySessionPids(marker))}`,
    )

    // ── A second shell running a command: listed first, marked as working.
    await openSessionViaMenu(app.client, copy('sessions.spawnShell'))
    await pollUntil(app.client, TABS, (value) => value.length === 2, 8000)
    await newSessionPid(marker, [firstPid])
    const labels = await app.client.evaluate(TAB_LABELS)
    await realClick(app.client, await app.client.evaluate(TERMINAL_RECT))
    await typeLine(app.client, 'sleep 600')
    await sleep(800)
    const promptsWorking = close.dialogs().length
    close.close()
    const second = (await waitDialogs(close, promptsWorking + 1))[promptsWorking]
    const detailLines = (second?.detail ?? '').split('\n')
    check(
      results,
      `${label}: a working session is marked and listed first`,
      detailLines[0] === line('repo-a', labels[1], true) && detailLines[1] === line('repo-a', labels[0]),
      `lines=${JSON.stringify(detailLines.slice(0, 2))} tabs=${JSON.stringify(labels)}`,
    )

    // ── Hold the prompt open: a second close and a signal do not ask twice or end the app.
    const promptsBefore = close.dialogs().length
    const closesBefore = close.closes()
    close.hold(true)
    close.close()
    await waitDialogs(close, promptsBefore + 1)
    await waitCloses(close, closesBefore + 1)
    close.close()
    const consumed = await waitCloses(close, closesBefore + 2)
    await sleep(800)
    const afterSecond = close.dialogs().length
    const upAfterSecond = await responsive(app.client)
    check(
      results,
      `${label}: a second close while the dialog is open does not ask twice (one prompt, window open)`,
      consumed >= closesBefore + 2 && afterSecond === promptsBefore + 1 && upAfterSecond,
      `triggers ${closesBefore} → ${consumed} prompts ${promptsBefore} → ${afterSecond} responsive=${upAfterSecond}`,
    )

    app.signal('SIGTERM')
    await sleep(1500)
    const upAfterSignal = await responsive(app.client)
    close.answer('cancel')
    await sleep(800)
    close.hold(false)
    const upAfterCancel = await responsive(app.client)
    close.close()
    const askedAgain = await waitDialogs(close, promptsBefore + 2)
    check(
      results,
      `${label}: a signal during the open dialog does not disable the question (still running after cancel; the next close asks again)`,
      upAfterSignal && upAfterCancel && askedAgain.length === promptsBefore + 2,
      `responsive after SIGTERM=${upAfterSignal} after cancel=${upAfterCancel} prompts=${askedAgain.length} (expected ${promptsBefore + 2})`,
    )

    // ── Confirm: the app exits by itself, no pty remains, the sessions come back dormant.
    close.answer('quit')
    close.close()
    const exited = await app.waitForExit(10_000)
    const ptysGone = await waitPtysGone(marker)
    app.client.close()
    if (!exited) await app.quitGracefully()
    app = null

    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, SELECT_FOLDER('repo-a'), (value) => value === true, 10_000)
    const statuses = await pollUntil(
      app.client,
      TAB_STATUS,
      (value) => value.length === 2 && value.every((tab) => tab.title.includes(copy('sessions.statusDormant'))),
      10_000,
    )
    check(
      results,
      `${label}: confirming closes the window and ends the sessions (exits by itself, no pty, dormant on relaunch)`,
      exited && ptysGone && statuses.length === 2 && statuses.every((tab) => tab.title.includes(copy('sessions.statusDormant'))),
      `exited=${exited} ptysGone=${ptysGone} relaunch=${JSON.stringify(statuses.map((tab) => tab.title))}`,
    )

    // ── Only dormant sessions: no prompt, the window closes.
    const promptsDormant = close.dialogs().length
    const closesDormant = close.closes()
    close.answer('cancel')
    close.close()
    const dormantExited = await app.waitForExit(10_000)
    check(
      results,
      `${label}: only dormant sessions close without asking`,
      dormantExited && close.closes() === closesDormant + 1 && close.dialogs().length === promptsDormant,
      `exited=${dormantExited} triggers ${closesDormant} → ${close.closes()} prompts ${promptsDormant} → ${close.dialogs().length}`,
    )
    app.client.close()
    if (!dormantExited) await app.quitGracefully()
    app = null

    // ── A global session counts; then SIGTERM with sessions running quits without asking.
    app = await launch({ port, profileDir: profile, rendererUrl, marker, stub })
    await pollUntil(app.client, `!!document.querySelector('aside[aria-label="${copy('rail.label')}"]')`, (v) => v === true, 10_000)
    const GLOBAL_NEW_SESSION = `(() => {
      const btn = document.querySelector('aside[aria-label="${copy('rail.label')}"] [aria-label="${copy('rail.newSessionIn', { name: copy('rail.globalName') })}"]')
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`
    await realClick(app.client, await pollUntil(app.client, GLOBAL_NEW_SESSION, (v) => v !== null, 8000))
    await realClick(app.client, await pollUntil(app.client, MENU_ITEM_RECT(copy('sessions.spawnShell')), (v) => v !== null, 4000))
    await waitForPtyCount(marker, 1, 12_000)
    const [globalLabel] = await pollUntil(app.client, TAB_LABELS, (value) => value.length === 1, 8000)
    // Two dormant repo-a sessions plus the new global one.
    await waitPersisted(profile, 3)
    const promptsGlobal = close.dialogs().length
    close.answer('cancel')
    close.close()
    const globalPrompt = (await waitDialogs(close, promptsGlobal + 1))[promptsGlobal]
    check(
      results,
      `${label}: a global session counts (listed under the global item's name)`,
      Boolean(globalPrompt?.detail?.includes(line(copy('rail.globalName'), globalLabel))),
      `detail=${JSON.stringify(globalPrompt?.detail)} tab=${JSON.stringify(globalLabel)}`,
    )

    const promptsSignal = close.dialogs().length
    const quit = await app.quitGracefully()
    const signalPtysGone = await waitPtysGone(marker)
    app = null
    check(
      results,
      `${label}: a termination signal quits with sessions running (no prompt, exits by itself, no pty remains)`,
      quit?.escalated === false && close.dialogs().length === promptsSignal && signalPtysGone,
      `escalated=${quit?.escalated} prompts ${promptsSignal} → ${close.dialogs().length} ptysGone=${signalPtysGone}`,
    )
  } finally {
    if (app) await app.destroy()
  }
}

/**
 * Settings applies each change when it is made (`terminal-preferences`, "A change in Settings applies when it is
 * made" and "Each section restores its own defaults after a confirmation"; `settings-sections`).
 *
 * Every assertion reads **both** what the user sees (the field, the preview, the alert) and what is stored (the
 * main process's answer, or `preferences.json`): a field that only looks applied and a write that the field never
 * shows are the two failures this section exists for.
 */
async function runSettingsApply(label, { port, rendererUrl }) {
  console.log(`\n── ${label}（Settings applies each change when it is made）──`)

  const { repo } = makeFixture()
  const profile = seedProfile([['f1', repo]])
  const stub = makeStubClaude()
  const prefsFile = join(profile, 'preferences.json')
  const onDisk = () => (existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, 'utf8')) : null)
  const stored = (field) => `window.workspace.settings.get().then((p) => p[${JSON.stringify(field)}] ?? null)`
  const DIALOG_OPEN = `Boolean(document.querySelector(${JSON.stringify(SETTINGS_DIALOG_SELECTOR)}))`
  const SIZE = inSettings(`input${ariaLabel('settings.fontSize')}`)
  const FAMILY = inSettings(`select${ariaLabel('settings.fontFamily')}`)
  const GPU = inSettings(`input${ariaLabel('settings.gpuAcceleration')}`)
  const PREVIEW = inSettings(`pre${ariaLabel('settings.preview')}`)
  const ALERTS = `[...document.querySelectorAll(${JSON.stringify(inSettings('[role="alert"]'))})].map((el) => el.textContent)`
  const valueOf = (selector) => `document.querySelector(${JSON.stringify(selector)})?.value ?? null`

  /**
   * After the main process has applied a write, the renderer takes it a task later (the provider's state, then a
   * render). A field edited in between is replaced by the arriving value, so the next edit waits two frames.
   */
  const settleRender = () =>
    app.client.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')

  /** Waits for the preview to show a typed size, which proves the typed text has rendered. */
  const awaitTyped = (size) =>
    pollUntil(app.client, `document.querySelector(${JSON.stringify(PREVIEW)})?.style.fontSize ?? null`, (value) => value === size, 5_000)

  /** A real click on the button in Settings whose text is `text` (the restore controls carry no label of their own). */
  const clickButtonText = async (text) => {
    const rect = await pollUntil(
      app.client,
      `(() => {
        const b = [...document.querySelectorAll(${JSON.stringify(inSettings('button'))})].find((x) => x.textContent === ${JSON.stringify(text)})
        if (!b) return null
        b.scrollIntoView({ block: 'nearest' })
        const r = b.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })()`,
      (value) => value !== null,
      5_000,
    )
    if (!rect) throw new Error(`Settings has no button "${text}"`)
    await realClick(app.client, rect)
  }

  let app = null
  try {
    app = await launch({ port, profileDir: profile, rendererUrl, stub })
    await openSettings(app.client, 'terminal')

    // ── A choice applies at once, with Settings still open.
    await clickSelector(app.client, GPU, 'the GPU acceleration box')
    const gpuStored = await awaitApplied(app.client, stored('gpuAcceleration'), (value) => value === false, 'GPU off applied')
    const openAfterChoice = await app.client.evaluate(DIALOG_OPEN)
    check(results, `${label}: a choice applies at once, with Settings still open`,
      gpuStored === false && openAfterChoice === true,
      `stored gpuAcceleration=${gpuStored} settingsOpen=${openAfterChoice}`)

    // ── A typed value does not apply while it is being typed; the preview follows it.
    await setField(app.client, 'settings.fontSize', '21', { commit: 'none' })
    const whileTyping = {
      stored: await app.client.evaluate(stored('fontSize')),
      preview: await app.client.evaluate(`document.querySelector(${JSON.stringify(PREVIEW)})?.style.fontSize ?? null`),
    }
    check(results, `${label}: a typed value does not apply while it is being typed`,
      whileTyping.stored === null && whileTyping.preview === '21px',
      JSON.stringify(whileTyping))

    // ── …and applies when focus leaves the field.
    await app.client.evaluate(`document.querySelector(${JSON.stringify(SIZE)})?.blur()`)
    const afterBlur = await awaitApplied(app.client, stored('fontSize'), (value) => value === 21, 'size 21 applied on blur')
    await settleRender()
    check(results, `${label}: a typed value applies when the field is left`,
      afterBlur === 21, `stored fontSize=${afterBlur}`)

    // ── Esc in a field with an unapplied edit restores the stored value and leaves Settings open.
    await setField(app.client, 'settings.fontSize', '9', { commit: 'none' })
    // The key must reach a field whose typed text has rendered (the preview reads it): a key sent within the
    // same task as the typing would meet the previous render's handler.
    await awaitTyped('9px')
    await pressEscape(app.client)
    const afterEscape = {
      field: await app.client.evaluate(valueOf(SIZE)),
      stored: await app.client.evaluate(stored('fontSize')),
      open: await app.client.evaluate(DIALOG_OPEN),
    }
    check(results, `${label}: Esc restores a field that has not applied, and Settings stays open`,
      afterEscape.field === '21' && afterEscape.stored === 21 && afterEscape.open === true,
      JSON.stringify(afterEscape))

    // ── Text the number field cannot parse is rejected (a real `badInput`, typed through the input pipeline).
    await app.client.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(SIZE)})
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    })()`)
    await app.client.send('Input.insertText', { text: '1e' })
    const badInput = await app.client.evaluate(`document.querySelector(${JSON.stringify(SIZE)})?.validity.badInput ?? null`)
    await app.client.evaluate(`document.querySelector(${JSON.stringify(SIZE)})?.blur()`)
    const rejected = await pollUntil(
      app.client,
      `(async () => ({ field: ${valueOf(SIZE)}, stored: await ${stored('fontSize')}, alerts: ${ALERTS} }))()`,
      (value) => value.field === '21' && value.alerts.includes(copy('settings.invalidNumber')),
      5_000,
    )
    check(results, `${label}: unparseable text in a number field is rejected`,
      badInput === true && rejected.field === '21' && rejected.stored === 21 &&
        rejected.alerts.includes(copy('settings.invalidNumber')),
      `badInput=${badInput} ${JSON.stringify(rejected)}`)

    // ── A clamped value is shown as applied.
    await setField(app.client, 'settings.fontSize', '99')
    const clamped = await pollUntil(
      app.client,
      `(async () => ({ field: ${valueOf(SIZE)}, stored: await ${stored('fontSize')} }))()`,
      (value) => value.stored === 32 && value.field === '32',
      5_000,
    )
    await settleRender()
    check(results, `${label}: a clamped value is shown as applied`,
      clamped.stored === 32 && clamped.field === '32', JSON.stringify(clamped))

    // The families the machine offers. Without two of them the family assertions below cannot be made.
    const families = await pollUntil(
      app.client,
      `[...(document.querySelector(${JSON.stringify(FAMILY)})?.options ?? [])].map((o) => o.value).filter(Boolean)`,
      (list) => list.length >= 2,
      5_000,
    )
    check(results, `${label}: precondition: the machine lists at least two monospace families`,
      families.length >= 2, JSON.stringify(families.slice(0, 5)))
    const [familyA, familyB] = families

    // ── Choosing a family does not apply a typed size.
    await setField(app.client, 'settings.fontSize', '11', { commit: 'none' })
    await awaitTyped('11px')
    await app.client.evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(FAMILY)})
      select.value = ${JSON.stringify(familyA)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    const familyApplied = await awaitApplied(app.client, stored('fontFamily'), (value) => value === familyA, 'family A applied')
    await settleRender()
    const sizeAfterFamily = await app.client.evaluate(stored('fontSize'))
    check(results, `${label}: choosing a family does not apply a typed size`,
      familyApplied === familyA && sizeAfterFamily === 32,
      `stored family=${JSON.stringify(familyApplied)} size=${sizeAfterFamily} (typed 11, not applied)`)
    // Drop the unapplied edit, so no later blur applies it.
    await app.client.evaluate(`document.querySelector(${JSON.stringify(SIZE)})?.focus()`)
    await pressEscape(app.client)

    // ── Two quick font changes both persist: the size field's blur and the family's change in one evaluate, so the
    // family write is queued before the size write has returned. Bound arguments would send the old size again.
    await app.client.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(SIZE)})
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      input.focus()
      setter.call(input, '19')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
      const select = document.querySelector(${JSON.stringify(FAMILY)})
      select.value = ${JSON.stringify(familyB)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    const both = await pollUntil(
      app.client,
      `(async () => ({ size: await ${stored('fontSize')}, family: await ${stored('fontFamily')}, field: ${valueOf(SIZE)}, select: ${valueOf(FAMILY)} }))()`,
      // The renderer shows a write a task after the main process applied it: wait for the screen as well.
      (value) => value.size === 19 && value.family === familyB && value.field === '19' && value.select === familyB,
      5_000,
    )
    const diskBoth = onDisk()?.terminal ?? {}
    check(results, `${label}: two quick font changes both persist, on screen and on disk`,
      both.size === 19 && both.family === familyB && both.field === '19' && both.select === familyB &&
        diskBoth.fontSize === 19 && diskBoth.fontFamily === familyB,
      `shown ${JSON.stringify(both)} disk ${JSON.stringify({ fontSize: diskBoth.fontSize, fontFamily: diskBoth.fontFamily })}`)

    // ── A failed write is shown and leaves nothing behind. A directory where the atomic write puts its temporary
    // file makes the write throw (EISDIR) with no test branch in the product.
    const blocker = `${prefsFile}.tmp`
    mkdirSync(blocker)
    await clickSelector(app.client, GPU, 'the GPU acceleration box')
    const failed = await pollUntil(
      app.client,
      `(async () => ({ alerts: ${ALERTS}, checked: document.querySelector(${JSON.stringify(GPU)})?.checked ?? null, stored: await ${stored('gpuAcceleration')}, open: ${DIALOG_OPEN} }))()`,
      (value) => value.alerts.includes(copy('settings.writeFailed')),
      5_000,
    )
    rmSync(blocker, { recursive: true, force: true })
    await setField(app.client, 'settings.fontSize', '17')
    await awaitApplied(app.client, stored('fontSize'), (value) => value === 17, 'size 17 applied after the failure')
    const diskAfter = onDisk()?.terminal ?? {}
    check(results, `${label}: a failed write is shown and leaves nothing behind`,
      failed.alerts.includes(copy('settings.writeFailed')) && failed.checked === false && failed.stored === false &&
        failed.open === true && diskAfter.gpuAcceleration === false && diskAfter.fontSize === 17,
      `while failing ${JSON.stringify(failed)}; disk after the next write ${JSON.stringify({ gpuAcceleration: diskAfter.gpuAcceleration, fontSize: diskAfter.fontSize })}`)

    // ── Restore per section. Agent status off first, in the other section, so restoring Terminal can be seen to
    // leave it alone.
    await showSection(app.client, 'agents')
    await clickSelector(app.client, inSettings(`input${ariaLabel('settings.agentStatus')}`), 'the agent status box')
    await awaitApplied(app.client, stored('agentStatus'), (value) => value === false, 'agent status off applied')
    await showSection(app.client, 'terminal')

    // Declining changes nothing.
    await clickButtonText(copy('settings.restoreDefaults'))
    await clickButtonText(copy('common.cancel'))
    const declined = { size: await app.client.evaluate(stored('fontSize')), family: await app.client.evaluate(stored('fontFamily')) }
    check(results, `${label}: declining a restore changes nothing`,
      declined.size === 17 && declined.family === familyB, JSON.stringify(declined))

    // Esc while it asks cancels the question and leaves Settings open.
    await clickButtonText(copy('settings.restoreDefaults'))
    await pollUntil(app.client, `[...document.querySelectorAll(${JSON.stringify(inSettings('p'))})].some((p) => p.textContent === ${JSON.stringify(copy('settings.restoreConfirm'))})`, Boolean, 5_000)
    await pressEscape(app.client)
    const afterConfirmEscape = await app.client.evaluate(`({
      asking: [...document.querySelectorAll(${JSON.stringify(inSettings('p'))})].some((p) => p.textContent === ${JSON.stringify(copy('settings.restoreConfirm'))}),
      open: ${DIALOG_OPEN},
    })`)
    check(results, `${label}: Esc cancels a restore confirmation and Settings stays open`,
      afterConfirmEscape.asking === false && afterConfirmEscape.open === true, JSON.stringify(afterConfirmEscape))

    // Confirmed: Terminal returns to its defaults; agent status and the language do not move.
    await clickButtonText(copy('settings.restoreDefaults'))
    await clickButtonText(copy('settings.restore'))
    const restored = await pollUntil(
      app.client,
      `(async () => { const p = await window.workspace.settings.get(); return { size: p.fontSize ?? null, family: p.fontFamily ?? null, gpu: p.gpuAcceleration ?? null, agentStatus: p.agentStatus ?? null } })()`,
      (value) => value.size === null && value.family === null && value.gpu === null,
      5_000,
    )
    const diskRestored = onDisk()
    check(results, `${label}: restoring Terminal leaves the other sections and the language as they were`,
      restored.size === null && restored.family === null && restored.gpu === null && restored.agentStatus === false &&
        diskRestored?.ui?.language === 'en',
      `${JSON.stringify(restored)} ui=${JSON.stringify(diskRestored?.ui)}`)

    await closeSettings(app.client)
  } finally {
    if (app) await app.destroy()
  }
}

/** 五次冷啟動的兩段給更長的時限；dev 模式的冷啟動是 30 秒級（unbundled ESM + Monaco）。 */
const LONG = 14 * 60 * 1000

const SECTIONS = [
  // **`runMode` 的時限必須放寬。** 它的最壞等待預算（各次等待的時限總和，含它呼叫的輔助
  // 函式）已經**大於**預設時限 —— 於是幾個等待落空，它就會在跑完後半段之前被時限殺掉。
  // 被吃掉的不是已經印出來的行（stdout 是 inherit，那些留著），而是**尚未執行的部分與這一段
  // 的累計**（窗口耗盡幾次、CDP 往返多少）—— 而那正是要拿去回答 issue #21 的東西。
  { name: 'runMode', run: runMode, timeoutMs: LONG, onTimeout: killStrays },
  { name: 'runUnicodeWidth', run: runUnicodeWidth, onTimeout: killStrays },
  { name: 'runRestore', run: runRestore, timeoutMs: LONG, onTimeout: killStrays },
  { name: 'runHealAndCrash', run: runHealAndCrash, timeoutMs: LONG, onTimeout: killStrays },
  { name: 'runAltScreen', run: runAltScreen, onTimeout: killStrays },
    { name: 'runDormantHint', run: runDormantHint, onTimeout: killStrays },
  { name: 'runHibernate', run: runHibernate, timeoutMs: LONG, onTimeout: killStrays },
  { name: 'runAutoHibernateShell', run: runAutoHibernateShell, timeoutMs: LONG, onTimeout: killStrays },
  { name: 'runAgentStatus', run: runAgentStatus, onTimeout: killStrays },
  { name: 'runContinuation', run: runContinuation, onTimeout: killStrays },
  { name: 'runWorktree', run: runWorktree, onTimeout: killStrays },
  { name: 'runGlobalSession', run: runGlobalSession, onTimeout: killStrays },
  { name: 'runCloseConfirm', run: runCloseConfirm, timeoutMs: LONG, onTimeout: killStrays },
  { name: 'runSettingsApply', run: runSettingsApply, onTimeout: killStrays },
]

const outcome = await runSections({
  sections: SECTIONS,
  build: { port: BUILD_PORT, rendererUrl: null },
  dev: { port: DEV_PORT, start: startRendererDevServer },
  results,
  cleanup: () => {
    for (const dir of temps) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 暫存目錄清不掉不影響結論
      }
    }
  },
})

process.exit(outcome.ok ? 0 : 1)
