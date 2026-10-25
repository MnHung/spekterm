# agent-model-switch Specification

## Purpose
Defines how a paired device's model switch gets past the agent's cache-miss confirmation: an armed, short-lived
mark that an injected `PreModelSwitch` hook honours for exactly that switch, and nothing else.

## Requirements

### Requirement: A device's model switch skips the cache-miss confirmation, and only that switch

For each agent session that takes part in agent events, the desktop SHALL inject a command for the agent's
pre-model-switch hook and a per-session mark file named by an environment variable of the session. The desktop
SHALL arm the mark immediately before a device's submit key for a one-name model command, holding the name and a
deadline 15 seconds ahead. The hook command SHALL take the mark atomically and SHALL answer "allow" — which makes
the agent skip the confirmation it would otherwise ask when the conversation is cached — only when the deadline
has not passed, the switch's source is a command, and the requested name equals the armed one. In every other
case it SHALL print nothing, so the agent behaves as without the injection. It SHALL always exit successfully
and SHALL leave the mark in place for a switch it did not allow. After an allow it SHALL shorten the mark's deadline to
5 seconds ahead instead of removing it, because one switch can ask the hook more than once; a mark SHALL permit
only the one armed name and only until that shortened deadline.

#### Scenario: One switch asking twice is allowed both times

- **WHEN** the mark is armed for `sonnet` and the hook runs twice within a second for a command switch requesting `sonnet`
- **THEN** both runs print the allow decision

#### Scenario: The allow lapses shortly after

- **WHEN** the hook allowed a switch and runs again for `sonnet` more than 5 seconds later
- **THEN** it prints nothing

#### Scenario: A switch the user makes at the desktop still asks

- **WHEN** no mark is armed and the hook runs for a switch from the model picker, or for a command switch
- **THEN** the hook prints nothing

#### Scenario: A different name is not allowed and keeps the mark

- **WHEN** the mark is armed for `sonnet` and the hook runs for a command switch requesting `opus`, then for `sonnet`
- **THEN** the first run prints nothing and the second prints the allow decision

#### Scenario: A lapsed mark allows nothing

- **WHEN** the mark's deadline passed before the hook ran
- **THEN** the hook prints nothing

#### Scenario: A hook failure never blocks the agent

- **WHEN** the mark file is unreadable or the session has no mark variable
- **THEN** the hook prints nothing and exits successfully

### Requirement: The mark follows the session's life

Starting an agent session SHALL clear any mark an earlier process of that session left. Ending a session SHALL
clear its mark. A session that does not take part in agent events SHALL receive neither the hook nor the variable.

#### Scenario: An old mark does not permit the new process

- **WHEN** a session's earlier process left an armed mark and the session starts again
- **THEN** the new process's first model switch is not allowed by it
