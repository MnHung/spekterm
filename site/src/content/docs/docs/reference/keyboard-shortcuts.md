---
title: Keyboard shortcuts
description: Every shortcut spekterm adds, and why some keys are left to the terminal.
sidebar:
  order: 1
---

spekterm's shortcuts work wherever the focus is: in a terminal, in the editor, or in the side panel. They
do nothing while a dialog or a menu is open. The terminal almost always has the focus, so spekterm catches
these keys before the terminal does. A key spekterm uses never reaches the program running in the terminal.

## Sessions and the rail

| Shortcut | Action |
| --- | --- |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous session in the current rail item, in tab order (wraps around). With focus in the side panel's change view: next / previous artifact |
| `Ctrl+↓` / `Ctrl+↑` | Next / previous rail item, including the global item (wraps around). On macOS, see [On macOS](#on-macos) |
| `Ctrl+T` | Open the new-session menu (fully usable from the keyboard) |
| `Ctrl+Shift+W` | Close the focused session |
| `Ctrl+Shift+H` | Hibernate the focused session: its process ends, and the session stays in the workspace to wake later |
| `Shift+↓` / `Shift+↑` | Move the selected repository one place down / up the rail. Moving it into or out of the pinned group pins or unpins it |
| `Shift+→` / `Shift+←` | Move the focused session one place along the tab bar |

## Side panel and files

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+M` | Maximize / restore the side panel |
| `Ctrl+P` | Quick open a file (only when the side panel has the focus) |
| `Ctrl+S` | Save the open file |
| `Esc` | Close an overlay, a dialog, or a menu |

## Terminal

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| `Ctrl+C` | Always an interrupt, even with a selection on screen |

## Zoom

| Shortcut | Action |
| --- | --- |
| `Ctrl+=` (or `Ctrl++`) / `Ctrl+-` | Zoom the whole interface in / out one step (50% to 175%) |
| `Ctrl+0` | Reset the zoom to 100% |
| `Ctrl` + mouse wheel | Zoom in (wheel up) or out (wheel down), one step per notch |

They work anywhere in the window, also in the terminal, in the editor and while a dialog is open, and the keys
never reach the terminal. `Ctrl+Shift+-` is not a zoom key: it goes to the terminal, where shells use it to undo.
`Ctrl` with the mouse wheel always zooms the interface, also over a program in the terminal that uses the mouse
and over the side panel's Graph.

## Keys spekterm leaves to the terminal

- **`Ctrl+P` with the terminal focused** goes to the terminal: Claude Code uses it for its previous
  history. Click into the side panel first to quick-open a file.
- **`Ctrl+C` is never taken.** Stopping an agent that has gone off course must always work, whatever is
  selected on screen.
- **`Ctrl+W` is not taken**: shells use it to delete a word. Closing a session is `Ctrl+Shift+W`.
- **`Shift+arrow` in a text field selects text** as usual. The reorder shortcuts apply only outside text
  fields.

One known cost: Claude Code's own agents view also uses `Shift+arrow`, but in a spekterm terminal these
keys reorder instead.

## On macOS

The shortcuts above are the same on macOS, with these differences:

- **Copy and paste in the terminal** are `Cmd+C` and `Cmd+V`. `Ctrl+C` is still the interrupt.
- **Save** is `Cmd+S`.
- **Zoom** is `Cmd+=` / `Cmd+-` / `Cmd+0`, and `Cmd` with the mouse wheel.
- **`Cmd+Q`** (or **Spekterm → Quit Spekterm**) quits. If sessions are running, it asks first, as closing
  the window does.
- **There is no `Cmd+W`.** Close a session with `Ctrl+Shift+W`, as on Linux.
- **`Ctrl+↑` / `Ctrl+↓`** belong to Mission Control and App Exposé in macOS's default settings, so they
  never reach spekterm. To use them on the rail, turn those shortcuts off in **System Settings →
  Keyboard → Keyboard Shortcuts → Mission Control**.
- The menu bar is minimal: the **Spekterm** menu (About, Hide, Hide Others, Show All, Quit) and the
  **Edit** menu (Undo, Redo, Cut, Copy, Paste, Select All). The Edit menu's shortcuts work in text fields.
