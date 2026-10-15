---
title: Remote access
description: Reach spekterm from your phone — see your sessions, read and answer agents, start sessions, and get told when an agent waits for you. Directly, with no relay.
sidebar:
  order: 7
---

Remote access lets the spekterm app on your phone reach spekterm on your computer **directly**: no account,
no relay, no push service. From the phone you can see every folder and session, read an agent's
conversation and reply to it, answer a permission prompt in the terminal, start or wake a session, handle the
inbox, follow your handoffs, and read your OpenSpec changes. You are told when an agent waits for you.

It is **off** until you turn it on.

> **The Android app is in development.** spekterm's side is ready, and the protocol the app is built against
> is in the repository (`docs/remote-protocol.md`).

## What a paired phone can do

A paired phone can do what you can do in a session: read your agents and shells and **type into them**. Agents
have a shell, so treat a paired phone like your keyboard. It cannot edit files outside a session, change
settings, see your Slack connection or any credential, or close and hibernate sessions.

Starting or waking a session from the phone **never takes your desktop away from you**: the session appears in
its folder, but what you are looking at and where you are typing stay as they were.

## Turning it on and pairing

1. Open **Settings** and, under **Remote access**, open the remote access dialog.
2. Turn on **Allow paired devices to connect**. spekterm now listens on the port shown (47615 unless you change
   it) on every network interface.
3. Choose **Pair a device** and scan the QR code with the spekterm app on your phone. The code works once, for
   five minutes, and only while that view is open. The same link is shown as text if you cannot scan it.

The phone stores its own credential; spekterm keeps only a hash of it. The phone checks spekterm's certificate
against the fingerprint in the code, so another computer cannot pose as yours.

## Networks

The phone connects to the addresses in the pairing code, whichever works:

- **The same network** — your computer's local address.
- **Tailscale** — your computer's Tailscale address works as is; add its Tailscale name as the **additional
  address** to have it in the pairing code.
- **A port forward** — forward the port on your router and add your public name (for example a DDNS name) as
  the additional address.

Each time the phone connects, by whatever route works, spekterm tells it the computer's current addresses,
and tells it again if they change while it is connected. A phone app that keeps that list does not need to
pair again when your computer's local address changes: once it has connected some other way (Tailscale, or
the additional address), it has the new local address for next time.

If none of them reaches your computer — away from home, with no Tailscale and no port forward — the phone
cannot connect, and it is told nothing.

## Notifications

The phone learns that an agent waits for you, waits on a choice, finished a handoff, or that a new inbox item
arrived **only over its own connection** to spekterm. To notify you in the background, the app keeps that
connection open, which uses some battery. When the connection drops and comes back, spekterm sends what the
phone missed — the last 24 hours, up to 200 events — or tells it that it may have missed some. Nothing is told
about the session you are looking at on your computer right now.

## Who is connected, revoking, and resetting

- While a phone is connected, a phone icon appears in the activity bar; it opens the dialog.
- The dialog lists your paired devices with when each was last seen. **Revoke** disconnects a device at once and
  refuses it from then on.
- **Reset remote access** creates a new certificate and revokes every device; each must pair again. If its
  private key is ever lost, spekterm resets by itself and says so in the dialog.

## On networks you do not trust

Remote access listens on every network interface. Turn it off on networks you do not trust. Repeated failed
attempts from one address are refused for a minute; someone sharing your phone's public address could delay
its reconnection this way.

## When spekterm runs without a window (macOS)

On macOS, spekterm keeps running after you close its window, and remote access keeps listening. A paired phone
still connects and sees the inbox, but sessions need the window: the phone is told there is none, and spekterm
does not open one for it.
