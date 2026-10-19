# 交接（agent-initiated handoff）的實測結論

> 觸發器：動 `src/main/handoff-*`、`src/main/agent-injection.ts` 的合成、或任何**倚賴注入內容
> 真的進入 agent 脈絡**的東西之前，先讀這裡。

## 一、`SessionStart` hook 的 stdout 確實進入 agent 的脈絡（實測）

**測於 2026-09-17，Claude Code 2.1.274。** 這個機制是 agent CLI 的行為、不是本應用程式的行為，
而在此之前**整個 repo 對它零證據** —— `additionalContext` / `hookSpecificOutput` 在版控中只命中
規格文字本身。design D0 因此把它排成第一個 task：先量，再依賴。

作法：以 `--settings` 注入一份只含 `SessionStart` hook 的設定，hook 命令是 `cat` 一個檔案，
檔案內容為
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<獨特字串>"}}`，
然後 `claude -p '把脈絡中所有以 <前綴> 開頭的字串列出來'`。

四個結論，**後三個都與直覺不同**：

| 情況 | 結果 |
|---|---|
| 合法的 `hookSpecificOutput` JSON | **進入脈絡** |
| **同一個事件上的兩條命令** | **兩條的內容都進入脈絡** |
| stdout 是**純文字**（不是 JSON） | **原樣進入脈絡** |
| stdout 是**格式壞掉的 JSON** | **原樣（含 JSON 的殘骸）進入脈絡** |
| 命令以**非零碼結束** | stdout **不進入脈絡**，且 session 照常完成 |

### 第二列是本能力可行的前提

事件橋接**已經佔用了 `SessionStart`**（`agent-events.ts` 的 `HOOKED_EVENTS`）。如果同一事件只有
第一條命令會被執行、或只有第一條的 stdout 會被採納，自我介紹就必須與事件回報**擠進同一條命令**
—— 兩個獨立的功能從此綁在一起，而關掉其中一個會讓另一個一起消失。實測否定了這個擔憂。

> **注意這與「合成器必須合併 `hooks`」是兩件不同的事。** CLI 端會把同一事件的多條命令都跑完，
> 但**我們自己的合成器**若逐鍵覆蓋，第二個貢獻者根本不會出現在送出去的設定裡 —— CLI 沒有機會
> 執行一條它沒收到的命令。兩邊都要對。

### 第三、四列的意義：降級是安全的，但內容是原樣的

`cat` 一個不存在的檔案 ⇒ 非零碼 ⇒ 什麼都不進去、session 照常 —— 這正是我們要的降級方向
（`agent-handoff-source` 的「告知失敗 SHALL 降級為沒有自我介紹」）。

但**格式壞掉不會被丟棄，它會以原文進入脈絡**。於是自我介紹檔的內容是什麼，agent 就讀到什麼 ——
它不是一個「格式對才算數」的通道。**寫進那個檔案的每一個位元組都要當成會被 agent 讀到。**

### 這個結論有前提

它綁在 CLI 的版本上。日後若 `SessionStart` 的 stdout 處置改變（例如改為只採納合法 JSON、或只跑
第一條命令），本能力的第一步會**靜默失效** —— agent 只是沒有被告知，它不會抱怨，而交接功能看
起來就像沒有人用。重測的方式就是上面那三行。

## 二、落點的一般化：`depth` 不參數化的失效是「看起來像時序問題」

共用投遞落點是**扁平**的（`intake-source.ts` 原本寫死 `depth: 0`），交接的落點是**每個 session
一層**。把 `IntakeSource` 一般化時若只參數化了 root 而漏掉 `depth`：

- **啟動掃描照常運作** —— 它是自己遞迴的，看得到子目錄裡的東西。
- **只有 watcher 收不到事件。**

於是症狀是「即時不進來、重啟才出現」。那看起來完全像一個時序問題，而它是一個少傳了參數的問題。

## 三、來源身分：目錄名擋得住什麼，擋不住什麼

一則交接的來源由「它落在哪一個 session 的目錄」推導。**它擋掉的是「payload 自稱來源」**，
於是收件匣「可驗證／第三方撰寫」的型別分類不被破壞。

**它擋不掉「agent 直接寫進別人的目錄」**：落點的根位置 agent 算得出來（`SPEKTERM_EVENT_DIR`
已經把 userData 交給它了，argv 上還有 `--settings` 的路徑），而它有完整的檔案系統寫入權。

**這不是一道安全邊界**，而那句話有兩個實際的下游後果：

- **（已移除）交接次數的上限曾經必須是全域的。** 第一版寫成 per 來源 session 的滾動窗口 —— 一個
  失控的 agent 只要輪流寫進不同 session 的目錄，每個計數器就都不會累積，**而那正是那道上限唯一要擋的
  情境**。上限本身已於 `handoff-session-lifecycle` 由使用者裁決移除（每一則交接都到達即建立並送出）；
  日後若要加回來，這條結論仍然成立。
- **完成報告可以被偽造**（`handoff-session-lifecycle`）。任何 agent 都能往別的 session 的落點寫一份
  `{"kind":"report"}`，把它標成已完成，再誘導使用者「收掉已完成」（關閉 pty 不可逆）。擋不住，只能
  讓它被看見：確認對話框列出每一個將被關閉的 session 的最新結果。

## 四、識別碼由內容摘要推導，不由檔名

`sessionId + 內容摘要`。兩個被否決的替代各自有一個具體的失效：

- **由檔名推導**（第一版的設計）＝ **由 agent 指定**，而那正是我們用來否決「由 payload 指定」的
  理由。同一個 session 兩次交接都叫 `handoff.json`：內容相同 ⇒ 靜默丟棄，內容不同 ⇒ `DUPLICATE`
  拒絕且不建 session，**而 agent 已經回報它交接出去了**。
- **接收時隨機產生** ⇒ 落點的「先建立監看、再掃描」會讓同一份投遞被讀兩次，於是**開出兩個
  session**，而既有的去重完全看不見。

## 五、驗收：三個花了很久才定位的坑

這一段不是流水帳 —— 每一個都讓一條**正確的實作**看起來像壞掉的產品。

### 5.1 替身的位元組收據是整個替身共用一份

`makeStubAgent` 一次建立一個 `$HOME`，而同一支探針段落裡的**每一個** agent session 都用它 ——
三個 session 的輸入位元組寫進**同一個** `agent-input.bytes`。於是：

- 「切掉前面 N 個字元看新增了什麼」拿到的是**交錯後的亂碼**；
- 連「出現過幾則」都不可靠（實測：三個 prefill 全部 `fill()` 了，收據只看得到兩則）。

**處置：不要拿它當「prompt 有沒有送到某個 session」的載體。** 產品自己的「待送出」標示
（`intake.prefillPending`）是 per-session 的，而且它正是那條 requirement 在說的事。

> **定位它的方法值得記下來**：在 `schedulePrefill` 的 `fill` 與訂閱回呼各加一行 `console.error`，
> 探針把主行程的 stderr 印出來。三行輸出就結束了兩個小時的猜測 —— **當「哪一半壞了」有兩種以上
> 的可能時，先加診斷，不要加假設。**

### 5.2 通知的觸發：合併窗沒結算就按下去，觸發到的是上一則

替身的觸發檔模擬的是「點了**最新**的那一則」。合併窗是秒級的 —— 在它結算之前觸發，拿到的是
**上一則**的主鍵，於是斷言測的是另一件事。

更隱蔽的一半：兩則到達若落在同一個窗裡就會**合併成一則**，而合併的通知依規格是「打開收件匣」。
探針裡的兩次投遞若挨得太近，它們就合併了 —— 而那不是產品的問題，是那一段沒有造出它要的前提。
**替身把每一則涵蓋的主鍵一起落盤**，正是為了讓這個前置寫得出來。

### 5.3 前綴不算命中：對照組要選**只屬於目標那一個**的前綴

驗「模糊比對會開在錯的 repo」時，若取的是兩個 folder 的**共同**前綴，模糊比對的實作會得到
「歧義」而不是「誤中」—— 它照樣不建 session，**對照組紅不起來**。

## 六、renderer 的訂閱：依賴陣列寫錯，IPC 訊息會消失

「到達即接受」與「通知把我帶到那個 session」都是主行程 → renderer 的單向訊息。承接它們的
元件把 `onReveal`（呼叫端的 inline arrow function）與 `sessions`（context 的 API 物件）放進
依賴陣列 ⇒ **每次重繪都退訂再訂閱**，而落在那個窗口裡的訊息就此消失。

實測三次有一到兩次，症狀是「通知偶爾沒反應」。處置是把變動的東西放進 ref、訂閱只建立一次
（ref 的更新要放在 effect 裡，不在渲染期間 —— `react-hooks/refs` 會擋）。

這正是 CLAUDE.md 那條「依賴陣列就是某條 requirement 的觸發條件在程式碼裡的載體」的實例。

## 七、`fs.mkdirSync('/proc/<不存在>', { recursive: true })` 會卡住

實測（2026-09-17、Node 22.22.0）：它**不拋錯，直接卡死**。拿它當「寫不進去的位置」的測試，
症狀是整個測試檔連一條斷言都印不出來 —— 看起來像測試框架壞了。

要一個必定失敗的寫入位置，讓**父層是一個檔案**（立刻 `ENOTDIR`）。

## 八、交付給 agent 的內容有三道讀取門檻，而最先咬到的那道**靜默截斷**

**實測於 Claude Code 2.1.278（2026-09-21）。它是 agent CLI 的行為，不是本應用程式的行為 ——
CLI 換版之後要重測。**

預填的第一則 prompt 是 `Read <contextPath>. Its fenced section …`（`agent-protocol-copy.ts`）。
以真實的 context 檔格式（`buildContext` 的兩道界線）造不同大小的檔案實讀：

| 內容 | 檔案 | 結果 |
|---|---|---|
| 20,000 字元 CJK（572 行） | 52 KB | **完整**，收尾界線在脈絡中 |
| 約 93,000 字元 ASCII（3,000 行） | 94 KB | **截斷**於第 1,770 行，收尾界線（第 3,005 行）不在 |
| 100,000 字元 CJK（2,273 行） | 266 KB | **硬失敗**，整個讀取被拒，一個字都拿不到 |

三道門檻：

1. **檔案大小 256 KB** —— 超過即硬失敗（`File content exceeds maximum allowed size`）。
2. **單次讀取的 token 上限 25,000** —— 超過即截斷。**這是最常先咬到的那一道**：
   94 KB 的 ASCII 檔只讀到 57%。
3. 預設的行數上限 2,000 —— token 上限通常先到。

**第 2 道是承重的那一道，因為它截斷而不失敗。** 收尾界線於是不進脈絡，
「界線之外的不算數」這條保護靜默失效，接手的 agent 拿到半份工作包 **而它不會知道**。
那與「一則交接被消費卻沒有人知道」是同一個失效形狀，只是換了一個位置。

> **不要用行數去推算字元上限。** 第一版的 design 就是這樣算的（「以 2,000 行推算約 109,000
> 字元」），而行數是三道門檻裡**最寬**的那一道 —— 推算出來的數字比真正的門檻大了五倍。
> 三道門檻裡有兩道不以字元計，所以**取值要取「實測完整讀取成功」的那一格，不要取換算值**。

`agent-intake` 的 first-party 本文上限（20,000 字元）就是這樣定出來的。對照：真實的一份
工作交接包約 5,700 字元。

## 九、自我介紹漏掉一個約束，代價是投遞者走進一條死路

2026-09-21：一則交接的 `body` 是 5,719 字元，而當時的上限是 4,000。spekterm 在一秒內讀到它、
拒絕、刪檔。**來源 agent 回報「已寫出」，使用者由「目標 repo 沒有開出 session」才發現。**

那個上限**從未出現在自我介紹裡**。它講了 target 的規矩、講了原子寫入的規矩，唯獨漏了長度。

**投遞者沒有回饋管道 —— 因此一個未被告知的約束就是一條死路。** 它會照著手上那份說明去寫、
被拒絕，然後回報自己已經交出去了。這不是「它應該更小心」，而是它**沒有任何方式**得知那個約束。

> **Since `scheduled-handoff` the agent gets a receipt** for every file (§17) — but that does not retire this
> section. A receipt reports a refusal **after** it happened, and the agent writing a handoff is often about to be
> closed: an unstated constraint still costs a refused delivery, and maybe the work. Every constraint is still
> stated, and since the introduction was tightened, each one has its own assertion (`handoff-intro.test.ts`,
> each checked by deleting its sentence).

### 對策不是「這次記得寫全」

一份手寫的、宣稱自己完整的清單會在某一次調整之後與實際判定分岔，**而分岔不會讓任何東西
變紅**：型別過、測試過、探針過，只有 agent 收到一份過期的說明。這與「把可交接對象的清單做成
快照而非取當下值」是同一個失效方式。

因此 `introText()` 的每一個數字都由**實際生效的常數**推導，並有一道原始碼守衛
（`scripts/handoff-intro-source.test.mjs`）擋它們以字面值出現。

> **那道守衛的第一版抓不到它唯一要抓的東西。** 它只看 `NumericLiteral`，而最自然的寫死形式
> 是把數字打進模板字串裡 —— 那在語法樹上是**文字段**，不是數字字面值。對照組當場紅了。
> 「改一下常數看輸出變不變」則對 `export const` 根本做不到（測試裡改不了它），
> 那是一次性的手動驗證，不是常駐載體。

### 要告知的不只是「有哪些上限」

自我介紹現在還明說**失敗是一個可達的結果**：一則交接可能因為目標查無、本文過長、檔案過大而
被拒絕，使用者會在收件匣看到它，而**投遞者不會被告知**。原本那句「You will NOT be told whether
a handoff succeeded」只講了成功那一側，讀起來像「寫出去就算數」。

## 十、落點被「刪掉再重建」，監看就死了 —— 而它的症狀與第二節**一模一樣**

現場：兩則合法的交接寫進落點，通過所有驗證，目標 repo 什麼都沒發生，而來源 agent 回報它已經
交接出去了。使用者由「那兩個 repo 沒有動靜」才得知 —— **失敗的可見性條款對它完全沉默**，
那條管的是被**拒絕**的投遞，而這裡的投遞從頭到尾沒有被讀到過。

根因在落點的**建立**，不在監看：`prepareOutbox()` 於每次 spawn 把該 session 的落點
`rmSync` 之後 `mkdirSync`，而落點的監看是 app 啟動時對 `outbox/` 根掛一次的。**監看綁定的是
目錄這個「對象」，不是它的路徑** —— 刪掉再建立之後路徑同名而對象已換，監看留在一個不再有
任何動靜的舊對象上。

### 實測（chokidar 5，`depth: 1`）

| 落點的準備方式 | 其後寫入的投遞 |
|---|---|
| 落點已存在，rm + mkdir 不讓出 event loop | **收不到任何事件** |
| 落點已存在，rm → 讓出一個 tick → mkdir | `unlinkDir` → `addDir` → `add`，正常 |
| 落點已存在，**不刪除目錄** | `add` 正常 |
| 落點**不存在**，rm + mkdir（新建的 session） | `addDir` → `add`，正常 |
| 落點已存在，rm + mkdir，但監看為輪詢 | `add` 正常（輪詢對物件的替換免疫） |

**第四列是它躲過整個能力驗收的原因**：既有的單元測試與探針都在「落點是新建的」那一側，
而那正是唯一不受影響的情形。觸發條件是「落點在被監看之後**又被重新準備**」，
最常見的形式就是 **session 被還原** —— 也就是這個 app 大多數時間的狀態。

**第二列是陷阱**：它會讓對照組變綠，而它把不變式押在「chokidar 來得及把刪除處理完」這件
時序上。它在今天的形狀下還寫不出來（`prepareOutbox` 是同步函式），但下一次有人把它改成
非同步時就寫得出來了。

### 與第二節的鑑別診斷 —— 兩個成因，一模一樣的症狀

第二節（`depth` 沒參數化）的症狀是「即時不進來、重啟才出現」。**這一節逐字相同。**
確認了 `depth` 有傳就排除掉這條，會錯得很遠。分辨的方式：

| 問 | `depth` 沒參數化 | 落點被換掉 |
|---|---|---|
| **所有** session 都收不到，還是只有一部分？ | 全部 | 只有**被還原**的那些 |
| app 啟動之後新建的 session 收得到嗎？ | 收不到 | **收得到** |

### 「看到事件」不代表監看還活著

落點裡若有殘留檔案，那次替換**會**發出 `unlink`（殘留檔被刪）—— 只是不發任何**目錄**事件
（沒有 `unlinkDir`、沒有 `addDir`）。於是一個掛 `watcher.on('all', log)` 去診斷的人會看到
那個落點確實有事件流出來，因而排除掉「監看死了」這個假設。**沒有目錄事件**也順帶讓
「在 `unlinkDir` 時重新掛上」這條補救路徑結構上不存在。

### 判斷「目錄是不是同一個」：不要用 inode

實測 ext4 在 `rmSync` 之後立刻 `mkdirSync`，**20/20 次 inode 號碼被重用** —— 一個以 inode
比對的測試會是一盞永遠亮綠的燈，而它是下一個人第一個會想到的辦法。可用的判準是：準備之前
對落點開一個 fd，準備之後讀 `/proc/self/fd/<n>`，路徑尾端出現 ` (deleted)` 即代表被換掉了
（Linux-only；其餘平台 skip 而非通過）。

### 順帶：改成「保留落點」之後，`EEXIST` 這條路要自己接

`mkdirSync(p, { recursive: true })` 在 `p` 已存在**且不是目錄**時拋 `EEXIST` ⇒ `prepareOutbox`
回 `null` ⇒ 該 session **完全不注入交接**（agent 連自己可以交接都不知道），而畫面上什麼都
沒有。舊的「刪掉再重建」會自動化解這種情形，改成保留之後就得明寫：**是目錄才什麼都不做。**

### 而「清掉落點裡的項目」這件事本身也該一起拿掉

原本那行註解寫的理由是「上一輪的殘留會讓一則早就處理過的交接在重建之後又被投遞一次」——
**不成立**：處理過的早已被消費，即使沒有，去重（id ＝ 來源 session ＋ 內容摘要）也會在建立
session 之前擋下它，且 `DUPLICATE` 是 `consume: true`。

而 session 的識別碼不重複，於是這裡清得到的殘留**只有一種**：同一個 session 上一輪留下的
東西 —— 那正是啟動掃描本來就會讀到的。真正沒人清的孤兒落點（app 被強制結束、該 session
再也不會被 spawn）它**永遠碰不到**。清得到的幾乎是空集合，代價卻是真的：一則**尚未被消費**
的待處理交接會在下次 spawn 時被銷毀，而投遞端與使用者兩邊都不會知道。

## 十一、agent CLI 的本機訊息與 `--name`（`handoff-lineage` 的前提）

**實測於 Claude Code 2.1.282（2026-09-25）。以下全部是 agent CLI 的行為，CLI 換版之後要重測 ——
任何一條改變，母子 session 互相聯絡就可能靜默失效：agent 送出的訊息找不到人，而它不會抱怨。**

| 問題 | 結果 |
|---|---|
| 本機 session 名冊 | `~/.claude/sessions/<pid>.json`：`sessionId`（對話 id）、`name`、`nameSource`、`messagingSocketPath` |
| 未指定名字 | `nameSource: "derived"`，由工作目錄加兩碼產生（`spekterm-3c`），**每個行程不同**；目錄名全為非 ASCII 時是 `claude-01` |
| `claude --name X` | 名冊 `name: "X"`、`nameSource: "user"`，有自己的訊息 socket |
| **以名字跨工作目錄送達** | ✅ 從 `spekterm` 的 session 以 `SendMessage` 送給另一個目錄中 `--name` 指定的 session，對方收到並回覆 |
| 名字的字元 | 空白、CJK、雙引號、82 字元皆**原樣**登記（CLI 不正規化） |
| `--resume <id> --name Y` | 名冊為 `Y`，不沿用那段對話先前的名字 |
| 兩個同名行程同時執行 | **兩者都保留同一個名字**，未觀察到改名（二進位檔中有 `collision` 的處置，但這個情境沒觸發）⇒ 同名的風險是**歧義**，不是地址被改掉 |
| 指定名字對終端標題 | 未指定：`✳ Claude Code` → 送出 prompt 後 `✳ <任務名>`。指定：**恆為 `✳ X`** |
| 收件方的 agent | 訊息抵達即**自行開始工作**（不等使用者）|
| 讀 userData 下的檔案 | 使用者的預設模式（auto）下**不詢問權限**；其他模式**未測** |

三個會讓人白花時間的量測陷阱：

- **在一個 claude session 裡啟動另一個 claude 來測**，它會繼承 `CLAUDE_CODE_CHILD_SESSION` 等巢狀標記
  （`terminal.ts` 的 `NESTED_CLAUDE_ENV`），於是「Transcript saving is off」而且行為與真的 session 不同。
  量測時用 `env -u` 把那組變數（外加 `CLAUDE_CODE_MESSAGING_*`、`CLAUDE_PID`）剝掉 —— spekterm 的
  pty 本來就會剝。
- **`pkill -f <樣式>` 會殺掉執行它的那個 shell**（命令列本身含那個樣式）。症狀是 exit 144 而沒有輸出。
- **從未送過 prompt 的 session 沒有 transcript**，拿它測 `--resume` 會找不到對話。

另見 `SendMessage` 的說明：**收件方與寄件方的權限模式不同時，訊息會先等收件方的使用者同意**。
母子 session 的權限模式一致（都是使用者的預設）時不受影響。

有一次以 `--name` 啟動**完全沒有輸出**，換名字重跑正常；之後以同名、殘留名冊、並行同名皆未重現。

## 十二、母子關係：寫入的時機、查詢的範圍、以及一個冒泡

`handoff-lineage` 讓交接出來的 session 記住母 session，並讓母、子、兄弟的 agent 以固定名字互相
聯絡。三個不知道就會踩的地方：

### 12.1 關係在 spawn 之前寫入，而且只能由主行程簽發的單次憑證觸發

自我介紹與關係檔都在 spawn 時寫出。關係若在 spawn 之後才寫（例如在 `attach`），子 session 的
agent 第一次被注入時看不到母 session —— 而 `attach` 的 sessionId 由 renderer 提供、不檢查狀態，
在那裡寫等於讓 renderer 能把任何既有 session 掛成子節點。因此：

- renderer 建立 session 時只能轉交一張**主行程簽發**的憑證（`handoff-ticket.ts`），綁定 record、
  folder 與 claude 目標，用過即廢；只對**待處理**的交接簽發（record 永不刪除、了結之後仍是
  accepted —— 以主鍵當憑證的話，歷史上的交接能被無限次引用）。
- `createSession` 先產生識別碼、再寫**暫定紀錄**、最後 spawn（順序見 `session-create.ts`）。

### 12.2 「查某個 session」要看暫定紀錄 —— 否則最快的那一則交接會把來源記成「已結束」

新 session 在 renderer 把它送來持久化之前（~500ms 的 debounce）只存在於暫定紀錄。`SessionStore`
的 `list()`／`get()` **看不到它**，要用 `view()`。

實際咬到的一次：母 session 建好後立刻投遞的交接，`sourceOf()` 用 `get()` 查不到母 session，
於是來源的歸屬被記成 `unknown`（「攝入時來源已結束」）。**跨 folder 的那一則晚一點投遞，所以
是對的** —— 第一版 probe 只驗了跨 folder 那一則的快照，整段照樣綠，直到「母 session 關閉之後
呈現快照」那條才露出來。**凡是「以識別碼找一個 session」的地方，都問一次：它可能還在暫定紀錄裡嗎？**

### 12.3 選單的點擊會沿著 React 元件樹冒泡，不管它畫在畫面的哪裡

母 session 的「→ N」標示打開的選單，是那一列 session 的子元件。選一個子 session 的那次點擊，
合成事件沿著**元件樹**冒到那一列的 `onClick` —— 把焦點選回母 session，蓋掉剛才的跳轉。
症狀是「點了沒反應」（選中項停在母 session 的 folder）。`ContextMenu` 用 `position: fixed` 畫在
別處，這件事從畫面上完全看不出來。處置：標示的外層同時停下 `mousedown`、`keydown`、`click`。

### 12.4 `SPEKTERM_` 前綴是保留的

`ptyEnv()` 會剝掉所有從外層繼承來的 `SPEKTERM_*`（開發時 spekterm 常在另一個 spekterm 的
session 裡啟動，外層的名字與落點會被繼承）。**測試或使用者自己設的變數不要用這個前綴** ——
`user-env.spawn.test.ts` 的哨兵原本叫 `SPEKTERM_RC_SENTINEL`，改規則之後它「消失」了。

### 12.5 已知的缺口

- **（對交接已不成立）peer 訊息會被誤判為「使用者已送出預填的 prompt」**：自 `handoff-session-lifecycle`
  起交接的第一則 prompt 被代為送出，這個缺口只剩下「送出字元沒生效、退回待送出標示」的那一種情形
  （第十三節）。原文：收件的 agent 一收到訊息就開始工作，而那正是
  「已送出」唯一的判準。自我介紹要求 agent 在使用者送出第一則 prompt 之前不要傳訊息給剛交接出去的
  session；根本的修正（以 `UserPromptSubmit` 作為真正的送出事件）未做。
  **Update (`companion-test-fixes`)**: `UserPromptSubmit` is now injected and sets busy, but the submission
  check still reads the wait state, so a peer message that makes the agent work still counts as submitted.
  Whether a peer message reports `UserPromptSubmit` was not measured.
- **在 claude 裡用它自己的 `/rename` 會改掉名字**，直到下一次 spawn 被 spekterm 指定回來。
- **休眠的 session 收不到訊息**（沒有行程）；關係檔以 `running: false` 標明，spekterm 不代為喚醒。

## 十三、首次就緒時寫入 `prompt\r`：對話框擋得住，送出字元偶爾會掉（`handoff-session-lifecycle` 的前提）

**實測於 Claude Code 2.1.283（2026-09-28）。agent CLI 的行為，CLI 換版之後要重測。**

作法：以 pty 啟動真實的 `claude`（剝掉巢狀標記，見第十一節），`--settings` 只注入一條
`SessionStart` hook（寫下時間戳），hook 一觸發就**一次寫入** `prompt\r`（比 spekterm 還早 ——
產品要等下一次 400ms 輪詢），之後讀 transcript 看有沒有恰好一則使用者訊息。

| 情境 | `SessionStart` 何時觸發 | 結果 |
|---|---|---|
| 已信任的 repo（無對話框） | 約 1 秒 | 6/6 恰好送出一則 |
| **未信任的資料夾**（信任對話框，預設選項是 **No, exit**） | **對話框在時始終不觸發**（觀察 45 秒）；使用者選擇信任之後約 0.6 秒 | 接受後 1/1 送出 |
| **新的 `.mcp.json`**（MCP 核准對話框） | **對話框在時始終不觸發**；關掉之後約 0.9 秒 | 關掉後 12/13 送出，**1/13 prompt 留在輸入框、`\r` 沒有生效** |

兩個結論：

1. **啟動對話框擋住的是 `SessionStart` 本身**，於是以它為閘寫入的 `\r` 結構上不可能落在對話框上
   —— 「替使用者選了對話框的預設選項」（信任對話框的預設是退出）這個災難形狀在 2.1.283 不存在。
   對話框一直沒被處理時，產品的預填逾時（30 秒）照舊把該則退回待處理。
2. **送出字元偶爾會掉**：文字進了輸入框、`\r` 沒有被當成送出（畫面上 prompt 停在輸入框、transcript
   沒有建立）。延遲 400ms 或把文字與 `\r` 分開寫各 2/2 成功，樣本太小，不構成「改成那樣就不會掉」
   的證據。**失效方向是溫和的**（退化成「填好而不送出」，也就是這個 change 之前的行為），但產品若以為
   已送出而不呈現「待送出」，使用者就看不到它在等他 —— 所以送出之後要有「一段時間內沒開始工作就
   退回待送出標示」的退路。**不要自動補送一次 `\r`**：那段時間使用者可能已經在那個 session 裡打字。

### 13.1 長文字會被當成貼上，緊跟在後的 `\r` 被併進去 —— dogfood 第一次就踩到

上表用的是 50 字元的短 prompt。**真實的第一則 prompt 約 300 字元、含全形破折號與彎引號**，而以它重測
（同一版 CLI、同一台機器、首次就緒後 400ms 寫入）：

| 寫法 | 結果 |
|---|---|
| 文字與 `\r` 一次寫入 | **沒有送出**（文字停在輸入框） |
| 文字，隔 50ms 再寫 `\r` | 沒有送出 |
| 文字，隔 100ms 再寫 `\r` | 沒有送出 |
| 文字，隔 150ms／200ms／300ms／500ms 再寫 `\r` | 全部送出（8/8） |

agent 把一次抵達的長文字當成**貼上**，緊跟在後的 `\r` 被併進貼上成為換行。產品因此把送出字元**分開、
隔 500ms**（約門檻三倍）才寫（`SUBMIT_KEY_DELAY_MS`）。

**為什麼整輪驗收都沒抓到**：替身逐位元組讀取、不做貼上偵測；第一次實測用的是短 prompt。**量測用的輸入
要是產品真的會送的那一份** —— 長度與字元組成都是變因。單元測試現在斷言「分兩次寫且間隔足夠」
（對照組 `submit-joined`：分開但不等，會紅）。

> 同一個形狀可能也存在於對話 view 的送出（`encodeInput` 把文字與 `\r` 一次寫入）：使用者在對話 view
> 打一段長訊息時，可能同樣只進了輸入框。**本 change 沒有處理它**，未實測。

另一個觀察：輸入框上方的警告橫幅（例如 permission rule 的提示）不是對話框，不擋 `SessionStart`，
也不影響送出。

量測會在目標 repo 的 `~/.claude/projects/` 下留下 transcript（它們會出現在 `/resume` 清單與對話
計量裡），**量完要清掉**。

## 十四、交接 session 的生命週期：完成報告、落定、收掉已完成（`handoff-session-lifecycle`）

完成由**子 agent 自己宣告**：它往自己的落點寫 `{"kind":"report","summary":"…"}`（與交接同一個落點，
以種類欄位區分；缺席即交接）。spekterm 保存它、呈現它、寫進關係檔，**不傳遞** —— 結果回送母 session
是子 agent 自己用 `SendMessage` 做的。三個不知道就會踩的地方：

### 14.1 落定依「採納之後的輪詢值」，不依「狀態的轉變」

報告經檔案監看送達、等待狀態經 400ms 輪詢送達，**兩條通道互不排序**。「寫報告 → 回送訊息 → Stop」若
Stop 先被輪詢到、報告才被讀到，採納那一刻狀態已經是就緒，之後不會再「轉變為」就緒 —— 依轉變判定的話
它永遠不落定，之後的追問整段顯示「已完成」。對照組 `settle-by-transition` 實跑為紅。

**反過來的窄窗（design D6 的已知誤判二）**：採納之後不到一次輪詢就來了新的交辦，那一次輪詢摺出來的值是
忙碌 —— 分不出是報告的收尾還是新交辦，依規則不算重新開始。**探針因此要先等 `settled` 落盤再送忙碌**
（`runCompletion` 的 `awaitSettled`）。第一版沒有等，C2 那條就是這樣紅的：畫面顯示已完成的那一刻報告
剛被採納，探針立刻送出的忙碌與它落在同一次輪詢裡。**那不是產品的錯，是探針沒造出它要的前提。**

### 14.2 狀態機要在 pty 存在期間持續被餵

等待狀態只在**有訂閱者**時被求值。生命週期的訂閱跟著 pty 走（`onPtyChange` → `track`／`untrack`），
**每一次輪詢都通知**（`agent-wait.ts` 的 `tick`），但只在「值變了或完成狀態變了」時才重寫關係檔與推畫面
—— 每 400ms 重寫一輪關係檔是浪費。

### 14.3 交接單的本文另存一個檔，而它的清理要看暫定紀錄

`<id>.handoff.json` 與畫面快照同一個目錄、同一條刪除路徑。它在 spawn **之前**寫出，比 renderer 把新
session 送來持久化早 ~500ms —— `pruneScrollback` 的「已知 session」因此改為含暫定紀錄（`view()`）。
（實情是 prune 目前只在 `load()` 時跑，那時沒有暫定紀錄；這條是讓日後在別處呼叫 prune 的人不會踩到。）

### 14.4 驗收：替身的「指令通道」

完成報告的時序只能由探針排：替身多了一個指令通道（`stub.command(對話 id, shell)`，在替身自己的 shell 裡
執行，`fire` 可用），以及 `stub.report.stage／commit`（先寫以點開頭的暫存名、再改名 —— 產品不讀以點開頭
的檔，於是「agent 已停下之後報告才被讀到」造得出來）。收據也改為**每個 session 一份**
（`stub.sessionInputs()`）：共用的那一份分不出送到哪個 session（5.1 節）。

### 14.5 保存了不等於被看見

第一版只把報告存下來、放在四個查得到的位置，dogfood 第一輪使用者就問「報告在哪裡看」。**一個由別人
產生、使用者沒在等的結果，要有一個主動告知的時刻**（design D9：完成通知，綁定於採納）。探針的驗法：先把
焦點放在**別的** folder，再觸發通知，斷言選中的項目換了、交接單打開了且含那份結果。


## 15. The outbox watcher missed a directory, and nothing ever read it again (`intake-periodic-rescan`)

In dogfood a handoff written to a session's outbox never arrived (issue #48). The file was valid,
parsed, and named a target in the session's own list — it was simply never read. The inotify watch
list showed that session's outbox was the only one not being watched; a restart picked the handoff
up at once, through the startup scan. Three product-logic hypotheses (chokidar missing a new
subdirectory, a window before `ready`, `prepareOutbox` dropping the watch) were each disproved with
a minimal reproduction. The likeliest trigger was a polluted dev environment (stdout cut by an early
`head`, every later `console.*` failing with `EPIPE`), but that is not the point.

**The point is that the drop points had only two readers — the startup scan and the watcher.** Once
the watcher missed a directory, every delivery into it disappeared until a restart, and neither side
was told: the agent said it had handed off (it had), the inbox stayed empty. The Slack source learned
the same thing earlier ("backfill is the backbone, real-time the accelerator").

What was done, and why each choice:

- **A periodic re-read, not a watcher fix.** The cause was never found, and the next miss may have a
  different one (exhausted watch descriptors, a network filesystem). The re-read makes the question
  non-load-bearing.
- **Every 30 s, not every five minutes like Slack.** Slack's interval is set by API quota; a local
  re-read is a few `readdir` calls on directories that are normally empty. The spec bounds it at one
  minute.
- **It starts before the watcher is `ready`**, and survives a failing startup scan — a watcher that
  never becomes ready is one of the failures it is for.
- **Not "scan once after preparing an outbox".** That was the first idea in the issue. The outbox is
  prepared at spawn, before the agent exists; a scan then always finds nothing.
- **No probe carries the missed-watch case.** Making the real app's watcher miss needs a test-only
  switch in product code or root. The unit tests replace only the watcher (a factory that reports
  `ready` and nothing else) and go through the real `HandoffService.start()` with the default
  interval.
- **The clock helper needs a budget.** `rescanOnce` first ticked the mocked clock "until a re-read
  started"; the control group with a five-minute default stayed green, because it simply ticked five
  times. It now advances at most one minute of mocked time per call.

## Session commands: "in a turn", the chain, and what yields (`agent-session-control`)

An agent can close, hibernate or rename its own session and its descendants by writing `{"kind": "close" |
"hibernate" | "rename", ...}` into its drop point (`src/main/session-control.ts`). Four things fail silently if
forgotten.

### "In a turn" is not the wait state

`ready` is the wrong signal for "the turn has ended", in both directions (measured, CLI 2.1.301,
`docs/lessons/transcript.md` "Turn boundaries"):

- **`ready` is set too early.** A mid-turn compaction's `SessionStart` sets it, and so does a `Stop` that
  leaves a background subagent running.
- **`ready` is set when nothing happened.** `idle_prompt` sets it 60 s after a turn.
- **`ready` is cleared when nothing happened.** A stray subagent `PreToolUse` after a turn clears it, so a
  finished child could never be closed.
- **A turn can report no start at all.** A `!cmd` reports only its `Stop`.

So `inTurnOf` (`agent-wait.ts`) is its own fact. A turn starts with an own `UserPromptSubmit` **or any
keystroke**, and it ends only at the agent's own boundaries:

- `Stop` with no background subagent running (a background **shell** does not hold it);
- `StopFailure`;
- `SessionStart` that is not a compaction;
- the `SessionStart(compact)` that follows a **manual** `PreCompact` (the user's `/compact` reports no `Stop`).

`busyReason` is not the answer either: it counts an unsent prompt as busy.

A keystroke into the target also **drops** a waiting command. An Esc interruption reports nothing, so the turn
stays open until the user's next turn, and that turn's end would otherwise fire the command. The safe-direction
cost: a command sent to an interrupted session never runs, and nobody is told.

**xterm's answers to the agent's startup queries reach the pty as writes** (DA1, XTVERSION, the kitty keyboard
query). `isTerminalReport` treats them as the terminal's own. Without that, a freshly started session counts as
typed into, and it is never at rest.

### The chain is taken at ingestion

Lineage used to record only the direct parent, and a closed intermediate broke the link to a grandchild.
`SessionLineage.ancestors` now holds the rest of the chain. **It is taken when the handoff is ingested**
(`verified.source.ancestors`), not when its session is created: the two can be days apart, and a parent closed
in between would leave `[parent]` only. `ancestryOf` (`src/shared/lineage/ancestry.ts`) walks **every record**.
Existence only decides who is listed and who may be targeted, so the relations tree and command authorization
cannot disagree.

### What a command yields to

The drop point is read at a session's end only by `kill` (a close). Neither a hibernation nor a quit reads it,
and the periodic re-read can be up to 30 s late. A close or hibernate is therefore dropped when its file's mtime
(taken from the read, never a second `stat`) is older than either:

- the target's last process start or end in this run (`session-runs.ts`, process-wide, because macOS reopens
  windows);
- the run's start.

An end the command itself caused does not count, so the latest command still wins.

### An agent's close of its own session is offered, not carried out

Dogfood: a close at the end of the turn worked, and took away a reply that mattered the moment it appeared. A
self-close now sends `offer-close` to the window (`CloseOffer.tsx`, in both views). Nothing ends until the user
chooses Close; Keep, or any keystroke into the session (`withdraw-close` from the main process, the same
`onKeystroke` that drops a waiting command), withdraws it. The offer's container is `pointer-events-none`: only
its two buttons take the pointer, so the reply under it stays selectable and scrollable — the probe hit-tests the
terminal under it, and a covering backdrop turns that red. It takes no focus. A descendant's close and the
agent's own hibernation are not offered: "close the finished handoffs" stays one request.

**A paired device sees the offer and answers it** (`remote-close-offer`: `closeOffered` in the session list,
`sessions.keep`). Three things that were harmless while only the window showed the offer, and fail silently once
it leaves the window:

- **The main process owns the offer** (`SessionControl`), and the list reads it there. So every way the user
  answers must reach it: the desktop's Keep sends `handoff.keepCloseOffer` besides clearing the card. Clearing
  only the card left the main process's record standing, and a phone would show an offer the user declined.
- **An offer ends with the next process start or end, by time, not by wiring.** It records when it was made and
  is stale once `lastProcessChangeAt` is later. The first plan, clearing it from `onPtyChange` as waiting
  commands are, depended on the wiring whose absence caused the bug, and missed a race: a wake that spawns before
  the hibernated pty's exit arrives makes that exit ignored, so no `onPtyChange` fires and the woken session
  would show the old offer. The list also requires the session to be live, since an end a command announced in
  advance (`expectCommandEnd`) is not timed.
- **Nothing else announces an offer at once.** It usually rides on the wait state's change at the same turn end,
  and the list's 5 s reconcile (while a device is connected) delivers it anyway, later. Both hide a missing
  announcement: the first control group of the probe stayed green until the late-read step (the command read after
  the turn ended, as the watcher's late event or the 30 s re-read do) asserted on time, ~160 ms with
  `offersChanged` against 1.4–2.1 s without. **An "it arrives" assertion on the session list proves nothing while
  that reconcile runs; assert how soon.** And a failed
  request drops the offer only when it was the `offer-close` itself: a parent's rename of an offered child that
  timed out used to drop the child's offer while its card stayed.

### Classification and delivery

- `CONTROL_UNAVAILABLE` (agent events off) and `CONTROL_NO_WINDOW` are **temporary**, as `agent-intake` rules a
  failure a resend could overcome: they leave a trace and send no notification. They are consumed anyway:
  "temporary" decides only the notification.
- **`deliver` never awaits the window.** The drop points are read one file at a time, so a command waiting on
  a window would stall every handoff and report behind it. Requests run asynchronously behind a per-window restore
  gate (`restore-gate.ts`, bounded at 60 s). A failure after the file was consumed reports both halves itself:
  `reject` and, for a permanent code, `reportFailure`.

## 16. The introduction's size limit: past 10,000 characters the agent keeps only the first 2 KB (`scheduled-handoff`)

**Measured with Claude Code 2.1.303 (2026-10-19), Haiku, nested markers stripped (§11), the hook injected the way
spekterm injects it (`cat` of a `hookSpecificOutput` JSON).** Re-measure on a CLI upgrade — the failure is silent.

| `additionalContext` | `-p` mode | interactive (real pty) |
|---|---|---|
| 9,000 characters | whole | whole |
| 10,000 characters | whole | whole |
| 10,001 characters | replaced | replaced |
| 300 short lines (~2,000 characters) | — | whole: no line limit |

"Replaced" means the **whole** context is swapped for `Output too large (9.8KB). Full output saved to: <file>` and a
preview of about the first 2,000 characters. The agent does not read the file by itself. For the introduction that
leaves the opening and half the delivery rules: the repo list, the receipts, the session commands and the report
paragraph are all gone at once — **not "the last paragraph is lost"**, which is what the first draft of the change
assumed. The threshold is counted in string length (a binary read shows `originalSize: h.length`), so a non-ASCII
folder name counts as one character per UTF-16 unit, not per byte.

The binary also carries an 8,000-character / 200-line cut for `additionalContext`; neither applied in these runs
(9,000 characters and 300 lines both arrived whole).

What the product does about it (`handoff-intro.ts`): a budget test holds a 30-folder introduction at 8,000 characters
(6,985 when this was written; the test prints the margin), and a run-time hard limit of 9,000 cuts the repo list — never
the rules — for a workspace too large for the budget, saying how many repos were left out.

How it was found: the change's first draft wrote "the CLI may cut it — not measured", while `docs/PRD.md` §13 had
recorded "1 萬字, then a file and a 2,000 preview" all along. The reviewer reproduced it; the bisection is in this table.

## 17. Scheduled handoffs and receipts: what fails silently here (`scheduled-handoff`)

- **`Date.parse` is not a validator** (Node 22.22.0): it accepts `2026-02-30T10:00:00+08:00` (rolls over to
  2 March), `T24:00`, a time without an offset (read as the desktop's local time), `+0800` and a space separator.
  `parseScheduledAt` checks the form and every component first; `Date.parse` only converts.
- **`setTimeout` overflows past 2^31−1 ms (about 24.8 days)** — inside the 30-day scheduling bound — and then fires
  at once. Nothing schedules a timer per handoff: the opener looks every 30 seconds against the wall clock, which
  also covers a computer that slept through the time.
- **An open request no window receives is lost.** `intake:autoAccept` goes only to windows that listed the inbox; a
  handoff read at startup before that used to sit in the inbox as if refused. The opener therefore waits until one
  window both lists the inbox and has restored its sessions, and looks again when either happens (they come in
  either order). The control group (`opens-before-window`) shows the loss.
- **At most once, ever — persisted before anything else.** A handoff whose prefill timed out goes back to pending;
  any rule that opens pending handoffs without a persisted mark would open another session at every start.
  `firedAt` is saved before the request is sent, and also when a user's accept issues a ticket (an accept whose
  session then fails to start is followed by no `attach`, which would otherwise be the next save). And while a
  ticket is live (issued, or used and not attached yet), a second accept is refused: two sessions would open.
- **A receipt is written before its file is removed**, on every path (delivered, oversize, thrown), so "file gone"
  means "receipt exists". A receipt that cannot be written is logged, and the file is still processed: holding a
  delivery back for its bookkeeping would turn a full disk into a lost handoff. Receipts are written to a
  dot-prefixed name and renamed (a reader in another process saw 218 torn reads in the control group), and a
  `held` receipt is rewritten only when its code changes — the 30-second re-read would otherwise churn it.
