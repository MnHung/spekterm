## Why

A paired phone reaches spekterm only directly: on the desktop's network, over Tailscale, or through a port forward.
Away from those, remote access does not work. spekterm-server 0.4.0 (its change `phone-relay`) can now splice a
member's phone to that member's own desktop without reading the bytes. The user decided (2026-11-06) that direct
access stays the default and that, for a desktop on a team, the team server's blind relay is an optional second path
— not a replacement, and with no push.

The server side is done and its protocol fixed (spekterm-server `docs/protocol.md` §5, §10, §13; design D9 lists
what the desktop must do). The Android app's change depends on how the desktop hands a phone its grant, so that field
is defined here first.

## What Changes

- **A setting** in Settings → Team, "Reach this desktop from your phones through the team server", off by default.
  Shown when the last authentication's `operations` list `relay.grant` and remote access is on, and always while it
  is on (so it can be turned off).
- **Grants**: with the setting on, the desktop asks the team server for one relay grant per paired phone, keeps each
  grant's id and secret in the secret store bound to the membership and the phone, revokes a grant when its phone is
  unpaired, the setting is turned off or remote access is reset, and reconciles with `relay.grants` after every
  `hello`. Leaving the team or losing the membership forgets them (the server deleted them with the device).
- **Remote protocol, additively**: the `hello` answer carries `relay: { url, fp?, grant, secret }` when the desktop
  holds a grant for that phone, and a new `relay.changed` event `{ relay: Relay | null }` tells a connected phone when
  its grant appears, changes or goes away. Only to that phone's own authenticated connections.
- **Tunnels**: a `relay.incoming` from the team server is refused (`relay.refuse`) unless the setting and remote
  access are on, the listener is listening, and the grant is one this desktop holds and has given to a phone that is
  still paired. Otherwise `team-connection.ts` opens the desktop leg to `/relay` on **the membership's own server**,
  with the same certificate check before any byte, sends `relay.accept`, and hands the byte stream — every write cut
  into messages of at most 64 KiB — to the remote access listener as one more incoming connection.
- **Relayed connections** go through the listener's TLS, upgrade, authentication, limits and pings, with these
  differences: they accept `hello` only, never `pair`, and only with the credential of the phone the grant was made
  for; their failures are throttled per grant (`relay:<grant>`), since a relayed connection has no address of its own;
  and, because a server that never listens enforces no HTTP timeouts, the listener keeps its own deadline for a
  relayed connection until it is upgraded.
- **What the app states about itself changes**: CLAUDE.md, `docs/remote-protocol.md`, `docs/PRD.md`, the README and
  the website's "Data and network" page say that, with the setting on, the desktop opens a connection to the team
  server when one of its phones asks for it. Attention events still travel only over the phone's own connection, and
  there is still no push.

## Capabilities

### New Capabilities

- `phone-relay`: the desktop side of reaching a paired phone through the team server — the setting, the grants'
  lifecycle and storage, accepting or refusing a tunnel, the desktop leg, and how a relayed connection is admitted.

### Modified Capabilities

- `remote-access`: failures of a relayed connection are throttled per grant, not per address; pairing is refused on
  a relayed connection.
- `remote-protocol`: the `hello` answer's `relay` field and the `relay.changed` event, and the protocol document
  stating them.
- `remote-notifications`: attention events still go only over a device's own connection, which may now be a relayed
  one the desktop dialed at the phone's request; the desktop opens no connection for an event.
- `secret-scope`: a relay grant's secret goes only to the phone it was made for, over that phone's authenticated
  connection; the device secret goes to the team server in `relay.accept` as well as `hello`.
- `project-website`: the data and network page states the relay.
- `team-membership`: one `/connect` connection plus a relay leg per accepted tunnel; the device credential also goes
  in `relay.accept`; a leg is held to the same certificate rule, on `/relay`.

## Impact

- **Code**: `src/main/team-connection.ts` (the desktop leg, cutting writes), `src/main/remote-server.ts` (accepting a
  handed-over stream, per-grant throttle key, no `pair` on it, the `relay` field), `src/main/remote-service.ts`
  (`relay.changed`), a new Electron-free `src/main/relay-grants.ts` (the grant store) and `src/main/relay-service.ts`
  (the setting, the reconcile, `relay.incoming`), `src/main/team-store.ts` (the setting),
  `src/main/team-projection.ts`, `src/main/index.ts`, `src/main/ipc/team.ts`, the preload, `TeamSection.tsx`, both
  dictionaries.
- **Guards**: `scripts/network-surface.test.mjs` and `scripts/server-source.test.mjs` unchanged (no new import or
  server-creating module); `scripts/secret-scope.test.mjs`'s reveal allow-list gains `relay-grants.ts`.
- **Docs**: `docs/remote-protocol.md` (§4, §6, §2's "nothing in between", the throttle, obligations), CLAUDE.md
  (Remote access, Teams), `docs/lessons/team.md`, `docs/PRD.md`, README (both languages), website docs in both
  languages (data and network, remote access, team, settings reference), `remote-notifications`' Purpose.
- **Other repositories**: spekterm-android builds on the `relay` field and event (already told the shape);
  spekterm-server unchanged. Real-device measurement through the NAS is spekterm-server's task 7.3, after Android.
- **No new dependency.**
