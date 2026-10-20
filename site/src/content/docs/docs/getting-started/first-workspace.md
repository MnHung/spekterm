---
title: Your first workspace
description: Add a repository, start a Claude Code session in it, and read its OpenSpec change beside the terminal.
sidebar:
  order: 2
---

A workspace is the list of folders spekterm shows on the left: the **rail**. Each folder is usually a git
repository. Everything else in the window belongs to the item selected on the rail: its sessions in the
middle, its specs and files in the side panel on the right.

## Add a folder

Click **+ Add folder** at the bottom of the rail and pick a directory in the dialog. It appears on the
rail with its current git branch.

- A folder without an `openspec/` directory is marked **no openspec/**. You can still open sessions and
  browse files there; the OpenSpec side panel needs that directory.
- If a folder is later moved or deleted on disk, it stays on the rail marked **missing**, so you can see
  what happened instead of losing it silently.
- **Remove from workspace**, in a folder's right-click menu, takes the folder off the rail. So does the ✕
  that appears when you hover it. Neither deletes anything on disk.

Add as many folders as you work in. spekterm remembers the list across restarts.

## Start a session

Select the folder, then click **+** on the tab bar or press `Ctrl+T`. Pick one of:

- **Run claude** — starts Claude Code in the folder.
- **Login shell** — starts your usual shell in the folder.

The session opens as a tab. You can open several sessions in the same folder and switch between them with
`Ctrl+Tab`. A tab is named after the title its program sets; right-click it and choose **Rename** to give
it your own name.

At the very top of the rail is **Global**. Sessions there belong to no repository and start in your home
directory. Use it for anything that is not about one project.

## Read the change next to the agent

The side panel on the right has two identities, switched at its top: **OpenSpec** and **Files**.

With **OpenSpec**, open **Browse**, expand **Changes**, and pick the change you are working on. The
**This change** view now shows it: one tab per artifact (proposal, design, specs, tasks), with the task
progress always visible. Ask the agent to work on that change, and the panel updates as files change on
disk: checked tasks, a new design section, a new spec delta.

spekterm never guesses which change a session is working on from what the agent prints. You pick it once
per folder, and the choice is remembered. If the repository has exactly one active change, it is shown
without picking.

When the change still lacks an artifact, **Continue** asks the focused `claude` session to write the
next one. See [The OpenSpec side panel](/docs/using/side-panel/) for everything the panel does.

## Arrange the rail

- Drag folders to reorder them, or select one and press `Shift+↑` / `Shift+↓`.
- Hover a folder and pin it to keep it at the top. Pinned folders stay visible while the rest of the rail
  scrolls.
- `Ctrl+↑` / `Ctrl+↓` move the selection between rail items from the keyboard. On macOS, Mission Control
  and App Exposé take these keys by default; turn them off in **System Settings → Keyboard → Keyboard
  Shortcuts → Mission Control** to use them.

## Close and come back

When you close spekterm with sessions still running, it asks first and lists them. Closing ends their
processes: a build or dev server running in a shell stops. On macOS, closing the window ends the sessions
the same way but leaves spekterm running in the Dock; click its Dock icon to open the window again.

The next time you open spekterm, your sessions are back as tabs but **dormant**: no process is running
until you press **Wake** (or `Enter` while the session has focus). A `claude` session resumes the same
conversation; a shell starts again in its last directory (on macOS, in its folder), with the previous
screen shown above a line that reads **end of previous content**. Details are in
[Terminals and sessions](/docs/using/terminals-and-sessions/).

## Next steps

- [Terminals and sessions](/docs/using/terminals-and-sessions/) — restore, hibernation, worktrees.
- [The OpenSpec side panel](/docs/using/side-panel/) — artifacts, browsing, Graph and Timeline.
- [Keyboard shortcuts](/docs/reference/keyboard-shortcuts/) — the whole list.
