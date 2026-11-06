---
title: spekterm for Android — Privacy policy
description: What spekterm for Android sends, where it sends it, and what it keeps on your phone.
---

Effective 2026-11-06.

spekterm for Android ("the app") is the companion app of spekterm, the desktop workbench. It is open source:
[github.com/spekhq/spekterm-android](https://github.com/spekhq/spekterm-android). It is available on
[Google Play](https://play.google.com/store/apps/details?id=com.spekterm.android).

**The app sends nothing to its developer.** It has no account, no server of its own, no analytics, no advertising, no
crash reporting and no push service.

## Connections

The app connects to the computer running spekterm that you paired it with, or, while you pair, to the addresses in
the pairing link or QR code you chose. It connects directly — over your local network, Tailscale, or a port you forward —
and that stays its first choice. The connection is encrypted with TLS, and the app accepts only the certificate of the
desktop you paired (its fingerprint comes from the pairing code), so no one in between can read it, including the app's
developer.

**Through your team's server.** Only if your desktop is on a team and you turned on its setting to reach the desktop
through the team server, the desktop gives the app a pass for that server, and the app can also reach the desktop through
it when no direct address works. That server is spekterm-server run by your team, the one your desktop is a member of —
not by the app's developer. The connection to your desktop stays encrypted end to end: inside it, the app still accepts
only your desktop's certificate, so the team's server cannot read or change what passes. The team's server does see your
phone's IP address, when it connects and for how long, how many bytes cross each way, and which pass it used; its logs
record ids, durations and byte counts, not addresses or content. Pairing always happens directly.

## What goes to your desktop

The replies you type, your answers to an agent's questions or permission requests, and the photos, PDFs and text files you
attach go only to that desktop. What happens to them there is decided by your spekterm and the agent tools you run on it:
an AI coding agent may send them to its AI provider, under that provider's terms. Before sending, the app copies an
attachment into its own cache (converting HEIC photos to JPEG); the copy is deleted when the app's process ends. The
desktop sends the app your sessions, conversations, inbox items and OpenSpec files to show you. The app keeps them in
memory while it shows them and does not store them.

## Camera

The camera is used only to read the desktop's pairing QR code. Frames are decoded on the phone and are neither stored nor
sent.

## On the phone

The pairing (the desktop's addresses, its certificate fingerprint and a credential protected by the phone's Android
Keystore), the pass for your team's server if your desktop gave one (protected the same way), a few preferences, and a connection log for troubleshooting stay on the phone. They are excluded from Android
backup and device transfer. The connection log holds connection events, the desktop's addresses and the outcomes of
requests, not the text of messages, names or titles; it leaves the phone only if you share it yourself from Settings.
Unpairing deletes the credential; uninstalling the app deletes everything it stored.

## Links

A link in the content the app shows opens in your browser or another app only when you tap it. The app itself loads no images or
other content from the internet.

## Permissions

| Permission | Why |
|---|---|
| Internet, network state | To connect to your desktop, and to retry when the network changes |
| Foreground service (special use) | To keep the connection to your desktop open, so its notifications reach you; you can pause it from its notification |
| Notifications | To tell you when an agent needs you, a handoff finishes or an inbox item arrives |
| Camera | To scan the pairing QR code |
| Run at startup | To reconnect after the phone restarts |
| `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | Added by the AndroidX library; keeps the app's internal broadcasts private to the app |

## Children

The app is meant for adults who develop software, and is not directed at children.

## Changes

A change to this policy is published on this page with a new date.

## Contact

Open an issue at [github.com/spekhq/spekterm-android/issues](https://github.com/spekhq/spekterm-android/issues), or write
to the email address shown on the app's Google Play listing.
