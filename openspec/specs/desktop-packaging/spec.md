## Purpose

把版控中的原始碼變成**可獨立分發、脫離 repo 執行**的桌面產物（Linux 的 AppImage、macOS on Apple Silicon 的 dmg）—— 打包指令與產物形態、
打包設定的宣告位置、native 模組在 asar 中的處置、production 政策在產物中仍然生效，以及開發模式與
產物之間的使用者資料隔離。

這份規格之所以獨立存在，是因為**打包會改變執行環境的形狀，而那些改變的失效幾乎都是靜默或異地的**：
`.node` 的載入走 `dlopen`，需要真實的檔案系統路徑（asar 是唯讀虛擬檔案系統）；重建 native 相依會
反過來綁死 Electron 的 ABI，且問題只在缺 toolchain 的機器上浮現；自桌面環境啟動的行程不繼承使用者
shell profile 的 PATH，而自終端機啟動的驗收看不出這件事；`file://` 的 URL 形狀在打包後改變，
既有的 CSP 覆蓋推論不到它。

因此這份規格反覆做同一件事：**要求以行為判定，而非以檔案存在性或設定欄位替代**，並如實記載每一道
守衛的效力上界。產品身分（`productName`、`appId`、userData 的解析來源）由 `app-identity` 規範，
本規格消費它。

## Requirements

### Requirement: 專案產出可獨立執行的 Linux 桌面產物

專案 SHALL 提供一個打包指令，從版控中的原始碼產出**單一可執行檔**形態的 Linux x64 產物
（AppImage），落於 `release/`。

該產物 SHALL 可在 repo 工作副本之外的任意目錄執行 —— 這正是它存在的理由：**使用 app 與開發 app
必須是兩份互不干擾的東西**。一份仍需 repo 才能執行的產物，等於沒有解決任何問題。

產物 SHALL NOT 進入版控（`release/` 已列於 `.gitignore`）。

#### Scenario: 打包指令產出可執行的 AppImage

- **WHEN** 執行打包指令
- **THEN** `release/` 之下出現一個副檔名為 `.AppImage` 的檔案，且該檔案具備執行權限

#### Scenario: 產物脫離 repo 仍可執行

- **WHEN** 將產物複製到 repo 工作副本之外的目錄並執行
- **THEN** 應用程式視窗成功開啟

### Requirement: 打包設定宣告於 package.json

electron-builder 的設定 SHALL 宣告於 `package.json` 的 `build` 之下，SHALL NOT 外移為獨立的
設定檔（`electron-builder.yml`／`.json`／`.js`）。

理由是**避免製造假綠**：`app-identity` 有一條 scenario 直接讀取版控中的 `package.json` 斷言
`build.appId`。設定一旦外移，那條斷言會**繼續通過** —— `build.appId` 仍在原處，只是
electron-builder 不再讀它，於是驗收與實際生效的設定悄悄脫鉤。

後續 change 若必須外移設定，SHALL 同時更新 `app-identity` 的該條 scenario 與其驗收腳本。

The macOS target is declared in the same place (`build.mac`, `build.dmg`). A packaging command MAY pass
values that depend on the build machine on the command line, such as the path of the verified Electron
archive. It SHALL NOT move any setting that the guard below checks out of `package.json`.

#### Scenario: 打包設定位於 package.json

- **WHEN** 讀取版控中的 `package.json`
- **THEN** `build` 之下存在 Linux 目標設定，且該設定指定 AppImage 為產出形態

#### Scenario: The macOS target is declared in package.json

- **WHEN** `package.json` in version control is read
- **THEN** `build.mac` declares a dmg for `arm64`, an ad-hoc signing identity, and the hardened runtime
  turned off

#### Scenario: 版控中不存在獨立的 electron-builder 設定檔

- **WHEN** 檢查 repo 根目錄
- **THEN** 不存在 `electron-builder.yml`、`electron-builder.json` 或 `electron-builder.config.js`

### Requirement: 打包產物中的 native 模組可載入並 spawn 出真實 pty

打包產物執行時 SHALL 能載入 `node-pty` 並 spawn 出真正的偽終端。

asar 是唯讀的虛擬檔案系統，而 `.node` 的載入走 `dlopen` —— 它需要一個真實的檔案系統路徑。
因此打包產物中的 `node-pty` SHALL 位於 asar 之外，且其 `lib/` 與 `prebuilds/` SHALL 落在同一棵
目錄樹裡（`lib` 以相對路徑解析 `.node`）。

打包設定 SHALL 明示這項要求，**即使打包工具的預設行為已經滿足它** —— 不把「native 模組會落在
asar 之外」這件事繫在第三方工具的隱含行為上：那個行為不出現在我們的設定裡，也就不會在它改變時
發出任何聲音。

**該設定的守衛 SHALL NOT 被詮釋為「少了它產物就會壞」。** 實測（design D3）移除該設定後產物
結構完全相同 —— 打包工具偵測到套件內含 `.node` 就會整包解出。守衛守的是「這個明示不被靜默
拿掉」，僅此而已。**位於 asar 之外這件事本身，由下方的行為 scenario 擔保** —— pty 建立成功
即代表 `dlopen` 成功。

**此要求的驗收 SHALL 以行為判定。** 驗收 SHALL NOT 以「`app.asar.unpacked` 之下存在
`pty.node`」替代：後者是檔案存在性，它在 `dlopen` 因任何其他原因失敗時（glibc 不符、
Electron 的 unpacked 轉向未生效、相依檔未一併解出）**仍會通過**。

行為的判定形式為兩件事：**pty 行程確實存在**，且**送進該 session 的指令確實被執行**。

驗收 SHALL NOT 以「終端畫面上出現指令的輸出」為判準。理由有二，且都與便利無關：

1. **讀畫面的手法綁死 renderer 種類。** 承載文字的 DOM 元素只存在於 DOM renderer；GPU
   renderer 把畫面畫進 canvas 之後它就消失了 —— 而它讀不到時**回空字串**，於是斷言會以
   「畫面上沒有東西」的形狀紅掉，指向錯誤的原因。
2. **那條路徑與打包無關。** pty → 主行程 → IPC → renderer → 終端元件全部是 JavaScript、
   全部住在 asar 內，而「asar 內的 JavaScript 載入正常」已由 renderer 成功載入那條
   requirement 證明。打包唯一能破壞的是 **native 模組的載入**。

「指令被執行」的判定 SHALL 能與「字元僅被回顯」區分 —— 字元送達 pty 但 shell 未執行時，
畫面上一樣看得見那行字。

#### Scenario: 打包產物中建立的 session 產生真實的 pty 行程

- **WHEN** 啟動打包產物並於其中建立一個終端 session
- **THEN** 系統中出現一個由該 app 產生的 shell 行程

#### Scenario: 送進 session 的指令確實被執行

- **WHEN** 對該 session 送出一段會在檔案系統留下副作用的指令
- **THEN** 該副作用出現，且其內容與送出的指令一致

#### Scenario: 打包設定明示 node-pty 須解出 asar

- **WHEN** 讀取 `package.json` 的 `build.asarUnpack`
- **THEN** 其涵蓋 `node-pty` 套件

#### Scenario: asarUnpack 的涵蓋範圍不致使 asar 失去意義

- **WHEN** 以一個純 JavaScript 相依的路徑比對 `build.asarUnpack` 的每一個 pattern
- **THEN** 沒有任何 pattern 匹配它

### Requirement: 打包過程不重建 native 模組

打包過程 SHALL NOT 對 native 相依執行重建。

`native-module-toolchain` 的整條規格建立在「node-pty 是 Node-API 模組，其 prebuilt binary 可同時
被 Node 與 Electron 載入、**無需為 Electron 的 ABI 重建**」之上。而打包工具的預設行為與此相反
——它預設會重建 native 相依。

沿用該預設有兩個代價：打包從此**需要 C++ toolchain**（`native-module-toolchain` 明文要求安裝
不得依賴本地編譯，理由是 Linux 正是優先支援的平台之一）；且重建產出的 binary **反而綁死了
Electron 的 ABI**，使該規格所依賴的跨 runtime 相容性失效。

此設定的失效是**遲滯且異地**的：在具備 toolchain 的機器上打包照樣成功，問題會出現在別人的機器
或 CI 上。

#### Scenario: 打包設定關閉 native 模組重建

- **WHEN** 讀取 `package.json` 的 `build` 設定
- **THEN** 重建 native 相依的選項為關閉

#### Scenario: 打包過程回報未執行重建

- **WHEN** 執行打包並檢視其輸出
- **THEN** 輸出指出已略過相依重建

### Requirement: 打包產物套用 production 內容安全政策

打包產物執行時，其 renderer 收到的 response SHALL 帶有 production 的 Content-Security-Policy
—— 即不含開發模式為 Vite dev server 所做的放寬。

政策的**內容**已由既有驗收覆蓋（切換依 `ELECTRON_RENDERER_URL` 的存在，打包產物與既有探針的
建置模式落在同一個分支）。此處新增的驗收對象是**另一件事**：主行程的 `onHeadersReceived` 對
**asar 內的 `file://` response** 仍然觸發。URL 的形狀在打包後改變了，那不是可以從既有覆蓋推論
出來的。

#### Scenario: 打包產物的 renderer 收到 production CSP

- **WHEN** 啟動打包產物並檢視 renderer 生效中的 Content-Security-Policy
- **THEN** 政策存在，`script-src` 為 `'self'`，且不含任何指向 dev server 的來源

### Requirement: 打包產物載入 renderer 並呈現產品身分

打包產物 SHALL 從 asar 內載入 renderer 並完成呈現。

這同時是 **ESM 進入點在 asar 內解析成功**的證明 —— `package.json` 宣告 `type: "module"`，主行程
產物為 ESM、preload 為 `.mjs`；若解析失敗，應用程式根本開不起來。

#### Scenario: 打包產物開啟視窗並載入 renderer

- **WHEN** 啟動打包產物
- **THEN** 視窗開啟，且其 `document.title` 為 `spekterm`

### Requirement: 打包設定不得靜默退化

專案 SHALL 提供一道併入單元測試層（秒級、隨時可跑）的守衛，斷言打包設定的關鍵欄位仍在。

**此守衛的效力有明確上界，SHALL 被如實記載**：它擋的是「日後某次整理 `package.json` 時把設定
靜默拿掉」。它 SHALL NOT 被詮釋為「打包會成功」或「產物可執行」—— 它連一次打包都沒有執行過。
產物是否真的能用，只有實際打包並執行產物的驗收能回答。

For macOS the guard also checks:

- the ad-hoc identity and the hardened runtime turned off;
- that no file is placed at the top of the bundle's `Contents/`. There is no top-level `extraFiles` entry
  and no `build.mac.extraFiles` entry, because a platform's file set is added to the top-level one, and a
  file there makes signing fail;
- that the macOS packaging command keeps its release check before the build, packages only through the
  step that verifies the Electron archive (never by calling the packager directly), and prunes after it.

#### Scenario: 關鍵設定齊備時守衛通過

- **WHEN** 在打包設定完整的情況下執行單元測試
- **THEN** 該守衛通過

#### Scenario: 移除 asarUnpack 時守衛失敗

- **WHEN** 自 `package.json` 移除 `build.asarUnpack` 的 `node-pty` 涵蓋後執行單元測試
- **THEN** 該守衛失敗

#### Scenario: A top-level extra file fails the guard

- **WHEN** an entry is added to the top-level `build.extraFiles` and the unit tests run
- **THEN** the guard fails, naming the macOS bundle's `Contents/` as the reason

#### Scenario: A macOS extra file fails the guard

- **WHEN** an entry is added to `build.mac.extraFiles` and the unit tests run
- **THEN** the guard fails

#### Scenario: Packaging around the checksum step fails the guard

- **WHEN** the macOS packaging command is changed to call the packager directly instead of the verifying
  step, and the unit tests run
- **THEN** the guard fails

### Requirement: 打包產物於桌面環境啟動時仍能解析使用者的 agent CLI

自**桌面環境**（應用程式選單、檔案管理員、桌面捷徑）啟動的打包產物，其終端 session SHALL 能解析
到使用者 shell profile 所提供的可執行檔路徑 —— 包含 `claude` 本身。

桌面環境啟動的行程只繼承系統預設 PATH，不含使用者 profile 所加入的路徑（nvm、`~/.local/bin`
之屬）。此要求由兩個機制共同承擔，**而它們的涵蓋範圍不同，不可互相替代**：

- **login shell spawn 機制** —— spawn 目標為 login shell 者，其 shell 掛在 pty 上為**互動** shell，
  會讀取只在互動時載入的 rc 檔（`.zshrc`、`.bashrc`）。spawn 目標為 agent CLI 者以**非互動**方式
  執行一個命令，**不**讀取那些 rc 檔，因此**這個機制對 agent CLI 目標的涵蓋範圍僅及於 login rc**。
- **下一條要求的使用者環境取得** —— agent CLI 目標所缺的那一段由它補上。

**該缺口只對「環境可被安全查詢」的情形關閉。** 使用者的 shell 不屬於已知可安全查詢者、或平台為
Windows 時，取得一律放棄，agent CLI 目標於是**退回只涵蓋 login rc** —— 它得以解析到 `claude`，
純粹因為 `claude` 恰好安裝於 login rc 所提供的路徑；若改安裝於僅由互動 rc 初始化的版本管理器之下，
**本要求的 scenario 在那些情形下仍會失敗**。此為已知缺口，追蹤於 issue #31。

agent CLI 目標的完整要求（不限於 PATH）見 `terminal-sessions` 的「agent 目標的 session 環境等同
使用者的互動 shell 環境」及其涵蓋範圍條款。

**此要求 SHALL 以自桌面環境啟動的執行驗收，SHALL NOT 以自終端機啟動的執行替代。** 自終端機執行
產物時，它繼承該終端機的完整 PATH —— 於是兩個機制**有沒有生效完全看不出來**，驗收會在機制失效的
情況下依然通過。

#### Scenario: 自桌面環境啟動後可建立 agent session

- **WHEN** 自應用程式選單或檔案管理員（而非終端機）啟動打包產物，並於其中建立一個 agent session
- **THEN** `claude` 成功啟動並顯示其互動介面

### Requirement: 主行程代表使用者執行的外部程式亦解析使用者的 PATH

主行程本身（非終端 session）代表使用者 spawn 外部程式時，SHALL 能解析到使用者**互動** shell 所提供
的可執行檔路徑，包含只由互動 rc 初始化的版本管理器（nvm 之屬）所提供者。

上一條要求所倚賴的 login shell spawn 機制**對此無能為力** —— 那個機制作用於 pty，主行程自身的
`process.env` 不受它影響。

**取得的範圍 SHALL 為整份使用者環境**（終端 session 需要的不只是路徑，見 `terminal-sessions`），
**但併入主行程 `process.env` 的 SHALL 僅有 `PATH`**。其餘變數 SHALL 只供終端 session 使用，
SHALL NOT 寫入主行程自身的環境。

> **這條分界是承重的，而它由結構而非由名單保證。** 主行程的環境決定應用程式自身的行為 ——
> 使用者資料目錄的落點、開發與正式的政策判定 —— 而那些判定發生在啟動流程中的某個時點，
> 與使用者 rc 的執行速度形成競賽。**已實測：決定這些行為的變數多數在桌面環境啟動時並不存在**
> （`XDG_CONFIG_HOME`、`ELECTRON_*`、`NODE_OPTIONS` 皆不在），因此任何「只在原本不存在時才加入」
> 的規則對它們**一律放行** —— 方向與直覺相反。一份「不可覆寫」的名單則會遺漏尚未存在的變數，
> 而遺漏是靜默的。不寫入主行程環境，這一整類問題便表達不出來。

實作 SHALL 於程序啟動時**一次性**取得，且：

- SHALL 以**互動** shell 取得。非互動 shell 不讀取 `.zshrc` / `.bashrc`，取不到 nvm 之屬所提供的
  路徑，也取不到只在那裡設定的變數。
- 使用者路徑中既有 PATH 所無的項目 SHALL **前置**於既有 PATH，SHALL NOT 附加於其後。附加時外部
  程式雖被解析到，其 `#!/usr/bin/env …` 之類的直譯器仍會解析到系統版本而失敗，**且該失敗與
  「未安裝」無法區分**。
- 既有 PATH 的項目 SHALL NOT 被移除（產物自身注入的路徑必須保留）。它們會被排到使用者路徑之後 ——
  這是刻意的，且**「不移除」不等於「不受影響」**。
- **SHALL 只對已知能以此方式安全查詢的 shell 執行**，其餘一律放棄。未知 shell 對「以互動方式執行
  一個命令」的語意、以及取值方式在其上的可用性皆未經實測，而失效是**靜默**的 —— 取回一份不完整
  或空的環境，沒有錯誤。
- 取值方式 SHALL 使變數的值**不可能**與包夾或分隔的標記混淆。環境變數的值可以包含換行、引號與
  任意可列印字元；以那類字元分隔會讓某一個值裡剛好含有它時**靜默地**截斷或錯位。
- 取回的內容 SHALL 全程以位元組處理，SHALL NOT 於讀取時假定其編碼。環境變數的值是任意位元組，
  以文字編碼讀取會讓非該編碼的值**靜默替換為替代字元**，而解析本身不會出錯。
- SHALL NOT 阻塞視窗建立，SHALL 於逾時後放棄並維持原行為，且 SHALL 於放棄時**確保所生成的子行程
  被收掉**（否則每次啟動可能留下一個等待中的 shell）。
- 取得失敗、逾時、平台或 shell 不支援時，SHALL NOT 使任何功能失效 —— 倚賴它的功能一律有各自的退路。
- 套用 SHALL 只發生在**單一、確定的時點**，SHALL NOT 於某個功能的使用點才套用。在使用點套用會使
  「其他行程有沒有拿到修好的環境」取決於使用者是否先用過那個功能 —— 一個順序相依且靜默的差異。

**此要求 SHALL 以自桌面環境啟動的執行驗收，SHALL NOT 以自終端機啟動的執行替代**（理由同上一條）。

**驗收 SHALL 以「取不到權威順序時所呈現的說明是否出現」判定，SHALL NOT 以 artifact 的排列順序判定。**
排列順序不具鑑別力：可用的 schema 其宣告順序恰與敘事順序相同，於是「權威順序被取用」與「退路頂替」
產生完全相同的畫面。**該說明的有無與順序無關**，是這兩者唯一可觀察的差別。

判讀 SHALL 在啟動後**留出足夠的時間**再進行：資料來源對「取不到」的結果亦有數十秒的快取，啟動早期的
第一次讀取可能落在本要求的機制完成之前。機制真的失效時該說明會**持續存在**，成立時則至多出現於最初
的那段窗口。

自動化驗收 SHALL 涵蓋取值解析與路徑合併的邏輯本身，但 SHALL NOT 被詮釋為「桌面環境啟動下確實解析
得到」。

#### Scenario: 主行程解析得到只由互動 rc 提供的可執行檔

- **WHEN** 自桌面環境啟動打包產物，而某個外部程式只存在於使用者互動 rc 所加入的路徑中
- **THEN** 主行程代表使用者執行該程式時解析得到它

#### Scenario: 使用者的路徑前置而非附加

- **WHEN** 合併使用者 PATH 與既有 PATH
- **THEN** 使用者 PATH 中既有 PATH 所無的項目排在既有項目之前，且既有項目一個都沒有被移除

#### Scenario: 主行程環境除 PATH 外不因使用者環境而改變

- **WHEN** 使用者環境中含有主行程環境所無的變數，且取得成功並套用
- **THEN** 主行程環境中除 `PATH` 之外沒有任何變數被新增或改變

#### Scenario: 值含分隔字元的變數不被截斷

- **WHEN** 使用者環境中某個變數的值含有換行或引號
- **THEN** 該變數以其完整的值被取得，且不影響其他變數的解析

#### Scenario: 無法安全查詢的 shell 一律放棄

- **WHEN** 使用者的 shell 不屬於已知能以此方式安全查詢者
- **THEN** 不變更環境，且不產生錯誤

#### Scenario: 取得失敗不致使功能失效

- **WHEN** 使用者環境無法取得（shell 不可用、逾時、或平台不支援）
- **THEN** 主行程維持原環境繼續運作，倚賴它的功能各自落到其退路

### Requirement: 開發模式與打包產物使用不同的使用者資料目錄

`npm run dev` 啟動的開發模式，其 `app.getPath('userData')` SHALL 解析到與打包產物**不同**的目錄。

此分離 SHALL 由啟動指令本身保證 —— SHALL NOT 僅以文件約定或執行者記得設定環境變數來達成。
需要開發模式的場合（追一支探針抓不到的行為、迭代版面）**正是最不會記得設定環境變數的場合**，
而遺漏的後果是靜默的：兩份執行各自落盤 session 清單，後寫的贏，使用者正在使用的 session 分頁
會消失而其 pty 仍存活。

此分離 SHALL NOT 以修改主行程的路徑解析達成。在主行程判斷「是否為開發模式」需要同時滿足兩個
條件才正確（依 dev server 的存在而非 `app.isPackaged`；命令列已指定使用者資料目錄時不得覆蓋），
而兩者失效時皆無徵狀 —— 後者更會壓掉每一支探針的隔離。

打包產物 SHALL 繼續解析到 `app-identity` 所規範的位置（即以 `productName` 命名的目錄），
使既有的使用者設定為打包產物所沿用。

**On macOS this separation does not hold yet.** Electron does not read `XDG_CONFIG_HOME` on macOS, so
`npm run dev` there resolves to the packaged application's data directory. This is a known gap, tracked as
an issue; the scenarios below are accepted on Linux.

#### Scenario: 開發模式的啟動指令自身宣告了資料目錄的隔離

- **WHEN** 讀取版控中 `package.json` 的 `dev` script
- **THEN** 該指令設定了使 `userData` 解析至他處的環境變數，而非僅在文件中記載該做法

#### Scenario: 該環境變數確實改變 userData 的解析結果

- **WHEN** 於 Linux 上，於設定與未設定該環境變數的兩種情況下各啟動一次 Electron，並讀取
  `app.getPath('userData')`
- **THEN** 兩次解析出不同的路徑，且設定時的路徑位於該環境變數所指的目錄之下

### Requirement: 產物的執行前提與逃生口見於文件

`README` SHALL 記載打包與執行產物所需的前提，以及前提不成立時的逃生口。至少涵蓋：

- 執行 AppImage 需要 `libfuse2`（Ubuntu 22.04 起預設不再安裝）。缺少時的失敗訊息指向動態連結器
  而非套件缺失，讀起來像「這個 app 壞了」。
- 上述情況的逃生口：以 `--appimage-extract-and-run` 執行（不經 fuse）。
- 首次打包需要網路（下載 Electron binary）。
- Building the macOS artifact needs a Mac, a checkout of a release commit, and network access for the
  Electron archive. Where GitHub's download is too slow, `ELECTRON_MIRROR` may point at a mirror. It applies
  to installing the dependencies as well as to packaging, and the
  pinned checksum still applies.
- Trying a macOS build at a commit that is not a release runs the packaging step without the release check,
  and the README
  says that such a build is not a release.

一個只有作者知道的逃生口等於沒有逃生口 —— 而這幾條的共同特徵是**失敗訊息不會指向真正的原因**。

#### Scenario: README 記載執行前提與逃生口

- **WHEN** 閱讀 `README`
- **THEN** 其中記載 `libfuse2` 的前提、`--appimage-extract-and-run` 的逃生口，以及首次打包的網路
  需求

#### Scenario: README states how to build for macOS

- **WHEN** the `README` is read
- **THEN** it states that the macOS artifact is built on a Mac from a release commit, names
  `ELECTRON_MIRROR`, and gives the command for a trial build that is not a release

### Requirement: 專案提供將產物整合進桌面環境的機制

專案 SHALL 提供一個指令，將打包產物安裝為桌面環境的應用程式項目 —— 安裝後該項目 SHALL 出現在
應用程式選單中，且點選它 SHALL 啟動已安裝的產物。

This applies to Linux. On macOS, dragging the application from the disk image to Applications is the
platform's own integration, and the project provides no command for it.

這不只是便利。本規格另有兩條 requirement 明訂其驗收「**SHALL 以自桌面環境啟動的執行驗收，
SHALL NOT 以自終端機啟動的執行替代**」（agent CLI 的解析、主行程的 PATH）——
**沒有一個桌面項目可以點，那兩條就沒有可執行的前提**。

- 安裝的產物 SHALL 位於一個**與打包輸出目錄無關的固定位置**。打包輸出目錄不進版控、會被清除
  重建，且其中的檔名隨版本改變（見 `build-identity`）—— 桌面項目指向它會**靜默失效**：項目仍在
  選單裡，點下去卻沒有反應，或執行到一份早就不是最新的產物。
- 桌面項目所指向的路徑 SHALL NOT 隨版本改變。於是換版只需更新那個固定位置的產物，
  SHALL NOT 需要重寫桌面項目、亦 SHALL NOT 需要使用者記得去確認它還對不對。
- 安裝 SHALL 一併安裝圖示，並使桌面項目指向它 —— 指向一個不存在的圖示時，選單只會顯示一個
  通用的預設圖案，而那個失敗不會有任何訊息。
- 安裝 SHALL 可重複執行（換版即再跑一次），重複執行 SHALL NOT 產生重複的項目或殘留。
- 專案 SHALL 提供對應的**移除**方式。一個裝得上卻卸不掉的東西，使用者不會願意裝第一次。
- 打包產物不存在時，安裝指令 SHALL 明確告知並指出處置，SHALL NOT 產生一個指向不存在檔案的
  桌面項目 —— 後者會製造一個「裝好了但點了沒反應」的狀態，比失敗更難診斷。
- **已安裝的產物正在執行時，安裝 SHALL 仍然成功。** 這不是邊緣情況而是換版流程的常態：使用者
  一邊用著手上這一份、一邊重新打包，然後裝上去。作業系統對「就地覆寫一個執行中的可執行檔」是
  拒絕的，因此安裝 SHALL NOT 倚賴就地覆寫。執行中的那一份 SHALL 不受影響地跑完，其後啟動的
  SHALL 是新的那一份。

#### Scenario: 安裝後桌面項目存在且指向已安裝的產物

- **WHEN** 於已有打包產物的情況下執行安裝指令
- **THEN** 桌面環境的應用程式項目存在，其執行目標為一個實際存在且可執行的檔案

#### Scenario: 桌面項目的執行目標不隨版本改變

- **WHEN** 以兩個不同版本的產物各執行一次安裝指令
- **THEN** 兩次產生的桌面項目其執行目標為同一個路徑

#### Scenario: 打包輸出目錄被清除後已安裝的產物仍可執行

- **WHEN** 執行安裝指令後清除打包輸出目錄，再啟動已安裝的產物
- **THEN** 應用程式視窗成功開啟

#### Scenario: 重複安裝不產生重複的項目

- **WHEN** 連續執行安裝指令兩次
- **THEN** 桌面環境中該應用程式只有一個項目

#### Scenario: 提供移除方式

- **WHEN** 執行移除指令
- **THEN** 該桌面項目與已安裝的產物均不再存在

#### Scenario: 已安裝的產物正在執行時仍可換版

- **WHEN** 已安裝的產物正在執行中，以另一份產物執行安裝指令
- **THEN** 安裝成功，執行中的那一份不受影響，且其後啟動的是新的那一份

#### Scenario: 產物不存在時明確失敗

- **WHEN** 在尚未打包的情況下執行安裝指令
- **THEN** 指令明確報告產物不存在並指出處置，且未產生任何桌面項目

#### Scenario: README 記載安裝與移除

- **WHEN** 閱讀 `README`
- **THEN** 其中記載將產物整合進桌面環境的指令，以及移除的方式

### Requirement: 打包輸出目錄不無限累積產物

版本逐次遞增（見 `build-identity`）之後，每次打包都會在輸出目錄留下一份**新檔名**的產物 ——
在此之前檔名恆定、後一次覆蓋前一次，目錄大小是常數。單一產物逾百 MB，累積是使用者不會主動去看、
直到磁碟告急才發現的那種成本。

打包指令 SHALL 於成功產出之後，只保留**當次與前一次**的產物，並刪除更早的。保留前一次是刻意的：
換版後行為出問題時，退回上一份可執行的產物是第一個處置。

The count is kept **per kind of artifact**. The AppImages and the dmgs are counted separately, so one
platform's artifacts never push out the other's. A dmg's `.blockmap` belongs to its dmg and is deleted
with it.

刪除 SHALL 只涵蓋本專案自己產出的產物檔，SHALL NOT 涵蓋輸出目錄中的其他內容。

**「最近」SHALL 依版本序判定，SHALL NOT 依檔名的字典序。** 兩者在版本號跨越十位數之前完全
一致，其後相反 —— 字典序會把 `0.1.10` 排在 `0.1.9` 之前，於是**剛建好的那一份成為被刪的那一份**。
以逐次遞增計，這在第十次打包就會發生，而症狀是一份剛產出的產物憑空消失。此判定 SHALL 與
「在輸出目錄中挑出當前版本的產物」使用同一套比較。

#### Scenario: 第三次打包後只留下最近兩份產物

- **WHEN** 連續執行打包指令三次
- **THEN** 輸出目錄中本專案同一種產物只剩最近的兩份，最早的那一份已不存在

#### Scenario: 版本號跨越十位數時保留的仍是版本序上最新的兩份

- **WHEN** 輸出目錄中並存的產物其版本跨越十位數（例如 `0.1.8`、`0.1.9`、`0.1.10`、`0.1.11`）
  並執行清理
- **THEN** 保留的是版本序上最新的兩份（`0.1.10` 與 `0.1.11`），而非字典序上排在最後的兩份

#### Scenario: 不刪除輸出目錄中的其他內容

- **WHEN** 輸出目錄中存在一個非本專案產出的檔案，且執行打包指令
- **THEN** 該檔案仍然存在

#### Scenario: Each kind of artifact keeps its own two

- **WHEN** the output directory holds three AppImages and three dmgs with their blockmaps, and pruning runs
- **THEN** the newest two AppImages and the newest two dmgs remain, each remaining dmg still has its
  blockmap, and the oldest dmg's blockmap is gone with it

### Requirement: The project produces an installable macOS artifact

The project SHALL provide a packaging command, run on macOS, that produces a disk image (`.dmg`) for
Apple Silicon (`arm64`) in `release/`, containing the application bundle and a link to the Applications
folder. The bundle SHALL run from any location outside the repository working copy, as the Linux artifact
does. Intel Macs are not a target: no artifact SHALL be produced for an architecture nothing has run.

The command SHALL refuse to run on any other platform, with a message that names the platform it needs.

The bundle SHALL NOT carry Electron's placeholder application (`default_app.asar`). It is never used
when the application's own archive is present, and a release ships only what the application uses.

#### Scenario: The packaging command produces a dmg

- **WHEN** the macOS packaging command is run on a Mac at a release commit
- **THEN** `release/` contains a file named `Spekterm-<version>-arm64.dmg`, and mounting it shows the
  application bundle

#### Scenario: The command refuses another platform

- **WHEN** the macOS packaging command is run on Linux
- **THEN** it exits with an error naming macOS, and produces nothing

#### Scenario: No placeholder application ships

- **WHEN** the bundle inside the dmg is inspected
- **THEN** `Contents/Resources/default_app.asar` does not exist

### Requirement: The macOS bundle carries a signature that seals it

The macOS bundle SHALL be signed ad hoc so that the signature covers the whole bundle: the executables,
the frameworks, the helper applications, the resources, and `Info.plist`. Verifying it strictly and in
depth SHALL succeed, on the copy taken out of the dmg, not only on the build output.

This is what turns a downloaded copy from "damaged" (an unsealed bundle carrying the quarantine flag) into
"from an unidentified developer", which the user can allow once. **It SHALL NOT be described as making
the app open without a warning.** That needs a paid Developer ID and notarization, which this project
does not have.

The bundle SHALL NOT use the hardened runtime. That runtime matters only for notarization, and combined
with an ad-hoc signature it can stop the app from loading its own frameworks.

**Acceptance gaps, settled by dogfood:**

- which dialog a quarantined (downloaded) copy shows. Gatekeeper's command-line assessment rejects any
  app that is not notarized and does not say which dialog the user would see;
- whether updating from one ad-hoc build to the next makes macOS ask again for permissions granted to
  the previous one (notifications, protected folders, keychain items), since each ad-hoc build is a
  different code identity;
- whether notifications from an ad-hoc signed app are shown.

#### Scenario: The dmg's copy verifies

- **WHEN** the bundle is copied out of the mounted dmg and its signature is verified strictly and in depth
- **THEN** verification succeeds

#### Scenario: An unsealed bundle fails the same check

- **WHEN** the same verification is run on a bundle packaged without signing
- **THEN** verification fails, reporting that the bundle's resources are not sealed

### Requirement: The Electron binary in a macOS artifact matches a pinned checksum

The Electron archive that a macOS artifact is built from SHALL match the SHA-256 that the installed
`electron` package publishes for that exact archive, whichever server delivered it. A mirror is allowed
for speed, but a mirror SHALL NOT be trusted to vouch for its own file: the expected hash SHALL NOT come
from the server that served the archive.

The check SHALL run on every build, including when the archive comes from a local cache. A mismatch SHALL
stop the build, naming the archive and stating that its checksum did not match.

#### Scenario: A wrong checksum stops the build

- **WHEN** the expected checksum for the archive is altered and the macOS packaging command runs
- **THEN** it stops before packaging and reports the mismatch

#### Scenario: A mirror delivers a verified archive

- **WHEN** the Electron cache is empty, `ELECTRON_MIRROR` points at a mirror, and the macOS packaging command
  runs
- **THEN** the archive is downloaded from the mirror, matches the pinned checksum, and the build continues

### Requirement: The macOS artifact passes the packaged-artifact acceptance from a desktop launch

The macOS artifact SHALL pass, on a Mac and against the bundle copied out of the dmg, the same behavioral
checks the Linux artifact passes:

- its window opens and the renderer loads from the archive (`document.title` is `spekterm`);
- the production Content-Security-Policy applies;
- a session creates a real pty process, and a command sent to it runs, judged by its side effect on disk.
  This is the same judgment "打包產物中的 native 模組可載入並 spawn 出真實 pty" requires;
- the Settings dialog shows the build identity, whose version equals the version in the dmg's file name,
  whose commit is the release commit, and which reports a clean working tree.

These checks SHALL be run on an application launched with **the environment a Finder or Dock launch
gets**, not the environment of the shell running the acceptance. A launch that inherits the acceptance
shell's `PATH` is the substitute "打包產物於桌面環境啟動時仍能解析使用者的 agent CLI" forbids. On macOS,
launching through `open` from a shell is such a substitute, because `open` passes the caller's
environment on. The minimal environment SHALL be shown to be minimal: in it, `claude` does not resolve.

From that launch, an agent session SHALL start `claude`. If `claude` is not installed on the Mac, that
check SHALL report that it did not run, not that it passed.

The acceptance's processes SHALL be identified by this run's own launch arguments, not by reading other
processes' environments, which macOS does not show.

**Acceptance gap:** that the browser engine opens no connection at startup (`workspace-app-shell`) is
checked on Linux only. Its carrier maps host names to a local listener through Linux-specific means. On
macOS it is not verified.

#### Scenario: The renderer and CSP of the dmg's copy

- **WHEN** the bundle from the dmg is launched from a minimal environment
- **THEN** its window's `document.title` is `spekterm`, and the renderer's policy has `script-src 'self'`
  and no development-server source

#### Scenario: A pty runs a command in the dmg's copy

- **WHEN** a shell session is created in that application and a command with a side effect is sent to it
- **THEN** a pty process exists among the application's descendants, and the side effect appears with the
  content of the command

#### Scenario: The launch environment is minimal

- **WHEN** the environment used to launch the application is checked
- **THEN** `claude` does not resolve in it

#### Scenario: An agent session reaches claude from a desktop launch

- **WHEN** `claude` is installed on the Mac and an agent session is created in that application
- **THEN** a `claude` process appears among the application's descendants

#### Scenario: The dmg's copy states its build identity

- **WHEN** the Settings dialog of that application is opened
- **THEN** its build identity shows the version in the dmg's file name, the release commit, and a clean
  working tree

### Requirement: The documentation states how to install on macOS and what is limited there

The README (both languages) and the website's documentation (both languages) SHALL state, for macOS:

- the minimum macOS version the artifact declares, and the version the acceptance ran on;
- how to allow the app the first time, on the tested version and on macOS 15 and later, where the steps
  changed;
- what to do if macOS still reports the app as damaged (removing the quarantine flag);
- that macOS attributes to spekterm the privacy prompts caused by programs running in its sessions
  (an agent reading under the home directory, for example). The documentation SHALL say that denying them
  is safe unless a repository lives in the protected place it names;
- that updates may ask again for permissions granted before;
- where the application keeps its data on macOS;
- the features that degrade on macOS:
  - restored shells restart in their folder, not their last directory;
  - the status bar shows neither the focused session's working directory nor its git state;
  - idle shells are not hibernated automatically;
  - the font setting offers only the system default monospace font;
  - closing the window leaves the application running, and with it the inbox and Slack polling;
  - `Ctrl+↑` / `Ctrl+↓` are taken by Mission Control and App Exposé in macOS's default settings;
  - there is no command that integrates the app into the desktop; dragging it to Applications installs it.

#### Scenario: The macOS install steps are documented

- **WHEN** the README and the website's install page are read in either language
- **THEN** they state the minimum macOS version, the first-launch allow step, the damaged-app escape, the
  data location, and why privacy prompts name spekterm

#### Scenario: The macOS limitations are documented

- **WHEN** the website's documentation is read in either language
- **THEN** each degraded feature listed above is stated as a macOS limitation
