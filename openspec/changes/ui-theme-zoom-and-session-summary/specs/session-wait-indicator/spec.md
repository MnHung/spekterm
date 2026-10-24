## ADDED Requirements

### Requirement: The main stage's header counts the workspace's sessions by state and leads to them

The main stage's header SHALL show the name of the selected rail item (a folder's name, or the global item's
name) and SHALL NOT show a folder's path. Next to it, the header SHALL show a summary of **every session that
has a rail entry** — the sessions of every folder in the workspace and of the global item, whichever item is
selected, and also when no item is selected. A session whose folder has left the workspace has no rail entry
and SHALL NOT be counted.

For each state that at least one such session is in, the summary SHALL show the number of sessions in it,
with the state's dot and its words from the dictionary. The states are those of the status dots, each session
counted once by the state its own dot shows: **needs you** (asks for a choice or waiting for you, counted
together, as they share a dot), **ended with an error**, **working**, **running** (a shell, or an unknown wait
state), **idle**, **hibernated**, **ended**. They SHALL be listed in that order, the order of urgency of the
rail item's dot. A state with no session SHALL NOT be listed. The total is not repeated here: the status bar
already shows it (`status-bar`).

The summary SHALL follow every change of a session's state, and the creation, closing, hibernation and
waking of sessions, without any action of the user.

Each listed state SHALL be a control that can be activated with the mouse and the keyboard. Activating it
SHALL do what activating that session's rail row does — select its rail item, make it the focused session,
give it keyboard focus as the rail row does, and bring the tab and the session's rail row into view (or, when
its rail item's session rows are collapsed, the item's row, which carries its dot; the item stays collapsed) —
for the **next** session in that state. "Next" is in rail order — item by item (the global item, then the folders as the rail
lists them), and within an item in the order of its session rows — starting after the focused session (from
the start when there is none) and wrapping around, so that activating the same state again with the mouse
goes on to the following one. Its tooltip and its accessible name SHALL name the state and its count; the
tooltip SHALL also list the sessions it counts, each with its rail item's name, and for "needs you" SHALL say
which ask for a choice and which wait after a finished turn.

The header SHALL stay on one line, and the summary SHALL NOT take room the header needs for the rest. When the
header is too narrow for everything, it SHALL give way in this order:

1. the states' words, which stay in the tooltip and the accessible name;
2. the least urgent states, folded into one marker whose tooltip lists what it holds;
3. the item's name, which is truncated but keeps at least its first few characters.

The side panel controls at the header's end SHALL stay inside the header whenever they did before the summary
existed. Where the words are hidden, states whose dots look alike (working and running; hibernated and ended)
are told apart by their tooltip and accessible name only — an accepted cost of a narrow header.

#### Scenario: Counts span every repo

- **WHEN** folder A has a session waiting for you after a finished turn, folder B has a working session and an idle one, and the global item, which has no session, is selected
- **THEN** the header lists 1 needing you, 1 working and 1 idle

#### Scenario: Only states with sessions are listed, the most urgent first

- **WHEN** the workspace has one working session and one hibernated session and nothing else
- **THEN** the header lists working, then hibernated, and nothing for needs you, idle or the other states

#### Scenario: A removed folder's sessions are not counted

- **WHEN** a folder with a running session is removed from the workspace while its session keeps running
- **THEN** the summary no longer counts that session, and no activation of the summary focuses it

#### Scenario: Activating "needs you" goes to that session

- **WHEN** folder A is selected, a session in folder B waits for you after a finished turn, and the user activates the summary's "needs you"
- **THEN** folder B is selected, that session is focused, and the rail shows its row

#### Scenario: Looking at the session lowers the count

- **WHEN** the user has gone to a session waiting for you through the summary and the window has focus
- **THEN** the count of sessions needing you goes down by one

#### Scenario: Activating a state again moves on

- **WHEN** two sessions in different folders are in the same state (say hibernated) and the user clicks that state twice
- **THEN** the first click focuses the one earlier in rail order and the second focuses the other

#### Scenario: The jump follows the rail's order

- **WHEN** the workspace has a pinned folder, an unpinned folder and a session handed off from another, all in the same state (say hibernated), and the user clicks that state once per session in it
- **THEN** the sessions are focused in the order their rows appear on the rail

#### Scenario: The rail scrolls to the target even after a click on the rail

- **WHEN** the user clicked a rail row, scrolled the rail so that a waiting session's row is out of view, and then clicks the summary's "needs you"
- **THEN** that session's rail row is scrolled into view

#### Scenario: A jump into a collapsed item shows the item's row

- **WHEN** a folder's session rows are collapsed, the rail is scrolled so that its row is out of view, and the user clicks the summary's state for one of its sessions
- **THEN** the session is focused, the folder's row is scrolled into view and its session rows stay collapsed

#### Scenario: Ended sessions are counted and reachable

- **WHEN** one session has ended normally and another has ended with an error
- **THEN** the summary lists "error" and "ended" with one each, and clicking either focuses that session

#### Scenario: The summary follows a state change

- **WHEN** a working agent session that is not displayed finishes a turn
- **THEN** without any action of the user the header's count of sessions needing you goes up by one and its working count goes down by one

#### Scenario: The header no longer shows the path

- **WHEN** a folder is selected
- **THEN** the header shows the folder's name and does not show its path

#### Scenario: The tooltip names the sessions

- **WHEN** the user points at the summary's "needs you" while one session asks for a choice and another waits after a finished turn
- **THEN** the tooltip lists both sessions with their rail items' names and says which one asks for a choice

#### Scenario: A narrow header keeps its name and its controls

- **WHEN** the main stage is narrowed until the summary's words no longer fit, with four states listed
- **THEN** the header is one line, the name is wider than zero, every side panel control lies inside the header, and the summary shows each state's dot and count or folds the least urgent into one marker
