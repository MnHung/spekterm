---
title: 設定
description: 「設定」對話框能改什麼，以及 Slack 連線在哪裡設定。
sidebar:
  order: 2
---

從最左邊活動列的 **設定** 開啟。按下 **儲存** 才會生效；**回到預設** 會把終端相關的設定還原。

## 語言

介面語言（英文或繁體中文）。立即生效。spekterm 寫給 agent 讀的文字維持英文。

## 終端

- **字型** —— 系統上安裝的任何等寬字型；留空即系統預設。在 macOS 上，清單只提供系統預設的等寬字型。
- **字型大小** 與 **行高** —— 留空即預設值。
- **GPU 加速** —— 以 GPU 繪製終端。若終端在你的機器上顯示不正確，把它關掉。
- **預覽** —— 以選定的字型顯示一段範例，包含容易混淆的字元。

## 在狀態列顯示 agent 狀態

請 `claude` 把它的模型、context 用量與花費回報給 spekterm，顯示在狀態列。你自己的 Claude Code
status line 照常運作。只對此後建立的 session 生效。

## 讓閒置的 session 休眠

閒置超過選定時間的 session 會結束它的行程 —— 可選關閉、4 小時、24 小時（預設）、3 天或 7 天 ——
但仍留在 workspace 裡，之後可以喚醒。畫面上正在顯示的 session、正在工作的 agent、正在跑工作的 shell
都不會被休眠。在 macOS 上，閒置的 shell 永遠不會被自動休眠。見 [終端與 session](/zh-tw/docs/using/terminals-and-sessions/)。

## 關於

你正在執行的這份建置的版本、建置時間與 commit —— 回報問題時用得到。

## 遠端存取

一行狀態 —— 關閉；開啟，以及配對了幾台裝置、其中幾台連線中；或沒有在運作的原因（例如 port 被佔用）—— 以及一個
打開 **遠端存取** 對話框的按鈕，在那裡打開它、配對手機、撤銷裝置。見 [遠端存取](/zh-tw/docs/using/remote-access/)。

## Slack 連線

Slack 連線不在「設定」裡：它在 **交接** 收件匣中設定。見 [收件匣與 Slack](/zh-tw/docs/using/inbox-and-slack/)。
