## ADDED Requirements

### Requirement: An agent wakes a dormant session it is related to

An agent session SHALL be able to ask spekterm to start a dormant session by writing a **wake** command into its own
drop point, under the same delivery rules as the other session commands. A wake SHALL name its target by a session's
fixed name; a target that is present but not a non-empty string SHALL be refused, as for the other commands. Like
them, a wake SHALL NOT be able to state its own source.

A wake's target SHALL be found by an exact match on the fixed name of a session that **exists**, by the same
definition the relations file uses. The wake SHALL be carried out only when the target is listed in the source's
relations file (see `session-lineage`):

- the source's **parent**;
- a **sibling**: another session created by a handoff from the source's parent, whether or not the parent still
  exists;
- a **descendant** of the source, at any depth, decided as for close, hibernate and rename.

Any other target SHALL be refused, and so SHALL a name that matches no session. When the source session no longer
exists, its wake SHALL be dropped without a notice. A wake with no target, or naming the source itself, SHALL change
nothing and SHALL NOT be refused: the source is running.

**Why the reach is wider than close and hibernate**: a wake ends nothing and loses nothing, and the sessions an agent
needs to message are exactly the ones its relations file lists. A dormant one cannot receive a message, so without
this the agent's only way to reach it is a new handoff, which opens another session in the same repo.

A wake SHALL be carried out by the desktop's own wake, with its effects: the session resumes its conversation under
the same fixed name (only `claude` sessions have a fixed name, so only they can be named), and a failure to start is
shown on the dormant screen with the wake action as the retry. It SHALL be carried out **at once**: a dormant session has no turn
to wait for. It SHALL NOT ask the user, and SHALL NOT need agent event reporting. A target that already has a running
process SHALL be left as it is, and nothing SHALL be reported. Like every command, it SHALL be carried out without
changing the rail selection, the displayed session or the keyboard focus (see "A command is carried out by the
desktop's own action, without taking the desktop away from the user").

**A wake SHALL yield to anything that happened to its target after it was written**, as close and hibernate do: it
SHALL be dropped without a notice when the target's process started or ended after the wake was written, or when
the wake was written before the current run of the application. A user who hibernated the session after the agent
asked for it to be woken has decided later.

A refused wake, and a wake whose target fails to start, SHALL be visible as a refused or failed command is (see "A
refused or failed command is visible to the user, and its receipt states the refusal"). The agent SHALL learn that
the target runs from its relations file, where the target is listed as running.

#### Scenario: A child wakes its hibernated parent

- **WHEN** P handed off to C, the user hibernated P, and the agent in C writes a wake command targeting P's name
- **THEN** P has a running process and has resumed the same conversation under the same fixed name
- **AND** no dialog asked the user, and the rail selection, the displayed session and the keyboard focus are
  unchanged
- **AND** C's relations file lists P as running

#### Scenario: A sibling is woken

- **WHEN** P handed off to C1 and C2, C2 is dormant, and the agent in C1 writes a wake command targeting C2's name
- **THEN** C2 has a running process

#### Scenario: A sibling is woken after the parent closed

- **WHEN** P handed off to C1 and C2, the user closed P, C2 is dormant, and the agent in C1 writes a wake command
  targeting C2's name
- **THEN** C2 has a running process

#### Scenario: A dormant grandchild is woken through a closed intermediate

- **WHEN** P handed off to C, C handed off to G, the user closed C, G is dormant, and the agent in P writes a wake
  command targeting G's name
- **THEN** G has a running process

#### Scenario: A session not in the relations file cannot be woken

- **WHEN** the agent in session S writes a wake command targeting a dormant session that is not S's parent, sibling
  or descendant — a sibling's child, or a session unrelated to S by handoff
- **THEN** that session is still dormant, and the refusal is visible to the user

#### Scenario: An unknown name is refused for a wake

- **WHEN** an agent writes a wake command whose target matches no session's fixed name
- **THEN** no session is started, and the refusal is visible to the user

#### Scenario: Waking a running session changes nothing

- **WHEN** the agent in C writes a wake command targeting its parent P while P is running
- **THEN** P keeps the same process, and nothing is reported to the user

#### Scenario: A wake of the agent's own session changes nothing

- **WHEN** the agent in S writes a wake command with no target
- **THEN** nothing changes, nothing is reported to the user, and the receipt states `accepted`

#### Scenario: A wake does not need agent events

- **WHEN** agent event reporting is off, P is dormant, and the agent in its child C writes a wake command targeting
  P's name
- **THEN** P has a running process

#### Scenario: A wake yields to the user's later hibernation

- **WHEN** the agent in C writes a wake command targeting its running parent P, and the user hibernates P before the
  command is read
- **THEN** P is still dormant after the command is read, and nothing is reported to the user

#### Scenario: A wake left unread at quit does not act after a restart

- **WHEN** the agent in C writes a wake command targeting its dormant parent P, and the application quits before
  the command is read, and is opened again
- **THEN** P is still dormant after the command is read, and nothing is reported to the user

#### Scenario: A wake whose target cannot start is visible

- **WHEN** the agent in C writes a wake command targeting its dormant parent P, and P's process cannot be created
  (its folder's directory no longer exists)
- **THEN** P is dormant and its dormant screen shows the reason
- **AND** a notification states that a session command could not be carried out, and the inbox holds its trace

## MODIFIED Requirements

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

A fourth command, **wake**, is written the same way and is ruled by "An agent wakes a dormant session it is related
to". A delivery whose kind is none of a handoff, a completion report, one of these three commands, a wake, or a
cancel (see `handoff-cancel`) SHALL be refused, as it is today.

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
  visible to the user, and its receipt states the refusal")

#### Scenario: A command cannot claim another source

- **WHEN** the agent in session S writes, into S's drop point, a close command carrying a field that names another
  session as its source
- **THEN** the command is judged as S's command, and the field has no effect

### Requirement: Close, hibernate and rename reach only the agent's own session and the sessions descended from it

This requirement rules close, hibernate and rename. A wake reaches further (see "An agent wakes a dormant session it
is related to"): it ends nothing.

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

## RENAMED Requirements

- FROM: `### Requirement: A command reaches only the agent's own session and the sessions descended from it`
- TO: `### Requirement: Close, hibernate and rename reach only the agent's own session and the sessions descended from it`
