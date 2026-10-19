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

非由交接建立的 session SHALL NOT 被告知完成報告。

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

#### Scenario: 告知的長度上限與實際判定同源

- **WHEN** 實際生效的摘要長度上限被調整
- **THEN** 注入的內容所述的值隨之改變，無需另行編輯該段文字
