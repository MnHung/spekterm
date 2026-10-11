---
title: 安裝
description: 下載 Linux 版（AppImage）的 spekterm，然後啟動它。Apple Silicon 的 macOS 版正在測試中。
sidebar:
  order: 1
---

spekterm 提供 x86_64 的 Linux 版本，以 AppImage 發佈（一個檔案就能執行，不必在系統裡安裝任何東西）；
Apple Silicon 的 macOS 版本以磁碟映像檔（`.dmg`）發佈，目前正在測試中、尚未發佈。Windows 與 Intel Mac 尚未支援。

## 系統需求

- **x86_64 的 Linux。** AppImage 需要 `libfuse2` 才能執行。Ubuntu 22.04 起預設不再安裝它 ——
  見[AppImage 無法啟動時](#appimage-無法啟動時)。
- **macOS 12（Monterey）以上、Apple Silicon 的 Mac**，等 macOS 版發佈之後 —— 目前正在測試中。
  見[在 macOS 上安裝](#在-macos-上安裝)。
- **Claude Code**（agent session 需要）：`claude` 指令必須在你的 `PATH` 上。spekterm 執行的是真正的
  CLI，用的是你自己的登入與訂閱；它不會向你要 API key。只用 shell session 的話不需要它。
- **OpenSpec** 是選用的。側欄直接讀取 repo 裡的 `openspec/` 目錄；少數細節（例如一個 change 的
  artifact 順序）在你裝了 `openspec` CLI 時才取自它。沒有 `openspec/` 目錄的 repo，照樣有終端與
  「檔案」檢視。

## 在 Linux 上下載並執行

1. 打開[最新版本](https://github.com/spekhq/spekterm/releases/latest)，下載
   `Spekterm-<version>.AppImage`。
2. 設成可執行並啟動：

   ```bash
   chmod +x Spekterm-<version>.AppImage
   ./Spekterm-<version>.AppImage
   ```

第一次啟動會看到一個空的工作區。接著看[你的第一個工作區](/zh-tw/docs/getting-started/first-workspace/)。

spekterm 在啟動時讀一次你的 shell 環境（login shell 的 `PATH`，以及 agent session 需要的變數）。
改了 `.zshrc` 或 `.bashrc` 之後，要重開 spekterm，新的 session 才會看到改動。在 macOS 上，關掉視窗
並不會結束 spekterm：要用 `Cmd+Q` 結束它，再重新打開。

## AppImage 無法啟動時

如果看到 `dlopen(): error loading libfuse.so.2` 之類的錯誤，表示 AppImage 無法掛載自己。
可以安裝那個函式庫：

```bash
sudo apt install libfuse2
```

或是不經 FUSE 執行 AppImage（它會先解開到暫存目錄）：

```bash
./Spekterm-<version>.AppImage --appimage-extract-and-run
```

兩種都可以；裝了 `libfuse2`，每次啟動會比較快。其他問題與解法見[疑難排解](/zh-tw/docs/help/troubleshooting/)。

## 加進應用程式選單

在 Linux 上，AppImage 放在哪裡就從哪裡執行。如果你從原始碼建置 spekterm，repo 裡有一個指令會把建好的
AppImage 裝進 `~/.local/bin`，並在桌面環境的應用程式選單加上一個帶圖示的項目：

```bash
git clone https://github.com/spekhq/spekterm.git
cd spekterm
npm install
npm run build && npx electron-builder --linux   # → release/Spekterm-<version>.AppImage
npm run install:desktop                          # → ~/.local/bin + 應用程式選單
```

建置需要 Node.js 22。第一次打包會下載 Electron 的執行檔，所以需要網路。要移除選單項目與安裝的那一份，
執行 `npm run uninstall:desktop`。

這個指令適用於 Linux。macOS 上不需要另外加什麼：把 spekterm 拖進「應用程式」就是安裝。

## 在 macOS 上安裝

:::note[測試中]
macOS 版還沒有放上發佈頁面。以下步驟描述的是它發佈時的樣子。
:::

1. 打開[最新版本](https://github.com/spekhq/spekterm/releases/latest)，下載
   `Spekterm-<version>-arm64.dmg`。
2. 打開 dmg，把 **Spekterm** 拖進 **應用程式**（Applications）。安裝就只有這一步。
3. 從「應用程式」打開 spekterm。第一次 macOS 會擋下它 —— 見下一節。

### 第一次啟動

spekterm 沒有經過 Apple 公證（notarization）：那需要付費的 Apple Developer ID，而這個專案沒有。
app 改以 ad hoc 方式簽章，所以第一次打開時，macOS 會以「來自未識別的開發者」為由擋下它。允許一次即可：

- **macOS 14（Sonoma）及更早的版本：**在「應用程式」裡按住 Control 點一下（或按右鍵）Spekterm，選
  **打開**，再在對話框裡按一次 **打開**。也可以先照常打開它一次，再到 **系統設定 → 隱私權與安全性**
  按 **強制打開**（Open Anyway）。
- **macOS 15 以後**沒有 Control 點一下這條路了。先試著打開 spekterm 一次，再到 **系統設定 →
  隱私權與安全性** 按 **強制打開**（Open Anyway），並輸入密碼確認。

每安裝一個版本，這件事只會發生一次。

### macOS 說 app 已損毀時

如果 macOS 說 Spekterm「已損毀，無法打開」，把瀏覽器加在下載檔上的隔離標記移除，再打開一次：

```bash
xattr -dr com.apple.quarantine /Applications/Spekterm.app
```

### 以 spekterm 之名跳出的隱私權提示

session 裡執行的程式所引發的隱私權提示，macOS 會算在 spekterm 頭上。例如一個讀取家目錄底下檔案的
agent，可能讓 macOS 詢問是否允許 **Spekterm** 取用你的行事曆、照片、聯絡人、提醒事項、桌面、文件或
下載項目。拒絕它們是安全的 —— 除非你有某個 repo 就放在那個受保護的位置：放在「文件」裡的 repo 需要
「文件」的取用權限。

### macOS 上不一樣的地方

- **關掉視窗不會結束 spekterm。** 跟「終端機」與 iTerm2 一樣，關掉視窗會結束每個 session（若有
  session 在執行，會先問你），而 spekterm 繼續在 Dock 裡執行。點它的 Dock 圖示就會重新打開視窗，
  session 以休眠狀態回來。spekterm 沒有視窗地執行時，收件匣照常收件；若設定了 Slack，也照樣每五分鐘
  檢查一次提及。要結束它，用 `Cmd+Q` 或 **Spekterm → 結束 Spekterm**；見
  [終端機與 session](/zh-tw/docs/using/terminals-and-sessions/#在-macos-上關閉與結束)。
- **精簡的選單列**：**Spekterm** 選單（關於、隱藏、隱藏其他、顯示全部、結束）與 **編輯** 選單
  （還原、重做、剪下、拷貝、貼上、全選）。沒有 `Cmd+W`；關閉 session 跟 Linux 上一樣用
  `Ctrl+Shift+W`。

macOS 上已知的限制：

- 還原的 shell 會在它的資料夾重新啟動，而不是在它最後的目錄。關閉時的對話框會寫明這一點。
- 狀態列不顯示 focused session 的工作目錄與它的 git 狀態。
- 閒置的 shell 永遠不會被自動休眠。手動休眠照常可用。
- 字型設定只提供系統預設的等寬字型。
- `Ctrl+↑` / `Ctrl+↓`（在 rail 項目之間移動）在 macOS 的預設設定裡被「指揮中心」與「App Exposé」
  拿走了。要在 spekterm 裡使用它們，到 **系統設定 → 鍵盤 → 鍵盤快速鍵 → 指揮中心** 把那些快速鍵關掉。
- 沒有整合進桌面的指令（`npm run install:desktop` 是給 Linux 的）；把 app 拖進「應用程式」就是安裝。

## spekterm 把資料放在哪裡

spekterm 記得的一切 —— 資料夾清單、session、側欄的位置、偏好設定、收件匣 —— 都在同一個目錄：

- Linux 上是 `~/.config/Spekterm`；
- macOS 上是 `~/Library/Application Support/Spekterm`。

它不會往你的 repo 裡寫任何東西。刪掉那個目錄，spekterm 就回到剛安裝的狀態；你的程式碼不受影響。

## 更新

目前還沒有自動更新。從[最新版本](https://github.com/spekhq/spekterm/releases/latest)下載新版：
Linux 上，執行新的 AppImage 取代舊的那一個；macOS 上，把新的 Spekterm 拖進「應用程式」取代舊的，
並像第一次安裝那樣[允許它一次](#第一次啟動)。資料會沿用。**設定 → 關於**會顯示你正在執行的版本。

在 macOS 上，每一個建置對系統來說都是一個新的 app，所以更新之後，macOS 可能會再問一次你先前允許過的
權限，包括那些[隱私權提示](#以-spekterm-之名跳出的隱私權提示)。
