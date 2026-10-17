---
title: 交接
description: 讓 agent 把工作交給工作區裡的另一個 repo —— spekterm 開好 session、送出第一則 prompt、追蹤它，並在完成時告訴你。
sidebar:
  order: 6
---

spekterm 裡的 Claude Code session 可以把工作交接給工作區裡的另一個 repo。假設 `api-server` 裡的 agent
改了一個 endpoint，而 `web-app` 的 client 需要跟著改：agent 寫一份交接，spekterm 就在 `web-app` 開一個
新的 `claude` session，把交接內容交給它，並送出第一則 prompt。新的 session 記得自己從哪裡來，做完時
會回報。

## agent 怎麼知道自己可以交接

`claude` session 啟動時，spekterm 會告訴 agent：它正在 spekterm 裡執行、工作區裡有哪些 repo 可以交接，
以及怎麼投遞一份交接。你不需要設定任何東西，用平常的話說就好：

> 把 client 端的修改交接給 web-app。

agent 會寫一個簡短的標題與一段描述工作的內容。spekterm 讀到之後，以名稱在你的工作區裡找到目標 repo，
並在那裡啟動 session。

和來自 Slack 的收件匣項目不同，交接**不會先問你**就直接開好：它的內容是你自己 session 裡的 agent
寫的，不是第三方。新的 agent 一就緒，第一則 prompt 就會送出。偶爾 CLI 沒有接到送出鍵；這時 session
會顯示 **有一則 prompt 正等著被送出**，由你自己按 `Enter` —— spekterm 不會補送第二次。

## 追蹤交接出去的 session

- 新 session 的分頁以交接的標題命名。**開啟交接單** 隨時可以看交接內容與最新的結果。
- 同一個 repo 裡，交接出去的 session 在 rail 上會縮排在它的來源 session 底下。跨 repo 時，子 session
  會標示 **來自** 它的母 session，母 session 則標示它交接出去了幾個 session。點任一邊就能跳過去。
- 每個交接出去的 session 都有一個狀態，母子兩端都看得到：**進行中**、**等你** 或 **已完成**。
  **等你** 跟著 session 的圓點走：你看過那個 session 之後，它就不顯示狀態，直到它再開始工作
  （見[圓點代表什麼](/zh-tw/docs/using/terminals-and-sessions/#圓點代表什麼)）。

子 agent 做完時，會寫一份簡短的報告。spekterm 會把 session 標成 **已完成**、在交接單裡呈現摘要，並發出
桌面通知 —— 點它會打開交接單。子 agent 也可以直接把結果傳給母 agent；見下方。

**已完成** 的 session 收到新的工作就能重新開始。spekterm 絕不會自己關掉它（你請 agent 關它的話可以，見下文）：你可以逐一關閉已完成的
session，或一次全部收掉 —— 從母 session 的子 session 清單，或用至少有一個已完成時才出現的全工作區
動作。兩者都會先問你，並列出每個 session 的結果。

## agent 之間互相傳訊

spekterm 裡的每個 `claude` session 都以一個固定的名字執行，由它的 rail 項目與一段短碼組成（例如
`web-app-3f9a`）。這個名字跨重啟、跨喚醒都不變。agent 以這些名字使用 Claude Code 自己的本機 session
訊息功能，於是子 session 可以告訴母 session 它做完了，同一個母 session 交接出去的兄弟 session 也能互相
協調。spekterm 隨時更新每個 agent 的母、子（連同它們再交接出去的 session，一路往下）、兄弟清單；訊息本身由 Claude Code 傳遞。

休眠中的 session 沒有行程，在你喚醒它之前收不到訊息。agent 會被告知這一點，也會被告知不得自己去喚醒
session。

給每個 session 一個固定名字有一個副作用：Claude Code 會把那個名字顯示成終端標題。想在分頁上看到任務
名稱，就替分頁重新命名 —— 你取的名字優先。

## 請 agent 關閉、休眠或改名 session

agent 可以關閉、休眠或改名它自己的 session，以及它交接出去的任何 session —— 包括那些 session 再交接出去的。
直接用白話說：

> 這裡做完了，把這個 session 關掉吧。
>
> 把你交接出去、已經做完的都休眠。

- **關閉**會結束 session 並把它從工作區移除，跟分頁上的關閉一樣。**休眠**會結束它的行程，讓它保持休眠，
  直到你喚醒它。**改名**會改分頁上的名稱。
- **關閉和休眠會等那個 session 這一輪結束才執行。** 還在工作的交接 session 會在它停下來時才關，不會在
  中途被切斷。改名則立刻生效。
- **agent 不會自己把自己的 session 關掉。** 它要求關閉時會先把回覆講完，接著 session 上出現
  **agent 要求關閉這個 session**，附 **關閉** 與 **保留**。底下的回覆照樣看得到、捲得動；你按 **關閉**
  之前什麼都不會關。在那個 session 裡打字等於選了保留。已配對的手機上也會出現同一個提議，也能回應
  （[遠端存取](/zh-tw/docs/using/remote-access/)）；在任一邊回應，兩邊都算數。
- **在那個 session 裡打字，會取消等待中的關閉或休眠** —— 你已經把它拿回來了。你自己休眠、關閉或喚醒它
  也一樣。spekterm 結束時，等待中的指令也會被丟棄。
- agent 只能動它自己這一支。要它關掉母 session、兄弟或不相關的 session 會被拒絕，你會看到一則通知，
  收件匣裡也會留下紀錄。
- 畫面不會跳動：rail 上的選取和你的鍵盤焦點都留在原處。

和交接一樣，agent 不會知道指令有沒有被執行。對它交接出去的 session，它可以從關係清單看到結果
（不見了、沒在執行、或改了名）。

## 交接失敗時

送不到的交接不會無聲無息地消失。agent 若指名了一個不在你工作區裡的 repo（或兩個資料夾共用的名稱），
或寫了一段太長而無法審閱的內容，spekterm 會發出通知，並在收件匣留下一則附上原因的紀錄 —— 重啟之後
也還在 —— 直到你清除為止。

agent 本身不會知道它的交接有沒有送達；沒有回報的管道。交接很重要的話，請確認 session 真的開出來了。

## 交接不是什麼

- **不是安全邊界。** 有 shell 的 agent 想交接就能交接，就像它能執行任何指令一樣。交接只會在已經在你
  工作區裡的資料夾開 session。
- **沒有次數上限。** agent 想交接幾次都可以。
- **不是給別人的。** 交接是在你自己的機器、你自己的工作區裡開 session。
