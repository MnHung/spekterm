## Context

Remote access (`mobile-remote-bridge`) is a TLS WebSocket listener in `src/main/remote-server.ts`
(`https.createServer` + `ws` at `/v1`, self-signed P-256 leaf that the phone pins, `hello` / `pair` inside the
WebSocket, `AddressThrottle` per remote address, 16 + 16 connection caps, 20 s pings, 1 MiB frames, deflate on). It
accepts connections and makes none. The team connection (`team-membership`) lives in `src/main/team-connection.ts`:
it opens TLS itself, verifies the server's pin (or the trust store) on `secureConnect`, and only then builds the `ws`
client over that socket. `scripts/network-surface.test.mjs` allows `https` + `ws` only in `remote-server.ts` and
`tls` + `ws` only in `team-connection.ts`; `scripts/server-source.test.mjs` allows only `remote-server.ts` to create a
server.

spekterm-server 0.4.0 relays a phone to its member's desktop (`spekterm-server/docs/protocol.md` §5 `relay.grant` /
`relay.grants` / `relay.revoke` / `relay.refuse`, §10 `relay.incoming`, §13 the `/relay` endpoint; its design D9 is
the desktop's work list). The phone opens `/relay` with `relay.open {grant, secret}`; the server tells the desktop
with `relay.incoming {tunnel, grant, expiresAt}` on `/connect`; the desktop opens its own `/relay` and sends
`relay.accept {deviceId, deviceSecret, tunnel}`; the server splices the two and passes binary messages unchanged. The
bytes are the phone's TLS to the desktop's listener, pinned to the desktop's certificate. Messages over 256 KiB end
the tunnel; the server holds at most 64 KiB per leg in front of the pings.

The user's decision (2026-11-06, not to be reopened): direct stays the default; the relay is an optional second path
for a desktop on a team; no push.

## Goals / Non-Goals

**Goals:**

- A paired phone away from the desktop's network reaches the listener through the team server, with the listener's
  TLS, authentication, limits and pings unchanged.
- The phone gets everything it needs (server address, pin, grant id, secret) over its authenticated connection, and
  loses it when it should.
- Nothing is sent to the team server before its certificate is checked; the desktop dials only its own server.
- No new network module or import; the guards stay as they are.

**Non-Goals:**

- Push; reaching the desktop while spekterm is closed.
- Pairing through the relay (server design D11).
- A relay-only desktop that does not listen on a port.
- Remote access across people.

## Decisions

### D1. The setting lives on the membership, and is shown where it can be used

The setting is `relay: true` on the stored membership (`team.json`), written only through `TeamStore.updateMembership`
(its patch type gains `relay`, never `server`). Absent = off. It dies with the membership: leaving the team or a
revocation drops it, and a new join starts off.

The control sits in Settings → Team below the device name. It is shown when the membership's `operations` (from the
last `join` / `hello`) list `relay.grant` **and** remote access is on — and always while the setting is on, so it can
be turned off when the server or remote access later stops offering it. Shown but unusable (setting on, remote access
off or the server no longer lists the relay), it says why under the switch. The handoff asked for "only while the team
connection is up"; tying it to the stored `operations` instead keeps the switch from flickering on every reconnect,
and nothing it controls needs the connection at the moment it is flipped (D3 catches up at the next `hello`).

Under the switch, while on: how many paired phones hold a grant ("2 of 3 phones"), and a line for a refusal that needs
the user (`TOO_MANY_GRANTS`: the server's 16-grant limit).

The Team view is projected in `team-projection.ts` and today pushed only on `TeamService` changes. The relay fields
depend on remote access (on / off), the paired devices and the grants as well, so `RelayService` emits a change on
each of those and the Team view is pushed again on it.

With the Team feature turned off (`enabled: false`), no `/connect` connection exists, so no tunnel can be offered:
phones are told they have no grant (`relayFor` answers nothing), and nothing is revoked; turning the feature on again
gives them back. **Every open leg is terminated** when the feature is turned off, and its relayed connection with it:
`team-membership` says that with the feature off spekterm sends nothing to a team server, and the server would not
end those legs itself (it does only when the device is revoked, leaves, or its member is removed; server §13.5). A
team connection that merely drops or reconnects leaves open legs alone (server §13.5: a tunnel does not end with the
desktop's `/connect`).

### D2. Grants are one secret entry, bound to the membership

`relay-grants.ts` (Electron-free) keeps the grants in the secret store under one name, `team.relay` (the name
charset rules out a name per phone: remote device ids are base64url), as JSON:

```
{ "v": 1, "server": "<membership server address>", "device": "<team device id>",
  "grants": [ { "phone": "<remote device id>", "id": "<grant id>", "secret": "<grant secret>",
               "name": "<grant name>", "state": "active" | "revoke" } ] }
```

- **Bound**: a blob whose `server` or `device` differs from the current membership (or with no membership) is
  discarded at load and whenever the membership changes — its grants were deleted with the old device (server §13.1).
- **`state: "revoke"`**: a grant the desktop no longer wants (phone unpaired, setting off, remote access reset) but has
  not yet seen revoked. It is never given to a phone; it is revoked at the next reconcile and then removed.
- **Written before told**: a new grant is written to the store, then the phone is told; a grant marked `revoke` is
  written, then the phone is told `null`. A write that throws leaves memory as it was (`SecretStore.#commit`), and the
  phone is not told.
- **Reveal**: `relay-grants.ts` joins `scripts/secret-scope.test.mjs`'s reveal allow-list, and it is the only module
  that holds a grant secret in plain text. It reveals the stored blob once at load, keeps the parsed records in a
  module-private field (never returned, never logged; the class's `toString` / `toJSON` / `inspect` are redacted), and
  reads plain secrets in exactly two places: the serializer that rewrites the blob on every change (it needs every
  grant's secret, not only the changed one), and `relayFor(phoneId)`, which builds the phone's `relay` value. A new
  grant's secret arrives from the answer as a plain string, inside `relay-service.ts`'s handling of the
  `relay.grant` answer, and is passed straight to `add`. **Wrapping the stored secrets in `Secret` and serializing
  them with `JSON.stringify` would write `"[redacted]"` to disk** (`Secret.toJSON`): after a restart the phone would
  be given `[redacted]`, be refused `GRANT_INVALID`, and the reconcile would see the same id on both sides and never
  replace it. A round-trip test (write, load a new instance from the same file, compare the secret) pins it. The device
  secret for `relay.accept` is revealed in `team-connection.ts`, already on the list.

### D3. One reconcile, serialized, after every `hello` and on every change

`RelayService.reconcile()` runs on one queue. Triggers: the team connection reaching `connected` (after `hello`), the
setting changing, the paired device list changing (pair, revoke, reset), remote access turning on, and a
`relay.grant`-capable `operations` appearing. Local consequences (marking `revoke`, telling phones `null`) happen at
once, even when not connected; the requests wait for a connection whose `operations` list the relay.

**Wanted phones** = the paired phones while the setting is on, else none. Remote access being off does not change who
is wanted; it only stops new grants from being requested (step 6) and tunnels from being accepted (D5).

With a connection:

1. `relay.grants` → the server's ids.
2. A local grant the server does not have → removed (the server lost it: restored backup, admin); its phone told `null`.
3. A server grant not held locally → `relay.revoke` (an answer lost after `relay.grant`, or a grant from before a
   damaged store).
4. Local `revoke` grants → `relay.revoke`, removed on any ok answer (`revoked: false` included).
5. An `active` grant whose phone is not wanted → marked `revoke`, phone told `null`, revoked as in 4.
6. Only while remote access is on: a wanted phone without an `active` grant → `relay.grant { name }` (the phone's
   name, clipped to 64 code points; on `BAD_PARAMS` once more with `"phone"`), written, then the phone told.
   `TOO_MANY_GRANTS` stops creating for this round and is shown (D1).

**After every awaited answer the round re-reads the world** before acting on it: the membership binding (same server
and device id), the setting and the wanted phones. A `relay.grant` answer that arrives after the setting was turned
off, the phone was unpaired or remote access was reset is written as `revoke` (never told to the phone) and revoked in
the same round; one that arrives under a different membership is dropped (that server deleted it with the old
device). The next round sees whatever changed meanwhile, because every change enqueues one.

A request that fails because the connection ended stops the round; the next `hello` runs it again. An `AUTH_FAILED`
answer is left to the team connection, which discards the membership on its own path (and with it, by D2, the
grants). **A discarded membership tells every connected phone `null`** at once (`relayChanged` for each phone that
held an active grant), rather than leaving them to find out at their next `hello` or from `GRANT_INVALID`.

**Remote access turned off** does not revoke: the phones stay paired, and with it off nobody can reach the listener;
tunnels are refused (D5). **Reset** revokes every device (`remote-access`), so every grant goes through 5.

### D4. The phone's `relay` value: the `hello` answer and `relay.changed`

`docs/remote-protocol.md` gains, additively (already given to spekterm-android on 2026-11-06):

- The `hello` answer's optional `relay`: `{ "url": string, "fp"?: string, "grant": string, "secret": string }`. `url`
  is the membership's server address exactly as stored (the invite's `s`: `wss://host[:port]`, no path); the phone
  appends `/relay`. `fp` is the membership's pin when it has one (64 upper-case hex). Present only when this phone has
  an `active` grant and the setting is on. **Absent = the phone discards any stored grant.** The `pair` answer never
  carries it: the grant is requested after pairing, and arrives by the event.
- `relay.changed`: `{ "relay": Relay | null }`, the complete current value, sent only to **that device's**
  authenticated connections when its value changes. The baseline is **per connection**: set to the value put in that
  connection's `hello` answer at the moment the answer is sent (a pairing connection's baseline is "none"), and
  updated with each `relay.changed` it is sent; a change is sent to a connection only when the new value differs from
  that connection's baseline, with absent and `null` normalized to the same "none". `null` = discard.
- **Ready before the listener**: the grants are loaded and `RelayService` built before remote access starts
  listening, so the first `hello` after a start already carries the phone's grant; a `hello` answered without it would
  make the phone discard its grant.
- Not an operation, so not in `operations`; the phone keys on the field.

`RemoteServer` gets an `authExtras(deviceId)` option that only the `hello` answer spreads; `RemoteService` gets
`relayChanged(deviceId)`, which sends the event to that device's connections whose baseline differs.

### D5. Accepting or refusing `relay.incoming`

`TeamService` already dispatches events of the current generation by kind; `RelayService` listens to
`relay.incoming`. The data is validated (`tunnel`, `grant` ids per server §5; else ignored). It is **refused** with
`relay.refuse { tunnel }` when any of these holds, checked in this order:

1. the setting is off, remote access is off, or the listener is not listening;
2. the grant is not an `active` grant held locally, or its phone is no longer paired;
3. the grant is throttled (`relay:<grant>` blocked in the listener's throttle, D7);
4. the server answered `RELAY_DISABLED` on a leg since the last `hello` (server §13.6).

`expiresAt` is the server's clock and is not compared with the desktop's: a desktop clock ten seconds fast would
refuse every tunnel, silently. A late accept is answered `TUNNEL_UNKNOWN`, and the leg's own 10 s deadline (D6),
counted locally from the event's arrival, bounds the wait.

Otherwise it opens the desktop leg (D6). A refusal's answer is not waited for; a refusal that cannot be sent (the
connection ended) is dropped — the server answers the phone `DESKTOP_UNAVAILABLE` after 10 s anyway.

### D6. The desktop leg, in `team-connection.ts`

`openRelayLeg({ server, fingerprint, deviceId, secret, tunnel, onEnd })` in `team-connection.ts`:

- **Where**: `server` and `fingerprint` come from the stored membership when the event is handled — never from the
  event, which carries no address. `RelayService` reads them; the function cannot take them from anything else.
- **Verify, then hand the socket to `ws`**: the same `openVerified` as `/connect` (pin, or trust store and host name),
  then `new WebSocket(<server>/relay, { createConnection: () => socket, perMessageDeflate: false, maxPayload: 256 KiB,
  followRedirects: false })`.
- **One request**: on `open`, one text frame `relay.accept { protocol: [1], deviceId, deviceSecret, tunnel }`; nothing
  else is sent until its answer. A binary frame before the answer, or no answer within 10 s of the leg starting, ends
  the leg (`terminate()`).
- **After an ok answer**: the `message` listener used for the answer is removed, then
  `createWebSocketStream(ws)` wraps the socket, and its `_write` is wrapped so **each write is cut into messages of at
  most 64 KiB**, sent in order, the callback called after the last piece. `createWebSocketStream` sends one message per
  `_write`, and the listener's TLS hands down a whole application write as one chunk; without the cut, a 1 MiB
  snapshot is one message and the server ends the tunnel with 1009. (Measured for this design in a scratch spike: with
  the cut, a 900 KiB message each way crossed a 256 KiB-limited splice with the largest relayed message 65,536 bytes;
  without it, the splice closed with 1009.) Wrapping `_write` keeps the module free of a `stream` import, which
  `network-surface` does not allow.
- **Ending is `terminate()`**: `createWebSocketStream`'s `_final` (run on `end()`, which the listener's TLS socket
  calls when it closes) calls `ws.close()` and calls back only when the peer's close frame arrives — up to 30 s when
  the peer is not reading (measured by the review: 30,007 ms against a paused stand-in; 5 ms against a responsive one,
  with the closing handshake already done). `_final`, like `_write`, is set per instance, so it is wrapped the same
  way: `ws.terminate()`, then the callback. Its `_destroy` terminates the WebSocket unless the WebSocket already
  errored (`terminateOnDestroy` starts true), so a destroyed stream ends the leg at once already; the leg also
  terminates on the WebSocket's `error` and destroys the stream when the WebSocket closes. The leg reports its end
  once (`onEnd` with the close code or the error answer's code). The test for this uses a stand-in relay that stops
  reading: against a responsive one, `close()` passes too.
- **Types without imports**: the stream is typed as `ReturnType<typeof createWebSocketStream>` (or the
  `import('node:stream').Duplex` type query), never `import type … from 'node:stream'` — the network-surface scanner
  counts a type-only import as an import (measured by the review). No comment in a new module may spell
  `createServer` or `.listen(`: `scripts/server-source.test.mjs` matches text, comments included.
- **Answers** (server §13.6): `AUTH_FAILED` → nothing on the leg (the `/connect` path is told within 10 s and discards
  the membership there, one owner of discarding); `RELAY_DISABLED` → `RelayService` refuses until the next `hello` whose
  `operations` list the relay; `TUNNEL_UNKNOWN`, `INTERNAL`, closes 4010 / 1001 → nothing; the client-bug codes →
  logged, nothing retried. Only codes are logged, never a frame (an accept carries the device secret).

### D7. Handing the stream to the listener: one non-listening server per tunnel

`RemoteServer.acceptRelayed(stream, grantId, phoneId)` creates, **in `remote-server.ts`**, an `https.Server` with the
listener's key, certificate and TLS minimum version, which never listens, and emits the stream on it as a
`connection`. Its `upgrade` requests go to a second `WebSocketServer` created with the listener (`noServer: true`,
the same `maxPayload` and deflate), through `handleUpgrade`; a path other than `/v1` is refused as `ws` refuses it on
the listening server (400), and a plain request is answered 404. Both servers' connections go to the same `#accept(ws, source)`, where `source` is
`{ kind: 'direct', address }` or `{ kind: 'relay', grant, phone }`. The listening server's own path is unchanged.

Why a server per tunnel: the listener needs to know which grant a relayed connection came through (D8), and a relayed
`TLSSocket` exposes neither an address (`remoteAddress` is `undefined`, measured) nor its source stream except through
Node's internal fields. A closure on a per-tunnel server knows the grant by construction. The cost is one
`https.Server` object per open tunnel (the team server allows four per desktop); it is closed with the tunnel.
`remote-server.ts` stays the only module that creates a server and imports `https`; no new import anywhere.

**A server that never listens enforces none of the HTTP timeouts.** Node starts tracking connections for
`headersTimeout` / `requestTimeout` only on `listening`, and `closeAllConnections()` acts only on a listening server
(measured by the review: a relayed connection that finished TLS and sent nothing was still open after 6 s with a 1 s
`headersTimeout`; the same code after `listen(0)` closed it at 1.2 s). The TLS handshake timeout does apply. So
`acceptRelayed` keeps its own books, until the connection reaches `#accept` (where the auth deadline, pings and caps
take over):

- every handed-over stream joins a set of pending relayed streams, with a deadline of `authTimeoutMs` (10 s); at the
  deadline the stream is destroyed and the grant's throttle counts a failure. (This is stricter than a direct
  connection, whose silence before the upgrade ends at `headersTimeout` uncounted; through a grant, every attempt is
  one the server already rate-limits, and a dial that never upgrades is worth counting.)
- `#accept` removes it from the set and clears the deadline;
- a stream that closes before its deadline (a phone dropping during the TLS handshake, the leg ending) is removed and
  its deadline cleared, **without** counting a failure;
- the per-tunnel server is closed when its stream closes, whatever the stage;
- `#stop` destroys every pending relayed stream and closes the per-tunnel servers, besides closing the accepted
  connections as today;
- `acceptRelayed` refuses (destroys the stream) when `#server` is `null` — not when `state()` is off: `#stop` clears
  `#server` first and the state only after awaiting, and a stream accepted in between would outlive the stop.

### D8. A relayed connection: `hello` only, throttled per grant

- **Throttle key** `relay:<grant id>` instead of the address; the existing `AddressThrottle` is used unchanged (it is
  keyed by string). Ten refusals through one grant in 60 s block that grant for 60 s; other grants and direct
  addresses are unaffected. A blocked grant is refused before dialing (D5 step 3), and a connection that still
  arrives through it is answered `THROTTLED` / 4030 as a direct one would be.
- **`pair` refused**: on a relayed connection `pair` is answered `PAIRING_FAILED` and refused like a wrong code (it
  counts toward the grant's throttle), without consuming or even reading the open pairing code. An open pairing code
  is therefore reachable only from the desktop's own network, as today.
- **Bound to the grant's phone**: a relayed `hello` must present the credential of the phone the grant was made for;
  another paired device's valid credential through that grant is answered `AUTH_FAILED` and counts toward the grant's
  throttle. A grant then reaches one phone's credential at most, so a leaked grant together with another phone's
  credential is not enough. **The phone is fixed when the tunnel is accepted** (D5 step 2 checked then that the grant
  is active and its phone paired) and travels in the connection's source; `#accept` compares with it and never asks
  the grants' current state. Asking at `hello` time would answer `AUTH_FAILED` to the right phone whenever the user
  turned the setting or the Team feature off during the tunnel's handshake — and the Android app treats `AUTH_FAILED`
  as "unpaired" and drops its credential. A tunnel accepted just before such a change is ended by the change
  (turning the Team feature off ends legs; turning the setting off revokes the grant, and the server ends its tunnel
  with 4004 / 4010).
- **Same answer otherwise**: the `hello` answer is the same as a direct one's (`protocol`, `server`, `addresses`,
  `operations`, `relay`); the connection counts toward the same caps and gets the same pings.

### D9. Inner keepalive on a slow link

The listener pings every 20 s and terminates a connection whose pong is more than about 40 s late (`#ping`: two
missed). What sits in front of a ping is everything the desktop has written to that connection and the link has not
yet carried: the server's window (at most 64 KiB per direction: 6.4 s at 10 KiB/s), the kernel's socket buffers on
each hop (up to megabytes), and — the unbounded part — the desktop's own buffers: the listener sends every terminal
chunk at once and never looks at `bufferedAmount`, so when a session produces output faster than the link carries it,
the backlog grows without limit (at 16 KiB/s, 640 KiB of backlog is 40 s; one incompressible 1 MiB snapshot is 64 s).

**This is the listener's existing behaviour on any slow link**, direct ones included; the relay adds the server's
window and its cap (default 512 KiB/s). So the threshold depends on whether the desktop's output rate exceeds the
link's, not on the relay. This change does not alter the keepalive or add backpressure; it measures (task 6.3, against
a real spekterm-server with `RELAY_KIB_PER_SECOND=16`, for three minutes each):

- output below the cap (about 8 KiB/s): the relayed connection must stay up;
- output above the cap (about 64 KiB/s): recorded, and compared with a direct connection throttled to the same rate;
- a reconnect that receives a full terminal snapshot: recorded the same way.

If the relayed connection stays up below the cap and is no worse than the throttled direct one above it, the
keepalive is left as it is and the result goes into `docs/lessons/team.md`. Otherwise stop and bring the numbers to
the user; backpressure on the listener's output is its own change.

### D10. What the app now says about itself

Remote access "makes no connection of its own" stops being true with the setting on. Changed, in the same change:
`docs/remote-protocol.md` §0 and §2 (a relayed path exists; the phone's TLS still ends at the desktop),
`remote-notifications` (events go over the device's own connection, which may be one the desktop dialed at the
phone's request; nothing is dialed for an event — its requirement by delta, its Purpose paragraph edited directly in
the main spec at archive, since a Purpose has no delta form), `team-membership` (one `/connect` connection plus relay
legs; the credential also in `relay.accept`; `/relay` under the same certificate rule), the website's settings
reference page for the new switch, the website's data and network page (both languages), the README
(both languages), `docs/PRD.md`, CLAUDE.md's Remote access and Teams paragraphs, and `docs/lessons/team.md` (the leg's
`terminate()` rule and the `_write` cut). The network allow-lists do not change, so their comments gain the relay as a
second reason for the existing entries.

## Risks / Trade-offs

- **The team server's operator can make the desktop dial its own server** (only for grants the desktop holds, at most
  20 per grant per 10 minutes, server-enforced) and reach the listener's TLS → the listener still needs a phone
  credential; `pair` is refused on relayed connections; off by default.
- **A leaked grant** gives the same reach to whoever holds it → it authenticates only the credential of the phone it
  was made for (D8); unpairing the phone revokes it; the per-grant throttle bounds guessing on top of the server's
  rate limit.
- **No backpressure on the listener's output** (D9) can make a slow link, relayed or direct, miss pings while a session
  streams faster than the link → measured, not fixed here.
- **Wrapping `createWebSocketStream`'s `_write`** depends on `ws` 8 setting `_write` per instance → a unit test pins
  the cut (a 1 MiB write arrives as messages of at most 64 KiB) and fails on a `ws` that changes it.
- **One `https.Server` per tunnel** costs a little memory per tunnel → bounded by the server's four tunnels per desktop.
- **The setting is visible while unusable** (D1) → it says why, instead of hiding a switch that is on.

## Migration Plan

Additive everywhere. An older phone ignores `relay` and `relay.changed`; an older server never lists `relay.grant`,
so the switch never appears. Rolling back the app leaves a `team.relay` secret entry and `relay: true` in `team.json`
that the older app ignores; the server's grants then stay until the device leaves the team or the admin removes them
(`member list` shows them).

## Open Questions

None. The real-device measurement through the NAS is spekterm-server's task 7.3, after the Android change ships.
