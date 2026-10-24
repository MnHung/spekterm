import { ChangeTimeline, SpecGraph, buildLanes } from '@spekjs/ui'
import { useMemo, useState } from 'react'
import type { ChangeInfo } from '../types'
import type { VizKind } from '../maximize-state'
import { useChanges, useGraphData } from './data'
import { ErrorNote, Loading } from './ui'
import { useTranslation } from 'react-i18next'
import { useColorScheme } from '../../color-scheme'

interface VizViewProps {
  folderId: string
  kind: VizKind
  /** A change chosen in the graph or the timeline: the panel shows it in This change. */
  onSelectChange: (slug: string) => void
  /** A spec chosen in the graph: the panel shows it in Browse. */
  onSelectSpec: (topic: string) => void
}

/**
 * Graph and Timeline as views of the maximized side panel (`openspec-panel`, "Graph and Timeline
 * are views of the maximized side panel"). They used to be a full-window overlay because Timeline
 * needs more than 900px; the maximized side panel spans the main stage, and on a narrower window
 * this view scrolls horizontally.
 *
 * **They are different things** — Graph is the structure of specs and changes, Timeline the life
 * cycle of changes. Both come from **`@spekjs/ui`**, the same code spek web uses; this is only the
 * host's part: fetching, loading / error, and handing the user's choice back.
 *
 * This element is the sibling of the panel's own scroll container, which stays mounted and hidden
 * while this is shown — so that view comes back exactly as it was (design M5).
 */
export function VizView({ folderId, kind, onSelectChange, onSelectSpec }: VizViewProps): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {kind === 'graph' ? (
        <GraphPane folderId={folderId} onSelectChange={onSelectChange} onSelectSpec={onSelectSpec} />
      ) : (
        <TimelinePane folderId={folderId} onSelectChange={onSelectChange} />
      )}
    </div>
  )
}

function GraphPane({
  folderId,
  onSelectChange,
  onSelectSpec,
}: {
  folderId: string
  onSelectChange: (slug: string) => void
  onSelectSpec: (topic: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  const { data, loading, error } = useGraphData(folderId)
  // Graph writes resolved colors into its SVG and redraws only when `themeKey` changes (`ui-appearance`).
  const colorScheme = useColorScheme()

  if (error) return <ErrorNote message={error} />
  if (loading || !data) return <Loading />
  if (data.edges.length === 0) {
    return <p className="px-4 py-3 text-sm text-ink-faint">{t('viz.noGraph')}</p>
  }

  // 圖會填滿父容器 —— 父容器要有明確高度，且 relative 才放得下圖例。
  return (
    <div className="relative h-full min-h-[400px] overflow-hidden rounded border border-hairline bg-shell">
      <SpecGraph data={data} onSelectSpec={onSelectSpec} onSelectChange={onSelectChange} themeKey={colorScheme} />
    </div>
  )
}

function TimelinePane({
  folderId,
  onSelectChange,
}: {
  folderId: string
  onSelectChange: (slug: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  const changes = useChanges(folderId)
  const graph = useGraphData(folderId)
  const [groupByTopic, setGroupByTopic] = useState(false)
  const [hideActive, setHideActive] = useState(false)
  const [hideArchived, setHideArchived] = useState(false)

  const all = useMemo<ChangeInfo[]>(
    () => (changes.data ? [...changes.data.active, ...changes.data.archived] : []),
    [changes.data],
  )

  const filtered = useMemo(
    () =>
      all.filter((change) => {
        if (hideActive && change.status === 'active') return false
        if (hideArchived && change.status === 'archived') return false
        return true
      }),
    [all, hideActive, hideArchived],
  )

  // group by topic 才需要關係圖（它用來推 change → topic 的對應）。
  const { lanes, unknownCreated } = useMemo(
    () =>
      buildLanes(filtered, groupByTopic ? (graph.data ?? null) : null, groupByTopic),
    [filtered, graph.data, groupByTopic],
  )

  if (changes.error) return <ErrorNote message={changes.error} />
  if (changes.loading || !changes.data) return <Loading />

  const laneItems = lanes.reduce((total, lane) => total + lane.items.length, 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          label={groupByTopic ? t('viz.groupedByTopic') : t('viz.groupByTopic')}
          active={groupByTopic}
          onClick={() => setGroupByTopic((v) => !v)}
        />
        <span className="h-4 w-px bg-hairline" />
        <Chip
          label={t('viz.hideActive')}
          active={hideActive}
          onClick={() => setHideActive((v) => !v)}
        />
        <Chip
          label={t('viz.hideArchived')}
          active={hideArchived}
          onClick={() => setHideArchived((v) => !v)}
        />
      </div>

      {laneItems === 0 ? (
        <p className="rounded border border-hairline px-4 py-6 text-sm text-ink-faint">
          {t('viz.noTimeline')}
        </p>
      ) : (
        <ChangeTimeline
          lanes={lanes}
          groupByTopic={groupByTopic}
          onSelectChange={(change) => onSelectChange(change.slug)}
        />
      )}

      {/* 沒有 createdDate 的 change 放不上時間軸 —— 它們不該就這樣消失。 */}
      {unknownCreated.length > 0 && (
        <section aria-label={t('viz.undatedSection')}>
          <h3 className="mb-1 text-xs font-bold text-ink-dim">
            {t('viz.undatedHeading', { count: unknownCreated.length })}
          </h3>
          <ul className="flex flex-col gap-[2px]">
            {unknownCreated.map((change) => (
              <li key={change.slug}>
                <button
                  type="button"
                  onClick={() => onSelectChange(change.slug)}
                  className="font-mono text-xs text-ink-faint hover:text-accent"
                  title={change.description}
                >
                  {change.slug}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded border px-2 py-[3px] text-xs transition-colors ${
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-hairline text-ink-dim hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}
