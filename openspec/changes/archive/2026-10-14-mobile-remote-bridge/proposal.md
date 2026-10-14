## Why

Away from the desk, the maintainer reaches their running agents through Claude Code's Remote Control, one
session at a time. It sees none of what spekterm adds: the sessions of every repo in one place, the inbox
and handoffs, the OpenSpec side panel. It also says nothing when an agent starts waiting. A companion
Android app (a separate repository, written in Kotlin, published on Google Play) can cover all of this if
spekterm lets a phone the user paired reach it directly. Nothing in between: no relay server run by
anyone, and no push service. Firebase Cloud Messaging (FCM) needs a Firebase project's server key, which an
open-source desktop app cannot hold without a relay. UnifiedPush avoids that but makes the user install a
separate distributor app, which the project will not ask of users. A relay would put a third party in the
path. The project rejected all three, and accepts that the phone spends battery holding its connection.

PRD §10 / §11 dropped "remote approval from a phone" in 2026-09 as covered by first-party tooling. Daily
use says otherwise. This change brings back the same-person part of it, with no paid tier and no relay.

## What Changes

- **Remote access (off by default).** When the user turns it on, spekterm listens for WebSocket
  connections over TLS on a port the user can set, on all network interfaces. The phone reaches it however
  the user's network allows: the same LAN, Tailscale, or a router port forward. spekterm itself does not
  care which.
- **Pinned identity, no certificate authority.** spekterm generates a self-signed certificate once and
  keeps it. The phone trusts exactly that certificate, identified by its SHA-256 fingerprint.
- **Pairing by QR code.** Pairing shows a QR code with the addresses, the port, the certificate's
  fingerprint and a single-use pairing code that expires after a few minutes. A device that pairs gets its
  own long-lived credential, and spekterm stores only a hash of it. The user sees the paired devices and
  revokes any of them; revoking closes that device's connections at once. "Reset" replaces the certificate
  and revokes every device.
- **A paired device has the user's power over agents, stated as such.** It can type into a session the
  same way the keyboard can. The controls are pairing and revocation, plus an indicator on the desktop
  whenever a device is connected.
- **An allow-list of remote operations** that reuse what the desktop already does:
  - the folder and session list, with each session's running, waiting, and handoff state;
  - the conversation view of an agent session (the same transcript stream), and replying to it under the
    same rules as the desktop;
  - a session's terminal output as text, plus input keys, which is how a permission prompt is
    answered today;
  - starting an agent or shell session in a folder, and waking a dormant session. Both go through the
    desktop's interface, which owns the session list;
  - the inbox: listing, accepting into a folder the user picks, and ignoring;
  - the state and brief of each handoff;
  - read-only OpenSpec changes, artifacts and specs.

  Anything not on the list is rejected: the file tree and editing, settings, Slack, and credentials.
- **Streams resume cheaply after a dropped connection.** Every stream begins with a snapshot. A
  reconnecting client names the last entry or terminal position it has. spekterm sends only what follows when it
  still holds that, and a fresh snapshot otherwise. A gap is never presented as complete.
- **Attention events over the device's own connection.** "An agent is waiting for you", "an agent is
  waiting on a choice", "a handoff finished" and "a new inbox item":
  - reach a connected device as events. To notify in the background, the Android app keeps its connection
    open in a foreground service; nothing else carries them;
  - are held for a while (the last 24 hours, up to 200, only while remote access is on), so a phone that
    reconnects receives what it missed, or is told it may have missed some;
  - have agent-controlled and third-party text reduced before they are sent.
- **The protocol is written down** in the repository (`docs/remote-protocol.md`). The Android app is built
  against it.

## Capabilities

### New Capabilities

- `remote-access`: the listener and its lifecycle, the TLS identity and its fingerprint, pairing, per-device
  credentials and revocation, connection limits, the threat model, the desktop's remote access interface and
  connection indicator, and behavior while the application has no window.
- `remote-protocol`: the frame format and version negotiation, the allow-list of operations and how each
  maps onto existing behavior, snapshot-and-resume streams, actions carried out through the desktop's
  interface, and errors.
- `remote-notifications`: attention events, when they fire and when they are suppressed, that they travel only
  over a device's own connection, how a reconnecting device recovers missed ones, and text reduction.

### Modified Capabilities

- `terminal-preferences`: the Settings interface gains a remote access section (its state and the way into
  the remote access dialog).
- `project-website`: the data and network page must state the remote access listener (off by default, and
  what can connect when it is on), and that remote access makes no outbound connection of its own.
- `session-hibernation`: a session a paired device is watching counts as displayed, so automatic
  hibernation does not end it under the user's eyes.

Checked and unchanged:

- `spek-core-integration`: "the scan does not go through HTTP or IPC" keeps its wording. `probe:core`
  still asserts that no process listens during its run. That assertion only holds because `probe:core` moves to a
  throwaway profile: today it runs on the user's real one, where remote access may be on. The source-text guard, "no server anywhere in `src/main`", narrows to "only the remote access module
  creates one".
- `workspace-app-shell`:
  - "The app's own code connects only where its allow-list says" already requires every new network module
    and API to be listed. This change lists them, scoped to the files that use them.
  - Its rule that "an action that targets the window while none exists first opens one" is not changed.
    `remote-protocol` states the deliberate exception for actions requested from a phone.
- `secret-scope`:
  - The new private key (the TLS key) lives in the existing secret store and is never sent anywhere.
  - Device credentials are stored only as hashes.
  - The pairing code is the one remote-access secret the renderer shows. That is its purpose, and it
    expires.
  - The guard's `reveal()` allow-list gains the modules that use the key.
- `agent-intake`:
  - Its notification rules govern the desktop's own notifications, which do not change. A phone's
    notifications are built by the Android app from attention events, under `remote-notifications`.
  - Its human check, that the body is read before acceptance, becomes an obligation the protocol document
    places on the client. It cannot be verified from this repository.
- `agent-input-bridge`: replying from a phone obeys the same wait-state rules. The rules are not changed.
- `session-persistence`: the renderer remains the authority on the session list. Remote actions that create
  or wake a session, or accept an inbox item, are carried out by it. They are "quiet": they never take
  keyboard focus or replace the displayed session.

## Impact

- **Main process (new):**
  - the server, on `https` + `ws`;
  - self-signed certificate generation with `node:crypto` (no certificate library);
  - pairing and device store (`remote.json`);
  - the protocol dispatcher and its allow-list;
  - a per-session output ring buffer (only while remote access is on);
  - attention-event derivation, with a short in-memory log for reconnecting devices.
- **Main process (touched):**
  - `index.ts` wiring and quit handling;
  - inbox broadcasting, unified into one hook so desktop and remote changes reach both;
  - the hibernation tracker, which treats a watched session as displayed;
  - wait-state draining, which reports a completed turn;
  - `terminal.ts`, which gains an output tap and the pty size;
  - the transcript follower, which gains a non-renderer consumer;
  - the desktop's intake accept flow, extracted so the phone's accept runs the same steps;
  - window focus and the displayed session, used for suppression.
- **Renderer:**
  - a remote access dialog (QR code, pairing link, devices), a Settings section, and a connection indicator;
  - a resident handler for remote create, wake and accept requests;
  - `sessions.create` gains a quiet mode, and `TerminalView`'s first-active focus respects it;
  - the desktop's accept flow is extracted from `IntakeOverlay` so both sides use it;
  - `wake()` returns an outcome.
- **Dependencies:** `ws` (runtime, so it goes in `dependencies`) and a small QR encoder for the renderer.
  Everything else is built in.
- **Guards:**
  - `network-surface.test.mjs` gains entries: `https` and `ws`, for the listener only.
  - `probe:core`'s server text guard moves to a unit test that allows one file, and `probe:core`
    runs on a throwaway profile.
  - `network-surface`'s module allow-list gains file-scoped entries.
  - `secret-scope.test.mjs`'s `reveal()` allow-list grows.
  - `probe:shell`'s preload whitelist grows.
  - `ports.mjs` registers the new probe and its listener ports.
  - `scenario-coverage.test.mjs` registers this change.
- **Probes:**
  - the stub agent gains unique record ids and timestamped input receipts;
  - a new `probe:remote` acts as the phone. It talks to the real listener through a client that pins the
    certificate.
  - `test:e2e` gains it.
- **Docs:**
  - `docs/remote-protocol.md` (new);
  - the website's data and network page, the settings reference, and a new remote access page, all in
    both languages;
  - PRD §10 / §11 / §12;
  - CLAUDE.md's current-state section.
- **Out of the repository:** the Android app is a separate repository and is not part of this change.
