---
title: Handoffs
description: Let an agent hand work to another repository in your workspace — spekterm opens the session, sends the first prompt, tracks it, and tells you when it is done.
sidebar:
  order: 6
---

A Claude Code session in spekterm can hand work off to another repository in your workspace. Say an agent
in `api-server` changes an endpoint and the client in `web-app` needs updating: the agent writes a
handoff, and spekterm opens a new `claude` session in `web-app`, gives it the handoff, and sends its first
prompt. The new session remembers where it came from and reports back when it is done.

## How an agent knows it can hand off

When a `claude` session starts, spekterm tells the agent that it is running inside spekterm, which
repositories in the workspace it can hand off to, and how to deliver a handoff. You do not need to set
anything up. Ask in plain words:

> Hand the client-side changes off to web-app.

The agent writes a short title and a body describing the work. spekterm reads it, finds the target
repository by name in your workspace, and starts the session there.

Unlike inbox items from Slack, a handoff opens **without asking you first**: its text was written by an
agent in your own session, not by a third party. Its first prompt is sent as soon as the new agent is
ready. Rarely, the CLI does not take the submit key; the session then shows **A prompt is waiting to be
sent**, and you press `Enter` yourself — spekterm does not send it twice.

## Following a handed-off session

- The new session's tab is named after the handoff's title. **Open handoff brief** shows the handoff text
  and the latest result at any time.
- In the same repository, a handed-off session is indented under the session it came from on the rail.
  Across repositories, the child shows **From** its parent, and the parent shows how many sessions it
  handed off. Click either to jump.
- Each handed-off session has a state, shown on both ends: **Working**, **Waiting for you**, or **Done**.

When the child agent finishes, it writes a short report. spekterm marks the session **Done**, shows the
summary in the brief, and sends a desktop notification — clicking it opens the brief. The child agent
can also send its result to the parent agent directly; see below.

A **Done** session can start again if you give it more work. spekterm never closes it on its own (an agent can, when asked; see below): close
completed sessions one by one, or all at once — from the parent's list of handed-off sessions, or with
the workspace-wide action shown while at least one is done. Both ask first and list each session's
result.

## Agents talking to each other

Every `claude` session in spekterm runs under a fixed name, made of its rail item and a short code (for
example `web-app-3f9a`). The name stays the same across restarts and wakes. Agents use these names with
Claude Code's own local session messaging, so a child can tell its parent it is done, or siblings handed
off by the same parent can coordinate. spekterm keeps each agent's list of parent, children (with the sessions they
handed off, at every depth), and siblings up to date; Claude Code delivers the messages.

A session that is hibernated or dormant has no process and cannot receive messages until you wake it.
Agents are told this, and that they must not wake sessions themselves.

Giving each session a fixed name has a side effect: Claude Code shows that name as the terminal title.
To see a task name on the tab instead, rename the tab — your name takes priority.

## Asking an agent to close, hibernate, or rename sessions

An agent can close, hibernate, or rename its own session, and any session it handed off, including the
ones those sessions handed off in turn. Ask in plain words:

> We're done here — close this session.
>
> Hibernate the handoffs you finished.

- **Close** ends the session and removes it from the workspace, as the tab's close does. **Hibernate**
  ends its process and keeps it dormant until you wake it. **Rename** changes the tab's label.
- **Close and hibernate wait for the session's current turn to end.** A handed-off session that is still
  working is closed when it stops, not in the middle. Rename happens at once.
- **An agent never closes its own session by itself.** When it asks to, it finishes its reply, and the
  session then shows **The agent asked to close this session** with **Close** and **Keep**. The reply
  stays readable and scrollable underneath; nothing closes until you choose **Close**. Typing into the
  session counts as keeping it.
- **Typing into that session cancels a waiting close or hibernate**: you have taken it back. So does
  hibernating, closing, or waking it yourself. A waiting command is also dropped when spekterm quits.
- The agent can only act on its own subtree. Asking it to close its parent, a sibling, or an unrelated
  session is refused, and you see the refusal as a notification and an entry in the inbox.
- Nothing moves on screen: the rail selection and your keyboard focus stay where they are.

As with handoffs, the agent is not told whether a command was carried out. For a session it handed off,
it can see the result in its relations list (gone, not running, or renamed).

## When a handoff fails

A handoff that cannot be delivered is not lost silently. If the agent names a repository that is not in
your workspace (or a name shared by two folders), or writes a body too long to review, spekterm sends a
notification and keeps an entry with the reason in the inbox — also after a restart — until you clear
it.

The agent itself does not learn whether its handoff was delivered; there is no reply channel. If a
handoff matters, check that the session opened.

## What a handoff is not

- **Not a security boundary.** An agent with a shell can write a handoff whenever it decides to, the same
  way it can run any command. Handoffs only ever open sessions in folders that are already in your
  workspace.
- **Not limited in number.** An agent can hand off as often as it chooses.
- **Not for other people.** A handoff opens a session on your own machine, in your own workspace.
