---
title: Conversation view
description: Read and answer a Claude Code session as a conversation instead of a terminal — what it shows, when it lets you send, and when to switch back.
sidebar:
  order: 3
---

Every `claude` session can be shown two ways: as its **terminal** (the default) or as a **conversation**
— messages, the agent's thinking, and tool results laid out like a chat, with a box at the bottom to send
the next message.

Shell sessions have only the terminal view.

## Switching views

Use **Show conversation view** and **Show terminal view** on the session. The choice applies to **all**
agent sessions at once and is remembered across restarts, so new sessions open in the view you used last.

Switching never restarts anything. Both views show the same running `claude` process; the terminal keeps
running underneath while the conversation is on screen.

## Where the content comes from

The conversation view is built from the record Claude Code itself writes for each conversation, in
`~/.claude/projects`, read as it grows. Whether the agent is working or waiting comes from events Claude
Code reports to spekterm while it runs.

spekterm never reads the terminal screen to build this view. Screen output is made for people, not
programs; reading it breaks whenever the CLI changes how it draws. The terminal view stays available for
anything the conversation view cannot show.

When the view opens a long conversation, it loads the most recent part and says **Earlier messages are
not loaded.** While it catches up you see **Catching up…**. If the record cannot be read at all, the view
says **Conversation is unavailable** instead of showing an empty conversation.

## Sending a message

Type in **Message the agent** and press **Send**. Whether you can send depends on what the agent is doing:

- **Waiting for your input** — send.
- **Working…** — the agent is busy, also while it writes an answer without using any tool. You can still send:
  Claude Code takes the message in while it works, and the message appears in the conversation where the
  agent picked it up.
- **The agent is asking to use a tool, or is waiting for a choice.** The view shows what it is waiting for.
  Answer it in the terminal view — the conversation view does not send free text into a permission prompt
  or a menu. This includes a prompt from an agent running in the background: while any prompt is open, the
  view keeps waiting for it, even when the agent itself has finished its turn.
- **The agent's state is unknown.** This happens right after a session starts, or when Claude Code is not
  reporting events. The view refuses to send rather than guess; switch to the terminal view to see what the
  agent is doing.

What you send goes to the agent as plain text. It is never interpreted as terminal control sequences.

A message you sent appears as **Not confirmed yet** until it shows up in Claude Code's own record. If it
never does, the view tells you to check the terminal view — the message may not have arrived.

## Hibernated sessions

A dormant or hibernated session shows **Session is hibernated. Waking resumes the conversation.** Press
**Wake** (or `Enter`) to start it again; the conversation continues where it stopped. See
[Terminals and sessions](/docs/using/terminals-and-sessions/#hibernation).

## When to use which

- Use the **conversation view** to read what an agent did, follow a long answer, or send the next
  instruction without terminal noise.
- Use the **terminal view** for permission prompts, menus, slash-command pickers, and anything
  interactive — and whenever the conversation view tells you it cannot help.

## What it needs from Claude Code

spekterm adds its own settings to each `claude` session it starts, so Claude Code reports when it starts
working and when it waits. Your own Claude Code settings, hooks, and status line keep working; spekterm
adds to them and does not change your settings files. Agent sessions started outside spekterm are not
affected.

The settings also allow Claude Code to read the files your phone attaches to a message (see
[Remote access](/docs/using/remote-access/)), which spekterm keeps in its own data folder, so reading them
asks no permission. Only reading is allowed there. When you turn agent event reporting off, this permission
is not added either.
