import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { summarize, type SummaryBucket, type SummaryEntry } from '@shared/wait/summary'
import type { RowState } from '@shared/wait/attention'
import { nextInOrder, railSessionOrder } from './rail-order'
import { useLineage } from './terminal/lineage'
import { StateDot, rowStateOf, sessionTitle } from './terminal/session-badge'
import { type SessionState, useSessions } from './terminal/sessions'
import { useAttention } from './terminal/wait'
import type { WorkspaceFolder } from './types'

/**
 * The main stage header's workspace summary (`session-wait-indicator`, "The main stage's header counts the
 * workspace's sessions by state and leads to them"): one control per state that has a session, most urgent first,
 * each going to the next session in that state — what a rail row click does, so the user reaches what needs them
 * without scrolling the rail.
 */

/** The dot each bucket shows: the state its sessions' rail dots show (running and unknown look alike). */
const BUCKET_DOT: Record<SummaryBucket, RowState> = {
  needsYou: 'waiting',
  error: 'error',
  working: 'working',
  running: 'running',
  idle: 'idle',
  hibernated: 'dormant',
  ended: 'ended',
}

interface Counted {
  folderId: string | null
  session: SessionState
  state: RowState
}

/**
 * How much of the summary the header has room for (design D9): words, or dots and counts, `shown` states of them,
 * the rest folded into one marker. With no room even for the marker beside the name's minimum, nothing is shown.
 */
interface Fit {
  words: boolean
  shown: number
  fold: boolean
}

const ALL_WITH_WORDS: Fit = { words: true, shown: Number.POSITIVE_INFINITY, fold: false }
const NOTHING: Fit = { words: false, shown: 0, fold: false }

export function SessionSummary({
  folders,
  focusedId,
  headerRef,
  nameRef,
  controlsRef,
  name,
}: {
  folders: readonly WorkspaceFolder[]
  /** The selected item's focused session — "next" starts after it. */
  focusedId: string | null
  headerRef: React.RefObject<HTMLElement | null>
  nameRef: React.RefObject<HTMLElement | null>
  controlsRef: React.RefObject<HTMLElement | null>
  /** The item's name as the header shows it; measured at full width to decide what gives way first. */
  name: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const sessions = useSessions()
  const { attentionOf } = useAttention()
  const lineage = useLineage()

  const order = railSessionOrder(folders, sessions.forFolder, lineage.exists)
  const summary = summarize<Counted>(
    order.map(({ folderId, session }) => {
      const state = rowStateOf(session, attentionOf(session.id))
      return { state, item: { folderId, session, state } }
    }),
  )

  const wordsRef = useRef<HTMLDivElement>(null)
  const compactRef = useRef<HTMLDivElement>(null)
  const foldRef = useRef<HTMLSpanElement>(null)
  const fullNameRef = useRef<HTMLSpanElement>(null)
  const fit = useHeaderFit(
    summary.length,
    { header: headerRef, name: nameRef, controls: controlsRef },
    { words: wordsRef, compact: compactRef, fold: foldRef, name: fullNameRef },
    name,
  )

  const jump = (entry: SummaryEntry<Counted>): void => {
    const ids = new Set(entry.items.map((item) => item.session.id))
    const next = nextInOrder(order, ids, focusedId)
    if (next) lineage.jumpTo(next.folderId, next.session.id)
  }

  const stateWords = (bucket: SummaryBucket): string => t(`stage.summaryState.${bucket}`)
  const countLabel = (entry: SummaryEntry<Counted>): string =>
    t('stage.summaryCount', { state: stateWords(entry.bucket), count: entry.items.length })
  const itemName = (folderId: string | null): string => lineage.itemName(folderId) ?? ''
  const sessionLine = (item: Counted): string => {
    const values = { session: sessionTitle(item.session), item: itemName(item.folderId) }
    if (item.state === 'choice') return t('stage.summaryChoice', values)
    if (item.state === 'waiting') return t('stage.summaryTurnEnded', values)
    return t('stage.summarySession', values)
  }
  const tooltip = (entry: SummaryEntry<Counted>): string =>
    [countLabel(entry), ...entry.items.map((item) => `• ${sessionLine(item)}`)].join('\n')

  if (summary.length === 0) return null

  const shown = Math.min(fit.shown, summary.length)
  const folded = summary.slice(shown)
  const visible = shown > 0 || fit.fold

  return (
    <>
      {visible && (
        <div role="group" aria-label={t('stage.summary')} className="flex shrink-0 items-center gap-2">
          {summary.slice(0, shown).map((entry) => (
            <SummaryButton
              key={entry.bucket}
              entry={entry}
              words={fit.words ? stateWords(entry.bucket) : null}
              label={countLabel(entry)}
              title={tooltip(entry)}
              onActivate={() => jump(entry)}
            />
          ))}
          {folded.length > 0 && (
            <span
              role="img"
              aria-label={t('stage.summaryFoldLabel', { count: folded.length })}
              title={folded.map(tooltip).join('\n\n')}
              className="shrink-0 rounded px-1.5 py-0.5 text-sm text-ink-dim"
            >
              {t('stage.summaryFold', { count: folded.length })}
            </span>
          )}
        </div>
      )}

      {/*
        The measurer: every control at both widths, and the name at full width, laid out but invisible, so the fit
        can be computed before anything overflows. Absolutely positioned, it is no flex item of the header (no gap,
        no width); `invisible` keeps it out of `innerText` (probes read the header's first line) and the
        accessibility tree; the clipping keeps it from widening the page.
      */}
      <div aria-hidden="true" className="pointer-events-none invisible absolute inset-0 flex flex-col overflow-hidden">
        <span ref={fullNameRef} className="w-max whitespace-nowrap">
          {name}
        </span>
        <div ref={wordsRef} className="flex w-max items-center gap-2">
          {summary.map((entry) => (
            <SummaryButton key={entry.bucket} entry={entry} words={stateWords(entry.bucket)} label="" title="" inert />
          ))}
        </div>
        <div ref={compactRef} className="flex w-max items-center gap-2">
          {summary.map((entry) => (
            <SummaryButton key={entry.bucket} entry={entry} words={null} label="" title="" inert />
          ))}
        </div>
        <span ref={foldRef} className="w-max shrink-0 rounded px-1.5 py-0.5 text-sm whitespace-nowrap">
          {t('stage.summaryFold', { count: summary.length })}
        </span>
      </div>
    </>
  )
}

function SummaryButton({
  entry,
  words,
  label,
  title,
  onActivate,
  inert,
}: {
  entry: SummaryEntry<Counted>
  words: string | null
  label: string
  title: string
  onActivate?: () => void
  /** A copy in the measurer: never focusable. */
  inert?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      tabIndex={inert ? -1 : undefined}
      aria-label={label || undefined}
      title={title || undefined}
      onClick={onActivate}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-sm whitespace-nowrap text-ink-dim hover:bg-hover hover:text-ink"
    >
      <StateDot state={BUCKET_DOT[entry.bucket]} />
      <span className="tabular-nums">{entry.items.length}</span>
      {words !== null && <span>{words}</span>}
    </button>
  )
}

/**
 * Decides what the summary shows from the room the header has (design D9), measured with a `ResizeObserver` so it
 * holds in either language and at any zoom: words if everything fits beside the full name; else dots and counts;
 * else the most urgent states with the rest folded into one marker; only then the name truncates, down to its
 * minimum.
 */
interface MeasureRefs {
  /** The controls with words, one child each, spaced as the summary spaces them. */
  words: React.RefObject<HTMLDivElement | null>
  /** The controls with dots and counts only, one child each. */
  compact: React.RefObject<HTMLDivElement | null>
  fold: React.RefObject<HTMLSpanElement | null>
  /** The name at full width. */
  name: React.RefObject<HTMLSpanElement | null>
}

interface HeaderRefs {
  header: React.RefObject<HTMLElement | null>
  name: React.RefObject<HTMLElement | null>
  controls: React.RefObject<HTMLElement | null>
}

function useHeaderFit(count: number, header: HeaderRefs, measured: MeasureRefs, name: string): Fit {
  const [fit, setFit] = useState<Fit>(ALL_WITH_WORDS)
  // The refs are stable objects; the callback reads them when it runs.
  const refs = useRef({ header, measured })
  useLayoutEffect(() => {
    refs.current = { header, measured }
  })

  const measure = useCallback(() => {
    const { header: h, measured: m } = refs.current
    const headerElement = h.header.current
    const nameElement = h.name.current
    const controls = h.controls.current
    if (!headerElement || !nameElement || !controls || !m.words.current || !m.compact.current) return

    const style = getComputedStyle(headerElement)
    const gap = Number.parseFloat(style.columnGap) || 0
    const inner =
      headerElement.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0)
    const widths = (row: HTMLElement): number[] =>
      [...row.children].map((child) => child.getBoundingClientRect().width)
    const words = widths(m.words.current)
    const compact = widths(m.compact.current)
    const fold = m.fold.current?.getBoundingClientRect().width ?? 0
    const fullName = m.name.current?.getBoundingClientRect().width ?? 0
    const minName = Number.parseFloat(getComputedStyle(nameElement).minWidth) || 0
    const innerGap = Number.parseFloat(getComputedStyle(m.words.current).columnGap) || 0
    const row = (list: number[]): number =>
      list.reduce((sum, value) => sum + value, 0) + innerGap * Math.max(0, list.length - 1)

    // The controls' natural width, not their current one: in a narrow header their labels wrap, and room measured
    // against wrapped controls would keep them wrapped. Set and restored within one task, so nothing paints.
    const previous = controls.style.width
    controls.style.width = 'max-content'
    const controlsWidth = controls.getBoundingClientRect().width
    controls.style.width = previous

    // Name, summary, spacer, controls: three gaps.
    const roomBeside = (nameWidth: number): number =>
      inner - controlsWidth - Math.max(nameWidth, minName) - gap * 3

    const choose = (room: number): Fit | null => {
      if (row(words) <= room) return ALL_WITH_WORDS
      if (row(compact) <= room) return { words: false, shown: compact.length, fold: false }
      for (let shown = compact.length - 1; shown >= 0; shown -= 1) {
        if (row([...compact.slice(0, shown), fold]) <= room) return { words: false, shown, fold: true }
      }
      return null
    }
    const next = choose(roomBeside(fullName)) ?? choose(roomBeside(minName)) ?? NOTHING
    setFit((current) =>
      current.words === next.words && current.shown === next.shown && current.fold === next.fold ? current : next,
    )
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [measure, count, name])

  useLayoutEffect(() => {
    const { header: h, measured: m } = refs.current
    const observer = new ResizeObserver(() => measure())
    for (const element of [h.header.current, h.controls.current, m.words.current, m.name.current]) {
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [measure, count])

  return fit
}
