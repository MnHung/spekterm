## MODIFIED Requirements

### Requirement: Every connection authenticates within a bounded time, and failures are throttled per source

A connection SHALL authenticate, either with a device credential or with a pairing code, within ten seconds
of the TLS handshake. Otherwise it SHALL be closed. A connection that presents an unknown device, a wrong
credential, or an invalid code SHALL be refused. No operation of `remote-protocol` SHALL be served before
authentication.

After ten refusals from one source within sixty seconds, the application SHALL refuse unauthenticated
connections from that source for sixty seconds. Other sources SHALL be unaffected. **The source of a direct
connection is its remote address; the source of a connection that arrived through the team server's relay
(`phone-relay`) is the relay grant it came through**, since such a connection has no address of its own and
keying it by a shared placeholder would let failures through one grant block every relayed phone.

The number of connections that have not yet authenticated SHALL be capped separately from authenticated
ones. When that cap is reached, a new connection SHALL be admitted by closing the oldest unauthenticated
one, so that idle unauthenticated connections cannot keep a paired device out. A connection that reaches
the authentication deadline without authenticating SHALL count as a refusal for its source. Relayed and direct
connections SHALL count toward the same caps.

Throttling is not what protects the credentials; they are long enough that guessing is not a threat. It
limits noise. A global lockout would let anyone on the network keep the user's own phone out, so there is
none. What remains is that a party sharing the phone's public address (the same carrier NAT) can delay that
phone's reconnection, and this is stated.

#### Scenario: A paired device connects with its credential

- **WHEN** a paired device connects and presents its credential
- **THEN** the connection is accepted, and the device's last-seen time is updated

#### Scenario: A wrong credential is refused

- **WHEN** a client presents a known device id with a wrong credential
- **THEN** the connection is closed without serving any operation

#### Scenario: A silent connection is closed

- **WHEN** a client completes the TLS handshake and sends nothing for more than ten seconds
- **THEN** the connection is closed

#### Scenario: Repeated failures throttle only their source

- **WHEN** ten refused attempts come from one address within sixty seconds, and then a paired device presents its correct credential from that address and from another
- **THEN** the attempt from the throttled address is refused, the one from the other address is accepted, and the throttled address is accepted again once sixty seconds have passed

#### Scenario: Silence counts as a failure

- **WHEN** one address opens ten connections within sixty seconds that each stay silent past the deadline
- **THEN** that address is throttled as after ten refusals

#### Scenario: Idle unauthenticated connections do not keep a device out

- **WHEN** as many unauthenticated connections as the cap allows are open and idle, and a paired device connects with its credential
- **THEN** the device's connection is accepted

#### Scenario: Relayed failures throttle only their grant

- **WHEN** ten refused attempts arrive through one relay grant within sixty seconds, and then paired phones present
  their correct credentials through that grant, through another grant, and directly
- **THEN** the attempt through the throttled grant is refused, and the other two are accepted

## ADDED Requirements

### Requirement: A relayed connection authenticates only as the grant's phone, and never pairs

A connection that arrived through the team server's relay SHALL be refused when it asks to pair, as for an invalid
code, without consuming the pairing code that is open, and the refusal SHALL count toward that grant's throttle. Only
`hello` with the credential of the phone the grant was made for SHALL authenticate a relayed connection; another
paired device's credential through that grant SHALL be refused as a wrong credential and counted the same way. An open
pairing code SHALL therefore be usable only by a client that reaches the listener directly.

The grant's phone SHALL be the one fixed when the tunnel was accepted, so that turning a setting off during the
tunnel's handshake does not make the right phone's credential be refused.

A relayed connection that has not upgraded to the WebSocket within the authentication deadline SHALL be closed and
counted as a refusal for its grant; one that closes on its own before the deadline SHALL NOT be counted. Turning
remote access off SHALL close relayed connections at every stage, before the upgrade included.

#### Scenario: A pairing attempt through the relay is refused

- **WHEN** the pairing view is open and a client presents its valid code through a relay tunnel
- **THEN** the client is refused, no device is added, and a client that then presents the same code directly pairs

#### Scenario: Another phone's credential through a grant is refused

- **WHEN** phones A and B are paired, the grant was made for A, and B's valid credential is presented through it
- **THEN** the connection is refused and the refusal counts toward that grant's throttle

#### Scenario: A silent relayed connection is closed

- **WHEN** a relayed connection completes TLS and sends nothing
- **THEN** it is closed within the authentication deadline and counted as a refusal for its grant

#### Scenario: The right phone is not refused when the setting changes mid-handshake

- **WHEN** a tunnel for phone A has been accepted, the user turns the relay setting off, and phone A then presents
  its own credential through the tunnel before the tunnel ends
- **THEN** the answer is not `AUTH_FAILED`

#### Scenario: A relayed connection that drops before upgrading is not counted

- **WHEN** a relayed connection closes during its TLS handshake, before the deadline
- **THEN** no refusal is counted for its grant

#### Scenario: Turning remote access off closes a relayed connection before its upgrade

- **WHEN** a relayed connection has completed TLS but not yet upgraded, and the user turns remote access off
- **THEN** that connection is closed
