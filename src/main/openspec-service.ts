import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type AggregatedScanResult,
  type ChangeInfo,
  type GraphData,
  type HistoryEntry,
  type ParsedTasks,
  type TaskStats,
  type WorktreeInfo,
  buildGraphDataAggregated,
  readChange,
  readSpec,
  readSpecAtChange,
  scanOpenSpecAggregated,
} from '@spekjs/core'
import { changeNodeSlug } from '@spekjs/core/graph-node-id'
import type { FSWatcher } from 'chokidar'
import { isWithin } from './fs-boundary'
import { resolveCommonDir } from './git-branch'
import { whenUserEnvReady } from './user-env'
import { createWatcher } from './watcher'
import type { FolderLookup } from './workspace-store'

export type OpenSpecErrorCode = 'UNKNOWN_FOLDER' | 'NOT_FOUND' | 'READ_FAILED'

export class OpenSpecServiceError extends Error {
  constructor(
    readonly code: OpenSpecErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OpenSpecServiceError'
  }
}

/**
 * 送往 renderer 的 spec 摘要。
 *
 * core 的 `SpecInfo.path` 是**絕對路徑**，這裡一律翻成 folder-relative 的 `relPath`
 *（design D5）—— renderer 的全部設計前提是「它沒有詞彙可以表達 workspace 之外的位置」，
 * DTO 裡一旦出現絕對路徑，這個前提就破了。
 *
 * `relatedChangeCount` 直接取 core 的 `historyCount`：實測兩者恆等（`findRelatedChanges`
 * 的長度），因此不必為了這個數字再跑一次 N 個 topic 的查詢。
 */
export interface SpecSummary {
  topic: string
  relPath: string | null
  relatedChangeCount: number
}

export interface SpecDetailView {
  topic: string
  content: string
  relatedChanges: string[]
  history: HistoryEntry[]
  relPath: string | null
  /**
   * 這份 spec 的來源工作目錄 —— **該 repo 有多於一個工作目錄時才填**。
   *
   * core 的聚合對 spec 與 change 的處理不同：`specs` 一律取自**主工作目錄**。於是使用者從
   * 一個 worktree 的 `openspec/specs/<topic>/spec.md` 反向導覽過來時，看到的是**另一份檔案**
   * 的內容 —— 而那不是邊角：`common-openspec-change` 的流程要求 archive 前在 worktree 裡
   * backfill main spec，所以兩份分歧是每個 change 出貨前的常態。
   *
   * 單一工作目錄時為 `undefined`（沒有歧義，標示只是噪音 —— 比照 change 的來源徽章不標示 main）。
   */
  origin?: ChangeOrigin
}

export interface SpecVersionView {
  topic: string
  slug: string
  content: string
}

export interface OverviewData {
  specCount: number
  activeChangeCount: number
  archivedChangeCount: number
  defaultSchema: string | null
  /** active change 的 tasks 加總。沒有任何 tasks 時為零。 */
  taskStats: TaskStats
}

/**
 * 一個 change 的來源工作目錄（git worktree），送往 renderer 的形狀。
 *
 * core 的 `WorktreeSource` 帶著**絕對路徑**，這裡一律丟棄它 —— renderer 沒有詞彙可以表達
 * workspace 之外的位置。`key` 是 core 算的路徑 sha1 前 8 碼，不可逆、不含路徑資訊。
 *
 * **兩個布林各司其職，不可互相代用**：
 *
 * | | 是什麼 | 用途 |
 * |---|---|---|
 * | `isMain` | 來源的**性質** —— 它是不是該 repo 的主工作目錄 | **呈現**：徽章不標示 main（對齊 spek） |
 * | `isFolderRoot` | 來源與**這個 folder** 的關係 —— 它是不是 folder 自己 | **能力判定**：續寫入口（design D7） |
 *
 * folder 本身就是一個 linked worktree 時，兩者是**相反**的：該 folder 的 change 其
 * `isMain === false`（主工作目錄在別處）但 `isFolderRoot === true`（agent 就站在這裡）。
 * 拿 `isMain` 去判斷「agent 能不能對這個 change 動手」會錯誤地停用一個明明會成功的入口。
 */
export interface ChangeOrigin {
  key: string
  branch: string | null
  vcs: 'git' | 'jj'
  isMain: boolean
  isFolderRoot: boolean
}

/**
 * 一個**可供選擇**的工作目錄，送往 renderer 的形狀（Files 身分的樹根選擇器）。
 *
 * 與 `getWorktreeRoots()` 是兩個不同的問題，故兩者並存：那個回答「哪些根可用於**定位 OpenSpec
 * 內容**」（反向交叉導覽），邊界外的與該問題無關故整筆省略；這個回答「這個 repo **有哪些工作
 * 目錄、各自能不能瀏覽**」，邊界外的**必須在列**且標示為不可瀏覽 —— 省略它，使用者無從得知那是
 * 刻意的限制還是應用程式沒看見它。
 *
 * **`key` 對「folder 自身」那一筆是省略的**，比照 `terminal-sessions` 的「省略即 folder 根」
 * （`worktree-pick.ts` 的 `if (!worktreeKey)`）。folder 不在版控之下時列舉為空，根本沒有任何
 * key 可放 —— 若改以「主工作目錄的 key」表示 folder 自身，同一個邏輯狀態就會有兩種落盤表示。
 *
 * `head` 存在的理由只有一個：`branch` 於 detached HEAD 為 `null`，那時得有東西能辨識該工作目錄，
 * 否則選擇器上是一個空標籤。
 */
export interface WorktreeOption {
  key?: string
  /** folder-relative 根。folder 自身為空字串；翻不出來（位於 folder 邊界外）為 `null`。 */
  relPath: string | null
  branch: string | null
  head: string | null
  isMain: boolean
}

/**
 * 送往 renderer 的 change 摘要。
 *
 * `Omit<ChangeInfo, 'source'>` 而非逐欄列舉是刻意的：core 日後新增欄位仍會**自己流穿**到
 * renderer（CLAUDE.md 記為承重的性質），本 change 接下的同步義務因此縮到 `source` 這一個欄位。
 *
 * 而欄位**不叫 `source`**：`Omit` 之後該屬性不存在，加上它在 `ChangeInfo` 裡是 optional，
 * 於是這個型別仍可直接餵給 `@spekjs/ui` 的 `buildLanes`（它要的是 core 的 `ChangeInfo[]`）。
 * 若沿用 `source` 這個名字換成我們的型別，就會因缺 `path` 而不 assignable。
 */
export type ChangeSummary = Omit<ChangeInfo, 'source'> & { worktree?: ChangeOrigin }

export interface ChangesData {
  active: ChangeSummary[]
  archived: ChangeSummary[]
  defaultSchema: string | null
}

export interface DeltaSpecView {
  topic: string
  content: string
  relPath: string | null
}

export interface ChangeArtifactView {
  id: string
  title: string
  /**
   * **這個 union 必須與 core 的 `ArtifactKind` 同步** —— 它是 core 的值原樣轉手，而 core
   * 1.11.0 加進來的 `'data'`（change 根目錄下的 `.yaml` / `.yml` / `.json`）就是這樣被編譯器
   * 攔下的。少一個值只會紅在這個檔案，**但消費端漏掉一個分支不會紅**（見 `ChangeView` 的
   * `ArtifactContent`：kind 是逐一窮舉的，落空就是一個點得到卻空白的分頁）。
   */
  kind: 'markdown' | 'tasks' | 'specs' | 'data'
  /** `kind` 為 `'markdown'` 或 `'data'`：原始檔案內容。`'tasks'` 亦帶原文（core 1.12.0 起）。 */
  content?: string
  tasks?: ParsedTasks
  specs?: DeltaSpecView[]
  /** 該 artifact 的底層檔案（`kind: 'specs'` 沒有單一檔案，為 null）。供交叉導覽。 */
  relPath: string | null
}

export interface ChangeDetailView {
  slug: string
  status: 'active' | 'archived'
  createdDate: string | null
  archivedDate: string | null
  schema: string | null
  defaultSchema: string | null
  artifacts: ChangeArtifactView[]
  schemaOrder?: string[]
  /**
   * 這個 change 還缺哪些 artifact，依工作流順序。空陣列＝齊備。
   *
   * **不能由 `artifacts` 與 `schemaOrder` 相減得出** —— `schemaOrder` 只列出已存在的 artifact，
   * 兩者相減恆為空。見 `missingArtifacts()`。
   */
  missingArtifacts: string[]
  /** change 的目錄。供交叉導覽。 */
  relPath: string | null
  /**
   * 來源工作目錄。**不取自 core 的 `ChangeDetail.source`** —— 那個欄位雖然宣告著「僅聚合讀取會
   * 填入」，但 `readChange` 從來不填它（core 沒有聚合版的 readChange，已 grep 確認）。這裡取自
   * 掃描結果中查表得到的那筆 `ChangeInfo`，與讀取根的解析同源。
   */
  worktree?: ChangeOrigin
}

/** agent 的一次操作會寫入數個檔案（proposal + design + specs/*.md + tasks），不合批就會讓側欄連續重載。 */
const DEFAULT_DEBOUNCE_MS = 150

/**
 * The watchers of one `openspec/` (openspec-watch-skip-archive, design D1 and D2).
 *
 * `tree` watches the whole directory **except the contents of `changes/archive`**: archived changes only
 * accumulate, and watching each of their files made the cost grow with a repository's history times its worktrees
 * (on macOS one descriptor per file). `archive` watches `changes/archive` at depth 0, so an archived change
 * directory added or removed is still seen; an edit inside one is not, by design.
 *
 * **`archive` exists only while its directory does, and `tree` decides when**: `tree` still sees the archive
 * directory itself appear and go away. A chokidar watcher created on a missing directory reports it appearing and
 * then nothing inside it, reports nothing at all when the parent is missing too, and closing one around that
 * transition was measured to leave a native watch open — so the archive watcher is not created on a missing path
 * (design D2 names the one race in which it still ends up on one).
 */
interface OpenSpecDirWatch {
  /** `<openspec>/changes/archive`. */
  archiveDir: string
  tree: FSWatcher
  archive: FSWatcher | null
  /** Set when closed, so a late event cannot start a watcher no one will close. */
  closed: boolean
}

interface FolderWatch {
  /** 基礎層的工作目錄清單（`<commonDir>/worktrees/`）。 */
  watchers: FSWatcher[]
  /** 基礎層：folder 自己的 `openspec/`。 */
  own: OpenSpecDirWatch | null
  /** 第二層：每個**其他**工作目錄的 `openspec/`，以其絕對路徑為 key。 */
  worktreeWatchers: Map<string, OpenSpecDirWatch>
  /** 已監看的工作目錄清單目錄（`<commonDir>/worktrees/`）—— 去重，避免重複建立。 */
  worktreeListTargets: Set<string>
  timer: NodeJS.Timeout | null
}

function toRelPath(root: string, abs: string): string | null {
  if (!isWithin(root, abs)) return null
  const rel = path.relative(root, abs)
  if (rel === '') return null
  return rel.split(path.sep).join('/')
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * 一個 change 的目錄，以 OpenSpec 的慣例推導。
 *
 * core 沒有把 change 的路徑放進 `ChangeDetail`，而 `listChangeMarkdownFiles()` 回的是
 * repo 根目錄的 markdown（`CLAUDE.md` / `README.md`），**不是** change 的 artifact ——
 * 已實測，不要拿它來推路徑。
 *
 * 因此這裡依慣例推導候選路徑（純字串，不碰檔案系統）；是否真的存在、以及能不能翻譯成
 * folder-relative，由 `toFolderRel()` 回答。
 *
 * 回傳值**相對於該 change 的來源工作目錄**，不是相對於 folder —— 聚合之後兩者可能不同。
 */
function changeDirIn(slug: string, status: 'active' | 'archived'): string {
  return status === 'archived' ? `openspec/changes/archive/${slug}` : `openspec/changes/${slug}`
}

/**
 * 把「相對於**來源工作目錄**的路徑」翻譯成「相對於 **folder**」，並確認它真的存在。
 *
 * 聚合之後這兩個 root 不再必然相同：change 可能住在一個 linked worktree 裡，而那個 worktree
 * 可以在 folder 邊界之內（`<repo>/.claude/worktrees/<slug>`）或之外（`/tmp/...`）。邊界外時
 * `toRelPath` 回 `null` —— 側欄少一個「跳到檔案」的入口，好過送一個 renderer 無從表達的路徑
 * （design D5／D6）。
 *
 * **一個承重的前提**：`isWithin` 是純字面比較。這裡第一次拿**兩個獨立來源**的絕對路徑相比 ——
 * 一端來自 `workspace.json`，另一端來自 `git worktree list`。兩者目前都是 realpath
 * （`workspace-store.ts` 的 `add()` 以 `realpathSync` 正規化；git 回的一律已解析 symlink），
 * 所以比得起來。**若 workspace 的路徑正規化改變，每一個 change 的「跳到檔案」會同時靜默消失。**
 */
async function toFolderRel(
  folderRoot: string,
  sourceRoot: string,
  rel: string,
): Promise<string | null> {
  const abs = path.join(sourceRoot, rel)
  if (!(await exists(abs))) return null
  return toRelPath(folderRoot, abs)
}

function sumTaskStats(changes: ChangeInfo[]): TaskStats {
  let total = 0
  let completed = 0
  for (const change of changes) {
    if (!change.taskStats) continue
    total += change.taskStats.total
    completed += change.taskStats.completed
  }
  return { total, completed }
}

/**
 * 這個 change 還缺哪些 artifact，依 OpenSpec 工作流的順序。
 *
 * **來源必須是 `ChangeInfo` 的 `has*` 四個旗標，不能用 `schemaOrder` 去減** ——
 * `schemaOrder` **只列出已經存在的 artifact**（實測：一個只有 `tasks.md` 的 change，它就只回
 * `['tasks']`），拿它當「schema 期望的完整清單」去相減，結果恆為空，這個功能就永遠不會出現。
 *
 * 這四個名字是 spec-driven 工作流的形狀，也是 core 唯一提供的粒度。**它只是一個提示** ——
 * 真正要產生哪一個 artifact 由 OpenSpec 自己決定（`artifact-continuation` 的 spec 明文要求
 * 入口不得承諾特定 artifact），所以即使某個自訂 schema 讓這份提示不準，也不會導致錯誤的動作。
 */
function missingArtifacts(info: ChangeInfo): string[] {
  const missing: string[] = []
  if (!info.hasProposal) missing.push('proposal')
  if (!info.hasDesign) missing.push('design')
  if (!info.hasSpecs) missing.push('specs')
  if (!info.hasTasks) missing.push('tasks')
  return missing
}

/**
 * 主行程為每個 workspace folder 供應 OpenSpec 結構。
 *
 * 三件事貫穿整個類別：
 *
 * 1. **定址只認 `folderId`。** 絕對路徑既不進來（renderer 沒有詞彙說它）也不出去
 *    （DTO 的路徑欄位一律 folder-relative）。
 * 2. **`slug` / `topic` 是不受信任的輸入。** 它們會被 core 拿去拼路徑，因此一律先在掃描
 *    結果裡**查表**，查不到就不呼叫 core（design D6）。這是白名單，不是「過濾 `..`」那種
 *    黑名單 —— 後者總有漏網的編碼形式。
 * 3. **快取 + 監看。** 這個 app 的前提是旁邊有 agent 一直在寫檔，側欄不能是啟動時的快照。
 *
 * 不依賴 Electron，因此可由單元測試直接驅動：推送的出口是建構時傳入的 `send`。
 */
export class OpenSpecService {
  readonly #cache = new Map<string, AggregatedScanResult>()
  /** 同一個 folder 的併發請求共用一次掃描 —— 四個 tab 同時開，不該掃四次。 */
  readonly #inflight = new Map<string, Promise<AggregatedScanResult>>()
  readonly #watches = new Map<string, FolderWatch>()

  constructor(
    private readonly store: FolderLookup,
    private readonly send: (folderId: string) => void,
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
    /**
     * 掃描的實作。預設即 core 的**聚合**掃描。
     *
     * 之所以是個可注入的依賴：「快取命中時不重複掃描」是**效能特性**，從外部的回傳值看不
     * 出來 —— 不把掃描這件事顯式化，就只能靠計時之類的脆弱手段去猜它有沒有真的跑。
     *
     * `includeJj: false`：本階段只涵蓋 git worktree，jj 那條路徑（內容指紋去重、`isCurrent`、
     * `conflictsWith`）整條不會被走到，與 spek 的 web 與 extension 的預設一致。
     *
     * `aggregate` 採 core 的預設（true）。core 在 worktree ≤ 1 時會自行退回等同 `scanOpenSpec`
     * 的結果 —— 於是單一工作目錄的 repo 行為與聚合前完全相同。**這也是一個假綠的來源**：
     * 驗收若 fixture 的 worktree 沒建成功，斷言會照樣通過。
     */
    private readonly scan: (root: string) => Promise<AggregatedScanResult> = (root) =>
      scanOpenSpecAggregated(root, { includeJj: false }),
  ) {}

  /**
   * 該 repo 的主工作目錄 —— **spec 的讀取根**。
   *
   * core 的聚合掃描其 `specs` 一律取自主工作目錄（`scanner.ts` 的 `specs: main.scan.specs`），
   * 因此讀取單一 spec 時不能沿用 folder 自己的路徑：folder 可能是該 repo 的一個 linked
   * worktree、或其中一個子目錄，兩種情形下 spec 都會**列得出來卻打不開**（已實測 `readSpec`
   * 回 `null` → NOT_FOUND）。
   *
   * **非聚合時一律用 folder 自身，不可看 `worktrees`。** 這是個容易寫錯的地方：
   * `scanOpenSpecAggregated` 在工作目錄 ≤ 1 時回的是 `scanOpenSpec(folder)` 的結果，**但
   * `worktrees` 仍然帶著那唯一一筆（主工作目錄）**。於是「folder 是某個 repo 的子目錄」時，
   * specs 來自子目錄、而 `isMain` 那筆指向 repo 根 —— 兩者不同源，spec 會**列得出來卻打不開**
   * （已實測 `readSpec` 回 `null`）。那正是本 change 想修的病，只是方向相反。
   */
  #specRoot(root: string, result: AggregatedScanResult): string {
    if (!result.aggregated) return root
    return result.worktrees.find((wt) => wt.isMain)?.path ?? root
  }

  /** change 的讀取根：它自己的來源工作目錄；非聚合時 `source` 為 `undefined`，退回 folder。 */
  #changeRoot(root: string, change: ChangeInfo): string {
    return change.source?.path ?? root
  }

  /**
   * core 的來源資訊 → 送往 renderer 的形狀（丟棄絕對路徑，補上 `isFolderRoot`）。
   *
   * `isFolderRoot` 的比較在此完成 —— renderer 沒有路徑詞彙，能力判定（design D7）卻需要
   * 「來源是不是 folder 自己」這個答案。
   */
  #origin(root: string, change: ChangeInfo): ChangeOrigin | undefined {
    const source = change.source
    if (!source) return undefined
    return {
      key: source.key,
      branch: source.branch,
      vcs: source.vcs,
      isMain: source.isMain,
      isFolderRoot: source.path === root,
    }
  }

  /**
   * spec 的來源工作目錄 —— 恆為主工作目錄（`specs: main.scan.specs`），**但只在該 repo 有
   * 多於一個工作目錄時才回傳**。
   *
   * 只有一個工作目錄時沒有任何歧義，標示是噪音；有多個時使用者無從得知自己看的是哪一份，
   * 而他很可能剛從某個 worktree 的同名檔案跳過來（見 `SpecDetailView.origin` 的說明）。
   */
  #specOrigin(root: string, result: AggregatedScanResult): ChangeOrigin | undefined {
    if (result.worktrees.length <= 1) return undefined
    const main = result.worktrees.find((worktree) => worktree.isMain)
    if (!main) return undefined
    return {
      key: main.key,
      branch: main.branch,
      vcs: main.vcs,
      isMain: true,
      isFolderRoot: main.path === root,
    }
  }

  /** `ChangeInfo` → `ChangeSummary`：只換掉 `source`，其餘欄位原封流穿（design D3）。 */
  #summary(root: string, change: ChangeInfo): ChangeSummary {
    const { source: _source, ...rest } = change
    const worktree = this.#origin(root, change)
    return worktree ? { ...rest, worktree } : rest
  }

  /** 驗收「快取命中不重掃」與「重新載入不累積 watcher」用得上。 */
  get watchedFolderCount(): number {
    return this.#watches.size
  }

  /**
   * 該 folder 所屬 repo 各工作目錄的 **folder-relative 根**。
   *
   * renderer 拿它判斷一個檔案路徑是不是落在某個工作目錄的 `openspec/` 底下（反向交叉導覽）——
   * 它沒有別的詞彙可以問這件事：`ChangeOrigin` 只有不可逆的 `key`、分支與兩個布林。
   *
   * **folder 自身恆為清單的第一筆（空字串），而且它不經 `toRelPath`。** 這一條是承重的，
   * 三個獨立的事實會合謀把它弄丟：
   *
   * 1. `toRelPath(root, root)` 回 **`null`**（`rel === ''` 那一行）—— 照「翻不出來就省略」
   *    直覺地寫成 `worktrees.map(toRelPath).filter(Boolean)`，folder 自己**第一個**被丟掉。
   * 2. 非 git 目錄的 `listWorktrees` 回**空陣列**（core 對 `execFile` 失敗即 `resolve([])`），
   *    於是清單裡連一筆都沒有。
   * 3. folder 是某個 repo 的**子目錄**時，`worktrees` 那筆指向 repo 根 —— 落在 folder 邊界外，
   *    翻譯出界後同樣被丟掉。
   *
   * 任何一條發生，`openspec/…` 這種**現行就能用**的路徑都會失去入口。folder 自身的
   * `openspec/` 是這個能力自始就在供應的東西，它的可導覽性不該取決於 git 列舉的結果。
   *
   * 其餘工作目錄翻譯不出 folder-relative 路徑時**整筆省略** —— 不以 `null` 佔位：空字串是
   * folder 自身的合法值，清單裡混進 `null` 會在消費端與它糾纏。
   */
  /**
   * 該 folder 所屬 repo 的工作目錄 —— **識別碼與絕對路徑**。
   *
   * **這是主行程內部 API，回傳值不得經 IPC 送往 renderer**（它含絕對路徑）。renderer 那一側
   * 用的是 `getWorktreeRoots()`，回的是 folder-relative 的根。
   *
   * 存在的理由是 `terminal-sessions` 的一條 requirement：session 的工作目錄以不可逆識別碼指定，
   * 而**列舉必須與側欄同源且同參數** —— 兩者若各自列舉，可達的位置集合就可能大於使用者在介面上
   * 看得到的集合。特別是 core 的 `listWorkspaces` 預設 `includeJj: true`，而這裡（與側欄）用的
   * 是 `includeJj: false`；繞過這個方法直接呼叫 core，那條「恆等於」的保證就沒了。
   */
  async worktreesOf(folderId: string): Promise<{ key: string; path: string }[]> {
    const { result } = await this.#scan(folderId)
    return result.worktrees.map((worktree) => ({ key: worktree.key, path: worktree.path }))
  }

  async getWorktreeRoots(folderId: string): Promise<string[]> {
    const { root, result } = await this.#scan(folderId)
    const roots = ['']
    for (const worktree of result.worktrees) {
      const rel = toRelPath(root, worktree.path)
      if (rel !== null) roots.push(rel)
    }
    return roots
  }

  /**
   * 可供選擇的工作目錄（Files 身分的樹根選擇器）。
   *
   * **代表 folder 自身的那一筆是「合併」出來的，不是額外附加的。** 這是承重的：`toRelPath()` 對
   * 「與 root 相同的位置」回的是 `null`（不是 `''`），於是 `getWorktreeRoots` 那種「先塞一個合成
   * 的 `''`、再翻譯其餘各筆」的結構，在**每一個 folder 即其 repo 主工作目錄的普通 repo**（最常見
   * 的情形）上會產出兩筆 —— 一筆合成的 folder 自身，加一筆 `relPath === null` 的主工作目錄，而
   * 後者正是使用者當下所在的位置，卻會被呈現為「位於此 folder 之外、不可瀏覽」。
   *
   * 這裡以 `self` / `others` 的**互斥分割**表達「兩者擇一，恆不並存」—— 讓那個不變式由結構保證，
   * 而不是靠後續的去重。folder 自身恆為第一筆（它是預設值）。
   */
  async getWorktrees(folderId: string): Promise<WorktreeOption[]> {
    const { root, result } = await this.#scan(folderId)

    // 與 root 相同的位置：不能用 `toRelPath` 判定 —— 它對「相同」與「邊界外」都回 `null`，
    // 兩者在這裡的意義恰好相反。
    const isSelf = (worktree: WorktreeInfo): boolean => path.relative(root, worktree.path) === ''
    const self = result.worktrees.find(isSelf)
    const others = result.worktrees.filter((worktree) => !isSelf(worktree))

    return [
      self
        ? { key: self.key, relPath: '', branch: self.branch, head: self.head, isMain: self.isMain }
        : // folder 不在版控之下、或是某個 repo 的子目錄 —— 沒有對應的工作目錄可合併，也就沒有 key
          { relPath: '', branch: null, head: null, isMain: false },
      ...others.map((worktree) => ({
        key: worktree.key,
        relPath: toRelPath(root, worktree.path),
        branch: worktree.branch,
        head: worktree.head,
        isMain: worktree.isMain,
      })),
    ]
  }

  async getOverview(folderId: string): Promise<OverviewData> {
    const { result } = await this.#scan(folderId)
    return {
      specCount: result.specs.length,
      activeChangeCount: result.activeChanges.length,
      archivedChangeCount: result.archivedChanges.length,
      defaultSchema: result.defaultSchema,
      taskStats: sumTaskStats(result.activeChanges),
    }
  }

  async getSpecs(folderId: string): Promise<SpecSummary[]> {
    const { root, result } = await this.#scan(folderId)
    return result.specs.map((spec) => ({
      topic: spec.topic,
      relPath: toRelPath(root, spec.path),
      relatedChangeCount: spec.historyCount,
    }))
  }

  async getSpec(folderId: string, topic: string): Promise<SpecDetailView> {
    const { root, result } = await this.#scan(folderId)
    const info = result.specs.find((spec) => spec.topic === topic)
    if (!info) throw new OpenSpecServiceError('NOT_FOUND', `unknown spec topic: ${topic}`)

    const specRoot = this.#specRoot(root, result)
    const detail = await this.#read(
      () => readSpec(specRoot, info.topic),
      `spec not readable: ${topic}`,
    )
    const origin = this.#specOrigin(root, result)
    return {
      topic: detail.topic,
      content: detail.content,
      relatedChanges: detail.relatedChanges,
      history: detail.history,
      relPath: toRelPath(root, info.path),
      ...(origin ? { origin } : {}),
    }
  }

  async getSpecAtChange(folderId: string, topic: string, slug: string): Promise<SpecVersionView> {
    const { root, result } = await this.#scan(folderId)
    const spec = result.specs.find((entry) => entry.topic === topic)
    if (!spec) throw new OpenSpecServiceError('NOT_FOUND', `unknown spec topic: ${topic}`)
    const change = this.#findChange(result, slug)

    // spec 的某個版本住在**該 change 自己的**工作目錄裡（它是 change 的 delta），
    // 因此讀取根是 change 的來源，不是 spec 的來源。
    const changeRoot = this.#changeRoot(root, change)
    const version = await this.#read(
      () => readSpecAtChange(changeRoot, spec.topic, change.slug),
      `spec ${topic} not present at change ${slug}`,
    )
    return { topic: spec.topic, slug: change.slug, content: version.content }
  }

  async getChanges(folderId: string): Promise<ChangesData> {
    const { root, result } = await this.#scan(folderId)
    return {
      active: result.activeChanges.map((change) => this.#summary(root, change)),
      archived: result.archivedChanges.map((change) => this.#summary(root, change)),
      defaultSchema: result.defaultSchema,
    }
  }

  async getChange(folderId: string, slug: string): Promise<ChangeDetailView> {
    const { root, result } = await this.#scan(folderId)
    const info = this.#findChange(result, slug)

    const changeRoot = this.#changeRoot(root, info)

    /*
      **只在這裡等，而且只是等。** `readChange` 會 spawn `openspec` 取得 schema 的權威順序，
      而桌面環境啟動的產物 PATH 裡沒有它 —— 使用者環境的解析與套用由 `user-env.ts` 負責，
      這裡等的是「那件事做完了沒」。從未啟動過解析時（單元測試）立即完成。

      其餘 core 呼叫（掃描、關係圖）只 spawn `git`，不需要使用者 PATH，讓它們也等是白付延遲。

      **取值範圍擴大成整份環境之後，這個裁決依然成立** —— `user-env.ts` 併進 `process.env` 的
      **仍然只有 PATH**（其餘只交給 pty，理由見該檔檔頭）。於是主行程 spawn 的東西受影響的
      也只有 PATH，判準沒有變。
    */
    await whenUserEnvReady()

    const detail = await this.#read(
      () => readChange(changeRoot, info.slug),
      `change not readable: ${slug}`,
    )

    // 目錄名相對於**來源工作目錄**；`changeDir` 則是翻譯後、相對於 folder 的（可能為 null）。
    const dirIn = changeDirIn(info.slug, detail.status)
    const changeDir = await toFolderRel(root, changeRoot, dirIn)

    const artifacts: ChangeArtifactView[] = await Promise.all(
      detail.artifacts.map(async (artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        content: artifact.content,
        tasks: artifact.tasks,
        specs: artifact.specs
          ? await Promise.all(
              artifact.specs.map(async (delta) => ({
                topic: delta.topic,
                content: delta.content,
                relPath: changeDir
                  ? await toFolderRel(root, changeRoot, `${dirIn}/specs/${delta.topic}/spec.md`)
                  : null,
              })),
            )
          : undefined,
        /*
          檔名取自 core 的 `file`（1.12.0 起），**不是由 `id` 補上 `.md` 組出來的**。

          `id` 是檔名去副檔名，於是 `asyncapi.yaml` 的 id 是 `asyncapi` —— 拼回 `.md` 會指向一個
          **不存在的檔案**，而「在 Files 中開啟」失敗時畫面上只是沒有反應。編譯器看不見這件事。

          specs 是一整棵子目錄，沒有單一檔案可跳 —— core 對它不填 `file`，於是這裡**由結構**為
          null，不必再問一次 kind。
        */
        relPath:
          !artifact.file || !changeDir
            ? null
            : await toFolderRel(root, changeRoot, `${dirIn}/${artifact.file}`),
      })),
    )

    return {
      slug: detail.slug,
      status: detail.status,
      createdDate: detail.createdDate,
      archivedDate: detail.archivedDate,
      schema: detail.schema,
      defaultSchema: detail.defaultSchema,
      artifacts,
      schemaOrder: detail.schemaOrder,
      missingArtifacts: missingArtifacts(info),
      relPath: changeDir,
      worktree: this.#origin(root, info),
    }
  }

  /**
   * spec ↔ change 的關係圖。
   *
   * 送出前要做**兩件事，而它們是同一件事的兩面**：
   *
   * 1. **剝掉來源** —— 聚合的圖會在每個 change 節點上掛一份完整的 `WorktreeSource`，其中含
   *    絕對路徑。core 這樣做是對的（它是 library），但那不能出 IPC。
   * 2. **把識別碼還原成非聚合形式** —— 聚合的 change 節點是 `change:<worktreeKey>:<slug>`，
   *    而**判斷那個 key 存不存在，靠的正是即將被剝掉的 `source`**。
   *
   * **順序因此是承重的：先還原，再剝除。** 只做第 1 件會送出一個**不自洽**的節點（識別碼帶
   * key、卻沒有能證明那是 key 的資訊），下游於是無從還原 —— `SpecGraph` 會把整串
   * `<key>:<slug>` 當成 slug 交出去（錨定到一個不存在的 change），`changeTopicsMap` 則查表
   * 落空（Timeline 的分組全部掉到「無 topic」）。**兩者都不會報錯。**
   *
   * 剝離後的識別碼仍是安全的：`key` 是路徑的 sha1 前 8 碼，不可逆、不含路徑資訊；而 renderer
   * 目前不需要圖上的來源（徽章走 change 清單那條路）。
   */
  async getGraphData(folderId: string): Promise<GraphData> {
    const { root } = await this.#scan(folderId)
    const graph = await this.#read(
      () => buildGraphDataAggregated(root, { includeJj: false }),
      `graph not available: ${folderId}`,
    )

    // 舊識別碼 → 新識別碼。**只有節點握有 `source`**，所以映射必須在這裡建立，
    // 邊再據它改寫（邊只有兩個字串端點，自己看不出哪一段是 key）。
    //
    // `changeNodeSlug` 回傳的是 **slug**，不是識別碼 —— 前綴要自己補回去；而它對非 change
    // 節點原樣回傳（`spec:auth` → `spec:auth`），所以**只能對 change 節點施加**，
    // 否則 `spec:auth` 會變成 `change:spec:auth`。
    const renamed = new Map<string, string>()
    for (const node of graph.nodes) {
      if (node.type !== 'change') continue
      const plain = `change:${changeNodeSlug(node)}`
      if (plain !== node.id) renamed.set(node.id, plain)
    }

    return {
      nodes: graph.nodes.map(({ source: _source, ...node }) => ({
        ...node,
        id: renamed.get(node.id) ?? node.id,
      })),
      // 邊的 `source` / `target` 是**端點**，與 worktree 來源無關（同名，容易看混）。
      // 消費端是先以端點查節點、再讀節點的識別碼 —— 只改節點不改邊，查表會全數落空。
      edges: graph.edges.map((edge) => ({
        source: renamed.get(edge.source) ?? edge.source,
        target: renamed.get(edge.target) ?? edge.target,
      })),
    }
  }

  /** folder 自 workspace 移除，或 renderer 消失時釋放。 */
  async releaseFolder(folderId: string): Promise<void> {
    this.#invalidate(folderId)
    const watch = this.#watches.get(folderId)
    if (!watch) return
    this.#watches.delete(folderId)
    if (watch.timer) clearTimeout(watch.timer)
    const dirWatches = [...(watch.own ? [watch.own] : []), ...watch.worktreeWatchers.values()]
    await Promise.all([
      ...watch.watchers.map((watcher) => watcher.close()),
      ...dirWatches.map((dirWatch) => this.#closeOpenSpecDir(dirWatch)),
    ])
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#watches.keys()].map((folderId) => this.releaseFolder(folderId)))
    this.#cache.clear()
    this.#inflight.clear()
  }

  /**
   * `slug` 的白名單查表（design D6）。
   *
   * 只有掃描確實發現的 change 才可讀 —— 一個 `slug = "../../../../etc"` 在這裡就被擋下，
   * 而且**不會**有任何以它拼接而成的檔案系統存取。
   *
   * 聚合之後這裡還多擔一件事：**回傳的那筆帶著來源**，讀取根由它解析（design D2）。
   * 白名單的語意完好 —— renderer 給 slug、主行程查表、表裡那筆決定去哪讀。
   *
   * active 先於 archived：一個 slug 可能在主工作目錄已封存、而某個 worktree 仍持有其 active
   * 版本（「一個 change 一個 worktree」工作流的常態）。此時以進行中的那一份為準。
   */
  #findChange(result: AggregatedScanResult, slug: string): ChangeInfo {
    const change = [...result.activeChanges, ...result.archivedChanges].find(
      (entry) => entry.slug === slug,
    )
    if (!change) throw new OpenSpecServiceError('NOT_FOUND', `unknown change slug: ${slug}`)
    return change
  }

  /**
   * 呼叫 core 的讀取函式。
   *
   * core 的介面有兩個容易踩的點，都已實測：`readSpec` / `readChange` 找不到目標時**回 `null`
   * 而不是拋錯**；而 `readSpecAtChange` / `buildGraphData` / `findRelatedChanges` 是**同步**
   * 函式（會阻塞主行程做磁碟 IO）。這裡把兩者統一收斂為「拿不到就是 NOT_FOUND」。
   */
  async #read<T>(run: () => T | Promise<T | null> | null, missing: string): Promise<T> {
    let value: T | null | undefined
    try {
      value = await run()
    } catch (error) {
      throw new OpenSpecServiceError('READ_FAILED', String(error))
    }
    if (value === null || value === undefined) {
      throw new OpenSpecServiceError('NOT_FOUND', missing)
    }
    return value
  }

  async #scan(folderId: string): Promise<{ root: string; result: AggregatedScanResult }> {
    const folder = this.store.list().find((entry) => entry.id === folderId)
    if (!folder) throw new OpenSpecServiceError('UNKNOWN_FOLDER', `unknown folder: ${folderId}`)
    const root = folder.path

    const cached = this.#cache.get(folderId)
    if (cached) return { root, result: cached }

    const inflight = this.#inflight.get(folderId)
    if (inflight) return { root, result: await inflight }

    // **先訂閱、再掃描。** 反過來的話，兩者之間的窗口裡發生的變更會兩頭落空 ——
    // 掃描沒看到它，事件也還沒開始送（Phase 2 的教訓，這裡同樣適用）。
    this.#ensureWatch(folderId, root)

    const promise = this.scan(root)
      .then((result) => {
        // 掃描期間若有變更事件抵達，快取已被 invalidate 清掉 —— 此時不可把過期的結果塞回去。
        if (this.#inflight.get(folderId) === promise) {
          this.#cache.set(folderId, result)
          this.#inflight.delete(folderId)
        }
        // 工作目錄清單是掃描的**產物**，所以第二層只能在這裡同步（design D4）。
        this.#syncWorktreeWatches(folderId, root, result.worktrees)
        return result
      })
      .catch((error) => {
        this.#inflight.delete(folderId)
        throw new OpenSpecServiceError('READ_FAILED', String(error))
      })

    this.#inflight.set(folderId, promise)
    return { root, result: await promise }
  }

  /**
   * 基礎層：不需要掃描結果就知道要看哪的兩處。
   *
   * 1. folder 自己的 `openspec/`；
   * 2. **工作目錄清單本身**（`<commonDir>/worktrees/`）—— 這條是承重的，不是加保險：worktree 是
   *    「先建立目錄、後寫入 change」，只監看既有工作目錄的話，一個新建 worktree 的第一次寫入
   *    **沒有任何 watcher 在場**，側欄要等到不相干的事件才會醒（雞生蛋，只能由監看清單打破）。
   *
   * 第二層（每個工作目錄的 `openspec/`）建立在 `#syncWorktreeWatches`，因為清單是掃描的產物。
   */
  #ensureWatch(folderId: string, root: string): void {
    if (this.#watches.has(folderId)) return

    const watch: FolderWatch = {
      watchers: [],
      own: null,
      worktreeWatchers: new Map(),
      worktreeListTargets: new Set(),
      timer: null,
    }
    this.#watches.set(folderId, watch)

    watch.own = this.#watchOpenSpecDir(folderId, path.join(root, 'openspec'))
    this.#watchWorktreeList(folderId, root)
  }

  /**
   * 監看**工作目錄清單本身**（`<commonDir>/worktrees/`）。
   *
   * **解析的起點必須容許 folder 不是工作目錄的根** —— `resolveGitDir` 只看 `<folder>/.git`、
   * 不往上找，因此 folder 是 repo 的**子目錄**時（D2b 明文接受的佈局）從它解不出 common dir。
   * 掃描回來之後我們知道主工作目錄在哪，那時再補一次即可，所以這個方法會被呼叫兩次：
   * 掃描前以 folder 自己試一次（多數情況就成了），掃描後以主工作目錄再試一次。
   */
  #watchWorktreeList(folderId: string, from: string): void {
    const watch = this.#watches.get(folderId)
    if (!watch) return

    const commonDir = resolveCommonDir(from)
    if (commonDir === null) return

    const target = path.join(commonDir, 'worktrees')
    if (watch.worktreeListTargets.has(target)) return
    watch.worktreeListTargets.add(target)

    // **只理會目錄的新增與移除。** 實測：在 worktree 裡跑一次 `git commit`，這個目錄下會產生
    // 3 個檔案事件（index / logs/HEAD / COMMIT_EDITMSG）。這個 app 的前提是旁邊有 agent 一直
    // 在跑 git —— 不收窄的話，每次 commit 都會使快取失效並重跑一次聚合掃描（約 175ms）。
    watch.watchers.push(
      this.#watch(folderId, target, { depth: 0, events: ['addDir', 'unlinkDir'] }),
    )
  }

  /**
   * 第二層：每個工作目錄的 `openspec/`。工作目錄清單一變（新增／移除 worktree）就跟著調整。
   *
   * folder 自己的那個由基礎層負責，這裡跳過它 —— 否則同一個目錄會被監看兩次，一次變更送出
   * 兩個事件。
   */
  #syncWorktreeWatches(folderId: string, root: string, worktrees: WorktreeInfo[]): void {
    const watch = this.#watches.get(folderId)
    if (!watch) return

    // folder 不是工作目錄的根時（例如 repo 的子目錄），掃描前那次解不出 common dir —— 補一次。
    const mainPath = worktrees.find((wt) => wt.isMain)?.path
    if (mainPath !== undefined) this.#watchWorktreeList(folderId, mainPath)

    const wanted = new Set(worktrees.map((wt) => wt.path).filter((wtPath) => wtPath !== root))

    for (const [wtPath, dirWatch] of watch.worktreeWatchers) {
      if (wanted.has(wtPath)) continue
      watch.worktreeWatchers.delete(wtPath)
      void this.#closeOpenSpecDir(dirWatch)
    }

    for (const wtPath of wanted) {
      if (watch.worktreeWatchers.has(wtPath)) continue
      watch.worktreeWatchers.set(wtPath, this.#watchOpenSpecDir(folderId, path.join(wtPath, 'openspec')))
    }
  }

  /** The watchers of one `openspec/` (see `OpenSpecDirWatch`). */
  #watchOpenSpecDir(folderId: string, openspecDir: string): OpenSpecDirWatch {
    const archiveDir = path.join(openspecDir, 'changes', 'archive')
    const dirWatch: OpenSpecDirWatch = {
      archiveDir,
      // Containment by `isWithin` (path.relative), never a prefix comparison: `archive-notes` is not inside.
      // The archive directory itself is not ignored: its appearing and going away drive `archive`.
      tree: this.#watch(folderId, openspecDir, {
        ignored: (p) => p !== archiveDir && isWithin(archiveDir, p),
      }),
      archive: null,
      closed: false,
    }

    dirWatch.tree.on('all', (event, p) => {
      if (p !== archiveDir) return
      if (event === 'addDir') this.#openArchiveWatch(folderId, dirWatch)
      if (event === 'unlinkDir') this.#closeArchiveWatch(dirWatch)
    })
    // Before `ready` the initial scan reports nothing (`ignoreInitial`), so an archive directory created between
    // this check and the end of that scan is caught by the second check.
    if (existsSync(archiveDir)) this.#openArchiveWatch(folderId, dirWatch)
    dirWatch.tree.once('ready', () => {
      if (existsSync(archiveDir)) this.#openArchiveWatch(folderId, dirWatch)
    })
    return dirWatch
  }

  #openArchiveWatch(folderId: string, dirWatch: OpenSpecDirWatch): void {
    if (dirWatch.closed || dirWatch.archive) return
    dirWatch.archive = this.#watch(folderId, dirWatch.archiveDir, {
      depth: 0,
      events: ['addDir', 'unlinkDir'],
    })
  }

  #closeArchiveWatch(dirWatch: OpenSpecDirWatch): void {
    const archive = dirWatch.archive
    dirWatch.archive = null
    void archive?.close()
  }

  async #closeOpenSpecDir(dirWatch: OpenSpecDirWatch): Promise<void> {
    dirWatch.closed = true
    const archive = dirWatch.archive
    dirWatch.archive = null
    await Promise.all([dirWatch.tree.close(), archive?.close()])
  }

  /**
   * 建一個監看者，其事件一律收斂為「該 folder 的結構已變更」。
   *
   * **邊界約束（不跟隨 symlink）與錯誤回報都在 `createWatcher` 裡**，不由這裡決定。
   * 這與「監看位於邊界外的工作目錄」不衝突：那些路徑是版控系統列舉出來的已知位置，而該約束防的
   * 是由 repo 內容決定的、不受信任的展開；且推給 renderer 的只有一個 folderId，沒有任何路徑會
   * 流出去。
   */
  #watch(
    folderId: string,
    target: string,
    options?: { depth?: number; events?: string[]; ignored?: (path: string) => boolean },
  ): FSWatcher {
    // 這裡是一個 watcher 對一個目標（同一個 folder 底下有多個：`openspec/`、工作目錄清單、
    // 每個工作目錄的 `openspec/`）：輪詢判定靠預設（即 `target` 自己），識別標籤同樣用 `target`。
    const watcher = createWatcher({
      target,
      label: target,
      ...(options?.depth === undefined ? {} : { depth: options.depth }),
      ...(options?.ignored === undefined ? {} : { ignored: options.ignored }),
    })

    const events = options?.events
    watcher.on('all', (event) => {
      if (events && !events.includes(event)) return
      this.#onChange(folderId)
    })

    return watcher
  }

  #onChange(folderId: string): void {
    this.#invalidate(folderId)

    const watch = this.#watches.get(folderId)
    if (!watch || watch.timer) return
    watch.timer = setTimeout(() => {
      watch.timer = null
      this.send(folderId)
    }, this.debounceMs)
    // 合批的計時器不該讓 Electron 的主行程無法結束
    watch.timer.unref?.()
  }

  #invalidate(folderId: string): void {
    this.#cache.delete(folderId)
    // in-flight 的掃描已經過時了。讓它跑完但不要把結果寫進快取（見 #scan 的比對）。
    this.#inflight.delete(folderId)
  }
}
