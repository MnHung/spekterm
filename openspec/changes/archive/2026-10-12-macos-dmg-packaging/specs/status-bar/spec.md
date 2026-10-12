## MODIFIED Requirements

### Requirement: 狀態列呈現該 session 的工作目錄與 git 工作區狀態

狀態列 SHALL 呈現 focused session 的 pty **當下的工作目錄**（不是它所屬 folder 的路徑 ——
使用者在終端裡 `cd` 之後，這個欄位 SHALL 隨之改變）。路徑過深時 SHALL 縮寫。

git 分支之外，狀態列 SHALL 標示該工作目錄的 git 工作區**是否有未提交的變更**；當它位於一個
linked worktree 時，SHALL 呈現該 worktree 的名稱而非完整路徑。

工作目錄的取得 SHALL NOT 倚賴 agent 提供 —— login shell 的 session 同樣要有這個欄位。

**On macOS this field is not available yet.** The application cannot read a pty's current directory
there, so the status bar shows neither the working directory nor its git state for the focused session.
This is a known gap, documented as a macOS limitation and tracked as an issue. The scenarios below are
accepted on Linux.

#### Scenario: 於終端內切換目錄後欄位隨之更新

- **WHEN** 於 Linux 上，使用者在 focused session 的終端內切換到另一個目錄
- **THEN** 狀態列呈現的工作目錄於短時間內改為新的目錄

#### Scenario: login shell 的 session 同樣呈現工作目錄

- **WHEN** focused session 的 spawn 目標為 login shell
- **THEN** 狀態列仍呈現其當下的工作目錄

#### Scenario: 工作區有未提交的變更時標示

- **WHEN** focused session 的工作目錄所屬的 git 工作區有未提交的變更
- **THEN** 狀態列在分支旁標示該狀態
