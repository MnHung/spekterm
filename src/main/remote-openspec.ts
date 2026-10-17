import { sortArtifacts } from '@spekjs/core/artifact-order'
import { FRAME_MAX_BYTES, RemoteError } from './remote-frames'
import type {
  ChangeDetailView,
  ChangeOrigin,
  ChangeSummary,
  ChangesData,
  SpecDetailView,
  SpecSummary,
} from './openspec-service'

/**
 * The OpenSpec results a device receives (`remote-openspec-browse`, `docs/remote-protocol.md` section 5).
 *
 * **Every field is copied by name** (design D1). The service's views are the renderer's, and they let core's new
 * fields flow through on purpose (`ChangeSummary` is `Omit<ChangeInfo, 'source'>`); a network contract must not.
 * A field the views gain later reaches a device only when it is named here and in the document. Names are those
 * the views have, so a client reads an older desktop's pass-through answers with the same parser.
 *
 * Dropped on purpose: every `relPath` (the desktop's "open in Files"), the worktree's `key` / `vcs` /
 * `isFolderRoot`, `schema` / `defaultSchema` / `schemaOrder` / `missingArtifacts`, `date`, `artifactCount`, the
 * tasks artifact's raw `content`, and a spec's `relatedChanges` (the same slugs as its `history`).
 */

export interface RemoteWorktree {
  branch: string | null
  isMain: boolean
}

export interface RemoteChange {
  slug: string
  status: 'active' | 'archived'
  description: string
  createdDate: string | null
  archivedDate: string | null
  timestamp: string | null
  hasProposal: boolean
  hasDesign: boolean
  hasSpecs: boolean
  hasTasks: boolean
  taskStats: { total: number; completed: number } | null
  worktree?: RemoteWorktree
}

export interface Omitted {
  omitted: { bytes: number }
}

export interface RemoteTasks {
  total: number
  completed: number
  sections: { title: string; tasks: { text: string; completed: boolean }[] }[]
}

export type RemoteDelta = { topic: string; content?: string } & Partial<Omitted>

export type RemoteArtifact = {
  id: string
  title: string
  kind: 'markdown' | 'tasks' | 'specs' | 'data'
  content?: string
  tasks?: RemoteTasks
  specs?: RemoteDelta[]
} & Partial<Omitted>

export interface RemoteChangeDetail {
  slug: string
  status: 'active' | 'archived'
  createdDate: string | null
  archivedDate: string | null
  worktree?: RemoteWorktree
  artifacts: RemoteArtifact[]
}

export interface RemoteSpecDetail {
  topic: string
  content?: string
  omitted?: { bytes: number }
  history: { slug: string; status: 'active' | 'archived'; description: string; date: string | null; timestamp: string | null }[]
  origin?: RemoteWorktree
}

/**
 * The most an OpenSpec answer may hold, as UTF-8 bytes of the serialized result: the frame cap less a reserve for
 * the frame's envelope (`{"t":"res","id":…,"ok":true,"r":…}` with a 64-character id, escaped, is under 1 KiB).
 */
export const ANSWER_BUDGET_BYTES = FRAME_MAX_BYTES - 4 * 1024

function worktree(origin: ChangeOrigin | undefined): RemoteWorktree | undefined {
  return origin ? { branch: origin.branch, isMain: origin.isMain } : undefined
}

function change(view: ChangeSummary): RemoteChange {
  const wt = worktree(view.worktree)
  return {
    slug: view.slug,
    status: view.status,
    description: view.description,
    createdDate: view.createdDate,
    archivedDate: view.archivedDate,
    timestamp: view.timestamp,
    hasProposal: view.hasProposal,
    hasDesign: view.hasDesign,
    hasSpecs: view.hasSpecs,
    hasTasks: view.hasTasks,
    taskStats: view.taskStats ? { total: view.taskStats.total, completed: view.taskStats.completed } : null,
    ...(wt ? { worktree: wt } : {}),
  }
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function tooLarge(what: string): RemoteError {
  return new RemoteError('TOO_LARGE', `${what} is larger than a frame`, { limit: FRAME_MAX_BYTES })
}

/** A list has no content to leave out: over the budget, it is refused with the limit. */
function bounded<T>(result: T, what: string): T {
  if (sizeOf(result) > ANSWER_BUDGET_BYTES) throw tooLarge(what)
  return result
}

/** One piece of content that may be left out: `key` on `holder` is replaced by `omitted: { bytes }`. */
interface Piece {
  holder: Record<string, unknown>
  key: string
  bytes: number
  /** Display order, for ties. */
  order: number
}

function piece(holder: Record<string, unknown>, key: string, order: number): Piece | null {
  if (holder[key] === undefined) return null
  return { holder, key, bytes: sizeOf(holder[key]), order }
}

/**
 * Leaves content out, largest first (ties in display order), until the serialized result fits the budget
 * (design D4). Each step's saving is computed exactly — the property `"key":value` is replaced by
 * `"omitted":{"bytes":N}`, one property for one, so no comma changes — and the result is measured again at the
 * end. Still over with every piece left out is `TOO_LARGE`.
 */
function fit<T>(result: T, pieces: (Piece | null)[], what: string): T {
  let size = sizeOf(result)
  if (size <= ANSWER_BUDGET_BYTES) return result
  const queue = pieces.filter((p): p is Piece => p !== null).sort((a, b) => b.bytes - a.bytes || a.order - b.order)
  for (const p of queue) {
    if (size <= ANSWER_BUDGET_BYTES) break
    const omitted = { bytes: p.bytes }
    size -= sizeOf(p.key) + p.bytes - (sizeOf('omitted') + sizeOf(omitted))
    delete p.holder[p.key]
    p.holder.omitted = omitted
  }
  if (sizeOf(result) > ANSWER_BUDGET_BYTES) throw tooLarge(what)
  return result
}

export function remoteChanges(view: ChangesData): { active: RemoteChange[]; archived: RemoteChange[] } {
  return bounded({ active: view.active.map(change), archived: view.archived.map(change) }, "the folder's change list")
}

export function remoteSpecs(view: SpecSummary[]): { topic: string; relatedChangeCount: number }[] {
  return bounded(
    view.map((spec) => ({ topic: spec.topic, relatedChangeCount: spec.relatedChangeCount })),
    "the folder's spec list",
  )
}

export function remoteChange(view: ChangeDetailView): RemoteChangeDetail {
  const pieces: (Piece | null)[] = []
  let order = 0
  // The side panel's order (`ChangeView.tsx`), so no client reimplements it. Core's own order is by mtime.
  const artifacts = sortArtifacts(view.artifacts, 'schema', view.schemaOrder).map((artifact): RemoteArtifact => {
    const out: RemoteArtifact = { id: artifact.id, title: artifact.title, kind: artifact.kind }
    if (artifact.kind === 'tasks') {
      if (artifact.tasks) {
        out.tasks = {
          total: artifact.tasks.total,
          completed: artifact.tasks.completed,
          sections: artifact.tasks.sections.map((section) => ({
            title: section.title,
            tasks: section.tasks.map((task) => ({ text: task.text, completed: task.completed })),
          })),
        }
      }
      pieces.push(piece(out, 'tasks', order++))
    } else if (artifact.kind === 'specs') {
      out.specs = (artifact.specs ?? []).map((delta) => {
        const d: RemoteDelta = { topic: delta.topic, content: delta.content }
        pieces.push(piece(d, 'content', order++))
        return d
      })
    } else if (artifact.content !== undefined) {
      out.content = artifact.content
      pieces.push(piece(out, 'content', order++))
    }
    return out
  })
  const wt = worktree(view.worktree)
  const result: RemoteChangeDetail = {
    slug: view.slug,
    status: view.status,
    createdDate: view.createdDate,
    archivedDate: view.archivedDate,
    ...(wt ? { worktree: wt } : {}),
    artifacts,
  }
  return fit(result, pieces, 'the change')
}

export function remoteSpec(view: SpecDetailView): RemoteSpecDetail {
  const origin = worktree(view.origin)
  const result: RemoteSpecDetail = {
    topic: view.topic,
    content: view.content,
    history: view.history.map((entry) => ({
      slug: entry.slug,
      status: entry.status,
      description: entry.description,
      date: entry.date,
      timestamp: entry.timestamp,
    })),
    ...(origin ? { origin } : {}),
  }
  return fit(result, [piece(result as unknown as Record<string, unknown>, 'content', 0)], 'the spec')
}
