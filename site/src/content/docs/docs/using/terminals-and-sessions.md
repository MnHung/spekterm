---
title: Terminals and sessions
description: Claude Code and shell sessions, restoring them after a restart, hibernation, and sessions in git worktrees.
sidebar:
  order: 1
---

Every session is a real terminal running a real program: either Claude Code (`claude`) or your login
shell. spekterm does not wrap or imitate either one — what you type goes to the program, and what it
prints is what you see.

## Starting sessions

Select a folder on the rail, then click **+** on the tab bar or press `Ctrl+T` and choose **Run claude**
or **Login shell**. The menu works from the keyboard: arrow keys to move, `Enter` to choose.

- A session starts in the folder's root directory. Sessions on the **Global** rail item start in your
  home directory.
- `claude` and your shell get the same environment you would have in your own terminal: spekterm reads
  your login shell's environment once at startup. After editing `.zshrc` or `.bashrc`, restart spekterm.
- If `claude` is not found, the terminal shows the shell's error and the tab is marked **Exited** — it
  does not fail silently.

Tabs are named after the title the program sets. To use your own name, right-click the tab and choose
**Rename**; while a name is set, the program's titles are ignored. Clear the name to follow them again.

## Working in the terminal

- **Copy and paste:** `Ctrl+Shift+C` and `Ctrl+Shift+V` (on macOS, `Cmd+C` and `Cmd+V`). `Ctrl+C` is
  always an interrupt, even when text is selected, so you can always stop a runaway command.
- **Links** in terminal output open in your browser when you click them.
- **Switch sessions** in the current rail item with `Ctrl+Tab` / `Ctrl+Shift+Tab`; reorder tabs by
  dragging or with `Shift+←` / `Shift+→`.
- **Close** a session with `Ctrl+Shift+W` or from its tab menu.

spekterm's shortcuts are chosen so they do not take keys your shell or Claude Code need. The full list,
and why each key was chosen, is on the [Keyboard shortcuts](/docs/reference/keyboard-shortcuts/) page.

The look of the terminal — font, size, line height, and GPU drawing — is under **Settings**; see
[Settings](/docs/reference/settings/).

## What the dots say

The dot beside each session, on its tab and on the rail, tells you whether a `claude` session needs you,
without opening it. Hover over it to see the state in words.

| Dot | State |
|---|---|
| Amber, pulsing | **Waiting for you**: the agent finished its turn and you have not looked at it since, or it **asks for a choice** (a permission prompt or a question) |
| Green, glowing | **Working**: the agent is in a turn |
| Green ring | **Idle**: the turn ended and you have already seen it |
| Green | Running: a shell, or an agent whose state is not known (agent events are off) |
| Grey | Hibernated, or ended |
| Red | Ended with an error |

Turning to a session in the spekterm window — or opening its conversation in the companion phone app —
counts as looking at it, and its dot calms from waiting to idle. A session that has just started or woken
is idle, not waiting. Each folder row on the rail carries one dot for its most urgent session, so a
collapsed folder still shows that something inside it waits.

Two things the agent does not report: pressing `Esc` to interrupt a turn leaves the dot on **Working**
until your next prompt, and a permission prompt you answer by typing in the terminal is taken as answered
from your keystroke.

## After a restart: dormant sessions

Closing spekterm ends every session's process. If any are still running, spekterm asks first and lists
them. A build, a dev server, or a reply an agent is still writing is lost; spekterm cannot keep processes
alive while it is closed.

What it does keep is the session itself. When you open spekterm again, every session is back in its tab,
**dormant** — shown, but with no process. Nothing starts until you ask:

- Press **Wake**, or `Enter` while the dormant session has focus.
- A `claude` session resumes **the same conversation** where it left off.
- A shell starts again **in its last working directory**. Its previous screen is shown above a line that
  reads **end of previous content**, so you can tell old output from new. On macOS, a shell starts again
  in its folder instead, not in its last directory; the close dialog says so.

If a conversation cannot be resumed (for example, it was deleted), the session starts a fresh conversation
instead of leaving you with a tab that cannot be used.

## Closing and quitting on macOS

On Linux, closing the window quits spekterm. On macOS, spekterm behaves like Terminal and iTerm2:

- **Closing the window** ends every session — asking first if any is running, as above — but leaves
  spekterm running in the Dock. Click the Dock icon to open the window again; your sessions are back,
  dormant, exactly as after a restart (`claude` resumes its conversation, shells start again).
- **While spekterm runs without a window**, the inbox keeps receiving, and if you set up Slack, spekterm
  keeps checking for mentions every five minutes. See [Inbox and Slack](/docs/using/inbox-and-slack/).
- **`Cmd+Q`** (or **Spekterm → Quit Spekterm**) asks the same question as closing the window when
  sessions are running.
- **Quitting from the Dock, logging out, or shutting down** does not ask about running sessions. It still
  asks about files with unsaved changes.

## Hibernation

Sessions you only use now and then do not need to hold a running process. **Hibernate** a session to end
its process and leave it dormant in place — exactly the state a restart produces, woken the same way.

- **By hand:** `Ctrl+Shift+H`, or **Hibernate** in the tab's or the rail row's menu.
- **Automatically:** a session that has been idle for 24 hours is hibernated. Change the time or turn it
  off under **Settings → Hibernate idle sessions**. The session on screen is never hibernated
  automatically, and neither is an agent that is working or a shell that is running a job. On macOS, idle
  shells are never hibernated automatically; hibernating them by hand works.

A hibernated shell loses what only lived in its process: unexported variables, command history not yet
saved to disk, and background jobs. The dormant screen says so. A hibernated `claude` session loses
nothing — waking it resumes the conversation.

## Sessions in git worktrees

If a repository has linked git worktrees, the side panel shows changes from all of them, labeled with
their working directory. When a change lives in another worktree, the side panel offers **Open a session
there**, which starts a `claude` session in that worktree's root. The status bar shows which worktree the
focused session is in (`wt <name>`), except on macOS (see below).

Worktrees outside the folder's directory can still host sessions; only browsing their files in the side
panel is limited.

## The status bar

Along the bottom, the status bar shows the selected repository, the focused session's working directory
and branch, how many sessions are open, and the anchored change's task progress. If you turn on **Show
agent status in the status bar** in Settings, `claude` also reports its model, context usage, and cost
there. That setting applies to sessions started after you change it, and your own Claude Code status line
keeps working.

On macOS, the status bar does not show the focused session's working directory or its git state (branch,
uncommitted changes, worktree).
