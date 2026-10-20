---
title: 快捷鍵
description: spekterm 加上的每一個快捷鍵，以及為什麼有些按鍵留給終端機。
sidebar:
  order: 1
---

不論焦點在終端機、編輯器還是側欄，spekterm 的快捷鍵都有效；只有對話框或選單開著時不作用。終端機幾乎永遠持有焦點，所以 spekterm 會搶在終端機之前攔下這些按鍵。spekterm 用掉的按鍵，不會送進終端機裡執行的程式。

## Session 與 rail

| 快捷鍵 | 動作 |
| --- | --- |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 目前 rail 項目內的下／上一個 session，依分頁順序（可循環）。焦點在側欄的 change 檢視時：下／上一個 artifact |
| `Ctrl+↓` / `Ctrl+↑` | rail 上的下／上一個項目，包含全域項目（可循環）。macOS 請見 [macOS 上](#macos-上) |
| `Ctrl+T` | 開啟建立 session 的選單（可以全程用鍵盤操作） |
| `Ctrl+Shift+W` | 關閉目前的 session |
| `Ctrl+Shift+H` | 讓目前的 session 休眠：行程會結束，session 仍留在 workspace 裡，之後可以喚醒 |
| `Shift+↓` / `Shift+↑` | 把選中的 repository 在 rail 上往下／往上移一格。移進或移出置頂區，就會置頂或取消置頂 |
| `Shift+→` / `Shift+←` | 把目前的 session 在分頁列上移一格 |

## 側欄與檔案

| 快捷鍵 | 動作 |
| --- | --- |
| `Ctrl+Shift+M` | 放大／還原側欄 |
| `Ctrl+P` | 快速開檔（只在側欄持有焦點時） |
| `Ctrl+S` | 儲存開著的檔案 |
| `Esc` | 關閉 overlay、對話框或選單 |

## 終端機

| 快捷鍵 | 動作 |
| --- | --- |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | 複製／貼上 |
| `Ctrl+C` | 一律是中斷，即使畫面上有選取的文字 |

## spekterm 留給終端機的按鍵

- **終端機持有焦點時的 `Ctrl+P`** 交給終端機：Claude Code 用它叫出上一筆歷史。要快速開檔，請先點一下側欄。
- **`Ctrl+C` 絕不挪用。** agent 跑偏時，不論畫面上選取了什麼，都一定要能中斷它。
- **`Ctrl+W` 不挪用**：shell 用它刪除一個字。關閉 session 用 `Ctrl+Shift+W`。
- **在文字欄位裡，`Shift+方向鍵`** 照常選取文字。排序快捷鍵只在文字欄位之外生效。

一個已知的代價：Claude Code 自己的 agents 檢視也用 `Shift+方向鍵`，但在 spekterm 的終端機裡，這組按鍵會拿去排序。

## macOS 上

上面的快捷鍵在 macOS 上都一樣，只有以下差別：

- **終端機的複製與貼上**是 `Cmd+C` 與 `Cmd+V`。`Ctrl+C` 仍然是中斷。
- **存檔**是 `Cmd+S`。
- **`Cmd+Q`**（或 **Spekterm → 結束 Spekterm**）結束 spekterm。有 session 在執行時會先詢問，跟關閉視窗時一樣。
- **沒有 `Cmd+W`。** 關閉 session 跟 Linux 上一樣用 `Ctrl+Shift+W`。
- **`Ctrl+↑` / `Ctrl+↓`** 在 macOS 的預設設定裡歸「指揮中心」與「App Exposé」使用，送不到 spekterm。要在 rail 上使用它們，請到 **系統設定 → 鍵盤 → 鍵盤快速鍵 → 指揮中心** 關掉那些快速鍵。
- 選單列很精簡：**Spekterm** 選單（關於、隱藏、隱藏其他、顯示全部、結束）與 **編輯** 選單（還原、重做、剪下、拷貝、貼上、全選）。編輯選單的快捷鍵在文字欄位裡可用。
