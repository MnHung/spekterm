# Claude Code 的 session transcript —— 讀它之前必讀

> **觸發條件**：要動 `src/main/transcript-*`、`src/main/insights*`、`scripts/probe-insights.mjs`，
> 或任何會去讀 `~/.claude/projects` 的東西。
>
> 這一整份的失效方式幾乎都是同一種：**兩種算法都算得出數字，而錯的那一個看起來完全正常。**
> 沒有一條會拋錯，沒有一條會讓型別檢查變紅。

## 這份資料是什麼

Claude Code 把每個 session 的對話寫成 NDJSON，落在
`<設定目錄>/projects/<cwd 編碼後的目錄名>/<session-id>.jsonl`，逐輪追加。設定目錄預設 `~/.claude`，
以 `CLAUDE_CONFIG_DIR` 覆寫（**實測 2026-09-05：`projects/` 與其中的 transcript 確實一併搬走**，
即使那一趟認證失敗也照樣寫出來）。

**它預設只留 30 天。** 實測（2026-09-04）：本機 44 個專案目錄、488 個檔、31 萬行、1.5 GB，
而最舊的一筆剛好是 30 天前 —— 更早的已經不存在。這是 `conversation-archive` 存在的全部理由。

## 一、判定一律看結構欄位，不看內文長什麼樣

來源裡有一整類記錄其角色是 `user` 但**使用者從未輸入**：skill 與 slash command 被展開的內文、
其他 agent session 送來的訊息、圖片佔位、harness 的追問。它們帶著頂層的 **`isMeta`**。

| 判定方式 | 抓到 |
|---|---|
| 文字樣式比對（`<task-notification>` / `<local-command-caveat>` / 中斷標記三個 pattern） | **53** 筆 |
| `isMeta: true` | **965** 筆 |

漏掉的 912 筆讓每一個數字都偏掉：

| | 文字比對 | `isMeta` |
|---|---|---|
| 使用者訊息數 | 4,777 | **3,839**（高估 24%） |
| 長度中位數 | 33 | **23** |
| 長度平均 | 1,119 | **53** |
| 最長 | 922,812 | **3,784** |

那個「最長 92 萬字元的 prompt」不存在 —— 它是一份 skill 的內文。

**中斷同理**：判定看頂層的 **`interruptedMessageId`**，不要比對內文的
`[Request interrupted by user…]`。那是英文文案，改版即失效 —— 屆時「我什麼時候踩煞車」
會變成一條漂亮的零線。

> **fixture 要放一筆「內文與一般訊息完全無法區分」的 `isMeta`。**
> 實作時的對照組第一次是綠的：fixture 那三筆 `isMeta` 的內文剛好都有明顯特徵
> （`Base directory` / `Another Claude session` / `[Image:`），於是它對「看旗標」與「比對內文開頭」
> 兩種實作給出相同結果。**真實資料裡 skill 的內文可以長成任何樣子，而看起來正常的那一筆
> 才是會被漏掉的那一筆。**

## 二、記錄類型是白名單，不是黑名單

實測本機資料有 **21 種**頂層 `type`：

```
assistant / user / attachment / bridge-session / last-prompt / mode / permission-mode /
ai-title / atis-latch / system / queue-operation / file-history-snapshot / file-history-delta /
worktree-state / relocated / frame-link / agent-name / artifact-autoreact-ledger /
cost-state / pr-link / artifact-comment-monitor
```

多數是隨版本陸續長出來的（參考實作的註解只列了 8 種）。**只認 `user` 與 `assistant`，
其餘一律忽略且不報錯** —— 黑名單式的排除會在下一次更新時把新類型當成資料處理。

## 三、`cwd` 在一支 session 之內會變

實測本 repo 自己的一份 transcript：同一個 session 裡出現過**四個**不同的 `cwd`，
包含 `/tmp/…/scratchpad`。直覺作法 `basename(最後一個 cwd)` 會把那個專案標成 **「scratchpad」**，
而畫面上看起來完全正常。

正解利用目錄名的生成規則反查：在該 session 出現過的 `cwd` 之中，取**編碼後等於目錄名**的那一個。
編碼非單射（`/a/foo-bar` 與 `/a/foo/bar` 編碼後相同），兩者都出現時取**最早出現**的 ——
目錄名由起始 cwd 生成，而起始 cwd 必然最早出現。

反查不到時回傳 `null` 而非猜一個。比照 `SpecInfo.path`：少一個名字，好過給一個錯的。

## 四、`input_tokens` 幾乎恆為 0

有 prompt cache 的時候，真正的輸入量在 **`cache_read_input_tokens`**。實測本機 32 天：

| 欄位 | 量 |
|---|---|
| `input_tokens` | 0.4 M |
| `cache_read_input_tokens` | **26.4 B** |

**差七萬倍。** 照欄位名畫「輸入 token」會顯示成幾乎沒花錢。

## 五、時間戳是 UTC

`"timestamp": "2026-08-06T10:48:10.009Z"`。直接拿它算「星期 × 小時」，對 UTC+8 的使用者
整張熱圖偏移 8 小時 —— 「半夜十一點還在工作」會顯示成下午三點。逐日分組與跨午夜的切段同理。

> **驗收要造一筆「本機日期與 UTC 日期不同」的記錄，而取哪個鐘點取決於時區的方向。**
> 固定取當地 23:30 對東半球無效：UTC+8 的 23:30 是**同一天**的 UTC 15:30，
> 那筆記錄於是沒有鑑別力。東半球取當地 00:30，西半球取 23:30；UTC+0 造不出對比，
> 該條驗收應當**略過而非通過**。

## 六、subagent 有自己的檔案，而兩類資料的歸屬方向相反

subagent 的 transcript 在 `<project>/<session-id>/subagents/*.jsonl`（本機 251 個，
多於主 session 的 237 個）。

- **使用者訊息**：subagent 的 `role: user` 是 orchestrator 寫給它的指令，**不是使用者打的**。排除。
- **工具呼叫與用量**：subagent 跑掉的 Bash 就是這次工作真的跑掉的 Bash，花掉的 token 也是真的
  花掉了。**計入。**

兩種選擇都算得出數字，而「Bash 佔 75%」在兩種定義下是不同的量。**必須寫下來，並讓使用者看得到
用的是哪一個。**

## 七、slash command 在來源裡是展開的 XML

```
<command-message>opsx:continue</command-message>
<command-name>/opsx:continue</command-name>
<command-args>my-change</command-args>
```

不還原的話，「我最常說的那幾句」會列出一堆 XML，而 slash 的使用量會被**低估**：
以訊息開頭找斜線只抓到約 34 次，實際打出來的有 376 次（其中 342 次是展開形式）。

同族的還有 `!` 前綴的 bash：`<bash-input>` **是**使用者打的，`<bash-stdout>` / `<bash-stderr>`
**不是**。

## 八、`<task-notification>` 在真實資料裡只有一種形態

實測 40 個 transcript：非 `isMeta` 的通知記錄 **130 筆全部是「通篇只有通知」**，
夾在真實訊息裡的 **0 筆**。

規格若只寫「移除通知、保留其餘內文」，照字面實作會產出 130 列**空內文的使用者訊息** ——
訊息數灌水、長度中位數被拉低，而數字看起來完全正常。**兩種形態都要寫，而高頻的是前者。**

## 九、資料量會讓「展開運算子」炸掉

```js
Math.min(...times)   // times 有六十幾萬筆 → RangeError: Maximum call stack size exceeded
```

展開運算子把每一筆變成一個函式參數，而參數個數有上限。**fixture 只有二十列，單元測試與探針
都看不到** —— 這是 dogfood 抓到的。任何對「一列一筆」的陣列做 `Math.min/max(...)` 的地方都要改成迴圈。

## 十、掃描的體積與時間

| | |
|---|---|
| 全掃 490 檔 / 31 萬行 | **約 24 秒**（Node 與 Python 同數量級） |
| 存檔（含訊息內文與用量） | 一年約 **145 MB**，其中用量列佔 65%、訊息內文只佔 3% |

24 秒放在主行程上就是 24 秒的 IPC 停擺。**跑在 `utilityProcess`，而決定性的理由是崩潰隔離
不是效能** —— 這個模組解析的是會隨版本改變的內部格式，它出事時使用者正在跑的 agent 不該跟著死。

## 十一、`claude -p` 會寫進 transcript，而那則記錄**沒有** `isMeta`

實測 2026-09-05（`claude` 2.1.261）：非互動模式下，`-p` 的指令與標準輸入**被串成同一則**
`type: "user"` 記錄，`isMeta` 欄位不存在，`cwd` 是委派的工作目錄。

```
$ printf 'ALPHA BRAVO\nCHARLIE DELTA\n' | claude -p '回覆第二個字' --output-format json
$ # → ~/.claude/projects/<cwd 編碼>/<session-id>.jsonl
$ #   {"type":"user","message":{"role":"user","content":"回覆第二個字\nALPHA BRAVO\nCHARLIE DELTA\n"}}
```

意思是：**任何「委派 `claude` 去分析這份資料」的功能，都會逐次污染它自己分析的資料。**
一趟讀後感的語料是 200 KB，那就是一則 200 KB 的「使用者訊息」——
正是本文件 §一 記錄的「最長 92 萬字元的 prompt 其實不存在」，只是這次是我們自己製造的。

處置有三層，缺一不可（見 `conversation-archive` 的規格）：

1. 委派跑在 userData 之下一個**專屬空目錄**（順帶擋掉 repo 的 `CLAUDE.md` 與 skill 滲進分析）。
2. **掃描與呈現都排除它** —— 只擋來源迴圈救不了已經落地的存檔，因為呈現走 `readArchive()`
   而孤兒政策是原地保留。掃描要**主動刪除**符合排除條件的既有存檔。
3. 排除的判定是「編碼形態**以固定 basename 結尾**」，**不綁單一絕對路徑** ——
   dev 與打包產物的 userData 分家（`spekterm-dev` 對 `Spekterm`）而來源根共用，
   綁路徑的話在 dev 按一次讀後感就會弄髒正式產物的數字，而以「同一個安裝內」為前提的驗收必綠。

**不能用 `CLAUDE_CONFIG_DIR` 把它整個導去別處**（那才是最徹底的隔離）—— 見 §「這份資料是什麼」：
換掉設定目錄會連認證一起換掉。

> **但「使用者自己設了它」是另一回事。** 委派的環境會**原樣轉送**使用者明確指定的
> `CLAUDE_CONFIG_DIR`（而且只在他明確指定時才傳）—— 見第十三節。這裡禁止的是「我們自己
> 挑一個目錄導過去」，不是「照抄使用者的設定」。**合成一個預設值傳進去也在禁止之列，
> 而理由與這一段不同**（設定檔會搬家）。

> **順帶一個獨立的坑**：`content` 可以是**字串**而不是 block 陣列，而真實的 `claude -p`
> 寫出來的正是字串型。產品的 `transcript-extract.ts` 有處理，但
> `transcript-fixture.test.ts` 那份「獨立重算」原本只認陣列 —— 於是任何字串型的使用者記錄
> 都會被它靜默漏掉。**一份漏算的獨立重算比沒有更糟**，它會讓 fixture 的宣告值看起來被驗證過。

## 十二、委派的回覆只依賴少數幾個 JSON 欄位

`--output-format json` 實測有這些可用（同上版本）：`result`（回覆本體）、`is_error` /
`subtype`（成敗）、`session_id`、`total_cost_usd`、
`permission_denials`（**工具有沒有真的被關掉唯一的偵測訊號**）。

> **`session_id` 已不再被消費**（`delegate-billing-attribution`）：委派紀錄的刪除改為以
> **專案目錄**為單位。理由見下面第十三節 —— 失敗的那幾條路根本拿不到它，而失敗的那一趟
> 同樣留下了一份完整語料的紀錄。

**模型不在清單裡** —— 報告記錄的是「本應用程式請求的模型」，那是我們自己傳出去的值。
實際生效的可能因回退而不同，把推測寫成事實正是要避免的。

**不要依賴 stderr 的文字**：它會隨版本與語言環境改變，而且可能含絕對路徑或帳號資訊 ——
那些會被畫到畫面上。



## 十三、委派的環境是一份白名單 —— 而理由不只是費用

（實測 2026-09-06，`claude` 2.1.263）

### 認證優先序共七層，訂閱 OAuth 排**最後**

官方 `docs/en/iam`：雲端供應商選擇（`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`）→
`ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN`
→ profile / federation → `/login` 的訂閱憑證。而關鍵的一句是：

> In interactive mode, you are prompted once to approve or decline the key ...
> **In non-interactive mode (`-p`), the key is always used when present.**

**pty 裡的互動式 claude 會問使用者一次；`-p` 的委派不會。** 於是把使用者 login shell 的整份
環境交給委派，等同讓一個從未被詢問的憑證接管計費，而 `total_cost_usd` 是 client-side 估算、
**看不出這筆走訂閱還是 API**。

`env-vars` 頁上這類變數目前約 25 個，且一年內從三、四個長到這個數量
（`ANTHROPIC_PROFILE`、federation 那組、`ANTHROPIC_FOUNDRY_*`、`ANTHROPIC_AWS_*`、
`ANTHROPIC_BEDROCK_MANTLE_BASE_URL`、`CLAUDE_CODE_USE_FOUNDRY` 都是近期才有的）。
**所以是白名單而不是剝除清單** —— 一份剝除清單需要有人定期比對官方文件，而漏補的徵狀是
「一切正常」。

**`CLAUDE_CODE_OAUTH_TOKEN` 是這一族裡的例外，它在白名單上**：那是 `claude setup-token`
產生的**訂閱**憑證，轉送它**維持**而非改變計費歸屬。拿它去論證「不可用前綴一概剝除」、
然後自己的白名單也沒放它，是同一個錯誤的兩面 —— **「不在清單上」與「明確剝除」後果一樣。**

### `process.env` 這一半同樣要防，而它只在從終端機啟動時才髒

自桌面選單啟動的產物環境很乾淨；**自一個 Claude Code session 之內啟動時**（`npm run dev`
常常就是），`process.env` 實測帶著 11 個：

```
CLAUDECODE  CLAUDE_CODE_ENTRYPOINT  CLAUDE_CODE_SESSION_ID  CLAUDE_CODE_CHILD_SESSION
CLAUDE_CODE_BRIDGE_SESSION_ID  CLAUDE_CODE_MESSAGING_SOCKET  CLAUDE_CODE_MESSAGING_TOKEN
CLAUDE_CODE_EXECPATH  CLAUDE_PID  CLAUDE_EFFORT  CLAUDE_CODE_NO_FLICKER
```

`MESSAGING_SOCKET` / `_TOKEN` 是一條通往**父 session** 的通道 —— 那是剝除它們最直接的理由。
（`terminal.ts` 的 `NESTED_CLAUDE_ENV` 只有 7 個名字，涵蓋上面 5 個 —— pty 那條路的缺口
是 issue #38，不在委派這條路上。）

> **不要把 `terminal.md` 那個二分實測外推到 `-p` 上。** 那份實測（`CLAUDE_CODE_CHILD_SESSION`
> 單獨一個就會讓 `claude` 完全不寫 transcript）的對象是**掛在 pty 上的互動式 claude**。
> 對非互動模式實測過了，結論相反：
>
> | | 帶著 `CLAUDE_CODE_CHILD_SESSION` | `env -u` 剝除 |
> |---|---|---|
> | 是否寫下紀錄 | **有**（221,740 bytes） | **有**（221,758 bytes） |
>
> （以不存在的模型跑 `-p`，`total_cost_usd: 0`，不計費 —— **這是查證這類問題的便宜作法**。）
> 剝除的理由仍然成立，但**理由是那條通往父 session 的管道，不是「它會讓 claude 不寫紀錄」**。

### `CLAUDE_CONFIG_DIR`：**設與不設，主設定檔不是同一個檔**

這是本節最容易從語意推論而推錯的一條。

| | 主設定檔 |
|---|---|
| 未設定 | `~/.claude.json` |
| 設為 `$D` | `$D/.claude.json` |

於是「反正解析出來的預設值就是 `~/.claude`，明確傳進去等於不變」是**錯的**：claude 會去找
`~/.claude/.claude.json`，那個檔不存在，**它就地建出一份「首次啟動」的空設定**
（實測 39,417 bytes、`projects` 為空、沒有 onboarding 狀態），並印出三行
`Claude configuration file not found at: …`。

**而 `report-runner.ts` 的 `JSON.parse(stdout)` 是零容忍的**（不取最後一行、不濾非 JSON
前綴）—— 那三行若落在 stdout，每個使用者的**第一趟**讀後感都會 `unparsableReply`。
「只有第一次會發生」是最容易被放行的形狀：dogfood 跑第二次就再也看不到。
（該訊息走 stdout 還是 stderr **未能重現，查不出結論** —— 正確的做法讓這個問題不必回答。）

**結論：只在使用者明確指定時才轉送它，不合成預設值。** `insights-source.ts` 的
`explicitConfigDir()` 就是那個「有沒有明確指定」的判定；`configDirs()` 一次解析回傳
`explicit` 與 `resolved` 兩個衍生值，因為「委派寫到哪」與「我們去哪刪」必須同源。

> **這與本文件他處那句「不能用 `CLAUDE_CONFIG_DIR` 把它整個導去別處」不衝突。**
> 那句話針對的是「把委派導去一個**不同的**目錄以求隔離」（會連認證一起換掉）。
> 這裡轉送的是使用者**自己已經設定的那個值** —— 他的互動式 claude 看到的也是它。

### 委派**失敗**的那一趟同樣寫了紀錄

實測：無憑證的 `-p` 以 exit 1、`is_error: true` 結束，而
`<configDir>/projects/<編碼後的 cwd>/<session>.jsonl` **仍然產生**，內容含送進去的語料。

而失敗路徑上 `RunOutcome` 只有 `code`，**拿不到 `session_id`**。以識別碼定位單一檔案的刪除
因此在失敗時無事可做 —— 一份 60 萬字元的語料副本留在來源目錄，活 30 天，沒有任何程式碼
會去刪它。**刪除因此改為以委派的專案目錄為單位**（那是本應用程式專屬管理的工作目錄所對應
的專案目錄，其中不會有別人的紀錄），並在成功與失敗兩條路上都執行。

**唯一不能刪的時機是 `busy`** —— 那代表這一趟根本沒有起委派，而另一趟正在跑，刪下去會把
**它的**紀錄一併清掉。

### 白名單「夠不夠」要實測，不要從語意推論

以 `env -i` 只給 `PATH` / `HOME` / `USER` / `LOGNAME` / `LANG` 跑一趟真實的
`claude -p --output-format json`：**exit 0 並取得回覆**。

- 本機的 `claude` 是 **native ELF 單檔**（`~/.local/bin/claude` → `~/.local/share/claude/versions/…`），
  `ldd` 只有 libc/libm/libpthread/libdl/librt —— **不需要 node、與 nvm 無關**。
  （npm 安裝法的 `#!/usr/bin/env node` 由 `PATH` 涵蓋。）
- 認證讀 `~/.claude/.credentials.json`；binary **未連結 libsecret**，所以
  `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` 不需要。
- **`TERM` 不需要**；`HOME` 是致命的。

**這只覆蓋這一種安裝方式。** 換一種安裝法要重測。



---

## 讀 transcript 有兩條路，它們不共用生命週期，也不共用投影

`agent-transcript-view` 之後，這個 repo 有兩條讀同一份來源的路徑。**分清楚它們，否則會想把其中
一條改成另一條的樣子。**

| | `transcript-archive`（存檔） | `transcript-follow`（跟進） |
|---|---|---|
| 觸發 | 應用程式啟動、使用者手動 | session 的生命週期 |
| 範圍 | 全部專案 | **單一 session** |
| 增量單位 | **整個來源檔案**（size/mtime 變了就重讀重寫） | **位元組偏移**（只讀追加的那一段） |
| 行程 | 獨立的 utility process（崩潰隔離） | 主行程 |
| 投影 | 計量用的列 | 要**呈現**的內容 |

共用的是「來源格式的知識」與「白名單處理記錄類型」的紀律。**不共用投影。**

### 位元組偏移，不是字元偏移

檔案大小是位元組數。以字元數當偏移，遇到任何非 ASCII 內容就錯位，而錯位之後解析出來的是
**看起來像壞掉的 JSON** —— 徵狀與「來源被改寫」無法區分。未終止的尾段因此以 `Buffer` 保留：
一次讀取的邊界可能落在一個多位元組字元的中間。

### 對話識別碼會變，而自癒不是唯一的原因

實測（2026-09-06、CLI 2.1.263）：**`/clear` 會直接指派一個新的 session id**，於是紀錄換檔；
`/resume`、`--fork-session` 同理。而這些**全部發生在 pty 之內** —— pty 沒死，
`SessionHealed` 不觸發，spekterm 收不到任何自己發出的訊號。

漏掉它的失效**特別惡劣**：跟進器停在舊檔，落進「檔案不存在 ⇒ 等它出現」，於是**永遠等下去**，
而「跟進失敗」也不會觸發（沒有失敗）。畫面就是一份安靜停住的對話。

**正解是不要只靠算**：hook 事件的基底 payload **每一個都帶 `transcript_path`**，而 statusLine
的 payload 也帶它。算出來的路徑是初始值與後備，**事件帶來的才是權威**。

### `SessionEnd` 這個 hook 不代表 session 結束

同一個實測：`/clear` 會發 `SessionEnd`，**而 pty 還活著**（59ms 後緊接著一個帶新路徑的
`SessionStart`）。

把它接上拆除，使用者按一次清空，跟進就此停住 —— 而 session 正常、終端正常、沒有任何錯誤。
**它的正確語意是「這一段對話結束了，接下來可能換一份紀錄」，因此接到「重新定位」。**
拆除只由 pty 的結束觸發。

> **一般形式：一個由可消費串流推導出來的狀態，其生命週期必須綁在被描述的對象上，
> 不能綁在觀察者上。** 等待狀態一度放在「訂閱物件」裡，於是使用者切走再切回時它重設為未知，
> **而重建它所需的事件早已被前一次訂閱讀走並刪掉**（讀完即刪正是去重的機制）——
> agent 那時閒著不再產生事件，狀態就永遠停在未知、輸入框永遠送不出去。

### hooks 的實測結論（2026-09-06、CLI 2.1.263）

- **注入的 hooks 與使用者 `settings.json` 的 hooks 是「合併」不是覆寫**（兩邊都定義
  `SessionStart`，兩個標記檔都出現）。因此**不需要**像 `statusLine` 那樣自己去讀使用者的設定
  來串接 —— 那是單一值才有的問題。
- **`Notification` 不是 idle 的同義詞。** `permission_prompt` 與 `idle_prompt` **都走它**，
  必須依 `notification_type` 分派。不分派的實作會把許可提示讀成「就緒」。
- **許可的 `Notification` 延遲 6 秒才送**（實測 6002ms / 6026ms 兩次），且可被
  `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS` 關掉。那六秒內狀態仍是上一個值＝忙碌，
  **而忙碌是允許送出的** —— 同一個災難換一條路走進來，且不需要任何實作錯誤。
- **`PermissionRequest` 是權威訊號**：實測早於畫面上的提示 22ms，且**與工具無關**
  （`ExitPlanMode` 走同一個 hook 並帶 `tool_name`）⇒ 不需要維護一張工具清單。
- **`PermissionRequest` 的 payload 不含它呈現給使用者的選項** —— `permission_suggestions` 是
  「要不要改變權限規則」的建議（例如 `{type:"setMode",mode:"acceptEdits"}`）。因此在對話 view
  裡作答只能靠猜終端畫面上的編號，而那正是被禁止的依賴。**規格因此改成「只說正在被問什麼，
  作答回終端 view」。**
- **基底 payload 帶四個以上的絕對路徑**（`transcript_path` / `cwd` / `scratchpad_dir`，
  工具類再加參數裡的檔案路徑）⇒ 送往 renderer 之前的剝除**必須是白名單**，黑名單會在 agent
  新增一個帶路徑的欄位時靜默失效。
- **`Stop` 帶 `last_assistant_message`**，是「剛講完話」的即時訊號。

### `SessionStart` 的時序，與「往一個剛起來的 TUI 寫字」（2026-09-11、CLI 2.1.267）

此前這份清單逐條記了 `PermissionRequest` 早 22ms、`Notification` 晚 6002ms，**唯獨沒有
`SessionStart` 的時序** —— 而「預填第一則 prompt」整條路徑就建立在它上面。實測（`bash -l -c
claude`，6 次）：

| 事件 | 相對 spawn |
|---|---|
| TUI 進入 alt-screen（`\e[?1049h`） | 1030–1180ms |
| **`SessionStart` hook 觸發** | **1284–1449ms** |

- **`SessionStart` 恆晚於 alt-screen 約 200–300ms，而且晚於 TUI 啟動時的輸入丟棄窗口。**
  以「看到 `SessionStart` 就寫入」重複 5 次，**5 次全部落進輸入框**。
  ⇒ **它是一個可用的閘，不需要第二個條件。**
- **失效的是一個窄帶，不是「越早越糟」。** 掃時間點的結果反直覺：
  **300ms 寫入會成功**（`bash -l -c` 不讀 stdin，位元組留在 tty 緩衝區，claude 起來後讀得到），
  **1000ms 寫入會被吞掉**（正好落在 TUI 啟動時清空輸入的窗口），1150ms 之後一律成功。
  > **因此「marker 有沒有出現在 pty 輸出裡」不是判準** —— 啟動前 tty 仍是 canonical 模式，
  > login shell 會回顯它，而那次回顯會被 alt-screen 切換連同整個畫面抹掉。
  > 判準是「**marker 出現在 `\e[?1049h` 之後的輸出裡**」。第一版的量測正是栽在這裡（300ms 那筆
  > 被判成成功，而它成功的理由與 TUI 無關）。
- **不附 `\r` 的寫入：文字落在輸入框裡、可編輯、且不送出。** 實測寫入後等 16 秒，
  **transcript 檔案根本沒有被建立** —— 沒有任何訊息被送出。
- **閒置時 `Notification` / `idle_prompt` 一次都沒有觸發**（9s 與 25s 各試）。
  ⇒ 把它當作「TUI 就緒」的備選訊號是**行不通的**，那個候選集合實際上是空的。

### 送出的編碼（以讀回紀錄驗證 agent 實際收到什麼）

- **`\n`（0x0A）是訊息內的換行，`\r`（0x0D）才是送出。** 送「多行本文 + `\r`」得到**恰好一則**
  訊息且換行完整保留；**bracketed paste 包與不包結果相同，因此不需要它**。
- **原始控制位元組會讓整則訊息無聲消失** —— 送含 `\x01` / `\x07` / `\t` 的本文再送 `\r`，
  紀錄檔**根本沒有被建立**。失效方向比「訊息被誤解」更難察覺：使用者只會以為自己沒按到送出。
  因此除 `\n` 外的控制位元組一律過濾。

### 注入的 shell 命令：整個 `if…fi` 必須在同一個字串元素裡

把它拆成陣列的多個元素再以 `'; '` 相接，`then` 後面會被塞進一個分號（`then; f=…`）——
**shell 語法錯誤，hook 每一次都失敗**。

而 agent 不會抱怨一個寫壞的 hook：我們只看到一個空的事件目錄、一個永遠「未知」的等待狀態、
一個永遠停用的輸入框，**沒有任何訊息指向真正的原因**。

**一條只斷言「命令字串包含某些片段」的測試擋不住它。唯一擋得住的是執行它**
（`agent-events.test.ts` 以 `sh -c` 真的跑一次，斷言檔案出現、內容正確、`.tmp` 沒殘留）。

## Who typed it, and what the hook events do not say (`companion-test-fixes`, CLI 2.1.300, 2026-10-15)

Measured with a real `claude` driven through a pty, hooks injected through `--settings` with matcher `''`,
plus a survey of a maintainer's local transcripts. **Agent CLI behavior: re-measure after a CLI upgrade**,
above all the `UserPromptSubmit` row of the table below.

### A message typed while tools run is not a `user` record

It is written as an `attachment` record, at the moment the agent absorbs it into the running turn (after the
tool result it rides in with), with the submission time as its timestamp:

```json
{"type":"attachment","uuid":"…","timestamp":"…","attachment":{"type":"queued_command","prompt":"<the text>",
 "source_uuid":"…","delivery_id":"…","commandMode":"prompt","origin":{"kind":"human"}}}
```

`queue-operation` records (`enqueue`, `remove` with `reason: "absorbed_mid_turn"`) accompany it; they have no
`uuid`. No `user` record is written for it. A message typed during a **text-only** answer is different: an
ordinary `user` record with `promptSource: "queued"`, written when the next turn starts.

**The same subtype carries other things.** About 1,340 local `queued_command` records: about 950
`commandMode: "task-notification"`, about 130 human prompts, and a few prompts from other origins
(`origin.kind: "peer"`, one `"auto-continuation"`). So the projection needs all of `queued_command`,
`commandMode: "prompt"` and `origin.kind: "human"`; anything less shows a notice or another session's message
as the user's. No delivery was also written as a `user` record (no `source_uuid` equals a `user` uuid), so
nothing is de-duplicated.

### `isMeta` is not the only "not typed by the user" marker

String-content `user` records not flagged `isMeta`:

| What | `promptSource` | `origin.kind` | Other |
|---|---|---|---|
| typed prompt | `typed` / `queued` / `suggestion_accepted` | `human` | |
| background-task notice (`<task-notification>…`) | `system` | `task-notification` | |
| compacted conversation's summary | — | — | `isCompactSummary: true` |
| slash command, `!` input and its output | — | — | |

`transcript-follow` marks the second and third as meta. The last row carries no marker at all, which is why
`!` output and local command output still show as the user's. Insights (`transcript-extract`) does its own
classification and strips notices by text; the two are deliberately separate.

### Hook events, measured

| Action | Events that followed |
|---|---|
| prompt submitted, text-only answer | `UserPromptSubmit` at once, `Stop` at the end |
| `!echo hi` | `Stop` only |
| `/cost` | none |
| `/clear` | `SessionEnd`, `SessionStart` |
| message typed while a tool runs | `UserPromptSubmit` at once, mid-turn |
| message typed during a text-only answer | `UserPromptSubmit` at once; `Stop`, then a second turn and `Stop` (1.8 s later) |
| tool needing permission | `PreToolUse`, `PermissionRequest` (+0.2 s), `Notification`/`permission_prompt` (+6.0 s, all five prompts) **with no `tool_name`** |
| prompt approved, tool fails | `PostToolUseFailure` (not `PostToolUse`), then `Stop` |
| agent service unreachable | `UserPromptSubmit`; `StopFailure` after ten retries (+175 s), no `Stop`; `idle_prompt` 60 s later |
| prompt denied (Esc, or "No") | **nothing** in 70 s |
| text-only answer interrupted (Esc) | **nothing** in 70 s |
| question tool (`AskUserQuestion`) | `PreToolUse`, `PermissionRequest` |
| after a turn ended (once in five runs) | a subagent's `PreToolUse` (it carries `agent_id`), nothing after it |

Three consequences, each in `agent-events.ts`:

- **Text typed into an open permission prompt or question, then Enter, answers it** (the tool ran) and
  reports no `UserPromptSubmit`. That is what makes `UserPromptSubmit` → busy safe: it cannot arrive while a
  prompt is open. It is also why sending into a prompt is refused: free text approves.
- **A denial and an interruption are invisible.** The state stays what the turn last reported until the next
  event, usually the user's next prompt.
- **The injected hook command must print nothing.** The agent adds a `UserPromptSubmit` hook's stdout to the
  prompt, so an `echo` in `EVENT_COMMAND` would ride along with every prompt.
  `agent-events.test.ts` pins an empty stdout.

## Prompts, answers and attachments (`remote-prompts-attachments-rename`, CLI 2.1.300, 2026-10-15)

Measured with a real `claude` driven through a pty, every hook dumping its full payload. Where the
maintainer's own settings would answer the question (they allow reads under the home directory and `/tmp`),
the agent ran with `--setting-sources project`. **Re-measure after a CLI upgrade**: `remote-answer.ts` and
the open-request rules in `agent-events.ts` rest on every row below.

### A permission request does not say which prompt it is, nor what the terminal offers

`PermissionRequest` carries `tool_name`, `tool_input`, `permission_suggestions`, `agent_id` (for a subagent)
and `prompt_id` (the turn's, shared by every prompt of the turn), but **no `tool_use_id`** and **not the options
the terminal shows**. The desktop gives each request its own id and matches it to the `PreToolUse` with the same
agent, tool and input: parallel calls' starts can arrive 1.5 ms apart, before either request.

| Prompt | Options shown |
|---|---|
| Bash | `1. Yes` / `2. Yes, and always allow access to <dir>…` / `3. Yes, and switch to auto mode` / `4. No` (the third is in no payload) |
| Write, Edit | `1. Yes` / `2. Yes, and switch to accept edits…` / `3. No` |
| WebFetch | `1. Yes` / `2. Yes, and don't ask again for <host>` / `3. No, and tell Claude…` |
| Read outside the working directories | `1. Yes` / `2. Yes, allow reading from <dir> during this session` / `3. No` |
| plan approval (`ExitPlanMode` with `tool_input.plan`) | `1. Yes, and use auto mode` / `2. Yes, manually approve edits` / `3. Tell Claude what to change` |
| `ExitPlanMode` with an empty `tool_input` | "Exit plan mode?" `1. Yes, and switch to default (ask each time)` / `2. No` |

- A digit picks its option at once, with no Enter. Esc dismisses any prompt and reports **nothing**: the agent's
  own turn ends ("Interrupted"); a question is "declined"; a plan approval leaves the agent in plan mode.
- After a plan answer, every event carries the mode entered (`permission_mode: "auto"` or `"default"`). That
  is how an answer is confirmed.
- **The agent waits for its `PreToolUse` hooks before it shows a prompt** (a hook sleeping 4 s delayed the
  prompt by 4 s), and for `PostToolUse` before the next tool starts. **It does not wait for a
  `PermissionRequest` hook**: the prompt is on screen while that hook runs.

### Several prompts at once, and what a background agent does meanwhile

- Parallel calls of a tool that runs in parallel (Read) report every request before any is answered. The
  terminal shows them one after another, in arrival order ("1 of 2"). Two parallel Bash calls are requested one
  at a time, and Esc interrupts both.
- **While a background subagent's prompt is open, the agent reports its own `Stop`**, and when another
  background task finishes, its notice arrives as a `UserPromptSubmit` (prompt `<task-notification>…`)
  followed by another `Stop`. Nothing in the payload tells such a submission from a typed one. A wait state that
  clears on those events reads ready over an open prompt, and a reply's text and Enter approve it. That shipped
  until this change.
- **The agent's own prompt holds those back**: a background subagent that finished while the agent's own
  prompt was open produced no event for 20 s, and its notice and the `Stop` came right after Esc.
- A subagent whose prompt is dismissed ends: `SubagentStop` with its `agent_id`. `SubagentStop` also arrives for
  helper agents (`agent_type: ""`) that raised nothing, after the turn ended.
- `Stop` lists the background tasks (`background_tasks: [{ id, type, status }]`, `id` = the subagent's
  `agent_id`, `status: "running"` while its prompt is open).
- `SessionStart` carries `source` (`startup`, `resume`, `clear`, `compact`).

### Answering a question

`tool_input.questions[]` is `{ question, header, options: [{ label, description }], multiSelect }`;
`PostToolUse` adds `tool_input.answers: { <question>: "<label>[, <label>…]" }`.

- Per question: options numbered from 1, then "Type something", then "Chat about this". A single-choice digit
  picks and moves on; a several-choice digit toggles; Tab or → leaves a several-choice question. After the last
  one a review opens (`1. Submit answers`), except for a single single-choice question, which submits on its
  digit.
- **Enter toggles the option under the cursor.** So does nothing else in an answer.
- **Every key in one write answered wrongly.** 100 ms and 250 ms gaps answered right.
- Keys written where no prompt is: `1` sits in the input box, → and Tab show nothing, Esc does nothing in an
  empty box ("Esc again to clear" with text in it). Nothing is submitted.

### Attachments

- Reading a file outside the working directories raises a permission prompt. `permissions.allow:
  ["Read(/<dir>/**)"]` (an absolute path needs the `//`) or `permissions.additionalDirectories` in `--settings`
  removes it. The settings merge with the user's own (the default mode stayed `auto`). The read rule is the one
  used: an additional directory is also writable in accept-edits mode.
- An 8.7 MB PNG named in a prompt was read with the Read tool and described.
- **A reply taken as a paste is recorded inside `<pasted_content id="…">` markers**:
  `\n\n<pasted_content id="55b5">\n<the text>\n</pasted_content id="55b5">\n`. The projection unwraps that
  whole-message shape. A paste among typed text is not measured, and is left as recorded.
- **In a reply taken as a paste, an image path on a line of its own becomes an inline image**
  (`[Image #1]`). The record is then a list of a text block (the path removed) and an image block, which the
  conversation projection does not show. Inside a sentence, in backticks, the path stays text and the agent
  uses Read, which is why the attachment sentence is written that way.
