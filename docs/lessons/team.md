# Teams (`team-membership`): what fails silently

> Trigger: `src/main/team-*`, `src/main/ipc/team.ts`, `scripts/probe-team.mjs`, `scripts/lib/stub-team-server.mjs`,
> or anything that talks to a team server. The contract is spekterm-server's `docs/protocol.md` (version 1; this
> client was written against spekterm-server 0.2.0's code and its 0.2.1 `protocol-clarifications`).

## 1. "Nothing before the certificate check" is held by structure, and only that way

Measured (Node 22.22.0, `ws` 8.22.0, a self-signed server recording every byte; `team-connection.test.ts` keeps it):
`tls.connect` with `rejectUnauthorized: false`, the pin compared on `secureConnect`, then a `ws` client built with
`createConnection: () => verifiedSocket`. A mismatched pin destroys the socket and the server sees **0 bytes** of
application data; a matching one opens the WebSocket. **In Electron's main process too**: `probe:team`'s pin-mismatch section, run against the
built app, saw 0 bytes and no frame.

The two places that look right are not:

- **`checkServerIdentity`** is not called when the chain fails — and a self-signed certificate's chain always
  fails (`DEPTH_ZERO_SELF_SIGNED_CERT`), with `rejectUnauthorized` true or false. A pin there never runs.
- **`ws`'s `upgrade` event** fires after the upgrade request was sent.

The control group (`pin-checked-after-data` in `scripts/team-control-groups.mjs`, and the unit test's) writes the
upgrade before the comparison: the "no application data" assertion turns red.

With TLS 1.3 the server may never emit `secureConnection` for a session the client abandons right after its check,
so "bytes received" can be `[]` rather than `[0]`: assert the sum, not the shape.

## 2. `close()` waits 30 seconds; end with `terminate()`, and act only on the current generation

`ws`'s `close()` waits up to 30 s (`CLOSE_TIMEOUT`) for the peer's close frame. A connection spekterm gave up on
(request timeout, Reconnect, resume) would report its close long after a newer one authenticated; read as a drop,
it reconnects a **third** time, and the server closes the current connection with 4006 — a stop the user has to
clear, caused by spekterm itself. Every end spekterm decides calls `terminate()`, the service bumps its generation
before it does, and events of an older generation are dropped. The unit test drives this with fake connections
(control: remove the generation check ⇒ a third connection).

## 3. `ws` reports its own size bound as a 1006 close

A frame over `maxPayload` gives an `error` with `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`, then a **1006** close — the
row "drop ⇒ retry". With a backoff reset on `hello` that is a reconnect every second. The connection records the
error code and reports `oversize` (a fault, a stop), and the backoff resets only after a minute authenticated.

## 4. A missing secret is not a revocation

`SecretStore.load()` starts empty when the file cannot be read (and does not set it aside) or cannot be parsed (and
does). A `hello` sent then carries no secret and is answered `AUTH_FAILED`, which the table reads as "revoked":
the user would be told they left a team they are still on, and the membership discarded for a read that failed
once. The service checks for the secret before connecting and stops with `CREDENTIAL_UNAVAILABLE`, keeping the
membership; discarding writes `team.json` first, so an interruption leaves at worst a secret with no address,
removed at the next start.

## 5. Trust anchors: the runtime's roots are not the operating system's

`tls.connect` without `ca` trusts only the runtime's bundled roots (Electron 43.8.4's Node: 118 bundled, 441 in the
system store; Node 22.22.0 here: 146 and 441). A server certified by an authority installed in the OS would fail.
The unpinned path passes `ca` = `getCACertificates('default')` + `('system')`; `default` includes
`NODE_EXTRA_CA_CERTS`, which Node reads once at process start — test it in a child process.

## 6. The probe

- The device name is an input's **value**: `textContent` does not include it.
- A local variable named `fetch` is reported by `scripts/network-surface.test.mjs` as the global `fetch`.

## 7. Control groups that could not fail (`scripts/team-control-groups.mjs`)

Three of the first five mutations stayed green, each for a reason that would have hidden a real defect:

- **A write followed at once by `destroy()` is discarded before it is flushed** (Electron's main process): "write the
  upgrade, then compare the pin" sent nothing, so it could not show that the check must come first. The mutation now
  refuses only in the write's callback, after the data left.
- **The missing-secret rule has three guards** (`start`, `#settle`, `#connect`): removing one changes nothing. The
  mutation is the failure the rule exists for — the missing secret taken for a revocation.
- **`npm test`'s output overflows `execFileSync`'s default 1 MiB buffer**, and the truncated output has no `not ok`
  line. A unit-test control runs its one file.

## 8. Teammate handoffs (`teammate-handoff`): what failed silently while building it

- **A stand-in's scripted answer can skip its own recording.** The stub recorded `handoff.send` inside the default
  answer, so a request answered `'silent'` (a lost answer) was never recorded: the probe saw one send instead of
  two and blamed the product. Requests are recorded when the frame arrives, before any scripted answer.
- **The members refetch is throttled to once a minute, and the connect itself fetches.** "A member who joined since
  the last fetch is found" holds for the first read after that minute, not for a read seconds after connecting;
  the probe waits out the minute rather than asserting the impossible.
- **A request timeout ends the connection** (`team-connection.ts`): a send that timed out is a lost answer, not an
  `INTERNAL` — it is resent with the same `clientId` on the next `connected`.
- **The teammate label and the prompt are each decided by one fact, and each has a control group** that turns its
  probe assertion red when it reads the other (`label-from-origin-kind`, `prompt-from-limit-flag` in
  `scripts/team-control-groups.mjs`).

## 8. Against the real server (spekterm-server 0.3.1, 2026-11-04)

Every step of the dogfood list behaved as the stub had: a member invite and a device invite through Settings (the
device invite asked only for the device name), a rename that survived a restart, a leave from one of two devices
(the member stayed, no notification), a revocation while spekterm was closed (one notification, the secret gone, no
further connection), and a leave from the last device (the member removed, no notification).

One trap on the server's side when it runs outside Docker: **the admin command needs `TLS_CERT` in its environment
too**, or the invites it prints carry no `fp`, and spekterm then verifies the self-signed certificate against the
system's trust store and cannot connect. In the documented Docker setup the container's environment provides it.

## 9. The way back (`teammate-handoff-return`): what failed silently while building it

- **A stand-in agent that answers and stops at once is never seen busy.** It reported `UserPromptSubmit` and `Stop`
  in one breath; the wait state drains every 400 ms and landed on ready, so "the user sent the prompt" (busy or
  awaiting a choice) never happened and `taken` was never reported. The probe's agent works a few seconds
  (`busySeconds`), as a real one does.
- **Notifications in one window coalesce, and a probe that filters by title then sees nothing.** The Outgoing
  notification and a Sent one, or a teammate session's completion and the `TOO_MANY_REPORTS` stop of that same
  report, land in one 4-second window and come out as "2 new handoffs". Wait for the earlier one to be presented
  before causing the next, or accept the coalesced one where that is the product's behavior.
- **"Nothing was notified" must wait past the coalescing window.** A 3-second wait after the event was green on the
  mutation that notifies every device (`notify-every-device`): the wrong notification would only have been presented
  at 4 seconds.
- **"Some notification mentions the title" was green on the wrong notification**: the inbox arrival of the same
  handoff names it too. Find the notification by its own title first.
- **Accepting an inbox item closes the inbox.** Row lookups afterwards return nothing, and an assertion of the shape
  "nothing was sent for it" passes without the click ever happening — reopen the inbox, and wait for the row.
- **Anchored control groups follow the exact source text.** Changing `ticketFor`'s gate and `createSession`'s
  `addProvisional` line broke two `scripts/intake-control-groups.mjs` anchors (`scripts/control-groups-source.test.mjs`
  caught it); re-anchoring them is only half the job — run them, and see them turn red.

## 10. The phone relay (`phone-relay`): what failed silently, or would have

- **A relay leg is a WebSocket turned into a byte stream, and two of `createWebSocketStream`'s defaults are wrong for
  it.** It sends one message per `_write`, and a TLS socket on top hands down a whole application write as one chunk:
  a 900 KiB message is one 900 KiB message, and the relay ends the tunnel on anything over 256 KiB (1009). Cut every
  write into ≤ 64 KiB (measured: with the cut a 900 KiB message crossed each way with the largest relayed message
  65,536 bytes; without it, 1009). And its `_final` calls `close()`, which calls back only when the peer's close frame
  arrives — 30 s when the relay stopped reading. Both are set **per instance** in ws 8, so `cutAndTerminate` wraps them
  on the instance; `team-connection-relay.test.ts` pins both with controls that turn red. Its `_destroy` terminates the
  WebSocket unless the WebSocket already errored (`terminateOnDestroy` starts true) — the first design said the
  opposite.
- **A type-only `import type { Duplex } from 'node:stream'` counts as an import** for the network-surface scan, and
  `stream` is not allowed there. Type a stream as `ReturnType<typeof createWebSocketStream>` or the
  `import('node:stream').Duplex` type query.
- **The listener learns a relayed connection's grant by giving each tunnel its own `https.Server` that never listens**:
  a relayed `TLSSocket` has no `remoteAddress` (measured `undefined`) and reaches its source stream only through Node's
  internal fields. **A server that never listens enforces no HTTP timeouts** — Node tracks connections for
  `headersTimeout` / `requestTimeout` only from `listening`, and `closeAllConnections()` reaches only a listening server
  (review measurement: a relayed stream that finished TLS and sent nothing was still open after 6 s with a 1 s
  `headersTimeout`; after `listen(0)`, closed at 1.2 s). So `acceptRelayed` keeps its own deadline until the upgrade,
  `#stop` ends pending relayed streams itself, and a stream handed over during a stop is refused by `#server === null`,
  not by `state()` (which changes only after the stop awaited).
- **The grant's phone is fixed when the tunnel is accepted, never looked up at `hello`.** The Android app treats
  `AUTH_FAILED` as "unpaired" and drops its credential; a lookup at `hello` time would answer the right phone
  `AUTH_FAILED` whenever the user turned the relay off during the tunnel's handshake.
- **Grant secrets wrapped in `Secret` and serialized with `JSON.stringify` are written as `[redacted]`**, and after a
  restart the phone would get `[redacted]`, be refused, and never be given a new grant (the same id is on both sides).
  `relay-grants.ts` keeps plain records private and reads them in two places; a round-trip test pins it.
- **A `relay.grant` answer can arrive after the world changed.** The round re-reads the membership, the setting and the
  paired phones after every await: a late grant for a phone no longer wanted is written as `revoke` and revoked in the
  same round. The first test of it was green on the mutation that skips the re-check — `relayFor` hides the grant
  anyway — and only an assertion on the request order (revoked before the next listing) told them apart.
- **`stream.duplexPair` is not a stand-in for a relay leg**: a pair end is not destroyed with its peer, so a TLS socket
  over it never closes and a WebSocket on top waits in CLOSING forever. The production shape (two WebSocket legs
  spliced) closes in tens of milliseconds; `relay.testkit.ts` is that shape.
- **Against the real server** (spekterm-server 0.4.0, `scripts/relay-live-check.ts`, 2026-11-06): join, grant, a phone
  through `/relay` with the outer connection pinned to the server and the inner one to the listener, `hello` answered
  with the grant, a 1 MiB message from the listener and a 900 KiB one from the phone crossing whole — 12/12.
- **The listener's keepalive through a slow relay** (`--slow`, the server capped at 16 KiB/s per direction, three
  minutes per case, 2026-11-06): terminal output at ≈ 8 KiB/s stayed up; at ≈ 64 KiB/s the relayed connection was
  closed after 79 s (1006, missed pings) and a direct one through a 16 KiB/s TCP proxy after 160 s (the two throttles
  differ: the server's token bucket and the script's proxy, kernel buffers on one hop versus two); a reconnect that
  receives a 1 MiB snapshot then ≈ 8 KiB/s was closed after 74 s. The cause is design D9's: the listener sends every
  frame at once and never looks at `bufferedAmount`, so its ping waits behind whatever the link has not carried yet,
  and two missed pings (≈ 40 s late) end the connection. At the server's default cap (512 KiB/s) a 1 MiB snapshot takes
  about two seconds. The keepalive was left as it is (the user's decision); backpressure on the listener's output is issue
  #101.
- **A phone gets a grant only over a connection it already has** (server design D11), so a relay turned off and on
  again while the phone is away leaves it with no grant until its next direct connection — dogfooding with the Android
  app's debug relay-only switch showed exactly that (a new grant created, no tunnel asked for, until one direct
  connection). It is the design, not a fault; a phone that cannot use the relay should say why.
