---
title: 你的第一個工作區
description: 加入一個 repository、在裡面開一個 Claude Code session，並在終端機旁邊閱讀它的 OpenSpec change。
sidebar:
  order: 2
---

工作區就是 spekterm 左側那一列資料夾清單，也就是 **rail**。每個資料夾通常是一個 git repository。視窗裡其他的部分都屬於 rail 上選中的那一項：中間是它的 session，右側的側欄是它的 spec 與檔案。

## 加入資料夾

按 rail 底部的 **＋ 加入資料夾**，在對話框裡挑一個目錄。它會出現在 rail 上，並顯示目前的 git 分支。

- 沒有 `openspec/` 目錄的資料夾會標示 **沒有 openspec/**。你照樣可以在那裡開 session、瀏覽檔案，只是 OpenSpec 側欄需要那個目錄。
- 資料夾之後若在磁碟上移走或刪除了，它會留在 rail 上並標示 **找不到**，讓你看得出發生了什麼，而不是無聲無息地消失。
- 在資料夾上按右鍵選 **自工作區移除**，就能把它從 rail 拿掉；滑過資料夾時出現的 ✕ 也有同樣的作用。兩者都不會刪除磁碟上的任何東西。

你在幾個資料夾工作就加幾個。重開 spekterm 之後，這份清單依然在。

## 開一個 session

選中資料夾，然後按分頁列上的 **＋** 或 `Ctrl+T`，再從下面兩項擇一：

- **執行 claude** —— 在這個資料夾啟動 Claude Code。
- **登入 shell** —— 在這個資料夾啟動你平常用的 shell。

session 會以分頁開啟。同一個資料夾可以開好幾個 session，用 `Ctrl+Tab` 切換。分頁名稱取自程式設定的標題；在分頁上按右鍵選 **重新命名**，就能自己取名字。

rail 的最上方是 **全域**。那裡的 session 不隸屬任何 repository，從你的家目錄開始。跟單一專案無關的事，就放在那裡做。

## 在 agent 旁邊閱讀 change

右側的側欄有兩個身分，在它頂端切換：**OpenSpec** 與 **檔案**。

在 **OpenSpec** 打開 **瀏覽**，展開 **Change**，挑你正在處理的那個 change。**這個 change** 視圖就會呈現它：每個 artifact 一個分頁（proposal、design、specs、tasks），task 進度隨時看得到。請 agent 處理那個 change，側欄會隨著磁碟上的檔案變動即時更新：打勾的 task、新的 design 段落、新的 spec delta。

spekterm 絕不從 agent 印出的內容去猜 session 在處理哪個 change。每個資料夾由你挑一次，spekterm 會記住你的選擇。repository 若恰好只有一個進行中的 change，不必挑就會直接呈現。

change 還缺 artifact 時，**續寫**會請 focused 的 `claude` session 寫出下一份。側欄能做的所有事，請見[OpenSpec 側欄](/zh-tw/docs/using/side-panel/)。

## 整理 rail

- 拖曳資料夾調整順序，或選中一個之後按 `Shift+↑` / `Shift+↓`。
- 滑過資料夾就能把它置頂，讓它固定在最上面。rail 其餘部分捲動時，置頂的資料夾仍然看得到。
- `Ctrl+↑` / `Ctrl+↓` 用鍵盤在 rail 的項目之間移動選取。在 macOS 上，「指揮中心」與「App Exposé」預設佔用了這兩個鍵；到 **系統設定 → 鍵盤 → 鍵盤快速鍵 → 指揮中心** 把它們關掉，才能在這裡使用。

## 關掉再回來

關閉 spekterm 時若還有 session 在執行，spekterm 會先列出這些 session，問過你才關閉。關閉會結束它們的行程：在 shell 裡跑著的 build 或 dev server 會停掉。在 macOS 上，關掉視窗會以同樣的方式結束 session，但 spekterm 會繼續在 Dock 裡執行；點它的 Dock 圖示就會重新打開視窗。

下次打開 spekterm，你的 session 都會回到分頁上，但處於**休眠**：在你按下 **喚醒**（或 session 有焦點時按 `Enter`）之前，沒有任何行程在跑。`claude` session 會接回同一段對話；shell 會在它最後的目錄（macOS 上則是它的資料夾）重新啟動，先前的畫面顯示在一行 **以上為先前的內容** 之上。細節請見[終端機與 session](/zh-tw/docs/using/terminals-and-sessions/)。

## 接下來

- [終端機與 session](/zh-tw/docs/using/terminals-and-sessions/) —— 還原、休眠、worktree。
- [OpenSpec 側欄](/zh-tw/docs/using/side-panel/) —— artifact、瀏覽、關係圖與時間軸。
- [快捷鍵](/zh-tw/docs/reference/keyboard-shortcuts/) —— 完整清單。
