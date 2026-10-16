## ADDED Requirements

### Requirement: The introduction states the session commands

The introduction every agent session receives (see "agent 於 session 啟動時被告知 spekterm 的存在、可交接的對象與投遞方式")
SHALL also state the session commands (see `agent-session-control`). This applies to **every agent session**, not
only one created by a handoff: every agent can act on its own session. It SHALL state:

- the shape of each of the three commands (close, hibernate, rename);
- that an omitted target means the agent's own session;
- that any other target is named by a fixed name from the agent's relations file, and only a session in its own
  tree of descendants may be targeted;
- that close and hibernate take effect when the target's current turn ends, and that anything typed into the
  target before then cancels the command;
- that a close of its own session is not carried out but offered to the user, who closes it or keeps it;
- that a rename takes effect at once and changes no fixed name;
- **every constraint that makes a command refused**: the rename name's length limit, and that close and hibernate
  of a running session need the agent's events to be on;
- that it is not told the outcome, and that a descendant's outcome shows in its relations file.

The part of the introduction that describes the relations file SHALL describe its shape as it is (see
`session-lineage`): children nest their own descendants at every depth, and a descendant whose direct parent no
longer exists is marked so. An agent that is not told where its grandchildren are listed cannot address them.

The limits SHALL be derived from the constants the judgement uses, as the handoff limits are. An unstated
constraint is a dead end for an agent that has no reply channel.

#### Scenario: A session not created by a handoff is told the commands

- **WHEN** the user opens a new agent session in a folder, with no handoff involved
- **THEN** the introduction it receives states the three session commands and that an omitted target means its own
  session

#### Scenario: The stated name limit is the one applied

- **WHEN** the introduction states the rename name's length limit as N
- **THEN** a rename command whose name has N characters is carried out, and one with N + 1 characters is refused

#### Scenario: The introduction describes the descendant tree

- **WHEN** an agent session receives its introduction
- **THEN** the introduction states that each child in the relations file lists the sessions it handed off, and what
  the mark for a direct parent that no longer exists means

#### Scenario: The introduction states that there is no reply

- **WHEN** an agent session receives its introduction
- **THEN** the introduction states that the agent is not told whether a command was carried out, and that its
  relations file shows a descendant's outcome
