## ADDED Requirements

### Requirement: The Sent list shows every handoff the member sent to a teammate

The inbox SHALL have a **Sent** tab listing the handoffs the current team member sent to teammates, as the team
server reports them, newest change first. Each row SHALL show:

- the status: pending, delivered, taken, declined, done or expired, and how long since it last changed;
- the recipient's handle and display name, and that they are **no longer on the team** when the server says so;
- the title for a handoff this device sent; a handoff sent from another device of the member, or from this device
  before it joined again, SHALL be shown without a title, saying why;
- for a declined handoff with a reason and for a done handoff, the reason or the latest report as **plain
  third-party text** (the inbox's plain-text presentation), with a way to copy it;
- that the server no longer has the handoff, when a reset of the server's list did not include it.

Records SHALL be kept on this device for 90 days after their last change, also after the server deleted the text.
The Sent list SHALL show only the current membership's records. The inbox's count of unhandled items SHALL NOT
include Sent records.

#### Scenario: A handoff sent from this device shows its title and status

- **WHEN** the user confirms a teammate handoff titled "Fix billing export" to `sam` and the server answers it
- **THEN** the Sent tab lists it with that title, `sam` and the status pending

#### Scenario: A handoff sent from another device has no title

- **WHEN** the server's list includes a handoff the member sent from another device
- **THEN** the Sent tab lists it with its recipient and status and a label saying the title is not available

#### Scenario: A recipient who left the team is marked

- **WHEN** a record arrives whose recipient has been removed from the team
- **THEN** the row says the recipient is no longer on the team

#### Scenario: A report is shown as plain text

- **WHEN** a done record's report contains markdown and an HTML tag
- **THEN** the Sent tab shows the report's characters as written, not rendered

#### Scenario: The Sent list does not count in the badge

- **WHEN** the Sent list has records and the inbox has no pending item
- **THEN** the activity bar's inbox count shows nothing

### Requirement: The Sent list is synchronized from the last stored sequence number

After every successful authentication with a server whose operations include `handoff.sync`, spekterm SHALL request
`handoff.sync` from the last sequence number it stored for the current membership, and again from the last record's
sequence number while the answer says `more: true`. It SHALL then apply each `handoff.status` event.

- A record SHALL be stored durably **no later than** the sequence number it raises.
- Outside a reset, a record SHALL replace the stored one with the same id only when its sequence number is greater;
  otherwise it SHALL be ignored. The stored sequence number is the highest one seen.
- On an answer with `reset: true`, spekterm SHALL record durably that a reset is in progress before storing that
  answer's records. **While a reset is in progress** (the server's numbering went back), a record SHALL replace the
  stored one with the same id whatever its sequence number, and the stored sequence number SHALL be set to each
  page's last one. When an answer says `more: false`, every stored record of the membership not received since the
  reset began SHALL be marked as unknown to the server, and the record that a reset is in progress SHALL be cleared.
  If paging is interrupted, the next synchronization SHALL start from 0 and SHALL be treated as the same reset, even
  though its answers do not say `reset: true`. A record received later for an id marked unknown to the server SHALL
  clear that mark.
- After the connection closes with code 1011, spekterm SHALL reconnect with backoff and synchronize again.
- A server whose operations do not include `handoff.sync` SHALL NOT be sent it; the Sent tab SHALL say the server
  does not support it.
- Leaving and joining the same member again SHALL resume from that member's stored sequence number; another
  membership SHALL start from 0.

#### Scenario: Paging until more is false

- **WHEN** the server has 250 records after the stored sequence number and answers 100 per page
- **THEN** spekterm requests three pages, and the Sent list has the 250 records

#### Scenario: A record seen twice is applied once

- **WHEN** a record arrives in a page and again as an event with the same sequence number
- **THEN** the stored record is unchanged by the second and no second notification is raised

#### Scenario: A crash between pages loses nothing

- **WHEN** spekterm stops after storing a page and is started again
- **THEN** its next synchronization starts after that page's last record

#### Scenario: A reset replaces records with lower sequence numbers

- **GIVEN** the stored record of handoff H has sequence number 500 and status delivered
- **WHEN** the server, restored from an older backup, answers `reset: true` with H at sequence number 40 and status
  done, and then `more: false`
- **THEN** H is shown as done, and the next synchronization starts after 40, not after 500

#### Scenario: An interrupted reset is finished from zero

- **WHEN** an answer says `reset: true`, and the connection drops before an answer says `more: false`
- **THEN** after reconnecting spekterm synchronizes from 0, and only then marks the records the server no longer has

#### Scenario: A 1011 close is followed by a resync

- **WHEN** the server closes the connection with 1011
- **THEN** spekterm reconnects with backoff and requests `handoff.sync` from its stored sequence number

### Requirement: The sending device is notified when a handoff ends

When a record of status done, declined or expired is applied, the device that sent it (`sentFrom`) is this device,
and either a stored copy of it exists with another status or report count, or it is a send of this device still
waiting for its answer, spekterm SHALL raise a desktop notification. The answer to a send SHALL count as such a
record (a resend after a lost answer may already be final). Every handoff this device sends SHALL have a stored copy
from the moment the server answers the send. Any other record with no stored copy SHALL NOT notify, and no record
applied while a reset is in progress SHALL notify. Other devices of the member SHALL
update their list without notifying.

The notification SHALL use fixed copy, the local title (or the recipient's display name when there is none) and,
for done and for a declined handoff with a reason, the beginning of the text, each non-fixed field reduced as
third-party text is before it enters a notification (`agent-intake`). Notifications SHALL coalesce with the inbox's
others; activating one made only of Sent items SHALL open the Sent tab.

#### Scenario: Done notifies the sending device only

- **WHEN** the member's laptop sent a handoff and both the laptop and the desktop are connected, and the handoff
  becomes done
- **THEN** the laptop raises one notification and the desktop raises none, and both list it as done

#### Scenario: A newer report notifies again

- **WHEN** a done handoff receives a second report
- **THEN** the sending device raises one more notification

#### Scenario: A resent send that is already done notifies once

- **WHEN** this device's send was stored by the server but its answer was lost, the handoff became done meanwhile,
  and the resend is answered with status done
- **THEN** the device raises one notification for it

#### Scenario: Upgrading does not notify old results

- **WHEN** a member who sent handoffs with an earlier spekterm synchronizes for the first time
- **THEN** the Sent list shows them and no notification is raised

#### Scenario: Activating the notification opens the Sent tab

- **WHEN** the user activates a notification about a done handoff
- **THEN** the window comes forward with the inbox open on the Sent tab

### Requirement: The sending session sees the status of its teammate handoffs, never their text

The relations file of a session that sent teammate handoffs SHALL list each of them with the recipient's handle, the
title the session wrote, the status and when it last changed, and that the recipient left the team when they did.
It SHALL NOT contain the report, the decline reason or the recipient's display name: those are written by the
teammate or their agent and SHALL NOT enter the sending agent's context on spekterm's own initiative. The teammates
file's rules SHALL explain this field. The relations file SHALL be rewritten when a status changes.

#### Scenario: The agent sees done but not the report

- **WHEN** session S sent a handoff to `sam` and it becomes done with a report
- **THEN** S's relations file lists it with status done, and the report's text appears nowhere in that file

#### Scenario: Another device's sends are not attributed to a session

- **WHEN** a record arrives for a handoff sent from the member's other device
- **THEN** no session's relations file lists it

### Requirement: A session opened from a teammate's handoff is linked to it before it starts

When the user accepts a teammate's handoff (adapter `teammate`), the session created for it SHALL be linked to the
server's handoff before its process starts, by the main process, through the same single-use mechanism that records a
session's source; the renderer SHALL NOT be able to link a session to a handoff by naming it. The link SHALL survive
restarts. It SHALL NOT be a lineage: the session has no parent session, does not nest on the rail, and its relations
file has no parent.

#### Scenario: The link exists at the session's first start

- **WHEN** the user accepts a teammate's handoff into a folder
- **THEN** the introduction injected at the new session's first start already contains the teammate report paragraph

#### Scenario: The link survives a restart

- **WHEN** spekterm restarts and the session is resumed
- **THEN** a report the agent delivers afterwards is sent for the same handoff

#### Scenario: A renderer cannot link an existing session

- **WHEN** the renderer creates a session naming a teammate item without a ticket the main process issued
- **THEN** the session has no link and its reports are refused as not from a handoff

### Requirement: The receiving side reports taken, declined and done to the server

spekterm SHALL report on a teammate's handoff only when its acknowledgement was answered as accepted, from the
device and under the membership it was answered under, and only to a server whose operations include
`handoff.update`. An item that does not meet these conditions SHALL be accepted without a link and SHALL NOT offer
Decline. Reports:

- **taken** once the linked session has actually started on the handoff — when its agent starts working after the
  user sent the filled-in first prompt — and not when the user presses Accept nor when the prompt is merely filled
  in; a session whose prompt was never sent SHALL NOT report taken; if spekterm restarts between the fill and the
  send, taken MAY be omitted (the protocol lets done or declined follow delivered);
- **declined** only when the user declines the item (next requirement);
- **done** with the linked session agent's completion report.

Reports of one handoff SHALL be sent one at a time, in the order they were made, each after the previous one was
answered. After an answer is lost (a timeout, a dropped connection, a restart) the same report SHALL be sent again
before any later one. A report never sent MAY be dropped when a later one makes it redundant (a newer done replacing an
older one, a taken followed by done or declined).

On `HANDOFF_NOT_DELIVERED` spekterm SHALL acknowledge the handoff again and then send the same report, once per
report. On `HANDOFF_FINISHED`, `HANDOFF_EXPIRED`, `HANDOFF_DELIVERED_ELSEWHERE`, `HANDOFF_UNKNOWN`,
`TOO_MANY_REPORTS`, `BAD_PARAMS` or an operation the server does not offer, it SHALL stop reporting for that handoff,
SHALL NOT retry it. On `INTERNAL` it SHALL retry the same report with backoff. When the membership or the device the
handoff was received under ends, reporting for it SHALL stop, whether or not a report is waiting. After a decline was
answered, nothing more SHALL be reported for that handoff.

When reporting stops with reports unsent, spekterm SHALL make it visible: one trace in the inbox and a notification,
naming the handoff's title and saying that its sender did not receive them (the title and the sender's name reduced
as third-party text). A later report from the linked session of a stopped or declined handoff SHALL be refused at
once with a receipt saying reporting for that handoff has stopped, and SHALL NOT be sent.

#### Scenario: Taken is reported once the user sends the prompt

- **WHEN** the user accepts a teammate's handoff, the prompt is filled in, and the user sends it and the agent starts
  working
- **THEN** spekterm sends `taken` for that handoff

#### Scenario: A filled prompt alone is not taken

- **WHEN** the user accepts a teammate's handoff and the prompt is filled in, and the user has not sent it
- **THEN** no report is sent

#### Scenario: A prefill timeout reports nothing

- **WHEN** the user accepts a teammate's handoff and the prompt is never filled in before the timeout
- **THEN** no report is sent, and the item is pending again

#### Scenario: The agent's report is sent as done

- **WHEN** the linked session's agent delivers a completion report with summary S
- **THEN** spekterm sends `done` with text S after any earlier report of that handoff was answered

#### Scenario: A lost answer is retried with the same report

- **WHEN** spekterm sends `done` with S1, the connection drops before the answer, and the agent then reports S2
- **THEN** after reconnecting spekterm sends `done` with S1 again before `done` with S2

#### Scenario: Too many reports stops reporting visibly

- **WHEN** the server answers `TOO_MANY_REPORTS` to a report
- **THEN** no further report for that handoff is sent, the inbox shows a trace for it and a notification is raised
- **AND** the agent's next report receives a `rejected` receipt saying reporting has stopped

#### Scenario: Not delivered is acknowledged again

- **WHEN** the server answers `HANDOFF_NOT_DELIVERED`
- **THEN** spekterm sends `handoff.received` for the handoff and, once it is answered, the same report

#### Scenario: A server without the way back offers no Decline and no link

- **WHEN** the team server's operations do not include `handoff.update` and a teammate's handoff arrives
- **THEN** its inbox item offers no Decline, the session opened for it has no report paragraph, and no report is sent

#### Scenario: A handoff shown without an answered acknowledgement cannot be reported

- **WHEN** a teammate's handoff is shown because the server answered `HANDOFF_UNKNOWN` to its acknowledgement
- **THEN** its inbox item offers no Decline, and the session opened for it has no link

#### Scenario: Leaving the team stops reporting

- **WHEN** the device's credential is discarded while a report is queued
- **THEN** that report is not sent, and the stop is shown as a trace in the inbox
- **AND** a report the linked agent delivers afterwards is refused with a receipt saying reporting has stopped

### Requirement: A teammate's handoff can be declined, with an optional reason

A pending inbox item of adapter `teammate` that may be reported on (previous requirement) SHALL offer **Decline**
besides ignoring it. Declining SHALL let the user
write an optional reason of at most 500 UTF-16 code units, shown with its length as it is typed; the item SHALL then
leave the pending list as an ignored item does, and spekterm SHALL report `declined` with the reason (none when it is
empty). Ignoring an item SHALL send nothing to the server.

The decline reason and the completion report SHALL be normalized as authored text, then made well-formed UTF-16, and
only then measured against their limit, so that a text spekterm accepted is not refused by the server.

#### Scenario: Declining with a reason reaches the server

- **WHEN** the user declines a teammate's item with the reason "Not my area — ask the billing team"
- **THEN** the item leaves the pending list and spekterm sends `declined` with that reason

#### Scenario: Declining without a reason

- **WHEN** the user declines a teammate's item leaving the reason empty
- **THEN** spekterm sends `declined` with no reason

#### Scenario: Ignoring tells the sender nothing

- **WHEN** the user ignores a teammate's item
- **THEN** no report is sent for it

#### Scenario: A reason over the limit cannot be sent

- **WHEN** the user types a reason of 501 code units
- **THEN** Decline is not available until the reason is shortened

#### Scenario: A lone surrogate does not make a report refused

- **WHEN** an agent's summary contains a lone surrogate
- **THEN** the text sent carries U+FFFD in its place and is within the limit the agent was told
