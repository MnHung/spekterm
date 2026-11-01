## RENAMED Requirements

- FROM: `### Requirement: Restored sessions are dormant and start only on an explicit wake`
- TO: `### Requirement: Restored sessions that were running start again; the others are dormant and start only on an explicit wake`

## MODIFIED Requirements

### Requirement: Restored sessions that were running start again; the others are dormant and start only on an explicit wake

重建出來的 session SHALL 先處於**休眠**狀態 —— 具備完整身分（名字、順序）但**沒有 pty**。

**A restored session that had a running process when its ptys were last ended without the session ending
SHALL start again on its own**, right after it is restored. That covers closing and reopening the application,
the application ending abnormally, a renderer reload, and on macOS reopening the window (`workspace-app-shell`).
It starts exactly as an explicit wake would start it — a `claude` session resumes its conversation, a shell
session respawns in its last directory after its snapshot is replayed — with the same handling of a failure (the
reason is shown on the dormant screen, and the wake action is the retry). Starting it SHALL be **quiet**: it
SHALL NOT change the rail selection or the displayed session, and SHALL NOT take the keyboard focus from where
the user has put it. **When focus is nowhere at the moment the session starts** — typically because the user had
displayed it and its own wake action held the focus, and that action disappears as it starts — focus SHALL move
to its input, as after an explicit wake. A wake the user triggers while such a session is waiting for its turn
SHALL behave exactly as an explicit wake, focus included, and SHALL NOT start it a second time.

**A systemic failure SHALL NOT be repeated across every session.** The system SHALL NOT start any `claude` session
this way when it could not read the user's shell environment at launch (without it the agent may not be found);
those sessions SHALL stay dormant, still recorded as running, and say why. And when the first `claude` session
started this way ends on its own within moments of starting, the remaining `claude` sessions SHALL NOT be started,
SHALL stay dormant and still recorded as running, and SHALL say why. A first session that the user closes or
hibernates during those moments, or whose process cannot be created, does not count as such a failure; the next
`claude` session takes its place. A failure of an individual session after that does not stop the others.

A session that starts while it is not displayed has no terminal size to take (`terminal-sessions`: no size is
derived without a layout box): it starts at the default size, as a session a paired device starts, and takes the
terminal's size when it is first displayed. **Until it has been displayed, a shell started this way SHALL NOT
replace its saved screen**: its terminal still holds the replayed history at a size never measured, and saving it
would rewrap that history and add a replay separator at every restart.

Whether a session was running SHALL be recorded by the system, not by the interface: it is running from the
moment its process starts (created, woken, or restarted after a failed resume) until it is hibernated. Ending
the processes because the window closes, the renderer reloads or the application quits SHALL NOT change the
record; a session that ends on its own or is closed is not persisted at all. **A record written before this
rule existed has no such information, and its sessions SHALL be restored dormant** — the first launch after
upgrading starts nothing, as before.

**Every other restored session — one that was dormant when the processes were ended — SHALL start its pty only
when the user explicitly wakes it.** That is a session the user or the idle policy hibernated, and a restored
session that was never woken. Displaying a dormant session — selecting its rail item, switching to it with the
keyboard, clicking its tab — SHALL NOT start it. This holds for every dormant session, whether it was restored
or hibernated (see `session-hibernation`).

The dormant screen SHALL offer a wake action in both the terminal view and the conversation view. When a
dormant session becomes the displayed session and nothing covers it, the wake action SHALL receive focus —
where a running session's input would — so that pressing `Enter` wakes it, in either view. Once it is running,
focus SHALL move to its input, so that typing reaches it.

**Selecting a rail item therefore starts no session.**
**選中的 rail 項目不被持久化，且冷啟動時 SHALL NOT 有任何項目被預設選中**（含 `global-session` 的
全域項目）—— that rule predates explicit wake and still holds; it keeps "what is selected" from depending on
the previous run. Sessions that start again at launch do so without any item being selected.

**Why explicit wake rather than wake-on-display**: a session kept for occasional use would otherwise be started
by any keyboard pass over it (`Ctrl+Tab`, `Ctrl+↓`), defeating hibernation as a way to save resources.
**Why the running ones start again**: the user did not put them to sleep; a restart is not a decision about
which sessions to keep running, and hibernation already records the sessions that should stay asleep.

休眠狀態 SHALL 被明確地呈現，SHALL NOT 呈現為一個空白的畫面 —— **無論當下是哪一種 view**。
終端 view 之下是一個空白的終端，對話 view 之下是一份空白的對話，兩者是同一個錯誤的兩種長相：
**它與「這個 session 真的還沒講話」無法區分**，而兩者的正確處置不同。

未被喚醒的休眠 session SHALL 維持持久化 —— 使用者一路未喚醒它便再次關閉應用程式時，它 SHALL 於
下次開啟時仍然存在，且仍為休眠。

#### Scenario: Sessions that were running start again when the application opens

- **WHEN** the user closes the application while several sessions are running, and reopens it
- **THEN** each of those sessions has started a pty, without the user waking it
- **AND** a `claude` session among them has resumed its conversation and a shell session among them runs in its
  last directory

#### Scenario: Sessions that were dormant stay dormant when the application opens

- **WHEN** the user closes the application while one session is running and another has been hibernated, and
  reopens it
- **THEN** the session that was running has started a pty, and the hibernated one is dormant and has no pty

#### Scenario: Starting again at launch does not take the user's focus

- **WHEN** the application reopens, the user displays a session that was running before it has started again,
  moves the focus into the side panel, and then that session starts again
- **THEN** the session is still displayed and the focus is still in the side panel

#### Scenario: A displayed session whose wake action has focus gets its input focused

- **WHEN** the application reopens, the user displays by keyboard a session that was running, so that its wake
  action has the focus, and then that session starts again
- **THEN** the focus is on that session's input

#### Scenario: Waking a session that is waiting for its turn is an explicit wake

- **WHEN** the application reopens and the user triggers the wake action of a displayed session that was running
  before it has started again
- **THEN** that session has started exactly once and the focus is on its input

#### Scenario: Starting again does not take focus the user moved while it was starting

- **WHEN** the application reopens, a session that was running is being started, and before it has started the user
  displays it and then moves the focus into the side panel
- **THEN** once it has started, the focus is still in the side panel

#### Scenario: The first agent's failure keeps the others dormant and says why

- **WHEN** the application reopens with several `claude` sessions that were running, and the agent cannot be
  started at all
- **THEN** at most the first of them has been started, and the others are dormant, still present, and their dormant
  screen says why they were not started

#### Scenario: A first agent the user hibernates does not stop the others

- **WHEN** the application reopens with several `claude` sessions that were running, and the user hibernates the
  first of them right after it starts
- **THEN** the other `claude` sessions start

#### Scenario: Without the user's environment no agent is started

- **WHEN** the application reopens with `claude` sessions that were running, and the user's shell environment could
  not be read
- **THEN** no `claude` session has been started, and each says why on its dormant screen

#### Scenario: Sessions started at launch take the terminal's size when shown

- **WHEN** a session that started again at launch is displayed for the first time
- **THEN** its pty's columns and rows match the terminal's available size, not the size it was spawned with

#### Scenario: A shell started while hidden keeps its saved screen until displayed

- **WHEN** a shell session is running when the application closes, the application is reopened, the shell starts
  again without being displayed, and the application is closed and reopened again without displaying it
- **THEN** its replayed screen is the same as after the first reopen: no added replay separator, no lines rewrapped

#### Scenario: A session that ended abnormally comes back running

- **WHEN** the application is killed while a session is running, and is opened again
- **THEN** that session has started a pty

#### Scenario: Sessions that were running start again after a renderer reload

- **WHEN** the renderer reloads while one session is running and another is dormant
- **THEN** after the reload the session that was running has started a pty and the dormant one has none

#### Scenario: Opening the application starts no session

- **WHEN** the application opens with persisted sessions that were all dormant when it closed, and the user selects
  one of their rail items
- **THEN** no session has started a pty; every session is dormant

#### Scenario: The first launch after upgrading starts nothing

- **WHEN** the application opens with persisted sessions recorded before the system recorded whether they were
  running
- **THEN** no session has started a pty; every session is dormant

#### Scenario: A session that fails to start again stays dormant and says why

- **WHEN** a session that was running cannot be started again when the application opens, because its process
  cannot be created (for example its folder is still in the workspace but its directory no longer exists)
- **THEN** it is dormant, its dormant screen shows the reason, and its wake action is available as the retry

#### Scenario: 冷啟動不因全域項目恆存而喚醒 session

- **WHEN** 使用者關閉應用程式時全域項目有數個休眠的 session，重新開啟應用程式但尚未選中任何 rail 項目
- **THEN** 沒有任何 session 啟動 pty，全域項目的 session 皆為休眠

#### Scenario: Displaying a dormant session does not start it

- **WHEN** the user switches to a dormant session, by selecting its rail item or by keyboard
- **THEN** it is displayed as dormant and has no pty

#### Scenario: The wake action starts a dormant session

- **WHEN** the user triggers the wake action of a displayed dormant session
- **THEN** that session starts its pty

#### Scenario: Enter wakes the displayed dormant session

- **WHEN** a dormant session becomes displayed by keyboard and the user presses `Enter`
- **THEN** that session starts its pty

#### Scenario: Typing after a keyboard wake reaches the session

- **WHEN** a dormant session becomes displayed by keyboard, the user presses `Enter`, and then types a command
  and presses `Enter` again
- **THEN** the command runs in that session

#### Scenario: 休眠的 session 不呈現為空白終端

- **WHEN** 使用者檢視一個尚未被喚醒的休眠 session
- **THEN** 該 session 明確地呈現其休眠狀態，而非一個沒有內容的終端

#### Scenario: 休眠的 session 於對話 view 不呈現為空白對話

- **WHEN** 使用者檢視一個尚未被喚醒的休眠 session，且其當前 view 為對話
- **THEN** 該 session 明確地呈現其休眠狀態，而非一份沒有內容的對話
- **AND** the wake action is offered there as well

#### Scenario: 未喚醒的休眠 session 於再次重啟後仍存在

- **WHEN** 使用者重新開啟應用程式、未喚醒某個休眠 session、再次關閉並重新開啟應用程式
- **THEN** 該 session 仍然存在且仍為休眠
