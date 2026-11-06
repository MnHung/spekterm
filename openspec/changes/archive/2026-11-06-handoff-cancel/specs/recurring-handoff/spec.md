## MODIFIED Requirements

### Requirement: The user runs, skips and stops a recurrence in the inbox

An upcoming occurrence SHALL offer the scheduled handoff's two actions (`scheduled-handoff`), with these effects:

- **Run now** — opens this occurrence at once; the next occurrence is the first matching time after this
  occurrence's own time, so the time that was run early is not run again;
- **Skip** — the occurrence's Cancel, labelled for what it does: this time never opens; the recurrence continues
  with its next time.

Each recurrence in the recurrences section SHALL offer **Stop repeating**, which SHALL ask for confirmation
before it acts: the recurrence ends, its upcoming occurrence is removed, and no further occurrence is created.
A waiting occurrence stays for the user, and sessions already opened are not affected. A stopped recurrence
cannot be proposed again with the same content from the same session — that is a duplicate — so stopping on the
desktop is not one click.

An agent session SHALL also be able to skip an occurrence and stop a recurrence, through a cancel (`handoff-cancel`),
with the same effects. **An agent's stop asks for no confirmation** (the user's ruling): the agent is told to confirm
with the user in the conversation instead. The desktop's confirmation applies to its own button only.

Stopping SHALL be possible on the desktop, and by an agent's cancel, only in this version (`remote-protocol`: a paired
device has no Stop). A user on a paired phone can still ask an agent to stop one, through a prompt: that is the
agent's capability, not the device's.

#### Scenario: Run now does not run the same time again

- **GIVEN** a weekly recurrence whose occurrence is on Wednesday at 21:00, and it is Tuesday
- **WHEN** the user chooses Run now
- **THEN** a session is created at once, and the scheduled section lists the occurrence for the Wednesday after next

#### Scenario: Skip moves to the next time

- **GIVEN** a weekly recurrence whose occurrence is this Wednesday at 21:00
- **WHEN** the user skips it and Wednesday 21:00 passes
- **THEN** no session is created for it, and the scheduled section lists next Wednesday's occurrence

#### Scenario: Stop repeating asks first

- **WHEN** the user chooses Stop repeating and then declines the confirmation
- **THEN** the recurrence and its upcoming occurrence are unchanged

#### Scenario: Stop repeating ends the recurrence

- **WHEN** the user stops a recurrence and confirms, its next time passes, and then the application restarts
- **THEN** no session is created for it, and the inbox lists neither the recurrence nor an occurrence of it

#### Scenario: An agent's stop ends the recurrence without a confirmation on the desktop

- **GIVEN** an approved recurrence, and the desktop showing the inbox
- **WHEN** an agent cancels the recurrence by its id
- **THEN** no confirmation appears on the desktop, and the inbox lists neither the recurrence nor an occurrence of it
