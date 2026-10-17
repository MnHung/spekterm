## ADDED Requirements

### Requirement: A device sees and answers an agent's offer to close its own session

When an agent's close of its own session is offered to the user (`agent-session-control`), the session list SHALL
mark that session as offered for closing, and SHALL stop marking it as soon as the offer is withdrawn or the session
stops running. A change of the mark SHALL be sent to connected clients as a new complete list, like any other change
to the list, without waiting for an unrelated change.

A device SHALL be able to answer the offer either way:

- **keeping** the session withdraws the offer, with the effect of choosing to keep it on the desktop: the desktop's
  views stop showing the offer, and the session keeps running. Keeping a session that has no offer SHALL succeed and
  have no effect. Keeping is carried out quietly, as every session change a device requests;
- **closing** is the device's ordinary close of the session, with its rules unchanged: a session that is not idle is
  refused unless the device insists.

Keeping SHALL be refused with a not-found error for a session that does not exist.

The protocol document SHALL name, as a client obligation, that a client showing the session list offers both answers
for a session marked as offered (closing through the close operation, keeping through the keep operation), and that
choosing close there is the user's confirmation for the close.

#### Scenario: An offer appears in the list when it is made

- **WHEN** a client is connected, and the agent in session S closes its own session and its turn ends
- **THEN** the client receives a session list in which S is marked as offered for closing and is running

#### Scenario: An offer made with no other change still reaches the client

- **WHEN** a client has received a session list in which S's turn has ended and S is not marked, and only then S's close of its own session is read and offered
- **THEN** the client receives a session list in which S is marked as offered for closing

#### Scenario: Keeping from a device withdraws the offer on both sides

- **WHEN** S is offered for closing, and a client keeps S
- **THEN** the response succeeds, the client receives a session list in which S is no longer marked, the desktop's views no longer show the offer, and S is still running

#### Scenario: Keeping on the desktop clears the mark for devices

- **WHEN** S is offered for closing, and the user chooses to keep it on the desktop
- **THEN** a connected client receives a session list in which S is no longer marked

#### Scenario: Typing into the session clears the mark for devices

- **WHEN** S is offered for closing, and the user types into S on the desktop
- **THEN** a connected client receives a session list in which S is no longer marked

#### Scenario: Keeping a session with no offer has no effect

- **WHEN** a client keeps a running session that is not offered for closing
- **THEN** the response succeeds, and the session is still running and unmarked

#### Scenario: Closing an offered session from a device closes it

- **WHEN** S is offered for closing and its agent is waiting for input, and a client closes S without insisting
- **THEN** the response succeeds, and S leaves the session list

#### Scenario: A hibernated and woken session carries no old offer

- **WHEN** S is offered for closing, the user hibernates S on the desktop, and later wakes it
- **THEN** no session list a client receives after the hibernation marks S as offered

## MODIFIED Requirements

### Requirement: Operations are an allow-list with named errors

An authenticated connection SHALL be able to invoke only the operations this capability names. Any other
operation SHALL be answered with an error naming it as unknown and SHALL have no effect. Every failure SHALL
be answered with a stable error code and a message. The connection SHALL stay open after an operation
fails.

The operations are:

- listing folders and sessions;
- watching a session's conversation, replying to it (with attachments, see `remote-attachments`), and
  answering its open prompt;
- uploading an attachment (see `remote-attachments`);
- watching a session's terminal output, and sending it input;
- creating a session;
- waking a dormant session;
- renaming a session;
- hibernating a running session;
- closing a session;
- keeping a session whose agent offered to close it (withdrawing the offer);
- listing, accepting and ignoring inbox items;
- reading handoff state and a handoff's brief;
- reading OpenSpec changes, change details and specs;
- watching the attention stream, resuming from the last event received (see `remote-notifications`).

Writing or deleting files, changing settings, reading the Slack configuration, reading any credential, and
changing a terminal's size SHALL NOT be operations. The one exception to "writing files" is an uploaded
attachment. It is written only into the desktop's attachment store, under a name the desktop chooses
(`remote-attachments`). Closing a session removes that session's attachments, as closing it on the desktop
does. No operation SHALL take a path or a directory from the device.

#### Scenario: An unknown operation is refused without effect

- **WHEN** an authenticated client invokes an operation name that is not on the list, such as one that writes a file
- **THEN** the response is an error naming the operation as unknown, and the connection stays open

#### Scenario: A failed operation keeps the connection

- **WHEN** an authenticated client watches a session id that does not exist
- **THEN** the response is an error with a not-found code, and a following valid operation succeeds on the same connection

### Requirement: The session list reflects the desktop's sessions

Listing SHALL return:

- the workspace folders, with id, name, branch, pinned state and whether they have OpenSpec, in rail order;
- every session of the window, with id, folder (or the global item), target (agent or shell), label,
  whether it is running, the agent's wait state for agent sessions, its handoff lifecycle state and
  lineage where it has them, and whether its agent's close of itself is offered to the user.

A change to any of these SHALL be sent to connected clients as a new complete list.

While the application has no window, the session list SHALL be empty and SHALL state that no window exists.

#### Scenario: A session created on the desktop appears in the list

- **WHEN** a client is connected and the user creates a session on the desktop
- **THEN** the client receives a session list that contains the new session with its folder and label

#### Scenario: A finished turn is listed as waiting for input

- **WHEN** an agent session's agent works for several seconds and then finishes its turn
- **THEN** the client first receives a session list in which that session is working, and then one in which it waits for input

### Requirement: With no window, session operations are refused rather than opening one

While the application has no window, creating, waking, renaming, hibernating, closing, keeping and accepting SHALL
be refused with an error stating that no window exists. The application SHALL NOT open a window for them.

This is a deliberate exception to "an action that targets the window while none exists first opens one"
(`workspace-app-shell`). That rule serves an action the user takes at the desktop. Here the user is not at
the desktop, and a window opening there unattended would restore and expose its sessions to whoever is.

When the window closes or its interface reloads, every remote conversation and terminal watch on its
sessions SHALL end with it, because nothing the window held outlives it. The connection itself stays open.

#### Scenario: No window refuses creation

- **WHEN** the application has no window, and a client creates a session
- **THEN** the response is an error stating that no window exists, and no window opens

#### Scenario: No window refuses renaming

- **WHEN** the application has no window, and a client renames a session
- **THEN** the response is an error stating that no window exists, no window opens, and the session's stored name is unchanged

#### Scenario: No window refuses hibernating and closing

- **WHEN** the application has no window, and a client hibernates a session, then closes it
- **THEN** both responses are errors stating that no window exists, no window opens, and the session is still persisted

#### Scenario: No window refuses keeping

- **WHEN** the application has no window, and a client keeps a session
- **THEN** the response is an error stating that no window exists, and no window opens

#### Scenario: Reloading the interface ends remote watches and keeps the connection

- **WHEN** a client watches a session's terminal, and the window's interface reloads
- **THEN** the client is told the watch ended, and its connection is still open

### Requirement: The authentication answer lists the operations the desktop accepts

The answer to a successful authentication, by credential or by pairing, SHALL list the operations this
desktop accepts, other than authentication itself. A client SHALL be able to rely on it to decide which
controls to show. Additions within protocol version 1 SHALL be new fields, operations, events, event values
and error codes, which a client ignores when it does not know them.

#### Scenario: The answer lists the new operations

- **WHEN** a paired device authenticates
- **THEN** the answer lists the operations the server accepts, including renaming, hibernating, closing, keeping, uploading an attachment and answering a prompt, and does not list authentication operations
