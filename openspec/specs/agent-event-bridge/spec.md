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

#### Scenario: 事件內容不含絕對路徑

- **WHEN** 呈現層收到任一則源自 agent 事件的內容
- **THEN** 該內容不含任何絕對路徑

#### Scenario: 選擇類請求的選項不含絕對路徑

- **WHEN** agent 提出一個參數中含有檔案路徑的選擇類請求
- **THEN** 呈現層收到的選項不含絕對路徑

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
  it. So this event cannot move the state out of awaiting-choice while a prompt is open;
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
- **THEN** the wait state is unknown, not ready

### Requirement: A pending choice keeps what it asks about until the choice ends

While the wait state stays awaiting-choice, the request presented as pending (the tool and its identifying
argument) SHALL stay the one the agent's request named. An event that names no tool SHALL NOT replace it,
and neither SHALL a check that finds no new event or no event location. The pending request SHALL clear
when the state leaves awaiting-choice, and a new request that names a tool SHALL replace it.

**Reason**: the agent's own notice of the same prompt arrives about six seconds after the request and names
no tool (measured, CLI 2.1.300). The state is also checked several times a second, mostly finding nothing
new.

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

When the user denies a permission prompt, by dismissing it or by choosing to refuse, the agent reports no
event at all (measured, CLI 2.1.300: none within 70 seconds, no turn end and no idle notice). The wait state
therefore SHALL stay awaiting-choice until the next event, typically the user's next submitted prompt. This
is a known limitation of the agent's event reporting. The state SHALL NOT be inferred from the terminal
screen.

#### Scenario: Typing after a denied prompt recovers the state

- **WHEN** the user denies a permission prompt and then submits a prompt in the terminal
- **THEN** the wait state leaves awaiting-choice
