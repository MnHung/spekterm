# Proposal

## Why

Every OpenSpec watcher watches its whole `openspec/` tree, archived changes included, once per worktree. Archived
changes only accumulate, so the cost grows with a repository's history times its worktrees. In a workspace of a few
long-lived repositories with 28 worktrees this came to about 21,600 watched files and 8,700 directories, 84% of the
files under `changes/archive/`. On macOS that is one file descriptor per file plus an FSEvents watch per
directory: a sample of the main process showed it inside FSEvents handling for minutes after a session was opened, held about 28,000 file
descriptors, and then failed to spawn `git` (`EBADF`). On Linux the same tree spends `max_user_watches`, which some
machines still leave at 8192 (the website's troubleshooting page).

The side panel gains nothing from watching inside an archived change. An archived change is not edited, and
archiving one removes its directory from `changes/`, which stays watched. The original design named this as the
fallback if the full watch proved too costly (`openspec-side-panel` design, Risks, "chokidar 監看整個 `openspec/` 的成本").

## What Changes

- The contents of an archived change (`changes/archive/<name>/**`) are no longer watched, for the folder's own
  `openspec/` and every worktree's.
- `changes/archive/` itself is watched shallowly: an archived change directory being added or removed still makes
  the folder's OpenSpec structure count as changed, also when it arrives without an active change leaving
  `changes/` (a pull, a checkout).
- An edit inside an existing archived change is not seen until the next change that is seen. **This is a known,
  accepted gap**, not an oversight.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `openspec-data-access`: the cache-and-watch requirement says which part of each `openspec/` is watched and that
  archived change contents are not.

## Impact

- `src/main/openspec-service.ts` (how each `openspec/` is watched), `src/main/watcher.ts` (an `ignored` predicate
  passed through to chokidar).
- Both `OpenSpecService` instances benefit: the side panel's and the remote one's.
- No IPC, DTO, renderer, or dependency change.
