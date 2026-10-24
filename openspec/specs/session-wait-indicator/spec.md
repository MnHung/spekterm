# session-wait-indicator Specification

## Purpose
What an agent session's status dot shows (asks for a choice, waiting for you, working, idle), how each state is derived from the agent's reported events, the seen mark the main process owns and shares with paired devices and the handoff lifecycle, and the rail item's most-urgent dot.

## Requirements

### Requirement: An agent session's status dot shows whether it needs the user

The status dot of a running agent session — on its rail row and on its tab — SHALL show the session's attention
state, derived by the main process from the agent's wait state (`agent-event-bridge`), whether a turn is in progress,
and the seen mark:

| Attention state | When |
|---|---|
| **asks for a choice** | the agent waits on a choice, and the session has not been typed into since the agent began the tool call the choice is about |
| **waiting for you** | the agent is not in a turn, its last turn ended while no one was looking at it, and no one has looked at it since |
| **working** | the agent reports work, within a turn that is in progress (it was given a prompt and has not finished) |
| **idle** | the agent is not in a turn, and the seen mark says its last turn end has been looked at — or no turn has ended since the agent started |
| **running** | the wait state is unknown |

"Not in a turn" includes an agent whose wait state reports work after its turn ended — a background subagent's tool
start can arrive after the turn's end, and it does not start a new turn. A choice the session was typed into after the agent
began that tool call is one the user answered at the desktop; the agent reports no event for a denial, so the state is taken from
the keystroke, and the choice no longer shows.

These states apply only while the session's process runs. A hibernated session and an ended session SHALL keep the
dots they have today, and a shell session SHALL keep today's running dot: it has no wait state.

"Asks for a choice" and "waiting for you" SHALL share one dot, visibly distinct from every other dot at a glance,
without hovering — it is the state the user scans for. "Idle" and "working" SHALL be distinct from each other and from
the hibernated dot. "Running" (unknown) MAY look like "working", since an unknown state cannot claim to be anything
else.

The dot's tooltip SHALL state the attention state in words, distinguishing a choice from a finished turn. The words
SHALL come from the dictionary, in every supported language.

#### Scenario: A turn that ends unseen shows as waiting

- **WHEN** an agent session that is not the displayed session finishes a turn
- **THEN** its rail row's tooltip and its tab's tooltip state "waiting for you"

#### Scenario: A turn in progress shows as working

- **WHEN** an agent session is given a prompt and its agent is working
- **THEN** that session's tooltips state "working"

#### Scenario: A permission prompt shows as a choice even when displayed

- **WHEN** the agent in the displayed session, in the focused window, asks for permission to run a tool
- **THEN** that session's tooltips state that it asks for a choice

#### Scenario: A choice answered at the desktop stops showing

- **WHEN** a session asks for a choice and the user types into that session
- **THEN** its tooltips no longer state that it asks for a choice

#### Scenario: A subagent's late tool start does not make a session working

- **WHEN** an agent session's turn ends unseen, and afterwards its agent reports a background subagent's tool start
  with no new prompt
- **THEN** its tooltips still state "waiting for you"

#### Scenario: A shell session keeps the running dot

- **WHEN** a shell session runs
- **THEN** its tooltip states running and no attention state

#### Scenario: A session with event reporting off keeps the running dot

- **WHEN** an agent session runs and its wait state is unknown
- **THEN** its tooltip states running and no attention state

### Requirement: Looking at a session clears its waiting state, and the main process owns that mark

The main process SHALL hold, per agent session, a seen mark for the agent's last turn end. A turn end is the moment
the agent stops being in a turn — it reports the turn's completion, or a turn that was in progress is no longer, and
the agent waits for input. A turn end that no one is looking at SHALL make the mark **not seen**; a turn end while
someone is looking at the session SHALL be seen at once; looking at the session SHALL make it **seen**; and a new
turn in progress SHALL clear it. Work reported in the middle of a turn that leaves the turn in progress (an automatic
compaction) is not a turn end.

Someone is looking at a session when:

- it is the session a window displays, and that window has focus; or
- a paired device watches its conversation. A device holds that watch only while the conversation is on its screen.
  Watching a session's terminal output does not count.

An agent that starts, resumes (including a wake from hibernation) or clears its conversation, and reports only its
start, has had no turn end, so it SHALL be seen: there is nothing new to see.

The mark SHALL NOT be persisted. After a restart every session's wait state starts unknown (`agent-event-bridge`), and
a session whose agent reports nothing new is not shown as waiting.

The renderer SHALL NOT decide the mark. It reports which session it displays (as it does today), and receives the
attention state of every running agent session from the main process — whether or not its conversation view is open —
as a complete projection whenever any of them changes.

#### Scenario: Turning to a session clears it

- **WHEN** an agent session states "waiting for you" after an unseen turn end, and the user makes it the displayed
  session in the focused window
- **THEN** its tooltips state "idle"

#### Scenario: Focusing the window clears the displayed session

- **WHEN** an agent session finishes a turn while it is the displayed session but the window does not have focus,
  and the window then gains focus
- **THEN** it states "waiting for you" until the window gains focus, and "idle" from then on

#### Scenario: A turn that ends while the user watches is seen

- **WHEN** an agent session is the displayed session in the focused window and its agent finishes a turn
- **THEN** it goes from "working" to "idle", never stating "waiting for you"

#### Scenario: A device watch clears it on the desktop

- **WHEN** an agent session states "waiting for you" on the desktop and a paired device starts watching its
  conversation
- **THEN** the desktop's tooltips for that session state "idle"

#### Scenario: A terminal watch does not clear it

- **WHEN** an agent session states "waiting for you" and a paired device watches its terminal output
- **THEN** it still states "waiting for you"

#### Scenario: A started session is not waiting

- **WHEN** an agent session starts, is resumed after a restart, or is woken from hibernation while not displayed, and
  its agent reports its start and nothing more
- **THEN** it states "idle", not "waiting for you"

#### Scenario: A new turn end is unseen again

- **WHEN** a session was seen after one turn end, then is given a new prompt that finishes while the session is not
  displayed
- **THEN** it states "waiting for you" again

### Requirement: A rail item's row carries the most urgent state of its sessions

Each folder row on the rail, and the global item's row, SHALL carry one dot for the most urgent state among its
sessions, in this order: asks for a choice or waiting for you, ended with an error, working, running, idle,
hibernated or ended. A rail item with no session SHALL show no dot. The dot SHALL show whether or not the item's
session rows are expanded, so a collapsed item still says that something inside it needs the user. The row's tooltip
SHALL name the state.

#### Scenario: A collapsed folder says a session waits

- **WHEN** a folder's session rows are collapsed and one of its agent sessions finishes a turn unseen
- **THEN** the folder row's tooltip states "waiting for you"

#### Scenario: Waiting outranks working

- **WHEN** one session of a folder is working and another states "waiting for you"
- **THEN** the folder row's tooltip states "waiting for you"

#### Scenario: A folder with no session shows no dot

- **WHEN** a folder has no session
- **THEN** its row shows no state dot and its tooltip names no state

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
