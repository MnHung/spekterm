## ADDED Requirements

### Requirement: A phone learns its relay grant over its own authenticated connection

When a phone authenticates with `hello` and the desktop holds a relay grant for that phone (`phone-relay`) with the
setting on, the answer SHALL carry `relay`: the team server's address as the membership stores it, the membership's
pin when it has one, the grant id and the grant secret. When the desktop holds no such grant, the answer SHALL NOT
carry the field, and a phone SHALL treat its absence as having no grant. The `pair` answer SHALL NOT carry it.

While a phone is connected, the desktop SHALL send that phone's connections — and no other device's — a
`relay.changed` event with the complete current value, or `null`, whenever the value it would put in a `hello`
answer changes. A connection that has not authenticated SHALL receive neither.

This is an addition to protocol version 1. A client that ignores the field and the event SHALL keep working as before,
reaching the desktop directly. The protocol document SHALL state the field, the event, the meaning of absence and of
`null`, that `pair` is refused on a relayed connection, and that a relayed connection's failures are throttled per
grant.

**Reason**: the phone needs a grant, the server's address and its pin to open the relay, and only the desktop holds
them. Giving them over the phone's own authenticated connection keeps them off the pairing link (server design D11)
and lets the desktop take them back.

#### Scenario: The hello answer carries the phone's grant

- **WHEN** the setting is on, a phone holds a grant, and it authenticates with `hello`
- **THEN** the answer's `relay` names the membership's server address, its pin, and that phone's grant id and secret

#### Scenario: A phone without a grant gets no field

- **WHEN** the setting is off and a paired phone authenticates
- **THEN** the answer has no `relay` field

#### Scenario: A new grant reaches the connected phone only

- **WHEN** two phones are connected and a grant is created for one of them
- **THEN** that phone's connection receives `relay.changed` with its grant, and the other receives no `relay.changed`

#### Scenario: A revoked grant is announced as null

- **WHEN** a connected phone holds a grant and the user turns the setting off
- **THEN** that phone's connection receives `relay.changed` with `relay: null`

#### Scenario: The protocol document states the relay field

- **WHEN** `docs/remote-protocol.md` is read
- **THEN** it states the `relay` field of the `hello` answer, the `relay.changed` event, what absence and `null`
  mean, that `pair` is refused through the relay, and the per-grant throttle
