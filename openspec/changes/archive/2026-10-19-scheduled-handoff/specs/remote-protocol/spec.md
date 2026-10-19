## ADDED Requirements

### Requirement: A device sees scheduled handoffs, and runs or cancels them

The inbox list SHALL carry, for a scheduled handoff that has not been opened yet, the time it is scheduled for
(`scheduledAt`, in the list's time unit). An item without that field is not scheduled. The time can be in the
past: the handoff is due and opens as soon as a window on the desktop can receive it. A client SHALL be able
to tell scheduled handoffs from items waiting for the user from the list alone.

Accepting a scheduled handoff from a device SHALL open it at once: it follows the desktop's accept ("Inbox
accept from a device follows the desktop's accept"), so its session opens in the folder the device names and
its first prompt is submitted. Ignoring it SHALL cancel it, with the desktop's Cancel's effect. A change of a
scheduled handoff — scheduled, opened, cancelled — SHALL be sent to connected clients as a new complete inbox
list.

The protocol version SHALL stay 1: the change is a new field. The protocol document SHALL describe the field,
SHALL state that an `intake` attention event for a scheduled handoff comes when it opens, and SHALL add a
client obligation to show a scheduled item with its time and apart from the items waiting for the user, and
not to raise a notification for it while it waits. A client that does not know the field shows the item as a
pending one, and accepting it runs it now; that is the documented degradation.

#### Scenario: The inbox list carries the scheduled time

- **WHEN** a handoff scheduled for tomorrow is in the inbox and a client lists the inbox
- **THEN** that item carries `scheduledAt` equal to its scheduled time, and the other items do not carry it

#### Scenario: Accepting a scheduled handoff from a device opens it now

- **WHEN** a client accepts a handoff scheduled for tomorrow into folder B
- **THEN** folder B has a new agent session for it with its first prompt submitted, and the next inbox list no longer carries it as scheduled

#### Scenario: Ignoring a scheduled handoff from a device cancels it

- **WHEN** a client ignores a handoff scheduled for two minutes from now, and the time passes
- **THEN** no session is created for it, and the inbox list on the client and on the desktop no longer has it

#### Scenario: Opening at its time updates connected clients

- **WHEN** a scheduled handoff opens at its time while a client is connected
- **THEN** the client receives an inbox list in which that item no longer carries `scheduledAt`
