## MODIFIED Requirements

### Requirement: The introduction states the session commands

The introduction every agent session receives (see "agent 於 session 啟動時被告知 spekterm 的存在、可交接的對象與投遞方式")
SHALL also state the session commands (see `agent-session-control`). This applies to **every agent session**, not
only one created by a handoff: every agent can act on its own session. It SHALL state:

- the shape of each of the four commands (close, hibernate, rename, wake);
- that an omitted target means the agent's own session;
- that any other target is named by a fixed name from the agent's relations file; that close, hibernate and rename
  may target only a session in its own tree of descendants; and that a wake may target any session the relations file
  lists — its parent, its siblings and its descendants;
- that a wake starts a dormant session at once, without asking the user; how to tell when the woken session can be
  messaged: its relations entry turns running, and its name then appears among the sessions Claude Code's messaging
  can reach; that a parent is not to be woken only to deliver a completion report, which needs no running parent;
  and that a target still not running a while after an accepted wake was put back to sleep, so the user is to be
  asked before it is woken again;
- that close and hibernate take effect when the target's current turn ends, and that anything typed into the
  target before then cancels the command;
- that a close of its own session is not carried out but offered to the user, who closes it or keeps it;
- that a rename takes effect at once and changes no fixed name;
- **every constraint that makes a command refused**: the rename name's length limit, and that close and hibernate
  of a running session need the agent's events to be on;
- that its receipt (`handoff-receipt`) states whether the command was accepted, not whether it was carried
  out, and that a descendant's outcome shows in its relations file.

The part of the introduction that describes the relations file SHALL describe its shape as it is (see
`session-lineage`): children nest their own descendants at every depth, and a descendant whose direct parent no
longer exists is marked so. An agent that is not told where its grandchildren are listed cannot address them.

The limits SHALL be derived from the constants the judgement uses, as the handoff limits are. A receipt tells
the agent of a refusal only after the fact, so an unstated constraint still costs a refused command.

#### Scenario: A session not created by a handoff is told the commands

- **WHEN** the user opens a new agent session in a folder, with no handoff involved
- **THEN** the introduction it receives states the four session commands and that an omitted target means its own
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
- **THEN** the introduction states that a command's receipt says whether it was accepted, not whether it was
  carried out, and that its relations file shows a descendant's outcome

#### Scenario: The introduction states how to reach a dormant relative

- **WHEN** an agent session receives its introduction
- **THEN** the introduction states the wake command, that it may target the parent, siblings and descendants, that
  it is carried out at once without asking the user, and that the woken session can be messaged once its relations
  entry is running and its name is reachable
- **AND** it states that a parent is not to be woken only to report, and that a wake that did not take is not to be
  repeated without asking the user
