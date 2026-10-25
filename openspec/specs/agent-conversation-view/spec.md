# agent-conversation-view Specification

## Purpose

在主舞台上以結構化內容呈現 agent session 的對話，使 agent 的工作不必受限於終端的字格版面，
同時保留終端作為隨時可切回的逃生口。

## Requirements

### Requirement: agent session 有兩種可切換的 view，終端為預設

agent 目標的 session SHALL 具備**終端**與**對話**兩種 view，並 SHALL 提供在兩者之間切換的入口。

**終端 view SHALL 為預設**，且 SHALL NOT 可被移除 —— 它是對話 view 無法處理任何情況時的逃生口。
「預設」指的是**尚未選擇過時的值**；使用者選擇之後，新建的 session SHALL 採用當下的選擇
（見「view 的選擇為全域，且跨重啟保留」）。

**逃生口的作用域亦為全域** —— 切換 SHALL 使全部回到終端 view。**這是全域化刻意接受的代價**，
而它比「對話 view 壞掉時」廣：`agent-input-bridge` 要求等待狀態未知、等待選擇、以及送出後
未確認時，皆指引使用者切換到終端 view，而那些是 per-session 事件。

**SHALL NOT 以「該 session 自動退回終端」化解。** 兩個理由：其一，一個 session 的 view 與其他
不同、且是被系統寫上去的，在資料上就是一個 per-session 覆寫，只是寫入者換人 —— 它承受與
使用者覆寫相同的批評，而且更隱形。其二，`agent-transcript-stream` 明文要求內容無法取得時
**必須於該 session 的呈現中被說明，SHALL NOT 靜默地呈現為「沒有內容」**；自動退回會把那份
說明變成一次無聲的 view 切換，使用者只會看到「它有時候自己跳回終端」。**逃生口是使用者按的，
不是系統替他按的。**

shell 目標的 session SHALL NOT 具備對話 view，亦 SHALL NOT 呈現切換入口 —— 它沒有 agent 紀錄。

#### Scenario: 新建的 agent session 預設為終端 view

- **WHEN** 使用者尚未切換過 view，並建立一個 agent 目標的 session
- **THEN** 該 session 呈現終端 view
- **AND** 提供切換到對話 view 的入口

#### Scenario: 已選擇對話 view 時，新建的 session 採用該選擇

- **WHEN** 使用者已切換到對話 view，並建立一個 agent 目標的 session
- **THEN** 該 session 呈現對話 view

#### Scenario: 切換到對話 view 再切回

- **WHEN** 使用者於一個 agent session 切換到對話 view，再切回終端 view
- **THEN** 終端 view 呈現其原有內容

#### Scenario: shell session 沒有對話 view

- **WHEN** 使用者檢視一個 shell 目標的 session
- **THEN** 不呈現切換到對話 view 的入口

### Requirement: 切換 view 不改變 session 的身分與其 pty

切換 view SHALL NOT 建立或結束 pty、SHALL NOT 改變 session 的身分、順序或名稱。

兩種 view 是同一個 session 的兩種呈現，SHALL NOT 呈現為兩個分頁或兩個 session。

#### Scenario: 切到對話 view 後 pty 仍在執行

- **WHEN** 使用者於一個執行中的 agent session 切換到對話 view
- **THEN** 該 session 的 pty 仍在執行
- **AND** 分頁列中該 session 仍為單一一項

### Requirement: 當前 session 的終端保有版面盒子，即使對話 view 在其上

session 為當前顯示的 session 時，其終端 SHALL 保有版面盒子，與哪一個 view 位於上層無關。

**理由**：`terminal-sessions` 的「終端尺寸變化時 pty 尺寸同步」以「容器是否具有版面盒子」為判準，
並明文禁止在沒有盒子時推導或推送尺寸。若對話 view 在上層時終端失去盒子，該 session 的 pty
將停留在一個從未被量測過的初始值 —— agent 會以錯誤的寬度輸出，**而那些輸出一旦印出就永久留在
終端歷史裡**，使用者切回終端 view 時才會看見，屆時已無法補救。

終端不可見時仍 SHALL 依既有條款釋放其程式化繪製的渲染資源 —— 「有版面盒子」與「看得見」
是兩個不同的判準。

#### Scenario: 對話 view 在上層時 pty 的欄數與可用寬度相符

- **WHEN** 一個重建後尚未於終端 view 顯示過的 agent session，被喚醒並直接以對話 view 呈現
- **THEN** 該 session 的 pty 欄數與該區域當下的可用寬度相符
- **AND** 不為初始的暫定值

#### Scenario: 對話 view 在上層時終端不持有渲染資源

- **WHEN** 一個 agent session 以對話 view 呈現
- **THEN** 其終端不持有程式化繪製的渲染資源

### Requirement: 內容不完整時明示，不呈現為完整

對話 view SHALL 於下列情況**明示**其內容不完整，SHALL NOT 呈現為一份完整的對話：

- 尚未跟上紀錄（初次附掛或正在讀取）
- 較早的內容因量體上限而未載入
- 內容無法取得（見 `agent-transcript-stream`）

**理由**：一個安靜落後的對話 view 比沒有 view 更糟 —— 使用者會據此判斷 agent 沒在動。

#### Scenario: 尚未跟上時呈現跟進中

- **WHEN** 使用者切換到對話 view 而內容尚未讀取完成
- **THEN** 呈現「跟進中」的狀態，而非一份空的或部分的對話

#### Scenario: 內容無法取得時說明原因

- **WHEN** 某個 session 的紀錄無法讀取
- **THEN** 對話 view 說明內容無法取得，並指出可切換到終端 view

### Requirement: 休眠的 session 於對話 view 呈現休眠狀態

休眠的 session 於對話 view 之下 SHALL 明確呈現其休眠狀態，SHALL NOT 呈現為一份空的對話。

**一份空的對話與「這個 session 真的還沒講話」無法區分**，而兩者的正確處置不同。

#### Scenario: 休眠 session 於對話 view 呈現休眠

- **WHEN** 使用者檢視一個尚未被喚醒的休眠 session 且其當前 view 為對話
- **THEN** 該 session 明確呈現其休眠狀態，而非一份沒有內容的對話

### Requirement: agent 的忙碌狀態來自事件橋接，且 SHALL NOT 模擬逐字產生

對話 view SHALL 依 `agent-event-bridge` 回報的等待狀態呈現 agent 是否正在工作。

訊息 SHALL 於其完整內容抵達時整則出現。系統 SHALL NOT 以任何方式模擬「內容正在逐字產生」——
包含逐字顯示、與訊息長度相關的顯示延遲、或任何宣稱產生進度的呈現。

**理由**：內容抵達時該訊息早已完整，agent 可能已在進行下一件事。一個模擬的產生過程宣稱了一個
沒有來源的進度，與解析終端畫面是同一種錯誤的兩個方向 —— 前者猜測過去發生了什麼，後者演出
一件沒有發生的事。

訊息出現時的轉場效果 SHALL 被允許，但其時長 SHALL NOT 隨訊息長度改變 —— 一旦隨長度變化，
它就開始宣稱進度。

#### Scenario: 忙碌時呈現忙碌，閒置時不呈現

- **WHEN** 使用者送出訊息後 agent 尚未回報閒置
- **THEN** 對話 view 呈現 agent 正在工作
- **AND** agent 回報閒置後該呈現消失

#### Scenario: 訊息整則出現

- **WHEN** 一則新的 agent 訊息抵達
- **THEN** 其完整內容一次出現
- **AND** 不存在逐字顯示的過程

#### Scenario: 轉場時長不隨訊息長度改變

- **WHEN** 分別抵達一則短訊息與一則長訊息
- **THEN** 兩者出現的轉場時長相同

### Requirement: view 的選擇為全域，且跨重啟保留

當前 view 的選擇 SHALL 為**單一的全域偏好**，SHALL NOT 屬於個別 session。
於任何一個 agent session 切換 view，**所有 agent session** SHALL 一起改變。

**作用域是「所有 agent session」而不是「所有 session」** —— shell 目標的 session 仍然
不具備對話 view（見「agent session 有兩種可切換的 view，終端為預設」），該判定不受本條影響。

**切換的入口 SHALL 留在個別 session 上** —— 改變的只有作用域，不是操作的位置。

該選擇 SHALL 跨應用程式重啟保留，且 SHALL 與其他使用者偏好落盤於同一處；
**SHALL NOT 落盤於 session 的持久化紀錄**。兩處都寫的實作使「兩個 session 的 view 不一樣」
重新變得表達得出來，因此驗收 SHALL 同時斷言它**不在** session 的持久化紀錄裡。

**未設定時 SHALL 視為終端 view。**

持久化的值 SHALL 以白名單判定：**恰為已定義的兩種 view 之一才採用**，其餘一律視為未設定。
把不合法的值直接當成終端，會使「檔案損壞」與「使用者選了終端」無法區分。

#### Scenario: 切換一個 session 的 view，其他 session 一起改變

- **WHEN** 使用者於一個 agent session 切換到對話 view，且另有其他 agent session 存在
- **THEN** 其他 agent session 亦呈現對話 view

#### Scenario: 切回終端時其他 session 亦回到終端

- **WHEN** 使用者於一個 agent session 自對話 view 切回終端 view，且另有其他 agent session 存在
- **THEN** 其他 agent session 亦呈現終端 view

**兩個方向都要**：全部已在對話 view 時，「切換其中一個之後另一個是對話 view」與
「它一直都是對話 view」在觀察上完全相同。往終端方向的那一次才具鑑別力。

#### Scenario: 選擇不落在 session 的持久化紀錄裡

- **WHEN** 使用者切換 view 之後，檢視 session 的持久化紀錄
- **THEN** 該紀錄 SHALL NOT 含有任何逐 session 的 view 欄位

#### Scenario: 重啟後回到上次的選擇

- **WHEN** 使用者切換到對話 view，關閉並重新開啟應用程式，再喚醒一個 agent session
- **THEN** 該 session 以對話 view 呈現

#### Scenario: 持久化的值不合法時回到終端

- **WHEN** 持久化的偏好中，view 的值不是已定義的兩種之一
- **THEN** 呈現終端 view

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

### Requirement: A message the user did not type is labeled with where it came from

The conversation view SHALL label a message marked as not typed by the user with its origin when it carries one:
a message from another session with that session's name (or as from another session when no name is given), a
subagent's report with the subagent's type (or as from a subagent), a background-task notice as one. A message
with no origin SHALL keep the generic not-typed label. The labels SHALL come from the dictionary in every
supported language.

**Reason**: a session's message is shown as the sender's message, without the agent's wrapper that used to name the
sender (`agent-transcript-stream`); without the label the desktop could no longer tell who sent it.

#### Scenario: A message from another session names the session

- **WHEN** the conversation holds a message from another session that names its sender
- **THEN** the message's label names that session

#### Scenario: A background-task notice is labeled as one

- **WHEN** the conversation holds a background-task notice
- **THEN** its label says it is a background-task notice

#### Scenario: A not-typed message without an origin keeps the generic label

- **WHEN** the conversation holds a not-typed message with no origin, such as a skill's text
- **THEN** its label is the generic not-typed label

### Requirement: A tool result holding images says how many it holds

The conversation view SHALL label a tool result that lists images with the number of images it holds, beside the
result's or the failure's label. The label SHALL come from the dictionary in every supported language, with the
language's plural forms. The view SHALL NOT show the images themselves.

**Reason**: a result of reading an image has no text, so without the count the desktop shows an empty result and
the user cannot tell that the agent looked at a picture.

#### Scenario: A result with one image says so

- **WHEN** the conversation holds a tool result that lists one image and no text
- **THEN** the result's label says it holds one image

#### Scenario: A result without images has no count

- **WHEN** the conversation holds a tool result with only text
- **THEN** the result's label carries no image count
