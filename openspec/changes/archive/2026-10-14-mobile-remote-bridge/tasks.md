## 1. Acceptance first (red before 2–6)

- [x] 1.1 `scripts/lib/ports.mjs`: register the `remote` probe's debugging port, two non-default listener ports it uses (the probe never uses the product default 47615, so a maintainer's AppImage holding it cannot interfere). Verify: `npm test` (`ports.test.mjs`) passes
- [x] 1.2 `scripts/lib/stub-agent.mjs`: every transcript record the stub writes gets a unique `uuid` (today user records share `u-$$`). Input is read in blocks (whatever is available, up to 4 KiB), and each block's arrival time goes to a separate file. The existing byte receipt and `stub.bytes()` are unchanged. A per-byte timestamp would measure the stub's own pace (about 2.5 ms per byte), not the product's writes. Verify: `npm test` (`scripts/stub-agent.test.mjs`), `probe:agent-view`, `probe:intake` and `npm run capture:screenshots` still pass
- [x] 1.3 `scripts/lib/remote-client.mjs`: a test client acting as the phone. It connects with `ws` over TLS, pinning the certificate by its SHA-256 fingerprint and rejecting any other. It can pair, connect with a credential, invoke operations, collect events, resume the attention stream from a position it kept, and answer or ignore liveness pings. Its unit test `scripts/remote-client.test.mjs` shows it rejects a server presenting a different certificate. Verify: that test passes
- [x] 1.4 New `scripts/probe-remote.mjs`, with sections registered in `SECTIONS` and wired into `scripts/run-probe.mjs`, `package.json` (`probe:remote`) and `scripts/run-probes.mjs` (`test:e2e`). It drives the dialog with real mouse and keys, reads the pairing link from its text field, sets the port to a registered non-default one before turning remote access on, and reads process facts from `/proc`. Sections:
  - `runListener`: turning on ⇒ TLS succeeds; the client's computed fingerprint equals the dialog's; a port change moves the listener; off ⇒ the connected client is closed and no socket listens on that port; on, then a restart ⇒ listening with the same fingerprint; a port held by the probe ⇒ the dialog and the Settings line state the conflict, and a free port recovers; the dialog's port field shows 47615 in a fresh profile
  - `runPairing`: pair ⇒ the device is listed by name; the same code again ⇒ refused; closing the pairing view ⇒ its code refused; no file under user data contains the credential; a wrong credential ⇒ closed with no operation served; silence beyond ten seconds ⇒ closed; revoke one of two ⇒ it is closed and refused while the other connects; reset ⇒ new fingerprint, and both refused; the renderer's remote-state response, read through CDP, contains no credential, hash or private key; the secret store's TLS key removed between runs ⇒ the dialog states remote access was reset, and the old device is refused
  - `runIndicator`: connect ⇒ the activity-bar indicator appears; activating it opens the dialog; the Settings section's control opens the dialog; the last disconnect removes the indicator; Settings states off, then "on, 2 devices, 1 connected"
  - `runSessions`: the list matches the rail; a session created on the desktop is sent; the stub with `busySeconds` ⇒ the sent list shows it working, then waiting; create an agent session in another folder G ⇒ it is in the rail, the rail selection is unchanged, and it is restored after relaunch; then select G and click the new tab ⇒ `document.activeElement` is in its terminal and its pty is not 80 columns (`/proc` plus the IPC size); with the desktop displaying a session of folder F and focus in its terminal, create a session in F ⇒ the displayed session and `document.activeElement` are unchanged; with the desktop displaying an empty folder E and focus in the side panel's editor, create a session in E ⇒ focus is still in the editor and the new pty is not 80 columns; with the desktop displaying a dormant session and focus in the editor, wake it from the client ⇒ it runs and focus is still in the editor; wake a dormant session ⇒ a `/proc` pid exists and it is listed running; a watched idle agent with a seeded few-second auto-hibernation threshold (`preferences.json`, the hibernation probes' method) is still running past the threshold, and hibernates once the watch ends and the threshold passes again
  - `runConversation` (stub agent): watch ⇒ the stub's reply arrives as an entry; a long reply ⇒ the stub's block containing `\r` arrived at least 400 ms after the previous block, and the reply appears as an entry; reply while the stub holds a permission request ⇒ refused with that reason, nothing reaches the pty; reply while working, with the stub raising a permission request inside the delay ⇒ answered filled-not-submitted, and no `\r` reaches the pty; reply to an unwatched session ⇒ refused; disconnect, the stub writes two records, watch again with `afterUuid` ⇒ exactly those two, not replacing; a shell session ⇒ no conversation; watching a nonexistent session ⇒ not-found, then a valid operation succeeds; an unknown operation and a write-a-file operation ⇒ unknown-operation error with the connection still open; an unsupported protocol version ⇒ refused, naming the supported ones
  - `runTerminal`: a shell printing a numbered sequence while the client starts watching ⇒ every number exactly once; input `echo <marker>\r` ⇒ the marker comes back; the snapshot's cols and rows equal the pty's, and a desktop resize is delivered; a position older than the ring ⇒ replacing and incomplete; hibernate and wake the session, then watch with the old position ⇒ replacing; reload the renderer (CDP `Page.reload`) ⇒ the client is told the watch ended, and its connection is still open (closing the window would quit the app on Linux, which ends everything and so proves nothing)
  - `runIntakeHandoff`: the client watches the attention stream first; deliver a third-party inbox item ⇒ the intake event arrives; accept into a named folder ⇒ a session in that folder, whose pty cwd (`/proc/<pid>/cwd`) is that folder, with the prompt filled in and unsent, and the item no longer pending; with the stub's `readyDelaySeconds` beyond the 30 s prefill limit, the item returns to pending, then accept again ⇒ no second session, and the first session receives the prompt once ready (this step costs about 30 s, and is the only one that does); accept into a folder whose directory was absent when the app started (seeded in `workspace.json`, status missing) ⇒ error, item still pending; accept without a folder ⇒ error, still pending; ignore from the client ⇒ gone on the client and on the desktop; ignore on the desktop ⇒ the client receives the list without it; a handoff child reports with a URL in its summary ⇒ lifecycle done, the brief carries the summary, and the handoff event's summary lacks the URL
  - `runOpenSpec`: read an active change of the fixture repo ⇒ its artifacts with content; a `../`-shaped slug ⇒ not found
  - `runAttention`: the client watches the attention stream; then:
    - the stub holding a permission request ⇒ a choice event naming the tool;
    - the stub finishing a turn ⇒ a waiting event;
    - disconnect, the stub raises two events, reconnect and watch from the last position received ⇒ exactly those two, in order, complete. While disconnected, sample every app process's `/proc/<pid>/net/tcp` and `tcp6` (sockets of its inodes under `/proc/<pid>/fd`) and assert no socket other than listening ones, the listener's and the debugging port's; this is the runtime carrier for "opens no connection", because the source guard cannot see an outbound call made with the `https` or `ws` modules `remote-server.ts` is allowed;
    - remote access turned off, the stub raises an event, remote access turned on, the stub raises another, then watch from the old position ⇒ only the second, incomplete;
    - change the port, the stub raises an event, reconnect on the new port and watch from the old position ⇒ that event, complete;
    - an event raised while the client starts watching ⇒ received exactly once;
    - the displayed session in a focused window ⇒ a suppressed event. First check whether Xvfb lets the probe focus the window (`BrowserWindow.isFocused()` through CDP). If not, drop this assertion and record the gap under 1.5; the unit test in 4.2 carries it

  Verify: the probe runs end to end and reports every section complete
- [x] 1.5 `scripts/scenario-coverage.test.mjs`: register `mobile-remote-bridge` in `COVERED_CHANGES`, with one row for **every** scenario in this change's spec files, each with `greenIfAbsent` and `mutation`. Labels come from 1.4, from the unit tests in 2.x–4.x, from the guards in 6.x (6.5 carries "An undocumented operation fails the test"), from the site build's content check for the website scenario, or from `probe:core` ("A fresh profile does not listen", after 6.2). The project-website scenario that already has a row ("The page states the app's own connections and the started programs") keeps it; the guard rejects duplicate rows. They are never written from memory. Where nothing can carry a scenario, write "no carrier" with the reason. The macOS no-window scenarios are carried by dispatcher unit tests with no window registered, plus dogfood on a Mac. The client's obligation to show the full body before accepting has no carrier in this repository. Verify: `npm test` passes the coverage guard
- [x] 1.6 Run 1.4 against the unchanged product and record under this task which assertions are red and why. A run that fails on a selector this change introduces proves only that the selector is new (`docs/lessons/probes.md`). For those, the control groups in 7.2 carry the behavior. Verify: the record is written here

  Recorded (2026-10-13, the probe and its libraries copied onto a worktree of the commit before this change, built there): of 11 sections, every one stops at its first step — "not on screen: the remote access section control" (runIndicator one step earlier, at the same entry), because the remote access dialog is markup this change adds. The one assertion that ran, "a fresh profile: nothing listens on the listener ports", is green on the old product, as it must be. So the red run proves only that the entry is new (`docs/lessons/probes.md`, "The red run must fail on behavior"); each behavior is carried by a control group under 7.2.

## 2. Main process: identity, store, listener

- [x] 2.1 `package.json`: add `ws` to `dependencies`, and a QR encoder with no runtime dependencies for the renderer. Verify: `npm ls ws` shows one copy; `npm run build` succeeds
- [x] 2.2 New `src/main/remote-cert.ts`: an ECDSA P-256 key and a minimal self-signed v3 certificate, from a small DER writer signed with `crypto.sign` (DER signature); its SHA-256 fingerprint; and a check that a key belongs to a certificate. Unit test `remote-cert.test.ts`:
  - `new X509Certificate(pem)` parses it;
  - `verify(publicKey)` is true;
  - `fingerprint256` matches ours;
  - a real `tls` server completes a handshake with a pinning client;
  - the key-matches check rejects another key;
  - control group: one flipped TBS byte fails `verify`
- [x] 2.3 New `src/main/remote-store.ts` (`remote.json`): enabled; port (1024–65535, default 47615); additional address; certificate; devices `{ id, name, model, pairedAt, lastSeenAt, secretHash }`; and a reset notice. Atomic writes, mode 0600, and quarantine of a corrupt file (the `secret-store` pattern). The private key goes through `SecretStore` (`remote.tlsKey`), with a field-whitelisted projection for the renderer. Unit tests:
  - a round trip;
  - an invalid port falls back to the default;
  - the projection has no `secretHash`;
  - a missing or mismatched key at start ⇒ a reset with the notice set and the devices gone
- [x] 2.4 New `src/main/remote-pairing.ts`:
  - one live pairing code (128-bit, base32): five-minute expiry, single use, cancelled when the pairing view closes;
  - device credentials of 256 bits, stored as SHA-256 and compared with `timingSafeEqual`;
  - a per-address throttle: 10 failures in 60 s refuse that address for 60 s, and reaching the authentication deadline counts as a failure;
  - the clock is injectable.

  Unit tests: expiry; single use; cancel; a revoked credential fails; the throttle refuses only its address and lapses after 60 s
- [x] 2.5 New `src/main/remote-server.ts`, the only module that creates a server (design D1):
  - `https` + `ws` on `/v1`, `maxPayload` 1 MiB, permessage-deflate;
  - a ten-second authentication deadline, and a one-second delay before closing on a failure;
  - separate caps for unauthenticated and authenticated connections; at the unauthenticated cap, a new connection closes the oldest unauthenticated one;
  - a ping every 20 s, closing after two misses;
  - closing a device's sockets when it is revoked;
  - listen errors surfaced as a state;
  - idempotent start, stop and port change;
  - an injectable ping interval.

  Unit tests on an ephemeral port: an unauthenticated operation is refused; a silent client is closed and counted as a failure; idle unauthenticated connections at the cap do not block an authenticated one; revoking closes; a client that ignores pings is closed after two intervals; `stop()` releases the port; a busy port yields the error state, and a port change recovers
- [x] 2.6 `src/main/index.ts`: construct the remote store and server after the secret store; start after the window, as Slack is started; stop in a `will-quit` handler; restart on a settings change; register each connection's per-window state with the window's `destroyed` / `did-navigate` cleanup. Verify: 1.4 `runListener` passes

## 3. Main process: the protocol

- [x] 3.1 New `src/main/remote-protocol.ts`: frame parsing and validation; `hello` / `pair` / `welcome` with version negotiation; a dispatcher whose allow-list is one exported table. An unknown operation answers `UNKNOWN_OPERATION` and keeps the connection, and error codes are stable strings. Unit tests: framing errors; a version refusal naming the supported versions; an unknown operation leaving the connection usable; `NO_WINDOW` for create, wake and accept with no window registered, and an empty session list with `window: false`
- [x] 3.2 Extract `startFollow(sessionId, emit)` from `ipc/conversation.ts`: the initial location, relocation on wait snapshots, and the shell answer. The desktop handler uses it unchanged. Verify: `probe:agent-view` passes as before, plus a unit test of the helper
- [x] 3.3 Remote conversation:
  - one follower per connection;
  - `afterUuid` resume at the **last** matching event, with an empty value treated as not found (design D6);
  - send with the desktop's gate and `encodeInput`;
  - the text, then the submit key `SUBMIT_KEY_DELAY_MS` later, after re-checking the wait state; a state no longer `ready` or `busy` withholds it and answers `filled-not-submitted`;
  - a per-session send queue.

  Unit tests, with the pty write and the clock injected (the primary carrier for the split, as lesson 13.1's control was): the text and `\r` are two writes at least `SUBMIT_KEY_DELAY_MS` apart; resume at a uuid shared by several events sends only events after the last of them; an empty or missing uuid replaces; send is refused for `unknown`, `awaiting-choice` and an unwatched session; `awaiting-choice` injected during the delay ⇒ no `\r` written; two concurrent sends produce text, Enter, text, Enter
- [x] 3.4 `src/main/terminal.ts`: an output tap in the `sink.data` path, and the current cols and rows per session. New `src/main/remote-output.ts`:
  - a ring of up to 262,144 UTF-16 code units per session, with positions `{ gen, offset }` (`gen` new for every pty of the session), trimmed outside surrogate pairs;
  - kept only while remote access is on;
  - snapshot and live subscription in one synchronous turn;
  - size-change events.

  Unit tests: resume inside and outside the ring (`complete: false`); a position from an earlier pty replaces; no chunk lost or duplicated across a subscribe; a trim never splits a surrogate pair; nothing buffered while off
- [x] 3.5 Remote session list: folders from `WorkspaceStore`; sessions from the window's records with liveness, wait state, lifecycle and lineage; `window: false` and an empty list with no window. Pushed as complete lists, debounced, on store, liveness, wait and lifecycle changes. Unit tests: the projection's contents; the no-window shape
- [x] 3.6 Renderer-mediated actions (design D4): `workspace:remote:request` / `reply` with request ids, a 15 s timeout, and `NO_WINDOW` for `create`, `wake` and `accept`. Extract the desktop's accept flow from `IntakeOverlay.tsx` (`decideAccept` → `sessionToReuse` → create → `attach`) into a function both use. Unit tests: timeout; no window; missing folder; a creation failure leaves the item pending
- [x] 3.7 Inbox broadcasting: replace the per-handler closure `broadcast()` in `ipc/intake.ts` with one `notifyIntakeChanged()` hook, called by every state change from either side and listened to by the desktop and the remote server. Extract dismiss into a function. Unit test: a desktop dismiss and a remote dismiss each reach both listeners
- [x] 3.8 Handoff and OpenSpec reads: the lifecycle projection and the brief through the existing modules; a per-server `OpenSpecService` over the workspace store, disposed on stop, with the same lookup-table rules. Unit test: a `../` slug is not found, with no file-system call
- [x] 3.9 `terminal.input`: the string goes to the session's pty through the window's `TerminalService.write`. No resize operation exists. Unit test: the allow-list contains no resize
- [x] 3.10 Watched counts as displayed (`session-hibernation` delta): the hibernation tracker's displayed set is the union of each window's displayed session and each connection's watched session, and a watch starting or ending is activity. Unit test in the hibernation policy tests: a watched idle session is not eligible, and it becomes eligible after the watch ends and the threshold passes

## 4. Main process: attention events

- [x] 4.1 `src/main/agent-events.ts` / `agent-wait.ts`: `DrainResult` gains `turnEnded` (the batch contains a `Stop` event) and `choiceRaised` (the tool of the batch's last `PermissionRequest`; `Notification` does not count); `observeWaits(cb)` is a process-wide observer of every drained batch. Unit tests: a batch with start and stop folded to `ready` has `turnEnded: true`; a batch with `PostToolUse(A)`, `PreToolUse(B)`, `PermissionRequest(B)` after an `awaiting-choice` state has `choiceRaised: B`; a `Notification(permission_prompt)` alone raises nothing; an observer sees a session that has no remote subscriber
- [x] 4.2 New `src/main/remote-attention.ts`:
  - derives `waiting` (`turnEnded`, with the state not `awaiting-choice`), `choice` (`choiceRaised`, with its tool), `handoff-done` (the `onReported` hook in `index.ts`) and `intake` (`onArrival`);
  - marks events `suppressed` from the injected focused-window and displayed-session sources;
  - runs titles and summaries through `reduceForNotification`, and clips folder names to 80 code points.

  Unit tests: each derivation; a one-batch turn raises `waiting`; suppression; a URL removed from a summary
- [x] 4.3 The attention log and stream, in `remote-attention.ts` (design D7):
  - follows the `enabled` setting, not the server's start and stop: created with a new random epoch when remote access turns on, dropped when it is turned off or reset, kept across a port change, a restart of the listener, and a listen failure;
  - holds every event of the last 24 hours, up to the 200 most recent, with the clock injectable;
  - a position is held when its epoch is current and `firstHeldSeq ≤ seq + 1 ≤ nextSeq`;
  - watching again on a connection replaces its earlier watch;
  - positions `{ epoch, seq }`;
  - `attention.watch { after? }` answers `{ events, complete }` and subscribes in the same synchronous turn;
  - every watching connection receives each event, suppressed ones included.

  Unit tests: resume from a held position sends only what follows, complete; a position whose own event was pushed out, with nothing after it lost, is still complete; another epoch, a position with later events dropped, and no position each send everything held, incomplete; a port change keeps the epoch and a reset changes it; a second watch on one connection does not double events; an event older than 24 h is gone; nothing is held while off; no event lost or repeated across a subscribe

## 5. Renderer

- [x] 5.1 `src/preload/index.ts` and `index.d.ts`: a `remote` namespace (get state, set enabled, set port, set additional address, start and cancel pairing, revoke, reset, subscribe) and the request/reply bridge, narrowed on both sides (`docs/lessons/slack.md` §10). Verify: `npm run typecheck`
- [x] 5.2 `sessions.tsx`, `TerminalView.tsx` and `ConversationView.tsx` (design D4):
  - `create` gains `quiet`: it sets no item's focused session, and gives the session a one-shot "arrived quietly" mark;
  - `wake` takes the same option;
  - at the first activation, `TerminalView` skips only its `focus()` call, while `fit()` and the pty resize still run; `ConversationView` skips focusing its input on dormant → running;
  - the mark is cleared by that first activation, or by any user action that turns to the session (`focus()`, a selection change);
  - `wake()` returns an outcome.

  Verify: 1.4 `runSessions` (the displayed-folder assertion) passes, and `probe:terminal` and `probe:intake` pass as before
- [x] 5.3 The remote access dialog (`role="dialog"`):
  - the switch, with the power and untrusted-network statement;
  - the port, the additional address, the found addresses and the fingerprint;
  - Pair a device: the QR code, the link as selectable text with an `aria-label`, and the countdown;
  - the devices, with last seen, connected, and Revoke;
  - Reset, with confirmation;
  - a listen error or reset notice.

  All text comes from both dictionaries. Verify: 1.4 `runPairing` and `runListener` pass
- [x] 5.4 The Settings section (the state line and the control that opens the dialog), and the activity-bar indicator shown while a device is connected. Verify: 1.4 `runIndicator` passes
- [x] 5.5 A resident handler for `workspace:remote:request`: `create` (quiet), `wake`, and `accept` (the extracted flow, with quiet creation). It replies with the outcome, subscribes once, and keeps changing values in refs (the `IntakeAutoAccept` pattern). Verify: 1.4 `runSessions` and `runIntakeHandoff` pass

## 6. Guards and existing probes

- [x] 6.1 `scripts/network-surface.test.mjs` and `scripts/lib/network-surface.mjs`: `MODULE_ALLOW` gains file-scoped entries `{ file, module }`. Allow `https` and `ws` only for `src/main/remote-server.ts`, and nothing outbound for any remote module, then rewrite the header. Control groups: another file importing `https` fails; a stale file-scoped entry fails. Verify: `npm test`
- [x] 6.2 Move `probe:core`'s server text guard into `scripts/server-source.test.mjs`: only `src/main/remote-server.ts` may match `createServer|.listen(`, test files excluded, with a control group. `probe:core` launches with `XDG_CONFIG_HOME` pointing at an empty temporary directory (`probe:native` does not load the app's code and is left alone). Its runtime LISTEN checks stay as they are. Verify: `npm test`; `npm run probe:core` passes
- [x] 6.3 `scripts/secret-scope.test.mjs`: add the modules that call `reveal()` for `remote.tlsKey` to `REVEAL_ALLOWLIST`. Verify: the test passes, and a `reveal()` elsewhere fails it
- [x] 6.4 `scripts/probe-shell.mjs`: extend the preload whitelist with the `remote` namespace and the request bridge. Verify: `npm run probe:shell` passes
- [x] 6.5 New `scripts/remote-protocol-doc.test.mjs`: the dispatcher's allow-list and the document's operation list are equal. Control group: a fixture document missing one operation fails. Verify: `npm test`

## 7. Docs and verification

- [x] 7.1 Write `docs/remote-protocol.md` (design D11), covering:
  - the pairing link;
  - the pinning rule for both the trust manager and the hostname verifier;
  - framing and version negotiation;
  - every operation and event, with parameters, results and error codes;
  - the resume rules (UTF-16 positions, the last occurrence of a uuid);
  - the attention stream: the event format, the resume rule, that a suppressed event is not notified, that events reach a client only while it is connected (so a background client must hold its connection), and the URL placeholder in the desktop's language;
  - liveness and the dead-connection window;
  - the client obligations.

  Verify: 6.5 passes
- [x] 7.2 Control groups: for each section of 1.4 and the unit tests named below, revert the product behavior and confirm the named assertion turns red. The minimum set:
  - the send gate allowing `awaiting-choice`;
  - no re-check before the submit key;
  - a single-write send;
  - no send queue;
  - subscribing after the snapshot;
  - `afterUuid` resuming at the first matching event;
  - `quiet` ignored;
  - the quiet mark skipping `fit()` as well as `focus()`;
  - the quiet mark never cleared;
  - the terminal position's `gen` ignored;
  - the authentication deadline not counted as a failure;
  - remote accept through auto-accept (no reuse);
  - revoke not closing sockets;
  - a reusable pairing code;
  - a global throttle;
  - suppression off;
  - the attention resume ignoring the epoch;
  - the attention log kept while remote access is off;
  - subscribing to attention after the snapshot;
  - reduction off;
  - `turnEnded` replaced by a state comparison;
  - `choiceRaised` replaced by a state comparison;
  - the attention log tied to the server's start and stop (a port change then answers incomplete);
  - an outbound `https.request` from `remote-server.ts` on each attention event (the `/proc` socket sample in `runAttention` must turn red);
  - watched not counted as displayed.

  Record each result under this task. Verify: every listed mutation turns its named assertion red

  Recorded (2026-10-13; scratch scripts plant each defect, run the carrier, restore the file):
  - unit carriers, all red: the send gate allowing `awaiting-choice`; no re-check before the submit key; a single-write send; no send queue; `afterUuid` resuming at the first matching event; subscribing after the snapshot (terminal and attention); the terminal position's `gen` ignored (**green at first** — the old position fell outside the new pty's output, so the test replaced for the wrong reason; the new output is now longer than the old position, and it turns red); the authentication deadline not counted as a failure; revoke not closing sockets; a reusable pairing code; a global throttle; remote accept with no reuse; suppression off; reduction off; `turnEnded` and `choiceRaised` replaced by state comparisons; the attention resume ignoring the epoch; the attention log kept while off; the attention log tied to the server's start and stop; watched not counted as displayed; a document missing an operation; another file importing `https`; a server outside the listener.
  - probe carriers (build + section): `quiet` ignored → "creating in the displayed folder…" red (tab `claude 1 → shell 2`); the quiet mark asked at every activation and never consumed → "a quietly created session takes focus once the user turns to it" red; an outbound `https.request` from `remote-server.ts` → "an event with no device connected opens no outbound connection" red (SYN_SENT sockets to 192.0.2.1:443 listed).
  - **one mutation stays green, and that is a finding, not a gap**: the quiet mark skipping `fit()` as well as `focus()`. The terminal's mount-time size sync (`ResizeObserver` + an immediate `sync()` in `TerminalView`) fits a newly mounted terminal on its own, so a skipped activation fit never leaves the pty at 80 columns. Design D4's "otherwise the pty would stay at 80×24" overstated it; the coverage row now names the mutation that does break the scenario (taking focus).
- [x] 7.3 Website, in both languages:
  - `reference/data-and-network.md`: the listener only while remote access is on, paired devices only, no outbound connection from remote access, and `remote.json` plus the TLS key in the data list;
  - `reference/settings.md`: the remote access section;
  - a new `using/remote-access.md`: pairing, revoking, networks (LAN, Tailscale, port forward), the threat model, macOS with no window, and notifications: the phone is told only while its app holds the connection, so nothing arrives when the desktop is unreachable;
  - `site/src/content-plan.json`: the new topic and the data-and-network keywords.

  Verify: `(cd site && npm ci && npm run build)` passes its content check
- [x] 7.4 Update the remaining docs:
  - `CLAUDE.md`'s current state: remote access off by default, the one module that may listen, renderer-mediated quiet actions, the guard changes, and `probe:remote` in the probe list;
  - `docs/lessons/probes.md`: `probe:identity` starts the listener when the real profile has remote access on, and `probe:core` now uses a throwaway profile;
  - `docs/PRD.md`: §5's F9 row, §7, §10 and §11's Phase 8+ say that same-person phone control is back, without a relay or a paid tier; §12's security section gains the remote access trust boundary;
  - `README.md` and `README.zh-TW.md`: mention remote access if they list features.

  Verify: read through
- [x] 7.5 Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run probe:remote`, then `npm run test:e2e`. Verify: all green, and the e2e summary marks every probe complete

  Run 2026-10-14: typecheck, lint and `npm test` (1929) green; `probe:remote` 90/90 (11 sections complete); `test:e2e` 13/14 — every probe complete, `probe:openspec` 289/290 with one red: "[change-view-keyboard] the tab chosen with the keyboard is visible in the tab strip". **The same red on the commit before this change** (a baseline worktree, same section, same detail `scrollLeft 90, selectedVisible false`), and this change touches neither the side panel nor its tab strip; the lockfile only gained `ws`, `@types/ws` and `uqr`. The pre-existing red is not fixed by this change; it is filed as issue #74. Also filed from this run: #75 (`probe-slack` and `probe-intake` exit 0 when assertions fail). `capture:screenshots` (task 1.2's check) captured every spekterm shot; its spek half refused because the local spek checkout is not at a release tag (environment). The regenerated screenshots were restored, not part of this change.
