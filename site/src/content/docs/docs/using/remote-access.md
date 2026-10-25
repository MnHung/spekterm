---
title: Remote access
description: Reach spekterm from your phone, directly, with no relay. See your sessions, read and answer agents, attach photos and files, answer their prompts, start, rename, hibernate and close sessions, answer an agent that asks to close its own, and get told when an agent waits for you.
sidebar:
  order: 7
---

Remote access lets the spekterm app on your phone reach spekterm on your computer **directly**: no account,
no relay, no push service. From the phone you can:

- see every folder and session;
- read an agent's conversation and reply to it, with photos and files attached, see what each tool call did, and open
  the files the agent sends you;
- answer an agent's permission prompts and questions;
- start, wake, rename, hibernate, or close a session;
- handle the inbox and follow your handoffs;
- read your OpenSpec changes.

You are told when an agent waits for you.

It is **off** until you turn it on.

> **Get the Android app on [Google Play](https://play.google.com/store/apps/details?id=com.spekterm.android).** It is open source
> ([spekhq/spekterm-android](https://github.com/spekhq/spekterm-android)), and the protocol it is built against is in
> this repository (`docs/remote-protocol.md`).

## What a paired phone can do

A paired phone can do what you can do in a session: read your agents and shells, and **type into them**.
Agents have a shell, so treat a paired phone like your keyboard. The phone cannot edit files outside a
session, change settings, or see your Slack connection or any credential. The only files it can put on your
computer are attachments, and only into spekterm's own data folder, under names spekterm chooses. The only
files it can read, besides your OpenSpec changes, are the ones an agent sent you: whatever the agent sent,
the phone can open. Images in a conversation are read from the conversation's record, never from a file.

### Background work

An agent can leave work running after its turn ends: a background subagent, a background command such as a
dev server or a test run, or a monitor. The phone can list that work under the session, each with the
agent's own one-line description. A session that has finished its turn but still has work running then does
not look idle. The list is what the agent last reported. It is updated when the agent's turn ends and when
one of its subagents stops, and it is cleared when the session's process ends.

### Hibernating and closing from the phone

The phone can hibernate a session (its process ends, and the session stays in place for you to wake later)
or close it (it leaves your workspace). Neither takes your keyboard focus or changes your selection on the
computer. A session may be busy: an agent is working or waiting on your choice, a shell is running a
command, or spekterm cannot tell. The phone is then told why, and asks you before ending the session anyway.

When an agent asks to close its own session, spekterm offers the close to you instead of closing it
([Handoffs](/docs/using/handoffs/)). The phone shows the same offer with **Close** and **Keep**, and an
answer on either side counts for both. Keeping the session on the phone removes the offer from the computer.
Keeping it on the computer, or typing into the session there, removes the offer from the phone. As with any
turn, the phone tells you the agent is waiting when its turn ends; the offer itself shows on the session.

### Answering prompts from the phone

When an agent asks permission or asks you a question, the phone shows it and can answer:

- **A permission prompt**: allow it once, or deny it. Allowing is offered for running commands, editing,
  writing and reading files, and fetching web pages: the prompts whose first option is a one-time "Yes".
  The "always allow" options are not offered; use the terminal for those.
- **A question** the agent asks with choices: pick the options.
- **A plan** the agent wants to carry out: read it, then approve it (asking before each edit, or in auto
  mode), or deny it so the agent keeps planning.

spekterm presses the keys you would press, one at a time, and never sends text or Enter into a prompt.
Before each key, it checks that the same prompt is still open. The phone cannot answer when more than one
prompt is waiting, or after you have typed into that session on your computer. Answer those on the
computer.

### Sending an inbox item's prompt from the phone

Accepting an inbox item on the phone opens its session on the computer, just as accepting it there does:
the first prompt is typed in and **not sent** ([Inbox and Slack](/docs/using/inbox-and-slack/)). A phone
app that supports this then shows the waiting prompt together with the item's full text. It sends the
prompt only when you tap send, and spekterm then presses `Enter` for you, nothing more. Until then, any
reply from the phone to that session is refused, so a reply can never go out together with a prompt you
have not read. If you typed into that session on the computer, finish it there.

### Replying from the phone

When you reply from the phone, spekterm tells the agent that you sent the message from your phone and will
read the answer there, so the agent keeps its answer short and easy to read on a small screen. That note
travels alongside your message, not inside it: your message is sent exactly as you wrote it. The next
message you type on the computer carries no such note.

While you watch a conversation, the phone can also show the session's model, effort, context used, cost
and rate limits. That is what the computer's status bar shows when **Show agent status in the status bar**
is on. The phone can also list the skills the agent can run: send `/name` or `/name arguments` as a reply
to run one. The list appears once the session has received its first message. The agent's built-in
commands, such as `/clear`, are not in it.

The phone can also switch the session's model. Normally the agent asks you to confirm a switch in its
terminal when the conversation is cached, and nothing on the phone could show that question. So when the phone
asks for the switch, spekterm lets exactly that switch go through without the question, for a few seconds; a
switch you start at the computer still asks. Switching makes the agent re-read the whole conversation on your
next message, and the agent keeps the choice as its default for new sessions.

### What the agent did, and who wrote to it

The phone shows what each tool call did, not only its name: the command an agent ran, the change it made to
a file, the message it sent to another session and to whom, the subagent it started and its instructions, the
skill and its arguments, the question and its options. Long text is shortened, and the phone says so. Calls
to MCP servers show only their name and main argument.

Images the agent looked at show in the conversation too: an image it read, a browser or MCP screenshot. They
come from the conversation's own record, not from your files, so the phone sees the image the agent saw, even
after the file is deleted.

A message from another session, or a report from a subagent, is shown as such, with who sent it; a message
from another session shows the label you gave that session. Messages from other sessions and background-task
notices that arrive while the agent works are shown too.

### Files the agent sends you

When an agent sends you a file, the phone can open it: text, Markdown and images in the app, other files
with the phone's own apps. Files up to 32 MB. A file the agent has since deleted or changed is reported as
such.

### Attaching files

A reply from the phone can carry photos, screenshots, PDFs and text files, up to 10 per reply and 10 MB
each. spekterm keeps them in its own data folder and tells the agent where they are, and the agent reads
them without a permission prompt. They are deleted when you close the session, or after 30 days at the
latest.

### Renaming a session

Renaming from the phone works as on the computer: an empty name gives the session back its agent's title.

Starting or waking a session from the phone **never takes your desktop away from you**. The session appears
in its folder, but what you are looking at and where you are typing stay as they were.

## Turning it on and pairing

1. Open **Settings** and choose the **Remote access** section.
2. Turn on **Allow paired devices to connect**. spekterm now listens on every network interface, on the
   port shown (47615 unless you change it). A new port applies when you press **Use port** or **Enter**,
   not when you leave the field, because changing the port disconnects connected devices.
3. Choose **Pair a device** and scan the QR code with the spekterm app on your phone. The code works once,
   for five minutes, and only while that view is open; leaving the section or closing Settings ends it. If
   you cannot scan it, the same link is also shown as text.

The phone stores its own credential, and spekterm keeps only a hash of it. The phone checks spekterm's
certificate against the fingerprint in the code, so another computer cannot pose as yours.

## Networks

The phone connects to the addresses in the pairing code, using whichever one works:

- **The same network**: your computer's local address.
- **Tailscale**: your computer's Tailscale address works as is. To put its Tailscale name in the pairing
  code, add the name as the **Additional address**.
- **A port forward**: forward the port on your router, and add your public name (for example a DDNS name)
  as the **Additional address**.

Each time the phone connects, by whatever route, spekterm tells it the computer's current addresses. It
tells the phone again if they change during the connection. A phone app that keeps this list does not have
to pair again when your computer's local address changes. Once it has connected some other way (Tailscale,
or the additional address), it has the new local address for next time.

If none of the addresses reaches your computer (you are away from home, with no Tailscale and no port
forward), the phone cannot connect, and it is told nothing.

## Notifications

The phone learns **only over its own connection** to spekterm that an agent waits for you, waits on a
choice, or finished a handoff, or that a new inbox item arrived. To notify you in the background, the app
keeps that connection open, which uses some battery. When the connection drops and comes back, spekterm
sends what the phone missed (the last 24 hours, up to 200 events), or tells it that it may have missed some.
You are not notified about the session you are looking at on your computer right now.

A scheduled handoff arrives when it opens, not when it was scheduled. Until then, the phone lists it apart
with its time, and can run it now or cancel it. For a repeating handoff, the phone can decline the proposal,
and can run or skip an upcoming time. Approving the proposal and stopping the schedule happen only on the
computer.

## Who is connected, revoking, and resetting

- While a phone is connected, a phone icon appears in the activity bar. It opens Settings
  on **Remote access**.
- The section lists your paired devices and when each was last seen. **Revoke** asks first, then
  disconnects the device at once and refuses it from then on. The device has to pair again.
- **Reset remote access** creates a new certificate and revokes every device; each one must pair again. If
  the certificate's private key is ever lost, spekterm resets by itself and says so in the section.
- If remote access cannot start (for example, the port is in use), the section says why, and Settings marks
  **Remote access** in its list of sections.

## On networks you do not trust

Remote access listens on every network interface. Turn it off on networks you do not trust. Repeated failed
attempts from one address are refused for a minute. Because of this, someone who shares your phone's public
address could delay your phone's reconnection.

## When spekterm runs without a window (macOS)

On macOS, spekterm keeps running after you close its window, and remote access keeps listening. A paired
phone still connects and sees the inbox, but sessions need the window. The phone is told there is none, and
spekterm does not open one for it.
