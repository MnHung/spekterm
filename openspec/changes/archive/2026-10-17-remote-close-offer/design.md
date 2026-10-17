## Context

See proposal.md for why. The pieces this change touches, as they are today:

- **The decision and a record of offers live in the main process.** `SessionControl` (`src/main/session-control.ts`)
  adds the session to `#offered` and sends `{ kind: 'offer-close' }` to the window when an agent's close of its own
  running session reaches the end of the turn (`agent-session-control` D12). A keystroke into the session removes it
  and sends `withdraw-close`. Any failed request to the window about that session (not only `offer-close`) removes it. `processEnded` removes it, but `index.ts`
  calls `processEnded` only for `pendingTargets()`, the sessions with a *waiting* command.
- **The card lives in the interface.** `sessions.tsx` keeps `closeOffers`, clears an entry when its session stops
  running, and both views render `CloseOffer`. Keep calls `withdrawCloseOffer` there and nowhere else. Close is the
  desktop's ordinary close.
- **The remote host is built before `SessionControl`** in `index.ts` (the host near line 630, `SessionControl` near
  line 750), in the same `whenReady`.
- **`sessions.changed`** goes out, debounced (150 ms), on `onPtyChange`, `sessionStore.subscribe`, `store.subscribe`,
  a wait state change (`observeWaits`) and `windowGone`. While a device is connected the list is also recomputed
  every 5 s and sent when it changed (`remote-service.ts`, "changes nothing signals"): a backstop, not an
  announcement.
- **A device's close** runs `busyReason` unless forced (`remote-host.ts` `perform`), and only `ready` counts as idle
  for an agent.

## Goals / Non-Goals

**Goals:**

- One record of offers, in the main process, that every reader (the list for devices, the keystroke path, a device's
  Keep, the desktop's Keep) reads and changes, and that every reader sees change at once.
- No visible change on the desktop.

**Non-Goals:**

- Withdrawing an offer when a turn starts without a keystroke (a prompt from Claude Code's local messaging). The
  desktop does not do it today; see Risks.
- Persisting offers across a restart. A restart restores every session dormant, so there is nothing to offer.
- Any change to `sessions.close`.

## Decisions

### D1. `SessionControl` stays the owner, and announces every change it makes

`#offered` already exists, already sees the offer, the keystroke and the failed `offer-close`. Adding the missing
inputs (Keep from either side) to it keeps one owner. The alternative, making the interface the owner and having the
main process ask it for the list, would make `sessionList()` asynchronous and put a round trip to the window into
every `sessions.changed`.

`SessionControl` gets one more dependency, `offersChanged: () => void`, called after every **real** change it makes to
its record: an offer added that was not there, and a withdrawal (keystroke, Keep from either side, failed
`offer-close`) of an offer that was there. A second self-close of an already offered session, or a withdrawal of a
session with no offer, does not call it. `index.ts` wires it to `remoteService.listChanged('sessions')`. Calling it
from the one place the record changes, rather than at each call site, means a future way to withdraw an offer cannot
forget to announce it. The end of a process is announced differently (D3).

The public surface gains `withdraw(sessionId): boolean`: removes the offer and announces it; returns whether there was
one. It does **not** contact the window: the caller decides (D2, D4). `isOffered(sessionId)` (exists) is what the list
reads.

**A failed request removes the offer only when the request was the `offer-close` itself.** Today `#carryOut` removes the
offer on any failed request, so a parent's rename or hibernate of an offered child that times out removes the child's
offer in the main process while the desktop still shows the card. Harmless while only the main process read the record;
after this change the phone would show no offer while the desktop shows one.

### D2. A device's `sessions.keep` withdraws in the main process, then asks the window

`OPERATIONS['sessions.keep']` → `host.keep(sessionId)`:

1. No window → `NO_WINDOW` (as every session operation). No record of the session → `NOT_FOUND`.
2. `withdraw(sessionId)` in the main process: the list is right at once, whatever the window does next.
3. **Always** ask the window `{ kind: 'withdraw-close', sessionId }`, and await it, even when step 2 found no offer.
   Its failure is the operation's error, mapped as `perform` maps it (`TIMEOUT`, `NO_WINDOW`, anything else
   `CREATE_FAILED`, the interface's catch-all).

Asking even with no offer is what makes a retry repair things. If the window timed out in a first attempt, the main
process has already withdrawn, and a retry that skipped the window would answer "no offer" while the desktop still
shows the card. Asking again costs one round trip to a handler that replies ok when there is no card. So "a session
with no offer answers with no effect" holds as an effect, not as "never contacts the window".

`withdraw-close` is already an internal `HostAction`, passed by the preload's `narrowRemoteAction` and handled by
`RemoteRequests.tsx`. Nothing new crosses the window channel.

The host is built before `SessionControl` in `whenReady`, with no `await` between them, and the host's functions are
first called from a debounce timer or a connection. So the host receives `offered` and `keep` as **direct closures**
over the later `const`. A holder answering "no offer" until bound was considered and rejected: it would turn a wiring
mistake into a silently empty field, while a closure called too early throws.

### D3. An offer ends with the process by its time, not by wiring

An offer records **when** it was made. `isOffered(sessionId)` is true only while the session's last process change
(`session-runs.ts` `lastProcessChangeAt`, set on every start and every end, hibernation and a reload's disposal
included) is not later than that time. A stale entry is dropped when it is read, without announcing (see below), and
counts as absent everywhere: withdrawing it returns "no offer", and a new self-close records a fresh time and
announces. `processEnded` no longer removes an offer: the time decides, so there is one way an offer ends with its
process.

The alternative, calling `processEnded` on `onPtyChange` for offered sessions as for pending ones, is what this change
first proposed. It depends on wiring in `index.ts` (the wiring that is missing today is how the bug arose), and it
misses a race: a wake that spawns before the hibernated pty's exit arrives makes that late exit ignored
(`terminal.ts`, `session.pty !== pty`), so no `onPtyChange` fires for it and the woken session would keep the old
offer. With the time stamp, the wake's start alone ends it.

Nothing new announces a process end: `onPtyChange` already sends `sessions.changed`, and the list read then no longer
marks the session. An end that a command announced in advance (`expectCommandEnd`) is not recorded as a change, but
such an end closes or hibernates the session, and the next start is recorded; between them D5 applies.

### D4. The desktop's Keep reaches the main process

A new renderer → main message, `workspace:handoff:keepCloseOffer` (`ipcRenderer.send`, no reply), exposed as
`window.workspace.handoff.keepCloseOffer(sessionId)`. Its main handler type-checks the id and calls
`withdraw(sessionId)`, **without** sending `withdraw-close` back: the interface already cleared its own card. The
handler is registered after `SessionControl` is built (the other handoff handlers are registered earlier, at
`registerHandoffHandlers`), so it closes over the instance directly.

The card's Keep, in both views, does what it does today (clear the card at once, so the desktop never waits) **and**
sends the message. The interface clears its card before the main process hears it, the reverse of D2's order. Either
order leaves both sides cleared; the only thing the order changes is which side is briefly stale, and on the desktop
that must not be the card the user just dismissed.

**Namespace.** `handoff`, because session commands arrive through the handoff drop point and `SessionControl` is built
next to the handoff service. `probe:shell` enumerates that namespace and documents it as read-only; this is its first
member that changes state. It fits the boundary the probe guards: it takes only a session id, has no path shape, and the
most it can do is withdraw an offer, leaving the session running and the agent's command already decided. The probe's
allow-list and rationale comment are updated with it. Alternatives: `remote` would suggest a device is involved;
`terminal` documents that every member maps to a pty, and this writes nothing to one; reusing the keystroke path
(treating Keep as a keystroke) would also drop a *waiting* command on the session, which Keep does not mean.

### D5. The list reads the record, and only for a running session

`sessionList()` adds `closeOffered: true` when `offered(session.id)` and the session is in the window's live set; the
field is absent otherwise. The running condition is redundant with D3 by design: D3 cannot see an end announced in
advance, and the list must not show an offer on a dormant session whatever the record says.

Absent rather than `false` follows the list's other optional facts (`wait`, `lifecycle`, `lineage`). A client treats a
missing field as "no offer", which is also what an older desktop means.

### D6. `sessions.close` is unchanged, and keeps its idle check

An offered session has just ended its turn, so its wait state is normally `ready` and `sessions.close` without `force`
goes through. It is not guaranteed: `ready` can be cleared by a stray subagent `PreToolUse` after the turn, and an open
background subagent's prompt keeps `awaiting-choice` (`docs/lessons/handoff.md`, "In a turn is not the wait state").
The two alternatives:

- **Skip the check for an offered session**, as the desktop's card does. It matches the desktop, but the phone user
  sees less than the desktop user does, and the check is exactly what tells them something would be lost.
- **Keep the check** (chosen). The phone follows obligation 12 as for any close: show the reason, force only if the
  user agrees. It adds a step only in the cases where something may be lost.

The probe verifies the usual case (an offered session closes without `force`) with the stub agent.

### D7. No attention event for an offer

An offer normally follows a `Stop` that ends the turn, and that `Stop` raises `waiting` (with the same `suppressed`).
A `close-offered` kind would notify twice for one moment or, to avoid that, need `waiting` held back when an offer will
follow, which the attention log cannot know at the `Stop`: the offer is decided later, after the window gate. A phone
opened by the `waiting` notification fetches the list, which carries the offer. The cost: the notification says
"waiting" rather than "asks to close".

Two paths where "the `Stop` already notified" is not exact, accepted and recorded in the spec:

- **A turn that ends in `StopFailure`** (an API error) ends the turn without `turnEnded`, so no `waiting` is raised and
  the offer arrives with no attention event. The phone sees it in the list when next opened. Raising `waiting` on
  `StopFailure` would change "Four moments" for every session and is out of scope.
- **A command read after the turn ended** (a late watcher event, or the 30 s re-read) is offered seconds after the
  `waiting` event, not with it. The user was still notified once.

A `Stop` that leaves a background subagent running raises `waiting` without ending the turn; the offer then follows a
later `Stop`, which raises a second `waiting`. That is two turn ends, each notified once, as for any session.

### D8. The protocol stays version 1

A new optional field and a new operation. An older phone ignores `closeOffered` (obligation 7) and has no Keep control
to show, since it does not know the operation. A new phone against an older desktop never sees the field, and finds
`sessions.keep` absent from `operations`, so it shows no Keep (obligation 8).

## Risks / Trade-offs

- [A prompt from Claude Code's local messaging starts a turn without a keystroke, so the offer stays up while the
  agent works] → Today's desktop behavior, out of scope. A phone's Close then meets `SESSION_BUSY` (`working`) and the
  user decides; the desktop's card closes it without asking, as it does today.
- [The main process announces an offer a moment before the window shows its card] → `#offered` is set before the
  `offer-close` request, so a keystroke in that round trip withdraws it (D12). The phone can see the offer some
  milliseconds before the desktop does. If the request then fails, the offer is withdrawn and announced again: the
  phone sees it appear and go.
- [An `offer-close` request times out, and the interface applies it afterwards] → The main process has dropped the
  offer, the desktop shows a card, devices show none. This predates the change; it is now visible to devices. The
  user's Keep or Close on that card behaves as usual.
- [A device's Keep times out after the main process withdrew] → The phone gets `TIMEOUT`, the list already says no
  offer, the desktop may still show the card; a retry clears it (D2). A user who clicks the stale card's Close closes
  the session, which is their own act.
- [The time is wall-clock: a clock stepped backwards between an offer and a wake could let the offer survive the
  wake] → Rare, and the card is gone on the desktop; the mark would last until the next keystroke or Keep. A
  per-session change counter in `session-runs.ts` would be immune; not worth it now.
- [A self-heal respawn changes the time but sends no `ptyChanged`, so devices see the mark go only at the next list
  change] → Unreachable in practice: a heal happens only in the resume-failure window right after a spawn, and an
  offer needs a whole turn.
- [The appearance of an offer is usually announced by the wait-state change at the same turn end, and the 5 s
  reconcile delivers it anyway, both of which hide a missing `offersChanged`] → The probe makes the offer appear with
  no other change (the command read after the turn ended) and asserts on time: measured ~160 ms with the
  announcement, 1.4–2.1 s without, so it requires under 700 ms, three times.

## Migration Plan

None. Nothing is persisted, and the protocol is additive.
