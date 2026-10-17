## MODIFIED Requirements

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
