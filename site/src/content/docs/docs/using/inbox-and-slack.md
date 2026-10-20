---
title: Inbox and Slack
description: Turn Slack mentions into inbox items. Review each one, then open it as a ready-to-go Claude Code session in the folder you choose.
sidebar:
  order: 5
---

The inbox collects work that arrives from outside. Today that is mainly **Slack messages that mention you**.
Each item waits until you have read it. When you accept one, spekterm opens a `claude` session in the folder
you confirm. The message goes to the agent as context, and a first prompt is typed in but **not sent**: you
press `Enter`.

Open the inbox with **Handoffs** on the activity bar (the column at the far left). The entry shows how
many items are waiting for you.

## Reviewing an item

Before anything opens, each item shows where it came from, who wrote it, when, and its **full text**. The
text is shown as plain text, exactly as the agent will receive it.

- **Opens in** shows the folder the item will open in. spekterm preselects one from your routing rules, and
  you can pick another. Nothing opens until a folder is confirmed.
- **Accept** opens a `claude` session in that folder. The agent gets the item's text as context, and a prompt
  that points to it is typed into the agent's input. Read the prompt, edit it if you like, and press `Enter`
  to send it.
- **Dismiss** removes the item without opening anything.

An accepted item shows **Already opened** until you choose **Clear from inbox**, so you can still reread
what you accepted.

Text written by someone else never reaches an agent on its own. You review it first, and the first prompt
waits for your `Enter`. For an item accepted on a paired phone, the prompt waits until you read it on the
phone and send it from there
([Remote access](/docs/using/remote-access/#sending-an-inbox-items-prompt-from-the-phone)).

## The Schedules tab

The inbox keeps what needs you now apart from what is planned. The **Inbox** tab lists the items to deal
with now. The **Schedules** tab lists everything planned, in three parts:

- **Waiting for approval**: repeating handoffs an agent proposed
  ([Handoffs](/docs/using/handoffs/#handing-off-work-that-repeats)). Each shows its schedule, the next times
  it would open, its end, and its full text. **Approve** it into the folder you choose, or **Decline** it. A
  proposal whose end has already passed can no longer be approved. The tab's label shows how many proposals
  wait.
- **Scheduled**: every handoff waiting for its time, earliest first. That covers handoffs for a later time
  ([Handoffs](/docs/using/handoffs/#handing-work-off-to-a-later-time)) and the next time of each repeating
  handoff. Each shows when it opens, where it came from, the folder it opens in, and its full text.
  **Run now** opens it at once, as if its time had come. **Cancel** drops a one-off handoff, and **Skip this time**
  drops one time of a repeating one.
- **Repeating**: each approved repeating handoff, with its next time or the reason it has none (an earlier
  time is still waiting in the inbox, or the inbox is full). **Stop repeating** ends it, after asking you
  first.

A proposal waits for you, so it counts on the inbox entry and sends a notification. A scheduled handoff does
neither until it opens. When a notification is only about proposals, opening the inbox from it shows the
Schedules tab. Every item, planned or not, counts toward the inbox's limit on waiting items.

## Notifications

When new items arrive, spekterm shows a desktop notification. Items that arrive together share one
notification. Clicking it brings spekterm to the front with the inbox open.

## Routing rules

The **Routing rules** tab decides which folder is preselected for an item.

- Rules are checked from top to bottom, and the first one that matches wins. Each rule names a field
  (**Match on**), the text that field must contain (**Contains**), and the folder to open in (**Open in**).
  Reorder rules with the arrow buttons.
- **Default folder** is used when no rule matches. Set one. Without it, items arrive with no folder chosen,
  and you pick one each time.
- Some fields, such as the title and the message text, are written by whoever sent the item. Rules on
  those fields are marked, because a sender can word a message to steer where it opens.

If a rule points to a folder that is no longer in your workspace, the item says so instead of quietly
opening somewhere else.

## Connecting Slack

Set up the Slack connection in **Settings → Integrations**. It connects your Slack account. spekterm then
finds messages that mention **you** (the person the token belongs to) and turns each one into an inbox item.
The thread up to that message comes along as context. A very long thread is shortened, and the item says so.

You need a Slack app in your workspace with a **user token**. Give the token these user token scopes:

```text
channels:history  groups:history  im:history  mpim:history
channels:read     groups:read     im:read     mpim:read
users:read
```

The `*:history` scopes let spekterm read messages, the `*:read` scopes let it list the conversations you
are in, and `users:read` turns user IDs into names. After changing scopes, reinstall the app and copy the
token again. Paste it under **User token** and press **Save** or **Enter**. Leaving the field does not save
it, so half a pasted token is never stored. spekterm reads your identity from the token, so there is nothing
else to fill in.

While no **Default folder** is set, the Integrations section warns that mentions will arrive with no folder
to open in. Its **Open routing rules** button takes you to the inbox's routing rules.

### When mentions arrive

spekterm checks for new mentions when it starts, every five minutes, and right after you save a token.
**Look-back window** limits how far back a check reaches. Slack does not replay what happened while
spekterm was closed, so a mention that is older than the window when spekterm starts is missed. A new
window applies when you press **Enter** or leave the field.

On macOS, closing the window does not quit spekterm. While it runs without a window, the inbox keeps
receiving items and the five-minute check continues.

For mentions within seconds, also add an **app-level token**: enable Socket Mode for your Slack app and
create an app-level token for it. **Live updates** then shows whether the live connection is on. If the
connection drops, spekterm falls back to the periodic check.

### Status

The Integrations section always shows the state of the connection: not set up, working with nothing new,
how many mentions the last check brought in, Slack asking spekterm to slow down, or credentials that are
invalid or missing scopes. A broken connection never looks like "nobody mentioned you". While it is broken,
the inbox also shows a one-line Slack status with a button that opens the Integrations section.

### Your tokens

Tokens are stored in spekterm's data directory (`~/.config/Spekterm` on Linux,
`~/Library/Application Support/Spekterm` on macOS), with access limited to your user. They are sent only to
Slack, or to the endpoint set under **API endpoint**. Change the endpoint only if you know why: an address
that is not `https` is refused, and the endpoint stays as it was. Tokens never reach your terminals or your
agents. See [Data and network](/docs/reference/data-and-network/).

## Rejected deliveries

An item that cannot enter the inbox is not dropped silently. That happens when it is unreadable, too long
to review, or names a repository that is not in your workspace. The inbox lists each rejection with its
reason until you clear it, and the list survives a restart.
