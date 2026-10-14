# session-hibernation Specification

## Purpose
Lets a running session go back to the dormant state — by the user's hand or after a period of idleness — so
that sessions kept in the workspace for occasional use stop holding a live process between uses.

## Requirements

### Requirement: The user can hibernate a running session

The system SHALL let the user hibernate a running session from the session's tab context menu and from its
row on the rail. Hibernating SHALL end the session's process and leave the session **dormant** — the same
state a restored, not-yet-woken session is in (see `session-persistence`).

The session SHALL keep everything that identifies it: its place in the tab order and on the rail, its
user-given name, the title its process last declared, its working directory identifier, its fixed agent
name, its lineage, and — for a `claude` session — its conversation identifier.

The hibernate action SHALL be offered only for a running session. It SHALL NOT be offered for a dormant or
an exited session.

#### Scenario: Hibernating a shell session ends its process and keeps the tab

- **WHEN** the user hibernates a running shell session
- **THEN** the session's process no longer exists
- **AND** the session remains in the same tab position, with the same label, shown as dormant

#### Scenario: A hibernated claude session resumes the same conversation

- **WHEN** the user hibernates a running `claude` session that has exchanged messages with the agent, and
  later wakes it
- **THEN** the session resumes the same conversation

#### Scenario: A session can be hibernated and woken repeatedly

- **WHEN** the user hibernates a session, wakes it, hibernates it again and wakes it again
- **THEN** after each wake the session is running

#### Scenario: No hibernate action on a session without a process

- **WHEN** the user opens the context menu of a dormant session, or of an exited session
- **THEN** the menu does not offer to hibernate it

### Requirement: Hibernation is not closing

A hibernated session SHALL NOT be treated as ended. In particular:

- it SHALL NOT be shown as exited;
- it SHALL remain persisted, and SHALL be restored as dormant when the application is reopened;
- it SHALL continue to exist for lineage (see `session-lineage`, the single definition of existence): it
  stays in its relatives' relations, listed as not running and not closed;
- when woken, it SHALL be able to hand work off and report exactly as before it was hibernated;
- if it was created by a handoff, it SHALL show no lifecycle state while hibernated (see `handoff-completion`:
  a dormant session has none) — not the state it last had while running.

A hibernated parent still receives its children's results: a child reports through its own drop point, and
the system keeps the report for the parent (see `handoff-completion`).

#### Scenario: A hibernated session survives a restart as dormant

- **WHEN** the user hibernates a session, closes the application and reopens it
- **THEN** the session exists in the same place and is dormant

#### Scenario: A hibernated parent is listed as existing and not running

- **WHEN** the user hibernates session P, the parent of session C
- **THEN** C's relations list P as its parent, not running, and not closed

#### Scenario: A woken session can hand off again

- **WHEN** the user hibernates a `claude` session and wakes it, and its agent then writes a handoff
- **THEN** the handoff is delivered and the new session lists the woken session as its parent

#### Scenario: A hibernated handoff child shows no lifecycle state

- **WHEN** a session created by a handoff has reported that it is waiting for the user, and the user
  hibernates it
- **THEN** it is shown as dormant, not as waiting for the user, and its parent's relations list it as idle

#### Scenario: A child's report reaches a hibernated parent

- **WHEN** session P handed work to session C, the user hibernates P, and C then writes a completion report
- **THEN** the report is processed and C is shown as done
- **AND** when P is woken and queries its relations, C is listed with that report's summary

### Requirement: Waking a hibernated session restores what restore restores

Waking a hibernated session SHALL behave exactly as waking a restored session (see `session-persistence`):
a shell session SHALL show its screen as it was **at the moment it was hibernated**, distinguished from the new
shell's output, and SHALL start in its last working directory; a `claude` session SHALL show the resumed
conversation **once** — the screen as it was before hibernation SHALL NOT be shown in addition to it.

#### Scenario: Output produced just before hibernation is kept

- **WHEN** a shell session prints a line and the user hibernates it immediately afterwards, then wakes it
- **THEN** that line is visible, above the marker that separates history from the new shell's output

#### Scenario: A woken shell starts where it was

- **WHEN** the user changes directory in a shell session, hibernates it and wakes it
- **THEN** the new shell's working directory is the one the user changed to

#### Scenario: A woken claude session does not show its history twice

- **WHEN** the user hibernates a `claude` session whose screen shows a line of its conversation, and wakes it,
  and the resumed agent shows that line again
- **THEN** that line appears on the screen once

### Requirement: A dormant shell session states what was not kept

The dormant screen of a shell session SHALL state that a shell's unexported environment, its unsaved command
history, and any jobs it was running do not survive hibernation. A `claude` session's dormant screen SHALL NOT
carry that statement — its conversation does survive.

#### Scenario: The note appears for a shell only

- **WHEN** the user views a dormant shell session, and then a dormant `claude` session
- **THEN** the first states what a shell does not keep, and the second does not

### Requirement: Idle sessions hibernate automatically

When automatic hibernation is enabled (see `terminal-preferences`), the system SHALL hibernate a running
session once all of the following hold, and SHALL NOT hibernate it otherwise:

1. it is **not the session currently displayed**;
2. no **activity** has occurred in it for at least the configured threshold. Activity is: the session
   becoming displayed or ceasing to be displayed; for a shell session, any output from its process; for a
   `claude` session, a change in the agent's waiting state. The agent's own output is not activity, and
   replies the terminal generates on its own (focus reports, answers to terminal queries) are not activity;
3. it is **idle**:
   - a `claude` session: the agent reports, currently, that it is waiting for the user's next message. A
     session whose agent is working, is waiting on a choice (such as a permission prompt), or whose state is
     unknown is not idle — **whether or not the session is being watched**. A session holding a filled-in
     prompt whose submission has not been confirmed (see `agent-intake`) is not
     idle either: resuming would discard the unsent text;
   - a shell session: the process the session started **is still the shell it started as** (not a program
     the shell replaced itself with) **and** it has no child processes. A foreground job, a background job, a
     replaced process, or a failure to determine any of these means it is not idle. On a platform where this
     cannot be determined, shell sessions are never idle.

Automatic hibernation SHALL leave the session in the same state as manual hibernation.

**Fail closed**: every case in which idleness cannot be established keeps the session running. Ending a
process the user was relying on is not recoverable; an extra process costs memory.

#### Scenario: An idle shell hibernates after the threshold

- **WHEN** a shell session sits at its prompt, is not displayed, and has had no activity for longer than the
  threshold
- **THEN** the session is hibernated

#### Scenario: The displayed session never hibernates automatically

- **WHEN** the displayed session is otherwise eligible and the threshold passes
- **THEN** it is still running

#### Scenario: A shell running a foreground job stays running

- **WHEN** a shell session that is not displayed runs a long foreground command, and the threshold passes
  with no further activity
- **THEN** it is still running

#### Scenario: A shell with a background job stays running

- **WHEN** a shell session that is not displayed has a job running in the background and is at its prompt,
  and the threshold passes with no further activity
- **THEN** it is still running

#### Scenario: A working agent stays running

- **WHEN** a `claude` session that is not displayed reports that its agent is working, and the threshold
  passes
- **THEN** it is still running

#### Scenario: An agent waiting on a choice stays running

- **WHEN** a `claude` session that is not displayed is waiting on a permission choice, and the threshold
  passes
- **THEN** it is still running

#### Scenario: An idle agent hibernates after the threshold

- **WHEN** a `claude` session that is not displayed reports that its agent is waiting for the next message,
  and has had no activity for longer than the threshold
- **THEN** the session is hibernated

#### Scenario: Showing a session restarts the clock

- **WHEN** an idle session that is not displayed is shown briefly and left again shortly before the threshold
  would have passed
- **THEN** it is still running when the original threshold passes
- **AND** it is hibernated once the threshold has passed again since it was left

#### Scenario: An agent that starts working while unwatched stays running

- **WHEN** a `claude` session that is not displayed and has never been shown in the conversation view starts
  working, and keeps working past the threshold
- **THEN** it is still running

#### Scenario: An unsent filled-in prompt keeps the session running

- **WHEN** a `claude` session that is not displayed holds a filled-in first prompt that has not been sent, its
  agent waiting, and the threshold passes
- **THEN** it is still running

#### Scenario: A shell replaced by another program stays running

- **WHEN** the shell of a session that is not displayed has replaced itself with another program (for example
  with `exec`), and the threshold passes with no further activity
- **THEN** it is still running

#### Scenario: Disabled means never

- **WHEN** automatic hibernation is disabled and an idle, undisplayed session passes what would have been the
  threshold
- **THEN** it is still running

### Requirement: Activity during an automatic hibernation prevents it

If a session stops being eligible after it has been judged eligible for automatic hibernation but before its
process is ended — it became displayed, its agent started working, it produced output — the system SHALL NOT
hibernate it. The decision SHALL be re-checked at the moment of execution.

This re-check SHALL apply to automatic hibernation only. A hibernation the user asked for SHALL proceed even
for the displayed session or a working agent.

#### Scenario: A session displayed between decision and execution is kept

- **WHEN** a session has been judged eligible and becomes the displayed session before its process is ended
- **THEN** the session is still running

#### Scenario: The user can hibernate the displayed, working session

- **WHEN** the displayed session's agent is working and the user hibernates it
- **THEN** it is hibernated

### Requirement: Agents are told what a listed session without a process is

The introduction the system gives an agent about its relations SHALL state that a related session listed as
not running is hibernated: it still exists, it comes back when the user wakes it, and the agent SHALL NOT try
to wake it. The introduction SHALL keep directing a child to report through its drop point when its parent is
not running.

#### Scenario: The introduction explains a not-running relative

- **WHEN** a `claude` session starts and is told where its relations are
- **THEN** the introduction it receives says that a relative listed as not running is hibernated, returns when
  the user wakes it, and is not to be woken by the agent

### Requirement: A session a paired device is watching counts as displayed

For automatic hibernation, a session whose conversation or terminal a connected paired device is watching
(see `remote-protocol`) SHALL count as a displayed session. "Watching" here means a remote device's watch.
It is distinct from the desktop conversation view that other scenarios of this capability call "watched". It SHALL therefore not be hibernated
automatically while watched. A device starting or stopping to watch a session SHALL count as that session
becoming displayed or ceasing to be displayed, which is activity. Manual hibernation is unaffected.

Without this rule, a session the user is reading on their phone could be ended under them as soon as the
threshold passed, because the desktop is not displaying it.

#### Scenario: A watched session does not hibernate

- **WHEN** automatic hibernation has a threshold of a few seconds, a paired device watches the conversation of an idle agent session that the desktop does not display, and the threshold passes
- **THEN** the session is still running

#### Scenario: A session hibernates once the device stops watching

- **WHEN** the device stops watching that session, and the threshold passes again with no activity
- **THEN** the session is hibernated
