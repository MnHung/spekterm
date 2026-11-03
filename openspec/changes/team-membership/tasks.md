## 1. Invite link and membership store (main process)

- [x] 1.1 `src/main/team-invite.ts`: parse the link per spec (scheme, `v=1`, `wss:` host and optional port, no user
  information, path only empty or `/` and normalized away, no query/fragment, base32 code, optional 64-hex `fp`,
  duplicate parameters refused, surrounding whitespace trimmed); unit tests with one case per rule and a control for
  each (loosen the rule ⇒ red)
- [x] 1.2 `src/main/team-store.ts`: `team.json` as in D4 (with `stop` and `leaving`) — versioned, whole-file write
  to a temporary name then rename, file first then memory, quarantine of a damaged file; `setMembership` as the only
  writer of `server`; unit tests: round trip, a damaged file is set aside and reads as no membership, a failed write
  leaves memory unchanged (control: assign first ⇒ red)
- [x] 1.3 Secret name `team.deviceSecret`; discarding order (`team.json` with `stop` and the device's name, then the
  secret, then the extension point) in one function; a secret without a membership removed at startup; a membership
  whose secret cannot be found becomes the stop `CREDENTIAL_UNAVAILABLE` (membership kept, Reconnect re-reads the
  secret store, Remove from this computer), and with `leaving` completes the leave quietly; unit tests of the order,
  of an interruption between the writes, and of the missing-secret case including a store that failed to read
  (control: send `hello` without a secret ⇒ a revocation notice ⇒ red)

## 2. Connection (main process)

- [x] 2.1 `src/main/team-connection.ts`: TLS connect; pinned verification on `secureConnect`, unpinned with `ca` =
  `getCACertificates('default')` + `('system')` and the host as `servername`; SNI rule; `ws` over the verified socket
  via `createConnection`; the URL `<address>/connect` without a doubled slash; frame codec; request ids and the 15 s
  answer timeout; the 20 s connect deadline; the 75 s ping watchdog; `terminate()` for every end spekterm decides; a
  generation number on every event; client frame bound (256 KiB) and accepted bound (1 MiB) with the `ws` error code
  reported; unknown event kinds ignored; `deviceSecret` wrapped in `Secret` while parsing the join answer; no raw
  frame logged; `reveal()` only where `hello` is built
- [x] 2.2 Unit tests against a throwaway local TLS + `ws` server: pin match connects; pin mismatch sends no
  application data (the server records 0 bytes after the handshake) — control: verify in `upgrade` instead ⇒ red;
  unpinned trusted through `NODE_EXTRA_CA_CERTS` in a child process connects and an untrusted certificate fails;
  `getCACertificates` available in the repo's Node (or the test says why it is skipped); no answer ⇒ timeout; a
  silent server ⇒ connect deadline; no pings ⇒ watchdog; an oversize incoming frame is reported as the bound, not as
  a plain 1006; an oversize outgoing frame is refused locally; the secret appears in no console output or error
  message of a join (control: log the raw answer ⇒ red)
- [x] 2.3 `src/main/team-service.ts`: the state machine of D3 with one exhaustive `switch` from (recorded pre-auth
  error, close code, TLS/network failure, timeout, own size bound) to retry / stop / discard; the recorded pre-auth
  error decides by itself; post-auth `AUTH_FAILED` does not discard; events of an older generation ignored; backoff
  with jitter reset after 60 s authenticated; `powerMonitor` `resume` terminates and reconnects; Reconnect; on/off;
  the extension points `onEvent(kind)`, `request(op, params)` gated by `operations`, `onCredentialDiscarded`,
  `onState(state)` (entering and leaving `connected`), `onMembers(list)`, `operations()`, `membership()` (the current
  server and member, or none) and `refreshMembers({ maxWaitMs })` (throttled by the service, which keeps the list)
- [x] 2.4 Unit tests: one case per row of the spec's table, plus a guard that every protocol close code and error
  code is mapped and the `switch` has no `default` (in the style of `scripts/rejection-exhaustive.test.mjs`);
  `BAD_PARAMS` before auth stops; an error followed by a 1006 within the second still decides; an abandoned
  connection's late close changes nothing (control: drop the generation check ⇒ a third `hello` ⇒ red); backoff
  grows when every connection fails right after `hello` (control: reset on `hello` ⇒ red); `resume` reconnects a
  connected state; 4006 makes no further attempt; a stop is notified once and not again at the next start
- [x] 2.5 Inspect and join (D5): inspect on its own connection and terminated; join on a new one that becomes the
  device's connection; credential written secret-then-membership before success is reported; a failed write sends
  `device.leave` on that connection and leaves no membership; a lost join answer is shown and not retried; `INTERNAL`,
  network/TLS errors and timeouts shown; a pin mismatch on the first connection worded as "the invite does not match
  its server"; a device invite joined while a stopped membership is held replaces it; unit tests for each, including
  `HANDLE_TAKEN` keeping the invite usable
- [x] 2.6 Rename, leave (`leaving` written before `device.leave`; a later 4004 or `AUTH_FAILED` completes it quietly,
  also after a restart; the device-count sentence from a `team.members` fetched when the user presses Leave) and Remove from this computer;
  members fetched after join/hello, on showing the section, and every 15 minutes while connected, normalized with
  `normalizeAuthored`, kept with `fetchedAt`; unit tests
- [x] 2.7 Version (D9): offer `[1]`; which side is older from `detail.supported`; the stop lasts until Reconnect or a
  different spekterm version; unit tests
- [x] 2.8 The stop notification (D10): its own notification backend instance and probe stub, held until closed, team
  name normalized and reduced; activation through its own IPC channel opens Settings on Team, closing the inbox first

## 3. IPC, preload, renderer

- [x] 3.1 `src/main/ipc/team.ts`: get (field-by-field projection, D8), set enabled, inspect, join, rename, leave,
  remove locally, reconnect; state pushed on change; wire the service in `src/main/index.ts` (start after the secret
  store loads; dispose at quit)
- [x] 3.2 Preload `team` namespace with the narrowed projection type; a projection guard in the style of
  `scripts/settings-projection.test.mjs` (no `deviceId`, no secret; control: add a field ⇒ red)
- [x] 3.3 `src/renderer/src/shell/settings/sections/TeamSection.tsx`: the switch with the operator sentence; the
  paste field with Continue, the inspect result, the member/device form with the handle rule, Join; the joined view
  (team, member, device name field per the save model, server address, members with "you", state line with next
  attempt, Reconnect, Leave with its confirmation, Remove from this computer, paste a new invite after a revocation
  or a changed certificate); refusals and failures by code in the user's language
- [x] 3.4 `SettingsDialog.tsx`: the Team section between Integrations and Remote access, and its failure marker while
  stopped
- [x] 3.5 Dictionary strings in `en.json` and `zh-TW.json` (every refusal code, every stop, retry and join failure
  reason, the lost-credential message, the two leave sentences, the operator sentence, the handle rule);
  `aria-label`s from the dictionary; no shell-quote characters in labels the probe selects by

## 4. Guards

- [x] 4.1 `scripts/network-surface.test.mjs`: file-scoped `tls` and `ws` modules and the `WebSocket` API entry for
  `src/main/team-connection.ts`, with the data-and-network page revisited (task 6.1)
- [x] 4.2 `scripts/secret-scope.test.mjs`: add `team-connection.ts` to the `reveal()` allow-list with its reason; pin
  `TeamStore.setMembership`'s only caller to `team-service.ts`'s join path and that path's only caller to
  `ipc/team.ts`, with a control for each
- [x] 4.3 Run `scripts/server-source.test.mjs` (a client creates no server) and the `secret-scope` child-environment
  test with a stored team secret

## 5. Probe

- [x] 5.1 `scripts/lib/stub-team-server.mjs`: TLS WebSocket server with a self-signed certificate; inspect, join,
  hello, rename, leave, members; scriptable answers, errors, closes (1006, 4004, 4006, 4003 after an error), silence,
  dropped answers and `UNSUPPORTED_VERSION`; records every frame and every byte received
- [x] 5.2 `scripts/probe-team.mjs` and `npm run probe:team`, its port in `scripts/lib/ports.mjs`, entry in
  `scripts/run-probes.mjs`, the UI language seeded on its launch path (`probe-language.test.mjs`); sections: a
  membership with the feature off opens nothing; invalid links (http, path, userinfo) refused without a connection;
  member and device invite flows; taken handle; lost join answer; pinned join; an invite whose pin does not match;
  rename survives restart; reconnect after a drop; an abandoned connection's late close; 4004 discards and notifies
  once; a membership without its secret is not a revocation; 4006 stops and Reconnect works; version mismatch names
  the older side; leave sentences for one and two devices; a leave whose answer was lost completes quietly; members
  shown offline after a restart; the renderer's team state never contains the secret (IPC payload and DOM); an outbox
  file and an inbox delivery naming another server address change nothing
- [x] 5.3 Control groups for the probe's key assertions (pin check moved after the upgrade; 4006 retried; leave
  without the count; generation check removed) in the style of `scripts/intake-control-groups.mjs`
- [x] 5.4 Run `probe:shell` (no connection at startup) and `probe:workspace` (Settings sections) for regressions

## 6. Docs

- [x] 6.1 Website, both languages: the data-and-network page (the team server paragraph, and "where your data is
  stored" / "everything spekterm keeps is on your machine" qualified for what the server keeps), the settings
  reference (the Team section), a new Teams page under "Using" (joining, leaving, what the operator can read,
  troubleshooting by stop reason), sidebar entries
- [x] 6.2 `README.md` and `README.zh-TW.md`: the feature list
- [x] 6.3 `docs/PRD.md`: §7.6 items 2–3, §7.7 item 7, §10, Phase 8+, the F9 row and §14 — the 2026-09-29 decision
  ruled out a paid, hosted, same-person relay; a free, self-hosted server between people is in scope (spekterm-server)
- [x] 6.4 `CLAUDE.md`: a Team line in 現況; the rule "`remote-server.ts` is the only module that may create a server
  or import `https`/`ws`" restated (it creates the only server; `team-connection.ts` is the only client importing
  `tls`/`ws`); `probe:team` in the probe list and the probe count; a trigger row for `docs/lessons/team.md`
- [x] 6.5 `docs/lessons/team.md`: the D2 measurement (review run and the in-Electron result), `ws`'s 30 s close and
  why spekterm terminates, `ws`'s 1006 for its own size bound, the CA list, the 4006 reasoning, and anything that
  failed silently while building this

## 7. Verification

- [x] 7.1 Register `team-membership` in `scripts/scenario-coverage.test.mjs`'s `COVERED_CHANGES` and fill one row per
  scenario with its carrier, `greenIfAbsent` and `mutation`, each carrier looked up, not recalled
- [x] 7.2 `npm run typecheck`, `npm run lint`, `npm test` green
- [ ] 7.3 `npm run probe:team` complete and green; `npm run test:e2e` before archiving
- [ ] 7.4 Dogfood against a local spekterm-server 0.2.1 (with `protocol-clarifications`) with a self-signed certificate (`docs/self-hosting.md` §2b):
  member invite, device invite on a second profile, rename, admin revoke while connected and while closed, leave from
  one of two devices and from the last; note anything the stub does differently in `docs/lessons/team.md`
