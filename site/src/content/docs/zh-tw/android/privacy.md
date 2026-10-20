---
title: spekterm for Android 隱私權政策
description: spekterm for Android 會傳送什麼、傳到哪裡，以及在手機上留下什麼。
---

生效日期：2026-10-20。

spekterm for Android（以下稱「本 app」）是桌面工作台 spekterm 的配套 app，原始碼公開：
[github.com/spekhq/spekterm-android](https://github.com/spekhq/spekterm-android)，可從
[Google Play](https://play.google.com/store/apps/details?id=com.spekterm.android) 下載。

**本 app 不會把任何資料傳給開發者或任何第三方。** 本 app 沒有帳號、沒有自己的伺服器，不含分析、廣告或當機回報功能。

## 連線

本 app 只會連到你配對的那台執行 spekterm 的電腦；配對進行中，則連到你選的配對連結或 QR code 裡的位址。連線經由你的區域網路、
Tailscale 或你自行轉發的連接埠，以 TLS 加密，而且本 app 只接受你配對的那台桌機的憑證（指紋來自配對碼），中間任何人——包括本 app
的開發者——都讀不到內容。

## 送到你桌機的東西

你輸入的回覆、你對 agent 的問題或權限請求的回答，以及你附加的照片、PDF 和文字檔，只會送到那台桌機。到了桌機之後怎麼處理，由你的
spekterm 和你在上面執行的 agent 工具決定：AI coding agent 可能會把它們送到它的 AI 服務供應商，適用該供應商的條款。送出前，本 app
會把附件複製到自己的快取（HEIC 照片會轉成 JPEG），這份複本在本 app 的程序結束時刪除。桌機傳給本 app 的 session、對話、收件匣項目和
OpenSpec 檔案只在顯示時留在記憶體中，本 app 不會儲存。

## 相機

相機只用來掃描桌機的配對 QR code。畫面在手機上解碼，不會儲存，也不會傳出去。

## 留在手機上的東西

配對資料（桌機的位址、憑證指紋，以及受手機 Android Keystore 保護的憑證）、少數偏好設定，以及用來排查問題的連線紀錄都留在手機上，
並排除在 Android 備份與裝置轉移之外。連線紀錄記的是連線事件、桌機的位址和各項請求的結果，不含訊息內容、名稱或標題；只有你自己在
設定裡分享時才會離開手機。取消配對會刪除憑證；解除安裝會刪除本 app 存的所有東西。

## 連結

本 app 顯示的內容裡的連結，只有在你點了之後才會用瀏覽器或其他 app 開啟。本 app 本身不會從網路載入圖片或其他內容。

## 權限

| 權限 | 用途 |
|---|---|
| 網路、網路狀態 | 連到你的桌機，並在網路變化時重試 |
| 前景服務（特殊用途） | 讓連到桌機的連線保持開著，桌機的通知才收得到；可以從它的通知暫停 |
| 通知 | 在 agent 需要你、交接完成或收件匣有新項目時通知你 |
| 相機 | 掃描配對 QR code |
| 開機後執行 | 手機重新開機後重新連線 |
| `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | 由 AndroidX 函式庫加入，讓本 app 內部的廣播只在本 app 內傳遞 |

## 兒童

本 app 的對象是開發軟體的成年人，並非以兒童為對象。

## 變更

本政策的變更會公布在這一頁，並更新日期。

## 聯絡方式

請到 [github.com/spekhq/spekterm-android/issues](https://github.com/spekhq/spekterm-android/issues) 開 issue，或寫信到本 app
在 Google Play 商店頁面上列出的電子郵件地址。
