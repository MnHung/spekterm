## Context

See proposal.md for why. What exists, from `scheduled-handoff` (archived 2026-10-19):

- A handoff record lives in the inbox store (`intake-store.ts`). A scheduled one carries `verified.scheduledAt`
  and `opensAt`; `firedAt` (persisted before anything else) makes every handoff open automatically at most once.
  "Scheduled" in every view is `pending && scheduledAt !== undefined && firedAt === undefined`; the projection
  carries `scheduledAt` only then (`intake-projection.ts`), and `src/shared/intake/scheduled.ts` classifies a view
  from `{ state, scheduledAt }`.
- `HandoffOpener` (`handoff-opener.ts`) is the one owner of automatic openings: it ticks after each delivery,
  every 30 s, when a window restores or first lists the inbox, and on resume; it opens due records when a window
  can receive them; `runNow` is the desktop's Run now. A failed opening leaves an ordinary pending item (fired).
  The opener only requests the opening (`requestOpen`); the context header is built later, when the window
  attaches the session (`ipc/intake.ts`'s `attach` → `buildContext`, `startedAt` = the attach time).
- Routing preselects `verified.targetFolderId` when present (`intake-routing.ts`); the opener resolves
  `verified.targetText` instead.
- Arrival is announced by `deliver`, except for a scheduled record (`whenAnnounced`), which the opener announces
  when it fires.
- Receipts (`handoff-receipt.ts`): one status per outbox file, from the delivery outcome. Refusals carry a code
  and a fixed reason per code (`agent-protocol-copy.ts`); the inbox's failure trace shows the code's reason, not
  the detail (`IntakeOverlay.tsx`).
- The introduction is 6,985 characters for the 30-folder budget fixture, budget 8,000, hard limit 9,000
  (`handoff-intro.test.ts`). `scripts/handoff-intro-source.test.mjs` refuses any written number that contains a
  guarded constant's value as a substring.
- Remote: `inbox.list` is the projection; `inbox.accept` goes to the window's accept path (`remote-host.ts`
  `perform`); `inbox.ignore` goes to `dismissIntake`, the same main-side function the desktop's ignore uses.

Constraints:

- `IntakeStore` whitelists states on load; a new state would be dropped on rollback. New facts go in optional
  fields.
- An approved recurrence outlives every record it produces and has no time bound, so it cannot be one inbox
  record: a record is opened at most once.
- The maintainer's zone (Asia/Taipei) has no daylight saving; transitions are reachable only under a fixed `TZ`
  in tests (`node --test` runs one process per file).
- Every clock is injectable (`fe6d35e`: a test that ran on real time broke on a slow machine).

## Goals / Non-Goals

**Goals:**

- Reuse `scheduled-handoff`'s machinery for every occurrence: an occurrence is a scheduled handoff record, so the
  opener, at-most-once, arrival at fire, the scheduled section, Run now and the device's `scheduledAt` apply.
- One owner (`RecurrenceKeeper`) that keeps each recurrence's upcoming occurrence right and repairs it after a
  crash, triggered from every path that can change it, the device's included.
- A cron subset small enough to state whole in the introduction and to validate strictly.

**Non-Goals:**

- Running anything while spekterm is closed (as `scheduled-handoff`).
- Telling the source agent whether its proposal was approved, declined or stopped.
- Editing an approved recurrence (expression, body, folder).
- **Approving or stopping a recurrence from a device.** A device declines proposals and runs or skips
  occurrences; approval needs a client that shows the schedule, and a new operation (Android follow-up).
- An agent stopping or changing a recurrence.
- Seconds, macros, `L`, `W`, `#`, `?`, a time zone per recurrence, a count of runs (an end time covers it; the
  user chose `until` over a count, and over a year field in the cron).

## Decisions

### D1. An occurrence is a scheduled handoff record; the recurrence lives in its own store

`recurrence-store.ts`, file `<userData>/handoff-recurrences.json`: `version: 1`, entries
`{ id, repeat, intake, targetText, approvedAt, startAt?, until?, lastOccurrenceAt?, stoppedAt?, endedAt? }`. `intake` is a copy of the
proposal's verified and authored content (title, body, origin, lineage `source`, `firstPartyBody`); the
recurrence does not depend on the proposal record. `targetText` is the folder the user confirmed at approval,
as its **absolute path** (`resolveTarget` accepts a path; a folder removed and added back keeps its path, not its
id). `stoppedAt` is a tombstone (D4). The store writes the file first and assigns after (as the other stores).
The load whitelists each field by type and drops an entry missing a required one.

**A missing file is an empty store. An unreadable file — not JSON, an unknown version — is not**: the store is
marked unavailable, the keeper does nothing, approval is refused with a visible message, and the file is never
overwritten. Treating it as empty would let the keeper read every occurrence as an orphan (D4) and an approval
overwrite the user's recurrences.

Each occurrence is an ordinary handoff record in the inbox store, id `<recurrence id>-r<occurrence ms in base 36>`
(about 63 bytes, under `MAX_ID_BYTES`), with `verified.scheduledAt` = `opensAt` = the occurrence time,
`verified.targetText` = the recurrence's path, **`verified.targetFolderId` = that path resolved against the
current folders when the occurrence is created** (absent when it does not resolve — routing would otherwise
preselect the folder the agent named, not the one the user approved), `verified.recurrenceId` and
`verified.repeat`.

*Alternatives.* The recurrence as an inbox record in a new state: dropped on rollback. Computing the next time
in the opener without a record: the scheduled section, Run now, devices' `scheduledAt` and at-most-once would
each need a second path. *Rollback cost:* an older version ignores the file and the new fields; the upcoming
occurrence opens once as a scheduled handoff; nothing after it.

### D2. `RecurrenceKeeper.ensureNext` — at most one upcoming occurrence, found by scanning

`recurrence-keeper.ts` (Electron-free, clock injected). For one recurrence that is not stopped:

1. Collect its records: `verified.recurrenceId === r.id`.
2. **Upcoming** = pending and not fired. If there is one, keep the earliest; dismiss any other (a crash can
   leave two: an occurrence added, the recurrence not updated, and a restart after its time computing a
   different one). Done. An overdue upcoming one is kept: it is the run of the missed times (D7).
3. **Waiting** = its **most recently scheduled fired** occurrence is pending and **is not being opened** — the
   opener did not ask a window to open it in this run (`HandoffOpener.wasRequested`), and no accept holds its
   ticket (`handoffTickets`); both are passed to the keeper as one predicate. If so, create nothing: **the
   recurrence waits until the user accepts or ignores it.** Without this, a recurrence whose folder was removed
   would add one failed item per time, each notifying, counted, and holding one of the 200 pending places — a daily
   one fills the inbox in about 200 days, and then Slack and every handoff are refused.
   "Being opened" matters: a fired occurrence is pending with `firedAt` from `#fire` until the window's `attach`
   accepts it, so "pending and fired" alone would read every opening in progress as waiting and the next
   occurrence would appear only at a later tick. **The ticket alone is not that signal** (found in `probe:intake`):
   `ticketFor` issues one only for a handoff with a lineage source, so an occurrence without one read as waiting
   until its session attached. The opener's in-memory record of what it requested covers every opening; after a
   restart a fired, pending occurrence is one the user deals with. Only an opening the opener itself refused
   (target gone, agent events off) leaves a fired, pending latest occurrence that is not being opened. A later
   failure — the window could not create the session, or the prefill timed out — happens after the next
   occurrence already exists (step 2 returns first), and when that next one fires it is the latest; so those
   failures leave a pending item for the user and do not pause the recurrence. Step 2 runs before step 3 for this
   reason.
4. If the inbox is full, create nothing.
5. Otherwise `next = firstMatchAfter(repeat, max(now, lastOccurrenceAt ?? approvedAt, startAt - 1))` (the start is
   inclusive). **If `until` is set and `next > until`, set `endedAt`, save, and create nothing**: the recurrence
   has ended and leaves the Repeating section. Otherwise add the record; then
   set `lastOccurrenceAt = next` and save the recurrence store. Add first: scanning (step 1) finds it whatever
   happened to the second write.

`ensureAll` also settles a pending proposal whose id already has a recurrence (a crash between approval's two
writes, D4), and dismisses an unfired occurrence of a recurrence with `stoppedAt`. Occurrences of an id that is
neither in the store nor tombstoned are left alone.

Triggers: at load; at the start of every opener tick (before the due check, so a repaired occurrence that is
due opens in the same tick); after approval; after an occurrence fires or is refused by the opener; after Run
now; **inside `dismissIntake`** (Skip and Decline, desktop and device, go through it); in the accept handler
after it issues the ticket for a waiting occurrence (then it holds a live ticket, so it is no longer waiting).
Every call that changes the inbox calls `notifyIntakeChanged`, so the desktop and devices get the new list.
**The keeper's own dismissals (step 2, tombstones) call the store directly, not `dismissIntake`**, which
triggers the keeper: going through it would recurse.

The base `max(now, lastOccurrenceAt)` makes each action consume the right time: after an overdue occurrence
fires at start, the next is after now; after Run now on Wednesday's occurrence on Tuesday, the next is after
Wednesday; after Skip, likewise; after a waiting occurrence is dealt with days later, the next is after now.

### D3. A proposal is a pending record never opened automatically

`deliverFile` reads `repeat` and `until` (`parseHandoffPayload`). **With `repeat`, `at` is the start**: it is
parsed by `parseScheduledAt` with its existing rules and refusal (`SCHEDULE_INVALID`), and a start not later than
the read time is dropped (the recurrence starts at once) — the same "decided once" rule as for a scheduled
handoff. `until` is parsed by the same form check (offset, existing date) without the 30-day bound. Refused with
a new permanent code **`REPEAT_INVALID`** whose detail names the rule: an invalid expression (D5); `until`
without `repeat`; `until` not later than the read time or the start; no matching time between the start (or the
read time) and `until`. `startAt` and `until` travel with `repeat` into `verified` and the recurrence, and join
the id digest when present. **The start goes only into `startAt`, never through `DeliveryProvenance.scheduledAt`**:
today's code turns a future `at` into `scheduledAt`, and the receipt (`scheduled` before `proposed`), the arrival
guard (`whenAnnounced`) and the projection (the scheduled section) all key on that field — a start that leaked
there would make a proposal silent, uncounted and listed as scheduled. Tests hold this (task 2.4). It passes `repeat` through
`DeliveryProvenance` into `verified.repeat` and delivers **without `autoOpen`**: no `opensAt`, the opener never
picks it, `whenAnnounced` does not skip it — announced on arrival, counted in the badge. The id digest includes
`repeat` only when present.

`REPEAT_INVALID` gets: the `IntakeRejection` union, permanent in `intake-rejection.ts`, a receipt reason that
states the accepted syntax and includes the detail (as `SCHEDULE_INVALID`'s does), and a `rejectReason` in both
dictionaries saying the repeat schedule was not valid. The inbox shows the code's reason; the rule reaches the
agent through the receipt.

The main side refuses an accept of a proposal (`decideAccept`): it is approved, not accepted.

### D4. Approve, Decline, Skip, Stop

- **Approve** (`intake:approveRecurrence(adapter, id, folderId)`, desktop only): the record must be a pending
  proposal, the folder a current folder, the store available, and some matching time must remain before its
  `until` (a proposal that waited past its end is refused, and the overlay says why). Writes the recurrence (id = the proposal id,
  `targetText` = the folder's path), then marks the proposal accepted and settled with no session, then
  `ensureNext`. A second approval of the same id answers from the existing recurrence. A proposal has no
  `opensAt`, so nothing ever opens it (`markFired` would be a no-op on it and is not relied on).
  This is an accepted record without a session: `agent-intake`'s lifecycle requirement is modified to allow it.
- **Decline** is the existing ignore.
- **Skip** is the existing ignore on an occurrence — the occurrence's Cancel (`scheduled-handoff`), labelled
  Skip because the recurrence continues; `dismissIntake` triggers `ensureNext`.
- **Stop repeating** (`intake:stopRecurrence(recurrenceId)`, desktop only, confirmed inline): sets `stoppedAt`,
  saves, then dismisses the unfired occurrence. A waiting (fired) occurrence stays for the user.
- **Run now** is the existing `runNow`; after it, `ensureNext`.

### D5. A strict cron subset, hand-written

`src/main/cron.ts`: `parseCron(text)` → `{ ok, schedule } | { ok: false, rule }`; `firstMatchAfter(schedule, t)`;
`matchesBetween(schedule, from, to, limit)` (deduplicated instants).

- Five fields separated by any run of spaces or tabs, trimmed. Each field is `*` or a comma list of `n`, `a-b`,
  `*/s`, `a-b/s`. Ranges: minute 0–59, hour 0–23, day 1–31, month 1–12 or `JAN`–`DEC`, weekday 0–7 or `SUN`–`SAT`
  (0 and 7 are Sunday), names case-insensitive. Refused, naming the field: out of range, `a > b`, a step of 0, a
  wrong field count, anything else (seconds, macros, `L`, `W`, `#`, `?`).
- When day of month and day of week are both restricted, a day matches if either matches.
- **The minute field must be a single number** — at most once an hour, structurally.
- **It must occur** within `MAX_REPEAT_SEARCH_YEARS = 4` years and a day (`0 0 29 2 *` passes, `0 0 31 2 *` is
  refused).
- Matching walks days in the desktop's local time and builds candidates with the local `Date` constructor.
  Measured on Node 22.22.0 under `TZ=America/New_York`: `new Date(2026, 2, 8, 2, 30)` is 03:30 EDT (a time in the
  gap moves forward by the gap); `new Date(2026, 10, 1, 1, 30)` is the first 01:30 (EDT); `30 * * * *` on the
  spring day yields 02:30 and 03:30 as one instant, so matches are deduplicated.
- The zone is the one in effect when each next time is computed; an occurrence is an absolute instant once
  created.

*Alternative:* `croner` (MIT, no dependencies). Rejected: it accepts a superset, so the strict validation would
be written anyway; its daylight-saving behavior would need the same tests; the subset is about 150 lines.

### D6. What the user and devices see

`IntakeView` gains `recurrence?: { role: 'proposal' | 'occurrence'; repeat: string; until?: number; next?: number[] }` (`next`: up to three) — `role`
from the record (`recurrenceId` absent ⇒ proposal), `next` (three times from now) on a proposal only. Every
classification reads `role`, never "has `scheduledAt`": a failed occurrence is pending, fired, and carries no
`scheduledAt`, and must not look like a proposal. `src/shared/intake/scheduled.ts` gains `isProposal(view)`.
A waiting occurrence is an item waiting for the user (badge), shown with its expression and the ordinary accept.

The overlay gains a third tab, **Schedules**, beside the items and rules tabs (`IntakeOverlay`'s `Tab` becomes
`'inbox' | 'schedules' | 'rules'`; `initialTab` already exists for opening on a given tab). The user's ruling:
scheduled things in the same list as items to deal with now was confusing. The items tab keeps every pending
item that is not a proposal and not scheduled (a fired, waiting occurrence stays there: it needs the user now).
The Schedules tab holds, top to bottom:

- **Waiting for approval**: proposals;
- **Scheduled**: one-off scheduled handoffs and upcoming occurrences in one list by time (the existing
  `ScheduledCard`, moved here);
- **Repeating**: the recurrences.

The tab's label shows the number of proposals in a separate element; each tab button gets a fixed,
dictionary-sourced `aria-label` without the count, so a probe's selector does not depend on the number.
`src/shared/intake/scheduled.ts` gets a named predicate per list — `isProposal`, `isScheduled`, and
`isItemsTabItem` (`isWaitingForUser && !isProposal`) — and its "one predicate for every count" comment is
rewritten: the badge and the overlay's header count stay `isWaitingForUser` (proposals included, so the two
numbers the user sees agree), the items tab lists `isItemsTabItem`.

**Which tab a notification opens** is decided in the main process from the keys the notification stands for
(`onActivate(keys)` → `actOnNotification` in `index.ts`): Schedules when every key names a record that is a
proposal (by its content, not its current state — the user may have dealt with it on the desktop), otherwise
items. A merged batch with a failure carries no keys (`intake-notify.ts`), so it opens items. The decision is a
pure function (`notificationTab(keys, store)`) so it can be unit-tested; it travels through `openInbox(tab)` in
`ipc/intake.ts`, the preload's `onOpenInbox`, and `ActivityBar`, which **sets** `intakeTab` on every opening by
a notification (today only a click resets it, so an inbox last left on rules would reopen on rules). When the
inbox is already open the trigger stays a no-op (`agent-intake`: it does not change the tab). Moving the scheduled section changes `scheduled-handoff`'s probe sections, which must select the tab
first (a selector that finds nothing reads as "nothing listed", not as a failure).

- a proposal: title, source, body, its expression, the three next times from its start
  (`locale.ts`), its end time or "until stopped", the
  folder picker preselected to the resolved target, **Approve** and **Decline**;
- an occurrence (Scheduled): its time and expression, **Run now** and **Skip**;
- a **Repeating** section (delivered in the `intake:list` snapshot as a `recurrences` field beside `items`; it
  is not an inbox item, and `inbox.list` does not carry it) listing every recurrence that is not stopped: expression, folder, title, the next
  time — or why there is none (an earlier time is waiting in the inbox; the inbox is full) — and **Stop
  repeating** with an inline confirmation. This is where a recurrence is visible when it has no upcoming
  occurrence, and where it is stopped. (A confirmation, because a stopped recurrence cannot be re-proposed with
  the same content from the same session: it is a duplicate.)
- when the store is unavailable, the Repeating section states that the recurrences could not be read and
  approval is refused.

The expression is shown as written; the next times answer "when". The view's `next` is computed when the list
is built; a device sees the value as of the last inbox change.

### D7. The opened session is told it repeats and what was missed

In `attach` (`ipc/intake.ts`), for a record with `recurrenceId`: `missed = matchesBetween(repeat, scheduledAt,
min(record.firedAt, until), 1000)`, the times after the occurrence up to **when it was fired**, not the attach time: a
failed occurrence accepted by hand days later was fired on time, and the days the recurrence then waited (D2
step 3) are not times this session stands in for. A Run now has
`firedAt < scheduledAt`: none. `buildContext` gets `{ scheduledAt, startedAt, repeat, missed (first ten),
missedCount }`. Copy in `agent-protocol-copy.ts`, outside the fence:

`This handoff repeats on the schedule "<expr>" (cron, local time), approved by the user; each time opens its
own session. This one was scheduled for <t1>. It started at <t2>.`, `The schedule ends at <until>.` when it has
an end, and, when missed: `<n> later scheduled times
passed before it started and were not run separately: <t…>[, and <k> more].` A count of 1,000 is stated as "at
least 1,000".

### D8. Receipts and the introduction

- `ReceiptStatus` gains `proposed` (an `ok` outcome whose record carries `repeat` and no `recurrenceId`).
- The introduction gains one `repeat` line stating every rule D5 applies, and the `proposed` status. Draft (the
  zone from `Intl.DateTimeFormat().resolvedOptions().timeZone` when the introduction file is written, the
  four-year bound from `MAX_REPEAT_SEARCH_YEARS`):
  `repeat: a cron schedule "minute hour day month weekday" in <zone>, e.g. "0 21 * * 3"; with it, "at" is the
  start and "until" (same format, no day bound) the end, both optional; "until" needs "repeat", must be later
  than now and the start, with at least one time between. A field
  is * or a list of n, a-b, */s, a-b/s; names JAN-DEC, SUN-SAT; weekday 0 and 7 are Sunday; day and weekday both
  set match either. Rejected: more than one minute, seconds, @macros, L W # ?, a schedule with no time within 4
  years. The user approves it first; then each time opens a new session until the user stops it. It opens only
  while spekterm runs; times missed while it was closed run once at the next start.` and `proposed - a repeating handoff waiting for the
  user's approval.` About 830 characters (measured by the reviewer with the longest zone name, the Shape line's
  new fields included); the budget margin goes from 1,015 to about 185, and the budget test
  prints it.
- The guard matches substrings, so a single-digit constant cannot be in `GUARDED` (every "4" in the text would
  match). The four-year bound gets its own assertion instead: the stated number equals the constant, with a
  control group. The example avoids the digits of guarded constants (`30` is one).
- Every new statement gets an assertion before the wording is final.

### D9. Remote

- `inbox.list` items carry `recurrence` from the projection.
- **`inbox.accept` on a proposal is refused** with a named error, `APPROVE_ON_DESKTOP` (added to `ERROR_CODES` in
  `remote-frames.ts` and to the protocol document's error table; the doc test checks operations, not errors, so
  the table is kept by hand), and the proposal stays pending. A client that predates this field shows a proposal as an ordinary pending item; accepting it would
  approve an unbounded schedule its user never saw. Approval from a device is a follow-up with an operation of
  its own. `inbox.ignore` on a proposal declines it (the safe direction).
- On an occurrence, accept and ignore are today's scheduled-item behavior: run now, and skip (the recurrence
  continues — `dismissIntake` triggers the keeper).
- The Repeating section is desktop-only: a device does not see a recurrence that has no upcoming occurrence, or
  why. Listing recurrences on a device is part of the Android follow-up.
- `docs/remote-protocol.md`: §5 the field and the two meanings and the error; the errors list; §9 obligations
  (show the expression; ignoring an occurrence skips one time; a proposal is approved on the desktop).
- The operations and the protocol version do not change.

### D10. Lineage

Each occurrence's session takes the proposal's source snapshot as its parent, as a one-off handoff does. Over
months a living source gains one child per time; children close and leave its relations file, so the growth is
bounded by what the user keeps open.

## Risks / Trade-offs

- [An agent proposes recurrences repeatedly] → each needs the user's approval and holds a pending place.
- [The target folder leaves the workspace] → one occurrence fails visibly and the recurrence waits for the user
  (D2 step 3); the Repeating section says so.
- [A full inbox] → no occurrence is created; times in that window are not run or reported. The Repeating
  section says why there is no next time.
- [The recurrence file is unreadable] → nothing is changed or overwritten; approval is refused and the inbox
  says so. Fixing the file and restarting resumes.
- [Daylight-saving behavior depends on the platform's local-time rules] → measured under a fixed zone in tests;
  the user sees the next times before approving.
- [The 1-in-13 unsent submit (lessons §13)] → unchanged from scheduled handoffs; matters more unattended. The
  status dot shows it waiting.
- [Day-of-month OR day-of-week surprises] → visible in the next times at approval.
- [An `until` years ahead is a typo the bound does not catch] → no day bound on `until` (an end date is meant
  to be far); the proposal shows the end before approval.
- [The introduction's margin shrinks to about 185] → the budget test prints it; the hard limit still protects a
  large workspace.
- [The phone cannot approve or stop] → stated in the protocol document and the website; Android follow-up.

## Migration Plan

No data migration. New file, new optional fields. Rollback: D1. A leftover recurrence file is ignored by older
versions and used again after an upgrade; `ensureAll` re-creates a missing occurrence.
