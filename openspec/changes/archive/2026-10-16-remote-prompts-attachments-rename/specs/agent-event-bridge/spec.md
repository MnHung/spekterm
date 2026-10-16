## ADDED Requirements

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

## MODIFIED Requirements

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
path. That covers a tool's identifying argument, a question's text, and an option's label and description.
The obligation SHALL NOT be read as requiring that text to be rewritten.

#### Scenario: 事件內容不含絕對路徑

- **WHEN** the presentation layer receives content from any agent event
- **THEN** it contains no working directory, scratch directory or transcript location, and no tool parameter other than the identifying argument

#### Scenario: 選擇類請求的選項不含絕對路徑

- **WHEN** the agent makes a choice request whose tool parameters contain file paths
- **THEN** the presentation layer receives the identifying argument and, for a question, the question fields, and no other parameter

#### Scenario: An agent-written option is shown as plain text

- **WHEN** the agent asks a question whose option label contains a file path
- **THEN** the option is delivered with its label as written
