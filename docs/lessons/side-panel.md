# OpenSpec 側欄與 `@spekjs`

元件重用的判準、`@spekjs/core` 的簽名與語意陷阱、worktree 聚合、聚合圖節點識別碼、反向導覽、側欄的資料流與座標、狀態橋接、續寫入口。

> 這份文件是 `CLAUDE.md` 的延伸。**它與 CLAUDE.md 同一個定位：**
> 幾乎每一條都是「不知道就會踩、而且失敗是靜默的」的實測結論。
> 觸發條件（什麼時候該讀它）寫在 CLAUDE.md 的「踩雷指南」。

## 重用的判準是「它綁死了版面嗎」

完整論證見 `docs/PRD.md` §9.2（該節已依 Phase 5 的實作結論改寫）。一句話：**側欄自刻**（spek 的
頁面是為全寬瀏覽器設計的，不是同一個東西），**`SpecGraph` / `ChangeTimeline` 抽進 `@spekjs/ui`**
（它們吃資料、吐 SVG，對宿主零認知）。判斷「該不該重用」要問的是「**它綁死了版面嗎**」，不是
「它在 spek 長什麼樣」—— 我一度自刻了一個二分圖取代 force graph，被判定為「四不像」。

日常會踩到的兩條：

- **套件擁有自己的顏色變數名（`--spek-*`），絕不讀宿主的 token。** spek web 叫
  `--color-text-primary`，我們叫 `--color-ink` —— 名字對不上時圖會**畫得出來但完全沒有顏色**。
  換膚＝在 `index.css` 覆寫它們（`@spekjs/ui` 1.3 起是 **9 個**）。**React 必須是 peer 依賴**
  （兩份實例會讓 hooks 直接爆炸）。
  - **契約會變長，而漏接一個是靜默的。** 套件為每個變數都備了深色預設值 —— 漏接的那一個不會
    消失，只會偷偷改用套件的顏色。1.3 新增 `--spek-node-active`（Graph 上進行中的 change 節點）
    時正是如此，而當時 `probe:openspec` 只驗 `--spek-accent` 一個值：**我們的 `--color-accent`
    與套件預設同為 `#f59e0b`，那條斷言連整段覆寫消失都察覺不到。**
  - 名單的完整性現由 **`scripts/spek-theme-contract.test.mjs`** 守著（`npm test`，比對套件
    `styles.css` 宣告的全集 ⊆ `index.css` 的宣告）—— **套件下次再加變數就會變紅**，不必有人
    記得回來看那段註解。probe 那條則改驗有鑑別力的 `--spek-node-active`（我們 `#34d399`
    vs 套件 `#22c55e`），驗的是執行期真的解析成我們的值，與名單守衛不重複。
- **d3 把顏色寫進 SVG 屬性**（命令式），不能用 `var()` —— 宿主換膚時圖必須重畫。套件**不去偵測**
  主題（監看 `data-theme` 是在猜宿主的實作），由宿主換一個 `themeKey` 明說「該重畫了」。

## Graph ≠ Timeline

**它們是兩個不同的功能。** Graph 是 spec ↔ change 的**關聯結構**（無時間概念）；Timeline 是 change
的**生命週期**（Gantt，有日期軸）。Timeline 的最小可用寬度是 **920px**，而側欄平常遠窄於此。
They were a full-window overlay until `maximize-panel-and-confirm-close`; now they are views of the
OpenSpec identity that are **only shown while the side panel is maximized** (choosing one maximizes
it). Their state (`viz`) lives in `MainStage`, above `OpenSpecPanel` — that panel is remounted with
`key={folder.id}` on every source change, and the identities mount exclusively, so state kept inside
it would vanish on a repo switch. While one is shown, the panel's own scroll container stays mounted
and **hidden** (a hidden scroller keeps its `scrollTop`; an outer scroller whose content is swapped
resets to 0), so restoring returns the reader exactly where they were.

## `@spekjs/core` 的簽名與語意陷阱（全部實測）

- **`readSpec` / `readChange` 找不到目標時回 `null`，不拋錯**；而 **`readSpecAtChange` /
  `buildGraphData` / `findRelatedChanges` 是同步函式**（會阻塞主行程做磁碟 IO）。危險的是把 `null`
  當成成功值傳下去。
- **`SpecInfo.path` 是絕對路徑。** 直接送給 renderer 會**破壞邊界語彙**。主行程必須翻成
  folder-relative，翻不出來就回 `null` —— 側欄少一個「跳到檔案」的入口，好過洩漏一個絕對路徑。
- **`listChangeMarkdownFiles(repo, slug)` 不是它聽起來的意思** —— 實測回的是 repo 根目錄的
  `["CLAUDE.md", "README.md"]`。改以 OpenSpec 的目錄慣例推導候選路徑，再 `stat` 確認。
- **`GraphNode.label` 對 change 是 humanize 過的描述（`solo change`），不是 slug（`solo-change`）。**
  identity 一律從 `node.id` 取。在 d3 的圖上定位節點要讀 DOM 上的 `__data__.id`，不要讀文字。
- **`ChangeDetail.source` 是一個宣告了但從不被填的欄位**（core 沒有聚合版的 `readChange`）。
  要來源就**從掃描結果取**（`ChangeInfo` 本來就帶著它）。
- **`ChangeInfo.createdDate` 只來自每個 change 的 `.openspec.yaml`（`created:` key）。** 沒有它，
  change 就**放不上 Timeline**。造 fixture 時很容易漏 —— `openspec/config.yaml` 是 repo 層的，無關。
- **`SpecInfo.historyCount` 恆等於 `findRelatedChanges()` 的長度**（實測吻合），所以 Specs 清單的
  「N changes」是零成本的。
- **`schemaOrder` 的 CLI 快取 key 是 `repoRoot::schema`，不跨 worktree。** 影響比直覺小：它發生在
  `readChange`（開啟某個 change），**不在掃描路徑上**。**不在本 app 疊一層自己的快取** —— spek 用
  同一份 core，要改該在 upstream 改。
  - **那個快取連 `null` 一起存，TTL 同為 30 秒**（回報於 spek #46）。於是 app 啟動早期一次暫時性的
    失敗（PATH 還沒補好、逾時），會讓**同一個 repo 在接下來半分鐘持續拿到 `null`** —— 而 consumer
    分不出「查過了、確實沒有」與「查詢失敗了」。**這使「權威順序有沒有被取用」在端對端驗收中不可靠**：
    實測同一份程式碼、同一輪 `probe:openspec`，**build 模式紅而 dev 模式綠**，差別只在各自的 app
    啟動時序落在快取窗口的哪一邊。相關的 scenario 因此由單元測試承擔（`schema-order.test.ts`），
    探針只驗 archived 那條 —— **core 對 archived 根本不查 CLI，不經過快取，所以它是穩定的**。
- **artifact 的排序規則不在本 repo。** `sortArtifacts(artifacts, 'schema', schemaOrder)`
  （`@spekjs/core/artifact-order`，node-free subpath）就是那條規則：權威順序可用照它、不可用退回
  敘事順序、只涵蓋部分時未涵蓋者接在其後。**不要自己用 `DEFAULT_ORDER` / `defaultRank` 排** ——
  core 1.6.0 上移該函式、1.7.0 再泛型化（spek #45，泛型讓它吃得下我們的 `ChangeArtifactView` 並
  原樣交回、`relPath` 不消失），兩次都是本 repo 撞到後回報促成的。
  - **每一個 archived change 都走退路** —— core 只對 active 查 CLI。側欄的重要用途正是讀
    `archive/`，所以退路的正確性決定了那半的閱讀體驗，不是邊角。
- **`TaskItem.text` 是 markdown，而且可能有多行**（core **1.4.0** 起把作者寫在項目底下的續行折了
  進來，各減去 `- ` 的 CommonMark content offset）。實測本 repo 自己的 `tasks.md`：**40 條裡 29 條
  是多行**。當純文字畫（`<span>{task.text}</span>`）的話 HTML 會把換行摺成一個空格，子項與縮排一起
  消失 —— 側欄那塊主要閱讀內容會糊成一團。
  - **它必須走 `MarkdownView`（`dense`），不可以在 `TaskList` 自己起一個 `react-markdown`。**
    `task.text` 與 proposal／design 同源，是使用者 repo 裡的**不受信任內容**，而那個元件的安全性是
    「一組沒有被加上／覆寫的預設值」（`rehype-raw`、`urlTransform`、連結交給主行程）——
    **第二個呼叫點就是第二個必須永遠記得維持它們的地方，而漏掉不會有任何紅燈**。
  - **不要改成保留每一個換行（`whitespace-pre-wrap`）**：續行的斷行位置是原始檔案的排版寬度，不是
    內容的語意。逐字保留它，會在 620px 的側欄裡產生一堆與內容無關的短行。哪些換行有意義由 markdown
    的規則決定 —— 那正是 core 做那個 dedent 的目的。
  - **probe 取 task 的選擇器必須是直接子代鏈**（`section[aria-label="Tasks"] > div > ul > li`）。
    子項渲染出來也是 `<li>`，後代選擇器會把它們一起選中 —— 失效的樣子是「有幾條 task」對不上，
    看起來像 flaky，不像選錯層。

### 已完成 task 的淡化：**繼承會被子元素自己的顏色打敗**

淡化（`text-ink-faint line-through`）掛在 `<li>` 上，靠**繼承**傳給內文。刪除線沒事 ——
`text-decoration` 是**傳播**給後代的；但顏色是**繼承**的，而一個自己宣告了顏色的元素會贏過繼承。
於是一條已被劃掉的 task 仍夾著數段最亮的前景色，而「已完成的東西比還沒做的更醒目」正好偽裝成
使用者在掃視的那個訊號。

- **那條既有的 scenario（「多行項目仍可區分完成狀態…涵蓋該項目的整段文字」）措辭是對的，
  載體卻只驗到一半** —— 它讀 `<li>` 自己的 `textDecorationLine`，而刪除線本來就涵蓋整段。
  **顏色沒有涵蓋，而沒有任何東西會紅。**
- **修正要下在呼叫端，不是 `MarkdownView`。** 拿掉 `strong` 的 `text-ink` 會改到**散文**
  （非 `dense` 的容器是 `text-ink-dim`，那裡的層級差是承重的），**而散文的一般 `strong`
  沒有任何載體**（`probe-openspec.mjs` 只驗 BDD 關鍵字與內文不同色）。
  順帶更正一個直覺：它**不會**改到 `ConversationView` —— 那條祖先鏈一層都沒設顏色，
  繼承到的就是 `body` 的 `--color-ink`，`strong` 的 `text-ink` 在那裡與繼承值同值。
- **涵蓋範圍要用通用選擇器，不要列舉。** `.task-done .markdown * { color: inherit }`。
  列舉 `strong, a` 是白名單 —— `index.css` 裡自帶顏色的還有 `.markdown h1..h4`、
  `.markdown blockquote`、`.markdown th`，**而那個 change 的 design 第一版列舉時就漏了這三條**。
- **勝負來自 cascade layer，不是 specificity（實測）。** `.text-ink` 產在 `@layer utilities`
  之內，`index.css` 的自訂規則在任何 layer 之外 —— **unlayered 無條件贏過 layer 內的宣告**。
  把同一條規則包進 `@layer components`，實測全部復原。**因此：把 `index.css` 收進 `@layer`、
  或把這條改寫成 Tailwind v4 的 `@utility`，它會靜默失效。**
- **作用域是文字，不含完成標記。** `TaskMark` 是 `<li>` 的直接子節點、不在 `.markdown` 之內，
  它承載的是狀態本身 —— 雛型明文豁免它（`workspace-mockup.html:374`）。
  把規則寫成 `.task-done *` 會把綠勾勾也弄暗。
- **對比度是一個知情的缺口。** 已完成 task 的文字落在 **3.06:1**（`--color-ink-faint` #5b6675
  對 `--color-panel` #14181d），低於 WCAG 2 AA 的 4.5:1，也低於上游 spek 判定不可接受而 revert
  的 3.24:1 —— 上游另有明文下限（`theme-toggle/spec.md:58`）與一條要求已完成 task 的連結／
  行內 code 仍須過那個下限的 scenario，**本 repo 的方向與它相反**。
  提高到 `--color-ink-dim`（6.95:1、過 AA、接近 spek 實際的 6.08–6.41:1）的方案經渲染比對後
  被否決：淡化不夠。**spekterm 目前沒有任何對比度守衛**，這是裁決不是疏漏；
  完整論證見 `task-completion-dimming` 的 design D4。

## worktree 聚合

**涵蓋範圍、去重、graph 節點命名全部委由 core**（upstream #17／#23）。宿主端只做四件事：來源 DTO
（丟棄絕對路徑，換成識別碼＋分支）、三個讀取根、兩層 watcher、Timeline 分組的適配。

- **「worktree ≤ 1 時 core 靜默退回非聚合」是最大的假綠來源。** `scanOpenSpecAggregated` 在
  `aggregate: false` **或工作目錄只有一個**時，回傳結果等同 `scanOpenSpec`。這讓回歸風險極低 ——
  但也意味著**驗收的 fixture 若 `git worktree add` 失敗，每一條斷言仍會通過**。
- **讀取根有三個，不是一個**（core 的聚合是 `specs: main.scan.specs` —— spec 一律取自主工作目錄）：

  | 讀什麼 | 根 |
  |---|---|
  | change 的內容 / 某個 change 當下的 spec 版本 | **該 change 自己的來源工作目錄** |
  | spec 的內容 | **主工作目錄**（不是 folder 自己！） |
  | relPath 的翻譯基準 | **folder**（翻不出來就 `null`） |

  沿用單一根的話兩種情形會壞：folder 是 **linked worktree** 時只存在於主工作目錄的 spec **列得出來
  卻打不開**；folder 是 repo 的**子目錄**時**每一個** spec 都打不開。
- **`isMain` 與 `isFolderRoot` 不可互代。** `listWorkspaces` 從一個 linked worktree 呼叫時，`isMain`
  掛在**該 repo 的主工作目錄**上。要問的是「**agent 站的地方，就是 change 在的地方嗎**」＝
  `source.path === folder.path`。DTO 因此帶兩個布林：`isMain`（來源的**性質**，呈現用）與
  `isFolderRoot`（來源與**這個 folder** 的關係，能力判定用）。folder 本身是 linked worktree 時兩者
  相反。
- **gitdir 要多解一層 `commondir`。** worktree 清單住在 **common dir** 底下的 `worktrees/`，而
  `.git` 檔案只指到 `<main>/.git/worktrees/<name>` —— **那底下永遠不會有 `worktrees/`**。
  少了 `resolveCommonDir()`，watcher 會 attach 到一個永不存在的路徑，而 chokidar **不報錯、也不發
  事件**。
- **監看工作目錄清單本身是承重的，不是加保險** —— worktree 是「先建立目錄、後寫入 change」，只監看
  既有工作目錄的 `openspec/` 時，新建 worktree 的第一次寫入**沒有任何 watcher 在場**。這與「先訂閱、
  再掃描」直接打架，解法是分兩層。基礎層要 `depth: 0` 且只理會 `addDir`／`unlinkDir`：實測在
  worktree 裡跑一次 `git commit` 會產生 3 個檔案事件，不收窄的話每次 commit 都重跑一次聚合掃描
  （約 175ms）。
- **The contents of archived changes are not watched** (`openspec-watch-skip-archive`). They only accumulate, and
  watching them cost one descriptor per file per worktree on macOS (a few large repositories with 28 worktrees
  reached about 28,000 and the main process then failed to spawn `git`). `changes/archive` itself is watched at
  depth 0 by a watcher that exists only while the directory does, because **a chokidar watcher created on a missing
  path** reports the directory appearing and nothing after, and closing one around that moment left a native watch
  open (design D2 of that change). The tree watcher on a worktree's missing `openspec/` has that limit too (older). An edit inside an archived change is seen only at the next change seen.
- **`isWithin` 是純字面比較**，而這裡第一次拿兩個獨立來源的絕對路徑相比（`workspace.json` vs
  `git worktree list`）。**兩端目前都是 realpath**，所以比得起來。**若 workspace 的路徑正規化改變，
  每一個 change 的「跳到檔案」會同時靜默消失。**
- **連帶一個已接受的行為切換**：folder 是 repo 的子目錄時，該 repo 只要有 ≥2 個工作目錄，整個 repo
  的 spec 與 change 就會突然出現在側欄（`listWorkspaces` 是對 repo 作答，不是對子目錄）。

## 聚合圖的節點識別碼

聚合關係圖的 change 節點 id 是 `change:<worktreeKey>:<slug>`。**我們送出的圖必須先還原識別碼、
再剝掉來源 —— 順序是承重的**（判斷「那個 key 存不存在」靠的正是即將被剝掉的 `source`）。

只做剝除會送出一個**不自洽**的節點，而**兩個消費端都不報錯**：`SpecGraph` 把整串當成 slug 交出去
⇒ **錨定到一個不存在的 change，還會寫進落盤**；`changeTopicsMap` 查表落空 ⇒ **Timeline 的分組全部
掉到「無 topic」**。

- **`changeNodeSlug` 回傳的是 slug，不是識別碼** —— 前綴要自己補，且**只能對 `type === 'change'`
  的節點施加**（否則 `spec:auth` 會變成 `change:spec:auth`）。**直接拿回傳值當 id（裸 slug）是最
  危險的寫法**：兩個消費端對它照樣運作，只有「識別碼恰為 `change:<slug>`」這條斷言擋得住。
- **邊的兩端也要換。** 而 `GraphEdge.source` 是**端點**、`GraphNode.source` 是 **worktree 來源** ——
  兩個 `source` 在同一段程式碼裡，極容易看混。只換節點不換邊，症狀與完全沒換相同。
- **`@spekjs/ui` 內部對聚合 id 的處理不一致**：`SpecGraph` **在 `node.source` 存在時**才剝掉 key，
  `buildLanes` / `changeTopicsMap` 不剝。**spekterm 是唯一刻意剝掉 `source` 的宿主**，於是那條
  guard 對我們恰好是假的。**抄別人的行為表時要連 guard 一起抄。**
- **邊指向一個不存在的 spec 節點是合法狀態，不是 bug**（upstream 已正確駁回）。spec 節點來自**已
  納入 specs 的 capability**，而一個 change 的 delta 可以提議一個**尚未納入**的 topic —— 那正表達
  「這個 change 提議一個新 capability」。與聚合無關。
- **產生格式的地方與解析格式的地方應當同居。** 解析原本住在 `@spekjs/ui`，正是 upstream #25 的
  溫床（core 開始加 key，ui 的解析沒跟上，**沒有任何東西會紅**）。已回報並採納：現在是
  **`@spekjs/core/graph-node-id`**（node-free subpath）—— **於是主行程 import 得到它**
  （`@spekjs/ui` 的入口會拉進 JSX／d3／React，Node 環境碰不得）。
  > **判斷「該不該回報 upstream」的一個訊號：你正要手寫第二份它剛抽出來防止重寫的東西。**

## 反向導覽與工作目錄清單

判準是「**以工作目錄根由長至短逐一嘗試**，剝除該根之後首段為 `openspec` 且其後符合已知結構者即
命中」。

- **folder 自身必須恆入清單（以空字串），不經 `toRelPath`、不取決於 git 列舉是否成功。**
  三條路都會靜默把它弄丟：`toRelPath(root, root)` 回 **`null`**；非 git 目錄的 `listWorktrees` 回
  **空陣列**；folder 是 repo **子目錄**時那筆指向 repo 根而落在邊界外。
  **清單裡不以 `null` 佔位** —— 空字串是 folder 自身的合法值，兩者會在消費端糾纏。
- **`toRelPath` 對 folder 自身回 `null`，所以「合成 + 翻譯其餘」會產生兩筆。** 照抄那個結構寫新
  API，**每一個 folder 即其 repo 主工作目錄的普通 repo**（最常見的情形）都會得到兩筆，而後者標著
  「位於此 folder 之外、無法瀏覽」—— 選擇器於是在每個 git repo 都冒出來。**正解是「合併」而非
  「附加」**：列舉中 `path === root` 的那一筆**就是**代表 folder 自身的那一筆。以 `self` / `others`
  的**互斥分割**表達，讓不變式由結構保證，而不是靠事後去重。
- **spec 一律來自主工作目錄，所以它的入口要標示來源。** worktree 裡的 spec 檔案跳過去呈現的是
  主工作目錄那一份，而往返會把使用者送到**另一個檔案**。**仍然給入口**（反向導覽的目標是 **topic**
  這個實體，不給只會製造另一種不對稱），**但必須標示**，且只在該 repo 有**多於一個**工作目錄時標
  （單一工作目錄時沒有歧義，標示只是噪音）。
  > **同一個決定上，頻率假設連錯兩次，方向還相反。** 第一版裁決「不給入口」（把罕見當常態）；
  > 翻轉之後又寫「只有跑過 `/opsx:sync` 才會分歧」（把常態當罕見）。實際上工作流要求 archive 前在
  > worktree 裡 backfill main spec —— **分歧是每個 change 出貨前的常態終局**，而那正是使用者最常
  > 盯著側欄的時刻。**該動的是代價的處理，不是裁決本身。**

## Files 的工作目錄

- **權威恆為完整的 folder-relative 路徑，只有「呈現給人看的那一段」剝前綴。** 回報是三件事免費成立：
  未存變更跨工作目錄切換自然存活（鍵沒變）、反向導覽的判定一行不用改、watch 不受影響。
  - **`title` 必須留在完整座標系** —— 它同時是 6 個 probe 助手的選擇器。剝掉它，那些助手**選不到
    元素而回 `false`**，導航靜默停住，其後的斷言驗的是上一個狀態。麵包屑因此 `title={完整路徑}` 而
    顯示剝前綴 —— **兩者要成對驗**，只驗一邊的話「兩邊都不剝」或「兩邊都剝」都會通過。
- **樹根解析必須在父層，因為它同時是 key。** 在 `FilesPanel` 內解析的話，樹會先以 folder 根建起來、
  清單抵達後再整棵換掉，而 key 沒變、初始狀態也不會重設。連帶：`useFileTree` 的**根狀態鍵是
  `rootPrefix` 而非 `ROOT_PATH`** —— `rootLoading` / `rootError` 漏改，工作目錄根的「載入中…」與根層
  錯誤訊息會**靜默地永遠不出現**。
- **「使用者主動切換」四個字是規範性的。** 切換工作目錄要關閉開啟中的檔案，但**跨身分導覽也會切換
  工作目錄**，而它緊接著就要開一個檔案。兩者若共用觸發點會變成「開了又關」或「關了又開」。
  **而 bug 的方向不對稱**：關檔那條 scenario 兩種順序都會通過，只有跨身分導覽那條會時綠時紅 ——
  紅燈會指向錯的地方。觸發點因此是**選擇器的選取事件**。
- **`fs.*` 的定址一行未改** —— 可選的工作目錄一律在 folder 邊界內，切根只是換一個路徑前綴。

## 側欄的資料流與座標

- **重取時不可回到 loading。** `openspec/` 一有變更就重新取數，但**保留舊資料** —— agent 每存一次檔
  就閃一次「載入中…」，側欄會變成一塊閃爍的東西，而使用者正在讀它。`loading` 只在「還沒有任何
  資料」時為真。**反過來，key 變了（切 folder、換 change）就必須把資料清掉** —— 沿用上一份的話會有
  一瞬間顯示**上一個 folder 的 change**，那比 loading 更糟，因為它看起來像是真的。
- **側欄座標（來源 repo／工作目錄／錨定的 change）是 per-folder 的，落盤於 `panel.json`。**
  刻意**不與 folder 清單同居** —— `parseWorkspace` 是 all-or-nothing 且它損毀的代價是「失去所有
  repo」，而錨定一次 change 就要重寫一次那份清單。
  - **鍵刻意措辭為「rail 項目的識別碼」**（今日等於 folder id）—— **issue #5**（rail 把 worktree
    列為一級項目，尚未做）到來時是**擴充鍵空間**而非重做。而 per-folder 的模型順帶回答了 #5 自陳
    未解的那個問題：**rail 選中 worktree ＝ 設定工作目錄維度，不是 repo 維度** ⇒ OpenSpec 維持
    聚合、Files 以該 worktree 為根。同理 Files 的工作目錄欄位命名為**側欄來源的維度**而非 Files
    專屬，#5 到來時是擴充消費者。
- **切換來源時 `anchoredChange` 必須重置** —— slug 隸屬於某個 repo，沿用舊 slug 會對著一個在新 repo
  不存在的 change 顯示空狀態，**看起來像壞掉**。「一個 (repo, change)」在資料上是「來源 + 隸屬於它
  的錨定」，不是一個獨立的複合鍵。
- **「一堵拿不到 pid 的牆」擋住了「側欄自動跟隨 agent 實際在動的 repo」這條路。** Linux 的 inotify
  **不回報 pid**，fanotify 需 `CAP_SYS_ADMIN`。於是「哪個 session 改了哪個 repo」在核心層面就拿不到。
  被這堵牆逼一下之後，正確的框架是「把側欄的來源與 rail focus 解耦」—— 不需要偵測、不需要歸因。
  > **這條擋住未來想「加點自動化」的衝動**：那條路沒有可靠的入口，除非願意讀 claude 的 transcript，
  > 而那是把設計綁在 claude 的內部檔案佈局上。
- **「側欄選一個 repo 而非聚合多個」的決定性理由**：Files 的檔案樹是單一 repo 的階層，本就一次只能
  呈現一個來源；若 OpenSpec 聚合而 Files 只能選一個，兩個身分的來源語意會分裂。
- **watcher 的錯誤一律經 `src/main/watcher.ts` 回報，不要在呼叫端另建 watcher。** 那個模組是
  chokidar 的唯一入口（eslint + `scripts/watcher-source.test.mjs` 兩道守衛），錯誤處理與
  `followSymlinks` 都在裡面。此前三個站點各自建構，於是演化出三種姿態 —— 其中
  `openspec-service` 的 `on('error', () => {})` 使「watcher 建不起來」與「檔案沒變」無法區分，
  而 `branch-service` 根本沒掛 handler（Node 對沒有 listener 的 `'error'` 直接 throw ⇒ 主行程
  掛掉 ⇒ 所有 pty 陪葬）。
  > **這裡原本寫著一個錯誤的根因，留作教訓**：舊版說「`inotify` 的 `max_user_instances` 是
  > per-user 的 128，app 每監看一處就吃一個，加夠多 repo 側欄就會安靜地停止更新」。**實測是
  > 錯的** —— libuv 對整個 event loop 只開**一個** instance（主行程實測佔 3 個），每個路徑是
  > 一個 **watch descriptor**，上限是 `max_user_watches`（524288，主行程實測佔 7675）。
  > 真正會撞到的機器是 `max_user_watches` 仍為 8192 預設的那些，見 README 的疑難排解。
  > **一個看起來相關、又容易量到的數字（97/128），不等於規格真正在乎的那個。**

## 與 agent 的狀態橋接（`claude-status-bridge`）

狀態列上「只有 agent 算得出來」的那幾段（模型顯示名、context 用量百分比、花費、rate limit）不是
我們算的 —— spawn 時以 **`--settings`（公開的 CLI 旗標）**注入一個 `statusLine` 命令，把 claude
已經算好的 payload 落盤，主行程監看後推給 renderer。

- **不解析 transcript。** 那裡面**有** model id、effort、token usage、cwd、gitBranch；**沒有**花費、
  rate limit、**context window 大小**。而 `message.model` 的 **`[1m]` 後綴被拿掉了** —— 1M 與 200k
  兩種變體長得一模一樣，**百分比的分母算不出來**。
- **`--settings` 吃 inline JSON 也吃檔案路徑，且是疊加**（只有 `statusLine` 被指定）。
- **注入的命令看得到我們設給 pty 的環境變數** —— 落點因此可以是 per-session 的路徑，同一份設定檔給
  所有 session 共用。
- **payload 內含 `context_window.context_window_size`** —— **於是不需要維護一張「模型 → context
  window」的對照表**。那種表會隨新模型過期，而**它失效的樣子是一個看起來很正常的錯誤百分比**。
- **`rate_limits` 在全新 session 的 payload 中缺席** —— **每個欄位都必須能單獨缺席**。
- **預設啟用**（第一版「預設關閉」的理由被實測推翻）：`⏵⏵ auto mode …` 那條**不是** statusLine，
  兩種情況都在。自訂的 statusline 是額外多出來的一行 —— **接管一個空位，損失為零**。
  **但有一條保險**：使用者已有自訂 statusline、而我們**讀不出**它的命令時，**整個不注入** ——
  注入會讓他失去自己那條，不注入只是少一個他還不知道存在的功能。**兩種失敗的代價不對等，就往代價
  小的那邊倒。**
  > **這推翻了「別綁 claude 的內部佈局」嗎？沒有，而區別是承重的**：那條教訓的情境是「猜錯 → 撞號
  > → session 死掉」，**降級方向是災難性的**；這裡猜錯的下場是狀態列少幾個欄位。而且我們綁的是一個
  > CLI 旗標與它自己的輸出。**同一條紀律不該無差別套用 —— 要問的是「失效時會怎樣」。**

## 續寫入口（`artifact-continuation`）

側欄在 change 尚缺 artifact 時提供入口，觸發即把 **`/opsx:continue <slug>` 送出並執行**於 focused
session 的 pty。

- **送 slash command 而非自然語言**：行為本就是「產生恰好一個然後停」、帶 slug 可省掉反問，
  而且它是 ASCII，**於是「該用中文還是英文」這個沒有好答案的問題根本不存在**。
- **一顆按鈕而非每個缺漏各一顆** —— 續寫流程一次只產生一個且由它自己挑，四顆按鈕會承諾一個它給
  不出的選擇。
- **`null === null` 的誤啟用是這裡最危險的一條。** 全域 session 沒有所屬 folder（`null`），而全域
  項目的側欄來源**預設也是缺席** —— 樸素的 `panelSource === session.folderId` 會讓入口亮起來，然後
  把 change 識別碼送進一個站在家目錄的 agent，它會在**家目錄**建出一個同名的空 change。
  **而一個取決於「今天恰好用 `?.` 還是 `??`」的安全判定，本身就不可接受**，不論它今天倒向哪一邊。
  判定因此抽成純函式並由**對照組**守住。
- **第 4 個條件（來源工作目錄）不能寫成「比對兩個識別碼」**：開在 folder 根的 session **沒有識別
  碼**，而 folder 本身是 linked worktree 時**它自己的 change 帶著識別碼** ⇒ 錯誤地停用一個會成功的
  入口。正確的是兩段式 —— `session 有 key ? origin.key === session.key : origin.isFolderRoot`。
  **舊判準沒有消失，它降級成了新判準的一個分支。**
  > **一般形式：一個條件依賴的「巧合」被打破時，它通常不是變得多餘，而是需要更精確的判準。**
