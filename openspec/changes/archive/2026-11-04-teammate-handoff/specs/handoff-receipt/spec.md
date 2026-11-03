## RENAMED Requirements

- FROM: `### Requirement: A receipt states one of six outcomes`
- TO: `### Requirement: A receipt states one outcome from a fixed set`

## MODIFIED Requirements

### Requirement: A receipt is the outcome of reading, not of the work

A receipt SHALL state only what the system did with the file. It SHALL NOT be presented as the target
session having received, started or finished the work: whether a handed-off session finished is its own
report (`handoff-completion`), visible in the relations file (`session-lineage`).

**A teammate handoff's receipt is rewritten as its sending proceeds** (`teammate-handoff`): first
`awaiting-confirmation` when it is read, then the user's decision and the server's answer. Its last state SHALL be
`sent`, `discarded` or `rejected`. `sent` SHALL mean only that the team server stored the handoff for the recipient:
it SHALL NOT be presented as the recipient having seen, accepted or done it (that is the server's milestone M2).
A later rewrite SHALL replace only the receipt it wrote: a teammate handoff's receipt carries the handoff's own
reference, and a receipt file now holding another delivery's outcome (the agent reused the file name) SHALL be left
alone. When the source session has ended before the sending finished, its receipts directory is gone and SHALL NOT be
created again; the user still sees the outcome in the Outgoing tab. A session that is only dormant keeps its
receipts directory, and its receipts SHALL be rewritten.

The system SHALL still NOT write anything into the source session's terminal about a delivery's outcome: that
would arrive as the agent's input and disturb what the user is looking at.

#### Scenario: A failed delivery writes nothing into the source terminal

- **WHEN** a handoff fails because its target matches no folder
- **THEN** nothing is sent to the source session's terminal, and the outcome is in the receipt

### Requirement: A receipt states one outcome from a fixed set

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
- `rejected` — refused, by spekterm or, for a teammate handoff the user confirmed, by the team server (its error
  code, such as `RECIPIENT_UNKNOWN`): the receipt carries the refusal's code, a reason in words, and **whether the refusal is
  permanent**, by the rule `agent-intake` uses for permanent and temporary failures. A permanent refusal will
  happen again for the same content; a temporary one (agent event reporting off, no window to carry a command
  out) may not once the user changes something, and its reason says so;
- `awaiting-confirmation` — a teammate handoff (`teammate-handoff`) that waits for the user to send or discard it
  on the desktop. Nothing has left the computer;
- `sent` — a teammate handoff the team server stored for the recipient, with the recipient's handle and, when the
  recipient has no device yet, a reason saying it waits until they add one;
- `discarded` — a teammate handoff the user discarded; nothing was sent;
- `held` — not finished yet, in one of two ways. **The file stays in the outbox** and will be read again (it could
  not be parsed as JSON, or the inbox is full, or reading it failed, or too many teammate handoffs wait for
  confirmation — `OUTGOING_FULL`); or **the file was taken** and a teammate handoff the user confirmed waits to be sent
  (`NOT_CONNECTED`; `RATE_LIMITED` with the time it is tried again; `RETRYING` after a server error or no answer). The receipt carries the code and a reason that says
  which, and when it will be read or sent again: within a minute for an unparseable file, within a minute of the inbox
  having room for a full inbox, within a minute of one waiting teammate handoff being sent or discarded, at the
  next start or when the file is rewritten for a failed read, when the connection is up, or at the stated time.

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

#### Scenario: Sent means stored by the server

- **WHEN** the user sends a teammate handoff and the server answers `ok`
- **THEN** its receipt states `sent`, and its reason does not say the teammate received or accepted it

#### Scenario: A teammate handoff's receipt follows the user's decision

- **WHEN** an agent writes a valid teammate handoff as `t.json`, and the user then discards it
- **THEN** the receipt `t.json` first states `awaiting-confirmation` and then `discarded`

#### Scenario: A server refusal reaches the receipt

- **WHEN** the user sends a teammate handoff written as `u.json` and the server answers `RECIPIENT_UNKNOWN`
- **THEN** the receipt `u.json` states `rejected` with the code `RECIPIENT_UNKNOWN`
