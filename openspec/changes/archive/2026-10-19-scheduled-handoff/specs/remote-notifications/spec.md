## MODIFIED Requirements

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
- a new item arrives in the inbox, a handoff's arrival included, as on the desktop. A scheduled handoff
  arrives when it opens, not when it is scheduled (`scheduled-handoff`), as the desktop's notification does.

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

#### Scenario: A scheduled handoff raises its intake event when it opens

- **WHEN** a client watches the attention stream, a handoff scheduled for two minutes from now is read, and later its time comes
- **THEN** the client receives no intake event when it is read, and one intake event for it when it opens
