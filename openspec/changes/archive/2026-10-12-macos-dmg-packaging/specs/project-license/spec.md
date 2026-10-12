## MODIFIED Requirements

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
