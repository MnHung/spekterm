/**
 * 驗證 spek-core-integration 的四條 requirement。
 *
 * 走「啟動真正的 app、讀主行程的 stdout」而非在主行程塞測試分支：開發模式輸出
 * 掃描摘要本身就是 spec 要求的產品行為，probe 只是它的第一個消費者。摘要中的
 * 每個數字都由本腳本從檔案系統獨立算出期望值再比對，而不是照抄 app 的輸出。
 *
 * TCP 埠的判定在掃描全程持續抽樣行程樹（含 Electron 的 zygote / renderer 子行程），
 * 而非只在結束後看一眼 —— 掃描期間曇花一現的 listener 同樣算違規。
 *
 * 用法：npm run probe:core（需 npm 把 node_modules/.bin 放進 PATH 才找得到 electron）
 * 結束碼 0 表示全部 scenario 通過。
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { electronExtraArgs } from './lib/display.mjs'
import { quitAndWait } from './lib/quit.mjs'
import { check, pollFor } from './lib/instrument.mjs'

const PROJECT_ROOT = realpathSync(new URL('..', import.meta.url).pathname)
const SUMMARY_TIMEOUT_MS = 60_000
const SAMPLE_INTERVAL_MS = 100

const SUMMARY_RE =
  /^\[openspec\] scan (.+?) specs=(\d+) activeChanges=(\d+) archivedChanges=(\d+) defaultSchema=(.+)$/m

// ── 期望值：以 core 的規則從檔案系統獨立推導，不看 app 的輸出 ────────────────

/** 對齊 core 的 safeReadDir：忽略 dotfile，只留目錄。 */
function childDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(dir, name)).isDirectory())
}

function expectedCounts(repoPath) {
  const specsDir = join(repoPath, 'openspec', 'specs')
  const changesDir = join(repoPath, 'openspec', 'changes')

  return {
    specCount: childDirs(specsDir).filter((t) => existsSync(join(specsDir, t, 'spec.md'))).length,
    activeChangeCount: childDirs(changesDir).filter((n) => n !== 'archive').length,
    archivedChangeCount: childDirs(join(changesDir, 'archive')).length,
    defaultSchema: expectedSchema(repoPath),
  }
}

/** 直接讀 openspec/config.yaml 的 schema:，缺檔或缺 key 時對應摘要的 "(none)"。 */
function expectedSchema(repoPath) {
  const configPath = join(repoPath, 'openspec', 'config.yaml')
  if (!existsSync(configPath)) return '(none)'
  const m = readFileSync(configPath, 'utf8').match(/^schema:\s*(.+)$/m)
  if (!m) return '(none)'
  const quoted = m[1].trim().match(/^"([^"]*)"/) || m[1].trim().match(/^'([^']*)'/)
  return quoted ? quoted[1] : m[1].replace(/\s+#.*$/, '').trim()
}

/**
 * 合成一個 OpenSpec repo，三個計數刻意互不相同（specs 2 / activeChanges 3 / archivedChanges 1）。
 * 掃描本 repo 只會得到 0 / 1 / 0，分辨不出「欄位錯位」這類錯誤 —— 合成 fixture 可以。
 * 另埋兩個誘餌驗證 core 的過濾規則：沒有 spec.md 的 spec 目錄、dotfile 目錄，兩者都不該被計入。
 */
function makeFixtureRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spekterm-fixture-')))
  const openspec = join(root, 'openspec')

  mkdirSync(openspec, { recursive: true })
  writeFileSync(join(openspec, 'config.yaml'), 'schema: fixture-schema\n')

  for (const topic of ['alpha', 'beta']) {
    mkdirSync(join(openspec, 'specs', topic), { recursive: true })
    writeFileSync(join(openspec, 'specs', topic, 'spec.md'), '## ADDED Requirements\n')
  }
  mkdirSync(join(openspec, 'specs', 'no-spec-md'), { recursive: true })

  for (const slug of ['change-one', 'change-two', 'change-three']) {
    mkdirSync(join(openspec, 'changes', slug), { recursive: true })
    writeFileSync(join(openspec, 'changes', slug, 'proposal.md'), '## Why\n')
  }
  mkdirSync(join(openspec, 'changes', '.hidden'), { recursive: true })

  const archived = join(openspec, 'changes', 'archive', '2026-01-01-old')
  mkdirSync(archived, { recursive: true })
  writeFileSync(join(archived, 'proposal.md'), '## Why\n')

  return root
}

// ── TCP listener 偵測（Linux /proc） ─────────────────────────────────────────

function processTree(rootPid) {
  const parents = new Map()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      // comm 可能含空白與括號，故自最後一個 ')' 之後開始切：state ppid ...
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      parents.set(Number(name), Number(fields[1]))
    } catch {
      // 行程在讀取途中消失
    }
  }

  const tree = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, ppid] of parents) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid)
        grew = true
      }
    }
  }
  return tree
}

/**
 * 讀某個 network namespace 中處於 LISTEN(0A) 的 TCP socket：inode → 位址。
 * `/proc/<pid>/net/` 反映的是該 pid 所屬的 netns —— Chromium 的 zygote 與 renderer
 * 跑在獨立 netns，故必須逐 pid 讀，只看主行程的表會漏掉它們。
 */
function listenTable(netDir) {
  const found = new Map()
  for (const family of ['tcp', 'tcp6']) {
    let text
    try {
      text = readFileSync(join(netDir, family), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length < 10 || c[3] !== '0A') continue
      found.set(c[9], `${family} ${c[1]}`)
    }
  }
  return found
}

/** probe 自己所在的 netns（即 Electron 主行程所在的 netns）的 LISTEN 表。 */
const hostListenTable = () => listenTable('/proc/self/net')

function socketInodes(pid) {
  const inodes = new Set()
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)
      if (m) inodes.add(m[1])
    } catch {
      // fd 在讀取途中關閉
    }
  }
  return inodes
}

function describePid(pid) {
  const read = (f) => {
    try {
      return readFileSync(`/proc/${pid}/${f}`, 'utf8')
    } catch {
      return ''
    }
  }
  const cmd = read('cmdline').split('\0').filter(Boolean).slice(0, 2).join(' ').slice(0, 60)
  return `pid ${pid} (${read('comm').trim() || '?'}${cmd ? `, ${cmd}` : ''})`
}

/**
 * 抽樣一次：回傳行程樹中「自己持有 LISTEN socket」的行程，以及 fd 無權讀取的行程。
 * 逐 pid 取交集（該 pid 的 socket inode ∩ 該 pid 所屬 netns 的 LISTEN 表），
 * 因此無論行程在哪個 namespace，只要它真的在監聽就會被抓到。
 */
function sampleListeners(rootPid) {
  const listeners = []
  const blindSpots = []

  for (const pid of processTree(rootPid)) {
    let inodes
    try {
      inodes = socketInodes(pid)
    } catch (err) {
      // ESRCH / ENOENT 表示行程已結束，不是權限問題
      if (err.code === 'EACCES' || err.code === 'EPERM') blindSpots.push(describePid(pid))
      continue
    }
    const table = listenTable(`/proc/${pid}/net`)
    for (const inode of inodes) {
      if (table.has(inode)) listeners.push(`${describePid(pid)} → ${table.get(inode)}`)
    }
  }
  return { listeners, blindSpots }
}

// ── 啟動 app，等摘要，全程抽樣 ───────────────────────────────────────────────

const onLinux = process.platform === 'linux'

async function runApp(scanPath) {
  // 基準線：app 尚未啟動時，本 netns 已存在的 LISTEN socket（機器上其他行程的）
  const baseline = onLinux ? hostListenTable() : new Map()

  /*
    **A throwaway profile** (`XDG_CONFIG_HOME` at an empty directory; no `--user-data-dir`, which is what this
    probe has always launched without). On the maintainer's real profile remote access may be on, and then
    the app listens by design — "no process holds a LISTEN socket" would be red for a correct app. With a
    fresh profile it is the carrier of `remote-access`'s "A fresh profile does not listen".
  */
  const profile = mkdtempSync(join(tmpdir(), 'spekterm-core-profile-'))
  tempDirs.push(profile)
  const child = spawn('electron', [...electronExtraArgs(), '.'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SPEKTERM_SCAN_PATH: scanPath, XDG_CONFIG_HOME: profile },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))

  const listeners = new Set()
  const blindSpots = new Set()
  const appeared = new Map()
  // **這一段在語意上是「取樣」而不是「等待」** —— 每一輪都往三個集合累積證據，順帶檢查兩個
  // 結束條件。它仍在原語的定義域內（`read` 做取樣、`settled` 判結束），但「窗口耗盡」對它的
  // 意思是「摘要一直沒出現」，而不是「某個東西沒好」。
  try {
    await pollFor({
      read: () => {
        if (onLinux && child.exitCode === null && child.pid) {
          const sample = sampleListeners(child.pid)
          sample.listeners.forEach((l) => listeners.add(l))
          sample.blindSpots.forEach((p) => blindSpots.add(p))
          // 不倚賴逐 pid 權限的第二道判準：app 存活期間本 netns 新增的 LISTEN socket
          for (const [inode, addr] of hostListenTable()) {
            if (!baseline.has(inode)) appeared.set(inode, addr)
          }
        }
        return {
          summaryPrinted: SUMMARY_RE.test(stdout) || /\[openspec] scan failed/.test(stdout),
          exited: child.exitCode !== null,
        }
      },
      settled: (state) => state.summaryPrinted || state.exited,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      interval: SAMPLE_INTERVAL_MS,
      label: '等主行程印出 openspec 掃描摘要',
    })
  } finally {
    // 等 app 真的結束再看殘留：仍在監聽的 socket 屬於別的行程，隨 app 一起消失的才是它的。
    // **這裡曾經是一份手寫的「SIGTERM → 等 exit → 5 秒後 SIGKILL」** —— 與 `quitAndWait`
    // 逐字同一件事。收斂它不是整理，是讓那道守衛有意義（第二份實作＝守衛的漏洞）。
    await quitAndWait(child, { timeoutMs: 5_000 })
  }
  await sleep(300)
  const lingering = onLinux ? hostListenTable() : new Map()
  const vanished = [...appeared].filter(([inode]) => !lingering.has(inode)).map(([, addr]) => addr)

  const m = stdout.match(SUMMARY_RE)
  return {
    summary: m
      ? {
          repoPath: m[1],
          specCount: Number(m[2]),
          activeChangeCount: Number(m[3]),
          archivedChangeCount: Number(m[4]),
          defaultSchema: m[5].trim(),
        }
      : null,
    scanFailed: /\[openspec] scan failed/.test(stdout),
    listeners: [...listeners],
    blindSpots: [...blindSpots],
    vanished,
    stdout,
    stderr,
  }
}

// ── 檢查 ────────────────────────────────────────────────────────────────────

const results = []

console.log('spek-core-integration 驗收：\n')

// Requirement: 以已發佈的 npm 套件取得 core
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package-lock.json'), 'utf8'))
const declared = pkg.dependencies?.['@spekjs/core']
const resolved = lock.packages?.['node_modules/@spekjs/core']?.resolved ?? ''

console.log('以已發佈的 npm 套件取得 core')
check(results, '依賴宣告為語意化版本，無本機協定', Boolean(declared) && !/^(file|link|portal):/.test(declared), `"@spekjs/core": "${declared}"`)
check(results, 'lockfile 自 npm registry 解析', resolved.startsWith('https://registry.npmjs.org/'), resolved || '(未解析)')

// Requirement: 掃描不經 HTTP 或 IPC 中介（靜態面）
console.log('\n掃描不經 HTTP 或 IPC 中介')
// 遞迴收集：`src/main/` 之下有 `ipc/` 子目錄，只讀第一層會漏掉 IPC handler
function readMainSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return readMainSources(full)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [readFileSync(full, 'utf8')]
  })
}

const mainSources = readMainSources(join(PROJECT_ROOT, 'src', 'main')).join('\n')
const importsCore = /from '@spekjs\/core'/.test(mainSources)
const callsScan = /scanOpenSpec\(/.test(mainSources)
check(results, '主行程直接 import @spekjs/core', importsCore && callsScan,
  `import 到 @spekjs/core=${importsCore}；呼叫 scanOpenSpec()=${callsScan}`)
// "No server in the main process" moved to `scripts/server-source.test.mjs` with `mobile-remote-bridge`: one
// module (the remote access listener) may create one now, and that rule is a source rule, not a run.

const tempDirs = []
function bail(message) {
  console.error(`\n${message}`)
  tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
  process.exit(1)
}

// Scenario: 掃描含 openspec 目錄的 repo —— 以計數互異的合成 fixture 為主要判準
console.log('\n掃描含 openspec 目錄的 repo（合成 fixture）')
const fixture = makeFixtureRepo()
tempDirs.push(fixture)
const expected = expectedCounts(fixture)

// 先確認 probe 自己的期望值推導沒寫錯，再拿它去驗 app
if (
  expected.specCount !== 2 ||
  expected.activeChangeCount !== 3 ||
  expected.archivedChangeCount !== 1 ||
  expected.defaultSchema !== 'fixture-schema'
) {
  bail(`probe 的期望值推導有誤：${JSON.stringify(expected)}`)
}

const onFixture = await runApp(fixture)
if (!check(results, '主行程輸出掃描摘要', onFixture.summary !== null, onFixture.summary ? '' : onFixture.stderr.trim().slice(0, 400))) {
  bail('無摘要可比對，中止。')
}

const f = onFixture.summary
check(results, '掃描目標為指定的 repo 路徑', realpathSync(f.repoPath) === fixture, f.repoPath)
check(results, 'specs 數量正確（含忽略無 spec.md 的目錄）', f.specCount === expected.specCount, `${f.specCount}（期望 ${expected.specCount}）`)
check(results, 'activeChanges 數量正確（含忽略 dotfile 目錄）', f.activeChangeCount === expected.activeChangeCount, `${f.activeChangeCount}（期望 ${expected.activeChangeCount}）`)
check(results, 'archivedChanges 數量正確', f.archivedChangeCount === expected.archivedChangeCount, `${f.archivedChangeCount}（期望 ${expected.archivedChangeCount}）`)
check(results, 'defaultSchema 等於 openspec/config.yaml 宣告值', f.defaultSchema === expected.defaultSchema, `${f.defaultSchema}（期望 ${expected.defaultSchema}）`)

// 同樣的掃描套用在真實 repo 上，順帶在全程抽樣 TCP listener
console.log('\n掃描含 openspec 目錄的 repo（本 repo）')
const onSelf = await runApp(PROJECT_ROOT)
const selfExpected = expectedCounts(PROJECT_ROOT)
if (!check(results, '主行程輸出掃描摘要', onSelf.summary !== null, onSelf.summary ? '' : onSelf.stderr.trim().slice(0, 400))) {
  bail('無摘要可比對，中止。')
}

const s = onSelf.summary
check(results, '掃描目標為指定的 repo 路徑', realpathSync(s.repoPath) === PROJECT_ROOT, s.repoPath)
check(
    results,
  '四項數值符合檔案系統',
  s.specCount === selfExpected.specCount &&
    s.activeChangeCount === selfExpected.activeChangeCount &&
    s.archivedChangeCount === selfExpected.archivedChangeCount &&
    s.defaultSchema === selfExpected.defaultSchema,
  `specs=${s.specCount} activeChanges=${s.activeChangeCount} archivedChanges=${s.archivedChangeCount} defaultSchema=${s.defaultSchema}`,
)

// Scenario: 掃描期間未開啟網路埠
console.log('\n掃描期間未開啟網路埠')
if (!onLinux) {
  check(results, '可檢視行程樹的 socket', false, `本檢查僅實作 Linux /proc，當前平台 ${process.platform}`)
} else {
  check(results, '行程樹中無行程持有 LISTEN socket', onSelf.listeners.length === 0, onSelf.listeners.join('; '))
  check(results, 'app 存活期間本 netns 未新增 LISTEN socket', onSelf.vanished.length === 0, onSelf.vanished.join('; '))
  if (onSelf.blindSpots.length > 0) {
    // 兩道判準的用意正在於此：第一道逐 pid 歸屬，會被權限死角擋住；
    // 第二道只看 netns 的 LISTEN 表，不需要讀任何 pid 的 fd —— 死角行程若在同一個
    // netns 監聽，它的 socket 一樣會出現在表裡。
    console.log(`  ℹ fd 不可讀的行程（不影響上述判定）：${onSelf.blindSpots.join('; ')}`)
  }
}

// Scenario: 掃描不含 openspec 目錄的路徑
console.log('\n掃描不含 openspec 目錄的路徑')
const emptyDir = realpathSync(mkdtempSync(join(tmpdir(), 'spekterm-noopenspec-')))
tempDirs.push(emptyDir)
const withoutSpec = await runApp(emptyDir)
check(results, '回傳空結構而非拋出例外', withoutSpec.summary !== null && !withoutSpec.scanFailed, withoutSpec.scanFailed ? '主行程回報 scan failed' : '')
if (withoutSpec.summary) {
  const e = withoutSpec.summary
  check(
    results,
    '空結構的計數皆為 0、defaultSchema 為 (none)',
    e.specCount === 0 && e.activeChangeCount === 0 && e.archivedChangeCount === 0 && e.defaultSchema === '(none)',
    `specs=${e.specCount} activeChanges=${e.activeChangeCount} archivedChanges=${e.archivedChangeCount} defaultSchema=${e.defaultSchema}`,
  )
}

tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true }))

console.log(
  '\n註：core 的 getTimestamps 會 spawn 一次 `git log` 取得 change 時間戳。' +
    '\n    那是 in-process 解析的輸入來源，掃描結果本身仍是函式呼叫的回傳值，且 git 不監聽任何埠。',
)

const passed = results.every(Boolean)
console.log(`\n${passed ? '全部通過' : '有檢查未通過'}（${results.filter(Boolean).length}/${results.length}）`)
process.exit(passed ? 0 : 1)
