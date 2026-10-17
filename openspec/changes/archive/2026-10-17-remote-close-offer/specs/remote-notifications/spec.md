## ADDED Requirements

### Requirement: An agent's offer to close its own session raises no attention event of its own

An agent's close of its own session being offered to the user (`agent-session-control`) SHALL NOT raise an attention
event of its own. The offer normally follows the agent's turn completion, which already raises a waiting event,
marked suppressed under the same rule. A second event would notify twice for one moment, and the offer is decided
after the turn completion, so the waiting event cannot be held back for it. A device opened by the waiting event
reads the offer from the session list (`remote-protocol`).

This leaves a known gap: a turn that ends in a failure the agent reports (an API error) rather than a turn
completion raises no waiting event, so an offer that follows it raises none either, and a device learns of it only
from the session list.

#### Scenario: An offered close notifies once

- **WHEN** a client watches the attention stream, and the agent in session S closes its own session and its turn ends
- **THEN** the client receives one waiting event for S for that turn end, and no other attention event for S
- **AND** the session list it receives marks S as offered for closing
