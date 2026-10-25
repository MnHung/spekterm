## ADDED Requirements

### Requirement: A device switches an agent session's model

A device SHALL be able to ask the watched conversation's agent to switch model with `conversation.setModel`,
taking `sessionId` and `model`. `model` SHALL be 1 to 100 characters from letters, digits and `. _ : / @ [ ]` and `-`,
not beginning with `-`; any other value SHALL be refused with a bad-parameters error and nothing SHALL be written.
The desktop SHALL write `/model <model>` exactly as it writes a reply to `conversation.send` — the same
conditions and errors (not the watched conversation, an agent that cannot take a reply, a held filled-in prompt,
no running process), the same per-session queue, the same re-checks before the submit key and the same outcomes
— and SHALL answer with the outcome and the text written. The answer SHALL NOT claim that the model changed.
`conversation.setModel` SHALL be on the list of operations the authentication answer carries.

#### Scenario: A switch is written like a reply

- **WHEN** a device that watches a session whose agent is ready invokes `conversation.setModel` with `sonnet`
- **THEN** `/model sonnet` is written to the session followed by the submit key, and the answer is `submitted` with that text

#### Scenario: A name with a space is refused

- **WHEN** a device invokes `conversation.setModel` with `sonnet extra`, or with an empty name, or with `-x`
- **THEN** the answer is a bad-parameters error and nothing is written to the session

#### Scenario: A held prompt refuses the switch

- **WHEN** the session holds a filled-in prompt nobody has sent and a device invokes `conversation.setModel`
- **THEN** the answer is the held-prompt error, as for a reply, and nothing is written

#### Scenario: The authentication answer lists the operation

- **WHEN** a paired device authenticates with a desktop that has this operation
- **THEN** the answer's list of operations includes `conversation.setModel`

### Requirement: A reply that is a one-name model command arms the switch

When the text a reply writes (including any attachment sentence) is exactly `/model` followed by one name of the charset above — whether it came from
`conversation.setModel` or from `conversation.send` — the desktop SHALL arm that name for the session
(`agent-model-switch`) after the last re-check and immediately before the submit key. A reply whose key is
withheld SHALL arm nothing. A bare `/model`, a `/model` with more than one argument, and any other text SHALL arm
nothing. A failure to arm SHALL NOT fail the reply.

#### Scenario: A hand-typed model command arms too

- **WHEN** a device sends `/model sonnet` through `conversation.send`
- **THEN** the session is armed for `sonnet` before the submit key is written

#### Scenario: A withheld key arms nothing

- **WHEN** the agent begins waiting on a choice during the delay before the submit key, so the key is withheld
- **THEN** no switch is armed and the outcome is `filled-not-submitted`

#### Scenario: Other text arms nothing

- **WHEN** a device sends `/model`, or `/model a b`, or `/effort high`, or `/model x` with an attachment
- **THEN** no switch is armed

## MODIFIED Requirements

### Requirement: Operations are an allow-list with named errors

An authenticated connection SHALL be able to invoke only the operations this capability names. Any other
operation SHALL be answered with an error naming it as unknown and SHALL have no effect. Every failure SHALL
be answered with a stable error code and a message. The connection SHALL stay open after an operation
fails.

The operations are:

- listing folders and sessions;
- watching a session's conversation, replying to it (with attachments, see `remote-attachments`), switching its
  agent's model, and answering its open prompt;
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
