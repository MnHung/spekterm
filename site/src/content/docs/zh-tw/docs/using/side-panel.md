---
title: OpenSpec 側欄
description: 在 agent 處理一個 OpenSpec change 的同時跟著它 —— artifact、task、spec delta、瀏覽、worktree、關係圖與時間軸。
sidebar:
  order: 2
---

側欄是 spekterm 存在的理由。你不必切到編輯器去讀 spec：agent 正在處理的 change 就放在它的終端機旁邊，agent 寫入什麼，你就看著它跟著變。

側欄有兩個身分，在頂端切換：**OpenSpec** 與 **檔案**。這一頁講 OpenSpec；「檔案」有[自己的一頁](/zh-tw/docs/using/files/)。沒有 `openspec/` 目錄的 repository 只提供「檔案」。

## 這個 change

**這個 change** 顯示一個 change，每個 artifact 一個分頁：proposal、design、spec delta、tasks，以及 change 附帶的資料檔。分頁依你的 OpenSpec schema 定義的順序排列。

- **Task** 分頁顯示進度，以及依標題分組的各個 task。進度數字也會出現在狀態列上。
- **Spec delta** 分頁標出每條 requirement 是新增、修改、移除還是改名，並把 scenario 的 `WHEN` / `THEN` 關鍵字標亮。
- 磁碟上的檔案一變，這裡就跟著更新。agent 把一個 task 打勾，分頁上就會看到。

焦點在這個檢視裡時，`Ctrl+Tab` / `Ctrl+Shift+Tab` 在 artifact 分頁之間切換；方向鍵、`Page Up` / `Page Down`、`Home`、`End` 與 `Space` 則捲動內容。

## 選擇 change

spekterm 不會從 agent 的輸出去猜 session 在處理哪個 change。偶爾跳到錯的 change 的側欄，比沒有側欄更糟。所以由你來選：

1. 打開 **瀏覽**。
2. 展開 **Change**（**進行中** 或 **已封存**），挑一個。

這個 change 就成了這個資料夾錨定的 change，**這個 change** 會顯示它。每個資料夾各自記得自己的選擇，重啟後仍然保留。repository 若剛好只有一個進行中的 change，不必挑就會直接顯示。

**瀏覽** 也列出所有 spec。打開一個 spec，就能看到哪些 change 動到它。

## 續寫 change

change 還缺 artifact 時，**這個 change** 會顯示 **續寫**，並列出還沒寫的部分。按下去，spekterm 會把 `/opsx:continue <change>` 送給這個 repository 裡 focused 的 `claude` session，由它寫出下一個 artifact。下一個該寫哪個 artifact 由 OpenSpec 決定，不是 spekterm。

沒有 session 能接手時，**續寫** 會停用並說明原因：這個 repository 沒有 session、focused session 是 **全域** session 或 shell、它沒有在執行、側欄正在顯示另一個 repository，或 change 與 session 位在不同的工作目錄。

## 其他 worktree 裡的 change

如果你習慣一個 change 開一個 git worktree，側欄會顯示 repository 所有 worktree 的 change，並標出各自的工作目錄。你正在看的 change 若位在沒有 session 執行的 worktree，按 **在那裡開一個 session** 就會在那個 worktree 開一個 `claude` session，並替你把這個 change 錨定好。

## 顯示另一個 repository

側欄平常顯示 rail 上選中的 repository，但也能顯示工作區裡任何一個資料夾。例如 session 在 app 裡工作時，你可以讀共用函式庫裡的 spec。按側欄頂端的來源指示器，挑一個資料夾即可；按 **回到選中的 repo** 就回來。側欄顯示別的 repository 時，狀態列會顯示 `側欄：<名稱>`。

## 在 spec 與檔案之間移動

在 artifact 上按 ▤ 按鈕，會在「檔案」身分打開對應的檔案。在 `openspec/` 底下的檔案上按 **在 OpenSpec 中檢視**，就會回去。焦點在側欄時，按 `Ctrl+P` 打開快速開檔，可以用檔名找任何檔案；見[檔案與快速開檔](/zh-tw/docs/using/files/)。

## 放大、關係圖與時間軸

`Ctrl+Shift+M` 會把側欄放大，蓋住 session 分頁與終端機，底下的 session 照常執行。再按一次，或按 **還原**，就回到原樣。rail 始終看得到。

OpenSpec 身分還有兩個檢視，只在側欄放大時顯示（選了其中一個，側欄會自動放大）：

- **關係圖**：spec 與 change 之間的關聯（哪些 change 動到哪些 spec）。
- **時間軸**：每個 change 在時間軸上的生命週期。

在任一個檢視裡點一個 change，會在 **這個 change** 打開它；在關係圖點一個 spec，會在 **瀏覽** 打開它。還原側欄後，會回到你先前的檢視，停在同一個 artifact 與捲動位置。

## 跟上磁碟

側欄會監看 repository，檔案一變就重繪。如果用了一陣子之後不再更新，多半是系統的檔案監看上限太低；見[疑難排解](/zh-tw/docs/help/troubleshooting/)。
