## Context

See proposal.md for motivation. The state this change builds on:

- **The renderer owns the session list.** `SessionStore.replace()` rebuilds from the list the renderer pushes
  (debounced 500 ms). A session the main process creates on its own is wiped on the next replace while its
  pty keeps running (`ipc/intake.ts` header). That is why intake auto-accept sends
  `workspace:intake:autoAccept` and the renderer creates the session. Running, dormant and exited are
  renderer state. The main process only knows "has a pty" (`TerminalService.liveSessionIds()`).
- **Background creation still takes the desktop.** `sessions.create(folderId, target, { background: true })`
  skips only the `attention` bump. It still sets the folder's focused session (`sessions.tsx:543-545`).
  When that folder is the selected item, `MainStage` makes the new session active, and `TerminalView`'s
  first-active effect calls `focus()` (`TerminalView.tsx:349-363`). So today a handoff that arrives in the
  folder the user is typing in replaces the view and takes keyboard focus. The comment in
  `IntakeAutoAccept.tsx` says it does not; it is true only of the explicit `focus()` call.
- **The desktop's accept is not the auto-accept path.** `IntakeOverlay` runs:
  - `decideAccept`;
  - `sessionToReuse(existingSessionId, …)`, which reuses the session an earlier accept left;
  - `create` only if nothing can be reused;
  - `attach`.

  `attach` picks the prefill mode with `prefillModeFor({ firstPartyBody, reusedSession })`: a third-party
  body is filled in unsent, and a first-party (handoff) body is submitted. Auto-accept always creates, and
  it silently drops a creation failure.
- **Everything in the main process is keyed by `webContents.id`.** That covers the pty service, the
  conversation follower, the status poller and the displayed session (which drives auto-hibernation). On
  macOS the application can run with no window, and then no session exists: "nothing the closed window held
  outlives it" (`workspace-app-shell`).
- **The conversation view is one `TranscriptFollower` per renderer**, for the displayed session
  (`ipc/conversation.ts`). Its first attach sends at most the last 400 events, with `reset: true`.
  `ViewEvent`s carry the `uuid` of the transcript record they came from. One record can yield several events
  (text plus tool use, several tool results), all with the same `uuid`, and a record without one yields `''`
  (`transcript-follow.ts:179-229`).
- **Sending is gated in the main process.** The sender must be watching that session, and the wait state
  must be `ready` or `busy`. The text goes through `encodeInput` (control characters stripped, then `\r`) in
  **one** write. The 500 ms split between text and the submit key exists only in prefill
  (`SUBMIT_KEY_DELAY_MS`). There a long single write is taken as a paste and the `\r` is swallowed
  (`docs/lessons/handoff.md` 13.1). Prefill can split safely because it writes only at a fresh session's
  first `ready`.
- **Wait states are drained every 400 ms for every running claude session** (`session-hibernation`).
  `drainEvents` folds a batch to its final state, so a turn that starts and ends within one batch looks like
  `ready` → `ready`. `pendingRequestOf` gives `{ tool, arg }`. The hook payload does not carry a permission
  prompt's options.
- **pty output reaches the main process as decoded strings**, synchronously in `pty.onData` → `sink.data`
  (`terminal.ts:575, 604-609`). It goes only to the owning `webContents`. The main process keeps no buffer,
  and claude sessions are never snapshotted.
- **Inbox broadcasts are per-handler.** Desktop dismiss, accept, attach and settle each call
  `store.setState` and then the `broadcast()` in their own closure (`ipc/intake.ts`). `IntakeStore.setState`
  does not fire `IntakeService.subscribe`.
- **Guards this change runs into:**
  - `network-surface.test.mjs`. `MODULE_ALLOW` is a global `Set`: a module on it is allowed in every file.
    It currently says network modules "are never on it". `API_ALLOW` is `{ file, api }`.
  - `probe-core.mjs`. It has a regex `/createServer|\.listen\(/` over `src/main`, comments included. It
    also samples `/proc` for LISTEN sockets during the run. **It launches with no `--user-data-dir` and no
    `XDG_CONFIG_HOME`, so it runs on the real profile `~/.config/Spekterm`.** `probe:identity` uses the real
    profile on purpose. (`probe:native` does not load the app's code, so it never reads `remote.json`.)
  - `secret-scope.test.mjs`, which restricts `Secret.reveal()` to an allow-list of files.
- **Secrets** are a plaintext JSON file with mode 0600 (`secret-store.ts`). A corrupt file is set aside, and
  every secret in it is lost.

## Goals / Non-Goals

**Goals:**

- Every remote operation reuses the path the desktop uses for the same thing: the same follower, the same
  send gate, the same create and wake paths, the same accept flow. A phone cannot reach a state the desktop
  cannot.
- With remote access off, the feature does nothing: no listener, no output buffering, no attention log, no
  new subscriptions.
- The feature makes no outbound connection. The phone learns everything over the connection it opened.
- A device never takes the desktop away from someone using it: no focus change, no view change.
- The Android app can be written from `docs/remote-protocol.md` alone.

**Non-Goals:**

- A relay, FCM, or any server operated by the project.
- A push service of any kind, UnifiedPush included (D8). The user ruled it out on 2026-10-13: asking users to
  install a second app (a push distributor) is not acceptable, and they prefer the battery cost of a held
  connection.
- iOS. The protocol is not Android-specific, but nothing here is tested against an iOS client.
- Answering a permission prompt through the `PermissionRequest` hook's decision output. That would make the
  hook block until someone decides, which changes the desktop too. The phone answers prompts the way the
  desktop does, with keys into the terminal.
- From the phone:
  - closing, hibernating, renaming or reordering sessions;
  - managing folders;
  - browsing or editing files outside OpenSpec;
  - settings, Slack, insights.
- Opening a desktop window from the phone (an explicit exception in `remote-protocol`).
- Binding to one chosen interface. The listener binds to all interfaces, and narrowing it later does not
  change the protocol.
- Fixing the two pre-existing desktop defects this design runs into:
  - the desktop's single-write send (issue #76);
  - a handoff taking focus in the displayed folder (issue #77).

  Both are filed as GitHub issues. The remote paths here do not inherit
  either.

## Decisions

### D1. One module owns the listener: `https` + `ws`, TLS 1.2+

`src/main/remote-server.ts` is the only place that creates a server: `https.createServer({ key, cert,
minVersion: 'TLSv1.2' })` with a `ws` `WebSocketServer({ server, path: '/v1', maxPayload: 1 MiB,
perMessageDeflate: true })`. Any other path gets 404. A plain HTTP request fails the TLS handshake.

- **Why `ws` rather than a hand-written RFC 6455 server.** Node 24 (Electron 43) has a WebSocket *client*
  but no server. Framing, fragmentation, masking, close handshakes and permessage-deflate are where a
  hand-written server goes wrong silently. `ws` has no runtime dependencies. It goes in `dependencies`
  because the main build externalizes dependencies and only `dependencies` are packed (the `i18next`
  lesson). Only `WebSocketServer` is imported, so the scanner's `WebSocket` global rule does not fire. If it
  does, that is an `API_ALLOW` entry for this file.
- **Why TLS 1.2 and not 1.3 only.** Android's platform TLS has 1.3 only from API 29. Allowing 1.2 costs the
  pinning model nothing.
- **Guards.**
  - `MODULE_ALLOW` is refactored to accept file-scoped entries `{ file, module }` next to the global ones.
    `https` and `ws` are allowed only in `remote-server.ts`. A control group fails when another file imports
    `https`. The header's "never on it" becomes "only file-scoped, and only here".
  - `probe:core`'s text guard moves into `scripts/server-source.test.mjs`. Only `remote-server.ts` may match
    `createServer|.listen(`, test files are excluded, and a control group covers the rule (the
    `watcher-source.test.mjs` pattern).
  - `probe:core` moves to a throwaway profile. `XDG_CONFIG_HOME` points at an empty temporary directory,
    which needs no UI-language seeding, because the probe selects nothing by label. Their
    LISTEN assertion then holds whatever the maintainer's own AppImage has turned on. It becomes the carrier
    of "a fresh profile does not listen". `probe:remote` cannot carry that scenario: it holds a debugging
    port itself.
  - `probe:identity` must keep the real profile. If the maintainer turned remote access on there, running
    it starts the listener for the probe's few seconds. This is stated in `docs/lessons/probes.md` rather
    than worked around.

*Alternative rejected: plain `ws://` plus an application-level encrypted channel (a Noise handshake).* It
avoids certificates, but replaces a TLS stack with code of our own. On Android, OkHttp with a pinning trust
manager does TLS correctly already.

### D2. A self-signed ECDSA P-256 certificate built with `node:crypto`

- **The key.** `generateKeyPairSync('ec', { namedCurve: 'P-256' })`.
- **The certificate.** A minimal v3 certificate: random serial, CN=spekterm for both issuer and subject, ten
  years of validity, no extensions. Its DER is assembled by a small ASN.1 writer and signed with
  `crypto.sign('sha256', tbs, key)`, whose default output is DER, the form X.509 requires.
- **The fingerprint.** SHA-256 over the certificate's DER, shown as upper-case hex pairs.

The key is stored in the secret store (`remote.tlsKey`), and the certificate in `remote.json`. Either file
can be lost or damaged on its own: a corrupt `secrets.json` is set aside whole. So at start the server checks
that the key belongs to the certificate. If it does not, the server performs a reset (new certificate,
devices revoked) and the dialog says why. The alternative is a silent regeneration, after which every phone
fails to connect with no explanation.

Hostname verification is meaningless here, because the phone dials whatever address works. The phone checks
one thing: the leaf certificate equals the one it pinned. With OkHttp this has to be done in **both** the
trust manager and the `HostnameVerifier`. The default verifier fails a certificate with no SAN, and an
"always true" verifier is the pattern Play's security scanning flags. `docs/remote-protocol.md` says so.

*Alternative rejected: a certificate library.* `node-forge` is large, and `@peculiar/x509` pulls in a
reflection runtime. Only one certificate shape is ever produced. Node's `X509Certificate` (`verify`,
`fingerprint256`) and a real TLS handshake with a pinning client are its oracles. Whether Android's
Conscrypt accepts a certificate with no extensions is checked at the start of the Android work. Adding
`basicConstraints` would be the fallback, and it does not change this design.

### D3. Pairing: QR code → single-use code → per-device credential, stored as a hash

1. **The pairing code.** The desktop dialog creates a code: 128 random bits, base32. It is valid for five
   minutes, until used, or until the pairing view closes, whichever comes first. Only one is live at a time.
2. **The QR code** encodes
   `spekterm://pair?v=1&a=<addr>,<addr>&p=<port>&fp=<fingerprint hex>&c=<code>&n=<host name>`:
   - the addresses are the non-internal interface addresses, plus the additional address the user entered,
     if any (such as a DDNS name for a port forward);
   - the same link is shown as selectable text, so it can be sent to the phone by other means; the probe
     reads it there too.
3. **Pairing.** The phone connects, verifies the fingerprint, and sends `pair { code, deviceName,
   deviceModel }`. It receives `{ deviceId, deviceSecret }` once. The secret is 256 random
   bits.
4. **Storage.** `remote.json` keeps `{ deviceId, name, model, pairedAt, lastSeenAt, secretHash }`.
   `secretHash` is `sha256(secret)`: a full-entropy secret needs no salt or stretching. It is compared with
   `timingSafeEqual`.
5. **Reconnecting.** Every later connection sends `hello { deviceId, deviceSecret, protocol: [1] }` within 10
   seconds of the TLS handshake.
6. **Revoke** deletes the record and closes that device's sockets. **Reset** replaces the key and
   certificate and deletes every device.

**Failures** close the connection after a fixed one-second delay. The throttle is **per source address**:
ten failures in sixty seconds refuse that address for sixty seconds. A global lockout would let anyone on the
network keep the user's own phone out, and the secrets do not need it, because their length already defeats
guessing. Connections that have not authenticated have their own cap (16). When it is full, a new connection
closes the oldest unauthenticated one, so idle TLS sockets cannot use up the slots paired devices need.
Reaching the authentication deadline counts as a failure for the address, so reconnecting every ten seconds
gets throttled. Authenticated connections are capped separately (16).

**Why per-device credentials and not BAT's single shared token.** Revoking one lost phone must not log out
the others, and a device list is what makes "who is connected" answerable.

### D4. The renderer stays the authority: remote session actions are requests to it, and none takes the desktop

The main process sends `workspace:remote:request (requestId, action)`, and the renderer answers with
`workspace:remote:reply (requestId, outcome)`. The main process waits 15 s. There are three actions:

- **`create (folderId, target)`** runs `sessions.create(folderId, target, { background: true, quiet: true })`.
- **`wake (sessionId)`** runs the Wake path, with the quiet mark. `wake()` currently returns `void`, and
  gains an outcome.
- **`accept (adapter, id, folderId)`** runs the same flow `IntakeOverlay` runs, extracted into a function both
  call: `decideAccept` → `sessionToReuse` → `create` (with `quiet: true`) only if nothing can be reused →
  `attach`. Its outcome is the session id, or the failure, in which case the item stays pending. The prefill
  mode is `attach`'s own (`prefillModeFor`), so a third-party body stays unsent and a first-party body is
  submitted, exactly as on the desktop. The auto-accept path is **not** reused. It always creates, it cannot
  report failure, and with no window its send is simply lost.

**`quiet`** is the new part, and it means that a device-requested session never takes the desktop:

- It never sets any item's focused session, so it cannot replace what the desktop displays. The new tab
  simply appears. The one case in which it is displayed anyway is `focusedIdFor`'s fallback: an item with
  no session before it, which shows its first session. A deliberately simpler rule than "focused unless
  displayed", which would need the rail selection, and `SessionsProvider` does not have it.
- It never calls `focus()`. It carries a one-shot "arrived quietly" mark, and `TerminalView`'s first-active
  effect, on seeing it, **skips only the `focus()` call**, still fitting and resizing the pty. (Measured during
  apply: the terminal's mount-time size sync fits a new terminal on its own, so skipping the activation fit
  would not have left the pty at 80×24. The rule stays as written: holding back only the focus is the
  smallest change to that effect.) The mark is cleared by the first
  activation, or by any user action that turns to the session (`focus()`, a selection change). A session
  the user later opens takes focus normally.
- `wake` sets the same mark. A dormant session the desktop displays, woken from the phone, must not pull
  focus into its terminal or conversation input (`ConversationView` focuses its input on dormant → running,
  too).

Handoffs keep today's behavior. That defect is a Non-Goal.

**No window** makes all three answer `NO_WINDOW`. The application does not open a window for them, and
`remote-protocol` states this as an exception to `workspace-app-shell`'s general rule. When the window
closes or reloads, every remote follower and terminal subscription on its sessions ends, while the
connection stays (`remote-protocol`). On Linux, closing the window quits the app, so the probe tests this
with a reload. The per-connection state
registers with the same `destroyed` / `did-navigate` cleanup the window's own state uses.

**Inbox broadcasting** becomes one hook. The desktop handlers' closure `broadcast()` becomes
`notifyIntakeChanged()`, called by every state change on either side. The desktop's inbox and connected
clients both listen to it. Dismiss is extracted from its IPC handler into a function the remote dispatcher
calls too.

*Alternative rejected: let the main process create sessions and push them to the renderer.* That flips the
authority the whole persistence design rests on. It is a change of its own.

### D5. A remote client is a "virtual renderer": its own follower, its own watch, counted as displayed

Each authenticated connection owns at most one `TranscriptFollower` (the session whose conversation it
watches), at most one terminal subscription, and a wait subscription for the watched session. The follower
is created by a helper extracted from `ipc/conversation.ts`, `startFollow(sessionId, emit)`. It picks the
initial location (`lastTranscriptPathOf` or the computed path), relocates on wait snapshots, and answers
"no conversation" for a shell. The two consumers cannot drift.

**Send.**

- **Gate.** The same as the desktop: watching that session, with the wait state `ready` or `busy`.
- **Sanitizing.** The same `encodeInput` cleaning.
- **Writes.** The text and the submit key are written `SUBMIT_KEY_DELAY_MS` apart, because phone input is
  often dictated or pasted and long.
- **Re-check.** Immediately before the submit key, the wait state is checked again. If it is no longer
  `ready` or `busy`, the agent began waiting on a choice during the delay. The submit key is withheld, and
  the reply is answered `filled-not-submitted`. Writing it would have chosen the prompt's default for the
  user, which is what `agent-input-bridge` exists to prevent. Nothing is sent later (`docs/lessons/handoff.md`
  §13).
- **Order.** Replies to one session go through a per-session queue, so two never interleave as text, text,
  Enter, Enter.
- **Lag.** The re-check sees the state as of the last 400 ms drain. That is the same lag the desktop's gate
  has. It is not eliminated, only not widened by the split.

**Terminal input** (`terminal.input { sessionId, data }`) writes the string to the pty, as the desktop's
keyboard does. That is how a permission prompt is answered from the phone. It is also arbitrary input into a
shell, deliberately: a paired device has the user's power (D9). **Remote clients never resize a pty**: the
phone renders at the size that comes with the stream.

**Watched counts as displayed** for automatic hibernation (`session-hibernation` delta). The hibernation
tracker's displayed set becomes the union of every window's displayed session and every connection's watched
session. Starting or stopping a watch reports activity. Otherwise a session the user is reading on their
phone would be hibernated under them.

### D6. Every stream begins with a snapshot. Resuming means "send me what follows X if you still have it"

There is no global sequenced log of everything. Each stream has a natural position, and the server either
continues from it or starts over. Attention events are the one stream with no durable source of their own, so
they get a small log of their own (D7).

- **Conversation.** The client sends `conversation.watch { sessionId, afterUuid? }`.
  - The follower's first update is the last 400 events with `reset: true`.
  - The resume point is the **last** event in that batch whose `uuid` equals `afterUuid`, because one
    record yields several events that share its `uuid`. An empty `afterUuid` counts as not found.
  - If the point is found, the server sends only the events after it, with `reset: false`. Otherwise it
    sends the whole batch, with `reset: true`.
  - `truncated` passes through unchanged.
- **Terminal.** pty output arrives as strings, so a position is `{ gen, offset }`. `gen` identifies the
  session's current pty (a new one after a wake or a heal). `offset` counts UTF-16 code units of that pty's
  output. Frames carry strings as JSON, with no base64. A position with another `gen` is one the server
  does not hold.
  - Each session has a ring of up to 262,144 code units. It is trimmed from the front, never inside a
    surrogate pair.
  - The client sends `terminal.watch { sessionId, from? }` and receives
    `{ offset, cols, rows, data, complete }`. `data` is everything after `from` if the ring still holds it.
    Otherwise it is the whole ring, with `complete: false` (it may then begin mid-escape-sequence; the
    client's emulator recovers, as it would at any join).
  - The snapshot is taken and the live listener registered inside the `sink.data` path's synchronous turn,
    so no chunk falls between them.
  - Buffering runs only while remote access is on.
- **Lists.** Folders, sessions, inbox and handoffs travel as whole snapshots: a `*.changed` event carries the
  full list. Reconnecting simply refetches them.

*Alternative rejected: BAT's per-session sequence log with a host epoch.* BAT needs it because its agent
events are deltas with no other source of truth. Here every stream already has a durable source: the
transcript file, the pty output, the stores. A position into that source does the job without a second copy
to bound and evict. Attention events are derived moments with no such source, which is why they, and only
they, take BAT's shape (D7).

### D7. Attention events: one derivation, one stream, a short memory

`remote-attention.ts` turns existing moments into `{ pos, kind, at, sessionId?, intakeId?, folderName, title,
summary?, suppressed }`:

| kind | from |
|---|---|
| `waiting` | a drained batch that contains the agent's turn-completion event (`Stop`), with the folded state not `awaiting-choice`. `DrainResult` gains `turnEnded`, because a short turn folds to `ready` → `ready` and a state comparison would miss it |
| `choice` | a drained batch that contains a `PermissionRequest`, carrying its tool. `DrainResult` gains `choiceRaised` for the same reason as `turnEnded`: an answered prompt followed by the next one (`PostToolUse` → `PreToolUse` → `PermissionRequest`) folds to `awaiting-choice` → `awaiting-choice`. Only `PermissionRequest` counts; `Notification(permission_prompt)` for the same prompt would raise it twice |
| `handoff-done` | report adoption (`onReported`), the moment the desktop notification uses |
| `intake` | `intakeService.onArrival` |

`agent-wait` gains a process-wide `observeWaits(cb)`. It is called for every drained batch of every
session, with the snapshot and `turnEnded`, so no per-session wiring can be forgotten.

**Suppression.** `waiting` and `choice` about the session displayed in the focused desktop window
(`BrowserWindow.isFocused()` and the window's displayed session) are marked `suppressed`. They still reach
watching clients and the log, so lists update, but the protocol document tells clients not to notify for
them. Whether Xvfb lets a probe give the window focus is unverified, so task 1.4 (`runAttention`) checks it
first. If it cannot, a unit test with the focus source injected carries the rule, and the gap is recorded.

**The log.** A phone that is briefly out of reach (a lift, a network change, the 60 s before a dead
connection is closed) would otherwise lose exactly the events it exists to deliver.

- Events are kept in memory: every event of the last 24 hours, up to the 200 most recent.
- A position is `{ epoch, seq }`. `epoch` is random, new each time the log starts. The log follows the
  `enabled` setting, not the server's start and stop: it starts when remote access is turned on (including at
  startup) and is dropped when it is turned off or reset. A port change or a listen failure keeps it, so a
  phone is not told it may have missed something when it did not. A reset drops it so that a device paired
  afterwards does not see titles from before. A position with another epoch is one the server does not
  hold, the same rule as the terminal's `gen` (D6).
- A position is held when its epoch is current and `firstHeldSeq ≤ seq + 1 ≤ nextSeq`. The event at the
  position may itself be gone (aged out, or pushed out by count) without anything after it being lost.
- `attention.watch { after? }` answers `{ events, complete }`: everything after `after` if the log holds it,
  otherwise everything held with `complete: false`. Watching again replaces the connection's earlier watch. The snapshot and the live subscription are taken in one
  synchronous turn, as for the terminal.
- It is not persisted. After a restart, a phone gets `complete: false` and the session list, which is the
  current truth anyway.
- The client keeps the last `pos` it received and resumes from it. An event sent into a dead socket is
  therefore recovered on reconnect, without the server knowing which events a device actually got.

**Text reduction.** Titles and summaries can be agent-controlled (a session title set through OSC, a report
summary) or third-party (an inbox item), so they go through `reduceForNotification`. Folder names are not
reduced, but they are clipped to the same 80 code points. The URL placeholder is in the desktop's interface
language, and the protocol document says so. The phone's notification shade parses the text the same way a
desktop's does.

### D8. No push service. The phone keeps its connection open

The phone is told of attention events only over the WebSocket it opened. To notify while in the background,
the Android app holds that connection in a foreground service, with the persistent notification Android
requires. This change only has to make that possible:

- **Liveness stays as it is**: a ping every 20 s and a close after two misses (`remote-protocol`'s liveness rule). The ping is what keeps a
  NAT or a router mapping alive, and it is also what wakes the phone's radio. The interval is the battery
  knob. It is not exposed now; the Android work measures it first.
- **Missed events are recovered** by the log in D7, so a held connection that drops costs nothing but the
  delay until the phone reconnects, as long as it reconnects within 24 hours and 200 events.
- **No outbound connection.** The feature only answers connections. The network surface grows by a listener
  and nothing else, and there is no `fetch` to guard.

*Alternatives rejected:*

- **FCM.** Sending needs a Firebase project's server credentials. An open-source desktop app cannot hold
  them without a relay, and a relay is a Non-Goal.
- **UnifiedPush (RFC 8291 encrypted Web Push).** It works without a relay or Google, but the phone needs a
  separate distributor app (such as ntfy). The user ruled that out.
- **Periodic polling by the phone** (WorkManager). Android runs periodic work at most every 15 minutes, and
  less often in Doze. An agent waiting on a permission prompt would wait that long.

What this costs is stated in Risks: battery, Android's background limits, and Google Play's foreground
service review.

### D9. Threat model: a paired device has the user's power over agents

A paired device can type into any session, and agents have a shell. The design does not pretend otherwise:

- **Off by default.** Turning it on is an explicit act in the remote access dialog, and the dialog states
  what a device can do.
- **Who is connected is visible.** Devices are listed with their last-seen time, and the activity bar shows
  an indicator while any device is connected. Pairing happens only while the dialog shows a live code, so the
  new device appears in front of the user. No desktop notification is added; those belong to `agent-intake`.
- **Revocation and reset are immediate.**
- **All interfaces.** The listener binds to all interfaces, and the dialog says to turn it off on untrusted
  networks. The port reaches the internet only if the user forwards it.
- **Credentials.**
  - Device secrets exist on the phone and, hashed, in `remote.json`.
  - The TLS private key is in the secret store and is never sent anywhere.
  - The pairing code is the only secret the renderer sees. It must show it, and the code is single-use and
    short-lived.
- **Inbox acceptance.** An inbox item can only be accepted after its full body has been read
  (`agent-intake`'s human check). The protocol document makes that the client's obligation, and this
  repository cannot verify it.

### D10. Settings and the dialog

Settings gains a "Remote access" section: one line of state (off; on, N devices, M connected; or the listen
error) and a button that opens the remote access dialog. The Settings dialog already scrolls at its height
cap.

The dialog (`role="dialog"`) holds:

- the switch, with the power and untrusted-network statement;
- the port, the additional address, the found addresses and the fingerprint;
- Pair a device: the QR code, the link text and the countdown;
- the devices, with Revoke;
- Reset;
- a listen error or a reset notice.

Settings live in `remote.json`, through their own store, like Slack's `slack.json`, and not in
`preferences.json`. The device list is not a preference, and its hashes must never be projected. The renderer
receives a field-whitelisted projection.

**A listen failure is shown, not swallowed**: `EADDRINUSE`, for example the dev build and the AppImage on
one port, and `EACCES`. The switch stays on, and changing the port or toggling retries.

### D11. The protocol document is part of the change

`docs/remote-protocol.md` is the contract with the Android repository. It covers:

- the pairing link and the pinning rule (trust manager **and** hostname verifier: the leaf equals the pin);
- frames: `{ t: 'req', id, m, p }`, `{ t: 'res', id, ok, r | e: { code, message } }`, `{ t: 'evt', k, d }`;
- version negotiation;
- every method and event with its parameters, results and error codes;
- the resume rules, including UTF-16 positions and "last occurrence of the uuid";
- the attention stream: the event format, the resume rule, that suppressed events are not notified, and that
  a client learns of events only while connected;
- liveness: a server ping every 20 s, closed after two missed pongs;
- which events reach every connection (the list changes) and which only a watcher of the attention stream;
- the client obligations: show the full body as plain text before offering accept; reduce nothing further,
  because the server already did; render the terminal at the stream's size; do not notify for a suppressed
  event; notify for live events and for held events after a complete resume, but summarize the held events
  of an incomplete answer (a fresh pairing receives up to 200) rather than notifying each.

A unit test fails when the dispatcher's allow-list and the document's operation list differ.

## Risks / Trade-offs

- **[Raw terminal on a phone]** Claude Code's TUI repaints for the desktop's width. → The conversation view
  is the primary phone surface. The terminal is for prompts and shells, and the size travels with the stream.
- **[Permission prompts answered by keys]** The phone must read the prompt from raw output, and the option
  order is Claude Code's. → The same is true on the desktop today. The hook-decision route is a Non-Goal,
  recorded for later.
- **[The re-check before Enter is 400 ms stale]** → It is the same staleness the desktop gate has. The split
  does not widen it, and a withheld Enter is reported, never sent later.
- **[Port open on a hostile network]** → Off by default, TLS with pinning, full-entropy credentials, the
  per-address throttle, separate connection caps, and the dialog's warning.
- **[A carrier-NAT neighbor delays the phone's reconnection]** The throttle is per address. → This is stated
  in the spec. Throttling exists only to limit noise.
- **[Battery]** The phone holds a TLS socket and answers a ping every 20 s, so its radio wakes at least that
  often. → The user accepted the cost (D8). The interval is one constant, and the Android work measures it
  before anything is tuned.
- **[Android background limits]** Whether a foreground service keeps its network during Doze, and whether
  vendor battery managers kill it, is unverified. If either fails, the phone is not notified until the app
  is opened again, and the log in D7 then delivers what it missed within 24 hours, up to 200 events. A known
  fallback is asking the user to exempt the app from battery optimization, but Google Play restricts apps
  that request that exemption directly (unverified; for the Android work). → Checked at the start of
  the Android work, on a real device.
- **[Google Play review]** The foreground service must declare a type Google accepts for a held connection
  to the user's own computer. With no push service, notifications depend on it. → Decided and tested in the
  Android repository before it is published.
- **[Notifications need a reachable desktop]** Away from the LAN, with no Tailscale and no port forward,
  nothing reaches the phone. → Inherent in having no relay. Stated on the website's remote access page.
- **[Hand-written crypto]** One piece, the ASN.1 writer for the certificate. → Pinned by an external oracle
  with a control group: Node's X.509 parser and a real handshake.
- **[A probe running on the real profile]** `probe:identity` starts the listener for its few seconds if the
  maintainer turned remote access on. → Stated in `docs/lessons/probes.md`. `probe:core` moves to a
  throwaway profile.
- **[macOS with no window]** Session operations return `NO_WINDOW`. Only inbox arrivals can still raise
  attention events, because with no window there are no sessions. → Stated on the website's remote access page.

## Migration Plan

Nothing to migrate. `remote.json` and the secret entry are created the first time remote access is
turned on. Rollback is turning it off, which closes the listener and drops the attention log. An older build ignores
`remote.json`.

## Open Questions

- The Android app's notification channels, and its foreground service type for Play review
  (`remoteMessaging`, `connectedDevice` or `specialUse`). These are decided in the Android repository. Nothing in
  this repository depends on the choice, but the phone's notifications do (Risks).
