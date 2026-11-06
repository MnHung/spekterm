# Design

## Context

`OpenSpecService` creates one recursive watcher per `openspec/` (the folder's own and one per worktree) through
`createWatcher` (`src/main/watcher.ts`), which does not expose chokidar's `ignored`. Measured with chokidar 5 on
macOS (a fixture of 300 archived changes, four files each): the current watcher holds 1,202 file descriptors, the
design below 2, with the events listed under D1.

## Goals / Non-Goals

**Goals:** the watch cost of an `openspec/` stops growing with its archive, and every structural change the side
panel shows (a change archived, an archived change added or removed) still invalidates the cache.

**Non-Goals:**

- Watching only the folder the side panel shows (the open question of `openspec-side-panel` design). It would bound
  how many folders are watched; this change bounds what each one costs. Independent, left for later.
- A watched `openspec/` that is removed and created again stops being watched (`watcher.ts`, "被監看的目錄被刪掉再
  重建"). Already true today; not changed here.

## Decisions

### D1: Two watchers per `openspec/`, the archive one shallow

| Watcher | Target | Options |
|---|---|---|
| tree | `<openspec>` | `ignored`: `changes/archive` and everything under it |
| archive | `<openspec>/changes/archive` | `depth: 0`, only `addDir` / `unlinkDir` count |

Measured events: archiving a change is seen twice (the tree watcher's `unlinkDir` of `changes/<slug>` and the
archive watcher's `addDir`); an archived change directory added on its own is seen by the archive watcher; an edit
inside an archived change is seen by neither. The debounce makes the double sighting one notification.

Containment in the `ignored` predicate uses `path.relative`, never a prefix comparison (CLAUDE.md, file system
boundary).

Alternatives rejected:

- **Ignore only below `changes/archive/<name>/`, one watcher.** chokidar then watches each archived change
  directory itself: one directory watch per archived change, the part that costs most on macOS.
- **Watch `specs/` and `changes/` with a depth limit** (the fallback the original design sketched). One depth
  applies to the whole tree, and an active change needs depth (`specs/<topic>/spec.md`) where the archive must have
  none.
- **Polling, or one native recursive FSEvents stream.** Polling trades descriptors for periodic stat of the same
  files; a native stream is a new dependency and macOS only.

### D2: The archive watcher is rebuilt when its directory was missing or comes and goes

Measured: a chokidar watcher created on a missing `changes/archive` reports the directory appearing and then
nothing inside it; when `changes/` is missing too, it reports nothing at all. So the archive watcher is rebuilt:

- when one of its events names the archive directory itself (`addDir` or `unlinkDir` of the target), which covers
  creation after the watch started and removal followed by re-creation;
- at every scan, while the archive directory did not exist when the watcher was created. That covers `changes/`
  appearing later: the tree watcher sees `changes/` appear, the cache is invalidated, the next scan rebuilds.

A rebuild closes the old watcher and creates a new one in the same slot. Every path that closes an `openspec/`'s
watcher today closes both of its watchers, whichever archive watcher is current: a worktree leaving the list,
`releaseFolder`, and `dispose`.

## Risks / Trade-offs

- [An edit inside an archived change is not seen until another change is] → accepted (proposal, What Changes).
  What it can leave stale is an archived change's content or task count, never which changes exist.
- [An archived change added between a rebuild's close and the new watcher being ready is missed until the next
  change that is seen] → same class as the risk above; the window is one watcher start and opens only when the
  archive directory itself appears or disappears, or at a scan while it is missing.
