# remote-access Specification

## Purpose
Lets a device the user paired, such as the companion Android app, reach this spekterm directly over the
network. The connection is protected by a certificate the device pins and a per-device credential the user
can revoke. Remote access is off unless the user turns it on.

## Requirements

### Requirement: Remote access is off by default and listens only while turned on

Remote access SHALL be off unless the user has turned it on in the remote access section of Settings (see
`terminal-preferences`). While it is off, the application SHALL hold no listening socket and SHALL keep no
per-session output buffer for remote use.

While it is on, the application SHALL accept TLS connections on the configured port on all network
interfaces. Turning it off SHALL close every remote connection and release the port. The setting and the
port SHALL persist across restarts. With the setting on, the listener SHALL be started again at the next
launch.

The port SHALL default to 47615 and SHALL be changeable by the user to any value from 1024 to 65535. A typed
port SHALL apply only through its own control or Enter, not when focus leaves the field: a port change
restarts the listener and drops connected devices, so it is a deliberate action. The section SHALL say so next
to the field. A typed port that was not applied SHALL stay in the field marked as not applied, and Esc SHALL
restore the stored port.

#### Scenario: A fresh profile does not listen

- **WHEN** the application starts with a fresh user-data directory, in which remote access was never turned on
- **THEN** no process of the application holds a listening TCP socket

#### Scenario: Turning remote access on starts the listener

- **WHEN** the user turns remote access on in the remote access section of Settings
- **THEN** a TLS connection to the configured port succeeds

#### Scenario: Turning remote access off releases the port and drops connections

- **WHEN** a paired device is connected and the user turns remote access off
- **THEN** that device's connection is closed and no process of the application holds a listening socket on the port

#### Scenario: Remote access that was on is on again after a restart

- **WHEN** remote access is on, the application is closed and started again
- **THEN** a TLS connection to the configured port succeeds without the user turning it on again

#### Scenario: Changing the port moves the listener

- **WHEN** remote access is on and the user changes the port
- **THEN** a TLS connection succeeds on the new port and fails on the old one

#### Scenario: Leaving the port field does not change the port

- **WHEN** remote access is on, the user types another port and moves focus out of the field without applying it
- **THEN** a TLS connection still succeeds on the old port

### Requirement: A listen failure is shown to the user

When the listener cannot be started (the port is in use, or binding is not permitted), the application
SHALL show the failure and its cause in the remote access section of Settings, and Settings' list of sections
SHALL mark that section. It SHALL NOT present remote access as working. The switch SHALL stay on. Changing the port, or turning the switch off and on again, SHALL
retry.

#### Scenario: A port already in use is reported

- **WHEN** another process holds the configured port and the user turns remote access on
- **THEN** the remote access section states that the port is in use, does not say remote access is running, and the list of sections marks it

#### Scenario: Changing to a free port recovers

- **WHEN** after a reported port conflict the user changes to a free port
- **THEN** the failure is no longer shown and a TLS connection to the new port succeeds

### Requirement: The server identifies itself with a persistent self-signed certificate

When remote access is first turned on, the application SHALL generate a key pair and a self-signed
certificate, and SHALL present that certificate on every remote connection until the user resets remote
access. The remote access section of Settings SHALL show the certificate's SHA-256 fingerprint. The private
key SHALL be kept in the application's secret store and SHALL NOT leave the main process.

If, when remote access starts, the stored private key is missing or does not belong to the stored
certificate (for example because one of the two files was damaged and set aside), the application SHALL
treat it as a reset. It SHALL generate a new certificate, revoke every device, and state in the remote
access section that this happened and why. Paired devices must not silently stop connecting.

#### Scenario: The certificate is the same across restarts

- **WHEN** remote access is on, the application is restarted, and a client connects
- **THEN** the certificate presented has the same SHA-256 fingerprint as before the restart

#### Scenario: A key that no longer matches its certificate resets remote access

- **WHEN** the stored private key is missing or does not match the stored certificate, and remote access starts
- **THEN** a new certificate is generated, every device is revoked, and the remote access section states that remote access was reset and why

#### Scenario: The dialog shows the fingerprint of the presented certificate

- **WHEN** a client connects and computes the SHA-256 fingerprint of the certificate presented
- **THEN** it equals the fingerprint the remote access section shows

### Requirement: A device pairs with a single-use, short-lived code shown on the desktop

The remote access section of Settings SHALL let the user start pairing. Pairing SHALL show a QR code and the
same pairing link as selectable text. The link SHALL carry:

- the addresses at which this machine may be reached: its non-loopback interface addresses, and the
  additional address the user entered, if any;
- the port;
- the certificate fingerprint;
- a pairing code;
- the machine's name.

The pairing code SHALL be valid for at most five minutes, for one successful pairing only, and only
while the pairing view is open. The pairing view SHALL close when the user leaves the remote access section
or closes Settings. At most one pairing code SHALL be valid at a time. A device that presents a valid code
SHALL receive its own device credential, once. The pairing code SHALL then be invalid.

The application SHALL store a paired device's name, model, pairing time, last-seen time and a hash of its
credential. It SHALL NOT store the credential itself.

#### Scenario: A device pairs with the code from the dialog

- **WHEN** the user starts pairing and a client connects with the pairing link's code, a device name and a model
- **THEN** the client receives a device credential and the device appears in the section's device list under that name

#### Scenario: A pairing code works once

- **WHEN** a device has paired with a code and a second client presents the same code
- **THEN** the second client is refused and no second device is added

#### Scenario: An expired code is refused

- **WHEN** a client presents a pairing code more than five minutes after the section created it
- **THEN** the client is refused and no device is added

#### Scenario: Closing the pairing view invalidates the code

- **WHEN** the user closes the pairing view and a client then presents the code it showed
- **THEN** the client is refused

#### Scenario: Leaving the section invalidates the code

- **WHEN** the user starts pairing, switches to another section of Settings, and a client then presents the code
- **THEN** the client is refused

#### Scenario: The stored device record holds no usable credential

- **WHEN** a device has paired
- **THEN** no file under the user-data directory contains that device's credential

### Requirement: Every connection authenticates within a bounded time, and failures are throttled per source

A connection SHALL authenticate, either with a device credential or with a pairing code, within ten seconds
of the TLS handshake. Otherwise it SHALL be closed. A connection that presents an unknown device, a wrong
credential, or an invalid code SHALL be refused. No operation of `remote-protocol` SHALL be served before
authentication.

After ten refusals from one source address within sixty seconds, the application SHALL refuse
unauthenticated connections from that address for sixty seconds. Other addresses SHALL be unaffected.

The number of connections that have not yet authenticated SHALL be capped separately from authenticated
ones. When that cap is reached, a new connection SHALL be admitted by closing the oldest unauthenticated
one, so that idle unauthenticated connections cannot keep a paired device out. A connection that reaches
the authentication deadline without authenticating SHALL count as a refusal for its address.

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

### Requirement: The user can revoke a device or reset remote access

The remote access section of Settings SHALL list paired devices with their name, model, last-seen time,
and whether they are connected. The user SHALL be able to revoke any device.
Revoking SHALL first ask for confirmation in place and SHALL do nothing if the user declines; a revoked
device has to pair again. Once confirmed, revoking SHALL close that device's connections at once, SHALL delete
its record, and its credential SHALL no longer be accepted.

The user SHALL be able to reset remote access, after a confirmation. A reset SHALL generate a new certificate
and revoke every device.

#### Scenario: Revoking a connected device disconnects it

- **WHEN** a paired device is connected and the user revokes it and confirms
- **THEN** its connection is closed, and reconnecting with its credential is refused

#### Scenario: Declining a revoke keeps the device

- **WHEN** the user asks to revoke a device and then declines
- **THEN** the device is still listed and can still connect with its credential

#### Scenario: Revoking one device leaves the others

- **WHEN** two devices are paired and the user revokes one
- **THEN** the other can still connect with its credential

#### Scenario: A reset changes the certificate and revokes every device

- **WHEN** the user resets remote access
- **THEN** the presented certificate's fingerprint differs from before, and no previously paired device's credential is accepted

### Requirement: The desktop shows when a device is connected

While at least one paired device is connected, the activity bar SHALL show a remote access indicator, and
activating it SHALL open Settings on its remote access section. When no device is connected, the indicator
SHALL NOT be shown.

The remote access section SHALL state, next to the switch, that a paired device can do whatever the user can
do in a session, and that remote access should be off on networks the user does not trust.

#### Scenario: A connection shows the indicator

- **WHEN** a paired device connects
- **THEN** the activity bar shows the remote access indicator

#### Scenario: The indicator goes away with the last connection

- **WHEN** the only connected device disconnects
- **THEN** the activity bar no longer shows the remote access indicator

#### Scenario: The indicator opens the dialog

- **WHEN** the user activates the remote access indicator
- **THEN** Settings opens on its remote access section

### Requirement: The renderer never receives device credentials or private keys

The renderer SHALL receive the device list only as a projection: name, model, pairing time, last-seen time,
and connected. It SHALL NOT receive device credentials, their hashes, or private keys. The pairing code is the one remote access secret the renderer receives, because the
remote access section of Settings must show it.

#### Scenario: The device list sent to the renderer carries no secret material

- **WHEN** a device has paired, and the renderer requests the remote access state
- **THEN** the response contains no credential, hash or private key

### Requirement: Remote access keeps running while the application has no window

On a platform where the application keeps running after its window is closed, remote access SHALL keep
listening. Paired devices SHALL still connect, inbox attention events SHALL still be delivered (see
`remote-notifications`), and operations on sessions SHALL report that there is no window (see
`remote-protocol`). With no window there are no sessions, so no session-based attention event can arise.

#### Scenario: A device connects while no window exists

- **WHEN** on macOS remote access is on, the window is closed, and a paired device connects
- **THEN** the connection is accepted and the session list it receives is empty and states that no window exists
