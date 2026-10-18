## Context

The agent reports its background tasks in two hook payloads, and nowhere else the desktop reads:

| Event | `background_tasks` |
|---|---|
| the agent's own `Stop` | the session's complete list (`[]` when nothing is in flight) |
| `SubagentStop` | the same complete list, **including the stopping subagent** (measured CLI 2.1.302; a helper agent's `SubagentStop` after a `Stop` also carried the running shell, measured 2.1.301) |
| every other hooked event | absent (no capture of `SessionStart` carries it) |

The Agent SDK's type declarations (0.3.220, which matches CLI 2.1.220 — older than the 2.1.302 measured here) describe
the hook field only as "in-flight background work (running/pending + backgrounded) registered in this session". A
task's status is one of `pending`, `running`, `completed`, `failed`, `killed`, `paused`. **A different message of the
SDK's stream** (`SDKBackgroundTasksChangedMessage`, ids only) says consumers should replace their set with each payload
and that "the level is per-process … reset to the empty set whenever the session's CLI process (re)starts"; this design
reads the hook field by analogy with it, not on its authority.

The measurement for this change (CLI 2.1.302, 2026-10-18): this repository's own spekterm session, a background
copier saving its event files before the drain removed them, and a background subagent that started `sleep 45` in the
background and a `Monitor` (a 40-second wait) and then reported. In order:

1. `Stop` (own): the `subagent` (`description`, `agent_type`), the subagent's `sleep 45` (`shell`), the agent's own
   copier (`shell`), and **the subagent's Monitor, listed as `type: "shell"`** with `description` and `command` — each
   `status: "running"`.
2. `SubagentStop` (the subagent paused, waiting on its own background work): the same four.
3. `UserPromptSubmit` (`<task-notification>` for the subagent's interim report), the agent's turn, then `Stop` (own):
   the subagent **gone**; its two tasks and the copier still listed.
4. The `sleep 45` finished; the subagent resumed (`PreToolUse` / `PostToolUse` with its `agent_id`); the agent's
   `UserPromptSubmit` (the hand-back message); `SubagentStop`: the subagent listed as running again, its `sleep 45`
   gone, its Monitor and the copier still listed. The `Stop` after that was not captured.

`type: "monitor"` was seen only in an earlier capture, for two artifact subscriptions
(`description: "live updates for artifact https://… (re-armed on session resume)"`, a description the CLI wrote, not
the agent); the SDK describes that kind as carrying a server and a tool. **The `Monitor` tool's tasks are shells.**

Today `parseEvent` reads the list only on `Stop`, into `runningAgents` (ids) and `backgroundAgentRunning` (a running
task that is not a shell). The remote session list is built in `remote-host.ts` `sessionList()`, sent on a wait-state
change (`observeWaits` in `index.ts`), on session store and pty changes, and by a 5-second reconcile while a device is
connected, debounced 150 ms and deduplicated by its JSON text (`remote-service.ts`).

## Goals / Non-Goals

**Goals:** a paired phone can show, for each running agent session, the background work it runs now — what kind and a
short label — and it learns of a change as soon as the desktop does.

**Non-Goals:** showing it on the desktop; any new hook or measurement channel; tasks' progress or output; scheduled
wake-ups (`session_crons` in the SDK: `/loop`, cron tasks), which are another way a quiet session still has work;
changing what holds a turn open (see Risks, the monitor finding).

## Decisions

### D1. The agent's own list is the source, and it replaces what is held

The held list is replaced by the list in each reporting event, never merged or built from tool events. Tracking
`run_in_background` calls, `Monitor` calls and task notifications would need a parser for every way a task starts and
ends, and every CLI change to them would leave a task listed forever. The agent's list is complete each time it is
sent, so the newest one is the truth as of that moment, and an error in one report is gone at the next (the SDK
prescribes the same for its own background-task message: "replace their set with each payload … so a missed bookend
cannot wedge a stale running indicator").

**Rejected**: keeping the list from `Stop` and removing one subagent by id on `SubagentStop` (the handoff's
suggestion). A `SubagentStop` carries the whole list: work that ended since the last report is already gone from it
(step 4's `sleep 45`) and work started meanwhile is already in it. Removing one id alone would keep the first listed and
miss the second until the agent's next turn end.

### D2. Which events replace, and with what

| Event | Effect |
|---|---|
| own `Stop` with the field | replace with its tasks in flight |
| own `Stop` without the field | clear (a CLI that does not report it has no list to keep) |
| `SubagentStop` with the field | replace with its tasks in flight **minus the task whose id is the event's `agent_id`** |
| `SubagentStop` without the field | no change |
| `StopFailure`, `SessionStart` (any source), `PreCompact`, `UserPromptSubmit`, tool events, `Notification` | no change |

The `SubagentStop` subtraction: the stopping subagent is listed at its own stop (steps 2 and 4). After step 2 the
agent's next `Stop` (step 3) did not list it either, so there the subtraction shows what the agent reports next. After
step 4 the next `Stop` was not captured; the subtraction is then an inference from step 3 and from the event's
meaning (the subagent stopped). Should it be wrong, the next `Stop` restores the subagent. A subagent's id is its task
id (`docs/lessons/transcript.md`).

**`SessionStart` changes nothing.** A process (re)start already clears the list (D3), so a `SessionStart` that is not
after a restart is a `/clear`, an in-process `/resume` or a compaction. Whether `/clear` stops background tasks was not
measured, and the SDK does not say for the hook field. Either guess is wrong only until the next report, which replaces
the whole list; the two errors differ in kind: clearing would hide a dev server that keeps running after `/clear` (the
symptom this change exists to remove), keeping would show work that is gone. This design keeps (Risks has the cost).

**Tasks in flight**: every task whose status is not `completed`, `failed` or `killed` (so `running`, `pending`,
`paused`, and a status not known). The SDK says the list holds only in-flight work, so the finished statuses are not
expected; filtering them costs nothing and keeps the field honest if the CLI ever lists one.

**The two existing readings stay as they are**: `runningAgents` and `backgroundAgentRunning` keep `status === "running"`.
They decide which subagent permission requests stay open and whether a turn is held open — what the CLI does with a
pending or paused task there was not measured, and changing them would move the wait state and the idle check, which
this change does not touch. So a pending subagent can be shown to the phone while the desktop reads the turn as ended.
Every measured task was `running`; an implementer should not unify the two rules as a cleanup.

### D3. A process end clears it, through the existing reset

`forgetRequests` (called from the terminal service's exit callback for every way a process ends:
`src/main/ipc/terminal.ts`) resets `HeldWait` to a fresh value, and hibernation also calls `clearWait`. Holding the
list **inside `HeldWait`** puts it under both, and under the drain's copy-and-fold, with no new wiring to forget.

The host emits the field only for a session whose process is live (as `closeOffered`, `remote-close-offer` D5). One
gap remains, shared with the open requests, on an end other than hibernation (which calls `clearWait` and stops the
drain): after `forgetRequests`, a still-subscribed drain can fold a `Stop` the agent wrote just before it ended, and the
held list then stays in memory — preparing the event directory at the next spawn does not reset it — until the agent's
next report after a wake. It is rare and bounded by that report.

### D4. Each task by white-list, and its label

A task is kept when it is an object with a non-empty string `id` and is in flight (D2); the first of two with the same
id wins. Kept fields:

- `id`: the CLI's task id (a subagent's `agent_id`, a short shell or monitor id). An identifier, not a location.
- `kind`: `subagent` and `local_agent` → `"agent"`; `shell` → `"shell"`; `monitor` → `"monitor"`; anything else →
  `"other"` (the SDK also names a `workflow` type, which is `"other"` here). `subagent` is the measured value (also in `remote-prompts-attachments-rename`'s notes); `local_agent`
  appears only in hand-written fixtures and is accepted because it costs nothing.
- `label`: the first of `description` (any kind) and `command` (shell only) that is a string with something other than
  whitespace; control characters and whitespace runs become one space, the result is trimmed and clipped to 200 UTF-16
  code units (the identifying argument's bound). `null` when neither exists. **No other field is kept** (`agent_type`,
  status, output paths, anything the CLI adds later).

`description` first: for a shell it is the agent's own one-line summary ("Sleep 45 seconds in the background"),
shorter and more readable than the command, and it is the only label a subagent and a monitor have.

**The path rule** (`agent-event-bridge`): no field the system selects may be a location the system added or one the
presentation layer could navigate to, and a field whose value is text written for the user — the agent's, or here its
CLI's — is delivered as written, as plain text, even when it contains a path. The protocol already sends the same kind
of value: `Prompt.arg` and `pending.arg` are a Bash command (`docs/remote-protocol.md`, "may contain paths"). This
change names the label in the rule's scope (a MODIFIED requirement), since the existing wording lists only a tool's
identifying argument and question text, and a shell's `description` is not the identifying argument. The protocol
document gets the matching client obligation: show labels as plain text, never as a link (a monitor's description can
hold a URL).

**Rejected**: kind and count only. It is what the phone needs to stop reading "idle", but not what the user needs to
judge whether to wait: "1 shell" does not say whether it is a dev server or a test run, and the command is already on
the phone for every permission prompt. **Rejected**: rewriting paths in the label to folder-relative ones. The scope
clause says such text is not to be rewritten, and a command's paths cannot be located reliably in shell syntax.

### D5. The field: present only when there is something to show

`background?: [{ id, kind, label }]` on `Session`, `kind` typed as the same union as the held task, in the order the
agent reported, present only when the session is an agent session, its process is live, and at least one task is
held. Absent otherwise — so a client treats "absent" the same whether the desktop has nothing to show or predates the
field, which is the answer it needs in both cases. `label` is always present, `null` when there is none, so a client
parses one shape.

The list reflects **the agent's last report**, not the moment: a task started inside the current turn appears when the
turn (or a subagent) stops, and while a turn runs the list may still name a task whose end started that turn. The
document says this.

No cap on the number of tasks: each entry is at most a few hundred bytes, and the agent's own list is bounded by
what it can run.

### D6. A change is announced at once

The drain result and the wait snapshot gain `backgroundChanged`: the held list's serialization differs before and after
the batch (order included, since D5 promises the agent's order). The `observeWaits` callback in `index.ts` calls
`listChanged('sessions')` when the state changed **or** `backgroundChanged`. Without it, a `SubagentStop` — which moves
no wait state and reaches no other announcement (`apply` returns before `nextWaitState`; the attention broadcaster
announces only its own projection's changes) — reaches the phone only at the next 5-second reconcile.

The probe times it: the path is the drain tick (0–400 ms) plus the list debounce (150 ms), so the bound is
**1000 ms**, measured with and without the wiring before it is fixed in the section's comment. A reconcile landing in
that window by chance is about (1000 − 350) / 5000 ≈ 13% per try; three tries in a row about 0.2%.

## Risks / Trade-offs

- **A stale entry when no report follows a task's end.** A task that ends with no later `Stop` or `SubagentStop`
  stays listed until the next one, or until the process ends. Measured paths all report (a finished task's notice
  starts a turn, which ends in `Stop`), but the agent's own open prompt holds those events back
  (`docs/lessons/transcript.md`), and an interrupted turn reports nothing. → The document states the list is the
  agent's last report; a process end always clears it.
- **A task hidden until a report.** One started during a turn shows only at its end. → Accepted; the turn itself is
  shown as working.
- **The CLI changes the payload.** A renamed `type` falls into `"other"` (still shown); a removed field leaves the
  list empty, the behavior before this change. `docs/lessons/transcript.md` gets the measurement to redo on a CLI
  upgrade.
- **Work shown after `/clear` stopped it.** If `/clear` stops background tasks and no turn follows, the phone shows
  work that is gone until the next report or the process ends. → Accepted for the reason in D2; `docs/lessons/transcript.md`
  lists `/clear` as a measurement still to make.
- **The SDK evidence is older than the CLI measured, and partly about another message.** The in-flight statement comes
  from SDK 0.3.220 (CLI 2.1.220); the replace and per-process statements are about the SDK's stream message, read here by
  analogy. The 2.1.302 captures agree where they reach (complete lists, replaced each time, no field on
  `SessionStart`); `pending` and `/clear` were not observed.
- **Finding, not changed here**: `backgroundAgentRunning` counts every running task that is not a shell as holding
  the turn open, so an MCP-style `monitor` (the earlier capture has two) does. Such a session may read as in a turn
  after its turn ended, which the hibernate and close idle check reads as "working". It belongs to
  `agent-session-control` D3 and needs its own measurement; this change does not alter it.

## Migration Plan

None: an additive field on a version-1 frame. Rollback is removing the field.

## Open Questions

None for the desktop. The phone's presentation is the companion app's change.
