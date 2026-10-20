## MODIFIED Requirements

### Requirement: Inbox accept from a device follows the desktop's accept

Listing the inbox SHALL return the same items and fields the desktop's inbox shows, including each item's
full body as plain text. Accepting SHALL require a folder chosen by the device user and SHALL be refused
without one.

Accepting SHALL be carried out by the window's interface along the same path as the desktop's accept:

- it reuses the session an earlier accept of the same item left in that folder;
- otherwise it creates a session there, under the rules for device-requested creation above;
- the item's first prompt is then filled in and submitted or left unsent, by the same rule as on the
  desktop (`agent-intake`).

A prompt left unsent SHALL then be sendable from the device only as a separate, explicit operation
("A device sees a filled-in prompt waiting to be sent, and sends it as the user's Enter"). Accepting SHALL NOT
take a parameter that submits it: the accept usually answers before the prompt is filled in, so such a parameter
would have the desktop submit a third-party body later on its own.

If the session cannot be created, the accept SHALL be refused, and the item SHALL stay pending.

**A repeating proposal (`recurring-handoff`) SHALL NOT be accepted from a device**: the accept SHALL be refused
with a named error stating that it is approved on the desktop, and the proposal SHALL stay pending. A client
that does not know repeating handoffs shows a proposal as an ordinary pending item, so accepting it there would
approve an unbounded schedule its user was never shown. Approval from a device needs an operation of its own.

Ignoring SHALL have the same effect as the desktop's ignore. Any change to the inbox, made on the desktop or
from a device, SHALL be sent to connected clients as a new complete list and SHALL be reflected in the
desktop's inbox.

The protocol document SHALL require a client to show an item's full body as plain text before it offers to
accept that item, which is the human check `agent-intake` places before acceptance. This repository has no
carrier for that obligation. It falls to the client.

The protocol document SHALL describe, in its accept section, how a device sends a prompt the accept left
unsent.

#### Scenario: Accepting a third-party item from a device opens a prefilled session in the chosen folder

- **WHEN** an inbox item with a third-party body is pending, and a client accepts it into a folder it names
- **THEN** an agent session is created in that folder with the item's first prompt filled in and not sent, and the item is no longer pending

#### Scenario: Accepting again reuses the earlier session

- **WHEN** an item accepted from a device went back to pending because its agent did not become ready within the prefill time limit, and the client accepts it again into the same folder
- **THEN** no second session is created, and the earlier session receives the prompt once its agent is ready

#### Scenario: A creation failure leaves the item pending

- **WHEN** a client accepts an item into a folder in which no session can be created
- **THEN** the response is an error, and the item stays pending

#### Scenario: Accepting without a folder is refused

- **WHEN** a client accepts an inbox item without naming a folder
- **THEN** the response is an error, and the item stays pending

#### Scenario: Ignoring from a device updates the desktop

- **WHEN** a client ignores a pending inbox item
- **THEN** the item no longer appears in the inbox list on the client or on the desktop

#### Scenario: Ignoring on the desktop updates the client

- **WHEN** the user ignores a pending inbox item on the desktop while a client is connected
- **THEN** the client receives an inbox list without that item

#### Scenario: Accepting a repeating proposal from a device is refused

- **WHEN** a client accepts a repeating proposal into a folder it names
- **THEN** the response is the named error, no session is created, nothing is scheduled, and the proposal stays pending

## ADDED Requirements

### Requirement: A device sees repeating handoffs, declines a proposal, and runs or skips an occurrence

The inbox list SHALL mark every item that belongs to a repeating handoff (`recurring-handoff`) with its role —
a proposal waiting for approval, or an occurrence of an approved recurrence — and its cron expression as the
agent wrote it, and its end time when it has one. A proposal SHALL also carry its next times, up to three, in the list's
time unit, as computed when the list was built. A client SHALL be able to tell a proposal from an occurrence from that mark alone, whatever the
item's other fields: an occurrence whose opening failed is pending without a scheduled time, and is still an
occurrence.

Ignoring a proposal SHALL decline it, with the effect of the desktop's Decline. Accepting an occurrence that is
still scheduled SHALL run it now, as accepting a scheduled handoff does; accepting one whose opening failed
SHALL follow the ordinary accept. **Ignoring an occurrence SHALL skip that time only**; the recurrence continues.
Stopping a recurrence SHALL NOT be possible from a device in this version, and the desktop's list of approved
recurrences is not part of the inbox list: a device does not see a recurrence that has no upcoming occurrence.

These SHALL be fields on existing items and meanings of existing operations: the protocol version and the
allow-list of operations SHALL NOT change. The protocol document SHALL describe the fields, the meanings and the
error, and SHALL add client obligations: show the expression of a repeating item; say that ignoring an
occurrence skips one time only; say that a proposal is approved on the desktop.

#### Scenario: The inbox list marks a proposal with its expression and next times

- **WHEN** an agent proposes a handoff repeating `0 21 * * 3` and a client lists the inbox
- **THEN** the item is marked as a proposal with the expression `0 21 * * 3` and up to three next times, each a Wednesday at 21:00 in the desktop's time zone

#### Scenario: A failed occurrence is still marked as an occurrence

- **WHEN** an occurrence's target folder was removed before its time, its opening failed, and a client lists the inbox
- **THEN** the item is pending, has no scheduled time, and is marked as an occurrence with its expression

#### Scenario: Ignoring an occurrence from a device skips one time

- **WHEN** a client ignores the upcoming occurrence of an approved recurrence
- **THEN** no session is created for that time, and the list carries the recurrence's next occurrence at the following matching time

#### Scenario: Ignoring a proposal from a device declines it

- **WHEN** a client ignores a repeating proposal
- **THEN** it is no longer listed on the client or the desktop, and nothing is scheduled

#### Scenario: The operations and the protocol version are unchanged

- **WHEN** a client authenticates against a desktop with this capability
- **THEN** the protocol version and the list of operations are the same as before it
