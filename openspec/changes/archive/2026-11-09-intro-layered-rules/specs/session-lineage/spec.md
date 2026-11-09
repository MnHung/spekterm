## ADDED Requirements

### Requirement: The relations file describes its own fields

Every relations file given to an agent SHALL carry, in the file itself, a description of what its fields mean:
that a session marked not running has no process and cannot receive messages until it runs again; the lifecycle
states and that a summary appears once a session has reported finishing; that children list the sessions they
handed off at every depth; and what the mark for a descendant whose direct parent no longer exists means. The
introduction (see `agent-handoff-source`) SHALL NOT repeat these meanings: the agent must read this file to use
any relation, so the description is where it is used, and it follows the file's shape when that shape changes.

The description SHALL be written by spekterm, in English, outside the dictionaries, and SHALL contain no path, no
session identifier and no text a third party wrote (the relations file's existing rule).

#### Scenario: A relations file explains the not-running mark and the tree

- **WHEN** an agent reads its relations file
- **THEN** the file states what a session marked not running means for messaging, what each lifecycle state means,
  that children nest their own descendants, and what the lost-parent mark means

#### Scenario: The description adds no path

- **WHEN** the relations file of a session whose relatives all have folders in the workspace is examined
- **THEN** the description contains no path and no spekterm session identifier
