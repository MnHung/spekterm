# spekterm — Product Requirements Document

> 狀態：整合定案（consolidated draft）
> 更新：2026-09-29（§2 related projects, §10 business model, §13–15; previous version 2026-07-08）
> 這份 PRD 是後續開發的**單一權威來源**，已整合先前散落的規劃文件（roadmap / 競品分析 / handoff 概念與設計）。
> 唯一並存的補充素材是 [`workspace-mockup.html`](./workspace-mockup.html) — 定案互動雛型（OpenSpec × terminal × Handoff），因為它是互動原型、無法併入 markdown。

---

## 目錄

1. [產品概述](#1-產品概述)
2. [問題與市場定位](#2-問題與市場定位)
3. [目標使用者與範圍](#3-目標使用者與範圍)
4. [產品原則](#4-產品原則)
5. [功能總覽](#5-功能總覽)
6. [使用者介面與體驗](#6-使用者介面與體驗)
7. [護城河：跨 agent、磁碟狀態驗證的 Handoff](#7-護城河跨-agent磁碟狀態驗證的-handoff)
8. [系統架構](#8-系統架構)
9. [與既有 spek 的關係](#9-與既有-spek-的關係)
10. [Business model](#10-business-model)
11. [開發路線圖](#11-開發路線圖)
12. [橫切關注點](#12-橫切關注點)
13. [技術風險與緩解](#13-技術風險與緩解)
14. [開放問題](#14-開放問題)
15. [建議的下一步（2026-09-29 改寫）](#15-建議的下一步2026-09-29-改寫)

---

## 1. 產品概述

**spekterm** 是一個**以 agent 為核心的本地開發工作台**——一個獨立的 Electron 桌面 app（以 MIT 授權開源），把多個「一個 repo／資料夾各自一個 `claude` session」的 terminal 包在一個殼裡，並加上一塊**懂 OpenSpec 結構的側欄**，讓使用者不必另外開 IDE 就能一邊駕駛 agent、一邊看著 spec 上下文。

core 邏輯重用開源的 [`@spekjs/core`](https://github.com/spekhq/spek)（MIT）；app 本身同樣以 MIT 開源（2026-09-29 裁決，見 §10）。

**一句話定位（headline）**：spec-driven 的多 agent 開發工作台。

**護城河（moat，非 headline）**：跨異質 agent、以**磁碟狀態驗證**為核心的**結構化工作交接（handoff）**——一級功能、不綁 OpenSpec，任何 repo 都能用；工作對應到 OpenSpec change 時再額外錨定 change 做語意增強。見 §7。

**現況**（2026-09）：Phase 0–5 已封存；Linux AppImage 可用；Phase 7 的本機收件匣、Slack 來件、agent 發起的跨 repo 交接與母子關係已交付。macOS (Apple Silicon, ad-hoc signed dmg) is delivered by `macos-dmg-packaging` (2026-10); Windows 產物未做；Phase 8+ 付費層已裁決不做（§10）。UI 定案雛型見 `workspace-mockup.html`。

---

## 2. 問題與市場定位

### 2.1 要解的問題

開發者同時跑多個 agent session（多 repo、多 worktree）時：
- 視窗與 session 管理散亂，不知道「哪個 agent 在等我」。
- agent 缺乏共享的、可驗證的上下文；工作在 session／agent／人之間交接時只能靠聊天摘要，會失真。
- 現有 IDE 不理解 spec-driven 工作流（OpenSpec 的 change 生命週期），無法把 spec 上下文與終端機並排。

### 2.2 Related projects (snapshot: 2026-09-29)

Running several coding agents side by side is a busy space. The projects below overlap with spekterm in
some way; they are listed so readers can compare approaches, not ranked. Details change quickly — check each
project for its current state.

**Multi-session agent workbenches and terminals**

- [Claude Code Desktop](https://code.claude.com/docs/en/desktop) — Anthropic's own desktop app: parallel
  sessions with per-session worktrees, cross-session messaging, and Remote Control from web and mobile.
- [better-agent-terminal](https://github.com/tony1223/better-agent-terminal) — an open-source (MIT)
  multi-workspace terminal aggregator with Claude Code and Codex integration, remote access, and a mobile app.
- [Nimbalyst](https://github.com/nimbalyst/nimbalyst) — an open-source (MIT) desktop workbench for Claude
  Code, Codex and others, with worktrees and its own plans / specs / tasks.
- [cmux](https://github.com/manaflow-ai/cmux) — a native macOS terminal built for running many agents in
  parallel.
- [Superset](https://github.com/superset-sh/superset), [Conductor](https://conductor.build) — desktop apps
  for running parallel agents across worktrees.
- [GitHub Copilot app](https://github.com/features/copilot), [OpenAI Codex app](https://openai.com/codex) —
  first-party apps from other agent vendors.
- [claude-view](https://github.com/tombelieber/claude-view) — a monitoring dashboard for Claude Code
  sessions.

**Spec-driven development**

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) — the format spekterm's side panel understands.
- [GitHub Spec Kit](https://github.com/github/spec-kit), [Kiro](https://kiro.dev),
  [BMAD](https://github.com/bmad-code-org/BMAD-METHOD) — other spec-driven workflows.
- Smaller OpenSpec viewers and editor extensions exist (for example
  [openspecui](https://github.com/jixoai/openspecui)); spekterm's own sibling viewer is
  [spek](https://github.com/spekhq/spek).

### 2.3 Where spekterm fits

Hosting several agent sessions in one window is now common, including in first-party tools. What spekterm
adds is narrower:

- **A side panel that understands OpenSpec** — the change a session is working on, its artifacts, its tasks,
  and its specs — and follows along as the agent writes to disk.
- **Agent-initiated handoffs with a lifecycle** — an agent hands work to another repository; the child
  session remembers its parent, reports back, and its state is visible on both ends.

Both are features, not a moat, and they are why spekterm is developed as an open-source project rather than
a commercial one (see §10).

---

## 3. 目標使用者與範圍

### 3.1 目標使用者

- 採用 **OpenSpec / spec-driven 工作流**、且同時操作**多個 agent session**（多 repo／多 worktree）的重度開發者。
- ~~首發平台優先補 cmux 的空窗：Windows / Linux 使用者。~~ **2026-09 重評：Linux 空窗已關閉**（Claude Code Desktop、better-agent-terminal、Nimbalyst、Copilot app 皆已上 Linux），平台不再是選擇目標使用者的理由，見 §2.3。

### 3.2 明確不做（防止範圍蔓延）

- 不取代 Claude Code 已有的 diff / task 呈現——刻意不重做。
- 不重做 VS Code Extension / IntelliJ Plugin / Demo / Web 版的唯讀檢視器角色（維持現狀）。
- 不做 API-key 代理；跑真 `claude`，用使用者自己的訂閱。

### 3.3 平台

Electron，目標產出 macOS / Windows / Linux 三平台安裝檔。

---

## 4. 產品原則

1. **OpenSpec 是語意核心**：workspace 的差異化建立在懂 OpenSpec change 生命週期。版面上，OpenSpec 是 side panel 的**預設身分**（跟隨 focused session 的 change），與 Files 同層互斥切換、與中央 terminal 並存；repo 沒有 `openspec/` 時退為 Files——核心不因缺 OpenSpec 就殘廢。（版面以 §6 / mockup 為準。）
2. **狀態變更才算數**（延續 spek 立場）：「agent 說做完不算，磁碟上的狀態變更才算」——這條原則直接決定 handoff 的誠實度設計（讀 diff / checkbox，而非 agent 自述），也是 handoff 不必綁 OpenSpec 的底氣：git diff 每個 repo 都有。
3. **agent 中立**：目前只包 `claude`，但介面與資料模型從一開始就為多 agent（Claude / Codex / Gemini …）設計。
4. **重用而非重造**：`@spekjs/core`（MIT）與 spek 前端元件最大化重用；不重做 Claude Code 已有能力。
5. **信任邊界優先**：fs 寫入、terminal cwd、handoff auto-spawn 都受明確信任邊界約束（同機同人 vs 跨人／外部）。

---

## 5. 功能總覽

| # | 功能 | 說明 | 路線圖 |
|---|---|---|---|
| F1 | 多 folder 工作區 | 加入／移除多個 folder，清單與狀態持久化 | Phase 1 |
| F2 | File Explorer | 多 folder 檔案樹、子目錄 lazy load、chokidar 監控外部變更 | Phase 2 |
| F3 | 檔案檢視／編輯 | 於 side panel 內開檔（markdown 渲染／原始碼切換、其餘 Monaco 語法高亮）；編輯、dirty 狀態（跨換頁與跨 folder 存活）、`Cmd/Ctrl+S` 存檔、完整 CRUD 屬 Phase 3 | Phase 2–3 |
| F4 | 多 session terminal | 底部 dock，`node-pty` 多 session，跑 agent 主場，預設 cwd = 選中 folder | Phase 4 |
| F5 | OpenSpec 側欄 | **本 change**（每個 artifact 一個分頁）＋ **瀏覽**（Specs / Changes 兩棵樹），經 `IpcAdapter` 取自主行程；跟隨 focused session 錨定的 change。Graph 與 Timeline 是放大側欄時的視圖（`Ctrl+Shift+M`），來自 `@spekjs/ui` | Phase 5 ✅ |
| F6 | 交叉導覽 | spec/change ↔ 底層檔案互跳 | Phase 5 |
| F7 | 打包發佈 | electron-builder 三平台安裝檔、主題、持久化 layout | Phase 6 |
| F7b | UI 語言 | 介面文案可切換語言（`en` / `zh-TW`），立即生效且跨重啟保留；首次啟動取自作業系統的偏好語言。**寫給 agent 讀的文字不在地化**（見下） | Phase 6 ✅ |
| F8 | Handoff（本機免費） | 寫 handoff → daemon probe → 同機自動開 session + context 注入 | Phase 7（moat）|
| F9 | Handoff（跨機/跨人/編排，付費） | relay、跨人核准、自動編排 Claude→Codex→Gemini、稽核、遠端核准。**2026-09-29 已裁決不做**：同一人的跨機與手機核准已由官方覆蓋（§10）。**2026-10: same-person phone control is back** as an open-source feature with no relay and no paid tier — remote access and the companion Android app (`mobile-remote-bridge`, §10) | —（付費層不做） |

---

### 5.1 UI 語言的邊界

**受支援語言為 `en` 與 `zh-TW`**，清單本身是資料（`SUPPORTED_LANGUAGES`），日後增加不需要
改變任何機制。語言是使用者偏好的一部分，落盤於 `preferences.json`；**首次啟動**（＝偏好檔
不存在）取自作業系統回報的偏好語言順序，其後一律以使用者的選擇為準 —— 既有使用者**不會**
在升級後被改變語言。

**寫給 agent 讀或執行的文字不在地化，恆為英文**，即使它出現在畫面上：

- 經 `SessionStart` 注入 agent 脈絡的自我介紹
- 交給 agent 的 context 檔中，界線**之外**的抬頭
- **被填入 agent 輸入處而尚未送出的第一則 prompt** —— 使用者確實會讀到它，但它承載 prompt
  injection 的措辭，而**翻譯後的效力沒有任何載體能驗**。使用者需要理解的「這則交接來自誰、
  內容是什麼」由收件匣的介面承擔，那一側在地化。

**已知缺口**：`conversation-report` 的讀後感由 `claude` CLI 產生，其 prompt 是硬編英文的模型
指令，因此中文介面下產出的 claims 仍為英文。

---

## 6. 使用者介面與體驗

> **本章以 [`workspace-mockup.html`](./workspace-mockup.html) 為準**——它是定案的高保真互動雛型（OpenSpec / Files × Handoff）。以下文字描述雛型呈現的版面與行為；若文字與 mockup 有出入，以 mockup 為權威。

### 6.1 目標 Layout

**組織主軸**：workspace 以 **repo 為一級單位、session 為其下子項**（呼應 §2「repo 級，一 repo 一 session、多 worktree 多開」），不是檔案總管優先的 IDE 版面。**terminal（跑真 `claude` 的 pty）是主舞台中央**，OpenSpec／Files 是它右側可切換的副手。

**版面三塊**：`① 活動列 ｜ ② workspace rail（repos→sessions）｜ ③ 主舞台`；主舞台內部再分成 `repo header + session 分頁 + （左 terminal ／右 side panel）`。

```
┌────┬─────────────────┬───────────────────────────────────────────────────┐
│ ▤  │ WORKSPACE       │ project-a   2 sessions · master, feat/term         │
│Ses │ ▾📁 project-a  2│    [◈ OpenSpec│▤ Files]  ⤳ Handoff  + session   ⟩  │ ← repo header
│    │   ● master        ├───────────────────────────────────────────────────│
│⤳ 2 │   ● feat/term 待ack│ ●master[multi-folder-explorer]│●feat/term[…]     │ ← session 分頁
│Han │ ▸📁 acme… ①1│─────────────────────────┬─────────────────────────│
│    │ ▸📁 spek-web    ↩│ ~/git/project-a $ claude │ project-a/changes/       │
│ 🔍 │                 │ > 幫我把 FolderRow…      │   multi-folder-explorer  │
│    │                 │ ⏺ Edit(fs.ts) +24 -2     │[本ch│Specs│Changes│Graph]│
│ ⚙  │                 │ > ▏                      │ Tasks 3/9 ▓▓▓░░░░░░      │
│    │                 │                          │ ☑ …   ☐ …               │
│    │                 │   ← 左：純 terminal       │ SPEC DELTAS  WHEN…THEN… │
│    │ [+ Add folder]  │     (pty 跑 claude)       │  → 右：side panel        │
├────┴─────────────────┴─────────────────────────┴─────────────────────────┤
│ ◐ 4 sessions   workspace                             UTF-8   spek ws 0.1  │ ← 狀態列
└───────────────────────────────────────────────────────────────────────────┘
 ①活動列 ②workspace rail  ③主舞台(repo header + session 分頁 + 左 terminal│右 side panel)
```

主舞台只屬於**當前選中的 repo**。分界（rail｜主舞台、terminal｜side panel）皆可拖動；side panel 可整個收合讓 terminal 佔滿。**活動列為固定寬度，不可拖動**——它是一列固定尺寸的圖示按鈕，加寬不會多顯示任何東西，而一個調不出任何差異的控制項比沒有這個控制項更糟（`dogfood-panel-affordances`）。

### 6.2 各區塊

- **① 活動列**：`Sessions`（工作台，預設）／`Handoffs`（收件匣，帶待處理 badge）／🔍 搜尋（沿用 spek `Cmd+K`）／**📈 對話計量**（`agent-conversation-insights` 與 `insights-qualitative-report`，見「對話計量」一節）／⚙ 設定。
  > **第五個入口是對 `docs/workspace-mockup.html` 的一次明示偏離** —— 雛型只畫了四個。裁決記錄在
  > `workspace-layout` 的 requirement 裡：對話計量的範圍是整個 workspace，不隸屬任何 folder、
  > 也不是側欄座標之下的東西，而活動列正是「不隸屬任何 repo 的全域入口」該在的位置。
  > 已排除的替代方案是塞進 Settings 對話框：**Settings 是放旋鈕的地方，而這是內容。**組織軸是 **Sessions 與 Handoffs**，不是檔案總管——點 `Handoffs` 會把主舞台整個換成 workspace 層級的 Handoff 收件匣（見 §6.4），點 `Sessions` 切回工作台。
- **② workspace rail**：跨 repo 導覽。每個 repo 為一列，可展開露出其下的 session 子列；repo／session 上疊加最急迫的狀態燈與 handoff 標記（incoming badge、`↩ 接棒`、`待 ack`）。底部 `[+ Add folder]`（原生對話框、持久化）。沒有 `openspec/` 的 repo 於此標示（如 mockup 的 spek-web），提示它只能用 Files 身分。
  rail 分為**置頂段**與其餘兩段，之間有一條分界：置頂段**位於捲動容器之外**，因此 repo 一多、
  session 子列一展開時它仍留在視野裡 —— 那正是置頂相對於「把 repo 拖到最上面」的增量價值
  （順序本來就可以自己排）。置頂以圖釘或 folder 的右鍵選單切換，**把 repo 拖過分界**亦然；
  `Shift+↑↓` 移動一格時，分界本身算一格。全域項目恆為置頂段的第一列，其置頂狀態不可取消。
- **③ 主舞台 · repo header**：左邊 repo 身分 + session 聚合資訊；右邊是 `[◈ OpenSpec │ ▤ Files]` segmented switch、`⤳ Handoff`（開 compose）、`+ session`、side panel 收合鈕。
- **③ 主舞台 · session 分頁**：當前 repo 底下每個 session 一個分頁（branch + 狀態燈 + 錨定 change 的 badge）。切分頁 = 切 focused session；OpenSpec side panel 隨 focused session 的 change 更新。
- **③ 主舞台 · 左 terminal**：跑 agent 的主場，`node-pty` 真 pty 跑 `claude`。**terminal 保持純淨**——結尾就是 `claude` 自己的 `>` prompt 行，spek **不另外畫輸入框**。`+ session` 開新 pty（預設 cwd = 當前 repo／worktree）。
- **③ 主舞台 · 右 side panel**：一次只顯示一個身分（OpenSpec 或 Files），見 §6.3。

> 註：本版面刻意**不**把 Monaco 檔案編輯器當主編輯區的一級公民。工作台圍繞「terminal 駕駛 agent + side panel 看 spec／檔案上下文」；深度改檔仍走 agent 或使用者自己的 IDE。Monaco 的角色退為 Files／檔案檢視（F3 編輯能力保留，但不是版面主角）。

### 6.3 Side panel：OpenSpec ↔ Files（同層互斥切換）

OpenSpec 與 Files 是 side panel 的**兩個同層級、互斥的身分**，用 repo header 的 segmented switch 切換，一次只顯示一個，與左側 terminal 並存。

| 身分 | 內容 | 條件 |
|------|------|------|
| `◈ OpenSpec`（預設） | **本 change** 與 **瀏覽** 兩個視圖，資料經 `IpcAdapter` 取自主行程；**跟隨 focused session 錨定的 change**。Graph 與 Timeline 是側欄放大時才呈現的視圖 | 條件式：repo 要有 `openspec/` 才可用；否則此鈕 disabled/dim |
| `▤ Files` | 當前 repo 的檔案樹（子目錄 lazy load、chokidar 監控、git 狀態 tag） | 恆可用 |

- **OpenSpec 是條件式身分**：沒有 `openspec/` 的 repo（如 mockup 的 spek-web），OpenSpec 鈕 disabled，side panel 退為 Files。這正是「spek 以 OpenSpec 為核心，但版面不因缺 OpenSpec 就殘廢」的體現。
  - **啟用條件不含「且有 active change」**（本欄原本這樣寫，`openspec-side-panel` 推翻並回寫）。判定「有沒有 active change」需要一次完整掃描，而 folder 清單是啟動時一次算出來的 —— 那會讓啟動時間隨 folder 數線性成長（`workspace-folders` 規格明文禁止在此判定中掃描）。且沒有 active change 不代表側欄沒東西可看：瀏覽視圖的兩棵樹對一個只有 archived change 的 repo 仍然完全有用。降級的正確層級是**「本 change」視圖呈現空狀態**，而不是停用整個身分。
- **本 change 視圖**：change 的識別與狀態，**每個 artifact 一個分頁**（Proposal │ Design │ Tasks │ Specs，順序依 schema），tasks 進度條**恆常可見、不進分頁**。tasks 依 section 分組；spec deltas 標示 ADDED／MODIFIED 並高亮 BDD 關鍵字。
  - 初版把 tasks 與 spec deltas 攤開、其餘收合成區塊，一路往下堆 —— 使用者的判定是「在找資料的時候不好找」。**並排的分頁讓「找」變成一次點擊，而不是一次搜尋。**
- **瀏覽視圖**：上下堆疊、各自可收合的**兩棵樹** —— Specs（`topic → heading`）與 Changes（`Active / Archived → change`，帶進度）。
  - **藍本是 VSCode extension 的 tree provider，不是 spek web 的 sidebar** —— 後者只是五個扁平的 nav link，內容全在主頁面裡。VSCode 的兩棵樹才是為 ~300px 窄側欄設計的。
- **Graph 與 Timeline 原在全視窗 overlay**（`openspec-side-panel` 的 design D12）；**since `maximize-panel-and-confirm-close` they are views of the side panel, shown only while it is maximized over the main stage** —— the reasoning below is why they need that width：Timeline 的最小可用寬度超過 900px，而側欄上限是 620px。而且它們是「**搞懂全局**」的動作，不是「一邊駕駛 agent 一邊盯著」的動作 —— 沒有與 terminal 並存的需求。兩者**是不同的視覺化**：Graph 是關聯結構（無時間），Timeline 是生命週期（有時間軸）。
- **錨定關係由使用者建立，系統不猜**（design D3）：pty 裡的 agent 不會宣告它在做哪個 change，任何從終端標題／輸出去比對 slug 的推測都會假陽性與假陰性 —— 一個偶爾莫名其妙跳到別的 change 的側欄，比沒有側欄更糟。唯一的自動值是**衍生的預設**：該 folder **恰有一個** active change 時就顯示它（不需要先建 session）。使用者在 Changes 樹點一個 change 即可改變錨定。**Phase 7 的 handoff 會自然填上這個欄位** —— 屆時系統知道 session 在做哪個 change，是因為有人告訴它。
- **交叉導覽**：spec/change ↔ 底層 `.md` 互跳（保留 spek 現有 UX）。

### 6.4 Handoff 相關 UI（Phase 7+）

對齊 mockup 的五個時刻（Handoff 不綁 OpenSpec，見 §7；同機自動接棒／跨人需核准）：

1. **活動列 `Handoffs` 圖示 + badge**：點擊把主舞台換成 workspace 層級的 **Handoff 收件匣 view**；再點 `Sessions` 切回工作台。
2. **Handoff 收件匣 view**：`收件匣／待你 ack／已完成` 三區，每張卡片含狀態 badge、`from→to`、錨定（有 change 顯示 change slug；ad-hoc 顯示「無 change」）、「狀態驗證進度」（讀磁碟，非 agent 自述）、producer、依狀態的動作鈕。
3. **跨人來件通知橫幅**：router probe 到跨人 handoff、等你核准（含核准／檢視／略過）。
4. **workspace rail 標記**：repo 上 incoming handoff badge、session 上 `↩ 接棒`（同機自動接棒開的）、`待 ack`（已交接出去待對方 ack）。
5. **repo header `⤳ Handoff` 鈕 → compose modal**：手動寫 handoff；`To` 選 repo 或人；「錨定 change」在 focused session 有 change 時自動唯讀帶入、ad-hoc 時留空；下方一句提示同機自動接棒／跨人需核准。自動開的 session 於分頁／rail 標示接棒來源。

---

## 7. 護城河：跨 agent、磁碟狀態驗證的 Handoff

> 定位：這是 spekterm 的**護城河層**，不是行銷 headline。headline 維持簡單好懂（「spec-driven 的多 agent 開發工作台」）；handoff 是往下證明 moat 的深水區，也是對「為什麼 cmux 抄不走我」的答案。

> **Handoff 是一級功能，不綁 OpenSpec。** spek 以 OpenSpec 為核心沒錯，但 handoff 的守護價值來自「**磁碟狀態驗證**」——讀 git diff／檔案這種每個 repo 都有的 ground truth，任何 repo（含沒有 `openspec/` 的）都能收送 handoff。OpenSpec change 錨定是**選配的增強層**：當這一棒的工作剛好對應到一個 change 時，額外綁上 change slug、讀 tasks.md 打勾、對齊 spec deltas，讓上下文更濃。沒有 change（ad-hoc、或非 OpenSpec repo）時，handoff 退為「git diff 快照 + 自由文字意圖」，仍然是一級、仍然誠實。mockup 已同時畫出兩種：OpenSpec 錨定的 H1／H3，與 ad-hoc 的 H2。

### 7.1 一句話

在包住多個異質 agent session 的工作台裡，讓工作以「**磁碟狀態驗證**」的結構化交接產物，在不同 session / agent（Claude / Codex / Gemini）/ 時間 / 甚至不同人之間傳遞——每一棒都讀得到「這個工作做到哪、diff 長怎樣、上一棒留了什麼雷」；**當工作對應到 OpenSpec change 時，再額外錨定 change（spec 是什麼、tasks 打到哪）把上下文加濃。**

### 7.2 為什麼守得住

| | 商品化（約半年被抄） | 可守護（抄不走） |
|---|---|---|
| 怎麼產生 | 叫 agent 自己總結 | 從**磁碟 ground truth 推導**：git diff + 檔案狀態 + 「下一步 / 雷點」；有 OpenSpec change 時再疊上 tasks 打勾 + spec deltas |
| 誠實度 | agent 自述（會樂觀、會說謊） | **磁碟驗證**：diff 真的存在、checkbox 真的勾才算 |
| 誰能做 | cmux 用 socket API 週末拼一個 | 需跨 session／跨 agent 的狀態驗證管線 + 主動 router；懂 OpenSpec 結構讓錨定的那一棒又更濃——對手資料模型裡沒這層 |

核心信念：**handoff 不是 agent 的自我總結，是對工作當前真實狀態的結構化快照**（有 OpenSpec change 時，快照再對齊到那個 change）。

> **2026-09-29 現況核對**：右欄兩個條件**都還沒實作**。已交付的交接單是 agent 寫的一段文字（`{target, title, body}`），屬於左欄；原始碼裡也沒有 Codex／Gemini 的路徑。另外 **Gemini CLI 已於 2026-06-18 對個人用戶停止、由 Antigravity CLI 接替**，§7.3 的第三棒要改寫。

### 7.3 殺手級組合

```
Claude   做完 proposal / spec  ──handoff──▶
Codex    接手實作              ──handoff──▶
Gemini   跑 review / 測試
```

每一棒交接的不是聊天摘要，而是綁在同一個 OpenSpec change 上、狀態驗證過的產物。這個故事兩個對手都講不出來。

### 7.4 Handoff 產物內容（schema，初步）

格式須 **agent-agnostic**（markdown + frontmatter）。frontmatter 帶狀態、來源、目標、主題與時間（目標可為人、群組或 repo），並有確認的生命週期；再加上 spek 專屬欄位。分**核心（恆有）**與 **OpenSpec 增強（選配）**兩層：

**核心欄位（每個 handoff 都有，不依賴 OpenSpec）**
- **錨點**：repo / worktree / branch。
- **進度（狀態驗證）**：目前 diff stat、動到哪些檔案——實際讀磁碟。
- **意圖**：這一棒想達成什麼（自由文字）。
- **交棒內容**：下一步、已知雷 / 卡點 / 決策、需人類拍板的問題。
- **產生者**：哪個 agent、哪個 session、何時。

**OpenSpec 增強欄位（僅當這一棒對應到一個 change 時才帶）**
- **change 錨定**：change slug（把上面的錨點連到具體 change）。
- **tasks 進度**：tasks.md 已勾 / 未勾（實際讀檔）。
- **spec 對齊**：觸及哪些 spec deltas（ADDED / MODIFIED），有無未落實的 requirement。

> 狀態部分由 spek 自動從磁碟推導；agent 只補意圖 / 下一步。傾向「自動從 ground truth 推導 + agent 補充意圖」的混合產生模式。ad-hoc（無 change）時，增強欄位整段省略，卡片上顯示「無 change」（見 mockup H2）。

### 7.5 Pipeline

```
session A（repo-A 做完）
  └─ 寫 handoff：to: repo-B、附「狀態驗證過的」進度（有 change 時另錨定 OpenSpec change）
        │
        ▼
spek 背景 router 主動 probe → 比對 to 命中的 repo-B
        │
        ├─ 同使用者 / 同機 ─────────▶ 直接在 repo-B 自動開新 session
        └─ 跨人 / 外部來源 ─▶ 通知 + 等核准 ─▶ 核准後才開
        │
        ▼
新 session 跑目標 agent，把 handoff 當初始 context 注入（每種 agent 注入方式不同）
        │
        ▼
做完回寫「處理紀錄」+ 更新 status → 通知 A 去 ack（open→awaiting-ack→done）
```

### 7.6 已定決策

1. **auto-spawn 安全邊界**：「收到 handoff 就自動跑 agent」≈ 讓來源方在你機器上執行指令，必須有信任邊界。
   - **同使用者 / 同機**：可自動開（頂多一個「已開 session」通知）。
   - **跨人 / 外部來源**：**預設先通知、要人核准才 spawn**。
   - **cascade 護欄**：handoff → session → handoff 的無限接力要有深度上限 / 迴圈偵測（上限與方式 TODO）。
2. **Store 兩層**：
   - **信封（envelope）= 本機 daemon inbox**（`~/.spek/handoffs/`，workspace 範圍）。router 住這，看得到本機所有 repo 的 handoff，`to` 命中就路由。**同機跨 repo 完全本機、零 backend。**
   - **內容（payload）= 磁碟狀態快照（git diff／檔案）為底**；當工作對應到 change 時，再連到 repo 內的 OpenSpec change、不重抄（豐富內容跟著 repo 走 git、天然 spec 錨定）。無 change 時就只有磁碟快照。
   - **跨機 / 跨人 = relay**（spek 自己的中繼）：本機 daemon 把 outbox 同步到 relay，relay 送到別台機 / 別人的 daemon。
   - **不採**「主要存 repo 內用 git 傳」：解不了跨 repo 路由、又會弄髒版控。
3. **Freemium**：本機單人 handoff 免費；跨機 / 跨人 / 自動編排 / 稽核 / 遠端核准付費（見 §10）。**2026-09-29 已裁決不做付費層**（§10）。Phone access for the same person came back in 2026-10, free and direct (`mobile-remote-bridge`).

### 7.7 元件（work breakdown）

1. **Handoff schema** — frontmatter + spek 專屬錨點與磁碟狀態快照（§7.4）。
2. **Store + addressing** — 本機 daemon inbox；repo / workspace 定址 registry（沿用 spek 已管的 workspace repo 清單當起點）。
3. **Producer** — `spek handoff` CLI（agent 用 bash 就能叫）或檔案慣例，**不是 SDK**；狀態由 spek 自動推導。
4. **Router / probe daemon** — Electron 主行程背景 watcher：監看 inbox、比對 `to`、依信任邊界路由、repo 沒開時先進 pending。
5. **Spawner + context 注入器** — 開新 pty session + 把 handoff 餵進目標 agent；每種 agent 注入方式不同，需抽象層。
6. **Consumer / ack** — 回寫處理紀錄、狀態流轉、通知發送方 ack。
7. **Relay（付費）** — 跨機 / 跨人中繼 + 身分 / Team registry + 存取控制。（已裁決不做，§10。）
8. **UI** — 見 §6.4。

---

## 8. 系統架構

### 8.1 為什麼選 Electron

| 需求 | Electron 的優勢 |
|------|----------------|
| Terminal（PTY） | 主行程是 Node，可直接 `node-pty` spawn shell，透過 IPC 串流，不需另架 WebSocket server |
| 讀寫任意檔案 | 桌面 app 信任模型本就允許，不需處理沙盒 / CORS / localhost 綁定 |
| 重用 `@spekjs/core` | core 是純 Node.js，主行程可直接 import，無需 HTTP 中介 |
| 重用 spek 前端 | renderer 是標準 React + Vite，沿用 spek 的 React 19 / Tailwind v4 |

### 8.2 三層結構

```
spekterm
├── main/        # Electron 主行程（Node）
│   ├── window.ts          # 視窗 / 選單 / 生命週期
│   ├── ipc/               # IPC handlers
│   │   ├── fs.ts          # 讀目錄 / 讀檔 / 寫檔 / 監看（重用 @spekjs/core）
│   │   ├── terminal.ts    # node-pty 管理（多 session）
│   │   └── openspec.ts    # 呼叫 @spekjs/core scanner / reader
│   ├── handoff/           # (Phase 7) daemon inbox / router / spawner
│   ├── workspace-store.ts # 多 folder 設定持久化（userData JSON）
│   └── watcher.ts         # chokidar 檔案監控 → IPC push
├── preload/     # contextBridge：把 IPC 包成 type-safe API 暴露給 renderer
└── renderer/    # React app（重用 spek 前端）
    ├── shell/             # 活動列 / 三欄 layout / split panes
    ├── explorer/          # 多 folder 檔案樹
    ├── tabs/              # 全域 tab manager（檔案 + spek 視圖共用）
    ├── editor/            # Monaco wrapper
    ├── terminal/          # xterm.js wrapper
    ├── handoff/           # (Phase 7) 收件匣 / 通知 / compose UI
    └── adapter/IpcAdapter # 實作 spek 的 ApiAdapter 介面（走 IPC）
```

### 8.3 技術選型

| 用途 | 選擇 | 備註 |
|------|------|------|
| App framework | **Electron** + **electron-vite** | 與 spek 既有 Vite 建置一致 |
| 打包 | **electron-builder** | 產出 mac / win / linux |
| 編輯器 | **Monaco Editor** | VS Code 同款；需處理 Vite worker 設定。替代：CodeMirror 6（更輕、Vite 整合單純）——先以 Monaco 技術驗證，視打包大小再定 |
| Terminal UI | **@xterm/xterm** | 搭配 fit / web-links / serialize addon；**webgl renderer 只載給當下 active 的終端**（`customGlyphs` 把 box-drawing 程式化繪製，與字型 glyph 及 cell 的分數像素落點都無關；並存的 WebGL context **實測上限恰為 16 且超出時最舊的靜默被丟棄、不觸發任何事件** —— 而所有 session 的終端同時掛載，故「只給 active」是正確性要求而非優化）；使用者可關閉 GPU 加速（逃生口）。**canvas addon 不採**：它停在 xterm 5 時代（latest 0.7.0、peer `^5.0.0`、2023 年後未再發佈） |
| PTY | **node-pty**（釘死 `1.2.0-beta.14`） | Node-API 模組，prebuilt 的 `.node` 可直接被 Electron 載入，**不需 `electron-rebuild`**。須採用 prebuilds 涵蓋全部目標平台的 1.2.0-beta 系列——npm `latest`（1.1.0）缺 Linux prebuild |
| 檔案監控 | **chokidar** | spek 已用，主行程沿用 |
| 設定持久化 | userData JSON | `workspace.json`（folder 清單與順序）／`sessions.json` + `sessions/<id>.scrollback`（session 狀態與畫面快照）／`preferences.json`（使用者偏好）。三者同一套紀律：**版本欄位 + 原子寫（temp+rename）+ 損毀隔離**（無法信任即改名保留、以預設啟動，絕不讓 app 開不起來） |
| UI 技術棧 | React 19 + Tailwind v4 + react-markdown | 與 spek 完全一致，最大化重用 |

> **終端字型：預設吃系統字型，且由使用者設定**（`terminal-rendering-and-preferences`）。字型**不打包、也不
> 寫死特定字型名** —— 這個 app 要給一般使用者，預設必須是「一個**真實存在**的系統等寬字」
> （`ui-monospace, monospace`），開箱即正常。（此前預設首選 `JetBrains Mono` —— 一個既沒打包、多數機器也
> 沒裝的字型，於是靜默落到系統預設，字型從此與宣告不符。）與使用者自己的終端一致，由**偏好設定**達成：
> Settings 入口 → 自**系統的等寬字型清單**挑選（下拉，非硬打字）+ **即時預覽** + 字型大小。
> 字級的**預設**仍由字級尺度推導（單一旋鈕 `--text-base`），使用者偏好可覆蓋它。

---

## 9. 與既有 spek 的關係

### 9.1 直接重用

- **`@spekjs/core`**：scanner、tasks、headings、git-cache、worktrees、types — 主行程直接 import。
- **spek 的 `ApiAdapter` 介面契約**：spek 前端已把通訊層抽象成 `ApiAdapter`（Fetch / Message / Static，11 個 method、全 Promise、參數皆可序列化）。Workspace 新增一個 **`IpcAdapter`** 實作它 —— 換的是接縫，不是視圖（見 §9.2）。

### 9.2 `@spekjs/ui` 的抽取 —— **已於 Phase 5 完成（但範圍與原計畫不同）**

> **本節原本主張「抽出 `@spekjs/ui`，既有 spek 頁面（Dashboard / SpecDetail / ChangeDetail /
> GraphView）幾乎可原封不動在 Electron renderer 跑起來，這是整合既有畫面的關鍵槓桿」。
> Phase 5 實作後的結論是：這句話對「頁面」是錯的，對「視覺化元件」是對的。**

**對頁面而言是錯的。** `docs/workspace-mockup.html`（UI 的權威）定義的側欄是為 **320–620px 窄欄**
設計的緊湊 UI；spek 的頁面是為**全寬瀏覽器**設計的（自帶 `Layout` + `Sidebar`）。**兩者不是同一個
東西。** 側欄因此依 mockup **自刻**（兩棵樹、本 change 的 artifact 分頁、BDD 高亮）—— 而且它在 spek
根本沒有對應物：spek web 的 sidebar 只是五個扁平的 nav link。

**對視覺化元件而言是對的。** **`GraphView`（d3 力導向圖）與 `timeline/*`（Gantt）不是頁面** ——
它們吃 `GraphData` / `ChangeInfo[]`，吐一塊 SVG，對宿主零認知。這兩個正是「真正可重用的那種」，
而且重刻一次只會得到一個更差的版本（實測：自刻的二分圖被使用者判定為「四不像」）。

**於是 `@spekjs/ui@1.0.0` 已抽出並發佈至 npm**（`extract-ui-package`），內容為：

- **`<SpecGraph>`** —— 力導向圖（zoom / pan / drag / 鄰居高亮 / fit-to-viewport）
- **`<ChangeTimeline>`** —— Gantt 時間軸（自適應刻度、active 延伸至今天、today 虛線、tooltip）
- `buildLanes()` 等純函式，以及**顏色契約**

**不含**：`ApiAdapter` 介面（我們的 `IpcAdapter` 每個 method 第一個參數都是 `folderId`，**簽名不
相容、實作不了它** —— 搬進套件對我們零價值，卻要讓 web 十幾個檔案改 import 路徑），以及整頁視圖。

**三個讓它能跨宿主的關鍵**（詳見 spek 的 `extract-ui-package` design）：

1. **元件是純呈現層** —— 沒有 router（導航改為回呼）、沒有 adapter（資料由 props 進）、沒有
   theme context。
2. **顏色是一份明確的契約** —— 一組 `--spek-*` CSS 變數（`@spekjs/ui` 1.3 起為 9 個），套件
   **擁有自己的變數名**而不讀宿主的 token。少了這道，我們的 token（`--color-ink` 那套）名字對
   不上，圖會畫出來但**完全沒有顏色**。換膚就是在 `index.css` 覆寫它們 —— **逐一**，漏接一個
   會靜默沿用套件的預設色（見 `docs/lessons/side-panel.md`）。
3. **React 為 peer 依賴** —— 兩份 React 實例會讓 hooks 直接爆炸。

**`openspec.*` IPC 的形狀對齊 `ApiAdapter` 這個決定在這裡得到了回報**：接上套件時換的是 UI，
不是接縫。d3 讓 renderer bundle 增加約 160 KB。

### 9.3 core 的小幅擴充

目前通用檔案操作（`safeReadDir`、`readFileOrNull`）是 scanner.ts 的私有 helper。抽成 core 公開模組，新增 `listDir` / `readFile` / `writeFile` / `stat`，供 workspace 的 fs IPC 重用。

### 9.4 不動

- VS Code Extension、IntelliJ Plugin、Demo、Web 版維持原本唯讀檢視器角色。

---

## 10. Business model

spekterm is open source under the MIT license, and has no paid tier.

Earlier planning (2026-07) assumed a freemium model: local features free, with paid cross-machine relay,
cross-person routing, remote approval from a phone, and automatic orchestration across agent vendors. In
2026-09 that plan was dropped — the same-person parts are now covered by first-party tooling, and a closed,
paid local app has little room next to free open-source alternatives. The project was released as MIT
instead (change `open-source-mit`), and Phase 8+ is not planned.

**2026-10: the same-person phone part came back, free.** Daily use showed that the first-party remote control
reaches one agent session at a time and sees none of what spekterm adds (every repo's sessions, the inbox and
handoffs, the OpenSpec side panel), and says nothing when an agent starts waiting. Remote access
(`mobile-remote-bridge`) lets a companion Android app (a separate repository) reach spekterm directly — LAN,
Tailscale or a port forward — with a pinned certificate and per-device credentials. There is still no relay,
no push service and no paid tier: the phone learns of events only over its own connection.

The only income is sponsorship, which supports the maintainer personally and is not distributed based on
contributions (see `CONTRIBUTING.md`).

---

## 11. 開發路線圖

每個 Phase 對應一個（或數個）OpenSpec change，依 CLAUDE.md 工作流 proposal → design → tasks → 實作 → verify → archive。Phase 0–6 建立工作台本體，Phase 7+ 建立護城河（handoff）。

### Phase 0 — 基礎建設與技術驗證（spike）
`spekterm` 能開視窗、renderer 跑起來，並驗證高風險相依。
- 建 package 骨架：electron-vite + React + Tailwind v4 + TypeScript。
- 主行程 import `@spekjs/core` 成功（印出某 repo 掃描結果）。
- **技術驗證**：node-pty 能在 Electron 主行程 spawn 真 pty（Node-API，免 `electron-rebuild`）；Monaco 能在 renderer 載入並高亮，且 worker 於 dev 與 build 兩種模式皆正常。
- **風險前置**：node-pty 的 prebuild 平台覆蓋、Monaco worker 打包。

### Phase 1 — 多 folder 工作區骨架
- Workspace 設定（folder 清單）存 userData，重開記得。
- 活動列 + folder 清單 UI；split panes 三欄骨架。
- IPC：`fs.listDir`（重用 core）。原生對話框加 folder。

### Phase 2 — File Explorer + 唯讀檢視
- side panel 的 `[◈ OpenSpec │ ▤ Files]` 身分切換（§6.3）；OpenSpec 為條件式身分。
- 遞迴檔案樹（子目錄 lazy load）。IPC：`fs.readFile`、`fs.watch`。
- **開檔在 side panel 內換頁**（樹 ↔ 檔案內容，以 breadcrumb 返回），**不做全域 tab manager**
  —— 主舞台屬於 terminal（§6.2「terminal 是主場」），檔案 tab 會與 session 分頁搶同一列。
  markdown 渲染、其餘以 Monaco 唯讀高亮（不含語言服務 worker）。
- chokidar（主行程）→ IPC push → renderer 更新；外部變更提示重載。
- **導航防護**：`will-navigate` / `setWindowOpenHandler` 一律阻擋，外部連結交系統瀏覽器。
  渲染不受信任的 markdown 之後，這是 §12 信任模型的前提 —— 少了它，一個連結就能把
  preload 白名單交給遠端頁面。

### Phase 3 — 編輯能力
- 多語言 syntax highlight、dirty 狀態、`Cmd/Ctrl+S` 存檔、**關閉視窗 / 結束 app 時的未存提示**。
- markdown 加 `[預覽 │ 原始碼]` 切換後可編輯；dirty buffer **跨換頁與跨 folder 存活**，樹上標記未存的檔案。
- IPC：完整 CRUD —— `fs.writeFile`（就地覆寫）、`createFile`、`createDirectory`、`deleteEntry`、`rename`，全部限制在已加入的 workspace folders 內。
- 存檔與外部變更衝突處理（mtime 樂觀鎖）。
- **寫入的邊界不得沿用讀取的論證**：Node 無 `openat`、`O_NOFOLLOW` 為 POSIX-only，中間目錄段的 TOCTOU 靠「renderer 拿不到 symlink」承擔（白名單不暴露 `symlink()`）。詳見 `file-editing-and-crud` 的 `design.md` D1–D8。

### Phase 4 — Terminal（agent 主場）
- 主行程：`node-pty` 多 session 管理；IPC 雙向串流。
- xterm.js + fit addon；底部 dock 多 tab、可 resize。
- 新 terminal 預設 cwd = 當前選中 folder。
- session 生命週期（視窗關閉時清理子行程）。

### Phase 5 — OpenSpec 側欄
- 主行程以 `@spekjs/core` 為每個 folder 供應 OpenSpec 結構，經 `openspec.*` IPC 送達 renderer（快取 + `openspec/` 的 chokidar 監看 → agent 改檔，側欄自己更新）。
- 實作 **`IpcAdapter`** —— 形狀對齊 spek 的 `ApiAdapter` 介面契約。
- side panel 的 OpenSpec 身分：**本 change**（每個 artifact 一個分頁）與 **瀏覽**（Specs / Changes 兩棵樹）—— 依 mockup 與 VSCode 的 tree provider 自刻，非搬 spek 的頁面（見 §9.2）。
- **抽出 `@spekjs/ui`**（發佈至 npm）：`SpecGraph`（d3 力導向圖）與 `ChangeTimeline`（Gantt），與 spek web 共用同一份程式碼 —— 兩者原放在**全視窗 overlay**（Timeline 的最小可用寬度超過 900px），現為**放大的側欄**中的視圖。
- session 的**錨定 change**：側欄跟隨 focused session；錨定由使用者建立，系統不猜（§6.3）。
- 交叉導覽：spec/change ↔ 底層檔案互跳。

### Phase 6 — 打包、設定與發佈
- electron-builder 產出三平台安裝檔。
  **Linux（AppImage）已由 `linux-appimage-packaging` 交付** —— `npm run dist:linux`，
  產物與 repo 工作副本脫鉤，並由 `npm run probe:package` 驗收（啟動真正的 AppImage：
  載入 renderer、production CSP、pty 建得起來且指令真的被執行）。
  同一個 change 也讓**開發模式的 userData 與產物分家**（`dev` script 的 `XDG_CONFIG_HOME`，
  主行程零改動）。
  **macOS (Apple Silicon) is delivered by `macos-dmg-packaging`**: `npm run dist:mac`, run on a Mac,
  packages a dmg from a release commit only (the version follows the Linux bump), ad-hoc signed so that
  the whole bundle is sealed — a downloaded copy is "from an unidentified developer", allowed once, not
  "damaged". Electron's archive is checked against the checksums the `electron` package ships, whatever
  mirror served it. On macOS the app has a minimal menu (the Edit roles and a Quit that closes the window
  first, so it asks like a close), and closing the window leaves the app running, as Terminal does.
  Accepted by `npm run probe:package:mac` on the Mac, from a desktop launch's environment.
  **Not done**: Developer ID signing and notarization (paid account), installing updates on macOS (needs them;
  the macOS build only tells, see `auto-update` below), Intel
  Macs, building on CI; the macOS limitations (a pty's directory, idle hibernation, the font list,
  `Ctrl+↑/↓` vs Mission Control) are tracked as issues.
  **Windows 未動**：檔案邊界在 `O_NOFOLLOW` 缺席下退為 `lstat` 二次確認，從未實測。
- **換版的辨識與桌面整合**，由 `appimage-version-and-desktop-entry` 交付（issue #13 / #15）：
  - `dist:linux` 自身**遞增 patch 版本並提交**（`chore(release): <v>`，不打 tag），於是每一份
    產物的檔名都不同、且對得回一個 commit。理由不是儀式：在此之前「修正沒生效」與「還在跑舊的」
    在畫面上一模一樣，而兩者要用完全不同的方式處理。
  - 新能力 **`build-identity`** —— 執行中的 app 於 Settings 的「About」段說出版本、建置時刻、
    commit 與**建置當時工作副本乾不乾淨**，且與產物檔名同版。刻意**不放狀態列**
    （`status-bar` 明文禁止恆定欄位，該裁決未被推翻）。
  - `npm run install:desktop` / `uninstall:desktop` 把產物裝進應用程式選單。這同時讓
    `desktop-packaging` 兩條「SHALL 以自桌面環境啟動驗收」的 requirement **首次具備可執行的前提**。
  - **仍未解**：agent CLI 在 nvm 之下的解析（issue #20）、應用程式圖示仍是 placeholder（#14）。
- **The website** (`project-website`): `spekterm.com` — a landing page and the user documentation in
  English and Traditional Chinese, built from `site/` and hosted on Cloudflare Pages; `spekterm.app`
  and `www` redirect to it. Downloads link to the latest GitHub release. Its account of the app's network
  behavior is held to the code by a unit guard, and the same change turned off Electron's spell checker,
  which downloaded a dictionary from a third-party server at every fresh start.
- 沿用 spek 深色主題（#0a0c0f / amber #f59e0b）、圖示、原生選單。
- 持久化 layout（panel 尺寸）與最近工作區。
  **session 的持久化已由 `session-restore` 落地**（不屬於任何 Phase）—— session 清單、
  使用者取的名字、順序、錨定的 change 與終端畫面快照皆跨重啟存活，claude 以 `--resume` 續接
  對話，shell 於最後已知的工作目錄重生。這裡剩下的是「開啟的檔案 tab」與 panel 尺寸。
- **Auto-update is delivered by `auto-update`** for the Linux AppImage: a packaged build asks GitHub Releases
  for a newer version a minute after startup and every six hours (on by default, a switch in Settings → About),
  downloads it in the background, and installs it — by copy and atomic rename, never with `electron-updater`'s
  own installer — when the user chooses "Restart to update" (asked like a close) or next closes the window; a
  signal or logout never installs. macOS, and a Linux build that cannot replace its file, only tell, with a link
  to the release. Releases go through `npm run release:github`, which publishes the AppImage only with its
  `latest-linux.yml`. CHANGELOG 流程仍為可選。
- **(Future, not scheduled) Linux package repositories**, alongside the AppImage's self-update rather than
  instead of it: `deb` / `rpm` (electron-builder builds them) served from a self-hosted, signed apt / rpm
  repository, so `apt upgrade` / `dnf upgrade` carry spekterm; an AUR package is best left to the community.
  The cost is the repository, not the package: a signing key, hosting, and a push at every release. Flatpak and
  Snap are a poor fit: their sandbox works against the product's core (a pty running the user's shell and
  `claude` on arbitrary repos), so it would need holes everywhere or Snap's classic confinement and its review.
  Official distribution repositories are unrealistic for an Electron app. **When this is done, a build installed
  by a package manager must detect it and stay silent about updates**: it has no `APPIMAGE`, so `auto-update`
  would otherwise treat it as a build that only tells and send its users to GitHub at every release.

### 對話計量（不屬於任何 Phase）

比照 `session-restore`：它不是路線圖上的某一格，而是一個獨立成立的能力。

**動機是資料正在消失。** Claude Code 把每個 session 的對話寫成 NDJSON 落在
`~/.claude/projects/`，但**預設只留 30 天** —— 實測 2026-09-04：本機最舊的一筆剛好是 30 天前，
而本 repo 從 2026-07-07 開始、108 個 commit 全程以 claude 開發，**第一個月的對話已經不存在了**。
這不是「以後想做再做」的功能：每多等一天就多丟一天。

交付的是三個能力：

- **`conversation-archive`** —— 掃描、萃取、落盤。契約是「**資料在，而且比來源活得久**」。
  顆粒度是**列**（一則訊息一列、一次工具呼叫一列），不是彙總 —— 來源會被刪除，
  而一旦只留下彙總，將來想問一個當初沒想到的問題就再也沒有東西可以重算了。
  掃描跑在 `utilityProcess`，決定性的理由是**崩潰隔離**：它解析的是會隨版本改變的內部格式，
  出事時使用者正在跑的 agent 不該跟著死。**app 啟動後無條件跑一趟**，與使用者要不要看無關。
- **`conversation-insights`** —— 全視窗 overlay，分為**兩個分頁**。「數字」是十一個視圖：
  前八個是工作的形狀（節奏、一次坐下來多久、講多長、幾個來回、何時踩煞車、哪個 repo、
  Bash 在跑什麼、用哪些 skill），後三個是說話的方式（**字面線索**、中英文比例、最常說的那幾句）。
- **`conversation-report`** —— 「讀後感」分頁：**質性的那一半**，由使用者自己的 `claude` CLI
  讀存檔，產出一份帶日期的報告。

**為什麼質性那一半不由規則式的分類承擔。** 第九個視圖原名「我的語氣」，用一份字面詞表做語意
分類 —— 而「這句話的語氣是什麼」**沒有唯一正確答案**：排除清單是黑名單、`correction` 抓不到
「不用止血」、`tentative` 的「我覺得」把決斷算成猶豫。它已降格為**「字面線索」**：計算方式一個
位元組都沒改，改的是它宣稱在測什麼，並補上此前沒有的「都沒中」那一格。**規則調得再細也不會
變成語氣分類**，而降格之後它反而對讀後感有對照價值 —— agent 說「你很少直接下命令」而字面線索
說「祈使開頭佔三成」時，那個不一致本身有資訊。

**兩個分頁不同時呈現是刻意的。** 儀表板永遠是「現在」且範圍可切換；報告是「某天針對某段期間
跑的一份」。疊在同一頁上，散文會被當成跟旁邊的長條圖一樣新 —— 使用者的習慣改變之後數字會動、
那段文字不會，**它會靜靜地繼續講三個月前的那個人**。

**讀後感唯一的守衛是機械查證。** agent 寫出來的東西永遠讀起來很有道理，包括它錯的時候，而散文
沒有對照組可言 —— 但「這句話存不存在」可以判定。因此每一條論斷必須附一段引用，主行程逐條在
語料中做**單一則訊息**的比對，查不到即**丟棄**並計數；**日期與專案由存檔填，不由回覆提供**
（否則掛錯的會是我們自己）。**被丟棄的條數呈現在報告上** —— 十條裡丟了三條，使用者就知道該用
什麼態度讀剩下的七條。

**存檔含使用者輸入的完整內文**，只寫進 userData；畫面上呈現原文的位置只有三處
（高頻的極短訊息、每個字面線索類別至多 9 則的例句、報告中通過查證的引用），
且**明文禁止長成一份對話的全文檢視器**。

**送出是逐次授權的例外，不是預設。** 原本的條文是「不得送往任何網路端點」；讀後感把它放寬為
「預設不送、僅在使用者針對該次明確授權下送往使用者自己的 agent，且授權畫面看得見這一趟的範圍
（而非內容）」。**不接受「這些話本來就是打給 agent 的」這個論證** —— 原本每一則是在它自己的
session 脈絡裡送出的，彙整成一份跨數十天、跨數十個專案的檔案再送一次，**聚合本身就是新的資訊**，
而存檔裡有一部分是使用者以為已經隨 30 天輪替消失的東西。

**相對於 agent 自身分析功能的增量價值有兩點**：範圍是整個 workspace 而不是單一 cwd；
數字那一半是可跨期比較的量，而不是一份每次重跑內容都不同的敘述 —— 敘述那一半刻意逐份保存
並標示其產生條件，那是它唯一能被拿來對照的方式。

來源格式的踩雷點見 **`docs/lessons/transcript.md`** —— 其中 §十一「`claude -p` 會寫進 transcript，
而那則記錄**沒有** `isMeta`」是讀後感的前提：不排除的話，這個功能會逐次污染它自己分析的資料。

### session 常駐（排在 Phase 6 之後，編號待定）

`session-restore` 交付的是**重建**：關掉 app，pty 就死了；重開時我們把 session **重新開一個**
（claude 續接對話、shell 回到最後的工作目錄、畫面以快照還原）。它涵蓋了痛點的絕大部分，但有一件事
它做不到 —— **跑到一半的長行程（build、dev server、正在工作的 agent）會跟著 app 一起死。**

要讓 session 真的活著，繞不過一個物理事實：**pty 的 master fd 必須有人持有。** app 一死，master
關閉，slave 收到 SIGHUP，底下的行程跟著死。所以「常駐」不是一個功能，是一個架構決定 ——
**必須有一個活過 app 的行程握著那個 fd**。

**兩條路，取捨已記錄在案：**

| | tmux（或 dtach／abduco） | 自寫常駐 daemon |
|---|---|---|
| 相依 | **硬相依外部二進位**。Windows 沒有 tmux；不能假設每台機器都裝了 | 無外部相依，完全可控 |
| 複雜度 | **兩層 multiplexer 疊在一起** —— resize 協商、alternate screen、滑鼠模式都要重新處理 | 沒有雙層問題，但要自己做 daemon 生命週期、unix socket、scrollback ring buffer、版本升級相容 |
| 對既有機制的衝擊 | **tmux 會攔截 OSC 0/2 標題**拿去當自己的 window name —— 而 `session-titles-and-controls` 整套 session 標題機制正是建立在 OSC 上 | 標題機制不受影響 |
| 工作量 | 中 | **一整個 Phase** |

**兩條路共同的代價**：Phase 4 立下的「**關閉分頁／reload／關閉視窗三路徑皆不留孤兒行程**」不變式
會被**整個反轉**成「刻意留下孤兒」。必須同時設計回收路徑（何時該把一個沒人要的 session 殺掉），
否則使用者機器上會慢慢累積一堆還活著的殭屍 claude。

**先不做的理由**：`session-restore` 做完之後還缺的大概就只剩「長行程死掉」這一項。等 dogfooding
一陣子，再決定要不要付上面的代價 —— 那會是一個資訊充分的決定，而不是現在猜。

### Phase 7 — Handoff 免費核心（moat 起步）

> **本機 inbox 與 spawner + context 注入器已由 `agent-intake-inbox` 落地**（活動列的 Handoffs
> 入口已接上）。外部 producer 往 `<userData>/intake-inbox/` 投遞一份 JSON，使用者看過本文之後
> 接受它，就在他確認的 folder 得到一個開好、context 備妥、第一則 prompt 已填但
> **尚未送出**的 agent session。routing 只決定預先選定哪一個 —— 接受之前可以改選
> （`intake-inbox-usability`）。
>
> **agent 自己是第二個 producer**（`agent-initiated-handoff`）—— 而那正是「handoff」這個字
> 原本的意思：a repo 的 session 把工作交接給 b repo。spekterm 經 `SessionStart` hook 的
> `additionalContext` 告訴 agent 自己的存在與可交接的對象，agent 寫一份 JSON 到**它自己的**
> 投遞落點；來源由**目錄名**推導（payload 自稱的一律不採信），目標由 folder 清單**查表**解析
> （完整相等，歧義與查無皆拒絕）。**交接到達即建立 session，不經接受閘** —— 那道閘的前提明寫著
> 「本文為第三方逐字撰寫」，而這裡的本文是使用者自己 session 的 agent 寫的、且由他當下的交辦
> 觸發。**第一則 prompt 於 agent 就緒時代為送出**（`handoff-session-lifecycle`；此前是填好而不送出，
> 使用者得回 spekterm 按送出）。
>
> **它不是安全邊界**：agent 有 shell，投遞落點的位置它算得出來。交接次數的上限（曾經必須是**全域**的）
> 已由使用者裁決移除 —— 每一則合法的交接都到達即建立並送出。
>
> **交接出來的 session 有生命週期**（`handoff-session-lifecycle`）：分頁以交接標題命名、隨時打得開
> 原始交接單；子 agent 做完一件事就寫一份完成報告（同一個落點，`kind: "report"`），spekterm 把它標為
> 已完成並把結果放進關係檔（母 session 錯過訊息也讀得到），結果回送母 session 由子 agent 自己以訊息
> 送出；已完成的由使用者一次收掉（從母 session 的清單，或 rail 的全域入口），系統不自動結束任何 pty。
>
> **回程已交付，但不是由 spekterm 傳遞**（`handoff-lineage`）：交接出來的 session 記住母 session
> （跨重啟），rail 以樹狀與「← 來源」「→ N」標示呈現；每個 claude session 以固定名字（`--name`）
> 啟動，母、子、兄弟之間用 **Claude Code 自己的本機訊息功能**以名字互相聯絡，spekterm 只提供
> 「地址穩定」與「誰是誰」（關係檔）。代價是 agent 的終端標題被固定為那個名字。
>
> 未做：**以工具而非寫檔投遞**（MCP）。Since `scheduled-handoff` the agent learns each delivery's outcome from a
> **receipt** written beside its outbox (accepted, scheduled, proposed, duplicate, rejected with the reason, or
> held); a failure found only when a handoff opens later still reaches the user, not the receipt. A handoff may
> also name a **later time**, and opens when due or at the next start (spekterm does not run while closed). Since
> `recurring-handoff` a handoff may **repeat** on a cron schedule, with an optional start and end: it is a proposal
> the user approves on the desktop, each time opens a new session, and times missed while closed run once.
>
> **Slack 是第一個外部 producer**（`slack-mention-intake`）：有人在 Slack 提及使用者本人時，
> 那件事成為收件匣的一則待處理項目，帶著該提及所在討論串的內容（**上界固定於被提及的那一則**）。
>
> **回補是主幹，即時是加速器。** 桌面應用程式大多數時間是關著的，而 Socket Mode 沒有重送佇列
> —— 以即時為主等於把最常見的情形（關機八小時）交給一個結構上補不了的機制。以 Web API 取回
> 「上次水位之後」的提及，**三個觸發點**：啟動時、每五分鐘一次、以及**使用者存下憑證的那一刻**；
> 即時路徑（若 app-level token 也設定了）只是把同一件事提早送到。
>
> **三個都是必要的，而第一版只做了第一個（dogfood 當場踩到）**：即時路徑是加速器且可能根本不可用，
> 所以週期輪詢不是備援而是主幹的一部分；而使用者在 app 起來之後才貼上憑證是常態，少了那一次觸發
> 他看到的是一個什麼都沒變的畫面 —— 與「功能壞了」無法區分。
>
> **交付不了多租戶，而那要攤開講**：Socket Mode 的 app 上不了 Slack Marketplace（要上架就得走
> HTTP 端點），且 app-level token 是整個 app 一份、多條連線之間是負載平衡 —— 結構上這是單人、
> 單一工作區的。能交付的是**邊界的位置**：adapter 只是收件匣的一個 producer，換接取層時
> 收件匣、routing、session 的建立與預填**一個字都不必改**。
>
> **不需要任何新依賴**（實測）：Node 22.22 與 Electron 43.4.1 內的 Node 24.18.1 都具備全域
> `fetch` 與全域 `WebSocket`。不引入官方 SDK 的第二個理由是承重的 —— 許多服務 SDK 會讀約定俗成的
> 環境變數，而往 `process.env` 寫一個值就會進到**每一個 pty**。
>
> **身分自憑證推導，不是設定欄位**：一個填錯的「要偵測誰」，症狀是什麼都不會發生 —— 與
> 「沒有人提及我」和「連線已失效」在畫面上完全相同，而讓後兩者可區分正是這條能力花了一整條
> requirement 在做的事。
>
> **刻意的缺口**（完整清單見該 change 的 `design.md` 與規格）：回看範圍有上限，關機超過它的期間
> 會漏（範圍對使用者可見）；即時路徑「收得到事件」這一半沒有自動化載體（替身回一個連不上的
> wss 位址，只驗得到降級那一半）；真實 Slack 的連線由 dogfood 認定 —— **2026-09-13 通過，
> 而它一次就抓到兩個自動化驗收全綠也看不見的缺陷**（權限不足被報成憑證失效、回補沒有週期性；
> 兩者都以「收件匣是空的」呈現）。
>
> **那筆技術債已還**：`settings:get` 改為逐欄位投影，且 preload 的宣告一併窄化 ——
> renderer 的偏好型別是自 preload 回推的，**preload 寫寬了，主行程的白名單就只剩執行期效果**。
> 兩者都由 `scripts/settings-projection.test.mjs` 守著。

- **Handoff schema**（§7.4）：frontmatter + 錨點 + 磁碟狀態快照。
- ~~**本機 daemon inbox**~~（已落地）+ repo/workspace addressing registry（沿用已管的 repo 清單）。
- **`spek handoff` CLI**（producer）：狀態由磁碟推導、agent 補意圖。
- **Router / probe daemon**（主行程 watcher）：同機 auto-spawn，跨人先 pending。
- ~~**Spawner + context 注入器**（先只接 `claude`）~~（已落地）。
- **Consumer / ack** 流轉（open → awaiting-ack → done）。
- **UI**：~~收件匣~~（已落地）、~~通知~~（已落地：活動列入口的待處理計數 ＋ 作業系統原生通知，
  觸發它把視窗帶到前景並打開收件匣）、compose、session「picked up from handoff X」標示。

  > **通知有兩條缺口寫在規格裡**：「它真的出現在桌面上」與「視窗真的浮到前景」沒有自動化
  > 載體，由 dogfood 認定。另外**桌面沒有通知服務時本能力靜默無效，而應用程式偵測不到**
  > —— 實測「支援通知」的回報在完全沒有通知服務、甚至連匯流排都連不上時依然為真。
  > 已裁決不做主動偵測；計數標示是那種情況下唯一仍然有效的那一半。

### Phase 8+ — Handoff 付費層與 agent 擴充

> **2026-09-29：已裁決不做付費層（§10）。** relay（同一人跨機）與手機核准已由官方覆蓋。跨廠牌 agent 的擴充是否還要做，見 §14。

- **Relay**：跨機 / 跨人中繼 + 身分 / Team registry + 存取控制 + 跨人核准。
- **多 agent**：擴充 spawner 注入抽象至 Codex / Gemini；**自動編排** Claude→Codex→Gemini。
- handoff 歷史 / 稽核、手機遠端核准。**Phone access for the same person shipped free in 2026-10** (`mobile-remote-bridge`): direct, no relay; the Android app lives in its own repository.

---

## 12. 橫切關注點

- **狀態持久化**：工作區 folder、panel 尺寸、最近專案；**terminal session 已由 `session-restore`
  落地**（清單、名字、順序、錨定的 change、終端畫面快照，以及 claude 的對話續接）。「開啟的檔案
  tab」仍待 Phase 6。**注意 session 的持久化是「重建」不是「常駐」** —— pty 仍隨 app 結束而死，
  差別與代價見 §11 的「session 常駐」。
- **快捷鍵 / 命令面板**：命令面板（`Cmd+K`）仍為後續項目。**導航快捷鍵已由
  `session-navigation-and-labels` 落地**：`Ctrl+Tab` / `Ctrl+Shift+Tab` 切換當前 repo 內的
  session（分頁位置序、可循環），`Ctrl+↓` / `Ctrl+↑` 切換 repo（rail 順序、可循環）。
  **`docs/workspace-mockup.html` 對快捷鍵沉默** —— 這組綁定由該 change 定義，不算偏離雛型。
  鍵位的取捨（哪些鍵能從 pty 手上拿走、代價是什麼）見該 change 的 `design.md` D1–D2。
- **主題**：沿用 spek dark/light，Monaco 與 xterm 主題同步。
- **安全 / 信任模型**：
  - fs 寫入與 terminal cwd 限制在已加入的 workspace folders。
  - Electron `contextIsolation: true`、停用 `nodeIntegration`，所有能力走 preload 白名單。
  - handoff auto-spawn 受 §7.6 信任邊界約束（同機同人 vs 跨人核准）。
  - **Remote access** (`mobile-remote-bridge`) is off by default. When on, one module listens (TLS on all
    interfaces); a paired device has the user's power over agents — it can type into sessions — and nothing
    else (no files outside OpenSpec reads, no settings, no credentials). Devices pin a self-signed certificate
    and hold their own revocable credential, stored only as a hash; the feature makes no outbound connection.
- **效能**：大目錄樹 lazy load；大檔案 Monaco 上限保護。

---

## 13. 技術風險與緩解

| 風險 | 緩解 |
|------|------|
| node-pty 所選版本的 prebuilt 未涵蓋目標平台 | 釘死有全平台 prebuild 的版本（1.2.0-beta 系列）；Node-API 使其免 `electron-rebuild`。Electron 升版後重跑載入驗證（`npm run probe:native`） |
| ~~Monaco + Vite worker 設定繁瑣~~（Phase 0 已證偽） | Vite `?worker` + `MonacoEnvironment.getWorker` 即可，dev 與 build 兩模式實測皆通過 |
| `@spekjs/ui` 抽取波及 web | 抽取前先確保 web 有基本回歸；小步搬移 |
| Electron 安全設定不當 | 預設 contextIsolation + preload 白名單，不開 nodeIntegration |
| 打包體積大 | Phase 0 實測 renderer 資產 20.88 MB（基準 0.54 MB），其中 `ts.worker` 佔 12.65 MB。僅需高亮與存檔時可移除 `language/typescript` contribution；必要時退守 CodeMirror 6 |
| **cmux 用 socket API 拼出「夠用」spec 側欄** | 差異化推進到「懂 change 生命週期」的 handoff 語意深度，且要快（Phase 7 前置） |
| **cmux 補上一級 worktree 支援** | 不只靠組織模型，靠 spec + handoff 雙腿 |
| **Anthropic 官方向上吃**（內建多 session + spec 呈現） | 綁 OpenSpec 語意 + 跨異質 agent，非官方單 agent 能覆蓋。**2026-09：多 session、worktree、跨 session 訊息、Remote Control 已發生；spec 呈現尚未**（§2.3） |
| **OpenSpec 若收斂到別的格式** | payload 錨點設計成可換；handoff 抽象不硬綁單一 spec 格式 |
| handoff auto-spawn 被濫用執行指令 | 信任邊界（§7.6）+ cascade 護欄 |
| **`--name` 撞名自動改名**（Claude Code v2.1.232 起：同機已有活著的同名 session 時，新的會被加上後綴） | spekterm 自己的 session 之間已由 `decidePeerName` 避開撞名；**與 spekterm 之外的 claude session 撞名時，實際名字會與關係檔記錄的名字不同，母子訊息靜默送錯或送不到**。待確認：是否能從 SessionStart 取回實際名字 |
| **組織可以關掉注入的 hooks**（`allowManagedHooksOnly`、`disableAllHooks`） | Team／Enterprise 使用者的對話 view 狀態、交接的自我介紹全部失效，而沒有錯誤。待評估：偵測並呈現 |
| **`SessionStart` 的 `additionalContext` 上限 1 萬字**（超過存成檔案、只留前 2000 字預覽） | Measured (Claude Code 2.1.303, `-p` and interactive): 10,000 characters arrive whole, 10,001 are replaced by the preview, so the agent loses every rule after the opening. The introduction groups its repo list by directory, a test holds a 30-folder introduction within 8,000 characters (6,985 at `scheduled-handoff`, 7,808 at `recurring-handoff`: 192 to spare), and a run-time limit of 9,000 cuts the list, never the rules (`docs/lessons/handoff.md` §16) |

---

## 14. 開放問題

### 策略
- ~~spekterm 還要不要當付費產品？授權模式？~~ **已裁決（2026-09-29）：MIT 開源，不做付費層**，見 §10。
- **跨廠牌 agent**：是否真的要做 Codex（與 Antigravity CLI）的注入路徑，還是承認「只做 Claude」並把原則 3
  （agent 中立）降級。

### Handoff（多屬 TODO）
- **Addressing registry**：repo / workspace 全域命名與解析；跨人時 `to` 指向誰的哪個 repo？
- **跨 agent 注入抽象**：Claude / Codex / Gemini CLI 的 context 注入方式不同（prompt / flag / 初始訊息 / 檔案引用），需一層統一介面。（2026-09：Gemini CLI 已對個人用戶停止，由 Antigravity CLI 接替。）
- **cascade 上限**：自動接力深度上限與迴圈偵測方式。
- **產生時機**：agent 結束主動產生？人手動觸發？狀態自動推導？（傾向混合）
- **relay 信任模型**：跨人核准的身分驗證、handoff 內容完整性 / 來源可信。
- **OpenSpec 增強層**：核心 / 增強兩層已定（§7.4，不綁 OpenSpec）；待決的是增強欄位的自動偵測——如何判定「這一棒對應到哪個 change」以自動帶入（branch↔change 對應、focused session 上下文、或使用者指定）。
- **UI 呈現**：handoff 是 OpenSpec 側欄裡的一個區塊，還是 session 之間的獨立產物 / inbox？（mockup 目前採 workspace 層級收件匣 + rail badge）

---

## 15. 建議的下一步（2026-09-29 改寫）

Phase 0–5 已封存，Phase 6 的 Linux 與 macOS（Apple Silicon）打包與 Phase 7 的本機收件匣、交接、母子關係已交付。原本這一節的
「先做 Phase 0」已完成，不再適用。

1. **開源已裁決**（§10）。macOS (Apple Silicon) ships unsigned by a Developer ID; what remains to decide is whether a paid Apple account (notarization, auto-update) and a Windows artifact are worth it, and whether cross-vendor agents are still in scope (§14).
2. **不論裁決結果都值得做的**：處理 §13 新增的三條官方介面風險（`--name` 撞名、組織關閉 hooks、
   `additionalContext` 上限）—— 它們影響的是已交付的功能。
3. 若要保住「交接」這條差異化，**補上 §7.2 的磁碟狀態驗證**（交接單自動附 diff stat 與 tasks 進度），
   讓它從「agent 自述」變成「磁碟驗證」。那是目前其他工具都沒有的一層，而且不需要任何雲端。

> 開新 change 用 `/openspec-new-change` 或 `/opsx:new`。
