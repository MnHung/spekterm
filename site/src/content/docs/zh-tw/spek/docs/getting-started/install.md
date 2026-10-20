---
title: 安裝 spek
description: 在 VS Code 或 JetBrains IDE 裡安裝 spek，或從原始碼啟動網頁版。
sidebar:
  order: 1
---

只要 repository 含有 `openspec/` 目錄，spek 就能讀。下面每一種用法都呈現同樣的畫面（[瀏覽](/zh-tw/spek/docs/using/browsing/)）。[GitHub Action](/zh-tw/spek/docs/using/github-action/) 比較特別：它在 CI 裡產出靜態頁面，不在你的電腦上執行。

## VS Code

從 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=kewang.spek-vscode) 安裝 **spek — OpenSpec Viewer**（[Open VSX](https://open-vsx.org/extension/kewang/spek-vscode) 上也有）。需要 VS Code 1.85 以上。

- workspace 的 `openspec/` 目錄含有 `config.yaml`、`specs/` 或 `changes/` 時啟用。
- 活動列的 **spek** 圖示會打開側欄，列出 spec（依資料夾巢狀排列）與 change。點任何一項，就會在完整的檢視面板裡打開。
- 指令：**spek: Open spek**、**spek: Search OpenSpec**、**spek: Open Dashboard**。
- 設定：

  | 設定 | 作用 | 預設 |
  |---|---|---|
  | `spek.aggregateWorktrees` | 顯示 repository 所有 git worktree 的 change | `true` |
  | `spek.aggregateJjWorkspaces` | 實驗性：連 jj workspace 一起顯示 | `false` |

  面板上的範圍切換會寫入這兩個設定；直接改設定，範圍切換也會跟著更新（[Worktree 聚合](/zh-tw/spek/docs/using/worktrees/)）。

## JetBrains IDE

從 [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/30600-spek--openspec-viewer) 安裝 **spek - OpenSpec Viewer**，或在 **Settings › Plugins › Marketplace** 搜尋「spek」。支援 2023.3 以上的 IntelliJ IDEA、WebStorm、PyCharm、PhpStorm、GoLand、RubyMine、CLion、Rider 等 IntelliJ 系列 IDE。

- 專案含有 `openspec/` 目錄時啟用。
- 從右側欄的 **spek** 工具視窗打開，或選 **Tools › Open spek**。
- IDE 有內建瀏覽器（JCEF）時，直接在 IDE 裡顯示；沒有的話，改在預設瀏覽器打開同一個頁面。
- 這個外掛不做 worktree 聚合。

## 網頁版

網頁版從 spek 的原始碼啟動，沒有發佈成套件。需要 [Node.js](https://nodejs.org/) 22 以上與 git。

```bash
git clone https://github.com/spekhq/spek.git
cd spek
npm install
npm run dev
```

打開 `http://localhost:5173`，輸入含有 `openspec/` 目錄的 repository 路徑，就能開始瀏覽。`npm run dev` 會在本機啟動兩個行程：頁面跑在 port 5173，頁面讀資料用的 API 跑在 port 3001（[資料與網路](/zh-tw/spek/docs/reference/data-and-network/)）。

## OpenSpec CLI

spek 自己就能讀 `openspec/`。如果裝了 [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec)，spek 還會向它查詢 repository 的工作流程 schema。沒裝 CLI 時其他功能照常運作，只是 spek 能呈現的 schema 資訊比較少。
