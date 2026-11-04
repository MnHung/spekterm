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
