## ADDED Requirements

### Requirement: On macOS, closing the window leaves the application running and activating it reopens the window

On macOS, closing the window SHALL end its sessions exactly as on other platforms (with the same
confirmation), and SHALL NOT quit the application. This follows the convention of macOS terminal
applications. Activating the application while it has no window (clicking its Dock icon, opening it
again) SHALL open a new window, whose sessions are restored as dormant, as they are after a restart
(`session-persistence`).

The second window SHALL behave as the first: its menu, its close confirmation, and the delivery of inbox
and handoff events. Nothing the closed window held SHALL outlive it: its ptys, its watchers, its
conversation tracking.

**An action that targets the window while none exists SHALL first open one.** Such actions are a
notification click, opening the inbox, and revealing a handoff brief. The action SHALL be performed once
the new window's interface is ready to receive it. It SHALL NOT be dropped, and it SHALL NOT be sent
before the interface can handle it.

**Acceptance gap, settled by dogfood:** that clicking a real notification while no window exists opens
the window and performs its action. The logic is covered without a real notification.

#### Scenario: Closing the window keeps the application

- **WHEN** on macOS a shell session holds a running process, the user closes the window and confirms
- **THEN** the session's process has ended, and the application process is still running with no window

#### Scenario: Activating the application restores the sessions

- **WHEN** on macOS the application is running with no window and is activated
- **THEN** a window opens and the session that was running is present as dormant

#### Scenario: The second window has the menu

- **WHEN** on macOS the window is closed and the application is activated again
- **THEN** the new window's application menu still contains Quit and the Edit menu

#### Scenario: An inbox action with no window opens one

- **WHEN** on macOS the application has no window and an action that opens the inbox is triggered
- **THEN** a window opens and its inbox opens once the window's interface is ready

### Requirement: On macOS, quitting from the application menu asks like closing the window

On macOS, the application menu's Quit item and `Cmd+Q` SHALL close the window first, with everything that
closing the window does: the confirmation of unsaved changes and the confirmation of running sessions.
They SHALL quit the application only once that close has finished. Cancelling either confirmation SHALL
keep the application and the window as they were, and SHALL leave nothing behind that would turn a later
close of the window into a quit.

When the application has no window, Quit SHALL quit at once.

#### Scenario: Cmd+Q with a running session asks

- **WHEN** on macOS a shell session holds a running process and the user presses `Cmd+Q`
- **THEN** the confirmation of running sessions is shown, and the application is still running

#### Scenario: Cancelling Cmd+Q keeps everything

- **WHEN** the user cancels that confirmation
- **THEN** the window is open and the session's process is the same process, still running

#### Scenario: A cancelled Cmd+Q leaves nothing behind

- **WHEN** after cancelling that confirmation the user closes the window and confirms
- **THEN** the application is still running, with no window

#### Scenario: Confirming Cmd+Q quits

- **WHEN** the user confirms that confirmation
- **THEN** the application exits and no process of its sessions remains

#### Scenario: Cmd+Q with nothing to ask quits at once

- **WHEN** on macOS no session holds a running process, nothing is unsaved, and the user presses `Cmd+Q`
- **THEN** no dialog is shown and the application exits

#### Scenario: Quit with no window quits at once

- **WHEN** on macOS the application is running with no window and the user chooses Quit
- **THEN** the application exits

### Requirement: A quit that waited for an answer finishes once it is answered

When a quit had to wait for the user, it SHALL finish once the user has answered with anything other than
cancel. Such a quit is either one that started from the Quit item, or one whose unsaved changes had to be
confirmed after a request from the operating system. A quit the user asked for SHALL NOT end in an
application that keeps running with no window.

#### Scenario: Answering the unsaved-changes question of an OS quit finishes the quit

- **WHEN** on macOS a file has unsaved changes, the operating system asks the application to quit (as the
  Dock's Quit does), and the user chooses not to save
- **THEN** the application exits

## MODIFIED Requirements

### Requirement: 應用程式視窗不呈現原生 menu bar

應用程式視窗 SHALL NOT 呈現原生的 menu bar，使用者按 `Alt` SHALL NOT 浮出任何 menu。這個 app
不定義任何 menu 內容（Linux、Windows）—— 一條空的 menu bar 只會擋住畫面、讓使用者以為漏看了什麼。

此要求為**移除** menu，而非僅隱藏：`autoHideMenuBar`（平時隱藏、按 `Alt` 浮出）不滿足它，
主行程 SHALL 移除整個 menu（`Menu.setApplicationMenu(null)` 或等效）。

**This applies to Linux and Windows. macOS is the exception**, because there the application menu is
not part of the window: it is the system's menu bar. The standard keyboard shortcuts of text editing
(`Cmd+C`, `Cmd+V`, `Cmd+X`, `Cmd+A`, undo and redo) come from that menu's items, and so does `Cmd+Q`.
On macOS the application SHALL therefore define a minimal application menu, and nothing beyond it:

- the application menu: About, Hide, Hide Others, Show All, Quit;
- the Edit menu: Undo, Redo, Cut, Copy, Paste, Select All.

It SHALL NOT define a shortcut that closes the window with one key (`Cmd+W`): closing the window ends every
session.

The menu SHALL be set once for the application, not per window, and every label SHALL come from the
dictionaries in the current UI language (`ui-localization`). The application menu's own title is the
bundle's name and is not translated.

A paste or a copy SHALL happen once per key press: in the terminal, in the editor, and in text fields. An
Edit menu item SHALL NOT repeat a paste that the terminal or the editor has already performed.

#### Scenario: 按 Alt 不叫出任何 menu

- **WHEN** 在 Linux 或 Windows 上應用程式視窗開啟，使用者按下 `Alt`
- **THEN** 不出現任何 menu bar

#### Scenario: The macOS menu holds the minimal items

- **WHEN** on macOS the application is running
- **THEN** its menu bar holds the application menu and the Edit menu with the items listed above, the
  application defines no other item, and no item is bound to `Cmd+W`

#### Scenario: The macOS menu follows the UI language

- **WHEN** on macOS the UI language is changed in Settings
- **THEN** the menu's items (other than the application menu's own title) are labelled in the new language
  without a restart

#### Scenario: Paste in the editor happens once on macOS

- **WHEN** on macOS the clipboard holds a word and the user presses `Cmd+V` in an editable file in the
  editor
- **THEN** the word is inserted exactly once

#### Scenario: Copy and paste work in a text field on macOS

- **WHEN** on macOS text is selected in a text field, the user presses `Cmd+C`, then `Cmd+V` in another
  text field
- **THEN** the text is pasted there once

#### Scenario: Paste in the terminal happens once on macOS

- **WHEN** on macOS the clipboard holds a line and the user presses `Cmd+V` in a terminal session
- **THEN** the line reaches the session exactly once

### Requirement: Closing the window while sessions are running asks for confirmation

When the user closes the window (the title bar's close button, `Alt+F4`, or any other close the window
manager delivers) while at least one session of that window **holds a running process**, the main
process SHALL keep the window open and ask the user to confirm, in a native dialog, before anything
is ended. Closing the window ends every running process; nothing a session was running survives it.

- **What counts** is exactly the sessions holding a pty — folder sessions and global sessions alike.
  A dormant session (restored and not woken, or hibernated) and an exited session SHALL NOT count:
  closing loses nothing of theirs.
- The decision to hold the close SHALL be made synchronously in the close event from state the main
  process already holds. It SHALL NOT depend on a round trip to the renderer.
- The dialog SHALL state how many sessions are running and list them by their rail item and label
  (the session's name as the tab derives it, cut to a fixed length), at most 10, then a count of the rest. Sessions known to be **working** —
  an agent that is working or waiting on the user's choice, a shell whose process has a child process
  or has been replaced by another program — SHALL be marked as such and listed first. A session whose
  state is not known SHALL be listed without a mark, not as idle and not as working.
- The dialog SHALL say what closing loses and what it keeps: running commands and an agent's reply in
  progress are lost; claude sessions resume their conversation when woken. **What it says about shells
  and about what is closing SHALL be true on the platform it runs on.** Shells restart in their last
  directory only where the application can read a session's directory; elsewhere they restart in their
  folder, and the dialog says so. On macOS closing the window does not quit the application, and the dialog
  does not say that it does.
- The dialog SHALL offer exactly two answers, closing and cancelling. **Cancelling SHALL be the
  default and the cancel answer** — pressing `Enter` or `Escape` in the dialog SHALL NOT end any
  session.
- Choosing to close SHALL close the window; its sessions end as they do on any close and are restored
  as dormant on the next launch (`session-persistence`), or, on macOS, when the window is opened again.
- Choosing to cancel SHALL leave the window open and every session running, with the same process.

The dialog's text is user-visible copy and SHALL come from the dictionaries in the current UI
language (`ui-localization`).

**One question at a time.** While the dialog is waiting for an answer, a further close of the window
(a second click on the close button, `Alt+F4`, a termination signal, a Quit from the application menu)
SHALL NOT show another dialog and SHALL NOT close the window. The open dialog's answer decides alone. If
the window no longer exists when the answer arrives, the answer SHALL be ignored without an error.

**Acceptance gaps, settled by dogfood** (the automated carrier replaces the native dialog with a
stand-in that records what it was asked and answers from a file, and closes the window from the main
process the way the close button does): that the real close button and `Alt+F4` reach this path, and
that `Enter` / `Escape` in the real native dialog choose its default and cancel answers. It is also
not verified which way each desktop environment ends the application at logout — a termination
signal (which this requirement does not ask about) or a window close (which it would ask about).

#### Scenario: A second close while the dialog is open does not ask twice

- **WHEN** the dialog is open and the window is closed again before it is answered
- **THEN** exactly one dialog has been shown and the window is still open

#### Scenario: Closing with a running session asks first

- **WHEN** a shell session holds a running process and the user closes the window
- **THEN** the window stays open and a dialog asks for confirmation, stating one running session and
  listing it by its rail item and label

#### Scenario: Cancelling keeps every session running

- **WHEN** the user cancels that dialog
- **THEN** the window stays open and the session's process is the same process, still running

#### Scenario: Confirming closes the window and ends the sessions

- **WHEN** on Linux the user confirms that dialog
- **THEN** the application exits, no process of its sessions remains, and on the next launch the
  session is present as dormant

#### Scenario: The safe answer is the default

- **WHEN** the dialog is shown
- **THEN** its default answer and its cancel answer are both "cancel"

#### Scenario: Only dormant sessions close without asking

- **WHEN** every session of the window is dormant and nothing is unsaved, and the user closes the
  window
- **THEN** the window closes without any dialog

#### Scenario: A global session counts

- **WHEN** the only running session belongs to the global item and the user closes the window
- **THEN** the dialog is shown and lists that session under the global item's name

#### Scenario: A working session is marked and listed first

- **WHEN** one shell is idle and another shell runs a command (`sleep`), and the user closes the window
- **THEN** the dialog lists the shell running the command first, marked as working, and the idle shell
  without that mark

#### Scenario: A working agent is marked

- **WHEN** a claude session's agent is working and the user closes the window
- **THEN** the dialog lists that session marked as working

#### Scenario: The dialog does not promise a directory it cannot restore

- **WHEN** the application cannot read a session's directory on its platform and the dialog is shown
- **THEN** the dialog says that shells restart in their folder, not in their last directory

#### Scenario: On macOS the dialog does not say the application closes

- **WHEN** on macOS the dialog is shown for closing the window
- **THEN** it says that closing the window ends the sessions, and does not say that spekterm closes

### Requirement: A quit that does not start with closing the window does not ask about sessions

When the application is asked to quit by something other than the user closing the window, the
confirmation about running sessions SHALL NOT be shown and SHALL NOT hold the quit. Such a request is a
termination signal (`SIGTERM`, as sent by the session manager at logout or shutdown, or by `kill`), or,
on macOS, a quit request from the operating system: the Dock's Quit, logout, or shutdown. Nobody may be
there to answer it, and a held quit ends in a forced kill that skips the application's own cleanup and
its last persistence write. An unattended restart for a system update is such a case.

The application menu's Quit on macOS is **not** such a request: it starts with closing the window (see "On
macOS, quitting from the application menu asks like closing the window").

The confirmation of unsaved changes is unchanged on this path (see "視窗關閉前確認未存的變更"). Once it is
answered with anything but cancel, the quit finishes (see "A quit that waited for an answer finishes once
it is answered").

The one exception is a quit request that arrives while the user is already answering the dialog (the
close came first): a signal, or on macOS the Dock's Quit, logout, or the application menu's Quit. The open
question is not withdrawn behind the user's back, and that request does not end the application by
itself. Answering close ends it, on macOS too, where closing the window alone would leave the application
running: the request turns the open close into a quit. Answering cancel keeps it running and the request
is dropped. Either way, a later close of the window SHALL ask again as described in "Closing the
window while sessions are running asks for confirmation" — the dropped request leaves nothing behind
that would skip the question or turn a later close into a quit (see "One question at a time").

#### Scenario: A signal during the open dialog does not disable the question

- **WHEN** the dialog is open, the application receives `SIGTERM`, the user cancels, and later closes
  the window again while a session is still running
- **THEN** the application is still running after the cancel, and the second close asks again

#### Scenario: A termination signal quits with sessions running

- **WHEN** a shell session holds a running process, nothing is unsaved, and the application receives
  `SIGTERM`
- **THEN** no dialog is shown, the application exits by itself, and no process of its sessions
  remains

#### Scenario: On macOS a quit during the open dialog finishes when answered

- **WHEN** on macOS the user closes the window with a running session, the dialog is open, the user
  presses `Cmd+Q`, and then answers close
- **THEN** the application exits

#### Scenario: An operating-system quit on macOS does not ask about sessions

- **WHEN** on macOS a shell session holds a running process, nothing is unsaved, and the operating system
  asks the application to quit (the quit request the Dock's Quit and logout send)
- **THEN** no dialog is shown, the application exits by itself, and no process of its sessions remains
