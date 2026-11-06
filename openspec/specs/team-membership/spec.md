# team-membership Specification

## Purpose
Being on a team that runs its own spekterm-server: joining from an invite link, the device credential and where it
may go, the one connection and when it reconnects or stops, the device name, leaving, and the members list. The
contract is spekterm-server's `docs/protocol.md`; handing work to teammates over this connection is `teammate-handoff`.

## Requirements

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

### Requirement: An invite link is read strictly, and the server address comes only from the user's join

An invite link SHALL be accepted only in the form `spekterm://join?v=1&s=<server address>&c=<code>[&fp=<fingerprint>]`:

- `v` SHALL be `1`;
- `s` SHALL be a `wss:` address with a host, an optional port and **no user information, path, query or
  fragment** (an empty path or `/` is accepted and normalized away, so the connection's path is exactly
  `/connect`); any other scheme SHALL be refused (`secret-scope`: the address is where the credential is sent). User
  information is refused because a WebSocket client turns it into an `Authorization` header sent to the server;
- `c` SHALL be 26 characters of RFC 4648 base32, compared case-insensitively;
- `fp`, when present, SHALL be 64 hexadecimal digits, compared case-insensitively;
- a parameter given twice SHALL make the link invalid.

A link that does not meet these SHALL be refused before any connection is made, with a message saying the link is
not a valid invite. **Surrounding whitespace SHALL be ignored**: a link is pasted.

The server address, and the fingerprint pinned with it, SHALL be written to the membership only by the user's
join, from the link the user pasted. Nothing else — a handoff, an inbox delivery, an agent's outbox file, a
message from the server — SHALL change where the credential is sent.

#### Scenario: A link with an http address is refused without connecting

- **WHEN** the user pastes `spekterm://join?v=1&s=https%3A%2F%2Fteam.example.com&c=<26 base32 characters>`
- **THEN** the link is refused as not a valid invite, and no connection is made

#### Scenario: A link with a path is refused

- **WHEN** the user pastes an invite whose `s` is `wss://team.example.com/other`
- **THEN** the link is refused as not a valid invite

#### Scenario: A link with user information is refused

- **WHEN** the user pastes an invite whose `s` is `wss://user:pass@team.example.com`
- **THEN** the link is refused as not a valid invite, and no connection is made

#### Scenario: A pasted link with surrounding whitespace is read

- **WHEN** the user pastes a valid invite link with a trailing newline
- **THEN** the link is read as that invite

### Requirement: Joining shows what the invite is for before the user commits

After the user pastes a valid link and asks to continue, spekterm SHALL inspect the invite (`invite.inspect`) and
show the team's name, whether the invite **joins a new member** or **adds this device to an existing member** (with
that member's handle and display name), and when the invite expires. Inspecting SHALL NOT redeem the invite.

Only for a new member's invite SHALL the user be asked for a handle and a display name. The handle's rule (1–32 of
`a`–`z`, `0`–`9` and `-`, starting with a letter or digit, lowercased, unchangeable later) SHALL be stated next to
its field. The device's name SHALL be asked for every invite, prefilled with the computer's host name.

The user SHALL then join with an explicit control. Joining SHALL use a connection of its own, which becomes the
device's connection on success. A refusal SHALL be shown in the user's language, by its code:

- `INVITE_UNKNOWN`, `INVITE_EXPIRED`, `INVITE_USED`: the invite cannot be used; a new one is needed from the team's
  admin;
- `HANDLE_TAKEN`: the handle is taken; the invite is still good and the user can choose another handle;
- `BAD_PARAMS`: the field the server names is invalid;
- `UNSUPPORTED_VERSION`: see "A version mismatch says which side is older".

A refused join SHALL leave no membership behind.

The other ways inspecting or joining can fail SHALL each be shown, and none SHALL be retried by spekterm on its own:

- **a lost join answer** (the connection ended after `join` was sent and before its answer): the invite may have
  been used and the credential is gone; spekterm SHALL say so, name the device's name for the admin, and SHALL NOT
  send `join` again (protocol §5);
- `INTERNAL`, a network or TLS error, or no answer in time: the attempt failed; the user can try again;
- **a pinned fingerprint that does not match on this first connection**: the invite does not match the server it
  names (a wrong or tampered link, or a server whose certificate changed since the invite was made); a new invite is
  needed. It SHALL NOT be described as the server's certificate having changed since joining.

#### Scenario: A device invite does not ask for a handle

- **WHEN** the user pastes a device invite for the member `sam` and continues
- **THEN** spekterm shows the team's name and that the invite adds this device to `sam`, and asks only for the
  device's name

#### Scenario: A member invite asks for a handle and a display name

- **WHEN** the user pastes a member invite and continues
- **THEN** spekterm shows the team's name and asks for a handle, a display name and the device's name

#### Scenario: A taken handle keeps the invite usable

- **WHEN** the user joins with a member invite and a handle another member has
- **THEN** spekterm says the handle is taken, keeps the form, and joining again with another handle succeeds

#### Scenario: A lost join answer is not retried

- **WHEN** the user joins and the connection drops after `join` was sent and before its answer
- **THEN** spekterm says the invite may have been used and names the device's name for the admin, holds no
  membership, and sends no second `join`

#### Scenario: An invite whose pin does not match its server

- **WHEN** the user pastes an invite whose fingerprint differs from the server's certificate and continues
- **THEN** spekterm says the invite does not match its server and a new one is needed, and sends no application
  data to that server

#### Scenario: Inspecting does not use up the invite

- **WHEN** the user inspects an invite and then closes Settings without joining
- **THEN** the same invite can still be joined with

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

### Requirement: Whether to reconnect follows the protocol's codes

While the feature is on and a credential is held, spekterm SHALL keep the connection open, authenticating with
`hello`, and SHALL reconnect after it ends, **with backoff** (the first retry within a few seconds, each later wait
longer, capped at five minutes, with jitter), except where the table below says to stop:

| Ended by | spekterm |
|---|---|
| close 1001, a drop with no close code (1006), a network error, a certificate that fails verification (unpinned), no connection within the deadline, no ping from the server in time | reconnects with backoff |
| close 4001 on the device's own connection | reconnects with backoff |
| close 4003 after `INTERNAL` | reconnects with backoff |
| close 4004 (revoked), or `AUTH_FAILED` before 4003 | **discards the credential and the membership**, stops |
| close 4006 (replaced by a newer connection of this device) | **stops**: another process or computer is using this credential |
| `UNSUPPORTED_VERSION` before 4003 | stops (see "A version mismatch says which side is older") |
| close 1003 or 1009, a frame over spekterm's own size bound, or `BAD_FRAME`, `NOT_AUTHENTICATED`, `UNKNOWN_OPERATION`, `BAD_PARAMS` before 4003 | stops: a fault in spekterm |
| a pinned certificate that does not match | stops |

**An error answered before authentication SHALL decide the outcome by itself**, whatever close follows it (4003,
or a drop within that second); a 4003 with no recorded error is treated as `INTERNAL`. An `AUTH_FAILED` answered to
an operation **after** authentication SHALL NOT discard the credential by itself: the revocation it reports is
followed by 4004, which decides.

A request with no answer within a bounded time SHALL end the connection, which then reconnects with backoff. A
connection that is not authenticated within a deadline (the TCP connection, the TLS handshake and the upgrade
together) SHALL be ended and retried with backoff. A connection whose server sends no ping within a bound longer
than the protocol's 30-second interval SHALL be treated as dropped. The backoff SHALL reset only after a connection
has stayed authenticated for a minute, so a connection that fails right after `hello` cannot reconnect in a tight
loop. When the computer resumes from sleep, the current connection SHALL be ended and a new one made at once.

**A connection spekterm has ended or given up on SHALL NOT affect the state afterwards**: spekterm SHALL end it at
once, without waiting for the closing handshake, and SHALL ignore every later event from it — its close above all,
which may arrive after a newer connection has authenticated and would otherwise start a third.

A stopped connection SHALL stay stopped until the user acts: **Reconnect** in the Team section (offered after 4006,
a version mismatch and a fault), a new invite (after a revocation or a changed certificate), or turning the feature
off and on. Reconnecting after 4006 SHALL be explicit because it takes the credential back from whatever else uses
it.

#### Scenario: A dropped connection is reconnected

- **WHEN** the device is connected and the server goes away without a close code, then comes back
- **THEN** the device connects again without the user doing anything

#### Scenario: A revoked device forgets its membership and stops

- **WHEN** the admin revokes this device while it is connected
- **THEN** spekterm discards the credential and the membership, makes no further connection, and the Team section
  says the device was removed from the team

#### Scenario: A device revoked while offline finds out at hello

- **WHEN** the device was revoked while spekterm was closed, and spekterm starts with the feature on
- **THEN** spekterm discards the credential and the membership after the `AUTH_FAILED` answer and makes no further
  connection

#### Scenario: A connection spekterm abandoned does not disturb the next one

- **WHEN** a request times out, spekterm ends that connection and a new one authenticates, and the old connection's
  close arrives afterwards
- **THEN** the device stays connected on the new connection, and no further `hello` is sent

#### Scenario: A failure right after hello does not reconnect in a tight loop

- **WHEN** the server accepts `hello` and the connection then drops at once, repeatedly
- **THEN** the waits between attempts grow as without a successful `hello`

#### Scenario: A replaced connection does not fight back

- **WHEN** another process authenticates with this device's credential and the server closes this connection with
  4006
- **THEN** spekterm makes no further connection by itself and offers Reconnect

### Requirement: A version mismatch says which side is older

spekterm SHALL offer the protocol versions it speaks in `invite.inspect`, `join` and `hello`. When the server
answers `UNSUPPORTED_VERSION`, spekterm SHALL state which side is older, from `detail.supported`: when the server
speaks only versions newer than spekterm's, that **spekterm** needs updating; when it speaks only older ones, that
**the server** needs upgrading, which is the admin's to do. It SHALL NOT retry until the user asks or spekterm's
version changes.

#### Scenario: A server that speaks only a newer version

- **WHEN** the server answers `UNSUPPORTED_VERSION` with `supported` listing only versions above spekterm's
- **THEN** spekterm says that spekterm is older than the server and needs updating, and does not retry by itself

### Requirement: A stop that needs the user is visible

When the connection stops for a reason only the user can resolve — the device was revoked, the connection was
replaced, the versions do not meet, the pinned certificate changed, or a fault in spekterm — spekterm SHALL:

- state the reason in the Team section, with what the user can do;
- mark the Team section in Settings' list of sections, so it is visible without opening that section;
- send **one** desktop notification for that stop (not one per attempt), whose activation opens Settings on the
  Team section.

After a stop for a changed certificate or a revocation, the Team section SHALL offer to paste a new invite. A device
invite joined while a membership with a changed certificate is held SHALL replace that membership and its secret,
and the section SHALL say the old device stays on the server's list until the admin revokes it.

A connection that is only retrying SHALL NOT notify; the Team section SHALL state that it is reconnecting and when
it tries next, so a failure and an idle wait can be told apart.

#### Scenario: A revocation notifies once

- **WHEN** the device is revoked while connected
- **THEN** one desktop notification says the device was removed from the team, and activating it shows the Team
  section

#### Scenario: Retrying does not notify

- **WHEN** the server is unreachable for several reconnect attempts
- **THEN** no desktop notification is sent, and the Team section states that spekterm is reconnecting and when it
  tries next

### Requirement: Settings holds the team controls and states the team's state

Settings SHALL contain a Team section. It SHALL state one of the following:

- that the feature is off;
- that it is on and the device is on no team, with the field to paste an invite link;
- that it is on and connected, connecting, reconnecting (with when it tries next), or stopped (with the reason);

and, while a membership is held: the team's name, the member's handle and display name, this device's name, the
server address, and the team's members by handle and display name, as last fetched.

The section SHALL state, next to the switch, that a team's server operator can read everything that passes through
the server (protocol §8).

#### Scenario: The section shows the server address

- **WHEN** the device has joined a team and the user shows the Team section
- **THEN** the section shows the server address from the invite, the team's name, the member and this device's
  name

#### Scenario: The section says the operator can read handoffs

- **WHEN** the user shows the Team section
- **THEN** it states that the team server's operator can read what passes through it

### Requirement: The device can be renamed

While connected, the user SHALL be able to change this device's name in the Team section (`device.rename`). The name
SHALL follow Settings' rule for a typed value (it applies on Enter or when the field is left). The name the server
returns SHALL be the one shown and kept. A refused name (`BAD_PARAMS`) SHALL be shown next to the field with the
stored name shown again. While not connected, the field SHALL say that renaming needs the connection.

#### Scenario: A renamed device keeps the server's name

- **WHEN** the user types a new device name and presses Enter while connected
- **THEN** the Team section shows the name the server answered with, also after a restart

### Requirement: Leaving says beforehand whether it removes the member

**Leave team** SHALL ask for confirmation, and the confirmation SHALL state, from the member's device count in a
members list fetched when the user asks to leave (not the count from the last `join` or `hello`, which can be
stale in the dangerous direction), which of the two will happen:

- this is the member's last device: **leaving removes the member from the team**, frees the handle, and handoffs
  addressed to them stop;
- the member has other devices: only this device leaves; the member stays on the team on the others.

On confirmation spekterm SHALL record that a leave is in progress (on disk) and send `device.leave`; once it is
answered it SHALL discard the credential and the membership. The close 4004 that follows SHALL NOT be shown as a
revocation. **While a leave is recorded as in progress, a 4004 or an `AUTH_FAILED` SHALL complete the leave**, also
after a lost answer or a restart, and SHALL NOT be shown as a revocation.

While not connected, Leave SHALL NOT pretend to leave. The section SHALL instead offer **Remove from this computer**,
stating that the server still lists this device until the admin revokes it.

#### Scenario: Leaving from the last device says the member is removed

- **WHEN** the member has one device and the user asks to leave
- **THEN** the confirmation says leaving removes them from the team

#### Scenario: Leaving from one of several devices says only the device leaves

- **WHEN** the member has two devices and the user asks to leave from one
- **THEN** the confirmation says only this device leaves

#### Scenario: A leave whose answer was lost completes quietly

- **WHEN** the user confirms leaving, the connection drops before the answer, and the reconnect's `hello` is answered
  `AUTH_FAILED`
- **THEN** the Team section shows the feature with no team, and no notification of a removal is sent

#### Scenario: A completed leave is not shown as a revocation

- **WHEN** the user confirms leaving and the server answers and closes with 4004
- **THEN** the Team section shows the feature with no team, and no notification of a removal is sent

### Requirement: The team's members are fetched on each connection and kept

After each successful `hello` or `join`, and when the user shows the Team section while connected, spekterm SHALL
fetch the team's members (`team.members`) and keep the list with the membership, so it is available while offline.
While connected it SHALL also be fetched every fifteen minutes. The list SHALL include the member itself,
marked as such where it is shown.

Every member's handle and display name SHALL be normalized as other third-party text is (`agent-intake`), before
they are kept or shown: a member chooses their own display name.

#### Scenario: The members are shown while offline

- **WHEN** the device fetched the members while connected, and spekterm then starts with the server unreachable
- **THEN** the Team section lists those members

### Requirement: Features follow the server's operations

spekterm SHALL use an operation after authentication only when the server's `operations` list from the last
`join` or `hello` answer names it, and SHALL hide or disable the control that needs it otherwise, saying the
server does not offer it.

#### Scenario: A server without rename

- **WHEN** the server's `operations` do not list `device.rename`
- **THEN** the device name field is not editable and says the server does not offer renaming

### Requirement: The membership survives restarts and a damaged file

The membership (the server address and pin, the team, the member, the device, the members list, whether the feature
is on) SHALL be kept in a file of its own in the user data directory, apart from the secret store, and SHALL be
written whole (to a temporary name, then renamed), **the file first, then the state in memory**. A membership file
that cannot be parsed SHALL be set aside under another name and spekterm SHALL start with no membership, saying so
in the Team section; it SHALL NOT keep using a secret whose membership is gone.

**The reverse SHALL be handled too**: a membership whose secret cannot be found (the secret store could not be read
this time, or was set aside as damaged, or the file was removed by hand) SHALL **stop without discarding anything**
(`CREDENTIAL_UNAVAILABLE`) — no connection, no `hello`, **no notice of a revocation** — because the secret may come
back (a read that failed once, a set-aside file the user restores). The Team section SHALL say the credential cannot
be found on this computer, name the device, and offer **Reconnect** (which reads the secret store again) and
**Remove from this computer** (with the admin revoking the device by its name and issuing a device invite).

Discarding (after a revocation or a completed leave) SHALL write the membership file first — the membership removed,
the stop reason and the device's name recorded — and remove the secret after, so an interruption can leave only a
secret with no membership, which is never sent and is removed at the next start.

#### Scenario: A membership without its secret is not taken for a revocation

- **WHEN** spekterm starts with a membership and no team secret in the secret store
- **THEN** it sends no `hello`, sends no notification of a removal, keeps the membership, and the Team section says
  the credential cannot be found on this computer, names the device, and offers Reconnect and Remove from this
  computer

#### Scenario: A damaged membership file is set aside

- **WHEN** spekterm starts and the membership file is not valid JSON
- **THEN** spekterm starts with no membership, the damaged file is kept under another name, and the Team section
  says the membership could not be read
