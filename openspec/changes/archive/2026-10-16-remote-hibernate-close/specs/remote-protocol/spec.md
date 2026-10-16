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

### Requirement: With no window, session operations are refused rather than opening one

While the application has no window, creating, waking, renaming, hibernating, closing and accepting SHALL be
refused with an error stating that no window exists. The application SHALL NOT open a window for them.

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
- **THEN** the answer lists the operations the server accepts, including renaming, hibernating, closing, uploading an attachment and answering a prompt, and does not list authentication operations

## ADDED Requirements

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
