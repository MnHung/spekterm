# 終端與 pty

`node-pty` 的 spawn 與生命週期、`claude` CLI 的實測結論、session 重建、標題權、剪貼簿與滑鼠、渲染、字元寬度、字型偏好。

> 這份文件是 `CLAUDE.md` 的延伸。**它與 CLAUDE.md 同一個定位：**
> 幾乎每一條都是「不知道就會踩、而且失敗是靜默的」的實測結論。
> 觸發條件（什麼時候該讀它）寫在 CLAUDE.md 的「踩雷指南」。

## spawn 與生命週期

- **`node-pty` 的 spawn 對 execvp 失敗「不會」同步拋錯。** 實測 `spawn('/nonexistent')` → 不 throw、
  pty 以 exit code 1 結束、`execvp(3) failed.` 由 `onData` 送出。於是「shell 路徑無效」與「claude
  找不到」殊途同歸，都經 `onExit` + 終端上的錯誤訊息呈現，**不是** `create` 回一個錯誤碼。
- **GUI app 常缺使用者 shell 的 PATH**（從桌面啟動不會繼承 `.zprofile`），直接 `spawn('claude')`
  會 ENOENT。兩種目標因此都經 login shell：`$SHELL -l` / `$SHELL -l -c claude`。
  **這道緩解的真正驗證點在 Phase 6 打包後從桌面啟動** —— `npm run dev` 是從終端起的，測不出來。
  - **但那兩者的涵蓋範圍不同，而差別是承重的（實測）。** `$SHELL -l` 掛在 pty 上是**互動** login
    shell，會 source `.zshrc` / `.bashrc`；`$SHELL -l -c <命令>` 是 login 但**非互動**，不會。
    而 **nvm 之屬正是在互動 rc 初始化的**：

    ```
    $ zsh -l -c 'command -v openspec; command -v node'
    /usr/bin/node          ← 系統的 v10.19.0，openspec 完全沒有輸出
    ```
    ```python
    pid, fd = pty.fork(); os.execv('/bin/zsh', ['/bin/zsh', '-l'])   # 真 pty 下的 shell 目標
    → /home/me/.nvm/versions/node/v22.22.0/bin/openspec
    ```

    所以 **shell 目標沒問題，缺口只在 claude 目標**：`claude` 目前找得到純粹因為它裝在
    `~/.local/bin`（由 login rc 提供）。改用 `npm i -g` 裝到 nvm 底下就會踩到（issue #20）。
- **主行程自己 spawn 的東西不受上面那道緩解保護** —— 那個機制作用於 pty。core 用來取得 schema
  權威順序的 `openspec` 因此在打包產物裡一律 ENOENT，解法是 `src/main/user-env.ts`（啟動時以
  **互動** shell 取一次 PATH）。兩個實測結論：
  - **必須前置（prepend），不能附加。** `openspec` 的 shebang 是 `#!/usr/bin/env node` —— 附加在後
    時它被解析到、卻用系統 node 執行而 `SyntaxError`，而 CLI 非零結束在 core 的 provider 眼中
    **與「未安裝」完全無法區分**。
  - **必須挑 shell，不能一律查詢。** `fish` 的 `$PATH` 是 list，`printf '@@%s@@' "$PATH"` 會印成
    `@@/a@@@@/b@@…`，解析得到的是第一個目錄 —— **沒有錯誤，只是 PATH 少掉大半**。因此是白名單
    （`sh`/`bash`/`zsh`/`ksh`），未知者放棄：沒修好的代價遠小於悄悄弄壞。
  - **它會改變 pty 的環境** —— `ptyEnv` 整份繼承 `process.env`。那是刻意的（agent session 從此也
    解析得到 nvm 底下的東西），但因此**套用只能發生在一個確定的時點**，不能放在某個功能的使用點：
    否則「其他行程有沒有拿到修好的 PATH」會取決於使用者有沒有先用過那個功能。
- **輸出的訂閱必須早於 `create`。** pty 在 `create` 回傳的那一刻就開始吐第一個 prompt，而
  `TerminalView` 要等 React 渲染完才 attach —— 中間沒有接收者的輸出會**直接消失**。
  `SessionsProvider` 因此在任何一次 create 之前就掛好唯一的 `onData`，尚未 attach 的先進 backlog。
  （與 Phase 2 的「**先訂閱、再列目錄**」同源：那個窗口裡的變更會兩頭落空。）
- **終端必須跨「切換 folder」常駐。** 只掛載當前 folder 的 session 的話，切走再切回時 xterm 實例已
  被卸載，先前的 scrollback 就沒了。因此掛載全部、以 `display:none` 決定顯示 —— 代價是隱藏的終端
  **量不到尺寸**，由隱藏轉為顯示時必須重新 `fit()`。
  > **「隱藏時 `FitAddon` 量到 0」是舊的心智模型，而它會咬人** —— 它回的不是 0，是一個被夾到
  > 下限的 `{cols: 2, rows: 1}`。見下面「隱藏的終端絕不可被 fit」。
- **`disposed` 的 exit 不是 session 結束。** 關視窗與 reload 時我們自己殺光所有 pty，那些都會觸發
  `onExit`。「已結束的 session 不持久化」若直接寫成「收到 exit 就移除」——**關一次視窗，
  `sessions.json` 就被清空了**。`ExitReason` 因此區分 `self`／`killed`（真的結束）與 `disposed`
  （我們收工時殺的：持久化原封不動，**且那個 exit 也不可推給 renderer** —— reload 後的新頁面已用
  同樣的 id 重建，一則遲到的 exit 會把剛重建好的分頁標成已結束）。
- **一個 claude session 是兩個 `/bin/sh` 行程**（`$SHELL -l -c "claude …"` 的那層 shell 不會 exec，
  實測）。**拿行程數去斷言「只喚醒了一個 session」，會把好的實作判成壞的** —— 以 `-l` 認出領頭
  行程，數量才等於 session 數。

## pty 的環境必須抹掉「巢狀 Claude Code」的標記 —— 否則續接功能**靜默失效**

spekterm 若由一個 agent 啟動（dogfooding 時的常態），Electron 會繼承那個 Claude Code session 的
環境變數，pty 再整份繼承下去。於是裡面每一個 `claude` 都認為自己是**巢狀的子 session**，而**巢狀的
claude 不寫 transcript**（實測：對話真的發生了，但 `~/.claude/projects/` 底下什麼都沒有）。
後果：`--resume` 必然失敗 → 自癒接手 → 使用者拿到一個**能用的** claude，只是對話永遠是全新的。
**沒有錯誤訊息、沒有紅燈，連探針也抓不到**（探針用的是 stub claude，它不管 env）。

- **元兇是單一一個變數**（二分實測）：**`CLAUDE_CODE_CHILD_SESSION`**。單獨拿掉 `CLAUDECODE` 或
  `CLAUDE_CODE_ENTRYPOINT` 都無效。
- **絕不以 `CLAUDE*` 前綴一概剝除** —— `CLAUDE_CODE_OAUTH_TOKEN` 是認證用的。`ptyEnv()` 的名單明確
  列舉，且不含任何帶 KEY／TOKEN 的名字。
- **兩種 spawn 目標都適用。** 此前這裡寫著「login shell 讓副作用很小（使用者自己在 rc 裡設的會被
  source 回來）」—— 那句話對 **claude 目標從來就不成立**（見下一節：它是非互動 shell，不讀 rc），
  而在使用者環境被合併進 pty 之後更會誤導：rc 若設了名單裡的名字，剝除之後**沒有東西會還原它**。
  那是刻意的 —— 一個宣稱自己隸屬於某個 Claude Code session 的 pty，對 spekterm 一律不成立。

## 使用者的 shell 環境：兩個目標涵蓋範圍不同，而修法不在 pty 上

**症狀**：agent session 裡的 MCP server 起不來、工具找不到憑證，而**同一個東西在使用者自己的
終端機裡好好的**。終端裡不會有任何一句話指出環境是缺的。

**成因**：`spawnArgs` 的兩個目標，其 shell 的互動性不同：

| spawn 目標 | 參數 | 掛在 pty 上是什麼 | 讀不讀 `.zshrc` |
|---|---|---|---|
| login shell | `['-l']` | **互動** login shell | **讀** |
| claude | `['-l', '-c', <命令>]` | **非互動** | **不讀** |

真 pty 下的對照（受控 `HOME`，`.zprofile` 與 `.zshrc` 各一個哨兵）：

```
zsh -l -c      → PROF=from-zprofile  RC=無          node=/usr/bin/node（系統 v10）  openspec=無
zsh -i -l -c   → PROF=from-zprofile  RC=from-zshrc  node=nvm 的 v22.22.0            openspec=有
```

### 為什麼**不**把 claude 目標改成 `-i -l -c`

那是最直覺的修法，而且副作用比預期小得多 —— 以下每一條都與直覺相反，都實測過：

- **真 pty 下沒有噪音。** `user-env.ts` 註解記載的 gitstatus 錯誤只出現在**非 tty**（`setopt monitor`
  失敗的連帶）。pty 上 `zsh -i -l -c` 與 `bash -i -l -c` 的輸出乾乾淨淨。
- **`HISTFILE` 不被寫入**（`-i` 配 `-c` 不記錄 history）。
- **`Ctrl+C` 語意沒壞** —— 互動版中斷後 shell 以 exit 130 結束，不落回 prompt。
- **`dash` / `sh` 對 `-i -l -c` 無害**，行為與 `-l -c` 相同。
- **`COLUMNS` / `LINES` / `TERM` 沒有被汙染**（互動 zsh 不匯出它們）——「pty 一輩子停在 80×24」
  這條在這裡**不成立**，曾經懷疑過，已否證。

**否決它的唯一理由是啟動延遲**，而它大到吸收不掉（各量三次，數字穩定）：

| | 命令開始執行的時間 |
|---|---|
| `zsh -l -c`（非互動） | **0.04s** / 0.04 / 0.04 |
| `zsh -i -l -c`（互動） | **2.33s** / 2.32 / 2.37 |

成本來自使用者的 rc（oh-my-zsh + powerlevel10k + compinit + nvm），**每個 agent session 都付一次**
（含休眠 session 首次顯示時的重建），而 `claude --version` 只要 **0.01s** —— 它是原生 binary。

> **這個否決有前提。** 若日後 per-session 的環境新鮮度變得比啟動延遲重要，這個裁決要重做。
> 兩者不互斥，可以並存。

### 於是：主行程取一次，但**只有 `PATH` 進 `process.env`**

那 2.33 秒 `user-env.ts` **每次啟動已經在付**（它查 PATH 用的就是 `-i -l -c`），把取值範圍擴大到
整份環境，邊際成本是零。

**但取回的東西不能全部寫進 `process.env`** —— 這是本節最承重的一條：

- `app.getPath('userData')`（決定 `workspace.json` / `sessions.json` / `preferences.json` /
  `panel.json` 的落點）與 CSP 的 dev／production 判定（讀 `ELECTRON_RENDERER_URL`）都在
  `whenReady` 內求值，而解析於 module load 觸發、**不被 await**。兩者之間是一個競賽窗口
  （實測約 **220ms**；一個只有幾行 `export` 的 `.zshrc` 是 **0.02–0.24s**，本機的 oh-my-zsh
  要 1.2s 所以贏不了 —— **但那是運氣**）。
- 後果：注入的 `XDG_CONFIG_HOME` ⇒ **所有 repo 與 session 消失，而它們的 pty 還活著**；
  注入的 `ELECTRON_RENDERER_URL` ⇒ 打包產物套用 dev CSP 並拿它去 `loadURL`。

**「只在原本不存在時才加入」這條規則救不了它**（實測，桌面選單啟動的產物，49 個變數）：

```
DISPLAY  存在      XDG_CONFIG_HOME  **不存在**      ELECTRON_RENDERER_URL  **不存在**
HOME     存在      NODE_OPTIONS     **不存在**      ELECTRON_RUN_AS_NODE   **不存在**
```

危險的那幾個**不在啟動環境裡**，於是那條規則對它們一律**放行** —— 方向與直覺相反。而一份
「不可覆寫」的黑名單會遺漏尚未存在的變數（下一個 Electron 版本新增的那些），且遺漏是靜默的。
**不寫進去，這一整類問題才表達不出來。**

### 其餘幾條實測

- **`bash -i -l -c` 走 login 路徑，不直接讀 `.bashrc`**（讀 `.bash_profile`；Debian/Ubuntu 的預設
  `~/.profile` 會 source 它，自訂過的可能不會）。這與**使用者自己開 login shell session 時看到的
  一模一樣** —— 我們要的等式是「agent session ＝ 同一個 app 裡的 login shell session」，
  不是「＝ 某個外部終端機」。另外 Ubuntu 的互動 bash 會印兩行 sudo hint，那是系統 rc 的輸出。
- **標記與分隔符用 NUL 是結構性保證**：`execve(2)` 讓環境變數的名字與值不可能含 NUL。此前的 `@@`
  不具這個性質 —— 一個值為 `line1\nline2 with 'quote' and @@ mark` 的變數會在它身上截斷。
- **驗證「`printf '\0'` 真的印得出 NUL」時不可經 `$(...)`** —— command substitution 會剝掉 NUL，
  於是會量到「印不出來」這個**相反的結論**。要直接 pipe（`| od -c`）。
- **環境是啟動時的快照** —— 改了 `.zshrc` 要**重開 app**，開新 session 不夠。
- **缺口沒有全關**：使用者的 shell 不在可安全查詢名單上（fish 之屬）或平台為 Windows 時，取得
  一律放棄，agent 目標的涵蓋範圍**退回只有 login rc**（issue #31 —— 真正會咬人的是 Windows，
  Phase 6 排了 Windows 產物）。

## `claude` CLI 的實測結論（全部左右了設計）

- **`--session-id <uuid>` 可由我們指定對話 id**；`--resume <uuid>` **沿用**原 id（`--fork-session`
  才換）。於是 id 可被持久化並直接續接，**不必去猜哪個 `.jsonl` 是我們的**。
- **`--session-id <已存在的 id>` 會直接報 `already in use`** —— 於是 `claude --resume X ||
  claude --session-id X` 這種自癒寫法是個陷阱（claude 因其他原因非零退出時 `||` 會撞號）。
- **開了 session、還沒跟它講話就關掉 app → claude 根本不寫 transcript**，重建時 `--resume` **必定
  失敗**。**這不是邊角，是主線情境**（開個分頁準備等一下用）。
- **`--resume` 在互動模式下會自己把過去的對話重畫在終端上** —— 因此 **claude session 絕不重播我們
  存的畫面快照**（會看到兩份歷史），**只有 shell 存快照**（順帶省下絕大部分快照 IO）。
- **`--resume` 的查找是 git repo 關聯的**（實測：主工作目錄 ↔ worktree 互通，無關的非 git 目錄
  查不到）。於是「worktree 消失 → 退回 folder 根」這條退路是安全的，對話不會丟。
  > 限制：這是 claude 的**內部行為**，可能隨版本改變。但**降級方向安全**（猜錯的下場是自癒成新
  > 對話，不是撞號讓 session 死掉）。
- **`claude` 一啟動就宣告任務式的 OSC 標題**（`✳ Claude Code`），**即使你一個字都還沒講**。
  所以**分頁標題不是「有對話」的證據**。

## session 的重建

- **spekterm 的 session id 與 claude 的對話 id 必須解耦。** 續接失敗時必須以**全新的** uuid 開新
  對話（沿用舊的會撞號），若兩者是同一個欄位，換號就等於換掉 session 的身分（分頁 key、focus、
  順序、錨定全要跟著搬）。因此持久化有兩個識別碼：`id`（**永不改變**）與 `claudeSessionId`（可換）。
- **續接策略：一律 `--resume`，pty 若在 3 秒內以非零碼結束就判定失敗，以全新 uuid 重試一次**
  （至多一次）。**判準只看「時間 + 結束碼」，不解析 claude 的輸出** —— 這條路徑零 layout 依賴。
- **`#heal()` 是主線情境，而它對 renderer 完全不可見**（`status` 一直是 `running`）。因此凡是
  「pty 誕生時要做的事」，自癒那條路上都要自己再做一次：**推尺寸**（否則新 pty 一輩子停在 80×24）、
  **沿用 session 記住的 cwd**（否則開在 worktree 的 session 會靜默站到別的地方）、**帶上固定名字**
  （`agent-peer-name`；否則自癒出來的 agent 以 CLI 自動產生的名字登記，告知給母子 session 的地址
  就此失效）。前兩件事**都是漏掉後才補的**，位置相同、疏漏同型；名字是一開始就寫進 `#heal()` 的。
- **同一個 session 的前一顆 pty 結束之前，不 spawn 新的。** renderer 重新載入時舊的 pty 被非同步地
  殺掉，新頁面會立刻喚醒 focused 的 session。agent CLI 允許兩個同名行程並存（實測），於是那段窗口裡
  以那個名字送出的訊息可能送進即將被終止的那一個。等待在 `TerminalService.create()` 裡（模組層級
  的 `lastExit`，因為舊 pty 屬於被 dispose 的那個服務），上限 3 秒。
- **`ptyEnv()` 剝掉所有從外層繼承來的 `SPEKTERM_*`**，之後才合併本 session 的專屬變數 —— 見
  `docs/lessons/handoff.md` 第十二節。
- **喚醒把「pty 先誕生、終端後掛載」的順序倒了過來。** `fit()` 在「尺寸沒變」時回 `null`。喚醒
  休眠 session 時：終端先顯示 → `fit()` 成功量到尺寸 → 送 resize → **pty 還不存在，被丟掉**；而
  `lastCols` 已記成那個尺寸 → 之後再 `fit()` 一律回 `null` → **再也沒有人告訴 pty 真正的尺寸**。
  修法：pty 誕生的那一刻（`status` 轉 `running`）把終端當下的尺寸告訴它（`XtermHandle.size()`，
  它不做「有沒有變」的偵測 —— `fit()` 回答不了這個問題）。**新建的 session 不會踩到。**
- **`\x1b[?1049l` 只能條件式地送。** `SerializeAddon` 會把終端模式一起序列化（使用者關 app 時正開
  著 vim，快照裡就真的有 `?1049h`），所以重播完可能就站在 alternate buffer 裡。但兩個直覺修法都
  錯：寫在歷史**之前**對 alt screen 毫無作用；**無條件**寫在歷史之後會毀掉正常情況 —— `?1049l` 會
  **還原「進入 alt screen 當下所儲存的游標」**，沒進去過時那是 **(0,0)**，游標被拉回左上角，分隔線
  蓋掉歷史第二行。**正解**：只有 `term.buffer.active.type === 'alternate'` 時才送。不動游標的重置
  （滑鼠追蹤、SGR）則無條件送。
- **重播完要自己把游標挪到內容之後**（只用相對移動的 `\n` —— 絕對定位在一個尺寸不同的終端上會落在
  錯的地方），再寫分隔線，**然後才接上 live 串流**。
- **快照的取用不可以是「讀完即刪」** —— StrictMode 把掛載 effect 跑兩次，第一次就把快照取走了，
  第二次（真正存活的那個 xterm）拿到 `undefined`，畫面一片空白。改為非破壞性讀取，`close()` 才清。
- **休眠的提示會被 xterm 蓋住。** `.xterm` 是 `position: relative` 且由 `handle.open(host)` 在
  effect 裡 append —— 排在 React children **之後**，兩者都 `z-index: auto` → 依 tree order 繪製。
  修法是 host 給 `relative`、提示給 `z-10`。而**「這個 session 恢復不了」的提示不該是
  `pointer-events-none`** —— 它背後是一個永遠不會活過來的終端，沒有東西值得點。

## 標題與命名權

三層優先序：**使用者取的名字 > pty 宣告的 OSC 標題（僅 `claude` 目標）> 本地流水號**。

- **使用者一旦命名就是永久接管** —— pty 其後宣告的標題一律**靜默地不予呈現**（不覆蓋、不確認、
  不提示）。交還的唯一路徑：**把名字清空**。
  > 這裡原本有一個「pty 想改名，要採用嗎？」的確認對話框，已移除 —— **它的前提是錯的**。它假定
  > 「pty 想改名是罕見事件，值得問一次」，但 `claude` 隨任務進展**持續**改標題。而「保留我的名字」
  > 只清掉待裁決欄位、**不記錄使用者已經拒絕過**，於是下一次判定條件完全相同，對話框再跳一次。
  > 當初的 spec **已經察覺** agent 會頻繁改名（才有「待確認的標題是單一欄位而非佇列」），但緩解只
  > 做到「不要一次問太多次」，沒處理「**沿著時間軸反覆問同一個問題**」。
  > **教訓：一個高頻事件上的確認，要問的是「這個問題值得問嗎」。** 而它的答案是可預測的 ——
  > **「使用者取的名字 > pty 的標題」這條優先序本身就已經是那個裁決。**
- **接管期間 pty 的標題仍持續被記錄，只是不呈現** —— 這是「清空即交還」得以即時的前提。若直接
  丟棄，清空後會退回 `claude 1`，空等到 pty 下次宣告為止（可能永遠不會來）。
- **login shell 不採用 OSC 標題。** shell 送的是 `使用者@主機:/路徑`，對使用者零識別意義；而且它
  **比 session 晚一秒多才到**（要先載完 rc、畫出第一個 prompt），抵達時分頁從約 60px 暴增到約
  210px，把緊鄰其後的「+」入口**往右推 150px**。**分頁不限寬** —— 根因是標籤內容突變。
  - **擋在 `sessions.tsx` 的 `setTitle()`，不是顯示層** —— 那是 OSC 標題進入狀態的唯一入口。
    只改顯示層的話，標籤是對了，但衍生的行為（當年的確認對話框）仍會被觸發。

## 隱藏的終端絕不可被 fit —— 以及「守衛倚賴上游回傳值形狀」這一類

**一道讀上游函式回傳值的守衛，其正確性不在我們的版控之內。** 純依賴升級不會改任何 `.ts`，於是
型別、單元測試與既有探針**全部照樣綠**。這條的實例是本 repo 最貴的一個靜默缺陷：

`xterm.ts` 的 `fit()` 曾以「`proposeDimensions()` 回傳的數字有沒有效」判斷容器可不可量。逐版比對：

| `@xterm/addon-fit` | 容器 `display:none` 時 `proposeDimensions()` 回傳 |
|---|---|
| `0.11.0`（本 repo 至 2026-08-18） | `parseInt('auto')` → `NaN`（`Math.max(0, NaN)` 仍是 `NaN`）⇒ **`{cols: NaN, rows: NaN}`** ⇒ `Number.isFinite` 攔得下 |
| `0.12.0-beta.299`（`3d0629a` 起） | 上游加了 `parseInt(...) \|\| 0` ⇒ 可用空間為負 ⇒ 夾到 `MINIMUM_COLS=2` / `MINIMUM_ROWS=1` ⇒ **`{cols: 2, rows: 1}`** ⇒ **三道防護全部放行** |

**後果有三個，全部靜默：**

1. `term.resize(2, 1)` 把 buffer **重排成 2 欄** —— 行數暴增、撞上 5000 行的 scrollback 上限，
   最舊的內容**永久消失**（實測：900 行的輸出，切走一次就毀掉 567 行）。
2. pty 真的收到 2 欄 ⇒ **agent 在隱藏期間以 2 欄排版**，那些輸出印進 scrollback 就是壞的
   （dogfood 的徵狀：Write 工具的預覽每一行只剩開頭一個字）。
3. **落盤的快照也是 2 欄的** —— 這是唯一跨重啟存活的損害，下次開 app 還會重播它。

**已經損失的救不回來**：被擠掉的 scrollback、以及已經落盤的 2 欄快照（直到該 session 被關閉或
快照被一次正確寬度的序列化覆寫）。

**判準因此改成「容器有沒有被排版出來」**（`term.element.parentElement` 的 `clientWidth` /
`clientHeight` 為 0 就不 fit）—— `display:none` 的元素沒有 box 是 **DOM 的契約**，不是某個套件的
實作細節。**不要改成「把 `< 1` 放寬成 `<= MINIMUM_COLS`」**：那是黑名單、綁在上游的內部常數上
（同一個成因換個位置重演），而且它分不出「真的很窄的終端」與「沒有盒子」—— 兩者的正確處置相反。

**擋住它的是三道結構，不是「升級時記得小心」：**

- `probe-terminal` 的 **winsize 斷言**（切走一個 session，讀它 pty 自己持有的 `stty size`）——
  擋「上游又變了」。
- `scripts/terminal-resize-source.test.mjs` —— 擋「我們自己在別處多開一條繞過 `fit()` 的路」
  （咽喉點是 `@xterm/*` 的 import，不是 `fit()` 的呼叫）。
- `xterm.ts` 明寫的 **`windowOptions: {}`** —— 擋「pty 裡的程式以 DECCOLM／XTWINOPS 自行改寫幾何」
  （此前靠的也是上游預設）。

**精確的觸發條件是「切走一個曾經顯示過的終端」**：`proposeDimensions()` 的第一道檢查是
`dims.css.cell.width === 0 → return undefined`，從未排版過的終端走的是那一條。**驗收的前置因此
是承重的** —— 載體必須先讓該終端真的顯示過。

## 複製、貼上、滑鼠

- **不能靠瀏覽器原生的路徑。** xterm 的選取**不是 DOM selection**（它自己畫），原生的
  「Ctrl+C 複製選取文字」對它完全無效。複製走 `term.getSelection()` + 主行程 clipboard；貼上走
  `clipboard.readText()` + `term.paste()`。**不用 `navigator.clipboard`** —— 它的 `readText()` 在
  Electron 中受 `clipboard-read` 權限模型擺布，跨平台不一致。
- **選單操作完要把焦點還給終端。** 實測：自右鍵選單貼上之後按 Enter **不會執行**（焦點還在選單）。
- **右鍵一律由終端擁有，與 mouse reporting 無關。** 此前它 gate 在 `term.modes.mouseTrackingMode`
  —— 程式接管滑鼠時右鍵讓位給它，「使 claude 的右鍵貼上生效」。**那個前提兩端都已實測否證**
  （`terminal-right-click-and-hidden-fit`）：
  - `claude` **一啟動就送 `?1000h ?1002h ?1003h ?1006h`**（以 node-pty spawn 抓序列）—— 於是
    agent session 裡右鍵**永遠**被讓出去，而那正是這個 app 的主場。
  - **pty 內的程式讀不到系統剪貼簿**：唯一的管道 OSC 52 xterm.js 未實作
    （`InputHandler.ts` 明列 52 為未支援）。讓出去的是一顆什麼都不做的鍵。
    > **但這是一個選擇，不是結構性不可能** —— `registerOscHandler` 是公開 API，要加隨時加得上。
    > 右鍵歸屬真正的依據是「**今天沒有程式在這個終端裡用右鍵做出有用的事**」。日後若 claude
    > 開始以右鍵做與剪貼簿無關的事，退路是 `Shift+右鍵` 轉發給程式。
  - 觸控板沒有中鍵，於是那道 gate 讓使用者**完全失去滑鼠貼上**（dogfood 回報）。
  右鍵因此與中鍵收斂為同一條歸屬規則：**capture 階段整顆接管，選單自 `mousedown` 開**
  （不依賴 `contextmenu` —— 它由平台決定派送在 down 還是 up）。已知取捨：終端的 `contextmenu`
  不再冒到 window，於是**兩個 `[role="menu"]` 可以並存**（分頁的選單開著時再對終端右鍵）。
- **中鍵雙貼的兇手是 Chromium 原生的中鍵貼上。** `terminal-clipboard` D5 當年寫「X11 的中鍵貼的是
  PRIMARY，而瀏覽器拿不到它」—— **那個假設在 Electron 裡不成立**。React 的 `onMouseDown`（bubble）
  擋不掉它：其一 bubble 晚於 xterm 掛在 `.xterm-screen` 上的 listener；其二**原生貼上掛在
  `auxclick` 而非 mousedown**。**正解**：host 上的 **capture 階段**原生 listener，對 button 1 的
  `mousedown`／`mouseup`／`auxclick` **一律 `preventDefault`** + `stopPropagation`，並在 mousedown
  做**唯一一次**貼上。
- **終端裡的連結歸誰管**：login shell 中純文字 URL 與 OSC 8 兩套都正常。差別只在 **claude 開了
  mouse reporting** —— xterm 此時把左鍵**轉發給程式**並 `cancel()` 掉自己的處理，而**修飾鍵是一起
  編碼進去的**，於是 `Ctrl+click` 是 **claude 自己**去開那個連結的。`Shift+左鍵`反而沒反應，因為它
  被 xterm 攔去做「強制選取」—— **Shift 從來就不是「連結的繞道」**。
  - **推論：「點檔案路徑開在側欄」在 claude session 裡做不到。** 唯一的攔法是在 capture 階段搶下
    **左鍵**，但左鍵是 claude 整個 UI 的主要互動面，代價與當初搶右鍵不是同一個量級。
    **真正的解是讓 spekterm 被 claude 認成 IDE**（它在 VS Code／JetBrains 裡就是這樣開檔的）——
    那要獨立論證，尚未進行。
- **OSC 8 超連結走 `Terminal.linkHandler`**（與 WebLinksAddon 的純文字連結是**兩套**）。未設它會
  落入 xterm 內建預設：`confirm()`（文字由不受信任的 pty 輸出控制）+ `window.open()`。
  兩套都要匯到 `openExternal`。

## 渲染

- **webgl 是唯一可用的 GPU renderer。** `@xterm/addon-canvas` 對 xterm 6 已死（latest 0.7.0，
  **唯一仍宣告 peer `^5.0.0` 的 addon**，2023-11 後未再發佈）。
- **並存的 webgl context 上限實測恰為 16，超出時最舊的靜默被丟棄、`webglcontextlost` 一次都不觸發。**
  於是「只給當下顯示的那一個終端」是**正確性要求而非優化** —— `onContextLoss` 的自癒救不了它
  （那條倚賴一個通知，而這裡根本沒有通知）。
- **`WebglAddon.dispose()` 不歸還那個額度** —— 該套件全檔沒有 `loseContext`（xterm 6 實測），
  它只移除 DOM 產物，context 等 GC，而上限的檢查是**即時**的。於是「已釋放」的 context 仍佔位置，
  直到把使用中的那一個擠掉。**解除掛載 ≠ 歸還額度**，而兩者的差別在 DOM 上看不出來 ——
  依產物判定的斷言在額度未歸還時**依然全綠**（`terminal-sessions` 為此把「釋放」明確定義成歸還額度）。
  修法是自己呼叫 `WEBGL_lose_context.loseContext()`。
  - **參照要在建立 addon 的當下就抓（`loadAddon` 前後取差集），不是釋放時才去找。**
    所有終端**同時掛載**，因此 `document.querySelector` 會回傳**另一個正在顯示**的終端的 canvas
    —— 釋放它＝使用者當場看到空白，正是這條規格要防的結果本身。終端銷毀那條路更確定：
    React 的 cleanup 跑在節點移除之後，查詢**只可能**命中別人的。**查詢根必須是 `term.element`。**
  - **用差集而非選擇器排除法。** `:not(.xterm-link-layer)` 是黑名單：`.xterm-screen` 下日後多一顆
    沒有 context 的 canvas，查詢它的 webgl context **會當場建立一個新的**（多吃一個額度，方向相反）。
    差集只看「這次新增了什麼」，兩種誤選在結構上都不可能。
  - **順序是 `dispose()` → `loseContext()`。** dispose 會解除 addon 的 DOM listener，因此不會觸發
    它的 handler。反過來會踩到：`webglcontextlost` 的 handler 排一個 **3000ms** 的 timer，而那個
    timer **只有 `webglcontextrestored` 會清、`dispose()` 不清** —— 三秒後仍會印訊息（污染
    #19／#21 賴以判讀的 console 緩衝），且若使用者在那三秒內切回來，它會把剛建好的新 addon 蓋成 `null`。
  - **「dispose 之後那個終端底下一個 canvas 都不剩」是狀態相依的觀察，不是不變式。** 確定被移除的
    只有主 canvas 與 link layer；`_tmpCanvas` 是否還在取決於誰最後光柵化過新 glyph（它跨終端共用
    且會遷移）。**不可據此放寬任何選擇。**
  - **驗收的判準是「該 context 自身是否已失效」，不是「額度滿了誰先被回收」。** 後者的回收順序
    （最早取得者優先）會讓「有歸還」與「沒歸還」在多數佈局下結果**完全相同** —— 追這個缺陷時
    兩度得到那種無差別的結果，差點據此推翻一個正確的結論。而**驗收持有參照這件事是承重的**：
    它讓觀察不受 GC 影響（未歸還的實作之所以多半沒出事，正是因為 GC 碰巧來得及）。
  - **「釋放的是它自己的資源」不能用「切換」驗**（實測）：切換後 React 會為新顯示的終端重建脈絡，
    誤傷了也看不出來 —— 那樣的斷言在以 `document` 為範圍的錯誤實作下**照樣是綠的**。
    載體是**關閉另一個 session**：顯示中的那個自始至終沒換過，沒有重建會掩蓋它。
- **關掉它的開關是必要的**：自動降級只擋得住「資源取不到」，擋不住「取得了但驅動畫錯」，那只有
  使用者看得出來。
- **行高預設 1.0，理由是「因為降級路徑存在」。** DOM renderer 下框線字元是**靠字型自己的 glyph 去
  拼**的，glyph 只有約 1em 高而 row 是 `fontSize × lineHeight` —— **行高大於 1 時上下兩列的 `│`
  接不起來**。實測（同一張表格）：DOM + 行高 1.3 是 7 段 / 30px 空洞，DOM + 行高 1.0 與 webgl 都是
  1 段 / 0 空洞。**webgl 在垂直方向的貢獻是「讓行高自由」，不是「修好縫」** —— 但 DOM 是真實可達
  的降級路徑（context 取不到、驅動有問題、使用者自己關掉），預設 1.3 的話落到 DOM 的使用者開箱就
  是破的表格，而他們正是最沒能力自救的一群。
- **webgl 真正修掉的是水平方向的分數像素。** 出貨預設下 DOM 的 `cellW = 9.63`（垂直線佔的 x 數
  `[1,2,2,1]`），webgl 是 `9`（`[1,1,1,1]`）。峰值亮度相同 —— **不是變暗，是被抹開**：外框線恰好
  落在整數像素而銳利，內部的線被反鋸齒攤到兩個像素。**同一張表格裡有的線是一條、有的是兩條淡的。**
- **`customGlyphs` 是官方機制**（xterm 6 的公開選項，預設 true），程式化繪製 block element 與
  box drawing，且**對 DOM renderer 無效**。
- **「捲動時破版」始終沒有被合成重現，是由 dogfood 認定修好的。** 合成 fixture 量到的是 fixture 的
  結構而非渲染缺陷。**紀律要留著**：下次遇到「只有真實環境才觸發的呈現問題」，能驗的就驗，驗不到
  的標示清楚交給 dogfood，不要用一個合成的綠燈假裝它被證明了。

## 字元寬度（判定單位是 grapheme cluster）

xterm 內建的寬度表是 **Unicode 6**，而 agent 依現代 wcwidth 排版 —— 每個 emoji 都讓那一行少一格。
這條缺陷與「一個 cell 內怎麼畫」（行高、GPU）**相鄰但不同層**。修法是載入
`@xterm/addon-unicode-graphemes` 並開啟 `allowProposedApi`。

| | claude 排版 | 內建 v6 | `addon-unicode11` | `addon-unicode-graphemes` |
|---|---|---|---|---|
| `✅` U+2705 | 2 | 1 ✗ | 2 ✓ | 2 ✓ |
| 星形平面 CJK 擴充 | 2 | 2 ✓ | 2 ✓ | 2 ✓ |
| `⚠️` U+26A0+FE0F | 2 | 1 ✗ | **1 ✗** | 2 ✓ |
| ZWJ 序列 | 2 | 3 ✗ | **6 ✗** | 2 ✓ |
| 膚色修飾 | 2 | 2 ✓（碰巧） | **4 ✗** | 2 ✓ |

**多個 code point 合起來算一個字，而查表式的實作沒有地方可以表達這件事** —— 於是「先用比較小的
`unicode11`，之後再換」不是可行的退路。

- **`allowProposedApi` 是硬性前提**：未開時 `loadAddon()` **當場**拋錯，沒有「載入了但沒生效」的
  中間狀態。而「版本字串在不在清單裡」是「寬度對不對」的**代理判準** —— 真正會靜默失敗的是
  「載入成功、版本對、寬度表卻答錯」，那只有「代表性字元集逐類別正確」的驗收擋得住。
- **不新增設定開關** —— 字元寬度是確定性的，沒有 GPU 那種「取得了但驅動畫錯」的失效模式。
- **效能**：同一實例重建、n=9 取中位數 —— 含 emoji **+4.6%**（4000 行多約 1.5ms），純 ASCII 在
  雜訊內。**初次量測 n=1 且跑出 −37%，唯一誠實的結論是「不具資訊量」，不是「沒有退步」。**

## 字型偏好

- **預設不該是一個「不存在的字型」。** 原本首選 `'JetBrains Mono'` —— 這台機器沒裝、專案也沒打包，
  於是靜默落到系統預設等寬字。字型從此與宣告不符，而且**畫面上看不出來**。預設收斂為誠實的
  `ui-monospace, monospace`；與使用者終端一致由**偏好**達成，不是靠猜一個字型名。
- **列舉系統等寬字用 `fc-list :spacing=100 family`**（`:spacing=100` 正是 fontconfig 的 monospace
  判準）。這是使用者開設定的一次性動作，spawn 一次 `fc-list` 可接受 —— 與「分支偵測不 spawn git」
  的熱路徑紀律不同。目前只支援 Linux。
- **UI 是純 `<select>`，不是可打字的 combobox** —— dogfood 兩次否決（free-text 難用、datalist
  combobox 要先清空才能換）。
- **preview 要含 box-drawing**：DOM renderer 下 preview 的框線就是終端的框線。（若只跑 GPU
  renderer，這條就反了，得重新想。）
- **掛載時「什麼都沒變」不該 resize。** 字型 effect 一開始無條件 `fit()` + `resize()`，於是每個終端
  掛載時都對 pty 多送一次 **SIGWINCH**，shell 收到它會**重畫 prompt，把既有輸出往上推**。
  `setFont` 要回報「有沒有真的改動 xterm 的選項」，沒改動就不打擾 pty。

## 渲染路徑持有的**第三種**資源：週期性工作

`terminal-sessions` 對「釋放」的定義已經擴充過兩次：先是「不只是移除文件產物」，再是
「必須歸還並存額度」（issue #24）。第三次是 issue #25 / #28：該路徑還會安排一個**週期性工作**
（游標閃爍，600ms），而它與並存額度**各自獨立地**被釋放或不被釋放。

實測的後果：上游套件曾讓額度歸還、週期性工作沒停，於是每一次釋放都留下一個不屬於任何存活終端
的計時器。它們每 600ms 要求一次畫面更新 ⇒ **renderer 永遠不進入閒置**，合成器被迫以螢幕更新率
持續產生沒有任何產出的幀。連續使用 24 小時累積 72 個、閒置負載由 0.2% 升到 23.2%；跑滿 100
小時者吃滿一整顆核心。症狀是打字延遲與切換 session 變慢。

**它對既有驗收結構性地隱形**：殘留者不留文件產物、不改變終端數、不影響並存額度 —— 依前兩種
判準寫的斷言全部照樣是綠的。九支探針數個月沒有察覺，最後靠使用者回報「用久了變慢」才被發現。

**診斷方法**（完整工具程式碼在 issue #29 的留言）：以 CDP 攔截 `requestAnimationFrame` 統計呼叫來源，
再除以 1/0.6 即得存活的閃爍計時器數；`trace.mjs` 抓 Chromium trace 可看出合成器是否在跑
「`DidNotProduceFrame` 恆為真」的空循環。**要看合成器必須用 `Tracing` domain，不是 `Profiler`**
—— 後者只看 JS 主執行緒，而主執行緒正是沒問題的那一條。

## `@xterm/*` 釘在 beta channel —— 理由與**解除條件**

六個 `@xterm/*` 套件釘死在 `0.20.0-beta.*` / `6.1.0-beta.*`，不是 `latest`。

- **為什麼**：上述缺陷的修正（xtermjs/xterm.js#5818）只在 beta channel。而 xterm.js 的正式版
  節奏是 5.5.0（2024-04）→ 6.0.0（2025-12），等下一版可能一年以上。
- **beta 不是無人使用的 nightly** —— **VS Code 出貨的就是這條 channel**，反而比 `latest` 被跑得更多。
- **必須釘死**：`^0.20.0-beta.298` 在 semver 下**會往上飄**到更新的 beta，而該 channel 每日發版。
  守衛在 `scripts/xterm-blink-release.test.mjs`。
- **已知代價**：該 beta 在虛擬螢幕環境下**游標閃爍不會啟動**（上游 xtermjs/xterm.js#6113），
  於是那條規格的行為層級驗收沒有載體（缺口登記於 issue #29）。實體螢幕上正常。
- **解除條件**：含修正的**正式版**發佈後，改回釘正式版並重新評估 #29。


---

## 「掛載」「有版面盒子」「看得見」是三個謂詞，而它們此前恆等

`agent-transcript-view` 讓一個 session 有兩種呈現方式（終端與對話），於是出現了**第四種轉換**：
**保有版面盒子、失去可見、不銷毀、不失去掛載**。

在那之前，三者恆等，於是 `TerminalView` 裡每一個以 `active` 為條件的判斷都同時是這三件事。
拆開之後，**四處裡有兩處的判準是錯的**，而型別檢查一句話都不會說：

| 判斷 | 正確的判準 | 為什麼 |
|---|---|---|
| `fit()` ＋ 推送尺寸給 pty | **有沒有版面盒子** | `terminal-sessions` 明文禁止在沒有盒子時推導尺寸 |
| `hidden` 類別 | 有沒有版面盒子 | 同上 |
| **`handleRef.focus()`** | **看不看得見** | 隱形的終端搶走焦點 ⇒ 使用者打的字進 pty 而**畫面上什麼都沒有** |
| **`setGpuRenderer()`** | **看不看得見** | 被覆蓋時必須歸還並存額度，否則反覆切換會把額度耗盡 |

### Covering must not resize: the two renderers measure different cells

`maximize-panel-and-confirm-close` measured it: maximize + restore turned a 63-column pty into a
57-column one, and nothing in the side panel touched the terminal's column. The chain:

1. Covering releases the GPU renderer (the table above: `setGpuRenderer()` follows visibility).
2. The DOM renderer lays the **same columns** out wider — about **9.63px** per cell against webgl's
   **9px** (the shipped font; see "渲染" below). 63 columns became 607px of content in a 587px box.
3. The `react-resizable-panels` panel wrapper is `overflow: auto` by default, so the column grew
   **scrollbars**, the terminal's box shrank by their width (15px each way), and the resize observer
   sent the pty the smaller size. The agent reflowed for a change nobody made.

Two fixes, both needed:

- **The terminal panel clips instead of scrolling** (`style={{ overflow: 'hidden' }}` on that
  `Panel`). The box can no longer change because of what is drawn inside it.
- **`TerminalView` does not fit on a change of `covered` alone** — only when it becomes `active` or
  its status changes. A cover never changes the box, and the renderer is swapped on that very
  transition, so a fit there measures with whichever renderer happens to be attached at that moment.
  The effect order made it worse: the fit effect runs before the GPU effect, so on uncover it
  measured with the DOM renderer and then webgl came back.

**Still open (pre-existing, not changed here):** a terminal that becomes active fits in that same
effect *before* the GPU effect attaches webgl, so its first size is DOM-based, and the resize
observer's debounced fit can follow with the webgl-based one — two sizes for one switch. Nothing
visible has been traced to it yet.

### 尺寸那一條為什麼不能用「記住上次的值」解決

第一版的方案是「session 持有最後已知尺寸並落盤，沒有終端掛載時就用它」。**那正是
`terminal-sessions` 明文禁止的事**：

> 一個從未被真實量測過的值會讓 agent 以錯誤的寬度輸出，而那些輸出一旦印出就**永久留在終端
> 歷史裡**，其後把尺寸改回來也救不回。

正解是不要製造「沒有版面盒子」的情況 —— 當前 session 的終端**保有盒子、只是不可見**。

### 這條的驗收極容易假綠

`probe-agent-view` 的「重建後直接進對話 view，pty 的 cols 不是 80」曾經在**上一條斷言是紅的**
（session 其實是在終端 view 下醒來的）情況下**通過** —— 終端 view 之下終端本來就掛載得好好的，
量到正確寬度理所當然。**那條斷言通過了，但它證明的不是它自稱在證明的事。**

抓到它的不是重跑，是「重建後回到上次的 view」那條先紅了，把人引過去查。
**一條斷言的前提若由另一條斷言擔保，那另一條就是它的一部分。**

### 週期性工作（游標閃爍計時器）那五條 scenario 沒有 probe 載體

複驗 `terminal-sessions` 的既有覆蓋時查到的：`probe-terminal.mjs` 全檔 `blink` 出現 **0 次**，
那五條的唯一載體是 `xterm-blink-release.test.mjs` 的**原始碼代理判準**，而該 spec 自己已寫明
它「擋得住依賴被退回，擋不住行為本身」。**這是既有缺口，記在這裡以免下一個人以為它有覆蓋。**

---

## Hibernation (`session-hibernation`)

A running session can go back to dormant, by hand or after an idle threshold. Three things the change
learned that are not visible from the code:

### Hibernation is a per-session `dispose`, not a `kill`

`kill()` is the "session ends" path: its exit reason (`killed`) makes the IPC layer drop the session from
`sessions.json`, and it ends the handoff drop point and clears agent status and events. Hibernation
must do none of that — the session has to come back exactly as a restored one does. It has its own exit
reason (`hibernated`) that, unlike `disposed`, **is** forwarded to the renderer (which keeps the session
and shows it dormant). Routing hibernation through `kill()` with a flag is the shape where the next edit
to `kill()` silently applies to it.

The reverse also needed fixing: `kill()` returns early for a session without a pty, so closing a
**dormant** session never ended its drop point. Restored sessions always leaked this way; hibernation made
it routine. `kill()` now reports whether it had a pty and the IPC handler does the cleanup otherwise.

### "Hibernated ≡ restored" needs three things restore never needed

The view is remounted on hibernation (a generation in its React key), so it takes the restore path. That
only works if:

- the snapshot taken at hibernation goes into the renderer's replay map — **the startup restore was its
  only writer**, so a session created in this run remounted blank, and a restored one replayed its startup
  history instead of the hibernation screen;
- output from the dying pty is dropped (marked per pty, so the pty a later wake creates is unaffected) —
  otherwise it lands in the dormant view ahead of the resumed conversation;
- the renderer's `waking` set forgets the session — it never removed a successful wake, which was correct
  only while a session could not become dormant twice in one run.

### Is a shell idle? Children, and the binary, not the foreground group

Measured with an interactive `zsh -i` in a pty:

| shell state | `tpgid` (stat field 8) | children of the shell |
|---|---|---|
| at the prompt | = shell pid | none |
| `sleep 30` in the foreground | = the job's pgid | `sleep`, plus a transient `preexec` hook process |
| `sleep 30 &` | = shell pid | `sleep` |

`tpgid` misses background jobs; every job, foreground or background, is a child, so the test is
"no children" (`/proc/<pid>/task/<pid>/children`). Transient hook children only fail one tick. After
`exec vim` the pid is the editor — foreground and childless — so the process must still be the shell it
was spawned as. Compare **file identity** (`dev`, `ino` of `realpath($SHELL)` at spawn vs
`stat('/proc/<pid>/exe')`), not the link's text: an upgraded shell binary makes the link read
`… (deleted)`, while `stat` still reaches the old inode. And not by reading `/proc/<pid>/exe` at spawn —
node-pty returns the pid right after `fork`, when it may still be Electron.

### pty input is not activity

The idle clock counts display changes, shell output and agent wait-state changes — not the pty input
stream. xterm sends its own replies (focus reports, answers to terminal queries) through the same path, so
a session that queries its terminal would never become idle. User input can only reach a displayed session
anyway, and the displayed session is exempt.

### The wait state must be current for sessions nobody watches

It is only evaluated while something subscribes. Without the tracker's always-on subscription, a session
watched until it was waiting, then left and given work, reads a stale `ready` and is hibernated mid-work.
Consequence: events are now always drained, so a transcript relocation could be consumed with no view
open — `agent-wait` keeps the last reported `transcriptPath` and the conversation view starts from it.

## Theme and zoom (`ui-appearance`)

Four measured facts behind the theme and the interface zoom (Electron 43.5.0). Each fails silently when forgotten.

- **The zoom has to be applied on `did-navigate`.** That is early enough for the page's first script to run at the
  stored zoom; on `dom-ready` or `did-finish-load` the first script sees the old one, and the terminal's first fit
  happens at the wrong size, so the pty gets one extra resize. `src/main/appearance.ts` (`followZoom`).
- **Chromium remembers a zoom per page, keyed by the full URL** (`per_host_zoom_levels` in the profile's
  `Preferences`). Unpackaged, the URL is stable, so "the zoom survives a restart" is green even when main never
  applies the preference; packaged, the AppImage mounts at a random path, so the memory never matches and each
  start would be 100%. The stored preference is applied on every navigation, so neither decides. A probe that
  checks a restart must make the two disagree (`probe-workspace-appearance.mjs`: Chromium records 150%, the file
  says 125%).
- **xterm's wheel handlers ignore `defaultPrevented`.** On the alternate screen it turns a wheel into arrow keys for
  the pty, and with mouse tracking on it reports the wheel; only the viewport's own scroll checks the flag. The
  `Ctrl`-wheel zoom is therefore a window capture listener that **stops propagation** (`KeyboardNavigation.tsx`);
  `preventDefault` alone leaks the wheel to the program. The same stop keeps it from Graph's d3-zoom.
- **GTK draws Linux's native dialogs and ignores `nativeTheme.themeSource`**: the close question looks the same
  under Light and Dark (pixel-identical screenshots). The website states this limit.

Two smaller ones: wheel `deltaY` is in CSS pixels, so it shrinks with the zoom (a notch of -120 arrives as -80 at
150%) and has to be converted to device pixels before deciding what a notch is; and xterm 6 paints its background
on `.xterm-scrollable-element`, not on `.xterm-viewport` (which reads black) — a probe reading the terminal's
color must read the former.
