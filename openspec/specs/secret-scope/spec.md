# secret-scope Specification

## Purpose

應用程式代使用者持有的**機密**（第三方服務的憑證），其作用域的邊界：它住在主行程，
而它**不得**經由那三條既有的出口離開。

出口有**四**條。前三條是既有的，而且每一條都**預設會帶上新東西**：IPC 的偏好投影原樣轉手
整個物件、建構子行程環境的路徑展開 `process.env`、診斷輸出接受任何字串。
**三者都不是為機密設計的，而它們都不會因為多帶了一個機密而變紅。**

**第四條（網路）是隨第一個機密一起出現的，而它是唯一真的會把憑證送出本機的那一條。**
它不是既有出口的延伸：一個可覆寫的服務端點加上一份憑證，就構成「把憑證送到別處」的能力，
而驗收必然需要那個覆寫。

它管的不是「Slack 的憑證怎麼存」（那是 `slack-intake-source` 的事），而是**任何**機密
流經那四條出口時會怎樣。本能力因此在第一個機密出現時建立，而不是在第二個出現時才回頭補。

## Requirements

### Requirement: 機密不抵達 renderer

機密 SHALL NOT 經由任何 IPC 通道送達 renderer。renderer 為了呈現與操作所需的資訊
SHALL 限於**衍生的事實**（是否已設定、所連的工作區名稱、當前的運作狀態），
SHALL NOT 包含機密本身或其任何可還原的片段。

**renderer 渲染不受信任的內容**（使用者 repo 裡的任意 markdown、pty 的輸出），
而導航防護是一道**行為**上的防護 —— 它擋得住已知的路徑，擋不住一個有 bug 的 renderer。
把機密送進去，等於讓這道防線的失效從「洩漏檔名」升級成「洩漏可用的憑證」。

送往 renderer 的內容 SHALL 以**白名單**判定，SHALL NOT 以黑名單或原樣轉手判定 ——
原樣轉手的失效方式是：日後加進該物件的任何欄位**零改動、零紅燈**地送到 renderer。

#### Scenario: 設定完成後 renderer 取不到憑證

- **WHEN** 使用者已完成一項需要憑證的設定，renderer 取得該功能的當前狀態
- **THEN** 所取得的內容指出「已設定」，且不含憑證本身

#### Scenario: 與機密同源的設定物件其投影為白名單

- **WHEN** 一個**確實會被投影給 renderer** 的設定物件（例如服務的連線設定：是否已設定、
  工作區名稱、運作狀態）中新增一個欄位，而未明確宣告它要送往 renderer
- **THEN** 該欄位不出現在 renderer 取得的內容中

> **這條刻意瞄準那個真的會被投影的物件，不是機密自己所在的那一份。** 機密住在自己的檔案裡
> （見「落盤的機密其存取受限」），於是對它講「不會流向 renderer」對**任何**實作都恆真 ——
> 一條紅不起來的斷言。真實的風險面是連線設定那個物件：它本來就要送出去，而機密住在它隔壁。

### Requirement: 機密不進入任何子行程的環境

機密 SHALL NOT 出現在應用程式所建立的**任何子行程**的環境變數中 —— pty 與委派給外部 CLI 的
行程皆然。

**建構 pty 環境的路徑會展開 `process.env`**（`terminal.ts` 的 `ptyEnv()` 是
`{ ...process.env, ...使用者 shell 環境, TERM }`），因此：

- **守衛的範圍 SHALL NOT 限於「建構環境的那幾個模組有沒有匯入機密」。**
  真正會讓機密進到每一個子行程的動作是**任何模組往 `process.env` 寫一個值** ——
  那個模組不必是建構環境的那一個、也不必被它匯入。第三方服務的用戶端套件正是最可能這樣做的
  地方（許多套件讀約定俗成的環境變數）。
- 因此：`process.env` 的**指派** SHALL NOT 出現在持有機密的模組及其呼叫端。

**「把憑證放進 shell 的 rc 檔」等同讓每一個 agent session 都讀得到它** —— 包含使用者在別的
repo 裡跑的、由不受信任的內容驅動的那些。使用者自己的 shell 環境不在本能力的控制範圍內，
但本能力的**文件 SHALL 明確指出這件事**（這是一條無條件的要求，不是「若有需要」）。

持有機密的模組 SHALL NOT 被**任何建構子行程環境的模組**取用（包含委派外部 CLI 的那條路徑）。
**這是結構性的約束而非紀律** —— 「記得不要把它加進去」約束不了下一個加欄位的人。

#### Scenario: 子行程的環境中不含機密

- **WHEN** 應用程式已持有機密，使用者建立一個 session
- **THEN** 該子行程的環境變數中不含該機密的任何片段

#### Scenario: 建構子行程環境的模組取用不到機密

- **WHEN** 掃描產品原始碼中對機密讀取入口的取用位置
- **THEN** 建構 pty 環境與建構委派環境的模組都不在其中

#### Scenario: 機密模組對 `process.env` 的指派即失敗

- **WHEN** 持有機密的模組或其呼叫端出現對 `process.env` 的指派
- **THEN** 驗收失敗

### Requirement: 機密只送往它所屬的那個服務

機密 SHALL 只被送往它所屬服務的端點。端點的 scheme SHALL 限於 `https:`（白名單，非黑名單）。
**A WebSocket service's endpoint SHALL be limited to `wss:` in the same way**: the team server
(`team-membership`) is reached over a WebSocket, and its device secret is sent in that connection's `hello`.

**這是本能力四條出口中唯一真的會把憑證送出本機的那一條，而它是隨本次新增而出現的。**
一個可覆寫的端點加上一份憑證，就是「把憑證送到一個不是該服務的主機」的能力 ——
而驗收必然需要那個覆寫（真實服務要網路、要憑證、回應不可重現）。

端點為使用者可編輯的設定項（與服務的其餘連線設定同一份），因此它 SHALL 配上以下三者：

1. **只能由使用者明確操作改動** —— SHALL NOT 由投遞內容、routing 規則或任何其他外部輸入寫入。
2. **非預設值時 SHALL 對使用者可見** —— 他要能知道「我的憑證正在送往一個非官方的主機」。
   **一個沉默的端點欄位比沒有這個欄位更糟**：它把憑證的目的地變成一個沒有人會去看的值。
3. scheme 的白名單如上。

**The team server has no default endpoint**: its address comes only from the invite link the user pasted, and it
is written only by the user's join (`team-membership`). It SHALL therefore always be shown in the team's settings,
which satisfies the second rule for every value. No handoff, inbox delivery, agent outbox file or message from the
server SHALL change it.

#### Scenario: 端點非預設值時使用者看得到

- **WHEN** 端點被設為非預設值
- **THEN** 使用者於該功能的介面上看得到它不是預設值

#### Scenario: 外部輸入改不動端點

- **WHEN** 一則外部投遞的內容中含有端點欄位
- **THEN** 實際使用的端點未改變

#### Scenario: 非 https 的端點不被接受

- **WHEN** 端點被設為一個 scheme 不在白名單中的位址
- **THEN** 該值被拒絕，且機密不被送往該位址

#### Scenario: The team server's address is shown and written only by a join

- **WHEN** the device has joined a team, and an agent then writes an outbox file and a teammate's handoff arrives,
  both containing a field naming another server address
- **THEN** the Team section shows the address from the invite, and the device's `hello` still goes only to it

#### Scenario: A team server address that is not wss is refused

- **WHEN** the user pastes an invite whose server address is `ws://` or `https://`
- **THEN** the invite is refused and no connection is made

### Requirement: 機密不出現在診斷輸出

機密 SHALL NOT 出現在 `console.*`、錯誤訊息或任何寫入磁碟的診斷內容中。

失效時最自然的動作正是「把整個設定物件印出來看看」，而診斷輸出**會被使用者貼進
issue 或交給另一個 agent**。

錯誤的回報 SHALL 以**不含機密的形式**描述失敗（例如「憑證已失效」），
SHALL NOT 為了便於診斷而包含憑證的任何片段 —— 前綴與末幾碼同樣是片段。

#### Scenario: 憑證失效的回報不含憑證

- **WHEN** 一項憑證失效，系統回報該失敗
- **THEN** 回報的內容描述失敗的性質，且不含該憑證的任何片段

### Requirement: 落盤的機密其存取受限，且不進入版控

落盤的機密 SHALL 位於應用程式的使用者資料目錄之下，SHALL 以僅限擁有者可讀寫的權限**持有**，
且 SHALL NOT 與使用者偏好、**亦 SHALL NOT 與該服務的其餘連線設定**共用同一份檔案。

與偏好分家有三個各自成立的理由：偏好會被投影到 renderer；偏好檔的寫入路徑自空物件重建
其內容，寄居其中的欄位倚賴每一個寫入者記得保留它（`intake-routing` 已就同一理由把規則
分了出去）；兩者的權限姿態不同。

**與連線設定分家的理由是獨立的**：連線設定**本來就要被投影給 renderer**（介面要顯示工作區
名稱、是否已設定、端點是否為預設值）。機密放在同一個物件裡，那個投影就直接成了本能力
第一條 requirement 所防的那條出口。分成兩份之後，「把機密投影出去」需要先跨檔案去拿它 ——
那是一個做得到、但不會被不小心做出來的動作。

**權限的要求是「持有」而非「建立時設定」**，因為三種情形都會讓後者靜默失效：目標檔案已存在
（權限是先前較寬的那一組，建立時的模式對它無效）；落盤採「先寫暫存檔再更名」時**暫存檔**
的權限（否則存在一個短暫的全域可讀窗口）；建立模式會被行程的 umask 遮罩。

**作用域限於具備 POSIX 權限語意的平台。** Windows 上此種權限位元無意義，該平台的等價保護
SHALL 視為**未涵蓋**，並列為打包驗收前必須確認的項目（比照既有的 `O_NOFOLLOW` 條款）。

機密 SHALL NOT 出現在版本控制之下的任何檔案中，包含測試的 fixture 與驗收所用的替身設定。

#### Scenario: 機密檔案僅擁有者可讀寫

- **WHEN** 系統寫出一份含機密的檔案
- **THEN** 該檔案的權限僅允許擁有者讀寫

#### Scenario: 寫入一個已存在且權限較寬的檔案後權限被收緊

- **WHEN** 目標路徑已存在一個權限較寬的檔案，系統其後寫入機密
- **THEN** 該檔案的權限僅允許擁有者讀寫

#### Scenario: 更名前的暫存檔同樣僅擁有者可讀寫

- **WHEN** 系統以「先寫暫存檔再更名」的方式寫出機密
- **THEN** 該暫存檔在存在期間的權限僅允許擁有者讀寫

#### Scenario: 變更終端偏好不影響機密

- **WHEN** 機密已設定，使用者其後變更終端字型設定
- **THEN** 該機密未被改變或移除

> **這條在機密與偏好分屬兩份檔案時恆真，它的價值全在 mutation** —— 把機密移進偏好檔之後
> 它必須變紅。少了那個 mutation，這條只是一句記錄，不是一道守衛。

### Requirement: 本能力的守衛具備鑑別力

本能力的每一條約束 SHALL 有一道會在違反時失敗的守衛，且該守衛 SHALL 經**對照組**驗證 ——
把約束刻意違反之後，對應的驗收 SHALL 確實失敗。

**這一條不是儀式。** 本能力的每一種失效都是靜默的：機密流向 renderer 不會有錯誤、
進了 pty 環境不會有錯誤、印進 log 不會有錯誤。一道「掛上了但從未真的判定過任何東西」的
守衛，與沒有守衛在輸出上完全相同 —— 而這個 codebase 每一次沒有跑對照組的守衛，
事後查核**全部**是假綠。

#### Scenario: 把機密加進被投影的內容即失敗

- **WHEN** 刻意把一個機密欄位列入送往 renderer 的內容
- **THEN** 驗收失敗

#### Scenario: 把機密加進子行程環境即失敗

- **WHEN** 刻意把一個機密加入建構子行程環境的路徑
- **THEN** 原始碼守衛與行為斷言**都**失敗

#### Scenario: 把機密移進偏好檔即失敗

- **WHEN** 刻意把機密改為與使用者偏好共用同一份檔案
- **THEN** 驗收失敗

#### Scenario: 把端點指向別處即失敗

- **WHEN** 刻意把服務端點改為一個與該服務無關的位址，且該變更未經使用者明確操作
- **THEN** 驗收失敗
