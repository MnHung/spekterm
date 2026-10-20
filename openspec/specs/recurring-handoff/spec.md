# recurring-handoff Specification

## Purpose
Lets an agent propose work that comes back on a rhythm — every Wednesday evening, every weekday morning — which
opens a new session at each time once the user has approved it, keeps going until its end time or until the user stops it, and runs
once at the next start for the times spekterm was closed.

## Requirements

### Requirement: A handoff may repeat on a cron schedule, in one strict subset

A handoff payload MAY carry a `repeat` field: a cron expression of five fields — minute, hour, day of month,
month, day of week — separated by spaces or tabs. Each field SHALL be `*` or a comma-separated list of a number, a range
`a-b`, or a step `*/s` or `a-b/s`, within minute 0–59, hour 0–23, day 1–31, month 1–12, day of week 0–7 (0 and
7 are Sunday). Months MAY be named `JAN`–`DEC` and days `SUN`–`SAT`, in any case. When both day of month and day
of week are restricted, a day SHALL match if either matches.

The system SHALL refuse, as a permanent failure of the handoff (`agent-handoff-source`, "交接的失敗對使用者可見"),
a `repeat` that:

- is not a string, or is not five fields of that form (seconds, macros such as `@daily`, `L`, `W`, `#` and `?`
  included), or has a value out of its range, a range whose start is after its end, or a step of 0;
- **names more than one minute** — the minute field SHALL be a single number. A schedule that could open
  sessions more than once an hour is far more likely a typo (`* * * * *`) than a plan, and each time opens a
  session;
- never occurs: no time within the next four years matches it.

A handoff with `repeat` MAY also carry:

- **`at` — when the recurrence starts.** It SHALL follow the rules of `at` in `scheduled-handoff` (format, the
  required offset, a date that exists, the scheduling bound); the first time SHALL be the first matching time at
  or after it. A start not later than the read time means the recurrence starts at once. With `repeat`, `at` does
  not make the handoff a scheduled handoff;
- **`until` — when the recurrence ends.** It SHALL be a time in the same format with the required offset and a
  date that exists, later than the read time and later than the start. No time after it SHALL be created. Without
  it the recurrence runs until the user stops it.

The system SHALL also refuse, as the same permanent failure: `until` without `repeat`; an `until` that breaks
those rules; and a `repeat` with no matching time between its start (or the read time) and its `until`.

The refusal SHALL be visible in the inbox as a failure of the repeat schedule, and the receipt
(`handoff-receipt`) SHALL name the rule that failed and state the accepted syntax.

The expression SHALL be read in the desktop's local time zone. A local time that does not exist on a day (a
daylight-saving gap) SHALL open at the corresponding time after the gap; a local time that occurs twice SHALL
open once.

#### Scenario: A weekly expression is accepted

- **WHEN** an agent writes a valid handoff with `repeat` set to `0 21 * * WED`
- **THEN** it is not refused, and its next times are Wednesdays at 21:00 local time

#### Scenario: More than one minute is refused

- **WHEN** an agent writes a handoff with `repeat` set to `*/15 9 * * *`
- **THEN** no session is created, a notification is raised, the inbox shows a failure of the repeat schedule, and the receipt's reason names the minute rule

#### Scenario: An expression that never occurs is refused

- **WHEN** an agent writes a handoff with `repeat` set to `0 0 31 2 *`
- **THEN** the handoff is refused as a failure visible in the inbox

#### Scenario: A start time delays the first occurrence

- **WHEN** an agent proposes `0 21 * * 3` with `at` set to a Monday two weeks from now, and the user approves it today
- **THEN** its first occurrence is the Wednesday after that Monday at 21:00, and no session opens before it

#### Scenario: An end time bounds the recurrence

- **GIVEN** an approved daily recurrence `0 9 * * *` with `until` set to Friday 12:00 of this week
- **WHEN** Friday 09:00 has opened
- **THEN** no further occurrence is created, and the recurrence is no longer listed among the recurrences

#### Scenario: An end time with no time before it is refused

- **WHEN** on a Saturday an agent writes `repeat` set to `0 9 * * 1` with `until` set to the coming Monday at 08:00
- **THEN** the handoff is refused as a failure visible in the inbox, and nothing is proposed

#### Scenario: An end time without repeat is refused

- **WHEN** an agent writes a handoff with `until` and no `repeat`
- **THEN** the handoff is refused as a failure visible in the inbox, and no session is created

#### Scenario: Day of month or day of week

- **WHEN** an agent proposes `0 9 1 * MON`
- **THEN** its next times include the first of each month and every Monday, at 09:00

#### Scenario: A time in a daylight-saving gap opens after the gap

- **GIVEN** the desktop's time zone is America/New_York
- **WHEN** a recurrence `30 2 * * *` reaches the day clocks move from 02:00 to 03:00
- **THEN** that day's occurrence is at 03:30 local time, and the next day's at 02:30

#### Scenario: A repeated local time opens once

- **GIVEN** the desktop's time zone is America/New_York
- **WHEN** a recurrence `30 1 * * *` reaches the day clocks move from 02:00 back to 01:00
- **THEN** that day has exactly one occurrence

### Requirement: A repeating handoff is a proposal that waits for the user's approval

A handoff with a valid `repeat` SHALL go through every check an arriving handoff goes through when it is read —
target resolution, length and size limits, identity and duplicates, agent events — and SHALL then wait in the
inbox as a **proposal**. A proposal SHALL NOT open a session, by itself or at any time, until the user approves
it. It is an item waiting for the user: it SHALL count in the activity bar's badge, raise the arrival
notification and the `intake` attention event (`remote-notifications`) when it arrives, and count toward the
inbox's limit on pending items.

The inbox SHALL show a proposal with its title, source, full body as plain text, its expression as written,
**its next times, up to three,** in the desktop's time zone (from its start, if it has one), and its end time or that it
has none, so that the user sees when it would open and for how long before approving. A proposal whose end time
has passed while it waited SHALL NOT be approvable, and the inbox SHALL say why.
It SHALL offer:

- **Approve** — into the folder the user confirms, preselected to the target the agent named. No session is
  opened by approving; the first occurrence opens at the first matching time after the approval. Approval is
  given on the desktop only (`remote-protocol`);
- **Decline** — nothing is scheduled. It is ignored as the inbox ignores an item.

The same file read twice SHALL remain one proposal. Two proposals with the same target, title and body but
different expressions SHALL be two proposals.

#### Scenario: A proposal opens nothing until approved

- **WHEN** an agent writes a valid handoff with `repeat` set to every minute 0 of every hour, and two hours pass without the user acting
- **THEN** no session has been created for it, and the inbox lists it as waiting for approval

#### Scenario: A proposal asks for attention

- **GIVEN** the inbox has no pending item
- **WHEN** a valid repeating handoff arrives
- **THEN** an operating-system notification is raised, and the activity bar's inbox entry shows a count of one

#### Scenario: The inbox shows when a proposal would open

- **WHEN** the inbox lists a proposal with `repeat` set to `0 21 * * 3`
- **THEN** it shows the expression and three upcoming Wednesdays at 21:00

#### Scenario: Approving opens nothing at once and schedules the first time

- **WHEN** the user approves a proposal for `0 21 * * 3` on a Monday into folder B
- **THEN** no session is created, the proposal is no longer waiting for the user, and the scheduled section lists one occurrence for that Wednesday at 21:00 in folder B

#### Scenario: Approving into another folder

- **WHEN** a proposal names folder B as its target and the user approves it into folder C
- **THEN** its occurrences are listed with folder C and open in folder C

#### Scenario: A declined proposal never opens

- **WHEN** the user declines a proposal
- **THEN** it is no longer listed, and no session is ever created for it

### Requirement: An approved recurrence keeps at most one upcoming occurrence, and its time is visible

An approved recurrence SHALL have **at most one** upcoming occurrence: a scheduled handoff (`scheduled-handoff`)
for the first matching time after the later of now and its previous occurrence, opening in the folder the user
approved it into. The occurrence SHALL be listed in the inbox's scheduled section with its time, that folder, its
full body and its expression, and SHALL behave as a scheduled handoff: it raises no notification and does not
count in the badge while it waits; it opens through the scheduled handoff's path — a new session, at most once,
only when a window can receive it, its arrival notification raised when it opens.

It SHALL have exactly one, except while:

- **its latest occurrence was refused when it came to open** — its target no longer resolves, or agent event
  reporting is off — so it is a pending inbox item. The recurrence SHALL create no further occurrence until the
  user accepts or ignores that item; then the next is the first matching time after that moment. A recurrence
  whose folder is gone would otherwise add a failed item, a notification and a held place in the inbox at every
  time. An occurrence whose session was requested but then not created, or whose prompt was not filled in in
  time, also stays as a pending item for the user, but SHALL NOT pause the recurrence: its next occurrence
  already exists by then;
- the inbox is full: no occurrence is created; the next is created once there is room, at the first matching
  time after that moment;
- the approved recurrences could not be read at start (the file is damaged or from a newer version): nothing
  about them is changed, nothing is created, and the inbox says that they could not be read.

When an occurrence is opened, skipped or run now, or a waiting one is dealt with, the next occurrence SHALL be
created at once, whether the action was taken on the desktop or from a device. An approved recurrence and its
upcoming occurrence SHALL survive a restart; whatever point the application stopped at, the next start SHALL
leave at most one upcoming occurrence.

The inbox SHALL list every approved recurrence that is not stopped in its own section (in the Schedules tab), with its expression,
folder, title, and its next time or the reason it has none, so that a recurrence is visible and can be stopped
when it has no upcoming occurrence. That list is not made of inbox items, and in this version a device does not
see it (`remote-protocol`).

The recurrence SHALL keep going until its end time, if it has one, or until the user stops it. When the next
matching time would be later than its end time, no occurrence SHALL be created and the recurrence ends. An
occurrence created before its end time SHALL still open if it opens late.

#### Scenario: Each time opens a new session

- **GIVEN** an approved recurrence for folder B whose occurrence is two minutes from now
- **WHEN** that time passes, and later the following matching time passes
- **THEN** folder B has two new agent sessions, one for each time, each with the recurrence's prompt sent once its agent is ready

#### Scenario: The next occurrence is listed as soon as one opens

- **WHEN** an occurrence of a weekly recurrence opens
- **THEN** the scheduled section lists the occurrence one week later

#### Scenario: A recurrence survives a restart

- **WHEN** a recurrence is approved and the application restarts
- **THEN** the scheduled section lists exactly one occurrence for it, at the same time as before the restart

#### Scenario: A restart after a crash between the two writes leaves one occurrence

- **GIVEN** the application stopped after an occurrence was added and before the recurrence recorded it
- **WHEN** the application starts after that occurrence's time
- **THEN** exactly one occurrence of the recurrence is opened or listed, not two

#### Scenario: A removed target fails one occurrence and the recurrence waits for the user

- **GIVEN** an approved daily recurrence for folder B, and the user then removes folder B from the workspace
- **WHEN** its next time comes, and the following two times pass
- **THEN** one failure is visible with a notification and an inbox trace, one pending item stands for it, no further occurrence is created, and the recurrences section states that an earlier time is waiting

#### Scenario: The next occurrence exists while an occurrence is still opening

- **WHEN** an occurrence fires and its session has been requested but not yet created
- **THEN** the scheduled section already lists the next occurrence

#### Scenario: Dealing with the waiting item resumes the recurrence

- **GIVEN** a recurrence waiting because an earlier occurrence failed
- **WHEN** the user ignores that item
- **THEN** the scheduled section lists the recurrence's next matching time after now

#### Scenario: An occurrence whose folder is gone names no other folder

- **GIVEN** a recurrence approved into folder B, folder B removed from the workspace, and a routing rule and a fallback folder that would match the occurrence
- **WHEN** its next occurrence is created
- **THEN** the occurrence is listed as having its folder gone, never with the rule's or the fallback's folder

#### Scenario: An unreadable recurrence file changes nothing

- **GIVEN** an approved recurrence with an upcoming occurrence, and its recurrence file then damaged
- **WHEN** the application starts
- **THEN** the upcoming occurrence is still listed, the file is unchanged, the inbox states that the recurrences could not be read, and approving a proposal is refused with that reason

### Requirement: Times missed while the application was closed run once

When one or more of a recurrence's times passed while its occurrence could not open — the application was not
running, the computer was asleep, or no window could receive it — its upcoming occurrence SHALL open **once**,
without asking, as soon as a window can receive it. No further occurrence SHALL be created for the other missed
times; the next occurrence is the first matching time after it opened. Should two overdue occurrences of the same
recurrence exist at a start (the application stopped between creating one and recording it), only one SHALL
open: for occurrences of one recurrence, that is the coalescing this requirement asks for, not the dropping of
an overdue handoff that `scheduled-handoff` forbids.

#### Scenario: Three missed times open one session

- **GIVEN** an approved daily recurrence, and the application closed for three days across three of its times
- **WHEN** the application starts and its window restores its sessions
- **THEN** exactly one new session is created for it, and the scheduled section lists its next time after now

### Requirement: The agent of an occurrence is told it repeats and what was missed

The session an occurrence opens SHALL be told, in the system-composed part of its handoff context (outside the
fenced body): that the handoff repeats on its expression in local time, approved by the user, and that each
time opens its own session; the time this occurrence was scheduled for and the time it started; and, when later
matching times passed before it was opened — not later than the end time — how many and which (up to ten listed,
and how many more); and the end time, if there is one. Times
after it was opened — while a failed occurrence waited for the user — SHALL NOT be stated as missed. This
text is for the agent and SHALL be English, outside the dictionaries.

The fenced body SHALL stay exactly the body the agent wrote in its proposal.

#### Scenario: A late occurrence's context lists the missed times

- **GIVEN** an approved recurrence `0 9 * * *` whose 09:00 occurrence on Monday opened on Wednesday at 10:00 because the application was closed
- **WHEN** its agent reads its handoff context
- **THEN** outside the fenced body it reads that the handoff repeats on `0 9 * * *`, was scheduled for Monday 09:00, started on Wednesday at 10:00, and that two later times — Tuesday and Wednesday at 09:00 — were not run separately

#### Scenario: A failed occurrence accepted days later lists no missed times

- **GIVEN** a daily occurrence whose opening failed on time on Monday
- **WHEN** the user accepts it from the inbox on Thursday
- **THEN** its context states both times and states no missed times

#### Scenario: An occurrence on time lists no missed times

- **WHEN** an occurrence opens within a minute of its time
- **THEN** its context states that it repeats and both times, and states no missed times

### Requirement: The user runs, skips and stops a recurrence in the inbox

An upcoming occurrence SHALL offer the scheduled handoff's two actions (`scheduled-handoff`), with these effects:

- **Run now** — opens this occurrence at once; the next occurrence is the first matching time after this
  occurrence's own time, so the time that was run early is not run again;
- **Skip** — the occurrence's Cancel, labelled for what it does: this time never opens; the recurrence continues
  with its next time.

Each recurrence in the recurrences section SHALL offer **Stop repeating**, which SHALL ask for confirmation
before it acts: the recurrence ends, its upcoming occurrence is removed, and no further occurrence is created.
A waiting occurrence stays for the user, and sessions already opened are not affected. A stopped recurrence
cannot be proposed again with the same content from the same session — that is a duplicate — so stopping is not
one click.

Stopping SHALL be possible on the desktop only in this version (`remote-protocol`).

#### Scenario: Run now does not run the same time again

- **GIVEN** a weekly recurrence whose occurrence is on Wednesday at 21:00, and it is Tuesday
- **WHEN** the user chooses Run now
- **THEN** a session is created at once, and the scheduled section lists the occurrence for the Wednesday after next

#### Scenario: Skip moves to the next time

- **GIVEN** a weekly recurrence whose occurrence is this Wednesday at 21:00
- **WHEN** the user skips it and Wednesday 21:00 passes
- **THEN** no session is created for it, and the scheduled section lists next Wednesday's occurrence

#### Scenario: Stop repeating asks first

- **WHEN** the user chooses Stop repeating and then declines the confirmation
- **THEN** the recurrence and its upcoming occurrence are unchanged

#### Scenario: Stop repeating ends the recurrence

- **WHEN** the user stops a recurrence and confirms, its next time passes, and then the application restarts
- **THEN** no session is created for it, and the inbox lists neither the recurrence nor an occurrence of it

### Requirement: Scheduling has its own tab in the inbox

The inbox SHALL show everything about scheduling in its own tab, **Schedules**, beside the tab of items waiting
for the user and the rules tab, so that what to deal with now is not mixed with what is planned:

- the Schedules tab SHALL hold, in this order: proposals waiting for approval (with Approve and Decline); every
  scheduled handoff — one-off scheduled handoffs (`scheduled-handoff`) and the upcoming occurrences of
  recurrences — in one list, earliest first; and the approved recurrences;
- the items tab SHALL NOT list any of those. It keeps every other pending item, including an occurrence that
  was opened and is now waiting for the user (its opening failed, or its prompt was not filled in in time),
  which is shown with its expression;
- the Schedules tab's label SHALL carry the number of proposals waiting for approval when there are any. The
  activity bar's badge SHALL count proposals as items waiting for the user, as before; scheduled handoffs are not
  counted, as before;
- opening the inbox from an arrival notification that stands only for proposals SHALL show the Schedules tab;
  a notification that also stands for other items (notifications are merged, `agent-intake`), and every other
  way of opening the inbox, SHALL show the items tab, as before. When the inbox is already open, triggering a
  notification SHALL NOT change its tab (`agent-intake`).

#### Scenario: Scheduled items are not in the items tab

- **GIVEN** the inbox holds one ordinary pending handoff, one proposal, one one-off scheduled handoff and one approved recurrence
- **WHEN** the user opens the inbox
- **THEN** the items tab lists only the ordinary handoff, and the Schedules tab lists the proposal, then the scheduled handoff and the recurrence's upcoming occurrence by time, then the recurrence

#### Scenario: The Schedules tab shows how many proposals wait

- **WHEN** two proposals wait for approval
- **THEN** the Schedules tab's label shows 2, and the activity bar's inbox badge counts both

#### Scenario: A proposal's notification opens the Schedules tab

- **GIVEN** the inbox is not open, and was last left on the rules tab
- **WHEN** the user triggers the arrival notification of a proposal
- **THEN** the inbox opens on the Schedules tab with the proposal in view

#### Scenario: Another notification opens the items tab

- **GIVEN** the inbox is not open, and was last left on the rules tab
- **WHEN** the user triggers the arrival notification of an ordinary handoff
- **THEN** the inbox opens on the items tab

### Requirement: A recurrence is not a promise that work runs while spekterm is closed

The system SHALL NOT claim that a recurrence runs at its times regardless of the application's state. It opens
only while the application runs; times that pass while it is closed are honoured once at the next start. The
introduction and the user documentation SHALL say so.

#### Scenario: The introduction states how missed times are handled

- **WHEN** the text injected into an agent's context is examined
- **THEN** it states that a repeating handoff opens only while spekterm is running, and that times missed while it was closed run once at the next start
