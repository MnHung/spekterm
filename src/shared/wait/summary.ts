import { type RowState, URGENCY } from './attention'

/**
 * The main stage's header summary (`session-wait-indicator`, "The main stage's header counts the workspace's
 * sessions by state"): every session with a rail entry, counted by the state its own dot shows.
 *
 * Choice and waiting share a dot, so they are one bucket ("needs you"); running and unknown share one too, as do
 * the dots of hibernated and ended — but those two stay apart, ended last.
 */
export type SummaryBucket = 'needsYou' | 'error' | 'working' | 'running' | 'idle' | 'hibernated' | 'ended'

export const BUCKET_OF: Record<RowState, SummaryBucket> = {
  choice: 'needsYou',
  waiting: 'needsYou',
  error: 'error',
  working: 'working',
  running: 'running',
  unknown: 'running',
  idle: 'idle',
  dormant: 'hibernated',
  ended: 'ended',
}

/** The buckets in the order the header lists them: `URGENCY`, ended after hibernated (they tie there). */
export const BUCKET_ORDER: readonly SummaryBucket[] = (Object.keys(BUCKET_OF) as RowState[])
  .map((state, index) => ({ bucket: BUCKET_OF[state], rank: URGENCY[state], index }))
  .sort((a, b) => a.rank - b.rank || a.index - b.index)
  .map(({ bucket }) => bucket)
  .filter((bucket, index, all) => all.indexOf(bucket) === index)

export interface SummaryEntry<T> {
  bucket: SummaryBucket
  /** The entries in this bucket, in the order they were given (the rail's order). */
  items: T[]
}

/** The non-empty buckets, most urgent first. */
export function summarize<T>(entries: readonly { state: RowState; item: T }[]): SummaryEntry<T>[] {
  const byBucket = new Map<SummaryBucket, T[]>()
  for (const { state, item } of entries) {
    const bucket = BUCKET_OF[state]
    const list = byBucket.get(bucket) ?? []
    list.push(item)
    byBucket.set(bucket, list)
  }
  return BUCKET_ORDER.filter((bucket) => byBucket.has(bucket)).map((bucket) => ({
    bucket,
    items: byBucket.get(bucket) ?? [],
  }))
}
