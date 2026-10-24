## ADDED Requirements

### Requirement: A message the user did not type is labeled with where it came from

The conversation view SHALL label a message marked as not typed by the user with its origin when it carries one:
a message from another session with that session's name (or as from another session when no name is given), a
subagent's report with the subagent's type (or as from a subagent), a background-task notice as one. A message
with no origin SHALL keep the generic not-typed label. The labels SHALL come from the dictionary in every
supported language.

**Reason**: a session's message is shown as the sender's message, without the agent's wrapper that used to name the
sender (`agent-transcript-stream`); without the label the desktop could no longer tell who sent it.

#### Scenario: A message from another session names the session

- **WHEN** the conversation holds a message from another session that names its sender
- **THEN** the message's label names that session

#### Scenario: A background-task notice is labeled as one

- **WHEN** the conversation holds a background-task notice
- **THEN** its label says it is a background-task notice

#### Scenario: A not-typed message without an origin keeps the generic label

- **WHEN** the conversation holds a not-typed message with no origin, such as a skill's text
- **THEN** its label is the generic not-typed label
