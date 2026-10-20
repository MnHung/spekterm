---
title: Handoffs
description: Let an agent hand work to another repository in your workspace. spekterm opens the session, sends the first prompt, tracks it, and tells you when it is done.
sidebar:
  order: 6
---

A Claude Code session in spekterm can hand work off to another repository in your workspace. Say an agent
in `api-server` changes an endpoint, and the client in `web-app` needs updating. The agent writes a
handoff, and spekterm opens a new `claude` session in `web-app`, gives it the handoff, and sends its first
prompt. The new session remembers where it came from and reports back when it is done.

## How an agent knows it can hand off

When a `claude` session starts, spekterm tells the agent that it is running inside spekterm, which
repositories in the workspace it can hand off to, and how to deliver a handoff. You do not need to set
anything up. Ask in plain words:

> Hand the client-side changes off to web-app.

The agent writes a short title and a body that describes the work. spekterm reads the handoff, finds the
target repository by name in your workspace, and starts the session there.

Unlike inbox items from Slack, a handoff opens **without asking you first**: an agent in your own session
wrote its text, not a third party. Its first prompt is sent as soon as the new agent is ready. Rarely, the
CLI does not take the submit key. The session then shows **A prompt is waiting to be sent**, and you press
`Enter` yourself; spekterm does not send it a second time.

## Handing work off to a later time

A change often takes days to finish: the last steps wait for a deploy, for data to pile up, or for a
review. Ask the agent to hand the rest off to a later time:

> Hand the verification off to this repo for tomorrow at 9.

The agent adds the time to the handoff. spekterm checks the handoff right away, while the agent is still
there: a target that does not exist, a body that is too long, or a time it cannot use is refused at once.
An accepted handoff waits in the inbox under **Scheduled**, and its session opens when the time comes. It
is always a new session, opened the same way as a handoff that opens immediately.

- **It runs only while spekterm runs.** If spekterm is closed at that time, the handoff opens at the next
  start, without asking. The new agent is told when the handoff was meant to start and when it actually
  did, so it can judge what changed in between.
- **A scheduled handoff waits quietly.** It sends no notification and adds no count to the inbox entry until
  it opens. Then it notifies you like any arriving handoff.
- **Run now** opens it at once, and **Cancel** drops it. A paired phone can do both.
- The time must include a time zone and can be at most 30 days ahead. A time that has already passed opens
  at once.

Each handoff opens by itself **at most once**. If that opening does not lead to a working session (its
folder was removed, or the session could not start), the handoff stays in the inbox as an ordinary item for
you to accept. spekterm does not try again.

## Handing off work that repeats

Some work comes back on a rhythm: a review every Wednesday evening, a check every weekday morning. Ask the
agent for it:

> Every Wednesday at 9 pm, open a session in this repo to write up the week's review. Stop at the end of the year.

The agent writes a handoff with a **repeat schedule** in cron form, read in your computer's time zone. For
example, `0 21 * * 3` is every Wednesday at 21:00. The agent can also set when the schedule starts and when
it ends. Without an end, it repeats until you stop it.

**A repeating handoff is a proposal, not a schedule.** Nothing opens until you approve it. It arrives in the
inbox like any handoff, with a notification and a count, and waits under **Schedules**. There you see its
schedule, the next times it would open, its end, and its full text. **Approve** it into the folder you
choose, or **Decline** it. Approving opens nothing right away: the first session opens at the first time on
the schedule.

- **Each time opens a new session.** Its agent is told that the handoff repeats, when this time was meant to
  start, and when it actually did.
- **It runs only while spekterm runs.** Times that pass while spekterm is closed (or the computer sleeps)
  run **once** at the next start, not once each. The agent is told which times it stands in for.
- **One time at a time.** The inbox lists only the next time. **Run now** opens it at once; that time is
  then done, and the one after it is next. **Skip this time** drops this time only.
- **A time that cannot open pauses the schedule.** That happens when its folder was removed or agent event
  reporting is off. The failed time stays in the inbox where you can see it, and no further time is created
  until you accept or dismiss it. Otherwise a schedule whose folder is gone would add a failed item every
  week.
- **Stop repeating** ends the schedule. You find it in the list of repeating handoffs under **Schedules**,
  and it asks you to confirm first. Sessions the schedule already opened stay.
- The schedule may open at most once an hour (the minute must be a single number), and it must have a time
  in the next four years.
- A paired phone can decline a proposal, and can run or skip a time. Approving and stopping happen only on
  the computer.

## Following a handed-off session

- The new session's tab is named after the handoff's title. **Open handoff brief** shows the handoff text
  and the latest result at any time.
- In the same repository, a handed-off session is indented under the session it came from on the rail.
  Across repositories, the child shows **From** its parent, and the parent shows how many sessions it
  handed off. Click either one to jump to the other.
- Each handed-off session has a state, shown on both ends: **Working**, **Waiting for you**, or **Done**.
  **Waiting for you** follows the session's dot: once you have looked at the session, it shows no state
  until it works again (see [What the dots say](/docs/using/terminals-and-sessions/#what-the-dots-say)).

When the child agent finishes, it writes a short report. spekterm marks the session **Done**, shows the
summary in the brief, and sends a desktop notification; clicking the notification opens the brief. The
child agent can also send its result straight to the parent agent (see below).

A **Done** session starts again if you give it more work. spekterm never closes it on its own, though an
agent can when you ask it to (see below). Close completed sessions one at a time or all at once: from the
parent's list of handed-off sessions, or with the workspace-wide action that appears while at least one is
done. Both ask first and list each session's result.

## Agents talking to each other

Every `claude` session in spekterm runs under a fixed name made of its rail item and a short code, for
example `web-app-3f9a`. The name stays the same across restarts and wakes. Agents use these names with
Claude Code's own local session messaging. A child can tell its parent it is done, and siblings handed off
by the same parent can coordinate. spekterm keeps each agent's list of relatives up to date: its parent, its
siblings, and its children together with the sessions they handed off, at every depth. Claude Code delivers
the messages.

A hibernated or dormant session has no process and cannot receive messages until you wake it. Agents are
told this, and told not to wake sessions themselves.

Giving each session a fixed name has a side effect: Claude Code shows that name as the terminal title. To
see a task name on the tab instead, rename the tab. Your name takes priority.

## Asking an agent to close, hibernate, or rename sessions

An agent can close, hibernate, or rename its own session and any session it handed off, including the ones
those sessions handed off in turn. Ask in plain words:

> We're done here — close this session.
>
> Hibernate the handoffs you finished.

- **Close** ends the session and removes it from the workspace, like closing its tab. **Hibernate** ends its
  process and keeps it dormant until you wake it. **Rename** changes the tab's label.
- **Close and hibernate wait for the session's current turn to end.** A handed-off session that is still
  working closes when it stops, not midway. Rename happens at once.
- **An agent never closes its own session by itself.** When it asks to, it finishes its reply first. The
  session then shows **The agent asked to close this session**, with **Close** and **Keep**. The reply stays
  readable and scrollable underneath, and nothing closes until you choose **Close**. Typing into the session
  counts as keeping it. A paired phone shows the same offer and can answer it
  ([Remote access](/docs/using/remote-access/)). An answer on either side counts for both.
- **Typing into that session cancels a waiting close or hibernate**, because you have taken it back.
  Hibernating, closing, or waking it yourself does the same. A waiting command is also dropped when
  spekterm quits.
- An agent can act only on its own subtree. If you ask it to close its parent, a sibling, or an unrelated
  session, the command is refused, and you see the refusal as a notification and an entry in the inbox.
- Nothing moves on screen: the rail selection and your keyboard focus stay where they are.

The agent's receipt for a command (see below) says whether the command was accepted or refused, not whether
it was carried out. For a session it handed off, the agent can see the outcome in its list of relatives:
gone, not running, or renamed.

## When a handoff fails

A handoff that cannot be delivered is not lost silently. That happens when the agent names a repository that
is not in your workspace (or a name two folders share), or writes a body too long to review. spekterm then
sends a notification and keeps an entry with the reason in the inbox until you clear it, even across
restarts.

## Receipts: what the agent learns

For every file an agent writes to spekterm (a handoff, a completion report, or a command), spekterm writes a
**receipt** the agent can read. The receipt says one of:

- **accepted**;
- **scheduled**, with the time;
- **proposed**: a repeating handoff waiting for your approval;
- **duplicate**;
- **rejected**, with the reason and whether trying again can help;
- **held**: not processed yet; spekterm reads the file again later.

The agent is not told later whether you approved a proposal.

With receipts, an agent can say "the handoff was accepted" instead of "I wrote it", and an agent about to be
closed learns of a refusal while it can still fix it.

A receipt records what spekterm did when it read the file. It does not mean the new session finished the
work; that is what the child's own report is for. An accepted handoff is also checked once more when it
opens. If its folder was removed by then, the failure is shown to you, not to the agent.

## What a handoff is not

- **Not a security boundary.** An agent with a shell can write a handoff whenever it decides to, just as it
  can run any command. Handoffs only ever open sessions in folders that are already in your workspace.
- **Not limited in number.** An agent can hand off as often as it chooses.
- **Not for other people.** A handoff opens a session on your own machine, in your own workspace.
