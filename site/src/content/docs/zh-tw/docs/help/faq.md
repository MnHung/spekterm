---
title: 常見問題
description: spekterm 是什麼、不是什麼的常見問題。
sidebar:
  order: 2
---

## 這跟在終端機裡跑 Claude Code 有什麼不同？

你仍然是在真正的終端裡跑 Claude Code —— spekterm 補上一排終端分頁沒有的東西。每個 repo 在 rail 上有自己的位置與 session，終端旁邊則是一塊懂 OpenSpec 的側欄：它顯示 agent 正在做的 change —— proposal、design、tasks 與 specs —— 並在 agent 寫入磁碟時跟著更新。session 也能撐過重新啟動，agent 還能把工作交接給另一個 repo。見 [OpenSpec 側欄](/zh-tw/docs/using/side-panel/)。

## 這跟同時跑很多 agent 的工具有什麼不同？

那些工具著重在同時跑很多個 agent。spekterm 著重在讓每個 session 待在它正在做的 OpenSpec change 旁邊，讓你在 agent 寫程式的同時讀規格。它在真正的終端裡執行真正的 `claude` CLI，從不解析終端畫面；對話檢視是由 agent 自己的對話紀錄組出來的。

## 一定要用 OpenSpec 嗎？

不用。終端、agent session、對話檢視、檔案與收件匣在任何資料夾都能用。只是在沒有 `openspec/` 目錄的資料夾裡，側欄的 OpenSpec 檢視沒有東西可以顯示。

## 可以在 macOS 或 Windows 上用嗎？

macOS 可以：有給 Apple Silicon 的 Mac 用的版本，需要 macOS 12（Monterey）以上。它沒有經過 Apple 公證，
所以第一次啟動要多一個步驟，而且有幾項功能在 macOS 上受限 —— 見[在 macOS 上安裝](/zh-tw/docs/getting-started/install/#在-macos-上安裝)。
Windows 與 Intel Mac 尚未支援。

## 我的程式碼會被送到哪裡嗎？

spekterm 自己不會把你的程式碼送到任何地方。它替你啟動的程式 —— 例如 `claude` —— 會連到它們自己的服務。完整清單見 [資料與網路](/zh-tw/docs/reference/data-and-network/)。

## spekterm 跟 spek 是什麼關係？

[spek](/zh-tw/spek/) 是同一群維護者做的唯讀 OpenSpec 檢視器，有網頁版、VS Code 擴充套件與 JetBrains 外掛。spekterm 用 spek 的引擎（`@spekjs/core`）讀 OpenSpec，側欄裡的關係圖與時間軸也來自 spek（`@spekjs/ui`）。用 spekterm 不需要裝 spek，反過來也一樣；spek 讓你在編輯器或瀏覽器裡讀 spec，spekterm 讓你在 spec 旁邊跑 agent。見 [spek 的文件](/zh-tw/spek/docs/)。

## spekterm 跟 Anthropic 或 OpenSpec 有關係嗎？

沒有。spekterm 是一個獨立的開源專案。Claude Code 是 Anthropic 的產品，OpenSpec 是它自己的專案；spekterm 只是執行它們。

## 要錢嗎？

不用。spekterm 以 MIT 授權開源。Claude Code 用的是你自己的訂閱。
