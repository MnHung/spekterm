import assert from 'node:assert/strict'
import fs from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  type ExitReason,
  TerminalError,
  TerminalService,
  type TerminalSink,
  ptyEnv,
} from './terminal'
import { forgetInput, lastKeystrokeAt } from './pty-input'
import { SecretStore } from './secret-store'
import type { FolderLookup, WorkspaceFolder } from './workspace-store'

/**
 * `TerminalService` 不依賴 Electron —— 推送的出口由建構端注入。這正是當初那樣設計的理由：
 * 餵它一個假的 sink 就能直接驅動真 pty，不必動用 CDP。
 */
function lookup(folders: Partial<WorkspaceFolder>[]): FolderLookup {
  return { list: () => folders as WorkspaceFolder[] }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error(`等待逾時：${label}（已收到 ${JSON.stringify(output().slice(-200))}）`)
}

let repo: string
let origShell: string | undefined
let service: TerminalService | null
let chunks: { sessionId: string; chunk: string }[]
let exits: { sessionId: string; exitCode: number; reason: ExitReason }[]
let conversations: { sessionId: string; conversationId: string }[]

function sink(): TerminalSink {
  return {
    data: (sessionId, chunk) => chunks.push({ sessionId, chunk }),
    exit: (sessionId, exitCode, reason) => exits.push({ sessionId, exitCode, reason }),
    conversation: (sessionId, conversationId) =>
      conversations.push({ sessionId, conversationId }),
  }
}

function output(): string {
  return chunks.map((entry) => entry.chunk).join('')
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-term-')))
  origShell = process.env.SHELL
  // 可預測、無 bash/zsh profile 的雜訊，且處處存在。
  process.env.SHELL = '/bin/sh'
  chunks = []
  exits = []
  conversations = []
  service = null
})

afterEach(() => {
  service?.dispose()
  if (origShell === undefined) delete process.env.SHELL
  else process.env.SHELL = origShell
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('TerminalService', () => {
  // **`create` 是 async，於是這些失敗是 rejection 而非同步 throw。** 跨越 IPC 的行為不變：
  // `ipc/terminal.ts` 的 `toResult` 是 `await run()` 包在 try/catch 裡，兩者都被接住並轉成
  // 帶 `code` 的結果物件。
  it('拒絕未註冊的 folder', async () => {
    service = new TerminalService(lookup([]), sink())
    await assert.rejects(
      () => service!.create('nope', 'shell'),
      (error: unknown) => error instanceof TerminalError && error.code === 'UNKNOWN_FOLDER',
    )
    assert.equal(service.sessionCount, 0)
  })

  it('拒絕路徑失效的 folder', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'missing' }]), sink())
    await assert.rejects(
      () => service!.create('f1', 'shell'),
      (error: unknown) => error instanceof TerminalError && error.code === 'FOLDER_UNAVAILABLE',
    )
    assert.equal(service.sessionCount, 0)
  })

  it('雙向串流：輸入送達並被執行，cwd 為 folder 的根目錄', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    const id = (await service.create('f1', 'shell')).sessionId
    assert.equal(service.sessionCount, 1)

    // tty 會回顯輸入行，因此不能只斷言「畫面上出現了我送的字」。回顯的是字面的
    // `echo OUT_$((6*7))`（不含 42）—— 只有 shell 真的執行了算術，輸出才會有 `OUT_42`。
    service.write(id, 'echo OUT_$((6*7))\r')
    await waitFor(() => output().includes('OUT_42'), { label: '執行結果 OUT_42' })

    // `$(pwd)` 在回顯裡不會展開，因此出現 `CWD=<路徑>` 就一定是真的執行了。
    service.write(id, 'echo CWD=$(pwd)\r')
    await waitFor(() => output().includes(`CWD=${repo}`), { label: `cwd = ${repo}` })

    service.write(id, 'exit\r')
    await waitFor(() => exits.some((entry) => entry.sessionId === id), { label: 'exit 事件' })
    assert.equal(service.sessionCount, 0)
  })

  it('a write records a keystroke; an answer\'s write and a focus report do not', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    const id = (await service.create('f1', 'shell')).sessionId
    forgetInput(id)
    service.write(id, '\x1b[I')
    service.write(id, '1', 'answer')
    assert.equal(lastKeystrokeAt(id), null)
    const before = Date.now()
    service.write(id, 'x')
    assert.ok((lastKeystrokeAt(id) ?? 0) >= before)
    service.kill(id)
    await waitFor(() => exits.some((entry) => entry.sessionId === id), { label: 'exit 事件' })
  })

  it('pty 結束後自集合移除（集合恆等於「還活著的 pty」）', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    const id = (await service.create('f1', 'shell')).sessionId

    service.write(id, 'exit\r')
    await waitFor(() => exits.length === 1, { label: 'exit 事件' })

    assert.equal(service.sessionCount, 0)
    // 已結束的 session：後續操作是 no-op，不得拋錯。
    assert.doesNotThrow(() => service?.write(id, 'echo hi\r'))
    assert.doesNotThrow(() => service?.resize(id, 100, 40))
    assert.doesNotThrow(() => service?.kill(id))
  })

  it('dispose 殺光所有 pty', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    await service.create('f1', 'shell')
    await service.create('f1', 'shell')
    assert.equal(service.sessionCount, 2)

    service.dispose()
    assert.equal(service.sessionCount, 0)

    // 真的被殺掉了 —— 兩個 pty 都會回報結束（不留孤兒行程）。
    await waitFor(() => exits.length === 2, { label: '兩個 pty 都結束' })
  })

  it('kill 終止指定的 session，其餘不受影響', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    const first = (await service.create('f1', 'shell')).sessionId
    await service.create('f1', 'shell')

    service.kill(first)
    assert.equal(service.sessionCount, 1)
    await waitFor(() => exits.some((entry) => entry.sessionId === first), { label: '被 kill 的 session 結束' })
  })

  it('啟動失敗不使 create 拋錯，而是以非零結束呈現', async () => {
    // **釘住實測結論**：node-pty 對 execvp 失敗不同步拋錯 —— 它成功回傳一個 pty，該 pty
    // 隨即以非零碼結束，`execvp(3) failed.` 由 onData 送出。若哪天有人「修」成同步拋錯，
    // 這條測試會擋下來。
    process.env.SHELL = '/nonexistent/xyzshell'
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    // 建立呼叫本身**不該**因為命令不存在而失敗（見下方的斷言：失敗改以非零結束呈現）。
    const created = await service.create('f1', 'shell')
    assert.notEqual(created.sessionId, '', 'create 仍應回傳 sessionId')

    await waitFor(() => exits.some((entry) => entry.exitCode !== 0), { label: '非零 exit' })
    assert.match(output(), /execvp/i)
  })

  it('resize 對已結束或未知的 session 是 no-op', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    assert.doesNotThrow(() => service?.resize('unknown-session', 100, 40))

    const id = (await service.create('f1', 'shell')).sessionId
    // 0 尺寸會讓 node-pty 拋錯，因此必須先被夾制。
    assert.doesNotThrow(() => service?.resize(id, 0, 0))
  })
})

/**
 * 一支假的 `claude`，用來驗續接與自癒 —— 我們**叫不動真的 claude 去續接一個指定的對話**，
 * 也不該讓一支單元測試真的啟動一個 Claude Code session。
 *
 * 產品的 claude 模式是 `$SHELL -l -c "claude …"`（從 PATH 解析），而 pty 的 env 整份繼承主行程的
 * `process.env` —— 於是把 stub 前置到 PATH 就走的是**產品原本那條路徑**：動的是環境，不是被出貨的
 * 程式碼。
 *
 * **`HOME` 也必須換掉（實測踩過，而且它會靜默地叫到真的 claude）**：`-l` 是 login shell，它會
 * source `~/.profile`，而 Ubuntu 的預設 `~/.profile` 裡有 `PATH="$HOME/.local/bin:$PATH"` ——
 * 那一行把**真** claude 的目錄搶到我們前面。把 HOME 指向暫存目錄後那裡沒有 `~/.profile` 可 source，
 * 而且 stub 就放在該 HOME 的 `.local/bin` 裡：即使 profile 真的 prepend `$HOME/.local/bin`，
 * 它指的也是我們的目錄。
 */
interface Stub {
  /** 每次被呼叫時的 argv，一行一筆。 */
  calls(): string[]
}

function installStubClaude({ resumeFails = false, alwaysFails = false } = {}): Stub {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-home-')))
  const bin = path.join(home, '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const log = path.join(home, 'calls.log')

  const script = [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(log)}`,
    alwaysFails ? 'echo "stub always fails"; exit 1' : '',
    resumeFails
      ? 'if [ "$1" = "--resume" ]; then echo "No conversation found with session ID: $2"; exit 1; fi'
      : '',
    'echo STUB_READY',
    // 續接成功的 claude 是個活著的互動程式 —— stub 也必須活著，否則 session 會立刻結束，
    // 而「快速非零結束」正是自癒的判準，測試就分不清成功與失敗了。
    'exec /bin/sh -i',
  ]
    .filter(Boolean)
    .join('\n')

  fs.writeFileSync(path.join(bin, 'claude'), `${script}\n`, { mode: 0o755 })

  process.env.HOME = home
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  stubHomes.push(home)

  return {
    calls: () => {
      try {
        return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
  }
}

let stubHomes: string[] = []

describe('claude 目標的對話續接', () => {
  let origHome: string | undefined
  let origPath: string | undefined

  beforeEach(() => {
    origHome = process.env.HOME
    origPath = process.env.PATH
    stubHomes = []
  })

  afterEach(() => {
    service?.dispose()
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origPath === undefined) delete process.env.PATH
    else process.env.PATH = origPath
    for (const home of stubHomes) fs.rmSync(home, { recursive: true, force: true })
  })

  it('新建的 claude session 以我們指定的對話識別碼啟動', async () => {
    const stub = installStubClaude()
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const result = await service.create('f1', 'claude')

    await waitFor(() => stub.calls().length === 1, { label: 'stub claude 被呼叫' })
    assert.ok(result.conversationId, '應該回報實際使用的對話識別碼')
    // 由我們指定 id（而不是事後去 ~/.claude/projects 猜哪個 jsonl 是我們的）—— 於是它可以被
    // 持久化，下次直接 --resume 它。
    assert.equal(stub.calls()[0], `--session-id ${result.conversationId}`)
  })

  it('重建的 claude session 續接同一個對話', async () => {
    const stub = installStubClaude()
    const conversation = '44444444-4444-4444-8444-444444444444'
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const result = await service.create('f1', 'claude', { resumeConversationId: conversation })

    await waitFor(() => stub.calls().length === 1, { label: 'stub claude 被呼叫' })
    assert.equal(stub.calls()[0], `--resume ${conversation}`)
    // --resume 沿用原 id（--fork-session 才換號）—— 所以持久化的識別碼跨多次重開都有效。
    assert.equal(result.conversationId, conversation)
  })

  it('被竄改的對話識別碼不得被拼進命令', async () => {
    const stub = installStubClaude()
    const marker = path.join(repo, 'pwned')
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    // 持久化檔案是磁碟上的檔案 —— 它是不受信任的輸入。這個值會走到 `$SHELL -l -c "claude …"`，
    // 一個字串命令。
    const result = await service.create('f1', 'claude', {
      resumeConversationId: `x; touch ${marker}`,
    })

    await waitFor(() => stub.calls().length === 1, { label: 'stub claude 被呼叫' })
    assert.equal(fs.existsSync(marker), false, '注入的命令絕不可被執行')
    assert.ok(!stub.calls()[0].includes('touch'), '未經驗證的值絕不可進入 argv')
    // 「沒有東西可以續接」不是錯誤 —— 以一個全新的對話開始，而不是讓這個 session 死掉。
    assert.equal(stub.calls()[0], `--session-id ${result.conversationId}`)
  })

  it('續接失敗時以全新的對話識別碼自癒，session 不死', async () => {
    // **這是主線，不是例外**：實測「開了 claude session、還沒跟它講話就關掉 app」時 claude 根本
    // 不寫 transcript —— 於是重建時 --resume 必定失敗。
    const stub = installStubClaude({ resumeFails: true })
    const stale = '55555555-5555-4555-8555-555555555555'
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const { sessionId } = await service.create('f1', 'claude', { resumeConversationId: stale })

    await waitFor(() => conversations.length === 1, { label: '自癒回報新的對話識別碼' })
    const healed = conversations[0].conversationId

    assert.equal(conversations[0].sessionId, sessionId, 'session 的身分不變')
    assert.notEqual(healed, stale, '必須換一個全新的 id')
    // 沿用舊 id 會撞上 `Error: Session ID … is already in use.`（實測）——
    // 這正是 `claude --resume X || claude --session-id X` 那種寫法是個陷阱的原因。
    // **等 stub 真的記下第二次呼叫。** 產品在 spawn 的當下就回報了新的 conversationId，
    // 但 stub 是在自己的行程裡 `echo "$@" >> log` —— 中間隔著一次 fork/exec。直接斷言會在
    // 機器負載高時讀到只有一筆的 log（實測：平行跑完整 npm test 時偶爾紅）。其餘的
    // `stub.calls()` 斷言本來就都先 waitFor 過，這裡與下一條漏了。
    await waitFor(() => stub.calls().length === 2, { label: 'stub 記下了自癒的那次呼叫' })
    assert.deepEqual(stub.calls(), [`--resume ${stale}`, `--session-id ${healed}`])

    await waitFor(() => output().includes('STUB_READY'), { label: '新的 claude 起來了' })
    assert.equal(
      exits.some((entry) => entry.sessionId === sessionId),
      false,
      '自癒過的 session 不該被回報為結束',
    )
    assert.equal(service.sessionCount, 1)
  })

  /**
   * **自癒重生的 pty 必須留在原本的工作目錄。**
   *
   * 這條的失效方式是最惡劣的那種：自癒對 renderer **完全不可見**（`status` 一直是 `running`），
   * 使用者拿到一個能用的 agent，只是它**站在錯的地方**，沒有任何訊號。而自癒是**主線情境**
   * ——「開了 session 卻還沒跟 agent 講過話」時它不寫 transcript，`--resume` 必定失敗。
   *
   * 與旁邊那條「繼承將死那顆 pty 的 cols／rows」同一個位置、同一種疏漏（那一行當年也是漏掉
   * 後才補的）。
   */
  it('自癒重生的 pty 仍在原本的工作目錄，不回到 folder 根', async () => {
    const wt = fs.mkdtempSync(path.join(tmpdir(), 'spekterm-wt-'))
    const real = fs.realpathSync(wt)
    installStubClaude({ resumeFails: true })
    const stale = '77777777-7777-4777-8777-777777777777'
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    // 這個 session 開在一個（邊界外的）工作目錄裡，然後續接失敗。
    const { sessionId } = await service.create('f1', 'claude', {
      resumeConversationId: stale,
      cwd: real,
      worktreeRoots: [real],
    })

    await waitFor(() => conversations.length === 1, { label: '自癒發生了' })
    await waitFor(() => output().includes('STUB_READY'), { label: '自癒後的 claude 起來了' })

    // stub 收尾是一個可以打字的互動 shell —— 問它自己站在哪。
    service.write(sessionId, 'echo CWD=$(pwd)\n')
    await waitFor(() => output().includes(`CWD=${real}`), {
      label: '自癒後的 pty 仍在該工作目錄',
    })
    fs.rmSync(wt, { recursive: true, force: true })
  })

  it('自癒至多一次 —— claude 根本起不來時不反覆重試', async () => {
    const stub = installStubClaude({ alwaysFails: true })
    const stale = '66666666-6666-4666-8666-666666666666'
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const { sessionId } = await service.create('f1', 'claude', { resumeConversationId: stale })

    await waitFor(() => exits.some((entry) => entry.sessionId === sessionId), {
      label: 'session 以結束呈現',
    })
    await waitFor(() => stub.calls().length === 2, { label: 'stub 記下了兩次啟動' })
    await delay(300)

    // 啟動的嘗試不超過兩次（原本那次 + 自癒那次）—— `delay` 之後仍然是 2，才叫「不反覆重試」。
    assert.equal(stub.calls().length, 2)
    assert.equal(exits.filter((entry) => entry.sessionId === sessionId).length, 1)
  })
})

describe('重建的工作目錄', () => {
  it('於最後已知的子目錄重生', async () => {
    const sub = path.join(repo, 'packages', 'app')
    fs.mkdirSync(sub, { recursive: true })
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const { sessionId } = await service.create('f1', 'shell', { cwd: sub })

    // 回顯不含答案：`$(pwd)` 在輸入行的回顯裡不會展開，只有真的執行了才會出現。
    service.write(sessionId, 'echo CWD=$(pwd)\n')
    await waitFor(() => output().includes(`CWD=${sub}`), { label: 'cwd 為子目錄' })
  })

  it('越出 folder 邊界的工作目錄退回根目錄', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    // 使用者關掉 app 之前 `cd /tmp` 了 —— 重建不得把 pty 開在 workspace 之外。
    const { sessionId } = await service.create('f1', 'shell', { cwd: fs.realpathSync(tmpdir()) })

    service.write(sessionId, 'echo CWD=$(pwd)\n')
    await waitFor(() => output().includes(`CWD=${repo}`), { label: 'cwd 退回 folder 根目錄' })
  })

  it('已不存在的工作目錄退回根目錄', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const { sessionId } = await service.create('f1', 'shell', { cwd: path.join(repo, 'gone') })

    service.write(sessionId, 'echo CWD=$(pwd)\n')
    await waitFor(() => output().includes(`CWD=${repo}`), { label: 'cwd 退回 folder 根目錄' })
  })

  /**
   * 夾制的範圍由「folder 邊界內」放寬為「folder 根，**或該 repo 任一工作目錄**」。
   *
   * 邊界外的 worktree（`/tmp/...`）是本 change 的重點：它在放寬前必定被夾制掉，
   * 而那正是「`cd` 到邊界外的 worktree、關 app 再開就回到 folder 根」那個既有缺陷。
   */
  it('落在工作目錄之下的 cwd 不再被夾制掉（即使該工作目錄在 folder 邊界外）', async () => {
    const outside = fs.mkdtempSync(path.join(tmpdir(), 'spekterm-wt-'))
    const real = fs.realpathSync(outside)
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const { sessionId } = await service.create('f1', 'shell', {
      cwd: real,
      worktreeRoots: [real],
    })

    service.write(sessionId, 'echo CWD=$(pwd)\n')
    await waitFor(() => output().includes(`CWD=${real}`), { label: 'cwd 為邊界外的工作目錄' })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('兩者皆非的 cwd 仍退回根目錄', async () => {
    const outside = fs.mkdtempSync(path.join(tmpdir(), 'spekterm-elsewhere-'))
    const wt = fs.mkdtempSync(path.join(tmpdir(), 'spekterm-wt-'))
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    // 合法根集合裡有一個工作目錄，但 cwd 不在它底下，也不在 folder 底下。
    const { sessionId } = await service.create('f1', 'shell', {
      cwd: fs.realpathSync(outside),
      worktreeRoots: [fs.realpathSync(wt)],
    })

    service.write(sessionId, 'echo CWD=$(pwd)\n')
    await waitFor(() => output().includes(`CWD=${repo}`), { label: 'cwd 退回 folder 根目錄' })
    fs.rmSync(outside, { recursive: true, force: true })
    fs.rmSync(wt, { recursive: true, force: true })
  })

  it('工作目錄集合為空時行為與放寬前一致', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    const { sessionId } = await service.create('f1', 'shell', { cwd: fs.realpathSync(tmpdir()) })

    service.write(sessionId, 'echo CWD=$(pwd)\n')
    await waitFor(() => output().includes(`CWD=${repo}`), { label: 'cwd 退回 folder 根目錄' })
  })
})

describe('pty 的環境', () => {
  it('抹掉「巢狀 Claude Code」的標記 —— 否則裡面的 claude 不寫 transcript，續接永遠失敗', () => {
    // spekterm 若由一個 agent 啟動（dogfooding 的常態），Electron 會繼承那個 Claude Code session
    // 的 env。**巢狀的 claude 不寫 transcript**（二分實測：元兇是 `CLAUDE_CODE_CHILD_SESSION`）——
    // 於是 `--resume` 必然失敗，而自癒機制會把這個失敗**蓋掉**：使用者拿到一個能用的 claude，
    // 只是對話永遠是全新的。看起來像正常運作。
    const env = ptyEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_CHILD_SESSION: 'true',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'def',
      CLAUDE_CODE_AGENT: 'x',
      CLAUDE_JOB_DIR: '/tmp/job',
      PATH: '/usr/bin',
    })

    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined)
    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined)
    assert.equal(env.CLAUDE_CODE_BRIDGE_SESSION_ID, undefined)
    assert.equal(env.CLAUDE_CODE_AGENT, undefined)
    assert.equal(env.CLAUDE_JOB_DIR, undefined)

    // 其餘一律保留，且 TERM 對齊前端的 xterm。
    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.TERM, 'xterm-256color')
  })

  it('應用程式自己持有的機密不出現在 pty 環境的任何一個值裡', () => {
    // **這是一條純否定斷言，它的鑑別力不在自己身上。** 如果機密與 pty 之間本來就沒有任何連線，
    // 它對「這個機制完全不存在」的實作也照樣綠 —— 判準見 `docs/lessons/probes.md`：
    // 「如果這個機制整個不存在，這條會不會照樣綠？」會。
    //
    // 它真正的作用是**回歸絆線**：`ptyEnv()` 展開 `process.env`，所以任何模組往那裡寫一個值，
    // 都會出現在這裡。鑑別力由 `scripts/secret-scope.test.mjs` 的三道守衛提供
    // （尤其是「`process.env` 的指派只允許一個地方」那一道）。
    //
    // **而這兩者是互補的，不是重複的**：那道守衛豁免 `user-env.ts`（使用者環境唯一的套用點），
    // 所以那個檔案裡的一行 `process.env.X = …` 守衛抓不到 —— **這條抓得到**。
    //
    // **因此必須呼叫 `ptyEnv()` 而不傳 `source`。** 第一版傳了明確的 `{ PATH: … }`，
    // 於是它繞過了 `process.env` 這個真正的向量：一個真的往 process.env 寫機密的實作，
    // 這條照樣綠。
    //
    // **sentinel 要獨特到不會被任何東西吞掉** —— 用 `'token'` 之類的字串，這條斷言會在
    // 某個無關的值裡偶然命中而變成噪音。
    const sentinel = 'xoxp-SENTINEL-a7f3c91e-do-not-leak'
    const secretsBase = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-secret-pty-')))
    const store = new SecretStore(path.join(secretsBase, 'secrets.json'))
    store.load()
    store.set('slack.userToken', sentinel)

    const env = ptyEnv()

    for (const [key, value] of Object.entries(env)) {
      assert.equal(
        value?.includes(sentinel) ?? false,
        false,
        `機密出現在 pty 環境的 ${key} 裡`,
      )
    }
    // 前提：這個環境本來就不是空的（否則上面的迴圈跑零次而恆真）。
    assert.ok(Object.keys(env).length > 3, `pty 環境意外地空：${Object.keys(env).length} 個變數`)
    assert.equal(env.TERM, 'xterm-256color')

    fs.rmSync(secretsBase, { recursive: true, force: true })
  })

  it('不以前綴一概剝除 —— 認證用的變數必須留下', () => {
    // `CLAUDE_CODE_OAUTH_TOKEN` 是認證用的。以 `CLAUDE*` 前綴一概剝除，claude 會登不進去。
    const env = ptyEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      CLAUDE_CODE_CHILD_SESSION: 'true',
    })

    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'secret')
    assert.equal(env.ANTHROPIC_API_KEY, 'secret')
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined)
  })
})

describe('全域 session：不隸屬任何 folder，位置為家目錄', () => {
  let service: TerminalService

  afterEach(() => {
    service?.dispose()
  })

  it('初始 cwd 為家目錄，且不需要任何 folder 存在', async () => {
    // **workspace 完全是空的** —— 全域 session 不查表，位置是主行程的常數。
    service = new TerminalService(lookup([]), sink())
    const id = (await service.create(null, 'shell')).sessionId
    assert.equal(service.sessionCount, 1)

    // `$(pwd)` 在回顯裡不會展開 —— 出現 `CWD=<家目錄>` 就一定是真的執行了。
    service.write(id, 'echo CWD=$(pwd)\r')
    await waitFor(() => output().includes(`CWD=${os.homedir()}`), { label: 'cwd = 家目錄' })
  })

  /**
   * **`cwdOf` 對全域 session 不做路徑夾制**（design D3）。
   *
   * 既有夾制的正當性來自「session 宣稱自己屬於某個 folder」；全域 session 沒有這個宣稱 ——
   * 家目錄是它的**起點**而非**邊界**。
   *
   * **對照組**：把 `cwdAllowed()` 的 `if (scope.global) return true` 拿掉（讓全域也走
   * `withinAny`），這一條必須變紅 —— 家目錄之外的位置會被夾制掉而回 `undefined`。
   */
  it('cd 到家目錄之外的位置後，該位置仍被記錄（不受路徑夾制）', async () => {
    service = new TerminalService(lookup([]), sink())
    const id = (await service.create(null, 'shell')).sessionId

    // `repo` 是測試自建的暫存目錄，必然落在家目錄之外。
    service.write(id, `cd ${repo}\r`)
    service.write(id, 'echo MOVED=$(pwd)\r')
    await waitFor(() => output().includes(`MOVED=${repo}`), { label: 'cd 已生效' })

    await waitFor(() => service.cwdOf(id) === repo, {
      label: '家目錄之外的 cwd 仍被記錄',
    })
  })

  /**
   * 重建路徑的降級：**目錄已不存在時退回家目錄，而不是讓重建失敗**。
   *
   * 全域 session 不受路徑夾制，但存在性檢查照留 —— 使用者關 app 前所在的目錄可能在這段期間
   * 被刪掉了（`/tmp` 下的暫存目錄尤其常見）。
   */
  it('最後已知的工作目錄已不存在時，退回家目錄', async () => {
    service = new TerminalService(lookup([]), sink())
    const id = (await service.create(null, 'shell', { cwd: path.join(repo, 'gone-for-good') })).sessionId

    service.write(id, 'echo CWD=$(pwd)\r')
    await waitFor(() => output().includes(`CWD=${os.homedir()}`), { label: '退回家目錄' })
  })

  it('關閉後不留下 pty', async () => {
    service = new TerminalService(lookup([]), sink())
    const id = (await service.create(null, 'shell')).sessionId
    service.kill(id)
    await waitFor(() => service.sessionCount === 0, { label: 'pty 已釋放' })
  })
})

describe('由 intake 建立的 session 其啟動參數與手動建立者等價', () => {
  /**
   * **這條刻意寫成等價／白名單，而不是「不得含某些旗標」。**
   *
   * 後者是黑名單：它只擋得住列舉得出來的東西，而且**在今日恆真** —— `create()` 根本沒有
   * 能夠加旗標的參數。一條恆真的斷言撐不住任何東西。
   *
   * 等價形式涵蓋所有未來新增的旗標，並順帶驗證了「走相同路徑」：`agent-intake` 不擴充
   * `terminal.create` 的介面，於是「由 intake 建立」與「手動建立」在這一層根本沒有分岔。
   *
   * **允許相異的只有三樣**：對話識別碼（每次都是新的 UUID）、注入設定的位置（未注入時兩者皆無），
   * 以及固定名字的**值**（`agent-peer-name`：每個 claude session 都有、各自不同）。其餘逐項相同，**且參數個數相同** —— 一個多出來的旗標必然破壞後者，
   * 不論正規化怎麼寫。
   */
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

  function normalize(argv: string): string[] {
    // 名字只換掉**值** —— 旗標本身仍逐項比對，於是「多一個旗標」照樣破壞等價。
    return argv.replace(UUID, '<conversation>').replace(/--name=\S+/g, '--name=<name>').split(' ')
  }

  it('去除對話識別碼與名字的值之後逐項相同，且參數個數相同', async () => {
    const stub = installStubClaude()
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())

    await service.create('f1', 'claude', { peerName: 'alpha-1111' })
    await waitFor(() => stub.calls().length === 1, { label: '第一個 session' })
    await service.create('f1', 'claude', { peerName: 'alpha-2222' })
    await waitFor(() => stub.calls().length === 2, { label: '第二個 session' })

    const [first, second] = stub.calls().map(normalize)
    assert.deepEqual(first, second)
    assert.equal(first.length, second.length)
  })

  it('對照組：多一個旗標即破壞等價（證明這條斷言有鑑別力）', () => {
    const withFlag = normalize('--session-id 11111111-2222-3333-4444-555555555555 --dangerous-extra')
    const without = normalize('--session-id 66666666-7777-8888-9999-000000000000')
    assert.notDeepEqual(withFlag, without)
    assert.notEqual(withFlag.length, without.length)
  })

  it('對照組：一個長得像路徑的旗標同樣破壞等價（驗正規化本身）', () => {
    // 正規化若以**位置**處理（第 N 個元素是可變片段），一個長得像路徑的旗標會落進
    // 被當成「可變」的那一格而溜過去。以個數與逐項比對就沒有那個洞。
    const withFlag = normalize('--session-id 11111111-2222-3333-4444-555555555555 /tmp/looks/like/a/path')
    const without = normalize('--session-id 66666666-7777-8888-9999-000000000000')
    assert.notDeepEqual(withFlag, without)
  })
})

describe('交接的落點', () => {
  it('session 結束時通知交接收掉它的落點', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spekterm-terminal-'))
    const ended: string[] = []
    const service = new TerminalService(
      lookup([{ id: 'f1', path: repo, status: 'ok' }]),
      sink(),
      () => false,
      () => false,
      () => '',
      () => null,
      (sessionId) => ended.push(sessionId),
    )
    const id = (await service.create('f1', 'shell')).sessionId
    service.kill(id)
    // **這條釘住的是「有人呼叫它」** —— `clearOutbox` 自己有單元測試，而那個測試在
    // 「產品從來沒接上它」時照樣是綠的（實測：接線漏了一整輪驗收都沒紅）。
    assert.deepEqual(ended, [id])
    service.dispose()
    fs.rmSync(repo, { recursive: true, force: true })
  })
})

describe('固定名字的交付（agent-peer-name）', () => {
  it('名字經環境變數交給 claude，不拼進命令字串', async () => {
    const stub = installStubClaude()
    // **這個值刻意不合法**（`decidePeerName` 不會產生它）—— 它是用來證明交付路徑本身不經 shell
    // 再解析一次：若名字被拼進命令字串，`$(...)` 會被執行。
    const marker = path.join(repo, 'pwned')
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    await service.create('f1', 'claude', { peerName: `x$(touch ${marker})` })
    await waitFor(() => stub.calls().length === 1, { label: 'claude 被呼叫' })
    assert.ok(stub.calls()[0].endsWith(`--name=x$(touch ${marker})`), stub.calls()[0])
    assert.equal(fs.existsSync(marker), false, '名字中的命令不得被執行')
  })

  it('注入功能全部關閉時仍帶名字', async () => {
    const stub = installStubClaude()
    // 建構子預設三個注入功能皆關、設定檔為空 ⇒ `composeInjection` 回 null。
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    await service.create('f1', 'claude', { peerName: 'alpha-1111' })
    await waitFor(() => stub.calls().length === 1, { label: 'claude 被呼叫' })
    assert.ok(stub.calls()[0].includes('--name=alpha-1111'), stub.calls()[0])
  })

  it('自癒出來的 agent 沿用相同的名字', async () => {
    const stub = installStubClaude({ resumeFails: true })
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    await service.create('f1', 'claude', {
      resumeConversationId: '55555555-5555-4555-8555-555555555555',
      peerName: 'alpha-1111',
    })
    await waitFor(() => stub.calls().length === 2, { label: '自癒的那次呼叫' })
    for (const call of stub.calls()) assert.ok(call.includes('--name=alpha-1111'), call)
  })

  it('shell 目標不帶名字', async () => {
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    const { sessionId } = await service.create('f1', 'shell', { peerName: 'alpha-1111' })
    service.write(sessionId, 'echo "NAME=[$SPEKTERM_PEER_NAME]"\n')
    // The pty echoes the typed command back, and that echo already contains `NAME=[` — so wait
    // for the expanded form (anything but `$` after the bracket), not for the echo.
    await waitFor(() => /NAME=\[[^$]/.test(output()), { label: 'shell 回應' })
    assert.ok(output().includes('NAME=[]'), output())
  })

  it('外層的 SPEKTERM_* 不進入 pty 的環境', () => {
    const env = ptyEnv(
      { PATH: '/usr/bin', SPEKTERM_PEER_NAME: 'outer-1111', SPEKTERM_HANDOFF_DIR: '/outer', SPEKTERM_EVENT_DIR: '/e' },
      {},
    )
    assert.equal(env.SPEKTERM_PEER_NAME, undefined)
    assert.equal(env.SPEKTERM_HANDOFF_DIR, undefined)
    assert.equal(env.SPEKTERM_EVENT_DIR, undefined)
    assert.equal(env.PATH, '/usr/bin')
  })

  it('同一個 session 的前一顆 pty 結束之前，不啟動新的', async () => {
    installStubClaude()
    const first = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    const sessionId = '66666666-6666-4666-8666-666666666666'
    await first.create('f1', 'claude', { sessionId, peerName: 'alpha-6666' })
    await waitFor(() => output().includes('STUB_READY'), { label: '第一個 claude 起來了' })

    // renderer 重新載入：舊服務非同步地殺掉 pty，新服務立刻以同一個識別碼喚醒。
    first.dispose()
    service = new TerminalService(lookup([{ id: 'f1', path: repo, status: 'ok' }]), sink())
    await service.create('f1', 'claude', { sessionId, peerName: 'alpha-6666' })
    assert.ok(
      exits.some((entry) => entry.sessionId === sessionId && entry.reason === 'disposed'),
      '新的 pty 誕生時，舊的那一顆已經結束',
    )
  })
})

describe('TerminalService.hibernate (session-hibernation)', () => {
  /** A service that records which sessions had their handoff drop point ended. */
  function hibernatable(ended: string[]): TerminalService {
    return new TerminalService(
      lookup([{ id: 'f1', path: repo, status: 'ok' }]),
      sink(),
      () => false,
      () => false,
      () => '',
      () => null,
      (sessionId) => ended.push(sessionId),
    )
  }

  it('ends the pty with reason hibernated, and leaves the drop point alone', async () => {
    const ended: string[] = []
    service = hibernatable(ended)
    const id = (await service.create('f1', 'shell')).sessionId

    assert.equal(service.hibernate(id), true)
    assert.equal(service.sessionCount, 0, 'the session no longer holds a pty')
    await waitFor(() => exits.some((entry) => entry.sessionId === id), { label: 'exit event' })
    assert.deepEqual(
      exits.filter((entry) => entry.sessionId === id).map((entry) => entry.reason),
      ['hibernated'],
    )
    // **Control**: `kill()` ends the drop point — hibernation through it would make this red.
    assert.deepEqual(ended, [], 'hibernation is not closing: the drop point stays')
  })

  it('drops output from the hibernating pty', async () => {
    service = hibernatable([])
    const id = (await service.create('f1', 'shell')).sessionId
    service.write(id, 'echo READY_$((1+1))\r')
    await waitFor(() => output().includes('READY_2'), { label: 'shell is up' })

        // A shell that never stops printing: whatever it emits between the request and its death
    // must not reach the sink.
    service.write(id, 'while :; do echo TICK_$((2*3)); done\r')
    await waitFor(() => output().includes('TICK_6'), { label: 'the loop is printing' })
    const before = chunks.length
    service.hibernate(id)
    await waitFor(() => exits.some((entry) => entry.sessionId === id), { label: 'exit event' })
    await delay(200)
    const after = chunks.slice(before).map((entry) => entry.chunk).join('')
    assert.equal(after, '', 'no output after hibernate reaches the sink')
  })

  it('is a no-op for an unknown session and for one already hibernated', async () => {
    service = hibernatable([])
    assert.equal(service.hibernate('nope'), false)
    const id = (await service.create('f1', 'shell')).sessionId
    assert.equal(service.hibernate(id), true)
    assert.equal(service.hibernate(id), false)
  })

  it('kill() reports whether the session had a pty', async () => {
    service = hibernatable([])
    const id = (await service.create('f1', 'shell')).sessionId
    assert.equal(service.kill(id), true)
    assert.equal(service.kill(id), false)
  })

  it('reports an idle shell at its prompt, and a busy one running a job', async () => {
    service = hibernatable([])
    const id = (await service.create('f1', 'shell')).sessionId
    service.write(id, 'echo READY_$((1+1))\r')
    await waitFor(() => output().includes('READY_2'), { label: 'shell is up' })
    await waitFor(() => service?.idleFactsOf(id)?.shell === 'idle', { label: 'idle at the prompt' })

        service.write(id, 'sleep 5\r')
    await waitFor(() => service?.idleFactsOf(id)?.shell === 'busy', { label: 'busy with a foreground job' })
    assert.equal(service.idleFactsOf('nope'), null)
  })
})
