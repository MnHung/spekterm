# agent-transcript-stream Specification

## Purpose

讓單一 agent session 的結構化紀錄以事件形式抵達呈現層，使 agent 的對話內容不必經由終端畫面
即可被呈現。與跨專案的批次存檔是兩條獨立的讀取路徑。

## Requirements

### Requirement: 跟進的來源由 session 自身的身分決定

系統 SHALL 以 session 自身的身分（其工作目錄與其對話識別碼）決定要跟進哪一份紀錄，
SHALL NOT 以「最近被修改的紀錄」或任何搜尋結果決定。

**理由**：多個 agent session 並行時，搜尋會抓到別人的紀錄，而失效方式是**把 A 的對話呈現在
B 的畫面上** —— 那比沒有內容更糟，因為它看起來完全正常。

session 的對話識別碼改變時，跟進的目標 SHALL 隨之改變 —— **無論該改變因何而起**。

**SHALL NOT 只涵蓋系統自己察覺得到的那些原因。** 續接失敗的自癒由系統發起，因此系統知道它發生了；
但**使用者在 agent 之內的操作同樣會換掉識別碼**（清空對話、切換對話、分支），而那些發生在
pty 之內 —— pty 沒有結束，系統收不到任何自己發出的訊號。

因此定位 SHALL 以 **agent 自己回報的紀錄位置**為權威（見 `agent-event-bridge`），
系統自行推導的位置僅為初始值與後備。

**漏掉這類來源的失效是安靜的**：跟進停在一份不再成長的紀錄上，落入「紀錄尚不存在」的等待，
既不報錯也不呈現落後 —— 使用者看到的是一份停住的對話，而終端裡 agent 明明在跑。

#### Scenario: 並行的 session 各自跟進自己的紀錄

- **WHEN** 兩個 agent session 同時執行，且各自產生新的內容
- **THEN** 每個 session 的呈現只包含它自己的內容

#### Scenario: 對話識別碼改變時跟進隨之改變

- **WHEN** 某個 agent session 的對話續接失敗並自癒為一個全新的對話
- **THEN** 該 session 的呈現跟進新對話的紀錄
- **AND** 不停留在舊對話的內容

#### Scenario: 使用者在 agent 之內換掉對話時跟進隨之改變

- **WHEN** 使用者於 agent 之內清空或切換對話，使其紀錄改換至另一個位置，而 pty 未結束
- **THEN** 該 session 的呈現跟進新的紀錄
- **AND** 不停留在舊紀錄的內容，亦不停留於「等待紀錄出現」的狀態

#### Scenario: 紀錄尚不存在不視為失敗

- **WHEN** 一個 agent session 剛建立，其紀錄尚未被寫出
- **THEN** 呈現層收到「尚無內容」而非錯誤
- **AND** 紀錄出現後其內容被送達

### Requirement: 跟進為增量，且已送出的內容不重送

系統 SHALL 只送出自上次讀取後新增的內容。

來源為逐行追加的格式，因此下列三種**不是單純追加**的情況 SHALL 各自被處理：

- **來源比上次讀到的位置短** —— 來源被改寫或更換。系統 SHALL 自頭重讀，並使呈現層據以重建。
- **最後一行尚未完整** —— 系統讀在寫入的中間。該行 SHALL NOT 被送出，直到它完整為止。
- **來源不存在** —— 見上一條，不是失敗。

#### Scenario: 只送出新增的內容

- **WHEN** 一份已被跟進的紀錄新增了一則內容
- **THEN** 呈現層只收到新增的那一則

#### Scenario: 來源被改寫時重新自頭讀取

- **WHEN** 一份已被跟進的紀錄其長度變得比上次讀到的位置短
- **THEN** 系統自頭重讀該紀錄
- **AND** 呈現層的內容與重讀的結果一致

#### Scenario: 不完整的最後一行不被送出

- **WHEN** 系統讀到的最後一行尚未終止
- **THEN** 該行不被送出
- **AND** 該行完整之後它被送出，且只送出一次

### Requirement: 記錄類型以白名單處理

系統 SHALL 只處理它明確認得的記錄類型，其餘 SHALL 一律忽略且 SHALL NOT 報錯。

**理由**：來源是 agent 的內部格式而非公開介面，其記錄類型會隨版本增加。黑名單式的排除會在
下一次更新時把新類型當成資料處理。本條使失效方向恆為「少呈現一種東西」，而非「呈現錯的東西」。

#### Scenario: 未知的記錄類型被忽略

- **WHEN** 紀錄中含有系統不認得的記錄類型
- **THEN** 該記錄不被呈現
- **AND** 其餘記錄照常呈現，且不出現錯誤訊息

### Requirement: 送往呈現層的事件不含檔案系統位置

送往呈現層的事件 SHALL 以 session 識別碼定址，SHALL NOT 含有任何絕對路徑 —— 包含來源紀錄
自身記載的工作目錄。

呈現層需要指涉檔案時（例如 agent 讀寫過的檔案），該指涉 SHALL 為 workspace 既有的位置詞彙，
翻譯不出來時 SHALL 呈現為不可導覽的純文字。

#### Scenario: 事件不含絕對路徑

- **WHEN** 呈現層收到任一則內容事件
- **THEN** 該事件不含任何絕對路徑

### Requirement: 初次附掛的內容量有上限，且超過時明示

使用者切換到一個已有大量內容的 session 時，系統 SHALL 送出最近的一段而非全部，並 SHALL
向使用者**明示**較早的內容未被載入。

**SHALL NOT 靜默截斷** —— 一個看起來完整、實際上少了開頭的對話，會讓使用者據此做出錯誤判斷。

#### Scenario: 長對話只載入最近一段並明示

- **WHEN** 使用者切換到一個內容量超過上限的 session
- **THEN** 呈現最近的一段內容
- **AND** 明示較早的內容未被載入

### Requirement: 跟進的失敗只影響它自己

跟進失敗（來源不可讀、內容無法解析、監看無法建立）SHALL NOT 影響該 session 的 pty、
其他 session、或應用程式本身。

失敗 SHALL 於該 session 的呈現中被說明，SHALL NOT 靜默地呈現為「沒有內容」——
後者與「這個 session 真的還沒講話」無法區分。

#### Scenario: 來源不可讀時 pty 不受影響

- **WHEN** 某個 session 的紀錄無法讀取
- **THEN** 該 session 的 pty 照常執行，終端 view 照常可用
- **AND** 對話 view 說明內容無法取得

### Requirement: 跟進的拆除只由 session 自身的結束觸發，不由 agent 宣告的對話結束觸發

跟進 SHALL 於 session 具備對話識別碼後開始，SHALL 於**該 session 結束**時停止並釋放其監看。

**「session 結束」指本應用程式所定義的 session 結束（其行程不再存在），SHALL NOT 以 agent 回報的
「對話結束」為判準。** 兩者是不同的生命週期：使用者在 agent 之內清空對話時，agent 會回報一段
對話結束，**而 session 仍在執行**。

以後者拆除的實作，其失效是：使用者清空對話的那一刻跟進被拆掉，其後**永遠不再更新** ——
而 session 正常、終端正常、沒有任何錯誤。agent 回報的對話結束 SHALL 觸發**重新定位**，
SHALL NOT 觸發拆除。

#### Scenario: session 結束後停止跟進

- **WHEN** 一個被跟進的 session 結束
- **THEN** 其監看被釋放
- **AND** 不再有該 session 的內容事件送出

#### Scenario: agent 宣告對話結束但 session 仍在時不拆除

- **WHEN** 某個 agent session 回報其一段對話已結束，而該 session 仍在執行
- **THEN** 跟進未被拆除
- **AND** 其後產生的新內容仍被送達呈現層

### Requirement: A message the user typed while the agent worked is presented as the user's message

A message the user submits while the agent is running tools is recorded by the agent as a different record
type from an ordinary user message (measured, CLI 2.1.300: an `attachment` record of subtype
`queued_command`). The follower SHALL present such a record as a user message when, and only when, the record
says it is a prompt typed by a human. That same subtype also carries background-task notices and messages
from other sessions, and those SHALL NOT be presented as the user's message.

The presented text SHALL be the text the user submitted, unchanged: a client confirms that its message
arrived by matching that text. The message SHALL be identified by the record's own identifier and time, and
SHALL appear where the record appears in the transcript.

This extends the record white-list by one subtype of one more record type. Every other record of that type
SHALL remain ignored.

#### Scenario: A message typed during a tool run appears

- **WHEN** the user submits a message while the agent is running a tool, and the agent records it as a mid-turn delivery
- **THEN** the conversation shows that message as the user's, with exactly the submitted text

#### Scenario: Other deliveries of the same record type are not the user's

- **WHEN** the transcript holds a mid-turn delivery that is a background-task notice, and another that is a message from another session
- **THEN** neither is shown as the user's message

#### Scenario: Other records of that type stay ignored

- **WHEN** the transcript holds a record of the same type with any other subtype
- **THEN** it is not shown, and no error is shown

### Requirement: A user record that the user did not type is marked as such

A user record SHALL be marked as not typed by the user when any of these holds:

- the record says it is a meta record;
- the record says its prompt came from the system;
- the record names an origin that is not a human;
- the record is the summary the agent writes when it compacts a conversation.

A record that carries none of these markers SHALL be presented as typed by the user, as before. That keeps
records from agent versions that do not write these fields unchanged.

**Reason**: the agent writes background-task completion notices, and conversation summaries, as user records
with no meta flag (measured, CLI 2.1.300). Deciding by the meta flag alone shows them as the user's own words.

#### Scenario: A background-task notice is not the user's message

- **WHEN** the transcript holds a user record that the agent wrote as a background-task completion notice, with no meta flag and a system prompt source
- **THEN** the conversation marks it as not typed by the user

#### Scenario: A compacted conversation's summary is not the user's message

- **WHEN** the transcript holds the summary record the agent wrote when compacting the conversation
- **THEN** the conversation marks it as not typed by the user

#### Scenario: A typed prompt is still the user's message

- **WHEN** the transcript holds a user record the user typed, whose origin is human
- **THEN** the conversation shows it as the user's message

#### Scenario: A record without origin fields keeps the meta flag's verdict

- **WHEN** the transcript holds a user record with no prompt source, no origin and no meta flag
- **THEN** the conversation shows it as the user's message
