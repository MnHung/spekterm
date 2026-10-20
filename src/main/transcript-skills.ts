/**
 * The skills an agent was told it can invoke, from its own transcript (`remote-phone-context`, part C;
 * `docs/remote-protocol.md`, `conversation.skills`).
 *
 * ## The source
 *
 * The agent records its listing as `attachment` records of subtype `skill_listing`:
 * `{ content: "- name: description\n…", skillCount, isInitial, names: [string] }`. It is exactly what the agent can
 * invoke — user, repository and plugin skills as the CLI resolved them — which a scan of skill directories could
 * only approximate. It is an internal format: a change makes the list absent, never wrong (white-list parse).
 *
 * ## Reading later records (measured, CLI 2.1.304, `docs/lessons/transcript.md`)
 *
 * - `isInitial: true` is a full listing (the first prompt, `/compact`, a resume): it **replaces** the list.
 * - `isInitial: false` names only added skills or skills whose description changed: it **adds or updates**,
 *   keeping first-seen order.
 * - A removal writes nothing: the removed skill stays in what the agent was told until the next full listing, and
 *   so it stays here.
 */

export interface Skill {
  name: string
  description: string | null
}

/** `null` = no listing in the transcript read so far. */
export type SkillList = readonly Skill[] | null

const DESCRIPTION_MAX = 300

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function clean(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX)
  return cleaned === '' ? null : cleaned
}

/**
 * Each name's description in `content`: the text after `- <name>: ` up to the next line that starts a listed name.
 * A bare `- <name>` line has none, and still ends the previous one.
 */
function descriptions(names: readonly string[], content: string): Map<string, string | null> {
  const known = new Set(names)
  const found = new Map<string, string | null>()
  let current: string | null = null
  let parts: string[] = []
  const flush = () => {
    if (current !== null && !found.has(current)) found.set(current, clean(parts.join(' ')))
  }
  for (const line of content.split('\n')) {
    const head = /^- (\S+?)(?::(?: (.*))?)?$/.exec(line)
    const name = head && known.has(head[1]) ? head[1] : null
    if (name !== null) {
      flush()
      current = name
      parts = head?.[2] ? [head[2]] : []
    } else if (current !== null) {
      parts.push(line)
    }
  }
  flush()
  return found
}

/** The listing a parsed transcript record carries, or `null` when it is not one (white-list). */
export function listingOf(raw: unknown): { initial: boolean; skills: Skill[] } | null {
  const r = record(raw)
  if (!r || r.type !== 'attachment') return null
  const attachment = record(r.attachment)
  if (!attachment || attachment.type !== 'skill_listing') return null
  const names = attachment.names
  if (!Array.isArray(names) || names.length === 0) return null
  if (!names.every((name): name is string => typeof name === 'string' && name.trim() !== '' && !/\s/.test(name))) {
    return null
  }
  const content = typeof attachment.content === 'string' ? attachment.content : ''
  const described = descriptions(names, content)
  const seen = new Set<string>()
  const skills: Skill[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    skills.push({ name, description: described.get(name) ?? null })
  }
  return { initial: attachment.isInitial === true, skills }
}

/** Folds parsed transcript records into the list (see the reading rules above). */
export function foldSkills(list: SkillList, records: readonly unknown[]): SkillList {
  let next = list
  for (const raw of records) {
    const listing = listingOf(raw)
    if (!listing) continue
    if (listing.initial || next === null) {
      next = listing.skills
      continue
    }
    const merged = [...next]
    for (const skill of listing.skills) {
      const at = merged.findIndex((known) => known.name === skill.name)
      if (at >= 0) merged[at] = skill
      else merged.push(skill)
    }
    next = merged
  }
  return next
}

export function sameSkills(a: SkillList, b: SkillList): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
