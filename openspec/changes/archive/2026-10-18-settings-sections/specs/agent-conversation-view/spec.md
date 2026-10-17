## ADDED Requirements

### Requirement: Settings also offers the view choice

The Agents & sessions section of Settings (see `terminal-preferences`) SHALL offer the agent session view as a
choice between the terminal view and the conversation view. It SHALL show the same global preference that the
switch on each agent session changes, and a change made in either place SHALL show in the other. The switch on
each agent session SHALL stay (see "view 的選擇為全域，且跨重啟保留").

**Why**: the preference is global, but its only control sat beside one session's tabs, where it reads as
belonging to that session. Settings is where a user looks for something that applies everywhere.

#### Scenario: Settings shows the current view

- **WHEN** the user has switched an agent session to the conversation view and opens Settings' Agents & sessions section
- **THEN** the view choice shows the conversation view

#### Scenario: A choice in Settings changes every agent session

- **WHEN** the user chooses the terminal view in Settings while agent sessions show the conversation view
- **THEN** every agent session shows the terminal view
