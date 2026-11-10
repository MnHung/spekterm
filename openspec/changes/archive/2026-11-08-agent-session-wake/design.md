## Context

Session commands (`agent-session-control`) are parsed in `src/main/handoff-delivery.ts` (`CommandKind`,
`parseCommand`) and judged and carried out in `src/main/session-control.ts` (`SessionControl.deliver` → `#carryOut`
→ `request(HostAction)` → `requestRenderer` → `RemoteRequests.tsx`). `HostAction` already has a `wake` kind: a paired
device's wake goes through the same renderer handler, which calls the desktop's own `wake(sessionId, { quiet: true })`
(`sessions.tsx`). That function already deduplicates a second start (`waking`), keeps a failure on the dormant screen
(`wakeError`), and makes the arrival quiet (`quietArrivals`). So this change adds no IPC and no renderer path: it adds
a command kind, a reach rule, and introduction text.

The relations file (`handoff-relations.ts`, `relationsOf`) lists the parent (the existing session whose id is the
source's `lineage.parentId`), the siblings (existing sessions with the same `lineage.parentId`, the parent existing
or not) and the descendant tree (`ancestryOf` over every record). Command authorization in `deliver` today knows only
the descendant test.

The introduction (`handoff-intro.ts`) is measured against an 8,500-character budget in `handoff-intro.test.ts`
(the CLI swaps an introduction past ~10,000 characters for a 2 KB preview, `docs/lessons/handoff.md` §16). The
longest variant measures 8,444 today: a 56-character margin.

## Goals / Non-Goals

**Goals:**

- An agent can start a dormant parent, sibling or descendant, so that it can then message it.
- "Listed in the relations file" and "may be woken" cannot disagree, by construction (D1).

**Non-Goals:**

- Waking on message delivery (spekterm does not carry messages; Claude Code does).
- Any limit on how many sessions an agent wakes (the user's decision, as with handoffs).
- Changing close, hibernate or rename's reach.
- A device- or desktop-side notice for a successful wake.

## Decisions

### D1 — A wake may target exactly the names the relations file lists

`SessionControl` gets one more injected fact, `relativeNames(sourceId)`: the fixed names in
`relationsOf(sourceId, currentRelationsWorld(...))` — the parent's `name`, each sibling's `name`, and every `name`
in the `children` tree, flattened. `index.ts` wires it from the same world the relations file is written from. A
wake's target is accepted only when its name is in that set; it is then resolved to a session id through
`commandWorld`, as other commands are. "Listed in the relations file" and "may be woken" are then one computation,
not two kept equal by a test.

*Alternatives*: (a) re-derive parent and siblings inside `session-control.ts`; (b) a shared `reach.ts` predicate used
by both `relationsOf` and the wake, held equal by a parity test. Rejected: (a) is a second copy of "who is a sibling"
(with its "a gone parent still counts" rule); (b) cannot be checked by a control group — widening the shared
predicate widens both sides and the parity test stays green (review finding).

Known duplication left in place: `commandWorld` (`index.ts`) and `relationsOf` each compute existence with the same
`sessionExists` call. The wake's reach no longer depends on the former; extracting one helper is not this change.

### D2 — A wake is carried out at once, and only when the target has no process

`parseCommand` accepts `wake` and reads only `target` (no `name`). In `deliver`, a wake is judged after the
target is resolved:

- no target, or the source's own name → `DONE` (accepted, nothing done);
- the source no longer exists → dropped silently (nothing to reach it for);
- not in the reach of D1 → `CONTROL_NOT_ALLOWED`; no such name → `CONTROL_TARGET_NOT_FOUND` (existing codes);
- written before the target's last process change or the run's start → dropped (D4);
- target running → `DONE`;
- otherwise `#carryOut` with `{ kind: 'wake', sessionId }` behind the same `whenReady` gate, re-checking existence,
  staleness and "still not running" after the gate.

No turn wait, no `agentEventsEnabled` check: a dormant session has no turn, and nothing is ended. No
`expectCommandEnd` either: that bookkeeping is for ends a command causes.

*Alternative*: go through `remote-host.perform`, which also answers "already running". Rejected: session commands
already call `requestRenderer` directly, and `perform` carries device-only rules (`SESSION_BUSY`).

### D3 — No confirmation; visibility is the session's own state

The user chose that a wake is carried out without asking. A successful wake produces no notification and no inbox
trace: the woken session shows running on the rail, in its tab and in the paired devices' list, which is where the
user looks for it. A refused or failed wake is visible exactly as other failed commands are.

*Alternative*: an inbox trace for each successful wake. Rejected: the inbox lists things that need the user, and a
wake the user allowed in advance does not.

### D4 — A wake yields like close and hibernate

The staleness rule (`#stale`: file mtime older than `lastProcessChangeAt` or `runStartedAt`) applies unchanged.
A user's hibernation after the agent wrote the wake is a later decision; a wake left unread at quit is about a
conversation that is no longer going on. The agent sees the target still `"running": false` and can write again.

The agent is told what a dropped wake looks like: accepted, and the target still not running a while later. It is
told to ask the user before waking it again, so a user's hibernation is not undone by the agent's next attempt.

Consequence: a wake's own start is a process change, so a close or hibernate of the same target **written before
the wake took effect** yields to it. Only a descendant can be both woken and closed by the same agent, and only by
writing both within moments; that order is accepted rather than special-cased.

### D5 — Restart-pending and canary-held sessions

A session restored as "was running" but not started yet (its turn in the restart queue, or held by the first-agent
canary or the missing-environment guard) is dormant to the relations file. A wake of it goes through the same
`wake`, which starts it once (`waking`) — the behavior a user's wake has (`session-persistence`: "SHALL NOT start it a
second time"). A wake of a canary-held session starts that one session; if it fails, the failure is an individual
one shown on its dormant screen and as a failed command. The guard keeps the *automatic* start from repeating a
systemic failure; an agent's request is not automatic in that sense.

### D6 — Introduction text within the 8,500 budget

The command paragraph is rewritten to state four commands, the two reaches, and that a wake is at once and needs no
confirmation; the relations paragraph replaces "you must not try to wake it yourself" with the wake, how to tell the
woken session is reachable (relations entry `"running": true`, then its name in `ListAgents`), that a parent is not
woken only to report, and that a wake that did not take is not repeated without asking the user. The other sentences
of the paragraph are tightened without dropping a rule. A draft of exactly that (below) measured **+24 characters**
against the current lines, so the longest variant lands near 8,468 of 8,500: **the budget is not raised**, and
`agent-handoff-source`'s budget requirement is untouched. The draft is a starting point; task 2.2's budget test is
the authority.

```
You can also ask spekterm to close, hibernate, rename or wake a session: write one of these into your outbox, by the same rules:
  {"kind": "close"}
  {"kind": "hibernate"}
  {"kind": "rename", "name": "<new label>"}
  {"kind": "wake", "target": "<name>"}
With no "target" a command acts on your own session. "target": "<name>" takes a name from your relations file: close, hibernate and rename only one in your "children" tree; wake also your parent and siblings.
Close removes the session. Hibernate ends its process, keeping it dormant. Wake starts a dormant one at once, without asking the user.
Close and hibernate wait until the target ends its current turn (make one on your own session your last action), are dropped if the user types into it first, and need agent event reporting to be on for a running target.
Closing your own session only offers the user to close or keep it, once your reply ends.
Rename takes effect at once and changes only the label. "name" is at most 200 characters, on one line; empty gives naming back to the terminal title. No messaging name changes.
A receipt says a command was accepted, not that it was carried out. Your relations file shows the result: a closed session is gone, a hibernated one has "running": false, a woken one "running": true, a renamed one the new "title".
…
A session listed with "running": false has no process and cannot receive messages: it was hibernated, or not started again yet after a restart. To reach it, wake it; message it once it is "running": true and its name shows in ListAgents. Do not wake a parent only to report: a report needs no running parent. Not running a minute after an accepted wake: it was put back to sleep; ask the user before waking it again.
```

**Unmeasured**: how soon after a `claude --resume` start its name is reachable through Claude Code's messaging. The
introduction tells the agent to check `ListAgents` rather than promising a delay; a dogfood measurement (task 5.2)
decides whether the wording needs a stronger "wait".

## Risks / Trade-offs

- [An agent wakes many sessions, each a `claude` process] → No limit by the user's decision; automatic hibernation
  (idle threshold) returns them to sleep. Recorded, not mitigated.
- [A woken session is recorded as running, so it starts again after a restart] → The same as a user's wake; the
  record is main-owned at spawn (`restore-running-sessions`).
- [The woken session's name is not yet reachable when the agent sends] → The introduction says to check
  `ListAgents`; the measurement in task 5.2 may tighten it. A message that fails says so to the agent (the screenshot
  that motivated this), so the failure is not silent.
- [A wake is not entirely lossless] → A `--resume` that exits within moments self-heals into a **new** conversation
  (`terminal.ts`), and one that cannot start at all ends. The user's own wake has the same risk; an agent's wake can
  now meet it while nobody watches. Recorded, not mitigated: the self-heal is the existing recovery.
- [An agent repeats a wake the user undid] → The introduction tells it to ask the user first (D4); an agent that
  ignores that can still undo a hibernation, which is the cost of "no confirmation".
- [The wider reach is mistaken for a wider reach of close/hibernate] → The reach rule of those three is renamed to
  name them, and the shared predicate is used only for the wake.
