# Design

## Context

`OpenSpecService` creates one recursive watcher per `openspec/` (the folder's own and one per worktree) through
`createWatcher` (`src/main/watcher.ts`), which does not expose chokidar's `ignored`. Measured with chokidar 5 on
macOS (a fixture of 300 archived changes, four files each): the current watcher holds 1,202 file descriptors, the
design below 1, with the events listed under D1.

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
| tree | `<openspec>` | `ignored`: everything under `changes/archive`, not the directory itself |
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

### D2: The archive watcher exists only while its directory does, and the tree watcher decides when

Measured: a chokidar watcher created on a missing `changes/archive` reports the directory appearing and then
nothing inside it; when `changes/` is missing too, it reports nothing at all; and closing one around that
transition left a native watch on `changes/` open (a unit test run never exited). So no watcher is ever created on
a missing path. The tree watcher does not ignore the archive directory itself (one more directory watch), and:

- its `addDir` of `changes/archive` opens the archive watcher, its `unlinkDir` closes it — covering the directory
  created after the watch started (also with `changes/`), and removed and created again;
- at creation, and again when the tree watcher is ready, an existing archive directory opens it (the initial scan
  reports nothing under `ignoreInitial`).

Every path that closes an `openspec/`'s watcher today closes both: a worktree leaving the list, `releaseFolder`, and
`dispose`.

Rejected: rebuilding the archive watcher on its own events about its directory, plus at each scan while the
directory was missing. It ran into the native watch left open above, and it added a scan-time rule.

## Risks / Trade-offs

- [An edit inside an archived change is not seen until another change is] → accepted (proposal, What Changes).
  What it can leave stale is an archived change's content or task count, never which changes exist.
- [An archived change added between the archive directory appearing and its watcher being ready is missed until
  the next change that is seen] → same class as the risk above; the directory appearing is itself a change seen, so
  the side panel reads again then.
