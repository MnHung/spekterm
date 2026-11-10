## MODIFIED Requirements

### Requirement: Agents are told what a listed session without a process is

The introduction the system gives an agent about its relations SHALL state that a related session listed as
not running has no process now: it still exists and cannot receive messages; it was hibernated, or the system has
not started it again yet after a restart; it comes back when the user wakes it, when the system starts it again
after a restart, or when an agent wakes it; and the agent MAY wake it with the wake command (see
`agent-session-control`) when it needs to reach it. The introduction SHALL keep directing a child to report through
its drop point when its parent is not running: a report needs no running parent.

#### Scenario: The introduction explains a not-running relative

- **WHEN** a `claude` session starts and is told where its relations are
- **THEN** the introduction it receives says that a relative listed as not running has no process now, may be
  hibernated or not yet started again after a restart, and can be woken with the wake command when the agent needs
  to reach it
- **AND** it no longer says that the agent must not wake it
