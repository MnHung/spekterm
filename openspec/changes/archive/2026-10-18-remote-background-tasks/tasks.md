## 1. Keep the tasks (`agent-events.ts`, `agent-wait.ts`)

- [x] 1.1 In `src/main/agent-events.ts`, add `BackgroundTask { id, kind: 'agent' | 'shell' | 'monitor' | 'other', label: string | null }`
  and parse `background_tasks` by white-list into `AgentEvent.backgroundTasks: BackgroundTask[] | null` for `Stop` and
  `SubagentStop` (`null` when the field is absent or not an array; `null` for every other event), following D2 and D4:
  in flight (status not `completed` / `failed` / `killed`), non-empty string `id`, first of a duplicate id, kind
  mapping (`subagent` / `local_agent` → agent), label from `description` then a shell's `command`, control characters
  and whitespace runs → one space, trimmed, clipped to 200. Keep `runningAgents` and `backgroundAgentRunning` as they
  are. Add the field to the `ev()` factory in `agent-events.test.ts` (a full `AgentEvent` literal). Verify with unit
  tests in `agent-events.test.ts`: the measured 2.1.302 payload (subagent with `description` and `agent_type`, shells
  with `description` and `command`, the Monitor's task as a `shell`) yields exactly `{ id, kind, label }` per task and
  no other key; a completed, a failed and a killed task, a task with no id and a repeated id are left out, a `pending`
  and a `paused` task are kept; an unknown `type` is `other`; a shell with only a two-line command containing an
  absolute path gets that command on one line; a label of 300 characters is clipped to 200; a task with neither field
  has `label: null`.
- [x] 1.2 Add `background: BackgroundTask[]` to `HeldWait` (empty in `heldWait()`, copied in `copyHeld`) and apply D2 in
  `apply()`: own `Stop` replaces (clears without the field); `SubagentStop` with the field replaces with the list minus
  the task whose id is its `agent_id`; nothing else touches it. Add `backgroundChanged: boolean` to `DrainResult` (the
  held list's JSON before and after the batch differ). Verify with unit tests: each row of D2's table, including
  `StopFailure`, `SessionStart` with each source (`startup`, `resume`, `clear`, `compact`), `UserPromptSubmit` and a
  `SubagentStop` without the field leaving it unchanged; the measured sequence of design Context steps 1–4 ends with
  the agent's copier and the subagent's Monitor listed, and the subagent and its `sleep 45` gone; `backgroundChanged`
  is true for a batch that changes the list or only its order, and false for an identical replacement.
- [x] 1.3 In `src/main/agent-wait.ts`, add `backgroundOf(sessionId): BackgroundTask[]` (a copy) and carry
  `backgroundChanged` in `WaitSnapshot` (`false` from `snapshotOf`). Verify with unit tests: `backgroundOf` follows a
  drained `Stop`; after `forgetRequests` it is empty; after `clearWait` it is empty. (A later drain is not
  modelled: the test rig folds its own `held`, not the module's.)

## 2. The session list (`remote-protocol.ts`, `remote-host.ts`, `index.ts`)

- [x] 2.1 Add `background?: BackgroundTask[]` (the same type, so `kind` is the union) to `SessionView`, set by
  `sessionList()` only for a `claude` session that is live and has a non-empty `backgroundOf` (D5). Verify with
  `remote-host.test.ts`: a live agent session with tasks carries them in order; a live one with none, a dormant one with
  tasks still held, and a shell carry no `background` key at all.
- [x] 2.2 In `src/main/index.ts`, make the `observeWaits` callback call `remoteService.listChanged('sessions')` when the
  state changed or `snapshot.backgroundChanged` (D6). Verify by the probe in 4.1 (the subagent-completion assertion),
  run once with this wiring removed to confirm it turns red there.

## 3. Documents

- [x] 3.1 `docs/remote-protocol.md` section 5, `sessions.list`: the `background` field — shape, present only for a
  running agent session with a task in flight, the agent's last report rather than the present moment (a task started
  in the current turn appears when it ends; a task whose end started the turn may still be listed during it), cleared
  when the process ends, the label rule, the `kind` values (a `Monitor` tool's task is a `shell`; `monitor` is another
  kind; a type such as the SDK's `workflow` is `other`) with "accept a kind you do not know" — and section 9, a new obligation: show a label as plain text, never as a
  link (a monitor's can hold a URL). Verify by `npm test` (`remote-protocol-doc.test.mjs` still green) and reading the
  section against D2–D5.
- [x] 3.2 `docs/lessons/transcript.md`: the 2.1.302 measurement (`type: "subagent"` with `description` and
  `agent_type`; a shell's `description` and `command`; a `Monitor` tool's task reported as `type: "shell"`, and
  `monitor` seen only for MCP-style subscriptions; `SubagentStop` carries the complete list and lists the stopping
  subagent; the list is session-wide; the SDK's per-process and in-flight statements and which of them were not
  observed; `/clear` with a background task running as a measurement still to make; how it was captured), and correct the earlier `background_tasks: [{ id, type, status }]` line. Verify by
  `npm test` (`public-hygiene.test.mjs`: no home path or private name in the capture description).
- [x] 3.3 The website's remote-access page, `site/src/content/docs/docs/using/remote-access.md` and its `zh-tw` twin:
  one paragraph saying the phone can show the background subagents and shells (the agent's monitors included) an agent
  session runs, as of the agent's last report. Verify by `(cd site && npm ci && npm run build)`.

## 4. Acceptance

- [x] 4.1 Add a `probe:remote` section `runBackground` acting as the phone, registered in the probe's `SECTIONS`: create
  an agent session S on the desktop, then with `fireEvent`:
  - a turn (`UserPromptSubmit`, `Stop` listing a subagent C, a shell with a description and a command, and a completed
    shell) → a `sessions.changed` **event** received after it in which S carries exactly C and the shell, labelled
    with the description;
  - `SubagentStop` for C listing C and the shell → an event in which S carries the shell alone **within 1000 ms**,
    three times, each try starting with a `Stop` that lists C again and waiting for the list carrying C before the
    `SubagentStop` (otherwise the debounce or the JSON dedup merges or swallows the change) (the 5 s reconcile delivers it without D6's wiring, only later — the bound is what makes this assertion
    discriminate; run the control group of 2.2 and record the measured times in the section's comment, adjusting the
    bound if the measurement says so);
  - `SessionStart` with `source: "clear"` → wait (`pollFor`) until that event file is gone (drained), then
    `sessions.list`: S still carries the shell;
  - a `Stop` listing nothing → an event in which S has no `background` key;
  - tasks listed again and an event received in which S carries them, then `Ctrl+Shift+H` on the desktop → an event in which S is not running and has no
    `background` key.
  Verify by `npm run probe:remote` green.
- [x] 4.2 Register `remote-background-tasks` in `scripts/scenario-coverage.test.mjs`'s `COVERED_CHANGES` and add one row
  per **new** scenario name (12: seven ADDED and one new MODIFIED scenario in `agent-event-bridge`, four ADDED in
  `remote-protocol`), each with its real carrier label, `greenIfAbsent` (true, with the reason, for the rows that hold
  without the feature, such as a failed turn leaving the list alone) and `mutation`. The table is keyed by scenario name
  and rejects duplicates, so the MODIFIED requirements' unchanged scenarios keep their rows; rewrite only the existing
  row for 「事件內容不含絕對路徑」, whose THEN now covers background tasks: carrier the 1.1 assertion "exactly
  `{ id, kind, label }`", and a note that no longer says the scope paragraph only states what the code always did.
  Verify by `npm test`.
- [x] 4.3 Run `npm run typecheck`, `npm run lint` and `npm test`, and `npm run probe:remote` and `npm run probe:intake`
  (the handoff sections read the same wait snapshot) for regressions. Verify all green.
