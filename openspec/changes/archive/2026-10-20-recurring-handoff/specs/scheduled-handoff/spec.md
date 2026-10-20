## MODIFIED Requirements

### Requirement: A handoff may name the time its session opens, in one strict format and within a bound

A handoff payload MAY carry an `at` field. When present it SHALL be a string in the ISO 8601 extended form
`YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by **an explicit offset** (`Z` or `±HH:MM`). The system SHALL
refuse, as a permanent failure of the handoff (`agent-handoff-source`, "交接的失敗對使用者可見"), an `at`
that:

- is not a string, or does not have that form;
- **has no offset** — a time without one is read in the desktop's local zone by common parsers, and the
  agent that wrote it may have meant another; guessing is how a handoff opens hours off;
- names a calendar date or time that does not exist (30 February, hour 24) — common parsers roll these over
  to another day instead of failing;
- lies further in the future than the scheduling bound (30 days after the handoff is read). A schedule that
  far ahead is more likely a mistyped month or year than a plan, and it would wait unnoticed.

**Whether a handoff is scheduled SHALL be decided once, when it is read**, against one reading of the clock:
an `at` later than that moment schedules it; an `at` not later than that moment makes the handoff behave
exactly as one without `at` — it is not a scheduled handoff, and nothing downstream compares its time again.
A handoff without `at` SHALL behave exactly as before this capability.

**With `repeat` (`recurring-handoff`), `at` is the time the recurrence starts, not the time the handoff opens**:
the format, offset, date and bound rules above SHALL apply to it unchanged, but such a handoff SHALL NOT be a
scheduled handoff — it is a proposal that waits for the user's approval, and nothing compares its `at` with the
clock to open it. **Wherever this capability speaks of a handoff with a future `at`, it means one without
`repeat`**: a proposal raises its arrival notification and counts in the badge (`recurring-handoff`).

The bound SHALL be the same value the introduction states (`agent-handoff-source`), derived from one source.

#### Scenario: A time with an offset in the future schedules the handoff

- **WHEN** an agent writes a valid handoff with `at` set to one hour from now with an explicit offset
- **THEN** no session is created when it is read, and the handoff is listed as scheduled for that time

#### Scenario: A time without an offset is refused

- **WHEN** an agent writes a handoff with `at` set to a time that has no offset
- **THEN** no session is created, a notification is raised, and the inbox shows a failure for that handoff

#### Scenario: A date that does not exist is refused

- **WHEN** an agent writes a handoff with `at` naming 30 February at 10:00 with an offset
- **THEN** the handoff is refused as a failure visible in the inbox, and no session is created

#### Scenario: A time beyond the bound is refused

- **WHEN** an agent writes a handoff with `at` 31 days from now
- **THEN** the handoff is refused as a failure visible in the inbox, and no session is created

#### Scenario: A time in the past opens at once

- **WHEN** an agent writes a valid handoff with `at` set to one minute ago
- **THEN** a session is created for it on arrival, as for a handoff without `at`, and the inbox never lists it as scheduled

#### Scenario: With repeat, at is the start of the recurrence

- **WHEN** an agent writes a valid handoff with `repeat` and `at` set to tomorrow with an explicit offset
- **THEN** it is not listed as a scheduled handoff, it is listed as a proposal waiting for approval, a notification is raised and it counts in the badge, and its first listed time is not earlier than tomorrow's `at`

#### Scenario: With repeat, at still follows the format rules

- **WHEN** an agent writes a handoff with `repeat` and an `at` that has no offset
- **THEN** the handoff is refused as a failure visible in the inbox, and nothing is proposed
