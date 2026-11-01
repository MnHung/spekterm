## MODIFIED Requirements

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
  the target was running when the application quit, so after a restart it starts again (`session-persistence`) —
  a dropped hibernate leaves it running, and a dropped close leaves it in the workspace, running.

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
- **THEN** after the next start, S is still in the workspace and has started again, and it is not closed and no
  close is offered for it

#### Scenario: The user's own action drops a waiting command

- **WHEN** the agent in P writes a close command targeting its working child C, and the user hibernates C before C's
  turn ends
- **THEN** C stays dormant and in the workspace
- **AND** waking C later does not close it at the end of its next turn
