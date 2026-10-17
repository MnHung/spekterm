---
title: 終端與 session
description: Claude Code 與 shell session、重啟之後的還原、休眠，以及開在 git worktree 裡的 session。
sidebar:
  order: 1
---

每個 session 都是一個真的終端，跑著一個真的程式：Claude Code（`claude`）或你的 login shell。
spekterm 不包裝、也不模仿它們 —— 你打的字送給程式，程式印出什麼你就看到什麼。

## 開 session

在 rail 選中一個資料夾，按分頁列上的 **＋** 或 `Ctrl+T`，選 **執行 claude** 或 **登入 shell**。
這個選單可以全用鍵盤操作：方向鍵移動、`Enter` 選取。

- session 從資料夾的根目錄開始。rail 上 **全域** 項目的 session 從你的家目錄開始。
- `claude` 與你的 shell 拿到的環境，跟你在自己的終端裡一樣：spekterm 在啟動時讀一次你的 login shell
  環境。改了 `.zshrc` 或 `.bashrc` 之後，請重開 spekterm。
- 找不到 `claude` 時，終端會顯示 shell 的錯誤訊息，分頁標示為 **已結束** —— 不會悶不吭聲。

分頁以程式設定的標題命名。要用你自己的名字，在分頁上按右鍵選 **重新命名**；設了名稱之後，程式宣告
的標題會被忽略。清空名稱即可重新跟隨。

## 在終端裡工作

- **複製與貼上：**`Ctrl+Shift+C` 與 `Ctrl+Shift+V`（macOS 上是 `Cmd+C` 與 `Cmd+V`）。`Ctrl+C` 永遠是中斷，即使畫面上有選取的文字 ——
  所以失控的指令你隨時停得下來。
- 終端輸出裡的**連結**，點下去會在瀏覽器開啟。
- 用 `Ctrl+Tab` / `Ctrl+Shift+Tab` 在目前的 rail 項目內**切換 session**；拖曳分頁或用
  `Shift+←` / `Shift+→` 調整順序。
- 用 `Ctrl+Shift+W` 或分頁選單**關閉** session。

spekterm 的快捷鍵刻意挑選，不佔用你的 shell 或 Claude Code 需要的按鍵。完整清單與每一顆鍵的取捨，
見[快捷鍵](/zh-tw/docs/reference/keyboard-shortcuts/)。

終端的外觀 —— 字型、大小、行高、GPU 繪製 —— 在 **設定 → 終端** 裡；見[設定](/zh-tw/docs/reference/settings/)。

## 圓點代表什麼

每個 session 旁邊（分頁上與 rail 上）的圓點，讓你不必打開就知道一個 `claude` session 需不需要你。
滑鼠停在上面會用文字寫出狀態。

| 圓點 | 狀態 |
|---|---|
| 琥珀色、會閃 | **等你回應**：agent 做完這一輪，而你還沒去看；或者它**要你選擇**（權限詢問或提問） |
| 綠色、發光 | **工作中**：agent 正在跑這一輪 |
| 綠色空心圈 | **閒置**：這一輪結束了，你也已經看過 |
| 綠色 | 執行中：shell，或不知道狀態的 agent（agent 事件回報關閉時） |
| 灰色 | 休眠中，或已結束 |
| 紅色 | 異常結束 |

在 spekterm 視窗裡切到那個 session —— 或在手機 app 上打開它的對話 —— 就算看過了，圓點會從等你變回閒置。
剛啟動或剛喚醒的 session 是閒置，不是等你。rail 上每個 folder 列也有一顆圓點，顯示底下最急的那個
session，所以收合的 folder 也看得出裡面有東西在等你。

agent 不會回報的兩件事：按 `Esc` 中斷一輪之後，圓點會停在**工作中**直到你送出下一則；在終端裡直接打字回答
權限詢問，則以你的按鍵當作已回答。

## 重啟之後：休眠中的 session

關閉 spekterm 會結束每個 session 的行程。若還有 session 在執行，spekterm 會先問你並列出它們。
build、dev server，或 agent 還在寫的回覆都會遺失；spekterm 關著的時候無法讓行程繼續活著。

它保留的是 session 本身。再次打開 spekterm，每個 session 都回到它的分頁上，處於**休眠** ——
看得到，但沒有行程。在你要求之前什麼都不會啟動：

- 按 **喚醒**，或在休眠的 session 有焦點時按 `Enter`。
- `claude` session 會從中斷的地方接回**同一段對話**。
- shell 會**在它最後的工作目錄**重新啟動。先前的畫面呈現在一行 **以上為先前的內容** 之上，
  新舊輸出一眼就分得出來。在 macOS 上，shell 則是在它的資料夾重新啟動，而不是在它最後的目錄；
  關閉時的對話框會寫明這一點。

如果對話接不回來（例如它已被刪除），session 會改開一段新的對話，而不是留給你一個用不了的分頁。

## 在 macOS 上關閉與結束

在 Linux 上，關掉視窗就會結束 spekterm。在 macOS 上，spekterm 的行為跟「終端機」與 iTerm2 一樣：

- **關掉視窗**會結束每個 session —— 若有 session 在執行，會像上面那樣先問你 —— 但 spekterm 會繼續在
  Dock 裡執行。點 Dock 圖示就會重新打開視窗；session 都回來了，處於休眠，跟重啟之後完全一樣
  （`claude` 接回它的對話，shell 重新啟動）。
- **spekterm 沒有視窗地執行時**，收件匣照常收件；若設定了 Slack，spekterm 也照樣每五分鐘檢查一次提及。
  見[收件匣與 Slack](/zh-tw/docs/using/inbox-and-slack/)。
- **`Cmd+Q`**（或 **Spekterm → 結束 Spekterm**）在有 session 執行時，會問跟關掉視窗時一樣的問題。
- **從 Dock 結束、登出或關機**不會問正在執行的 session。有未儲存變更的檔案時仍然會問。

## 休眠

偶爾才用的 session，不需要一直佔著一個執行中的行程。對 session 按 **休眠**，會結束它的行程並讓它
原地休眠 —— 跟重啟之後的狀態完全一樣，喚醒的方式也相同。

- **手動：**`Ctrl+Shift+H`，或分頁、rail 那一列的選單裡的 **休眠**。
- **自動：**閒置 24 小時的 session 會被休眠。到 **設定 → Agent 與 session → 讓閒置的 session 休眠** 改時間或關閉。
  畫面上的 session 絕不會被自動休眠，正在工作的 agent、正在跑工作的 shell 也不會。在 macOS 上，閒置的
  shell 永遠不會被自動休眠；手動休眠照常可用。

休眠的 shell 會失去只存在於它行程裡的東西：未匯出的變數、還沒寫進磁碟的指令歷史，以及背景工作。
休眠畫面會寫明這一點。休眠的 `claude` session 什麼都不會失去 —— 喚醒就接回對話。

## 開在 git worktree 裡的 session

repo 若有 linked git worktree，側欄會呈現所有 worktree 的 change，並標示各自的工作目錄。change 位在
另一個 worktree 時，側欄會提供 **在那裡開一個 session**，在那個 worktree 的根目錄開一個 `claude`
session。狀態列會顯示 focused session 位在哪個 worktree（`wt <名稱>`），macOS 除外（見下文）。

位在資料夾目錄之外的 worktree 也照樣能開 session；只有在側欄瀏覽它的檔案會受限。

## 狀態列

視窗底部的狀態列顯示選中的 repo、focused session 的工作目錄與分支、開了幾個 session，以及錨定的
change 的 task 進度。在 **設定 → Agent 與 session** 打開 **在狀態列顯示 agent 狀態**，`claude` 還會在那裡回報它的模型、
context 用量與花費。這個設定套用於改動之後才開的 session，你自己的 Claude Code status line 照常運作。

在 macOS 上，狀態列不顯示 focused session 的工作目錄與它的 git 狀態（分支、未提交的變更、worktree）。
