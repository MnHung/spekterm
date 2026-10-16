/**
 * A session's chain of ancestors (`session-lineage`, "A session records its whole chain of ancestors").
 *
 * **One function for every reader**: the handoff's ingestion (which records the chain), the relations file (which
 * draws the descendant tree) and the agent's session commands (which may act only on descendants). If they walked
 * the chain differently, a session could be listed in the tree and refused as a target, or the reverse
 * (`agent-session-control` design D4).
 *
 * Callers pass **every record**, not only the sessions that exist: a session whose folder left the workspace still
 * links its descendants to its ancestors. Existence filters what is shown and what may be targeted, never the walk.
 */

/** The longest chain kept: nearest first, so past it the farthest ancestors are lost. */
export const MAX_ANCESTRY = 64

export interface AncestryRecord {
  lineage?: { parentId: string; ancestors?: readonly string[] }
}

/**
 * The ids above `id`, nearest first: its parent, its parent's parent, and so on.
 *
 * A recorded `ancestors` ends the walk (it was taken at ingestion and outlives the records it names). Without one
 * (a record from before chains were kept) the walk continues through the parent's record, if it still exists. It
 * stops on a missing record, on an id already seen (a corrupt file must not loop), and at `MAX_ANCESTRY`.
 */
export function ancestryOf(id: string, byId: (id: string) => AncestryRecord | undefined): string[] {
  const chain: string[] = []
  const seen = new Set([id])
  let current = byId(id)
  while (current?.lineage && chain.length < MAX_ANCESTRY) {
    const parentId = current.lineage.parentId
    if (seen.has(parentId)) break
    seen.add(parentId)
    chain.push(parentId)
    const recorded = current.lineage.ancestors
    if (recorded) {
      for (const ancestor of recorded) {
        if (chain.length >= MAX_ANCESTRY || seen.has(ancestor)) break
        seen.add(ancestor)
        chain.push(ancestor)
      }
      break
    }
    current = byId(parentId)
  }
  return chain
}

/** Whether `ancestorId` is in `id`'s chain: `id` is a descendant of it. */
export function isDescendantOf(id: string, ancestorId: string, byId: (id: string) => AncestryRecord | undefined): boolean {
  return ancestryOf(id, byId).includes(ancestorId)
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Reads a persisted chain back: an array of session ids, capped at `MAX_ANCESTRY`. Anything else is `undefined`,
 * and the caller drops **only this field** — a broken chain must not cost the session its lineage, nor its row on
 * the rail (`session-lineage`, "損毀的關係不使 session 從 rail 消失").
 */
export function parseAncestors(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  if (!raw.every((id) => typeof id === 'string' && UUID_SHAPE.test(id))) return undefined
  return (raw as string[]).slice(0, MAX_ANCESTRY)
}
