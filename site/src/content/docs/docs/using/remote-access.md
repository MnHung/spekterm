---
title: Remote access
description: Reach spekterm from your phone — see your sessions, read and answer agents, attach photos and files, answer their prompts, start, rename, hibernate and close sessions, answer an agent that asks to close its own, and get told when an agent waits for you. Directly, with no relay.
sidebar:
  order: 7
---

Remote access lets the spekterm app on your phone reach spekterm on your computer **directly**: no account,
no relay, no push service. From the phone you can see every folder and session, read an agent's
conversation and reply to it, attach photos and files to a reply, answer an agent's permission prompts and
questions, start, wake, rename, hibernate or close a session, handle the inbox, follow your handoffs, and read your OpenSpec
changes. You are told when an agent waits for you.

It is **off** until you turn it on.

> **The Android app is in development.** spekterm's side is ready, and the protocol the app is built against
> is in the repository (`docs/remote-protocol.md`).

## What a paired phone can do

A paired phone can do what you can do in a session: read your agents and shells and **type into them**. Agents
have a shell, so treat a paired phone like your keyboard. It cannot edit files outside a session, change
settings, or see your Slack connection or any credential. The only files it can put on your computer are
attachments, and only into spekterm's own data folder, under names spekterm chooses.

### Hibernating and closing from the phone

The phone can hibernate a session (its process ends; it stays in place and you wake it later) or close it
(it leaves your workspace). Neither takes your keyboard focus or changes your selection on the computer. If a
session is busy — an agent working or waiting on your choice, a command running in a shell, or spekterm cannot
tell — the phone is told why first and asks you before ending it anyway.

When an agent asks to close its own session, spekterm offers it to you instead of closing it ([Handoffs](/docs/using/handoffs/)),
and the phone shows the same offer with **Close** and **Keep**. Answering on either side answers it on both: keeping it
on the phone removes the offer from the computer, and keeping it or typing into the session on the computer removes it
from the phone. The phone tells you an agent is waiting when its turn ends, as for any turn; the offer itself shows on
the session.

### Answering prompts from the phone

When an agent asks permission or asks you a question, the phone shows it and can answer:

- **A permission prompt**: allow it once, or deny it. Allowing is offered for running commands, editing,
  writing and reading files, and fetching web pages — the prompts whose first option is a one-time "Yes". The
  "always allow" options are not offered; use the terminal for those.
- **A question** the agent asks with choices: pick the options.
- **A plan** the agent wants to carry out: read it, then approve it (asking before each edit, or with auto
  mode) or deny it to keep planning.

spekterm presses the keys you would press, one at a time, and never sends text or Enter into a prompt. Before
each key it checks that the prompt is still the same one and still open. The phone cannot answer when more than
one prompt is waiting, or once you typed into that session on your computer; answer those on the computer.

### Attaching files

A reply from the phone can carry photos, screenshots, PDFs and text files (up to 10 per reply, 10 MB each).
spekterm keeps them in its own data folder and tells the agent where they are; the agent reads them without a
permission prompt. They are deleted when you close the session, and after 30 days at the latest.

### Renaming a session

Renaming from the phone works as on the computer: an empty name gives the session back its agent's title.

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
