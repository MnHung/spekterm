---
title: Inbox and Slack
description: Turn Slack mentions into inbox items you review, then open as a ready-to-go Claude Code session in the folder you choose.
sidebar:
  order: 5
---

The inbox collects work that arrives from outside: today, mainly **Slack messages that mention you**.
Each item waits until you read it. When you accept it, spekterm opens a `claude` session in the folder you
confirm, with the message as context and a first prompt typed in — but **not sent**. You press `Enter`.

Open the inbox with **Handoffs** on the activity bar (the column at the far left). The entry shows how
many items are waiting for you.

## Reviewing an item

Each item shows where it came from, who wrote it, when it happened, and its **full text** — before
anything is opened. The text is shown as plain text, exactly as the agent will receive it.

- **Opens in** shows the folder the item will open in. spekterm preselects one using your routing rules;
  you can pick another. Nothing opens until a folder is confirmed.
- **Accept** opens a `claude` session in that folder. The item's text is handed to the agent as context,
  and a prompt that points at it is typed into the agent's input. Read it, change it if you like, and press
  `Enter` to send.
- **Dismiss** removes the item without opening anything.

Once accepted, an item shows as **Already opened** until you **Clear from inbox**, so you can still
reread what you accepted.

Message text written by someone else is never sent to an agent on its own. You review it first, and the
first prompt waits for your `Enter` — or, for an item accepted on a paired phone, for you to send it from the phone
after reading it there ([Remote access](/docs/using/remote-access/#sending-an-inbox-items-prompt-from-the-phone)).

## Scheduled handoffs

An agent can hand work off to a later time ([Handoffs](/docs/using/handoffs/#handing-work-off-to-a-later-time)).
Until that time it is listed under **Scheduled**, earliest first, with when it opens, where it came from,
the folder it opens in, and its full text. It is not counted on the inbox entry and raises no notification
while it waits.

- **Run now** opens it at once, as its time would have.
- **Cancel** drops it: it never opens.

A scheduled handoff counts toward the inbox's limit on waiting items, like every other item.

## Notifications

When new items arrive, spekterm shows a desktop notification. Several arrivals at once are merged into
one. Clicking the notification brings spekterm to the front with the inbox open.

## Routing rules

The **Routing rules** tab decides which folder is preselected for an item.

- Rules are checked from top to bottom; the first one that matches wins. Each rule picks a field
  (**Match on**), a text it must **Contain**, and the folder to **Open in**. Reorder rules with the arrow
  buttons.
- **Default folder** is used when no rule matches. Set one — otherwise items arrive with no folder chosen,
  and you pick one each time.
- Some fields, such as the title and the message text, are written by whoever sent the item. Rules on
  those fields are marked, because a sender can word a message to steer where it opens.

If a rule points at a folder that is no longer in your workspace, the item says so instead of quietly
opening somewhere else.

## Connecting Slack

The Slack connection is set up in **Settings → Integrations**. It connects your Slack account; spekterm then finds messages that mention **you** — the
person the token belongs to — and turns each one into an inbox item, with the thread up to that message
as context. A very long thread is shortened, and the item says so.

You need a Slack app in your workspace with a **user token**. Give the token these user token scopes:

```text
channels:history  groups:history  im:history  mpim:history
channels:read     groups:read     im:read     mpim:read
users:read
```

The `*:history` scopes let spekterm read messages; the `*:read` scopes let it list the conversations you
are in; `users:read` turns user IDs into names. After changing scopes, reinstall the app and copy the
token again. Paste it under **User token** and press **Save** or **Enter**; leaving the field does not save it,
so half a pasted token is never stored. Your identity is read from the token — there is nothing else to fill in.

While no **Default folder** is set, the Integrations section says that mentions will arrive with no folder to
open in, with a button that opens the inbox's routing rules.

### When mentions arrive

spekterm checks for new mentions when it starts, every five minutes, and right after you save a token.
**Look-back window** (applied with **Enter** or when you leave the field) sets how far back the startup check
searches: Slack does not replay what happened
while spekterm was closed, so mentions older than the window are missed. On macOS, closing the window does
not quit spekterm: while it keeps running without a window, the inbox keeps receiving and the five-minute
check continues.

For mentions within seconds, also add an **app-level token**: enable Socket Mode for your Slack app and
create an app-level token for it. **Live updates** then shows whether the live connection is on. If it
drops, spekterm falls back to the periodic check.

### Status

The Integrations section always says what state the connection is in: not set up, working with nothing new,
how many mentions arrived on the last check, Slack asking to slow down, or credentials that are invalid or
missing scopes. A broken connection never looks like "nobody mentioned you": while it is broken, the inbox also
shows a one-line Slack status with a button that opens the Integrations section.

### Your tokens

Tokens are stored in spekterm's data directory (`~/.config/Spekterm` on Linux,
`~/Library/Application Support/Spekterm` on macOS) with access limited to your user. They are sent only to Slack
(or to the endpoint you set under **API endpoint** — only change it if you know why; an address that is not
`https` is refused and the endpoint stays as it was), and never reach
your terminals or your agents. See [Data and network](/docs/reference/data-and-network/).

## Rejected deliveries

An item that cannot be accepted into the inbox — unreadable, too long to review, or naming a repository
that is not in your workspace — is not dropped silently. The inbox lists each rejection with its reason
until you clear it, including after a restart.
