## MODIFIED Requirements

### Requirement: 未處理的項目數在不打開收件匣的情況下可見

收件匣 SHALL 於活動列的入口上呈現目前待處理的項目數。該數與使用者打開收件匣後看到的待處理項目
**SHALL 出自同一次求值** —— 不是兩處各自判斷什麼算「待處理」。

沒有待處理項目時 SHALL NOT 呈現任何計數標示（**SHALL NOT 呈現 `0`，也 SHALL NOT 留下佔位**）。
一個恆常存在的標示不構成提示。

該數 SHALL 於收件匣**從未被打開過**的情況下同樣正確，並 SHALL 於項目被接受或忽略之後隨即反映。
被接受的項目其預填逾時而退回待處理時，該數 SHALL 隨之回復。它 SHALL 跨應用程式重啟保留。

routing 解析不出目標 folder 的項目 SHALL 計入 —— 它仍然是一件待處理的事，而它恰恰更需要注意。

**A scheduled handoff that has not been opened yet SHALL NOT count** (`scheduled-handoff`): nothing about it
waits for the user, and a badge that counts it would stay lit for days. Once its one automatic opening has been
attempted and it is still pending, it is an ordinary pending item and SHALL count. The count and the inbox SHALL still come from one evaluation:
the inbox lists scheduled handoffs apart from the pending items the count describes.

**被拒絕的投遞其彙整計數 SHALL NOT 計入本標示** —— 兩者是不同的東西，其可見性仍由收件匣之內
的彙整呈現承擔（見「投遞以檔案落點為契約，且落點的內容是不受信任的」）。

> **「出自同一次求值」是行為條款，不是措辭。** 若計數與收件匣內容各自判斷什麼算「待處理」，
> 兩份定義可以無聲地分岔，而症狀是「標示說三件、打開只有兩件」—— 沒有任何一邊會失敗。
>
> **缺口：拒絕在收件匣之外自此完全看不見。** 一次識別碼搶佔的畫面呈現是「沒有計數標示、
> 桌面安靜」，與什麼都沒發生一模一樣。此前那道警示倚賴「使用者會定期打開收件匣看一眼」，
> 而本能力正是把那個習慣換掉的東西。這是一條**已裁決的取捨**，不是疏漏；它與
> `docs/lessons/intake.md` 第五節那條「取捨之間的交互」屬於同一條鏈，放寬任何一格之前要回去看。

#### Scenario: 從未打開過收件匣時仍呈現計數

- **GIVEN** 應用程式啟動後使用者未曾開啟收件匣
- **WHEN** 一則 intake 進入收件匣
- **THEN** 活動列的收件匣入口上呈現計數 `1`

#### Scenario: 計數與收件匣內的待處理項目一致

- **GIVEN** 收件匣中有三則待處理項目
- **WHEN** 使用者檢視活動列的收件匣入口，再打開收件匣
- **THEN** 入口上的計數為 `3`，且收件匣中呈現的待處理項目恰為三則

#### Scenario: 處理掉一則之後計數隨即減少

- **GIVEN** 收件匣中有三則待處理項目
- **WHEN** 使用者忽略其中一則
- **THEN** 計數變為 `2`

#### Scenario: 沒有待處理項目時不呈現計數標示

- **GIVEN** 收件匣中所有項目都已被接受或忽略
- **WHEN** 使用者檢視活動列的收件匣入口
- **THEN** 該入口上不存在任何計數標示

#### Scenario: 計數跨重啟保留

- **GIVEN** 收件匣中有兩則待處理項目
- **WHEN** 應用程式重新啟動
- **THEN** 活動列的收件匣入口上呈現計數 `2`

#### Scenario: 解析不出目標 folder 的項目仍計入

- **GIVEN** 一則 intake 的 routing 解析不出任何 folder
- **WHEN** 使用者檢視活動列的收件匣入口
- **THEN** 該則項目計入其中

#### Scenario: 只有被拒絕的投遞時不呈現計數標示

- **GIVEN** 沒有任何待處理項目，但有數則投遞被拒絕
- **WHEN** 使用者檢視活動列的收件匣入口
- **THEN** 該入口上不存在任何計數標示
- **AND** 打開收件匣後，那些拒絕以彙整的形式呈現

#### Scenario: A scheduled handoff that is not due is not counted

- **GIVEN** the inbox has one pending item and one handoff scheduled for tomorrow
- **WHEN** the user looks at the activity bar's inbox entry
- **THEN** the count is `1`

#### Scenario: A due handoff that did not open is counted

- **GIVEN** a scheduled handoff whose time came but whose session could not be created
- **WHEN** the user looks at the activity bar's inbox entry
- **THEN** that handoff is counted

### Requirement: 通知綁定於項目的到達 —— 回補進來的要通知，落盤中既有的不重新通知

通知 SHALL 由一則 intake **成功進入收件匣**的那一刻觸發，SHALL NOT 由「收件匣之內存在待處理
項目」觸發。

**應用程式未執行期間投遞、於啟動時進入收件匣的項目 SHALL 發出通知** —— 那是本能力最主要的
使用情境。

**已存在於落盤狀態中**的待處理項目 SHALL NOT 因應用程式啟動而被重新通知。

**A scheduled handoff arrives when it opens, not when it is read** (`scheduled-handoff`). Its notification
SHALL be raised at the moment it opens — while the application runs, or at the start after its time passed —
and SHALL NOT be raised when it is scheduled. A scheduled handoff that is still waiting in the persisted state
is not an arrival at start.

> **兩半必須一起寫下。** 只寫後半的話，一個「啟動後一段時間內一律不發通知」的實作會滿足它，
> 而使用者在最常見的那條路徑上（關著時被提及 → 開機時回補進來）**一則通知都收不到** ——
> 沒有任何一條斷言會紅。只寫前半的話，每次開機會把收件匣裡積著的東西重新通知一遍。
>
> **兩半的驗收前提造法不同**：「回補要通知」以落點中預先存在的投遞造出；「既有的不重新通知」
> 只能以落盤的狀態造出 —— 在落點放檔案造出的是**到達**。

#### Scenario: 關閉期間投遞的項目於啟動時進來仍然通知

- **GIVEN** 應用程式未執行期間，落點中出現兩則投遞
- **WHEN** 應用程式啟動
- **THEN** 發出一則通知

#### Scenario: 落盤中既有的待處理項目不因啟動而重新通知

- **GIVEN** 落盤的狀態中已有三則待處理項目，且落點中沒有任何投遞
- **WHEN** 應用程式啟動
- **THEN** 不發出任何作業系統通知
- **AND** 活動列的收件匣入口呈現計數 `3`

#### Scenario: Scheduling raises no notification, opening does

- **WHEN** a handoff scheduled for two minutes from now is read, and later its time comes
- **THEN** no notification is raised when it is read, and one is raised when it opens

#### Scenario: A waiting scheduled handoff is not notified at start

- **GIVEN** a handoff scheduled for tomorrow is in the persisted state
- **WHEN** the application starts
- **THEN** no operating-system notification is raised for it
