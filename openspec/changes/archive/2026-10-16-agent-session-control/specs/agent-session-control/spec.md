## Purpose

Lets an agent running in spekterm close, hibernate or rename its own session and the sessions descended from it
by handoff, so the user can ask the agent for these actions instead of reaching for the interface.

## ADDED Requirements

### Requirement: An agent asks spekterm to close, hibernate or rename a session through its own drop point

An agent session SHALL be able to request three actions on a session by writing a command into its own handoff
drop point (see `agent-handoff-source`), under the same delivery rules as a handoff (file name, atomic write,
whole-file size limit):

- **close** the session, with the same effect as the desktop's close: the process ends, and the session leaves
  the workspace;
- **hibernate** the session, with the same effect as the desktop's hibernate: the process ends, and the session
  stays dormant in the workspace (see `session-hibernation`);
- **rename** the session, with the same effect as the desktop's rename: the label changes, and an empty name
  hands naming back to the terminal title.

A command SHALL name its target by a session's fixed name (see `agent-peer-name`), or omit the target. **An
omitted target SHALL mean the agent's own session**, and so SHALL the agent's own name.

The source of a command SHALL be derived from the drop point it lands in, as for a handoff. A command SHALL NOT be
able to state its own source.

A rename's name SHALL be flattened to one line and normalized as other fields an agent writes are, and SHALL be
held to the length limit of a handoff's title, counted in code points. A longer name SHALL be refused, not shortened. A rename without
a name, and a target that is present but not a non-empty string, SHALL be refused. A rename SHALL NOT change any
session's fixed name.

A delivery whose kind is none of a handoff, a completion report, or one of these three commands SHALL be refused,
as it is today.

#### Scenario: An agent closes its own session

- **WHEN** the agent in session S writes a close command with no target into S's drop point, its turn ends, and the
  user then chooses to close S from the offer shown over it
- **THEN** S is closed: its process has ended, and S no longer appears in the workspace

#### Scenario: An agent hibernates its own session

- **WHEN** the agent in session S writes a hibernate command with no target, and its turn ends
- **THEN** S is dormant and still in the workspace, and waking it resumes the same conversation

#### Scenario: The agent's own name means its own session

- **WHEN** the agent in session S writes a close command whose target is S's fixed name, and its turn ends
- **THEN** S is closed, as with an omitted target

#### Scenario: An agent renames its own session

- **WHEN** the agent in session S writes a rename command with the name "Fix login", while S is working
- **THEN** S's tab and rail row read "Fix login"
- **AND** S's fixed name is unchanged

#### Scenario: An empty name hands naming back

- **WHEN** the agent in session S, which the user named earlier, writes a rename command whose name is empty
  after normalization
- **THEN** S's label follows the terminal title again, as after the desktop's rename to an empty name

#### Scenario: A multi-line name becomes one line

- **WHEN** an agent writes a rename command whose name spans two lines
- **THEN** the target's label is those two lines joined by a space

#### Scenario: An overlong name is refused

- **WHEN** an agent writes a rename command whose name exceeds the title's length limit
- **THEN** no session is renamed, and the refusal is visible to the user (see "A refused or failed command is
  visible to the user, and the agent is not told")

#### Scenario: A command cannot claim another source

- **WHEN** the agent in session S writes, into S's drop point, a close command carrying a field that names another
  session as its source
- **THEN** the command is judged as S's command, and the field has no effect

### Requirement: A command reaches only the agent's own session and the sessions descended from it

A command's target SHALL be found by an exact match on the fixed name of a session that **exists** by the same
definition the rail and the relations file use (see `session-lineage`, "session 的存在有單一定義"). A session the
agent cannot see in its relations SHALL NOT be a target. The command SHALL be carried out only when the target is:

- the source session itself; or
- **a descendant of the source**: a session created by a handoff from the source, or by a handoff from such a
  session, at any depth (see `session-lineage`).

Any other target SHALL be refused. This includes the source's parent, its siblings, their descendants, and any
session unrelated to it by handoff. A name that matches no session SHALL be refused.

Whether a target is a descendant SHALL be decided from the lineage the system recorded when each session was
created, SHALL NOT be decided from the command's contents, and SHALL NOT require the source session to still
exist. **A descendant SHALL remain one after a session between them has been closed.**

When the source session no longer exists, a command naming one of its existing descendants SHALL still be
carried out. Any other command from it SHALL be dropped without a notice: there is nothing left to act on, and the
agent made no error. That covers a command with no target, one naming the source itself, and one naming nothing
that exists.

#### Scenario: A grandparent closes a grandchild

- **WHEN** session P handed off to C, C handed off to G, and the agent in P writes a close command targeting G's
  name while G is ready
- **THEN** G is closed

#### Scenario: A descendant stays reachable after the session between them closes

- **WHEN** P handed off to C, C handed off to G, the user then closed C, and the agent in P writes a hibernate
  command targeting G's name
- **THEN** G is hibernated

#### Scenario: A parent cannot be targeted

- **WHEN** the agent in session C, created by a handoff from P, writes a close command targeting P's name
- **THEN** P is not closed, and the refusal is visible to the user

#### Scenario: A sibling cannot be targeted

- **WHEN** P handed off to C1 and C2, and the agent in C1 writes a close command targeting C2's name
- **THEN** C2 is not closed, and the refusal is visible to the user

#### Scenario: An unrelated session cannot be targeted

- **WHEN** the agent in session S writes a close command targeting the name of a session that no handoff from S
  created, directly or indirectly
- **THEN** that session is not closed, and the refusal is visible to the user

#### Scenario: An unknown name is refused

- **WHEN** an agent writes a close command whose target matches no session's fixed name
- **THEN** no session is closed, and the refusal is visible to the user

#### Scenario: A session hidden from the relations cannot be targeted

- **WHEN** P handed off to C, the user removes C's folder from the workspace while C's record remains, and the
  agent in P writes a close command targeting C's name
- **THEN** C is not closed, and the refusal is visible to the user

#### Scenario: A command from a session already closed, naming itself, is dropped silently

- **WHEN** session S is closed, and its drop point's final read finds a close command targeting S's own name
- **THEN** nothing is reported to the user

#### Scenario: A descendant command read after its source closed is still judged

- **WHEN** the agent in P wrote a hibernate command targeting its child C, and the drop point is first read after
  P was closed
- **THEN** C is hibernated

### Requirement: Close and hibernate wait for the end of the target's current turn

A close or hibernate command on a target that has a running process SHALL NOT end that process in the middle of
a turn. It SHALL be carried out when the target is **at rest**: no turn is in progress. A turn SHALL be considered
in progress from the moment anything is typed into the session, or its agent reports a submitted prompt, until
the agent reports the end of its own turn with no background subagent of its own still running. Starting,
resuming or clearing the conversation ends any turn. Typing starts a turn because some turns report no start at
all: a shell command the user runs through the agent reports only its end. A compaction the user asks for ends
the turn the user started with it, since it reports no other end. Notifications the agent sends while idle, a
compaction the agent starts on its own, and its subagents' activity SHALL NOT start or end a turn.

It SHALL be carried out at once when the target is at rest at the moment the command is read, and otherwise at the
first moment afterwards that it is.

Each of these SHALL therefore be treated as **not** at rest, even when the agent would accept input:

- a turn stopped on a permission prompt; the command waits through the prompt until the turn ends;
- a compaction the agent starts on its own inside a turn;
- a turn whose agent stopped while a background subagent of its own still runs; the command waits until the
  turn that follows that subagent's end has ended.

A background shell command the agent started SHALL NOT hold the turn open: closing ends it, as the desktop's
close does.

A child that has not yet been sent its first prompt is at rest, and a close read then SHALL be carried out. Once
spekterm has written the first prompt, the child is in a turn.

**A target that stays in a turn without reporting an end SHALL NOT be acted on, and this gap SHALL be recorded,
not claimed absent.** That covers:

- a turn the user interrupted;
- text the user typed and did not send;
- input that reached the session without being the user's.

A command arriving at such a target waits, and the user's next turn starts with typing, which drops it (see "A
waiting command yields to the user and does not outlive the application"). The command is therefore never carried
out, and the agent is not told.

The agent's own session is covered by this rule. The command is typically written during the agent's turn, so it
SHALL take effect only after that turn ends, and the agent's last reply SHALL NOT be cut off.

A **rename** SHALL take effect at once, whatever the target is doing.

On a target **without a process** (dormant), a hibernate command SHALL do nothing (the state asked for already
holds), and a close command SHALL take effect at once.

**When the agent's events are turned off**, rest cannot be observed. A close or hibernate command on a target with
a running process SHALL then be refused. It SHALL NOT be held indefinitely, SHALL NOT be carried out mid-turn, and
SHALL NOT be retried later. Because a feature being off causes it, the refusal SHALL leave a trace in the inbox and
SHALL NOT send a notification (see `agent-intake`).

#### Scenario: Closing itself does not cut off the agent's reply

- **WHEN** the agent in session S writes a close command with no target and then continues its reply
- **THEN** S's process is still running until that reply has ended
- **AND** after it has ended, S is offered for closing, and is still running

#### Scenario: A shell command the user runs through the agent is a turn

- **WHEN** the user runs a long shell command through C's agent, and while it runs the agent in P writes a close
  command targeting C
- **THEN** C is not closed while the command runs, and is closed once it has ended

#### Scenario: A compaction the user asked for ends that turn

- **WHEN** the user compacts C's conversation by hand while C is otherwise idle, and afterwards the agent in P
  writes a close command targeting C
- **THEN** C is closed without waiting for another turn

#### Scenario: A busy descendant is acted on when its turn ends

- **WHEN** the agent in P writes a close command targeting its child C while C is working
- **THEN** C keeps running while it works
- **AND** C is closed once its turn ends

#### Scenario: A permission prompt does not end the turn

- **WHEN** the agent in P writes a hibernate command targeting C while C waits on a permission prompt, and the
  user then answers the prompt from a paired device and C keeps working
- **THEN** C is not hibernated before its turn ends, and is hibernated once it ends

#### Scenario: A finished child that has been idle a long time is acted on at once

- **WHEN** C ended its turn, has been idle long enough for its agent to report that it is waiting for input, and
  the agent in P writes a close command targeting C
- **THEN** C is closed without waiting for another turn

#### Scenario: A background subagent keeps the turn open

- **WHEN** the agent in P writes a close command targeting C, and C's agent stops its turn while a background
  subagent it started still runs
- **THEN** C is not closed while that subagent runs
- **AND** C is closed once the turn after the subagent's end has ended

#### Scenario: A compaction is not the end of a turn

- **WHEN** the agent in P writes a hibernate command targeting C while C is working, and C's conversation is
  compacted before C's turn ends
- **THEN** C is not hibernated at the compaction, and is hibernated once its turn ends

#### Scenario: A ready descendant is acted on at once

- **WHEN** the agent in P writes a close command targeting its child C while C is ready for input
- **THEN** C is closed without waiting for another turn

#### Scenario: A rename does not wait

- **WHEN** the agent in P writes a rename command targeting C while C is working
- **THEN** C's label changes while C is still working

#### Scenario: A dormant target is closed at once

- **WHEN** the agent in P writes a close command targeting its child C while C is dormant
- **THEN** C is closed

#### Scenario: Hibernating a dormant target changes nothing

- **WHEN** the agent in P writes a hibernate command targeting its child C while C is dormant
- **THEN** C stays dormant and in the workspace, and nothing is reported as failed

#### Scenario: With agent events off, a running target is not ended

- **WHEN** agent events are turned off, and an agent writes a close command targeting a session that has a running
  process
- **THEN** that session's process keeps running
- **AND** the inbox holds a trace of the refusal, and no notification is sent

### Requirement: A waiting command yields to the user and does not outlive the application

While a close or hibernate command waits for its target's turn to end:

- **anything typed into the target SHALL drop the waiting command**, without a notice. A user who types into a
  session has taken it back, and an interrupted turn may report nothing until the user's next one. This covers:
  - the desktop's keyboard, including answering a permission prompt at the desktop;
  - a paired device's reply;
  - spekterm's own sending of a handed-off session's first prompt.

  It does not cover a paired device's answer to a permission prompt, which is not typing;
- a later close or hibernate command for the same target SHALL replace it: only the latest one is carried out;
- when the target's process ends for any other reason (the user hibernates or closes it, or it exits), the waiting
  command SHALL be dropped without being carried out and without a notice;
- a waiting command SHALL NOT survive the application quitting. **This gap SHALL be recorded, not claimed absent**:
  after a restart every session is dormant, so a dropped hibernate changes nothing. A dropped close leaves a
  dormant session in the workspace.

**A close or hibernate command SHALL yield to anything that happened to its target after the command was
written.** It SHALL be dropped without a notice when the target's process started or ended after the command was
written, or when the command was written before the current run of the application. A process end that an
earlier command caused SHALL NOT count, so that the latest of several commands still wins. This holds for a command read
late as well as for one that waited. A rename is not subject to this rule.

#### Scenario: The latest command for a target wins

- **WHEN** the agent in P writes a hibernate command and then a close command, both targeting its working child C
- **THEN** once C's turn ends, C is closed, and it was not hibernated first

#### Scenario: Typing into the target drops a waiting command

- **WHEN** the agent in P writes a close command targeting its working child C, and the user interrupts C and types
  a new prompt into it
- **THEN** C is not closed when the new prompt's turn ends

#### Scenario: A self-close read after the user hibernated the session is dropped

- **WHEN** the agent in S writes a close command for itself, and the user hibernates S before the drop point is
  read
- **THEN** S stays dormant and in the workspace when the command is read

#### Scenario: A self-close left unread at quit does not act after a restart

- **WHEN** the agent in S writes a close command for itself, and the application quits before the drop point is
  read
- **THEN** after the next start, S is dormant and still in the workspace

#### Scenario: The user's own action drops a waiting command

- **WHEN** the agent in P writes a close command targeting its working child C, and the user hibernates C before C's
  turn ends
- **THEN** C stays dormant and in the workspace
- **AND** waking C later does not close it at the end of its next turn

### Requirement: An agent's close of its own session is offered to the user, not carried out

When the agent's own session is the target of a close command and its turn has ended, the system SHALL NOT close
it. It SHALL instead **offer** the close: the session's terminal view and conversation view SHALL show that the
agent asked to close this session, with an action that closes it and an action that keeps it. The session SHALL
keep running, and SHALL close only when the user chooses to close it. The agent's last reply may be what the user
most needs to read, and a close at the end of the turn would take it away the moment it appears.

The offer SHALL leave the session's content readable and scrollable underneath: only the offer's own controls take
pointer input. The offer SHALL NOT take keyboard focus.

The offer SHALL be withdrawn, and the session kept, when:

- the user chooses to keep it;
- anything is typed into the session (the same rule that drops a waiting command);
- the session's process ends for any other reason.

Choosing to close SHALL be the user's own close, with the effects of the desktop's close. A hibernate command on the
agent's own session, and every command on a descendant, SHALL NOT be offered: they are carried out as before. An
offer SHALL NOT survive the application quitting.

#### Scenario: The close is offered when the turn ends, and nothing closes on its own

- **WHEN** the agent in session S writes a close command with no target, and its turn ends
- **THEN** S's views show that the agent asked to close it, with a close and a keep action
- **AND** S is still running after its turn has ended

#### Scenario: The agent's last words stay readable under the offer

- **WHEN** S is offered for closing
- **THEN** the content of S's terminal is still visible and can be scrolled, and keyboard focus has not moved

#### Scenario: Keeping the session withdraws the offer

- **WHEN** S is offered for closing, and the user chooses to keep it
- **THEN** the offer is gone, and S is still running

#### Scenario: Typing into the session withdraws the offer

- **WHEN** S is offered for closing, and the user types into S
- **THEN** the offer is gone, and S is still running

#### Scenario: A descendant's close is not offered

- **WHEN** the agent in P closes its child C, which is at rest
- **THEN** C is closed without any offer

### Requirement: A command is carried out by the desktop's own action, without taking the desktop away from the user

A command read before the window has restored its sessions SHALL wait until the restore is done, and SHALL NOT
fail for a session that exists.

Each command SHALL be carried out by the same action the desktop's controls use for it, so its effects are those
of the desktop's action: a close removes the session and what the desktop removes with it, and a hibernation keeps
what the desktop's hibernation keeps.

Carrying out a command SHALL NOT change the rail selection and SHALL NOT take keyboard focus. The focused session
SHALL change only when the displayed session is closed, as the close of a displayed session forces it to. This
applies to every command the system carries out without the user. The close of the agent's own session is
offered instead (see "An agent's close of its own session is offered to the user, not carried out"), and choosing
it is the user's own close.

#### Scenario: Closing the displayed session does not move the keyboard into another terminal

- **WHEN** child session C is displayed, and the agent in its parent P closes C when C's turn ends
- **THEN** the rail selection is unchanged
- **AND** keyboard focus is not in any session's terminal or conversation input

#### Scenario: A command read at startup waits for the restored sessions

- **WHEN** the application quit with an unread rename command targeting a session, and it starts again
- **THEN** that session, restored and dormant, is renamed, and no failure is reported

#### Scenario: Acting on a background session does not disturb the displayed one

- **WHEN** the user is typing in session D, and the agent in P hibernates its child C, which is not displayed
- **THEN** D is still displayed, and keyboard focus is still in D

### Requirement: A refused or failed command is visible to the user, and the agent is not told

A command that is refused (unknown target, a target the source may not act on, an invalid or overlong field) or
that the interface cannot carry out (the session gone in between, an error) SHALL be visible to the user the way a
failed handoff is: a notification, and a trace in the inbox.

A failure that a resend could overcome with no setting changed SHALL leave the trace only and SHALL NOT notify,
as `agent-intake` rules for temporary failures. These are:

- a refusal because agent events are off;
- no window to carry the command out, or no answer from it in time.

A command SHALL NOT wait for a window indefinitely. A
notification about a single failed command SHALL say that a **session command** could not be carried out, not that
a handoff failed. A notification that merges several failures MAY use its general wording. A command file over
the whole-file size limit is refused before its kind is read, and its notification MAY use the handoff wording. The trace SHALL state the
sending session's rail item and label, the target as written, and why it failed. A command that fails after it
waited for its target's turn SHALL be just as visible.

The same command file read more than once SHALL be acted on once.

**The agent SHALL NOT receive the outcome.** As with handoffs, there is no reply channel, and this gap SHALL be
stated to the agent rather than hidden (see `agent-handoff-source`). What the agent can observe is its relations
file: a closed descendant is absent from it, a hibernated one is listed as not running, and a renamed one shows
its new label.

#### Scenario: A refusal produces a notification and an inbox trace

- **WHEN** the agent in C writes a close command targeting its parent P
- **THEN** a notification states that a session command could not be carried out
- **AND** the inbox holds a trace stating C's rail item and label, P's name as the target, and that C may not act
  on it

#### Scenario: A failure after waiting is still visible

- **WHEN** the agent in P writes a close command targeting its working child C, and when C's turn ends the
  interface answers that C cannot be found
- **THEN** a notification states that a session command could not be carried out, and the inbox holds its trace

#### Scenario: A command read twice is carried out once

- **WHEN** the same rename command file is read by both the watcher and the periodic re-read before it is consumed
- **THEN** the target is renamed once, and no failure is reported

#### Scenario: A descendant's outcome is visible in the relations file

- **WHEN** the agent in P closes its ready child C
- **THEN** P's relations file no longer lists C
