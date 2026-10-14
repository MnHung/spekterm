---
title: Settings
description: What the Settings dialog changes, and where the Slack connection is set up.
sidebar:
  order: 2
---

Open **Settings** from the activity bar on the far left. Changes take effect when you press **Save**;
**Reset to default** puts the terminal settings back.

## Language

The interface language (English or Traditional Chinese). It applies immediately. Text that spekterm
writes for the agent to read stays in English.

## Terminal

- **Font family** — any monospace font installed on your system; empty means the system default. On
  macOS the list offers only the system's default monospace font.
- **Font size** and **Line height** — empty means the default.
- **GPU acceleration** — draws the terminal on the GPU. Turn it off if the terminal renders incorrectly on
  your machine.
- **Preview** — shows a sample in the chosen font, including characters that are easy to confuse.

## Show agent status in the status bar

Asks `claude` to report its model, context usage, and cost to spekterm, which shows them in the status
bar. Your own Claude Code status line keeps working. It applies to sessions started after you change it.

## Hibernate idle sessions

Ends the process of a session that has been idle for the chosen time — Off, 4 hours, 24 hours (the
default), 3 days, or 7 days — and keeps the session in the workspace so you can wake it later. The
session on screen, an agent that is working, and a shell that is running a job are never hibernated. On
macOS, idle shells are never hibernated automatically. See
[Terminals and sessions](/docs/using/terminals-and-sessions/).

## About

The version, build time, and commit of the build you are running — useful when reporting a problem.

## Remote access

One line of state — off; on, with how many devices are paired and how many are connected; or why it is not
running (for example, the port is in use) — and a button that opens the **Remote access** dialog, where you turn
it on, pair a phone, and revoke devices. See [Remote access](/docs/using/remote-access/).

## Slack connection

The Slack connection is not in Settings: it is set up from the **Handoffs** inbox. See
[Inbox and Slack](/docs/using/inbox-and-slack/).
