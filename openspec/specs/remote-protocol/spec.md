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
- reading OpenSpec changes, change details and specs, and watching one folder's OpenSpec for changes;
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
  whether it is running, the agent's wait state for agent sessions, its handoff lifecycle state and
  lineage where it has them, whether its agent's close of itself is offered to the user, and, for a running agent
  session, the background tasks its agent runs (`agent-event-bridge`).

For an agent session whose wait state is "waits for input", the list SHALL also carry whether that state has been
seen (`session-wait-indicator`): seen when someone looked at the session since its last turn ended (the desktop's
focused window displays it, or a device watches its conversation — watching its terminal output does not count), or
when no turn has ended since its agent started. The field SHALL be present, true or false, whenever the wait state is
"waits for input", and absent otherwise, so that a client can tell this desktop from one that predates the field. It
SHALL become false at every turn end that no one is looking at. The handoff lifecycle state follows the same mark
(`handoff-completion`).

A change to any of these SHALL be sent to connected clients as a new complete list.

While the application has no window, the session list SHALL be empty and SHALL state that no window exists.

#### Scenario: A session created on the desktop appears in the list

- **WHEN** a client is connected and the user creates a session on the desktop
- **THEN** the client receives a session list that contains the new session with its folder and label

#### Scenario: A finished turn is listed as waiting for input

- **WHEN** an agent session's agent works for several seconds and then finishes its turn
- **THEN** the client first receives a session list in which that session is working, and then one in which it waits for input

#### Scenario: A turn that ends unseen is listed as not seen

- **WHEN** a client is connected, does not watch agent session S, S is not displayed in a focused window, and S's
  agent finishes a turn
- **THEN** the client receives a session list in which S waits for input and is not seen

#### Scenario: Watching a session marks it seen

- **WHEN** S is listed as waiting for input and not seen, and the client starts watching S's conversation
- **THEN** the client receives a session list in which S waits for input and is seen

#### Scenario: A terminal watch does not mark a session seen

- **WHEN** S is listed as waiting for input and not seen, and the client starts watching S's terminal output
- **THEN** S is still listed as not seen

#### Scenario: A turn that ends during a watch is seen at once

- **WHEN** the client watches S's conversation and S's agent finishes a turn
- **THEN** the first session list in which S waits for input lists it as seen

#### Scenario: The seen field is absent unless the session waits for input

- **WHEN** the client receives a session list in which an agent session is working, and one with a shell session
- **THEN** neither of those sessions carries the seen field

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

A client SHALL be able to list a folder's OpenSpec changes, active and archived, and its specs, and read a
change's artifacts and a spec's content. The identifiers, lookup rules and errors SHALL be the same ones the side
panel uses, except for the error an answer over the frame cap produces. An identifier that is not in the folder's
scanned results SHALL be answered as not found without touching the file system. No operation SHALL change
OpenSpec content.

The four results SHALL contain exactly the fields the protocol document names for them, and no other: a field the
desktop's OpenSpec views or `@spekjs/core` gain later SHALL NOT reach a device until the protocol document names
it. No field the desktop derives SHALL carry a file system path, neither absolute nor relative to the folder, and no
result SHALL carry the desktop's internal identifier of a working tree. Text the repository's authors wrote
(artifact, spec and delta content, task text, section titles) and names taken from the repository (slugs, spec
topics, a data artifact's file name) are not derived and are sent as they are. No error answer to an OpenSpec
operation SHALL carry a path of the desktop's file system.

The results SHALL describe what the side panel shows:

- the changes the side panel lists, including those that live in other working trees of the folder's repository,
  each slug once and in the side panel's order;
- a change's artifacts in the order the side panel shows them, with a tasks artifact given as its parsed task
  list (sections, each task's text and whether it is completed) rather than its raw text;
- a spec's content as the side panel shows it, and the changes in its history, each of which can be read as a
  change.

A change SHALL be addressed by its folder and slug alone, wherever it lives. When the folder's repository has more
than one working tree, each change and each spec SHALL state the working tree it is read from by its branch and
whether it is the main working tree; with one working tree, they SHALL NOT state it.

The protocol document SHALL state when a change's timestamp is absent and that it does not change while the desktop
runs, and the order the change lists follow.

The protocol document SHALL require a client to treat artifact, spec, task and section text as untrusted: to render
markdown with raw HTML shown as text, never interpreted; to treat a relative link or image reference as resolving to
nothing; to open a web link only when the user taps it, outside the client; not to load a remote image
automatically; and to show a data artifact (YAML or JSON) as plain text. This repository has no carrier for that
obligation. It falls to the client.

#### Scenario: Reading a change's artifacts

- **WHEN** a client reads an active change of a folder that has OpenSpec
- **THEN** the response contains that change's artifacts with their content, in the order the side panel shows them

#### Scenario: A path-shaped identifier is not found

- **WHEN** a client reads a change whose identifier is a relative path that leaves the folder
- **THEN** the response is a not-found error

#### Scenario: A field the desktop adds does not reach a device

- **WHEN** the desktop's view of a change carries a field the protocol document does not name for that result
- **THEN** the result a client receives does not contain that field

#### Scenario: No path reaches a device from a repository with a worktree outside the folder

- **WHEN** a client lists and reads the changes and specs of a folder whose repository has a linked working tree
  outside the folder, holding an active change
- **THEN** no string in the results, other than text the repository's authors wrote, contains the folder's path, the
  working tree's path or the user's home directory

#### Scenario: A read failure does not reveal a path

- **WHEN** reading a change fails because one of its files cannot be read
- **THEN** the client receives an internal error whose message contains no path of the desktop's file system

#### Scenario: A change in another working tree is read by its slug and labeled with its branch

- **WHEN** a folder's repository has a linked working tree holding an active change, and a client lists the
  folder's changes and reads that change by its slug
- **THEN** the change is listed once, labeled with the working tree's branch as not the main working tree, and
  reading it returns the working tree's content

#### Scenario: A repository with one working tree labels nothing

- **WHEN** a client lists the changes of a folder whose repository has a single working tree
- **THEN** no change in the result states a working tree

#### Scenario: A tasks artifact arrives as its parsed task list

- **WHEN** a client reads a change that has a tasks artifact with completed and open tasks
- **THEN** that artifact gives each task's text and completion, grouped in its sections, and not the file's raw text

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

### Requirement: An authenticated connection learns the desktop's current addresses

When a connection authenticates, by either presenting a device credential or pairing, the answer SHALL carry
the addresses at which the desktop may currently be reached. The list SHALL be built the same way as the
pairing link's: non-loopback interface addresses, IPv4 first, then IPv6 other than link-local, then the user's additional
address if one is set.

While devices are connected, the server SHALL notice when that list changes and send the complete new list to
every authenticated connection as an event. A connection that has not authenticated SHALL receive no
addresses.

This is an addition to protocol version 1. A client that ignores the field and the event SHALL keep working as
before. The protocol document SHALL state the field, the event, and what a client does with them.

**Reason**: a phone knew the desktop's addresses only from the pairing link. When the desktop's address
changed under an existing pairing, the phone could not reach it on that network until the user paired again,
even though the phone connected over another path in the meantime. The certificate pin, not the address,
decides which desktop the phone trusts, so a new address cannot make it trust another machine.

#### Scenario: The answer to an authenticated connection carries the addresses

- **WHEN** a paired device authenticates
- **THEN** the answer carries the desktop's current address list, including the additional address the user set

#### Scenario: A pairing connection receives the addresses too

- **WHEN** a device pairs
- **THEN** the answer carries the desktop's current address list

#### Scenario: A change while connected is announced

- **WHEN** a device is connected and the desktop's address list changes
- **THEN** the device receives an event carrying the complete new list

#### Scenario: An unchanged list is not announced

- **WHEN** a device stays connected and the address list does not change
- **THEN** the device receives no address event

#### Scenario: A refused connection learns no addresses

- **WHEN** a connection fails to authenticate
- **THEN** nothing it receives carries the address list

#### Scenario: A connection that has not yet authenticated receives no address event

- **WHEN** one connection is open but has not yet authenticated, another is authenticated, and the address list changes
- **THEN** the authenticated connection receives the address event
- **AND** the unauthenticated connection receives nothing

### Requirement: The watched conversation states the open prompt and whether a device may answer it

While a watched agent waits on a choice and a permission request is open (`agent-event-bridge`), the wait
updates sent to the client SHALL carry the first open request with its identity and the number of open
requests. The request is one of:

- **a permission prompt**: the tool and its identifying argument, and whether a device may allow it once.
  Allowing once SHALL be offered only for tools whose prompt was measured to put a one-time approval first
  (the command, file edit, file write, file read and web fetch tools). It SHALL NOT be offered for any other
  tool.
- **a plan approval**: the plan's text when the agent wrote one, and the approvals a device may choose.
  With a plan, they are "approve, asking before each edit" and "approve and switch to auto mode". Without
  one, the only approval is "leave plan mode, asking before each edit". Allowing once SHALL NOT be offered
  for it, because its first option starts a mode that approves later actions.
- **a question**: its questions, each with its header, its options (label and description) and whether
  several may be chosen.

The update SHALL also say whether a device may answer. It may only when:

- exactly one request is open;
- no keystroke was written to the session since the request's tool call started;
- the request's agent reported no other tool start or finish since then;
- no device answer was written to it yet;
- for a question, there are one to four questions, each with one to eight options.

A keystroke is any write to the session except a device answer's own keys and the terminal's focus and mouse
reports: the keyboard, a client's terminal input, a reply, and the desktop's own prefills.

The update SHALL be sent whenever the prompt, the number of open requests or whether a device may answer
changes, also when no agent event caused the change.

When no request is open, the update SHALL carry no prompt. The existing pending request (tool and argument)
SHALL be sent as before.

**Reason**: the terminal's options for a permission prompt are not in the agent's request, and their number
and meaning differ by tool and by the user's settings (measured, CLI 2.1.300). A question's options are in the
request. Several prompts can be open at once, and only the first is on screen.

The desktop's conversation view still offers no answering (`agent-input-bridge`), because it would depend on
the terminal's numbering. A device's answer depends on it too, but only within what was measured:

- the first option of the listed tools is a one-time approval;
- dismissing a prompt;
- the question tool's option numbering.

The answer is also checked against the agent's record where one exists.

#### Scenario: A permission prompt is stated with its answers

- **WHEN** a client watches an agent that asks permission to run a command
- **THEN** the client receives a wait update whose prompt names the command tool and its argument, carries an identity, offers allowing once, and is answerable

#### Scenario: A plan approval is stated with the plan and its approvals

- **WHEN** a client watches an agent that asks for approval of a plan it wrote
- **THEN** the prompt the client receives carries the plan's text, offers both approvals and denying, and does not offer allowing once

#### Scenario: A question is stated with its options

- **WHEN** a client watches an agent that asks two questions, the second allowing several choices
- **THEN** the prompt the client receives carries both questions with their options in order, marks the second as allowing several choices, and is answerable

#### Scenario: Two open requests are not answerable

- **WHEN** a client watches an agent with two open permission requests
- **THEN** the prompt the client receives names the first, says two are open, and is not answerable

#### Scenario: A prompt the desktop typed into is not answerable

- **WHEN** a permission request is open, the agent reports nothing more, and a key is typed into the session on the desktop
- **THEN** the client receives a wait update that says the prompt is not answerable

### Requirement: A device's answer reaches only the prompt it was given and never submits text

Answering SHALL be accepted only for the conversation the connection watches, and only with the identity of
the open request. The answer SHALL be one of:

- allow once, where offered;
- for a plan approval, one of the approvals it offers;
- deny (for a question, decline; for a plan approval, keep planning);
- for an answerable question, one choice per single-choice question and one or more distinct choices per
  several-choice question.

Anything else SHALL be refused, and nothing SHALL be written.

The desktop SHALL write the answer to the session as the keys a user would press, one key at a time, with a
pause between keys. Immediately before each key, it SHALL read the agent's events again. It SHALL write the
key only while:

- exactly one request is open;
- it has the answer's identity;
- no keystroke was written to the session since that request's tool call started;
- the request's agent reported no other tool start or finish since then;
- no other answer was written to it.

Then:

- When the first key is withheld, the answer SHALL be refused with an error stating the prompt is gone.
- When a later key is withheld, the remaining keys SHALL NOT be written, and the answer SHALL be reported as
  partial.
- For a question, the desktop SHALL compare the answers the agent records with the choices sent. For a plan
  approval, it SHALL compare the permission mode the agent reports next with the one chosen. It SHALL report
  either as confirmed or as differing. With no record within three seconds, it SHALL report the keys as sent.
- After a denial the desktop writes, the request SHALL no longer be open (`agent-event-bridge`).

No answer SHALL include the submit key. Answers and replies to one session SHALL be written one at a time.

**Reason**: text and the submit key typed into an open prompt approve it (`companion-test-fixes`), so an
answer must not be text.

- The agent waits for its tool-start event before showing any prompt. It reports each queued request before
  that request's own prompt is shown, and shows queued prompts in the order reported (measured, CLI 2.1.300).
  A prompt that replaced the one being answered, or one queued behind it, is therefore known before the next
  key.
- A prompt answered or dismissed on the desktop reports nothing until its tool ends, or nothing at all. The
  key the user pressed is what tells it.
- A request dismissed in some other way can still be answered. The keys then reach the agent's input box,
  where none of them submits anything, or interrupt a working agent (Esc). The protocol document SHALL state
  this.

#### Scenario: Allowing a command from a device

- **WHEN** a client answers the open command prompt of its watched agent with allow once
- **THEN** the session receives that prompt's first-option key and no submit key, and the answer is reported as sent

#### Scenario: An answer to a prompt that was replaced is refused

- **WHEN** the agent's prompt is answered on the desktop, the agent then asks permission for another tool, and a client answers the first prompt's identity
- **THEN** the answer is refused as gone, and nothing is written to the session

#### Scenario: An answer after the desktop typed is refused

- **WHEN** a permission request is open, a key is typed into the session on the desktop, and a client answers that request
- **THEN** the answer is refused as gone, and nothing is written to the session

#### Scenario: A second answer to the same prompt is refused

- **WHEN** a client allowed a command whose tool is still running, and an answer to the same prompt arrives
- **THEN** it is refused as gone, and nothing is written to the session

#### Scenario: An answer while two requests are open is refused

- **WHEN** two permission requests are open and a client answers the first one's identity
- **THEN** the answer is refused as gone, and nothing is written to the session

#### Scenario: A question is answered with the option keys

- **WHEN** a client answers a two-question prompt, choosing the second option of a single-choice question and the first and third of a several-choice question
- **THEN** the session receives, one key at a time, the second option's key, the first and third options' keys, the key that moves past the question, and the confirmation key, and no submit key

#### Scenario: A question's answer is confirmed against the agent's record

- **WHEN** a client answers a question and the agent records the chosen labels as the answer
- **THEN** the answer is reported as confirmed

#### Scenario: An answer interrupted by the prompt ending is partial

- **WHEN** a client's multi-key answer is being written and, before the last key, the agent reports another permission request
- **THEN** the remaining keys are not written, and the answer is reported as partial

#### Scenario: Allowing where it is not offered is refused

- **WHEN** a client answers the plan approval with allow once
- **THEN** the answer is refused as not answerable from a device, and nothing is written

#### Scenario: Approving a plan from a device asks before each edit

- **WHEN** a client approves its watched agent's plan with the approval that asks before each edit
- **THEN** the session receives that option's key and no submit key, and when the agent next reports the default permission mode the answer is reported as confirmed

#### Scenario: A plan approval that lands in another mode is reported

- **WHEN** a client approves a plan with auto mode, and the agent next reports a mode other than auto
- **THEN** the answer is reported as differing

#### Scenario: After a device's denial the agent takes a reply

- **WHEN** a client denies the agent's only open prompt
- **THEN** the session receives the dismiss key, the wait state becomes ready, and a reply from the client is accepted

### Requirement: A device renames a session with the desktop's naming rule

Renaming SHALL be carried out by the window's interface through the desktop's own rename, under the naming
order of `terminal-sessions`. A non-empty name SHALL become the session's name. An empty name, or one that
is empty once trimmed, SHALL clear the session's name, so the label follows that order again. Control
characters SHALL be removed and the name SHALL be clipped to 200 characters before it is applied. A dormant
session SHALL be renameable.

Renaming SHALL NOT move the rail selection, change any item's focused session or take keyboard focus. The new
label SHALL reach clients through the session list. An unknown session SHALL be refused as not found, and an
interface that does not answer within fifteen seconds SHALL time out.

#### Scenario: Renaming from a device changes the label everywhere

- **WHEN** a client renames an agent session
- **THEN** the desktop's tab and rail show the new name, the session list the client receives carries it, the rail selection and keyboard focus are unchanged, and the name is restored after an application restart

#### Scenario: An empty name hands naming back

- **WHEN** a client renames an agent session that was not created by a handoff and has a name, to an empty name
- **THEN** the session's label is the agent's latest title again

### Requirement: The authentication answer lists the operations the desktop accepts

The answer to a successful authentication, by credential or by pairing, SHALL list the operations this
desktop accepts, other than authentication itself. A client SHALL be able to rely on it to decide which
controls to show. Additions within protocol version 1 SHALL be new fields, operations, events, event values
and error codes, which a client ignores when it does not know them.

#### Scenario: The answer lists the new operations

- **WHEN** a paired device authenticates
- **THEN** the answer lists the operations the server accepts, including renaming, hibernating, closing, keeping, uploading an attachment and answering a prompt, and does not list authentication operations

### Requirement: A device hibernates or closes a session through the desktop's own action, without taking the desktop away from the user

Hibernating and closing SHALL be carried out by the window's interface through the paths the desktop's own
controls use. The result SHALL be the same as if the user had done it there:

- **Hibernating** ends the session's process and leaves it dormant, persisted and wakeable, with a shell's
  screen kept (`session-hibernation`). Its attachments are kept.
- **Closing** removes the session from the workspace and from persistence, removes its attachments
  (`remote-attachments`), and ends a handoff-created session as closing it on the desktop does
  (`handoff-completion`, `session-lineage`).

Hibernating a dormant session SHALL succeed with no effect. Closing a dormant session SHALL close it. An
unknown session SHALL be refused as not found. An interface that does not answer within fifteen seconds SHALL
time out. The new state SHALL reach clients through the session list.

Neither action SHALL move the rail selection or take keyboard focus, in either of the session's view modes.
In particular:

- a hibernated session that the desktop displays SHALL NOT focus its Wake button;
- when the closed session is the one the desktop displays, the session displayed in its place SHALL NOT take
  focus on that activation;
- holding focus back SHALL apply only to the transition the device caused. Any later activation, including the
  user selecting the rail item again, SHALL take focus as it does for any session.

Closing the displayed session changes what the desktop displays, because the closed session can no longer be
shown.

#### Scenario: Hibernating from a device leaves a wakeable dormant session

- **WHEN** a client hibernates an idle running shell session, and later wakes it
- **THEN** after the hibernation the session list shows it not running, the desktop shows it dormant in the same tab position, and it is still persisted; after the wake it runs again

#### Scenario: Hibernating a dormant session changes nothing

- **WHEN** a client hibernates a session that is already dormant
- **THEN** the response succeeds, and the session is still dormant and persisted

#### Scenario: Closing from a device removes the session

- **WHEN** a client closes an agent session that has a sent attachment
- **THEN** the session is absent from the session list the client receives, from the desktop's rail and from persistence, and its attachments are removed

#### Scenario: Closing a dormant session from a device

- **WHEN** a client closes a dormant session
- **THEN** the session is absent from the session list and from persistence

#### Scenario: Hibernating the displayed session does not take focus

- **WHEN** the desktop displays a running session with keyboard focus in the side panel's editor, and a client hibernates that session
- **THEN** the desktop shows the session dormant, keyboard focus is still in the editor, and the rail selection is unchanged

#### Scenario: Closing the displayed session does not take focus

- **WHEN** the desktop displays one of two sessions of a folder with keyboard focus in the side panel's editor, and a client closes the displayed one
- **THEN** the desktop displays the other session, keyboard focus is still in the editor, and the rail selection is unchanged

#### Scenario: Hibernating the displayed session in the conversation view does not take focus

- **WHEN** the desktop displays a running agent session in its conversation view with keyboard focus in the side panel's editor, and a client hibernates that session
- **THEN** the conversation view shows the session dormant, and keyboard focus is still in the editor

#### Scenario: The session shown in place of a closed one takes focus once the user turns to it

- **WHEN** a client closed the displayed session, and the user then selects another rail item and selects this one again
- **THEN** keyboard focus is in the terminal of the session displayed in place of the closed one

#### Scenario: An unknown session is not found

- **WHEN** a client hibernates or closes a session id that does not exist
- **THEN** the response is a not-found error

### Requirement: A session that is not idle is hibernated or closed from a device only when the device insists

Before hibernating or closing a session that has a process, the application SHALL check whether the session
is idle, by the same conditions automatic hibernation uses to keep a session running (`session-hibernation`,
"idle"), without its displayed and idle-time conditions. If the session is not idle, the operation SHALL be
refused with an error stating that the session is busy and why, and SHALL have no effect. The reasons are:

- the agent is working;
- the agent waits on a choice;
- a filled-in prompt is not yet confirmed sent;
- the shell runs a job, or was replaced by another program;
- idleness cannot be established.

A request that states it insists SHALL skip this check and proceed, as the desktop's own manual hibernation
and close do.

The desktop's own hibernate and close SHALL NOT change: they do not ask.

#### Scenario: A working shell is not hibernated without insisting

- **WHEN** a shell session runs a long command, and a client hibernates it without insisting
- **THEN** the response is a busy error naming a running job, and the command is still running

#### Scenario: Insisting hibernates a working shell

- **WHEN** a shell session runs a long command, and a client hibernates it insisting
- **THEN** the session's process ends, and the session list shows it not running

#### Scenario: An agent waiting on a choice is not closed without insisting

- **WHEN** an agent session waits on a permission prompt, and a client closes it without insisting
- **THEN** the response is a busy error naming the choice, and the session is still listed and running

#### Scenario: Insisting closes an agent waiting on a choice

- **WHEN** an agent session waits on a permission prompt, and a client closes it insisting
- **THEN** the session is absent from the session list

#### Scenario: An idle agent needs no insisting

- **WHEN** an agent session waits for the user's next message, and a client hibernates it without insisting
- **THEN** the session is hibernated

### Requirement: A watch ends with the reason its session's process ended

A conversation watch and a terminal watch SHALL last while the watched session's process runs. When the
process ends, every watch of that session SHALL end, and the client SHALL be told one of these reasons:

- the process exited on its own;
- the session was hibernated;
- the session was closed.

This SHALL hold whoever ended it: a device or the user at the desktop. A watch that ends SHALL stop counting
the session as displayed for automatic hibernation (see `session-hibernation`).

Two endings keep their own rules:

- a window reload or close (see "With no window, session operations are refused rather than opening one");
- an agent that the application restarts on its own after a failed resume. Its terminal watch ends as
  restarted, and its conversation watch continues.

A client SHALL be told the reason as a value it may not know yet. Clients ignore values they do not know
(see "The authentication answer lists the operations the desktop accepts").

#### Scenario: Hibernating a watched session ends its watches as hibernated

- **WHEN** a client watches an agent session's conversation and terminal, and the session is hibernated
- **THEN** the client is told that both watches ended because the session was hibernated

#### Scenario: Closing a watched session on the desktop tells the client

- **WHEN** a client watches an agent session's conversation and terminal, and the user closes that session on the desktop
- **THEN** the client is told that both watches ended because the session was closed

#### Scenario: A session hibernated while watched hibernates automatically again after waking

- **WHEN** automatic hibernation is enabled with a short threshold, a client watches an idle agent session's conversation, the session is hibernated, and it is then woken and left idle without being watched or displayed
- **THEN** the session is hibernated automatically after the threshold

#### Scenario: A process that exits on its own ends the watch as exited

- **WHEN** a client watches a shell session's terminal, and the shell exits
- **THEN** the client is told the watch ended because the process exited

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

### Requirement: OpenSpec answers stay within the frame cap

No answer to an OpenSpec operation SHALL exceed the frame size the protocol document states for these answers
(1 MiB of UTF-8). The protocol document SHALL say that the bound applies to OpenSpec answers.

When reading a change or a spec would exceed it, the desktop SHALL leave out content, the largest piece first, until
the answer fits, and SHALL mark each piece left out with its size; everything else in the answer SHALL be as it
would have been. If the answer still exceeds the bound with all content left out, and when listing a folder's
changes or specs would exceed it, the answer SHALL be an error stating the limit.

#### Scenario: An oversized artifact is left out and the rest of the change still reads

- **WHEN** a client reads a change one of whose artifacts alone is larger than the frame cap
- **THEN** the answer fits the frame cap, that artifact is marked as left out with its size, and the change's other
  artifacts carry their content

#### Scenario: A change within the cap is sent whole

- **WHEN** a client reads a change whose answer fits the frame cap
- **THEN** no piece of it is marked as left out

#### Scenario: A list over the cap is refused with the limit

- **WHEN** a client lists the changes of a folder whose list would exceed the frame cap
- **THEN** the answer is an error stating the limit

### Requirement: A client watches one folder's OpenSpec and is told when it changes

A client SHALL be able to watch the OpenSpec content of one folder at a time. Watching another folder SHALL replace
the watch, a watch request naming no folder SHALL end it, and the watch SHALL end with the connection. Watching a
folder that is not in the workspace SHALL be answered as not found.

When the watched folder's OpenSpec content changes on disk, including in another working tree of its repository,
the connection SHALL receive an event naming the folder. The event SHALL carry no content; a client reads again what
it shows. Connections not watching that folder SHALL NOT receive it.

For one folder, events SHALL be sent at most once a second, and every change SHALL be followed by an event within a
second or so. Folders SHALL be throttled independently. A folder removed from the workspace SHALL produce no further
events.

The protocol document SHALL state that a desktop listing the watch operation in its authentication answer sends the
OpenSpec results in the shapes the document names, and that a desktop not listing it may send additional fields,
artifacts in another order, and no change events.

#### Scenario: Writing a task file announces the watched folder

- **WHEN** a client watches a folder and an agent then writes the `tasks.md` of a change of that folder that lives in
  a linked working tree outside the folder
- **THEN** the client receives an event naming that folder, and reading the change again returns the new content

#### Scenario: A burst of writes is announced at most once a second, and its end is announced

- **WHEN** a watched folder's OpenSpec content changes many times within a few seconds
- **THEN** the client receives at most one event for that folder per second, and an event after the last change

#### Scenario: A connection not watching the folder is not told

- **WHEN** two clients are connected, one watching a folder and the other watching another folder, and the first
  folder's OpenSpec content changes
- **THEN** only the first client receives an event

#### Scenario: Watching another folder replaces the watch

- **WHEN** a client watches one folder and then another, and the first folder's OpenSpec content changes
- **THEN** the client receives no event for the first folder

#### Scenario: A removed folder is not announced

- **WHEN** a client watches a folder, its OpenSpec content changes, and the folder is removed from the workspace
  before the event is sent
- **THEN** the client receives no event for that folder

### Requirement: A device sees the background work of an agent session

The session list SHALL carry, for each agent session whose process is running and that has at least one kept
background task (`agent-event-bridge`), those tasks in the order the agent reported them, each with its identifier,
kind and label (none when it has no label). For any other session — a shell, a dormant session, an agent session with
no kept task — the list SHALL carry no background field at all, so that a client reads the absence the same way for
this desktop and for one that predates the field.

A change of a session's kept tasks, their order included, SHALL be sent to connected clients as a new complete list,
like any other change to the list, without waiting for an unrelated change.

The protocol document SHALL describe the field, that it reflects the agent's last report rather than the present
moment, when it appears and goes, and the label rule; and SHALL name, as a client obligation, that a client shows a
label as plain text and never as a link.

#### Scenario: A background shell is listed when the turn ends

- **WHEN** a client is connected, and an agent session S's turn completion lists a running background shell with a description
- **THEN** the client receives a session list in which S carries one background task of kind shell, labelled with that description

#### Scenario: A subagent's completion reaches the client at once

- **WHEN** a client has received a session list in which S carries a background subagent C and a shell D, and C's completion lists C and D as running
- **THEN** the client receives, without any other change, a session list in which S carries D alone

#### Scenario: The field is absent when there is nothing to show

- **WHEN** the client receives a session list with a shell session, a dormant agent session, and a running agent session whose last turn completion listed no task in flight
- **THEN** none of those sessions carries the background field

#### Scenario: Hibernation removes the background field

- **WHEN** S carries background tasks, and the user hibernates S on the desktop
- **THEN** the client receives a session list in which S is not running and carries no background field

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
