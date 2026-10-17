---
title: Settings
description: What each section of Settings changes, and how a change is applied.
sidebar:
  order: 2
---

Open **Settings** from the activity bar on the far left. Settings lists its sections on the left and shows
one of them at a time; it opens on the section you used last.

**A change applies when you make it.** There is no Save button:

- A list, a switch, or an option applies as soon as you choose it.
- A typed value (font size, line height, look-back window, address, endpoint) applies when you press
  **Enter** or leave the field. **Esc** in a field puts the saved value back.
- If a change cannot be saved, a message appears under the field and the field shows the saved value again.

Two values wait for their own button or **Enter** and are never applied by leaving the field: a Slack token
(so that half a pasted token is never stored) and the remote access port (changing it disconnects connected
devices).

**Restore defaults** at the bottom of the Terminal and Agents & sessions sections puts that section back,
after asking. It does not change the other sections or the language.

## General

The interface language (English or Traditional Chinese). Text that spekterm writes for the agent to read
stays in English.

## Terminal

- **Font family** — any monospace font installed on your system; empty means the system default. On
  macOS the list offers only the system's default monospace font.
- **Font size** and **Line height** — empty means the default.
- **Preview** — shows a sample in the chosen font, including characters that are easy to confuse. It follows
  what you type before the value applies.
- **GPU acceleration** — draws the terminal on the GPU. Turn it off if the terminal renders incorrectly on
  your machine.

## Agents & sessions

- **Show agent status in the status bar** — asks `claude` to report its model, context usage, and cost to
  spekterm, which shows them in the status bar. Your own Claude Code status line keeps working. It applies to
  sessions started after you change it.
- **Hibernate idle sessions** — ends the process of a session that has been idle for the chosen time (Off,
  4 hours, 24 hours (the default), 3 days, or 7 days) and keeps the session in the workspace so you can wake
  it later. The session on screen, an agent that is working, and a shell that is running a job are never
  hibernated. On macOS, idle shells are never hibernated automatically. See
  [Terminals and sessions](/docs/using/terminals-and-sessions/).
- **Agent sessions show** — the terminal or the conversation view, for every agent session. It is the same
  choice as the switch beside an agent session's tabs. See [Conversation view](/docs/using/conversation-view/).

## Integrations

The Slack connection: tokens, the look-back window, and the API endpoint. See
[Inbox and Slack](/docs/using/inbox-and-slack/). The routing rules that decide where a mention opens stay in
the inbox.

## Remote access

The state of remote access (off; on, with how many devices are paired and connected; or why it is not
running), the switch, the port, pairing, and the paired devices. If remote access failed to start, the
section is marked in the list. See [Remote access](/docs/using/remote-access/).

## About

The version, build time, and commit of the build you are running — useful when reporting a problem.
