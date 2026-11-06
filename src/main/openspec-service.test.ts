import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { AggregatedScanResult } from '@spekjs/core'
import { OpenSpecService, OpenSpecServiceError } from './openspec-service'
import type { FolderLookup, WorkspaceFolder } from './workspace-store'

const SPEC_AUTH =
  '# auth Specification\n\n## Purpose\n\n登入。\n\n## Requirements\n\n### Requirement: 可登入\n\n系統 SHALL 允許登入。\n\n#### Scenario: 正確的密碼\n\n- **WHEN** 密碼正確\n- **THEN** 登入成功\n'
const DELTA_AUTH =
  '## ADDED Requirements\n\n### Requirement: OAuth\n\n系統 SHALL 支援 OAuth。\n\n#### Scenario: Google\n\n- **WHEN** 選擇 Google\n- **THEN** 導向 Google\n'

let base: string
let repo: string
let outside: string
let changed: string[]
let service: OpenSpecService | null

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** chokidar 的初次掃描是非同步的；改檔案之前必須讓它完成，否則事件不會來。 */
const READY_MS = 300

/**
 * Lets the fixture's own writes settle before a watch starts. On macOS a directory watch can report files written
 * a moment before it started (FSEvents delivers them late), which reaches an assertion of an exact notification
 * list as an extra `'f1'`. Measured: the unchanged code receives such events too; whether one lands inside a test's
 * window depends on how long the watch takes to start. Linux (CI) does not need it.
 */
const settleFixture = (): Promise<void> => delay(400)

function lookup(folders: Partial<WorkspaceFolder>[]): FolderLookup {
  return { list: () => folders as WorkspaceFolder[] }
}

function okFolder(): FolderLookup {
  return lookup([{ id: 'f1', path: repo, status: 'ok' }])
}

function write(relPath: string, content: string): void {
  const target = path.join(repo, relPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

/**
 * 一個最小但完整的 OpenSpec repo：一份 spec、一個 active change（含 tasks 與 delta spec）、
 * 一個 archived change。
 */
function makeRepo(): void {
  write('openspec/config.yaml', 'schema: spec-driven\n')
  write(
    'openspec/specs/auth/spec.md',
    '# auth Specification\n\n## Purpose\n\n登入。\n\n## Requirements\n\n### Requirement: 使用者可登入\n\n系統 SHALL 允許登入。\n\n#### Scenario: 正確的密碼\n\n- **WHEN** 密碼正確\n- **THEN** 登入成功\n',
  )
  write(
    'openspec/changes/add-oauth/proposal.md',
    '# 加入 OAuth\n\n## Why\n\n因為需要。\n',
  )
  write(
    'openspec/changes/add-oauth/tasks.md',
    '## 1. 後端\n\n- [x] 1.1 建立 endpoint\n- [ ] 1.2 接上 provider\n\n## 2. 前端\n\n- [ ] 2.1 加按鈕\n',
  )
  write(
    'openspec/changes/add-oauth/specs/auth/spec.md',
    '## ADDED Requirements\n\n### Requirement: 使用者可用 OAuth 登入\n\n系統 SHALL 支援 OAuth。\n\n#### Scenario: 以 Google 登入\n\n- **WHEN** 使用者選擇 Google\n- **THEN** 導向 Google\n',
  )
  write(
    'openspec/changes/archive/2026-01-01-old-change/proposal.md',
    '# 舊的 change\n\n## Why\n\n歷史。\n',
  )
  /*
    **資料 artifact 自成一個 change，不掛在 `add-oauth` 上。**

    共用 fixture 裡沒有空位：`add-oauth` 的 artifact 組成被本檔以外的斷言依賴著，而「多一個
    artifact」正是那種會讓別人靜默改變的事。副檔名刻意取兩種（`.yaml` 與 `.json`）——
    `relPath` 若退回「`id` 補 `.md`」的舊寫法，兩條都得紅。
  */
  write('openspec/changes/add-webhook/proposal.md', '# 加入 webhook\n\n## Why\n\n因為需要。\n')
  write('openspec/changes/add-webhook/asyncapi.yaml', 'asyncapi: 3.0.0\ninfo:\n  title: Demo\n')
  write('openspec/changes/add-webhook/limits.json', '{\n  "maxRetries": 3\n}\n')
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(tmpdir(), 'spek-openspec-'))
  repo = path.join(base, 'repo')
  outside = path.join(base, 'outside')
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  makeRepo()
  changed = []
  service = null
})

afterEach(async () => {
  await service?.dispose()
  fs.rmSync(base, { recursive: true, force: true })
})

function create(
  store: FolderLookup = okFolder(),
  {
    debounceMs = 20,
    scan,
  }: { debounceMs?: number; scan?: (root: string) => Promise<AggregatedScanResult> } = {},
): OpenSpecService {
  service = scan
    ? new OpenSpecService(store, (id) => changed.push(id), debounceMs, scan)
    : new OpenSpecService(store, (id) => changed.push(id), debounceMs)
  return service
}

describe('OpenSpecService 的定址邊界', () => {
  it('未知的 folderId 被拒，且不觸及檔案系統', async () => {
    const svc = create()
    await assert.rejects(
      () => svc.getSpecs('nope'),
      (error: unknown) =>
        error instanceof OpenSpecServiceError && error.code === 'UNKNOWN_FOLDER',
    )
  })

  it('spec 的路徑以 folder-relative 呈現，不是絕對路徑', async () => {
    const specs = await create().getSpecs('f1')

    assert.equal(specs.length, 1)
    assert.equal(specs[0].topic, 'auth')
    assert.equal(specs[0].relPath, 'openspec/specs/auth/spec.md')
    assert.ok(!path.isAbsolute(specs[0].relPath ?? ''))
  })

  it('change 的 artifact 路徑以 folder-relative 呈現', async () => {
    const detail = await create().getChange('f1', 'add-oauth')

    assert.equal(detail.relPath, 'openspec/changes/add-oauth')

    const tasks = detail.artifacts.find((artifact) => artifact.id === 'tasks')
    assert.equal(tasks?.relPath, 'openspec/changes/add-oauth/tasks.md')

    const specs = detail.artifacts.find((artifact) => artifact.kind === 'specs')
    // specs 是一整棵子目錄，沒有單一檔案可跳 —— 但它底下的每個 delta spec 有。
    assert.equal(specs?.relPath, null)
    assert.equal(specs?.specs?.[0].relPath, 'openspec/changes/add-oauth/specs/auth/spec.md')
  })

  /*
    資料 artifact（core 1.11.0 起把 change 根目錄的 `.yaml` / `.yml` / `.json` 也當 artifact）。

    **這兩條的鑑別力在副檔名上。** `id` 是檔名去副檔名，於是舊寫法 `${id}.md` 組出來的
    `asyncapi.md` 是一個不存在的檔案 —— 而「在 Files 中開啟」對一個不存在的路徑只是沒有反應，
    沒有任何東西會紅。斷言路徑的**全文**（而不是「有值就好」）才擋得住它。
  */
  it('資料 artifact 被呈現，且帶著原文', async () => {
    const detail = await create().getChange('f1', 'add-webhook')

    const yaml = detail.artifacts.find((artifact) => artifact.id === 'asyncapi')
    assert.equal(yaml?.kind, 'data')
    assert.equal(yaml?.content, 'asyncapi: 3.0.0\ninfo:\n  title: Demo\n')

    const json = detail.artifacts.find((artifact) => artifact.id === 'limits')
    assert.equal(json?.kind, 'data')
    assert.equal(json?.content, '{\n  "maxRetries": 3\n}\n')
  })

  it('資料 artifact 的路徑帶著它真正的副檔名，不是補上的 .md', async () => {
    const detail = await create().getChange('f1', 'add-webhook')

    assert.equal(
      detail.artifacts.find((artifact) => artifact.id === 'asyncapi')?.relPath,
      'openspec/changes/add-webhook/asyncapi.yaml',
    )
    assert.equal(
      detail.artifacts.find((artifact) => artifact.id === 'limits')?.relPath,
      'openspec/changes/add-webhook/limits.json',
    )
    // 對照：同一個 change 的 markdown artifact 仍然正確 —— 換掉組路徑的來源沒有波及它。
    assert.equal(
      detail.artifacts.find((artifact) => artifact.id === 'proposal')?.relPath,
      'openspec/changes/add-webhook/proposal.md',
    )
  })

  it('archived change 的路徑指向 archive 目錄', async () => {
    const detail = await create().getChange('f1', '2026-01-01-old-change')

    assert.equal(detail.status, 'archived')
    assert.equal(detail.relPath, 'openspec/changes/archive/2026-01-01-old-change')
  })

  it('送往 renderer 的 DTO 完全不含絕對路徑', async () => {
    const svc = create()
    const payload = JSON.stringify([
      await svc.getOverview('f1'),
      await svc.getSpecs('f1'),
      await svc.getSpec('f1', 'auth'),
      await svc.getChanges('f1'),
      await svc.getChange('f1', 'add-oauth'),
      await svc.getGraphData('f1'),
    ])

    // repo 的絕對路徑（以及它的父目錄）不得出現在任何一個回應裡。
    assert.ok(!payload.includes(repo), 'DTO 洩漏了 repo 的絕對路徑')
    assert.ok(!payload.includes(base), 'DTO 洩漏了暫存目錄的絕對路徑')
  })
})

describe('OpenSpecService 的 identifier 白名單', () => {
  it('traversal 形式的 slug 被拒，且不讀取 folder 之外的內容', async () => {
    // folder 之外真的有一個 change 目錄 —— 若實作是拼路徑而非查表，就會讀到它。
    const outsideChange = path.join(outside, 'openspec/changes/secret')
    fs.mkdirSync(outsideChange, { recursive: true })
    fs.writeFileSync(path.join(outsideChange, 'proposal.md'), '# 機密\n')

    const svc = create()
    for (const slug of [
      '../../outside/openspec/changes/secret',
      '../../../etc',
      path.join(outside, 'openspec/changes/secret'),
    ]) {
      await assert.rejects(
        () => svc.getChange('f1', slug),
        (error: unknown) => error instanceof OpenSpecServiceError && error.code === 'NOT_FOUND',
        `slug 應被拒：${slug}`,
      )
    }
  })

  it('掃描結果中不存在的 topic 被拒', async () => {
    const svc = create()
    await assert.rejects(
      () => svc.getSpec('f1', '../../../etc/passwd'),
      (error: unknown) => error instanceof OpenSpecServiceError && error.code === 'NOT_FOUND',
    )
    await assert.rejects(
      () => svc.getSpec('f1', 'no-such-topic'),
      (error: unknown) => error instanceof OpenSpecServiceError && error.code === 'NOT_FOUND',
    )
  })

  it('存在的 slug 讀得到內容', async () => {
    const detail = await create().getChange('f1', 'add-oauth')

    assert.equal(detail.slug, 'add-oauth')
    const tasks = detail.artifacts.find((artifact) => artifact.kind === 'tasks')
    assert.equal(tasks?.tasks?.total, 3)
    assert.equal(tasks?.tasks?.completed, 1)
    assert.deepEqual(
      tasks?.tasks?.sections.map((section) => section.title),
      ['1. 後端', '2. 前端'],
    )
  })
})

describe('OpenSpecService 的快取與失效', () => {
  it('快取命中時不重複掃描', async () => {
    let scans = 0
    const real = new OpenSpecService(okFolder(), () => {}, 20)
    // 借用真的掃描一次，取得可回放的結果。
    const first = await real.getSpecs('f1')
    await real.dispose()

    const svc = create(okFolder(), {
      scan: async () => {
        scans += 1
        return {
          specs: [],
          activeChanges: [],
          archivedChanges: [],
          defaultSchema: null,
          worktrees: [],
          aggregated: false,
        }
      },
    })

    await svc.getSpecs('f1')
    await svc.getSpecs('f1')
    await svc.getChanges('f1')
    await svc.getOverview('f1')

    assert.equal(scans, 1, '四次請求只應掃描一次')
    assert.equal(first.length, 1)
  })

  it('同一個 folder 的併發請求共用一次掃描', async () => {
    let scans = 0
    const svc = create(okFolder(), {
      scan: async () => {
        scans += 1
        await delay(30)
        return {
          specs: [],
          activeChanges: [],
          archivedChanges: [],
          defaultSchema: null,
          worktrees: [],
          aggregated: false,
        }
      },
    })

    await Promise.all([
      svc.getSpecs('f1'),
      svc.getChanges('f1'),
      svc.getOverview('f1'),
      svc.getSpecs('f1'),
    ])

    assert.equal(scans, 1, '四個 tab 同時開，不該掃四次')
  })

  it('openspec 目錄變更後快取失效，且通知 renderer', async () => {
    const svc = create()

    const before = await svc.getChanges('f1')
    assert.ok(before.active.length > 0, '前提：fixture 本來就有 active change')

    await delay(READY_MS)

    // agent 新增了一個 change。
    write('openspec/changes/add-sso/proposal.md', '# 加入 SSO\n\n## Why\n\n因為需要。\n')

    const deadline = Date.now() + 3000
    while (changed.length === 0 && Date.now() < deadline) await delay(20)

    assert.deepEqual(changed, ['f1'], '應收到一次該 folder 的變更通知')

    /*
      **比的是差值，不是一個寫死的數字。** 寫死的話，任何往 fixture 加一個 change 的改動都會
      讓這條紅 —— 而它紅的理由與它要測的事（快取有沒有失效）無關。差值為 1 的鑑別力不變：
      快取若沒失效，`after` 會等於 `before`。
    */
    const after = await svc.getChanges('f1')
    assert.equal(after.active.length, before.active.length + 1, '快取應已失效並重新掃描')
  })

  it('連續變更合併為單次通知', async () => {
    const svc = create(okFolder(), { debounceMs: 120 })
    await svc.getChanges('f1')
    await delay(READY_MS)

    // agent 的一次操作會寫入數個檔案。
    write('openspec/changes/add-sso/proposal.md', '# 1\n')
    write('openspec/changes/add-sso/design.md', '# 2\n')
    write('openspec/changes/add-sso/tasks.md', '# 3\n')
    write('openspec/changes/add-sso/specs/auth/spec.md', '# 4\n')

    const deadline = Date.now() + 3000
    while (changed.length === 0 && Date.now() < deadline) await delay(20)
    await delay(300)

    assert.equal(changed.length, 1, `四次寫入應合併為一次通知，實得 ${changed.length}`)
  })

  it('釋放 folder 後不再監看', async () => {
    const svc = create()
    await svc.getSpecs('f1')
    assert.equal(svc.watchedFolderCount, 1)

    await svc.releaseFolder('f1')
    assert.equal(svc.watchedFolderCount, 0)

    await delay(READY_MS)
    write('openspec/changes/add-sso/proposal.md', '# 加入 SSO\n')
    await delay(300)

    assert.deepEqual(changed, [], '已釋放的 folder 不該再推送事件')
  })
})

/**
 * openspec-watch-skip-archive: the contents of an archived change are not watched; `changes/archive/` is, shallowly.
 * Each test lets the fixture settle first (`settleFixture`) because each asserts an exact notification list.
 */
describe('OpenSpecService and archived changes', () => {
  const archive = (...parts: string[]): string => path.join(repo, 'openspec', 'changes', 'archive', ...parts)

  async function waitForNotice(): Promise<void> {
    const deadline = Date.now() + 3000
    while (changed.length === 0 && Date.now() < deadline) await delay(20)
    await delay(100)
  }

  async function watching(): Promise<void> {
    await settleFixture()
    await create().getChanges('f1')
    await delay(READY_MS)
  }

  it('archiving a change notifies once its directory moves into the archive', async () => {
    await watching()
    fs.renameSync(
      path.join(repo, 'openspec', 'changes', 'add-oauth'),
      archive('2026-02-02-add-oauth'),
    )
    await waitForNotice()
    // Two watchers see it (the tree the directory leaving changes/, the archive one it arriving); the debounce
    // usually merges them, not always.
    assert.ok(changed.length >= 1 && changed.every((id) => id === 'f1'), `got ${JSON.stringify(changed)}`)
  })

  it('an archived change directory arriving on its own notifies', async () => {
    await watching()
    write('openspec/changes/archive/2026-03-03-pulled/proposal.md', '# pulled\n')
    await waitForNotice()
    assert.deepEqual(changed, ['f1'], 'nothing left changes/, so only the archive watcher can see this')
  })

  it('an edit inside an archived change does not notify', async () => {
    await watching()
    fs.appendFileSync(archive('2026-01-01-old-change', 'proposal.md'), 'edited\n')
    await delay(READY_MS + 200)
    assert.deepEqual(changed, [])
  })

  it('an archive directory created after the watch started is followed', async () => {
    fs.rmSync(archive(), { recursive: true })
    await watching()

    write('openspec/changes/archive/2026-04-04-first/proposal.md', '# first\n')
    await waitForNotice()
    assert.deepEqual(changed, ['f1'], 'the archive directory appearing is a change')

    // No structure is read in between: only the rebuild on the archive's own event can see the second one.
    changed.length = 0
    await delay(READY_MS)
    write('openspec/changes/archive/2026-04-05-second/proposal.md', '# second\n')
    await waitForNotice()
    assert.deepEqual(changed, ['f1'], 'a later archived change is seen too')
  })

  it('an archive directory removed and created again is followed', async () => {
    await watching()

    fs.rmSync(archive(), { recursive: true })
    await waitForNotice()
    write('openspec/changes/archive/2026-05-05-again/proposal.md', '# again\n')
    await delay(READY_MS)

    changed.length = 0
    write('openspec/changes/archive/2026-05-06-after/proposal.md', '# after\n')
    await waitForNotice()
    assert.deepEqual(changed, ['f1'])
  })

  it('a changes directory created after the watch started is followed', async () => {
    fs.rmSync(path.join(repo, 'openspec', 'changes'), { recursive: true })
    await watching()

    write('openspec/changes/archive/2026-06-06-first/proposal.md', '# first\n')
    await waitForNotice()
    assert.deepEqual(changed, ['f1'], 'changes/ appearing is seen by the tree watcher')

    // No structure is read in between.
    changed.length = 0
    await delay(READY_MS)
    write('openspec/changes/archive/2026-06-07-second/proposal.md', '# second\n')
    await waitForNotice()
    assert.deepEqual(changed, ['f1'])
  })
})

describe('OpenSpecService 的空 repo', () => {
  it('不含 openspec 的 folder 回傳空結構，而非失敗', async () => {
    const empty = path.join(base, 'empty')
    fs.mkdirSync(empty, { recursive: true })

    const svc = create(lookup([{ id: 'f2', path: empty, status: 'ok' }]))

    assert.deepEqual(await svc.getSpecs('f2'), [])
    const changes = await svc.getChanges('f2')
    assert.deepEqual(changes.active, [])
    assert.deepEqual(changes.archived, [])
  })
})

/**
 * 聚合（git worktree）—— 以注入的掃描結果驅動。
 *
 * **刻意不 spawn 真的 `git`**：要驗的是本 app 對聚合結果的處理（來源翻譯、讀取根、監看範圍），
 * 而「core 怎麼列舉與去重」是 core 的責任，不該在這裡重測一次（本 change 的 spec 明文把那件事
 * 委由 core）。真 git worktree 的端到端行為由 `probe:openspec` 承擔。
 */
describe('OpenSpecService 的 worktree 聚合', () => {
  /** 一筆 core 形狀的 worktree 資訊。 */
  function worktree(wtPath: string, opts: { isMain?: boolean; branch?: string | null } = {}) {
    return {
      path: wtPath,
      branch: opts.branch === undefined ? 'feat-x' : opts.branch,
      head: 'a'.repeat(40),
      isMain: opts.isMain ?? false,
      isBare: false,
      key: path.basename(wtPath).slice(0, 8),
      vcs: 'git' as const,
    }
  }

  /** 一筆 core 形狀的 change，帶著來源。 */
  function change(slug: string, source: ReturnType<typeof worktree>) {
    return {
      slug,
      date: null,
      timestamp: null,
      createdDate: null,
      archivedDate: null,
      hasTasks: false,
      hasSpecs: false,
      hasProposal: true,
      hasDesign: false,
      artifactCount: 1,
      schema: null,
      defaultSchema: null,
      taskStats: null,
      source: { key: source.key, path: source.path, branch: source.branch, isMain: source.isMain, vcs: source.vcs },
    }
  }

  function aggregated(
    active: unknown[],
    worktrees: unknown[],
    isAggregated = true,
  ): AggregatedScanResult {
    return {
      specs: [],
      activeChanges: active,
      archivedChanges: [],
      defaultSchema: null,
      worktrees,
      aggregated: isAggregated,
    } as unknown as AggregatedScanResult
  }

  /**
   * 工作目錄根清單 —— renderer 反向交叉導覽的唯一依據。
   *
   * **這一組的重點是 folder 自身那一筆**：它有三條互相獨立的路可以被靜默弄丟（`toRelPath`
   * 對 root 自身回 `null`、非 git 目錄的列舉是空的、folder 是 repo 子目錄時那筆指向邊界外），
   * 而任何一條發生，**現行就能用**的 `openspec/…` 反向導覽都會消失。
   */
  describe('工作目錄根清單', () => {
    it('folder 自身為空字串，邊界內的 worktree 為相對路徑', async () => {
      const inside = worktree(path.join(repo, '.claude/worktrees/wt-a'))
      const svc = create(okFolder(), {
        scan: async () => aggregated([], [worktree(repo, { isMain: true }), inside]),
      })

      assert.deepEqual(await svc.getWorktreeRoots('f1'), ['', '.claude/worktrees/wt-a'])
    })

    it('邊界外的 worktree 不出現，且清單無絕對路徑亦無 null', async () => {
      const outside = worktree(path.join(base, 'outside-wt'))
      const svc = create(okFolder(), {
        scan: async () => aggregated([], [worktree(repo, { isMain: true }), outside]),
      })

      const roots = await svc.getWorktreeRoots('f1')
      assert.deepEqual(roots, [''])
      assert.equal(
        roots.some((root) => root.includes(base)),
        false,
        '不得含絕對路徑',
      )
      assert.equal(
        roots.every((root) => typeof root === 'string'),
        true,
        '不得以 null 佔位 —— 空字串是 folder 自身的合法值，兩者會在消費端糾纏',
      )
    })

    /**
     * 非 git 目錄：core 的 `listWorktrees` 對 `execFile` 失敗回**空陣列**。
     * 少了「folder 自身恆入清單」，這裡會回 `[]` —— 而 `probe:openspec` 的主 fixture 正是
     * 建在 `/tmp` 的非 git 目錄，既有的反向導覽會整個消失。
     */
    it('folder 不在版控之下時，清單恰含 folder 自身', async () => {
      const svc = create(okFolder(), { scan: async () => aggregated([], [], false) })

      assert.deepEqual(await svc.getWorktreeRoots('f1'), [''])
    })

    /**
     * folder 是某個 repo 的**子目錄**：`scanOpenSpecAggregated` 在工作目錄 ≤ 1 時退回
     * `scanOpenSpec`（`aggregated: false`），**但 `worktrees` 仍帶著主工作目錄那筆** —— 它指向
     * repo 根，落在 folder 邊界**外**。這是 `#specRoot` 踩過的同一個坑，失效方式是**靜默的**
     * （沒有任何 fixture 是 repo 子目錄）。
     */
    it('folder 是 repo 子目錄時，清單恰含 folder 自身', async () => {
      const repoRoot = worktree(base, { isMain: true }) // folder(repo) 的上一層
      const svc = create(okFolder(), { scan: async () => aggregated([], [repoRoot], false) })

      assert.deepEqual(await svc.getWorktreeRoots('f1'), [''])
    })
  })

  /**
   * 可供選擇的工作目錄 —— Files 身分的樹根選擇器。
   *
   * **這一組的核心是第一條**：代表 folder 自身的那一筆必須由**合併**產生，不是額外附加。
   * `toRelPath()` 對「與 root 相同的位置」回的是 `null`（不是 `''`），於是照抄
   * `getWorktreeRoots` 的「合成一筆 + 翻譯其餘」結構，會在**每一個 folder 即其 repo 主工作目錄
   * 的普通 repo**（最常見的情形）上產出兩筆：一筆合成的 folder 自身，加一筆 `relPath === null`
   * 的主工作目錄 —— 而後者正是使用者當下所在的位置，卻會被呈現為「不可瀏覽」，並讓選擇器在每個
   * git repo 都冒出來。
   *
   * 沒有任何探針走得到那條路徑：`probe:files` 的 fixture 非 git（列舉為空），`probe:openspec`
   * 的有 3 個 worktree。**這裡是它唯一的守衛。**
   */
  describe('可供選擇的工作目錄', () => {
    it('folder 即其 repo 主工作目錄且無 linked worktree 時，清單恰含一筆', async () => {
      const svc = create(okFolder(), {
        scan: async () => aggregated([], [worktree(repo, { isMain: true, branch: 'master' })], false),
      })

      const options = await svc.getWorktrees('f1')

      assert.equal(options.length, 1, '折疊失敗會讓選擇器在每個普通 git repo 都出現')
      assert.equal(options[0].relPath, '')
      assert.equal(options[0].branch, 'master', '合併而非合成 —— 分支要保留下來')
      assert.equal(
        options.some((option) => option.relPath === null),
        false,
        '使用者當下所在的位置不得被呈現為「位於此 folder 之外」',
      )
    })

    it('folder 自身之外的工作目錄各自成列，邊界外者 relPath 為 null 但仍在列', async () => {
      const inside = worktree(path.join(repo, '.claude/worktrees/wt-a'), { branch: 'feat-inside' })
      const outside = worktree(path.join(base, 'outside-wt'), { branch: 'feat-outside' })
      const svc = create(okFolder(), {
        scan: async () => aggregated([], [worktree(repo, { isMain: true }), inside, outside]),
      })

      const options = await svc.getWorktrees('f1')

      assert.equal(options.length, 3)
      assert.equal(options[0].relPath, '', 'folder 自身恆為第一筆（它是預設值）')
      assert.equal(options[1].relPath, '.claude/worktrees/wt-a')
      assert.equal(options[2].relPath, null, '邊界外的必須在列且標示為不可瀏覽，不得省略')
      assert.equal(options[2].branch, 'feat-outside', '不可瀏覽仍要能被辨識')
    })

    it('清單不含任何絕對路徑', async () => {
      const outside = worktree(path.join(base, 'outside-wt'))
      const svc = create(okFolder(), {
        scan: async () => aggregated([], [worktree(repo, { isMain: true }), outside]),
      })

      const serialized = JSON.stringify(await svc.getWorktrees('f1'))

      assert.equal(serialized.includes(base), false, '邊界外的工作目錄不得洩漏其絕對路徑')
    })

    it('folder 不在版控之下時恰含一筆，且該筆不帶識別碼', async () => {
      const svc = create(okFolder(), { scan: async () => aggregated([], [], false) })

      const options = await svc.getWorktrees('f1')

      assert.equal(options.length, 1)
      assert.equal(options[0].relPath, '')
      assert.equal(
        options[0].key,
        undefined,
        '列舉為空時根本沒有 key 可放 —— folder 自身以「省略識別碼」表示（比照 terminal）',
      )
    })

    it('folder 本身是 linked worktree 時，它自己 relPath 為空字串且非主工作目錄', async () => {
      // folder(repo) 自己是 linked worktree，該 repo 的主工作目錄在 folder 邊界外。
      const main = worktree(path.join(base, 'main-wt'), { isMain: true, branch: 'master' })
      const svc = create(okFolder(), {
        scan: async () => aggregated([], [main, worktree(repo, { branch: 'feat-self' })]),
      })

      const options = await svc.getWorktrees('f1')
      const self = options.find((option) => option.relPath === '')

      assert.ok(self, 'folder 自身恆入清單')
      assert.equal(self.isMain, false, 'isMain 與「是不是 folder 自身」是兩件事，不可互相代用')
      assert.equal(self.branch, 'feat-self')
      assert.equal(options.find((option) => option.isMain)?.relPath, null, '主工作目錄在邊界外')
    })

    it('detached HEAD 的工作目錄以 head 承擔辨識', async () => {
      const detached = worktree(path.join(repo, '.claude/worktrees/wt-d'), { branch: null })
      const svc = create(okFolder(), {
        scan: async () => aggregated([], [worktree(repo, { isMain: true }), detached]),
      })

      const options = await svc.getWorktrees('f1')

      assert.equal(options[1].branch, null)
      assert.ok(options[1].head, '分支缺席時，選擇器上不得是一個空標籤')
    })
  })

  /**
   * `openspec-panel` 的 scenario「topic 僅存在於該 worktree」。
   *
   * core 的聚合其 `specs` 一律取自**主工作目錄**，所以某個 worktree 裡新增的 capability
   * （backfill 之後它的 `openspec/specs/<topic>/spec.md` 只存在於那裡）**不在**側欄的 spec
   * 清單中。反向導覽的判準刻意不驗存在性（design D5，那是 UI 自己的座標、不拿去拼路徑），
   * 於是使用者會拿到一個指向不存在 topic 的入口 —— 點下去必須是誠實的「找不到」。
   *
   * **`probe:openspec` 碰不到這個情形**：它的 worktree 是從含 `openspec/specs/auth/spec.md`
   * 的 commit 切出去的，兩份內容相同。故由這裡承擔。
   */
  it('僅存在於某個 worktree 的 topic 讀不到（specs 取自主工作目錄）', async () => {
    const mainWt = worktree(repo, { isMain: true, branch: 'master' })
    const other = worktree(path.join(repo, '.claude/worktrees/wt-a'))
    // 掃描結果的 specs 只有主工作目錄那些 —— worktree 裡的 `new-capability` 不在其中。
    const svc = create(okFolder(), { scan: async () => aggregated([], [mainWt, other]) })

    await assert.rejects(
      () => svc.getSpec('f1', 'new-capability'),
      (error: unknown) => error instanceof OpenSpecServiceError && error.code === 'NOT_FOUND',
      '只存在於 worktree 的 topic 應回報找不到，而不是呈現別的 topic',
    )
  })

  it('來源翻譯後不含絕對路徑，且其餘欄位原封流穿', async () => {
    const wt = worktree(path.join(base, 'wt-a'))
    const raw = change('in-worktree', wt)
    const svc = create(okFolder(), { scan: async () => aggregated([raw], [worktree(repo, { isMain: true }), wt]) })

    const changes = await svc.getChanges('f1')
    const [entry] = changes.active

    // 對照組：core 原始結果**確實**帶著絕對路徑 —— 少了這條，「DTO 不含路徑」在
    // 「core 根本沒給 source」時也會通過。
    assert.equal(raw.source.path, path.join(base, 'wt-a'))

    assert.equal(JSON.stringify(entry).includes(base), false, 'DTO 不得含絕對路徑')
    assert.equal(entry.worktree?.branch, 'feat-x')
    assert.equal(entry.worktree?.key, wt.key)
    // 原封流穿：core 的其餘欄位沒有因為重建而遺失
    assert.equal(entry.slug, 'in-worktree')
    assert.equal(entry.artifactCount, 1)
  })

  /**
   * `isMain` 與 `isFolderRoot` 在「folder 本身就是 linked worktree」時**相反** ——
   * 這正是續寫入口的條件不能用 `isMain` 判定的理由（design D7）。
   */
  it('isFolderRoot 與 isMain 是兩件事', async () => {
    const mainWt = worktree(path.join(base, 'elsewhere'), { isMain: true, branch: 'master' })
    const selfWt = worktree(repo) // folder 自己，但不是主工作目錄
    const svc = create(okFolder(), {
      scan: async () => aggregated([change('here', selfWt), change('there', mainWt)], [mainWt, selfWt]),
    })

    const { active } = await svc.getChanges('f1')
    const here = active.find((c) => c.slug === 'here')
    const there = active.find((c) => c.slug === 'there')

    assert.equal(here?.worktree?.isMain, false)
    assert.equal(here?.worktree?.isFolderRoot, true, 'folder 自己的 change：agent 搆得著')
    assert.equal(there?.worktree?.isMain, true)
    assert.equal(there?.worktree?.isFolderRoot, false, '主工作目錄在別處：agent 搆不著')
  })

  it('來源在 folder 邊界外時不提供檔案導覽路徑，但內容照樣讀得到', async () => {
    // 邊界外的 worktree，內含一個真的 change
    const outsideWt = path.join(outside, 'wt')
    fs.mkdirSync(path.join(outsideWt, 'openspec', 'changes', 'far-away'), { recursive: true })
    fs.writeFileSync(
      path.join(outsideWt, 'openspec', 'changes', 'far-away', 'proposal.md'),
      '# 遠方\n\n## Why\n\n測試。\n',
    )

    const wt = worktree(outsideWt)
    const svc = create(okFolder(), {
      scan: async () => aggregated([change('far-away', wt)], [worktree(repo, { isMain: true }), wt]),
    })

    const detail = await svc.getChange('f1', 'far-away')
    assert.equal(detail.relPath, null, '邊界外 → 翻不出 relPath')
    assert.ok(
      detail.artifacts.some((a) => a.content?.includes('遠方')),
      '內容仍然完整 —— 降級的只有檔案導覽',
    )
    assert.equal(detail.worktree?.isFolderRoot, false)
  })

  it('worktree 的 openspec 變更會使快取失效並通知 renderer', async () => {
    const wtPath = path.join(base, 'wt-watch')
    fs.mkdirSync(path.join(wtPath, 'openspec'), { recursive: true })
    const wt = worktree(wtPath)

    const svc = create(okFolder(), {
      scan: async () => aggregated([], [worktree(repo, { isMain: true }), wt]),
    })
    await svc.getChanges('f1') // 觸發掃描 → 第二層 watcher 建立
    await delay(READY_MS)

    fs.writeFileSync(path.join(wtPath, 'openspec', 'poke.md'), '# 動了\n')
    await delay(READY_MS)

    assert.deepEqual(changed, ['f1'], 'worktree 裡的變更也要推送通知')
  })

  it('folder 自己的工作目錄不重複監看', async () => {
    const svc = create(okFolder(), {
      scan: async () => aggregated([], [worktree(repo, { isMain: true })]),
    })
    await svc.getChanges('f1')
    await delay(READY_MS)

    fs.writeFileSync(path.join(repo, 'openspec', 'poke.md'), '# 動了\n')
    await delay(READY_MS)

    // 基礎層已經在看 repo/openspec —— 第二層若也建一個，同一次變更會送出兩個事件。
    // debounce 會把它們合批，所以這裡驗的是「通知恰好一次」。
    assert.deepEqual(changed, ['f1'])
  })
})

/**
 * 兩層 watcher 的生死 —— 這一組驗的是「訂閱什麼取決於掃描結果」那個張力被正確處理了。
 */
describe('OpenSpecService 的 worktree 監看層', () => {
  /** 讓 repo 看起來像個 git 主工作目錄（不 spawn git，比照 git-branch.test.ts）。 */
  function makeGitDir(): string {
    const gitDir = path.join(repo, '.git')
    fs.mkdirSync(path.join(gitDir, 'worktrees'), { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/master\n')
    return gitDir
  }

  function wt(wtPath: string, isMain = false) {
    return {
      path: wtPath,
      branch: isMain ? 'master' : 'feat',
      head: null,
      isMain,
      isBare: false,
      key: path.basename(wtPath).slice(0, 8),
      vcs: 'git' as const,
    }
  }

  function result(worktrees: unknown[]): AggregatedScanResult {
    return {
      specs: [],
      activeChanges: [],
      archivedChanges: [],
      defaultSchema: null,
      worktrees,
      aggregated: true,
    } as unknown as AggregatedScanResult
  }

  /**
   * 雞生蛋：worktree 是「先建立目錄、後寫入 change」。
   *
   * **三段式是必要的** —— 單純斷言「新建 worktree 之後收到通知」是**假綠**：建立目錄這件事
   * 本身就會觸發基礎層（`<commonDir>/worktrees/`），那條斷言在完全沒有第二層 watcher 的實作下
   * 照樣會過。要驗的是「**其後**寫進那個 worktree 的 change 也會被看見」。
   */
  it('執行期新建的 worktree，其後的寫入也被監看', async () => {
    const gitDir = makeGitDir()
    const newWt = path.join(base, 'wt-new')

    let discovered = false
    const svc = create(okFolder(), {
      scan: async () =>
        discovered ? result([wt(repo, true), wt(newWt)]) : result([wt(repo, true)]),
    })

    await svc.getChanges('f1') // 第一次掃描：只有主工作目錄
    await delay(READY_MS)

    // (a) 新 worktree 出現 —— 基礎層（worktrees 清單）應該察覺
    fs.mkdirSync(path.join(gitDir, 'worktrees', 'wt-new'), { recursive: true })
    fs.mkdirSync(path.join(newWt, 'openspec'), { recursive: true })
    await delay(READY_MS)
    assert.deepEqual(changed, ['f1'], '新增工作目錄本身要觸發一次通知')

    // (b) 重新取數 —— 這一次掃描才會讓第二層把新 worktree 納入監看
    discovered = true
    changed.length = 0
    await svc.getChanges('f1')
    await delay(READY_MS)

    // (c) 真正的考驗：寫進新 worktree 的 change
    fs.writeFileSync(path.join(newWt, 'openspec', 'poke.md'), '# 新的\n')
    await delay(READY_MS)
    assert.deepEqual(changed, ['f1'], '新 worktree 裡的寫入必須被看見')
  })

  it('工作目錄自清單消失後，其 watcher 被釋放', async () => {
    makeGitDir()
    const gone = path.join(base, 'wt-gone')
    fs.mkdirSync(path.join(gone, 'openspec'), { recursive: true })

    let present = true
    const svc = create(okFolder(), {
      scan: async () => (present ? result([wt(repo, true), wt(gone)]) : result([wt(repo, true)])),
    })

    await svc.getChanges('f1')
    await delay(READY_MS)
    fs.writeFileSync(path.join(gone, 'openspec', 'a.md'), '# 在\n')
    await delay(READY_MS)
    assert.deepEqual(changed, ['f1'], '還在清單上時看得到它的變更')

    // 自清單消失（worktree 被移除）
    present = false
    changed.length = 0
    await svc.getChanges('f1')
    await delay(READY_MS)

    fs.writeFileSync(path.join(gone, 'openspec', 'b.md'), '# 不該再被看見\n')
    await delay(READY_MS)
    assert.deepEqual(changed, [], '已離開清單的工作目錄不該再推送通知')
  })

  it("a departed worktree's archive is no longer watched", async () => {
    makeGitDir()
    const gone = path.join(base, 'wt-gone')
    fs.mkdirSync(path.join(gone, 'openspec', 'changes', 'archive'), { recursive: true })
    await settleFixture()

    let present = true
    const svc = create(okFolder(), {
      scan: async () => (present ? result([wt(repo, true), wt(gone)]) : result([wt(repo, true)])),
    })
    await svc.getChanges('f1')
    await delay(READY_MS)
    // The control: while listed, its archive is watched (and this invalidates the cache, so the next read scans).
    fs.mkdirSync(path.join(gone, 'openspec', 'changes', 'archive', '2026-07-06-listed'))
    await delay(READY_MS)
    assert.deepEqual(changed, ['f1'], 'a listed worktree has its archive watched')

    present = false
    await svc.getChanges('f1')
    await delay(READY_MS)
    changed.length = 0

    fs.mkdirSync(path.join(gone, 'openspec', 'changes', 'archive', '2026-07-07-late'))
    await delay(READY_MS + 200)
    assert.deepEqual(changed, [], 'its archive watcher must close with its tree watcher')
  })
})

/**
 * 讀取根的分家（design D2b）。
 *
 * **這一組是補上來的** —— 獨立稽核發現 `#specRoot` 的 fallback 有迴歸，而當時整條分支
 * 沒有任何測試會走到（聚合的 fixture 一律 `specs: []`）。一個拿掉之後不會有東西變紅的
 * 修正，就是一個遲早會被改回去的修正。
 */
describe('OpenSpecService 的 spec 讀取根', () => {
  function wt(wtPath: string, isMain: boolean) {
    return {
      path: wtPath,
      branch: isMain ? 'master' : 'feat',
      head: null,
      isMain,
      isBare: false,
      key: path.basename(wtPath).slice(0, 8),
      vcs: 'git' as const,
    }
  }

  function scanOf(specTopics: string[], worktrees: unknown[], aggregated: boolean) {
    return async (): Promise<AggregatedScanResult> =>
      ({
        specs: specTopics.map((topic) => ({
          topic,
          path: path.join(repo, `openspec/specs/${topic}/spec.md`),
          historyCount: 0,
        })),
        activeChanges: [],
        archivedChanges: [],
        defaultSchema: null,
        worktrees,
        aggregated,
      }) as unknown as AggregatedScanResult
  }

  /**
   * **非聚合時不可看 `worktrees`。** core 在工作目錄 ≤ 1 時回的是 `scanOpenSpec(folder)`，
   * 但 `worktrees` 仍帶著主工作目錄那筆 —— folder 是 repo 的**子目錄**時，那筆指向 repo 根，
   * 而 specs 來自子目錄。看了它就會去錯的地方讀，spec 列得出來卻打不開。
   */
  it('非聚合時以 folder 自身為讀取根，即使 worktrees 指向別處', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    fs.mkdirSync(path.join(elsewhere, 'openspec/specs/auth'), { recursive: true })
    // 別處**也有**同名 spec，內容不同 —— 讀錯地方會讀到這一份，而不是靜靜地失敗。
    fs.writeFileSync(path.join(elsewhere, 'openspec/specs/auth/spec.md'), '# WRONG SOURCE\n')

    const svc = create(okFolder(), { scan: scanOf(['auth'], [wt(elsewhere, true)], false) })
    const detail = await svc.getSpec('f1', 'auth')

    assert.ok(!detail.content.includes('WRONG SOURCE'), '不得讀到 worktrees 指向的那個 repo')
    assert.ok(detail.content.includes('auth'), `應讀到 folder 自己的 spec：${detail.content.slice(0, 40)}`)
  })

  /** 聚合時反過來 —— folder 是 linked worktree，spec 只存在於主工作目錄，仍要讀得到。 */
  it('聚合時以主工作目錄為讀取根（folder 是 linked worktree 的情形）', async () => {
    const mainWt = path.join(base, 'main-wt')
    fs.mkdirSync(path.join(mainWt, 'openspec/specs/core'), { recursive: true })
    fs.writeFileSync(
      path.join(mainWt, 'openspec/specs/core/spec.md'),
      '# core Specification\n\n## Purpose\n\nMAIN WORKTREE SPEC\n',
    )

    const svc = create(okFolder(), {
      scan: scanOf(['core'], [wt(mainWt, true), wt(repo, false)], true),
    })
    const detail = await svc.getSpec('f1', 'core')

    assert.ok(
      detail.content.includes('MAIN WORKTREE SPEC'),
      `folder 自己沒有這個 spec，必須從主工作目錄讀：${detail.content.slice(0, 60)}`,
    )
  })
})

/**
 * 送往 renderer 的 DTO 一律不含絕對路徑 —— **關係圖也算**。
 *
 * 稽核發現：聚合的圖會在每個 change 節點掛一份完整的 `WorktreeSource`（含 `path`），
 * 而原本唯一驗這件事的測試只 stringify change 清單。
 */
describe('OpenSpecService 的關係圖不洩漏路徑', () => {
  /**
   * **必須是真的 git repo 且真的有 linked worktree。**
   *
   * 這條測試的第一版用既有的（非 git）fixture，於是 core 靜默退回非聚合、節點上根本沒有
   * `source` —— 把修正整個拿掉它照樣全綠（對照組實測）。那正是本 change 自己記載的頭號假綠
   * 來源：`worktree ≤ 1 時 core 靜默退回非聚合`。
   *
   * `getGraphData` 不經注入的 `scan`（它直接呼叫 core 的 `buildGraphDataAggregated`），
   * 因此這裡只能用真 git 造出聚合的情境。
   */
  function makeGitRepoWithWorktree(): string {
    const gitRepo = path.join(base, 'graph-repo')
    const wtPath = path.join(base, 'graph-wt')
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'color.ui=false', ...args], {
        cwd: gitRepo,
        stdio: 'pipe',
      })

    const put = (target: string, content: string) => {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    put(path.join(gitRepo, 'openspec/config.yaml'), 'schema: spec-driven\n')
    put(path.join(gitRepo, 'openspec/specs/auth/spec.md'), SPEC_AUTH)
    put(path.join(gitRepo, 'openspec/changes/main-change/proposal.md'), '# m\n')
    put(path.join(gitRepo, 'openspec/changes/main-change/specs/auth/spec.md'), DELTA_AUTH)
    git(['init', '-q', '--initial-branch=master', '.'])
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['worktree', 'add', '-q', '-b', 'feat-x', wtPath])
    put(path.join(wtPath, 'openspec/changes/wt-change/proposal.md'), '# w\n')
    put(path.join(wtPath, 'openspec/changes/wt-change/specs/auth/spec.md'), DELTA_AUTH)
    return gitRepo
  }

  it('graph 的節點不含來源的絕對路徑，且識別碼已還原為非聚合形式', async () => {
    const gitRepo = makeGitRepoWithWorktree()
    const svc = create(lookup([{ id: 'g1', path: gitRepo, status: 'ok' }]))

    // 前置：聚合真的發生了，否則下面的斷言沒有鑑別力。
    const changes = await svc.getChanges('g1')
    assert.ok(
      changes.active.some((c) => c.slug === 'wt-change'),
      `worktree 的 change 必須出現，否則不是聚合路徑：${changes.active.map((c) => c.slug).join(',')}`,
    )

    const graph = await svc.getGraphData('g1')
    const payload = JSON.stringify(graph)

    assert.ok(graph.nodes.length > 0, '圖不該是空的')
    assert.ok(!payload.includes(base), `關係圖洩漏了絕對路徑：${payload.slice(0, 200)}`)

    // change 節點的識別碼恰為 `change:<slug>` —— 既不帶來源識別碼，也不是裸 slug。
    // **裸 slug 那個錯誤特別危險**：`changeTopicsMap` 與 `SpecGraph` 對它照樣運作，
    // Timeline 分組仍是綠的，只有這條斷言擋得住。
    const changeNodes = graph.nodes.filter((n) => n.type === 'change')
    const slugs = changes.active.map((c) => c.slug)
    assert.ok(changeNodes.length >= 2, `應有兩個 change 節點：${changeNodes.length}`)
    for (const node of changeNodes) {
      const slug = node.id.slice('change:'.length)
      assert.ok(node.id.startsWith('change:'), `裸 slug 或前綴遺失：${node.id}`)
      assert.ok(slugs.includes(slug), `識別碼未還原（疑似仍帶來源識別碼）：${node.id}`)
    }

    // 邊的 **change 端**必須對得到節點（spec 端的懸空邊是掃描結果的合法狀態 —— 一個 change
    // 可以提議尚未納入 specs 的 topic，見 spec 的但書）。
    const ids = new Set(graph.nodes.map((n) => n.id))
    const orphaned = graph.edges.filter((e) => e.source.startsWith('change:') && !ids.has(e.source))
    assert.deepEqual(orphaned, [], `邊的 change 端對不到節點（只換節點沒換邊？）：${JSON.stringify(orphaned)}`)
    assert.ok(graph.edges.length > 0, '圖不該沒有邊，否則上一條沒有鑑別力')
  })

  it('非聚合的 repo 其節點識別碼不變（正規化必須是 no-op）', async () => {
    // `repo` 不是 git repo ⇒ core 走非聚合路徑，節點本來就沒有 source。
    const graph = await create().getGraphData('f1')
    const changeNodes = graph.nodes.filter((n) => n.type === 'change')

    assert.ok(changeNodes.length > 0, '應有 change 節點')
    for (const node of changeNodes) {
      assert.match(node.id, /^change:[^:]+$/, `非聚合路徑不該改動識別碼：${node.id}`)
    }
  })
})

/**
 * 工作目錄清單的監看，其解析起點必須容許「folder 不是工作目錄的根」。
 *
 * `resolveCommonDir` 只看 `<folder>/.git`、不往上找 —— folder 是 repo 的**子目錄**時
 * （design D2b 明文接受的佈局）從它解不出 common dir，那一層 watcher 就不會存在，
 * 於是「新建的 worktree 被納入」靜默失效。掃描回來之後才知道主工作目錄在哪，因此
 * 那一層要在掃描後補建。
 */
describe('OpenSpecService 的工作目錄清單監看', () => {
  it('folder 是 repo 的子目錄時，仍監看得到工作目錄清單', async () => {
    const gitRepo = path.join(base, 'sub-repo')
    const sub = path.join(gitRepo, 'packages/app')
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'color.ui=false', ...args], {
        cwd: gitRepo,
        stdio: 'pipe',
      })

    fs.mkdirSync(path.join(sub, 'openspec/specs/x'), { recursive: true })
    fs.writeFileSync(path.join(sub, 'openspec/config.yaml'), 'schema: spec-driven\n')
    fs.writeFileSync(path.join(sub, 'openspec/specs/x/spec.md'), SPEC_AUTH)
    git(['init', '-q', '--initial-branch=master', '.'])
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])

    const svc = create(lookup([{ id: 's1', path: sub, status: 'ok' }]))
    await svc.getSpecs('s1') // 觸發掃描 —— 清單 watcher 於此之後才補建得起來
    await delay(READY_MS)
    changed.length = 0

    // 模擬「多了一個工作目錄」：git 就是在 common dir 底下建這個目錄的
    fs.mkdirSync(path.join(gitRepo, '.git/worktrees/newly-added'), { recursive: true })
    await delay(READY_MS)

    assert.deepEqual(changed, ['s1'], '新增工作目錄必須觸發通知（folder 為子目錄時亦然）')
  })
})
