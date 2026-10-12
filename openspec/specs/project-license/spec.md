# project-license Specification

## Purpose
宣告 spekterm 以 MIT 授權開源，並確保這個宣告在版控的每一處、以及被出貨的產物裡都一致成立 —— 公開的程式碼若沒有
一致的授權宣告，在法律上的預設是「不得使用」，而一處殘留的保留權利聲明就足以讓人不敢用。

## Requirements

### Requirement: 專案以 MIT 授權，且各處的授權宣告一致

repo 根目錄 SHALL 有一份 `LICENSE`，內容為 MIT License 全文，著作權人為 `Kewang`。

所有宣告授權的位置 SHALL 宣告同一份授權：`package.json` 的 `license` 欄位 SHALL 為 `MIT`；README 的授權段落
SHALL 寫明 MIT 並指向 `LICENSE`。

`package.json` 的 `private: true` SHALL 維持不變 —— 它的語意是「不發佈到 npm」，與授權無關（`app-identity`）。

#### Scenario: 根目錄有 MIT 授權檔

- **WHEN** 讀取 repo 根目錄的 `LICENSE`
- **THEN** 它是 MIT License 全文，且著作權行寫明 `Kewang`

#### Scenario: package.json 宣告 MIT 且仍不發佈到 npm

- **WHEN** 讀取版控中的 `package.json`
- **THEN** `license` 為 `MIT`，且 `private` 仍為 `true`

#### Scenario: README 寫明授權

- **WHEN** 讀取 README 的授權段落
- **THEN** 它寫明 MIT，並指向 `LICENSE`

### Requirement: 版控中不得殘留限制性授權的宣告

repo 中的檔案 SHALL NOT 含有宣告限制性授權或自稱不開源的字樣。禁字清單如下，英文不分大小寫：

- `All rights reserved`、`proprietary`、`closed source`、`closed-source`、`UNLICENSED`
- `專有授權`、`保留所有權利`、`非開源`、`私有 repo`、`商業版`

檢查的範圍 SHALL 為版控追蹤的檔案**加上**尚未追蹤、但未被 `.gitignore` 忽略的檔案 —— 一份還沒加進版控的新文件，
正是最容易把舊說法寫回來的地方。

排除 SHALL 恰為以下三處，不多不少：

- `openspec/changes/archive/**` —— 歷史紀錄，記載的是當時的授權。
- `openspec/changes/open-source-mit/**` —— 本 change 的目錄。它的 proposal、design、tasks 必須談論被移除的
  說法；封存之後它搬進 archive，由上一條涵蓋。
- `openspec/specs/project-license/spec.md` —— 本規格封存後的位置。一份說「不得含有 X」的規格必須寫出 X，那是
  自我指涉，不是殘留。

`CLAUDE.md`、README、`docs/`、`scripts/` 與產品程式碼一律受檢。那些文件若要談論專案過去的授權，SHALL 繞開
上述字面。描述**其他產品**的授權同理（競品分析裡寫別家的授權，換一種說法）。

#### Scenario: 限制性授權的字樣不殘留

- **WHEN** 在檢查範圍內搜尋禁字清單，套用上述三處排除
- **THEN** 沒有任何命中

#### Scenario: 排除恰為宣告的三處

- **WHEN** 讀取守衛實際使用的排除清單
- **THEN** 它恰為上述三處，不多不少

#### Scenario: 每一個禁字的搜尋都確實有效

- **WHEN** 在**不排除**規則定義處的情況下，逐一搜尋禁字清單中的每一個字
- **THEN** 每一個字都命中規則定義處 —— 一個永遠零命中的搜尋等於沒有檢查
- **AND** 守衛使用的禁字清單與規則定義處列出的清單相同

#### Scenario: archive 未被改寫

- **WHEN** 在**不排除** `openspec/changes/archive/**` 的情況下搜尋同一批禁字
- **THEN** archive 之下仍有命中

### Requirement: 被出貨的產物附帶本身與第三方的授權文字

MIT 授權要求散布的副本附上授權聲明，產物裡被打包的第三方套件的授權同樣如此要求。專案產出的桌面產物 SHALL 在
產物根目錄帶著：

- spekterm 的 `LICENSE`，內容與版控中的 `LICENSE` 逐位元組相同；
- 一份第三方授權彙總，涵蓋**每一個被打包進產物的第三方套件** —— 被打進 bundle 的，與以原樣隨產物出貨的依賴都
  算。每一個套件列出名稱、版本、授權識別與授權全文（含套件自附的第三方聲明檔）；套件本身未附授權全文者，SHALL
  列出它宣告的授權識別並註明未附全文。
- 被打包的原始檔裡標明授權的保留註解。**打包會剝掉這些註解**，而被其他套件內嵌的第三方原始碼在
  `node_modules` 裡不是獨立的套件，它的授權常常只寫在那段註解裡。
- Electron's licence and Chromium's licence notices, which the Electron distribution ships beside its
  binary. The application is built on that binary, and these texts are not in the third-party summary.

**"The artifact root" is defined per platform**, as the place inside the artifact where the platform keeps
files that are not code:

- the AppImage's root on Linux;
- `Contents/Resources/` in the macOS application bundle. A file at the top of `Contents/` makes signing
  fail, and a file beside the bundle in the disk image would not travel with the application once it is
  copied to Applications.

#### Scenario: 產物內含與版控相同的授權文字

- **WHEN** 檢視執行中的桌面產物的根目錄
- **THEN** 其中的 `LICENSE` 與版控中的 `LICENSE` 逐位元組相同

#### Scenario: 產物內含第三方授權彙總

- **WHEN** 檢視執行中的桌面產物的根目錄
- **THEN** 其中有一份第三方授權彙總，且被打進 renderer bundle 的套件（例如 `react`、`monaco-editor`、
  `@xterm/xterm`）與原樣出貨的依賴（例如 `i18next`、`node-pty`）都在其中，各自帶著授權全文

#### Scenario: 內嵌的第三方原始碼的聲明被保留

- **WHEN** 檢視產物裡的第三方授權彙總
- **THEN** 其中有 `monaco-editor` 內嵌的 DOMPurify 的授權聲明 —— 它不是獨立套件，而打包後的程式碼裡已經沒有
  這段註解

#### Scenario: 彙總涵蓋每一個被打包的套件

- **WHEN** 以建置工具之外的獨立來源（sourcemap 的來源清單）列出 bundle 裡的第三方套件，與彙總比對
- **THEN** 前者的每一個套件都出現在彙總中

#### Scenario: The AppImage carries Electron's and Chromium's licence texts

- **WHEN** the root of the running AppImage is inspected
- **THEN** it contains Electron's licence and Chromium's licence notices

#### Scenario: The macOS bundle carries every licence text

- **WHEN** `Contents/Resources/` of the application bundle copied out of the disk image is inspected
- **THEN** it contains `LICENSE` byte-identical to the one in version control, the third-party summary,
  Electron's licence, and Chromium's licence notices, and the top of `Contents/` contains no licence file

### Requirement: 貢獻與贊助的條件寫在版控裡

repo 根目錄 SHALL 有一份 `CONTRIBUTING.md`，SHALL 寫明：

- 對本 repo 的貢獻依 MIT 授權提供（與專案本身的授權相同）；
- 贊助是給維護者個人的支持，不是專案共有的基金，不依貢獻分配。

A sponsorship entry point (`.github/FUNDING.yml`, and sponsor links in the READMEs) SHALL exist only while
the maintainer has an active GitHub Sponsors profile. A sponsor button that leads to a page that doesn't
exist is worse than no button. When it exists, `.github/FUNDING.yml` SHALL name the GitHub Sponsors account
`kewang`, and the READMEs SHALL link only to that account.

#### Scenario: 貢獻說明寫明兩項條件

- **WHEN** 讀取 `CONTRIBUTING.md`
- **THEN** 它寫明貢獻依 MIT 授權提供，且寫明贊助歸維護者、不依貢獻分配

#### Scenario: Sponsor links appear only together with FUNDING.yml

- **WHEN** the READMEs are read
- **THEN** they link to a GitHub Sponsors page only if `.github/FUNDING.yml` exists, and then only to the
  account it names
