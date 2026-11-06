## MODIFIED Requirements

### Requirement: Attention events travel only over a device's own connection

The application SHALL deliver attention events only to clients connected to it, over each client's own
authenticated connection. It SHALL NOT send them, or anything derived from them, through a push service, and SHALL
NOT open any connection because of an event. A device's own connection MAY reach the desktop through the team
server's relay (`phone-relay`): its bytes are the device's TLS to the desktop, which the server passes on without
reading, and the desktop opened its side of that path only because the device asked for it. A device
that should notify its user while in the background has to keep its connection open; that is the client's concern,
and the protocol document says so.

#### Scenario: An event with no device connected opens no connection

- **WHEN** a device is paired but not connected, and an agent waits on a choice
- **THEN** the application opens no outbound connection for the event, and the event is held for that device's next connection

#### Scenario: An event with the relay on opens no connection

- **WHEN** the relay setting is on, a phone holding a grant is not connected, and an agent waits on a choice
- **THEN** the application opens no connection to the team server's relay for the event, and the event is held for
  that phone's next connection
