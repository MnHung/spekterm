---
title: FAQ
description: Common questions about what spekterm is and is not.
sidebar:
  order: 2
---

## How is this different from running Claude Code in a terminal?

You still run Claude Code in a real terminal — spekterm adds what a row of terminal tabs does not have.
Each repository gets its own place on the rail with its sessions, and next to the terminal is a side panel
that understands OpenSpec: it shows the change the agent is working on — its proposal, design, tasks, and
specs — and follows along as the agent writes to disk. Sessions also survive a restart, and an agent can
hand work to another repository. See [The OpenSpec side panel](/docs/using/side-panel/).

## How is it different from tools that run many agents in parallel?

Those tools focus on running many agents at once. spekterm focuses on keeping each session next to the
OpenSpec change it is working on, so you can read the spec while the agent writes the code. It runs the
real `claude` CLI in a real terminal and never scrapes the screen; the conversation view is built from the
agent's own transcript.

## Do I need OpenSpec?

No. Terminals, agent sessions, the conversation view, files, and the inbox work in any folder. The side
panel's OpenSpec view simply has nothing to show in a folder without an `openspec/` directory.

## Does it work on macOS or Windows?

macOS, yes: there is a build for Macs with Apple Silicon, running macOS 12 (Monterey) or later. It is not
notarized by Apple, so the first launch needs one extra step, and a few features are limited on macOS —
see [Install on macOS](/docs/getting-started/install/#install-on-macos). Windows and Intel Macs are not
supported yet.

## Is my code sent anywhere?

spekterm itself does not send your code anywhere. The programs it starts for you — such as `claude` —
connect to their own services. See [Data and network](/docs/reference/data-and-network/) for the full
list.

## How is spekterm related to spek?

[spek](/spek/) is a read-only OpenSpec viewer — a web app, a VS Code extension,
and a JetBrains plugin — from the same maintainers. spekterm uses spek's engine (`@spekjs/core`) to read
OpenSpec, and spek's Graph and Timeline (`@spekjs/ui`) in its side panel. You do not need spek to use
spekterm, or the other way around; spek is for reading specs in your editor or browser, spekterm for
running agents next to them. See [spek's documentation](/spek/docs/).

## Is spekterm affiliated with Anthropic or OpenSpec?

No. spekterm is an independent open-source project. Claude Code is Anthropic's product and OpenSpec is
its own project; spekterm only runs them.

## Is it free?

Yes. spekterm is open source under the MIT license. Claude Code runs with your own subscription.
