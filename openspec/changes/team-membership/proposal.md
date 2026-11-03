## Why

spekterm-server (a separate repository, `spekhq/spekterm-server`, protocol version 1 in its `docs/protocol.md`) lets
a team run a small self-hosted server so that spekterm users can hand work to each other. Its milestones M0 (team,
invites, device credentials, the connection) and M1 (sending and receiving handoffs) are done on the server, but
spekterm has no client for it, so nobody can use it. This change is the first half of the spekterm side: being on
a team — joining with an invite link, keeping a device credential, holding the connection, renaming the device,
leaving. The second half, handing work to a teammate and receiving it, is the change `teammate-handoff`, which
builds on this one.

It also revises spekterm's own PRD: the relay ruled out on 2026-09-29 was a paid, hosted relay for the same
person across machines; a free, self-hosted server between different people is now in scope
(spekterm-server PRD §2.3 and §10).

## What Changes

- **Settings gains a Team section**, off by default. Turned on, it lets the user paste an invite link
  (`spekterm://join?v=1&s=<wss address>&c=<code>[&fp=<fingerprint>]`), see what the invite is for (the team's
  name, and whether it joins a new member or adds a device to an existing one) before committing, and join —
  asking for a handle and a display name only for a new member's invite. Once joined it shows the team, the
  member, this device's name (editable, `device.rename`), the server address, the connection's state, the team's
  members, and **Leave team**, which says beforehand whether leaving removes the user from the team (their last
  device) or only this device.
- **A device credential**, given once by the server at join, is kept in spekterm's secret store. It never reaches
  the renderer, a terminal, an agent's environment, or any file spekterm writes for an agent.
- **One outbound WebSocket over TLS** to the server, opened only while the feature is on and the device has a
  credential, reconnected with backoff. Whether to reconnect follows the protocol's close codes and pre-auth error
  codes: a revoked device discards its credential and stops; a connection replaced by another use of the same
  credential stops; a version mismatch stops and says which side is older; a certificate that no longer matches
  the invite's pin stops and says a new invite is needed. Nothing is sent before the server's certificate is
  verified.
- **A stop that needs the user** (revoked, replaced, version mismatch, certificate changed) is shown in the Team
  section, marks the section in the Settings list, and sends one desktop notification.
- **The team's members** are fetched on each connection and kept, so the next change can tell agents whom they
  can hand work to while offline.
- **This is the first long-lived outbound connection spekterm opens by itself.** The network allow-list gains the
  one module that makes it, and the website's "Data and network" page states it in both languages.
- **The PRD is revised** (§7.6, §7.7 item 7, §10, Phase 8+, F9, §14) to say what was ruled out and what is now in
  scope.

## Capabilities

### New Capabilities

- `team-membership`: being on a spekterm-server team — the invite link, inspecting and joining, the device
  credential and where it may go, the connection and when it reconnects or stops, version negotiation, the device
  name, leaving, the members list, and how the state is shown.

### Modified Capabilities

- `secret-scope`: "機密只送往它所屬的那個服務" allows `wss:` for a WebSocket service, and the team server's
  address is written only by the user's join.
- `project-website`: "The documentation states the app's network behavior" names the team server connection: off
  by default, only to the address from the invite the user pasted, what it carries, and that the operator can read
  what passes through it.
- `terminal-preferences`: "偏好設定介面" lists a Team section (between Integrations and Remote access);
  "A change in Settings applies when it is made" gains a third exception, the invite link, which applies only
  through its own controls.

Checked and unchanged: `workspace-app-shell` ("The app's own code connects only where its allow-list says" is
generic; only the allow-list's entries change), `remote-access` / `remote-protocol` (the listener is untouched;
nothing of the team reaches a paired device in this change), `terminal-preferences`' "Each section restores its own
defaults after a confirmation" (the Team section has no defaults to restore; Leave is its own control, as
Integrations and Remote access have their own resets — the requirement already names only two sections).

## Impact

- **Main process (new)**: `src/main/team-invite.ts` (link parsing), `src/main/team-store.ts` (the membership file),
  `src/main/team-connection.ts` (TLS, pinning, frames — the only module that imports `tls` and the `ws` client),
  `src/main/team-service.ts` (lifecycle, reconnect, operations), `src/main/ipc/team.ts`.
- **Main process (changed)**: `src/main/index.ts` (wiring), `src/main/secret-store.ts` callers (a new secret name),
  the notification backend for the stop notice.
- **Preload / renderer**: a `team` namespace in the preload; `settings/sections/TeamSection.tsx`;
  `SettingsDialog.tsx` (the section and its failure marker); dictionary strings in `en.json` and `zh-TW.json`.
- **Guards**: `scripts/network-surface.test.mjs` (file-scoped `tls` and `ws` for `team-connection.ts`),
  `scripts/secret-scope.test.mjs` (the `reveal()` allow-list, the server address's only writer), the settings
  projection guard pattern for the team projection.
- **Probes**: a new `probe:team` with a stub team server (`scripts/lib/stub-team-server.mjs`), registered in
  `scripts/lib/ports.mjs` and `scripts/run-probes.mjs`.
- **Docs**: `docs/PRD.md`, `CLAUDE.md` (status, the "only `remote-server.ts` imports `ws`" rule), a new
  `docs/lessons/team.md` trigger row, the website's data-and-network, settings and a new Teams page in both
  languages.
- **Dependencies**: none new (`ws` is already a dependency; `tls` is built in).
