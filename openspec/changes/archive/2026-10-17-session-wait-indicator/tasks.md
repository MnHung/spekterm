## 1. The attention state and its ranking (design D3)

- [x] 1.1 `src/shared/wait/attention.ts`: `attentionOf({ wait, inTurn, seen, choiceTypedOver })` and
      `mostUrgent(states)` in the spec's order. Verify with `src/shared/wait/attention.test.ts`:
  - each wait value with `seen` true and false;
  - `awaiting-choice` is `choice` whatever `seen` says, and a typed-over choice reads as the `ready` row;
  - `busy` is `working` only with `inTurn`, and `busy` without `inTurn` reads as the `ready` row;
  - `unknown` is `unknown`;
  - the ranking puts choice/waiting over error over working over running over idle over dormant/ended, and an empty
    list gives `null`;
  - control: with `inTurn` ignored for `busy`, the late-subagent case goes red.

## 2. The seen mark and "looked at" (design D1, D2)

- [x] 2.0 `src/main/agent-events.ts` `drainEvents` and `src/main/agent-wait.ts` `WaitSnapshot`: `sessionStarted` — the
      batch held a `SessionStart` whose source is not `compact`. Verify in `agent-events.test.ts`: true for `startup`,
      `resume` and `clear`; false for `compact` and for a batch with none.

- [x] 2.1 `src/main/wait-seen.ts`: `SeenMarks` with `onBatch`, `lookedAt`, `forget`, `seenOf`, an injected
      `isLookedAt`, and the per-session `wasInTurn`. Verify with `src/main/wait-seen.test.ts`. Snapshots are built
      through `drainEvents` from event fixtures where a case depends on the drain.
  - `Stop` after a prompt while not looked at → unseen; while looked at → seen;
  - a failed turn (`StopFailure`) after a prompt → unseen;
  - a start or resume (`SessionStart` only) → seen;
  - a late subagent `PreToolUse` after an unseen turn end → still unseen;
  - an automatic compaction in a turn (`busy` → `ready` with `inTurn`) → no mark;
  - the user's `/compact` (keystroke turn, then `SessionStart(compact)`) while not looked at → unseen;
  - a `poke` snapshot changes nothing to the mark but records `wasInTurn` (a device dismissal followed by a quiet
    tick is not a turn end);
  - a wake: stale keystroke (`inTurn: true` while `unknown`), then `SessionStart(resume)` → seen;
  - a user's `/clear` (keystroke turn, `SessionEnd`, `SessionStart(clear)`) while not looked at → seen;
  - a `!cmd` (keystroke and `Stop` in one batch) while not looked at → unseen;
  - a new turn in progress clears the mark, and the next unseen turn end sets it again;
  - `lookedAt` clears it and reports the change once; `forget` drops it;
  - controls: the turn-end test reduced to `turnEnded` alone turns the `/compact` case red; `!inTurn` removed turns
    the compaction case red; the `sessionStarted` exception removed turns the wake case red.
- [x] 2.2 `src/main/hibernation.ts`: `conversationWatched(sessionId)`, which counts only `:conversation` watch keys,
      exported through `src/main/ipc/terminal.ts` beside `displayedSessionOf`. Verify in `hibernation.test.ts`:
      true while a conversation key holds the session; false for a terminal key holding it; false after the
      conversation key moves away.
- [x] 2.3 `src/main/looked-at.ts`: `displayedInFocus` and `isLookedAt` with an injected focused-window source and
      displayed source, plus the three wiring points (a displayed report from the focused window, a window `focus`,
      and a conversation watch) that call `lookedAt`. Verify with `src/main/looked-at.test.ts`:
  - a displayed report from an unfocused window does not clear the mark;
  - focusing that window then clears it;
  - a conversation watch clears it and a terminal watch does not;
  - control: with the focus condition removed, the first case goes red.
- [x] 2.4 `src/main/index.ts` and `src/main/ipc/terminal.ts`: `AttentionLog` takes `displayedInFocus` from
      `looked-at.ts`. The window's `focus` event, the `displayed` IPC handler and `setRemoteWatched` call the wiring
      from 2.3 (through `onDisplayedReport` / `onRemoteWatch` listeners, so `ipc/terminal.ts` does not import the
      mark). The `observeWaits` observer calls `onBatch` before the projection (3.1). Every pty change drops the
      marks of sessions that no longer run (`SeenMarks.retain`) — the one signal every `forgetRequests` /
      `clearWait` site already raises. Verify with `npm run typecheck`, `npm test`, and the
      unchanged `suppressed` assertion of `probe:remote` (6.2).

## 3. The projection (design D4, D6)

- [x] 3.1 `src/main/ipc/wait.ts` (the pure projection and broadcaster in `src/main/wait-attention.ts`): `workspace:wait:list` and `workspace:wait:changed`, carrying
      `{ sessionId, attention }[]` for every running agent session. `choiceTypedOver` is computed from `requests`
      and `lastKeystrokeAt`. `broadcastAttention()` sends only when the projection differs from the last one sent.
      It is called from the `observeWaits` observer after `onBatch`, from a `lookedAt` that changed something, on a
      poke and on `onPtyChange`. A change also calls `remoteService.listChanged('sessions')`; when a changed session
      has a lineage it runs the `onCompletionChange` path (`refreshAllRelations`, `broadcastLifecycle`,
      `listChanged('handoffs')`, `listChanged('sessions')`). Register it in `index.ts`. Verify with
      `src/main/wait-attention.test.ts` (pure projection and dedup with injected sources):
  - identical consecutive projections send once;
  - a seen flip sends;
  - a session starting or ending sends;
  - a hibernated session has no entry;
  - a seen flip on a lineage session calls the relations refresh, and one on a session without lineage does not.
- [x] 3.2 `src/preload/index.ts`: `window.workspace.wait.list()` and `onChanged(listener)`, typed from the main
      module. Add `wait` and each of its members to the preload allow-list in `scripts/probe-shell.mjs`
      (`surplusApiKeys`). Verify with `npm run typecheck` and `npm run probe:shell`.
- [x] 3.3 `src/renderer/src/shell/terminal/wait.tsx`: `WaitProvider` and `useAttention()`, which subscribe first and
      then call `list()` once (the `LifecycleProvider` shape). Mount it beside `LifecycleProvider` in `AppShell.tsx`.
      Verify with `npm run typecheck` and the probes in 6.1.
- [x] 3.4 `src/shared/lineage/lifecycle.ts`: `lifecycleOf(completion, wait, seen)` per D6; `onWaitTick` is unchanged.
      `src/main/handoff-lifecycle-view.ts` passes `seenOf`. Verify with `lifecycle.test.ts`:
  - `working` for `busy` whatever `seen` says;
  - `waiting` for `awaiting-choice`, and for `ready` when not seen;
  - `idle` for `ready` when seen, and for `unknown`;
  - `done` regardless;
  - settling and reopening are unchanged by the mark.
- [x] 3.5 `scripts/probe-intake.mjs`: the lineage precondition at about line 3952 expects the child's state before its
      first turn ends — now `idle` for a just-started child, not `waiting`; update it to the D6 value and keep the
      assertion's discrimination (it must still fail if the lifecycle is missing). The `fire PreToolUse` assertion at
      about line 2057 stays `working` (raw `busy`, D6) and is re-run unchanged. Add a step: after a child's unseen turn
      end shows `waiting`, displaying it makes the parent's list show no state for it and the relations file says
      `idle` (the new `handoff-completion` scenario). Verify with `npm run probe:intake`.

## 4. The dots and tooltips (design D5, D7)

- [x] 4.1 `src/renderer/src/shell/terminal/session-badge.tsx`: `StatusDot` takes the attention of a running agent
      session and draws the D5 table, with the pulse suppressed under `prefers-reduced-motion`. `statusTitle` adds the
      attention words. Replace the comment that defers waiting/running to "a later phase". `SessionTabs.tsx` and
      `WorkspaceRail.tsx` pass the attention. Verify with `npm run typecheck`, `npm run lint` and `npm test`
      (`aria-label-source`, `typography`, `copy-language`).
- [x] 4.2 `src/renderer/src/shell/WorkspaceRail.tsx`: the rail item dot after the session count on folder rows and on
      the global item's row. It is ranked by `mostUrgent`, absent for an item with no session, and `aria-hidden`. Its
      state goes into the row's `title`; the row's `aria-label` does not change. Verify with the probe in 6.1.
- [x] 4.3 `src/shared/i18n/en.json` and `zh-TW.json`: the attention words for `statusTitle` and the rail row's
      most-urgent words. Verify with `npm test` (`dictionary-completeness`, `i18n-key-safety`).

## 5. The protocol (design D8)

- [x] 5.1 `src/main/remote-host.ts` `sessionList` and the `SessionView` type in `src/main/remote-protocol.ts`: add
      `seen` on agent sessions whose wait is `ready`, absent otherwise. Verify in `remote-host.test.ts`:
  - present and false after an unseen turn end;
  - true after `lookedAt`;
  - true for a just-started agent;
  - absent for a busy agent and for a shell.
- [x] 5.2 `docs/remote-protocol.md` §`sessions.list`: document `seen`:
  - present (true/false) exactly while `wait` is `"ready"`;
  - false again at every unseen turn end;
  - what counts as looking (a focused desktop display, a device's conversation watch, not a terminal watch);
  - a missing `seen` on a ready session means an older desktop;
  - the `lifecycle` `waiting` value follows it.
  Verify with `npm test` (`remote-protocol-doc.test.mjs` unchanged and green).

## 6. Acceptance

- [x] 6.1 `scripts/lib/stub-agent.mjs`: an option to start without the startup `Stop` (a real agent reports
      `SessionStart` only). `scripts/probe-agent-view.mjs`: a new section that, like `runAttention` in
      `probe-remote.mjs`, checks `document.hasFocus()` first and records a gap instead of asserting the focus-dependent
      steps when there is no focus. Three stub sessions in folder F (A, B, C, with the new option), plus a shell
      session in F and a folder G with no session:
  - baseline: A, B and C state "idle" (the "started session" scenario);
  - B is displayed while A finishes a turn → A's rail row and tab titles state "waiting for you", and F's row title
    states "waiting for you";
  - C is given a turn that keeps working → F's row still states "waiting for you";
  - collapse F → its row title is unchanged;
  - A fires a late subagent `PreToolUse` → still "waiting for you";
  - display A → "idle";
  - B (displayed, focused) finishes a turn → working, then idle, with no "waiting" title seen in between;
  - A, displayed, asks for permission → "asks for a choice"; the probe types a key into A → the choice no longer
    shows;
  - after A has been seen, a new turn ends while B is displayed → "waiting for you" again;
  - a stub session with event reporting off → "Running" with no attention words;
  - the shell session → "Running" with no attention words;
  - G's row title names no state.
  Controls:
  - with `lookedAt` disabled, the "display A → idle" assertion goes red;
  - with `mostUrgent` order reversed, F's assertion goes red;
  - with the stub's startup `Stop` restored, the baseline goes red.
- [x] 6.2 `scripts/probe-remote.mjs`, a new section `runSeen` (stub started without the startup `Stop`, its start
      reported after a shell is displayed):
  - the baseline is `ready` with `seen: true`;
  - a turn while unwatched and not displayed is listed `ready` with `seen: false`;
  - a `terminal.watch` of it leaves `seen: false`;
  - a `conversation.watch` gives a list with `seen: true`, and the desktop's tab title for it states "idle";
  - a turn that ends during the watch is listed `seen: true` the first time it is `ready`;
  - a busy session and a shell carry no `seen`;
  - the existing `suppressed` assertion stays green;
  - control: with the startup `Stop` restored, the baseline goes red.
- [x] 6.3 `scripts/scenario-coverage.test.mjs`: add `session-wait-indicator` to `COVERED_CHANGES`, and add one row per
      **new** scenario (`session-wait-indicator` spec, the five new `remote-protocol` scenarios, the new
      `handoff-completion` scenario). The two carried-over remote-protocol scenarios and the unchanged
      handoff-completion ones already have rows. Each row has a carrier, `greenIfAbsent` and a mutation. The
      handoff scenario's carrier is `lifecycle.test.ts` plus a `probe:intake` lineage assertion if one fits. A
      scenario whose carrier needs focus names the gap path. Verify with `npm test`.
- [x] 6.4 Run `npm run typecheck`, `npm run lint` and `npm test`. Then run `npm run probe:agent-view`,
      `npm run probe:remote`, `npm run probe:shell`, `npm run probe:intake` (handoff lifecycle),
      `npm run probe:keyboard` (rail rows) and `npm run probe:terminal` (tabs).

## 7. Documentation

- [x] 7.1 `site/src/content/docs/docs/using/terminals-and-sessions.md` and its `zh-tw` twin: the session dots and the
      rail item dot, what each state means, and that turning to a session (or opening it on the phone) clears
      "waiting for you". `site/src/content/docs/docs/using/handoffs.md` and its `zh-tw` twin: "Waiting for you" on a
      handoff follows the same rule.
- [x] 7.2 `docs/lessons/transcript.md`: an interrupted turn leaves the dot on "working" (no event). A denied prompt is
      read from the keystroke. A late subagent tool start is not a turn.
- [x] 7.3 `CLAUDE.md` "現況": one line under the agent conversation view bullet saying that the dots show working /
      waiting / idle from the hooks, and that the seen mark is owned by the main process and shared with the phone and
      the handoff lifecycle.
