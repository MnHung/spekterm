## ADDED Requirements

### Requirement: An agent session's background tasks in flight are kept from the agent's own reports

For each agent session the system SHALL keep the background tasks its agent reports as in flight (background
subagents, background shells — the agent's Monitor tool included —, monitors, and any other kind), taken only from the
list the agent itself reports with its turn completion and with a subagent's completion. A task is in flight unless the
report gives it a finished status (completed, failed or killed). Each report's list SHALL **replace** the one kept,
never be merged with it:

- the agent's own turn completion replaces it with that report's tasks in flight, and a turn completion that carries
  no list clears it; a failed turn leaves it unchanged;
- a subagent's completion replaces it with that report's tasks in flight **except the subagent that completed**; one
  that carries no list leaves it unchanged;
- no other event changes it — starting, resuming, clearing or compacting the conversation included.

The kept tasks SHALL be cleared when the session's process ends, whatever ended it.

Each task SHALL be read by white-list: an identifier (tasks without one are left out, and of two with the same
identifier the first is kept), a kind (agent, shell, monitor, or other for a kind the system does not know), and a
label. The label SHALL be the task's description, or else a shell's command, or else none; control characters and
runs of whitespace SHALL become a single space, and the label SHALL be trimmed and clipped to 200 characters. The label
is text written by the agent or by its CLI, and is delivered as written, as plain, non-navigable text (the path
rule's scope). No other field of a task SHALL be kept.

#### Scenario: A turn completion's list replaces the kept tasks

- **WHEN** the kept tasks are a shell A and a monitor B, and the agent's turn completion lists only a running subagent C
- **THEN** the kept tasks are C alone

#### Scenario: A subagent's completion leaves the subagent out

- **WHEN** a subagent C completes, and its completion lists C and a shell D as running
- **THEN** the kept tasks are D alone

#### Scenario: Finished tasks are not kept, pending ones are

- **WHEN** the agent's turn completion lists a running shell A, a pending shell B and a completed shell C
- **THEN** the kept tasks are A and B

#### Scenario: An unknown kind is kept as other

- **WHEN** the agent's turn completion lists a running task of a kind the system does not know
- **THEN** that task is kept with the kind other

#### Scenario: The label prefers the description

- **WHEN** a running shell carries a description and a command
- **THEN** its label is the description; and a running shell with only a command, spread over two lines, has that command on one line as its label

#### Scenario: A failed turn and a conversation event leave the kept tasks alone

- **WHEN** the kept tasks are not empty, and the agent then reports a failed turn, a compaction and a cleared conversation
- **THEN** the kept tasks are unchanged

#### Scenario: A process end clears the kept tasks

- **WHEN** the kept tasks are not empty and the session's process ends (it exits, or the session is hibernated)
- **THEN** the kept tasks are empty, and they stay empty after the session is woken until the agent reports again

## MODIFIED Requirements

### Requirement: 事件所帶的內容送往呈現層之前必須剝除檔案系統位置

agent 回報的事件**本身即帶有絕對路徑，且不只一個欄位** —— 實測其基底內容即含紀錄位置、
工作目錄與暫存目錄，工具類事件另含參數之中的檔案路徑。

**因此剝除 SHALL 以白名單（只送出明確需要的欄位）實作，SHALL NOT 以黑名單（列舉要移除的欄位）
實作** —— 黑名單會在 agent 新增一個帶路徑的欄位時靜默失效。
凡送往呈現層的事件內容，SHALL 剝除或轉譯為 workspace 既有的位置詞彙，SHALL NOT 含有任何絕對路徑。

**這與內容路徑的同名條款是兩條獨立的義務，不是同一條。** 兩條路徑各自把資料送進呈現層，
只在其中一條做剝除，另一條照樣把路徑送出去 —— 而選擇類請求的選項正是取自事件內容。

紀錄位置本身 SHALL 只在系統內部使用（見 `agent-transcript-stream` 的定位），SHALL NOT 送往呈現層。

**Scope.** This obligation applies to the fields the system selects from an event: no selected field
SHALL be a location that the system added or that the presentation layer could navigate to. A field's value
that is text written by the agent SHALL be presented as plain, non-navigable text, even when it contains a
path. That covers a tool's identifying argument, a question's text, an option's label and description, and a
background task's label (its description or a shell's command, written by the agent or by its CLI).
The obligation SHALL NOT be read as requiring that text to be rewritten.

#### Scenario: 事件內容不含絕對路徑

- **WHEN** the presentation layer receives content from any agent event
- **THEN** it contains no working directory, scratch directory or transcript location, and no tool parameter other than the identifying argument, and of a background task nothing but its identifier, kind and label

#### Scenario: 選擇類請求的選項不含絕對路徑

- **WHEN** the agent makes a choice request whose tool parameters contain file paths
- **THEN** the presentation layer receives the identifying argument and, for a question, the question fields, and no other parameter

#### Scenario: An agent-written option is shown as plain text

- **WHEN** the agent asks a question whose option label contains a file path
- **THEN** the option is delivered with its label as written

#### Scenario: A background task's label is delivered as written

- **WHEN** the agent reports a running background shell whose command contains an absolute path, and no description
- **THEN** its label is that command as written, except that its whitespace is collapsed, and no other field of the task is delivered
