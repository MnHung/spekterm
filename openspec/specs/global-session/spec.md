# global-session Specification

## Purpose

在 workspace rail 上恆常提供一格**不隸屬於任何 workspace folder** 的項目，讓使用者開得出與任何
repo 都無關的 `claude` 或 login shell —— 有些脈絡本來就不屬於任何一個 repo。

**它與「把家目錄加進 workspace」的差別是全部的重點**：後者確實也開得出 session，但會把 `fs.*`
的白名單與 Files 的檔案樹**對整個家目錄開放**；全域 session 只改變 pty 的**初始工作目錄**，而
`terminal-sessions` 早已明文「此邊界只約束初始工作目錄」。**`filesystem-access` 因此一條未改** ——
家目錄不是任何 folder，renderer 一個位元組都讀不到它。

除了「沒有自身的 repo」所必然帶來的差異（無分支、不可移除、不可排序、側欄來源預設未選定）之外，
全域項目與 folder 的列**共用同一條路徑**：session 分頁列、focus 記憶、鍵盤導航、持久化與重建、
側欄座標，一律同等適用。

## Requirements

### Requirement: rail 恆常呈現一個不隸屬於任何 workspace folder 的全域項目

workspace rail SHALL 恆常呈現一個**全域項目**，它 SHALL NOT 隸屬於任何 workspace folder。它
SHALL 位於所有 folder 之前，且 SHALL 恆為 rail **置頂段**的第一列（見「全域項目恆為置頂，且該
狀態不可取消」）。

**明確的視覺分隔 SHALL 劃在置頂段與其餘 folder 之間** —— 亦即全域項目與置頂的 folder 位於分隔
線的**同一側**。此處原本要求分隔線劃在全域項目與整個 folder 清單之間；置頂能力使分隔線之上不再
只有全域項目，兩者無法並存。

因此「使用者要能一眼看出它與 repo 不是同一類東西」這件事 SHALL 由該列**自身的呈現**承擔，而不
再由分隔線承擔：它使用與 folder 不同的圖示、不呈現 git 分支、不提供移除入口，且其置頂指示為
停用。workspace 尚無任何置頂的 folder 時，分隔線的位置與此前相同。

全域項目 SHALL 在 workspace **尚未加入任何 folder** 時同樣呈現。它是這個應用程式恆常提供的一格，
不是 workspace 內容的函數。

全域項目 SHALL 呈現一個標籤，SHALL NOT 呈現 git 分支 —— 它沒有 repo 可讀（見 `repo-branch`，
該能力的措辭限於 workspace 的 folder）。

**全域項目 SHALL NOT 於冷啟動時被預設選中。** This rule was introduced so that cold start would not wake
the global item's focused session. Since dormant sessions now start only on an explicit wake (see
`session-persistence`), selecting an item no longer starts anything, and that reason is gone; the rule stays
because "what is selected" must not depend on what an earlier run left behind, and the empty state is the
honest one when the user has not chosen yet.

**rail 上「選中哪個項目」的表示 SHALL 使「未選中」與「選中全域項目」互斥可辨。** 兩者若共用同一個
缺席值，每一處以「有沒有選中」為條件的行為（快捷鍵的無操作條件、狀態列的空狀態）都會把使用者
明確選中的全域項目誤判為「他還沒選」。

#### Scenario: 全域項目位於所有 folder 之前

- **WHEN** workspace 已加入一或多個 folder
- **THEN** rail 的第一個項目為全域項目，其後才是各個 folder

#### Scenario: 分隔線劃在置頂段與其餘 folder 之間

- **WHEN** workspace 有一或多個置頂的 folder
- **THEN** 全域項目與那些置頂的 folder 位於分隔線的同一側，未置頂的 folder 位於另一側

#### Scenario: 尚無置頂的 folder 時分隔線緊接於全域項目之後

- **WHEN** workspace 有一或多個 folder，但沒有任何一個被置頂
- **THEN** 分隔線緊接於全域項目之後，其後才是各個 folder

#### Scenario: 尚無任何 folder 時仍呈現

- **WHEN** workspace 尚未加入任何 folder
- **THEN** rail 仍呈現全域項目

#### Scenario: 不呈現 git 分支

- **WHEN** 使用者檢視 rail 上的全域項目
- **THEN** 該列不呈現任何 git 分支資訊
- **AND** workspace 的持久化設定中不存在任何路徑為家目錄的 folder 條目 —— 全域項目不是被合成
  出來的一筆 folder

#### Scenario: 冷啟動不預設選中全域項目

- **WHEN** 應用程式啟動完成，使用者尚未點選任何 rail 項目
- **THEN** 沒有任何 rail 項目被選中，主舞台呈現尚未選擇項目的空狀態

### Requirement: 全域項目不是 workspace 的成員

全域項目 SHALL NOT 出現在 workspace 的 folder 清單中，因此：

- SHALL NOT 提供移除的入口，亦 SHALL NOT 可被移除；
- SHALL NOT 可被拖曳排序，且 SHALL NOT 成為其他項目拖曳時的落點 —— 它的位置是固定的；
- 其存在與否 SHALL NOT 被寫入 workspace 的持久化設定（見 `workspace-folders`）。

**folder 的拖曳排序其落點索引 SHALL 以 folder 清單為基準計算，SHALL NOT 以 rail 上的列位置計算。**

此處原本寫「rail 比 folder 清單多了**一列**，兩者的索引因此**相差一位**」。置頂能力使該敘述
**不再成立**：rail 的列空間有兩列不是 folder（全域項目與分界），而分界的位置隨置頂數變動 ——
**偏移量因此不是常數**（分界之上為一、之下為二）。把它當成一個固定的差值，正是這條要求本來
就在防的那個 off-by-one，只是形式更隱蔽。

因此：拖曳與鍵盤排序 SHALL 在一個**明確定義的列空間**中進行（見 `rail-pinning` 的「使項目跨越
分界的移動即改變其置頂狀態」），該列空間與 folder 清單之間的換算 SHALL 集中於**單一處**，且
SHALL NOT 以任何形式散落為「加一」或「減一」的常數。全域項目 SHALL NOT 進入該列空間 —— 它既
不可拖曳，也不作為落點。

#### Scenario: 不提供移除入口

- **WHEN** 使用者檢視 rail 上的全域項目
- **THEN** 該列不提供移除的入口

#### Scenario: 不可被拖曳排序

- **WHEN** 使用者嘗試以滑鼠拖曳全域項目
- **THEN** rail 的順序不變，且不呈現任何插入指示線

#### Scenario: 全域項目不使 folder 的拖曳落點偏移

- **WHEN** workspace 有三個以上的 folder 且皆未置頂，使用者將第一個 folder 拖曳至第二個 folder
  的下半部
- **THEN** 該 folder 落在第二個 folder 之後，且不因 rail 上多出的全域項目而落到其他位置

#### Scenario: 分界不使 folder 的拖曳落點偏移

- **WHEN** workspace 有兩個置頂與三個未置頂的 folder，使用者將第一個**未置頂**的 folder 拖曳至
  第二個未置頂 folder 的下半部
- **THEN** 該 folder 落在第二個未置頂 folder 之後 —— 不因 rail 上多出的全域項目與分界而落到
  其他位置

#### Scenario: 不進入 workspace 的持久化設定

- **WHEN** 檢視 workspace 的持久化設定內容
- **THEN** 其中不含代表全域項目的任何條目

### Requirement: 全域項目恆為置頂，且該狀態不可取消

全域項目 SHALL 恆為 rail **置頂段的第一列**（見 `rail-pinning`）。它是這個應用程式恆常提供的
一格，因此「它會不會被捲出視野」不該取決於使用者記不記得去置頂它。

全域項目 SHALL 呈現一個置頂的指示，且該指示 SHALL 為**停用**狀態，並 SHALL 說明它恆為置頂。
它 SHALL NOT 提供取消置頂的入口。

**一個停用且明確宣告自身停用狀態、並說明原因的控制項，不構成 `workspace-layout` 所禁止的
「不可操作的控制項」**（見該能力的「rail 呈現每個 folder 的名稱與身分」）—— 那條禁令針對的是
「長得像可按、按下去卻什麼都不發生、且不傳達任何狀態」的元素。此處的指示傳達的正是使用者需要
知道的狀態：它是置頂的，而且動不了。

全域項目的置頂狀態 SHALL NOT 被寫入 workspace 的持久化設定 —— 它是恆定的性質，不是一筆可變的
狀態，落盤一個永遠不變的值等於落盤一個可能與程式碼分歧的謊言。

全域項目 SHALL NOT 提供右鍵選單。它既不可移除、其置頂狀態亦不可切換，一個只含停用項目的選單
正是上述禁令所指的那種元素。

#### Scenario: 呈現停用的置頂指示

- **WHEN** 使用者檢視 rail 上的全域項目
- **THEN** 該列呈現一個置頂的指示，該指示為停用狀態並附有說明它恆為置頂的提示

#### Scenario: 不提供取消置頂的入口

- **WHEN** 使用者嘗試觸發全域項目上的置頂指示
- **THEN** 全域項目仍為置頂，rail 的內容不變，且應用程式不產生錯誤

#### Scenario: 置頂狀態不進入持久化設定

- **WHEN** 檢視 workspace 的持久化設定內容
- **THEN** 其中不含任何代表全域項目置頂狀態的欄位

#### Scenario: 不提供右鍵選單

- **WHEN** 使用者於全域項目的標題列按下右鍵
- **THEN** 不呈現任何選單

### Requirement: 全域 session 的初始工作目錄為使用者的家目錄

使用者 SHALL 能於全域項目建立 session，spawn 目標與 folder 的 session 相同（`claude` 或
login shell）。該 session 的 pty 初始工作目錄 SHALL 為**使用者的家目錄**。

該路徑 SHALL 由主行程自行決定，renderer SHALL NOT 獲得任何新的路徑詞彙 —— 它至多表達「這是一個
全域 session」這件事，SHALL NOT 傳遞任何絕對或相對路徑，亦 SHALL NOT 傳遞任何可解析為路徑的
識別碼。於是 renderer 可達的初始工作目錄集合恰好擴大**一個由主行程決定的常數**，該集合仍由結構
保證，而非由字串驗證事後補救（見 `terminal-sessions`）。

主行程 SHALL 拒絕為全域 session 指定工作目錄識別碼的請求：全域 session 不隸屬任何 repo，沒有可供
查表的工作目錄集合，一個送進來的識別碼只可能是錯的 —— 此處比照既有的「查無對應即拒絕，不靜默
退回」。

此邊界只約束**初始**工作目錄。session 一旦啟動即為真實 shell，pty 內執行的命令 SHALL NOT 被此
邊界限制。

#### Scenario: 於全域項目建立 session

- **WHEN** 使用者於全域項目建立一個 session
- **THEN** 主行程回傳一個 session 識別碼，且該 session 的 pty 初始工作目錄為使用者的家目錄

#### Scenario: 兩種 spawn 目標皆可選

- **WHEN** 使用者觸發全域項目的建立 session 入口
- **THEN** 使用者可選擇 spawn 目標為 `claude` 或 login shell

#### Scenario: 建立介面不接受路徑參數

- **WHEN** 檢視建立全域 session 的能力介面
- **THEN** 不存在讓 renderer 指定工作目錄路徑的參數

#### Scenario: 拒絕為全域 session 指定工作目錄識別碼

- **WHEN** 建立全域 session 的請求帶有一個工作目錄識別碼
- **THEN** 建立被拒絕並回報錯誤，不產生任何 pty
- **AND** 不以家目錄替代之

### Requirement: 全域 session 的工作目錄依 spawn 目標記憶並重生

全域 session 的工作目錄 SHALL 沿用 `session-persistence` 既有的依 spawn 目標分工，SHALL NOT 另立
一套規則：

- spawn 目標為 **login shell** 者，重生時 SHALL 位於該 session **最後已知的**工作目錄；
- spawn 目標為 **claude** 者，重生時 SHALL 位於該 session **建立時的**工作目錄，即家目錄。

**shell 目標的工作目錄 SHALL NOT 受路徑夾制**，僅 SHALL 在該目錄已不存在或無法取得時退回家目錄。
既有夾制的正當性來自 session 宣稱自己屬於某個 folder；全域 session 沒有這個宣稱，家目錄是它的
**起點**而非**邊界**。夾制在此唯一的效果會是「使用者切換到別處之後重開應用程式莫名跳回家目錄」。

**持久化的**工作目錄 SHALL 由主行程自行取得、保存與使用，SHALL NOT 送往 renderer（延續
`session-persistence` 的「持久化不得把路徑詞彙交給 renderer」）。**此禁令的作用域限於持久化** ——
狀態列為呈現而取得的當下工作目錄不在其內（見 `status-bar`：那是一個顯示字串，不是可定址的詞彙，
且使用者 `cd` 到哪裡，狀態列就該誠實地說他在那裡）。

**全域 session 的工作目錄恰為家目錄時 SHALL NOT 偵測 git 工作區狀態。** 家目錄本身是 git repo 是
常見設定（dotfiles 工作流），而該偵測是**同步**執行的外部程式呼叫、每數秒對 focused session 重複
一次 —— 於整個家目錄執行它會週期性地阻塞主行程（IPC 不回應、pty 轉發延遲）。「整個家目錄的 dirty
狀態」對使用者本來就沒有意義；一旦 `cd` 進真正的工作區，狀態 SHALL 照常呈現。

**claude 目標不得改以觀測到的工作目錄重生。** `claude --resume` 的對話查找與所在位置相關：一個
開在家目錄的對話自另一個目錄續接時會查無此對話，隨後靜默自癒為全新對話 —— 使用者拿到一個能用的
agent，只是歷史沒了，且沒有任何訊號。

#### Scenario: shell 目標於最後的工作目錄重生

- **WHEN** 使用者在一個全域 shell session 內切換到家目錄**之下**的某個子目錄，關閉應用程式，
  重新開啟並喚醒該 session
- **THEN** 新的 shell 的工作目錄為該子目錄

#### Scenario: 工作目錄為家目錄時不偵測 git 狀態

- **WHEN** 使用者的家目錄本身是一個 git 工作區，而 focused session 為一個位於家目錄的全域 session
- **THEN** 不對家目錄執行 git 工作區狀態的偵測，且狀態列不呈現分支欄位

#### Scenario: cd 進工作區後照常偵測

- **WHEN** 使用者於該全域 session 內切換到某個 git 工作區之下
- **THEN** 該工作區的狀態照常被偵測並呈現

#### Scenario: shell 目標的工作目錄不受路徑夾制

- **WHEN** 使用者在一個全域 shell session 內切換到家目錄之外的某個目錄（例如 `/tmp` 之下），關閉
  應用程式，重新開啟並喚醒該 session
- **THEN** 新的 shell 的工作目錄為該目錄，而非家目錄

#### Scenario: 工作目錄已不存在時退回家目錄

- **WHEN** 一個全域 shell session 最後已知的工作目錄在重開應用程式時已不存在
- **THEN** 新的 shell 的工作目錄為家目錄

#### Scenario: claude 目標恆於家目錄重生

- **WHEN** 一個全域 claude session 被喚醒
- **THEN** 新的 pty 的工作目錄為家目錄，不論該 session 先前曾被觀測到位於何處

#### Scenario: 續接失敗自癒後仍於家目錄

- **WHEN** 一個全域 claude session 被喚醒，而其對話無法續接因而自癒為全新對話
- **THEN** 自癒產生的 pty 的工作目錄仍為家目錄

### Requirement: 全域 session 不具備「自身所屬的 folder」，凡以此為條件者對它恆不成立

全域 session **沒有**自身所屬的 folder，凡以「某值等於該 session 所屬 folder」為條件者 SHALL 判定
為**不成立**，SHALL NOT 因兩端同為缺席值而判定為成立。

**這條要求存在的理由是一個具體的失效路徑，不是語意潔癖。** 全域 session 所屬的 folder 為缺席值，
而全域項目的側欄來源預設**也**是缺席值；一個樸素的相等比較會使兩者「相等」，於是
`artifact-continuation` 的續寫入口**錯誤地啟用**，把一個 change 識別碼送進站在家目錄的 agent ——
它會在家目錄建出一個同名的空 change。**誤判的方向是啟用而非停用**，因此後果不是少一個按鈕，而是
agent 在錯的地方動手，且使用者以為它在對的地方。

判定 SHALL 先確認該 session 是否為全域 session，SHALL NOT 倚賴兩個缺席值的比較結果。

#### Scenario: 續寫入口對全域 session 恆為停用

- **WHEN** focused session 為一個全域 session，而側欄座標錨定了某個 change
- **THEN** 續寫入口以停用狀態呈現並說明原因

#### Scenario: 側欄來源亦未選定時仍為停用

- **WHEN** focused session 為一個全域 session，且該全域項目的側欄來源尚未選定
- **THEN** 續寫入口仍以停用狀態呈現，SHALL NOT 因兩者同為缺席值而啟用

### Requirement: 全域 session 一樣跨重啟存活並重建

全域 session SHALL 與 folder 的 session 一樣被持久化並於下次開啟應用程式時重建，包含：spawn 目標、
使用者取的名字、分頁順序、pty 最近一次宣告的終端標題，以及 claude 目標的對話識別碼。A restored global
session SHALL follow the same rule as any other restored session (see `session-persistence`): one that was
running when the application closed starts again on its own, and one that was dormant then is dormant and SHALL
start its pty only when the user explicitly wakes it.

持久化的內容 SHALL 以「不隸屬任何 folder」為一個明確表示的狀態，SHALL NOT 以某個保留的 folder
識別碼字串偽裝成隸屬於某個 folder —— 後者會使每一處「以識別碼查找 folder」的程式碼靜默地查無此
folder，而型別檢查對此無能為力。

#### Scenario: 全域 session 跨重啟重建

- **WHEN** 使用者建立數個全域 session 並為其中之一命名，關閉並重新開啟應用程式
- **THEN** 那些 session 以原本的順序與名字重建於全域項目之下

#### Scenario: claude 目標的全域 session 續接原對話

- **WHEN** 一個全域 claude session 曾與 agent 對話過，關閉並重新開啟應用程式後它已再次啟動或被喚醒
- **THEN** 該 session 續接同一個對話

#### Scenario: A running global session starts again when the application opens

- **WHEN** a global session is running when the application closes, and the application is reopened
- **THEN** that session has started a pty, without the user selecting the global item or waking it

#### Scenario: Selecting the global item does not start its sessions

- **WHEN** the application is reopened with several global sessions that were dormant when it closed, and the
  user selects the global item
- **THEN** its focused session is displayed as dormant and no global session has started a pty

#### Scenario: 落盤內容以明確狀態表示不隸屬任何 folder

- **WHEN** 檢視持久化的 session 清單內容
- **THEN** 全域 session 的條目以一個明確的狀態表示它不隸屬任何 folder，而非帶有一個不對應任何
  workspace folder 的識別碼字串

### Requirement: 以「沒有任何 folder」為前提的條款，其驗收於零 folder 的 workspace 進行

凡以「workspace 中沒有任何 folder」為前提的條款，其驗收 SHALL 於一個**確實沒有任何 folder** 的 workspace 執行，SHALL NOT 於種有 folder 的驗收環境中執行。

**理由是鑑別力，而且失效方向是假綠**：種有 folder 的環境**區分不了「恆常呈現」與「有 folder 時才呈現」**。全域項目的呈現若寫成「rail 為空就不渲染任何東西」，在種了三個 folder 的環境中，「全域項目是 rail 的第一個項目」這條斷言**照樣通過** —— 它測到的是「有 folder 時全域項目在第一個」，而那不是本能力所要求的性質。

**本要求的涵蓋範圍跨越四個能力**，它們共用同一個前提，因此也共用同一種假綠與同一個驗收載體：

- 本能力的「尚無任何 folder 時仍呈現」
- `keyboard-navigation` 的「rail 只有全域項目時為無操作」
- `status-bar` 的「workspace 為空且無任何 session 時」與「workspace 為空但有全域 session 時不呈現空狀態」
- `file-explorer` 的「沒有可用的側欄來源」——「來源未選定」與「沒有 folder 可選」是**兩個狀態**，而在種有 folder 的環境中只驗得到前者

**寫下這個範圍是本要求的一部分**：只寫「全域項目的恆常性要以零 folder 驗證」時，下一個人只會想到 rail 那一條，而另外三條的載體會在下一次調整驗收環境時被靜默移除。

**驗證「某快捷鍵為無操作」時，斷言 SHALL 以絕對狀態表述，SHALL NOT 僅表述為「與前一刻相同」。** 快捷鍵在對話框或選單開啟時一律被抑制（見 `keyboard-navigation`），而零 folder 是一個罕被執行的啟動狀態。若斷言寫成「選中項與按鍵前相同」，一個被抑制的快捷鍵會使兩側同為「沒有選中任何項目」而**照樣通過** —— 在相對判定下，「按了沒有反應」與「規格所要求的無操作」完全相同。寫成「選中項仍為全域項目」則兩者可分：被抑制時根本沒有東西被選中。

**此外 SHALL 先執行一次應當有作用的按鍵並斷言其效果，再執行待測的那一次。** 這一步的價值是**診斷力與防退化**：失敗時它區分得出「快捷鍵整個失效」與「無操作的行為不正確」，而它的存在也使日後有人把上述判定式改寫回相對比較時，仍有一條斷言擋在那裡。

（實測記錄：注入一個 `[role="dialog"]` 使快捷鍵被抑制後，**兩條斷言同時變紅** —— 絕對判定本身已免疫於該假綠。原先的設計預期是「第一步紅、第二步綠」，那個預期建立在相對判定上。**真正承重的是絕對判定，先按一次是輔助**。）

#### Scenario: 恆常呈現的驗收於零 folder 的 workspace 進行

- **WHEN** 驗證全域項目「尚無任何 folder 時仍呈現」
- **THEN** 該次驗收所啟動的 workspace 不含任何 folder

#### Scenario: 零 folder 下的無操作驗收以絕對狀態表述

- **WHEN** 於零 folder 的 workspace 驗證某快捷鍵為無操作
- **THEN** 該斷言表述為「選中項仍為全域項目」而非「選中項與按鍵前相同」——後者在快捷鍵被抑制時同樣成立

#### Scenario: 零 folder 下的無操作驗收先證明快捷鍵生效

- **WHEN** 於零 folder 的 workspace 驗證某快捷鍵為無操作
- **THEN** 該次驗收先以一次應當有作用的按鍵證明快捷鍵未被抑制，其後才斷言待測按鍵的無操作
