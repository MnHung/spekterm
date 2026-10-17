# handoff-completion Specification

## Purpose
交接出來的 session 有一個可見的生命週期（進行中、等你、已完成），完成由子 agent 自己宣告並附上結果，
結果呈現給使用者、查得到給母 session 的 agent，且已完成者可由使用者一次收掉。

## Requirements

### Requirement: 由交接建立的 session，其 agent 被告知如何宣告完成

由交接建立的 claude session（不論其母 session 此刻是否存在），系統 SHALL 於注入自我介紹時
（`agent-handoff-source`）另外告知：

- 完成母 session 或使用者交辦的一件事時，SHALL 投遞一份完成報告（格式與位置見下一條）；
- 完成報告之後，若母 session 在執行中，以 agent CLI 自身的訊息功能把同一份摘要送給母 session；
  母 session 不在執行中或已不存在時不送；
- 其後每完成一件後續要求，重複一次；
- 完成報告的**所有會使它被拒絕的約束**（含摘要的長度上限與不得為空）。

**自我介紹的每一個寫出點 SHALL 一致地包含或不包含這一段** —— 含 session 啟動時的寫出，以及
workspace 的 folder 清單變動時的重寫。後者若漏掉它，agent 的脈絡下一次被重建（續接、壓縮、清除）
之後就不再知道要寫報告，該 session 永遠停在「等你」，而沒有任何東西會失敗。

非由交接建立的 session SHALL NOT 被告知完成報告。

告知的約束 SHALL 與實際生效的判定同源，SHALL NOT 為另行撰寫的數字（理由同 `agent-handoff-source`
的自我介紹：投遞者沒有回饋管道，一個未被告知的約束就是一條死路）。

#### Scenario: 子 session 的自我介紹含完成報告的說明

- **WHEN** session C 由一則交接建立，檢視注入 C 的內容
- **THEN** 其中說明完成時要投遞完成報告、報告的格式與摘要的長度上限，以及要把摘要以訊息送給執行中的母 session

#### Scenario: folder 清單變動後重寫的自我介紹仍含完成報告的說明

- **WHEN** session C 由一則交接建立之後，使用者把一個 folder 加入 workspace
- **THEN** C 此時的自我介紹內容仍含完成報告的說明，且含新加入的 folder

#### Scenario: 沒有母 session 的 session 不被告知

- **WHEN** 使用者自己建立一個 claude session，檢視注入它的內容
- **THEN** 其中沒有完成報告的說明

#### Scenario: 告知的長度上限與實際判定同源

- **WHEN** 實際生效的摘要長度上限被調整
- **THEN** 注入的內容所述的值隨之改變，無需另行編輯該段文字

### Requirement: 完成報告經該 session 自己的投遞落點送達，來源由落點推導

完成報告 SHALL 經與交接**相同的投遞落點與寫入規矩**送達，並以一個明確的種類欄位與交接區分；
沒有種類欄位的投遞 SHALL 照舊視為交接。種類欄位為不認得的值 SHALL 被拒絕，且該次拒絕 SHALL 以
與交接失敗相同的方式對使用者可見。

報告屬於哪一個 session SHALL 由它落在哪一個落點推導，SHALL NOT 由報告內容自稱。查詢該 session
時 SHALL 涵蓋已建立而尚未被納入持久化清單的 session。

- 該 session **由交接建立**（不論母 session 此刻是否存在）⇒ 採納；
- 該 session 存在但**非由交接建立** ⇒ 拒絕，且對使用者可見；
- 該 session **已不存在** ⇒ 丟棄，SHALL NOT 呈現為拒絕（沒有可以掛上去的 session，而那不是
  投遞者的錯）。

摘要 SHALL 經與其他非第三方欄位相同的攝入正規化；正規化後為空者 SHALL 被拒絕；超過長度上限者
SHALL 被拒絕，SHALL NOT 被截斷後採納 —— 截斷後的摘要看起來是完整的，而它的結尾從未抵達。
以上拒絕皆 SHALL 對使用者可見。

完成報告 SHALL NOT 成為收件匣的待處理項目（它不是一件工作交辦，是既有 session 的狀態變化）。
同一個 session 後到的報告 SHALL 取代先前的報告。報告被採納後，其投遞檔 SHALL 被消費。
**同一份投遞檔 SHALL 只被採納一次**，即使它被讀取兩次。

#### Scenario: 子 session 投遞完成報告

- **WHEN** session C（由 P 交接而來）於自己的落點投遞一份摘要為 S 的完成報告
- **THEN** C 的最新結果為 S
- **AND** 收件匣中未出現新的項目

#### Scenario: 母 session 已關閉的子 session 仍可宣告完成

- **GIVEN** C 由 P 交接而來，使用者已關閉 P
- **WHEN** C 投遞一份完成報告
- **THEN** C 的狀態為已完成

#### Scenario: 沒有種類欄位的投遞仍是交接

- **WHEN** 一份未帶種類欄位、形狀為交接的投遞到達
- **THEN** 它照舊被當作交接處理

#### Scenario: 非由交接建立的 session 投遞報告被拒絕

- **WHEN** 一個使用者自己建立的 session 於自己的落點投遞一份完成報告
- **THEN** 沒有任何 session 的結果因此改變
- **AND** 該次拒絕以通知與收件匣中的痕跡兩者呈現

#### Scenario: 已不存在的 session 的報告被靜默丟棄

- **WHEN** 使用者關閉 C 時，C 的落點中留有一份完成報告
- **THEN** 收件匣中沒有因它而生的拒絕痕跡

#### Scenario: 摘要過長被拒絕而非截斷

- **WHEN** C 投遞一份摘要超過上限的完成報告
- **THEN** C 的最新結果不變
- **AND** 該次拒絕以通知與收件匣中的痕跡兩者呈現

#### Scenario: 空白摘要被拒絕

- **WHEN** C 投遞一份摘要只含空白的完成報告
- **THEN** C 的最新結果不變，且該次拒絕對使用者可見

#### Scenario: 後到的報告取代先前的

- **WHEN** C 先後投遞摘要為 S1 與 S2 的兩份完成報告
- **THEN** C 的最新結果為 S2

### Requirement: 交接 session 的狀態由完成報告與等待狀態推導，且完成之後可重新開始

由交接建立的 session SHALL 依下列規則呈現狀態：

- **已完成**：已採納完成報告，且其後未重新開始；
- **進行中**：沒有完成報告、或已重新開始，且等待狀態為忙碌；
- **等你**：沒有完成報告、或已重新開始，且等待狀態為等待選擇，或等待狀態為就緒且其最近一次的一輪結束尚未被
  看過（`session-wait-indicator` 的看過標記）；
- **不呈現狀態**：沒有完成報告、或已重新開始，且等待狀態為未知（含休眠與已結束的 session ——
  它們照舊呈現既有的休眠或結束狀態），或等待狀態為就緒且已被看過。

The "waiting" state follows the seen mark so that "Waiting for you" means one thing across the application: the
session's status dot (`session-wait-indicator`) and this state say it at the same moments, and both stop saying it
once the user has looked at the session. Without that, a child the user has already read would keep a "Waiting for
you" mark beside an idle dot.

**完成的落定 SHALL 依「報告被採納之後」某一次等待狀態結算的值為就緒，SHALL NOT 依「狀態轉變為
就緒」。** 報告與等待狀態經兩條互不排序的通道抵達；agent 停下之後報告才被採納時，狀態不會再
「轉變為」就緒 —— 依轉變判定的話，它永遠不會落定。落定與重新開始依等待狀態本身判定，SHALL NOT 受看過標記影響。

**重新開始 SHALL 只在落定之後，某一次等待狀態結算的值為忙碌或等待選擇時發生。** agent 寫完報告
通常還會做事（例如把結果以訊息送給母 session），若報告之後的第一次忙碌即算重新開始，每一份報告都會
被它自己的收尾推翻。

等待狀態為**未知** SHALL NOT 觸發落定或重新開始。

重新開始 SHALL NOT 刪除先前的結果 —— 它仍可於交接單中取得，直到被下一份報告取代。

「已完成」「已落定」「已重新開始」SHALL 跨應用程式重啟保留。系統 SHALL NOT 因任何狀態自動結束
session 的 pty。

#### Scenario: 報告之後的收尾不推翻完成

- **WHEN** C 投遞完成報告，隨後等待狀態成為忙碌、再成為就緒
- **THEN** C 的狀態為已完成

#### Scenario: 報告於 agent 已停下之後才被採納

- **GIVEN** C 的等待狀態已為就緒
- **WHEN** C 先前寫下的完成報告此時才被採納，其後 C 的等待狀態成為忙碌
- **THEN** C 的狀態為進行中

#### Scenario: 完成之後再被交辦即重新開始

- **GIVEN** C 已完成，且報告被採納之後等待狀態已結算為就緒
- **WHEN** C 的等待狀態成為忙碌
- **THEN** C 的狀態為進行中
- **AND** C 的交接單仍呈現先前的結果

#### Scenario: 等待狀態落回未知不重新開始

- **GIVEN** C 已完成，且報告之後等待狀態已結算為就緒
- **WHEN** C 的等待狀態落回未知
- **THEN** C 的狀態仍為已完成

#### Scenario: 沒有報告時依等待狀態呈現

- **WHEN** C 尚未投遞任何報告，且等待狀態為就緒，且其一輪結束尚未被看過
- **THEN** C 的狀態為等你

#### Scenario: Looking at a child without a report clears its waiting state

- **WHEN** C has not delivered a report, its turn ended unseen so its state is waiting, and the user makes C the
  displayed session in the focused window
- **THEN** C presents none of working, waiting or done, and C's parent lists C with no state

#### Scenario: 等待狀態未知且沒有報告時不呈現狀態

- **WHEN** C 尚未投遞任何報告，且等待狀態為未知
- **THEN** C 不呈現進行中、等你或已完成任一者

#### Scenario: 已完成跨重啟保留

- **GIVEN** C 已完成
- **WHEN** 應用程式重新啟動
- **THEN** C 的狀態仍為已完成

#### Scenario: 完成不結束 pty

- **WHEN** C 成為已完成
- **THEN** C 的 pty 仍然存在

### Requirement: 狀態呈現於母子兩端

子 session 的狀態 SHALL 呈現於 rail 上它的子列與主舞台上它的分頁。母 session 的子 session 標示所
列出的每一個子 session SHALL 附帶其狀態；**全部**子 session 皆已完成時，母 session 的子 session
標示本身 SHALL 以可區分的樣式呈現。

狀態的文案 SHALL 來自字典。

#### Scenario: 子列呈現狀態

- **WHEN** C 為已完成
- **THEN** rail 上 C 的子列與 C 的分頁皆呈現已完成的標示

#### Scenario: 母 session 的清單附帶子 session 的狀態

- **WHEN** P 有兩個子 session，一個已完成、一個進行中，使用者觸發 P 的子 session 標示
- **THEN** 清單中兩者各自呈現其狀態

#### Scenario: 全部完成時母 session 的標示改變樣式

- **WHEN** P 的所有子 session 皆為已完成
- **THEN** P 的子 session 標示以與「尚有未完成」不同的樣式呈現

### Requirement: 完成報告被採納時發出作業系統通知，觸發它帶使用者去看結果

完成報告被採納時，系統 SHALL 發出一則作業系統通知，說出**哪一件交接**（交接的標題）完成了，以及
**結果的摘要**。報告被存下來而使用者不被告知的話，結果只查得到、不會被看到 —— 使用者大多時候不盯著 rail。

- 通知 SHALL 與收件匣的通知**共用同一個合併窗與同一組數量上界**（`agent-intake` 的「新項目到達時發出
  作業系統通知，且合併與總量皆有界」）—— 兩條通道各自有界等於兩倍。
- 通知的標題 SHALL 為系統文案；交接標題與摘要進入內文之前 SHALL 經與收件匣通知相同的**縮減**
  （`agent-intake` 的「通知的內文取自已正規化的值，且第三方欄位進入它之前先行縮減」）—— 摘要由 agent
  撰寫，而 agent 可能被它讀過的東西塑形。
- **同一份投遞檔被讀兩次只通知一次**（與只採納一次同一個判定）；應用程式重新啟動 SHALL NOT 對既有的
  已完成狀態重新通知 —— 通知綁定於報告的**採納**，不綁定於「目前是已完成」。
- 觸發一則**只涵蓋這一份報告**的通知 SHALL 把視窗帶到前景、選中該子 session 所屬的 rail 項目並聚焦它，
  並打開它的交接單（結果就在那裡）。該 session 已不存在時 SHALL 為無操作。合併的通知依既有規則打開收件匣。

#### Scenario: 報告被採納時發出通知

- **WHEN** 交接標題為 T 的子 session 投遞一份摘要為 S 的完成報告
- **THEN** 系統發出一則通知，其內文含 T 與 S（經縮減）

#### Scenario: 摘要中的網址不進入通知

- **WHEN** 完成報告的摘要含一個網址
- **THEN** 通知的內文不含該網址

#### Scenario: 同一份報告不重複通知

- **WHEN** 同一份完成報告的投遞檔被讀取兩次
- **THEN** 系統只發出一則通知

#### Scenario: 觸發通知帶使用者去看結果

- **GIVEN** 使用者的焦點在另一個 folder
- **WHEN** 使用者觸發一則只涵蓋一份完成報告的通知
- **THEN** rail 上選中的是該子 session 所屬的項目，focused session 為該子 session
- **AND** 該子 session 的交接單對話框已打開，呈現那份結果

#### Scenario: 重新啟動不重新通知

- **GIVEN** 某個子 session 已完成且其通知已發出
- **WHEN** 應用程式重新啟動
- **THEN** 系統未因該 session 的已完成狀態發出任何通知

### Requirement: 結果由子 agent 送回母 session，系統不代為傳遞

系統 SHALL NOT 把完成報告寫入母 session 的 pty 或以任何方式送進母 session 的 agent 輸入。
結果抵達母 session 的 agent 只經由兩條路徑：子 agent 以 agent CLI 自身的訊息功能送出，以及母
session 的 agent 查詢自己的關係（見 `session-lineage`）。

後者是前者的補償：母 session 在子 session 完成時可能不在執行中，或訊息可能被忽略。

#### Scenario: 報告到達時母 session 的終端未被寫入

- **WHEN** C 投遞完成報告，其母 session P 在執行中
- **THEN** 系統送往 P 的內容為空

### Requirement: 使用者可一次收掉已完成的交接 session

系統 SHALL 提供兩個收掉已完成交接 session 的動作：

1. **母 session 的子 session 清單中**：收掉該母 session 的所有已完成子 session；
2. **全域**：收掉 workspace 中所有已完成的交接 session。只在至少有一個已完成的交接 session 時
   呈現。

兩者 SHALL 先呈現確認對話框，列出將被關閉的 session（標籤、所屬 rail 項目、最新結果）。
**確認時關閉的 SHALL 為「對話框列出的」且「確認當下仍為已完成的」session** —— 對話框開啟期間
重新開始的 SHALL NOT 被關閉；開啟期間才成為已完成、未被列出的 SHALL NOT 被關閉。關閉 SHALL 與
使用者逐一關閉該 session 的效果相同。

系統 SHALL NOT 在使用者確認之外關閉任何 session。

#### Scenario: 從母 session 收掉已完成的子 session

- **GIVEN** P 有三個子 session，其中兩個已完成
- **WHEN** 使用者自 P 的子 session 清單觸發「收掉已完成」並確認
- **THEN** 那兩個 session 不再存在
- **AND** 第三個仍然存在

#### Scenario: 全域收掉跨 folder 的已完成 session

- **GIVEN** folder A 與 folder B 各有一個已完成的交接 session，且各有一個進行中的
- **WHEN** 使用者觸發全域的「收掉已完成」並確認
- **THEN** 兩個已完成的 session 不再存在，兩個進行中的仍然存在

#### Scenario: 確認前重新開始的 session 不被關閉

- **GIVEN** 使用者已開啟收掉已完成的確認對話框，其中列出 C
- **WHEN** C 於確認之前重新開始，使用者隨後確認
- **THEN** C 仍然存在

#### Scenario: 對話框開啟期間才完成的 session 不被關閉

- **GIVEN** 使用者已開啟收掉已完成的確認對話框，其中未列出 D
- **WHEN** D 於確認之前成為已完成，使用者隨後確認
- **THEN** D 仍然存在

#### Scenario: 確認對話框列出各自的結果

- **WHEN** 使用者開啟收掉已完成的確認對話框
- **THEN** 對話框中每一個將被關閉的 session 附帶它的最新結果

#### Scenario: 有已完成的 session 時全域入口呈現

- **WHEN** workspace 中至少有一個已完成的交接 session
- **THEN** 全域的收掉已完成入口呈現

#### Scenario: 沒有已完成的 session 時全域入口不呈現

- **WHEN** workspace 中沒有已完成的交接 session
- **THEN** 全域的收掉已完成入口不呈現

#### Scenario: 取消確認不關閉任何 session

- **WHEN** 使用者開啟確認對話框後取消
- **THEN** session 的總數不變
