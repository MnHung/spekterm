---
title: 資料與網路
description: spekterm 會連到哪裡、它啟動的哪些程式會自己連網，以及你的資料存在哪裡。
sidebar:
  order: 3
---

spekterm 沒有帳號，也沒有遙測（telemetry）。這一頁列出 spekterm 自己發出的每一種連線（包括檢查更新），以及它啟動之後會自己連網的程式。

## spekterm 自己會連到哪裡

- **Slack** —— 只在你於 **設定 → 整合** 存下 Slack 憑證之後才連線，而且只連到 Slack 的 API，或你在那裡設定的端點（設定畫面會提醒你，憑證會送到那個端點）。沒有憑證時，spekterm 的 Slack 整合什麼都不做。見[收件匣與 Slack](/zh-tw/docs/using/inbox-and-slack/)。
- **markdown 裡的遠端圖片** —— spekterm 顯示的 markdown（你開的檔案、側欄裡的 OpenSpec artifact、對話檢視）可能含有 `https:` 圖片，spekterm 會從圖片所指的位置載入。純 `http:` 的圖片不會載入。
- **你開啟的連結** —— 你點的連結會交給你的瀏覽器開啟；spekterm 自己不載入它。
- **GitHub，用來檢查更新** —— 啟動一分鐘後、之後每六小時（以及你按下**立即檢查**時），spekterm 會向 GitHub 查詢 `spekhq/spekterm` 的最新版本。在 Linux 上，如果它是從一個可以替換的 AppImage 執行的，接著會從那個版本下載新的 AppImage。這些請求不帶任何關於你或你工作的資訊，和任何人下載一個公開檔案時送出的內容一樣。檢查更新**預設開啟**，可以在 **設定 → 關於 → 自動檢查更新** 關掉。更新可不可信，取決於它所來自的 GitHub 版本：用來驗證它的校驗碼，就公布在同一個版本裡。見[安裝 → 更新](/zh-tw/docs/getting-started/install/#更新)。

除此之外沒有別的連線。像是瀏覽器引擎內建的拼字檢查，spekterm 也關掉了，否則它會在啟動時從第三方伺服器下載字典。

## 遠端存取（預設關閉，由你開啟）

打開**遠端存取**之後，spekterm 會在每一張網路介面的同一個 port（預設 47615，可以改）上**等待**連線，讓你手機上的 spekterm app 透過區域網路、Tailscale 或你轉發的 port 連過來。只有配對過的裝置能使用這條連線。每台裝置都以 TLS 連向它配對時確認過的憑證，並用裝置自己的憑證驗證身分；裝置的憑證你可以撤銷。**遠端存取自己不往外連任何地方**：它只回應你的裝置，手機也只在連線中才會收到事件。整個過程不經過任何推播服務、中繼站或本專案的伺服器。遠端存取關閉時，沒有任何東西在等待連線。見[遠端存取](/zh-tw/docs/using/remote-access/)。

## spekterm 啟動、會自己連網的程式

spekterm 會執行你安裝的程式。這些程式送出什麼由它們自己決定，而且 **spekterm 自己的檢查看不到這些程式做了什麼**：

- **`claude`**（Claude Code）—— 每個 agent session 都用你自己的登入，執行真正的 `claude` CLI，而 `claude` 會連到 Anthropic 的服務。對話讀後感（「讀後感」）也是執行你的 `claude`，而且只在你要求時才執行。執行之前，它會先列出要送出的確切內容並徵求你的同意。
- **`openspec`** —— 側欄會執行 OpenSpec CLI 來讀取你的 change。除非你關掉，OpenSpec CLI 會送出匿名的使用統計。不論 spekterm 是怎麼啟動的，下面這個做法都能關掉它：

  ```bash
  openspec config set telemetry.enabled false
  ```

  環境變數 `OPENSPEC_TELEMETRY=0` 與 `DO_NOT_TRACK=1` 也有效，但前提是它們存在於啟動 spekterm 的那個環境裡。從桌面選單（或 macOS 上的 Dock、Finder）啟動 spekterm 時，寫在 `.zshrc` 裡的值**不會**傳到 `openspec`。spekterm 在啟動時讀一次你的登入 shell（login shell）的環境，交給它開的終端機，但它自己的行程只取用其中的 `PATH`。
- **你的登入 shell（login shell）** —— spekterm 啟動時執行一次，用來讀取你的環境（例如 `PATH`）。你的 shell 設定在登入時會做的事，那時都會發生。

## 你的資料存在哪裡

spekterm 保存的一切都在你的電腦上：Linux 上位於 `~/.config/Spekterm`，macOS 上位於 `~/Library/Application Support/Spekterm`。

- 你的 workspace（資料夾清單、順序、置頂了哪些），以及每個資料夾的側欄位置；
- 你的 session，以及每個 shell session 最後的畫面，重新啟動後用來重播；
- 你的偏好設定；
- 收件匣與交接的檔案；
- 一份 Claude Code 對話的副本，供對話計量與讀後感使用，以及你產生過的讀後感；
- 你的 Slack 憑證，單獨存在一個只有你的使用者帳號能讀寫的檔案裡。這個檔案沒有加密：任何能以你的使用者帳號讀取檔案的人都讀得到它；
- 遠端存取的設定、憑證與已配對的裝置（`remote.json`，只有你的使用者帳號讀得到；每台裝置的憑證只存雜湊，不存憑證本身），以及憑證的私鑰（和 Slack 憑證存在同一個檔案裡）；
- 你從手機附加到訊息裡的檔案（`remote-attachments`，每個 session 一個資料夾，只有你的使用者帳號讀得到）。關閉 session 時刪除；沒送出的一天後刪除；任何檔案最晚 30 天後刪除。

spekterm 也會**讀取** Claude Code 自己在 `~/.claude/projects` 的對話紀錄，用來呈現對話檢視。它從不寫入那裡。

## spekterm 在沒有視窗的狀態下執行時（macOS）

在 macOS 上，關掉視窗不會結束 spekterm。在沒有視窗的狀態下，收件匣照常接收投遞；如果你存了 Slack 憑證，spekterm 也照樣每五分鐘檢查一次 Slack。如果遠端存取開著，spekterm 也照樣等待連線，已配對的手機仍連得上、看得到收件匣（session 需要視窗）。檢查更新也照排程進行。要讓這些全部停下來，請結束 spekterm（`Cmd+Q`）。
