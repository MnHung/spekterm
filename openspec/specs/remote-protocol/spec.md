# remote-protocol Specification

## Purpose
Defines what an authenticated remote device can see and do in spekterm. That covers how messages are
framed, which operations exist, and how each one reuses the desktop's own behavior. It also covers how
streams resume after a dropped connection.

## Requirements

### Requirement: Operations are an allow-list with named errors

An authenticated connection SHALL be able to invoke only the operations this capability names. Any other
operation SHALL be answered with an error naming it as unknown and SHALL have no effect. Every failure SHALL
be answered with a stable error code and a message. The connection SHALL stay open after an operation
fails.

The operations are:

- listing folders and sessions;
- watching a session's conversation, and replying to it;
- watching a session's terminal output, and sending it input;
- creating a session;
- waking a dormant session;
- listing, accepting and ignoring inbox items;
- reading handoff state and a handoff's brief;
- reading OpenSpec changes, change details and specs;
- watching the attention stream, resuming from the last event received (see `remote-notifications`).

Writing or deleting files, changing settings, reading the Slack configuration, reading any credential, and
changing a terminal's size SHALL NOT be operations.

#### Scenario: An unknown operation is refused without effect

- **WHEN** an authenticated client invokes an operation name that is not on the list, such as one that writes a file
- **THEN** the response is an error naming the operation as unknown, and the connection stays open

#### Scenario: A failed operation keeps the connection

- **WHEN** an authenticated client watches a session id that does not exist
- **THEN** the response is an error with a not-found code, and a following valid operation succeeds on the same connection

### Requirement: The client and server agree on a protocol version

On connecting, the client SHALL name the protocol versions it supports, and the server SHALL answer with the
one it chose or refuse the connection when it supports none of them. This change defines version 1.

#### Scenario: An unsupported version is refused

- **WHEN** a client offers only a protocol version the server does not support
- **THEN** the server refuses the connection with an error naming the supported versions

### Requirement: The session list reflects the desktop's sessions

Listing SHALL return:

- the workspace folders, with id, name, branch, pinned state and whether they have OpenSpec, in rail order;
- every session of the window, with id, folder (or the global item), target (agent or shell), label,
  whether it is running, the agent's wait state for agent sessions, and its handoff lifecycle state and
  lineage where it has them.

A change to any of these SHALL be sent to connected clients as a new complete list.

While the application has no window, the session list SHALL be empty and SHALL state that no window exists.

#### Scenario: A session created on the desktop appears in the list

- **WHEN** a client is connected and the user creates a session on the desktop
- **THEN** the client receives a session list that contains the new session with its folder and label

#### Scenario: A finished turn is listed as waiting for input

- **WHEN** an agent session's agent works for several seconds and then finishes its turn
- **THEN** the client first receives a session list in which that session is working, and then one in which it waits for input

### Requirement: The conversation a client watches is the same content the desktop's conversation view shows

Watching an agent session's conversation SHALL deliver the same entries, in the same order, with the same
completeness flags as the desktop's conversation view of that session. It SHALL follow the agent when it
moves to another transcript file. A shell session SHALL be answered as having no conversation. A connection
SHALL watch at most one conversation at a time, and watching another SHALL end the previous one.

#### Scenario: The client receives the agent's entries

- **WHEN** a client watches a running agent session and the agent writes a reply to its transcript
- **THEN** the client receives that reply as a conversation entry

#### Scenario: A shell session has no conversation

- **WHEN** a client watches the conversation of a shell session
- **THEN** the response states that the session has no conversation

### Requirement: Replying from a device follows the desktop's sending rules and never submits into a choice

A reply SHALL be accepted only for the conversation that connection is watching, and only while the agent's
wait state permits sending under the same rules as the desktop (`agent-input-bridge`). Otherwise it SHALL be
refused, with the wait state as the reason. Its content SHALL be cleaned of terminal control characters in
the same way.

The submit key SHALL be written separately from the text, after the same delay the prefill path uses, so a
long reply is not taken as a paste whose submit key is lost. Immediately before writing the submit key, the
wait state SHALL be checked again.

- If sending is no longer permitted (the agent began waiting on a choice during the delay), the submit key
  SHALL NOT be written. The reply SHALL be reported as filled in and not submitted, and it SHALL NOT be
  submitted later.
- Replies to one session SHALL be written one at a time, so two replies never interleave.

#### Scenario: A reply reaches the agent

- **WHEN** a client watches an agent session whose agent waits for input, and replies with a long text
- **THEN** the agent receives the text, then the submit key at least 400 milliseconds after the text's last character, and the reply appears in the conversation the client watches

#### Scenario: A reply while the agent waits on a choice is refused

- **WHEN** the watched agent waits on a permission choice, and the client replies with text
- **THEN** the reply is refused with the waiting-on-a-choice reason, and nothing is written to the session

#### Scenario: A choice that appears during the delay keeps the submit key back

- **WHEN** a client replies while the agent is working, and the agent starts waiting on a permission choice before the submit key is due
- **THEN** the submit key is not written, and the reply is reported as filled in and not submitted

#### Scenario: A reply to a conversation the connection is not watching is refused

- **WHEN** a client replies to an agent session other than the one it watches
- **THEN** the reply is refused, and nothing is written to that session

### Requirement: Terminal output is streamed as text with the terminal's size, and input goes to the session as typed

Watching a session's terminal SHALL deliver its recent output as text, followed by new output as it arrives,
with nothing lost or duplicated between the two. A position in the stream SHALL name the session's current
process (it changes when the session is woken or restarted) and a count of UTF-16 code units of that
process's output. A position naming an earlier process is a position the server does not hold. A snapshot
SHALL NOT begin inside a surrogate pair.
Each delivery SHALL carry the terminal's columns and rows, and a size change SHALL be delivered when it
happens.

Terminal input from a client SHALL be written to the session's terminal as it was sent, the same as the
desktop's keyboard. A client SHALL NOT change the terminal's size.

#### Scenario: Output between snapshot and stream is not lost

- **WHEN** a client watches a shell session's terminal while the session prints a numbered sequence of lines continuously
- **THEN** the text the client receives contains every number of the sequence exactly once, in order

#### Scenario: Input from a client reaches the session

- **WHEN** a client sends a shell command followed by a carriage return to a watched shell session
- **THEN** the command runs in that session, and its output reaches the client

#### Scenario: The stream carries the desktop's terminal size

- **WHEN** a client watches a session's terminal, and the desktop then resizes that terminal
- **THEN** the snapshot carries the desktop's columns and rows, and the client receives the new size

### Requirement: Streams resume from the client's last position when the server still holds it

When a client watches a stream again after a dropped connection, it SHALL be able to name the last position
it holds: the identifier of the last conversation entry it received, or the last terminal position.

- A conversation position is the **last** entry carrying that identifier. Several entries can come from one
  transcript record and share its identifier. An empty identifier is a position the server does not hold.
- If the server still holds the position, it SHALL send only what follows it.
- Otherwise it SHALL send a fresh snapshot, marked as replacing what the client has.
- A terminal snapshot that does not reach back to the start of the session's output SHALL be marked
  incomplete.

The server SHALL NOT present a gap as continuous.

#### Scenario: Resuming the conversation sends only new entries

- **WHEN** a client received conversation entries up to entry E, disconnected, the agent wrote two more entries, and the client watches again naming E
- **THEN** the client receives exactly those two entries, not marked as replacing

#### Scenario: A position from before a wake is not continued

- **WHEN** a client watched a session's terminal, the session was hibernated and woken, and the client watches again, naming its old position
- **THEN** the client receives the new process's output, marked as replacing

#### Scenario: Resuming from a position the server no longer holds replaces the content

- **WHEN** a client watches a terminal again, naming a position older than the output the server still holds
- **THEN** the client receives the held output, marked as replacing and incomplete

### Requirement: Session changes requested by a device are carried out by the desktop's interface without taking the desktop away from the user

Creating a session (an agent or a shell, in a folder or in the global item) and waking a dormant session
SHALL be carried out by the window's interface, through the same paths the desktop's own controls use. The
result is then the same as if the user had done it there, including persistence, restore, launch arguments
and handoff injection.

A session created or woken at a device's request SHALL NOT move the rail selection and SHALL NOT change any
item's focused session. So it never replaces the session the desktop displays. The one exception is an item
that had no session at all: there it becomes the item's only session and is therefore displayed.

Whether or not it ends up displayed, its arrival SHALL NOT take keyboard focus. Only the activation that
happens with no user action is held back, and the terminal is still sized to its view. When the user later
turns to the session (selecting it, or switching to its item), it SHALL take focus as any session does.

When the interface does not answer within fifteen seconds, the operation SHALL be refused with a timeout
error.

#### Scenario: A session created from a device is a desktop session

- **WHEN** a client creates an agent session in a folder
- **THEN** the session appears in the desktop's rail under that folder, it is listed in the session list the client receives, and it is restored after an application restart

#### Scenario: Creating in the displayed folder leaves the user where they are

- **WHEN** the desktop displays a session of a folder with keyboard focus in its terminal, and a client creates a session in that folder
- **THEN** the desktop still displays the same session, and keyboard focus is still in its terminal

#### Scenario: Creating in an empty displayed folder does not take focus

- **WHEN** the desktop displays a folder that has no session, keyboard focus is in the side panel's editor, and a client creates a session in that folder
- **THEN** keyboard focus is still in the editor, and the new session's terminal is not 80 columns wide

#### Scenario: A quietly created session takes focus once the user turns to it

- **WHEN** a client created a session in a folder the desktop does not display, and the user then selects that folder and the new session's tab
- **THEN** keyboard focus is in the new session's terminal, and its terminal is not 80 columns wide

#### Scenario: Waking the displayed dormant session from a device does not take focus

- **WHEN** the desktop displays a dormant session, keyboard focus is in the side panel's editor, and a client wakes that session
- **THEN** the session runs, and keyboard focus is still in the editor

#### Scenario: Creating does not move the desktop's selection

- **WHEN** the desktop's rail has another item selected, and a client creates a session in a folder
- **THEN** the rail selection is unchanged

#### Scenario: Waking a dormant session from a device

- **WHEN** a client wakes a dormant session
- **THEN** the session's process starts, and the session list shows it running

### Requirement: With no window, session operations are refused rather than opening one

While the application has no window, creating, waking and accepting SHALL be refused with an error stating
that no window exists. The application SHALL NOT open a window for them.

This is a deliberate exception to "an action that targets the window while none exists first opens one"
(`workspace-app-shell`). That rule serves an action the user takes at the desktop. Here the user is not at
the desktop, and a window opening there unattended would restore and expose its sessions to whoever is.

When the window closes or its interface reloads, every remote conversation and terminal watch on its
sessions SHALL end with it, because nothing the window held outlives it. The connection itself stays open.

#### Scenario: No window refuses creation

- **WHEN** the application has no window, and a client creates a session
- **THEN** the response is an error stating that no window exists, and no window opens

#### Scenario: Reloading the interface ends remote watches and keeps the connection

- **WHEN** a client watches a session's terminal, and the window's interface reloads
- **THEN** the client is told the watch ended, and its connection is still open

### Requirement: Inbox accept from a device follows the desktop's accept

Listing the inbox SHALL return the same items and fields the desktop's inbox shows, including each item's
full body as plain text. Accepting SHALL require a folder chosen by the device user and SHALL be refused
without one.

Accepting SHALL be carried out by the window's interface along the same path as the desktop's accept:

- it reuses the session an earlier accept of the same item left in that folder;
- otherwise it creates a session there, under the rules for device-requested creation above;
- the item's first prompt is then filled in and submitted or left unsent, by the same rule as on the
  desktop (`agent-intake`).

If the session cannot be created, the accept SHALL be refused, and the item SHALL stay pending.

Ignoring SHALL have the same effect as the desktop's ignore. Any change to the inbox, made on the desktop or
from a device, SHALL be sent to connected clients as a new complete list and SHALL be reflected in the
desktop's inbox.

The protocol document SHALL require a client to show an item's full body as plain text before it offers to
accept that item, which is the human check `agent-intake` places before acceptance. This repository has no
carrier for that obligation. It falls to the client.

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

### Requirement: Handoff state and briefs are readable

A client SHALL be able to read each handoff-created session's lifecycle state (working, waiting, done, idle),
its lineage, and its brief (the handoff body and, once reported, the report). A lifecycle change SHALL be
sent to connected clients.

#### Scenario: A reported handoff is read as done with its report

- **WHEN** a handoff-created session's agent reports completion
- **THEN** the client receives that session's lifecycle as done, and reading its brief returns the report summary

### Requirement: OpenSpec content is readable and only readable

A client SHALL be able to list a folder's OpenSpec changes and specs, and read a change's artifacts and a
spec's content. The identifiers, lookup rules and errors SHALL be the same ones the side panel uses. An
identifier that is not in the folder's scanned results SHALL be answered as not found without touching the
file system. No operation SHALL change OpenSpec content.

#### Scenario: Reading a change's artifacts

- **WHEN** a client reads an active change of a folder that has OpenSpec
- **THEN** the response contains that change's artifacts with their content

#### Scenario: A path-shaped identifier is not found

- **WHEN** a client reads a change whose identifier is a relative path that leaves the folder
- **THEN** the response is a not-found error

### Requirement: The protocol is documented, and the document matches the server

The repository SHALL contain a protocol document. It SHALL state:

- the pairing link format, and the certificate pinning rule;
- the framing and the version negotiation;
- every operation and event, with its parameters, results and error codes;
- the resume rules;
- the attention event format, and that a client is told of events only while connected;
- the liveness rule;
- the client obligations this capability names.

A unit test SHALL fail when an operation the server accepts is missing from the document, or when the
document names an operation the server does not accept.

#### Scenario: An undocumented operation fails the test

- **WHEN** an operation is added to the server's allow-list and not to the document
- **THEN** the documentation test fails and names the operation

### Requirement: Dead connections are detected and closed

The server SHALL check each connection's liveness at an interval of at most twenty seconds. It SHALL close a
connection that has not answered two consecutive checks. Closing a connection SHALL end its conversation and
terminal watches.

Until a dead connection is closed, the server treats its device as connected, and events sent in that
window never reach the device. The window is at most sixty seconds. The device recovers those attention
events by resuming the attention stream from the last event it received (see `remote-notifications`).

#### Scenario: An unresponsive client is closed

- **WHEN** a connected client stops answering liveness checks
- **THEN** the server closes its connection within sixty seconds, and the desktop's connection indicator reflects it
