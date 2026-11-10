## MODIFIED Requirements

### Requirement: Agents are told what a listed session without a process is

The relations file the system gives an agent SHALL state, in the file itself (see `session-lineage`), that a
related session listed as not running has no process now: it still exists and cannot receive messages; it was
hibernated, or the system has not started it again yet after a restart; it comes back when the user wakes it, when
the system starts it again after a restart, or when an agent wakes it. The introduction SHALL tell the agent where
its relations file is and that a dormant session can be woken with the wake command (see `agent-session-control`),
whose rules are in the commands rules file the introduction points to (see `agent-handoff-source`). The
introduction SHALL keep directing a child to report through its drop point when its parent is not running: a report
needs no running parent.

#### Scenario: The introduction explains a not-running relative

- **WHEN** a `claude` session starts and is told where its relations are
- **THEN** the introduction it receives names the wake command and the commands rules file, and the relations file
  it points to says that a relative listed as not running has no process now, may be hibernated or not yet started
  again after a restart, and comes back when it is woken or started again
- **AND** neither says that the agent must not wake it
