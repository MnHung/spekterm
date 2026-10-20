# scheduled-handoff Specification

## Purpose
Lets an agent hand work off to a later time: a handoff that names a future time is accepted and resolved at
once, waits, visible and cancellable, across app restarts, and opens its session when the time comes — or at
the next start when the app was closed at that time.

## Requirements

### Requirement: A handoff may name the time its session opens, in one strict format and within a bound

A handoff payload MAY carry an `at` field. When present it SHALL be a string in the ISO 8601 extended form
`YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by **an explicit offset** (`Z` or `±HH:MM`). The system SHALL
refuse, as a permanent failure of the handoff (`agent-handoff-source`, "交接的失敗對使用者可見"), an `at`
that:

- is not a string, or does not have that form;
- **has no offset** — a time without one is read in the desktop's local zone by common parsers, and the
  agent that wrote it may have meant another; guessing is how a handoff opens hours off;
- names a calendar date or time that does not exist (30 February, hour 24) — common parsers roll these over
  to another day instead of failing;
- lies further in the future than the scheduling bound (30 days after the handoff is read). A schedule that
  far ahead is more likely a mistyped month or year than a plan, and it would wait unnoticed.

**Whether a handoff is scheduled SHALL be decided once, when it is read**, against one reading of the clock:
an `at` later than that moment schedules it; an `at` not later than that moment makes the handoff behave
exactly as one without `at` — it is not a scheduled handoff, and nothing downstream compares its time again.
A handoff without `at` SHALL behave exactly as before this capability.

**With `repeat` (`recurring-handoff`), `at` is the time the recurrence starts, not the time the handoff opens**:
the format, offset, date and bound rules above SHALL apply to it unchanged, but such a handoff SHALL NOT be a
scheduled handoff — it is a proposal that waits for the user's approval, and nothing compares its `at` with the
clock to open it. **Wherever this capability speaks of a handoff with a future `at`, it means one without
`repeat`**: a proposal raises its arrival notification and counts in the badge (`recurring-handoff`).

The bound SHALL be the same value the introduction states (`agent-handoff-source`), derived from one source.

#### Scenario: A time with an offset in the future schedules the handoff

- **WHEN** an agent writes a valid handoff with `at` set to one hour from now with an explicit offset
- **THEN** no session is created when it is read, and the handoff is listed as scheduled for that time

#### Scenario: A time without an offset is refused

- **WHEN** an agent writes a handoff with `at` set to a time that has no offset
- **THEN** no session is created, a notification is raised, and the inbox shows a failure for that handoff

#### Scenario: A date that does not exist is refused

- **WHEN** an agent writes a handoff with `at` naming 30 February at 10:00 with an offset
- **THEN** the handoff is refused as a failure visible in the inbox, and no session is created

#### Scenario: A time beyond the bound is refused

- **WHEN** an agent writes a handoff with `at` 31 days from now
- **THEN** the handoff is refused as a failure visible in the inbox, and no session is created

#### Scenario: A time in the past opens at once

- **WHEN** an agent writes a valid handoff with `at` set to one minute ago
- **THEN** a session is created for it on arrival, as for a handoff without `at`, and the inbox never lists it as scheduled

#### Scenario: With repeat, at is the start of the recurrence

- **WHEN** an agent writes a valid handoff with `repeat` and `at` set to tomorrow with an explicit offset
- **THEN** it is not listed as a scheduled handoff, it is listed as a proposal waiting for approval, a notification is raised and it counts in the badge, and its first listed time is not earlier than tomorrow's `at`

#### Scenario: With repeat, at still follows the format rules

- **WHEN** an agent writes a handoff with `repeat` and an `at` that has no offset
- **THEN** the handoff is refused as a failure visible in the inbox, and nothing is proposed

### Requirement: A scheduled handoff is checked when it arrives and waits without asking for attention

A handoff with a future `at` SHALL go through every check an arriving handoff goes through — target
resolution, length and size limits, identity and duplicates, and the agent-event check — **when it is read**,
so that a refusal reaches the user and the author while the author still exists. It SHALL then wait in the
inbox as a scheduled item.

While it waits it SHALL NOT create a session, SHALL NOT raise an operating-system notification, and SHALL NOT
count in the activity bar's badge (`agent-intake`). It SHALL survive a restart of the application with its
time unchanged. It **SHALL count toward the inbox's limit on pending items**, as every pending item does: a
full inbox refuses further deliveries, scheduled handoffs included, and the inbox states that it is full.

Two handoffs from the same session with the same target, title and body but different times SHALL be two
handoffs. The same file read twice SHALL remain one.

The source session's lineage SHALL be taken when the handoff is read, not when it opens: the source may be
closed in between. The target string the agent wrote SHALL be kept with the handoff, so that it can be
resolved again when the handoff opens.

#### Scenario: Waiting raises no notification and no badge

- **GIVEN** the inbox has no pending item
- **WHEN** a handoff scheduled for tomorrow arrives
- **THEN** no operating-system notification is raised, and the activity bar's inbox entry shows no count

#### Scenario: A scheduled handoff survives a restart

- **WHEN** a handoff is scheduled for tomorrow and the application restarts
- **THEN** the inbox still lists it as scheduled for the same time, and no session was created

#### Scenario: The same body at two times is two handoffs

- **WHEN** an agent writes two handoffs with the same target, title and body, one scheduled for tomorrow and one for the day after
- **THEN** the inbox lists two scheduled handoffs

#### Scenario: A scheduled handoff to an unknown target is refused when it arrives

- **WHEN** an agent writes a handoff scheduled for tomorrow whose target matches no folder
- **THEN** the failure is visible at once, with a notification and an inbox trace, and nothing is scheduled

### Requirement: A handoff opens only when a window can receive it, and each handoff is opened automatically at most once

A handoff — scheduled or not — SHALL be opened automatically only when a window that has restored its
sessions is listening for it; until then it waits, and it opens as soon as such a window exists. A request to
open a session that no window receives is lost, and the handoff would sit in the inbox as if it had been
refused.

**Each handoff SHALL be opened automatically at most once, ever** — not once per run of the application. Once
an automatic opening has been attempted, or the user has accepted the handoff from the inbox or from a device,
the handoff SHALL NOT be opened automatically again, whatever became of that attempt. A handoff whose opening
did not lead to a working session is an ordinary pending inbox item from then on, and the user decides.
Without this, a handoff whose prefill timed out would open another session at every start of the
application, and announce itself again each time.

A handoff that was pending in the persisted state before this capability existed SHALL NOT be opened
automatically.

#### Scenario: A handoff read before the window restored opens after it

- **GIVEN** an agent's outbox holds a valid handoff written while the application was closed
- **WHEN** the application starts, reads it before its window has restored its sessions, and the window then restores them
- **THEN** a new session is created for that handoff in its target folder without any user action

#### Scenario: A handoff whose prefill timed out is not opened again at the next start

- **GIVEN** a handoff that was opened automatically, whose prefill timed out so that it is pending again
- **WHEN** the application restarts
- **THEN** no new session is created for it, and no notification is raised for it

### Requirement: A due handoff opens a new session through the arriving handoff's path

When a scheduled handoff's time comes while the application runs with a window that can receive it, the
system SHALL **create its session no later than one minute after its time**, through the same path as a
handoff that arrives without `at` (`agent-handoff-source`, "交接於到達時直接建立 session 並送出第一則
prompt"): a **new** session in its target folder, its first prompt filled in and submitted by the rules that
apply to every handoff (including showing it as waiting to be sent when the submission does not take), focus
not moved, the handoff recorded as accepted with that session.

The target SHALL be resolved again from the target string the agent wrote, by the same rule as on arrival, so
a folder removed and added back in the meantime is still found.

The due time SHALL be judged against the wall clock, not against elapsed time measured since scheduling: a
computer that slept through the time still opens the handoff after it wakes.

At that moment, and not when it was scheduled, the arrival notification (`agent-intake`) and the `intake`
attention event (`remote-notifications`) SHALL be raised for it.

#### Scenario: A handoff opens when its time comes

- **GIVEN** a handoff scheduled for a time two minutes from now, targeting folder B
- **WHEN** that time passes while the application runs
- **THEN** within one minute after it, folder B has a new agent session for it, its first prompt is then sent once the agent is ready, and the handoff is accepted

#### Scenario: Focus is not moved when a scheduled handoff opens

- **GIVEN** the user's focus is on a session in folder A
- **WHEN** a scheduled handoff targeting folder B opens
- **THEN** the focus is still on that session, and the rail's selection is unchanged

#### Scenario: Opening raises the arrival notification

- **WHEN** a scheduled handoff opens
- **THEN** an operating-system notification is raised for it, and triggering it focuses the session it created

### Requirement: A handoff whose time passed while the application was closed opens at the next start

A scheduled handoff whose time passed while the application was not running SHALL open at the next start,
**without asking the user**, as soon as a window can receive it. Every overdue handoff SHALL open; none is
dropped for being late.

#### Scenario: An overdue handoff opens at start

- **GIVEN** a handoff scheduled for a time that passed while the application was closed
- **WHEN** the application starts and its window restores its sessions
- **THEN** a new session is created for that handoff in its target folder without any user action

#### Scenario: Several overdue handoffs all open

- **GIVEN** two scheduled handoffs whose times both passed while the application was closed
- **WHEN** the application starts
- **THEN** both handoffs open, each in a new session

### Requirement: A due handoff that cannot open stays in the inbox, and the reason is visible

When a scheduled handoff is due but cannot open, it SHALL remain a pending inbox item the user can accept,
and the reason SHALL be shown as the arriving handoff's rules show it:

- its target no longer resolves to a folder in the workspace: a failure visible with a notification and an
  inbox trace stating the target as the agent wrote it;
- agent event reporting is turned off: the non-notifying rejection of "預填不可能發生時不建立 session";
- the window could not create the session: the item stays pending.

Each of these counts as the one automatic opening (see above): it is not retried, in this run or the next.
From then on the item is no longer listed as scheduled, and it counts in the badge.

#### Scenario: The target folder was removed before the time came

- **GIVEN** a handoff scheduled for folder B, and the user then removes folder B from the workspace
- **WHEN** its time comes
- **THEN** no session is created, a notification is raised, the inbox shows the failure, and the handoff stays as a pending item the user can accept into another folder

#### Scenario: A failed opening is not retried

- **GIVEN** a due handoff whose session could not be created
- **WHEN** several more minutes pass, and then the application restarts
- **THEN** no further attempt to create a session for it is made, and it is listed as pending

### Requirement: The user sees, runs and cancels scheduled handoffs in the inbox

The inbox SHALL list scheduled handoffs apart from the items waiting for the user, earliest time first, each
with its time, its source, its target folder and its full body as plain text. Each SHALL offer:

- **Run now** — opens it at once, through the path a due handoff takes. This is its one automatic opening; if
  it fails, the item stays as an ordinary pending item and does not open again at its original time;
- **Cancel** — it never opens. It is ignored as the inbox ignores an item.

A device paired for remote access SHALL be able to do the same (`remote-protocol`).

#### Scenario: Run now opens the handoff at once

- **GIVEN** a handoff scheduled for tomorrow targeting folder B
- **WHEN** the user chooses Run now
- **THEN** folder B has a new agent session for it at once, and it is no longer listed as scheduled

#### Scenario: A cancelled handoff never opens

- **GIVEN** a handoff scheduled for two minutes from now
- **WHEN** the user cancels it and the time passes
- **THEN** no session is created for it, and the inbox no longer lists it

#### Scenario: Scheduled handoffs are listed earliest first

- **WHEN** the inbox holds a handoff scheduled for the day after tomorrow and one scheduled for tomorrow
- **THEN** the scheduled section lists tomorrow's first

### Requirement: The agent of a scheduled handoff is told when it was meant to start

The session a scheduled handoff opens SHALL be told, in the system-composed part of its handoff context
(outside the fenced body), the time the handoff was scheduled for and the time it actually started. A handoff
opened late — after a closed application — would otherwise act as if no time had passed. This text is for
the agent and SHALL be English, outside the dictionaries (`ui-localization`'s rule for text given to agents).

The fenced body SHALL stay exactly the body the agent wrote (`agent-intake`).

#### Scenario: A late handoff's context states both times

- **GIVEN** a handoff scheduled for 09:00 that opened at 11:30 because the application was closed
- **WHEN** its agent reads its handoff context
- **THEN** outside the fenced body it reads that the handoff was scheduled for 09:00 and started at 11:30, and the fenced body equals the body the source agent wrote

### Requirement: Scheduling is not a promise that work runs while spekterm is closed

The system SHALL NOT claim that a scheduled handoff runs at its time regardless of the application's state.
It opens only while the application runs; a time that passes while it is closed is honoured at the next
start. The introduction and the user documentation SHALL say so.

#### Scenario: The introduction states that a handoff opens only while spekterm runs

- **WHEN** the text injected into an agent's context is examined
- **THEN** it states that a scheduled handoff opens only while spekterm is running, and at the next start if its time passed while spekterm was closed
