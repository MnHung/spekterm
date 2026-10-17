## Context

The main process already evaluates the wait state of every running agent session. `HibernationTracker` subscribes
to each claude session for its whole running life (`hibernation.ts`, tracked at create and wake), so `agent-wait.ts`
drains every running session's events every 400 ms, and `observeWaits` sees every drained batch together with the
state before it. Each `WaitSnapshot` also carries `inTurn` (`inTurnOf`: an own `UserPromptSubmit` or any keystroke
since the last turn end), `turnEnded` (the batch held a `Stop`) and the open `requests`, each with its `at`.

Three consumers read it today: the conversation view (one session, through a follow), the remote session list and
attention log (`remote-host.ts`, `remote-attention.ts`), and the handoff lifecycle (`handoff-lifecycle-view.ts`,
lineage sessions only). The renderer's status dot (`session-badge.tsx` `StatusDot`) reads none of it: it shows the
pty's running / dormant / ended state.

The main process also already knows what the user is looking at:

- `displayedSessionOf(contentsId)` (`ipc/terminal.ts`, backed by `HibernationTracker`): the renderer reports its
  displayed session (`MainStage.tsx`, the same test as a terminal's `active`).
- `displayedInFocus` in `index.ts`: that session, in the window that has focus. The attention log's `suppressed`
  is built on it.
- `HibernationTracker.setRemoteWatched(key, id)`: a device's watches, keyed `remote:<connection>:conversation` and
  `remote:<connection>:terminal` (`remote-protocol.ts`). The phone holds `conversation.watch` only while the
  conversation screen is visible. It watches on Android `ON_START` and unwatches on `ON_STOP`, which covers
  backgrounding and screen lock (confirmed by the spekterm-android session and `ConversationScreen.kt:138-142`).
  The phone does not use `terminal.watch`.

Measured facts this design rests on (`docs/lessons/transcript.md`, and the reviewer's runs of `drainEvents` in a
scratch harness):

- A background subagent's `PreToolUse` can arrive after the turn's `Stop` (1 run in 5). `apply` sets the base to
  `busy` whatever the `agent_id`, so the state goes `ready` → `busy` with `inTurn: false`, and nothing follows.
- A denied permission prompt (Esc or No at the desktop) reports nothing. The state stays `awaiting-choice` until
  the next turn event.
- An interrupted turn (Esc) reports nothing for at least 70 s, not even `idle_prompt`.
- The user's `/compact` ends with `SessionStart(compact)`, with no `Stop` and no `UserPromptSubmit`. The user's
  keystrokes make `inTurn` true, and `manualCompact` makes the `SessionStart` end the turn.
- An automatic compaction inside a turn goes `busy` → `ready` with `turnEnded: false` and `inTurn: true`.
- A real claude start or resume reports `SessionStart` only. The probe stub (`scripts/lib/stub-agent.mjs`) fires
  `SessionStart` and then `Stop` at startup, so its first batch is `unknown` → `ready` with `turnEnded: true`.
- `pty-input.ts` keeps a session's last keystroke for the app's life (`forgetInput` has no caller), and `clearWait`
  on hibernation drops `turnEndAt`. So after a wake, `inTurnOf` is true until `SessionStart(resume)` arrives; a user's
  `/clear` likewise passes through `inTurn: true`. `noteWrite` counts every pty write except a device's answer and
  terminal reports as a keystroke — including a prompt spekterm writes (a handoff's first prompt, a device reply).

## Goals / Non-Goals

**Goals:**

- Every running agent session's dot says whether it needs the user, on the rail and on the tabs.
- "Needs the user" means something new: an unanswered choice, or a finished turn no one has seen.
- The desktop and the phone answer the same question the same way, from one owner.
- "Waiting for you" means one thing across the application, in the session dot and in the handoff lifecycle.
- A collapsed rail item still says that something inside it waits.

**Non-Goals:**

- Attention events (`remote-notifications`) are unchanged: `waiting` is raised on a `Stop` and `suppressed` works
  as today. A `StopFailure` therefore makes the dot "waiting for you" but raises no phone notification. That gap
  exists today and is not widened here. The phone decides on its own whether a `seen` flip withdraws its
  notification.
- No desktop notification for a finished turn, and no sound.
- The seen mark is not persisted.
- The phone's own presentation belongs to spekterm-android's `session-relations` change.

## Decisions

### D1. The seen mark lives in the main process, in its own module

`src/main/wait-seen.ts` holds a `SeenMarks` class with an injected `isLookedAt(sessionId)`. Per session it keeps
two things: membership in the **unseen** set, and the previous batch's `inTurn` (`wasInTurn`).

`onBatch(sessionId, snapshot)` is called from the existing `observeWaits` observer. Rules 1–4 decide the mark;
step 5 runs **on every batch, pokes included**:

1. `snapshot.poke` → no change to the mark. A poke is a device's answer or dismissal, or a keystroke, and in each case
   the user acted.
2. `snapshot.inTurn` → remove from the set. A turn is in progress, so there is nothing to see yet.
3. `snapshot.state === 'ready'`, not `inTurn`, and a turn ended: `turnEnded`, or `wasInTurn` **unless the batch holds
   a non-compaction `SessionStart`** (`snapshot.sessionStarted`, new). This is a **turn end**: add to the set unless
   `isLookedAt(sessionId)`, in which case remove.
4. Anything else → no change. This covers `unknown` → `ready` by `SessionStart` (a start, a resume, a wake, a
   `/clear`), a late subagent `busy` with `inTurn: false`, and `unknown`.
5. Record `wasInTurn = snapshot.inTurn`. (Skipping it on a poke would let a device's dismissal — a poke with
   `inTurn: false` — leave `wasInTurn` true and turn the next tick into a false turn end.)

The method returns whether the session's seen value changed. `lookedAt(sessionId)` removes the session from the set
and returns whether that changed anything. `forget(sessionId)` drops both values (so `wasInTurn` restarts false) and is
called wherever `forgetRequests` or `clearWait` is called.

**`sessionStarted`** is a new `DrainResult` / `WaitSnapshot` field: the batch held a `SessionStart` whose source is not
`compact`. It exists because the stale keystroke (Context) makes `inTurn` true between a wake and its
`SessionStart(resume)`, and through a `/clear`; without it, `wasInTurn` would turn every quiet wake into "waiting for
you". The other fix — calling `forgetInput` on `clearWait` — is rejected: `agent-session-control` reads the last
keystroke to cancel a pending close. `seenOf(sessionId)` is `!unseen.has(sessionId)`.

**Why `!inTurn` in rule 3:** an automatic compaction is `busy` → `ready` while the turn is still in progress, and it
must not pulse. **Why `wasInTurn` and not "the previous state was busy":** the user's `/compact` has no `Stop` and no
busy state before it, but it has the keystroke turn. A late subagent's `busy` is not in a turn, so going from it back
to `ready` is not a turn end. `turnEnded` still matters for a turn whose keystroke and `Stop` land in the same batch (a
`!cmd`), where `wasInTurn` was never recorded true.

**Why main, not renderer:** the phone must read the same answer, and looking on the phone must clear it on the desktop
(and the reverse). **Why a set of unseen sessions:** absent means "nothing to see", which is the right answer for
every case the rules do not name, including every session after a restart.

### D2. "Looked at" is one function, shared with the attention log

`isLookedAt(sessionId)` is `displayedInFocus(sessionId) || conversationWatched(sessionId)`.

- `displayedInFocus` moves out of the `AttentionLog` construction into a named function in a small module
  (`src/main/looked-at.ts`) with injected `focusedContentsId()` and `displayedSessionOf(contentsId)`, so both halves
  can be unit tested. The attention log keeps reading only the desktop half: its `suppressed` still means "the desktop
  user sees it".
- `conversationWatched` is a new read on `HibernationTracker` that counts **only `:conversation` keys**. A terminal
  watch is a device streaming output, not the user reading the conversation, and `probe:remote` uses it.

The moments a session becomes looked at are wired in the same module, each calling `SeenMarks.lookedAt`:

- the renderer's `displayed` report, when the reporting window is the focused one;
- the window's `focus` event, for that window's displayed session;
- `setRemoteWatched` with a `:conversation` key and a session id.

A turn that ends while the session is looked at is covered by rule 3 asking `isLookedAt` at that moment.

**The maximized side panel** covers the terminal, but the displayed session is still reported (`MainStage.tsx` does
not change it, and automatic hibernation relies on that). It therefore counts as looked at. We accept this: the user
put the panel over their own session, and changing the report would let automatic hibernation take a session the user
is one key away from.

### D3. The attention state is derived once, in shared code

`src/shared/wait/attention.ts` (a subdirectory, so the `test:unit` glob `src/shared/*/*.test.ts` covers its test):

```ts
type Attention = 'choice' | 'waiting' | 'working' | 'idle' | 'unknown'
function attentionOf(input: { wait: WaitValue; inTurn: boolean; seen: boolean; choiceTypedOver: boolean }): Attention
type RowState = Attention | 'error' | 'running' | 'dormant' | 'ended'
function mostUrgent(states: readonly RowState[]): RowState | null
```

- `awaiting-choice` → `choice`, unless `choiceTypedOver`, which is then treated as the `ready` row.
  `choiceTypedOver` is `lastKeystrokeAt(sessionId) > max(request.at)` over the open requests, computed by the main
  projection. It is its own condition, not `promptView`'s answerability (which also weighs the count, `stirred` and
  `answeredAt`). `request.at` is the matched tool start, a little before the prompt is drawn, so typing in that gap
  also counts as answered — accepted (Risks). A keystroke into a session with an open request already pokes
  (`index.ts`), so the projection is recomputed at once.
- `busy` with `inTurn` → `working`.
- `ready`, `busy` without `inTurn` (a late subagent), or a typed-over choice → `seen ? 'idle' : 'waiting'`.
- `unknown` → `unknown`.

`mostUrgent` orders states as the spec does: choice and waiting first, then error, working, running and unknown,
idle, and finally dormant and ended. It returns `null` for an empty list. Both functions are pure and unit tested.
The main projection (D4) uses `attentionOf`, and the renderer's rail item dot uses `mostUrgent`.

### D4. The renderer receives a complete projection, pushed only on change

`src/main/ipc/wait.ts` (new, beside `ipc/handoff.ts`) has two channels, `workspace:wait:list` (invoke) and
`workspace:wait:changed` (push). Both carry `{ sessionId, attention }[]` for every **running** agent session; a
session that is not running has no entry. It follows `broadcastLifecycle`'s pattern and the reasoning in
`ipc/handoff.ts`'s comment: send the whole projection, not a diff, so one lost message cannot leave the picture wrong.

The observer fires every 400 ms for every running session, so the broadcast is **deduplicated**. The module keeps the
last projection it sent and sends only when it differs. The observer runs `SeenMarks.onBatch` **before** it computes
the projection, so an unseen turn end goes out in the same tick. Other triggers recompute too: a `lookedAt` that
changed something, `onPtyChange` (a session starting, hibernating, ending or being removed), and a poke.

A change of projection also calls `remoteService.listChanged('sessions')` (the remote service has its own debounce and
JSON dedup). When a changed session has a lineage it runs the whole `onCompletionChange` path —
`refreshAllRelations()`, `broadcastLifecycle()`, `listChanged('handoffs')` and `listChanged('sessions')` — because the
lifecycle now reads the mark (D6). That path must run **after** `onBatch`: `HandoffCompletion` is a wait subscriber,
and `publish` notifies subscribers before observers, so at a turn end the relations file is first written with the
mark's old value and corrected by this second pass in the same tick.
This also fixes a gap: today, after a device's dismissal, `index.ts` sends no remote list refresh, because its
`state !== previous` test sees `ready` → `ready`.

On the renderer side, `WaitProvider` (`shell/terminal/wait.tsx`) has the same shape as `LifecycleProvider`: it
subscribes first and then calls `list()` once, keeps one subscription for the app's lifetime, and exposes
`attentionOf(sessionId)`.

**Alternative considered:** add the attention to the `SessionState` that the terminal IPC pushes. We rejected it. That
list changes on pty and record events, not on wait ticks, and mixing a 400 ms-sourced value into it would rebuild
every session row's state on every wait change.

### D5. The dots

| State | Look | From the mockup |
|---|---|---|
| asks for a choice / waiting for you | `--color-accent` (amber), glow, pulsing | `.sdot.wait` |
| working | `--color-green`, glow | `.sdot.run` |
| running (unknown) | today's `bg-emerald-400`, no glow | today |
| idle | a hollow ring with a `--color-green` border | **deviates** from `.sdot.idle` (grey) |
| hibernated / ended / ended with error | unchanged | — |

Choice and finished turn share one dot, as the mockup has a single `wait`; the tooltip tells them apart. **Idle
deviates from the mockup.** The mockup's `.sdot.idle` is grey, but grey already means hibernated in this app, and
"alive and resting" must not look like "asleep". This deviation is listed in the proposal for the user's
confirmation. The pulse stops under `prefers-reduced-motion`. The dot keeps its size (`h-1.5 w-1.5`), so the rail and
tab layouts do not move.

`statusTitle` gains the attention: `Running · Asks for a choice`, `Running · Waiting for you`, `Running · Working`,
`Running · Idle`. An unknown state stays `Running`. Existing probes test with `includes(copy('sessions.statusRunning'))`,
which still matches. New dictionary keys go into `en.json` and `zh-TW.json`.

### D6. The handoff lifecycle reads the same mark

`lifecycleOf(completion, wait)` becomes `lifecycleOf(completion, wait, seen)`, changing only the `ready` row:

- `busy` → `working` (unchanged: the **raw** wait state, not the attention's `inTurn`);
- `awaiting-choice` → `waiting` (unchanged);
- `ready` → `waiting` when not seen, `idle` when seen;
- `unknown` → `idle`; `done` unchanged.

Settling and reopening (`onWaitTick`) keep reading the raw wait state. `handoff-lifecycle-view.ts` passes `seenOf`.
Its consumers (the relations file the agents read, the remote `lifecycle` field, and `LifecycleMark`) follow.

**Why raw `busy` here, not the attention:** a child given new work by its parent through Claude Code's messaging, or
driven by a probe's `fire PreToolUse`, may report work with no keystroke and no `UserPromptSubmit`; a lifecycle that
required `inTurn` would never say "working" for it. The cost is two small divergences from the dot — a late subagent
tool start (lifecycle `working`, dot `waiting`/`idle`) and a typed-over choice (lifecycle `waiting`, dot `idle`) —
both short-lived and both on the side of saying more, not less.

**Why:** the lifecycle mark's text for `waiting` is the same "Waiting for you" (`handoffLifecycle.waiting`). If the
mark kept reading the raw wait state, a child the user has already read would show "Waiting for you" beside an idle
dot. There are other options: rename one of the two texts, or hide the lifecycle's waiting on the desktop. Both leave
the word meaning two things. A side effect is that a parent agent reading the relations file sees a child go `idle`
once the user has looked at it. That is accurate: the child no longer waits on anyone.

### D7. The rail item dot

The rail item dot sits on the folder row and on the global item's row, after the session count (`WorkspaceRail.tsx`,
next to the `rail.sessionCount` element), where the mockup places it. It ranks the item's sessions with `mostUrgent`
and shows nothing for an item with no session. The dot is `aria-hidden`. Its state is added to the **row's** `title`
(`rail.mostUrgent`), so assistive technology and probes read it from the row. The row's `aria-label` is not changed,
because probes select by it.

### D8. Protocol: `seen` on `Session`

In `remote-host.ts` `sessionList`, an agent session whose `wait` is `ready` gets `seen: seenOf(id)`, and every other
session has no `seen` field. `docs/remote-protocol.md`'s `sessions.list` section documents the field:

- it is present (true or false) exactly while `wait` is `"ready"`;
- it becomes false again at every unseen turn end;
- what counts as looking: a focused desktop display, or a device's **conversation** watch;
- a missing `seen` on a `ready` session means an older desktop;
- the `lifecycle` `waiting` value now follows it;
- a choice the desktop user typed over (D3) is still `awaiting-choice` in the list: the phone keeps showing it as a
  choice, while its `prompt.answerable` is already false. This divergence is documented, not fixed: the list carries
  the raw wait state, and adding a derived field for one blind spot is not worth a protocol change.

The operation allow-list does not change, so `remote-protocol-doc.test.mjs` is unaffected.

## Risks / Trade-offs

- **[An interrupted turn stays "working"]** Esc reports nothing, and the keystroke keeps `inTurn` true, so the dot
  shows working until the next prompt. The cost is a green dot that should be a ring. It is never a false "waiting",
  and the user who pressed Esc is looking at the session. No event or other signal exists to fix it, so we accept it.
  `docs/lessons/transcript.md` records the measurement.
- **[Typing between a tool start and its prompt]** `request.at` is the tool start, so a keystroke in the moment
  before the prompt is drawn makes the choice read as answered, and the dot shows the ready row. The gap is short;
  the terminal still shows the prompt.
- **[A subagent's denied choice shows idle]** typing over a subagent's prompt marks the choice answered, and the agent
  may keep working with no new event until its next tool start. The dot shows idle for that moment and then working.
- **[A dead phone keeps "looking"]** a device whose network drops without a close is dropped after two missed
  20-second pings (`remote-server.ts`). Until then, about 40–60 s, its conversation watch still counts, and a turn
  ending in that window is marked seen. We accept this: the window is short and the phone is the one showing it.
- **[Observer cost]** `onBatch` runs per session every 400 ms. It is a set lookup and one boolean. The projection is
  compared only when something changed.
- **[Many pulsing dots]** several sessions that finished while the user was away all pulse. That is the signal, and
  each one stops when the user turns to it.
- **[Window focus in probes]** `probe-remote.mjs` treats focus as optional (it checks `document.hasFocus()` and
  records a gap when there is none). The new probe sections do the same, and the focus wiring is unit tested through
  `looked-at.ts` with an injected focus source (D2).

## Migration Plan

None. Nothing is persisted. An older phone ignores `seen`, and a newer phone on an older desktop sees no `seen` and
keeps today's reading.

## Open Questions

None. The idle-ring deviation (D5) and the lifecycle following the mark (D6) are listed in the proposal for review.
