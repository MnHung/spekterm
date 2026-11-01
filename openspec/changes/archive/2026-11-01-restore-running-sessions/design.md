## Context

See proposal.md for why. The pieces this change stands on:

- **Restore** (`session-restore`, `session-hibernation`): `sessions.json` is written by `SessionStore`
  (`src/main/session-store.ts`). The renderer sends its list (`persist` → `replace()`); a short white-list of
  fields is **main-owned** (`claudeSessionId`, `cwd`, `lineage`, `peerName`, `completion`) — the renderer cannot
  write them, `replace()` keeps them, `parseSessionEntry` validates them on read. The `restore` handler
  (`src/main/ipc/terminal.ts`) returns every entry minus the fields the renderer must not see; the renderer
  (`sessions.tsx`) turns each into a `dormant` session.
- **Nothing on disk says whether a session was running.** A hibernated session "is persisted exactly as a
  restored-but-not-woken one already is" (`session-hibernation` proposal).
- **The pty exit reasons** (`ExitReason` in `src/main/terminal.ts`): `self` and `killed` remove the session from
  persistence; `hibernated` keeps it; `disposed` (window closed, renderer reloaded, application quitting) keeps
  it and is explicitly "not an ending". Every spawn — create, wake, self-heal after a failed resume — goes
  through `#spawn`, which calls the sink's `spawned` once the pty object exists.
- **A quiet wake already exists**: a paired device's wake runs `wake(sessionId, { quiet: true })`
  (`RemoteRequests.tsx`), which starts a session without changing selection or focus, displayed or not.
- **Every session's `TerminalView` is mounted**, displayed or not (`MainStage.tsx`). A shell's snapshot is
  replayed into its xterm on mount; live output that arrives first waits in a backlog and is attached only after
  the replay's write completes, so a new process's output never lands inside the history.
- **A terminal that has never been displayed has never been measured**: its xterm sits at the default 80×24, and
  it must never be fitted while hidden (`docs/lessons/terminal.md`, "隱藏的終端絕不可被 fit"). A pty started by
  a wake spawns at the main process's `INITIAL_COLS`×`INITIAL_ROWS` (80×24); `TerminalView` sends the terminal's
  size when the status becomes `running` and fits on first display.
- **A shell writes its snapshot only while it has a pty** (`TerminalView`, the guard that keeps a never-woken
  shell from re-serializing its replayed history at 80 columns). A shell started while hidden is `running`, so
  that guard no longer stops it.

## Goals / Non-Goals

**Goals:**

- Record, in the main process, whether each session had a running process, so that it survives any way the
  processes are ended without the session ending (quit, crash, window close, reload).
- After a restore, start exactly the sessions recorded as running, through the path an explicit wake takes —
  without taking the user's focus or leaving it nowhere, without starting a session twice, and without turning one
  systemic failure into one failure per session.
- A shell started while hidden does not overwrite its saved screen with an unmeasured one.

**Non-Goals:**

- Keeping processes alive across a restart (PRD §11's deliberately-not-done resident sessions). A session that
  starts again is a **new** process: a `claude` resumes its conversation, a shell gets a new shell in its last
  directory. A build or dev server that was running is not restarted.
- A setting to turn this off. Hibernating a session is already the way to say "do not start this one"; a switch
  can be added later without changing the record.
- Resuming an agent's interrupted turn. `claude --resume` resumes the conversation, not the turn.
- Rewording every existing scenario whose precondition is "reopened and woken" (`session-persistence`'s cwd,
  resume and heal scenarios; `global-session`'s resume scenario; `side-panel-source`). Their outcome is the same
  whether the session started again or was woken; the probes that carry them now observe a session that started
  again (or hibernate it first where the scenario is about the wake itself), as listed in tasks.

## Decisions

### D1. The record is a main-owned field, `running`, set on spawn and cleared on hibernation

`PersistedSession` gains `running?: true` (absent = not running). It joins `MainOwnedField`, so the three
main-process places named at that type change: the type, `replace()` (taken from the pending main fields,
the existing entry or the provisional one — the same three sources `claudeSessionId` and `cwd` use), and `parseSessionEntry` (only the literal `true` is accepted; anything else is absent).
It does **not** go into the fourth white-list, the renderer's restore mapping into `SessionState` — the renderer
consumes it once (D3) and does not keep it.

It is written through a small module free of `electron` (`src/main/session-running.ts`), so its rules are unit
testable — `src/main/ipc/terminal.ts` cannot be imported under node:test. The sink and the IPC handler call it:

- `spawned(sessionId)` → `running: true`. This covers create, wake (explicit or quiet) and the self-heal respawn.
- the `hibernate` IPC handler, **when `service.hibernate()` returns true** → `running` removed, synchronously.
  Waiting for the pty's exit is not enough: the hibernated pty leaves the service's map at once, so `dispose()` at
  quit does not wait for it, and the main process may end before its `onExit` arrives — the session the user just
  hibernated would then start at the next launch. The exit with reason `hibernated` clears it again (idempotent).
- exit with `disposed` → **untouched**. The window closing, the renderer reloading and the application quitting
  all end ptys this way, and the record must say what was running before that.
- exit with `self` / `killed` → the session is removed from persistence already.

`SessionStore.update()` gains `running` in its patch type. It already handles an entry that is provisional or not
yet in the list (the pending-main-fields path), the case of a just-created session whose `spawned` arrives before
the renderer's first `persist`.

**`releaseRenderer` flushes before it drops provisional entries.** Today it calls `sessions.dropProvisional()`
before `flush(service, sessions)`; a session created in the last ~500 ms before a window close or reload has its
main-owned fields only in its provisional entry, so the flush's `replace()` no longer finds them and the session
comes back without `running` (and, already today, without `lineage` and `peerName`). The order is swapped.

*Alternative rejected: the renderer sends its status in `persist`.* The renderer's list is written on a debounce,
and the moment that matters most — quitting, or the application being killed — is the one where the renderer
cannot be relied on. The renderer also sees a hibernation slightly late. The main process sees every spawn and
every hibernation synchronously.

*Alternative rejected: write the set of running sessions at quit.* A crash never reaches a quit handler, and the
spec requires the abnormal end to behave like a normal one.

*Alternative rejected: record `hibernated` instead of `running`.* Then a record without the field — every
`sessions.json` written before this change, and every seeded fixture in the probes — would mean "running", and the
first launch after upgrading would start every session the user had hibernated (the case that motivated
hibernation was 22 `claude` processes, 6.9 GB). With `running`, absence means dormant.

### D2. The restore answer carries it

The `restore` handler already spreads the rest of the entry; `running` is not a path and not a secret.
`RestoredSession` (which omits main-owned fields) gets it added explicitly.

### D3. The renderer starts them after the restore commits, with a launch mark and a canary

In `sessions.tsx`, the restore `.then` records the ids whose entry has `running`, in persisted order (a ref). An
effect gated on `restored` (and a ref gate for StrictMode's second run, as the restore effect has) walks them.

- **After the commit**: the sessions' views mount in the commit that adds them, and a shell's replay starts on
  mount; the backlog-then-attach order in the terminal wrapper keeps the new process's output after the replay
  whatever the timing, so starting after the commit is enough.
- **Skip what the user already took**: before each start the walk reads the latest state and skips a session that
  is gone, no longer dormant, or **already in the `waking` set** (the user pressed Wake). A user's Wake that comes
  after the walk's start is a normal `wake()`: it clears the launch mark and returns early on `waking`, so the
  arrival focuses as after any explicit wake, and nothing starts twice.
- **A launch mark, not the device's quiet mark.** The walk calls `wake(id, { launch: true })`, which sets a
  per-session launch mark that `focus()` does **not** clear (the device's quiet mark is cleared by `focus()`,
  which would let a user's click during the wake turn the arrival into a focus grab). On the dormant → running
  arrival, a view that is active and not covered and takes the launch mark focuses its input **only when
  `document.activeElement` is `<body>` or null** — focus is nowhere. Measured in this repo's Electron (Chrome
  150): removing the focused Wake button blurs it synchronously, so by the time the arrival effect runs the
  focus is already on `<body>` — "focus was on its Wake button" cannot be observed, "focus is nowhere" can, and
  it is the condition that matters (typing would go nowhere). The device's quiet wake is unchanged
  (`remote-protocol`: its arrival SHALL NOT take focus).
- **Systemic failure: the user's environment, then a canary.** If the agent cannot start at all (the user's shell
  environment timed out at a cold boot and `PATH` lacks `claude`; the CLI was uninstalled), each `claude` exits at
  once; the resume-failure heal (`RESUME_FAILURE_WINDOW_MS`, 3 s) replaces its persisted conversation id with a
  fresh one, the fresh one exits too, and the session is removed from persistence as an ending. With an explicit
  wake that happens to one session the user is watching; automatically it would happen to every session, every
  slow boot. Two guards:
  1. **Environment.** `wake(id, { launch: true })` reaches the main process as an automatic wake. For a `claude`
     target the main process waits for the user-environment resolution (it already does, `whenUserEnvReady`) and
     **refuses with a distinct code when the resolution failed or timed out** (`user-env.ts` exposes that state;
     `startUserEnvResolution` already knows it). A resolution that was **skipped** (an unsupported shell or
     platform) is not a failure: those users always run with the desktop's environment, and refusing would mean
     their agents never start again on their own. The walk then starts no further `claude` session; each that is
     left gets a `wakeError` from the dictionary saying it was not started because the shell environment could not
     be read. Shell sessions still start.
  2. **Canary.** The first `claude` session the walk starts is watched from the moment its `wake` resolves (the pty
     exists) for 7 s — two heal windows plus a margin. **Only `status === 'exited'` stops the walk** (the heal's
     final `self` exit is what the renderer sees). If the user closes or hibernates the canary in that time, or
     its process cannot be created (`fail()`), it is not a systemic failure: the next `claude` becomes the canary.
     When the walk stops, each remaining `claude` session gets a `wakeError` saying it was not started because the
     first one could not keep running; its record stays `running`, so the next launch tries again. Shell sessions
     are not held back by the canary.
  After the canary survives, the rest start back to back.
- **A failure to create the process** (directory gone) goes through `wake`'s existing `fail()`: the session stays
  dormant with its reason, Wake is the retry, the record stays, and the walk continues.

*Alternative rejected: start them from the main process.* The renderer is the authority on sessions
(`remote-access`), and the wake path — waking set, `wakeError`, focus marks, status transition — lives there.

*Alternative rejected: reuse the device's quiet mark and add the focus exception there.* `remote-protocol` says a
device's arrival takes no focus, without exception, and `focus()` clears that mark — the user's click during the
wake would make the launch arrival take focus.

*Alternative rejected: wait for each agent's readiness (`SessionStart`) before the next.* It needs agent event
reporting, which can be turned off, and it serializes a dozen agent startups for no gain once one has shown that
the agent can start.

### D4. Reload and the macOS window behave like a restart, with no extra code

A renderer reload and closing the window on macOS end the ptys with `disposed` and then run the same restore, so
the sessions that were running start again there too.

### D5. Size: a hidden start spawns at the default size, and a hidden shell does not save its screen

A session started while not displayed has no layout box, and `terminal-sessions` forbids deriving a size without
one: it spawns at 80×24, exactly as a session a paired device starts or a handoff opens in a folder that is not
selected. The first display fits it and resizes the pty (`TerminalView`'s activation effect, `!wasActive`).

- **The shell snapshot guard is extended.** A shell writes its snapshot only while it has a pty; a shell started
  while hidden has one, but its xterm holds the replayed history at the never-measured 80×24, so a snapshot then
  would rewrap that history and add a replay separator at every restart (the case the existing guard was written
  for). The guard becomes "has a pty, **and** this view has not replayed a restored screen that it has not
  measured since". Until it is displayed the saved screen stays the one from before the restart; the cost is that
  a shell started and never displayed before the next quit loses what it printed in between (one prompt, unless
  something was run in it from a device). A shell created hidden (a device's create) replays nothing, so its
  snapshot is unaffected: its xterm and its pty are both at 80×24.
- **The cost for `claude`:** what Claude Code prints before the first display (the resumed conversation) is laid
  out at 80 columns in the terminal view's history. Whether Claude Code redraws it on the resize is not measured;
  the conversation view reads the transcript and is unaffected. This is the cost a handoff into an unselected
  folder already pays today.

*Alternative rejected (for this change): persist the terminal's last measured size and spawn hidden sessions at
it* (this design's second draft). `docs/lessons/terminal.md` ("尺寸那一條為什麼不能用「記住上次的值」解決")
rejected exactly that, and `terminal-sessions` forbids changing a terminal's rows and columns without a box. Doing
it right needs more than a stored value: only a real `fit()` may record it (the main process's resize sink also
receives the 80×24 a hidden running terminal reports, e.g. after a handoff opens in the background), the DOM and
webgl renderers measure different column counts for the same box, and the stored value is stale whenever the
window changed. It is a decision of its own, about all hidden starts (handoffs and device starts too), and is left
to a follow-up if the 80-column history proves a nuisance.

### D6. Interaction with automatic hibernation, agent commands and the introduction

- A session started at launch gets a fresh idle clock (the clock starts at spawn). Accepted: persisting the clock
  is out of scope.
- An agent's close or hibernate command written before the current run is already dropped
  (`agent-session-control`); only the recorded gap's wording changes.
- **The handoff introduction changes.** It says a relative listed with `running: false` "is hibernated … comes back
  when the user wakes it; spekterm will not start it for you". After a restart, sessions waiting for their turn (a
  few seconds; longer behind the canary) and sessions left dormant by a failed start are listed as not running too,
  and the first kind is started by spekterm. The sentence becomes: listed as not running means no process now —
  hibernated, or not yet started again after a restart; it comes back when the user wakes it or spekterm starts it
  again; do not try to wake it. `session-hibernation`'s requirement on the introduction changes accordingly. The
  introduction must stay under the CLI's 10,000-character threshold (`docs/lessons/handoff.md` §16); the change is
  a few words.

### D7. The close and restart dialogs stop promising a wake

The close-confirmation copy (`closeConfirm.consequence*`, and the update restart's `consequenceRestart*`, in both
dictionaries) says sessions resume "when you wake them". After this change the sessions that dialog lists — every
one holds a running process — start again on their own. The copy changes to "when spekterm opens again" /
"when the window opens again" / "when spekterm starts again with the new version", per variant.

## Risks / Trade-offs

- [Many `claude` sessions start within seconds after a restart, costing CPU and memory] → they were all running
  before the restart, so steady-state use is unchanged; hibernation (manual or by the idle threshold) is what keeps
  the set small. The walk is no throttle beyond the canary.
- [A systemic failure the environment check does not see (the CLI uninstalled) costs the canary session: its
  conversation id is replaced and the session removed] → the outcome an explicit wake has today, limited to one
  session per launch; the cold-boot environment timeout, the likely recurring case, starts no agent at all.
- [The resumed conversation of a `claude` started while hidden sits at 80 columns in the terminal view's history]
  → an existing cost of every hidden start (handoffs, devices); left to a follow-up decision (D5).
- [The first launch after upgrading starts nothing, so the feature looks broken once] → stated in the release
  notes; from the second launch on it works.
- [Closing the app now almost always asks, since sessions keep running] → the dialog was already shown whenever a
  session ran; stated in the release notes.
- [Probe sections that relaunch or reload and then click Wake throw "no Wake button"] → tasks list each section;
  each asserts the new behavior, and a section that is about the wake itself hibernates first.

## Migration Plan

No data migration: the field is additive, and its absence means "dormant", the behavior of every earlier
version. Rolling back ignores it (the entry white-list drops it) and writes the file without it.
