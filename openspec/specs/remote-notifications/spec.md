# remote-notifications Specification

## Purpose
Tells a paired device the moments that need the user. That means an agent waiting for them or waiting on
a choice, a finished handoff, and a new inbox item. A device learns them only over its own connection to
spekterm. No push service, relay or other third party carries them. A device that was not connected
when an event occurred receives it when it reconnects, if spekterm still holds it.

## Requirements

### Requirement: Four moments raise attention events

The application SHALL raise an attention event when:

- an agent session's agent reports that it finished its turn and waits for input. This is decided from the
  agent's turn-completion report, not from observing a change from working to waiting: a short turn can
  begin and end between two observations;
- an agent session's agent asks for a choice, such as a permission prompt, naming the tool it waits on. Each
  request raises its own event, decided from the agent's request, not from observing a change into waiting
  on a choice: a second prompt can follow an answered one within one observation, and the state then never
  leaves waiting on a choice;
- a handoff-created session's report is adopted, at the same moment the desktop's completion notification is raised;
- a new item arrives in the inbox, a handoff's arrival included, as on the desktop.

Each event SHALL carry its position in the attention stream, its kind, its time, the session or inbox item
it concerns, the folder's name when there is one (an inbox item may have no resolved folder), a title and,
for a finished handoff, the report summary. Every client watching the attention stream SHALL receive each
event as it occurs. Watching again on the same connection SHALL replace that connection's earlier watch, so
it never receives an event twice.

#### Scenario: A finished turn raises a waiting event

- **WHEN** a client watches the attention stream, and an agent session's agent works for several seconds and then finishes its turn
- **THEN** the client receives an attention event of the waiting kind for that session

#### Scenario: A turn shorter than one observation still raises a waiting event

- **WHEN** an agent's turn starts and finishes within the same observation of its events
- **THEN** watching clients receive an attention event of the waiting kind for that session

#### Scenario: A permission prompt raises a choice event

- **WHEN** an agent session's agent starts waiting on a permission choice
- **THEN** watching clients receive an attention event of the choice kind naming the tool

#### Scenario: A second prompt right after an answered one raises its own event

- **WHEN** an agent's permission prompt is answered, and within the same observation of its events the agent asks for another permission choice
- **THEN** watching clients receive a choice event for the second prompt

#### Scenario: An adopted report raises a handoff event

- **WHEN** a handoff-created session reports completion and the report is adopted
- **THEN** watching clients receive an attention event of the handoff-done kind with the report summary

#### Scenario: An inbox arrival raises an intake event

- **WHEN** a new item arrives in the inbox
- **THEN** watching clients receive an attention event of the intake kind for that item

### Requirement: An event about the session the user is looking at is marked suppressed

A waiting or choice event about a session that is displayed in the desktop's window while that window has
focus SHALL be marked suppressed. A suppressed event SHALL still reach watching clients and be held for
resuming, so their state can update. The protocol document SHALL tell clients not to notify the user of a
suppressed event.

#### Scenario: The displayed session in a focused window raises a suppressed event

- **WHEN** the desktop's window has focus and displays an agent session, and that agent finishes its turn
- **THEN** watching clients receive the waiting event marked suppressed

### Requirement: Attention events travel only over a device's own connection

The application SHALL deliver attention events only to clients connected to it. It SHALL NOT send them, or
anything derived from them, through a push service, a relay, or any other outbound connection. A device
that should notify its user while in the background has to keep its connection open; that is the client's
concern, and the protocol document says so.

#### Scenario: An event with no device connected opens no connection

- **WHEN** a device is paired but not connected, and an agent waits on a choice
- **THEN** the application opens no outbound connection for the event, and the event is held for that device's next connection

### Requirement: A reconnecting client receives the events it missed, or is told it may have missed some

While remote access is on, the application SHALL hold every attention event of the last 24 hours, up to the
200 most recent, and none older. A position in the attention stream SHALL identify both the event and the span
of time the application has held events without interruption. That span follows the user's remote access
setting, not the listener: it ends when remote access is turned off, when it is reset, or when the
application quits, and it does not end when the port changes or the listener fails to listen. Nothing is held
while remote access is off. A reset ends it so that a device paired afterwards is not shown titles from
before the reset.

When a client starts watching the attention stream it SHALL be able to name the position of the last event
it received:

- If the position is from the current span and no event after it has been dropped, it SHALL send every held
  event after it, in order, marked complete. The event at the position itself may have been dropped.
- Otherwise, including a position from an earlier span or one older than what is held, it SHALL send every
  event it holds, marked incomplete.
- With no position named, it SHALL send every event it holds, marked incomplete.

It SHALL then send new events as they occur, with none lost or repeated between the held events and the
live ones.

#### Scenario: Events that occurred while disconnected arrive on reconnect

- **WHEN** a client watching the attention stream disconnects, two attention events occur, and the client reconnects and watches from the position of the last event it received
- **THEN** it receives exactly those two events, in order, marked complete

#### Scenario: A position from before remote access was turned off is not continued

- **WHEN** a client holds a position, remote access is turned off, an agent waits on a choice, remote access is turned on, another agent waits on a choice, and the client watches from that position
- **THEN** it receives only the second event, marked incomplete

#### Scenario: Changing the port does not end the span

- **WHEN** a client holds a position, the user changes the port, an event occurs, and the client reconnects on the new port and watches from that position
- **THEN** it receives that event, marked complete

#### Scenario: A position older than the held events is not continued

- **WHEN** more events than the application holds have occurred since the client's position, and the client watches from it
- **THEN** it receives the held events marked incomplete

#### Scenario: An event during watching is neither lost nor repeated

- **WHEN** an attention event occurs while a client starts watching the attention stream
- **THEN** the client receives that event exactly once

### Requirement: Agent-controlled and third-party text is reduced before it leaves

Every title and summary in an attention event SHALL be reduced by the same rule the desktop applies to text
entering an operating-system notification (`agent-intake`): URL-shaped text replaced, markup characters
removed, and the length clipped. A phone's notification shade parses that text the same way a desktop's
does. Folder names are the user's own and SHALL NOT be reduced, but SHALL be clipped to the same length. The
replacement for a URL is in the desktop's interface language.

#### Scenario: A link in a report summary does not reach the device

- **WHEN** a handoff report's summary contains an `https:` URL and the report is adopted
- **THEN** the attention event's summary does not contain that URL

### Requirement: An agent's offer to close its own session raises no attention event of its own

An agent's close of its own session being offered to the user (`agent-session-control`) SHALL NOT raise an attention
event of its own. The offer normally follows the agent's turn completion, which already raises a waiting event,
marked suppressed under the same rule. A second event would notify twice for one moment, and the offer is decided
after the turn completion, so the waiting event cannot be held back for it. A device opened by the waiting event
reads the offer from the session list (`remote-protocol`).

This leaves a known gap: a turn that ends in a failure the agent reports (an API error) rather than a turn
completion raises no waiting event, so an offer that follows it raises none either, and a device learns of it only
from the session list.

#### Scenario: An offered close notifies once

- **WHEN** a client watches the attention stream, and the agent in session S closes its own session and its turn ends
- **THEN** the client receives one waiting event for S for that turn end, and no other attention event for S
- **AND** the session list it receives marks S as offered for closing
