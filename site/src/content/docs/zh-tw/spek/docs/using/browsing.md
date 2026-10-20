---
title: 瀏覽
description: spek 的各個畫面 —— 總覽、spec、change、schema、關係圖、時間軸 —— 與搜尋。
sidebar:
  order: 1
---

每一種 spek 的導覽都一樣：**Overview**、**Specs**、**Changes**、**Graph**、**Schemas**、**Timeline**，再加上搜尋。

## 總覽（Overview）

總覽列出 spec、進行中 change 與已封存 change 的數量，也顯示 task 完成率、已封存 change 的平均生命週期，以及有幾個進行中的 change 已經停滯（建立超過 30 天）。下方依序是進行中的 change 與各自的 task 進度，以及最近封存的 change。

## Spec

所有 spec 以資料夾樹呈現，依 `openspec/specs/` 在磁碟上的巢狀結構排列，並可篩選。spec 打開後是一份大綱：requirement 與 scenario 可以就地收合，規範性關鍵字（SHALL、MUST）與 scenario 步驟（WHEN、GIVEN、THEN、AND）都有標示。每份 spec 也有歷史紀錄，由新到舊列出動過它的 change。

## Change

列出進行中與已封存的 change。每一列標出建立日期與生命週期，已封存的 change 另外標出封存日期。change 打開後，它的每個 artifact（proposal、design、tasks、specs 等）各佔一個分頁。分頁可以依最後修改時間、工作流程 schema 定義的順序，或 A–Z 排列。delta spec 的每個操作（ADDED、MODIFIED、REMOVED、RENAMED）都有標籤；task 清單顯示勾選框，並依段落呈現進度。

## 關係圖（Graph）

呈現 spec 與 change 之間的關係：每個 change 都連到它的 delta 所動到的 spec。

## Schema

列出 repository 可用的所有工作流程 schema，標出各自的來源與定義的 artifact。schema 打開後是一張流程圖：artifact 依相依順序排列，每個都標出產生的檔案、撰寫前需要什麼，以及撰寫指示。repository 的預設 schema 會特別標示，每個 schema 也連到正在使用它的進行中 change。

## 時間軸（Timeline）

所有 change 的生命週期排成一張橫向的甘特圖：已封存的 change 是從建立到封存的長條，進行中的則延伸到今天。change 可以依 spec 主題分組，也可以隱藏進行中或已封存的 change。

## 搜尋

`Ctrl+K`（macOS 上是 `Cmd+K`）搜尋所有 spec 與 change 的內文。

## 主題

spek 有深色與淺色兩種主題，用頁首的按鈕切換。
