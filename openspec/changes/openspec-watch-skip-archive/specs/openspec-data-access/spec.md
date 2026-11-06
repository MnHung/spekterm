## MODIFIED Requirements

### Requirement: 掃描結果快取，並於 openspec 目錄變更時失效並通知 renderer

主行程 SHALL 快取每個 folder 的掃描結果 —— 側欄的多個視圖會反覆請求同一份結構，而掃描需要遞迴讀取
目錄並取得 git 時間戳。

主行程 SHALL 監看該 folder 涵蓋範圍內**每一個工作目錄**的 `openspec/` 目錄，並 SHALL 另外監看
**工作目錄清單本身**（見 `worktree-aggregation`）。上述任一處發生檔案變更時，主行程 SHALL 使該
folder 的快取失效，並 SHALL 通知 renderer 該 folder 的 OpenSpec 結構已變更。

通知 SHALL 對連續發生的變更事件合併後送出（debounce）—— agent 的一次操作會寫入數個檔案，逐一通知會使
側欄在極短時間內反覆重新載入。

監看 SHALL NOT 跟隨 symlink 走出 folder 邊界（延續 `file-explorer` 對 watcher 的既有約束）。**此約束
的對象是 symlink 的展開** —— 一個由 repo 內容決定的、不受信任的路徑；它 SHALL NOT 被詮釋為禁止監看
由版控系統列舉出的工作目錄，即使該工作目錄位於 folder 邊界之外。兩者的差別在於路徑的來源是否可信，
以及是否有路徑會流向 renderer（見 `worktree-aggregation`）。

這個 app 的前提是旁邊有 agent 一直在寫檔 —— 側欄 SHALL NOT 是啟動時的快照。

**Within each watched `openspec/`, the contents of an archived change SHALL NOT be watched** — nothing under
`changes/archive/<name>/`. Archived changes only accumulate, so watching them makes the cost grow with a
repository's history times its worktrees, and an archived change is not edited. The main process SHALL still
treat as a file change of the `openspec/` it belongs to:

- a change directory leaving `changes/` (which is how archiving one looks);
- an archived change directory added to or removed from `changes/archive/`, including when `changes/archive/`
  itself did not exist before and when it is removed and created again.

An edit inside an existing archived change SHALL NOT be required to invalidate the cache: it is seen at the next
scan that something else causes. This gap is accepted, not overlooked.

#### Scenario: agent 改動 change 後側欄資料更新

- **WHEN** 某個 folder 的 `openspec/changes/` 下有檔案被外部程式改動 (outside an archived change)
- **THEN** renderer 收到該 folder 的 OpenSpec 結構已變更的通知，且後續請求取得的是改動後的內容

#### Scenario: 連續變更合併為單次通知

- **WHEN** 某個 folder 的 `openspec/` 下在極短時間內有多個檔案被改動
- **THEN** renderer 收到的通知次數少於檔案變更的次數

#### Scenario: 重複請求不重複掃描

- **WHEN** renderer 在 `openspec/` 未發生任何變更的情況下，對同一個 folder 連續發出多次結構請求
- **THEN** 主行程不為每次請求重新掃描檔案系統

#### Scenario: linked worktree 中的變更觸發更新

- **WHEN** 某個 linked worktree 的 `openspec/` 下有檔案被外部程式改動 (outside an archived change)
- **THEN** renderer 收到該 folder 的 OpenSpec 結構已變更的通知

#### Scenario: Archiving a change triggers an update

- **WHEN** an active change's directory is moved from `changes/` into `changes/archive/`
- **THEN** renderer receives the notification that the folder's OpenSpec structure changed

#### Scenario: An archived change arriving on its own triggers an update

- **WHEN** a new directory appears under `changes/archive/` while no active change leaves `changes/` (for example
  after a pull)
- **THEN** renderer receives the notification that the folder's OpenSpec structure changed

#### Scenario: The archive directory created after the watch started is followed

- **WHEN** `changes/archive/` does not exist when the folder's watch starts, is created later, and afterwards a
  further archived change directory is added to it
- **THEN** renderer receives a notification for the later addition as well

#### Scenario: Edits inside an archived change are not watched

- **WHEN** a file inside an existing archived change directory is changed, and nothing else in `openspec/` is
- **THEN** renderer receives no notification
