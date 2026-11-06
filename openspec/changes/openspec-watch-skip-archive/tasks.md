# Tasks

## 1. Watch

- [ ] 1.1 `src/main/watcher.ts`: an optional `ignored` predicate passed through to chokidar, and the creation-point
  table gains the archive watcher; `src/main/watcher.test.ts` covers the pass-through (control: drop it ⇒ red);
  `npm test` green
- [ ] 1.2 `src/main/openspec-service.ts`: each `openspec/` (base layer and worktree layer) gets the tree and archive
  watchers of design D1, the archive watcher rebuilt per D2, both closed on every close path of D2; unit tests in
  `src/main/openspec-service.test.ts` for the four new scenarios of `specs/openspec-data-access/spec.md`, a
  removed-and-recreated archive, a missing `changes/`, and a departed worktree whose archive gets a new directory;
  the created-later and recreated tests read no structure between their steps, so only the event trigger can pass
  them. Controls, run and recorded in the commit message: no `ignored` ⇒ the edit-inside test red; no archive
  watcher ⇒ the arriving-on-its-own test red; no event-triggered rebuild ⇒ the created-later and recreated tests
  red; no scan-time rebuild ⇒ the missing-`changes/` test red; archive watcher left open when a worktree leaves ⇒
  the departed-worktree test red
- [ ] 1.3 Register `openspec-watch-skip-archive` in `scripts/scenario-coverage.test.mjs` with one row per scenario
  of both deltas; `node --test scripts/scenario-coverage.test.mjs` green

## 2. Verification

- [ ] 2.1 `npm test`, `npm run typecheck`, `npm run lint` green
- [ ] 2.2 `npm run probe:openspec` green on Linux (it needs `xvfb-run`, so it is run by a maintainer on Linux, not on
  the authoring Mac)
- [ ] 2.3 On macOS, the watcher-level measurement of design Context repeated against a real repository with a large
  archive: descriptors before and after, reported in the PR
- [ ] 2.4 Docs: `docs/lessons/side-panel.md` one line that archived change contents are not watched and why;
  `site/src/content/docs/docs/using/side-panel.md` and its `zh-tw` copy name the exception to "updates as files
  change"; `docs/remote-protocol.md` `openspec.watch` names it; `(cd site && npm run build)` passes;
  `openspec validate openspec-watch-skip-archive --strict` passes

## Review

Spec gate (one Claude reviewer, single track):
- [S1] retained scenarios' WHEN covered files inside an archived change, contradicting the new one → fix: narrowed to outside an archived change; a spec text correction, no mechanism
- [S2] `worktree-aggregation` stated every worktree file is watched and was not declared → fix: MODIFIED delta pointing at `openspec-data-access`
- [S3] website side panel page and `docs/remote-protocol.md` `openspec.watch` would overstate → fix: task 2.4 and proposal Impact
- [S4] the worktree-leaves-the-list close path was not named for the second watcher → fix: design D2 lists every close path; task 1.2 test and control
- [S5] only one of D2's rebuild triggers had a control → fix: task 1.2 names a test and a control per trigger
- [S6] task 2.2 told to stay unchecked, which blocks archive → fix: assigned to a maintainer on Linux
- Gate: converged — every finding ruled (six spec/plan text fixes, no new mechanism), regrounded against the files.
