---
title: 資料與網路
description: spek 讀什麼、執行哪些程式，以及每種用法會連到哪裡。
sidebar:
  order: 1
---

spek 自己沒有帳號、沒有遙測、沒有分析。它讀 OpenSpec 檔案與 git 歷史，從不寫入你的 repository。會連到哪裡，依用法而定。

## 每種用法從哪裡讀 repository

| 用法 | 讀取 |
|---|---|
| VS Code 擴充套件、JetBrains 外掛、網頁版 | 你電腦上的 repository |
| GitHub Action | GitHub Actions runner 上取出的 repository |
| 靜態頁面（action 的產出、線上 demo） | 建置當時嵌進頁面的快照 |

## 連線

| | 向 Google Fonts 載入字型 | 渲染後 Markdown 裡的遠端 `https:` 圖片 |
|---|---|---|
| 網頁版 | 會 | 會載入 |
| 靜態頁面（action 產出、線上 demo） | 不會 —— 字型直接內嵌在頁面裡 | 會載入 |
| VS Code 擴充套件 | 不會 | 擋下（面板的內容安全政策） |
| JetBrains 外掛 | 不會 | 會載入 |

除此之外，在你電腦上執行的用法不會向任何外部主機發出請求（GitHub Action 見下文）。你點開的連結會在你的瀏覽器開啟。

## 網頁版的本機伺服器

`npm run dev` 會在你的電腦上啟動兩個行程：port 5173 的頁面，以及它讀資料用的 port 3001 的 API。兩者都只在本機監聽：頁面在 `localhost`，API 在 `127.0.0.1` —— 同一個網路上的其他裝置連不到任何一個。API 只回應這個 app 自己的頁面：發給其他主機名稱的請求、來自其他網頁或網站的請求，它一律拒絕，所以你在同一個瀏覽器裡開著的其他網頁也無法透過它讀取任何東西。它會讀的：你挑選 repository 時瀏覽到的資料夾（為了讓你挑選而列出它們），以及你打開的那個 repository 的 OpenSpec 內容與 git 歷史。

JetBrains 外掛透過 IDE 內建的伺服器提供它的頁面，同樣只回應那個頁面。

## spek 執行的程式

| 程式 | 何時 | 用法 |
|---|---|---|
| `git` | 從歷史判斷 spec 與 change 的日期、列出 worktree、判斷哪個 worktree 推進了某個 change | 網頁版、VS Code、GitHub Action |
| `jj` | 只要裝了 jj 就會執行，用來偵測 jj workspace —— 不論 jj 聚合有沒有打開 | 網頁版、VS Code |
| `openspec` | 有裝時，用來讀 repository 的工作流程 schema | 網頁版、VS Code、JetBrains、GitHub Action |

OpenSpec CLI 預設會送出匿名使用統計，而 spek 執行它時沿用你原本的環境。要關閉：

```bash
openspec config set telemetry.enabled false
```

GitHub Action 執行 CLI 時已經關閉使用統計。

## GitHub Action

action 在你自己的 GitHub Actions 裡執行。它在 `spek-version`（沒設定就是 spek 的主分支）取出 spek 的原始碼，從 npm 安裝 spek 的相依套件與 OpenSpec CLI，然後建置頁面。徽章由 action 自己畫，不會呼叫任何徽章服務。
