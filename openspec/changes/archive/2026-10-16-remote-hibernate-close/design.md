## Context

The remote protocol (`remote-protocol`, `docs/remote-protocol.md`) lets a paired phone create, wake and rename
sessions. Each is a `HostAction` that the main process sends to the window's interface
(`workspace:remote:request`, `RemoteRequests.tsx`), which runs the desktop's own path for it **quietly**. The
desktop has two more per-session actions that the phone's new session menu needs:

- **Hibernate** (`session-hibernation`). The renderer's `hibernate(sessionId, token?)` serializes a shell's
  screen, then IPC `workspace:terminal:hibernate`. Without a token the request is the user's and always
  proceeds. With one it is automatic, and the main process re-checks `isEligible`
  (`src/main/hibernation-policy.ts`). The pty exits with reason `hibernated`. The record stays persisted.
  Attachments are kept.
- **Close** (`sessions.close` in `terminal/sessions.tsx`). The renderer's `close(sessionId)` sends IPC `kill`,
  forgets the session, and moves the item's focused session to a sibling. In the main process `kill`:
  - ends the pty with reason `killed`;
  - removes the record;
  - removes its attachments;
  - for a dormant session (no pty), clears agent status and events and ends its handoff drop point
    (`ipc/terminal.ts`, the `kill` handler).

  **The desktop's single-session close never asks for confirmation**: the tab's ×, the rail's ×, the menu and
  `Ctrl+Shift+W` all close at once. The text "running commands and any reply an agent is writing are lost"
  belongs to closing the *window* (`maximize-panel-and-confirm-close`), not to closing a session.

Facts this design rests on, read from the code (not measured; the probe measures them):

- `remote-output.ts` `exited(sessionId)` ends every terminal watch of the session with `exited`, whatever the
  pty's exit reason was. `ipc/terminal.ts` calls it for every reason.
- A conversation watch (`conversation-follow.ts` `startFollow`) is stopped only by `conversation.unwatch`,
  another watch, the connection closing, or `windowGone`. Nothing stops it when its session's process ends.
- `conversation.watch` needs a running agent (`TerminalService.agentSourceOf` is `null` without a pty), so a
  dormant session cannot be watched. That is already documented: `NOT_FOUND`, "or not running".
- `TerminalView`'s focus effect focuses the Wake button when its displayed session becomes dormant. It also
  focuses the terminal when a view becomes displayed with an unchanged status. That second case happens when
  the displayed session is closed and a sibling takes its place. `ConversationView` focuses the Wake button
  whenever it is displayed and dormant.
- The `sessions.changed` list is recomputed on `onPtyChange` and on session-store changes (`index.ts`), so a
  hibernation and a close both reach clients without new wiring.

## Goals / Non-Goals

**Goals:**

- A device can hibernate and close any listed session, through the desktop's own paths.
- A device never ends work by surprise: a session that is not idle is refused with the reason, and the device
  must ask again with `force`.
- Neither action takes the desktop's keyboard focus or rail selection.
- A watching client learns how its session ended (exited, hibernated, closed), whoever ended it.

**Non-Goals:**

- The phone's interface (`spekterm-android`, its own change).
- Changing the desktop's own hibernate or close. Neither asks today, and neither starts asking.
- Closing several sessions at once, or "close completed handoffs" from a device.
- The terminal watch's reason on a window reload (`disposed`). It stays what it is today, and the
  conversation's `window` ending is unchanged.

## Decisions

### D1. Two operations, named after the desktop's actions

`sessions.hibernate` and `sessions.close`, each `{ sessionId, force? }` → `{ sessionId }`. `force: true`
forces. Absent, `null` and `false` all mean "do not force" (a client that encodes defaults sends `false`;
`optionalStr` already reads `null` as absent). Any other type is `BAD_PARAMS`.

The result says only that the desktop carried the action out. The new state arrives through `sessions.changed`
(a hibernated session is listed with `running: false`; a closed one is absent), as it does for rename. The
answer does not wait for the list: a client that wants the state reads the event.

They are two new `HostAction` kinds, `hibernate` and `close`. The no-window refusal is the one `perform`
already has, so `NO_WINDOW` comes for free and keeps "no window is opened for a device" in one place. The
fifteen-second `TIMEOUT` comes from `RendererRequests`. An unexpected failure in the interface is `CREATE_FAILED`,
as for every renderer action (`perform` maps any code it does not know to it), and a malformed request is
`BAD_PARAMS`.

**The preload's `narrowRemoteAction`** (`src/preload/index.ts`) passes only the action kinds it knows.
Forgetting to add the two kinds there raises no type error: the renderer receives `null`, and the device
waits fifteen seconds for a `TIMEOUT`. The probe's success paths are what catch it.

### D2. A session that is not idle is refused unless the device forces it

**Decision.** Before asking the interface, the main process checks whether the session is idle. If it is not,
the operation is refused with the new code `SESSION_BUSY`, `detail: { reason }`, and nothing happens. With
`force: true` the check is skipped, and the action proceeds as the desktop's manual one does.

| `reason` | Session | When |
|---|---|---|
| `working` | agent | wait state `busy` |
| `choice` | agent | wait state `awaiting-choice` |
| `unsent` | agent | wait state `ready`, but a filled-in prompt is not yet confirmed sent |
| `unknown` | agent | wait state `unknown` (agent events off, or no event yet) |
| `job` | shell | `/proc` shows a foreground or background job, or the shell replaced itself with another program (`readShellFacts` answers `busy` for both) |
| `unknown` | shell | idleness cannot be read (`/proc` unreadable, a non-Linux platform, or no recorded shell identity) |

The test applies only to a session with a process. A dormant session has nothing to lose: hibernate answers at
once (D3), and close proceeds.

**Why not refuse outright** (as automatic hibernation does)? The user on the phone is the user. The desktop's
own manual action proceeds for a working agent (`session-hibernation`, "The user can hibernate the displayed,
working session"), and a device must not have less power than the desktop. A runaway agent is a reason to
hibernate it.

**Why not allow outright, like the manual action?** The desktop user sees the session they act on. The phone
does not:

- a shell's running job is visible only in `/proc`, which the protocol does not expose;
- an agent's `wait` is in the list, but `unsent` is not.

The desktop is the only side that knows whether something will be lost, so it states it. The phone turns the
reason into a sentence and offers "hibernate anyway" or "close anyway". One round trip happens only when there
is something to lose.

**Why a `force` flag and not a separate confirmation operation?** The phone confirms with its user, not with
the desktop. A token issued with the refusal would add state on the desktop and protect nothing: the device
already has the user's power, and it can type `exit` into the terminal.

**Why `unknown` counts as busy.** This is the automatic policy's rule (fail closed): idleness that cannot be
established is not idleness. With agent events off, every running agent answers `unknown`, so the phone asks
once more. That costs one confirmation, and its alternative is ending work silently.

**The displayed session is not "busy".** Automatic hibernation never takes the displayed session, because the
user may be looking at it. A device's request is the user's, and the user is not at the desktop. Refusing it
because a desktop screen shows the session would make the action fail for the most common target: the session
the user left on screen.

**The wait state is refreshed before the check.** `waitStateOf` returns the last drain of the agent's events,
which runs every 400 ms (`agent-wait.ts`). An agent that raised a permission prompt a moment ago can still
read `ready`. `perform` therefore calls `refreshWait(sessionId)` first, as the `answer` path already does.

**The remaining race is accepted.** After the refreshed check, an agent that starts working during the round
trip to the interface (milliseconds when the window answers) is hibernated or closed anyway. That is what a
forced request does, and the desktop's manual action has no check at all.

**On macOS every shell is `unknown`** (`readShellFacts` reads `/proc`, Linux only), so every shell hibernate or
close from a phone there is refused once and then forced. This is accepted for the same reason: the desktop
cannot tell whether a command is running there, and the automatic policy never hibernates those shells either.

### D3. One definition of "not idle", shared with automatic hibernation

The rows of D2 are exactly the session-specific part of `isEligible` (`hibernation-policy.ts`). That function
also checks two conditions that are not about the session: displayed, and the idle threshold. They move into a
pure function:

```ts
export type BusyReason = 'working' | 'choice' | 'unsent' | 'unknown' | 'job'
export function busyReason(input: { target; wait; unconfirmedSubmission; shell }): BusyReason | null
```

`isEligible` becomes "not displayed, past the threshold, and `busyReason(...) === null`". Its existing unit
tests stay as they are and must pass unchanged. That proves the refactor kept the policy. If the two were
separate copies, a future rule added to one (a new wait state, say) would leave the other answering the old
question, with no failing test.

`RemoteHost.perform` gets the inputs from the facts the main process already holds:

- the terminal service: `sizeOf` (whether there is a pty) and `idleFactsOf` (target and shell facts);
- `waitStateOf`;
- `hasUnconfirmedSubmission`.

`remote-host.ts` imports `waitStateOf` and `refreshWait` at module level today. They move into `HostDeps`,
together with `hasUnconfirmedSubmission` and the service's `idleFactsOf`, so each refusal reason is
unit-tested by injecting its facts rather than by driving the module-level wait state. `index.ts` passes the
real functions. **The check lives in the main
process, not the renderer.** The main process holds the pty and the `/proc` facts. The renderer's status can
lag a hibernation (the same reason `perform` answers a wake of a running session itself).

**A dormant session's hibernation answers at once**, in `perform` (no pty and a record → `{ sessionId }`),
mirroring "a running session answers `sessions.wake` at once". It is not an error: the phone's menu may be a
moment behind the list, and the state the user asked for holds.

`NOT_FOUND` comes from the session store: a session with no record. A session whose process exited on its own
is removed from the store at its exit, so it is `NOT_FOUND` too. It is not in the list the device sees either.

### D4. The renderer runs the desktop's paths, quietly

`RemoteRequests.tsx` gains two branches.

- **`hibernate`**: the desktop's `hibernate(sessionId)` path, so a shell's screen is serialized before the
  process ends, with no token (it is the user's request). It must report back, so `hibernate` returns a
  promise of the main process's answer. The existing callers ignore it. The main process already confirmed a
  pty. If the renderer's status has not caught up (a wake moments ago), the remote branch still sends the
  hibernation and skips the snapshot rather than doing nothing. `{ ok: false }` from the main process means the
  pty is already gone. That is answered as success when the session is dormant in the renderer, and as
  `NOT_FOUND` when it is `exited` (its process exited on its own between the main process's check and the
  interface). Otherwise the phone would believe it can wake a session that no longer exists.
- **`close`**: the desktop's `close(sessionId)`, then the reply. `kill` is fire-and-forget. The record's removal
  is what `sessions.changed` reports.

An unknown session is `NOT_FOUND` in the renderer too, in case the main process and renderer disagree for a
moment, as in rename.

**Quiet.** Neither action changes the rail selection, by construction: neither path touches it. Two focus moves
must be held back:

1. **Hibernating the displayed session.** Its view focuses the Wake button when the session becomes dormant.
   The terminal view remounts under a new key at that point (`generation`), so it is its first evaluation.
   The conversation view sees `dormant` turn true.
2. **Closing the displayed session.** The item's next session becomes displayed. Its view becomes active with
   an unchanged status, and `TerminalView` focuses it; a dormant one focuses its Wake button.

**The existing quiet-arrival mark is the wrong tool for these.** That mark (`takeQuietArrival`) is consumed
only when a view asks for it, and a view asks only when it would focus. A mark for a view that never asks
lingers until `focus()` clears it. But selecting a rail item or switching the view mode does not call
`focus()`. A lingering mark would then swallow the focus of a later activation the user caused. The review
found that the quiet wake already leaves such a mark for the conversation consumer when that view is not
mounted. That is harmless today only because the conversation view asks just on dormant → running. Making
views ask on activation would turn it into a defect. And "mark only the displayed view" cannot be implemented
where the mark is set: which session is displayed, and in which mode, is known only to `MainStage`.

**Decision: a separate mark whose lifetime is one commit.** `sessions.tsx` gains a set of sessions whose next
focus is held, `holdFocus`. A quiet hibernation or close adds to it **in the same state update that makes the
transition**:

- for a hibernation, in the hibernated-exit handler, which sets the session dormant. The remote branch records
  the session as quietly hibernated **before** it sends the IPC, so that the handler knows. The record is
  cleared when that IPC answers `{ ok: false }` (no exit will follow), and by `wake` and `close`. Otherwise a
  leftover record would make the user's own later hibernation of that session quiet;
- for a close, inside `close()`, for the session that becomes the item's focused session (or for its first
  session, which is what `focusedIdFor` falls back to).

A view's focus effect reads it (`isFocusHeld(sessionId)`, without consuming) and skips its own focus. That
holds for any trigger, arrival or activation. `isFocusHeld` is a stable callback backed by a ref. If it were
backed by state, it would enter the effects' dependencies and re-run them in the next commit, which would then
focus.

**Clearing.** The hold records the `sessions` array its transition produces (the one the `setSessions` updater
returns). The provider's own effect, with no dependency array, clears the hold in the commit that renders that
array. A commit for some other update (a user event in a sync lane that re-renders the provider first) does not
clear it early, and a hold whose update never commits cannot outlive the next transition. React runs child
effects before the parent's in a commit, so every view that evaluates in the transition's commit sees the mark.

**Re-runs within a commit.** In development, StrictMode runs a newly mounted component's effects a second time
**after** the whole tree's passive effects, so after the provider has cleared the hold (React 19.2,
`commitDoubleInvokeEffectsInDEV`). The terminal view remounts at hibernation, and a replacement view can mount
at close. Each view therefore remembers, in a ref, that it held focus for its current
`(status, active, covered)`, and keeps holding while an evaluation repeats those values. Without this, the
packaged app would be right and the development build would steal focus, and the probes (which run the build)
would not notice. **Nothing has to
know which view is displayed**, and nothing can linger: the mark's lifetime is fixed by the structure, not by
whether a consumer happened to ask.

The premise this rests on is that the transition (`setSessions` plus `setFocused`) is one commit. React 18
batches state updates made in one event or IPC callback. The probe is what verifies the premise: if a split
commit cleared the mark before the view evaluated, the editor would lose focus and the assertion would fail.

The quiet-arrival mark and its lingering conversation consumer stay as they are. Its consumers still ask only
at arrival, so this change does not enlarge it. It is recorded as a pre-existing gap: issue #83.

If keyboard focus was inside the closed session's own terminal, it falls to the document when that terminal
unmounts. It is not moved into another session. That is the "takes no focus" reading. A user typing into the
very session a phone closes has lost that session either way.

The probe asserts focus in the side panel's editor before and after, for both cases and in both view modes
(terminal and conversation), as `runSessions` does for a quiet create. It also asserts the other half: after
the user selects another rail item and selects this one again, the replacement session's terminal takes focus.
That path does not go through `focus()`, so it is the one a lingering mark would break. Clicking the
already-selected tab is not that path: it never focuses the terminal, even today (`sessions.focus()` changes
no dependency of the focus effect).

### D5. Watches end with the reason the session ended, whoever ended it

The pty's exit reason (`ExitReason` in `terminal.ts`) maps to the protocol's reasons:

| `ExitReason` | Cause | `terminal.ended` | `conversation.ended` |
|---|---|---|---|
| `self` | the process exited on its own (`exit`, `/exit`, a crash) | `exited` | `exited` (new) |
| `hibernated` | a hibernation: manual, automatic or a device's | `hibernated` (new) | `hibernated` (new) |
| `killed` | a close: the desktop's or a device's | `closed` (new) | `closed` (new) |
| `disposed` | the window reloaded or closed | not reached | `window`, unchanged (`windowGone`) |

`disposed` is mapped to `exited` only so that the mapping is total. It is not reached: `windowGone` stops every
watch synchronously, before the disposed ptys' exits arrive (`index.ts`, `ipc/terminal.ts`'s
`releaseRenderer`). A self-healing restart (a `claude --resume` that failed and was restarted) is not an end:
the terminal watch ends `restarted`, as today, and the conversation watch continues.

`killed` is set only by `TerminalService.kill`, whose only caller is the `kill` IPC (a close). That is checked
by grep during implementation, and the mapping lives next to `ExitReason` so a new reason fails to compile
there. `remoteTerminalOutput.exited(sessionId)` gains the reason. The exit handler in `ipc/terminal.ts` also
tells the remote service, `sessionEnded(sessionId, reason)`. The service tells every connection's protocol
session, which stops a conversation watch on that session **through `stopConversation`** and sends
`conversation.ended`. Calling `stopConversation` matters: it also clears the watch's "displayed" report
(`setWatched(key, null)`). Without it, the woken session would count as displayed forever and would never
hibernate automatically again. That is the case today for a session hibernated while watched.

Automatic hibernation never ends a watch: a watched session counts as displayed and is never hibernated
automatically (`session-hibernation`). The ends a client can see are therefore a device's, the desktop user's
and the process's own.

**Why end the conversation on hibernation** rather than keep following the transcript? A watch needs a running
agent to start (`agentSourceOf`). After a wake the agent may write to a new transcript file, which the
follower finds only through new hook events. Ending it makes the rule simple: a watch lasts while the process
runs, for both streams. The phone shows "dormant: Wake". After `sessions.wake` it watches again with
`afterUuid` and receives only what is new (`remote-protocol`, resuming). The terminal stream has always ended
at hibernation (as `exited`), so this aligns the conversation with it.

**This also changes what happens when the desktop does it.** A phone watching a session that the user closes
or hibernates on the desktop is now told so. Before, its conversation silently stopped updating. That is the
same defect, not a new feature: the reason is information the phone needs whoever acted.

A dormant session has no watches, since neither stream can be started on it, so closing one sends nothing.

The new values are additive, but **obligation 7 does not cover them as written**: it covers unknown fields and
unknown event kinds, not new values of a known field. The released Android app reads every
`conversation.ended` as "the window went away" (it ignores `reason`). So with this change an older phone briefly
shows "no window" at each hibernation or close, until the next `sessions.changed` (debounced, about 150 ms)
shows the session dormant or gone. Nothing breaks, and the phone change that adds the menu also branches on
`reason`. Obligation 7 is extended to new values of known fields, which §4 already promises ("event values").
The handoff to the phone says so explicitly.

### D6. Handoff-created sessions and lineage: no special case

Closing a handoff-created session from a device is the desktop's close, so it ends the same way:

- its drop point is drained, then removed;
- it leaves `handoffs.list` (`handoffs.changed`);
- its relatives' relations files show it closed;
- a closed parent's children keep its snapshot (`session-lineage`).

Hibernating one shows no lifecycle state while dormant (`session-hibernation`). A `done` child is an agent
waiting for input (`ready`), so it closes without `force`. That suits the phone's natural "close the finished
ones" use.

Closing a session that has children, or one that a handoff is about to report to, is allowed. The desktop
allows it, and the report is kept for the parent (`handoff-completion`).

### D7. The protocol document

- **§5 opening**: hibernating and closing move from "is not an operation" to the operation list.
- **Two entries**, after `sessions.rename`, each with its errors. They say that the desktop's own actions never
  ask, and that a device must.
- **§3**:
  - `SESSION_BUSY` with `detail.reason`;
  - `CREATE_FAILED` reads "could not carry out a session action" (still the code for an unexpected failure);
  - `NOT_FOUND` already covers "no such session".
- **`terminal.ended` and `conversation.ended`**: the new reasons, and that they arrive whoever ended the
  session.
- **§9**, a new obligation: confirm with the user before `sessions.close`, and before any request with
  `force: true`. Show `SESSION_BUSY`'s reason in that confirmation. Never send `force` on the first attempt
  unprompted. Obligation 7 is extended to unknown values of a known field (a `reason` among them), and the
  ended events are to be read by `reason`.
- **§4**: the list of operations an older desktop lacks gains these two.

The website's remote-access page (`site/src/content/docs/docs/using/remote-access.md` and `zh-tw/`) says the
phone cannot close or hibernate sessions. It is updated in both languages, together with the page
description.

## Risks / Trade-offs

- **[A phone could always send `force`]** → The protocol cannot enforce a confirmation it does not see. That is
  the same limit obligation 2 states for inbox bodies. The obligation is written down. The device already has
  the user's power (it can type into any session). The refusal protects against surprise, not against a
  hostile device.
- **[`unknown` makes every agent need a second tap when agent events are off]** → Accepted (D2). The detail
  says `unknown`, so the phone can word it as "spekterm can't tell whether it's working".
- **[Views now skip focus on any trigger while a session's focus is held]** → It could swallow a legitimate
  focus if the hold lingered. The hold is cleared after every commit by structure (D4). The probe asserts
  that the editor keeps focus, and also that a later rail reselection of the replacement session focuses its
  terminal.
- **[The hold depends on the transition being one commit]** → React 18's batching; verified by the probe in
  both view modes. If it ever splits, the failure is visible (the editor loses focus), not silent.
- **[Ending a conversation watch on every exit is a behavior change for the desktop's own actions]** → It only
  adds an event a client was missing. A client that ignores `conversation.ended` keeps a stale view, which is
  what it had before.
- **[A shell's `/proc` read in `perform`]** → One `readShellFacts` per request. That is the same cost as one
  automatic-hibernation tick for one session.

## Migration Plan

None. The protocol stays version 1, nothing is persisted differently, and a desktop without these operations
does not list them, so the phone hides the controls.

## Open Questions

None. The choices left to the maintainer at review are D2's "refuse unless forced" against "always proceed",
and D5's "end the conversation at hibernation".

Docs at archive: `CLAUDE.md`'s remote-access paragraph says a device's requests cause "no focused-session
change". Closing the displayed session necessarily changes the item's focused session, so that sentence is
qualified (task 5.3).
