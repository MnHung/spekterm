---
title: Worktree 聚合
description: spek 如何顯示 repository 所有 git worktree 的 change，以及實驗性的 jj workspace 支援。
sidebar:
  order: 2
---

一個 repository 常常同時有好幾份工作目錄：每個 agent、每件平行進行的工作，各自在自己的 git worktree 裡、自己的分支上進行。這些工作的 OpenSpec change 分散在各份工作目錄裡，檢視器若只指著其中一份，就只看得到一部分。

spek 會用 `git worktree list` 找出 repository 的所有 worktree，把各自進行中的 change 併成一份清單：

- **所有 worktree 的 change**，各自標出來自哪個分支。主要 worktree 的 change 不加標示，feature 的工作因此更顯眼。
- **一個 change 只佔一列。** 好幾個 worktree 都繼承到的同一個 change 只顯示一次。顯示哪一份由 git 決定（看哪個 worktree 以 commit 或未提交的修改把它推進到主分支之後），不是看檔案時間。
- **已封存的 change** 也從所有 worktree 合併。
- 任何一個 worktree 的 `openspec/` 有變動時，清單會自動更新。

不論 spek 指著哪一個 worktree 或主要的工作目錄，看到的結果都一樣。

## 範圍切換

有不只一份工作目錄時，頁首會出現範圍切換，選項有 **Current dir** 與 **Worktrees**，偵測到 jj workspace 時還有 **Worktrees + jj**。spek 會記住你的選擇：網頁版記在瀏覽器的儲存空間，VS Code 記在 `spek.aggregateWorktrees` 與 `spek.aggregateJjWorkspaces` 設定裡。

## jj workspace（實驗性）

在同時使用 git 與 [jj](https://jj-vcs.github.io/jj/) 的 repository 裡，`git worktree list` 看不到 jj workspace。選 **Worktrees + jj**（或在 VS Code 設定 `spek.aggregateJjWorkspaces`），spek 就會連每個 jj workspace 一起掃描：

- 預設關閉，而且只有存在 jj workspace 時才會出現這個選項。
- 同一個 change 的幾份副本內容相同時，合併成一列。副本已經分歧的 workspace 保留自己的那一列，標示為衝突。workspace 目前正在編輯的 change 會標示為 *editing*。
- jj 從來不是必要條件。沒裝 jj 或選項關閉時，spek 的行為就跟沒有這個功能一樣。

## 哪些用法支援

網頁版與 VS Code 擴充套件會聚合 worktree，JetBrains 外掛不會。
