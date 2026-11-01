## MODIFIED Requirements

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
  progress are lost; when the sessions start again (at the next launch, when the window opens again on macOS, or
  after the update's restart) claude sessions resume their conversation. **What it says about shells
  and about what is closing SHALL be true on the platform it runs on.** Shells restart in their last
  directory only where the application can read a session's directory; elsewhere they restart in their
  folder, and the dialog says so. On macOS closing the window does not quit the application, and the dialog
  does not say that it does.
- The dialog SHALL offer exactly two answers, closing and cancelling. **Cancelling SHALL be the
  default and the cancel answer** — pressing `Enter` or `Escape` in the dialog SHALL NOT end any
  session.
- Choosing to close SHALL close the window; its sessions end as they do on any close, and the ones that were
  running start again on the next launch (`session-persistence`), or, on macOS, when the window is opened again.
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
  session is present and has started again with a new process

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

### Requirement: On macOS, closing the window leaves the application running and activating it reopens the window

On macOS, closing the window SHALL end its sessions exactly as on other platforms (with the same
confirmation), and SHALL NOT quit the application. This follows the convention of macOS terminal
applications. Activating the application while it has no window (clicking its Dock icon, opening it
again) SHALL open a new window, whose sessions are restored as they are after a restart
(`session-persistence`): the ones that were running when the window closed start again, and the others are
dormant.

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
- **THEN** a window opens, the session that was running when the window closed is present and has started
  again, and a session that was dormant then is present as dormant

#### Scenario: The second window has the menu

- **WHEN** on macOS the window is closed and the application is activated again
- **THEN** the new window's application menu still contains Quit and the Edit menu

#### Scenario: An inbox action with no window opens one

- **WHEN** on macOS the application has no window and an action that opens the inbox is triggered
- **THEN** a window opens and its inbox opens once the window's interface is ready
