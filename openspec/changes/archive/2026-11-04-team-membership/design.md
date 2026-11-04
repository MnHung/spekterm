## Context

See proposal.md for why. What this change stands on:

- **The contract is `spekterm-server/docs/protocol.md`, version 1, draft** (spekterm-server 0.2.1 with `protocol-clarifications`; 0.2.0 was the version read while writing this). It is written so
  that a client can be built from it alone; this design cites its sections as "protocol §n". It may still change
  until a spekterm release ships a client for it. Where it is awkward or unsafe for the client, the fix is a change
  in spekterm-server, not a workaround here (the handoff that started this work says so).
- **spekterm already holds one secret-bearing outbound connection**: Slack (`slack-api.ts` with `fetch`,
  `slack-realtime.ts` with the global `WebSocket`). Its lessons (`docs/lessons/slack.md`) apply: errors are classed by
  what the user must do, not by cause; a retry wait is bounded; a skipped attempt the user asked for still reports;
  the four exits of a secret (IPC projection, child environment, diagnostics, network) are each guarded.
- **The secret store** (`secret-store.ts`): `Secret.reveal()` is the only way to the plaintext, and the modules that
  may call it are an allow-list (`scripts/secret-scope.test.mjs`). Writes go file first, then memory.
- **The network allow-list** (`scripts/network-surface.test.mjs`): network modules are allowed per file only; today
  `https` and `ws` only in `remote-server.ts`, which accepts connections and makes none.
- **Remote access already pins certificates in the other direction**: the desktop is the server and the phone pins
  its fingerprint (`remote-cert.ts`, `pairingLink`'s `fp` without colons). The team invite uses the same `fp` form.
- **Settings' save model** (`terminal-preferences`, "A change in Settings applies when it is made") and its section
  list with a failure marker (`SettingsDialog.tsx`, the remote marker).
- **The desktop notification backend** (`intake-notify-backend.ts`, with a probe stub) is how the app notifies; a
  notification must be held until it closes (`agent-intake`).

## Goals / Non-Goals

**Goals:**

- Join a team from an invite link, and hold a device credential that goes nowhere but its server.
- Keep one verified connection while the feature is on, reconnecting by the protocol's rules, and never fighting
  another holder of the same credential.
- Make every state that needs the user visible, and every other state distinguishable from "idle".
- Leave a member list and a connection that `teammate-handoff` can build on: an operation call, an event
  subscription, and a "credential discarded" signal.

**Non-Goals:**

- Sending and receiving handoffs (`teammate-handoff`). This change defines no handling of `handoff.incoming`; an
  event it does not know is ignored (protocol §3).
- Presence (server M3), the Sent list and statuses (M2), push notifications (not in server v1).
- More than one team at a time. The server serves one team (server PRD §13.1); spekterm holds one membership.
- Admin operations: the admin uses the server's command line (server PRD §13.1).
- Showing or doing anything about the team on a paired phone.
- An OS keyring for the secret. **Decided by the user (2026-11-03): the secret store's `0600` file**, the Slack
  tokens' posture; the spec records the gap, and the contract's wording changes upstream to match.

## Decisions

### D1. Five modules, and only one of them touches the network

| Module | Holds | Imports |
|---|---|---|
| `team-invite.ts` | parsing an invite link (pure) | — |
| `team-store.ts` | the membership file `<userData>/team.json` | `fs`, `path` |
| `team-connection.ts` | one TLS + WebSocket connection: pinning, frames, request ids, answers, events, close codes | **`tls`, `ws`** (file-scoped in the network allow-list) |
| `team-service.ts` | the lifecycle: on/off, reconnect and backoff, the state shown, join/inspect/rename/leave/members, the stop notification, the extension points for `teammate-handoff` | no network module |
| `ipc/team.ts` | the IPC handlers, the projection to the renderer | — |

`team-connection.ts` is also the only module of this change on the `reveal()` allow-list: the secret is revealed
where the `hello` frame is built, and nowhere else. The service passes it a `Secret`. **In the other direction**,
the `join` answer carries the secret in plaintext: `team-connection.ts` wraps `deviceSecret` in a `Secret` while
parsing that answer, before the answer object reaches any other code, and never logs a received frame. The
diagnostic exit is tested with a console spy and the error messages of a failing join (with a control that logs the
raw answer).

**Alternative rejected: the global `WebSocket`** (what Slack uses). It cannot pin: Node's WebSocket takes no TLS
options and no socket, and its non-standard `dispatcher` needs undici's `Agent`, which Node does not expose. The `ws`
package is already a dependency (the remote listener uses it) and accepts a socket we created (D2).

### D2. Verify first, then hand the socket to the WebSocket client

"Send nothing before the certificate is verified" (protocol §2) is enforced by structure: `team-connection.ts`
opens the TLS socket itself with `tls.connect`, waits for `secureConnect`, checks the certificate, and only then
constructs the `ws` client with a `createConnection` that returns that already-verified socket. The WebSocket
upgrade request cannot be written before the check, because the client that writes it does not exist yet.

- **Pinned** (`fp` present): `rejectUnauthorized: false`, then compare `getPeerX509Certificate().raw`'s SHA-256 with
  the pin. A mismatch destroys the socket and is a stop (`PIN_MISMATCH`).
- **Not pinned**: `rejectUnauthorized: true` with the host as `servername`, and **`ca` set to the runtime's bundled
  roots plus the operating system's** (`tls.getCACertificates('default')` and `('system')`). Without `ca`,
  `tls.connect` trusts only the bundled roots: measured in Electron 43.8.4's Node 24.22.1 by the reviewer, `default`
  and `bundled` hold 118 certificates and `system` 441, so a server certified by a company's own authority installed
  in the OS would fail. Node checks the chain and the host name.
  A failure is a retry with backoff, its reason shown (spec: an expired certificate on the server is the likeliest
  cause; a stop would leave every client down until each user clicks).
- SNI is sent with the host name when the host is not an IP address, in both modes.

**Why not `checkServerIdentity`**: Node calls it only after the chain verified; with a self-signed certificate the
chain fails first, so a pin implemented there never runs. **Why not check in `ws`'s `upgrade` event**: the upgrade
request was already sent by then.

**This rests on `ws` accepting an already-connected TLS socket from `createConnection`.** Measured during review
(Node 22.22.0, ws 8.22.0, a self-signed server recording every byte): a mismatched pin destroys the socket and the
server receives **0 bytes** of application data; a matching pin handed through `createConnection: () => socket`
opens the WebSocket (the server receives the 161-byte upgrade request) and frames flow both ways. Not yet run inside
Electron's main process; the unit test of task 3.2 is the standing carrier (it runs under the repo's Node, and
`probe:team` runs it in the real main process). "Nothing is sent" means no application data: the TLS handshake
itself (ClientHello with SNI, Finished) necessarily precedes the check.

### D3. The connection's states, and the table that decides between retrying and stopping

The service is one state machine, and its state is what the renderer shows:

`off` → (on, no membership) `unjoined` → (join) `connecting` → `connected` → (drop) `reconnecting{nextAt, reason}` →
`connecting` …, and `stopped{reason}` reached from the table in the spec. Every input — a close code, an error answer
before 4003, a TLS or network error, a request timeout — maps to exactly one outcome through **one exhaustive
`switch`** with no `default` (the repo's `rejection-exhaustive` discipline: a `default` would turn a new code into a
silent retry or a silent stop).

- **Error answer before 4003**: the protocol closes one second after any pre-auth error (checked in spekterm-server
  0.2.0's `src/connection.ts`: `#answerError` refuses while pending, and the refusal closes 4003 after
  `refuseDelayMs`; the 10 s authentication timer closes 4001 and is not extended by `invite.inspect`). The service records the
  code from the answer and decides on the close, so a 4003 is read against the error that caused it (protocol §4's
  table). A 4003 with no recorded error is treated as `INTERNAL`.
- **The recorded pre-auth error decides by itself** — not the close that follows it. If spekterm ends the
  connection first, or it drops (1006) within the server's one second, the recorded error still decides. `BAD_PARAMS`
  before authentication is a fault (spekterm sent a malformed `protocol`), not a retry.
- **After authentication**, `AUTH_FAILED` can be answered to `device.rename` or `device.leave` of a device revoked a
  moment ago (server `team.ts`); the protocol does not list it there. It does not discard: 4004 follows within 10 s
  and decides. (spekterm-server's `protocol-clarifications` states this in §5: the server answers `AUTH_FAILED`
  and closes with 4004 at once.)
- **4001 on our own connection** means `hello` did not finish in 10 s — a slow network or a stall: retry. 4001 on an
  inspect connection is expected (D5) and ignored.
- **Connection generations.** Every connection gets a generation number; the service acts only on events of the
  current generation. When spekterm gives up on a connection (timeout, Reconnect, resume, off) it calls
  `terminate()`, not `close()`: `ws`'s `close()` waits up to 30 s for the peer's close frame (`CLOSE_TIMEOUT`), and a
  close that arrives after a newer connection authenticated would read as a 1006, reconnect, authenticate a third
  time and make the server close the current one with 4006 — a stop the user has to clear, caused by spekterm itself.
- **Backoff**: 1 s, ×2, capped at 5 min, ±20% jitter, **reset only after a connection stayed authenticated for 60
  s**. Resetting on `hello` alone turns "fails right after hello" into a reconnect every second.
- **Deadlines and liveness**: 20 s for TCP + TLS + upgrade + `hello` together (Node's `tls.connect` has no handshake
  timeout of its own, and an address that accepts TCP and says nothing would leave the state at `connecting`
  forever); 15 s for any request's answer; and a watchdog on the server's pings — none for 75 s (two and a half
  intervals) means the connection is gone, which catches a half-open socket after sleep or a network change. Each
  ends the connection with `terminate()` and goes to backoff.
- **Resume**: `powerMonitor`'s `resume` terminates the current connection, if any, and connects at once — a
  connected state before sleep is not evidence of a live socket after it.
- **Frame size**: the client never builds a frame over 256 KiB (protocol §2; it would be closed 1009, a stop). It
  bounds what it accepts at 1 MiB (`maxPayload`). **`ws` reports exceeding that bound as a 1006 close** (measured
  during review: `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`, close code 1006), which the table would read as "retry"; the
  service therefore records the `ws` error code and classifies it as a fault (a stop), before the close.

**Why 4006 stops even though the protocol's wording ("another process or machine") makes it sound rare**: the
likeliest cause is the user's own second spekterm with the same profile copied (a restored backup, `npm run dev`
against the packaged profile — dev uses its own userData on Linux only). Two clients reconnecting on 4006 replace
each other forever. Reconnect is offered and is explicit.

### D4. The membership file and the secret, and the order they are written in

`<userData>/team.json` (`team-store.ts`), versioned like the other stores, whole-file writes (temporary name, then
rename), file first, then memory (`settings-sections`' rule; the remote store's known violation, issue #88, is not
copied):

```
{ version: 1, enabled, server: { address, fingerprint? }, team: { name }, member: { id, handle, displayName,
  deviceCount }, device: { id, name }, operations: [..], members: { list: [{ id, handle, displayName, deviceCount }],
  fetchedAt },
  stop?: { reason, appVersion, notified, deviceName }, leaving?: true }
```

`stop` keeps a stop across restarts (D9's "until spekterm's version changes" needs the version that stopped; D10's
"not notified again" needs `notified`). `leaving` is D6's leave in progress.

The secret is `team.deviceSecret` in the secret store. `deviceId` is in `team.json`: it is an identifier, useless
without the secret, and the Team section and a "needs the admin" message name the device by its name, not its id.

**Join's write order**: the `join` answer carries the credential once. The service writes the secret, then
`team.json`; only then is the join shown as done. A failure of either write: whatever was written is removed, and
spekterm sends `device.leave` on the connection the join just authenticated, so the server keeps no orphan device;
the user sees "the join could not be completed — a new invite is needed" (and the device's name for the admin only
if that leave is not answered).

**A membership whose secret cannot be found** — `SecretStore.load()` failed to read the file (it then starts empty
and does **not** set the file aside: EACCES, EIO), or set it aside as unparseable, or the user deleted
`secrets.json` — is checked at startup and before every connection. It becomes the stop `CREDENTIAL_UNAVAILABLE`,
**keeping the membership**: the secret may come back, and discarding would cost a device invite for a read that
failed once. No `hello` is sent: a `hello` without a secret is answered `AUTH_FAILED` (server `team.ts`), which the
table reads as a revocation and would tell the user they were removed from a team they are still on. Reconnect reads
the secret store again; Remove from this computer discards.

**Discard order**: `team.json` first (membership removed; `stop` recorded with the reason and the device's name, so
the section can still name the device for the admin), then the secret, then `onCredentialDiscarded`. An interruption
leaves at worst a secret with no membership: it has no address, so it is never sent, and startup removes it. (The
opposite order would leave a membership without its secret, which would then read as `CREDENTIAL_UNAVAILABLE`
instead of the revocation that happened.) A `leaving: true` membership found without its secret completes the leave
quietly.

**Discarding** (4004, `AUTH_FAILED`, a completed leave, Remove from this computer): the secret first, then the
membership, then the `onCredentialDiscarded` extension point (`teammate-handoff` removes handoffs it stored but
never had acknowledged, protocol §11 rule 6). The feature stays on with no team, so the section shows the paste
field and the reason.

**Only the join writes `server`**: `TeamStore.setMembership` is called only from `team-service.ts`'s join path,
and that path only from `ipc/team.ts`'s join handler — two pins in `scripts/secret-scope.test.mjs`, like Slack's
endpoint writer. (The service writes, because the credential arrives in the join's answer; the IPC handler is what
binds it to the user's action.) A damaged file is quarantined (renamed aside) and the
secret is then discarded too: a secret whose address is unknown can never be sent safely.

### D5. Inspecting and joining are two connections

Typing a handle takes longer than the 10-second authentication window (protocol §5, `invite.inspect`), so:

1. **Continue** opens a connection, sends `invite.inspect`, shows the answer, and ends it with `terminate()` (D3). The answer
   is kept in memory for the form; nothing is written.
2. **Join** opens a new connection and sends `join`. On success that connection is authenticated as the new device
   and becomes the device's connection: there is no separate `hello`.

An inspect error before 4003 is shown and ends that attempt; the user can correct the input and continue again
(`HANDLE_TAKEN` and `BAD_PARAMS` keep the form; the `INVITE_*` codes clear it). **A lost join answer** (the
connection drops after `join` was sent) is shown as the protocol says: the invite may have been used and the secret
is gone; ask the admin. spekterm does not retry a join by itself: a second `join` with the same code after a
success would be `INVITE_USED` and hide what happened.

The pin from the link is applied to both connections: the inspect connection verifies the same way the device's
connection will.

### D6. Leave needs the connection; forgetting does not pretend

`device.leave` is an operation, so it needs an authenticated connection. The confirmation's sentence comes from the
member's `deviceCount` in a `team.members` fetched when the user presses Leave (spekterm-server's
`protocol-clarifications` adds `deviceCount` to each member there): `1` ⇒ "removes you from the team", more ⇒
"only this device". A `memberRemoved` in the answer that disagrees with what was said is shown after the fact (the
count may have changed since the last `hello`); it is not prevented, since the user asked to leave either way.

Before sending `device.leave`, the service writes `leaving: true`. While it is set, a 4004 or an `AUTH_FAILED` —
after a lost answer, a timeout or a restart — completes the leave quietly instead of reading as a revocation.

**Why not the `hello` count**: it can be stale in the dangerous direction — the user is told "only this device" and
the member is removed, because their other device left since the last `hello`. Fetching at the moment of the
question narrows that to the seconds before the confirmation.

Offline, the section offers **Remove from this computer**: discard locally, say that the server still lists the
device until the admin revokes it (and, when it was the member's last device, that the member stays on the team and
handoffs to them are held until they expire). An offline device is never offered handoffs (protocol §11: only
connections are), so a forgotten device holds nothing.

### D7. Members: fetched, normalized, kept

`team.members` after every successful `join`/`hello`, when the Team section is shown while connected, and every 15
minutes while connected. Handles and display names pass through `normalizeAuthored` before they are stored or shown
(a member writes their own display name; the protocol forbids control characters but the client does not rely on
the server's checks for what it renders). The list is kept in `team.json` with `fetchedAt`, so `teammate-handoff`
can list teammates to an agent while offline, and the Team section shows when it was fetched.

### D8. What the renderer gets

`ipc/team.ts` sends a projection built **field by field** (the settings-projection discipline): the state, the
reason code of a stop or retry and `nextAt`, the team name, the member (handle, display name, device count), the
device name, the server address and whether it is pinned, the members list with `fetchedAt`, and which operations
are offered. No `deviceId`, no secret. The preload's type for it is narrowed to exactly that shape, so the renderer
cannot be written to read a field that is never sent (`docs/lessons/slack.md` §10). State changes are pushed; the
renderer never polls.

### D9. Version

spekterm offers `protocol: [1]`. `UNSUPPORTED_VERSION` with `detail.supported`: all above 1 ⇒ "spekterm is older";
all below ⇒ "the server is older"; anything else (empty, missing) ⇒ shown as a mismatch without a side. The stop
lasts until Reconnect or until spekterm's version differs from the one that stopped (kept with the stop reason).

### D10. One notification per stop

The stop reasons that need the user (spec) send one desktop notification, held until it closes, through **its own
notification backend instance** (a backend has one activation handler — `update-notify.ts` documents this — and the
inbox's opens the inbox), with a probe stub as the update notifier has, and its own IPC channel to open Settings on
Team (as `workspace:update:showAbout` does). The notification is with with a fixed text from the dictionary and the team's name — the team name is server-supplied text, so
it is normalized and reduced like any third-party field before it reaches a notification (`agent-intake`'s
reduction rule). Activating it opens Settings on the Team section (closing the inbox first, per
`terminal-preferences`). It is sent when the state enters `stopped`, not on each attempt, and not at startup for a
stop that was already shown in an earlier run (the stop reason is kept in `team.json`).

### D11. Acceptance

- **Unit tests** cover the parsing, the store, the outcome table (one case per row, plus "every code is handled"),
  the backoff, the write orders, and `team-connection.ts` against a throwaway local TLS + `ws` server (test files
  may create servers; `server-source.test.mjs` excludes them).
- **`probe:team`** runs the real app against `scripts/lib/stub-team-server.mjs`: a real TLS WebSocket server with a
  self-signed certificate (so the pin path is the one exercised; the unpinned path is covered by unit tests run in a
  child process started with `NODE_EXTRA_CA_CERTS` — the variable is read once at process start, and its
  certificates are part of `getCACertificates('default')`, which the `ca` list includes), whose
  answers and closes the probe scripts. It carries the Settings flows, the reconnect, 4004/4006, the version
  mismatch, and the "nothing reaches the renderer" check.
- **The stub can drift from the real server.** A dogfood task runs spekterm against a local spekterm-server 0.2.1
  (`docs/self-hosting.md` §2b) through join, rename, revoke and leave. The probe does not start the real server: it
  would make this repo's acceptance depend on another repository's checkout and Node version.

## Risks / Trade-offs

- **The secret is readable by any process of the user** → recorded as a gap in the spec; the same posture as Slack.
  An agent can read `secrets.json`; spekterm only guarantees it never hands the secret to one.
- **The secret's storage conflicts with the contract** → protocol §5 (`join`) says to store the credential "in the
  platform's protected storage, never in a file an agent can read", and server PRD §7.4 says it "never reaches a
  terminal or an agent". A `0600` `secrets.json` is readable by any process of the user, an agent with a shell
  included — and with `teammate-handoff`, agents are driven by a teammate's text, so a read would put the secret into
  a transcript under `~/.claude/projects`. **Decided by the user (2026-11-03): keep the secret store's file**; spekterm-server changes protocol §5 and PRD §7.4
  to "spekterm never hands it to an agent; processes of the same user can read it".
- **The protocol is a draft** → this client is the first; anything awkward goes back to spekterm-server before a
  spekterm release ships it. Sent to spekterm-server's session when this change was written, and being changed
  there in `protocol-clarifications` (2026-11-03, server 0.2.1): ids are 1–64 of `[A-Za-z0-9_-]`, case-sensitive,
  not starting with `-`; `member.deviceCount` in `hello` is defined as the count at authentication; a revoked device
  is closed with 4004 and offered nothing more; `AUTH_FAILED` after
  authentication is followed at once by 4004; `team.members` carries `deviceCount`; PRD §7.5 accepts only `wss`.
  **This change depends on that one** for `deviceCount` in `team.members` (D6); if it lands differently, D6 changes.
  The secret-storage wording is left to the user's decision above.
- **A stuck `reconnecting`** looks like a working feature with nothing to do → the Team section always states the
  state and the next attempt; only stops notify.
- **4006 between two copies of a profile** stops both sides until the user picks one → deliberate (D3); the message
  says another spekterm is using this device's credential.
- **The membership file names a server**, and a damaged one discards the secret (D4) → the user needs a new device
  invite after a corrupted file. Accepted: sending a secret to an address we could not read back is worse.

## Migration Plan

New files only; nothing existing is migrated. The feature is off by default, so an upgrade changes nothing until the
user turns it on. Rollback: an older spekterm ignores `team.json` and the `team.deviceSecret` entry (the secret
store keeps unknown names).

## Open Questions

- Whether the Team section should also show a short history of stops. Not needed for M1; the current reason is
  shown.
