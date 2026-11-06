## Context

Scheduling (`scheduled-handoff`) and repeating (`recurring-handoff`) gave the agent a way to plan work, and the
inbox's Schedules tab gave the user a way to undo it: Cancel on a scheduled handoff, Skip on an occurrence, Decline
on a proposal, Stop repeating on a recurrence. The agent got none of the undo. Both changes listed it as out of
scope ("telling the source agent later what became of a scheduled handoff", "editing an approved recurrence").

The user plans these in conversation, and changes the plan in conversation, often days later and in another
session. They ruled (2026-11-06):

- **any** agent session may cancel, not only the one that wrote the handoff;
- an agent may stop an **approved** recurrence directly, with no confirmation.

What exists and is reused:

- The outbox already carries several kinds (`handoff-delivery.ts`'s `outboxKindOf`: a handoff, `report`, and the
  session commands `close` / `hibernate` / `rename`). Every file gets a receipt (`handoff-receipt.ts`).
- The desktop's actions are single functions in the main process: the inbox's ignore is `dismissIntake`
  (`intake-changes.ts`), which a device's ignore also calls and which the recurrence keeper listens to
  (`onIntakeDismissed` → `afterDismiss` creates the next occurrence); Stop repeating is `RecurrenceKeeper.stop`.
- The teammates file (`teammates-file.ts`) is the precedent for "the introduction points to a file that holds the
  rules and the list": the introduction has 224 characters left under its 8,500 budget (measured with the
  30-folder test, `handoff-intro.test.ts`).

## Goals / Non-Goals

**Goals:**

- An agent can cancel any item the Schedules tab lists, with the effect of the desktop's own action on it.
- An agent that did not write the item can find it, and so can tell the user what it is about to cancel.
- "Change" works as "write the new one, then cancel the old one", and the rules say so in that order.

**Non-Goals:**

- An edit operation. A recurrence's approval is the user's, and an edit that kept it would let an agent change
  what the user approved; a one-off handoff's identity is its content's digest, so an edit is a new handoff anyway.
- Cancelling anything that is not in the Schedules tab: an item waiting in the items tab (its opening was
  attempted, or it came from Slack or a teammate), an opened handoff (its session is closed with `close`), an
  outgoing teammate handoff (the user sends or discards it on the desktop).
- Telling the writer of a handoff that someone cancelled it. Its receipt keeps saying what happened when it was
  read (`handoff-receipt`: a receipt is the outcome of reading).
- A device-side view of what agents cancelled (D5 is desktop-only).
- Any change to the remote protocol.

## Decisions

### D1. A cancel names an id, which spekterm gave out — never a file name

`{"kind": "cancel", "id": "<id>"}`. The id is the inbox record's id (a handoff: `<session id>-<digest>`; an
occurrence: `<recurrence id>-r<time>`), or a recurrence's id (the same string as the proposal it was approved
from).

Alternatives:

- **The file name the agent wrote.** Only the writing session knows it, and the user ruled that any session may
  cancel. A file name is also reused: two deliveries from one session can share it (`docs/lessons/handoff.md` §4),
  so it does not name one item.
- **Matching by title or target.** Titles are optional and not unique; a cancel that guesses can cancel the wrong
  work, and a refusal for "ambiguous" would push the agent to the schedules file anyway.

The id reaches the agent two ways: the `scheduled` and `proposed` receipts carry it (the writing session needs
nothing else), and the schedules file lists every cancellable item with its id (D6). Ids carry no path and no
delivery text, so neither the receipt's "no delivery text" rule nor the outbox's "no paths" posture changes.

### D2. What can be cancelled is exactly what the Schedules tab lists, decided when the file is read

The cancel is decided and carried out synchronously in the main process when the file is read, against the
current records:

| The id names | Condition | Effect (the desktop's own function) |
|---|---|---|
| a recurrence | in the Repeating section's own listing (`RecurrenceKeeper.listing().recurrences`) | `RecurrenceKeeper.stop` |
| an inbox record | adapter `handoff`, and its projection passes the Schedules tab's own predicate, `isProposal` or `isScheduled` (`src/shared/intake/scheduled.ts`) | `dismissIntake` |
| a handoff record already dismissed (cancelled, declined, skipped or ignored), or a recurrence already stopped | — | nothing; receipt `duplicate` (D11) |
| no record at all, or a proposal record that is no longer pending, while the recurrence store is unavailable | — | refused, `CANCEL_UNAVAILABLE` (temporary) |
| anything else | — | refused, `CANCEL_NOT_FOUND` |

The rows are tried in this order. The recurrence row reads the Repeating section's listing rather than the store's
fields, for the reason the record row reads the projection: "ended" is not one field (`#ensure` writes `endedAt` only
when it gives up creating, not while an occurrence past `until` waits for the user), and the desktop offers Stop on
every recurrence that listing returns, ended or not. An approved recurrence's id is also the id of its proposal
record, which stays in the inbox store for good (dedup keys are never deleted), `accepted` and settled; so when the
store is unavailable, that record must not read as "opened" and be refused for good — the unavailable row catches it
before the last row. The record is looked up across adapters (the store keys by adapter and id), so an id of a Slack
or teammate item is refused as not cancellable rather than unknown.

The record row and the file (D6) are judged through one narrow function shared with the projection — the item's
state, `scheduledAt` while pending and not fired, and its recurrence role — and the tab's own predicates, not a second
reading of the record's fields (a hand-written test would drift from the tab's the next time either changes, and
nothing would turn red), and not `project()` itself, which needs routing and the folder list. A proposal record keeps
its content once accepted (`expireContent` has no caller in production), so its role is still readable.

`firedAt` absent is the test for "its opening has not begun": `HandoffOpener` marks a record fired before it asks a
window to open it, and a user's accept or Run now marks it when its ticket is issued (`scheduled-handoff`, "at most
once, ever"). Both run in the main process, so a cancel read in the same tick cannot interleave with them. A fired
record that is still pending (the opener's attempt failed) has moved to the items tab; it is the user's to deal
with, and cancelling it would remove a failure the user has not seen.

A recurrence whose `until` passed but that still has an upcoming occurrence is listed, and can be stopped, as on the
desktop. Stopping a recurrence leaves an occurrence that is waiting for the user where it is, as the desktop's Stop
does. A store write that fails inside `stop` (the recurrence file cannot be written) is caught and refused as
`CANCEL_UNAVAILABLE`: left to throw, the delivery would get a `held` `READ_FAILED` receipt ("reading failed"), which
misleads.

Alternative: **let the agent cancel any pending handoff**. It would also cover the items tab, where the user
decides; the user asked for undoing plans, not for clearing the inbox.

### D3. One path for the effect: the desktop's functions, not a copy

Skip, Cancel and Decline are all the inbox's ignore, and ignoring an occurrence must make the keeper create the
next one. `dismissIntake` already notifies `onIntakeDismissed` (the keeper) and the inbox's change signal (the
desktop and every paired device). Calling `store.setState(..., 'dismissed')` directly would skip both: the
recurrence would wait with no upcoming occurrence until the next opener tick, and the desktop would show the item
until its next reload. The cancel module therefore takes `dismissIntake` and `stop` as dependencies and changes a record's state no other
way; D5's `cancelledBy` mark rides on those same calls.

### D4. Any session may cancel; no lineage check

Session commands check lineage (`agent-session-control`: only the agent's own session and its descendants),
because closing a session ends someone's work in progress. A scheduled handoff is not in progress, the user asked
for "cancel it" to work from whatever session they are talking to, and the outbox is not a security boundary
(`docs/lessons/handoff.md` §3: an agent can write into any outbox). A lineage check would only make the common case
fail.

What stops a confused agent from cancelling the wrong item is the same as for any other action an agent takes in
the user's name: the agent sees the title, target, time and the start of the body in the schedules file and is
told to confirm with the user what it will cancel (the rules say so); the user reads the agent's reply.

### D5. A cancel by an agent leaves a quiet line in the Schedules tab

The cancelled item leaves its list as it does when the user cancels it there, and the Schedules tab gains a section,
**Cancelled by an agent**, listing every cancel an agent carried out in the last 7 days: the item's title (or the
start of its body), what was done (cancelled, skipped, declined, stopped), the cancelling session's source label, and
when. No notification, no badge count, no action on the line; a line ages out after 7 days.

Why a line and not nothing (the first draft): any session may cancel and an agent's stop asks nothing (the user's
rulings), so a session that read third-party text (a Slack mention, a teammate's handoff) can be told by that text to
stop the user's plans. Without a line the user learns only when the work does not run, and a stopped recurrence
cannot be proposed again with the same content from the same session. The line costs little: the dismissed record
and the stopped recurrence are both kept already, so it is one field on each (`cancelledBy: { label, at }`), written **in the same save as the state change**: the
desktop's functions take an optional `by` (`dismissIntake(store, adapter, id, by?)`, `RecurrenceKeeper.stop(id, by?)`),
so a crash cannot leave a mark on an item that was not cancelled, to be shown later as an agent's cancel when the user
cancels it on the desktop. The section lists only dismissed records and stopped recurrences that carry the mark. Why not a notification: the common case is a cancel the user asked for in the
conversation they are reading, and a notification for it would be noise; why no Undo: a scheduled time may have
passed, and "undo" is "ask the agent to write it again".

A device does not see the section (the remote protocol is unchanged). A refused cancel **is** visible, through the
same path as every other refused outbox file (`service.reject`: a trace in the inbox and, for a permanent refusal, a
notification), which keeps one rule for the outbox ("a refused delivery is visible to the user", `agent-handoff-source`).

### D6. The schedules file: what can be cancelled, and the rules

`<userData>/handoff/schedules.json`, beside `teammates.json`, written whole (temporary name, then rename) on every
inbox change signal (`onIntakeChanged`, which every record change and every keeper change reaches), and only when its
content changed. Never throws: a file that cannot be written costs the agent the list, and a cancel by an id from a
receipt still works.

```json
{
  "rules": "<how to cancel and how to change, see below>",
  "recurrencesAvailable": true,
  "proposals":   [{ "id", "title", "target", "repeat", "next"?, "until"?, "source", "preview" }],
  "scheduled":   [{ "id", "title", "target", "at", "source", "preview", "recurrenceId"? }],
  "recurrences": [{ "id", "title", "target", "repeat", "until"?, "next"?, "source", "preview" }]
}
```

- **The same three groups as the Schedules tab, from the same functions** (`listView` filtered by `isProposal` /
  `isScheduled`, and `RecurrenceKeeper.listing`), so the file cannot list something the tab does not, or the other
  way round; and the cancel decision (D2) uses the same predicates, so what the file lists is what a cancel accepts
  at the moment the file was written.
- `target` is the folder's **name** (the repo list in the introduction uses names): for a recurrence, the last
  segment of its approved folder's path, with `"targetGone": true` when that path no longer resolves to a folder.
  `source` is the source coordinate's label (a folder name, `Global`, or ended). **No path the system derived** (a
  folder's path, a recurrence's approved path) is written; text the agent wrote — the title and the body's start,
  which often names a file, as the introduction tells agents to do — is written as it is.
- Times are ISO 8601 UTC, as receipts state them.
- `preview` is the first 200 code points (the spec says characters; code points is the count) of the body after the normalization the body already went through. An
  agent-written title is optional; without the body's start, an untitled item cannot be told from another. The whole
  body is not copied: the file is rewritten on every inbox change and holds up to the inbox's pending limit of items.
- **Every text in it was written by an agent of this user** (handoff adapter only), never by a third party: Slack
  and teammate items are not cancellable and not listed.
- `recurrencesAvailable: false` when the recurrence store could not be read; the rules say a cancel of a recurrence
  is then refused as temporary.

The file is written once `configureHandoff` has set the handoff root (before it, `schedulesFile()` is empty and a
"never throws" write would silently do nothing), right after, and on every `onIntakeChanged` from then on; an empty
path is logged. Two changes reach it late, and the decision does not depend on it: a user's accept marks a record
fired without a change signal (the next signal, at `attach`, follows), and a folder renamed or removed changes `target`
without one.

The rules, in the agent's words (English, outside the dictionaries, as `teammateRules`), state: the cancel shape;
what each kind of item's cancel does; that a stopped recurrence and a cancelled handoff cannot be undone; that
**it should confirm with the user which item it is cancelling** when it did not write it; that the file is a
snapshot and an item that started opening since is refused; how to change one (D7); and what the receipt says.

The introduction gets one sentence (D9) pointing here.

### D7. "Change" is new-then-cancel, and the duplicate rule is stated

To change a scheduled handoff's time, or a recurrence's expression, the agent writes a new handoff and then cancels
the old one. The order matters: the new one can be refused (a time past the 30-day bound, a cron the subset does not
take), and cancelling first would leave nothing scheduled. The rules say: write the new one, read its receipt, cancel
the old one only after the receipt says `accepted` or `scheduled`.

A changed recurrence is a new **proposal**: the user approves it again. That is deliberate (Non-Goals). `proposed` is
not enough to stop the old one: the user may decline the new proposal or never approve it, and the old one cannot be
proposed again with the same content from the same session (a duplicate). The rules say: stop the old recurrence only
once the new one's id appears among the approved `recurrences` in the schedules file, and until then tell the user
the new one is proposed and the old one still runs.

One trap is stated rather than fixed: a cancelled handoff written again **with the same content from the same
session** is a `duplicate` (its id is its content's digest, and the dismissed record still exists), so nothing
happens. Changing the rule would mean deleting records on cancel or exempting dismissed ones from the duplicate check;
both weaken the "a re-read never opens a second session" guarantee (`docs/lessons/handoff.md` §4) for a case that has
a one-word workaround (change the title). The rules state it.

### D8. Receipts: the id on `scheduled` / `proposed`; a cancel's `accepted` means done

- `scheduled` and `proposed` receipts gain `id` (the record's id; a proposal's id is also the recurrence's id after
  approval). `duplicate` gains it too when the record is known, so an agent that wrote the same handoff twice can
  still cancel it.
- A cancel's outcome is `accepted` when it was carried out — unlike a session command, nothing waits for a turn to
  end, so there is no "accepted but not yet done". The rules say so.
- New refusal codes:
  - `CANCEL_NOT_FOUND`, **permanent**, with a system-written detail naming which case: `unknown id`, `opening has
    begun or it was opened`, `not cancellable` (another producer's item, an item in the items tab), `ended` (a
    recurrence past its end with nothing left to open). The detail goes into the receipt (`DETAILED`), as
    `FIELD_TYPE`'s does; the inbox's trace does not render details, so the user sees the code's text only;
  - `CANCEL_UNAVAILABLE`, **temporary**: the recurrence store is unavailable and the id may name a recurrence (no
    record, or a record that is not pending), or the store could not be written while stopping;
  - an already dismissed handoff or an already stopped recurrence is no refusal: `duplicate` (D11).
  - A cancel without a string `id` is `FIELD_TYPE` with the field `id`, as other kinds' missing fields are.

### D9. The introduction: one sentence, inside the remaining budget

> `To cancel or change a scheduled or repeating handoff (any session's), read <path>: it lists them, with ids, and states how.`

About 130 characters plus the path (~45), inside the 224 left. The sentence goes after the receipt statuses. The
budget test (`handoff-intro.test.ts`, 8,500 for 30 folders) holds it; it prints the new margin. The sentence is
present whenever the outbox is (every agent session), unlike the teammate paragraph: scheduling has no off switch.

Alternative: **state the cancel shape in the introduction itself**. It does not fit with the rules that make it safe
(confirm with the user, new-then-cancel, the duplicate trap), and an introduction past 10,000 characters is replaced
whole by a 2 KB preview (`docs/lessons/handoff.md` §16).

### D11. A cancel of something already cancelled changes nothing, and says so

A second cancel of the same id is common and harmless: the agent rewrote the file under another name before reading
the receipt, two sessions were asked, the user cancelled on the desktop first, or the application ended between
carrying a cancel out and removing its file (the outbox is processed deliver → receipt → remove, and a restart reads
the file again). In each the state the cancel asks for already holds: the item will not open. A dismissed handoff
record (whoever dismissed it, and for whatever reason) and a stopped recurrence therefore give the receipt `duplicate`
("nothing new happened"), with no trace and no notification. The outcome is the report's precedent,
`{ ok: true, consume: true, notify: false, duplicate: true }`, never `service.reject('DUPLICATE', …)` (which leaves a
trace); the receipt carries the id the cancel named. The introduction's one-line meaning of `duplicate` ("the same
content was received before") is not widened for this — the schedules file's rules state it, and the introduction has
no room. Only an item whose opening began, or that was opened, is refused — there the asked-for state does not
hold.

### D10. Module layout

- `handoff-delivery.ts`: `cancel` joins the outbox kinds (`outboxKindOf`), with `parseCancel` (reads `id` only).
- `intake-projection.ts`: the narrow role function (state, `scheduledAt` while pending and unfired, recurrence role)
  that `project()` and the cancel decision both call.
- `handoff-cancel.ts` (new, Electron-free): `decideCancel(id, { store, listing })` returns the D2 row or the
  refusal with its detail; `HandoffCanceller.deliver` carries it out through the injected `dismiss` / `stop`.
- `schedules-file.ts` (new, Electron-free): `schedulesContent(listing)` and `writeSchedulesFile(file, content)`, the
  rules text, the teammates file's write discipline.
- `handoff-service.ts`: routes `cancel` to the canceller (unprovided ⇒ refused as an unknown kind, as the other kinds).
- `handoff-receipt.ts`: `id` on `scheduled` / `proposed` / `duplicate`.
- `handoff-outbox.ts`: `schedulesFile()`.
- `intake-store.ts` / `recurrence-store.ts`: `cancelledBy` on a record and a recurrence, saved with the state change
  (`setState` / `stop` take it); both readers whitelist fields, so the field is added to them, and neither version
  number changes (a bump drops the whole inbox, or makes an older build read the recurrences as unavailable).
- `ipc/intake.ts` and `IntakeOverlay.tsx`: the list snapshot carries the agent cancels of the last 7 days as its own
  field, never on `IntakeView` (the remote server spreads `IntakeView` to devices); the Schedules tab shows them (D5).
- `index.ts`: wires the canceller and writes the file on `onIntakeChanged` and once at start.

## Risks / Trade-offs

- **A confused agent cancels the wrong item, from any session** → the rules require confirming with the user; the
  schedules file gives it what to confirm with; the reversal for a recurrence is a new proposal. D5 records the cheap
  next step if it happens in practice.
- **The schedules file lags a change that sends no change signal** (a user's accept marking a record fired; a folder
  renamed or removed) → the cancel is decided against the records, not the file, and refuses with "opening has
  begun"; the file says it is a snapshot.
- **A session that reads third-party text can stop the user's plans.** A session opened from a Slack mention or a
  teammate's handoff reads text someone else wrote; an injected instruction there can cancel every scheduled handoff
  and stop every approved recurrence. This follows from the user's two rulings (any session; no confirmation). D5's
  line makes it visible within the 7 days without a notification; it does not prevent it.
- **A paired phone can stop a recurrence through an agent**, although the remote protocol gives a device no Stop:
  the phone sends a prompt, the agent writes the cancel. That is the agent's capability, not the device's, and the
  website says so.
- **The file is readable by every process of the user** → the same as the relations and teammates files beside it,
  and the inbox store itself; it holds no credential and no third-party text.
- **Stopping without confirmation** was the desktop's guard against a one-click loss ("stopping is not one click").
  The user ruled it away for agents; the desktop keeps its confirmation.

## Open Questions

None.
