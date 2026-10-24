import { type Forest, buildForest } from './session-forest'

/**
 * The rail's order of items and of their sessions, shared by the rail and the main stage's header summary
 * (`session-wait-indicator`, design D7). **The counted set is what the rail lists**: the global item's sessions
 * and each workspace folder's — a folder that left the workspace is not an item, so its still-running sessions
 * are out by construction.
 *
 * The rail still renders through its own recursion; `probe:agent-view` asserts that the summary's jump sequence
 * equals the rail's DOM row order, which is what keeps the two together.
 */

export interface RailFolder {
  id: string
  pinned: boolean
}

export interface RailSession {
  id: string
  lineage?: { parentId?: string }
}

/** The rail's two sections of folders, each folder with its index in the workspace list (drag rows use it). */
export function railSections<F extends RailFolder>(
  folders: readonly F[],
): { pinned: { folder: F; folderIndex: number }[]; rest: { folder: F; folderIndex: number }[] } {
  const indexed = folders.map((folder, folderIndex) => ({ folder, folderIndex }))
  return { pinned: indexed.filter(({ folder }) => folder.pinned), rest: indexed.filter(({ folder }) => !folder.pinned) }
}

/** The rail items, top to bottom: the global item (`null`), the pinned folders, then the rest. */
export function railItems(folders: readonly RailFolder[]): (string | null)[] {
  const { pinned, rest } = railSections(folders)
  return [null, ...[...pinned, ...rest].map(({ folder }) => folder.id)]
}

/**
 * One item's session tree. `exists` decides **only who can be a parent**, as on the rail — it is not a filter: an
 * ended session is not "existing" (`session-lineage`) but the rail still lists it; its children become top-level rows.
 */
export function railForest<S extends RailSession>(sessions: readonly S[], exists: (session: S) => boolean): Forest {
  return buildForest(
    sessions.map((session) => ({ id: session.id, parentId: session.lineage?.parentId })),
    new Set(sessions.filter(exists).map((session) => session.id)),
  )
}

export interface RailEntry<S> {
  folderId: string | null
  session: S
}

/** Every session with a rail entry, in the order its row appears on the rail (collapsed items included). */
export function railSessionOrder<S extends RailSession>(
  folders: readonly RailFolder[],
  sessionsOf: (folderId: string | null) => readonly S[],
  exists: (session: S) => boolean,
): RailEntry<S>[] {
  return railItems(folders).flatMap((folderId) => {
    const sessions = sessionsOf(folderId)
    const byId = new Map(sessions.map((session) => [session.id, session]))
    return railForest(sessions, exists).rows.flatMap((row) => {
      const session = byId.get(row.id)
      return session ? [{ folderId, session }] : []
    })
  })
}

/**
 * The next entry among `candidates` after `focusedId` in `order`, wrapping; from the start when the focused session
 * is not in the order. `null` when there is no candidate.
 */
export function nextInOrder<S extends RailSession>(
  order: readonly RailEntry<S>[],
  candidates: ReadonlySet<string>,
  focusedId: string | null,
): RailEntry<S> | null {
  const start = order.findIndex((entry) => entry.session.id === focusedId)
  for (const offset of order.keys()) {
    const entry = order[(start + 1 + offset) % order.length]
    if (candidates.has(entry.session.id)) return entry
  }
  return null
}
