# session-persistence Specification

## Purpose

**session 跨「關閉並重新開啟應用程式」與「renderer 重新載入」存活。**

關掉 app，pty 一定會死 —— **pty 的 master fd 必須有人持有**，app 一死，slave 收到 SIGHUP，底下的
行程跟著死。但「使用者建立了哪些 session」是**使用者親手做的事實**，沒有理由跟著 pty 一起消失。

因此本能力交付的是**重建**，不是**常駐**：重開時我們**重新開一個 pty**，然後讓 `claude` 續接它原本
的對話、讓 shell 回到最後的工作目錄並重播上次的畫面。**跑到一半的長行程（build、dev server）救不
回來** —— 那需要「讓 pty 活過 app 的生命」，是一個不同量級的架構決定（見 `docs/PRD.md` §11 的
「session 常駐」）。**不要把兩者混為一談。**

重建**不使 `terminal-sessions` 的「三路徑皆不留孤兒行程」鬆動**：舊 pty 照樣被殺，重建開的是新的。

## Requirements

### Requirement: session 跨應用程式重啟與 renderer 重新載入存活

重建一個 session 所需的**事實** SHALL 被持久化，並於下次開啟應用程式時重建：**它的歸屬**
（某個 folder，或**全域** —— 見 `global-session`）、spawn 目標、使用者取的名字、分頁順序、
**它開在哪個工作目錄**、**pty 最近一次宣告的終端標題**，以及由主行程寫入的**交接來源**（見
`session-lineage`）、**交接單**（見 `handoff-brief`）、**完成狀態與最新結果**（見 `handoff-completion`）與
claude 目標的**固定名字**（見 `agent-peer-name`）。完成狀態不是衍生狀態 —— 它由一次已消費的投遞與
其後的等待狀態序列決定，重啟之後無從重算。renderer 重新載入時 SHALL 同樣重建。

**歸屬為全域** SHALL 以一個明確的狀態表示，SHALL NOT 以一個保留的 folder 識別碼字串表示 ——
後者會使每一處「以識別碼查找 folder」的讀取靜默地查無此 folder。

持久化的內容 SHALL 限於重建所必需的事實，SHALL NOT 包含**可由當下環境廉價重算**的衍生狀態
（例如 folder 是否含 `openspec/`、git 分支 —— 那些每次載入都重算，存下來只是持久化謊言）。

**側欄座標（來源 repo、側欄的工作目錄、錨定的 change）SHALL NOT 由 session 持久化。** 它隸屬於
rail 上的項目而非任何 session（見 `side-panel-source`），由該能力自行持久化 —— 一個沒有任何
session 的 folder，其側欄座標同樣要跨重啟存活，而掛在 session 上的資料做不到這件事。

pty 宣告的標題屬於「必需」而非「衍生」：**休眠的 session 沒有 pty 可以再宣告一次**，不存它，重開後
那些分頁就全部退回流水號標籤，而它們正是被 agent 依任務命名的那些 —— 使用者認不出哪個是哪個。
它一經喚醒即被 pty 的下一次宣告覆蓋。

**session 開在哪個工作目錄**同樣屬於「必需」：它記錄的是使用者建立該 session 時的**選擇**，不是
某個時刻的觀測值。以工作目錄識別碼保存，重建時查表解析 —— 該工作目錄若已不存在（worktree 於應用
程式未開啟時被移除），該 session SHALL 於其 folder 的根目錄重建，SHALL NOT 使重建失敗。
**全域 session 不具備工作目錄識別碼**（它不隸屬任何 repo，沒有可供查表的集合），其工作目錄由
`global-session` 定義。

重建 SHALL NOT 使既有的 pty 生命週期鬆動 —— 重建產生的是**新的** pty；`terminal-sessions` 的
「關閉分頁／重新載入／關閉視窗三路徑皆不留孤兒行程」不受影響。

#### Scenario: 關閉並重新開啟應用程式後 session 回來

- **WHEN** 使用者建立若干 session、為其中之一命名、調整順序，然後關閉並重新開啟應用程式
- **THEN** 這些 session 以相同的名字與順序重新出現於其所屬的 folder

#### Scenario: 全域 session 一併重建於全域項目之下

- **WHEN** 使用者同時開著隸屬於某 folder 的 session 與全域 session，關閉並重新開啟應用程式
- **THEN** 兩者各自重建於其原本的 rail 項目之下，且全域 session 不出現在任何 folder 之下

#### Scenario: 側欄座標不隨 session 落盤

- **WHEN** 檢視 renderer 送往 session 持久化的資料
- **THEN** 其中不含側欄來源、側欄的工作目錄與錨定的 change

#### Scenario: renderer 重新載入後 session 回來

- **WHEN** renderer 重新載入
- **THEN** 先前的 session 以相同的名字與順序重建，且先前的 pty 皆已終止

#### Scenario: 開在工作目錄的 session 重建後仍在那裡

- **WHEN** 使用者於某個 linked worktree 建立一個 session，關閉並重新開啟應用程式，喚醒該 session
- **THEN** 新的 pty 的工作目錄為該 worktree 的根

#### Scenario: 工作目錄已消失時退回 folder 根目錄

- **WHEN** 一個 session 所開的 worktree 於應用程式未開啟期間被移除，其後該 session 被喚醒
- **THEN** 該 session 於其 folder 的根目錄重建，且不呈現為失敗

#### Scenario: 來源與固定名字隨 session 重建

- **WHEN** 一個由交接建立的 claude session 存在，關閉並重新開啟應用程式
- **THEN** 它的來源與固定名字與關閉之前相同

### Requirement: claude 目標的 session 續接其原本的對話

spawn 目標為 `claude` 的 session SHALL 以一個由應用程式指定、且被持久化的**對話識別碼**啟動。
該 session 重建並被喚醒時，SHALL 續接**同一個**對話 —— 使用者 SHALL 看到先前的對話內容。

該對話識別碼 SHALL 獨立於 session 自身的識別碼，使前者可被替換而不影響後者。

#### Scenario: 重建後的 claude session 續上先前的對話

- **WHEN** 使用者與一個 claude session 對話過，關閉應用程式，重新開啟並喚醒該 session
- **THEN** 該 session 續接先前的對話，先前的對話內容可見

### Requirement: 對話無法續接時自癒為全新對話，不留下無法使用的 session

續接的對話不存在時，應用程式 SHALL 以一個**全新的**對話識別碼啟動一個全新的 claude session，
並更新持久化的對話識別碼；SHALL NOT 沿用原識別碼重新建立對話。使用者從未與該 session 對話過時
即屬此情形 —— 那時不存在任何對話紀錄可供續接。

自癒 SHALL NOT 改變該 session 於應用程式中的身分 —— 其分頁、名字與順序皆 SHALL 不受影響。

自癒 SHALL 至多嘗試一次 —— `claude` 本身無法啟動時，該 session 依 `terminal-sessions` 的既有要求
呈現為已結束並於終端顯示訊息，SHALL NOT 反覆重試。

#### Scenario: 從未對話過的 session 於重建後仍可用

- **WHEN** 使用者建立一個 claude session 但從未與它對話，關閉應用程式，重新開啟並喚醒該 session
- **THEN** 該 session 啟動一個可用的全新 claude，且其名字與順序不變

#### Scenario: claude 無法啟動時不反覆重試

- **WHEN** 一個重建的 claude session 被喚醒，但環境中 `claude` 無法啟動
- **THEN** 該 session 呈現為已結束並於終端顯示訊息，且啟動的嘗試不超過兩次

### Requirement: shell 目標的 session 於最後已知的工作目錄重生

spawn 目標為 login shell 的 session 被喚醒時，其 pty 的工作目錄 SHALL 為該 session **最後已知的**
工作目錄，而非恆為 folder 的根目錄。

**隸屬於某個 folder 的 session**，該工作目錄 SHALL 被夾制於**所屬 folder 的邊界內，或該 folder
所屬 repo 任一工作目錄的邊界內** —— 兩者皆不成立、或無法取得時，SHALL 退回 folder 的根目錄。

**全域 session 不受此路徑夾制**：它沒有所屬 folder，家目錄是它的起點而非邊界（見
`global-session`）—— 僅在該目錄已不存在或無法取得時退回家目錄。

**兩道夾制 SHALL 使用同一個判定**：記錄側（觀測並保存工作目錄時）與重建側（啟動 pty 時）各有一道，
只放寬其中一道等於沒有放寬 —— 記錄側若仍夾制，越界的位置從一開始就不會被保存，而重建側收到的是
缺席值，一切看起來正常。

shell 的行程狀態（環境變數、執行中的行程）SHALL NOT 被宣稱可還原 —— 這是重生，不是續接。

#### Scenario: 於子目錄重生

- **WHEN** 使用者在一個 shell session 內切換到 folder 底下的某個子目錄，關閉應用程式，重新開啟並喚醒該 session
- **THEN** 新的 shell 的工作目錄為該子目錄

#### Scenario: 於 folder 邊界外的工作目錄重生

- **WHEN** 使用者在一個 shell session 內切換到該 repo 位於 folder 邊界外的某個 worktree，關閉應用程式，重新開啟並喚醒該 session
- **THEN** 新的 shell 的工作目錄為該 worktree —— 它落在該 repo 的工作目錄之內，不再被夾制掉

#### Scenario: 越界的工作目錄退回根目錄

- **WHEN** 使用者在一個 shell session 內切換到既不在所屬 folder、也不在該 repo 任何工作目錄之下的目錄，關閉應用程式，重新開啟並喚醒該 session
- **THEN** 新的 shell 的工作目錄為該 folder 的根目錄

#### Scenario: 全域 shell session 於家目錄之外的目錄重生

- **WHEN** 使用者在一個**全域** shell session 內切換到家目錄之外的某個目錄，關閉應用程式，重新開啟並喚醒該 session
- **THEN** 新的 shell 的工作目錄為該目錄，不被夾制回家目錄

#### Scenario: 無法取得最後工作目錄時退回根目錄

- **WHEN** 系統無法取得某個 shell session 最後的工作目錄
- **THEN** 該 session 被喚醒時的工作目錄為其 folder 的根目錄；該 session 為全域 session 時，為家目錄

### Requirement: 喚醒的 session 其 pty 自誕生起即採用終端當下的尺寸

休眠的 session 被喚醒時，其 pty SHALL 自誕生起就採用該終端**當下**的欄列數，SHALL NOT 停留在
spawn 時的預設尺寸直到下一次尺寸變化為止。

**喚醒倒轉了「pty 先誕生、終端後掛載」的順序**：休眠 session 的終端在 pty 存在**之前**就已經量測
過尺寸了，那次同步因此落空（沒有 pty 可以接收）；而依「尺寸有沒有變化」來決定是否同步的機制，
其後不會再送出第二次。若不另行處理，pty 將**永遠**停在 spawn 時的預設尺寸 —— pty 內的程式以錯誤
的寬度排版，畫面看起來縮成一小塊，直到使用者手動改變視窗大小為止。

#### Scenario: 喚醒後 pty 的尺寸與終端一致

- **WHEN** the user wakes a displayed dormant session, so that it starts its pty
- **THEN** 該 pty 的欄列數與終端當下的可用尺寸相符，而非 spawn 時的預設尺寸

### Requirement: 終端畫面以快照還原，且歷史與 live 內容明確區分

shell session 的終端畫面 SHALL 被快照並於重建時重播，使使用者看得到上次的內容。

重播的內容 SHALL 與新 pty 產生的內容**明確區分**——重播的內容並非由該 pty 產生，若不加區分，
使用者會誤以為該 shell 仍是先前那一個。

claude session SHALL NOT 重播快照 —— `claude` 續接對話時會自行重現先前的對話內容，重播將使
使用者看到兩份歷史。

快照 SHALL 有明確的體積上限，SHALL NOT 無限增長。

#### Scenario: 重建的 shell session 顯示上次的畫面

- **WHEN** 使用者在一個 shell session 產生若干輸出，關閉應用程式，重新開啟並喚醒該 session
- **THEN** 先前的終端內容可見，且與新 shell 產生的內容之間有明確的區分

#### Scenario: 重建的 claude session 不出現重複的歷史

- **WHEN** 一個對話過的 claude session 被重建並喚醒
- **THEN** 先前的對話內容只出現一次

### Requirement: session 的 pty 不得繼承「執行中的 Claude Code session」標記

session 的 pty SHALL NOT 繼承那些宣告「本行程隸屬於某個執行中的 Claude Code session」的環境變數 ——
應用程式本身若由這樣的行程啟動，那些標記 SHALL 在 spawn 之前被移除。

**這是「claude 續接對話」得以成立的前提**：帶著那些標記啟動的 `claude` 會把自己視為**巢狀的子
session**，而巢狀的 claude **不留下對話紀錄** —— 於是重建時的續接 SHALL 永遠失敗，而自癒機制會把
這個失敗**掩蓋掉**（使用者拿到一個可用的 claude，只是對話永遠是全新的）。

移除 SHALL 以明確列舉的名單為之，SHALL NOT 以名稱前綴一概剝除 —— 認證用的變數必須留下。

此要求對**兩種** spawn 目標皆適用：使用者於 login shell 內手動啟動 `claude` 時，面對的是同一個問題。

#### Scenario: 巢狀標記不進入 pty 的環境

- **WHEN** 應用程式由一個執行中的 Claude Code session 啟動，其環境帶有宣告該從屬關係的變數
- **THEN** 這些變數不出現在任何 session 的 pty 環境中

#### Scenario: 認證用的變數不被剝除

- **WHEN** 環境中存在 `claude` 用於認證的變數
- **THEN** 它們原封不動地傳入 pty 的環境

### Requirement: 持久化的識別碼在被用於命令或檔案路徑之前必須驗證

任何持久化的識別碼 SHALL 在被用於組成外部命令或檔案路徑之前，以嚴格的格式驗證。持久化的內容是
**不受信任的輸入** —— 它是磁碟上的檔案，可能被竄改或損毀。

驗證不通過時 SHALL 丟棄該筆資訊 —— 對話識別碼不合法時 SHALL 以全新的對話重建該 session；
session 識別碼不合法時 SHALL 丟棄該 session。SHALL NOT 將未經驗證的值拼接進任何命令或路徑。

#### Scenario: 不合法的對話識別碼不進入命令

- **WHEN** 持久化檔案中某個 session 的對話識別碼不是合法格式
- **THEN** 該值不被拼接進任何命令，且該 session 以一個全新的對話重建

#### Scenario: 不合法的 session 識別碼不進入檔案路徑

- **WHEN** 持久化檔案中某個 session 的識別碼不是合法格式
- **THEN** 該值不被用於組成任何檔案路徑，且該 session 被丟棄

### Requirement: 持久化不得把路徑詞彙交給 renderer

renderer 送往持久化的內容 SHALL NOT 包含任何絕對或相對路徑。session 的工作目錄 SHALL 由主行程
自行解析、驗證與夾制 —— renderer 至多供應一個**不可逆的工作目錄識別碼**（不含路徑資訊），
SHALL NOT 能指定任何路徑。

此為 `terminal-sessions`「renderer 僅以 `folderId` 與工作目錄識別碼指定 session 位置」的延續：
持久化若接受 renderer 送來的**路徑**，即等同把一個路徑詞彙交還給 renderer，該邊界論證即失效。
**識別碼不構成例外**：它不可逆推為路徑，且主行程只對查表命中的值解析 —— 於是 renderer 可達的
位置集合仍恆等於工作目錄的列舉結果，而不是任意路徑。

**本要求涵蓋 session 落盤資料中的每一個工作目錄事實。** 側欄的工作目錄已不在其中（它隨側欄座標
改基到 rail 的項目上，見 `side-panel-source`）—— **但那條原則 SHALL NOT 因此鬆動**，它由
`side-panel-source` 的「側欄座標跨應用程式重啟存活」以相同的措辭承接：落盤的內容會在**下次啟動
時**被解析，一個落盤的路徑等同一個繞過查表的位置指定，其危害與它當初是為了什麼用途、又寫進哪
一個檔案，都無關。

**這與 renderer 記憶體中持有 folder-relative 路徑並不衝突** —— 那本來就是它對檔案系統定址的
合法詞彙（見 `filesystem-access`）。本要求約束的是**送往持久化的內容**。

主行程自行取得的路徑（例如 shell 的最後工作目錄）SHALL NOT 送往 renderer。

#### Scenario: 持久化介面不接受任何路徑參數

- **WHEN** 檢視 renderer 可用的持久化能力介面
- **THEN** 其中不存在任何讓 renderer 指定工作目錄**路徑**或檔案路徑的參數

#### Scenario: 工作目錄以不可逆識別碼往返

- **WHEN** 檢視 renderer 送往持久化、以及自持久化取回的 session 資料
- **THEN** 其中的工作目錄僅以不可逆識別碼表示，不含任何路徑片段

### Requirement: 持久化檔案的損毀不得使應用程式無法啟動

持久化檔案無法解析、或版本不符時，應用程式 SHALL 隔離該檔案（改名保留，不刪除）並以空的 session
清單啟動。

個別 session 項目不合法時 SHALL 只丟棄**該項**，其餘 session SHALL 照常重建 —— 一個壞掉的 session
SHALL NOT 使所有 session 一併消失。

任何讀取失敗 SHALL NOT 使應用程式無法啟動。

#### Scenario: 整份損毀時以空清單啟動並保留原檔

- **WHEN** 持久化檔案的內容無法解析
- **THEN** 應用程式正常啟動且沒有任何 session，原檔案被改名保留

#### Scenario: 單一項目不合法時其餘照常重建

- **WHEN** 持久化檔案中有一個 session 項目的欄位不合法，其餘項目合法
- **THEN** 應用程式重建其餘的 session，只丟棄不合法的那一個

### Requirement: 已結束的 session 不被持久化

pty 已結束（`exited`）的 session SHALL NOT 被持久化 —— 重新開啟應用程式時它們 SHALL NOT 出現。

#### Scenario: 已結束的 session 於重啟後不出現

- **WHEN** 一個 session 的 pty 已結束，使用者未關閉該 session 便關閉應用程式，然後重新開啟
- **THEN** 該 session 不出現於清單中

### Requirement: 應用程式非正常結束時仍保有最近一次快照

終端畫面的快照 SHALL NOT 只在關閉視窗時才產生 —— 應用程式非正常結束（未經正常關閉流程）時，
最近一次的快照 SHALL 仍然可用。

#### Scenario: 強制結束後仍能還原畫面

- **WHEN** 使用者在一個 shell session 產生輸出、稍候片刻，應用程式隨後被強制結束
- **THEN** 重新開啟應用程式並喚醒該 session 時，先前的終端內容仍可見

### Requirement: claude 目標的 session 於其建立時的工作目錄重生

spawn 目標為 `claude` 的 session 被喚醒時，其 pty 的工作目錄 SHALL 為該 session **建立時所選定的
工作目錄**，而非恆為 folder 的根目錄。

**隸屬於某個 folder 的 session**，該位置 SHALL 由持久化的工作目錄識別碼查表解析，SHALL NOT 由觀測
pty 當下的工作目錄取得 —— agent 在 session 內執行的 `cd` 發生於子行程，不改變 pty 自身的工作目錄；
而識別碼記錄的是使用者的**選擇**，它比任一時刻的觀測值都更能代表這個 session 該在哪裡。

**全域 session 沒有工作目錄識別碼可查**（見 `global-session`）—— 它建立時的工作目錄恆為家目錄，
其位置由該能力定義，SHALL NOT 因查表落空而退回任何 folder 的根目錄。**「不由觀測值取得」這條對它
同等成立且更為要緊**：`claude --resume` 的對話查找與所在位置相關，一個開在家目錄的對話自其他目錄
續接時會查無此對話，隨後靜默自癒為全新對話。

**續接失敗後自癒產生的 pty 同樣 SHALL 位於該工作目錄。** 這不是邊角：對話續接失敗是**主線情境**
（開了 session 卻還沒跟 agent 講過話時，它不寫 transcript，`--resume` 必定失敗），而自癒對
renderer **完全不可見** —— 使用者拿到的是一個能用的 agent，只是它站在錯的地方，且沒有任何訊號。

#### Scenario: 於 worktree 建立的 claude session 重生後仍在該 worktree

- **WHEN** 使用者於某個 linked worktree 建立一個 claude session，關閉並重新開啟應用程式，喚醒它
- **THEN** 新的 pty 的工作目錄為該 worktree 的根

#### Scenario: 續接失敗自癒後仍在該 worktree

- **WHEN** 一個於 linked worktree 建立的 claude session 被喚醒，而其對話無法續接因而自癒為全新對話
- **THEN** 自癒產生的 pty 的工作目錄仍為該 worktree 的根，而非該 folder 的根目錄

#### Scenario: 於 folder 根建立的 claude session 重生於 folder 根

- **WHEN** 一個未指定工作目錄的 claude session 被重建並喚醒
- **THEN** 新的 pty 的工作目錄為該 folder 的根目錄

#### Scenario: 全域 claude session 重生於家目錄

- **WHEN** 一個全域 claude session 被重建並喚醒
- **THEN** 新的 pty 的工作目錄為家目錄，且不因沒有工作目錄識別碼可查而退回任何 folder

### Requirement: session 的來源與固定名字由主行程持久化，renderer 不能寫入

session 的來源（見 `session-lineage`）與 claude 目標的固定名字（見 `agent-peer-name`）SHALL 由
**主行程**寫入並持久化。renderer 送往持久化的 session 資料中即使含有它們，亦 SHALL 不被採信 ——
落盤時 SHALL 保留主行程已知的值，SHALL NOT 以 renderer 送來的值覆寫，亦 SHALL NOT 因 renderer
沒有送來而清除。

**理由**：來源決定了 agent 被告知「誰是你的母 session」，名字是 agent 被聯絡的地址 —— 兩者都是
關於身分的事實，不是呈現偏好。renderer 若能寫入它們，一個被入侵或有 bug 的 renderer 就能讓 agent
把訊息送給錯的對象，而使用者在畫面上看到的關係也不再可信。

**兩者都會在下次啟動時被使用，因此都適用「持久化的識別碼在被用於命令或檔案路徑之前必須驗證」**：

- 來源中的 session 識別碼會被**解析**（用以查找母 session）。不合法時 SHALL 丟棄該筆來源（該 session
  成為沒有來源的 session），SHALL NOT 丟棄該 session。
- 固定名字會成為 agent CLI 的**參數**。它 SHALL 以與產生時相同的字元集與長度規則驗證；不合法時
  SHALL 丟棄，並依 `agent-peer-name` 重新決定一個，SHALL NOT 以原值啟動 agent。

來源的快照（folder 名稱、session 標籤）是給人看的文字，SHALL NOT 被用於組成任何命令或檔案路徑；
系統 SHALL NOT 在其中放入任何路徑欄位。

session 被關閉時，它作為**母 session** 的關係 SHALL 保留在其子 session 上（見 `session-lineage`）。

#### Scenario: renderer 送來的來源與名字不被採信

- **WHEN** renderer 送往持久化的資料中，替一個 session 附上另一個 session 為其來源、並附上另一個名字
- **THEN** 重新啟動之後，該 session 的來源與名字與主行程原本記下的相同

#### Scenario: renderer 沒有送來源不會清掉來源

- **WHEN** session C 有來源，renderer 送往持久化的 C 資料中不含來源
- **THEN** 重新啟動之後，C 的來源仍在

#### Scenario: 不合法的來源識別碼只丟棄來源

- **WHEN** 持久化檔案中某個 session 的來源識別碼不是合法格式
- **THEN** 該 session 被重建且沒有來源，該值不被用於任何查找、命令或路徑

#### Scenario: 不合法的固定名字不進入 agent 的參數

- **WHEN** 持久化檔案中某個 claude session 的固定名字含有字元集之外的字元
- **THEN** 該 session 被喚醒時，agent 以一個合法的、重新決定的名字啟動，原值不出現在任何參數中

### Requirement: Restored sessions that were running start again; the others are dormant and start only on an explicit wake

重建出來的 session SHALL 先處於**休眠**狀態 —— 具備完整身分（名字、順序）但**沒有 pty**。

**A restored session that had a running process when its ptys were last ended without the session ending
SHALL start again on its own**, right after it is restored. That covers closing and reopening the application,
the application ending abnormally, a renderer reload, and on macOS reopening the window (`workspace-app-shell`).
It starts exactly as an explicit wake would start it — a `claude` session resumes its conversation, a shell
session respawns in its last directory after its snapshot is replayed — with the same handling of a failure (the
reason is shown on the dormant screen, and the wake action is the retry). Starting it SHALL be **quiet**: it
SHALL NOT change the rail selection or the displayed session, and SHALL NOT take the keyboard focus from where
the user has put it. **When focus is nowhere at the moment the session starts** — typically because the user had
displayed it and its own wake action held the focus, and that action disappears as it starts — focus SHALL move
to its input, as after an explicit wake. A wake the user triggers while such a session is waiting for its turn
SHALL behave exactly as an explicit wake, focus included, and SHALL NOT start it a second time.

**A systemic failure SHALL NOT be repeated across every session.** The system SHALL NOT start any `claude` session
this way when it could not read the user's shell environment at launch (without it the agent may not be found);
those sessions SHALL stay dormant, still recorded as running, and say why. And when the first `claude` session
started this way ends on its own within moments of starting, the remaining `claude` sessions SHALL NOT be started,
SHALL stay dormant and still recorded as running, and SHALL say why. A first session that the user closes or
hibernates during those moments, or whose process cannot be created, does not count as such a failure; the next
`claude` session takes its place. A failure of an individual session after that does not stop the others.

A session that starts while it is not displayed has no terminal size to take (`terminal-sessions`: no size is
derived without a layout box): it starts at the default size, as a session a paired device starts, and takes the
terminal's size when it is first displayed. **Until it has been displayed, a shell started this way SHALL NOT
replace its saved screen**: its terminal still holds the replayed history at a size never measured, and saving it
would rewrap that history and add a replay separator at every restart.

Whether a session was running SHALL be recorded by the system, not by the interface: it is running from the
moment its process starts (created, woken, or restarted after a failed resume) until it is hibernated. Ending
the processes because the window closes, the renderer reloads or the application quits SHALL NOT change the
record; a session that ends on its own or is closed is not persisted at all. **A record written before this
rule existed has no such information, and its sessions SHALL be restored dormant** — the first launch after
upgrading starts nothing, as before.

**Every other restored session — one that was dormant when the processes were ended — SHALL start its pty only
when the user explicitly wakes it, or when an agent's wake command reaches it (see `agent-session-control`).** That is a session the user or the idle policy hibernated, and a restored
session that was never woken. Displaying a dormant session — selecting its rail item, switching to it with the
keyboard, clicking its tab — SHALL NOT start it. This holds for every dormant session, whether it was restored
or hibernated (see `session-hibernation`).

The dormant screen SHALL offer a wake action in both the terminal view and the conversation view. When a
dormant session becomes the displayed session and nothing covers it, the wake action SHALL receive focus —
where a running session's input would — so that pressing `Enter` wakes it, in either view. Once it is running,
focus SHALL move to its input, so that typing reaches it.

**Selecting a rail item therefore starts no session.**
**選中的 rail 項目不被持久化，且冷啟動時 SHALL NOT 有任何項目被預設選中**（含 `global-session` 的
全域項目）—— that rule predates explicit wake and still holds; it keeps "what is selected" from depending on
the previous run. Sessions that start again at launch do so without any item being selected.

**Why explicit wake rather than wake-on-display**: a session kept for occasional use would otherwise be started
by any keyboard pass over it (`Ctrl+Tab`, `Ctrl+↓`), defeating hibernation as a way to save resources.
**Why the running ones start again**: the user did not put them to sleep; a restart is not a decision about
which sessions to keep running, and hibernation already records the sessions that should stay asleep.

休眠狀態 SHALL 被明確地呈現，SHALL NOT 呈現為一個空白的畫面 —— **無論當下是哪一種 view**。
終端 view 之下是一個空白的終端，對話 view 之下是一份空白的對話，兩者是同一個錯誤的兩種長相：
**它與「這個 session 真的還沒講話」無法區分**，而兩者的正確處置不同。

未被喚醒的休眠 session SHALL 維持持久化 —— 使用者一路未喚醒它便再次關閉應用程式時，它 SHALL 於
下次開啟時仍然存在，且仍為休眠。

#### Scenario: Sessions that were running start again when the application opens

- **WHEN** the user closes the application while several sessions are running, and reopens it
- **THEN** each of those sessions has started a pty, without the user waking it
- **AND** a `claude` session among them has resumed its conversation and a shell session among them runs in its
  last directory

#### Scenario: Sessions that were dormant stay dormant when the application opens

- **WHEN** the user closes the application while one session is running and another has been hibernated, and
  reopens it
- **THEN** the session that was running has started a pty, and the hibernated one is dormant and has no pty

#### Scenario: Starting again at launch does not take the user's focus

- **WHEN** the application reopens, the user displays a session that was running before it has started again,
  moves the focus into the side panel, and then that session starts again
- **THEN** the session is still displayed and the focus is still in the side panel

#### Scenario: A displayed session whose wake action has focus gets its input focused

- **WHEN** the application reopens, the user displays by keyboard a session that was running, so that its wake
  action has the focus, and then that session starts again
- **THEN** the focus is on that session's input

#### Scenario: Waking a session that is waiting for its turn is an explicit wake

- **WHEN** the application reopens and the user triggers the wake action of a displayed session that was running
  before it has started again
- **THEN** that session has started exactly once and the focus is on its input

#### Scenario: Starting again does not take focus the user moved while it was starting

- **WHEN** the application reopens, a session that was running is being started, and before it has started the user
  displays it and then moves the focus into the side panel
- **THEN** once it has started, the focus is still in the side panel

#### Scenario: The first agent's failure keeps the others dormant and says why

- **WHEN** the application reopens with several `claude` sessions that were running, and the agent cannot be
  started at all
- **THEN** at most the first of them has been started, and the others are dormant, still present, and their dormant
  screen says why they were not started

#### Scenario: A first agent the user hibernates does not stop the others

- **WHEN** the application reopens with several `claude` sessions that were running, and the user hibernates the
  first of them right after it starts
- **THEN** the other `claude` sessions start

#### Scenario: Without the user's environment no agent is started

- **WHEN** the application reopens with `claude` sessions that were running, and the user's shell environment could
  not be read
- **THEN** no `claude` session has been started, and each says why on its dormant screen

#### Scenario: Sessions started at launch take the terminal's size when shown

- **WHEN** a session that started again at launch is displayed for the first time
- **THEN** its pty's columns and rows match the terminal's available size, not the size it was spawned with

#### Scenario: A shell started while hidden keeps its saved screen until displayed

- **WHEN** a shell session is running when the application closes, the application is reopened, the shell starts
  again without being displayed, and the application is closed and reopened again without displaying it
- **THEN** its replayed screen is the same as after the first reopen: no added replay separator, no lines rewrapped

#### Scenario: A session that ended abnormally comes back running

- **WHEN** the application is killed while a session is running, and is opened again
- **THEN** that session has started a pty

#### Scenario: Sessions that were running start again after a renderer reload

- **WHEN** the renderer reloads while one session is running and another is dormant
- **THEN** after the reload the session that was running has started a pty and the dormant one has none

#### Scenario: Opening the application starts no session

- **WHEN** the application opens with persisted sessions that were all dormant when it closed, and the user selects
  one of their rail items
- **THEN** no session has started a pty; every session is dormant

#### Scenario: The first launch after upgrading starts nothing

- **WHEN** the application opens with persisted sessions recorded before the system recorded whether they were
  running
- **THEN** no session has started a pty; every session is dormant

#### Scenario: A session that fails to start again stays dormant and says why

- **WHEN** a session that was running cannot be started again when the application opens, because its process
  cannot be created (for example its folder is still in the workspace but its directory no longer exists)
- **THEN** it is dormant, its dormant screen shows the reason, and its wake action is available as the retry

#### Scenario: 冷啟動不因全域項目恆存而喚醒 session

- **WHEN** 使用者關閉應用程式時全域項目有數個休眠的 session，重新開啟應用程式但尚未選中任何 rail 項目
- **THEN** 沒有任何 session 啟動 pty，全域項目的 session 皆為休眠

#### Scenario: Displaying a dormant session does not start it

- **WHEN** the user switches to a dormant session, by selecting its rail item or by keyboard
- **THEN** it is displayed as dormant and has no pty

#### Scenario: The wake action starts a dormant session

- **WHEN** the user triggers the wake action of a displayed dormant session
- **THEN** that session starts its pty

#### Scenario: Enter wakes the displayed dormant session

- **WHEN** a dormant session becomes displayed by keyboard and the user presses `Enter`
- **THEN** that session starts its pty

#### Scenario: Typing after a keyboard wake reaches the session

- **WHEN** a dormant session becomes displayed by keyboard, the user presses `Enter`, and then types a command
  and presses `Enter` again
- **THEN** the command runs in that session

#### Scenario: 休眠的 session 不呈現為空白終端

- **WHEN** 使用者檢視一個尚未被喚醒的休眠 session
- **THEN** 該 session 明確地呈現其休眠狀態，而非一個沒有內容的終端

#### Scenario: 休眠的 session 於對話 view 不呈現為空白對話

- **WHEN** 使用者檢視一個尚未被喚醒的休眠 session，且其當前 view 為對話
- **THEN** 該 session 明確地呈現其休眠狀態，而非一份沒有內容的對話
- **AND** the wake action is offered there as well

#### Scenario: 未喚醒的休眠 session 於再次重啟後仍存在

- **WHEN** 使用者重新開啟應用程式、未喚醒某個休眠 session、再次關閉並重新開啟應用程式
- **THEN** 該 session 仍然存在且仍為休眠

#### Scenario: An agent's wake starts a dormant session without displaying it

- **WHEN** the user hibernated session P, P's child C is running and displayed with the keyboard focus in its
  terminal, and the agent in C writes a wake command targeting P's name
- **THEN** P has started a pty, and the rail selection, the displayed session and the keyboard focus are what they
  were before
