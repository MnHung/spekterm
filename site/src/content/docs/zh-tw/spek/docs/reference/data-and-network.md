---
title: 資料與網路
description: spek 讀什麼、執行哪些程式，以及每種用法會連到哪裡。
sidebar:
  order: 1
---

spek 本身沒有帳號、沒有遙測，也沒有分析。它讀取 OpenSpec 檔案與 git 歷史，從不寫入你的 repository。會連到哪裡，依用法而定。

## 每種用法從哪裡讀 repository

| 用法 | 讀取 |
|---|---|
| VS Code 擴充套件、JetBrains 外掛、網頁版 | 你電腦上的 repository |
| GitHub Action | 在 GitHub Actions runner 上取出的 repository |
| 靜態頁面（action 的產出、線上 demo） | 建置當時嵌進頁面的快照 |

## 連線

| | 向 Google Fonts 載入字型 | 渲染後 Markdown 裡的遠端 `https:` 圖片 |
|---|---|---|
| 網頁版 | 會 | 會載入 |
| 靜態頁面（action 產出、線上 demo） | 不會 —— 字型直接內嵌在頁面裡 | 會載入 |
| VS Code 擴充套件 | 不會 | 擋下（面板的內容安全政策） |
| JetBrains 外掛 | 不會 | 會載入 |

除此之外，在你電腦上執行的用法不會向任何外部主機發出請求。GitHub Action 的部分見下文。你點開的連結會在你的瀏覽器開啟。

## 網頁版的本機伺服器

`npm run dev` 會在你的電腦上啟動兩個行程：頁面跑在 port 5173，頁面讀資料用的 API 跑在 port 3001。兩者都只在本機監聽，頁面在 `localhost`，API 在 `127.0.0.1`，同一個網路上的其他裝置都連不到。API 只回應這個 app 自己的頁面：發給其他主機名稱的請求、來自其他網頁或網站的請求，一律拒絕。因此，你在同一個瀏覽器裡開著的其他網頁，也無法透過它讀取任何東西。API 只讀兩樣東西：你挑選 repository 時瀏覽過的資料夾（列出來讓你挑選），以及你打開的 repository 的 OpenSpec 內容與 git 歷史。

JetBrains 外掛透過 IDE 內建的伺服器提供頁面，同樣只回應那個頁面。

## spek 執行的程式

| 程式 | 何時 | 用法 |
|---|---|---|
| `git` | 從歷史判斷 spec 與 change 的日期、列出 worktree、判斷哪個 worktree 推進了某個 change | 網頁版、VS Code、GitHub Action |
| `jj` | 只要裝了 jj 就會執行，用來偵測 jj workspace；不論 jj 聚合有沒有開啟都一樣 | 網頁版、VS Code |
| `openspec` | 有裝時，用來讀 repository 的工作流程 schema | 網頁版、VS Code、JetBrains、GitHub Action |

OpenSpec CLI 預設會送出匿名使用統計，而 spek 執行它時不會更動你的環境。要關閉使用統計：

```bash
openspec config set telemetry.enabled false
```

GitHub Action 執行 CLI 時已經關閉使用統計。

## GitHub Action

action 在你自己的 GitHub Actions 裡執行。它取出 `spek-version` 指定的 spek 原始碼（沒設定就是 spek 的主分支），從 npm 安裝 spek 的相依套件與 OpenSpec CLI，然後建置頁面。徽章由 action 自己繪製，不會呼叫任何徽章服務。
