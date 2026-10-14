import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { FSWatcher } from 'chokidar'
import { BranchService } from './branch-service'
import { findPollingPath } from './polling-mount.testkit'
import { type CreateWatcherOptions, createWatcher } from './watcher'
import type { FolderLookup, WorkspaceFolder } from './workspace-store'

let base: string
let service: BranchService | null
let created: Array<{ options: CreateWatcherOptions; watcher: FSWatcher }>

beforeEach(() => {
  base = fs.mkdtempSync(path.join(tmpdir(), 'spekterm-branch-'))
  service = null
  created = []
})

afterEach(async () => {
  await service?.dispose()
  // service 已關掉它持有的那些；這裡收拾工廠建出但未被持有的漏網之魚。
  await Promise.all(created.map(({ watcher }) => watcher.close().catch(() => {})))
  fs.rmSync(base, { recursive: true, force: true })
})

/** 記錄每一次建立，並把真正的 watcher 交回去 —— 驗的是**建出來的東西**，不是參數。 */
const spyFactory: typeof createWatcher = (options) => {
  const watcher = createWatcher(options)
  created.push({ options, watcher })
  return watcher
}

function folderAt(folderPath: string): WorkspaceFolder {
  return {
    id: 'f1',
    path: folderPath,
    addedAt: new Date(0).toISOString(),
    name: path.basename(folderPath),
    status: 'ok',
    hasOpenSpec: false,
    pinned: false,
    branch: null,
  }
}

function usePollingOf(watcher: FSWatcher): boolean {
  return (watcher as unknown as { options: { usePolling: boolean } }).options.usePolling
}

/**
 * issue #16：第二層 watcher 監看的是 gitdir 底下的 `HEAD`，而 worktree／submodule 的 gitdir
 * **可能與 folder 根落在不同掛載點上**。以 folder 根判定輪詢，會讓「gitdir 在網路檔案系統」
 * 靜默退回 native watch —— `fs.watch` 只是永遠不觸發，沒有錯誤可 emit，錯誤回報救不到。
 *
 * fixture 重現的正是這個情形：folder 根在 tmpdir（本機，不需輪詢），`.git` 是**檔案**且指向
 * 一個位於需要輪詢的檔案系統上的 gitdir。修正前 `usePolling=false`，修正後 `true`。
 */
describe('BranchService 的輪詢判定依據', () => {
  it('HEAD watcher 以 gitdir 判定，而非 folder 根', (t) => {
    const pollingPath = findPollingPath(base)
    if (!pollingPath) {
      console.log('  ↷ 略過：找不到需要輪詢的掛載點（或環境覆寫使對照組不成立）')
      return t.skip()
    }

    // gitdir 位於需要輪詢的檔案系統上。它不必存在 —— 判定只看路徑落在哪個掛載點。
    const gitDir = path.dirname(pollingPath)
    fs.writeFileSync(path.join(base, '.git'), `gitdir: ${gitDir}\n`)

    service = new BranchService({ list: () => [folderAt(base)] } satisfies FolderLookup, () => {}, spyFactory)
    service.sync()

    const head = created.find(({ options }) => options.target === path.join(gitDir, 'HEAD'))
    assert.ok(head, `未建立 HEAD watcher：${created.map((c) => c.options.target).join(', ')}`)
    assert.equal(usePollingOf(head.watcher), true, '以 folder 根判定了 —— gitdir 在別的掛載點上')
  })

  it('第一層仍以 folder 根自己判定（對照：不是每個 watcher 都輪詢）', (t) => {
    const pollingPath = findPollingPath(base)
    if (!pollingPath) {
      console.log('  ↷ 略過：找不到需要輪詢的掛載點（或環境覆寫使對照組不成立）')
      return t.skip()
    }

    fs.writeFileSync(path.join(base, '.git'), `gitdir: ${path.dirname(pollingPath)}\n`)

    service = new BranchService({ list: () => [folderAt(base)] } satisfies FolderLookup, () => {}, spyFactory)
    service.sync()

    // 少了這一條，上一條分不出「以 gitdir 判定」與「這台機器什麼都要輪詢」。
    const root = created.find(({ options }) => options.target === base)
    assert.ok(root, '未建立 folder 根 watcher')
    assert.equal(usePollingOf(root.watcher), false)
  })
})

/**
 * Resolves once every watcher the service has built reports `ready`. Call it right after `sync()`:
 * chokidar emits `ready` asynchronously, so the listener is attached in time.
 */
function allReady(): Promise<unknown> {
  return Promise.all(created.map(({ watcher }) => new Promise<void>((resolve) => watcher.once('ready', () => resolve()))))
}

/** Counts `onChanged` calls; `settle` waits past the service's debounce. */
function changeCounter(): { count: () => number; onChanged: () => void } {
  let n = 0
  return { count: () => n, onChanged: () => { n += 1 } }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))

describe('BranchService carries hasOpenSpec', () => {
  it('pushes the folder list when openspec/ is created and removed while the app runs', async () => {
    const counter = changeCounter()
    service = new BranchService({ list: () => [folderAt(base)] } satisfies FolderLookup, counter.onChanged, spyFactory)
    service.sync()
    await allReady()

    // Control: another top-level entry is the agent's noise and must not push.
    fs.writeFileSync(path.join(base, 'README.md'), 'x')
    fs.mkdirSync(path.join(base, 'src'))
    await settle()
    assert.equal(counter.count(), 0, 'a top-level entry other than .git / openspec pushed the list')

    fs.mkdirSync(path.join(base, 'openspec', 'specs'), { recursive: true })
    await settle()
    assert.equal(counter.count(), 1, 'creating openspec/ did not push the folder list')

    fs.rmSync(path.join(base, 'openspec'), { recursive: true })
    await settle()
    assert.equal(counter.count(), 2, 'removing openspec/ did not push the folder list')
  })
})
