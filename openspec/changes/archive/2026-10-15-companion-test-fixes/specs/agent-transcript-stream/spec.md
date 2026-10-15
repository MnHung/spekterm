## ADDED Requirements

### Requirement: A message the user typed while the agent worked is presented as the user's message

A message the user submits while the agent is running tools is recorded by the agent as a different record
type from an ordinary user message (measured, CLI 2.1.300: an `attachment` record of subtype
`queued_command`). The follower SHALL present such a record as a user message when, and only when, the record
says it is a prompt typed by a human. That same subtype also carries background-task notices and messages
from other sessions, and those SHALL NOT be presented as the user's message.

The presented text SHALL be the text the user submitted, unchanged: a client confirms that its message
arrived by matching that text. The message SHALL be identified by the record's own identifier and time, and
SHALL appear where the record appears in the transcript.

This extends the record white-list by one subtype of one more record type. Every other record of that type
SHALL remain ignored.

#### Scenario: A message typed during a tool run appears

- **WHEN** the user submits a message while the agent is running a tool, and the agent records it as a mid-turn delivery
- **THEN** the conversation shows that message as the user's, with exactly the submitted text

#### Scenario: Other deliveries of the same record type are not the user's

- **WHEN** the transcript holds a mid-turn delivery that is a background-task notice, and another that is a message from another session
- **THEN** neither is shown as the user's message

#### Scenario: Other records of that type stay ignored

- **WHEN** the transcript holds a record of the same type with any other subtype
- **THEN** it is not shown, and no error is shown

### Requirement: A user record that the user did not type is marked as such

A user record SHALL be marked as not typed by the user when any of these holds:

- the record says it is a meta record;
- the record says its prompt came from the system;
- the record names an origin that is not a human;
- the record is the summary the agent writes when it compacts a conversation.

A record that carries none of these markers SHALL be presented as typed by the user, as before. That keeps
records from agent versions that do not write these fields unchanged.

**Reason**: the agent writes background-task completion notices, and conversation summaries, as user records
with no meta flag (measured, CLI 2.1.300). Deciding by the meta flag alone shows them as the user's own words.

#### Scenario: A background-task notice is not the user's message

- **WHEN** the transcript holds a user record that the agent wrote as a background-task completion notice, with no meta flag and a system prompt source
- **THEN** the conversation marks it as not typed by the user

#### Scenario: A compacted conversation's summary is not the user's message

- **WHEN** the transcript holds the summary record the agent wrote when compacting the conversation
- **THEN** the conversation marks it as not typed by the user

#### Scenario: A typed prompt is still the user's message

- **WHEN** the transcript holds a user record the user typed, whose origin is human
- **THEN** the conversation shows it as the user's message

#### Scenario: A record without origin fields keeps the meta flag's verdict

- **WHEN** the transcript holds a user record with no prompt source, no origin and no meta flag
- **THEN** the conversation shows it as the user's message
