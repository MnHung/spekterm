---
title: 資料與網路
description: spekterm 會連到哪裡、它啟動的哪些程式會自己連網，以及你的資料存在哪裡。
sidebar:
  order: 3
---

spekterm 沒有帳號、沒有遙測（telemetry）、也不檢查更新。這一頁列出它自己發出的每一種連線，以及它啟動、
而會自己連網的程式。

## spekterm 自己會連到哪裡

- **Slack** —— 只在你於收件匣存下 Slack 憑證之後，而且只連到 Slack 的 API（或你在那裡設定的端點；
  對話框會提醒你的憑證會被送到那裡）。沒有憑證時，spekterm 的 Slack 部分什麼都不做。
  見 [收件匣與 Slack](/zh-tw/docs/using/inbox-and-slack/)。
- **算繪出來的 markdown 裡的遠端圖片（image）** —— spekterm 算繪的 markdown（你開的檔案、側欄裡的
  OpenSpec artifact、對話檢視）可能含有 `https:` 圖片，它們會從所指的位置載入。純 `http:` 的圖片不會載入。
- **你點開的連結** —— 你點的連結會交給你的瀏覽器；spekterm 自己不載入它。

除此之外沒有。特別是，spekterm 關掉了瀏覽器引擎內建的拼字檢查 —— 否則它會在啟動時從第三方伺服器下載字典。

## 遠端存取（除非你打開，否則是關的）

打開**遠端存取**時，spekterm 會在每一張網路介面的一個 port（預設 47615，可以改）上**等待**連線，讓你手機上的
spekterm app 連得到它 —— 透過你的區網、Tailscale，或你轉送的 port。只有你配對過的裝置能使用這條連線：每台裝置
以 TLS 連到它配對時確認過的憑證，並用自己的憑證登入，你隨時可以撤銷。**遠端存取自己不往外連任何地方**：它只回應
你的裝置，你的手機只在連線中才會收到事件。過程中沒有任何推播服務、中繼站或本專案的伺服器。遠端存取關閉時，沒有
任何東西在等待連線。見 [遠端存取](/zh-tw/docs/using/remote-access/)。

## spekterm 啟動、而會自己連網的程式

spekterm 會執行你安裝的程式。它們送出什麼由它們自己決定，而且 **spekterm 自己的檢查看不到這些程式做了什麼**：

- **`claude`**（Claude Code）—— 每個 agent session 都是用你自己的登入執行真正的 `claude` CLI，它會連到
  Anthropic 的服務。對話讀後感（「讀後感」）也是執行你的 `claude`，而且只在你要求時才執行；它會先列出
  要送出的內容並徵求你的同意。
- **`openspec`** —— 側欄會執行 OpenSpec CLI 來讀取你的 change。OpenSpec CLI 預設會送出匿名的使用統計，
  除非你把它關掉。不論 spekterm 是怎麼啟動的，下面這個做法都有效：

  ```bash
  openspec config set telemetry.enabled false
  ```

  環境變數 `OPENSPEC_TELEMETRY=0` 與 `DO_NOT_TRACK=1` 也可以，但只在它們存在於 spekterm 本身被啟動時的
  環境裡才有效。寫在 `.zshrc` 裡的值，在你從桌面選單（或 macOS 上的 Dock、Finder）啟動 spekterm 時**不會**傳到 `openspec`：spekterm
  在啟動時讀一次你的登入 shell（login shell）的環境，交給它開的終端，而它自己的行程只從中取用 `PATH`。
- **你的登入 shell（login shell）** —— spekterm 啟動時執行一次，用來讀取你的環境（例如 `PATH`）。
  你的 shell 設定在登入時會做的事，那時都會發生。

## 你的資料存在哪裡

spekterm 保存的一切都在你的機器上，Linux 上位於 `~/.config/Spekterm`，macOS 上位於
`~/Library/Application Support/Spekterm`：

- 你的 workspace（資料夾清單、順序、置頂了哪些）以及每個資料夾的側欄位置；
- 你的 session，以及每個 shell session 最後的畫面，重新啟動後用來重播；
- 你的偏好設定；
- 收件匣與交接的檔案；
- 一份 Claude Code 對話的副本，供對話計量與讀後感使用，以及你產生過的讀後感；
- 你的 Slack 憑證，放在自己一個檔案裡，只有你的使用者帳號能讀寫。這個檔案沒有加密；任何能以你的身分讀取
  你的檔案的人都讀得到它；
- 遠端存取：它的設定、憑證與已配對的裝置（`remote.json`，只有你的使用者帳號讀得到；每台裝置的憑證只存雜湊，不存本身），
  以及憑證的私鑰，與 Slack 憑證存在同一個檔案裡。

spekterm 也會**讀取** Claude Code 自己位於 `~/.claude/projects` 的對話紀錄，用來呈現對話檢視。它從不寫入那裡。

## spekterm 沒有視窗地執行時（macOS）

在 macOS 上，關掉視窗不會結束 spekterm。它沒有視窗地繼續執行時，收件匣照常接收投遞；若你存了 Slack
憑證，spekterm 也照樣每五分鐘檢查一次 Slack。若遠端存取是開的，它也照樣等待連線，已配對的手機仍連得上、看得到收件匣（session 需要視窗）。要讓這些都停下來，
就結束它（`Cmd+Q`）。
