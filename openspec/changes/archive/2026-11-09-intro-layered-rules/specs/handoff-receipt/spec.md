## ADDED Requirements

### Requirement: A refusal under a rules file's rule names that file

When a delivery is refused for breaking a rule that the introduction does not state but sends the agent to the
repeating rules file or the commands rules file for (see `agent-handoff-source`), the receipt's reason SHALL name
that file's location:

- a repeating handoff refused for its `repeat` or `until` — the repeating rules file;
- a session command refused for its target (no such session, or one it may not act on), for needing agent event
  reporting, for its name's length, or for a missing or wrongly typed field — the commands rules file.

A refusal that is not a rule breach (no window to carry a command out, a command that failed) keeps its reason, and
a reason that refers to the introduction stays where the introduction still states the rule (a handoff's or a
report's field limits).

The agent that skipped the file then learns where the rule is from the refusal itself, and its next attempt can
follow it. A reason SHALL NOT refer the agent to its introduction for a rule the introduction no longer states.
(The teammates and schedules files keep their reasons, which name those files; this requirement does not change
them.)

The location is system-written; the receipt's rule that it carries no text from the delivery is unchanged.

#### Scenario: A refused repeating handoff points to the repeating rules file

- **WHEN** an agent writes a handoff whose `repeat` has a minute of `*/5`
- **THEN** its receipt states `rejected`, permanent, with a reason that names the repeating rules file's location and
  does not refer to the introduction

#### Scenario: A refused rename points to the commands rules file

- **WHEN** an agent writes a rename command whose name is one character over the limit
- **THEN** its receipt states `rejected` with a reason that names the commands rules file's location

#### Scenario: A refused command target points to the commands rules file

- **WHEN** an agent writes a close command naming its sibling
- **THEN** its receipt states `rejected` with a reason that names the commands rules file's location
