## RENAMED Requirements

- FROM: `### Requirement: A receipt states one of five outcomes`
- TO: `### Requirement: A receipt states one of six outcomes`

## MODIFIED Requirements

### Requirement: A receipt states one of six outcomes

A receipt SHALL be a JSON object naming the file it is for, the time it was written and one status:

- `accepted` — for a handoff, its session is being opened (or will be as soon as a window can receive it,
  `scheduled-handoff`). Opening is checked again when it happens, and a failure then (its target gone, agent
  event reporting off) reaches the user only, not the receipt; for a report, it was adopted; for a session command, it was accepted to be carried out
  (a command can still fail or be dropped later, as `agent-session-control` rules, and the receipt does not
  follow that);
- `scheduled` — a handoff that will open at the time the receipt states;
- `proposed` — a repeating handoff (`recurring-handoff`) that waits for the user's approval. Nothing opens
  until the user approves it, and the agent is not told later whether they did;
- `duplicate` — the same content was already received, a report included; nothing new happened;
- `rejected` — refused: the receipt carries the refusal's code, a reason in words, and **whether the refusal is
  permanent**, by the rule `agent-intake` uses for permanent and temporary failures. A permanent refusal will
  happen again for the same content; a temporary one (agent event reporting off, no window to carry a command
  out) may not once the user changes something, and its reason says so;
- `held` — not processed yet: the file stays in the outbox and will be read again (it could not be parsed as
  JSON, or the inbox is full, or reading it failed). The receipt carries the code and a reason that states when
  it will be read again: within a minute for an unparseable file, within a minute of the inbox having room for a
  full inbox, at the next start or when the file is rewritten for a failed read.

A `held` receipt SHALL be replaced when the file is read again with a different outcome, and by the final
outcome once there is one.

The words of a reason are for the agent: English, outside the dictionaries. The receipt SHALL NOT contain any
text from the delivery itself — its body or its target string — so that it carries nothing a third party
wrote.

#### Scenario: A file that is not JSON gets a held receipt and stays

- **WHEN** an agent writes `d.json` containing text that does not parse as JSON
- **THEN** the receipt `d.json` states `held` with a reason, and `d.json` is still in the outbox

#### Scenario: The same handoff written twice

- **WHEN** an agent writes a handoff as `e.json`, and after it is read writes the same content as `f.json`
- **THEN** the receipt `e.json` states `accepted` and the receipt `f.json` states `duplicate`, and only one session was created

#### Scenario: A refusal the user can lift is not stated as permanent

- **WHEN** agent event reporting is off and an agent writes a valid handoff as `g.json`
- **THEN** the receipt `g.json` states `rejected`, marked not permanent, with a reason saying it can succeed once agent event reporting is on

#### Scenario: A receipt carries no delivery text

- **WHEN** a handoff whose target matches no folder is refused
- **THEN** its receipt does not contain the target string or any part of the body

#### Scenario: A repeating handoff gets a proposed receipt

- **WHEN** an agent writes a valid handoff with `repeat` as `h.json`
- **THEN** the receipt `h.json` states `proposed`, and no session was created
