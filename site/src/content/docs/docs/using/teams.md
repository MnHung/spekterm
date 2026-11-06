---
title: Teams
description: Join your team's spekterm-server with an invite link, so spekterm can hand work to your teammates and receive theirs. What the server sees, how the connection behaves, and what to do when it stops.
sidebar:
  order: 8
---

A **team** is a group of spekterm users who share a small server that the team runs for itself,
[spekterm-server](https://github.com/spekhq/spekterm-server). Being on a team is what lets an agent hand work to a
teammate instead of to one of your own repositories. This page covers joining and the connection; handing work to a
teammate is described in [Handoffs](/docs/using/handoffs/).

The feature is **off** until you turn it on, and spekterm connects to nothing for it until you join.

## Joining

Your team's admin creates an invite on the server and sends you a link that starts with `spekterm://join`.

1. Open **Settings → Team** and turn on **Be on a team**.
2. Paste the link into **Invite link** and choose **Continue**. spekterm asks the server what the invite is for
   — without using it up — and shows the team's name and whether the invite makes you a **new member** or adds
   **this computer** to your existing membership.
3. For a new member, choose a **handle** (1–32 of `a`–`z`, `0`–`9` and `-`; it cannot be changed later) and a
   **display name**. For every invite, name **this device** (your computer's name is filled in).
4. Choose **Join**.

An invite works once and expires (seven days unless your admin chose otherwise). If the handle is taken, choose
another: the invite is still good.

If the invite carries a certificate fingerprint (a server with its own self-signed certificate), spekterm trusts
exactly that certificate. Otherwise it checks the server's certificate the usual way.

## Receiving a teammate's handoff

When a teammate sends you a handoff, it arrives in your [inbox](/docs/using/inbox-and-slack/) marked **Teammate**,
with their display name and your team's name — taken from the server, which knows who sent it, never from the
text. If spekterm is closed, it arrives at the next start. With several devices, it reaches one of them.

It is handled like any inbox item someone else wrote: you read the whole body first, choose the folder, and accept;
the new session's first prompt is filled in and **not sent** until you send it. Its body may be up to 20,000
characters — the same limit as a handoff between your own repositories, longer than other inbox items.

If this device is removed from the team while a handoff was arriving, spekterm still shows it, with a line saying
it may also have reached your other device.

Your teammate follows what happens to it in their **Sent** list ([Handoffs](/docs/using/handoffs/)):

- When the session you opened for it starts working — after you send its first prompt — they see **taken**.
  Accepting alone, or a prompt filled in and not sent, tells them nothing.
- **Decline…** on the inbox item lets you say no, with an optional reason of up to 500 characters that they will read.
  **Ignore** tells them nothing: they keep seeing it as delivered.
- The agent in that session is told that its completion reports go to your teammate. Each report it writes is sent
  to them as **done**, and you get the usual notification. If the team server stops accepting reports for it (for
  example after ten), or you leave the team, spekterm says so in the inbox and with a notification, and the agent's
  next report is refused with that reason.
- An older team server that does not support this shows no **Decline…**, and the agent is not told it can report.

## What the server sees

The server is run by your team, and **its operator can read everything that passes through it**, including
handoffs: nothing is end-to-end encrypted. It keeps your handle, display name, your devices' names, the
team's member list, and each handoff's title and body until it is delivered or expires (after that, only who sent it
to whom, and when). A decline reason or a completion report sent back is kept for 30 days after it was written, and
each handoff's record — who, to whom, when, its status — for 90 days after its last change, so your Sent list can be
rebuilt on another device. See [Data and network](/docs/reference/data-and-network/).

**Your phones, through the server.** If the server offers it, you can let your paired phones reach this computer
through the server when they are away from its network. The server passes their encrypted connection on without
reading it; it sees which phone connects, when, for how long and how much. Off until you turn it on in **Settings →
Team**. See [Remote access](/docs/using/remote-access/#through-your-teams-server).

Your device's credential is given once when you join and is kept in spekterm's secret file on your computer, next to
the Slack credentials. spekterm never puts it in a terminal, an agent's environment, or any file it writes for an
agent. The file is not encrypted: a program running as your user account — an agent with a shell included — can
read it.

## The connection

While the feature is on, spekterm keeps one connection open to the server and reconnects when it drops, waiting
longer between attempts (up to five minutes). **Settings → Team** shows the state: connected, reconnecting (and
when it tries next), or stopped. Turning the feature off closes the connection and keeps your membership.

It **stops**, tells you why, marks **Team** in the Settings list, and sends one desktop notification when only
you can resolve it:

| Stopped because | What to do |
|---|---|
| This device was removed from the team | Your admin revoked it, or removed you. Joining again needs a new invite. |
| Another spekterm is using this device's credential | Two copies of the same profile (for example a restored backup) replace each other. Choose **Reconnect** on the one you want to use. |
| spekterm and the server do not speak the same version | The message says which one is older: update spekterm, or ask your admin to upgrade the server. |
| The server's certificate changed | Ask your admin for a new device invite and paste it. |
| The credential cannot be found on this computer | **Reconnect** reads it again. If it is gone, **Remove from this computer** and ask your admin to revoke the device and send a device invite. |

## Renaming this device, and leaving

While connected, change **This device** and press Enter; the server's answer is what is kept.

**Leave team** checks how many devices you have first and says what will happen: from your last device, leaving
**removes you from the team** and frees your handle; from one of several, only this device leaves. Leaving needs
the connection. Without it, **Remove from this computer** forgets the team here, and the server keeps listing the
device until your admin revokes it.
