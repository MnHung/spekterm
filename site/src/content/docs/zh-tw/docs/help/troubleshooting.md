---
title: 疑難排解
description: 最常遇到的問題與處理方式。
sidebar:
  order: 1
---

## AppImage 開不起來（Linux）

如果啟動時印出 `dlopen(): error loading libfuse.so.2`，表示系統缺少 AppImage 需要的 `libfuse2`（Ubuntu 22.04 起預設不再安裝）。安裝它：

```bash
sudo apt install libfuse2
```

或不經 FUSE 執行 AppImage：

```bash
./Spekterm-<version>.AppImage --appimage-extract-and-run
```

## 從桌面選單啟動 spekterm 時找不到 `claude`

從桌面選單（或 macOS 上的 Dock、Finder）啟動的程式，不會繼承你在終端機裡的環境。spekterm 在啟動時讀一次你的登入 shell 的環境，並用其中的 `PATH` 尋找 `claude`。所以：

- 確認 shell 的啟動檔有把含有 `claude` 的目錄加進 `PATH`（zsh 是 `.zshrc` 或 `.zprofile`）；
- 改完之後**重新啟動 spekterm**。環境只在啟動時讀一次，開一個新的 session 不夠。在 macOS 上，關掉視窗不會結束 spekterm，要用 `Cmd+Q` 結束它。

## 改了 shell 的環境卻沒有生效

原因相同：spekterm 只在啟動時讀一次你的環境。結束 spekterm 再重新啟動（macOS 上用 `Cmd+Q`；只關掉視窗不夠）。

## 側欄或檔案樹停止更新

在 Linux 上，多半是 inotify 的監看上限太低。這時的錯誤 `ENOSPC` 只會出現在 spekterm 的標準錯誤輸出裡。查看目前的上限：

```bash
cat /proc/sys/fs/inotify/max_user_watches
```

如果是 8192，就調高它：

```bash
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-inotify.conf
sudo sysctl --system
```

## macOS：「無法打開 Spekterm，因為它來自未識別的開發者」

spekterm 沒有經過 Apple 公證，所以 macOS 會擋下它的第一次啟動。允許一次即可：

- **macOS 14（Sonoma）及更早的版本**：在「應用程式」裡按住 Control 點一下（或按右鍵）Spekterm，選 **打開**，再按一次 **打開**。也可以先試著打開它，再到 **系統設定 → 隱私權與安全性** 按 **強制打開**（Open Anyway）。
- **macOS 15 以後**：先試著打開它一次，再到 **系統設定 → 隱私權與安全性** 按 **強制打開**（Open Anyway），並輸入密碼確認。

每安裝一個新版本，都要這樣允許一次。見[在 macOS 上安裝](/zh-tw/docs/getting-started/install/#在-macos-上安裝)。

## macOS：「Spekterm 已損毀，無法打開」

下載的檔案帶著隔離標記。移除標記之後，再打開 spekterm 一次：

```bash
xattr -dr com.apple.quarantine /Applications/Spekterm.app
```

## macOS 詢問是否允許 Spekterm 取用行事曆、照片或文件

spekterm 的 session 裡執行的程式觸發隱私權提示時，macOS 會以 spekterm 的名義詢問。例如，讀取家目錄底下檔案的 agent，可能觸發行事曆、照片、聯絡人、提醒事項、桌面、文件或下載項目的提示。拒絕這些提示是安全的，除非你有 repository 就放在那個受保護的位置：放在「文件」裡的 repository 需要「文件」的取用權限。之後可以在 **系統設定 → 隱私權與安全性** 改變你的選擇。

## 更新之後 macOS 又問了一次權限

對 macOS 來說，spekterm 的每一個建置都是一個新的 app。所以裝了新版之後，macOS 可能會再問一次你先前允許過的權限，包括上面那些隱私權提示。像之前那樣再允許一次即可。

## macOS 上 `Ctrl+↑` / `Ctrl+↓` 沒有反應

在 macOS 的預設設定裡，「指揮中心」與「App Exposé」會在 spekterm 收到之前拿走這兩個鍵。請到 **系統設定 → 鍵盤 → 鍵盤快速鍵 → 指揮中心** 關掉那些快速鍵。

## 我在跑的是哪一份建置？

**設定 → 關於** 會列出版本、建置時間與 commit。到 [GitHub](https://github.com/spekhq/spekterm/issues) 回報問題時，請附上這些資訊。
