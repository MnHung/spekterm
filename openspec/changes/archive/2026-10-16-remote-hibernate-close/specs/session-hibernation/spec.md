## MODIFIED Requirements

### Requirement: The user can hibernate a running session

The system SHALL let the user hibernate a running session from the session's tab context menu and from its
row on the rail. A paired device SHALL be able to request it too (see `remote-protocol`). Such a request is a
hibernation the user asked for: it is not subject to the automatic policy's displayed and idle-time
conditions. A device that does not insist is refused for a session that is not idle by this capability's
definition of idle.
Hibernating SHALL end the session's process and leave the session **dormant** — the same
state a restored, not-yet-woken session is in (see `session-persistence`).

The session SHALL keep everything that identifies it: its place in the tab order and on the rail, its
user-given name, the title its process last declared, its working directory identifier, its fixed agent
name, its lineage, and — for a `claude` session — its conversation identifier.

The hibernate action SHALL be offered only for a running session. It SHALL NOT be offered for a dormant or
an exited session.

#### Scenario: Hibernating a shell session ends its process and keeps the tab

- **WHEN** the user hibernates a running shell session
- **THEN** the session's process no longer exists
- **AND** the session remains in the same tab position, with the same label, shown as dormant

#### Scenario: A hibernated claude session resumes the same conversation

- **WHEN** the user hibernates a running `claude` session that has exchanged messages with the agent, and
  later wakes it
- **THEN** the session resumes the same conversation

#### Scenario: A session can be hibernated and woken repeatedly

- **WHEN** the user hibernates a session, wakes it, hibernates it again and wakes it again
- **THEN** after each wake the session is running

#### Scenario: No hibernate action on a session without a process

- **WHEN** the user opens the context menu of a dormant session, or of an exited session
- **THEN** the menu does not offer to hibernate it

### Requirement: Activity during an automatic hibernation prevents it

If a session stops being eligible after it has been judged eligible for automatic hibernation but before its
process is ended — it became displayed, its agent started working, it produced output — the system SHALL NOT
hibernate it. The decision SHALL be re-checked at the moment of execution.

This re-check SHALL apply to automatic hibernation only. A hibernation the user asked for SHALL proceed even
for the displayed session or a working agent. The one exception is a paired device's request that does not
insist: it SHALL be refused for a session that is not idle (see `remote-protocol`). A device's request that
insists proceeds like any other request the user makes.

#### Scenario: A session displayed between decision and execution is kept

- **WHEN** a session has been judged eligible and becomes the displayed session before its process is ended
- **THEN** the session is still running

#### Scenario: The user can hibernate the displayed, working session

- **WHEN** the displayed session's agent is working and the user hibernates it
- **THEN** it is hibernated
