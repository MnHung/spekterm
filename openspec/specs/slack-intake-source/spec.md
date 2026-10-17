# slack-intake-source Specification

## Purpose

讓「有人在 Slack tag 了使用者本人」這件事成為收件匣的一則 intake：偵測、取回足以判斷的上下文、
經**既有的投遞契約**交進收件匣，其後完全沿用 `agent-intake` 與 `intake-routing`。

**本能力是收件匣的一個 producer，不是收件匣的一部分。** 這個分界是承重的，而不是整理上的偏好：
接取方式**已知必然會換**。Socket Mode 的 app 上不了 Slack Marketplace，且 app-level token
一個 app 只有一份、多條連線之間是負載平衡 —— **結構上這是單人、單一 workspace 的**。
產品化要走另一條路（Events API + 公開端點）。

因此本能力所交付的「擴充性」**是邊界的位置，不是多租戶**：換接取層時要改的是本能力自己，
`agent-intake`、`intake-routing`、session 的建立與預填一個字都不必改。**這句話寫在這裡，
是為了讓日後讀規格的人不必重新推導一次「為什麼不直接餵進去」。**

## Requirements

### Requirement: 偵測的對象是使用者本人被提及

系統 SHALL 偵測**訊息中提及使用者本人**的事件，SHALL NOT 以「提及某個 bot」為判準。

判準寫成「提及 bot」看起來只是實作差異，實際上是另一件事：它要求每個相關頻道都先邀請一個
bot，而使用者被 tag 的頻道**不在他的控制之下**（別人的頻道、私訊、臨時拉的群）。
以本人為判準才涵蓋得到那些地方。

**使用者自己發出的提及 SHALL 同樣被偵測。**

第一版排除了它（理由是「他不需要被自己交辦」、且在訊息裡 tag 自己會變成噪音），而那條裁決
**已被推翻，因為失效方向是不對稱的**：

- 收了而使用者不想要 ⇒ 收件匣多幾則**他自己造成的**項目，忽略一次就沒了。
- **不收而他想要 ⇒ 他 tag 了自己，什麼都不會發生** —— 而那與「這個功能壞了」在畫面上完全
  相同，正是本能力花了一整條 requirement（見「連線與授權的失效對使用者可見」）在對付的失效類。

且「tag 自己」是**唯一完全可信、完全刻意**的一種提及（其餘每一則都來自第三方），而拿 Slack
當待辦捕捉是常見用法。**系統 SHALL NOT 為此提供開關** —— 一個可預測答案的高頻問題不該被問；
若日後確認它確實吵，加開關會是一個資訊充分的決定，現在加是猜。

#### Scenario: 他人提及使用者即產生一則 intake

- **WHEN** 另一位成員在一則訊息中提及使用者本人
- **THEN** 收件匣中出現一則對應的待處理 intake

#### Scenario: 使用者自己發出的提及同樣產生 intake

- **WHEN** 使用者本人發出一則提及自己的訊息
- **THEN** 收件匣中出現一則對應的待處理 intake

#### Scenario: 未提及使用者的訊息不產生 intake，而同一批中提及他的照樣進來

- **WHEN** **同一批**訊息中含三則：使用者本人發出的一則提及自己的訊息、一則未提及任何人的
  訊息、以及另一位成員提及使用者的一則訊息
- **THEN** 收件匣中出現**兩則** intake，對應第一則與第三則

> **三則必須在同一批。** 那條否決單獨驗收時，「整條管線沒有接上」會讓它全綠 ——
> 一個什麼都不產生的實作完美滿足「不產生任何 intake」。把會通過的那兩則放進同一批，
> 否決就從「沒有東西發生」變成「篩選確實在運作」。

### Requirement: 應用程式未執行期間的提及不遺失

系統 SHALL 於啟動時取回「上次取回位置之後」發生而尚未交進收件匣的提及，
且該取回 SHALL NOT 依賴任何即時連線。

**桌面應用程式大多數時間是關著的，這是常態而非邊角情形。** 即時連線（無論何種形式）
在應用程式未執行時不存在，而 Slack 的即時通道**沒有重送佇列** —— 僅倚賴即時通道等同宣稱
「關機期間沒有人會 tag 你」。

**取回 SHALL 於啟動後進行，並 SHALL 週期性重複。** 只在啟動時取回一次是不夠的 ——
即時路徑是加速器且可能根本不可用，於是使用者在 app 執行期間被提及時**什麼都不會發生**，
而那與「功能壞了」在畫面上完全相同。**使用者存下憑證的那一刻 SHALL 也觸發一次取回** ——
那正是該去試一次的時機，而少了它他會看到一個什麼都沒變的畫面。

**來源要求延後時，系統 SHALL 尊重它。** 來源以「稍後再試」拒絕一次請求之後：

- **該輪 SHALL 停止對其餘目標的詢問。** 繼續逐一詢問只會逐一被拒絕 —— 那些請求註定不會帶回
  任何內容，而它們正是讓拒絕延長的原因。
- **在來源指定的時間之前 SHALL NOT 開始新的一輪。**
- **被跳過的那一輪 SHALL NOT 被補做。** 補做會在解禁的那一刻形成尖峰，而那正是這種拒絕存在的
  理由。**「跳過一輪」與「漏掉那段期間的提及」是兩件事** —— 取回位置的機制保證跳過期間發生的
  提及會在之後的取回中出現。
- **來源未指明等待多久時，系統 SHALL 仍然退避一段保守的時間**，SHALL NOT 視為零。
- **等待時間 SHALL 有上限。** 來源的端點是使用者可設定的，於是這個時間**不是完全可信的輸入**：
  一個指定極長等待的端點會讓本能力**無限期停擺**，而畫面上只呈現「正在等待」。
  一個能被輸入資料無限期關閉的能力，就是一個可以被關掉的能力。

系統 SHALL 記錄取回的位置並使其跨重啟保留，於是同一則提及 SHALL NOT 因為重複取回而被重複
交付（另見「重送不得被誤判為識別碼搶佔」）。

**回看的範圍 SHALL 有上限，且該上限 SHALL 為設定值。** 這是一個**刻意的缺口**：
關閉超過該範圍的期間所發生的提及會遺失。無上限的回看會讓啟動時的取回隨頻道數與時間長度
無界成長，而本能力不得阻塞主行程。**缺口的存在 SHALL 對使用者可見** —— 他必須能知道
「回補只看到這麼遠」，否則遺失與「沒有人 tag 我」在外部無法區分。

取回 SHALL 分批進行且 SHALL NOT 阻塞主行程（比照 `agent-intake` 對啟動檢視的同形條款）。

> **刻意的缺口：退避的狀態不跨重啟保留。** 重新啟動之後的第一輪可能立刻再次被拒絕一次。
> 代價是**一次**被拒絕的請求，而系統會立即重新學到；持久化它則需要一個依賴牆上時鐘的比較
> （「關機一天後開機」讀到的是一個過期的截止時間），為了省一次拒絕而引入那個依賴並不划算。

#### Scenario: 應用程式執行期間發生的提及也會進來，不必重啟

- **WHEN** 應用程式正在執行，且其後發生一則提及
- **THEN** 該提及在不重新啟動應用程式的情況下進入收件匣

#### Scenario: 存下憑證即觸發一次取回

- **WHEN** 應用程式已在執行而尚未設定憑證，使用者其後存下一份憑證
- **THEN** 系統立即進行一次取回，且其結果（成功或失敗）呈現於畫面上

#### Scenario: 關閉期間發生的提及於啟動後出現

- **WHEN** 應用程式未執行期間發生一則提及，其後應用程式啟動
- **THEN** 收件匣中出現該則提及對應的 intake

#### Scenario: 已取回的提及不因再次啟動而重複出現

- **WHEN** 一則提及已交進收件匣，應用程式其後重新啟動
- **THEN** 收件匣中該則 intake 的數量仍為一則
- **AND** 不產生任何面向使用者的拒絕或警示

#### Scenario: 回看範圍之外的提及不出現，而範圍之內的同時出現

- **WHEN** 兩則提及分別發生於回看範圍**之外**與**之內**，其後應用程式啟動
- **THEN** 收件匣中只出現範圍之內那一則對應的 intake
- **AND** 使用者看得到目前的回看範圍

> 兩則必須同時存在。只驗範圍之外那一則時，「回補整個沒有運作」會讓它全綠。

#### Scenario: 被要求稍後再試之後，該輪不再詢問其餘目標

- **WHEN** 一輪取回涵蓋多個目標
- **AND** 來源在其中一個目標上以「稍後再試」拒絕
- **THEN** 該輪對來源的詢問次數等於「已詢問到被拒絕的那一個為止」的次數
- **AND** 不等於目標的總數

#### Scenario: 指定的等待時間之前不開始新的一輪

- **WHEN** 來源要求等待一段時間
- **AND** 週期在該段時間之內到期
- **THEN** 該次週期不進行取回
- **AND** 該段時間過後的下一次週期正常進行取回

#### Scenario: 被跳過的期間內發生的提及之後仍然出現

- **WHEN** 系統因為被要求等待而跳過了一輪
- **AND** 該期間有人提及使用者
- **THEN** 該提及在之後的取回中進入收件匣

#### Scenario: 未指明等待多久時仍然退避

- **WHEN** 來源以「稍後再試」拒絕但未指明等待多久
- **THEN** 系統仍然退避一段時間，而非立即重試

#### Scenario: 極長的等待時間不使本能力永久停擺

- **WHEN** 來源指定的等待時間超過系統的上限
- **THEN** 系統在上限之後恢復取回

### Requirement: 每輪取回的投遞則數有上限

系統**每一輪**取回所交付的投遞則數 SHALL 有上限，達到時 SHALL 停止該輪並於下一輪續作，
且該事實 SHALL 對使用者可見。

**這一條所防的鏈第一次會被真的走到，正是因為本能力是第一個真實的來源。** 收件匣的待處理
總量上限是**暫時性拒絕**：超限的投遞原封留在落點、**每次掃描被重讀一次**，而 producer 若不
自我節制就會繼續寫新檔。一個活躍的使用者離線一段時間後開機，回補會一次產生遠多於上限的投遞，
於是落點累積大量無法被採納的項目，而每一次掃描都為它們付一次完整的讀取與解析。

`agent-intake` 既有的「面向使用者的拒絕與警示 SHALL 有界」擋得住訊息數量，擋不住這個成因 ——
**使用者的注意力是這條管線僅有的兩道防線之一，而本能力是那個決定投遞數量的角色**。

#### Scenario: 一輪取回不超過上限

- **WHEN** 回看範圍內待交付的提及數量超過每輪上限
- **THEN** 該輪交付的投遞則數不超過上限
- **AND** 使用者看得到還有未交付的項目

#### Scenario: 未交付的項目於下一輪續作

- **WHEN** 承上，其後再進行一輪取回
- **THEN** 先前未交付的提及被交付，且不重複交付已交付的那些

### Requirement: 一則提及對應一則 intake，識別碼由訊息座標推導

系統 SHALL 為每一則提及產生一則 intake，其識別碼 SHALL 自**該則訊息的座標**推導
（工作區、頻道與訊息三者），SHALL NOT 自其所在的討論串推導。

**以討論串為單位會讓第二次被 tag 靜默消失** —— 同一串裡再次被提及是一件新的事，
而它會與第一則共用識別碼，落入收件匣的重複抑制。

識別碼 SHALL 包含工作區的識別 —— 頻道的識別碼跨工作區不保證相異，而本能力日後接第二個
工作區時，碰撞的症狀是一則真實的工作項目被判為重複而消失。

#### Scenario: 同一討論串中的第二次提及是另一則 intake

- **WHEN** 使用者在同一討論串中先後被提及兩次
- **THEN** 收件匣中出現兩則相異的待處理 intake

#### Scenario: 識別碼可被收件匣接受

- **WHEN** 系統為一則提及產生 intake
- **THEN** 該識別碼通過收件匣既有的識別碼驗證，SHALL NOT 被拒絕

### Requirement: 同一則提及不被交付兩次，且其上下文取至被提及的那一則為止

系統 SHALL 於交付之前確認該提及的識別碼**尚未進入收件匣**，已進入者 SHALL NOT 再被交付。
該確認 SHALL 以**收件匣自己的紀錄**為依據，SHALL NOT 僅以本能力自己的取回位置為依據。

系統取回討論串時，其**上界 SHALL 為被提及的那一則訊息本身**，SHALL NOT 為「取回當下的內容」。

**兩者所防的不是同一件事：**

- **前者**防的是**假的識別碼搶佔警示**。收件匣對「同一識別碼、內容不同」的處置是一則可見的
  警示，語意為「有一件事沒進來」；而同一則提及隔一段時間被重新推導時，**發起者**（顯示名稱）
  與**來源座標標籤**（頻道名稱）等欄位可能已被第三方改動 —— 那時使用者會收到一則
  他沒做過的事的警示。**噪音與警訊走同一條通道，等於把警訊關掉。**

  以收件匣的紀錄為依據使這件事**在結構上不可達**：收件匣已有該識別碼 ⇒ 不交付 ⇒ 不做內容
  比對；收件匣沒有 ⇒ 交付被視為全新 ⇒ **同樣不做內容比對**。兩條路都不經過那個分支。
  **以本能力自己的取回位置為依據則不足** —— 會觸發重新推導的主要原因正是那個位置遺失
  （重裝、設定還原、設定檔損毀隔離），而它遺失時與它同居的任何紀錄一併遺失。

- **後者**是**語意**上的要求：使用者是在那個時間點被交辦的，他需要的是**那時**的上下文。
  其後的回覆若再次提及他，那是另一則提及、另一個座標、另一則 intake。它同時把下述缺口的
  影響面限制在少數幾個字串上。

系統 SHALL NOT 為此保存任何額外的內容快照 —— 上述兩者已使其不必要。

**殘餘的缺口**：確認若因缺陷被跳過，而討論串中既有訊息又被編輯或刪除，仍會產生一則假的
識別碼搶佔警示。此缺口為已知，其處置是「罕見且可見」優於「必然且誤導」。

#### Scenario: 提及之後新增的回覆不改變已交付的內容

- **WHEN** 一則提及已交進收件匣，其所在討論串其後新增了回覆
- **THEN** 收件匣中該則 intake 的本文不變

#### Scenario: 取回位置遺失之後不重複交付，也不產生警示

- **WHEN** 一則提及已交進收件匣，本能力的取回位置其後遺失，且該頻道被改名、發話者也改了
  顯示名稱，系統其後重新取回該範圍
- **THEN** 收件匣中該則 intake 的數量仍為一則
- **AND** 不產生任何面向使用者的拒絕或警示
- **AND** **該提及確實被重新取回並考慮過**（而非因為取回位置或篩選而未被看見）

#### Scenario: 收件匣中已被接受或忽略的項目同樣不再被交付

- **WHEN** 一則提及已被使用者接受（或忽略），本能力的取回位置其後遺失，系統重新取回該範圍
- **THEN** 該提及不再被交付，且不出現為一則新的待處理項目

#### Scenario: 內容真的不同時警示確實出現

- **WHEN** 一份識別碼與既有項目相同、而參與重複判定的欄位確實不同的投遞抵達收件匣
- **THEN** 出現一則面向使用者的警示

> 前兩條與最後一條**必須成對驗收**。只驗前者時，「那則提及根本沒有被重新看見」會讓它全綠，
> 而該確認機制一個位元組都沒被驗到（因此第三條 THEN 是必要的）；只驗後者時，
> 警示通道沒接上照樣全綠。

### Requirement: 超出長度上限時截斷，且截斷這件事寫在本文之內

系統 SHALL 於交付前把**每一個**受收件匣長度上限約束的欄位截至上限之內，
SHALL NOT 交付一則會因長度而被收件匣拒絕的投遞。

**作用域是所有 authored 欄位，不只是本文。** 收件匣有兩個不同的上限：一個較寬的套在本文上，
一個較窄的套在**標題、發起者與來源座標標籤**上，任一超過即**整則被拒絕**。
**而提及訊息的第一行拿來當標題很容易超過後者** —— 只截斷本文時，症狀是某些提及永遠進不了
收件匣，而使用者只看到一則看不懂的拒絕。截斷的尺度 SHALL 與收件匣判定長度的尺度相同
（正規化之後、同一種字元計量），否則會在邊界上差幾個字元而仍被拒絕。

本文的截斷 SHALL 保留**最接近被提及那一則**的內容。

**截斷發生這件事 SHALL 出現在本文字串之內**，SHALL NOT 僅出現在投遞的其他欄位、亦 SHALL NOT
由呈現層附加。本文是唯一「呈現給使用者的那一份逐字元就是交給 agent 的那一份」的欄位；
截斷標記置於他處時，**使用者讀到「這裡被截斷了」而 agent 讀不到** —— 兩者對「我看到的是
全部嗎」得到相反的答案，而那正是這條管線的人類閘門所倚賴的等式。

#### Scenario: 過長的討論串被截斷而非被拒絕

- **WHEN** 一則提及所在的討論串內容超過本文長度上限
- **THEN** 收件匣中出現對應的 intake
- **AND** 其本文之內含有截斷發生的說明

#### Scenario: 截斷保留最接近提及的內容

- **WHEN** 承上
- **THEN** 本文包含被提及的那一則訊息

#### Scenario: 過長的標題不使整則被拒絕

- **WHEN** 一則提及的訊息其第一行長度超過標題的長度上限
- **THEN** 收件匣中出現對應的 intake
- **AND** 不產生面向使用者的拒絕

### Requirement: 連線與授權的失效對使用者可見，且與「沒有人提及你」可區分

系統 SHALL 呈現本能力當前是否正常運作。連線中斷、憑證失效或權限不足時，SHALL 以使用者
看得到的方式呈現，SHALL NOT 僅寫入診斷輸出。

**「憑證失效」與「權限不足」SHALL 呈現為不同的情形，且後者 SHALL 指出缺少哪些權限。**
兩者都「重試無用」，但**處置完全相反**：前者要換一份憑證，後者要擴充權限並重新授權 ——
把後者報成前者會讓使用者換一份新憑證，而問題原封不動。來源若在回應中指出了缺少的權限，
那是這則訊息**唯一可行動的部分**，SHALL NOT 被丟棄。

**「來源要我們稍後再試」SHALL 呈現為與上述兩者不同的情形。** 它的處置是**什麼都不必做** ——
報成憑證失效或權限不足，會讓使用者去修一個根本不存在的問題。

**本能力的每一種失效在外部都是同一個樣子：收件匣是空的。** 而「沒有人 tag 我」也是同一個
樣子 —— 兩者若不可區分，使用者會在一件已經壞掉的事情上繼續等待。

**使用者明確要求的取回若因為退避而沒有進行，系統 SHALL 讓他看得出這件事。**
他按下之後什麼都沒發生，與「功能壞了」在畫面上完全相同 —— 而讓這兩者可區分正是本條
requirement 的全部目的。一次靜默的跳過會讓本條在那條路徑上作廢。

面向使用者的警示 SHALL 有界：重複的失效 SHALL 合併呈現，SHALL NOT 逐次各發一則
（與 `agent-intake` 對拒絕與警示的同形條款一致 —— 使用者的注意力是這條管線的防線之一）。

#### Scenario: 憑證失效時使用者看得到

- **WHEN** 系統的憑證不再有效
- **THEN** 使用者看得到本能力目前無法運作
- **AND** 該呈現與「目前沒有待處理項目」可區分

#### Scenario: 權限不足與憑證失效的呈現不同，且指出缺哪些權限

- **WHEN** 憑證有效但其權限不足以完成取回
- **THEN** 呈現指出是**權限**的問題，而非憑證失效
- **AND** 呈現包含來源所指出的**缺少哪些權限**

#### Scenario: 被要求稍後再試的呈現不同於憑證失效與權限不足

- **WHEN** 來源以「稍後再試」拒絕一次取回
- **THEN** 呈現指出這是暫時的、不需要使用者做任何事
- **AND** 該呈現與「憑證失效」及「權限不足」皆可區分

#### Scenario: 使用者觸發的取回落在退避期內時仍有回應

- **WHEN** 系統正在退避期內
- **AND** 使用者做出會觸發取回的操作
- **THEN** 呈現讓他看得出取回沒有進行以及大約何時會進行
- **AND** 呈現不停留在操作之前的樣子

#### Scenario: 重複的失效合併為恰好一則，且該則指出重複的次數

- **WHEN** 同一種失效連續發生多次
- **THEN** 使用者看到的呈現**恰為一則**
- **AND** 該則指出它涵蓋了多次發生

> **「而非多則」單獨不成立** —— 零則也滿足它，於是「失效通道整個沒接上」照樣全綠。
> 要求恰為一則、且該則帶著次數，兩個方向就都紅得起來。

### Requirement: 交付經既有的投遞契約，不修改收件匣的任何判斷

系統 SHALL 經 `agent-intake` 既有的投遞落點交付 intake，SHALL NOT 另闢一條進入收件匣的路徑。

**繞路是刻意的。** 經落點交付即沿用該能力既有的**全部**判定（大小上限、正規化、識別碼驗證、
重複、總量上限、拒絕的消費與否）；行程內的捷徑會開出第二條路徑，而那條路徑上的每一道判定
都要重做一次 —— 三個站點各自建構監看者、演化出三種錯誤姿態，是同一個形狀的前例。

它同時保住了 Purpose 所述的可替換性：本能力日後移出主行程時，收件匣不需要知道。

本能力的投遞 SHALL NOT 因為來自應用程式自身而獲得任何特殊待遇 —— 其內容與外部 producer 的
投遞**同樣不受信任**（Slack 上的任何人都寫得出那些字）。

#### Scenario: 收件匣已達總量上限時本能力的投遞受既有處置

- **WHEN** 收件匣的待處理則數已達上限，本能力其後交付一則投遞
- **THEN** 該投遞被依既有的**暫時性拒絕**處置（不被消費、原封留在落點）
- **AND** 使用者清出空間後該則仍被採納，不因來源為本能力而例外

> 這條刻意不以「長度超限」為前提 —— 前一條 requirement 要求 producer 自己截斷，
> 於是「長度超限的投遞」在實作正確時**造不出來**，那是一個 mutation 而不是 scenario。
> 總量上限是 producer **無法預防**的拒絕，因此它才驗得到「沿用既有處置」這件事。

#### Scenario: 新增本能力未改變收件匣的判斷

- **WHEN** 檢視收件匣與 routing 的判定邏輯
- **THEN** 其中沒有任何以「來源是否為 Slack」為條件的分支

### Requirement: 驗收以替身取代真實服務，且該缺口載明於規格

本能力的自動化驗收 SHALL 以替身取代真實的 Slack 服務。**真實連線的驗證 SHALL 視為未涵蓋**，
由 dogfood 認定 —— 它要網路、要憑證，且回應不可重現（比照 `conversation-report` 的真實委派
與 `agent-event-bridge` 的真實 agent）。

**驗收 SHALL 斷言結果，SHALL NOT 僅斷言系統送出了何種請求。** 兩者的差別是承重的：
後者在整條取回或轉換路徑失效時**不會失敗**。已有前例 —— 僅斷言注入旗標存在的驗收全綠地
通過了一個「命令有語法錯、每次都失敗、事件目錄安靜地空著」的實作。

替身 SHALL 能演出以下情形，否則對應的 scenario 無載體：連線中斷、憑證失效、
同一則提及被重複取回、討論串超過本文長度上限、提及落在回看範圍之外。

#### Scenario: 驗收斷言的是收件匣的結果

- **WHEN** 驗證一則提及被轉成 intake
- **THEN** 斷言的對象是收件匣中該則 intake 的存在與其本文內容，而非系統送出的請求

#### Scenario: 真實服務的驗證載明為未涵蓋

- **WHEN** 檢視本能力的驗收範圍
- **THEN** 「對真實 Slack 服務的連線」被明確記為未涵蓋

### Requirement: 投遞宣告被提及那一則訊息的時間

系統 SHALL 在每一份投遞中宣告**被提及那一則訊息**於來源發生的時間（見 `agent-intake` 的發生時間），
SHALL NOT 以取回或交付的時刻代替。

**回補是本能力的主幹**：桌面應用程式大多數時間是關著的，關閉期間的提及於下次啟動時一次取回。
不宣告的話，收件匣只知道它們**到達**的時刻 —— 昨天的提及會顯示成「剛剛」，而一整批回補的
項目看起來同時發生，使用者分不出哪一件先來。

#### Scenario: 回補取回的提及宣告訊息本身的時間

- **WHEN** 應用程式關閉期間的一則提及於啟動時被回補
- **THEN** 其投遞宣告的發生時間為該則訊息於來源發生的時間，而非回補的時刻

#### Scenario: 即時收到的提及同樣宣告訊息的時間

- **WHEN** 一則提及經即時連線收到
- **THEN** 其投遞宣告的發生時間為該則訊息於來源發生的時間

### Requirement: 連線設定為資料，存於本能力自己的位置，且於 Settings 的 Integrations 區段編輯

連線所需的設定（憑證、回看範圍、服務端點）SHALL 為使用者可編輯的**資料**，
SHALL NOT 為程式碼中的常數，SHALL NOT 需要重新安裝應用程式。

**但「要偵測誰被提及」與「連到哪個工作區」SHALL 自憑證推導，SHALL NOT 為使用者可編輯的設定。**
兩者 MAY 被快取以供呈現，而快取 SHALL NOT 有面向 renderer 的寫入通道。

理由是**失效模式**，不是便利：一個由使用者填寫的「要偵測誰」填錯了，症狀是**什麼都不會發生**
—— 與「沒有人提及我」、與「連線已失效」在畫面上完全相同，而這條能力的每一種失效本來就都長
那個樣子（見「連線與授權的失效對使用者可見」）。再加一個同樣形狀的失效源，等於把那條
requirement 的價值抵消掉一部分。自憑證推導則**表達不出來填錯** —— 憑證能看到的就是它擁有者
看到的東西，而推導出的身分就是那個擁有者。

本條的用意（不是常數、不需重新安裝）因此完全保留：推導比設定更強地滿足它。

設定 SHALL 落於本能力自己的持久化位置，SHALL NOT 與終端偏好共用同一份檔案或同一個物件
（理由與 `intake-routing` 對規則的同形條款一致：該檔案的寫入路徑自空物件重建其內容，
寄居其中的欄位倚賴每一個寫入者記得保留它）。憑證另受 `secret-scope` 約束。

The editing interface SHALL be the Integrations section of Settings (see `terminal-preferences`), and the
inbox SHALL NOT have its own copy of it. Where it is edited and where it is stored are separate questions: the
storage rule above stands unchanged.

- A token SHALL be stored only through its own save control, never when focus leaves the field, so that a partly
  pasted secret is never stored. The section SHALL say so next to the field.
- A token SHALL also be stored on Enter.
- The look-back window and the endpoint SHALL apply when the user presses Enter or leaves the field, and SHALL
  show a failure to apply next to the field (the save rule of `terminal-preferences`).
- The endpoint field is a draft: leaving it empty SHALL change nothing, and the endpoint SHALL return to the
  default only through its own reset control.
- An endpoint the user enters that is not an acceptable `https:` address SHALL be refused and shown as refused,
  and the stored endpoint SHALL stay as it was. An edit SHALL NOT silently turn into the default. A stored value
  that fails the check when it is read back is a different case: it still means the default.
- While no routing fallback folder is set (see `intake-routing`), the section SHALL say that mentions will
  arrive with no folder to open in, and SHALL offer a control that opens the inbox's routing rules. While a
  fallback is set, it SHALL NOT say so.

**Why it moved**: the inbox held these knobs in a tab beside its content, and each knob there followed its
own save model. The previous reason for keeping them out of the preferences dialog was that its content was
enumerated as terminal preferences. That dialog is now the application's single place for settings.

#### Scenario: 設定跨重啟保留

- **WHEN** 使用者經編輯介面設定連線，應用程式其後重新啟動
- **THEN** 該設定仍然生效

#### Scenario: 變更終端偏好不影響本能力的設定

- **WHEN** 本能力的設定已完成，使用者其後變更終端字型設定
- **THEN** 本能力的設定未改變

#### Scenario: 身分沒有面向使用者的編輯入口

- **WHEN** 檢視本能力的編輯介面與其 IPC 介面
- **THEN** 其中沒有設定「要偵測誰」或「哪個工作區」的通道
- **AND** 憑證設定完成後，介面呈現自該憑證推導出的身分

#### Scenario: The connection is edited in Settings, not the inbox

- **WHEN** the user opens the inbox
- **THEN** it has no Slack settings; Settings' Integrations section has them

#### Scenario: A token is not stored when the field is left

- **WHEN** the user pastes into a token field and moves focus away without using its save control
- **THEN** no token is stored

#### Scenario: The look-back window applies once

- **WHEN** the user types a two-digit look-back window and leaves the field
- **THEN** the stored value is that number, and no single-digit value was stored while typing

#### Scenario: An invalid endpoint is refused and the stored one stays

- **WHEN** a custom endpoint is stored and the user enters an `http:` address and presses Enter
- **THEN** the section shows that it was refused, and the stored endpoint is still the custom one

#### Scenario: An empty endpoint draft changes nothing

- **WHEN** a custom endpoint is stored and the user moves focus into the empty endpoint field and out again
- **THEN** the stored endpoint is still the custom one

#### Scenario: The fallback hint follows the fallback

- **WHEN** no routing fallback folder is set and the user shows the Integrations section
- **THEN** it says that mentions arrive with no folder to open in, and its control opens the inbox's routing rules
- **AND WHEN** a fallback folder is then set
- **THEN** the section no longer says so

### Requirement: The inbox says when Slack is not working

While the Slack connection is set up and not working (an invalid credential, missing permissions, a connection
failure, or a wait the service asked for), the inbox SHALL show one line stating that, as the Integrations section
of Settings states it. The line SHALL offer a control that closes the inbox and opens Settings on that section. While the connection
works, or was never set up, the inbox SHALL NOT mention Slack.

**Why**: from the outside, every failure of this capability looks the same as nobody mentioning the user: an empty
inbox (see "連線與授權的失效對使用者可見，且與「沒有人提及你」可區分"). The user looks at the inbox, not at
Settings, so the inbox is where the difference must be visible.

#### Scenario: A broken connection is stated in the inbox

- **WHEN** the Slack credential is no longer valid and the user opens the inbox
- **THEN** the inbox states that Slack is not working, and its control opens Settings on Integrations

#### Scenario: A working or absent connection is not mentioned

- **WHEN** Slack was never set up, or works, and the user opens the inbox
- **THEN** the inbox does not mention Slack
