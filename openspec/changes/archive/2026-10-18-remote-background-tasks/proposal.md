## Why

A paired phone cannot see the work an agent session runs in the background: background subagents, background
shells, monitors. The terminal lists them under the prompt, but the phone only has the session's wait state. Once a
turn ends while a background shell or a monitor keeps running, the phone shows the session as waiting for you or idle,
and the user reads it as a session that is doing nothing.

The desktop already receives the facts. Every `Stop` the agent reports carries `background_tasks`, and
`agent-events.ts` reads it today only for two internal decisions (whether a turn is still held open, and which
subagents' permission requests are still open). The remote protocol carries none of it. The companion app
(`spekterm-android`) asked for the desktop side first; its own change is written against this one.

Measured for this change (CLI 2.1.302, this repository's own session, 2026-10-18), and read in the Agent SDK's type
declarations:

1. A background subagent is listed as `type: "subagent"`, with `description` and `agent_type`. A background shell
   carries `description` (the agent's own summary) and `command`. **A task of the `Monitor` tool is listed as a
   `shell`** too; `type: "monitor"` is another kind (seen for artifact subscriptions, with a description the CLI wrote
   that contains a URL).
2. **`SubagentStop` carries the same complete `background_tasks` list as `Stop`**, and lists the stopping subagent
   itself.
3. The list is session-wide (a subagent's background shell appears in the agent's own `Stop`), holds only work in
   flight (`pending` included, per the SDK's description of the field). For its own background-task stream message the
   SDK tells consumers to replace their set with each list and to reset it when the CLI process restarts; this change
   reads the hook field the same way.

## What Changes

1. **The desktop keeps each agent session's background tasks in flight**, from the agent's own reports: the list a
   `Stop` or `SubagentStop` carries replaces the one held (a `SubagentStop`'s without the subagent that stopped). It
   is cleared when the session's process ends (any reason: exit, hibernation, close); nothing else clears it, a
   `/clear` included. Each task is read by white-list: its id, a kind (`agent`, `shell`, `monitor`, or `other` for a
   type not known), and a label.
2. **The label** is the task's `description`, else a shell's `command`, else none; whitespace runs and control
   characters become one space, and it is clipped to 200 characters. It is the agent's own text, delivered as plain
   text under the path rule's scope (`agent-event-bridge`, whose scope clause now names it), the same treatment the
   protocol already gives a tool's identifying argument (`Prompt.arg`, which is a Bash command).
3. **The session list carries it.** Each `Session` in `sessions.list` and `sessions.changed` gains
   `background: [{ id, kind, label }]`, present only for a running agent session with at least one task in flight, and
   absent otherwise. A change of the list is sent at once, without waiting for an unrelated change or the 5-second
   reconcile (a `SubagentStop` changes no wait state).
4. **The protocol document** describes the field, when it appears and goes, the label rule, and a client obligation
   to show labels as plain text. The protocol stays **version 1**: an additive optional field. An older phone ignores
   it (obligation 7); a newer phone reading an older desktop sees no field and shows no background work.
5. **The website's remote-access page** (both languages) says the phone can show an agent's background work.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-event-bridge`: the system keeps each agent session's background tasks in flight from the agent's own
  reports, with the replace and clear rules and the label rule; the path rule's scope names a background task's label.
- `remote-protocol`: the session list carries a running agent session's background tasks, and a change of them is
  sent at once; the list requirement's enumeration names them.

## Impact

- **Code**: `src/main/agent-events.ts` (parse the tasks by white-list, hold them in `HeldWait`, apply the replace and
  clear rules, report a change in the drain result); `src/main/agent-wait.ts` (an accessor, the snapshot's change
  flag; `forgetRequests` already resets `HeldWait`); `src/main/remote-protocol.ts` and `remote-host.ts` (the
  `background` field); `src/main/index.ts` (announce the list on a background change).
- **Docs**: `docs/remote-protocol.md`; `docs/lessons/transcript.md` (the measurements above); the website's
  remote-access page in English and Traditional Chinese.
- **Tests**: unit tests for parsing, the fold, the wait accessor and the host's list; a `probe:remote` section acting
  as the phone; `scripts/scenario-coverage.test.mjs` entries.
- **Protocol**: version 1, additive. No new operation, so the operations list and its document test are unchanged.
- **No new dependency, no new network surface, no new disk location, no new hook.**
- **Out of scope**: showing background work on the desktop's own views; scheduled wake-ups (`/loop`, cron tasks);
  what holds a turn open (a finding about MCP monitors is recorded in design Risks); the Android app (its own change,
  from the shape this one fixes).
