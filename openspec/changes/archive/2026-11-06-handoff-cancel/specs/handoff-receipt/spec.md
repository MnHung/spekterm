## MODIFIED Requirements

### Requirement: Every file read from an outbox gets a receipt before it is removed

For every file the system reads from an agent session's outbox — a handoff, a completion report, a session
command or a cancel (`handoff-cancel`) — it SHALL write a receipt **before** it removes that file. So a file gone from the outbox means its
receipt exists, with one exception: a receipt that cannot be written (a full disk, a directory that cannot be
created) SHALL be logged, and the file SHALL still be processed and removed as before. Holding a delivery back
because its receipt failed would turn a bookkeeping failure into a lost handoff.

The receipt SHALL be at the same file name in that session's receipts directory. The receipts directory SHALL
NOT be the outbox itself: a receipt is a `.json` file and would be read as a delivery there.

A file whose name begins with a dot is not read (it is how a producer marks a file it is still writing), and
SHALL get no receipt.

#### Scenario: An accepted handoff has a receipt

- **WHEN** an agent writes a valid handoff named `a.json` into its outbox, and it is read
- **THEN** the session's receipts directory has `a.json` stating that the handoff was accepted, and `a.json` is no longer in the outbox

#### Scenario: A refused handoff has a receipt with the reason

- **WHEN** an agent writes a handoff named `b.json` whose target matches no folder
- **THEN** the receipt `b.json` states that the handoff was refused for good, with the code for an unknown target and a reason in words

#### Scenario: A scheduled handoff's receipt states the time

- **WHEN** an agent writes a handoff named `c.json` scheduled for tomorrow
- **THEN** the receipt `c.json` states that it was scheduled, and the time it will open

#### Scenario: A dot-prefixed file gets no receipt and stays

- **WHEN** a file whose name begins with a dot and ends in `.json` appears in an outbox
- **THEN** no receipt is written for it, it does not appear in the inbox, and it stays in the outbox

#### Scenario: A delivery is processed when its receipt cannot be written

- **WHEN** the receipts directory cannot be written, and an agent writes a valid handoff
- **THEN** a session is created for the handoff, and the delivery file is removed

### Requirement: A receipt states one outcome from a fixed set

A receipt SHALL be a JSON object naming the file it is for, the time it was written and one status:

- `accepted` — for a handoff, its session is being opened (or will be as soon as a window can receive it,
  `scheduled-handoff`). Opening is checked again when it happens, and a failure then (its target gone, agent
  event reporting off) reaches the user only, not the receipt; for a report, it was adopted; for a session command, it was accepted to be carried out
  (a command can still fail or be dropped later, as `agent-session-control` rules, and the receipt does not
  follow that); **for a cancel (`handoff-cancel`), it was carried out**;
- `scheduled` — a handoff that will open at the time the receipt states, **with the handoff's id**;
- `proposed` — a repeating handoff (`recurring-handoff`) that waits for the user's approval, **with its id**, which
  stays the recurrence's id once the user approves it. Nothing opens until the user approves it, and the agent is
  not told later whether they did;
- `duplicate` — the same content was already received, a report included; nothing new happened. For a handoff
  that is still known, the receipt carries its id. For a cancel, the item was already cancelled (a dismissed
  handoff, a stopped recurrence): nothing new happened, and no trace or notification is raised;
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

The id a receipt carries is the one a cancel (`handoff-cancel`) names, so the session that wrote a handoff can
cancel it without reading anything else. A handoff's receipt SHALL NOT be rewritten when the handoff is later
cancelled, opened or approved: it states the outcome of reading. (A teammate handoff's receipt is rewritten as its
sending proceeds, as stated above; that is unchanged.)

The words of a reason are for the agent: English, outside the dictionaries. The receipt SHALL NOT contain any
text from the delivery itself — its body or its target string — so that it carries nothing a third party
wrote. An id is system-written and carries neither.

#### Scenario: A file that is not JSON gets a held receipt and stays

- **WHEN** an agent writes `d.json` containing text that does not parse as JSON
- **THEN** the receipt `d.json` states `held` with a reason, and `d.json` is still in the outbox

#### Scenario: A scheduled handoff's receipt gives the id a cancel uses

- **WHEN** an agent writes a handoff scheduled for tomorrow as `s.json`, and then writes a cancel with the id the receipt `s.json` states
- **THEN** the cancel's receipt states `accepted`, and the receipt `s.json` still states `scheduled`

#### Scenario: A cancel that cannot be carried out is rejected

- **WHEN** an agent writes a cancel whose id names nothing that can be cancelled
- **THEN** its receipt states `rejected`, permanent, with the code and a reason saying which case

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
- **THEN** the receipt `h.json` states `proposed` with an id, and no session was created

#### Scenario: Sent means stored by the server

- **WHEN** the user sends a teammate handoff and the server answers `ok`
- **THEN** its receipt states `sent`, and its reason does not say the teammate received or accepted it

#### Scenario: A teammate handoff's receipt follows the user's decision

- **WHEN** an agent writes a valid teammate handoff as `t.json`, and the user then discards it
- **THEN** the receipt `t.json` first states `awaiting-confirmation` and then `discarded`

#### Scenario: A server refusal reaches the receipt

- **WHEN** the user sends a teammate handoff written as `u.json` and the server answers `RECIPIENT_UNKNOWN`
- **THEN** the receipt `u.json` states `rejected` with the code `RECIPIENT_UNKNOWN`
