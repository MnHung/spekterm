## Why

Some work comes back on a rhythm: a weekly review every Wednesday evening, a daily check of last night's data. A
scheduled handoff (`scheduled-handoff`) opens once, so today an agent that wants "every Wednesday" has to schedule
the next one each time it runs — and the chain breaks the first time a session ends without doing so, or the
30-day bound is in the way. `scheduled-handoff` left recurrence out on purpose; the need is here now.

A recurring handoff is also a different kind of permission from a one-off. A one-off handoff ends; a recurrence
runs until someone stops it. An agent should be able to propose one, but **it takes effect only once the user has
approved it** (the user's ruling).

## What Changes

- A handoff may carry **`repeat`: a five-field cron expression** (minute, hour, day of month, month, day of week),
  read in the desktop's local time zone. **With `repeat`, `at` is optional and means when it starts, and a new
  `until` (optional, same format) means when it ends** — so a handoff is once (`at` only), a bounded run, or open-
  ended until the user stops it. A strict subset is accepted; an
  expression outside it, one that would occur more than once an hour, or one that never occurs is refused when
  it is read, as a visible failure.
- **A handoff with `repeat` is a proposal, not a schedule.** It is checked when it is read like every handoff,
  then waits in the inbox for the user, counted in the badge and announced like an arriving item. The inbox shows
  its expression and the next few times it would open. The user **approves** it on the desktop (into the folder
  they confirm, preselected to the target the agent named) or **declines** it. Nothing opens until it is approved.
- **An approved recurrence keeps one upcoming occurrence in the inbox** (none while it is paused or the inbox is
  full), shown in the scheduled section
  with its expression. Each occurrence opens a **new session** through the path a scheduled handoff takes
  (`scheduled-handoff`): at most once, only when a window can receive it, with its arrival notification when it
  opens. On an occurrence the user can **Run now** or **Skip** (this time only). A new **Repeating** section of
  the inbox lists every approved recurrence with its next time, or why it has none, and **Stop repeating**
  (confirmed).
- **Scheduling moves to its own tab in the inbox, Schedules** (the user's ruling): proposals, every scheduled
  handoff (one-off and occurrences) and the recurrences live there; the items tab keeps only what needs the user
  now. The tab's label shows the number of proposals waiting; a proposal's notification opens that tab.
- **An occurrence refused when it comes to open (target gone, agent events off) pauses its recurrence** until the user deals with the item it left in the
  inbox — otherwise a recurrence whose folder is gone would add a failed item at every time and eventually fill
  the inbox.
- **Occurrences missed while spekterm was closed run once, at the next start** (the user's ruling): one session,
  and its agent is told the time it was scheduled for, the times that were missed, and that it repeats.
- **Receipts** gain a status, `proposed`: the handoff waits for the user's approval. The agent does not learn
  later whether it was approved.
- **The introduction** states `repeat`, the accepted syntax, the time zone by name, that the user approves it
  first, and how missed times are handled — within the introduction's existing budget.
- **Remote protocol**: inbox items gain a `recurrence` mark (role, expression, and a proposal's next times).
  **A device cannot approve a proposal** — accepting one is refused with a named error, because a client that
  predates the field would show it as an ordinary item and its user would approve an unbounded schedule unseen;
  ignoring declines it. Accepting an occurrence runs it now; ignoring skips it. Approving and stopping from a
  device are an Android follow-up with an operation of their own. Protocol version 1 grows by fields only.

## Capabilities

### New Capabilities

- `recurring-handoff`: a handoff with a cron expression — its syntax and bounds, the proposal and the user's
  approval, the one upcoming occurrence, opening each occurrence, missed times coalesced into one run, Run now /
  Skip / Stop, what the opened session is told, and that it runs only while spekterm runs.

### Modified Capabilities

- `agent-handoff-source`: the introduction states `repeat`, and `at` / `until` with it.
- `scheduled-handoff`: with `repeat`, `at` is the recurrence's start, not a scheduled opening.
- `agent-intake`: an approved repeating proposal is an accepted intake without a session.
- `handoff-receipt`: a sixth status, `proposed`.
- `remote-protocol`: accepting a repeating proposal from a device is refused; recurring proposals and occurrences
  in the inbox list, and what ignore and accept do on them.

## Impact

- Main process: a strict cron module (parse, validate, next times in local time); `handoff-delivery.ts` (read
  `repeat` / `until`, `at` as the start, include them in the id digest); `handoff-service.ts` (a proposal is not opened);
  a new recurrence store (`<userData>`, approved recurrences, field-by-field whitelist on load) and the code that
  keeps one upcoming occurrence per recurrence; `handoff-opener.ts` (after an occurrence fires, the next one); `intake-projection.ts` / `src/shared/intake/scheduled.ts` (`repeat`, proposal preview);
  `ipc/intake.ts` (approve, stop; the missed times when the session attaches); `intake-context.ts` / `agent-protocol-copy.ts` (the recurrence lines);
  `handoff-receipt.ts` (`proposed`); `handoff-intro.ts`; `remote-protocol.ts` / `remote-host.ts` (accept and
  ignore on proposals and occurrences).
- Renderer: the inbox's proposal presentation with Approve / Decline, the occurrence's Skip and Stop repeating;
  dictionaries (`en`, `zh-TW`).
- Docs: `docs/remote-protocol.md`, `docs/lessons/handoff.md`, `docs/PRD.md`, CLAUDE.md's handoff paragraph, the
  website's handoff, inbox and remote-access pages in both languages.
- Tests: unit tests for the cron subset (including daylight-saving transitions under a fixed `TZ`), proposal,
  approval, occurrence upkeep and coalescing; `probe:intake` and `probe:remote` sections;
  `scripts/scenario-coverage.test.mjs` registration; the introduction's budget test.
- The Android app (`spekterm-android`) needs a follow-up to show the `recurrence` mark, and a new operation to
  approve and stop; until then accepting a proposal there is refused with an error saying to approve it on the
  desktop.
- No new dependency.
