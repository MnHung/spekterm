# intake-routing Specification

## Purpose
決定一則 intake 該在哪個 workspace folder 被處理：一組使用者可編輯的有序規則，比對 intake 的
通用欄位，得出一個 folder；解析不出來時**拒絕並說明**，而不是靜默開在某個地方。

## Requirements

### Requirement: routing 為使用者可編輯的有序規則，第一個命中者勝出

系統 SHALL 以一組**有序規則**把一則 intake 解析為一個 folder。規則 SHALL 依序比對，
**第一個命中的規則勝出**，其後的規則不再參與。

規則 SHALL 為**資料**：使用者 SHALL 能新增、修改、刪除與調整順序，SHALL NOT 需要修改程式碼或
重新安裝應用程式。

規則的判準 SHALL 限於 intake 的通用欄位，SHALL NOT 能以來源專屬的原始內容為判準。

**本條的作用域為「目標尚未被解析」的 intake。** 一則帶著接收端已解析出的目標 folder 的 intake
不比對規則（見下一條）—— 規則是**使用者**用來決定一件事該在哪裡處理的工具，而那種 intake 的
目標是使用者自己指名的。

#### Scenario: 第一個命中的規則勝出

- **WHEN** 三條規則分別指向三個不同的 folder，一則 intake 同時符合第二條與第三條
- **THEN** 解析結果為**第二個** folder

#### Scenario: 把規則往後移改變結果，且結果是絕對的

- **WHEN** 承上，使用者把**第二條規則移到第三條之後**
- **THEN** 同一則 intake 的解析結果為**第三條原本所指向的那個** folder

#### Scenario: 依來源座標識別碼解析

- **WHEN** 一則 intake 的來源座標識別碼符合某條規則，而其標題不符合任何規則
- **THEN** 解析結果為該規則指向的 folder

### Requirement: 以第三方撰寫的欄位為判準的規則須標示其可被操縱

規則的判準若為 intake 中**第三方逐字撰寫**的欄位（標題、本文、發起者、來源座標的標籤），
編輯介面 SHALL 標示該判準**可被投遞者操縱**。以**接收端可驗證**的欄位（來源種類、來源座標的
識別碼）為判準的規則 SHALL NOT 被如此標示。

以第三方撰寫的欄位決定開在哪個 repo，等同讓投遞者選擇他的 intake 會落在哪個工作目錄 ——
而他會選擇許可姿態最寬鬆的那一個。**這件事無法以驗證化解**（那些欄位本來就該是自由文字），
只能讓使用者在建立規則的當下知道他在交出什麼。

#### Scenario: 兩種判準的標示不同

- **WHEN** 使用者建立一條以標題為判準的規則與一條以來源座標識別碼為判準的規則
- **THEN** 前者被標示為可被投遞者操縱
- **AND** 後者未被如此標示

### Requirement: 有一條 fallback，且它是規則而非內建行為

系統 SHALL 支援一條 **fallback**：沒有任何規則命中時採用的 folder。

fallback SHALL 由使用者設定，SHALL NOT 為系統內建的某個 folder（例如清單中的第一個或當下
選中的那一個）—— 內建的選擇會讓使用者在毫不知情的情況下得到一個看似正確的結果。

#### Scenario: 規則存在但都不命中時採用 fallback

- **WHEN** 存在一條**指向 A 且刻意不命中**的規則，fallback 指向 B，且 A ≠ B
- **THEN** 解析結果為 **B**

#### Scenario: 一條規則都沒有時採用 fallback

- **WHEN** 規則清單為空，只設定了 fallback
- **THEN** 解析結果為 fallback 指向的 folder

### Requirement: 解析不出 folder 時拒絕並說明，不靜默退回

沒有任何規則命中且未設定 fallback 時，系統 SHALL 拒絕解析並**說明原因**，
SHALL NOT 退回任何預設的 folder。

**命中的規則所指向的 folder 已不在 workspace 中時，SHALL 同樣拒絕**，SHALL NOT 視為「未命中」
而繼續往下比對或落到 fallback —— 使用者明確指定的目標不可用時，正確的處置是告訴他，而不是
悄悄換一個地方。

**拒絕解析的呈現是「沒有被預先選定的 folder」**：該則 intake SHALL NOT 預先選定任何 folder，
且在使用者明確選定一個之前 SHALL NOT 能被接受（見「接受時由使用者確認目標 folder，系統不替他
補預設值」）。使用者的明確選定不是退回 —— 退回是系統替他挑，而這裡是他自己挑。

**理由與工作目錄識別碼查無對應時的處置同源**：靜默退回會讓一個 session 開在使用者以為的地方
以外，而他不會知道。

#### Scenario: 無規則亦無 fallback 時拒絕

- **WHEN** 一則待處理的 intake 不符合任何規則，且未設定 fallback
- **THEN** 該則 intake 沒有被預先選定的 folder，且系統說明無法解析出 folder

#### Scenario: 指向的 folder 已被移出 workspace 時拒絕，即使 fallback 可用

- **WHEN** 命中規則所指向的 folder 已不在 workspace 中，**而 fallback 已設定且指向一個可用的
  folder**
- **THEN** 該則 intake 沒有被預先選定的 folder，且系統說明該 folder 不再可用
- **AND** 被預先選定的不是 fallback 指向的 folder

#### Scenario: 解析失敗時嘗試接受不建立任何 session

- **WHEN** 解析失敗，使用者**未選定任何 folder** 而嘗試接受該則 intake
- **THEN** session 的總數與嘗試之前相同
- **AND** 該則 intake 仍為待處理

### Requirement: 使用者在接受之前看得到將開在哪個 folder

系統 SHALL 於一則待處理的 intake 上呈現它**目前被選定的 folder** —— 使用者尚未改選時即為
解析結果 —— 且該呈現 SHALL 在使用者接受它之前即可見。解析不出且使用者尚未選定時，
SHALL 呈現原因，且 SHALL NOT 呈現任何被選定的 folder。

**判準是被選定的那一個，不是可供改選的清單。** 可供改選的 folder 名稱同時出現在畫面上，
那不構成「呈現將開在哪個 folder」—— 以整塊區域是否含某個名稱來判定，其真假取決於清單的排列
順序，與使用者讀到的東西無關。

被選定的 folder SHALL 以它在 rail 上的名稱呈現，SHALL NOT 以識別碼呈現。

規則命中錯誤的代價是 session 開在錯的 repo；在按下去之前就看得到結果，使用者才有機會發現。

#### Scenario: 可解析與不可解析的兩則同時呈現

- **WHEN** 收件匣中有一則可解析與一則不可解析的待處理 intake
- **THEN** 前者被選定的 folder 為其解析結果，並以該 folder 的名稱呈現
- **AND** 後者呈現無法解析的原因，且沒有任何被選定的 folder

### Requirement: 規則落於本能力自己的持久化位置，與使用者偏好分離

規則與 fallback SHALL 跨應用程式重啟保留，且 SHALL 落於**本能力自己的持久化位置**，
SHALL NOT 與終端偏好共用同一份檔案或同一個物件。

既有的偏好檔案，其寫入路徑會從空物件重建其內容、且整份檔案於每次儲存時被重新產生 ——
任何寄居其中的欄位都倚賴每一個寫入者記得保留它。規則被那條路徑丟棄時，**fallback 可能仍在**
（或反之），於是其後每一則 intake 都靜默地改道，**而介面上呈現的解析結果是誠實的** ——
它報的就是那個錯誤的結果。使用者調整一次字型，收件匣就改了道。

The rules editor SHALL be in the inbox, not in Settings. Settings is now the application's place for settings
(see `terminal-preferences`), but the rules are not a knob of the application. They decide where each item in
the inbox opens, and the user reads them together with those items. The inbox SHALL offer the editor as a view
of its own, and Settings MAY offer a control that opens it (see `slack-intake-source`).

持久化的內容 SHALL 以白名單判定：形狀不合的單條規則 SHALL 被忽略，SHALL NOT 使其餘規則失效。

#### Scenario: 經編輯介面建立的規則跨重啟保留

- **WHEN** 使用者**經編輯介面**新增一條規則，應用程式其後重新啟動
- **THEN** 該規則仍然生效

#### Scenario: 變更終端偏好不影響規則

- **WHEN** 規則與 fallback 皆已設定，使用者其後變更終端字型設定
- **THEN** 規則與 fallback 皆未改變

#### Scenario: 形狀不合的規則被忽略而非使其餘失效

- **WHEN** 持久化的內容中有一條欄位型別不合的規則與數條合法規則
- **THEN** 合法的規則照常生效

#### Scenario: The rules editor is in the inbox

- **WHEN** the user opens the inbox
- **THEN** it offers the routing rules editor, and Settings has no rules editor of its own

### Requirement: 帶著接收端已解析目標的 intake 不比對規則，且其目標不可用時仍然拒絕

一則 intake 帶有**接收端已解析出的目標 folder** 時，系統 SHALL 以該 folder 為解析結果，
SHALL NOT 比對任何規則、SHALL NOT 落到 fallback。

該目標 **SHALL NOT 能由投遞內容表達**（見 `agent-intake`）—— 否則放進共用投遞落點的任何檔案
都能繞過規則自選 folder。

**該 folder 已不在 workspace 中時 SHALL 拒絕並說明**，SHALL NOT 改為比對規則、SHALL NOT 落到
fallback。理由與「命中規則所指向的 folder 已不在 workspace」完全相同：使用者明確指定的目標
不可用時，正確的處置是告訴他，而不是悄悄換一個地方。

**本條約束的是解析，不是使用者。** 該則 intake 若為待處理，使用者於接受之前的改選不在本條
作用域內（見「接受時由使用者確認目標 folder，系統不替他補預設值」）。

#### Scenario: 已解析目標者不受規則影響

- **WHEN** 一則 intake 帶著已解析的目標 folder A，而存在一條會命中它並指向 folder B 的規則
- **THEN** 解析結果為 **A**

#### Scenario: 已解析目標者不落到 fallback

- **WHEN** 一則 intake 帶著已解析的目標 folder A，且沒有任何規則命中它，fallback 指向 B
- **THEN** 解析結果為 **A**

#### Scenario: 已解析的目標已被移出 workspace 時拒絕，即使 fallback 可用

- **WHEN** 一則 intake 帶著已解析的目標 folder A，而 A 已不在 workspace 中，**且 fallback 已設定
  並指向一個可用的 folder**
- **THEN** 解析結果為拒絕，且系統說明該 folder 不再可用
- **AND** 被預先選定的不是 fallback 指向的 folder
- **AND** 在使用者明確選定一個 folder 之前，不建立任何 session

### Requirement: 接受時由使用者確認目標 folder，系統不替他補預設值

系統 SHALL 讓使用者在接受一則待處理的 intake **之前**，從 workspace 的 folder 中確認或改選它
將開在哪一個。routing 的解析結果 SHALL 只決定**預先選定哪一個**，SHALL NOT 決定接受的結果。

- 解析出 folder 的項目 SHALL 預先選定該 folder；使用者 SHALL 能改選 workspace 中的任何一個
  folder。
- 解析不出 folder 的項目 SHALL NOT 預先選定任何 folder；在使用者**明確選定**一個之前，
  該則 SHALL NOT 能被接受。
- 接受時 session SHALL 建立於使用者確認的 folder。一次接受**未指明**使用者確認的 folder 時，
  系統 SHALL 拒絕，SHALL NOT 以解析結果、fallback 或任何其他 folder 代替 —— 否則「使用者沒選」
  與「使用者選了解析結果」無從區分，解析不出 folder 的項目就多了一條不經使用者的預設路徑。
- 使用者確認的 folder 於接受時已不在 workspace 中時，系統 SHALL 拒絕並說明，SHALL NOT 建立
  session，SHALL NOT 改用其他 folder。
- 使用者的改選 SHALL NOT 改變規則或 fallback，且 SHALL NOT 延續到其他 intake。
- 預先選定的 folder SHALL 依序取下列第一個**仍在 workspace 中**的：使用者於本次打開收件匣
  之後的改選；**該則已建立過、而且仍存在的 session 所在的 folder**；解析結果。
  少了第二項，一則在 B 建過 session、預填逾時而退回待處理的 intake，重新打開收件匣之後會預選回
  解析結果 A —— 使用者未留意就按下接受，本文便送進他先前明確改掉的 repo。
- 使用者的改選 SHALL 在收件匣保持打開的期間保留，**包括切換收件匣內的分頁與經由其規則編輯
  入口修改規則**；規則或 fallback 的變動 SHALL NOT 覆蓋它。尚未改選者，其預先選定 SHALL 反映
  當下的解析結果。
- 本條適用於**所有**待處理項目，包括帶著接收端已解析目標的 intake（例如預填逾時而退回待處理
  的交接）—— 「已解析目標者不比對規則」約束的是**規則**，不是使用者。

規則只看得到 intake 的通用欄位；讀過本文的人才知道這件事該在哪裡處理，而那個人就在按下接受
的那一刻。**這不構成靜默退回**：做決定的是使用者，而且是在他看得到本文與目標的情況下。

#### Scenario: 改選之後 session 建立於改選的 folder

- **WHEN** 一則 intake 的 routing 解析到 folder A，使用者於接受之前改選 folder B（A ≠ B）並接受
- **THEN** 新的 agent session 建立於 **B**
- **AND** A 的 session 數與接受之前相同

#### Scenario: 解析不出者在選定之前無法接受

- **WHEN** 一則 intake 解析不出任何 folder，使用者未選定任何 folder 而嘗試接受
- **THEN** session 的總數與嘗試之前相同
- **AND** 該則 intake 仍為待處理

#### Scenario: 解析不出者在明確選定之後可接受

- **WHEN** 一則 intake 解析不出任何 folder，使用者明確選定 folder B 並接受
- **THEN** 新的 agent session 建立於 **B**

#### Scenario: 未指明確認的 folder 的接受被拒絕，即使解析得出

- **WHEN** 一次接受未指明使用者確認的 folder，而該則 intake 的 routing 解析得出 folder A
- **THEN** 系統拒絕該次接受
- **AND** session 的總數與之前相同，且該則 intake 仍為待處理

#### Scenario: 確認的 folder 於接受時已不在 workspace 時拒絕

- **WHEN** 使用者選定 folder B，B 於接受之前被移出 workspace，使用者其後接受
- **THEN** 系統說明該 folder 不再可用
- **AND** session 的總數與接受之前相同，且該則 intake 仍為待處理

#### Scenario: 改選不改變規則，也不延續到其他 intake

- **WHEN** 兩則 intake 的 routing 都解析到 folder A，使用者把其中一則改選為 B 並接受
- **THEN** 規則與 fallback 與改選之前相同
- **AND** 另一則預先選定的仍為 A

#### Scenario: 改選之後規則的變動不覆蓋使用者的選擇

- **WHEN** 使用者把一則待處理 intake 改選為 folder B，其後切到收件匣的規則編輯入口、修改規則
  使它解析到 folder C，再切回收件匣
- **THEN** 該則被選定的仍為 **B**

#### Scenario: 尚未改選者的預選隨規則變動

- **WHEN** 一則待處理 intake 未被改選，使用者修改規則使它的解析結果由 A 變為 C
- **THEN** 該則被選定的為 **C**

#### Scenario: 預填逾時退回者預選既有 session 所在的 folder

- **GIVEN** 一則 intake 的 routing 解析到 folder A，使用者改選 folder B 並接受，其預填逾時而
  退回待處理，B 中的那個 session 仍然存在
- **WHEN** 使用者再次打開收件匣
- **THEN** 該則被選定的為 **B**

#### Scenario: 帶著已解析目標者同樣可改選

- **WHEN** 一則帶著已解析目標 folder A 的 intake 為待處理，使用者改選 folder B 並接受
- **THEN** 新的 agent session 建立於 **B**
