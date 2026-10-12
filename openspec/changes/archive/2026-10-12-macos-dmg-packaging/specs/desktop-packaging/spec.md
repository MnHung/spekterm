## ADDED Requirements

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

## MODIFIED Requirements

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
