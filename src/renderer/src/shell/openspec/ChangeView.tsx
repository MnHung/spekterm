import { sortArtifacts } from '@spekjs/core/artifact-order'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownView } from '../files/MarkdownView'
import { registerTabCycleScope } from '../tab-cycle-scope'
import type { ChangeArtifactView, ChangeDetailView, DeltaSpecView, ParsedTasks } from '../types'
import type { ContinuationBlock } from './continuation'
import { useChange } from './data'
import { parseDelta } from './delta'
import { type FallbackReason, fallbackReason } from './schema-order'
import {
  DeltaBadge,
  ErrorNote,
  Loading,
  ProgressBar,
  SectionTitle,
  StatusBadge,
  TaskCount,
  WorktreeBadge,
} from './ui'

interface ChangeViewProps {
  folderId: string
  /**
   * 呈現哪一個 change。**不可為 `null`** —— 沒有可解析的 change 時，這個視圖與它的入口一併
   * 不呈現（`openspec-panel`），於是「無錨定」在這裡表達不出來。型別收窄是那條規格唯一的
   * 結構性保證：留著 `| null`，日後只會靜默地又長出一個沒有入口可去的空狀態。
   */
  slug: string
  /** 續寫入口不可用的原因；`null` ＝ 可用。 */
  continuationBlock: ContinuationBlock | null
  /**
   * focused session 開在哪個工作目錄（`undefined` ＝ folder 根，或根本沒有 session）。
   * 條件 4 拿它與 change 的來源識別碼比對。
   */
  sessionWorktreeKey?: string
  /** 請 agent 續寫下一個 artifact。 */
  onContinue: () => void
  /** 於這個 change 的來源工作目錄開一個 claude session（並錨定它）。 */
  onOpenSessionHere: (worktreeKey: string) => void
  onOpenFile: (relPath: string) => void
}

/**
 * 「本 change」視圖 —— 側欄的主角。
 *
 * **每個 artifact 一個分頁**（Proposal │ Design │ Tasks │ Specs），一次只顯示一個 —— 與 spek web
 * 的 `ChangeDetail`（`artifacts.map(...)` 餵給 `TabView`）同一個編排。
 *
 * 一度改成「一路往下堆的區塊」（tasks + spec deltas 攤開、proposal/design 收合），實測難用：
 * 要找一段內容得先想它在第幾個區塊、再捲過前面所有東西。**並排的分頁讓「找」變成一次點擊，
 * 而不是一次搜尋。**
 *
 * 它顯示的是**側欄座標所錨定的那個 change**，而錨定由使用者建立、系統不猜（design D3）。
 * **沒有可解析的 change 時，這個視圖根本不會被渲染**（連入口都不呈現，見 `OpenSpecPanel`）——
 * 於是這裡不需要、也不該有「無錨定」的空狀態：那是一個到不了的畫面。
 */
export function ChangeView({
  folderId,
  slug,
  continuationBlock,
  sessionWorktreeKey,
  onContinue,
  onOpenSessionHere,
  onOpenFile,
}: ChangeViewProps): React.JSX.Element {
  const { data, loading, error } = useChange(folderId, slug)
  const [activeId, setActiveId] = useState<string | null>(null)

  if (error) return <ErrorNote message={error} />
  if (loading || !data) return <Loading />

  return (
    <LoadedChange
      data={data}
      activeId={activeId}
      onChooseArtifact={setActiveId}
      continuationBlock={continuationBlock}
      sessionWorktreeKey={sessionWorktreeKey}
      onContinue={onContinue}
      onOpenSessionHere={onOpenSessionHere}
      onOpenFile={onOpenFile}
    />
  )
}

interface LoadedChangeProps extends Omit<ChangeViewProps, 'folderId' | 'slug'> {
  data: ChangeDetailView
  activeId: string | null
  onChooseArtifact: (id: string) => void
}

/**
 * The change view once its data is there.
 *
 * **A component of its own so that its hooks sit below the loading / error returns** — the
 * keyboard wiring needs the artifact list and the panel element, which exist only here.
 */
function LoadedChange({
  data,
  activeId,
  onChooseArtifact,
  continuationBlock,
  sessionWorktreeKey,
  onContinue,
  onOpenSessionHere,
  onOpenFile,
}: LoadedChangeProps): React.JSX.Element {
  const { t } = useTranslation()
  const idPrefix = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  /*
    排序**整條委由 core**（`sortArtifacts` 的 `schema` 模式），本 repo 不自寫規則：
    schema 順序可用就照它、不可用就退回敘事順序、只涵蓋部分時未涵蓋者接在其後。

    這正是 core 1.6.0 把該函式上移、1.7.0 再泛型化（spek #45）所要消除的重複 ——
    泛型讓它吃得下我們自己的 `ChangeArtifactView` 並原樣交回（`relPath` 不會消失）。
  */
  const artifacts = sortArtifacts(data.artifacts, 'schema', data.schemaOrder)

  // 預設停在 tasks —— 駕駛 agent 時要盯的是它。沒有 tasks 就退回第一個 artifact。
  const fallbackId = artifacts.find((a) => a.kind === 'tasks')?.id ?? artifacts[0]?.id
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts.find((a) => a.id === fallbackId)

  /*
    **Choosing an artifact focuses its content and starts it at the top** (`openspec-panel`).

    Done right here in the handler, not in an effect: the panel element survives the switch, and
    nothing that runs on render can then move focus or scroll when the same change is merely
    refreshed (an agent editing tasks.md re-renders this view constantly). Setting `scrollTop`
    before React commits the new content is fine — the new content renders from that offset.
    Choosing the artifact already shown only focuses it, so a click on the current tab does not
    throw the reader back to the top.
  */
  const choose = (id: string, currentId: string | undefined): void => {
    const panel = panelRef.current
    if (id !== currentId) {
      onChooseArtifact(id)
      if (panel) panel.scrollTop = 0
    }
    panel?.focus({ preventScroll: true })
  }

  // The artifact `Ctrl+Tab` chose, until it has rendered selected (see the effect after the handler).
  const cycledTo = useRef<string | null>(null)

  // The latest artifact order and selection, for the `Ctrl+Tab` handler registered once below.
  const latest = useRef({ ids: [] as string[], activeId: undefined as string | undefined, choose })
  useEffect(() => {
    latest.current = { ids: artifacts.map((a) => a.id), activeId: active?.id, choose }
  })

  /*
    **`Ctrl+Tab` / `Ctrl+Shift+Tab` cycle the artifacts while focus is in this view.**
    `KeyboardNavigation` owns the key and hands it over (see `tab-cycle-scope.ts`), so the
    dialog/menu rule is not repeated here. The chosen tab is scrolled into view in the tab strip:
    the panel takes focus with `preventScroll`, so nothing else would bring an off-screen tab in.
  */
  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    return registerTabCycleScope({
      element,
      cycle: (delta) => {
        const { ids, activeId: currentId, choose: chooseLatest } = latest.current
        if (ids.length === 0) return
        const index = currentId === undefined ? 0 : ids.indexOf(currentId)
        const next = ids[(index + delta + ids.length) % ids.length]
        cycledTo.current = next
        chooseLatest(next, currentId)
      },
    })
  }, [])

  /*
    The chosen tab is scrolled to **after** it has rendered as the selected one: the selected tab is wider, and a
    scroll from the handler measured the unselected width, leaving the tab's last pixels outside the strip
    (`probe:openspec`: "the tab chosen with the keyboard is visible in the tab strip").
  */
  const activeArtifactId = active?.id
  useEffect(() => {
    if (cycledTo.current === null || cycledTo.current !== activeArtifactId) return
    cycledTo.current = null
    tabRefs.current.get(activeArtifactId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeArtifactId])

  // 順序來自敘事順序而非該 change 的 schema 時，要說出來（判斷與理由在 `schema-order.ts`）。
  const fallback = fallbackReason(data.status, data.schemaOrder)

  if (artifacts.length === 0) {
    return <p className="px-4 py-3 text-sm text-ink-faint">{t('openspec.noArtifacts')}</p>
  }

  const tasks = artifacts.find((a) => a.kind === 'tasks')?.tasks
  const tabId = (index: number): string => `${idPrefix}-tab-${index}`
  const panelId = `${idPrefix}-panel`
  const activeIndex = artifacts.findIndex((a) => a.id === active?.id)

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="shrink-0 px-4 pt-4">
        <div className="flex items-center gap-2">
          <h2
            className="min-w-0 truncate font-mono text-lg font-bold text-ink"
            title={data.slug}
          >
            {data.slug}
          </h2>
          <StatusBadge status={data.status} />
          <WorktreeBadge worktree={data.worktree} />
        </div>

        {/*
          進度條**留在標題底下、不進分頁** —— 它是這個 change 的狀態摘要，不論你正在讀
          proposal 還是 spec deltas 都想看得到它。
        */}
        {tasks && (
          <div className="mt-2 flex items-center gap-2">
            <ProgressBar completed={tasks.completed} total={tasks.total} />
            <TaskCount completed={tasks.completed} total={tasks.total} />
          </div>
        )}
      </div>

      {/*
        The hairline is an inset shadow, not a border the tabs overlap with `-mb-px`: a horizontal
        scroller computes `overflow-y` to `auto` too, and that 1px overhang made it a 1px vertical
        scroller with a scrollbar of its own. The inset shadow paints under the tabs' underline.
      */}
      <nav
        aria-label={t('openspec.changeArtifact')}
        role="tablist"
        className="mt-3 flex shrink-0 overflow-x-auto overflow-y-hidden px-2 shadow-[inset_0_-1px_0_var(--color-hairline)]"
      >
        {artifacts.map((artifact, index) => {
          const selected = artifact.id === active?.id
          return (
            <button
              key={artifact.id}
              ref={(el) => {
                if (el) tabRefs.current.set(artifact.id, el)
                else tabRefs.current.delete(artifact.id)
              }}
              id={tabId(index)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              onClick={() => choose(artifact.id, active?.id)}
              className={`shrink-0 border-b-2 px-3 py-[6px] text-xs transition-colors ${
                selected
                  ? 'border-accent font-bold text-accent'
                  : 'border-transparent text-ink-dim hover:text-ink'
              }`}
            >
              {artifact.title}
            </button>
          )
        })}
      </nav>

      {fallback !== null && <FallbackNote reason={fallback} />}

      {/*
        **Focusable, so the keyboard can scroll it** (`openspec-panel`). Without a tab index a click
        on the text focuses the side-panel section around it, and the browser only scrolls the
        focused element's own scroll containers — this one is inside it, not around it.
      */}
      <div
        ref={panelRef}
        id={panelId}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={activeIndex === -1 ? undefined : tabId(activeIndex)}
        className="min-h-0 flex-1 overflow-auto px-4 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
      >
        {active && <ArtifactContent artifact={active} onOpenFile={onOpenFile} />}
      </div>

      {/*
        條件 4（change 住在另一個工作目錄）在**這裡**判定，不在 MainStage —— 那裡只有 session
        資料，拿不到 change 的來源。分工是：MainStage 管「有沒有對的對象」，這裡管「這個 change
        是不是它搆得著的」。session 的條件優先回報（先看有沒有對象，再看對象搆不搆得著）。
      */}
      <ContinuationBar
        missing={data.missingArtifacts}
        blocked={continuationBlock ?? (foreignWorktree(data.worktree, sessionWorktreeKey) ? 'foreignWorktree' : null)}
        onContinue={onContinue}
        onOpenSessionHere={
          // 來源必須有識別碼（＝出現在工作目錄的列舉裡）才開得了 session。
          // **位於 folder 邊界外不構成不可用** —— 那只影響檔案導覽（`worktree-aggregation`）。
          data.worktree && foreignWorktree(data.worktree, sessionWorktreeKey)
            ? () => onOpenSessionHere((data.worktree as { key: string }).key)
            : null
        }
      />
    </div>
  )
}

/**
 * 這個 change 是不是住在「不是 session 所在」的工作目錄裡（`artifact-continuation` 的條件 4）。
 *
 * **兩段式，不是直接比對兩個識別碼。** 開在 folder 根的 session **沒有識別碼**，而 folder 本身
 * 就是 linked worktree 時，**它自己的 change 帶著識別碼**（主行程恆填 `key`，不論 `isFolderRoot`）
 * —— 直接比對會得到 `undefined !== '0ceceaeb'` 而錯誤地停用一個會成功的入口，打破
 * 「folder 本身是 linked worktree 時入口可用」那條 scenario（`probe:openspec` 已經在守它）。
 *
 * 沒有識別碼的語意是「開在 folder 根」，而那正是 `isFolderRoot` 回答的問題 —— 舊判準沒有消失，
 * 它降級成了新判準的一個分支。
 */
function foreignWorktree(
  origin: { key: string; isFolderRoot: boolean } | undefined,
  sessionWorktreeKey: string | undefined,
): boolean {
  if (!origin) return false
  return sessionWorktreeKey ? origin.key !== sessionWorktreeKey : !origin.isFolderRoot
}

/**
 * 「請 agent 續寫下一個 artifact」的入口 —— 側欄第一次對 session **發話**（此前只有跟隨）。
 *
 * **一顆按鈕，不是每個缺漏的 artifact 各一顆。** 使用者原本要的是後者，但續寫流程一次只產生
 * 一個、且**由它自己挑**：排四顆按鈕會承諾一個它給不出的選擇（按「specs」那顆，寫出來的可能
 * 是 design）。而「下一個會是哪一個」我們刻意不算 —— readiness 取決於 schema 的依賴規則，
 * 側欄複製那套規則就是複製一份**會過期**的權威。因此只誠實列出「還缺哪些」（design D4）。
 *
 * 不可用時**停用而非消失**：消失會讓人以為這個功能不存在或壞了。
 */
function ContinuationBar({
  missing,
  blocked,
  onContinue,
  onOpenSessionHere,
}: {
  missing: string[]
  blocked: ContinuationBlock | null
  onContinue: () => void
  /**
   * 於這個 change 的工作目錄開一個 session。`null` ＝ 不呈現。
   *
   * **它不受「因條件 4 而停用」限制**：停用原因有優先序，`noSession`／`notClaude`／`notRunning`
   * 都先於條件 4 回報，而「剛開 app、還沒有任何 session」正是使用者最常遇到的 —— 只在條件 4
   * 停用時呈現的話，他得**先在錯的地方開一個 session**，才看得見「在對的地方開一個」的入口。
   */
  onOpenSessionHere: (() => void) | null
}): React.JSX.Element | null {
  const { t } = useTranslation()

  // artifact 齊備 —— 沒有東西要續寫，不佔位置。
  if (missing.length === 0) return null

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-4 py-2">
      <button
        type="button"
        disabled={blocked !== null}
        onClick={onContinue}
        aria-label={t('openspec.continueArtifact')}
        title={blocked ? t(`openspec.continueBlocked.${blocked}`) : undefined}
        className={`shrink-0 rounded border px-3 py-1 text-xs ${
          blocked
            ? 'cursor-not-allowed border-hairline text-ink-faint opacity-50'
            : 'border-accent text-accent hover:bg-hover'
        }`}
      >
        {t('openspec.continueArtifact')}
      </button>
      {onOpenSessionHere && (
        <button
          type="button"
          onClick={onOpenSessionHere}
          aria-label={t('openspec.openSessionHere')}
          title={t('openspec.openSessionHereTooltip')}
          className="shrink-0 rounded border border-hairline px-3 py-1 text-xs text-ink-dim hover:border-accent hover:text-accent"
        >
          {t('openspec.openSessionHere')}
        </button>
      )}
      <span className="min-w-0 truncate text-xs text-ink-faint">
        {blocked
          ? t(`openspec.continueBlocked.${blocked}`)
          : t('openspec.continueMissing', { artifacts: missing.join(', ') })}
      </span>
    </div>
  )
}

/**
 * 分頁順序來自敘事順序、而非該 change 的 schema 所宣告的順序時，說出來。
 *
 * **沒有這句話，使用者無從分辨眼前的順序是權威的還是推測的** —— 而 spec-driven 之下兩者恰好相同，
 * 於是「看起來正確」不構成任何證據。**已封存的 change 永遠取不到權威順序**（core 只對進行中的
 * change 查詢），所以這不是偶發狀態而是常態。
 *
 * **進行中的 change 那句刻意不指出單一成因** —— 取不到的可能有好幾種（`openspec` 不可解析、逾時、
 * 非零結束、輸出裡沒有對得上的項目），而這裡手上沒有足以分辨的資訊。指定一個會是編造。
 * 措辭沿用上游 spek web（`ChangeDetail.tsx`），兩邊講的是同一件事。
 */
function FallbackNote({ reason }: { reason: Exclude<FallbackReason, null> }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <p className="shrink-0 border-b border-hairline px-4 py-1.5 text-2xs text-ink-faint">
      {reason === 'archived'
        ? t('openspec.schemaOrderArchived')
        : t('openspec.schemaOrderUnavailable')}
    </p>
  )
}

function ArtifactContent({
  artifact,
  onOpenFile,
}: {
  artifact: ChangeArtifactView
  onOpenFile: (relPath: string) => void
}): React.JSX.Element {
  return (
    <>
      {/* 跳去 Files 開原始檔的入口。specs 是一整棵子目錄，沒有單一檔案可跳（見下）。 */}
      {artifact.relPath && (
        <div className="mb-2 flex justify-end">
          <OpenFileButton relPath={artifact.relPath} onOpenFile={onOpenFile} />
        </div>
      )}

      {artifact.kind === 'tasks' && artifact.tasks && <TaskList tasks={artifact.tasks} />}

      {artifact.kind === 'specs' && artifact.specs && (
        <DeltaList specs={artifact.specs} onOpenFile={onOpenFile} />
      )}

      {artifact.kind === 'markdown' && artifact.content && <MarkdownView text={artifact.content} />}

      {artifact.kind === 'data' && artifact.content && <DataView text={artifact.content} />}
    </>
  )
}

/**
 * schema 宣告的資料 artifact（change 根目錄下的 `.yaml` / `.yml` / `.json`）。
 *
 * **不走 `MarkdownView`** —— YAML 與 JSON 餵給 markdown 渲染器不會失敗，它會安靜地**重新排版**：
 * 縮排被當成 code block、`#` 註解變成標題、清單的破折號被吃掉。那種失效看起來像「內容怪怪的」，
 * 不像「渲染錯了」。原文就是這種 artifact 的全部內容，原樣呈現才是忠實的。
 *
 * 樣式刻意與 markdown 的 code block 一致（`.markdown pre`）—— 使用者看到的應該是同一個東西。
 * 長行以水平捲動處理而不折行：資料檔的縮排是有意義的，折行會讓層次看起來是錯的。
 */
function DataView({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <pre
      aria-label={t('openspec.dataArtifact')}
      className="overflow-x-auto rounded-[5px] border border-hairline bg-shell p-3 font-mono text-sm leading-relaxed text-ink-dim"
    >
      {text}
    </pre>
  )
}

/**
 * task 的完成標記。
 *
 * **不用 `☑` / `☐` 這兩個字元** —— 它們是字型的 glyph，長相隨字型而變（與 box-drawing 在終端裡
 * 的問題同源：同一個語意，換一個字型就是另一個樣子，而我們控制不了使用者裝了什麼）。改為內嵌
 * SVG，形狀由我們自己畫。取自 spek web `ChangeDetail` 既有的樣式，兩邊看起來是同一個東西。
 *
 * 不引入 icon 套件 —— 為兩個 16×16 的圖形背一整包相依，不划算。
 */
function TaskMark({ completed }: { completed: boolean }): React.JSX.Element {
  return completed ? (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="mt-1 h-4 w-4 shrink-0 text-green"
    >
      <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.2" />
      <path
        d="M5 8l2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="mt-1 h-4 w-4 shrink-0 text-ink-faint"
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function TaskList({ tasks }: { tasks: ParsedTasks }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section aria-label={t('openspec.tasks')} className="flex flex-col gap-3">
      {tasks.sections.map((section) => (
        <div key={section.title}>
          {/*
            標題與 task 都用 `text-base` —— 與 proposal 那些純文字內文（MarkdownView）同一級。
            它一度比它底下的 task 還小，那說不通。層級靠字重與顏色區分，不靠字級。
          */}
          <h4 className="mb-1.5 text-base font-bold text-ink">{section.title}</h4>
          {/*
            task 清單是側欄的**主要閱讀內容** —— 使用者一邊駕駛 agent 一邊盯著的就是它。
            它一度被當成輔助文字：偏小的字級 + 暗灰 + 緊行距，三者疊起來，把字級旋鈕轉到
            底也還是嫌小。主要內容用主要內容的層級（`text-base`）、正常行距、未完成者用
            最亮的前景色 —— 「還沒做的事」才是要讀的東西。
          */}
          <ul className="flex flex-col gap-1">
            {section.tasks.map((task, index) => (
              <li
                /*
                  key 用 section + 位置，不用 `task.text` —— core 1.4.0 起 text 會把作者寫的續行
                  一併折進來，於是它又長又易變（改一個字就換 key，整個項目重建）。位置在這裡是
                  穩定的：清單來自單一檔案的一次解析，不會就地重排。
                */
                key={`${section.title}:${index}`}
                /*
                  `task-done` 不是樣式，是 `index.css` 那條 `.task-done .markdown *` 的掛載點：
                  淡化靠繼承傳給內文，而 `MarkdownView` 渲染出來的 `strong`／連結自帶顏色，
                  會贏過繼承。**改動這個 class 名要連 `index.css` 一起改。**
                */
                className={`flex gap-2 text-base ${
                  task.completed ? 'task-done text-ink-faint line-through' : 'text-ink'
                }`}
              >
                <TaskMark completed={task.completed} />
                {/*
                  **文字是 markdown，而且必須走 `MarkdownView`。**

                  `task.text` 與 proposal／design 那些 `.md` 同源 —— 使用者 repo 裡的不受信任內容。
                  那個元件的安全性來自一組**沒有被加上／覆寫的預設值**（原始 HTML 降級為純文字、
                  URL 經 `defaultUrlTransform` 過濾、連結交給主行程），而第二個 `react-markdown`
                  呼叫點就是第二個必須永遠記得維持它們的地方 —— **漏掉不會有任何紅燈**。
                */}
                <div className="min-w-0">
                  <MarkdownView text={task.text} dense />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

function DeltaList({
  specs,
  onOpenFile,
}: {
  specs: DeltaSpecView[]
  onOpenFile: (relPath: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section aria-label={t('openspec.specDeltas')} className="flex flex-col gap-4">
      {specs.map((spec) => {
        const parsed = parseDelta(spec.content)

        return (
          <div key={spec.topic} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <SectionTitle>{spec.topic}</SectionTitle>
              <span className="flex-1" />
              <OpenFileButton relPath={spec.relPath} onOpenFile={onOpenFile} />
            </div>

            {/* 格式不合預期就原樣渲染 markdown —— delta 的格式不是我們控制的（design D9）。 */}
            {parsed.fallback !== null ? (
              <div className="rounded border border-hairline bg-stage px-3 py-2">
                <MarkdownView text={parsed.fallback} />
              </div>
            ) : (
              parsed.requirements.map((requirement) => (
                <div
                  key={`${requirement.verb}:${requirement.name}`}
                  className="rounded border border-hairline bg-stage px-3 py-2"
                >
                  <div className="mb-1 flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-sm font-bold text-ink">
                      {requirement.name}
                    </span>
                    <DeltaBadge verb={requirement.verb} />
                  </div>
                  <MarkdownView text={requirement.body} />
                </div>
              ))
            )}
          </div>
        )
      })}
    </section>
  )
}

/** 跳到 Files 身分開這個檔。推不出路徑（不在 folder 內、或檔案不存在）時不顯示（design D5）。 */
function OpenFileButton({
  relPath,
  onOpenFile,
}: {
  relPath: string | null
  onOpenFile: (relPath: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()

  if (!relPath) return null

  return (
    <button
      type="button"
      onClick={() => onOpenFile(relPath)}
      aria-label={t('openspec.openInFiles', { path: relPath })}
      title={t('openspec.openInFiles', { path: relPath })}
      className="shrink-0 rounded border border-hairline px-[6px] py-[1px] text-2xs text-ink-faint hover:border-accent hover:text-accent"
    >
      ▤
    </button>
  )
}
