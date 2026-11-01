## MODIFIED Requirements

### Requirement: Agents are told what a listed session without a process is

The introduction the system gives an agent about its relations SHALL state that a related session listed as
not running has no process now: it still exists and cannot receive messages; it was hibernated, or the system has
not started it again yet after a restart; it comes back when the user wakes it or, after a restart, when the
system starts it again; and the agent SHALL NOT try to wake it. The introduction SHALL keep directing a child to
report through its drop point when its parent is not running.

#### Scenario: The introduction explains a not-running relative

- **WHEN** a `claude` session starts and is told where its relations are
- **THEN** the introduction it receives says that a relative listed as not running has no process now, may be
  hibernated or not yet started again after a restart, returns when the user wakes it or the system starts it
  again, and is not to be woken by the agent
