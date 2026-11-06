# phone-relay Specification

## Purpose
Reaching this desktop from its paired phones through the team server (spekterm-server's relay), as an optional second
path beside direct access: the setting, one grant per paired phone and its lifecycle, accepting or refusing a tunnel,
the desktop's leg to its own server, and how a relayed connection reaches the remote access listener. The server's side
is spekterm-server's `docs/protocol.md` section 13; the phone's is spekterm-android.

## Requirements

### Requirement: Reaching the desktop through the team server is a setting, off by default

Settings → Team SHALL offer a setting that lets the desktop's paired phones reach it through the team server. It SHALL
be off for a new membership and SHALL persist with the membership; leaving the team, or the membership being
discarded, SHALL drop it.

The control SHALL be shown when the membership's operations from the last `join` or `hello` answer list
`relay.grant` and remote access is on, and SHALL also be shown whenever the setting is on. While it is on but cannot
be used (remote access off, or the server's operations no longer list the relay), the section SHALL say which of the
two is the reason. While it is on, the section SHALL say how many of the paired phones hold a grant, and SHALL say so
when the server refused a grant because the device holds the most grants it allows.

Direct access SHALL stay the phone's first path: this setting adds a second one and changes nothing about the
listener's port, addresses or pairing.

#### Scenario: A new membership has the relay off

- **WHEN** the device joins a team whose server lists `relay.grant`, with remote access on
- **THEN** the switch is shown and off, and the desktop has asked the server for no grant

#### Scenario: A server without the relay shows no switch

- **WHEN** the device is on a team whose server's operations do not list `relay.grant`, and the setting was never
  turned on
- **THEN** the Team section shows no relay switch

#### Scenario: Remote access off hides an unused switch

- **WHEN** the server lists `relay.grant`, remote access is off, and the setting is off
- **THEN** the Team section shows no relay switch

#### Scenario: A switch that is on stays reachable

- **WHEN** the setting is on and the user turns remote access off
- **THEN** the switch is still shown, on, with a line saying remote access is off

#### Scenario: Leaving the team drops the setting

- **WHEN** the setting is on, the device leaves the team and joins again
- **THEN** the switch is off

### Requirement: Each paired phone gets its own grant while the setting is on

While the setting is on, remote access is on and the team connection is authenticated with a server listing the relay,
the desktop SHALL hold one relay grant per paired phone, requested with `relay.grant` and named after the phone. It
SHALL request a grant when the setting is turned on (for every paired phone) and when a phone pairs while it is on.

A grant's id and secret SHALL be kept only in the secret store, beside the id of the phone it was made for and bound
to the membership's server address and device id; a stored grant whose binding does not match the current membership
SHALL be discarded. The desktop SHALL write a new grant to the store before telling the phone of it.

The desktop SHALL revoke a phone's grant with `relay.revoke` when that phone is unpaired, when remote access is
reset, and when the setting is turned off. A grant the desktop no longer wants SHALL never be given to a phone again,
also while the revocation waits for a connection, and SHALL be revoked once the team connection is next
authenticated. Turning remote access off SHALL NOT revoke grants.

After every successful `hello`, the desktop SHALL reconcile with `relay.grants`: revoke every grant the server holds
for this device that the desktop does not hold, and forget (telling its phone) every grant the desktop holds that the
server no longer has. A grant whose answer arrives after its phone stopped being wanted (the setting turned off, the
phone unpaired, remote access reset) SHALL NOT be given to the phone and SHALL be revoked.

When the membership is discarded (left, revoked), every connected phone that held a grant SHALL be told at once that
it has none. While the Team feature is turned off, phones SHALL be told they have no grant, and nothing SHALL be
revoked; turning it on again SHALL give the grants back.

#### Scenario: Turning the setting on requests a grant per phone

- **WHEN** two phones are paired and the user turns the setting on while the team connection is authenticated
- **THEN** the server holds two grants for this device, one named after each phone, and each phone's connection is
  told its own grant

#### Scenario: A phone paired while the setting is on gets a grant

- **WHEN** the setting is on and a new phone pairs
- **THEN** the desktop requests a grant for it and tells that phone's connection

#### Scenario: Unpairing revokes the phone's grant

- **WHEN** the user revokes a paired phone that holds a grant
- **THEN** the server no longer lists that grant

#### Scenario: Turning the setting off revokes every grant

- **WHEN** the setting is on with grants for two phones and the user turns it off
- **THEN** the server lists no grant for this device, and each connected phone is told it has none

#### Scenario: A revocation made while disconnected happens at the next connection

- **WHEN** the team connection is down and the user unpairs a phone that holds a grant, then the connection comes back
- **THEN** the phone is never given the grant again, and after the `hello` the server no longer lists it

#### Scenario: A grant the desktop does not know is revoked

- **WHEN** the server lists a grant for this device that the desktop's store does not hold (an answer to
  `relay.grant` was lost)
- **THEN** after the next `hello` the desktop revokes it

#### Scenario: A grant the server lost is forgotten

- **WHEN** the desktop holds a grant that the server's `relay.grants` answer does not list
- **THEN** the desktop removes it from the store and tells its phone it has none, and requests a new grant for that
  phone if the setting is on

#### Scenario: The grant secret stays in the secret store

- **WHEN** a grant has been created
- **THEN** its secret is in the secret store and in no other file under the user-data directory, and the renderer's
  view of the team state does not contain it

#### Scenario: A grant answered after the setting was turned off is never given

- **WHEN** the desktop has requested a grant for a phone and the user turns the setting off before the answer arrives
- **THEN** the phone is never told of that grant, and the server no longer lists it after the round ends

#### Scenario: Leaving the team tells the phones at once

- **WHEN** two phones hold grants and are connected, and the device leaves the team
- **THEN** each phone's connection is told it has no grant

#### Scenario: Turning the Team feature off withdraws the grants without revoking them

- **WHEN** a connected phone holds a grant and the user turns the Team feature off, then on again
- **THEN** the phone is told it has no grant while the feature is off and is told the same grant once it is on again

#### Scenario: A grant from another membership is not used

- **WHEN** the stored grants were made for another server address or device id than the current membership's
- **THEN** they are discarded and no phone is told of them

### Requirement: A tunnel is accepted only for a grant the desktop holds, and only to its own server

When the team server announces that a phone asks for a tunnel (`relay.incoming`), the desktop SHALL refuse it with
`relay.refuse` when the setting is off, when remote access is off or not listening, when the grant is not one the
desktop holds and has given to a phone that is still paired, when that grant is throttled, or when the server
answered `RELAY_DISABLED` since the last `hello`.

Otherwise the desktop SHALL open its leg of the tunnel to the `/relay` path of the server of its own membership, as
stored, with the same certificate check as the team connection, and SHALL send nothing before that check. It SHALL
NOT take an address from the event. It SHALL send exactly one request, `relay.accept`, and nothing more until its
answer. A leg that has not been answered within ten seconds SHALL be ended.

After an accepted answer, the leg's bytes SHALL be handed to the remote access listener as one more incoming
connection, and every write the desktop makes on the leg SHALL be cut into messages of at most 64 KiB. Every end the
desktop decides SHALL end the leg's WebSocket at once, without waiting for a closing handshake. An `AUTH_FAILED`
answer on a leg SHALL NOT discard the membership by itself; the team connection does that on its own path.

#### Scenario: A tunnel for a held grant reaches the listener

- **WHEN** the setting is on, a phone opens `relay.open` with its grant against a team server with relaying on, and
  then authenticates with `hello` inside the tunnel
- **THEN** the desktop accepts, and the phone's `hello` is answered as on a direct connection

#### Scenario: A tunnel with the setting off is refused

- **WHEN** the setting is off and the server announces a tunnel
- **THEN** the desktop answers `relay.refuse` and opens no connection to `/relay`

#### Scenario: A tunnel for an unknown grant is refused

- **WHEN** the server announces a tunnel for a grant the desktop does not hold
- **THEN** the desktop answers `relay.refuse` and opens no connection to `/relay`

#### Scenario: A tunnel with remote access off is refused

- **WHEN** the setting is on, remote access is off, and the server announces a tunnel for a held grant
- **THEN** the desktop answers `relay.refuse`

#### Scenario: The leg goes only to the membership's server

- **WHEN** a tunnel is accepted
- **THEN** the desktop's leg connects to the stored membership's server address and checks its stored pin, and to no
  other host

#### Scenario: A pin mismatch sends nothing

- **WHEN** a tunnel is accepted and the certificate presented on the leg does not match the membership's pin
- **THEN** the leg ends without sending `relay.accept` or any other byte

#### Scenario: A large message crosses the tunnel

- **WHEN** through an accepted tunnel the listener sends a message of at least 1 MiB to the phone, and the phone sends
  one of at least 900 KiB
- **THEN** both arrive whole, the tunnel stays open, and no message on the leg is larger than 64 KiB

#### Scenario: A relayed connection survives a slow link

- **WHEN** a relayed phone watches a terminal producing about 8 KiB/s through a team server capped at 16 KiB/s per
  direction
- **THEN** the listener does not close the connection for missed pings within three minutes

#### Scenario: A leg whose peer stops reading ends at once

- **WHEN** a leg is open, the relay stops reading from it, and the listener's side of the stream ends
- **THEN** the leg's WebSocket is gone within a second, without waiting for a closing handshake

#### Scenario: The relay switched off at the server stops the desktop from dialing

- **WHEN** a leg is answered `RELAY_DISABLED`, and the server then announces another tunnel before the next `hello`
- **THEN** the desktop refuses it without opening a leg

### Requirement: Remote access ending ends relayed connections

Turning remote access off, resetting it, or quitting SHALL close relayed connections as it closes direct ones, and
SHALL end their legs. Turning the Team feature off SHALL end every open leg and its relayed connection. The team
connection dropping or reconnecting SHALL NOT end a relayed connection that is already open.

#### Scenario: Turning remote access off closes a relayed phone

- **WHEN** a phone is connected through the relay and the user turns remote access off
- **THEN** the phone's connection is closed with the same code as a direct one, and the desktop's leg ends

#### Scenario: Turning the Team feature off ends open tunnels

- **WHEN** a phone is connected through the relay and the user turns the Team feature off
- **THEN** the desktop's leg ends and the phone's relayed connection is closed, while a phone connected directly
  stays connected

#### Scenario: A team reconnect leaves a tunnel open

- **WHEN** a phone is connected through the relay and the team connection drops and reconnects
- **THEN** the phone's relayed connection stays open
