## MODIFIED Requirements

### Requirement: An agent's close of its own session is offered to the user, not carried out

When the agent's own session is the target of a close command and its turn has ended, the system SHALL NOT close
it. It SHALL instead **offer** the close: the session's terminal view and conversation view SHALL show that the
agent asked to close this session, with an action that closes it and an action that keeps it. The session SHALL
keep running, and SHALL close only when the user chooses to close it. The agent's last reply may be what the user
most needs to read, and a close at the end of the turn would take it away the moment it appears.

The offer SHALL leave the session's content readable and scrollable underneath: only the offer's own controls take
pointer input. The offer SHALL NOT take keyboard focus.

The offer SHALL be withdrawn, and the session kept, when:

- the user chooses to keep it, on the desktop or from a paired device (`remote-protocol`);
- anything is typed into the session (the same rule that drops a waiting command);
- the session's process ends for any other reason, a hibernation included.

The offer SHALL be one fact for the desktop's views and for paired devices: withdrawing it anywhere SHALL withdraw
it everywhere, and a session whose process ended SHALL NOT be offered again when it is woken, unless its agent asks
again. Every change to an offer SHALL reach paired devices when it happens (`remote-protocol`).

Choosing to close SHALL be the user's own close, with the effects of the desktop's close. A hibernate command on the
agent's own session, and every command on a descendant, SHALL NOT be offered: they are carried out as before. An
offer SHALL NOT survive the application quitting.

#### Scenario: The close is offered when the turn ends, and nothing closes on its own

- **WHEN** the agent in session S writes a close command with no target, and its turn ends
- **THEN** S's views show that the agent asked to close it, with a close and a keep action
- **AND** S is still running after its turn has ended

#### Scenario: The agent's last words stay readable under the offer

- **WHEN** S is offered for closing
- **THEN** the content of S's terminal is still visible and can be scrolled, and keyboard focus has not moved

#### Scenario: Keeping the session withdraws the offer

- **WHEN** S is offered for closing, and the user chooses to keep it
- **THEN** the offer is gone, and S is still running

#### Scenario: Typing into the session withdraws the offer

- **WHEN** S is offered for closing, and the user types into S
- **THEN** the offer is gone, and S is still running

#### Scenario: A hibernated session loses its offer for good

- **WHEN** S is offered for closing, the user hibernates S, and later wakes it
- **THEN** S's views show no offer, and no paired device is told that S is offered

#### Scenario: A descendant's close is not offered

- **WHEN** the agent in P closes its child C, which is at rest
- **THEN** C is closed without any offer
