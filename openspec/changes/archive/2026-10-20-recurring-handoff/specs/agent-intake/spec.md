## MODIFIED Requirements

### Requirement: intake 有生命週期，跨重啟保留，且去重鍵與內容各有其保留期限

一則 intake SHALL 恰處於**待處理**、**已接受**、**已忽略**三種狀態之一，狀態 SHALL 落盤並跨
應用程式重啟保留。忽略一則 intake SHALL NOT 建立任何 session。

**已接受的 intake SHALL 記錄它建立的 session 識別碼**，使「這個 session 從哪來」在該則仍呈現於
收件匣時看得見（呈現的期間見「已開好的項目只在它的本文仍需要被看時呈現於收件匣」）。
該關聯 SHALL 只存在 intake 這一側，SHALL NOT 寫入 session 的持久化紀錄。

**One exception: an approved repeating proposal** (`recurring-handoff`) is accepted without creating a session —
approving it schedules its occurrences, each of which records its own session. It SHALL be accepted with no
session identifier and marked settled at the moment it is approved, so that it is not presented as an opened
item; its identifier and digest SHALL stay for deduplication as every accepted intake's do.

**已接受的 intake 另 SHALL 能被標記為「已了結」**（prompt 已送出，或使用者已清除它）。該標記
SHALL NOT 構成第四種狀態 —— 它的狀態仍為已接受 —— 且 SHALL NOT 影響去重。以新的狀態表達它，
會讓不認得該狀態的版本整筆丟棄那些紀錄，連同它們的去重鍵。

**去重鍵與內容的保留期限 SHALL 分開規定**：去重鍵（adapter、識別碼、狀態）SHALL 永久保留 ——
清除它等同放棄對該識別碼的去重；內容（通用欄位、保存的投遞、交給 agent 的檔案）SHALL 可過期。
少了這個區分，狀態檔會單調成長，而它在每次投遞時被整份重寫。

#### Scenario: 已忽略的狀態跨重啟保留

- **WHEN** 使用者忽略一則 intake，應用程式其後重新啟動
- **AND** 投遞落點此時為空
- **THEN** 該則 intake 存在且狀態為已忽略

#### Scenario: 已接受與待處理在同一次重啟後各自保持

- **WHEN** 收件匣中有一則已接受與一則待處理的 intake，應用程式重新啟動
- **THEN** 前者狀態為已接受、後者狀態為待處理

#### Scenario: 忽略不建立 session

- **WHEN** 使用者忽略一則待處理的 intake
- **THEN** 該則 intake 轉為已忽略
- **AND** session 的總數與忽略之前相同

#### Scenario: 內容過期之後去重仍然有效

- **WHEN** 一則已接受的 intake 其內容已被清除
- **AND** producer 以同一個識別碼再投遞一次
- **THEN** 該次投遞仍被視為重複而拒絕

#### Scenario: 已了結的項目狀態仍為已接受

- **WHEN** 一則已接受的 intake 被標記為已了結，應用程式其後重新啟動
- **THEN** 該則 intake 存在且狀態為已接受

#### Scenario: An approved repeating proposal is accepted without a session and survives a restart

- **WHEN** the user approves a repeating proposal and the application restarts
- **THEN** the proposal exists with state accepted, no session identifier and marked settled, it is not listed in the inbox, and the same proposal delivered again is a duplicate
