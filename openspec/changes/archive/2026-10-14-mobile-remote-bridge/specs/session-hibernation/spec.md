## ADDED Requirements

### Requirement: A session a paired device is watching counts as displayed

For automatic hibernation, a session whose conversation or terminal a connected paired device is watching
(see `remote-protocol`) SHALL count as a displayed session. "Watching" here means a remote device's watch.
It is distinct from the desktop conversation view that other scenarios of this capability call "watched". It SHALL therefore not be hibernated
automatically while watched. A device starting or stopping to watch a session SHALL count as that session
becoming displayed or ceasing to be displayed, which is activity. Manual hibernation is unaffected.

Without this rule, a session the user is reading on their phone could be ended under them as soon as the
threshold passed, because the desktop is not displaying it.

#### Scenario: A watched session does not hibernate

- **WHEN** automatic hibernation has a threshold of a few seconds, a paired device watches the conversation of an idle agent session that the desktop does not display, and the threshold passes
- **THEN** the session is still running

#### Scenario: A session hibernates once the device stops watching

- **WHEN** the device stops watching that session, and the threshold passes again with no activity
- **THEN** the session is hibernated
