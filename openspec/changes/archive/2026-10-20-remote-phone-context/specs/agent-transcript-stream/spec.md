## ADDED Requirements

### Requirement: A slash command is shown as the line the user typed

When the agent records a user message whose whole content is the agent's form for a slash command — the command's
name and, when given, its arguments, in the agent's command markers, in whichever order the agent writes them, with
only whitespace between them — the
conversation SHALL show it as the user's message `/name`, or `/name arguments` with the arguments trimmed. A message
that holds the markers among other text SHALL be shown as recorded. Whether the message is marked as not typed by the
user SHALL be decided as for any other user record.

A built-in command's output, recorded as a separate message in its own markers, is not covered and is shown as
recorded.

**Reason**: the conversation showed the markers, and a reply `/name arguments` sent from a device never matched its
entry, so it stayed "not confirmed".

#### Scenario: A skill run with arguments is shown as typed

- **WHEN** the transcript holds a user record whose content is the agent's command form for `/opsx:continue` with the arguments `my-change`
- **THEN** the conversation shows the user's message `/opsx:continue my-change`

#### Scenario: A command without arguments is shown as its name

- **WHEN** the transcript holds a user record whose content is the agent's command form for `/simplify` with empty arguments
- **THEN** the conversation shows the user's message `/simplify`

#### Scenario: A built-in command recorded name first is shown as typed

- **WHEN** the transcript holds a user record whose content is the agent's command form with the name marker first, for `/compact`
- **THEN** the conversation shows the user's message `/compact`

#### Scenario: Markers among other text are shown as recorded

- **WHEN** a user record holds typed text followed by the agent's command markers
- **THEN** the message is shown as recorded, markers included
