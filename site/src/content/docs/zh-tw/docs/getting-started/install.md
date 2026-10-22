---
title: 安裝
description: 下載並啟動 spekterm：Linux 用 AppImage，Apple Silicon 的 macOS 用 dmg。
sidebar:
  order: 1
---

spekterm 提供兩種平台的版本：x86_64 的 Linux 版以 AppImage 發佈（單一檔案就能執行，不必在系統裡安裝任何東西）；Apple Silicon 的 macOS 版以磁碟映像檔（`.dmg`）發佈。Windows 與 Intel Mac 尚未支援。

## 系統需求

- **x86_64 的 Linux。** AppImage 需要 `libfuse2` 才能執行，而 Ubuntu 22.04 起預設不再安裝它，請見[AppImage 無法啟動時](#appimage-無法啟動時)。
- **macOS 12（Monterey）以上、Apple Silicon 的 Mac。** 已在 macOS 13（Ventura）與 macOS 27 上測試過。請見[在 macOS 上安裝](#在-macos-上安裝)。
- **Claude Code**（agent session 需要）：`claude` 指令必須在你的 `PATH` 上。spekterm 執行的是真正的 CLI，用的是你自己的登入與訂閱，從不向你要 API key。只用 shell session 的話不需要它。
- **OpenSpec** 是選用的。側欄直接讀取 repository 裡的 `openspec/` 目錄；少數細節（例如 change 的 artifact 順序）要在你裝了 `openspec` CLI 時才會由它提供。沒有 `openspec/` 目錄的 repository，照樣有終端機與「檔案」檢視。

## 在 Linux 上下載並執行

1. 打開[最新版本](https://github.com/spekhq/spekterm/releases/latest)，下載
   `Spekterm-<version>.AppImage`。
2. 設成可執行並啟動：

   ```bash
   chmod +x Spekterm-<version>.AppImage
   ./Spekterm-<version>.AppImage
   ```

第一次啟動會看到一個空的工作區。接著請看[你的第一個工作區](/zh-tw/docs/getting-started/first-workspace/)。

spekterm 只在啟動時讀一次你的 shell 環境（login shell 的 `PATH`，以及 agent session 需要的變數）。改了 `.zshrc` 或 `.bashrc` 之後，要重開 spekterm，新的 session 才會套用改動。在 macOS 上，關掉視窗並不會結束 spekterm：要先用 `Cmd+Q` 結束，再重新打開。

## AppImage 無法啟動時

如果看到 `dlopen(): error loading libfuse.so.2` 之類的錯誤，表示 AppImage 無法掛載自己。你可以安裝那個函式庫：

```bash
sudo apt install libfuse2
```

或是不經 FUSE 執行 AppImage（它會先解開到暫存目錄）：

```bash
./Spekterm-<version>.AppImage --appimage-extract-and-run
```

兩種都可以；裝了 `libfuse2`，每次啟動會比較快。其他問題與解法見[疑難排解](/zh-tw/docs/help/troubleshooting/)。

## 加進應用程式選單

在 Linux 上，AppImage 放在哪裡就從哪裡執行。如果你從原始碼建置 spekterm，repository 裡有一個指令會把建好的 AppImage 裝進 `~/.local/bin`，並在桌面環境的應用程式選單加上一個帶圖示的項目：

```bash
git clone https://github.com/spekhq/spekterm.git
cd spekterm
npm install
npm run build && npx electron-builder --linux   # → release/Spekterm-<version>.AppImage
npm run install:desktop                          # → ~/.local/bin + 應用程式選單
```

建置需要 Node.js 22。第一次打包會下載 Electron 的執行檔，所以需要連網。要移除選單項目與安裝的那一份，請執行 `npm run uninstall:desktop`。

這個指令適用於 Linux。macOS 上不需要另外加什麼：把 spekterm 拖進「應用程式」就是安裝。

## 在 macOS 上安裝

1. 打開[最新版本](https://github.com/spekhq/spekterm/releases/latest)，下載
   `Spekterm-<version>-arm64.dmg`。
2. 打開 dmg，把 **Spekterm** 拖進 **應用程式**（Applications）。安裝就只有這一步。
3. 從「應用程式」打開 spekterm。第一次 macOS 會擋下它 —— 見下一節。

### 第一次啟動

spekterm 沒有經過 Apple 公證（notarization）：公證需要付費的 Apple Developer ID，而這個專案沒有。app 改以 ad hoc 方式簽章，所以第一次打開時，macOS 會以「來自未識別的開發者」為由擋下它。允許一次即可：

- **macOS 14（Sonoma）及更早的版本**：在「應用程式」裡按住 Control 點一下（或按右鍵）Spekterm，選 **打開**，再在對話框裡按一次 **打開**。也可以先照常打開它一次，再到 **系統設定 → 隱私權與安全性** 按 **強制打開**（Open Anyway）。
- **macOS 15 以後**沒有按住 Control 點一下這條路了。先試著打開 spekterm 一次，再到 **系統設定 → 隱私權與安全性** 按 **強制打開**（Open Anyway），並輸入密碼確認。

每安裝一個版本，這件事只會發生一次。

### macOS 說 app 已損毀時

如果 macOS 說 Spekterm「已損毀，無法打開」，把瀏覽器加在下載檔上的隔離標記移除，再打開一次：

```bash
xattr -dr com.apple.quarantine /Applications/Spekterm.app
```

### 以 spekterm 之名跳出的隱私權提示

spekterm 的 session 裡執行的程式觸發隱私權提示時，macOS 會以 spekterm 的名義詢問。例如讀取家目錄底下檔案的 agent，可能讓 macOS 詢問是否允許 **Spekterm** 取用你的行事曆、照片、聯絡人、提醒事項、桌面、文件或下載項目。拒絕這些提示是安全的，除非你有 repository 就放在那個受保護的位置：放在「文件」裡的 repository 需要「文件」的取用權限。

### macOS 上不一樣的地方

- **關掉視窗不會結束 spekterm。** 和「終端機」、iTerm2 一樣，關掉視窗會結束每個 session（有 session 在執行時會先問你），spekterm 則繼續在 Dock 裡執行。點它的 Dock 圖示就會重新打開視窗，session 會以休眠狀態還原。spekterm 在沒有視窗的狀態下執行時，收件匣照常收件；若設定了 Slack，也照樣每五分鐘檢查一次提及。要結束 spekterm，請用 `Cmd+Q` 或 **Spekterm → 結束 Spekterm**；見[終端機與 session](/zh-tw/docs/using/terminals-and-sessions/#在-macos-上關閉與結束)。
- **精簡的選單列**：**Spekterm** 選單（關於、隱藏、隱藏其他、顯示全部、結束）與 **編輯** 選單（還原、重做、剪下、拷貝、貼上、全選）。沒有 `Cmd+W`；關閉 session 和 Linux 上一樣用 `Ctrl+Shift+W`。

macOS 上已知的限制：

- 還原的 shell 會在它的資料夾重新啟動，而不是回到最後所在的目錄。關閉時的對話框會說明這一點（[#67](https://github.com/spekhq/spekterm/issues/67)）。
- 狀態列不會顯示 focused session 的工作目錄與 git 狀態（[#67](https://github.com/spekhq/spekterm/issues/67)）。
- 閒置的 shell 不會自動休眠。手動休眠照常可用（[#68](https://github.com/spekhq/spekterm/issues/68)）。
- 字型設定只提供系統預設的等寬字型（[#69](https://github.com/spekhq/spekterm/issues/69)）。
- `Ctrl+↑` / `Ctrl+↓`（在 rail 項目之間移動）在 macOS 的預設設定裡由「指揮中心」與「App Exposé」佔用。要在 spekterm 裡使用，請到 **系統設定 → 鍵盤 → 鍵盤快速鍵 → 指揮中心** 把那些快速鍵關掉（[#71](https://github.com/spekhq/spekterm/issues/71)）。
- 沒有整合進桌面的指令（`npm run install:desktop` 是給 Linux 的）；把 app 拖進「應用程式」就是安裝。

## spekterm 把資料放在哪裡

spekterm 記得的一切，包括資料夾清單、session、側欄的位置、偏好設定與收件匣，都放在同一個目錄：

- Linux 上是 `~/.config/Spekterm`；
- macOS 上是 `~/Library/Application Support/Spekterm`。

spekterm 不會往你的 repository 裡寫任何東西。刪掉那個目錄，spekterm 就回到剛安裝的狀態，你的程式碼不受影響。

## 更新

spekterm 會在啟動一分鐘後、之後每六小時向 GitHub 查詢是否有新版本。**設定 → 關於**會顯示你正在執行的版本、上一次檢查的結果，以及**立即檢查**。要停止自動檢查，在那裡關掉**自動檢查更新**；**立即檢查**仍然可以用。

**在 Linux 上**，如果 spekterm 是從一個你有權寫入其資料夾的 AppImage 執行的（`npm run install:desktop` 會把它放在 `~/.local/bin`），它會在背景下載新版本，就緒時以一則通知告訴你一次。在**設定 → 關於**選**重新啟動以更新**：spekterm 會先詢問，就和有 session 在執行時關閉視窗一樣，接著替換 AppImage，並帶著你的 session 重新啟動。如果你一直沒選，更新會在你下一次關閉視窗時安裝（自動檢查開著的話）；登出或 spekterm 被訊號結束時不會安裝。如果你把 AppImage 改成帶版本號的檔名，新版本會以它自己的版本號檔名存在旁邊，舊檔案會被移除，所以指向舊檔名的啟動器需要跟著改。

**在 macOS 上**，以及在無法替換自己的 Linux AppImage 上（資料夾無法寫入，或是以 `--appimage-extract-and-run` 啟動），spekterm 只會告訴你有新版本。**下載**會打開那個版本的頁面；請照第一次安裝的方式安裝：Linux 上，改為執行新的 AppImage，取代舊的那一個；macOS 上，把新的 Spekterm 拖進「應用程式」取代舊的，並[允許它一次](#第一次啟動)。資料會沿用。

在 macOS 上，每個建置對系統來說都是新的 app，所以更新之後，macOS 可能會再問一次你先前允許過的權限，包括那些[隱私權提示](#以-spekterm-之名跳出的隱私權提示)。
