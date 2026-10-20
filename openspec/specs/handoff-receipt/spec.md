# handoff-receipt Specification

## Purpose
Gives an agent that writes into its outbox a way to learn what spekterm did with each file — accepted,
scheduled, a duplicate, refused and why, or not processed yet — so that "I handed it off" can be checked
instead of assumed.

## Requirements

### Requirement: Every file read from an outbox gets a receipt before it is removed

For every file the system reads from an agent session's outbox — a handoff, a completion report or a session
command — it SHALL write a receipt **before** it removes that file. So a file gone from the outbox means its
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

### Requirement: Receipts are readable whole, and bounded

A receipt SHALL be written so that a reader in another process never sees it half-written. A session's
receipts SHALL be removed when its outbox is removed, and a session SHALL keep at most the most recent hundred
receipts: an agent that writes many files cannot grow the directory without bound. Trimming SHALL remove only
regular files and SHALL NOT follow a symbolic link: the directory's location is told to the agent, which can
write there.

#### Scenario: A reader never sees a partial receipt

- **WHEN** a large receipt is written while another process reads that file name repeatedly
- **THEN** every read that finds the file finds a complete JSON object

#### Scenario: Receipts beyond the bound are removed oldest first

- **WHEN** a session's outbox has received one hundred and one files
- **THEN** its receipts directory holds one hundred receipts, and the oldest is the one removed

### Requirement: A receipt is the outcome of reading, not of the work

A receipt SHALL state only what the system did when it read the file. It SHALL NOT be presented as the target
session having received, started or finished the work: whether a handed-off session finished is its own
report (`handoff-completion`), visible in the relations file (`session-lineage`).

The system SHALL still NOT write anything into the source session's terminal about a delivery's outcome: that
would arrive as the agent's input and disturb what the user is looking at.

#### Scenario: A failed delivery writes nothing into the source terminal

- **WHEN** a handoff fails because its target matches no folder
- **THEN** nothing is sent to the source session's terminal, and the outcome is in the receipt

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
