## ADDED Requirements

### Requirement: An authenticated connection learns the desktop's current addresses

When a connection authenticates, by either presenting a device credential or pairing, the answer SHALL carry
the addresses at which the desktop may currently be reached. The list SHALL be built the same way as the
pairing link's: non-loopback interface addresses, IPv4 first, then IPv6 other than link-local, then the user's additional
address if one is set.

While devices are connected, the server SHALL notice when that list changes and send the complete new list to
every authenticated connection as an event. A connection that has not authenticated SHALL receive no
addresses.

This is an addition to protocol version 1. A client that ignores the field and the event SHALL keep working as
before. The protocol document SHALL state the field, the event, and what a client does with them.

**Reason**: a phone knew the desktop's addresses only from the pairing link. When the desktop's address
changed under an existing pairing, the phone could not reach it on that network until the user paired again,
even though the phone connected over another path in the meantime. The certificate pin, not the address,
decides which desktop the phone trusts, so a new address cannot make it trust another machine.

#### Scenario: The answer to an authenticated connection carries the addresses

- **WHEN** a paired device authenticates
- **THEN** the answer carries the desktop's current address list, including the additional address the user set

#### Scenario: A pairing connection receives the addresses too

- **WHEN** a device pairs
- **THEN** the answer carries the desktop's current address list

#### Scenario: A change while connected is announced

- **WHEN** a device is connected and the desktop's address list changes
- **THEN** the device receives an event carrying the complete new list

#### Scenario: An unchanged list is not announced

- **WHEN** a device stays connected and the address list does not change
- **THEN** the device receives no address event

#### Scenario: A refused connection learns no addresses

- **WHEN** a connection fails to authenticate
- **THEN** nothing it receives carries the address list

#### Scenario: A connection that has not yet authenticated receives no address event

- **WHEN** one connection is open but has not yet authenticated, another is authenticated, and the address list changes
- **THEN** the authenticated connection receives the address event
- **AND** the unauthenticated connection receives nothing
