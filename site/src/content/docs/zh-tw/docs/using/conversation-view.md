---
title: 對話 view
description: 以對話而非終端的方式閱讀並回應 Claude Code session —— 它呈現什麼、什麼時候讓你送出、什麼時候該切回終端。
sidebar:
  order: 3
---

每個 `claude` session 都有兩種呈現方式：它的**終端**（預設），或是**對話** —— 訊息、agent 的思考、
工具的結果排成像聊天一樣，底部有一個輸入框讓你送出下一則訊息。

shell session 只有終端 view。

## 切換 view

在 session 上用 **顯示對話 view** 與 **顯示終端 view** 切換。這個選擇**一次套用到所有** agent session，
並跨重啟保留，所以新開的 session 會用你上次用的 view。同一個選擇也在 **設定 → Agent 與 session → Agent session 顯示**。

切換不會重新啟動任何東西。兩種 view 呈現的是同一個執行中的 `claude` 行程；對話 view 在畫面上時，
終端在底下照常執行。

## 內容從哪裡來

對話 view 取自 Claude Code 自己替每段對話寫下的紀錄（在 `~/.claude/projects`），隨著紀錄增長而讀取。
agent 正在工作還是在等待，來自 Claude Code 執行時回報給 spekterm 的事件。

spekterm 絕不讀終端畫面來組成這個 view。畫面輸出是給人看的，不是給程式讀的；CLI 只要改了繪製方式，
讀畫面的做法就會壞。對話 view 呈現不了的東西，終端 view 隨時都在。

對話 view 打開一段很長的對話時，會載入最近的一段，並寫明 **更早的訊息尚未載入。**。追上進度的期間
會顯示 **正在追上進度…**。紀錄完全讀不到時，view 會寫 **無法取得對話**，而不是呈現一段空的對話。

## 送出訊息

在 **傳訊息給 agent** 輸入，按 **送出**。能不能送出，要看 agent 正在做什麼：

- **等你輸入** —— 可以送出。
- **處理中…** —— agent 正在忙，連它不用任何工具、只是在寫回答時也算。這時仍然可以送出：Claude Code
  會在工作中收下這則訊息，訊息會出現在對話裡 agent 收下它的位置。
- **agent 正在請求使用某個工具，或在等一個選擇。** view 會顯示它在等什麼。請在終端 view 回答它 ——
  對話 view 不會把自由文字送進許可提示或選單。在背景執行的 agent 跳出的提示也一樣：只要還有提示開著，
  view 就會一直等它，即使 agent 本身已經結束這一輪。
- **agent 的狀態未知。** 這發生在 session 剛啟動時，或 Claude Code 沒有回報事件時。view 寧可拒絕送出
  也不猜；切到終端 view 看看 agent 在做什麼。

你送出的內容以純文字交給 agent，絕不會被解讀成終端控制序列。

你送出的 slash 指令（例如 `/simplify`，或帶參數的 skill）會以你打的那一行呈現。

你送出的訊息在出現於 Claude Code 自己的紀錄之前，會標示 **尚未確認**。如果它一直沒出現，view 會請你
查看終端 view —— 那則訊息可能沒有送到。

## 休眠中的 session

休眠中的 session 會顯示 **Session 正在休眠。喚醒後會接回對話。**按 **喚醒**（或 `Enter`）讓它重新
啟動；對話會從停下的地方繼續。見[終端與 session](/zh-tw/docs/using/terminals-and-sessions/#休眠)。

## 什麼時候用哪一個

- 要讀 agent 做了什麼、跟著一段長回答、或不受終端雜訊干擾地送出下一個指示時，用**對話 view**。
- 許可提示、選單、slash command 的選擇器、任何互動式的東西 —— 以及對話 view 告訴你它幫不上忙的
  時候，用**終端 view**。

## 它需要 Claude Code 提供什麼

spekterm 會替它啟動的每個 `claude` session 加上自己的設定，讓 Claude Code 回報何時開始工作、何時在
等待。你自己的 Claude Code 設定、hook 與 status line 照常運作；spekterm 是附加上去，不會改動你的設定
檔。在 spekterm 之外啟動的 agent session 不受影響。

這份設定也允許 Claude Code 讀取你從手機附加到訊息裡的檔案（見[遠端存取](/zh-tw/docs/using/remote-access/)）。
spekterm 把它們放在自己的資料資料夾裡，所以讀取時不會跳出許可提示；那裡只允許讀取。關掉 agent 事件回報時，
這項許可也不會加上。
