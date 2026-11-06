# Tasks

## 1. Watch

- [ ] 1.1 `src/main/watcher.ts`: an optional `ignored` predicate passed through to chokidar, and the creation-point
  table gains the archive watcher; `src/main/watcher.test.ts` covers the pass-through (control: drop it ⇒ red);
  `npm test` green
- [ ] 1.2 `src/main/openspec-service.ts`: each `openspec/` (base layer and worktree layer) gets the tree and archive
  watchers of design D1, the archive watcher rebuilt per D2, both closed by `releaseFolder`; unit tests in
  `src/main/openspec-service.test.ts` for the four new scenarios of `specs/openspec-data-access/spec.md`, plus a
  removed-and-recreated archive and a missing `changes/`; controls run and recorded in the commit message: no
  `ignored` ⇒ the edit-inside test red; no archive watcher ⇒ the arriving-on-its-own test red; no D2 rebuild ⇒ the
  created-later test red
- [ ] 1.3 Register `openspec-watch-skip-archive` in `scripts/scenario-coverage.test.mjs` with one row per scenario
  of the delta; `node --test scripts/scenario-coverage.test.mjs` green

## 2. Verification

- [ ] 2.1 `npm test`, `npm run typecheck`, `npm run lint` green
- [ ] 2.2 `npm run probe:openspec` green on Linux (the probe needs `xvfb-run`; not runnable on the authoring Mac — if
  no Linux run is available, leave this unchecked and say so in the PR)
- [ ] 2.3 On macOS, the watcher-level measurement of design Context repeated against a real repository with a large
  archive: descriptors before and after, reported in the PR
- [ ] 2.4 `docs/lessons/side-panel.md`: one line that archived change contents are not watched and why, pointing at
  this change; `openspec validate openspec-watch-skip-archive --strict` passes
