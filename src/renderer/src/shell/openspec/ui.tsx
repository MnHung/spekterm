import { useTranslation } from 'react-i18next'
import { t } from '@shared/i18n'
import type { DeltaVerb } from './delta'

/**
 * 資料未到達時的載入狀態。
 *
 * **不可以用空狀態代替** —— 空白會讓使用者以為這個 repo 沒有 OpenSpec 內容，或側欄壞了。
 * 掃描要遞迴讀目錄並取 git 時間戳，大 repo 的第一次是感覺得到的。
 */
export function Loading(): React.JSX.Element {
  const { t: translate } = useTranslation()
  return <p className="px-4 py-3 text-sm text-ink-faint">{translate('common.loading')}</p>
}

export function ErrorNote({ message }: { message: string }): React.JSX.Element {
  return <p className="px-4 py-3 text-sm text-danger">{message}</p>
}

export function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mb-2 text-2xs font-bold uppercase tracking-wider text-ink-faint">
      {children}
    </h3>
  )
}

/** change 的狀態。active 是 amber，archived 是安靜的灰。 */
export function StatusBadge({ status }: { status: 'active' | 'archived' }): React.JSX.Element {
  return (
    <span
      className={`shrink-0 rounded px-[6px] py-[1px] font-mono text-2xs font-bold uppercase ${
        status === 'active' ? 'bg-accent-soft text-accent' : 'bg-hover text-ink-faint'
      }`}
    >
      {status}
    </span>
  )
}

/**
 * change 的來源工作目錄（git worktree）。
 *
 * 規則對齊 spek 的 `WorktreeBadge`：**主工作目錄不標示** —— 在單一工作目錄的 repo 裡那會是
 * 每一列都重複一次的雜訊（比照 rail 把「每列都喊一次的 OpenSpec」降級的判斷）。
 *
 * **唯一偏離 spek 的地方是沒有 tooltip**：它那顆的 `title` 是來源的**絕對路徑**，而 renderer
 * 不持有該資訊（DTO 丟棄了它）。分支名本身已足以識別來源。
 */
export function WorktreeBadge({
  worktree,
}: {
  worktree?: { branch: string | null; vcs: 'git' | 'jj'; isMain: boolean }
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!worktree || worktree.isMain) return null

  const branch = worktree.branch ?? t('openspec.worktreeDetached')
  const label = worktree.vcs === 'jj' ? `jj:${worktree.branch ?? ''}` : branch

  return (
    <span className="min-w-0 shrink truncate rounded border border-hairline px-[6px] py-[1px] font-mono text-2xs text-ink-faint">
      {label}
    </span>
  )
}

/** delta 的動作。ADDED 是 amber、MODIFIED 是 blue（雛型的 .req-block badge）。 */
export function DeltaBadge({ verb }: { verb: DeltaVerb }): React.JSX.Element {
  const tone =
    verb === 'ADDED'
      ? 'bg-accent-soft text-accent'
      : verb === 'MODIFIED'
        ? 'bg-blue/15 text-blue'
        : verb === 'REMOVED'
          ? 'bg-danger/15 text-danger'
          : 'bg-hover text-ink-dim'

  return (
    <span
      className={`shrink-0 rounded px-[6px] py-[1px] font-mono text-2xs font-bold uppercase ${tone}`}
    >
      {verb}
    </span>
  )
}

/** tasks 的完成比例。零任務時為空條而非滿條。 */
export function ProgressBar({
  completed,
  total,
}: {
  completed: number
  total: number
}): React.JSX.Element {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)

  return (
    <div
      role="progressbar"
      aria-valuenow={completed}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={t('openspec.taskProgress')}
      className="h-[3px] w-full overflow-hidden rounded-full bg-hover"
    >
      <i className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  )
}

/** `3/9`。側欄各處共用的計數樣式。 */
export function TaskCount({
  completed,
  total,
}: {
  completed: number
  total: number
}): React.JSX.Element {
  return (
    <span className="shrink-0 font-mono text-xs text-accent">
      {completed}/{total}
    </span>
  )
}
