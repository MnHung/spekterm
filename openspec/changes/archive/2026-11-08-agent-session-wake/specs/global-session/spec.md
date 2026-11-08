## MODIFIED Requirements

### Requirement: 全域 session 一樣跨重啟存活並重建

全域 session SHALL 與 folder 的 session 一樣被持久化並於下次開啟應用程式時重建，包含：spawn 目標、
使用者取的名字、分頁順序、pty 最近一次宣告的終端標題，以及 claude 目標的對話識別碼。A restored global
session SHALL follow the same rule as any other restored session (see `session-persistence`): one that was
running when the application closed starts again on its own, and one that was dormant then is dormant and SHALL
start its pty only when the user explicitly wakes it or an agent's wake command reaches it (see
`agent-session-control`).

持久化的內容 SHALL 以「不隸屬任何 folder」為一個明確表示的狀態，SHALL NOT 以某個保留的 folder
識別碼字串偽裝成隸屬於某個 folder —— 後者會使每一處「以識別碼查找 folder」的程式碼靜默地查無此
folder，而型別檢查對此無能為力。

#### Scenario: 全域 session 跨重啟重建

- **WHEN** 使用者建立數個全域 session 並為其中之一命名，關閉並重新開啟應用程式
- **THEN** 那些 session 以原本的順序與名字重建於全域項目之下

#### Scenario: claude 目標的全域 session 續接原對話

- **WHEN** 一個全域 claude session 曾與 agent 對話過，關閉並重新開啟應用程式後它已再次啟動或被喚醒
- **THEN** 該 session 續接同一個對話

#### Scenario: A running global session starts again when the application opens

- **WHEN** a global session is running when the application closes, and the application is reopened
- **THEN** that session has started a pty, without the user selecting the global item or waking it

#### Scenario: Selecting the global item does not start its sessions

- **WHEN** the application is reopened with several global sessions that were dormant when it closed, and the
  user selects the global item
- **THEN** its focused session is displayed as dormant and no global session has started a pty

#### Scenario: 落盤內容以明確狀態表示不隸屬任何 folder

- **WHEN** 檢視持久化的 session 清單內容
- **THEN** 全域 session 的條目以一個明確的狀態表示它不隸屬任何 folder，而非帶有一個不對應任何
  workspace folder 的識別碼字串
