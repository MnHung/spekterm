## ADDED Requirements

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

## MODIFIED Requirements

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
