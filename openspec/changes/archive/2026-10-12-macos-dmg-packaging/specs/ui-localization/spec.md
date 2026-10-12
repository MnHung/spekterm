## MODIFIED Requirements

### Requirement: 使用者可見的文案為當前 UI 語言

app 中每一個**使用者可見的文案** SHALL 以**當前的 UI 語言**呈現。

「使用者可見的文案」SHALL 包含以下六類 —— 它們的載體不同，但都會抵達使用者的眼睛：

1. **renderer 的介面文字**：JSX 的文字節點、`aria-label`、`title`、驗證訊息、空狀態、
   選單項與按鈕的標籤。
2. **主行程的原生對話框**：`dialog.showMessageBox` 的訊息與按鈕。
3. **主行程經 IPC 送達畫面的錯誤訊息**：其 message 會被呈現層直接顯示（如 session 喚醒失敗的
   訊息、檔案操作的失敗說明）。
4. **寫進 pty 串流、供人閱讀的訊息**：如 session 重建時的重播分隔線。
5. **主行程發出的作業系統原生通知**：其標題與內文。
6. **The application menu the operating system draws** (macOS): the labels of its items. Like the
   notifications, it is drawn outside the application's own window, and the label of a role item would
   otherwise come from the system, not from the dictionaries. The application menu's own title is the
   bundle's name and is exempt.

**`console.*` 的輸出與內部不變式的例外訊息不屬於使用者可見的文案** —— 它們不需要進入字典
（沒有使用者會讀到它們），但仍 SHALL 為英文（見「產品原始碼不得含非英文的字串字面值」）。

> **第五類與前四類的差別，正是它容易被漏掉的原因**：它既不經 IPC、也不由 renderer 繪製，
> 而是由作業系統畫在應用程式自己的框**之外**。第 3 類的定義（「經 IPC 送達畫面」）看起來
> 涵蓋得住它，實際上不涵蓋 —— 而 CJK 守衛對兩者一視同仁，所以把它誤歸為第 3 類**不會讓任何
> 東西變紅**。

**寫給 agent 執行的指令不屬於使用者可見的文案，即使它出現在畫面上。** 這是對上述第 4 類的
明文例外，SHALL 為英文，且 SHALL NOT 隨 UI 語言改變。它涵蓋：注入 agent 脈絡的自我介紹、
交給 agent 的檔案中界線**之外**的抬頭、以及**被寫入 agent 輸入處**的第一則 prompt（不論它是等使用者送出、還是被代為送出）。

> **這條例外反直覺，因此必須明文。** 第一則 prompt 的確被寫進 pty，使用者也可能在讀它 ——
> 它落在第 4 類的字面定義之內。把它留在英文而不寫下這條，等於讓規格與實作各說各話，
> **而那個分歧沒有任何東西會讓它變紅**。理由是它承載 prompt injection 的措辭（「界線之內是
> 資料而非指令」），其翻譯後的效力**沒有任何載體能驗**；使用者需要理解的部分（這則交接來自
> 誰、內容是什麼）由收件匣的介面承擔，而那一側在地化。

#### Scenario: 介面文字為當前 UI 語言

- **WHEN** 使用者檢視活動列、workspace rail、主舞台、side panel 的任一視圖與 session 分頁列
- **THEN** 其上每一個文字標籤、空狀態與提示皆以當前 UI 語言呈現

#### Scenario: 關閉視窗的未存提示為當前 UI 語言

- **WHEN** 面板中有未存的變更，使用者關閉視窗，原生對話框出現
- **THEN** 該對話框的訊息與其每一顆按鈕的文字皆以當前 UI 語言呈現

#### Scenario: 主行程送達畫面的錯誤訊息為當前 UI 語言

- **WHEN** 一個由主行程產生、且會被呈現層顯示的失敗訊息抵達畫面
- **THEN** 該訊息以當前 UI 語言呈現

#### Scenario: 終端中寫給使用者的訊息為當前 UI 語言

- **WHEN** 一個被重建的 shell session 重播其上次的畫面，並顯示歷史與 live 之間的分隔
- **THEN** 該分隔上的文字以當前 UI 語言呈現

#### Scenario: 作業系統原生通知的文案為當前 UI 語言且取自字典

- **WHEN** 主行程發出一則作業系統原生通知
- **THEN** 其標題與內文中的系統文案以當前 UI 語言呈現
- **AND** 那些文案取自共用的字典，而非以字面值寫在主行程模組中

#### Scenario: 預填的 prompt 不隨 UI 語言改變

- **WHEN** UI 語言為非英文，使用者接受一則待處理項目，agent session 開啟並填入第一則 prompt
- **THEN** 該 prompt 為英文
- **AND** 同一畫面上屬於介面的文字（分頁標籤、狀態列、收件匣）以當前 UI 語言呈現

#### Scenario: 注入 agent 脈絡的文字不隨 UI 語言改變

- **WHEN** UI 語言為非英文，一個 agent session 啟動
- **THEN** 經 `SessionStart` 注入其脈絡的自我介紹為英文

#### Scenario: The macOS application menu is in the current UI language

- **WHEN** on macOS the UI language is not English and the application menu is opened
- **THEN** each of its items is labelled in that language, from the shared dictionaries
