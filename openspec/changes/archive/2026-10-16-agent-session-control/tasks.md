## 1. Ancestry

- [x] 1.1 `src/shared/lineage/types.ts`: `SessionLineage.ancestors?: string[]` (ids above the parent, nearest first). Add a pure `ancestryOf(id, byId)` in `src/shared/lineage/` (design D4): parent first; append a recorded chain and stop; otherwise walk existing records; stop on a missing record, a repeated id, or `MAX_ANCESTRY` = 64. Unit tests cover each stop and a corrupt cycle
- [x] 1.2 `src/main/session-store.ts` `parseLineage`: read `ancestors` as an array of UUIDs, capped at `MAX_ANCESTRY`; an invalid value drops only that field. Tests: valid, an invalid element, not an array, over the cap — each keeps `parentId` / `origin` / `brief`. A test pins that a replace from the renderer cannot change `ancestors`
- [x] 1.3 `src/main/intake-schema.ts`: `HandoffSource.ancestors?` with the same validation in `parseHandoffSource`; tests for valid and invalid values
- [x] 1.4 `src/main/handoff-service.ts`: `HandoffSource` from `sourceOf` carries the source's ancestry; `lineageSourceOf` puts it into `verified.source`. In `src/main/index.ts`, `sourceOf` computes it with `ancestryOf` over the session store. Tests in `handoff-service.test.ts`: a source with a chain, a source without one (derived), a gone source (no chain)
- [x] 1.5 `src/main/handoff-ticket.ts` `ticketResolutionFor`: copy `verified.source.ancestors` into the lineage; a test that a chain taken at ingestion survives the parent's record being gone at creation
- [x] 1.6 Confirm the renderer neither reads nor writes `ancestors`, and that `session-forest.ts` stays on `parentId`; record the result in a comment at the type

## 2. Relations tree

- [x] 2.1 `src/main/handoff-relations.ts`: each child entry gains `children` (recursive), built from `ancestryOf` over the full session view; existence only filters which sessions are listed. A descendant hangs under its nearest existing ancestor in the subtree; a direct parent that does not exist adds `"parentGone": true` (design D5). The parent and siblings are unchanged
- [x] 2.2 `handoff-relations.test.ts`:
  - grandchild under child;
  - orphan under self with `parentGone`, both for a closed parent and for one whose folder left the workspace;
  - a sibling's descendant absent from the sibling's entry;
  - a descendant whose folder left the workspace is absent;
  - no id or path field anywhere in the tree (extend the existing field check to recurse)

## 3. Turn tracking

- [x] 3.1 `src/main/agent-events.ts`: add `PreCompact` to `HOOKED_EVENTS` and parse its `trigger`; in `apply`, `PreCompact` changes neither the base state nor the requests. Fold the time of the last turn end (the "ends the turn" rows of the design D3 table; `background_tasks` absent or listing no running subagent counts as none) and whether an own `UserPromptSubmit` followed it. In `src/main/agent-wait.ts`, combine it with `lastKeystrokeAt` into `inTurn`. `dismissRequest` of the own prompt is a turn end, and the process ending resets. Expose `inTurn` on `WaitSnapshot` and through an accessor
- [x] 3.2 `agent-events.test.ts` and `agent-wait.test.ts`: one test per row of the D3 table. They include:
  - a keystroke after `Stop` with no event (a `!cmd`) puts the session in a turn until the next `Stop`;
  - `Notification(idle_prompt)` and a subagent `PreToolUse` after `Stop` leave it at rest;
  - an own `PreToolUse` alone does not start a turn;
  - `SessionStart(compact)` mid-turn leaves it in the turn;
  - `Stop` with a running background subagent leaves it in the turn, and the later `Stop` with none ends it;
  - a background task of `type: "shell"` does not hold the turn;
  - `PreCompact(manual)` then `SessionStart(compact)` ends a keystroke-started turn; `PreCompact(auto)` then `SessionStart(compact)` does not; `PreCompact` leaves the base state unchanged;
  - xterm's answers to DA1, XTVERSION and the kitty keyboard query are terminal reports (`pty-input.test.ts`), and a keystroke still is not
  - `dismissRequest` of the own prompt ends the turn, and of a subagent's prompt does not;
  - a fresh session with no events is at rest
- [x] 3.3 Measure with a real `claude` (CLI version recorded) and add the rows to `docs/lessons/transcript.md`'s event table:
  - whether `SessionStart(compact)` can arrive inside a turn;
  - what a manual `/compact` and a long `!cmd` report;
  - whether `idle_prompt` follows an ordinary `Stop` and an Esc interruption, and after how long;
  - what `background_tasks` lists for a background shell (its `type`);
  - which pty writes that are not the user's reach `noteWrite` during a turn and while idle;
  - re-confirm the two Esc rows.

  Set the shell-type filter of 3.1 from the result. Add any reply sequences found to `isTerminalReport` (`src/main/pty-input.ts`) with tests

## 4. Commands

- [x] 4.1 `src/main/handoff-delivery.ts`: `outboxKindOf` returns `close` / `hibernate` / `rename`. Add a command parser:
  - `target` optional; present but not a non-empty string → `FIELD_TYPE`;
  - `name` required for rename (`FIELD_TYPE` when missing), flattened by `sourceTitle`'s rule, over `MAX_FIELD_LENGTH` → `TOO_LONG`.

  Tests per field and per kind, including a two-line name. An unknown kind still yields `unknown`
- [x] 4.2 `src/main/intake-schema.ts` `IntakeRejection`: `CONTROL_TARGET_NOT_FOUND`, `CONTROL_NOT_ALLOWED`, `CONTROL_FAILED`, `CONTROL_NO_WINDOW`, `CONTROL_UNAVAILABLE`. In `src/main/intake-rejection.ts`, `isPermanentRejection` marks the first three permanent and the last two temporary (design D6 table), with a test that a temporary one leaves a trace and no notification. Add each reason to `src/shared/i18n/en.json` and `zh-TW.json`
- [x] 4.3 `FailureContext.subject?: 'command'` (`src/main/intake-service.ts`), carried through `DeliverOutcome.failure` to `reportFailure`, not persisted with the trace. `src/main/intake-notify.ts`: a single failure with `subject: 'command'` gets title "Session command" and body "A session command could not be carried out: {{reason}}" (new dictionary keys, both languages); a merged notification keeps its text. Tests in `intake-notify.test.ts` and `intake-service.test.ts`
- [x] 4.4 `src/main/intake-source.ts`: `deliver(contents, file, state)` receives the stat `readBounded` took; existing adapters ignore it. Test that the passed mtime is the read's
- [x] 4.5 `src/main/session-runs.ts` (new, process-wide, the `pty-input.ts` pattern): per-session time of the last process start and end, with whether this module caused the end, and the run's start time. `TerminalService` records every start (heal included) and every exit reason (`disposed` included). Tests: survives a new `TerminalService` instance; each exit reason recorded
- [x] 4.6 New `src/main/session-control.ts` (Electron-free, deps injected, design D6):
  - resolve and authorize (design D2): targets among existing sessions, ancestry over the full view, the gone-source rules;
  - rename at once;
  - dormant hibernate → nothing; dormant close → at once;
  - running target:
    - refuse `CONTROL_UNAVAILABLE` with agent events off;
    - otherwise `refreshWait`, then act if not `inTurn`, or hold pending until the first drain after which it is not;
  - `deliver` returns before any request to the window completes; the request runs asynchronously;
  - one pending per target, last wins. It is dropped without a notice:
    - on a keystroke into the target (`onKeystroke`);
    - when the target's process ends otherwise;
  - the staleness rule (design D11): drop a close or hibernate written before the target's last process start or end in this run (ends this module caused excluded), or before this run, or with no mtime;
  - identity deduplication;
  - `failure.origin` = the source's rail item and label, `failure.target` = the target as written;
  - a failed request to the window: `NOT_FOUND` / `CREATE_FAILED` → `CONTROL_FAILED`, `NO_WINDOW` / `TIMEOUT` → `CONTROL_NO_WINDOW`. Every failure goes through `service.reject`, and permanent ones also through `service.reportFailure`;
  - hold every request behind the per-window restore gate (design D9), at most 60 s, and decide a queued request again when released
- [x] 4.7 `session-control.test.ts`: one test per branch of 4.6, by injected facts. Include:
  - self reached by omitted target and by own name;
  - a grandchild through a closed intermediate;
  - parent, sibling, unrelated, and hidden-folder targets refused;
  - gone source + own name → silent; gone source + descendant → carried out; gone source + unknown name → silent;
  - a permission prompt, then a device answer, then the turn's end acts once, at the end (this test stands for the device-answer case; a desktop answer is a keystroke);
  - `idle_prompt` and a stray subagent `PreToolUse` after `Stop` do not stop an at-rest close from acting at once;
  - compaction does not act;
  - background-subagent `Stop` does not act, and the later `Stop` does;
  - a keystroke drops the pending command, and a later rest does not revive it;
  - a hibernate replaced by a close;
  - a pending command dropped by the process ending;
  - a duplicate identity acted on once;
  - a field claiming another source has no effect;
  - an empty name is sent as an empty rename;
  - a deferred failure reaches both `reject` and `reportFailure`;
  - a request before restore waits and then succeeds; a reload closes the gate again; a gate that never opens fails after 60 s as `CONTROL_NO_WINDOW`; a close queued across a reload is dropped;
  - a self-close written before the session's hibernation, one written before this run, and one with no mtime are dropped; one written after a wake acts;
  - hibernate then close on the same idle child, written close together, ends in a close;
  - `deliver` has returned while the window request is still unresolved;
  - a close of a fresh child with no events runs at once, and the first-prompt write that follows is a safe no-op (assert in `intake-prefill` / `ipc/intake` tests that writing to a gone pty does not throw)
- [x] 4.8 `src/main/handoff-service.ts` `deliverFile`: route the three kinds to an injected `control`, passing the read's mtime; with none, refuse them as today's unknown kind. Test in `handoff-service.test.ts`
- [x] 4.9 `src/main/index.ts`: build `SessionControl` with:
  - the session store with existence;
  - the terminal service's pty check;
  - the wait functions and `onKeystroke`;
  - `agentEventsEnabled`;
  - `request` bound to `requestRenderer` on `liveWindow()`; no window → `CONTROL_FAILED` / `NO_WINDOW`;
  - the restore gate per webContents: opened when the persist IPC is received (before its debounce, `ipc/terminal.ts`), closed on `did-navigate` and `destroyed`;
  - `session-runs.ts`.

  Drop a target's pending command when its pty ends, from `onPtyChange` (where completion untracks)
- [x] 4.10 `src/renderer/src/shell/remote/RemoteRequests.tsx`: update the header comment to say it also carries out agents' session commands. No behavior change

## 5. Introduction

- [x] 5.1 `src/main/handoff-intro.ts`: a session-commands section for every agent session (design D8), with the name limit from `MAX_FIELD_LENGTH`. Rewrite `peerLines` for the nested `children` and `parentGone`. In `handoff-intro.test.ts`, assert:
  - the section is present without `reportable`;
  - it states the omitted-target rule, the end-of-turn rule, the keystroke cancel, the no-reply rule and the relations-file outcome;
  - the limit equals the constant;
  - the relations paragraph mentions the nesting and `parentGone`
- [x] 5.2 Confirm `scripts/handoff-intro-source.test.mjs` still forbids the literal limit in `handoff-intro.ts`; extend it if the section uses another constant

## 6. Acceptance

- [x] 6.1 `scripts/lib/stub-agent.mjs`: a `control` helper next to `report` (stage + commit a command JSON into `$SPEKTERM_HANDOFF_DIR`)
- [x] 6.2 `scripts/probe-intake.mjs`, a section `runSessionControl` that seeds P → C → G by handoff with the stub agent. It asserts:
  - the stub's own close, written between `PreToolUse` and `Stop`, leaves its pty alive until `Stop` and closes the session after: pty gone (read through `/proc`, not the interface), record gone, rail row gone;
  - P hibernates G (at rest) at once, and G is dormant and still listed;
  - P closes busy C only after C's `Stop`;
  - a keystroke-started turn with no events (a stub `!cmd`: input, then only `Stop`) holds a close until that `Stop`;
  - with `firej Stop` listing a running background subagent, C is not closed, and is closed at the next `Stop` listing none;
  - with `firej SessionStart` of source `compact` mid-turn, C is not closed until its `Stop`;
  - a pending close on C is dropped by typing into C, and C survives its next `Stop`;
  - after C is closed, P's relations file lists G under P with `parentGone`, and P can still rename G;
  - C targeting P is refused: P still running, an inbox trace with C's label and P's name, a notification through the stub backend with the session-command text;
  - rename while busy changes the tab label at once;
  - the rail selection and the focused element are unchanged after each action on a non-displayed session; after closing the displayed one, no terminal or conversation input holds focus
- [x] 6.3 `scripts/intake-control-groups.mjs`: mutations for the section, each naming the assertion that must turn red:
  - act at once instead of waiting;
  - wait on `ready` instead of `inTurn`;
  - ignore keystrokes as turn starts;
  - ignore keystrokes;
  - authorize by `parentId` only;
  - drop the ancestry write;
  - ignore the staleness rule (the restart scenario's unit carrier must turn red).

  `quiet: false` is not among them: this section closes no displayed session, so it would not turn red. The quiet close is carried by `probe:remote` `runHibernateClose`, which drives the same `RemoteRequests` branch (recorded in the coverage table)
- [x] 6.4 `scripts/scenario-coverage.test.mjs`: register `agent-session-control` in `COVERED_CHANGES`, and add one row per scenario of the three delta specs with carrier, `greenIfAbsent` and `mutation`. Mark scenarios with no carrier as such, with the reason (for example, the restart drop of a pending command, and the real CLI's compaction timing)
- [x] 6.5 `npm test`, `npm run typecheck`, `npm run lint`, `npm run probe:intake` pass

## 7. Documentation

- [x] 7.1 `site/src/content/docs/docs/using/handoffs.md` and `site/src/content/docs/zh-tw/docs/using/handoffs.md`: asking an agent to close, hibernate or rename its session or the sessions it handed off, including the end-of-turn wait, typing to cancel, and the descendant tree. The website build passes (`cd site && npm ci && npm run build`)
- [x] 7.2 `docs/lessons/handoff.md`: a section on session commands. It covers:
  - `inTurn` and why neither `ready` nor `busyReason` is enough;
  - why a keystroke cancels;
  - why the ancestry is taken at ingestion;
  - why `CONTROL_UNAVAILABLE` is temporary and still consumed;
  - the staleness rule and why the drop point is not read at hibernation or quit
- [x] 7.3 `CLAUDE.md`, the handoff paragraph under "現況": one sentence on agent session commands and their reach (self and descendants)

## 8. The self-close offer (dogfood, design D12)

- [x] 8.1 `src/main/remote-protocol.ts` `HostAction`: `offer-close` and `withdraw-close`; `src/preload/index.ts` `narrowRemoteAction` passes them
- [x] 8.2 `src/main/session-control.ts`: a running self-close sends `offer-close` (no command end) and records the offer; a keystroke into an offered session sends `withdraw-close`; tests in `session-control.test.ts` (offered not closed, descendant still closed, hibernate self still hibernates, keystroke withdraws)
- [x] 8.3 `src/renderer/src/shell/terminal/sessions.tsx`: offered sessions as state with `offerClose` / `withdrawCloseOffer` / `closeOffered`, cleared on close, hibernate, exit and wake; `RemoteRequests.tsx` handles the two kinds
- [x] 8.4 `TerminalView.tsx` and `ConversationView.tsx`: the offer card (top-centred, transparent `pointer-events-none` backdrop, Close and Keep buttons, no focus); copy in `en.json` and `zh-TW.json`, labels from the dictionary
- [x] 8.5 `handoff-intro.ts`: the close of its own session is offered to the user; test
- [x] 8.6 `scripts/probe-intake.mjs` `runSessionControl`: the self-close shows the offer and keeps running past its `Stop`; the terminal content under it stays readable (the offer does not cover the hit-test point of the last line); Keep withdraws; a second self-close then Close closes it. A typing-withdraws step. Coverage rows for the new scenarios; a mutation that closes instead of offering
- [x] 8.7 Website handoff page (both languages), `docs/lessons/handoff.md`, CLAUDE.md sentence updated for the offer
