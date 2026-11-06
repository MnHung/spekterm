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

A delivery whose kind is none of a handoff, a completion report, one of these three commands, or a cancel (see
`handoff-cancel`) SHALL be refused, as it is today.

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
