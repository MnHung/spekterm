# session-lineage Specification

## Purpose
由交接建立的 session 記住它是由哪一個 session 交接出來的：使用者在 rail 與 session 上看得到這份
母子關係、在兩端之間直接跳轉；session 裡的 agent 隨時查得到它的母子 session 當下的名字與狀態 ——
跨應用程式重啟、母 session 不在之後仍然成立。

**本能力不是安全邊界**，理由與 `agent-handoff-source` 相同：來源由落點推導，而 agent 算得出
別人的落點。它保證的是**投遞內容與 renderer 都無法宣告一段關係**，不是關係不可偽造。

## Requirements

### Requirement: 由交接建立的 session 於建立當下記住它的來源 session

一則交接建立 session 時，系統 SHALL 讓該 session 記住它的**來源 session**：來源 session 的識別碼，
以及**交接被攝入時**來源的呈現快照。快照的歸屬 SHALL 為三者之一，且三者 SHALL 可被明確區分：
**某個 folder**（連同它當時的名稱）、**全域項目**、**未知**（攝入時來源已經結束）。快照另含來源
session 當時的標籤（未知時缺席）。標籤是 pty 宣告或使用者輸入的文字，SHALL 經與投遞內容相同的
正規化並截斷長度之後才被記下。

**快照 SHALL 取自攝入的那一刻，SHALL NOT 取自 session 建立的那一刻。** 一則退回待處理的交接（預填逾時）
可能在數天之後才被接受，那時來源 session 可能已經改名或關閉。

**來源 SHALL 由主行程於建立該 session 的當下寫入**，取自 `agent-handoff-source` 由落點推導出的
那一個來源 session：

- SHALL NOT 採信投遞內容中任何自稱來源的欄位；
- renderer SHALL NOT 能替任何 session 宣告或更改來源。renderer 至多能出示一張由主行程簽發的
  **單次憑證**，指明「這個新 session 是為了哪一則交接而建立的」；主行程查該則交接自己記下的來源。
  憑證 SHALL 綁定該則交接、目標 folder 與 agent 目標，**使用一次即失效**，且只在主行程決定要為該則
  交接建立 session 時簽發（到達即建立，或使用者接受）—— 一則歷史上的交接 SHALL NOT 能被重複引用
  來產生子 session。**對一個已經存在的 session，SHALL NOT 有任何途徑寫入來源**。

**兩條建立路徑皆適用**：到達即建立的交接，以及因預填逾時退回待處理、其後由使用者接受的交接。
使用者接受之前改選了 folder 時，來源不變。同一則交接因重新處理而建立了第二個 session 時，
兩者 SHALL 皆以同一個來源 session 為母 session。

非由交接建立的 session SHALL 沒有來源。

來源 session 在交接被攝入時已經結束者，來源 SHALL 仍被記下；其快照的歸屬為**未知**，且該來源
自始即不存在（見「session 的存在」）。歸屬為未知的來源 SHALL NOT 被呈現為來自全域項目。

#### Scenario: 交接建立的 session 帶著來源

- **WHEN** folder A 的 session S 投遞一則交接，目標為 folder B
- **THEN** folder B 中建立的 session 其來源為 S
- **AND** 其快照含 folder A 的名稱與 S 於攝入當下的標籤

#### Scenario: 投遞內容自稱的來源不被採信

- **WHEN** session S 投遞一則交接，其內容含有自稱來源為另一個 session T 的欄位
- **THEN** 建立的 session 其來源為 S

#### Scenario: 降級為待處理後接受的交接，快照是攝入當下的

- **WHEN** 一則由 session S 投遞的交接因預填逾時退回待處理，使用者其後把 S 重新命名，再接受該則交接
- **THEN** 建立的 session 其來源為 S，且其快照中的標籤為重新命名之前的標籤

#### Scenario: 一則交接建立兩個 session 時兩者皆為子 session

- **WHEN** 一則由 session S 投遞的交接建立了 session C1，其後因預填等不到就緒而回到待處理，使用者改選另一個 folder 接受，建立了 session C2
- **THEN** C1 與 C2 的來源皆為 S

#### Scenario: 攝入時已結束的來源不被呈現為全域

- **WHEN** session S 投遞一則交接之後、它被攝入之前，S 已經結束
- **THEN** 建立的 session 其來源標示標明來源已關閉，且不呈現為來自全域項目

#### Scenario: 同一張憑證不能用兩次

- **WHEN** 一則交接建立了 session C1，renderer 以同一張憑證再建立一個 session
- **THEN** 第二個 session 沒有來源

#### Scenario: 手動建立的 session 沒有來源

- **WHEN** 使用者於 folder A 手動建立一個 session
- **THEN** 該 session 沒有來源，且不呈現任何來源標示

#### Scenario: renderer 無法替既有的 session 宣告來源

- **WHEN** renderer 送往持久化的 session 資料中，替一個手動建立的 session 附上來源
- **THEN** 該 session 仍沒有來源，重新啟動之後亦然

### Requirement: 關係跨應用程式重啟與 renderer 重新載入存活

session 的來源 SHALL 隨該 session 一起持久化，於應用程式重新啟動與 renderer 重新載入之後
SHALL 維持相同。

**關係 SHALL 以 spekterm 自身的 session 識別碼表達，SHALL NOT 以 agent 的對話識別碼表達。**
前者依 `session-persistence` 永不改變；後者於續接失敗、自癒成新對話時會更換 —— 以它表達的關係
會在那一刻靜默斷開，而那正是使用者最需要找回母 session 的時候（重開之後）。

#### Scenario: 重新啟動之後關係仍在

- **WHEN** session C 由 session P 交接而來，其後應用程式重新啟動
- **THEN** C 的來源仍為 P，且兩端的標示照常呈現

#### Scenario: 對話識別碼更換不影響關係

- **WHEN** P 於重新啟動之後續接失敗、以全新的對話重建
- **THEN** C 的來源仍為 P

### Requirement: session 的存在有單一定義

本能力所稱「一個 session **存在**」，SHALL 為下列三者同時成立：它仍在 session 清單中、它的行程
不是已結束（休眠不算結束）、它所屬的 folder 仍在 workspace 之中（全域 session 恆滿足此項）。

**剛建立、renderer 尚未把它送來持久化的 session**，只在它的行程仍在執行時才算存在 —— renderer 在
那之前重新載入的話，它永遠不會被持久化，而它若仍被算作存在，母 session 會一直看到一個不存在的
子 session。

**所屬 folder 被移出 workspace 的 session 其行程可能仍在執行、也收得到訊息**（移除 folder 不會關閉
它的 session），但它已沒有 rail 入口，使用者無從跳到它。本能力把它視為不存在，使「畫面上點不到」
與「關係中標為已關閉」一致。

使用者可見的標示、rail 的樹狀、以及給 agent 讀的關係 SHALL 依據**同一個**定義 —— 兩者若分歧，
畫面會把子 session 縮排在一個 agent 看來已經不在的母 session 之下。

#### Scenario: 已結束的母 session 視為不存在

- **WHEN** session C 的母 session P 的行程結束，其分頁仍留在畫面上
- **THEN** C 的來源標示標明已關閉，且 rail 上 C 以頂層呈現

#### Scenario: 所屬 folder 被移出 workspace 的母 session 視為不存在

- **WHEN** session C 的母 session P 所屬的 folder 被移出 workspace
- **THEN** C 的來源標示標明已關閉，且觸發它為無操作

#### Scenario: 未被持久化就失去行程的 session 不存在

- **WHEN** 一則交接建立了 session C，renderer 在把 C 送去持久化之前重新載入
- **THEN** C 的母 session 查詢自己的關係，結果中不含 C

#### Scenario: 休眠的母 session 仍然存在

- **WHEN** 應用程式重新啟動之後，C 的母 session P 為休眠
- **THEN** C 的來源標示可被觸發，且觸發它聚焦 P

### Requirement: 母子兩端各有一個可跳轉的標示

有來源的 session（**子 session**）SHALL 呈現一個來源標示，說出來源所屬的 rail 項目名稱與來源
session 的標籤。來源 session 存在時，觸發該標示 SHALL 選中來源所屬的 rail 項目並聚焦來源 session。

有子 session 的 session（**母 session**）SHALL 呈現一個標示，說出它**目前存在的**子 session 數量；
觸發它 SHALL 列出那些子 session（各自的 rail 項目名稱與標籤；只有一個時亦同），選取其一 SHALL 選中該子 session
所屬的 rail 項目並聚焦它。該清單 SHALL 可全鍵盤操作。

兩個標示 SHALL 同時出現於 rail 的 session 子列與主舞台的 session 分頁上，**不論母子是否屬於同一個
rail 項目** —— 同一個 rail 項目中的樹狀呈現（見 `workspace-layout`）SHALL NOT 取代它們。

來源標示 SHALL 呈現來源 session 的**當前**標籤；來源不存在時才退回呈現快照。

#### Scenario: 自子 session 跳回母 session

- **WHEN** folder B 的 session C 由 folder A 的 session P 交接而來，使用者觸發 C 的來源標示
- **THEN** rail 上選中的項目為 folder A，且 focused session 為 P

#### Scenario: 自母 session 跳到子 session

- **WHEN** 承上，使用者觸發 P 的子 session 標示並選取 C
- **THEN** rail 上選中的項目為 folder B，且 focused session 為 C

#### Scenario: 母 session 的標示只計存在的子 session

- **WHEN** P 交接出兩個 session，使用者關閉了其中一個
- **THEN** P 的標示所述的數量為一，且清單中只有另一個

#### Scenario: 來源為全域 session

- **WHEN** 全域 session G 交接一則工作至 folder B，建立 session C
- **THEN** C 的來源標示說出全域項目與 G 的標籤
- **AND** 觸發它時選中全域項目並聚焦 G

#### Scenario: 來源標示隨母 session 改名而更新

- **WHEN** 使用者把 P 重新命名
- **THEN** C 的來源標示呈現新的名稱

### Requirement: 母 session 不存在之後，子 session 仍說得出它的來源

來源 session 不存在時，子 session 的來源標示 SHALL 呈現快照，並 SHALL 標明來源已關閉；觸發它 SHALL
為無操作，SHALL NOT 重建來源 session，SHALL NOT 建立任何 session。

**關係 SHALL NOT 因母 session 不存在而被清除** —— 快照的存在理由就是讓使用者在母 session 不在
之後仍知道這件事從哪裡來。

#### Scenario: 母 session 關閉後子 session 呈現快照

- **WHEN** 使用者關閉 P，而 C 仍存在
- **THEN** C 的來源標示呈現 folder A 的名稱與 P 於攝入當下的標籤，並標明已關閉

#### Scenario: 觸發已關閉來源的標示不建立 session

- **GIVEN** 觸發一個存在的來源標示會改變 focused session（正向對照）
- **WHEN** 承「母 session 關閉後子 session 呈現快照」，使用者觸發 C 的來源標示
- **THEN** session 的總數不變，且 focused session 仍為 C

#### Scenario: 母 session 關閉後重新啟動，快照仍在

- **WHEN** 承上，應用程式重新啟動
- **THEN** C 的來源標示仍呈現該快照並標明已關閉

### Requirement: agent 隨時查得到它當下的母、子、兄弟 session

每個 agent session SHALL 能於它存活期間的任何時刻，取得它**當下**的關係：它有沒有母 session、
母 session 是否存在與是否在執行、它目前存在的子 session，以及它目前存在的**兄弟**（與它有同一個
母 session 的其他 session，不含它自己）；每一個對象 SHALL 附帶它的固定名字
（見 `agent-peer-name`）、所屬的 rail 項目名稱與標籤。

**子 session 與兄弟 session 另 SHALL 附帶它的生命週期狀態（見 `handoff-completion`：已完成、進行中、
等你，或不呈現狀態 —— 後者含休眠者），以及它最新的完成結果（若有）。** 生命週期狀態改變時 SHALL
視同關係改變，agent 下一次查詢即得到新的值。 這是結果抵達母 session 的補償路徑：子 session 完成時母 session 可能不在
執行中，或子 agent 送出的訊息可能被忽略 —— 母 session 的 agent 仍查得到結果，而系統不必經手訊息。

**自我介紹只在 agent 的脈絡被建立或重建時注入**，而母 session 的子 session 是在它啟動**之後**才
長出來的，兄弟亦然。關係 SHALL NOT 只經由自我介紹提供；關係改變時（子或兄弟 session 建立、任一方不再存在、
改名、進入或離開執行中）SHALL NOT 需要重建 agent 的脈絡，agent 下一次查詢即得到新的值。

**Each child SHALL also carry the sessions it handed off, and so on at every depth** (its descendants, see
"A session records its whole chain of ancestors"), as a tree under the children. Each descendant SHALL carry the
same fields as a child (fixed name, rail item, label, whether it is running, lifecycle state, latest result), so
an agent can find, address and act on a grandchild as it can a child (see `agent-session-control`).
A descendant whose direct parent no longer exists SHALL appear under its nearest ancestor that still exists, and
SHALL be marked as having lost its direct parent. Its own relations still show that parent as closed. The parent
and the siblings SHALL NOT carry descendants.

系統 SHALL NOT 在提供給 agent 的關係中放入任何路徑欄位或 spekterm 的 session 識別碼 —— agent 需要的
只有名字。

Relations SHALL always be provided to running claude sessions: handoff has no switch (removed
2026-09-30), so there is no state in which they are withdrawn.

**本能力不經手訊息本身。** 母子之間的訊息由 agent CLI 自身的訊息功能傳遞；本能力交付的是
「對方是誰、叫什麼名字、此刻收不收得到」。**休眠的 session 沒有行程，收不到訊息** —— 關係中
SHALL 標明它不在執行中，本能力 SHALL NOT 為此喚醒它。

#### Scenario: 母 session 於啟動之後查得到新長出的子 session

- **WHEN** session P 啟動之後投遞一則交接，因而建立了 session C，其間 P 的脈絡未被重建
- **THEN** P 此時查詢自己的關係，結果中含有 C 與 C 的固定名字

#### Scenario: 子 session 查得到母 session 的名字

- **WHEN** session C 由 session P 交接而來
- **THEN** C 查詢自己的關係，結果中的母 session 為 P，並附帶 P 的固定名字

#### Scenario: 不存在的子 session 自查詢結果中消失

- **WHEN** 承「母 session 於啟動之後查得到新長出的子 session」，使用者關閉 C
- **THEN** P 此時查詢自己的關係，結果中不含 C

#### Scenario: 兄弟查得到彼此

- **WHEN** session P 先後交接出 session C1 與 C2，其間 C1 的脈絡未被重建
- **THEN** C1 此時查詢自己的關係，結果的兄弟中含有 C2 與 C2 的固定名字
- **AND** C1 的兄弟中不含 C1 自己

#### Scenario: 不存在的兄弟自查詢結果中消失

- **WHEN** 承上，使用者關閉 C2
- **THEN** C1 此時查詢自己的關係，結果的兄弟中不含 C2

#### Scenario: 母 session 不存在之後兄弟仍互相查得到

- **WHEN** 承「兄弟查得到彼此」，使用者關閉 P
- **THEN** C1 此時查詢自己的關係，母 session 標明已關閉，且兄弟中仍含有 C2

#### Scenario: 休眠的母 session 標明不在執行中

- **WHEN** 應用程式重新啟動之後，C has been woken while its parent session P is still dormant
- **THEN** C 查詢自己的關係，結果標明 P 存在但不在執行中
- **AND** P 仍為休眠

#### Scenario: 關係中沒有路徑欄位

- **WHEN** 檢視提供給 agent 的關係內容，其中各對象所屬的 folder 皆位於 workspace 之內
- **THEN** 其中沒有任何表示路徑或 spekterm session 識別碼的欄位

#### Scenario: 母 session 查得到子 session 的狀態與結果

- **WHEN** session P 的子 session C 投遞了摘要為 S 的完成報告
- **THEN** P 此時查詢自己的關係，結果中 C 標明為已完成，並附帶 S

#### Scenario: 尚未完成的子 session 沒有結果

- **WHEN** P 的子 session C 尚未投遞任何完成報告
- **THEN** P 查詢自己的關係，結果中 C 標明其狀態，且沒有結果

#### Scenario: A grandparent sees its grandchild

- **WHEN** session P handed off to C, and C then handed off to G, while P's context was not rebuilt
- **THEN** P now queries its relations, and G appears under C, with G's fixed name, rail item, label, whether it
  is running, and its state

#### Scenario: A grandchild stays in the tree after the session between them closes

- **WHEN** continuing "A grandparent sees its grandchild", the user closes C
- **THEN** P's relations no longer contain C
- **AND** G appears directly under P, marked as having lost its direct parent

#### Scenario: Siblings carry no descendants

- **WHEN** P handed off to C1 and C2, and C2 handed off to G
- **THEN** C1's relations list C2 as a sibling, and G does not appear in C1's relations

### Requirement: 關係的標示文案來自字典

本能力新增的使用者可見文字（來源標示、子 session 標示與其數量、已關閉的註明、全域項目的名稱）
SHALL 來自字典並依使用者選擇的語言呈現；數量 SHALL 依該語言的複數類別。folder 名稱與 session
標籤是資料，SHALL 原樣呈現。**全域項目的名稱 SHALL NOT 以字面值存入快照**，而是於呈現時取自字典。

#### Scenario: 切換語言後標示文案隨之改變

- **WHEN** 使用者把介面語言切換為另一種受支援的語言
- **THEN** 來源標示與子 session 標示的文案以該語言呈現，而其中的 folder 名稱與 session 標籤不變

#### Scenario: 來源為全域 session 的快照以當下的語言呈現

- **WHEN** 子 session C 的來源為已關閉的全域 session，使用者切換介面語言
- **THEN** C 的來源標示中的全域項目名稱以新的語言呈現

### Requirement: 損毀的關係不使 session 從 rail 消失

持久化的內容不受信任，其中的來源可能形成環（兩個 session 互為對方的來源，或以自己為來源）。
環上的 session SHALL 仍呈現於 rail，SHALL NOT 因為「沒有一個是根」而靜默地不被呈現。

#### Scenario: 互為來源的兩個 session 仍被呈現

- **WHEN** 持久化檔案中 session A 的來源為 B、B 的來源為 A，應用程式啟動
- **THEN** A 與 B 皆呈現於 rail

### Requirement: A session records its whole chain of ancestors

A session created by a handoff SHALL record the whole chain of sessions above it: its parent, its parent's
parent, and so on. The chain SHALL be taken **when the handoff is received**, as the rest of the source's snapshot
is, not when the session is created later. It SHALL be recorded before the session's process starts. A session SHALL be a **descendant** of every
session in that chain. The chain SHALL survive the closing of any session in it: closing an intermediate session
SHALL NOT make its descendants strangers to the sessions above it.

For a session recorded before chains were kept, the chain SHALL be rebuilt from the records that still exist. A
link that was already broken by a closed intermediate session SHALL stay broken.

A chain that cannot be read SHALL be ignored without losing the rest of the session's lineage. A chain SHALL NOT
make a session disappear from the rail. The chain SHALL be bounded in length, and SHALL NOT loop.

The chain SHALL NOT appear in what is provided to agents: they see fixed names only. The rail's indentation and
its source and handoff marks SHALL be unchanged by the chain: they still show only the direct parent.

#### Scenario: The chain survives an app restart and an intermediate close

- **WHEN** P handed off to C, C handed off to G, the application restarts, and the user closes C
- **THEN** G is still a descendant of P

#### Scenario: A chain survives a late acceptance

- **WHEN** C, a child of P, hands off a piece of work that falls back to pending in the inbox, the user closes C, and
  the user then accepts the item, creating G
- **THEN** G is a descendant of P

#### Scenario: A chain recorded before this change is rebuilt from existing records

- **WHEN** the session list holds P, C and G, with C's and G's lineage naming only their direct parents
- **THEN** G is a descendant of P

#### Scenario: A broken chain does not remove a session

- **WHEN** a session's recorded chain of ancestors is unreadable in the session list
- **THEN** the session appears on the rail with its direct parent intact

#### Scenario: The rail shows only the direct parent

- **WHEN** P handed off to C, and C handed off to G, all three in the same folder
- **THEN** G is indented under C on the rail, not under P
