## 1. The protocol shapes (design D1, D2, D3)

- [x] 1.1 `src/main/remote-openspec.ts`: pure mapping functions from `OpenSpecService`'s views to the four
      results, copying each field by name and keeping today's names (D1's list): `Change`, the change detail with
      artifacts sorted by core's `sortArtifacts(…, 'schema', schemaOrder)` from `@spekjs/core/artifact-order`,
      `Artifact` by kind (tasks as the parsed list only), the spec list, the spec detail, and a change's `worktree`
      / a spec's `origin` as `{ branch, isMain }` only when the view has one. Verify with `remote-openspec.test.ts`:
  - each result's key set is exactly the documented one, from views carrying extra fields (an unknown core field,
    `relPath`, an absolute path, `key`, `vcs`, `isFolderRoot`, `missingArtifacts`, `relatedChanges`);
  - artifacts come out in a `schemaOrder` that differs from both the input order and `DEFAULT_ORDER`;
  - a tasks artifact has `tasks` and no `content`;
  - `worktree` / `origin` is absent when the view has none, and `{ branch, isMain }` when it has one.
- [x] 1.2 `src/main/remote-host.ts`: the four `openspec*` methods return the mapped results; `openspecCall` answers
      `READ_FAILED` with a fixed `INTERNAL` message and logs the original with `console.error`. Verify in
      `remote-host.test.ts`: the existing `NOT_FOUND` case still passes; an extra field on the service's view does
      not reach the answer; a `READ_FAILED` whose message holds an absolute path answers `INTERNAL` without it.

## 2. The answer bound (design D4)

- [x] 2.1 `src/main/remote-frames.ts`: export the 1 MiB frame cap; `remote-server.ts` uses it for `maxPayload`
      instead of its own `MAX_PAYLOAD`. Verify with `npm run typecheck` and the existing `remote-server.test.ts`.
- [x] 2.2 `src/main/remote-openspec.ts`: the bound — the cap less a 4 KiB reserve, measured as UTF-8 bytes of the
      serialized result. A change or spec over it has its largest content piece (an artifact's `content` or
      `tasks`, a delta's `content`, the spec's `content`) replaced by `omitted: { bytes }` — `bytes` being the
      piece's serialized UTF-8 size — counting each saving exactly and measuring the result again at the end,
      until it fits, ties in display order; still over with every piece left out,
      or a change or spec list over it, is a `TOO_LARGE` error with `detail.limit`. Verify in
      `remote-openspec.test.ts`:
  - one over-size artifact is omitted with its size and the others keep their content;
  - several medium pieces whose sum is over the bound are omitted largest first until the result fits, the same
    way on every run, and an omitted delta is `{ topic, omitted }`;
  - a result within the bound is unchanged;
  - an over-size list, and a change still over the bound with everything omitted, throw `TOO_LARGE` with the limit;
  - a change of many small pieces fits after omission, because each saving is counted exactly.

## 3. The folder watch and its event (design D5)

- [x] 3.1 `RemoteHost` (`src/main/remote-protocol.ts`) gains `openspecWatch(folderId)`; `src/main/remote-host.ts`
      implements it by having the host's `OpenSpecService` scan the folder, answering only when the scan is done,
      through `openspecCall` (`UNKNOWN_FOLDER` → `NOT_FOUND`, `READ_FAILED` → the fixed `INTERNAL` message). Verify
      in `remote-host.test.ts`: an unknown folder answers `NOT_FOUND`; a failed scan answers `INTERNAL` without its
      message; the answer does not resolve before the scan does.
- [x] 3.2 `src/main/remote-protocol.ts`: `openspec.watch { folderId? }` → `{}` in `OPERATIONS`; the connection's
      state holds at most one watched folder, recorded only after the host succeeded, replaced by a new watch,
      cleared by a watch whose `folderId` is absent or `null` and when the connection ends; any other non-string
      `folderId` is `BAD_PARAMS`. The handler exposes whether a connection watches a given folder. Verify in
      `remote-protocol.test.ts`: replace, stop, an unknown folder not recorded, `BAD_PARAMS`, and the operation in
      the authentication answer's `operations`.
- [x] 3.3 `src/main/remote-service.ts`: a method that announces a folder's OpenSpec change as
      `openspec.changed { folderId }` to the authenticated connections watching that folder — a timer per folder
      (one second, injectable like `reconcileMs`), started by the first change after a quiet period and only when
      some connection watches the folder, absorbing changes while it runs, sending one event when it fires; a
      method that cancels a folder's timer; all timers cleared when the service stops. Verify in
      `remote-service.test.ts` with a short interval:
  - a burst shorter than the interval yields exactly one event, after the last change;
  - a stream of changes longer than the interval yields one event per interval and one after the last change;
  - two folders do not throttle each other;
  - a connection watching another folder, or none, receives nothing, and one that moved from F to G receives
    nothing for F;
  - a folder cancelled while its timer runs produces no event.
- [x] 3.4 `src/main/index.ts`: the remote host's `OpenSpecService` gets the announce method as its change callback
      instead of the no-op; on every folder-store change, the ids missing from the previous set are released from
      that service (`releaseFolder`) and cancelled in the remote service. Verify with `npm run typecheck`, the unit
      case in 3.3, and the probe in 5.1.

## 4. The protocol document (design D1–D7)

- [x] 4.1 `docs/remote-protocol.md`:
  - section 2: OpenSpec answers stay within the 1 MiB cap; other answers are not bounded by it;
  - section 4: `openspec.watch` joins the list of operations an older desktop does not have;
  - section 5: the four operations' results field by field — `Change`, `Artifact` by kind, `worktree` / `origin` and
    when they are absent, display order, `timestamp` (first commit of the change's directory; `null` when it has
    none or was first committed after the desktop started; not updated while the desktop runs) and the list order
    it produces (one key, `timestamp` or else the slug's date, newest first as a string comparison, changes with
    neither last), and that an archived change's `timestamp` is its archiving commit, so `createdDate` is the start
    date where present, `omitted`, `TOO_LARGE`; that a
    desktop not listing `openspec.watch` may send more fields, artifacts in another order and no events, and that
    the same parser reads both;
  - section 5, `openspec.watch`: parameters (`folderId` absent or `null` stops, other non-strings are
    `BAD_PARAMS`), replacement, `NOT_FOUND`, watch before reading, and the `openspec.changed` event with its throttle
    and the advice to read again on every event, described inside that section — **not** under a `` ### `openspec.changed` `` heading, which
    `scripts/remote-protocol-doc.test.mjs` would read as an operation;
  - section 3's error table: `TOO_LARGE` also covers an OpenSpec answer over the cap;
  - section 9: the OpenSpec content obligation (D6).
  Verify `scripts/remote-protocol-doc.test.mjs` passes with `openspec.watch` documented.

## 5. Acceptance

- [x] 5.1 `scripts/probe-remote.mjs` `runOpenSpec`, with its own git fixture rather than the shared `makeRepos()`: a
      folder whose repository has a linked worktree outside the folder holding an active spec-driven change
      (proposal, design, a delta spec, `tasks.md`) whose files' mtimes are set (`utimesSync`) in the reverse of
      display order, and a second, single-worktree folder. Verify with `npm run probe:remote`:
  - prerequisite: a change is listed with `worktree.isMain === false` (core silently stops aggregating when the
    worktree is missing);
  - the four results' key sets;
  - the worktree's change is labeled with the worktree's branch and read by slug with the worktree's content;
  - its artifacts arrive in display order (proposal, design, specs, tasks);
  - the single-worktree folder's changes carry no `worktree`;
  - no string other than `content`, task `text` and section `title` contains the folder's path, the worktree's path,
    the stub home or the real `HOME`;
  - after `openspec.watch`, a write of the change's `tasks.md` in the worktree, repeated with `retryAction` until
    `openspec.changed` for that folder arrives (the watchers become ready a moment after creation; no fixed delay),
    and a re-read shows the new task;
  - the existing "a path-shaped identifier is not found" check stays.
- [x] 5.2 Control groups for 5.1, run once by hand and recorded in the probe's comments, each turning its check red:
      the pass-through host (key sets); no `sortArtifacts` (display order); the fixture without its worktree
      (prerequisite); the change callback left a no-op (event).
- [x] 5.3 `scripts/scenario-coverage.test.mjs`: register `remote-openspec-browse` in `COVERED_CHANGES` and give each
      new scenario of its delta a row with its carrier, `greenIfAbsent` and `mutation`. The two carried-over
      scenarios keep their rows; "Reading a change's artifacts" moves its carrier to 5.1's display-order assertion
      (its THEN now names the order), with the old carrier noted and the mutation "no `sortArtifacts`". Verify
      `npm test` passes.

## 6. Verification

- [x] 6.1 `npm run typecheck`, `npm run lint`, `npm test`.
- [x] 6.2 `npm run probe:remote`, complete run. (159/160: the one red is the known intermittent #84 in `runListener`,
      green 10/10 when run alone.)
