## MODIFIED Requirements

### Requirement: Being on a team is off by default, and the connection exists only while it is on

spekterm SHALL be able to belong to one team on one spekterm-server (protocol version 1, `spekhq/spekterm-server`
`docs/protocol.md`, the interface contract this capability is written against).

The feature SHALL be **off** until the user turns it on in Settings. While it is off, spekterm SHALL open no
connection to any team server and SHALL send nothing to one. While it is on, spekterm SHALL hold **at most one**
connection, to the server of the membership it holds, and only while it holds a device credential; with no
membership it SHALL connect only to inspect or redeem an invite the user pasted, when the user asks. **Relay legs**
(`phone-relay`) are the one addition: while the relay setting is on, spekterm SHALL also open a connection to that same
server's `/relay` path for each tunnel one of its paired phones asks for, and none otherwise. Legs neither replace
nor are replaced by the one `/connect` connection, and SHALL NOT be opened while the feature is off.

Turning the feature off SHALL close the connection and SHALL keep the membership and its credential, so turning it
on again reconnects without a new invite. Turning it off SHALL NOT be presented as leaving the team.

#### Scenario: A membership with the feature off opens no connection

- **WHEN** the device has joined a team, the user turns the feature off and restarts spekterm
- **THEN** spekterm opens no connection to the team server

#### Scenario: Turning the feature off closes the connection and keeps the membership

- **WHEN** the device is connected to its team and the user turns the feature off, then on again
- **THEN** the connection is closed while it is off, and once it is on again the device connects with the same
  credential and no invite is asked for

#### Scenario: Relay legs open only for a phone's tunnel

- **WHEN** the device is connected to its team with the relay setting on, and no phone asks for a tunnel
- **THEN** spekterm holds exactly one connection to the team server; once a phone asks for a tunnel and it is
  accepted, it holds one more, to the same server's `/relay`

### Requirement: The device credential is kept only in the secret store and goes only to its server

The credential the server gives once at join (`deviceId`, `deviceSecret`) SHALL be stored before the join is shown
as successful: the secret in spekterm's secret store (`secret-scope`), the device id with the membership. **It SHALL
be written to disk before anything else uses it**. A credential that could not be stored SHALL make spekterm send
`device.leave` on the connection the join authenticated, so the server does not keep an orphan device, and then show
that the join could not be completed and a new invite is needed. If that leave is not answered either, spekterm
SHALL name the device's name so the admin can revoke it.

From the moment the join answer is read, the secret SHALL be held only in the form that cannot be printed (the
secret store's wrapper): the answer's frame, an error built from it, and every log line SHALL NOT contain it.

The secret SHALL NOT reach the renderer, any child process's environment, a diagnostic output, or any file spekterm
writes for an agent or a terminal (the handoff introduction, relations, receipts, context files, scrollback). It
SHALL be sent only in a `hello`, or in a `relay.accept` on a relay leg (`phone-relay`), to the server address of the
membership it belongs to, over a connection whose certificate was verified.

**Known gap, recorded and not claimed absent**: the secret store is a file owned by the user (`0600`), as the Slack
tokens are. A process the user runs — an agent with a shell among them — can read it. spekterm never hands the
secret to an agent; it does not stop one that reads the user's files from finding it. (The user's decision,
2026-11-03; the protocol's and the server PRD's wording is being changed to match.)

#### Scenario: The credential never reaches the renderer

- **WHEN** the device has joined and the renderer asks for the team's state
- **THEN** the answer contains no device secret

#### Scenario: The credential is not in a terminal's environment

- **WHEN** the device has joined and the user opens a terminal session
- **THEN** no value of that session's environment contains the device secret

#### Scenario: A credential that could not be stored leaves no orphan device

- **WHEN** the server accepts a join and storing the credential fails
- **THEN** spekterm sends `device.leave` on that connection, shows that the join could not be completed, and holds no
  membership

#### Scenario: The secret is not in diagnostic output

- **WHEN** a join succeeds and, in another attempt, the join answer arrives on a connection that then fails
- **THEN** no log line and no error message contains the device secret

#### Scenario: The relay leg carries the credential only to the membership's server

- **WHEN** a phone's tunnel is accepted
- **THEN** the device secret is sent in `relay.accept` on a connection to the membership's server address whose
  certificate was verified, and in no other frame of that leg

### Requirement: Nothing is sent before the server's certificate is verified

Every connection to a team server SHALL be TLS, to `<server address>/connect` or, for a relay leg (`phone-relay`), to
`<server address>/relay`. **No application data SHALL be sent
before the server's certificate is verified** — the WebSocket upgrade request included; only the TLS handshake
itself precedes the check:

- **with a pinned fingerprint**: the SHA-256 of the server's leaf certificate in DER SHALL equal the pin; no
  certificate authority and no host name are checked. A certificate that does not match SHALL stop the connection
  (see "A stop that needs the user is visible"): the server's certificate changed since joining, and a new device
  invite is needed;
- **without one**: the certificate SHALL be verified against the operating system's trust store together with the
  roots bundled with the runtime, and the host name. A
  certificate that fails SHALL be retried with backoff and its reason shown — an expired or renewed certificate on
  the server is the likeliest cause, and nothing is sent to an unverified server either way.

#### Scenario: A pinned certificate that does not match stops before anything is sent

- **WHEN** the membership pins a fingerprint and the server presents another certificate
- **THEN** the connection is closed before any application data, the upgrade request included, is sent, and
  spekterm says the server's certificate changed and a new device invite is needed

#### Scenario: A server certified by an authority the operating system trusts

- **WHEN** the server's certificate is issued by an authority in the operating system's trust store and not in the
  runtime's bundled roots, and the invite carries no fingerprint
- **THEN** the device joins and connects

#### Scenario: A self-signed server is trusted through its pin

- **WHEN** the invite carries the fingerprint of the server's self-signed certificate
- **THEN** the device joins and connects

#### Scenario: A relay leg with a mismatched pin sends nothing

- **WHEN** a tunnel is accepted and the server presents a certificate other than the pinned one on the relay leg
- **THEN** the leg is closed before any application data, the upgrade request included, is sent
