---
title: Conversation view
description: Read and answer a Claude Code session as a conversation instead of a terminal — what it shows, when it lets you send, and when to switch back.
sidebar:
  order: 3
---

Every `claude` session can be shown two ways: as its **terminal** (the default) or as a **conversation**.
The conversation lays out messages, the agent's thinking, and tool results like a chat, with a box at the
bottom for your next message.

Shell sessions have only the terminal view.

## Switching views

Use **Show conversation view** and **Show terminal view** on the session. The choice applies to **all**
agent sessions at once and is remembered across restarts, so new sessions open in the view you used
last. The same choice is under **Settings → Agents & sessions → Agent sessions show**.

Switching never restarts anything. Both views show the same running `claude` process, and the terminal
keeps running underneath while the conversation is on screen.

## Where the content comes from

The conversation view is built from the record Claude Code itself writes for each conversation in
`~/.claude/projects`, read as the record grows. Whether the agent is working or waiting comes from events
Claude Code reports to spekterm while it runs.

spekterm never reads the terminal screen to build this view. Screen output is made for people, not
programs, and reading it breaks whenever the CLI changes how it draws. For anything the conversation view
cannot show, the terminal view is always there.

When the view opens a long conversation, it loads only the most recent part and says **Earlier messages
are not loaded.** While it catches up, it shows **Catching up…**. If the record cannot be read at all, the
view says **Conversation is unavailable** rather than showing an empty conversation.

## Sending a message

Type in **Message the agent** and press **Send**. Whether you can send depends on what the agent is doing:

- The agent is waiting for your input: you can send.
- The agent is working: the view shows **Working…**, also while the agent writes an answer without
  using a tool. You can still send. Claude Code takes the message in while it works, and the message
  appears in the conversation at the point where the agent picked it up.
- The agent is asking to use a tool, or waiting for a choice: the view shows what the agent is waiting
  for. Answer it in the terminal view; the conversation view does not send free text into a permission
  prompt or a menu. This includes a prompt from an agent running in the background. While any prompt is
  open, the view keeps waiting for it, even after the agent itself has finished its turn.
- The agent's state is unknown: this happens right after a session starts, or when Claude Code is not
  reporting events. Rather than guess, the view refuses to send. Switch to the terminal view to see what
  the agent is doing.

What you send reaches the agent as plain text. It is never interpreted as terminal control sequences.

A slash command you send, such as `/simplify` or a skill with arguments, appears as the line you typed.

A message you send is marked **Not confirmed yet** until it appears in Claude Code's own record. If it
never appears, the view asks you to check the terminal view, because the message may not have arrived.

## Hibernated sessions

A dormant or hibernated session shows **Session is hibernated. Waking resumes the conversation.** Press
**Wake** (or `Enter`) to start it again, and the conversation continues where it stopped. See
[Terminals and sessions](/docs/using/terminals-and-sessions/#hibernation).

## When to use which

- Use the **conversation view** to read what an agent did, follow a long answer, or send the next
  instruction without terminal noise.
- Use the **terminal view** for permission prompts, menus, slash-command pickers, and anything else
  interactive, and whenever the conversation view tells you it cannot help.

## What it needs from Claude Code

spekterm adds its own settings to each `claude` session it starts, so that Claude Code reports when it
starts working and when it waits. Your own Claude Code settings, hooks, and status line keep working:
spekterm adds to them and does not change your settings files. Agent sessions started outside spekterm
are not affected.

These settings also let Claude Code read the files your phone attaches to a message (see
[Remote access](/docs/using/remote-access/)). spekterm keeps those files in its own data folder, and
reading them asks for no permission. Reading is the only thing allowed there. When you turn agent event
reporting off, this permission is not added either.
