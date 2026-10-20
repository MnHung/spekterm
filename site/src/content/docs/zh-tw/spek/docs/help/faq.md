---
title: 常見問題
description: 關於 spek 的常見問題。
sidebar:
  order: 1
---

## spek 會修改我的檔案嗎？

不會。spek 只讀取：它顯示你的 `openspec/` 目錄與 git 歷史，沒有任何修改的途徑。

## spek 跟 spekterm 是什麼關係？

[spekterm](/zh-tw/) 是在多個 repository 之間跑 Claude Code session 的桌面工作台，側欄顯示每個 session 正在做的 OpenSpec change。那個側欄以 spek 的引擎（`@spekjs/core`）讀取 OpenSpec，並繪製 spek 的關係圖與時間軸（`@spekjs/ui`）。想在平常工作的地方讀 spec，用 spek；想在 spec 旁邊跑 agent，用 spekterm。兩者互不依賴。

## 一定要裝 OpenSpec CLI 嗎？

不用。spek 自己就能讀 `openspec/`；有裝 CLI 的話，spek 能呈現更多工作流程 schema 的資訊。見 [安裝 spek](/zh-tw/spek/docs/getting-started/install/#openspec-cli)。

## 哪些用法會聚合 worktree？

網頁版與 VS Code 擴充套件。JetBrains 外掛不會。見 [Worktree 聚合](/zh-tw/spek/docs/using/worktrees/)。

## spek 跟 Anthropic 或 OpenSpec 有關係嗎？

沒有。spek 是獨立的開源專案。OpenSpec 是另一個專案，spek 只是讀取它的檔案。

## 要錢嗎？

不用。spek 以 MIT 授權開源。
