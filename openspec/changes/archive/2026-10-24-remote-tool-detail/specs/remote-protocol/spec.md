## ADDED Requirements

### Requirement: The session list names each agent session's messaging name

Each agent session in the session list SHALL carry the name it is started with for the agent's local session
messaging, once the session has one, whether it is running or dormant. A shell session SHALL NOT carry one. A
client SHALL be able to match the sender or recipient named in a conversation against it, to show that session's
label instead.

#### Scenario: A dormant agent session lists its messaging name

- **WHEN** a device lists sessions while an agent session that has run before is dormant
- **THEN** that session's entry carries its messaging name

#### Scenario: A rename keeps the messaging name

- **WHEN** the user renames an agent session and a device lists sessions
- **THEN** the session's entry carries the new label and the same messaging name

#### Scenario: A shell session has no messaging name

- **WHEN** a device lists sessions including a shell session
- **THEN** the shell session's entry carries no messaging name

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
- reading a file the agent sent to the user (see `remote-sent-files`);
- watching a session's terminal output, and sending it input;
- creating a session;
- waking a dormant session;
- renaming a session;
- hibernating a running session;
- closing a session;
- keeping a session whose agent offered to close it (withdrawing the offer);
- listing, accepting and ignoring inbox items;
- submitting the prompt the desktop filled into a session and left unsent;
- reading handoff state and a handoff's brief;
- reading OpenSpec changes, change details and specs, and watching one folder's OpenSpec for changes;
- watching the attention stream, resuming from the last event received (see `remote-notifications`).

Writing or deleting files, changing settings, reading the Slack configuration, reading any credential other than
as a file the agent sent to the user, and changing a terminal's size SHALL NOT be operations. The one exception to "writing files" is an uploaded
attachment. It is written only into the desktop's attachment store, under a name the desktop chooses
(`remote-attachments`). Closing a session removes that session's attachments, as closing it on the desktop
does. Besides OpenSpec content and handoff briefs, the only file a device reads is one the session's agent sent
to the user, addressed by the agent's tool call, whatever it holds (`remote-sent-files`). No operation SHALL take a path or a directory from the device.

#### Scenario: An unknown operation is refused without effect

- **WHEN** an authenticated client invokes an operation name that is not on the list, such as one that writes a file
- **THEN** the response is an error naming the operation as unknown, and the connection stays open

#### Scenario: A failed operation keeps the connection

- **WHEN** an authenticated client watches a session id that does not exist
- **THEN** the response is an error with a not-found code, and a following valid operation succeeds on the same connection

#### Scenario: The authentication answer lists reading a sent file

- **WHEN** a paired device authenticates with a desktop that has this operation
- **THEN** the answer's list of operations includes reading a file the agent sent to the user
