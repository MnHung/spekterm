## Purpose

Lets an agent take back what it, or any other agent session, planned: cancel a scheduled handoff, skip an occurrence,
decline a proposal or stop a recurrence, through the outbox, so a plan changed in conversation does not leave stale
work scheduled.

## ADDED Requirements

### Requirement: An agent cancels a scheduled item by its id, through its own outbox

An agent session SHALL be able to write `{"kind": "cancel", "id": "<id>"}` into its own outbox, by the outbox's rules
(a new file name ending in `.json`, written atomically). Only `id` SHALL be read; any other field has no effect. A
cancel without a non-empty string `id` SHALL be refused as a field of the wrong type, naming `id`.

The id SHALL be one the system gave out: an item's id as the schedules file lists it, or as the receipt of the
handoff that created it states it (`handoff-receipt`). A cancel SHALL NOT be addressed by a file name, a title or a
target.

The cancel SHALL be decided and carried out when the file is read. Its receipt SHALL state `accepted` only once the
cancel has taken effect.

#### Scenario: A scheduled handoff is cancelled by the id its receipt gave

- **GIVEN** an agent wrote a handoff scheduled for tomorrow, and its receipt states `scheduled` with an id
- **WHEN** the agent writes a cancel with that id
- **THEN** the cancel's receipt states `accepted`, the Schedules tab no longer lists the handoff, and no session is created for it when tomorrow comes

#### Scenario: A cancel without an id is refused

- **WHEN** an agent writes `{"kind": "cancel"}`
- **THEN** the receipt states `rejected` with the code for a field of the wrong type, naming `id`, and nothing in the Schedules tab changes

#### Scenario: Other fields do not choose what is cancelled

- **GIVEN** two scheduled handoffs A and B
- **WHEN** an agent writes a cancel with A's id and a `target` and `title` matching B
- **THEN** A is cancelled and B is still listed

### Requirement: A cancel has the effect of the desktop's own action on the item it names

What a cancel can name SHALL be exactly what the inbox's Schedules tab lists at the moment the file is read
(`recurring-handoff`), and its effect SHALL be the desktop's own action on that item, with every consequence the
desktop's action has:

- a one-off scheduled handoff — **Cancel**: it never opens;
- an upcoming occurrence of a recurrence — **Skip**: this time never opens, and the recurrence's next occurrence is
  created as when the user skips it;
- a proposal waiting for approval — **Decline**: it never opens and is no longer listed;
- an approved recurrence — **Stop repeating**: the recurrence ends, its upcoming occurrence is removed, and no
  further occurrence is created; an occurrence waiting for the user stays, and sessions already opened are not
  affected. **No confirmation is asked**: the desktop's confirmation applies to the desktop's button only.

A change made by a cancel SHALL reach the desktop's inbox and every paired device at once, as a change made on the
desktop does.

#### Scenario: Skipping an occurrence moves to the next time

- **GIVEN** a weekly recurrence whose upcoming occurrence is this Wednesday at 21:00
- **WHEN** an agent cancels that occurrence by its id
- **THEN** the Schedules tab lists next Wednesday's occurrence, and no session is created this Wednesday

#### Scenario: Stopping a recurrence from an agent asks nothing

- **GIVEN** an approved recurrence with an upcoming occurrence
- **WHEN** an agent cancels the recurrence by its id
- **THEN** no confirmation is shown, the Schedules tab lists neither the recurrence nor its occurrence, and after the occurrence's time passes and the application restarts, no session was created for it

#### Scenario: A proposal cancelled by an agent never opens

- **GIVEN** a proposal waiting for approval
- **WHEN** an agent cancels it by its id
- **THEN** the Schedules tab no longer lists it, the activity bar's count no longer includes it, and there is nothing left to approve

#### Scenario: A cancel shows on the open inbox without a reload

- **GIVEN** the inbox is open on the Schedules tab, listing a scheduled handoff
- **WHEN** an agent cancels it
- **THEN** the Schedules tab stops listing it without the user doing anything

### Requirement: Only what the Schedules tab lists can be cancelled

A cancel whose id names a handoff already dismissed (cancelled, declined, skipped or ignored — by an agent, on the
desktop or from a device) or a recurrence already stopped SHALL change nothing and SHALL NOT be refused: its receipt SHALL state `duplicate`, and no trace or
notification SHALL be raised. The state it asks for already holds.

Otherwise a cancel SHALL be refused, permanently, with a code saying the id names nothing that can be cancelled and a
system-written detail saying which case, when its id names:

- nothing the system knows;
- a handoff whose opening has begun (the opener asked a window to open it, or the user accepted it or chose Run now),
  or which was opened;
- an item that is not in the Schedules tab: one waiting for the user in the items tab, an item from another producer
  (Slack, a teammate), an outgoing teammate handoff;
- a recurrence that has ended with nothing left to open.

A cancel SHALL be refused as temporary when the recurrences cannot be read and its id may name a recurrence (it names
no inbox item, or a proposal that is no longer pending), or when stopping a recurrence could not be saved; its reason
SHALL say it can succeed once that is resolved. An approved recurrence's id SHALL NOT be refused permanently because
its recurrence could not be read.

A cancel SHALL NOT close, hibernate or otherwise act on any session.

A refused cancel SHALL be visible to the user as any refused outbox file is (`agent-handoff-source`).

#### Scenario: A handoff that is already opening cannot be cancelled

- **GIVEN** a scheduled handoff whose time has come, and whose opening has begun
- **WHEN** an agent cancels it by its id
- **THEN** the receipt states `rejected`, permanent, with the not-cancellable code and a detail saying its opening has begun, and its session opens as it would have

#### Scenario: An item waiting for the user cannot be cancelled

- **GIVEN** a scheduled handoff whose opening failed, so that it waits in the items tab
- **WHEN** an agent cancels it by its id
- **THEN** the receipt states `rejected` with the not-cancellable code, and the item is still in the items tab

#### Scenario: An unknown id is refused and visible

- **WHEN** an agent writes a cancel whose id names nothing
- **THEN** the receipt states `rejected`, permanent, with a detail saying the id is unknown, and the inbox shows the refusal as it shows other refused deliveries

#### Scenario: Cancelling twice is not a failure

- **GIVEN** an agent cancelled a scheduled handoff, and the cancel's receipt states `accepted`
- **WHEN** an agent writes a second cancel with the same id
- **THEN** its receipt states `duplicate`, and the inbox shows no refusal and no notification is raised

#### Scenario: A cancel never touches a session

- **GIVEN** a handoff that was opened into a running session
- **WHEN** an agent cancels it by its id
- **THEN** the cancel is refused, and the session is still running

### Requirement: What agents cancelled is listed quietly in the Schedules tab

Every cancel an agent carried out SHALL be listed in a section of the inbox's Schedules tab for 7 days after it, with
the item's title (or, when it has none, the start of its body), what was done (cancelled, skipped, declined or
stopped), the label of the session that wrote the cancel, and when. The section SHALL raise no notification, SHALL
NOT count toward the activity bar's count, and SHALL offer no action. A line SHALL leave the section 7 days after the
cancel, and the section SHALL be absent when it has no line. Cancels made on the desktop or from a device SHALL NOT be
listed there. A cancel that changed nothing (`duplicate`) SHALL NOT add a line.

The list SHALL survive a restart of the application.

#### Scenario: An agent's stop is listed with its source

- **GIVEN** an approved recurrence titled "Weekly report"
- **WHEN** an agent in a session of folder B stops it with a cancel
- **THEN** the Schedules tab shows a line saying "Weekly report" was stopped by an agent from B, with the time, and no notification is raised

#### Scenario: The line outlives a restart and ages out

- **GIVEN** an agent cancelled a scheduled handoff
- **WHEN** the application restarts
- **THEN** the line is still listed, and it is no longer listed once 7 days have passed since the cancel

#### Scenario: The desktop's own cancel adds no line

- **WHEN** the user cancels a scheduled handoff on the desktop
- **THEN** the section lists nothing for it

### Requirement: Any agent session may cancel

A cancel SHALL be carried out whichever agent session wrote it: the session that wrote the handoff, its parent, a
sibling, or a session unrelated to it, including the global session. The source of the cancel SHALL NOT be checked
against the source of the item.

#### Scenario: An unrelated session cancels another session's scheduled handoff

- **GIVEN** session A wrote a scheduled handoff, and session B, in another folder and not related to A, exists
- **WHEN** session B writes a cancel with the handoff's id
- **THEN** the handoff is cancelled, and the cancel's receipt in B's receipts directory states `accepted`

#### Scenario: A handoff whose writer has ended can be cancelled

- **GIVEN** a scheduled handoff whose writing session has since been closed
- **WHEN** another session cancels it by its id
- **THEN** it is cancelled

### Requirement: The schedules file lists what can be cancelled and states the rules

The system SHALL keep a schedules file at one fixed location beside the teammates file, readable by every agent
session, listing what can be cancelled in three groups that are the Schedules tab's groups: proposals waiting for
approval, scheduled handoffs (one-off and upcoming occurrences), and approved recurrences. Each entry SHALL carry its
id and what an agent needs to tell the user what it is: its title, its target folder's name, its time (or its
expression and, for a recurrence, its next time and end), its source's label, and the first 200 characters of its
body. A recurrence whose approved folder no longer exists SHALL say so. A scheduled occurrence SHALL name its recurrence's id. Times SHALL be
stated as receipts state them.

The file SHALL list only handoffs written by the user's own agent sessions; it SHALL NOT contain text from Slack, from
a teammate, or from any other third party. It SHALL NOT contain a path the system derived (a folder's path, a
recurrence's approved folder); text an agent wrote is written as it is.

The file SHALL state whether the recurrences could be read, and SHALL carry the rules in words for the agent
(English, outside the dictionaries), stating:

- the cancel's shape, and what a cancel does to each kind of item;
- that a cancel cannot be undone;
- that when the agent did not write the item, it is to confirm with the user which item it is cancelling;
- that the file is a snapshot, and an item whose opening began since is refused;
- how to change an item: write the new handoff first, and cancel the old one only after the new one's receipt states
  `accepted` or `scheduled`; a changed recurrence is a new proposal the user approves again, and the old recurrence is
  to be stopped only once the new one appears among the approved recurrences, telling the user meanwhile that the new
  one is proposed and the old one still runs;
- that a cancelled handoff written again with the same content from the same session is a duplicate, and nothing
  happens, so something in it has to differ;
- what the cancel's receipt states, including `duplicate` for an item already cancelled.

The file SHALL be rewritten whole (never readable half-written) whenever what the Schedules tab lists changes, and at
start. Failing to write it SHALL NOT stop anything else: a cancel by an id from a receipt still works.

Every number the rules state SHALL be derived from the constant the check uses, as the introduction's are.

#### Scenario: The file lists what the Schedules tab lists

- **GIVEN** the inbox holds one proposal, one one-off scheduled handoff, one approved recurrence with its upcoming occurrence, and one ordinary pending handoff
- **WHEN** an agent reads the schedules file
- **THEN** it lists the proposal, the scheduled handoff and the occurrence (naming its recurrence's id), and the recurrence, each with its id, and does not list the ordinary pending handoff

#### Scenario: The file follows a change at once

- **GIVEN** the schedules file lists a scheduled handoff
- **WHEN** the user cancels it on the desktop
- **THEN** the schedules file no longer lists it

#### Scenario: An untitled handoff can be told apart

- **GIVEN** two scheduled handoffs without a title, with different bodies
- **WHEN** an agent reads the schedules file
- **THEN** each entry carries the start of its own body

#### Scenario: A Slack item is never in the file

- **GIVEN** the inbox holds an item from Slack and a scheduled handoff
- **WHEN** an agent reads the schedules file
- **THEN** no text of the Slack item appears in it

#### Scenario: Unreadable recurrences are stated

- **GIVEN** the recurrence file cannot be read
- **WHEN** an agent reads the schedules file
- **THEN** the file states that the recurrences could not be read, and a cancel of an approved recurrence's id is refused as temporary, not permanent
