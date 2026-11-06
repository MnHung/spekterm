## MODIFIED Requirements

### Requirement: 監看範圍涵蓋每個工作目錄與工作目錄清單本身

主行程 SHALL 監看**每一個**工作目錄的 `openspec/` 目錄，而不僅是 folder 根目錄的那一個。

主行程 SHALL 另外監看**工作目錄清單本身**。工作目錄是「先建立目錄、後寫入 change」——僅監看
既有工作目錄的 `openspec/` 時，一個新建工作目錄的第一次寫入沒有任何監看者在場，側欄要等到
不相干的事件才會更新。

對工作目錄的監看 SHALL NOT 使既有的「監看不得跟隨 symlink 走出 folder 邊界」失效：該約束的
對象是**不受信任的 symlink 展開**，而工作目錄是版控系統列舉出的已知位置；由監看推送給 renderer
的 SHALL 僅為「該 folder 的 OpenSpec 結構已變更」，SHALL NOT 包含任何路徑。

Which part of each `openspec/` is watched — not the contents of an archived change — is stated once, in
`openspec-data-access` (the cache-and-watch requirement); it applies to every working tree alike.

#### Scenario: worktree 中的 change 被改動後側欄更新

- **WHEN** 外部程式改動了某個 linked worktree 的 `openspec/` 底下的檔案 (outside an archived change)
- **THEN** renderer 收到該 folder 的 OpenSpec 結構已變更的通知
- **AND** 後續請求取得的是改動後的內容

#### Scenario: 新建的 worktree 被納入

- **WHEN** 在 app 執行期間為該 repo 新建一個 linked worktree，並於其中新增一個 change
- **THEN** 側欄的 change 清單出現該 change，使用者無需手動重新整理

#### Scenario: 監看事件不攜帶路徑

- **WHEN** 位於 folder 邊界外的工作目錄中有檔案被改動
- **THEN** 推送給 renderer 的通知僅識別該 folder，不含任何檔案路徑
