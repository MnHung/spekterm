## Purpose

Electron app 的最小外殼 —— 主行程開啟視窗、renderer 載入 React 應用、主行程與 renderer 依 PRD §12 信任模型
隔離（`contextIsolation`、preload 白名單）。編輯器套件只能經由單一 wrapper 模組取用，
以確保日後替換編輯器的成本侷限於該模組。其上的所有 UI 都長在這個外殼上。

## Requirements

### Requirement: 主行程開啟應用程式視窗

Electron 主行程 SHALL 在應用程式就緒後建立 `BrowserWindow` 並載入 renderer 入口。

#### Scenario: 啟動應用程式

- **WHEN** 執行開發模式啟動指令，或啟動正式建置後的應用程式
- **THEN** 開啟一個應用程式視窗，視窗成功載入 renderer 入口，且主行程未拋出未捕捉的例外

### Requirement: Renderer 載入 React 應用

renderer SHALL 以 React 19 掛載根元件，且 Tailwind CSS v4 的樣式 SHALL 生效。

#### Scenario: React 根元件掛載

- **WHEN** 視窗完成載入
- **THEN** DOM 中存在 React 掛載的根節點，且畫面呈現可辨識的骨架內容

#### Scenario: Tailwind 樣式生效

- **WHEN** 根元件套用一個 Tailwind utility class
- **THEN** 該元素的 computed style 反映對應樣式，證明 Tailwind v4 已納入 renderer 建置

### Requirement: 主行程與 renderer 依信任模型隔離

`BrowserWindow` SHALL 啟用 `contextIsolation` 並停用 `nodeIntegration`。renderer SHALL NOT 能直接存取 Node.js API。此要求對應 PRD §12 的安全與信任模型。

#### Scenario: webPreferences 設定正確

- **WHEN** 檢查建立視窗時傳入的 `webPreferences`
- **THEN** `contextIsolation` 為 `true`，且 `nodeIntegration` 為 `false`

#### Scenario: renderer 無法存取 Node API

- **WHEN** 於 renderer 求值 `typeof require`
- **THEN** 其值為 `undefined`，renderer 無法直接取用 Node.js 模組系統

### Requirement: 能力僅經由 preload 白名單暴露

主行程能力 SHALL 僅透過 preload 以 `contextBridge` 暴露的具名 API 提供給 renderer。未列於白名單的能力 SHALL NOT 可從 renderer 取得。

#### Scenario: 白名單 API 可用

- **WHEN** renderer 呼叫 preload 經 `contextBridge` 暴露的具名 API
- **THEN** 該 API 可被呼叫並回傳預期結果

#### Scenario: 非白名單能力不可得

- **WHEN** renderer 嘗試存取一個未經 `contextBridge` 暴露的主行程能力
- **THEN** 該能力不存在於 renderer 的全域範圍

### Requirement: 編輯器透過 wrapper 介面存取

編輯器 SHALL 被封裝在單一 wrapper 模組之後。renderer 的其他模組 SHALL NOT 直接 import 編輯器套件，以確保退守替代編輯器時的改動侷限於單一模組。

#### Scenario: 只有 wrapper 直接依賴編輯器套件

- **WHEN** 搜尋 renderer 原始碼中對 `monaco-editor` 的 import 陳述
- **THEN** 僅 wrapper 模組出現該 import，其餘模組一律透過 wrapper 介面取用編輯器

### Requirement: renderer 不得導航離開應用程式來源

主行程 SHALL 阻止 renderer 導航至應用程式自身來源之外的位置，並 SHALL 阻止其開啟新視窗。外部連結 SHALL 改由系統的預設瀏覽器開啟，且主行程 SHALL 在交付之前驗證其協定，僅放行 `http` 與 `https`。

此要求對應 PRD §12 的信任模型，且是引入 markdown 渲染的前提：preload 綁定於 `webContents`，會在該 `webContents` 的每一次導航後重新注入，不分來源。若 renderer 被一個檔案中的連結帶往遠端頁面，該頁面將取得 preload 暴露的全部檔案系統能力 —— workspace folder 的邊界會被完全繞過。

協定驗證 SHALL 在主行程執行。renderer 端的過濾不構成防護。

#### Scenario: renderer 嘗試導航至外部位址

- **WHEN** renderer 中的一個連結被觸發，其目標為應用程式來源之外的位址
- **THEN** renderer 不發生導航，仍停留於原本的頁面

#### Scenario: renderer 嘗試開啟新視窗

- **WHEN** renderer 嘗試開啟一個新視窗
- **THEN** 不建立任何新視窗

#### Scenario: 主行程拒絕不安全協定的外部連結

- **WHEN** 一個協定不屬於 `http` 或 `https` 的外部連結被交付至主行程
- **THEN** 主行程拒絕開啟它

### Requirement: renderer 以內容安全政策約束可載入的資源

主行程 SHALL 對 renderer 施加一份 Content-Security-Policy，限制 renderer 可載入與連線的資源
來源。此政策 SHALL 由主行程施加，而非 renderer 自身於文件中宣告的 `<meta>` —— renderer 渲染的是
不受信任的內容，其自我宣告的約束不構成防護。此要求與 preload 白名單、「renderer 不得導航離開
應用程式來源」同屬 PRD §12 信任模型的一環。

政策 SHALL 阻止 renderer 文件中的 inline script 被執行，並 SHALL 限制 script、object、iframe 與
base-uri 的來源，使任何未來的 XSS 立足點無法升級（載入遠端 script、導航離開、嵌入 iframe、改寫
base-uri）。應用程式自身的 script 皆為打包後的 same-origin 外部檔案。

政策 SHALL NOT 破壞應用程式自身的資源載入（打包後的 same-origin script、Monaco 的編輯器 worker、
以及 Monaco／xterm／Tailwind 於執行期注入的 inline style），亦 SHALL NOT 阻擋 markdown 中合法的
遠端圖片 —— 遠端圖片是 markdown 的正常內容（README 徽章、架構圖、螢幕截圖），為了防一個低嚴重度
的追蹤 beacon 而擋掉它，代價大於效益。

#### Scenario: markdown 中的遠端圖片不被阻擋

- **WHEN** 使用者開啟一個含有遠端 https 圖片（`![](https://…/x.png)`）的 markdown 檔案
- **THEN** 該圖片不觸發內容安全政策的 img-src 違規，可向來源請求載入

#### Scenario: renderer 文件中的 inline script 不被執行

- **WHEN** 一段 inline script 出現在 renderer 的文件中
- **THEN** 它被內容安全政策阻擋，不被執行

#### Scenario: 應用程式自身的編輯器與終端在政策之下正常運作

- **WHEN** 應用程式在內容安全政策之下載入其編輯器與終端
- **THEN** Monaco 的編輯器 worker 完成一次往返，且 Monaco／xterm／Tailwind 注入的 inline style
  生效，介面正常呈現

### Requirement: 編輯器於檔案檢視中載入並提供語法高亮

renderer 於檢視非 markdown 的文字檔案時 SHALL 載入編輯器，且 SHALL 對其內容提供語法高亮 —— 內容中的語法元素 SHALL 被賦予不同的呈現樣式，而非單一樣式。

此 requirement 的載體為 side panel 的檔案檢視。它取代了 Phase 0 以診斷頁為載體、並於 Phase 1 隨診斷頁一併移除的同名 requirement。

#### Scenario: 開發模式下載入編輯器並高亮

- **WHEN** 以開發模式啟動應用程式，並於檔案檢視中開啟一個原始碼檔案
- **THEN** 編輯器完成掛載，且其內容中的語法元素被賦予多於一種的呈現樣式

#### Scenario: 正式建置下載入編輯器並高亮

- **WHEN** 啟動正式建置後的應用程式，並於檔案檢視中開啟一個原始碼檔案
- **THEN** 編輯器完成掛載，且其內容中的語法元素被賦予多於一種的呈現樣式

### Requirement: 編輯器的 worker 於 dev 與 build 兩種模式皆完成一次往返

編輯器的 worker SHALL 於開發模式與正式建置兩種模式下皆能被建立、載入並完成一次與主執行緒的往返。

驗收 SHALL NOT 以「觀察到語法高亮」作為 worker 存活的依據 —— 語法標記在主執行緒完成，worker 未載入時高亮依然存在。驗收 SHALL 觀察一項只可能由 worker 計算得出的結果。

#### Scenario: 開發模式下 worker 完成往返

- **WHEN** 以開發模式啟動應用程式，並於檔案檢視中開啟一個內容含有 URL 的檔案
- **THEN** 該 URL 於編輯器中被標示為連結 —— 此標示只可能由 worker 計算後回填

#### Scenario: 正式建置下 worker 完成往返

- **WHEN** 啟動正式建置後的應用程式，並於檔案檢視中開啟一個內容含有 URL 的檔案
- **THEN** 該 URL 於編輯器中被標示為連結

### Requirement: 編輯器對 renderer bundle 的體積貢獻可量測且可歸因

renderer 的建置產物 SHALL 具備一份體積報告，其中編輯器帶來的資產 SHALL 可被辨識並歸因 —— 報告 SHALL 區分編輯器的核心產物、其 worker 與其各語言的延遲載入資產。

此 requirement 是判斷是否依 PRD §8.3 退守替代編輯器的依據。它取代了 Phase 0 以「與不含 Monaco 的基準相比較」為形式、並於 Phase 1 隨診斷頁一併移除的同名 requirement —— 該形式在編輯器成為產品的一部分之後已無法成立，因為不含編輯器的建置不再是這個應用程式。

#### Scenario: 體積報告可歸因編輯器的貢獻

- **WHEN** 執行 renderer 的體積報告
- **THEN** 報告分別列出編輯器的核心產物、其 worker 資產與其語言資產的體積，且三者之和可與產物總體積相比較

#### Scenario: 各語言的資產為延遲載入

- **WHEN** 檢視 renderer 建置產物中編輯器的語言資產
- **THEN** 每種語言為獨立的資產，SHALL NOT 被合併進主要的載入路徑

### Requirement: 編輯器不引入任何語言服務 worker

renderer 的建置產物 SHALL NOT 包含任何語言服務 worker（TypeScript、JSON、CSS、HTML）。編輯器在本應用程式中承擔的是語法高亮，不是語意分析 —— PRD §6.2 明訂深度改檔走 agent 或使用者自己的 IDE，編輯器不是主編輯區的一級公民。

語言服務 worker 是編輯器體積的主要來源，其中 TypeScript 語言服務單獨即超過整個其餘產物。明文禁止，以免日後為了單一便利而讓它悄悄回到產物中。

#### Scenario: 建置產物不含語言服務 worker

- **WHEN** 檢視 renderer 的正式建置產物
- **THEN** 其中不存在 TypeScript、JSON、CSS 或 HTML 的語言服務 worker 資產

#### Scenario: 語法高亮不依賴語言服務

- **WHEN** 於檔案檢視中開啟一個 TypeScript 檔案
- **THEN** 其語法元素被賦予不同的呈現樣式，且未載入任何語言服務 worker

#### Scenario: 編輯內容不觸發語意診斷

- **WHEN** 使用者於編輯器中輸入一段語法正確但型別錯誤的 TypeScript
- **THEN** 編輯器不呈現任何型別診斷，亦未載入語言服務 worker

### Requirement: 視窗關閉前確認未存的變更

視窗關閉時，若存在任何未存的變更，主行程 SHALL 阻止關閉並要求使用者明確選擇：儲存全部、不儲存並關閉、或取消。未存的變更 SHALL NOT 因視窗關閉而被靜默捨棄。

此判斷 SHALL 於關閉事件中同步完成，SHALL NOT 依賴一次向 renderer 的往返查詢 —— renderer 若未能回應，等同於靜默捨棄，而那正是本 requirement 要防止的。

確認 SHALL 以作業系統的原生對話框呈現。其內容包含使用者 repo 中的檔案路徑，且此刻 renderer 正處於即將關閉的狀態。

**Unsaved changes and running sessions are confirmed in one dialog.** When the user closes the window
while there are unsaved changes **and** running sessions (see "Closing the window while sessions are
running asks for confirmation"), exactly one dialog SHALL be shown. It SHALL list the unsaved files
and the running sessions with what closing loses, and offer saving all and closing, closing without
saving, and cancelling — with **cancelling as the default**, since either other answer ends the
sessions. Saving all that fails or times out SHALL ask again, as before. When no session is running,
this dialog is unchanged.

#### Scenario: 有未存變更時阻止關閉

- **WHEN** 存在至少一個有未存變更的檔案，使用者關閉視窗
- **THEN** 視窗不關閉，並呈現要求選擇處置方式的原生對話框

#### Scenario: 選擇取消

- **WHEN** 使用者於該對話框中選擇取消
- **THEN** 視窗保持開啟，未存的變更仍在

#### Scenario: 選擇不儲存並關閉

- **WHEN** 使用者於該對話框中選擇不儲存並關閉
- **THEN** 視窗關閉，磁碟上的檔案不被修改

#### Scenario: 沒有未存變更時直接關閉

- **WHEN** 不存在任何未存的變更，且沒有任何 session 持有執行中的行程，使用者關閉視窗
- **THEN** 視窗直接關閉，不呈現任何對話框

#### Scenario: Unsaved changes and running sessions share one dialog

- **WHEN** a file has unsaved changes, a shell session holds a running process, and the user closes
  the window
- **THEN** exactly one dialog is shown; it lists the file and the session, and its default answer is
  cancelling

#### Scenario: Cancelling the shared dialog keeps both

- **WHEN** the user cancels that dialog
- **THEN** the window stays open, the unsaved changes are still there, and the session's process is
  still running

### Requirement: 應用程式視窗不呈現原生 menu bar

應用程式視窗 SHALL NOT 呈現原生的 menu bar，使用者按 `Alt` SHALL NOT 浮出任何 menu。這個 app
不定義任何 menu 內容（Linux、Windows）—— 一條空的 menu bar 只會擋住畫面、讓使用者以為漏看了什麼。

此要求為**移除** menu，而非僅隱藏：`autoHideMenuBar`（平時隱藏、按 `Alt` 浮出）不滿足它，
主行程 SHALL 移除整個 menu（`Menu.setApplicationMenu(null)` 或等效）。

**This applies to Linux and Windows. macOS is the exception**, because there the application menu is
not part of the window: it is the system's menu bar. The standard keyboard shortcuts of text editing
(`Cmd+C`, `Cmd+V`, `Cmd+X`, `Cmd+A`, undo and redo) come from that menu's items, and so does `Cmd+Q`.
On macOS the application SHALL therefore define a minimal application menu, and nothing beyond it:

- the application menu: About, Hide, Hide Others, Show All, Quit;
- the Edit menu: Undo, Redo, Cut, Copy, Paste, Select All.

It SHALL NOT define a shortcut that closes the window with one key (`Cmd+W`): closing the window ends every
session.

The menu SHALL be set once for the application, not per window, and every label SHALL come from the
dictionaries in the current UI language (`ui-localization`). The application menu's own title is the
bundle's name and is not translated.

A paste or a copy SHALL happen once per key press: in the terminal, in the editor, and in text fields. An
Edit menu item SHALL NOT repeat a paste that the terminal or the editor has already performed.

#### Scenario: 按 Alt 不叫出任何 menu

- **WHEN** 在 Linux 或 Windows 上應用程式視窗開啟，使用者按下 `Alt`
- **THEN** 不出現任何 menu bar

#### Scenario: The macOS menu holds the minimal items

- **WHEN** on macOS the application is running
- **THEN** its menu bar holds the application menu and the Edit menu with the items listed above, the
  application defines no other item, and no item is bound to `Cmd+W`

#### Scenario: The macOS menu follows the UI language

- **WHEN** on macOS the UI language is changed in Settings
- **THEN** the menu's items (other than the application menu's own title) are labelled in the new language
  without a restart

#### Scenario: Paste in the editor happens once on macOS

- **WHEN** on macOS the clipboard holds a word and the user presses `Cmd+V` in an editable file in the
  editor
- **THEN** the word is inserted exactly once

#### Scenario: Copy and paste work in a text field on macOS

- **WHEN** on macOS text is selected in a text field, the user presses `Cmd+C`, then `Cmd+V` in another
  text field
- **THEN** the text is pasted there once

#### Scenario: Paste in the terminal happens once on macOS

- **WHEN** on macOS the clipboard holds a line and the user presses `Cmd+V` in a terminal session
- **THEN** the line reaches the session exactly once

### Requirement: Closing the window while sessions are running asks for confirmation

When the user closes the window (the title bar's close button, `Alt+F4`, or any other close the window
manager delivers) while at least one session of that window **holds a running process**, the main
process SHALL keep the window open and ask the user to confirm, in a native dialog, before anything
is ended. Closing the window ends every running process; nothing a session was running survives it.

- **What counts** is exactly the sessions holding a pty — folder sessions and global sessions alike.
  A dormant session (restored and not woken, or hibernated) and an exited session SHALL NOT count:
  closing loses nothing of theirs.
- The decision to hold the close SHALL be made synchronously in the close event from state the main
  process already holds. It SHALL NOT depend on a round trip to the renderer.
- The dialog SHALL state how many sessions are running and list them by their rail item and label
  (the session's name as the tab derives it, cut to a fixed length), at most 10, then a count of the rest. Sessions known to be **working** —
  an agent that is working or waiting on the user's choice, a shell whose process has a child process
  or has been replaced by another program — SHALL be marked as such and listed first. A session whose
  state is not known SHALL be listed without a mark, not as idle and not as working.
- The dialog SHALL say what closing loses and what it keeps: running commands and an agent's reply in
  progress are lost; claude sessions resume their conversation when woken. **What it says about shells
  and about what is closing SHALL be true on the platform it runs on.** Shells restart in their last
  directory only where the application can read a session's directory; elsewhere they restart in their
  folder, and the dialog says so. On macOS closing the window does not quit the application, and the dialog
  does not say that it does.
- The dialog SHALL offer exactly two answers, closing and cancelling. **Cancelling SHALL be the
  default and the cancel answer** — pressing `Enter` or `Escape` in the dialog SHALL NOT end any
  session.
- Choosing to close SHALL close the window; its sessions end as they do on any close and are restored
  as dormant on the next launch (`session-persistence`), or, on macOS, when the window is opened again.
- Choosing to cancel SHALL leave the window open and every session running, with the same process.

The dialog's text is user-visible copy and SHALL come from the dictionaries in the current UI
language (`ui-localization`).

**One question at a time.** While the dialog is waiting for an answer, a further close of the window
(a second click on the close button, `Alt+F4`, a termination signal, a Quit from the application menu)
SHALL NOT show another dialog and SHALL NOT close the window. The open dialog's answer decides alone. If
the window no longer exists when the answer arrives, the answer SHALL be ignored without an error.

**Acceptance gaps, settled by dogfood** (the automated carrier replaces the native dialog with a
stand-in that records what it was asked and answers from a file, and closes the window from the main
process the way the close button does): that the real close button and `Alt+F4` reach this path, and
that `Enter` / `Escape` in the real native dialog choose its default and cancel answers. It is also
not verified which way each desktop environment ends the application at logout — a termination
signal (which this requirement does not ask about) or a window close (which it would ask about).

#### Scenario: A second close while the dialog is open does not ask twice

- **WHEN** the dialog is open and the window is closed again before it is answered
- **THEN** exactly one dialog has been shown and the window is still open

#### Scenario: Closing with a running session asks first

- **WHEN** a shell session holds a running process and the user closes the window
- **THEN** the window stays open and a dialog asks for confirmation, stating one running session and
  listing it by its rail item and label

#### Scenario: Cancelling keeps every session running

- **WHEN** the user cancels that dialog
- **THEN** the window stays open and the session's process is the same process, still running

#### Scenario: Confirming closes the window and ends the sessions

- **WHEN** on Linux the user confirms that dialog
- **THEN** the application exits, no process of its sessions remains, and on the next launch the
  session is present as dormant

#### Scenario: The safe answer is the default

- **WHEN** the dialog is shown
- **THEN** its default answer and its cancel answer are both "cancel"

#### Scenario: Only dormant sessions close without asking

- **WHEN** every session of the window is dormant and nothing is unsaved, and the user closes the
  window
- **THEN** the window closes without any dialog

#### Scenario: A global session counts

- **WHEN** the only running session belongs to the global item and the user closes the window
- **THEN** the dialog is shown and lists that session under the global item's name

#### Scenario: A working session is marked and listed first

- **WHEN** one shell is idle and another shell runs a command (`sleep`), and the user closes the window
- **THEN** the dialog lists the shell running the command first, marked as working, and the idle shell
  without that mark

#### Scenario: A working agent is marked

- **WHEN** a claude session's agent is working and the user closes the window
- **THEN** the dialog lists that session marked as working

#### Scenario: The dialog does not promise a directory it cannot restore

- **WHEN** the application cannot read a session's directory on its platform and the dialog is shown
- **THEN** the dialog says that shells restart in their folder, not in their last directory

#### Scenario: On macOS the dialog does not say the application closes

- **WHEN** on macOS the dialog is shown for closing the window
- **THEN** it says that closing the window ends the sessions, and does not say that spekterm closes

### Requirement: A quit that does not start with closing the window does not ask about sessions

When the application is asked to quit by something other than the user closing the window, the
confirmation about running sessions SHALL NOT be shown and SHALL NOT hold the quit. Such a request is a
termination signal (`SIGTERM`, as sent by the session manager at logout or shutdown, or by `kill`), or,
on macOS, a quit request from the operating system: the Dock's Quit, logout, or shutdown. Nobody may be
there to answer it, and a held quit ends in a forced kill that skips the application's own cleanup and
its last persistence write. An unattended restart for a system update is such a case.

The application menu's Quit on macOS is **not** such a request: it starts with closing the window (see "On
macOS, quitting from the application menu asks like closing the window").

The confirmation of unsaved changes is unchanged on this path (see "視窗關閉前確認未存的變更"). Once it is
answered with anything but cancel, the quit finishes (see "A quit that waited for an answer finishes once
it is answered").

The one exception is a quit request that arrives while the user is already answering the dialog (the
close came first): a signal, or on macOS the Dock's Quit, logout, or the application menu's Quit. The open
question is not withdrawn behind the user's back, and that request does not end the application by
itself. Answering close ends it, on macOS too, where closing the window alone would leave the application
running: the request turns the open close into a quit. Answering cancel keeps it running and the request
is dropped. Either way, a later close of the window SHALL ask again as described in "Closing the
window while sessions are running asks for confirmation" — the dropped request leaves nothing behind
that would skip the question or turn a later close into a quit (see "One question at a time").

#### Scenario: A signal during the open dialog does not disable the question

- **WHEN** the dialog is open, the application receives `SIGTERM`, the user cancels, and later closes
  the window again while a session is still running
- **THEN** the application is still running after the cancel, and the second close asks again

#### Scenario: A termination signal quits with sessions running

- **WHEN** a shell session holds a running process, nothing is unsaved, and the application receives
  `SIGTERM`
- **THEN** no dialog is shown, the application exits by itself, and no process of its sessions
  remains

#### Scenario: On macOS a quit during the open dialog finishes when answered

- **WHEN** on macOS the user closes the window with a running session, the dialog is open, the user
  presses `Cmd+Q`, and then answers close
- **THEN** the application exits

#### Scenario: An operating-system quit on macOS does not ask about sessions

- **WHEN** on macOS a shell session holds a running process, nothing is unsaved, and the operating system
  asks the application to quit (the quit request the Dock's Quit and logout send)
- **THEN** no dialog is shown, the application exits by itself, and no process of its sessions remains

### Requirement: The browser engine opens no connection at startup that nothing asked for

The app SHALL NOT use Electron's built-in spell checker, and SHALL NOT download its dictionaries. With a
fresh user-data directory, and with one an earlier version left behind, starting the app SHALL NOT make
the browser engine open any network connection. Afterwards, every connection the browser engine opens is
one the user asked for, configured, or that content the user opened requests (for example a remote image
in a markdown file).

The spell checker was on by default and downloaded a dictionary from a third-party server at every start
with a fresh profile, before the user touched anything, for a feature no part of the app uses.

Dictionary files downloaded by earlier versions MAY remain in the user-data directory; they are not used.
The `Dictionaries` directory itself may still be created, so its absence is not evidence of anything.

This requirement's check covers the browser engine's network stack only, for host names other than
`localhost`, within a bounded window after startup. Connections made by the main process's own code are
covered by "The app's own code connects only where its allow-list says"; connections to IP literals do not
pass through host-name resolution and are not observed.

#### Scenario: Startup with a fresh profile opens no connection

- **WHEN** the app is started with a fresh user-data directory, every host name except `localhost`
  resolving to a local listener that was already listening before the app started, and is left untouched
  for the settle window
- **THEN** the listener has received no connection

#### Scenario: Startup with an earlier version's profile opens no connection

- **WHEN** the app is started the same way with a user-data directory in which an earlier version
  registered a spell-check dictionary that is not present on disk (never downloaded, or deleted)
- **THEN** the listener has received no connection

#### Scenario: The check can see a connection

- **WHEN**, in the same run and after the settle window, the app's window loads an image from a remote
  `https:` host
- **THEN** the listener receives a connection for that host — so a check that saw nothing above was not
  blind

### Requirement: The app's own code connects only where its allow-list says

A unit test SHALL fail when the source of the main process, the preload, or the code they share
references a network-capable API, or imports a package or built-in module (not a file of this
repository) — statically, through `import()`, or through `require` — that is not on an allow-list; and
SHALL fail when an allow-list entry no longer matches anything. The allow-list SHALL name the
documentation page that states the app's network behavior (`project-website`), which is revisited
whenever the allow-list changes.

A URL handed to the user's browser because the user clicked a link is not a connection the app makes and
is not listed.

#### Scenario: A new network reference fails the test

- **WHEN** a source file in the main process gains a reference to the global `fetch` that is not on the
  allow-list — called, passed by reference, read from `globalThis`, or aliased
- **THEN** the test fails and names the file and the reference

#### Scenario: A new module import fails the test

- **WHEN** a source file in the main process, the preload, or the shared code imports a package or
  built-in module that is not on the allow-list, with or without the `node:` prefix
- **THEN** the test fails and names the file and the module

#### Scenario: A stale allow-list entry fails the test

- **WHEN** an allow-list entry matches no reference in the source
- **THEN** the test fails and names the entry

### Requirement: On macOS, closing the window leaves the application running and activating it reopens the window

On macOS, closing the window SHALL end its sessions exactly as on other platforms (with the same
confirmation), and SHALL NOT quit the application. This follows the convention of macOS terminal
applications. Activating the application while it has no window (clicking its Dock icon, opening it
again) SHALL open a new window, whose sessions are restored as dormant, as they are after a restart
(`session-persistence`).

The second window SHALL behave as the first: its menu, its close confirmation, and the delivery of inbox
and handoff events. Nothing the closed window held SHALL outlive it: its ptys, its watchers, its
conversation tracking.

**An action that targets the window while none exists SHALL first open one.** Such actions are a
notification click, opening the inbox, and revealing a handoff brief. The action SHALL be performed once
the new window's interface is ready to receive it. It SHALL NOT be dropped, and it SHALL NOT be sent
before the interface can handle it.

**Acceptance gap, settled by dogfood:** that clicking a real notification while no window exists opens
the window and performs its action. The logic is covered without a real notification.

#### Scenario: Closing the window keeps the application

- **WHEN** on macOS a shell session holds a running process, the user closes the window and confirms
- **THEN** the session's process has ended, and the application process is still running with no window

#### Scenario: Activating the application restores the sessions

- **WHEN** on macOS the application is running with no window and is activated
- **THEN** a window opens and the session that was running is present as dormant

#### Scenario: The second window has the menu

- **WHEN** on macOS the window is closed and the application is activated again
- **THEN** the new window's application menu still contains Quit and the Edit menu

#### Scenario: An inbox action with no window opens one

- **WHEN** on macOS the application has no window and an action that opens the inbox is triggered
- **THEN** a window opens and its inbox opens once the window's interface is ready

### Requirement: On macOS, quitting from the application menu asks like closing the window

On macOS, the application menu's Quit item and `Cmd+Q` SHALL close the window first, with everything that
closing the window does: the confirmation of unsaved changes and the confirmation of running sessions.
They SHALL quit the application only once that close has finished. Cancelling either confirmation SHALL
keep the application and the window as they were, and SHALL leave nothing behind that would turn a later
close of the window into a quit.

When the application has no window, Quit SHALL quit at once.

#### Scenario: Cmd+Q with a running session asks

- **WHEN** on macOS a shell session holds a running process and the user presses `Cmd+Q`
- **THEN** the confirmation of running sessions is shown, and the application is still running

#### Scenario: Cancelling Cmd+Q keeps everything

- **WHEN** the user cancels that confirmation
- **THEN** the window is open and the session's process is the same process, still running

#### Scenario: A cancelled Cmd+Q leaves nothing behind

- **WHEN** after cancelling that confirmation the user closes the window and confirms
- **THEN** the application is still running, with no window

#### Scenario: Confirming Cmd+Q quits

- **WHEN** the user confirms that confirmation
- **THEN** the application exits and no process of its sessions remains

#### Scenario: Cmd+Q with nothing to ask quits at once

- **WHEN** on macOS no session holds a running process, nothing is unsaved, and the user presses `Cmd+Q`
- **THEN** no dialog is shown and the application exits

#### Scenario: Quit with no window quits at once

- **WHEN** on macOS the application is running with no window and the user chooses Quit
- **THEN** the application exits

### Requirement: A quit that waited for an answer finishes once it is answered

When a quit had to wait for the user, it SHALL finish once the user has answered with anything other than
cancel. Such a quit is either one that started from the Quit item, or one whose unsaved changes had to be
confirmed after a request from the operating system. A quit the user asked for SHALL NOT end in an
application that keeps running with no window.

#### Scenario: Answering the unsaved-changes question of an OS quit finishes the quit

- **WHEN** on macOS a file has unsaved changes, the operating system asks the application to quit (as the
  Dock's Quit does), and the user chooses not to save
- **THEN** the application exits
