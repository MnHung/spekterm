# agent-event-bridge Specification

## Purpose

讓 agent 自己回報它當下正在等待什麼，使「現在能不能送輸入」有一個來自 agent 的判準，
而不必從終端畫面推測。

## Requirements

### Requirement: 以 agent 公開的 CLI 旗標注入事件回報

事件橋接啟用時，系統 SHALL 在 spawn agent session 時，以該 agent **公開的 CLI 旗標**注入事件
回報設定，使 agent 於下列時機把結構化事件寫到系統指定的位置：

- agent 進入閒置或開始等待使用者輸入
- agent 提出需要使用者選擇的請求
- agent session 結束

落點 SHALL 以**環境變數**傳給注入的命令，per session 各自一個位置。

系統 SHALL NOT 為了取得這些事件而解析 agent 的終端畫面。

#### Scenario: 啟用後 agent 的事件落盤

- **WHEN** 事件橋接已啟用，使用者建立一個 agent session 並與之互動至其閒置
- **THEN** 該 session 的事件出現在系統指定的位置

#### Scenario: 未啟用時完全不注入

- **WHEN** 事件橋接未啟用，且使用者建立一個 agent session
- **THEN** spawn 該 session 時不注入任何事件回報設定
- **AND** 不產生任何事件檔案

### Requirement: 注入不得使使用者原有的設定失效，無法確保時不注入

使用者已自行設定同類事件回報時，系統的注入 SHALL 與之**並存** —— SHALL NOT 使其失效。

**無法確保並存時（注入機制對該設定為取代語意、或注入本身失敗）SHALL NOT 注入。**

> **本條的第一種觸發條件在實測的 agent 版本下不存在**（2026-09-06、CLI 2.1.261：注入的 hooks
> 與使用者的 hooks 為合併）。保留本條是為了防範版本改變，因此**其驗收只能以人造的分支進行** ——
> 這一點寫在這裡，是為了讓下一個人不會誤以為它有真實情境的覆蓋。

#### Scenario: 使用者已有同類設定且可並存

- **WHEN** 使用者已自行設定同類事件回報，且系統可確保並存
- **THEN** 使用者原有的設定照常運作
- **AND** 系統的事件同時被寫出

#### Scenario: 無法確保並存時不注入

- **WHEN** 使用者已自行設定同類事件回報，而系統無法確保並存
- **THEN** 系統不注入任何事件回報設定
- **AND** 使用者原有的設定照常運作
- **AND** 依賴事件的功能呈現為不可用並說明原因

### Requirement: 事件的寫入與讀取不得遺失事件

事件是**發生過的事**而非當下狀態的快照，因此其落點 SHALL NOT 以覆寫承載 —— 短時間內連續發生的
多個事件 SHALL 全部可被讀到。

單一事件的寫入 SHALL 為原子操作，使讀取端 SHALL NOT 讀到只寫了一半的內容。

讀取端 SHALL 對重複送達的事件去重。

#### Scenario: 短時間內的多個事件全部被讀到

- **WHEN** agent 在短時間內連續產生多個事件
- **THEN** 每一個事件都被讀到，且各只被處理一次

#### Scenario: 損毀的事件不影響其餘事件

- **WHEN** 事件落點中有一筆內容不是合法的結構化資料
- **THEN** 該筆被忽略
- **AND** 其餘事件照常被處理，且不向使用者呈現解析錯誤

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

### Requirement: 等待狀態的預設為「未知」，不是「就緒」

系統為每個 agent session 維持一個等待狀態，其值 SHALL 為下列之一：**就緒**、**忙碌**、
**等待選擇**、**未知**。

下列情況 SHALL 一律為**未知**：尚未收到任何事件、注入未成立、收到不認得的事件形狀、
或事件已過期而無後續。

**「未知」SHALL NOT 被當作「就緒」處理。** 兩者的代價不對等：詳見 `agent-input-bridge`。

#### Scenario: 未注入時等待狀態為未知

- **WHEN** 某個 agent session 未注入事件回報
- **THEN** 該 session 的等待狀態為未知

#### Scenario: 不認得的事件形狀不改變狀態為就緒

- **WHEN** 某個 session 的事件落點中出現系統不認得的事件形狀
- **THEN** 該 session 的等待狀態為未知

### Requirement: 事件落點的清除只由 session 自身的結束觸發

session 結束時，其事件落點 SHALL 被清除。

**「session 結束」指本應用程式所定義的 session 結束，SHALL NOT 以 agent 回報的「對話結束」事件
為判準** —— agent 於使用者清空對話時即回報一段對話結束，而 session 仍在執行。該事件的正確語意是
「接下來可能換一份紀錄」，SHALL 觸發重新定位而非清除。

session 建立時，其落點的殘留 SHALL 被清除 —— 上一輪的殘留會讓等待狀態先呈現一份過期的值。

#### Scenario: session 結束後不留下事件

- **WHEN** 一個曾產生過事件的 session 被關閉
- **THEN** 其事件落點不再存在

#### Scenario: 新 session 不繼承上一輪的殘留

- **WHEN** 一個 session 結束後，同一位置被一個新的 session 使用
- **THEN** 新 session 的等待狀態自「未知」開始，不呈現上一輪的值

#### Scenario: agent 宣告對話結束但 session 仍在時不清除落點

- **WHEN** 某個 agent session 回報其一段對話已結束，而該 session 仍在執行
- **THEN** 其事件落點未被清除
- **AND** 其後產生的事件仍被讀到

### Requirement: Submitting a prompt and a failed tool make the agent busy; a failed turn makes it ready

The injected event reporting SHALL also cover three more moments:

- the user submits a prompt, which SHALL set the wait state to busy;
- a tool fails, which SHALL set it to busy;
- a turn ends because the agent's requests kept failing, which SHALL set it to ready. When a subagent
  reports such a failure instead of the agent itself, the state SHALL be unknown, not ready: whether
  subagents report it was not measured, and a subagent's failure can arrive while the agent waits on a
  choice, where ready would allow sending into the prompt.

Each of these SHALL yield awaiting-choice instead while a permission request is open (see "Every open
permission request is tracked").

**Reason**:

- Without the submission event, an agent writing a text-only answer is never busy: busy came only from tool
  use, so the state read ready for the whole answer.
- Without the tool-failure event, an approved tool that fails leaves the state on awaiting-choice until the
  turn ends. The agent reports a failed tool differently from a finished one, and no reply can be sent
  while the state is awaiting-choice.
- Without the failed-turn event, a turn whose requests failed would read busy until the idle notice a minute
  later. The turn-end event is not sent for a failed turn.

Measured (CLI 2.1.300):

- prompt submission is reported at submission, also mid-turn and during a text-only answer;
- it is not reported for local commands (`!` input, `/cost`, `/clear`), so none of them leaves the state
  busy;
- text typed into an open permission prompt or question is not a submission: that text and Enter answer
  it. A background task's notice, however, is reported as a submission while a prompt is open, so a
  submission does not end an open request by itself (see "Every open permission request is tracked");
- with the agent's service unreachable, the failed-turn event arrived after the agent's retries ran out
  (about three minutes), and the idle notice a minute after that.

**Known gaps**, for which the agent reports no event:

- A message queued during a text-only answer is reported when it is submitted. When the first answer ends,
  the state reads ready until the agent starts answering the queued message (measured 1.8 s).
- An interrupted turn sends no event (measured: none in 70 s). The state stays what the turn last reported,
  typically busy, until the next event, usually the user's next prompt.
- A subagent's tool event can arrive after the turn ended. The state then reads busy until the next event.

#### Scenario: A text-only answer shows the agent busy

- **WHEN** the user submits a prompt and the agent answers with text only, using no tool
- **THEN** the wait state is busy from the submission until the agent reports it finished

#### Scenario: A failed tool leaves the choice

- **WHEN** the agent asks to use a tool, the user approves, and the tool fails
- **THEN** the wait state leaves awaiting-choice when the failure is reported

#### Scenario: A failed turn makes the agent ready

- **WHEN** the agent is busy and reports that its turn ended because its requests failed
- **THEN** the wait state is ready

#### Scenario: A subagent's failed turn does not make the agent ready

- **WHEN** the agent waits on a choice and a subagent reports that its turn ended because its requests failed
- **THEN** the wait state is not ready

### Requirement: A pending choice keeps what it asks about until the choice ends

While the wait state stays awaiting-choice, the request presented as pending (the tool and its identifying
argument) SHALL be the first open request (see "Every open permission request is tracked"). An event that
names no tool SHALL NOT replace it, and neither SHALL a check that finds no new event or no event location.
The pending request SHALL clear when no request is open and the state leaves awaiting-choice. A new request
SHALL be queued after the open ones, not replace them.

**Reason**: the agent's own notice of the same prompt arrives about six seconds after the request and names
no tool (measured, CLI 2.1.300). The state is also checked several times a second, mostly finding nothing
new. Several requests can be open at once, and the terminal shows them in the order they were reported.

#### Scenario: The prompt's later notice does not erase the tool

- **WHEN** the agent asks to use a tool, and its notice of the same prompt arrives in a later check
- **THEN** the pending request still names the tool and its argument

#### Scenario: A view opened during the prompt shows the tool

- **WHEN** the agent asks to use a tool, several checks find no new event, and then the conversation view is opened
- **THEN** the view shows which tool is asking

#### Scenario: The next request replaces the pending one

- **WHEN** a pending request is answered and the agent then asks to use another tool
- **THEN** the pending request names the new tool

### Requirement: A denied permission prompt is a known blind spot

When the user denies a permission prompt of the agent itself, by dismissing it or by choosing to refuse, the
agent reports no event at all (measured, CLI 2.1.300: none within 70 seconds, no turn end and no idle
notice). That request therefore SHALL stay open until the agent's next turn event, typically the user's next
submitted prompt. This is a known limitation of the agent's event reporting. The state SHALL NOT
be inferred from the terminal screen.

Two cases are not blind:

- a denied subagent prompt ends when the subagent reports its end (measured);
- a denial the desktop itself writes for a paired device (`remote-protocol`) ends the request at once, and
  for the agent's own prompt sets the state to ready. Dismissing the agent's own prompt ended its turn in
  every measured case.

#### Scenario: Typing after a denied prompt recovers the state

- **WHEN** the user denies a permission prompt and then submits a prompt in the terminal
- **THEN** the wait state leaves awaiting-choice

#### Scenario: A denial written for a device makes the agent ready

- **WHEN** a paired device denies the agent's only open prompt, and the desktop writes the denial
- **THEN** the request is no longer open and the wait state is ready

### Requirement: Every open permission request is tracked, and the agent waits on a choice while any is open

The desktop SHALL track each permission request the agent reports, its subagents' included. Each request
SHALL be matched to the tool call it belongs to: the latest unmatched tool start of the same agent with the
same tool and the same input. A request SHALL stay open until one of these:

- its tool call finishes or fails;
- for a request of the agent itself: the agent itself ends a turn, fails a turn or has a prompt submitted;
- for a subagent's request: that subagent ends, or the agent itself ends a turn without listing that
  subagent among its running background tasks;
- a conversation starts that is not a compaction of the current one;
- the session's process ends.

The agent's own turn events SHALL NOT close a subagent's request. While any request is open, the wait state
SHALL be awaiting-choice, whatever other events report. A subagent's end SHALL change only the open requests.
Queued requests SHALL be presented in the order they were reported, and the pending request (tool and
argument) SHALL be the first open one.

**Reason**: measured (CLI 2.1.300):

- With background subagents asking permission, the agent reported its turn end while their prompts were
  open. After one was answered, a background-task notice arrived as a prompt submission, followed by a turn
  end. The state read ready over an open prompt, and a reply's text and the submit key approve an open
  prompt (`companion-test-fixes`).
- Neither event payload tells a typed submission from a notice. So the rule is keyed on whose request is open.
- With the agent's own prompt open, a finished background subagent's notice and the agent's turn end waited
  until the prompt was dismissed. So the agent's own turn events do not arrive over its own prompt.
- Parallel calls' tool starts can arrive before either request, so order alone cannot match a request to its
  call.

#### Scenario: A background subagent's prompt keeps the agent waiting on a choice

- **WHEN** a subagent running in the background asks permission, and the agent then reports its turn end, listing that subagent as running
- **THEN** the wait state is awaiting-choice, and the pending request names the subagent's tool

#### Scenario: A notice submitted while a subagent's prompt is open does not leave the choice

- **WHEN** two background subagents ask permission, the first prompt is answered, and a background-task notice is then submitted as a prompt followed by a turn end
- **THEN** the wait state is awaiting-choice, and the pending request names the second subagent's tool

#### Scenario: A dismissed subagent prompt ends with the subagent

- **WHEN** a subagent's permission prompt is dismissed and the subagent reports its end
- **THEN** that request is no longer open

#### Scenario: A subagent no longer running does not keep its request open

- **WHEN** a subagent's request is open and the agent reports a turn end whose running background tasks do not include that subagent
- **THEN** that request is no longer open

#### Scenario: Parallel requests are both open

- **WHEN** the agent asks permission for two parallel calls before either is answered
- **THEN** two requests are open, the pending request names the first, and after the first call finishes one request is open and the pending request names the second

#### Scenario: A parallel call that needed no permission does not close another's request

- **WHEN** the agent starts two parallel calls of one tool, only the second needs permission, and the first finishes
- **THEN** the second call's request is still open

#### Scenario: Compaction keeps the open requests

- **WHEN** a subagent's request is open and a conversation start for a compaction is reported
- **THEN** that request is still open

### Requirement: Each open permission request has an identity

Each permission request SHALL be given a new identity by the desktop when it is reported, together with the
time the agent reported it. The identity SHALL stay with the request while it is open. A choice that the agent
signals only by its later notice, with no request seen, SHALL have no identity.

**Reason**: the agent's request carries no identifier of its own (measured, CLI 2.1.300). Its prompt
identifier belongs to the turn and is shared by every prompt in it. A device's answer must name the request
it answers (`remote-protocol`).

#### Scenario: The prompt's later notice keeps the identity

- **WHEN** the agent asks permission, and its notice of the same prompt arrives in a later check
- **THEN** the open request has the identity it was given when it was reported

#### Scenario: The next request gets a new identity

- **WHEN** a prompt is answered and the agent then asks permission for another tool
- **THEN** the open request has a different identity

### Requirement: A question's questions, options and recorded answers are carried by white-list

When the agent asks questions with its question tool, the desktop SHALL keep, for each question, only:

- its text;
- its header;
- whether several options may be chosen;
- each option's label and description.

Each string SHALL be clipped. A question of any other shape SHALL leave the request without questions. When
the tool finishes, the desktop SHALL keep the answers the agent recorded, as text keyed by question, clipped.
No other part of the tool's input SHALL be kept.

#### Scenario: A question's options are kept in order

- **WHEN** the agent asks one question with three options
- **THEN** the open request carries that question with its three options in the agent's order

#### Scenario: A malformed question carries no questions

- **WHEN** the agent's question tool input has a question whose options are not a list
- **THEN** the open request carries no questions

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
