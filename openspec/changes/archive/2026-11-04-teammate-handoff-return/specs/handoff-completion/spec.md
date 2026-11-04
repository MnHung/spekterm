## MODIFIED Requirements

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

**A session opened from a teammate's handoff** (`teammate-handoff-return`, linked before it starts) SHALL be told
too, with a variant: the same format and constraints; no mention of a parent session; instead of the message to a
parent session, that each report is sent to the teammate who handed the work over, through the team server, and is
the only thing they receive from the session; and, since the teammate cannot see this machine's files, that details
go where the teammate can reach them (a pushed branch, a pull request, an issue) rather than in a local file. A
session whose teammate's handoff could not be reported on when the session was linked (`teammate-handoff-return`)
SHALL NOT be told, and once reporting for it has stopped or it was declined, the introduction written afterwards
SHALL NOT tell it either. The variant SHALL NOT be longer than the paragraph for a session created by a handoff, and every
write point of the introduction SHALL include it for such a session as consistently as the other.

非由交接建立的 session（且非由隊友的交接開啟者）SHALL NOT 被告知完成報告。

告知的約束 SHALL 與實際生效的判定同源，SHALL NOT 為另行撰寫的數字（理由同 `agent-handoff-source`
的自我介紹：the receipt reports a refusal only after the fact, so an unstated constraint still costs a refused report）。

#### Scenario: 子 session 的自我介紹含完成報告的說明

- **WHEN** session C 由一則交接建立，檢視注入 C 的內容
- **THEN** 其中說明完成時要投遞完成報告、報告的格式與摘要的長度上限，以及要把摘要以訊息送給執行中的母 session

#### Scenario: folder 清單變動後重寫的自我介紹仍含完成報告的說明

- **WHEN** session C 由一則交接建立之後，使用者把一個 folder 加入 workspace
- **THEN** C 此時的自我介紹內容仍含完成報告的說明，且含新加入的 folder

#### Scenario: 沒有母 session 的 session 不被告知

- **WHEN** 使用者自己建立一個 claude session，檢視注入它的內容
- **THEN** 其中沒有完成報告的說明

#### Scenario: A session opened from a teammate's handoff is told its report goes to the teammate

- **WHEN** the user accepts a teammate's handoff and its session starts, and the injected content is examined
- **THEN** it explains the completion report, its format and the summary's limit, and says the report is sent to
  the teammate
- **AND** it does not tell the agent to send the summary to a parent session

#### Scenario: The teammate variant is not longer

- **WHEN** the introduction of a session opened from a teammate's handoff and of a session created by a handoff are
  composed for the same workspace
- **THEN** the first is not longer than the second

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
- the session was **opened from a teammate's handoff** (`teammate-handoff-return`) ⇒ adopted and reported to the
  team server as `done` for that handoff; its summary SHALL additionally be made well-formed UTF-16 before its
  length is checked. Once reporting for that handoff has stopped, or after it was declined, the report SHALL be
  refused with a reason saying so, visibly to the user, and SHALL NOT be sent. Such a report SHALL NOT set the
  lifecycle state of this capability (the session has no parent to show it to);
- 該 session 存在但**非由交接建立**（且非由隊友的交接開啟） ⇒ 拒絕，且對使用者可見；
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

#### Scenario: A session opened from a teammate's handoff delivers a report

- **WHEN** session T, opened from a teammate's handoff, delivers a report with summary S in its own drop point
- **THEN** the report's receipt is `accepted` and `done` with S is sent for that handoff
- **AND** no new inbox item appears

#### Scenario: A report after reporting stopped is refused

- **WHEN** reporting for T's handoff has stopped and T delivers another report
- **THEN** the report is refused, its receipt says reporting has stopped, and nothing is sent

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
- **A session opened from a teammate's handoff** (`teammate-handoff-return`) has no handoff sheet: activating a
  notification covering only its report SHALL bring the window forward, select its rail item and focus it, without
  opening a sheet. Its report SHALL be notified like any other adopted report; the title named is the teammate
  handoff's title.

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

#### Scenario: A teammate handoff's report notifies and focuses its session

- **GIVEN** the user's focus is in another folder
- **WHEN** session T, opened from a teammate's handoff titled H, delivers a report with summary S, and the user
  activates the notification
- **THEN** the notification's text contained H and S (reduced), and T is the focused session
- **AND** no handoff sheet dialog is open

#### Scenario: 重新啟動不重新通知

- **GIVEN** 某個子 session 已完成且其通知已發出
- **WHEN** 應用程式重新啟動
- **THEN** 系統未因該 session 的已完成狀態發出任何通知
