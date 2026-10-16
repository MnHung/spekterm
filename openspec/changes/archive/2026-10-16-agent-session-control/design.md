## Context

See `proposal.md` for why. The pieces this design builds on, read from the code:

- **The drop point already dispatches on `kind`** (`handoff-delivery.ts` `outboxKindOf`): no `kind` is a handoff,
  `"report"` is a completion report, anything else is refused as `FIELD_TYPE` and is visible to the user
  (notification and an inbox trace). The source session is derived from the directory the file lands in
  (`sourceSessionOf`), never from the file's contents. The drop point is read on watcher events, at startup, and
  every 30 seconds (`intake-periodic-rescan`). A file can therefore be read twice before it is consumed; reports
  handle that with an identity (path, mtime, digest) and adopt each identity once (`reportIdentity`).
- **Refusal visibility has two halves.** `IntakeService.reject()` leaves the inbox trace. The operating-system
  notification comes only from `IntakeSource` reporting a permanent rejection through `service.reportFailure`
  (`intake-source.ts`, `index.ts`). Its text is fixed to handoffs: "A handoff could not be delivered: {{reason}}"
  (`intake.notify.failure`). The trace shows the reason, `origin` and `target` (`IntakeOverlay.tsx`).
- **The desktop's close, hibernate and rename can be run quietly from the main process.** `requestRenderer(contentsId,
  action)` (`ipc/remote.ts`) sends a `HostAction` to the window's `RemoteRequests.tsx`. That component calls the
  same `close`, `hibernate` and `rename` the tab menu uses, with `{ quiet: true }`, and replies within 15 seconds.
  The preload's `narrowRemoteAction` already passes the three kinds, and `hibernate` / `close` carry
  `force: boolean`. `RemoteHost.perform` adds a busy check before the request; this design calls `requestRenderer`
  directly and decides by itself when to send.
- **A peer name is unique among the session records**: `decidePeerName` checks every record, provisional ones
  included, case-insensitively. It is derived from the session id. It is fixed for the life of the session: a
  rename changes the label, not the name (`agent-peer-name`). The relations file addresses sessions only by this
  name, contains no spekterm ids, and decides existence with `sessionExists` (`session-lineage`, "session 的存在有單一定義").
- **Lineage records only the direct parent** (`SessionLineage.parentId`). It comes from the intake record's
  `verified.source`, which `lineageSourceOf` fills **at ingestion** (`handoff-service.ts`). `ticketResolutionFor`
  copies it when the session is created, which may be days later if the handoff fell back to pending. When a
  session is closed its record is removed, so a grandchild's `parentId` then points at nothing.
- **The agent's wait state** (`agent-events.ts`, `agent-wait.ts`) is drained every 400 ms per running agent.
  `ready` does **not** mean "the turn ended" on every path:
  - `SessionStart` sets `ready` whatever its `source`, `compact` included, and a compaction can happen inside a
    turn;
  - an own `Stop` sets `ready` even while a background subagent still runs (`Stop.background_tasks`);
  - measured (`docs/lessons/transcript.md`): a prompt denied with Esc and a text answer interrupted with Esc report
    **nothing**, so the state stays `busy` / `awaiting-choice` until the user's next turn;
  - a message typed during an answer gives `Stop`, then a second turn.

  `DrainResult.turnEnded` flags a batch containing `Stop`. Events that are not the agent's own turn also move the
  base state:
  - `Notification(idle_prompt)` sets `ready`; it was measured 60 s after a `StopFailure`;
  - a subagent's `PreToolUse` sets `busy`, and once in five runs one arrived after the turn had ended, with nothing
    after it.

  A device's dismissal of the agent's own prompt sets `ready` with no event (`dismissRequest`); every measured
  dismissal ended the turn. `Stop.background_tasks` absent gives `runningAgents === null`. Whether background shells
  are listed there has not been measured: only subagents were.
- **Every pty write except a device answer's keys and the terminal's own focus and mouse reports is a keystroke**
  (`pty-input.ts` `noteWrite` / `onKeystroke`). These count:
  - device replies;
  - spekterm's own sending of a handed-off session's first prompt;
  - answering a permission prompt at the desktop;
  - the terminal's replies to queries the program sends (`docs/lessons/terminal.md`).
- **Only `kill` reads a drop point at a session's end** (`TerminalService.kill` → `endHandoff`). Hibernation and the
  app quitting (`dispose`) do not, so a command written in a session's last moments can be read in a later run, or
  after the session was hibernated.

## Goals / Non-Goals

**Goals:**

- One delivery format and one dispatch for every command, next to handoffs and reports.
- Who may be targeted is decided from records the main process owns (lineage and peer names), never from the
  command's contents.
- A command that ends a running agent's process never cuts a turn short, and yields to the user.
- The descendant chain survives the closing of an intermediate session.

**Non-Goals:**

- Commands on shell sessions. Lineage exists only on sessions created by handoff, and those are always agent
  sessions. An agent's own session is an agent session too.
- Waking, creating, or reordering sessions, or any action outside a session (folders, the panel, settings).
- A reply channel. The agent is not told whether a command was carried out (as with handoffs).
- Showing a pending command in the interface.
- Keeping a pending command across an app restart.
- Changing the remote protocol or the desktop's own close, hibernate and rename.

## Decisions

### D1. Three new `kind` values in the existing drop point

```json
{"kind": "close"}
{"kind": "hibernate", "target": "<name>"}
{"kind": "rename", "target": "<name>", "name": "<new label>"}
```

- `target` is optional. Absent means the agent's own session. The agent's own name is accepted too and means the
  same thing, because an agent that reads its relations file may well write it.
  - A `target` that is present but not a non-empty string is `FIELD_TYPE`.
- `name` is required for `rename`; missing or not a string is `FIELD_TYPE`.
  - It is flattened like a source title (`sourceTitle`'s rule: `normalizeAuthored`, line breaks to spaces, trimmed),
    so a multi-line label cannot reach the tab or the relations file.
  - It may have at most `MAX_FIELD_LENGTH` characters, counted in code points after flattening (the unit
    `sourceTitle` slices by). A longer name is `TOO_LONG`: refused, not shortened.
  - An empty name after flattening hands the label back to the terminal title, as the desktop's rename does. This
    is not an error.
- `outboxKindOf` gains the three values. Any other `kind` is still refused as `FIELD_TYPE`.

**Alternatives.** A single `{"kind": "session", "action": ...}` adds a second level of dispatch that has nothing to
dispatch on. An MCP tool would give the agent a result, but it is the larger piece of work the handoff spec
already records as not done, and it would introduce a second transport for the same request.

### D2. Targets are resolved by peer name, within the source's own subtree

The source session S comes from the directory. Only sessions that **exist** by `sessionExists`, the definition
the relations file and the rail use, can be resolved: a session whose folder left the workspace is invisible to
the agent's relations, so it is not a target either. Resolution:

1. **S does not exist any more.** This is the usual case on the drop point's final read: `kill` starts that read
   (`endHandoff`), and the close's handler removes S's record synchronously right after, while the read is still
   reading files. So the read sees no S.
   - no `target`: drop silently;
   - a `target` that names an existing descendant of S (step 3): carry it out;
   - anything else: drop silently. Without S's record, S's own name cannot be told from an unknown name, and
     neither is the agent's error at this point.
2. **S exists.** Absent `target`, or `target` equal to S's peer name: the target is S. Otherwise find the existing
   session whose peer name equals `target` exactly (names are machine-made and copied from the relations file).
   No such session: refused as `CONTROL_TARGET_NOT_FOUND`.
3. The target must be a descendant of S: S's id is in the target's ancestry (D4). Otherwise it is refused as
   `CONTROL_NOT_ALLOWED`. This covers the parent, siblings, cousins and unrelated sessions.

**Authorization never needs S's record.** It reads the target's ancestry, which holds S's id whether or not S still
exists. Ancestry is always walked over **every record** (D4). Existence only filters which sessions can be named
as targets and which are shown in the relations file, so "listed in the tree" and "may be commanded" cannot come
apart.

**Why not accept spekterm ids or labels.** The agent never sees ids (`session-lineage` forbids them), and labels
are neither unique nor stable.

### D3. "In a turn" is the agent's own turn boundaries plus the user's typing, and typing cancels a wait

The agent's wait state answers "may the agent be sent input now", and too many events move it: notifications,
subagent tool calls, compaction. "Is a turn in progress" needs its own fact, and events alone cannot give it. A
`!cmd` typed by the user reports **only** its `Stop` (measured), so a shell command running for minutes has no start
event. What every turn does start with is **a write into the pty**:

- the user's prompt;
- a `!cmd`;
- a slash command;
- a device reply;
- spekterm's own sending of a handed-off session's first prompt.

**A session is in a turn when, since its last turn end, it has received an own `UserPromptSubmit` or a keystroke.**

A **turn end** is:

| Event | ends the turn |
|---|---|
| own `Stop` with no running background **subagent** (`background_tasks` absent or empty, or listing none running) | yes |
| own `Stop` with a background subagent still running | no |
| own `StopFailure` | yes |
| `SessionStart` with `source` `startup`, `resume` or `clear` | yes |
| `SessionStart(compact)` after a `PreCompact` with `trigger: "manual"` (the user's `/compact`, which reports no `Stop`, measured) | yes |
| a device dismissing the agent's own prompt (`dismissRequest`, no event; every measured dismissal ended the turn) | yes |
| the process ending (`forgetRequests`) | yes (reset) |
| any other event: `SessionStart(compact)` after an automatic `PreCompact`, `SessionEnd`, `Notification` of any kind, `SubagentStop`, any subagent event, own `PreToolUse` | no, and none starts a turn either |

`agent-events.ts` folds the time of the last turn end and whether an own `UserPromptSubmit` followed it.
`agent-wait.ts` combines that with `lastKeystrokeAt` (`pty-input.ts`) into an `inTurn` value, exposed on
`WaitSnapshot`. A session is **at rest** when it is not in a turn. Own `PreToolUse` is deliberately not a start:
outside a turn it was never measured, and one arriving there would hold `inTurn` true with nothing to clear it.
Every measured start is already a submission or a keystroke.

A close or hibernate command on a **running** target:

- at rest when the command is read (after `refreshWait`): carry it out now. For the agent's own session this
  happens when the drop point was read late, after the turn already ended;
- in a turn: hold it as **pending**, and carry it out on the first drain after which the target is at rest. This
  covers:
  - a running `!cmd`, which ends at its `Stop`;
  - a permission prompt (the turn is still open);
  - a mid-turn compaction;
  - a background subagent: its notice arrives as a submission, and the turn ends at the `Stop` that lists none
    running;
- agent events off (`agentEventsEnabled()` false): the turn cannot be observed. The command is refused as
  `CONTROL_UNAVAILABLE` (D6).

**A keystroke into the target after a command arrived drops that pending command** (`onKeystroke`). The user has
taken the session back. Silence would otherwise leave the turn open until the user's next turn, and that turn's
end would fire the command: an Esc denial and an Esc interruption report nothing. The rule matches a device
answer's "nothing was typed since". Answering the target's permission prompt **at the desktop** is a keystroke, so
it drops the command. Answering it from a paired device is not (`origin: 'answer'`). The drop is silent: the user
is already acting on that session.

**The safe direction has a cost: a command can wait silently forever.** These targets stay in a turn until the
user's next turn, and that turn begins with a keystroke, which would drop the command anyway:

- a target whose last turn was interrupted with Esc;
- a target the user typed into without sending (a draft in the input);
- a target that received a non-user write after its last turn end.

A command arriving at such a target is never carried out, and the agent is not told. The spec records this gap.
Task 3.3 measures whether `idle_prompt` follows an Esc interruption; if it does, a later change can treat it as a
turn end. Task 3.3 also measures which non-user writes a real agent produces during a turn and while idle (replies
to the program's terminal queries, for example). Reply sequences found there go into `isTerminalReport`, which also
sharpens the device-answer rule.

`rename` never waits: it ends nothing. A **dormant** target has no turn: `hibernate` is already true and does
nothing, and `close` runs at once (subject to D11).

**Why not the wait state (`ready`) or `busyReason`.** `ready` is set by `idle_prompt` and by a mid-turn compaction,
and cleared by a stray subagent `PreToolUse` after the turn. A finished child idle for a minute could then never be
closed, and a compaction would let a close cut a turn short. `busyReason` also counts `unsent` as busy, and neither
sees a `!cmd`.

**Background shells.** Only background *subagents* hold the turn open. `background_tasks` lists a background shell
like an agent, told apart only by `type: "shell"` (measured), so the fold skips that type. A long-running dev
server must not hold a close forever. Closing ends it, as the desktop's close does.

**`PreCompact` joins the hooked events** (`HOOKED_EVENTS`) for its `trigger`. It changes neither the base state nor
the open requests: the fold records only whether the next `SessionStart(compact)` follows a manual one.

**Pending rules:**

- One pending command per target. A later command for the same target replaces it (last write wins), so "close"
  can overwrite an earlier "hibernate" and the reverse.
- When the target's process ends for another reason before it is at rest, the pending command is dropped without a
  notice. The other reasons are the user hibernating or closing it, or the process exiting. The user acted on that
  session, and that outranks a deferred request.
- Pending commands live in memory. Quitting drops them, and D11 keeps an unread one from acting in a later run.

**Why wait for descendants as well as for the agent's own session.** Refusing a busy descendant would need a
`force` field and a way to tell the agent to use it, and the agent has no reply channel. Waiting gives the parent
what it asked for without ending work mid-turn. The cost is a close that happens later than the parent wrote it,
at the end of whatever the child is doing, unless the user touches the child first.

**A child about to receive its first prompt.** A freshly spawned child has had no turn end yet and no keystroke,
so it is at rest. A close read before its first prompt is written runs at once. The first prompt's write then hits
a pty that is gone, and that write must be a safe no-op (task 4.5 asserts it). Once the first prompt is written,
the child is in a turn until its `Stop`.

**Measured (task 3.3, `docs/lessons/transcript.md`, "Turn boundaries"):**

- a `!cmd` reports nothing until its `Stop`;
- a manual `/compact` reports `PreCompact(manual)` and `SessionStart(compact)`, no `Stop`;
- `idle_prompt` follows an ordinary `Stop` after 60 s, and nothing at all follows an Esc interruption, so the
  interrupted-turn gap is real;
- a background shell is `type: "shell"`;
- the only non-user writes are xterm's answers to three startup queries (DA1, XTVERSION, the kitty keyboard
  query), and `isTerminalReport` now covers them.

Still not measured: whether an automatic compaction can arrive inside a turn. The rule does not depend on it: an
automatic one never ends a turn, wherever it falls.

### D4. Ancestry: the chain is taken at ingestion, and derived for older records

`SessionLineage` gains `ancestors?: string[]`. It holds the ids above the parent, nearest first, so
`[parentId, ...ancestors]` is the whole chain.

**The chain is taken when the handoff is ingested, not when its session is created.** The source's own lineage
snapshot is taken at that moment (`session-lineage`: the snapshot is from ingestion), and the two can be days
apart: a handoff that fell back to pending is accepted later. If the chain were computed at creation, closing the
parent in between would leave `[parent]` only, and the grandparent would lose the grandchild. That is the case
this change exists for. So:

- `HandoffService`'s `sourceOf` also returns the source's ancestry. `index.ts` computes it from the session store
  with `ancestryOf`.
- `lineageSourceOf` puts it into `verified.source` as `ancestors`. `HandoffSource` and `parseHandoffSource` gain
  the field, with the same validation as below.
- `ticketResolutionFor` copies it into the new session's lineage, as it already copies `origin` and the title.
  No new access to the session store is needed there.

`ancestryOf(id, byId)` is one pure function in `src/shared/lineage/`. The ingestion path, the relations file and
command authorization all use it, and all pass **the full session view** (every record, provisional ones
included), never only the existing sessions. A walk through a session whose folder left the workspace must not
break a chain that the session's record still holds:

- push the record's `lineage.parentId`;
- if the record has `ancestors`, append them and stop;
- otherwise continue from the parent's record, if it exists;
- stop on a missing record, on an id already seen (a corrupt file must not loop), or at `MAX_ANCESTRY` (64)
  entries.

Records written before this change have no `ancestors`. Walking their existing parents rebuilds what can be
rebuilt. A link already broken by a closed intermediate stays broken, as the proposal states. A handoff still
pending in the inbox from before this change carries no chain. Its session's chain is then derived from the
parent's record, if that still exists.

**Persistence.** `parseLineage` reads `ancestors` as an array of UUIDs, capped at `MAX_ANCESTRY`. An invalid value
drops only that field, never the lineage: a broken field must not remove a session from the rail
(`session-lineage`). The field is main-owned with the rest of `lineage` (`replace()` keeps `kept?.lineage`), so the
renderer cannot write it. It contains only ids, so sending lineage to the renderer leaks no paths. The renderer
ignores it.

**Alternatives.** Keeping closed sessions as tombstones for the chain would keep records the user removed and
would add a second notion of existence, and `session-lineage` insists on a single one.

### D5. The relations file becomes a tree under `children`

Each `RelatedSession` in `children` gains `children: RelatedSession[]`, recursively, with the same fields. The
field is present only on a descendant entry that has descendants of its own, never on the parent or on siblings, so
today's entries keep their exact shape.

- A descendant hangs under its **nearest existing ancestor** within the subtree.
- A descendant whose direct parent does not exist carries `"parentGone": true`, so the tree still says it was not
  handed off by the session it hangs under. "Does not exist" covers a closed parent and one whose folder left the
  workspace, so the field does not say "closed".
- The top-level `children` keeps its meaning for direct children. The only new entries at the top level are
  orphans, and they are flagged.
- `parent` and `siblings` are unchanged (flat, no subtrees). Command authorization does not reach them, and a
  sibling's subtree belongs to the sibling.

`refreshRelations` already recomputes every running agent's file on any change, so a grandchild's arrival,
rename or completion reaches the grandparent with no new trigger.

**Why a tree and not a flat `descendants` list.** A flat list needs a parent reference, and the only stable
reference available is the peer name. The tree shows the shape directly, and an agent reads it as it reads the
rail.

### D6. One module, `session-control.ts`, behind the handoff service, and delivery never waits for the window

`HandoffService.deliverFile` routes the three kinds to an injected `control.deliver(sourceId, command, identity,
mtimeMs)`, as it routes reports to `acceptReport`. With no `control` injected, they are refused as an unknown kind
is today.

The file's modification time is needed by D11 and the identity. It comes **from the read**: `IntakeSource`'s
`deliver(contents, file)` gains the stat that `readBounded` already took (`deliver(contents, file, state)`). A
second `stat` could see a newer file at the same path, or none.

The module is Electron-free, with these dependencies injected:

- the session view with existence (records, lineage, peer names, `sessionExists` inputs);
- whether a session has a pty;
- `refreshWait`, `inTurn` and `subscribeWait`;
- `onKeystroke`;
- `agentEventsEnabled`;
- the process-wide start and end times (D11);
- `request(action)`, which `index.ts` binds to `requestRenderer` on the live window behind the gate (D9).

**`deliver` never awaits the window.** It parses, resolves, authorizes and decides (D2, D3, D11). Then it returns
at once:

- a refusal as a `DeliverOutcome` (`service.reject` with the `failure` fields), the path every refusal takes
  today;
- otherwise `{ ok: true, consume: true }`, and the request runs **asynchronously**.

The reason is that `IntakeSource` handles files one at a time (`await this.#handle(file)`) and skips a periodic
re-read while the previous one runs. A `deliver` that awaited the window would stall every drop point's reading
behind one command: handoffs and reports too. The wait could be 15 s for a request, or unbounded behind the gate.
That is the silent "drop point not read" failure `intake-periodic-rescan` closed.

Identity deduplication works as it does for reports: an identity already acted on, pending or queued returns
`{ ok: true, consume: true }`. `hibernate` and `close` are sent with `force: true`; the interface ignores the field,
and this module has already decided.

**Failures of the request itself** come after the file was consumed, whether the command ran at once or waited.
They take one path. The module reports both halves the intake source would have produced:

- `service.reject(...)`, which leaves the trace;
- for a permanent code only (D6 codes below), `service.reportFailure(...)` with the same code, detail and failure,
  which sends the notification. This mirrors `IntakeSource`'s own `#reportIfPermanent`.

`reject` alone would leave a trace and no notification.

**What the user reads.**

- `failure.origin` is the source session's rail item and label, and `failure.target` is the target as written.
  With no target it is the source's own label. With the source gone it is `(ended)`, as for handoffs.
- **The failure carries its subject.** `FailureContext` gains `subject?: 'command'`, set for every failure of a
  command kind. It reaches `reportFailure` through `DeliverOutcome.failure`, as `target` and `origin` already do. A
  code alone cannot carry it: `FIELD_TYPE` and `TOO_LONG` are shared with handoffs. It is **not persisted** with
  the trace: only the notification reads it, and the trace's reason and target already say what happened.
- A single failed command's notification reads title "Session command" and body "A session command could not be
  carried out: {{reason}}". A merged notification keeps its general text, which already counts items without
  naming them. `intake-notify` gains the choice.
- A command file over the whole-file limit is rejected by `readBounded` before its kind is known. Its notification
  keeps the handoff text. The spec states this exception.

**New rejection codes** (`IntakeRejection`; `isPermanentRejection`'s exhaustive switch makes each a decision). Each
gets an entry in both dictionaries. The criterion is `agent-intake`'s: would the same delivery, resent with no
setting changed, fail the same way?

| Code | When | Kind |
|---|---|---|
| `CONTROL_TARGET_NOT_FOUND` | no existing session has that name | permanent |
| `CONTROL_NOT_ALLOWED` | the target is not the source or a descendant | permanent |
| `CONTROL_FAILED` | the interface answered `NOT_FOUND` or `CREATE_FAILED` | permanent |
| `CONTROL_NO_WINDOW` | no window, or the request timed out (`NO_WINDOW`, `TIMEOUT`, the gate's bound) | temporary: a window coming back would let it succeed |
| `CONTROL_UNAVAILABLE` | agent events are off | temporary: a setting, as `PREFILL_UNAVAILABLE` |

Permanent codes notify. Temporary ones leave the trace for this run only, which is what `agent-intake` requires.
Being temporary does not mean being retried: the file is consumed either way, so a stale close cannot fire later.

### D7. Quiet, including on the agent's own displayed session

Every command uses the `quiet` path paired devices use. The rail selection does not change, keyboard focus is not
taken, and the focused session changes only when the displayed session is closed.

**Considered:** the desktop's ordinary close for the agent's own session, because the user is likely looking at it.
That close moves keyboard focus into the next session's terminal. By the time the turn ends, though, the user may
be typing in another session, and a deferred action that takes the keyboard is the surprise the quiet rule exists
to prevent. The cost is that after closing the displayed session, the user clicks (or uses `Ctrl+Tab`) to type in
the next one.

### D8. The introduction states the commands and the new shape of the relations file, derived from the constants

`handoff-intro.ts` gains a section for **every** agent session, not only those created by handoff. Every agent
can act on itself. It states:

- the three shapes;
- that `target` is omitted for the agent's own session;
- that other targets are names from the relations file, only from its own `children` tree;
- that close and hibernate happen when the target's current turn ends, so the command should be the agent's last
  action, and that the user typing into the target cancels it;
- that rename takes effect at once and changes no messaging name;
- the name's length limit, from `MAX_FIELD_LENGTH`;
- that agent events must be on;
- that the agent is not told the outcome, but can see a descendant's result in its relations file (closed: gone;
  hibernated: `"running": false`; renamed: `title`).

`peerLines` (the relations paragraph) is rewritten for the tree:

- `children` nest: each child lists the sessions it handed off, at every depth;
- `"parentGone": true` marks a descendant whose direct parent no longer exists;
- state and summary apply to every descendant.

`scripts/handoff-intro-source.test.mjs` already forbids literal limits in the file. The new limit goes through
the same derivation.

### D9. Commands wait for each window's restored session list

At startup the drop points are read in `whenReady`, before the window has restored its sessions. A `close` or
`rename` sent then would find either no listener (`TIMEOUT`) or an empty list (`NOT_FOUND`), and it would surface as
a `CONTROL_FAILED` for a session that exists. The same happens while a window reloads (`did-navigate`) or after
macOS opens a new window.

Requests therefore go through a per-window gate:

- The gate opens when the main process **receives** the window's first session-list sync (the persist IPC), before
  that IPC's 500 ms debounce. The renderer sends this sync only after its restore, even when the list is unchanged:
  `restored` is in the persistence effect's dependencies, and the restore's `.finally` opens it whatever the result
  (`sessions.tsx`).
- The gate closes again on the window's `did-navigate` and `destroyed`.
- A request queues while the gate is closed, **for at most 60 seconds**. Past that it fails as `CONTROL_NO_WINDOW`.
  A renderer that crashed (`render-process-gone` fires neither `did-navigate` nor `destroyed`) or a restore that
  never finished must not hold commands forever. With no window at all, the request fails at once.
- **A queued request is decided again when the gate releases it**: its target's existence, its process state and
  D11. A reload ends every pty as `disposed`, so a close queued across a reload is dropped by D11, as a pending one
  is by the process-end rule.
- The queue lives in the module, so `deliver` returns before the gate opens (D6).

### D10. The existing "no automatic end" rules do not conflict

- `handoff-completion` says the system does not end a session's pty because of any state. That rule is about
  spekterm reading a lifecycle state, such as "done", and acting on its own. Here the end of a turn only times a
  request an agent made. The request is the cause, and no state is.
- `session-hibernation`'s first requirement names the user and a paired device. It grants those two, and it does
  not exclude others; automatic hibernation is already a third. This change's own spec covers the agent's
  request.

Neither main spec is modified. The new spec refers to both.

### D11. A close or hibernate yields to anything that happened to its target after it was written

The drop point is not read at hibernation or quit (Context), and the periodic re-read can find a file the watcher
missed up to 30 s late. Without a rule, either of these turns a command written before the user's own action into
an action after it:

- the agent's self-close written just before the user hibernated the session closes the dormant session;
- a self-close written just before the app quit closes the session after the next startup.

So a close or hibernate is carried out only if its file was written (its modification time, taken from the read,
D6):

- after the target's process last started or ended in this run of the application;
- after this run started, for a target that has not run in this run.

Otherwise it is dropped silently. The user's wake, hibernate or quit came later, and it outranks the command.

- Rename is not subject to this. It is harmless, and an unread rename from the last run is applied after the
  restore (D9).
- The modification time is written by the agent, which could set it. That is no concern here: the agent could just
  as well write a fresh command.
- The times live in a **process-wide** module-level map keyed by session id (the `pty-input.ts` pattern), with the
  run's start time. `TerminalService` is one instance per window and loses its sessions when the window goes, and
  macOS reopens windows. A per-instance record would forget S, and S would then be judged by the run's start: the
  very case this rule exists for. Every exit reason is recorded (`self`, `hibernated`, `killed`, `disposed`). So is
  every start, a heal (an automatic re-spawn after a failed resume) included: it is not the user's action, but
  dropping a command near it errs in the safe direction.
- **An end this module caused does not count.** When P writes hibernate C and then close C, the hibernation ends
  C's process. Without this exception the close, written before that end, would be dropped, and the first command
  would win against "latest wins". The module marks the ends it requested and skips them.
- No mtime (the stat was unavailable): a close or hibernate is dropped silently.
- The file system's clock is coarse: on ext4, measured in the review, a file's mtime can be up to about 4 ms
  earlier than `Date.now()` taken just before writing it. A command written within milliseconds of a process
  start or end can be judged on the wrong side. No agent writes a command within milliseconds of its own process
  starting, and the user's hibernate is not that fast either, so no tolerance is added.

### D12. An agent's close of its own session is offered, not carried out

Dogfood: the end-of-turn close works, but a reply that mattered disappears the moment it appears. So at the end
of the turn, a self-close becomes an **offer**. That covers only `close` with the source as target and a running
target; hibernate and every command on a descendant are unchanged, which keeps "close the finished handoffs" a
single request.

- **The decision stays in the main process.** `#carryOut` sends `{ kind: 'offer-close', sessionId }` instead of
  `close`. It does not mark a command end, because nothing ends. It records the session as offered. A keystroke
  into an offered session (the same `onKeystroke` that drops a waiting command, so a device reply and the
  conversation view's send count too) sends `{ kind: 'withdraw-close', sessionId }`. Both are new `HostAction`
  kinds, which are internal to the window channel and not remote-protocol operations, and the preload's
  `narrowRemoteAction` passes them.
- **The interface holds the offer as session state** (`sessions.tsx`). It is cleared on close, hibernate, exit and
  wake. Both views render it like the dormant prompt, with one difference: the backdrop is transparent and
  `pointer-events-none`, so the content stays readable, selectable and scrollable, and only the card's buttons take
  pointer input. The card sits at the top: the agent's last reply is at the bottom, above its input box. The offer
  takes no focus, so the user keeps typing where they were, and typing into the session withdraws it.
- **Close** is the desktop's ordinary `close` (the user acted, so it is not quiet). **Keep** clears the offer in
  the interface only; a later keystroke still sends a withdraw, which is then a no-op.
- **Not persisted.** A restart restores every session dormant, and the offer goes with the window state.
- **A paired device does not see the offer.** The phone's list shows the session running. That is a gap, recorded
  for the companion app.

## Risks / Trade-offs

- [A prompt-injected agent closes its own session or its descendants] → The reach is bounded by D2. A close ends
  the process and removes the record, but the agent's transcript stays on disk. This is not a security boundary:
  the drop point is not one (`agent-handoff-source`), and the agent has a shell anyway. What D2 keeps out of reach
  is unrelated sessions, other repos, and the parent.
- [A pending close fires at the end of a long turn of a child the user is watching but not typing into] → The user
  can type into the child, or hibernate or close it, and any of these drops the command. The introduction tells the
  agent the command waits.
- [A turn end that leaves no event] → A crash of the agent CLI mid-turn ends the process. That drops the pending
  command, which is the safe direction.
- [Ancestry grows with depth] → It is capped at 64 entries per record, nearest first, so beyond that the farthest
  ancestors are lost. That is far past any handoff depth we have seen.
- [The agent-events preference and what a session was spawned with can differ] → `agentEventsEnabled()` reads the
  current preference, while the hooks were injected at spawn. With no runtime toggle in the interface this is rare.
  A session spawned without events never reports a turn boundary, and a command on it is refused as unavailable
  only if the preference is off now. Otherwise it waits until a keystroke drops it.
- [A command waits silently forever on a session that stays "in a turn"] → An Esc-interrupted turn, an unsent
  draft, or an unmeasured non-user write keeps the target in a turn until the user's next turn, whose keystroke
  drops the command. The spec states the gap. Task 3.3 measures the writes and the Esc tail.
- [Wait state lags 400 ms] → `refreshWait` runs before every decision. A turn that starts in the round trip to the
  window is ended anyway. The window answers in milliseconds.

## Migration Plan

No data migration. Records and pending handoffs without `ancestors` are read as before, and their chains are
derived (D4). New ones carry the field.

**Rollback** is a revert, with one lasting effect: an older build drops `ancestors` the first time it rewrites
`sessions.json` (`parseLineage` builds only known fields). After upgrading again, chains are derived from the
records that still exist, so links through sessions closed while the older build ran are lost.
