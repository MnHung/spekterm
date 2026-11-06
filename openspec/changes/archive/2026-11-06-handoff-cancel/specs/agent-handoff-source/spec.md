## ADDED Requirements

### Requirement: The introduction points to the schedules file for cancelling and changing

The introduction every agent session receives (see "agent 於 session 啟動時被告知 spekterm 的存在、可交接的對象與投遞方式")
SHALL state, in one sentence, that a scheduled or repeating handoff — any session's — can be cancelled or changed,
and the location of the schedules file (see `handoff-cancel`) that lists them with their ids and states how. This
applies to **every agent session**, whether or not it was created by a handoff and whether or not anything is
scheduled: the plan can change in any conversation.

The cancel's shape and rules SHALL NOT be repeated in the introduction. The schedules file states every rule that
refuses a cancel, and **those rules count as stated** for the rule that every constraint that refuses a delivery is
stated, because the introduction directs the agent to that file before the only action they constrain — as the
teammates file's rules do.

The introduction SHALL stay within its size budget with the sentence included (the 30-folder variant, measured by
the existing test).

#### Scenario: Every agent session is told where to cancel

- **WHEN** the user opens a new agent session in a folder, with no handoff involved and nothing scheduled
- **THEN** the introduction it receives names the schedules file's location and says it is how a scheduled or repeating handoff is cancelled or changed
