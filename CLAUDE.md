# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **這份文件的定位**：前半是操作事實（指令、身分、慣例），後半是**教訓** —— 那些「不知道就會踩、
> 而且失敗是靜默的」的實測結論。每個 change 交付了什麼**不在這裡**，在 `openspec/changes/archive/`
> 與 `docs/PRD.md`。往這裡加東西前先問兩件事：
>
> 1. **下一個人不知道它，會不會靜默地做錯事？** 不會的話，它屬於那個 change 的 design.md。
> 2. **它是隨時會踩到，還是只在動某一類檔案時才會踩到？** 後者屬於 `docs/lessons/`，並在下面的
>    「踩雷指南」補一條觸發器。**這份文件每個 session 都全額載入，篇幅是有代價的**；`docs/lessons/`
>    則是要用時才讀。

## Project Overview

spekterm 是一個以 agent 為核心的本地開發工作台 —— 獨立的 Electron 桌面 app（以 MIT 授權開源），
把多個「一個 repo／資料夾各自一個 `claude` session」的 terminal 包在一個殼裡，並加上一塊懂
OpenSpec 結構的側欄，讓使用者不必另外開 IDE 就能一邊駕駛 agent、一邊看著 spec 上下文。

**側欄懂 OpenSpec，正是這個 app 相對於「開四個終端機分頁」的增量價值。** 任何讓側欄看不見使用者
當下在做的事的缺陷（例如曾經看不見 worktree 裡的 change），都是在掏空這個價值命題，不是小瑕疵。

### 現況

**Phase 0–5 已封存。** 目前具備：

- **殼層** —— 多 folder 工作區（清單持久化、拖曳排序）、活動列 + rail + 三欄版面、狀態列、
  rail 頂端一個不隸屬任何 repo 的**全域 session**。
- **終端** —— `node-pty` 多 session、xterm + webgl、session 落盤與重建（claude 以 `--resume`
    續接、shell 於最後 cwd 重生並重播畫面）、休眠喚醒、終端偏好（字型／size／行高／GPU 開關）。
  **Hibernation** (`session-hibernation`): a running session can go back to dormant — by hand
  (`Ctrl+Shift+H`, tab or rail menu) or after an idle threshold (default 24 h, Settings) — and
  **every dormant session starts only on an explicit Wake**, never on display. Hibernation is a
  per-session `dispose`, not a `kill`: the record, drop point and lineage stay. The shell idle test and
  why are in `docs/lessons/terminal.md`.
- **側欄** —— OpenSpec 與 Files 兩個身分、artifact 分頁與兩棵樹、Graph／Timeline、
  **maximize over the main stage** (`Ctrl+Shift+M`; it covers the terminal without resizing it, and
  Graph／Timeline are views shown only maximized)、
  worktree 聚合、雙向交叉導覽、`Ctrl+P` 快速開檔、續寫入口（送 `/opsx:continue`）。
  座標（來源 repo／工作目錄／錨定的 change）是 **per-folder** 的，落盤於 `panel.json`。
- **agent 對話 view** —— agent session 有終端與對話兩種可切換的呈現（**終端為預設**）。
  內容來自 agent 自己寫下的紀錄（`~/.claude/projects/**/*.jsonl` 增量 tail），
  「現在能不能送輸入」來自注入的 hooks。
  **The status dots read the same hooks** (`session-wait-indicator`): working / waiting for you / asks for a choice /
  idle. "Waiting" means a turn ended that no one has looked at; **the seen mark is owned by the main process**
  (`wait-seen.ts`) and shared with the phone (`seen` in the remote list) and the handoff lifecycle's "waiting".
  **SHALL NOT 解析終端畫面** —— 生態系有三個專案走過
  那條路，一個要在自己的 app 裡再養一個 VT100 模擬器，一個已失效，一個公開宣告不可維護後刪光。
- **收件匣** —— 活動列的 `Handoffs` 入口已接上（PRD §11 Phase 7 的本機 inbox）。外部 producer
  往 `<userData>/intake-inbox/` 投遞一份 JSON，使用者**看過本文之後**接受它，就在**他確認的**
  folder（routing 只決定預選哪一個，`intake-inbox-usability`）得到一個開好、context 備妥、
  第一則 prompt 已填但**尚未送出**的 agent session。
  **Slack 已是第一個 producer**（`slack-mention-intake`）：有人在 Slack 提及使用者本人時，
  那件事成為一則待處理項目。**回補是主幹、即時是加速器** —— 桌面 app 大多數時間是關著的，
  而 Socket Mode 沒有重送佇列。**回補有三個觸發點**（啟動時、每五分鐘、存下憑證的那一刻）——
  少了後兩個，這個能力只在啟動的那一刻有效（dogfood 當場踩到）。
  它**交付不了多租戶**（Socket Mode 上不了 Marketplace、
  app-level token 一個 app 一份），能交付的是邊界位置：adapter 只是收件匣的一個 producer。
  **不需要任何新依賴**（Node 22 與 Electron 43 內的 Node 24 都有全域 `fetch` 與 `WebSocket`）。
  活動列的入口帶**待處理數的計數標示**，新項目到達時發一則**作業系統原生通知**，觸發它把視窗
  帶到前景並打開收件匣。**通知不是一個被動的純文字平面** —— 桌面服務會把內文當標記解析、
  會把其中的 URL 變成可點的連結（而點在那一塊上不會觸發我們自己的效果），因此第三方欄位
  進入通知之前要**縮減**（不是轉義 —— 轉義的正確性取決於目的地，而執行環境沒有暴露它的能力
  宣告）。完整的實測見 `docs/lessons/intake.md` 第七節。
- **交接** —— **收件匣的第二個 producer 是 agent 自己**（`agent-initiated-handoff`）。
  spekterm 經 `SessionStart` hook 的 `additionalContext` 告訴 agent 自己的存在與可交接的對象，
  agent 寫一份 JSON 到**它自己的**投遞落點，spekterm 由**目錄名**推出來源、以 folder 清單
  **查表**解析目標，然後**到達即建立 session**（不經接受閘 —— 那道閘的前提是「本文為第三方
  逐字撰寫」，而這裡的本文是使用者自己 session 的 agent 寫的）。**第一則 prompt 於 agent 就緒時
  代為送出**（`handoff-session-lifecycle`）—— 送出字元偶爾不生效（實測 1/13），退路是呈現「待送出」、
  **不補送**。**它不是安全邊界**：agent 有 shell，落點的位置它算得出來；交接次數**沒有上限**（使用者裁決）。
  **交接 session 有生命週期**：分頁以交接標題命名、隨時打得開交接單（本文另存 `<id>.handoff.json`，
  不進 `sessions.json`）；子 agent 做完寫一份完成報告（同一個落點，`kind: "report"`），狀態
  （進行中／等你／已完成）呈現於母子兩端與關係檔；**完成的那一刻發一則通知**，觸發它打開那份交接單；
  已完成的由使用者收掉，系統不殺 pty。**送出字元與文字分開寫、隔 500ms** —— 一次寫入時長 prompt 被 agent
  當成貼上、`\r` 被併進去而沒有送出（13.1，dogfood 踩到）。
  **落定依「採納報告之後的輪詢值」，不依狀態的轉變**（第十四節）。
  **The drop points are read at startup, on watcher events, and every 30 seconds** — the watcher once
  missed an outbox silently and its handoffs vanished until a restart (`intake-periodic-rescan`, §15).
  The re-read skips a file whose re-read would repeat a visible outcome (`docs/lessons/intake.md`).
  **交接出來的 session 記得它的母 session**（`handoff-lineage`）：同 repo 在 rail 上縮排、跨 repo
  以「← 來源」「→ N」標示往返，母 session 關閉後呈現快照；關係由主行程在 **spawn 之前**寫入，
  renderer 只能轉交一張主行程簽發的單次憑證。**每個 claude session 以固定名字啟動**
  （`--name`，`<rail 項目>-<短碼>`，跨重啟／續接／自癒不變）—— 那是 Claude Code 本機訊息功能的
  地址；agent 從關係檔（隨時更新）查得到母、子、兄弟的名字，**訊息本身由 Claude Code 傳遞**。
  **代價：指定名字會把 agent 的終端標題固定成那個名字**（使用者以重新命名取回任務名稱）。
  完整的實測見 `docs/lessons/handoff.md`（第十一至十四節）。
  **An agent can also close, hibernate or rename its own session and its descendants** (`agent-session-control`,
  `kind: "close" | "hibernate" | "rename"` in the same drop point). Close and hibernate wait for the target's turn
  to end, and the user's typing cancels them. **An agent's close of its own session is only offered**: an overlay
  with Close / Keep, the content readable underneath. **The main process owns the offer** and a paired phone sees
  and answers it (`remote-close-offer`): any new way to answer it must reach `SessionControl`, not only the card. "In a turn" is **not** the wait state's `ready` (see
  `docs/lessons/handoff.md`, "Session commands").
- **Settings** (`settings-sections`) — one dialog with sections (General, Terminal, Agents & sessions,
  Integrations, Remote access, About) and **one save model: a change applies when it is made** (a choice at
  once, a typed value on Enter or blur, Esc restores). The only exceptions are a Slack token and the remote port,
  which wait for their own button or Enter. Slack's connection and the remote access controls live there; the
  routing rules stay in the inbox. Two rules that fail silently if forgotten:
  - **`PreferencesProvider` writes through a queue whose entries read the last applied preferences when they
    run** (`preferences-queue.ts`). The font family, size and line height are one write; arguments bound when
    a change is made let a quick second change undo the first.
  - **The preference, Slack settings and secret stores write the file first and assign after.** Assigning first
    kept a failed value in memory, where the next successful write put it on disk. The remote store does not do
    this yet (issue #88).
- **鍵盤** —— 見下文「快捷鍵」。
- **Website** (`project-website`) — `spekterm.com` is built from `site/` (Astro + Starlight, its own
  package, nothing of it reaches the app): **the website of both spekterm (`/`) and spek (`/spek/`)**,
  each with a landing page and user docs, English at `/` and Traditional Chinese at `/zh-tw/`, **every
  page in both**. What belongs to one product follows the page's path (`site/src/product.mjs`); spek's
  pages are written from spek's code and its screenshots need a clean, tagged spek checkout
  (`site/README.md`). **spek's live demo is served at `/spek/demo/`** — fetched by the build at the spek
  release pinned in `site/src/spek-demo.json` (tag + SHA-256), a file the site serves rather than a page,
  with no analytics; moving the pin is part of a spek release's site update. The docs are the authoritative user guide;
  the READMEs keep the overview and the install facts `desktop-packaging` reads them for. Its
  screenshots come only from `npm run capture:screenshots` (invented home, fixture repos, stub agent;
  reads the on-screen text through the hygiene matcher before each capture). Its "Data and network" page
  is held to the app by `scripts/network-surface.test.mjs` — **a new network API or import in
  `src/main` / `src/preload` / `src/shared` fails it until the page is revisited**. How the site is
  built, checked, and deployed: `site/README.md`, `site/DEPLOY.md`.
- **Remote access** (`mobile-remote-bridge`) — **off by default**. When the user turns it on, a companion
  Android app (its own repository, built against `docs/remote-protocol.md`) reaches spekterm **directly**:
  TLS WebSocket on one port, all interfaces, a self-signed certificate the phone pins, per-device credentials
  stored as hashes. **No relay, no push service, no outbound connection**: the phone learns of attention
  events only over its own connection, and a short in-memory log replays what it missed. Three rules that fail
  silently if forgotten:
  - **`src/main/remote-server.ts` is the only module that may create a server or import `https`/`ws`**
    (`scripts/server-source.test.mjs`, file-scoped entries in `scripts/network-surface.test.mjs`). `probe:core`
    runs on a throwaway profile because the real one may have remote access on.
  - **The renderer stays the authority on sessions**: a device's create, wake, rename, hibernate, close, keep and accept
    are requests to it (`workspace:remote:request`), carried out **quietly** — no selection change, no keyboard
    focus, and no focused-session change except the one a close of the displayed session forces
    (`takeQuietArrival`; for hibernate and close, `isFocusHeld`, which lasts one commit — a mark that waits to
    be asked for can linger and swallow a later focus). "Already running" and "is it idle" are answered by the
    main process from the pty; the renderer's status lags a hibernation by a moment.
  - **A device's operations are one allow-list** (`OPERATIONS` in `src/main/remote-protocol.ts`); the protocol
    document must list exactly them (`scripts/remote-protocol-doc.test.mjs`).
  - **OpenSpec answers are built field by field** (`remote-openspec.ts`, `remote-openspec-browse`), never the
    side panel's views passed through: those let core's new fields flow on purpose, and a field reaches a device
    only once that module and section 5 of the protocol document name it. Kept names stay the views' names, so a
    client parses an older desktop's pass-through answers too; `openspec.watch` in `operations` tells them apart.
  - **A device answers a prompt with keys, never text or Enter** (`remote-answer.ts`), re-checked before every
    key: only while exactly one permission request is open, nothing was typed since it appeared, and it was not
    answered yet. Every open request is tracked (`agent-events.ts`): a background subagent's prompt keeps the
    state on awaiting-choice through the agent's own `Stop`. Attachments go only into
    `<userData>/remote-attachments` under desktop-chosen names; agents read it through an injected `Read` rule.
    The key plans and event orders are measured (`docs/lessons/transcript.md`): re-measure on a CLI upgrade.
  - **A device's model and usage are a per-watch event (`conversation.status`), never a session list field**: context
    and cost change with every API call, and the list goes to every device. A device's prompt carries the phone-origin
    note as hook context, not text (`agent-origin.ts`); the skill list is the transcript's `skill_listing`
    (`transcript-skills.ts`). Both rest on measured CLI behavior: `docs/lessons/transcript.md`.
  - **A device sends an accepted item's filled-in prompt by writing only the submit key** (`sessions.submitPrefill`,
    `remote-prefill-send`); the settle stays `watchSubmission`'s, the same path as the desktop's Enter. The listed fill
    (`Session.prefill`) is the desktop's "not sent" label — a submitted handoff's prompt only after the fallback — with its
    item still in the inbox; `edited` counts keystrokes (`keystrokeSeq`), never times. **Any prefill record refuses a
    device reply** (`PREFILL_PENDING`), edited or not: the reply would be sent together with an unread third-party prompt.

**以 MIT 開源**（`open-source-mit`：`LICENSE`、`CONTRIBUTING.md`、產物根目錄附本身與第三方的授權文字；
公開前已改寫全部 git 歷史）。**Linux 打包已可用**（`npm run dist:linux` → AppImage，`npm run install:desktop` 裝進應用程式
選單）。**版號逐次遞增**且產物與執行中的 app 說得出同一個建置身分（Settings 的「About」段）。
**macOS (Apple Silicon) is packaged too** (`macos-dmg-packaging`): `npm run dist:mac` on a Mac, from a release
commit only, ad-hoc signed (not notarized). **尚未開始**：Windows 產物、Intel Mac、Developer ID 簽章與公證、自動更新（Phase 6 其餘）。
**交接已交付**（agent → 另一個 repo，以及母、子、兄弟之間經 Claude Code 本機訊息功能的往來）；
**以工具而非寫檔投遞**（MCP）仍未做；**the agent learns each file's outcome from a receipt** spekterm writes
beside its outbox (`handoff-receipt`: accepted / scheduled / duplicate / rejected / held, written before the file
is removed). **A handoff may name a later time** (`scheduled-handoff`, `"at"`): it waits in the inbox and opens
when due, or at the next start. **Every automatic opening goes through `HandoffOpener`**, which waits for a window
that has restored and lists the inbox, and opens each handoff **at most once, ever** (`firedAt`, persisted
first) — an open request no window receives is lost. The introduction must stay under the CLI's 10,000-character
`additionalContext` threshold; past it the agent keeps only a 2 KB preview (`docs/lessons/handoff.md` §16).
**session 常駐**（讓 pty 活過 app 的生命）已排入路線圖但**刻意不做** —— 見 `docs/PRD.md` §11 的
tmux 與自寫 daemon 取捨。**不要把「重建」誤當成「常駐」**：關掉 app，pty 一定會死（master fd
必須有人持有），跑到一半的 build 或 dev server 救不回來。
**That is why closing the window asks first** while any session holds a process
(`maximize-panel-and-confirm-close`): one native dialog together with the unsaved-changes question,
cancel as the default. A quit started by a signal (logout, `kill`) does not ask — the guard tells
them apart by event order (`before-quit` comes first only for a signal), see `src/main/close-guard.ts`.

### 權威來源

- **`docs/PRD.md`** — 產品需求的**單一權威來源**。功能範圍、路線圖、架構決策以它為準。
- **`docs/workspace-mockup.html`** — 定案的高保真 UI 互動雛型。**UI 版面與行為以它為權威**；
  PRD §6 的文字若與雛型有出入，以雛型為準。（雛型對快捷鍵沉默 —— 那組綁定不是偏離雛型。
  **rail 的置頂段同理**：`rail-pinned-repos` 刻意沒有回頭改雛型 —— 那是雛型定案之後才長出來的
  能力，它對此沉默，不構成偏離。**權威僅及於雛型講過的事。**）
- **`openspec/changes/archive/`** — 每個 change 的 proposal／design／spec delta。「為什麼這樣決定」
  的完整論證住在那裡，不在這份文件。

### 踩雷指南 —— 動到對應的東西之前**必讀**

這三份與本文件同一個定位（「不知道就會踩、而且失敗是靜默的」），只是**觸發條件夠明確**，所以搬出去
讓它們不必每個 session 都佔位。**它們不是補充讀物，是那些模組的前提。**

| 你要動的東西 | 先讀 |
|---|---|
| 任何一支 `scripts/probe-*.mjs`、`scripts/lib/` 的儀器（`instrument` / `cdp` / `mounted`）、加一條驗收斷言或一種等待、追一個 flaky | **`docs/lessons/probes.md`** |
| pty、`src/renderer/src/shell/terminal/`、session 持久化與重建 | **`docs/lessons/terminal.md`** |
| `src/renderer/src/shell/side-panel/`、`src/renderer/src/shell/openspec/`、`@spekjs/core` 或 `@spekjs/ui` 升級 | **`docs/lessons/side-panel.md`** |
| `src/main/intake-*`（**含 `intake-notify*`**）、`src/main/ipc/intake.ts`、`scripts/probe-intake.mjs`、`scripts/lib/stub-agent.mjs`、或任何會動到「呈現給人看的文字」與「交給 agent 的文字」其中一端的東西、**或任何會把文字送到作業系統通知的東西** | **`docs/lessons/intake.md`** |
| `src/main/slack-*`、`src/main/secret-store.ts`、`scripts/probe-slack.mjs`、`scripts/lib/stub-slack.mjs`、或任何會把憑證交給第三方的東西 | **`docs/lessons/slack.md`** |
| `src/main/handoff-*`、`src/main/handoff-service.ts` 的落點與上限、`scripts/probe-intake.mjs` 的 `runHandoff*` 段落、或任何**倚賴「注入的內容真的進入 agent 脈絡」**的東西 | **`docs/lessons/handoff.md`** |
| `src/shared/i18n/`（含 `locale.ts`、`languages.ts`、任一份字典）、`scripts/dictionary-completeness.test.mjs` / `locale-source.test.mjs` / `probe-language.test.mjs`、任何探針的**啟動路徑**、或任何會**格式化時間／數字／排序字串**的東西 | **`docs/lessons/i18n.md`** |
| `site/`、`scripts/capture-screenshots.mjs`、`scripts/network-surface.test.mjs`, or anything the website states about the app (network, platforms, features) | **`site/README.md`** |
| `build.mac` / `build.dmg`, `scripts/package-mac.mjs`, `scripts/after-pack.cjs`, `scripts/release-check.mjs`, `scripts/probe-package-mac.mjs`, `src/main/app-menu.ts`, `src/main/close-guard.ts`'s quit intent, or anything run on the build Mac | **`docs/lessons/macos.md`** |
| `src/main/transcript-*`、`src/main/agent-events.ts`、`src/main/agent-injection.ts`、`src/main/agent-origin.ts`、`src/main/insights*`、**`src/main/report.ts` 與 `src/main/report-*`**、`scripts/probe-insights.mjs`、`scripts/probe-agent-view.mjs`，或任何會讀 `~/.claude/projects`、**注入 `--settings`**、**或委派 `claude` CLI** 的東西 | **`docs/lessons/transcript.md`** |

## 開發指令

```bash
npm run dev             # electron-vite dev（開發模式）
                        #   **userData 走 `~/.config/spekterm-dev`，與打包產物分家** —— 靠 script 裡的
                        #   `XDG_CONFIG_HOME`，主行程一行都沒改。少了它，dev 與使用者正在用的 AppImage
                        #   會共用 `~/.config/Spekterm`，兩邊各自落盤 session 清單、後寫的贏（分頁消失，
                        #   而它的 pty 還活著）。**只在 Linux 生效** —— macOS／Windows 上 Electron 不看
                        #   這個變數，屆時隔離會靜默失效。
npm run build           # 建置至 out/
npm run dist:linux      # 換版 → 建置 → 打包 AppImage → 清掉更舊的產物（首次需要網路下載 Electron binary）
                        #   **第一步會 bump patch 版本並 commit**（`chore(release): <v>`，不打 tag）。
                        #   要升 minor／major 用 `RELEASE_LEVEL=minor npm run dist:linux` —— **不是**
                        #   `-- minor`：npm 把引數接在 `&&` 串的最後一步，而 bump 是第一步。
                        #   `package.json` / `package-lock.json` 任一已被改過時它**拒絕執行** ——
                        #   換版提交只能指名這兩個檔案，而遞增與你的編輯在同一個檔案裡。
npm run dist:mac        # macOS only, on a Mac: refuses unless HEAD is the clean release commit of the declared
                        #   version (it never bumps — the Linux command does), then `npm ci` → build →
                        #   Electron archive checked against `electron/checksums.json` → ad-hoc signed dmg.
                        #   **Set `ELECTRON_MIRROR` on the build Mac** — GitHub's download there stalls for
                        #   ten minutes without a word. A trial build: `npm run build && node scripts/package-mac.mjs`
                        #   (never a bare `electron-builder --mac`: the afterPack hook refuses it).
npm run install:desktop # 把產物裝進應用程式選單（~/.local/bin ＋ .desktop ＋ 圖示，尊重 XDG_*）
npm run uninstall:desktop
npm run typecheck       # tsc：main / preload（node）+ renderer（web）
npm run lint            # eslint（**這個 repo 沒有 prettier** —— 別順手跑 npx prettier，
                        #   它會用預設值把無分號／單引號改成分號／雙引號）
npm run measure:bundle  # renderer bundle 體積報告；產物出現語言服務 worker 即非零碼結束
npm run capture:screenshots  # the website's screenshots (builds the app first) — see site/README.md
(cd site && npm ci && npm run build)  # the website's build, which is also its gate (site/README.md)
                        #   **Once Cloudflare Pages is wired (site/DEPLOY.md), a push to `master` that
                        #   touches `site/` (or the root scripts its build reads) is a production deploy.**
```

開發模式啟動時主行程會印一行掃描摘要，目標預設本 repo，以 `SPEKTERM_SCAN_PATH` 覆寫：

```bash
SPEKTERM_SCAN_PATH=../spek npm run dev
# [openspec] scan /home/me/git/spek specs=43 activeChanges=1 archivedChanges=67 …
```

### 測試分兩層 —— 分界是**成本**，不是技術手法

| | 是什麼 | 什麼時候跑 |
|---|---|---|
| `npm test`（＝ `test:unit`） | node:test —— headless、秒級、可平行、無副作用 | **隨時**。改完就跑 |
| `npm run test:e2e` | 全部 14 支探針，走 CDP 或真 Electron 主行程，驗**被出貨的那份程式碼** | **驗收時**。約二十分鐘 |
| `npm run test:all` | 兩層都跑 | 封存前 |

**`test:unit` 是一串寫死層數的 glob，而一支不在 glob 裡的測試從來不會被執行** —— 沒有錯誤、
`npm test` 照樣全綠。`src/main/ipc/` 的測試曾經從寫下那天起就沒跑過，其中一條紅了而沒有人看到。
`scripts/test-glob.test.mjs` 擋著：repo 內每一支 `*.test.*` 都必須被某個 glob 涵蓋。

**探針不併進 `npm test` 是刻意的**：它們不可平行（各自佔 debugging port、各自起 Electron 還要收屍）。
併進去的代價是「從此沒有人敢隨手打 `npm test`」。迭代時用單支 `probe:*` 入口，不要為了改一行跑
`test:e2e`。

`test:e2e` 由 `scripts/run-probes.mjs` 依序跑完（成本遞增），它做兩件單支入口不做的事：**只 build
一次**、**清掉 `electron-vite dev` 洩漏到 shell 的環境變數**。它**不 fail fast** —— 付了十幾分鐘就該
拿到完整的一張圖。

**同一條紀律也落在探針之內**（`scripts/lib/sections.mjs`）：一個段落 throw 只讓那一段記為失敗，
其後段落照跑；宣告了前置的段落在前置失敗時標記為「未執行」而非連鎖紅燈。**總結會標示每支是否
完整執行 —— 不完整的那一輪，耗時不得拿來做最佳化判斷**（曾經有一輪 `probe:terminal` 的 dev 段
只跑了 10 段中的 1 段，而那個數字被拿去推導了一份與事實相反的方案，見 `docs/lessons/probes.md`）。

```bash
npm run probe:shell     # workspace-app-shell（視窗 + 信任模型 + preload 白名單）＋ the browser engine
                        #   opens no connection at startup (every host mapped to a local listener, with a
                        #   positive control — see docs/lessons/probes.md)
npm run probe:workspace # workspace-folders / filesystem-access / workspace-layout / repo-branch /
                        #   terminal-preferences（分支呈現與更新、repo 拖曳排序、Settings 對話框）
npm run probe:files     # file-explorer / file-viewer / 編輯 / CRUD / 導航防護 / worker / CSP
npm run probe:terminal  # terminal-sessions + session-persistence + GPU renderer
npm run probe:keyboard  # keyboard-navigation（切換、排序、按鍵不進 pty、對話框抑制、捲動）＋
                        #   **零 folder 的 workspace**（`checkEmptyWorkspace` —— 五條以「沒有任何
                        #   folder」為前提的 scenario 唯一的載體，橫跨 global-session／status-bar／
                        #   file-explorer；種有 folder 的環境對它們一律假綠）
npm run probe:insights  # conversation-archive / conversation-insights / conversation-report
                        #   （對話計量的 overlay 與掃描、讀後感分頁與授權畫面；
                        #   fixture 由產品的 testkit 產生，第一段先以已知數值釘住「掃的是 fixture
                        #   而非開發者本機的真實 transcript」—— 少了它，`CLAUDE_CONFIG_DIR` 沒傳
                        #   進去時每一條存在性斷言照樣全綠。**真實委派刻意不在裡面** ——
                        #   要網路、會花錢、回覆不可重現；產生路徑以注入的替身驗，
                        #   真實那段由 dogfood 認定，這條缺口寫在規格裡）
npm run probe:intake    # agent-intake / intake-routing（收件匣的兩條入口、純文字呈現、
                        #   routing 解析、接受→預填、忽略不建 session、活動列的計數標示、
                        #   通知的合併與內容、觸發通知→打開收件匣）
                        #   **通知走注入的替身後端**（以 `app.isPackaged` 為閘、路徑自 userData
                        #   推導 —— 不用環境變數：`ptyEnv()` 展開 `process.env`，一個環境變數
                        #   會進到每一個 pty）。少了它，**跑一次探針就會往開發者真實的桌面
                        #   噴一排通知**（`xvfb-run` 只換 `DISPLAY`，匯流排位址原封繼承）。
                        #   「通知真的出現在桌面上」「視窗真的浮到前景」兩條**沒有載體**，
                        #   由 dogfood 認定，缺口寫在規格裡
                        #   **唯一跨行程的那條斷言住在這裡**：畫面上那一列的 textContent 與
                        #   磁碟上 context 檔界線之內的內容必須逐字元相同 —— 主行程裡的單元
                        #   測試看不見呈現那一端，於是「正規化被搬到呈現層」對它是透明的。
                        #   **交接的三段也在這裡**（`runHandoff` / `runHandoffRestored` /
                        #   `runHandoffFailure`）—— 它是收件匣的第二個
                        #   producer，共用同一套替身與落點佈置。**`runHandoffRestored` 種
                        #   `sessions.json` ＋ 既有的落點目錄**：落點被重新準備之後還收不收得到，
                        #   只有「session 被還原」這個形狀驗得出來（新建落點是唯一沒壞的那一種）。
                        #   **母子關係的兩段**（`runLineage` / `runLineageDrag`）：替身回報每次
                        #   啟動拿到的 `--name` 與環境變數；拖曳一律三個以上兄弟、往下拖
                        #   對照組見 `scripts/intake-control-groups.mjs`（**61** 個 mutation，
                        #   每一個都指名哪一條斷言必須變紅；`section` 欄位讓它只跑需要的那一段）
                        #   **失敗的可見性也在這一支**：`TOO_LONG` / `TOO_LARGE` 的通知、
                        #   痕跡逐則呈現與逐則清除、痕跡活過重啟
                        #   **接受之前改選 folder 與已開好那一段的去留**（`runChooseFolder` /
                        #   `runOpenedLifecycle`）：session 開在哪裡一律讀 pty 行程的
                        #   `/proc/<pid>/cwd`；「缺了確認的 folder 就拒絕」直接呼叫 IPC ——
                        #   經畫面的斷言對主行程恆綠（停用的按鈕點不到它）
npm run probe:remote    # remote-access / remote-protocol / remote-notifications: the probe is the phone
                        #   (`lib/remote-client.mjs` pins the certificate; pairs with the code the dialog shows).
                        #   Listener ports come from `lib/ports.mjs`, never 47615 — the maintainer's own app may hold it
npm run probe:slack     # slack-intake-source / secret-scope（替身是**真的 HTTPS 伺服器** ——
                        #   產品的端點白名單只認 https，而那條不為驗收放寬。信任錨走
                        #   `NODE_EXTRA_CA_CERTS`：實測 `--ignore-certificate-errors` 無效，
                        #   因為主行程的 `fetch` 走 undici 而非 Chromium 的網路堆疊。
                        #   **即時路徑「收得到事件」那一半沒有載體**（替身回一個連不上的 wss），
                        #   真實 Slack 由 dogfood 認定 —— 兩條缺口都寫在規格裡）
npm run probe:agent-view # agent-transcript-stream / agent-event-bridge / agent-conversation-view /
                        #   agent-input-bridge（對話 view、注入的 hook 真的被執行、送出抵達 pty、
                        #   **重建後直接進對話 view 時 pty 的欄數不是 80**）
                        #   替身 agent 讀 `--settings` 並照著跑 hook 命令 —— **只斷言 argv 裡有
                        #   `--settings` 證明不了任何事**（實際踩過：命令有語法錯，每次都失敗而
                        #   事件目錄只是安靜地空著）。真實 agent 的委派刻意不在裡面，由 dogfood 認定
npm run probe:openspec  # openspec-data-access / openspec-panel / worktree 聚合 / side-panel-source
npm run probe:native    # native-module-toolchain（主行程載入 node-pty + spawn pty）
npm run probe:core      # spek-core-integration（主行程掃描 OpenSpec，且不開 TCP 埠）
npm run probe:identity  # app-identity（productName／appId／userData 路徑／視窗標題）

PROBE_ONLY=runMode:build npm run probe:terminal   # 只跑一個段落（迭代用；不設就跑全部）
                                                  #   terminal / keyboard / openspec 三支都支援。
                                                  #   指定的段落若宣告了前置，前置會被自動帶上。
PROBE_SKIP_BUILD=1 npm run probe:keyboard         # 只改探針腳本時跳過建置（會印警告與產物時間）
PROBE_DISPLAY=physical npm run probe:terminal     # 逃生口：畫在實體螢幕上
```

**`probe:package` 自成第三個成本層級 —— 它不在上面那十四支裡，也刻意不併進 `test:e2e`。**
它會先跑一次**完整打包**再啟動**真正的 AppImage**（其餘十四支驗的都是 `electron .` 載入 `out/`，
那不是被出貨的東西）。層級是「**換版前跑一次**」。

```bash
npm run probe:package   # 打包 → 啟動 AppImage → 產物可執行／脫離 repo／載入 renderer／
                        #   production CSP／pty 建得起來且指令真的被執行／建置身分與檔名同版
PROBE_PACKAGE_APPIMAGE=<path> node scripts/run-probe.mjs package   # 重用既有產物（迭代用）
npm run probe:package:mac   # on a Mac only: the app inside the dmg, launched from a desktop launch's minimal
                            #   environment; its key and menu sections need Accessibility + Automation
                            #   for the SSH session's program (`docs/lessons/macos.md`)
PROBE_PACKAGE_MAC_DMG=<dmg or .app> npm run probe:package:mac        # a trial or control build
```

> **跑一次 `probe:package` 會產生一個 `chore(release)` commit** —— 它的入口就是
> `npm run dist:linux`，而換版是那條指令的第一步。這是刻意的（一次打包＝一次換版），但**迭代時
> 一定要走 `PROBE_PACKAGE_APPIMAGE`**，否則調一支 probe 會在 master 上堆出十幾個 commit。
> 那些 commit 也會混進 `standup` 的輸出（它以 commit 作者過濾）。

**啟動前會檢查兩個前置條件**（`scripts/lib/preflight.mjs`）：建置產物在不在、該支要用的 debugging
port 通不通 —— 任一不成立就**立刻失敗並指出處置**，不進入那 30 秒的「等待 CDP target 逾時」。
兩者此前的失敗訊息一模一樣而處置相反，實測誤導過一次。**debugging port 一律宣告於
`scripts/lib/ports.mjs`**（加新探針要在那裡登記，`npm test` 擋重複與衍生）。

### 探針跑在虛擬螢幕上 —— 而那限定了驗收的效力

`scripts/run-probe.mjs` 把探針包進 `xvfb-run`（需 `sudo apt install xvfb`；缺了它會**明確失敗並說明
怎麼裝**，不會靜默改用你的螢幕）。虛擬螢幕沒有 GPU，探針以**軟體 GL** 執行 —— **它證明得了渲染資源
的生命週期，證明不了畫素**。框線相不相接、粗細一不一致只有真實驅動看得出來，那一類問題由 dogfood
認定。`terminal-sessions` 已把這條寫成規格：**自動化驗收通過 SHALL NOT 被詮釋為「程式化繪製的呈現
是正確的」**。

**第二條限制：探針不覆蓋「視窗不可見時」的行為。** 虛擬螢幕上 renderer 會被判定為不可見而
進入背景節流 —— **rAF 完全停擺**，於是 Monaco、xterm、選單全部不更新，而 CDP 往返照樣是 5ms
一次（**連線正常，只是畫面不更新**）。那曾經是三張票、七條紅、一次段落中斷。處置是啟動時一律
停用背景節流（`lib/display.mjs`，**與螢幕是虛擬或實體無關**），代價就是這條覆蓋缺口：
**任何要求「視窗不可見時仍如何如何」的 requirement 必須自備載體。**

> **看到一批「等畫面變成某個樣子」的等待同時落空，先問畫面時鐘有沒有在動**（`MOUNTED` 的
> `frameClock` 診斷、`awaitMounted` 的停擺說明），再問斷言對不對。

環境細節見 **`docs/lessons/probes.md`**（GL 旗標為何是承重的、`probe:identity` 為何不傳
`--user-data-dir`、`probe:files` 為何自己起 dev server、殭屍行程怎麼收、背景節流那一節的完整
現場與判讀規則）。


## Relationship to `spek`

- 開源的 [`spek`](https://github.com/spekhq/spek)（MIT）是 OpenSpec 內容檢視器 monorepo，本機
  clone 在 `../spek`。
- **本 repo 是獨立的 repo**（同樣以 MIT 開源），**不是** spek monorepo 的 npm workspace 成員。
- 重用 core 引擎與部分前端元件，詳見 `docs/PRD.md` §9。

### `@spekjs/core` 與 `@spekjs/ui`

core 發佈為 **`@spekjs/core`**（本 repo 宣告 `^1.13.0`），UI 套件為 **`@spekjs/ui`**（`^1.3.1`）。
改名的原因：`@spek` 這個 npm scope 已被他人註冊，本專案帳號無權發佈。

- **升 core 前先看 ui 的 peer 還滿不滿足** —— **不是「兩者必須同時升」**。`@spekjs/ui` 的 peer
  一路是 `@spekjs/core >=1.3.0`（1.2.0 與 1.3.1 皆然）：core 1.2.0 → 1.3.0 那次分兩步會
  `ERESOLVE`（peer 當時不被滿足），而 core 1.3.0 → **1.6.0** 那次 ui 一個字都不必動
  （`>=1.3.0` 涵蓋它）；core 1.7.0 → **1.10.0** 與 ui 1.2.0 → **1.3.1** 一起升同樣乾淨；
  core 1.10.0 → **1.13.0** 那次 ui 又是一個字都不必動（它本來就已是最新）。
  把它記成「一定要同升」的代價是實際的：要嘛做一次沒有必要的 ui 升級，要嘛以為升不了 core
  而放棄。
- **`@spekjs/ui` 對 core 是 peer 依賴** —— 升級後確認 npm **dedupe 成同一份** core（`npm ls
  @spekjs/core --all` 要看到 `deduped`），樹上若有兩份，套件眼中的 `ChangeInfo` 與我們的就是兩個
  不同型別。**要看輸出**：沒有 `ERESOLVE` 不等於只有一份。

**升 core 的檢查清單**（每一條都由實際咬過的版本推導出來）：

1. **grep「有沒有自己建構 core 的型別」** —— 1.1.0 對 `ChangeInfo` 加了 **required** 的
   `defaultSchema`，1.2.0 對 `WorktreeInfo` / `WorktreeSource` 加了 **required** 的 `vcs`。
   純**讀取** core 產出的值不受影響；自己 `.map()` 重建或手工組物件就 `TS2741`。
   spekterm 毫髮無傷是因為主行程把 core 的陣列**原封不動轉手** —— **這個「不重建」的性質是承重的**，
   日後若在主行程改寫 change 的欄位，就接下了同步 core 型別的義務。
2. **grep「有沒有呼叫聚合 API」** —— 修在 `scanOpenSpecAggregated` / `buildGraphDataAggregated` 的
   問題打不到 `scanOpenSpec`。「repo 有 worktree」不是觸發條件，「呼叫聚合 API」才是。
   （本 repo 自 `openspec-worktree-aggregation` 起已改用聚合版。）
3. **實測 optional 欄位何時被填，不要從語意推論** —— 這個 repo 兩次栽在這裡：假設 `source` 不在
   （結果在，含絕對路徑）、假設 `worktrees` 是空的（結果不是）。
4. **core 的列舉型別多一個值時，編譯器只攔得到轉手的那一處** —— 1.11.0 對 `ArtifactKind` 加了
   `'data'`（change 根目錄的 `.yaml` / `.yml` / `.json`）。`ChangeArtifactView.kind` 是窄化的字面
   union，於是 `openspec-service.ts` 那一行 `TS2322` 紅了 —— **但那是冰山一角**：消費端是逐一
   窮舉 kind 的（`ChangeView` 的 `ArtifactContent`），漏掉一個分支**不會紅**，畫面上是一個點得到
   卻空白的分頁。把 union 補上讓紅燈消失，就正好留下那個假綠。
   **同一次還有一條只有實測看得見的**：新的 kind 讓「`id` 補上 `.md` 就是檔名」這個既有假設失效
   （`asyncapi` 的檔案是 `asyncapi.yaml`）。1.12.0 新增的 `ChangeArtifact.file` 是正解，而它
   **每一個非 specs artifact 都被填**（已實測；specs 樹 absent，於是特判可由結構取代）。

**依賴一律宣告 npm 版本，不要把 `file:` / `link:` / `portal:` 寫進版控** —— 那會讓 CI 與
`electron-builder` 看到與開發者機器不同的依賴。本機要同步改 core 時用 `npm link` 覆寫。

## Tech Stack

Electron 43.5.0（釘死）+ electron-vite、TypeScript、React 19 + Tailwind CSS v4、
node-pty 1.2.0-beta.14（釘死）、Monaco Editor、chokidar 5、react-markdown + remark-gfm、
@xterm/xterm 6 + addon-fit / addon-web-links / addon-webgl / addon-serialize /
addon-unicode-graphemes、i18next、electron-builder（Phase 6）。

完整選型與理由見 `docs/PRD.md` §8.3。幾個容易踩的點：

- **node-pty 不需要 `@electron/rebuild`**（PRD 原本寫錯，Phase 0 實測推翻）。它是 Node-API 模組，
  prebuilt 的 `.node` 可同時被 Node 與 Electron 載入：Node 22 的 ABI 是 127、Electron 43 是 148，
  但兩者 N-API 同為 10。版本必須釘 1.2.0-beta 系列 —— npm `latest`（1.1.0）缺 Linux prebuild。
- **編輯器採 Monaco，且只取語法高亮**（`basic-languages/*` 的 monarch tokenizer），**不含任何
  `language/*` 語言服務**（`ts.worker` 單獨就佔 12.65 MB；含語言服務 21.51 MB、不含 8.81 MB）。
  深度改檔走 agent 或使用者自己的 IDE（PRD §6.2）。退守 CodeMirror 6 的成本侷限於
  `src/renderer/src/editor` 這個 wrapper 模組。
  - **Since monaco-editor 0.56 the entry points are `monaco-editor/editor`,
    `features/register.all`, and `languages/definitions/register.all`** (the old `esm/vs/...` paths
    no longer resolve through the package `exports`). Two silent traps from that upgrade: a language
    definition no longer pulls in the editor features, so `features/register.all` must be imported
    explicitly (without it find, folding, links and clipboard actions vanish with no error); and the
    lazy-grammar rule in `electron.vite.config.ts` matches the new directory, or every grammar lands
    in the initial `monaco` chunk — `measure:bundle`'s "several language chunks" check is what caught
    it. Typecheck, lint and unit tests were green on the broken upgrade; CI now builds and measures.
- **編輯器關閉 Monaco 的 native EditContext（`editContext: false`）**，改用經典的隱形 textarea。
  理由是**可驗收性**：native EditContext 的 `ime-text-area` **恆為 `readonly`**，與編輯器唯不唯讀
  無關 —— Phase 2 曾以它斷言唯讀，那對可編輯的編輯器**一樣會通過**。關掉之後 `readonly` 正確反映
  狀態，CDP 的 `Input.insertText` 也能真的打字。
- **`react-markdown` 的安全性來自預設值**：原始 HTML 降級為純文字、URL 由 `defaultUrlTransform`
  過濾。**絕不可加 `rehype-raw`、也不可覆寫 `urlTransform`** —— 檔案樹渲染的是使用者 repo 裡的
  任意 `.md`，那是不受信任的輸入。
- **終端封裝於單一 wrapper 模組**（`src/renderer/src/shell/terminal/xterm.ts`），與編輯器同一條
  約束：renderer 的其他模組不直接 import `@xterm/*`。**web-links addon 的開啟 handler 必須覆寫為
  走主行程的 `shell.openExternal`** —— pty 的輸出同樣是不受信任的內容。

## 產品身分（**已凍結，不要改**）

| | |
|---|---|
| `package.json` 的 `name` | `spekterm`（unscoped —— 本 package 是 `private`、不發佈） |
| `productName` | `Spekterm` |
| `build.appId` | `com.spekterm.app` |
| userData | `~/.config/Spekterm` |
| 視窗標題（`document.title`） | `spekterm` |

**`appId` 與 `productName` 一旦隨安裝檔發佈就凍結。** `appId` 進 macOS 的 `CFBundleIdentifier`
與 Windows 的 uninstall registry key —— 改動它的作業系統語意是「**發佈一個不同的 app**」：舊版不會
自動更新過去。`productName` 同理（它決定 userData 的落點，改了＝所有人的設定失聯）。

- **`app.getName()` 優先讀 `productName`、缺才退回 `name`** —— 正名前沒有 `productName`，於是退回
  當時那個 **scoped** 的 `name`，scope 名直接成了路徑的一層，造出帶 `@` 的巢狀 userData 目錄。
- **品牌書寫全小寫（`spekterm`），但 `productName` 首字大寫（`Spekterm`）** —— 後者是作業系統的
  顯示名稱（Dock、安裝檔名），那些位置的慣例是專有名詞。兩者不需一致。
- **`npm test` 有一條守衛**（`scripts/naming.test.mjs`）：版控中不得殘留舊名，`archive/` 除外。
  它的對照組要求「**不排除** archive 時必須命中舊名」—— 少了這條，`git grep` 的 ANSI 顏色碼曾讓
  路徑比對靜默失準而全綠。

> **`spekterm.com` 與 `spekterm.app` 已購入**（2026-07-12，Cloudflare，到期 2027-07-12）——
> `appId` 的風險就此關閉。`com.spekterm.app` 是反寫 `spekterm.com`，若該 domain 落入他人手中，
> 這個**已凍結**的 appId 就變成在宣告別人的命名空間，且事後**無法以改 appId 化解**。
> **因此續約不是行政瑣事，是承重的。** The website (`site/`, served at `spekterm.com`) depends on it too.

**GitHub 位置（`spekhq/spekterm`）不是凍結身分的一部分** —— repo 改名與 transfer 皆自動 redirect。
但 **npm scope 仍是 `@spekjs`，不要「順手對齊」成 `@spekhq`**：GitHub org 名與 npm scope 不一致是
常態（`@tailwindcss/*` 的源碼在 `tailwindlabs/tailwindcss`）。

## Workflow

- **所有變更都必須使用 OpenSpec 工作流程**：proposal → design → tasks → 實作。
  以 `/openspec-new-change` 或 `/opsx:new` 建立，`/openspec-verify-change` 驗證，
  `/openspec-archive-change` 封存。
- **Archive 時必須**：更新相關文件（CLAUDE.md、`docs/lessons/*`、README 等若有影響），並建立 git
  commit。**新教訓要照上面那兩條判準決定寫進哪一份** —— 全部堆回 CLAUDE.md 的話，它會再長回來。
- **Archive 時 `tasks.md` 必須全部打勾** —— 做完，或**明確轉為 issue** 並把那一條改寫成
  「本 change 不做，已轉為 issue #N」再打勾。**一個帶著未打勾方框的已封存 change，等於宣稱自己
  完成了卻沒有**，而那些缺口從此不在任何工作清單上。「已知的缺口」與「被追蹤的缺口」是兩件事。
- **A change that alters documented behavior updates the website's docs in both languages**
  (`site/src/content/docs/` and `zh-tw/`) in the same change — the build only checks that both
  languages have the same pages, not that they say the same thing or are current.

開發路線圖見 `docs/PRD.md` §11。每個 change 的完整論證見
`openspec/changes/archive/<date>-<slug>/`，**目錄名本身就是索引** —— 不必在這裡維護一份清單。

## Conventions

- **English is the single source of truth for everything committed to the repo** (same rule as `spek`,
  adopted when the repo went public): code, comments, `openspec/` artifacts, `docs/`, community
  files, and commit messages. The maintainer may think and draft in Traditional Chinese, but what gets committed is
  English. **Existing Chinese comments, docs, and commit messages stay as they are** — no wholesale back-translation or history rewrite — but
  anything new is English, including new sections added to this file. Exceptions: the README is
  bilingual (`README.md` + `README.zh-TW.md`, kept in sync); the UI's `zh-TW` dictionary; the
  website's Traditional Chinese files (`site/src/content/docs/zh-tw/**`, `site/src/i18n/zh-TW.json`);
  and conversation with the user, which stays in Traditional Chinese.
- **UI 文案為英文，且一律來自字典**（`src/shared/i18n/en.json`）—— 見下文「UI 文案與 i18n」。
  （舊的繁中註解與這條是分開的兩件事，而它們曾經混在一起：作者一邊用中文寫註解，一邊很自然地
  把中文寫進 `aria-label`。）
- 本 repo 的 Node 版本固定在 `.nvmrc`（22.22.0），與 `../spek` 一致
- **repo 是公開的（MIT）。不要寫進維護者任職公司的內部名稱、同事的名字、維護者的家目錄路徑** —— 包括 dogfood
  紀錄、實測數字的出處、測試 fixture。範例一律用通用名（`api-server`、`@alex`、`/home/me`）。
  `scripts/public-hygiene.test.mjs` 擋著，**且不排除 archive**；它的清單是雜湊，紅了只印雜湊前綴，
  明文清單在維護者本機（`~/spekterm-oss/`），不在 repo 裡。**這條最容易在「照著使用者的全域設定或 memory
  寫實測紀錄」時被違反** —— 那些地方正寫著那些名字。

## 快捷鍵

| | |
|---|---|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 當前 **rail 項目**內的下／上一個 session（**分頁位置序**，可循環）。**Focus inside the side panel's change view: next / previous artifact instead** — `KeyboardNavigation` hands the key to the view (`tab-cycle-scope.ts`), so the dialog/menu rule stays in one place |
| `Ctrl+↓` / `Ctrl+↑` | rail 上的下／上一個**項目**（可循環，**涵蓋全域項目**；尚未選中時選第一個） |
| `Ctrl+T` | 開啟建立 session 的入口（spawn 選單，可全鍵盤操作） |
| `Ctrl+Shift+W` | 關閉當前 focused 的 session |
| `Ctrl+Shift+H` | Hibernate the focused session (end its process, keep it dormant in the workspace). Effective with focus in the editor; suppressed while a dialog or menu is open |
| `Ctrl+Shift+M` | Maximize / restore the side panel (covers the session tabs and the terminal; the rail stays). Effective anywhere, terminal and editor included; suppressed while a dialog or menu is open |
| `Shift+↓` / `Shift+↑` | 把**選中的 repo** 在 rail 上移動一格（**不循環**；全域項目上無操作）。**置頂段與其餘之間的分界算一格** —— 跨過它即改變置頂狀態，而該 repo 在畫面上幾乎不動 |
| `Shift+→` / `Shift+←` | 把 **focused session** 在分頁列上移動一格（**不循環**） |
| `Ctrl+P` | **側欄持有焦點時**開啟檔案快速搜尋。**終端持有焦點時讓路給 pty** |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | 終端的複製貼上（macOS 用 `Cmd`） |
| `Cmd/Ctrl+S` | 存檔 |
| `Esc` | 關閉 overlay／對話框／選單 |

**原生 menu bar 已整個移除**（`Menu.setApplicationMenu(null)`，app 層設一次涵蓋整個應用程式）——
**不是** `autoHideMenuBar`，那只是「平時隱藏、按 `Alt` 浮出」，而 app 從未定義任何 menu 內容，
浮出來的是一條空的東西擋畫面。**macOS is the exception** (`src/main/app-menu.ts`): there the menu bar
belongs to the system, and `Cmd+C`/`Cmd+V`/`Cmd+Q` come from its items, so macOS gets a minimal app menu
and Edit menu. Its Quit is **not the Quit role** — that quits through `before-quit` first, which the
close guard reads as a signal and would end every session without asking. The menu is set once per
process in `whenReady`, never in `createWindow` (macOS opens a second window after the first is closed).

### 攔截點是 window 的 **capture 階段**

終端幾乎永遠持有焦點，xterm 會把按鍵直接寫進 pty，Monaco 也會吃鍵。**但這不代表 window listener
沒用** —— 既有的 `Ctrl+S` 之所以被迫註冊在 Monaco 內部，是因為它註冊在 **bubble 階段**，Monaco
攔下該鍵並停止傳播，它永遠冒不到 window。**capture 由 window 往下傳，早於 xterm 與 Monaco 綁在各自
DOM 節點上的 listener** —— `stopPropagation()` 一下，兩者都收不到，被攔下的按鍵也不會流進 agent。

**`Ctrl+P` 是例外，它掛在側欄容器的 capture 階段而非 window。** 「焦點在側欄之內」**就是**「按鍵
事件行經側欄容器」，那是 DOM 事件傳播的定義。終端與側欄是兩塊**並列的 Panel、互不為祖先**，xterm
的按鍵又來自它自己的隱形 textarea —— 事件根本不會行經側欄。**不需要任何「如果焦點在終端就不處理」
的判斷。**

### 每一顆鍵的代價都不同種 —— 不要混為一談

- **`Ctrl+Tab` 是白撿的。** 它在標準終端編碼下**送不出去**（`Tab` 就是 `Ctrl+I`＝`0x09`），
  pty 內零損失。GNOME Terminal、iTerm2 敢拿它切分頁正是這個原因。
- **`Ctrl+Shift+<字母>`（`Ctrl+Shift+W`／`H`／`M`／`C`／`V`）代價確定為零** —— 在終端協定裡編碼不出來。
  **選 Shift 版而非 `Ctrl+W`**：後者在 zsh 是 `backward-kill-word`、bash 是 `unix-word-rubout`。
- **`Ctrl+↑/↓` 送得出去**（`CSI 1;5A`/`B`），攔截它等於從 pty 裡的程式手上**永久沒收**這顆鍵。
  實測 zsh 與 bash 皆未綁定；**唯一的犧牲者是 tmux**（pane resize、copy-mode 捲動）—— 而這個 app
  本身就要取代那個用途。
- **`Ctrl+T` 最貴，採用它有兩個前提。** zsh 與 bash readline 都把它綁成 `transpose-chars`。
  可以拿是因為：(1) 使用者的 GNOME Terminal 本來就把它拿去開新分頁了；(2) **`claude` 沒有使用它**。
  > 此結論有前提。日後若 `claude` 開始使用 `Ctrl+T`，本裁決即失效。退路 **`Ctrl+Shift+T`** 成本為零。
- **`Shift+arrow` 是「明知主場在用仍然拿走」。** 實測 zsh 與 bash 未綁定，但**已知的犧牲者正是
  `claude` 自己的 agents view**。使用者在知情下裁決採用（排 repo 的頻率遠高於用那個 view）。
  > 此裁決有前提。退路 **`Ctrl+Shift+arrow`**（`CSI 1;6A`–`D`，實測 shell 亦未綁定，且與 `Ctrl+↑↓`
  > 成對：Ctrl ＝ 移動游標，加 Shift ＝ 移動東西）。**改鍵位只動 `KeyboardNavigation.tsx` 的一個
  > 判斷 + spec + probe**，沒有任何資料格式綁在鍵位上。
- **`Ctrl+P` 讓路給 pty**：實測 `claude` 以它顯示 previous history，而 agent 是這個 app 的主場。
  使用者裁決只做焦點判定版；退路 `Ctrl+Shift+P` 成本為零。
- **`Ctrl+Alt+↑/↓` 不能用** —— Linux 上被 GNOME 拿去切工作區（被拿走的是 `Ctrl+Alt+方向鍵`，
  不是 `Ctrl+方向鍵`）。
- **`Ctrl+C` 絕不挪用** —— 它必須維持中斷訊號。agent 跑失控時要中斷它的能力，不能因為畫面上剛好
  有一段選取就失靈。

### 四條跨快捷鍵的規則

- **四顆 session 快捷鍵的作用域是「rail 上選中的項目」，不是「選中的 repo」。** 那四條 requirement
  各帶一句「沒有選中的 repo 時 SHALL 為無操作」—— **那是行為條款而不是措辭**，照字面實作會讓全域
  項目上四顆鍵全部失效，而型別檢查對此完全無感。
- **對話框開啟時抑制快捷鍵，以 `[role="dialog"]` 的存在判定** —— 任何遵守這個無障礙慣例的新對話框
  自動被尊重，不必記得去某份清單註冊。代價是**漏掉 `role` 的對話框會靜默失效**，因此驗收須以
  **多種**對話框各驗一次（session 命名、files 的、收件匣的全視窗 overlay —— Graph／Timeline 已不再是對話框）。這條紀律寫在
  `keyboard-navigation` 的 spec 裡。`Ctrl+P` 的抑制判準與作用域必須與此**完全一致**（document-wide、
  同時看 `[role="menu"]`）—— 兩者若分歧，不會有紅燈。
- **排序快捷鍵有一條導航快捷鍵沒有的例外：可編輯文字讓路。** `Shift+arrow` 就是文字選取鍵，
  全域 capture 攔下它，Monaco 連選一個字元都做不到。**判準不能寫成「activeElement 是不是
  textarea」** —— xterm 與 Monaco 的輸入路徑**都是** textarea，那樣寫排序快捷鍵會在終端持有焦點時
  （也就是絕大多數時間）**靜默失效**。兩段式：**先問「在不在 `.xterm` 之內」**，再問是不是
  input／textarea／contenteditable。兩個相反的失效方向都要驗。
- **選單必須能全鍵盤操作，這不是加分項而是前提。** 用快捷鍵叫出一個只能用滑鼠點的選單，等於沒做
  這個快捷鍵。`ContextMenu` 因此有「焦點落在第一項 / `↑↓` 循環 / `Enter` 觸發」，並且**必須有
  `focus:` 的視覺樣式**。它是共用元件（分頁右鍵、檔案樹右鍵、spawn 選單）—— 動它要跑
  `probe:terminal` 與 `probe:files` 回歸。
- **`Ctrl+T` 走「啟動既有的建立入口」**（`querySelector` 找到它並觸發），不自己算座標 —— 於是鍵盤
  叫出的選單與滑鼠點出來的**錨定在同一個地方**，spawn 選單的狀態也不必從 `SessionTabs` 搬出來。

### 選取或焦點改變時，目標要被捲進可視範圍

rail 縱向 + 分頁列橫向。此前 renderer **一個 `scrollIntoView` 都沒有** —— rail 超出視窗時按
`Ctrl+↑↓`，切過去了卻看不到，使用者會直接判定快捷鍵壞了。

- **`block: 'nearest'` 不會順便讓滑鼠點選免於捲動。** `nearest` 只保證「**完全**可見就不捲」——
  部分可見的元素它會捲最小的量把它補齊，於是點下緣那半截的列，**那一列會在游標底下跳走**。
  滑鼠的例外是一條真的要寫的路徑（`useScrollIntoView`），不是免費的副產品。
- **判定是「最後一次輸入來自哪裡」，不是「消費一次旗標」。** 直覺寫法（pointerdown 設旗標、effect
  讀完即清）會被一次**沒有造成狀態改變**的點擊留下殘值（點已選中的列、點捲軸、點空白處都不觸發
  effect），下一次可能就是 `Ctrl+↓` —— 症狀是「第一次沒捲、第二次才捲」。
- **作用域是單一容器，不是整個 renderer。** 在 rail 點一列 session 之後，**分頁列仍應**把對應分頁
  捲進視野。rail、rail 的每一塊、分頁列**各持有一份**。

## 檔案系統邊界與信任模型

renderer 以 `(folderId, relPath)` 定址檔案系統，**永遠不傳絕對路徑** —— 它沒有詞彙可以表達
workspace 之外的位置。邊界檢查一律在**主行程**執行；preload 與 renderer 同屬一個行程樹，在那裡
檢查等同沒有檢查。

- **包含關係一律用 `path.relative(root, target)` 判定，絕不用 `target.startsWith(root)`。**
  前綴比對會把 `/a/bc` 誤判為位於 `/a/b` 之內。`src/main/fs-boundary.test.ts` 有一條測試就是為了讓
  這個寫法必定失敗；不要「簡化」掉它。
- **symlink 必須在比對之前解析**（root 與 target 兩端都要 `realpath`）。
- **讀取路徑（`resolveWithinRoot`）與寫入路徑（`openExistingForWrite` / `resolveNewWithin`）分家，
  不可混用。** 讀取回傳一個路徑，呼叫端拿去 `open`；寫入若沿用這個「檢查完再依原路徑開啟」，
  已實測會逸出邊界（check 與 open 之間 leaf 被換成越界 symlink）。寫入必須解析與開啟不可分割：
  對 `realpath` 的結果、帶 `O_NOFOLLOW` 開啟。
- **TOCTOU 與 hard link 以威脅模型承擔，不是機制性防護。** Node 沒有 `openat`，`O_NOFOLLOW` 只約束
  最後一段。關鍵在**白名單不暴露 `symlink()`、寫入的 leaf 檢查一律用 `realpath`（不是 `lstat`）**
  —— renderer 既造不出、也操縱不到 race 所需的 symlink。這道邊界防的是**被入侵或有 bug 的
  renderer**，不是已拿到本機寫入權的攻擊者。
  > **此結論有前提。** 任何後續 change 若要暴露 `symlink()`、或把寫入 leaf 檢查改為 `lstat` 語意，
  > 本論證即失效，必須重新論證。完整論證見 `file-editing-and-crud` design D1–D8（`O_NOFOLLOW` 為
  > POSIX-only，Windows 退為 `lstat` 二次確認，且**本 repo 無 Windows 實測**，列為 Phase 6 打包
  > 驗收前必須確認的項目）。
- **原地寫入，不做「暫存檔 + 改名」。** 後者會把 folder 內的 symlink 取代成普通檔案、斷開 hard
  link，並讓一次存檔在 watcher 上呈現為「刪除後新增」（已實測）。
- **watcher 一律經 `src/main/watcher.ts` 建立** —— 它是 chokidar 的唯一入口，`followSymlinks: false`
  與錯誤回報都在裡面，**不由呼叫端決定**。兩道守衛：eslint 擋靜態 import（型別放行）、
  `scripts/watcher-source.test.mjs` 擋動態 import、擋入口 re-export chokidar 的**值**、擋
  `followSymlinks` 出現在別處。三個站點曾各自建構，於是演化出三種錯誤姿態，其中
  `branch-service` 根本沒掛 handler —— Node 對沒有 listener 的 `'error'` 直接 throw，
  **主行程一死所有 pty 陪葬**。
  - **輪詢判定的依據路徑：預設等於監看目標，`pollingRoot` 是給服務多目標的 watcher 的例外。**
    `shouldUsePolling(p)` 判定的是 **`p` 所在掛載點**的檔案系統。**四個建立點裡三個是一對一**
    （`branch-service` 兩層、`openspec-service`），正確答案就是自己的 `target` —— 所以省略。
    餵錯路徑會讓「gitdir 在網路檔案系統」靜默退回 native watch，而**那種失效連錯誤 handler 都
    救不到**（`fs.watch` 只是永遠不觸發，沒有錯誤可 emit）。
    - **`watch-service` 是唯一顯式傳 `pollingRoot` 的地方**（它一個 watcher 服務 N 個動態增減的
      子目標）。**孤例看起來很像可以順手清掉的殘留**，而本機刪掉它不會讓型別、測試或探針變紅
      —— `watch-service.test.ts` 有一條專門釘住它的測試，別繞過。
    - **「共同根」只在該根與所有目標同掛載點時成立** —— 路徑包含不是同一檔案系統的保證
      （folder 內掛載網路儲存、bind mount）。單一 watcher 的 `usePolling` 建構時就定了，服務跨
      掛載點的多目標**結構上無解**，已登記為缺口。也因此那個站點的驗收只驗得到參數：**一個規格
      宣告不支援的組態，驗收造不出來。**
    - **驗收造得出對比，不要以為造不出。** 本機 `/proc/mounts` 有 FUSE 掛載點，core 對 `fuse*`
      一律判定需要輪詢，且**路徑不需要存在**（`realpath` 失敗時沿用原字串比對）。
      `polling-mount.testkit.ts` 負責探測，並**自檢對照組**（環境覆寫會讓所有路徑一起變 true，
      那時鑑別力已經沒了，必須 skip 而不是通過）。
  - **`label` 同理不能一律用 `target`**：一個 watcher 服務多個目標時，chokidar 的錯誤事件不指出
    是哪一個失敗。
- **watcher 受同一道邊界約束**：`followSymlinks: false`（它**預設是 `true`** —— folder 內一個指向
  `/etc` 的 symlink 被展開時，watcher 會走出去，把邊界外的檔名經事件推給 renderer），且事件的絕對
  路徑轉成 `(folderId, relPath)` 之前必須**再過一次 `isWithin`**。**且 app 自身的寫入不得回推為
  外部變更事件** —— 否則每次存檔都會警告使用者磁碟被改動。
- **`slug` / `topic` 是不受信任的輸入 —— 查表，不要過濾字元。** 它們來自 renderer，且會被 core
  拿去**拼接檔案路徑**。防護是白名單：先在快取的掃描結果裡查表，只對確實存在的 identifier 呼叫
  core。這比「檢查有沒有 `..`」強（後者是黑名單）。與 `fs.*` 的路徑邊界**互補而非重複** —— 那道防
  relPath，這道防 identifier。

### 兩條 Phase 2 的實測，至今仍是承重的

- **「一個樹上的路徑對應一個被監看的目錄」是錯的。** folder 內指向 `sub/` 的 symlink，在樹上是兩個
  節點、在磁碟上是同一個目錄，而 chokidar 只認絕對路徑。訂閱（樹上的 relPath）與監看（磁碟上的
  realpath）必須分層並以**參考計數**對接，事件也必須**以訂閱者使用的路徑改寫**後才推送 —— 否則收合
  其中一個節點會停掉另一個的監看，而經 symlink 展開的節點永遠收不到事件。
  **驗收 fixture 裡沒有 symlink，這個 bug 就會躲過整輪全綠的驗收。**
- **主行程拋出的錯誤帶不了 `code` 到 renderer。** Electron 的 IPC 序列化**只保留 `message`**，
  自訂屬性一律遺失。需要結構化的失敗資訊（錯誤碼、檔案大小與上限）時，要在 IPC 接縫上改回傳
  `{ ok: false, code, detail }` 結果物件。純邏輯層仍然拋錯。

### 列舉檔案（`quick-open` 的 `listFiles`）

首選 `git ls-files`，失敗或不適用時退回手寫遞迴列舉。四個實測踩雷：

- **`fs.readdirSync` 與 `fs/promises.readdir` 對同一個 `{ recursive: true }` 行為不同。** 前者**會**
  走進 symlink 目錄（列出邊界外的檔名、讓同一個檔案出現兩次），後者**不會**。第一版的對照組用了
  promises 版，於是**天真實作與正確實作的結果完全相同、對照組沒有變紅** —— 我差點據此認為「邊界會
  從 symlink 漏掉」是個假警報。**結論是手寫遞迴**（只在 `dirent.isDirectory()` 為真時下鑽），
  而理由比原本更強：一個在兩個同語意 API 之間不一致、且未見於文件的行為，不該拿來當邊界防護的依據。
- **git 的錯誤訊息會被在地化。** 這台機器的 git 講繁體中文（「致命錯誤: 不是一個 git 版本庫」），
  於是 `/not a git repository/i` 匹配不到 ⇒ **每一個非 git 目錄都被判成「列舉失敗」**。spawn 時設
  **`LC_ALL=C`**。這與「比對 git 輸出一律加 `--no-color`」是同一族，旋鈕從顏色換成語言。
- **`git ls-files` 預設 `core.quotePath=true`** —— 非 ASCII 檔名會被 C-quote 並包上雙引號。失效方式
  是清單裡那一筆看起來像亂碼、選了之後讀檔回「找不到」。用 **`-z`**（順帶解決檔名含換行；
  `-c core.quotePath=false` 只解決前者）。
- **`git ls-files` 在被 `.gitignore` 涵蓋的目錄裡 exit 0 且無輸出** —— 在 exit code 上與「成功」無法
  區分。使用者既然正在那裡工作，把它呈現為空是錯的，因此「成功但為空」也退回保守列舉。
- **git reports entries that are not files, in shapes that differ by source.** A nested worktree or
  repo comes from `--others` with a trailing `/`; a submodule (gitlink) and a symlink come from
  `--cached` as bare paths; a conflicted file comes once per stage. Hence tracked entries go through
  `--stage` and a mode **allow-list**, and "git printed nothing" is judged on the raw output — a list
  that only became empty after filtering must not reach the conservative walk, which descends into
  nested working trees. **And a machine can hide the worktree shape entirely**: the default excludes
  file `$XDG_CONFIG_HOME/git/ignore` (fallback `~/.config/git/ignore`) — the maintainer's ignores
  `.claude/worktrees/`. `GIT_CONFIG_GLOBAL=/dev/null` alone does not turn it off; point
  `XDG_CONFIG_HOME` at an existing empty directory (an empty string falls back to `~/.config`).
  `fs-service.test.ts` does both for the whole file (issue #55: green locally, red on CI).

**模糊比對的兩條**：貪婪掃描會把查詢的開頭浪費在目錄名上（`score` 對 `src/score.ts` —— `s` 與 `c`
被 `src` 吃掉，分數低到排在一個人工的 `s-c-o-r-e.ts` 之後）。修法是**先只在檔名上比對**，命中就加一
個大的 bonus —— 那同時實現了「檔名命中優先」這條 requirement。另外**連續命中的權重必須大於詞邊界
獎勵**，否則「每個字元都落在 `-` 之後」的散落命中會勝過連續命中。

### git 分支（`repo-branch`）

rail 的每一列顯示該 folder 的 git 當前分支。**以讀取 `.git/HEAD` 實作，不 spawn `git`** —— 這是每個
folder、每次載入都要做的判定，與 `hasOpenSpec` 同一條理由（也因此 `workspace-folders` 那條「偵測
SHALL NOT 呼叫任何外部程式」依然成立）。`.git` 是**檔案**時（worktree / submodule）要解 `gitdir:`
那層間接：worktree 寫絕對路徑、submodule 寫相對路徑，兩種都要吃。

**監看分支要兩層 watcher，兩者都反直覺（實測）**：

- **`git checkout` 是寫 `HEAD.lock` 再 rename 上去**，HEAD 的 inode 每次都變。直覺會認為監看單一檔案
  的 watcher 第一次就失聯 —— **但 chokidar 撐得住**（會在 rename 後重新 attach，連續切三次分支三次
  都收到 `change`）。所以**監看單一檔案即可**，不必退而監看整個 `.git/`（那會被 `index.lock`、
  `refs/`、object 寫入的事件淹沒）。
- **但監看一個「尚不存在」的 `.git/HEAD` 是行不通的** —— `git init` 之後 800ms 內收不到任何事件
  （連父目錄都不存在，chokidar 無從 attach）。因此**第一層**監看 folder 根目錄（恆常存在，`depth: 0`，
  以 basename `.git` 過濾），用來等 `.git` 出現或消失，再據以建立／銷毀**第二層**。

**而家目錄要跳過 git 狀態偵測。** 那條路上有一個 `spawnSync` 且每 2 秒一次 —— dotfiles-as-git-repo
是常見設定，於整個家目錄跑它會**週期性阻塞主行程**。cwd 恰為家目錄時不做。

### 幾道不屬於 `fs.*` 白名單、但同樣承重的邊界

- **導航防護是渲染 markdown 的前提，不是加分項。** preload 綁在 `webContents` 上，**每次導航後都會
  重新注入，不分來源**。使用者 repo 裡一個 `[click](https://evil.com)` 就能把 renderer 帶去遠端
  頁面，而那個頁面的 `window.workspace.fs` 就是我們的檔案系統白名單。
- **`did-start-navigation` 不可當作 renderer 重新載入的訊號。** 它與 `will-navigate` 對同一次導航
  都會觸發，`preventDefault()` 只是隨後取消它 —— 於是每擋下一次導航，就會順手把該 renderer 的所有
  watcher 關掉（已實測）。要用 `did-navigate`。**「導航開始」不等於「導航發生」。**
- **`did-navigate` 不只要清 watcher，也必須殺光 pty。** reload 不銷毀 `webContents`，只掛
  `'destroyed'` 的清理不會觸發 —— 舊 pty 會變孤兒，且新頁面的 xterm **永遠收不到它們的輸出**。
- **terminal 的 cwd 邊界不是沙箱。** `create` 只收識別碼、不收路徑（renderer 在語彙上無從指定
  workspace 外的 cwd），但這**只約束初始 cwd** —— pty 起來之後使用者可以 `cd` 到任何地方，那正是
  終端的用途。**不要把它與 `fs.*` 白名單的沙箱語意混為一談。**
  - **全域 session 與「把 `~` 加進 workspace」的差別是全部的重點**：後者會把 `fs.*` 白名單與 Files
    檔案樹對整個家目錄開放；全域 session 只改變 pty 的初始工作目錄。**`filesystem-access` 因此
    一條未改** —— 家目錄不是任何 folder，renderer 一個位元組都讀不到它。
  - **git 分支要讀的 gitdir 常在 folder 邊界之外**（worktree / submodule）。那是主行程自己的檔案
    存取，不經 renderer 的 `(folderId, relPath)` 詞彙 —— **不是白名單的擴大**，推給 renderer 的只有
    分支字串。
- **`clipboard.readText()` 沒有 workspace 邊界可言**（裡面可能是剛複製的密碼）。可接受的前提有二：
  導航防護確保 renderer 不會變成別人的頁面；且只在使用者明確要求貼上時讀取，不主動、不輪詢。
- **`clipboard:writeText` 需要型別 guard** —— 它是 fire-and-forget 的 `ipcMain.on`、無回應通道，
  非字串會讓 `clipboard.writeText` 拋 `TypeError` → 主行程未捕捉例外（真實 Electron 行程會跳原生
  錯誤對話框）。

### 工作目錄識別碼：三個前提**各自擔保不同的事**

session 開得進 worktree 之後，邊界保證從「renderer 沒有路徑詞彙」換成「**不可逆識別碼 + 主行程
查表**」。第一版 design 把三個前提寫成「缺一不可」，**那是錯誤的推理**：

| 前提 | 擔保什麼 | 破壞它會怎樣 |
|---|---|---|
| 解析是**查表**、來源是 **git 的列舉** | **圍堵性** | 可達集合不再受限於列舉結果 ⇒ 邊界失守 |
| key **不可逆**（sha1 前 8 碼） | 路徑不外洩到 renderer | 洩漏路徑，但**可達集合一點也不會變大** |
| 查無此 key **即拒絕**，不 fallback | **誠實性** | 退回 folder 根逸出不了任何邊界，但使用者會以為 session 開在他選的地方 |

**為什麼要分清楚**：日後任一條被鬆動時，得能判斷「這會不會破壞邊界」。捆成一句「缺一不可」就沒有
判準可用了。

- **落盤禁路徑的理由是獨立的**：那些內容**下次啟動時會被解析**，一個落盤的路徑等同一個繞過查表的
  位置指定。於是定址可以用 folder-relative 路徑（renderer 的合法詞彙），**落盤只能用識別碼**。
- **兩道夾制，只放寬一道等於沒放寬**：`#initialCwd`（重建側）與 `cwdOf()`（**記錄側**）是獨立的
  兩道。只放寬前者的話，`cd` 到邊界外 worktree 的位置**從一開始就不會被寫進 `sessions.json`**，
  重建側收到 `undefined`，一切看起來正常。**失效方向是靜默的。**
- **folder 自身以「省略識別碼」表示** —— folder 不在版控之下時 `listWorktrees` 回空陣列，**根本
  沒有 key 可放**。

### 機密的四條出口

應用程式代使用者持有的憑證（`secret-store.ts`），其**唯一**可接受的流向是「它所屬的那個服務」。
四條出口逐一被堵住，而**每一條的失效都是靜默的**（沒有錯誤、沒有型別問題）。完整的實測細節與
三個「第一版沒有鑑別力」的斷言見 **`docs/lessons/slack.md`**。留在這裡的只有跨模組的那一條：

- **`process.env` 的指派只允許 `user-env.ts`**（`scripts/secret-scope.test.mjs` 守著）。
  `ptyEnv()` 展開 `process.env`，所以**任何模組往它寫一個值，那個值就會進到每一個 pty** ——
  而那個模組不必是 `terminal.ts`、也不必被它 import。這條規則 CLAUDE.md 早就寫著
  （見「終端與 pty」一節），但**此前沒有任何東西在守**。
- 那道守衛豁免 `user-env.ts`（唯一的套用點），而那個缺口由一條行為測試補：pty 環境的任何一個值
  都不含機密。**兩者互補而非重複**，已實測配對。

### CSP

由**主行程**施加（`webRequest.onHeadersReceived`），不是 renderer 自宣告的 `<meta>` —— 與 fs 邊界
同哲學：renderer 渲染不受信任內容，它自己宣告的約束不構成防護。已實測 `onHeadersReceived` 對
`file://` response 確實觸發。

- **切換依 `ELECTRON_RENDERER_URL` 的存在，不是 `app.isPackaged`。** 後者只有真正打包後才為 true，
  於是「未打包但載入 `file://` build 產物」會**誤發 dev 政策**，更糟的是 **production 政策從此沒有
  任何 probe 覆蓋**（probe 永遠 `isPackaged === false`）—— 一個經典的假綠。
- `style-src` 的 `'unsafe-inline'` 無法避免（Monaco／xterm／Tailwind v4 都在執行期注入 inline
  `<style>`）；`script-src` 維持 `'self'`（建置產物無 `eval`）；**`img-src` 放行 `https:`** ——
  markdown 本就該能載入遠端圖片，而 beacon 是低嚴重度（洩漏「開了這個檔」＋ IP，無程式執行／邊界
  逸出），使用者本就在這些 repo 裡跑 agent。**`http:` 不放行**（順帶擋掉對 `http://localhost` 的
  image-GET 探測）。

## 終端與 pty

`node-pty` 的 spawn 與生命週期、pty 環境必須抹掉的那個變數、`claude` CLI 的實測結論、session 的重建
與自癒、標題與命名權、複製貼上與滑鼠、GPU 渲染、字元寬度、字型偏好 ——
全部在 **`docs/lessons/terminal.md`**。

**動 pty、`shell/terminal/` 或 session 持久化之前把它讀完。** 那一整份的失效方式幾乎都是靜默的：
續接功能悄悄失效而使用者拿到一個能用但永遠全新的對話、pty 一輩子停在 80×24、關一次視窗
`sessions.json` 就被清空。

留在這裡的只有一條，因為它跨到啟動流程、而且踩到它的方式是「順手加一行」：

- **使用者的 shell 環境於啟動時取得一次，但只有 `PATH` 進 `process.env`** —— 其餘（API 憑證、
  服務端點、工具鏈設定）由 `user-env.ts` 持有，只在 `ptyEnv()` 建構 pty 環境時合併。
  **絕不要「順手」把它們也 `Object.assign` 進 `process.env`。** 主行程的環境決定應用程式自身的
  行為，而 `app.getPath('userData')` 與 CSP 的 dev／production 判定都在 `whenReady` 內求值 ——
  與使用者 rc 的執行速度形成競賽（實測窗口約 220ms，一個精簡的 `.zshrc` 只要 0.02–0.24s）。
  一個被注入的 `XDG_CONFIG_HOME` 會換掉 userData 的落點：**所有 repo 與 session 消失，而它們的
  pty 還活著**。
  - **「只在原本不存在時才加入」這條規則救不了它** —— 實測桌面環境啟動的產物（49 個變數）中
    `XDG_CONFIG_HOME`、`ELECTRON_*`、`NODE_OPTIONS` **都不存在**，於是那條規則對它們一律放行，
    方向與直覺相反。一份黑名單則會遺漏尚未存在的變數。**不寫進去，這一整類問題才表達不出來。**
  - **環境是啟動時的快照** —— 改了 `.zshrc` 要**重開 app** 才生效（開新 session 不夠）。
    完整論證與量測見 `docs/lessons/terminal.md`。

## OpenSpec 側欄與 `@spekjs`

元件重用的判準、`@spekjs/core` 的簽名與語意陷阱、worktree 聚合的三個讀取根、聚合圖的節點識別碼、
反向導覽與工作目錄清單、Files 的工作目錄、側欄的資料流與座標、與 agent 的狀態橋接、續寫入口 ——
全部在 **`docs/lessons/side-panel.md`**。**升 `@spekjs/core` / `@spekjs/ui` 前也必讀**
（升級的檢查清單在上面的「`@spekjs/core` 與 `@spekjs/ui`」一節）。

留在這裡的只有一條，因為它跨到上面那道邊界：

- **`SpecInfo.path` 是絕對路徑。** 直接送給 renderer 會**破壞邊界語彙**。主行程必須翻成
  folder-relative，翻不出來就回 `null` —— 側欄少一個「跳到檔案」的入口，好過洩漏一個絕對路徑。

## UI 文案與 i18n

**使用者看得到的每一個字都來自字典，且以使用者選擇的語言呈現。** 受支援語言的單一來源是
`src/shared/i18n/languages.ts` 的 `SUPPORTED_LANGUAGES`（目前 `en` 與 `zh-TW`），每種語言一份
字典（`en.json` / `zh-TW.json`）。主行程與 renderer **共用同一批字典**（兩個 realm 各持有一份
i18next 實例，`resources` 指向同一批 JSON）。

**「使用者可見的文案」有四類，後兩類最容易漏 —— 它們住在主行程，看起來像內部錯誤：**

1. renderer 的介面文字（JSX、`aria-label`、`title`、驗證訊息、空狀態）
2. 主行程的**原生對話框**（關窗時的未存提示）
3. 主行程**經 IPC 送達畫面**的錯誤訊息 —— `TerminalError` 與 `FsServiceError` 的 message 都會被畫
   到畫面上
4. **寫進 pty 串流給人讀的訊息**（session 重建的重播分隔線；只有**文字**進字典，ANSI 與框線字元
   留在程式碼）

**而第 4 類有一條反直覺的例外：寫給 agent 執行的指令不屬於使用者可見的文案，即使它出現在
畫面上。** 被填入 agent 輸入處而尚未送出的那一則 prompt 的確被寫進 pty、使用者也的確在讀它，
但它承載 prompt injection 的措辭，**翻譯後的效力沒有任何載體能驗**。它與 `handoff-intro.ts`
的自我介紹、`continuation.ts` 的續寫命令同一側：住在 `src/main/agent-protocol-copy.ts`，
**不進字典、恆為英文、仍受 CJK 守衛約束**。

**`console.*` 與內部不變式的 `throw` 不進字典**（沒有使用者會讀到），**但一律英文** —— 守衛是一刀
切的，而一刀切是對的：「這個字串會不會被顯示」**無法靜態判定**（見第 3 類）。

- **字典是 `.json` 而不是 `.ts`，因為 probe 要 import 它**（`scripts/*.mjs` import 不了 TypeScript；
  Node 22 的 import attributes 讀得到 JSON）。**而「JSON ⇒ key 沒有型別安全」是錯的**：把
  `typeof en` 餵進 i18next 的 `CustomTypeOptions`，`t('rail.emty')` 就會**編譯失敗**並提示正確拼法。
  **不需要任何型別產生器。**（型別只看 `en` —— 其餘語言的結構允許不同，`zh` 的複數類別只有
  `other`，於是它少了 12 個 `_one`。）
- **i18n 於模組載入時初始化，不是導出一個「請記得呼叫」的 init。** **未初始化的 `t()` 不會拋錯，
  它回傳 `undefined`** —— 畫面上就只是什麼都沒有。初始語言恆為 `en`，其後由各自的 realm 套用
  偏好（主行程於 `whenReady` 建立視窗之前；renderer 於偏好抵達時，**因此非英文的使用者會看到
  一瞬的英文**，與字型偏好同一條先例）。
- **`i18next` 必須在 `dependencies`，不是 `devDependencies`。** main 的 build 用
  `externalizeDepsPlugin()` —— 它在**執行期 require**，而 electron-builder 只把 `dependencies` 打進
  asar。**放錯區塊時 dev 模式完全正常，打包後一啟動就 `MODULE_NOT_FOUND`。**
- **英文的語序與中文不同 —— 前綴／後綴選擇器不能機械替換。** `Remove {{name}} from workspace` 把
  變數放到了中間；rail 的展開／收合中文都以「的 session」結尾（一個 `$=` 通吃），英文
  `Expand/Collapse sessions in {{name}}` **沒有共同的固定後綴**。`copy.mjs` 因此提供
  `prefixOf` / `suffixOf` / `patternOf`；**`prefixOf` 在前綴為空時拋錯** —— `[aria-label^=""]` 會
  匹配**每一個**元素，那比選不到更糟，因為它會靜默地通過。
- **一切 locale 衍生的呈現只有一個來源**：`src/shared/i18n/locale.ts`（相對時間、時刻、日期、
  數字、以及**使用者看得到的排序**）。僅為確定性而存在的內部定序（同分時的 tie-break、
  列舉順序的收斂、對識別碼的比較）**不在其中**，且在守衛裡逐一具名豁免、各帶理由。

### 五道守衛，缺一不可（它們互補，不重複）

| 守衛 | 擋什麼 | 少了它會怎樣 |
|---|---|---|
| `copy-language.test.mjs` | 產品原始碼的字串字面值含 **CJK** | 文案被寫死在程式碼裡（與支援幾種語言無關） |
| `aria-label-source.test.mjs` | **硬編**的 `aria-label`（**含本來就是英文的**、**含樣板合成的**） | 改文案時探針**靜默地選不到元素**；`Ctrl+T` 連紅燈都沒有 |
| `i18n-key-safety.test.mjs` | 字典 key 的**編譯期**型別安全 | 打錯的 key 在執行期把 `rail.emty` 印在畫面上 |
| `dictionary-completeness.test.mjs` | 各語言字典的**基底 key／CLDR 複數類別／插值變數** | 少一條翻譯＝那一格靜默變回英文；漏一個變數＝少了檔名的句子 |
| `locale-source.test.mjs` | locale 在單一模組之外被取得 | 排序與時刻各走各的（**這條已經失效過三次**） |

第六道 `probe-language.test.mjs` 守的是驗收本身：每一支會傳遞 `--user-data-dir` 的探針，其啟動
路徑上都要種入 UI 語言 —— **漏種的徵狀是「選不到元素」，看起來像產品壞掉**。

- **CJK 守衛必須走語法樹（`ts.createSourceFile`），不能 regex 掃行** —— **豁免註解正是它的核心
  語意**（repo 慣例是繁中註解），而註解與字串在同一行裡分不開。豁免 `*.test.ts` 與 `scripts/`。
- **`aria-label` 守衛走行掃描**，在註解裡寫出該屬性的字面形式也會被判違規。
- **key 型別安全守的是一份 ambient declaration。** `i18next.d.ts` 的 `CustomTypeOptions` **沒有任何
  模組 import 它** —— **拿掉那個檔案，`npm run typecheck` 照樣 exit 0**（已實測）。

### **`aria-label` 同時是選擇器** —— 而多語讓它更尖銳

驗收不得為此在產品 UI 上掛 `data-*`（既有紀律），於是 probe 只能靠 `role` 與 `aria-label` 定位元素
（**11 支 probe、555 處**），而 `Ctrl+T` 的實作也靠 `querySelector` 找到既有的建立入口。
**兩者都從字典取字串**（`scripts/lib/copy.mjs` 的 `copy()` / `label()`；`KeyboardNavigation.tsx` 用
`t(...)`）。文案與選擇器一旦分離為兩份字面值，就會在某一次改文案時失去同步 —— **而失去同步的徵狀是
「選不到元素」，不是「斷言失敗」**；`Ctrl+T` 更是連紅燈都不會有。

**而標籤自己也會被翻譯**：切成中文之後，以英文標籤組出的選擇器選不到任何東西，回的是 `null`
—— 而 `null` 看起來像「介面沒變」。驗收在哪一種語言下執行，選擇器就得用哪一種語言的字典
（`copyIn` / `labelIn`）。探針一律在基準語言下執行，**那是它們的前提而不是巧合**。

推論出來的日常規則：

- **可見文字可以自由改，只要 `aria-label` 不動**（`+ session` → `+` 那次 168/168 全綠即為驗證）。
- **寫 `aria-label` 文案時要避開 shell 引號會咬到的字元**（單引號、雙引號、反引號）—— probe 的
  選擇器是用字串拼的。實測：`Back to this session's repo` 的單引號提前關閉了 probe 的字串字面值，
  整個 evaluate throw、**沒有紅的斷言，只有一個 Uncaught error**。
- **`role` 也會撞。** 現在有四到五個 `role="tablist"`（身分切換、OpenSpec 視圖、artifact 分頁、
  session 分頁，overlay 開著時還有第五個）。選取時一律連 `aria-label` 一起指名。
- **同一個字串可能是兩個東西的標籤**（`panelSwitch.files` 與 `files.label` 值相同 —— 以該標籤選取會
  命中 Files 面板那個 `<section>`）。
- **「測試與被測物同源，字典寫錯時探針不會發現」不成立。** probe 驗的是**行為**：沒有哪條 spec 說
  那顆按鈕必須叫 `New session`，spec 說的是「觸發它會建立一個 session」。`aria-label` 在 probe 裡的
  角色是**定位手段**，與 `role` 或 CSS class 沒有差別。文案內容的正確性由人擔保 —— 它就印在畫面上。

### dev 模式下，改字典或 preload／主行程**不會**熱套用

- **字典一改，vite 觸發 full page reload，而導航防護會擋掉它** —— renderer 於是**留著舊字典**，
  新增的 key 會變成 `t()` 回傳 key 字面。**必須重啟 dev。**
- **`electron-vite dev` 實測沒有在主行程／preload 改動時重啟 electron** —— 新的 preload 方法不會出現
  在 `window.workspace`。**同樣必須重啟 dev。**

## 字級、版面與 React

### 字級尺度：只有一個旋鈕

**renderer 的字級只有一個旋鈕：`index.css` 的 `--text-base`（定案 17px）。** 五級尺度全部由它以
`calc()` **平移**推導（`2xs` 13 / `xs` 14 / `sm` 15 / `base` 17 / `lg` 18），`--text-terminal`（16px）
也是。**平移，不是等比縮放** —— 使用者要的是「每個字都大一點」；等比縮放會改變版面的層次關係。

- **不得寫死字級。** `scripts/typography.test.mjs` 擋 `text-[13px]` 這類 arbitrary 值；CSS 的
  `font-size` 必須引用 token（`em` / `%` 放行 —— 它們相對父層；**`rem` 不放行**，它相對 html 的
  16px，旋鈕轉不動它）。收斂前有 **70 處**寫死字級，於是 `@theme` 裡的 token 調了也沒用。
- **字級是版面的輸入，不是裝飾。** 旋鈕從 15px 調到 17px 時，rail 立刻縮不到它宣告的 `minSize`
  —— flex item 的 `min-width` 預設是 `auto`，`Panel` 會被**內容**撐住。那道夾制**在實作上一直沒有
  真的兌現**，只是字級小的時候看不出來。修的是 `Panel` 的 `min-w-0`，**不是把 180px 調高**
  —— 最小寬度是版面契約，不該隨字級浮動。

三個會**靜默失敗**的陷阱：

- **`@theme` 會 tree-shake 掉沒有任何 utility 用到的 token。** `--text-terminal` 只被 JS 讀取，
  放在 `@theme` 裡它**會從產物中消失**。必須定義在 `:root`。
- **CSS 自訂屬性的 computed value 不會求值 `calc()`。** `getPropertyValue('--text-terminal')` 回的
  是字面的 `"calc(15px - 1px)"`，`parseFloat` 得到 `NaN` —— **而 fallback 剛好等於正確值，畫面上
  看不出來**。要讓瀏覽器求值：把 `var()` 餵給一個離屏元素的 `font-size`，再讀回它的 `fontSize`。
- **把 arbitrary 值換成具名 token，換掉的不只是你盯著的那個屬性。** `text-[12px]` 只設
  `font-size`；`text-xs` **連 `line-height` 一起設**。於是 45 處一收斂就憑空多出 16px 行高，而
  `probe:terminal` 是以**真滑鼠座標**點擊的 —— 版面一動，對時序敏感的斷言就開始點空。
  **徵狀是時綠時紅、每次紅的還是不同條，極易誤判為既有的 flaky。** 因此 `@theme` 裡的五個
  `--text-*--line-height` 全部明確釘住。

### 版面與游標

- **`react-resizable-panels` 的 px 尺寸是「掛載時換算出來的百分比」，不是一個會被維持的像素值。**
  `groupResizeBehavior` 預設 `preserve-relative-size` —— 於是視窗一放大，每個 `Panel` 都等比長大
  （`maxSize` 會夾住它，所以有上限，但 56px → 120px 已經是兩倍多）。**固定寬度的區域不該是
  `Panel`**：活動列曾經是，症狀是「每次重啟再最大化，它就佔掉更多空間」，而版面根本沒有落盤、
  每次都是重演。修法是把它移出 `Group`（結構上表達不出「被拖動」與「隨視窗長大」），不是用
  min=max 去夾它。**驗收這件事要兩條前置**：viewport 真的變寬了（`window.innerWidth` 前後值）
  **以及版面真的重算了**（一個 `preserve-relative-size` 的鄰居必須跟著變寬）—— 只驗前者的話，
  「ResizeObserver 沒觸發」會讓「寬度不變」照樣全綠。
- **一個 flex 容器裡，「誰吸收溢出」不是你以為的那一個 —— 而 `truncate` 會讓它悄悄被壓扁。**
  rail 的 `<aside>` 是 flex column，裡面有標題、兩段清單、底部的加入入口。內容過高時負的剩餘
  空間會分給**每一個收縮因子非零的項目**，而帶著 `truncate`（`overflow: hidden`）的元素其
  **自動最小尺寸是 0** —— 實測標題從 35px 被壓到 22px，**文字直接被裁掉**，而沒有任何東西會紅。
  不該參與收縮的項目要明寫 `shrink-0`。
- **`flex: 1 1 0%` 的區段「不會收縮」，但它也**拿不到任何剩餘空間** —— 那兩件事的差別是
  `clientHeight: 0`。** `flex-1` 讀起來像「它會佔滿剩下的空間」，於是很容易以為它有下限；
  實測兄弟節點一長，它直接變成零高度**而不是被壓小**。需要「這一段至少要能用」時，要明寫
  `min-h-*`，那才是把意圖編碼進版面。
- **混排字型的列要釘住行框（`leading-none`）。** 狀態列曾回報「字型不一樣大、排列不整齊」——
  根因不是字級（整條列同一個 token），是**某些字元落到 fallback 字型，而行框高度會跟著各自的字型
  度量走**，於是 `items-center` 對齊的是「各自不同高的盒子」。實測系統等寬字（DejaVu Sans Mono）
  有 `·` `…` `↻`，**沒有 `⑂`（U+2442）**；`✳`（U+2733）同時存在於等寬字與 emoji 字型，挑到後者
  會明顯變大又偏移基線。**與終端 box-drawing 同源：字型覆蓋範圍不足時，症狀出現在版面上，而不是
  出現在缺字的地方。**
- **`<button>` 不繼承父層的 `cursor`（Tailwind v4）。** `cursor` 雖是可繼承屬性，但元素自己的宣告
  會贏過繼承來的值，而 `<button>` 帶著一條 UA 的 `cursor: default` —— Tailwind v4 的 preflight 不再
  像 v3 那樣把它改回 `pointer`。**靜止的游標要掛在使用者真正滑過的那個元素上。**
- **可拖曳且可點擊的項目，靜止時是 `pointer` 不是 `grab`** —— `grab`（張開的手）宣告的是「這東西
  只能被拖」，但它們**點一下是有作用的**，而那是使用者最常做的事。
- **拖曳中的 `grabbing` 不能靠 `body.style.cursor`，也不該由每個呼叫端各自加三元式。** 同一條規則
  讓 body 上的 grabbing 被沿路每個元素蓋掉，而 repo 的拖曳判定**刻意涵蓋整個區塊** —— 游標一定會
  掃過它們，於是一路閃爍。作法是 `useDragReorder` 在 `body` 掛 `data-dragging`，由一條 `!important`
  規則覆蓋**整棵子樹**。
- **`<Panel collapsible collapsedSize={0}>` 收合時子樹仍然掛載**（收合只是把尺寸設為 0）。
  不要據此推論「收合時焦點不可能在容器裡」。
- **可程式聚焦的容器需要 `tabIndex={-1}`** —— 對一個沒有它的 `<section>` 呼叫 `.focus()` 是 no-op。
  這在 `Ctrl+P` 的焦點歸還上是承重的：overlay 關閉後若焦點落在 `<body>`，下一次 `Ctrl+P` **靜默
  失效**，使用者看到的是「這顆鍵時好時壞」。而**「開啟檔案」正是那個記住的元素必然消失的路徑**
  —— 退路在最常走的那條路上才會被用到。

### 拖曳的落點：插入點與提交序位差一格 —— 而**兩個項目時看不出來**

命中判定回傳**插入點**（「插在第 i 個之前」，指示線畫的也是它），但提交端是「**先移除、再插入**」
—— 移除會讓被拖曳項目**之後**的元素前移一格。於是**往下／往右拖時，落點比指示線多一格**（把 repo
拖到第二個 repo 的下半部，它會**飛到清單最後**）。換算集中在 `commitIndex()` 一處，state 裡存的
**永遠是插入點**。

- **這個 bug 從 `session-rename-and-reorder` 起就在，卻通過了每一輪驗收** —— **分頁列的拖曳只用
  兩個分頁測，而兩個項目時兩種語意的結果完全相同**。**驗收拖曳排序必須用至少三個項目，且往下／
  往右拖。** 這條紀律已寫進 `workspace-layout` 的 spec 本身。
- **末端要拖得到**：命中判定在「游標落在所有中線之後」時必須回 `count`，並在最後一個項目**之後**
  畫指示線。**無操作時不畫指示線** —— 一條說「放開會移動」的線，放開卻什麼都不動，是在騙人。
- **重排一律以識別碼定位而非位置** —— 清單的權威在主行程，飛行中的索引可能已指向另一個 folder。
- **拖曳排序用滑鼠事件實作，不用 HTML5 drag-and-drop** —— 後者在 CDP 下要走
  `Input.setInterceptDrags`，與探針既有的真滑鼠序列格格不入。自己做，驗收就能送真拖曳。

### React 的陷阱

- **effect 的依賴陣列，就是某條 requirement 的「什麼時候該發生」在程式碼裡的載體。** 把一個每次
  渲染都重建的值（`filter()` 出來的陣列、inline object、closure）放進去，等於把觸發條件悄悄改寫成
  「任何重繪」—— 型別、lint 與探針**都不會有一句話**，而 `exhaustive-deps` 還會**主動要求你把它
  加進去**。捲動的觸發條件曾經因此從「選取或焦點改變」變成「這個元件重繪了」，於是背景 agent 每改
  一次終端標題，使用者手動捲到的位置就被搶回去一次。**把觸發條件壓成一個純量再交出去**（身分 ＋
  位置），並讓介面只收得下純量 —— 這個 repo 的 `useScrollIntoView` 就是這樣關掉那個入口的。
  - **「掛載」不是「改變」。** 同一個捲動容器可能有一個以上的目標（rail 同時有「選中的項目」與
    「focused session 的子列」），重排會讓其中一份重新掛載 —— 若掛載也算一次改變，它就會蓋掉另一
    份剛完成的捲動。**實測 dev 壞、build 好**（StrictMode 只在 dev 生效），第一直覺又會是時序。
- **state updater 必須是純函式。** StrictMode（**只在 dev 生效**）會刻意 double-invoke updater ——
  把 `onCommit` 寫在 `setDrag(current => {...})` 裡面，排序就會被套用**兩次**（交換兩次＝回到原位，
  看起來像「拖曳完全沒反應」）。實測 **dev 失效、build 正常** —— 一邊過一邊不過，第一直覺會以為是
  時序 flaky，其實是 React 在告訴你「你的 updater 不純」。
- **「把 prop 同步成 state」的 effect 會在首次掛載時靜默失效。** 側欄兩個身分**互斥掛載**，跨身分
  導航送出的請求抵達時目標**那一刻才第一次掛載** —— 用「nonce 變了才套用」的寫法，`useState(nonce)`
  的初始值就等於當前 nonce，**跳過去的那一次永遠不會開檔**。**請求必須在 `useState` 的初始值就
  套用。** 連帶：這也讓「切走身分再切回來」不能用來重置（重新掛載會把上一個 request 重播一次）。
- **副作用不可寫在 effect 裡同步 setState** —— 用「渲染期間調整 state」。但**渲染期間只能改自己的
  state**，不能呼叫父層的 setState —— 所以錨定要在**送出請求的那個 event handler** 裡完成。
- **換 folder 必須清掉待處理的跨身分請求** —— 它是**上一個 repo** 的座標。
- **兩個會靜默毀掉使用者資料的陷阱**：落盤的 effect **必須有一道「restore 完成了嗎」的閘**（首次
  渲染時清單是空的，少了閘它會在 restore 回來**之前**送出一份空清單，**把上一次的全部抹掉**）；
  restore 的 `setSessions` **必須是合併，不能是覆蓋**（使用者完全可能在它回來之前就按下「+」，
  覆蓋會讓那個剛建好的 session **憑空消失，而它的 pty 還活著**）。
- **StrictMode 會把重建做兩次** —— restore 的 effect 需要一道 **ref 閘**，否則每個 session 都變成
  兩份分頁。
- **Monaco 的選取不是 DOM selection**（與 xterm 同源）—— `window.getSelection()` 讀不到，要看 view
  overlay 的 `.selected-text` 元素。

## 驗收與探針

**全 repo 最貴的一份教訓集在 `docs/lessons/probes.md`** —— 幾乎每一條都是「它曾經是綠的，而它測的
不是它自稱在測的東西」。**寫或改任何一支 `scripts/probe-*.mjs`、加一條驗收斷言、或追一個 flaky
之前，先把它讀完。**

只記住這三句是不夠的，但它們是那份文件的骨幹：

- **對照組是唯一擋得住假綠的東西** —— 把修正退回，確認測試真的變紅。這個 repo 每一條重要的守衛都
  這樣驗過，而**幾次沒這樣驗的，全部是假綠**。
- **一個方便取得、看起來相關的量，不等於規格真正在乎的那個量。** 已經咬過四次 —— 最近一次是**用來
  推導方案的那個量測腳本自己**算錯了。
- **等待落空是靜默的。** 所有等待走 `lib/instrument.mjs` 的 `pollFor`，帶副作用的重試走
  `retryAction`（**三道**原始碼守衛擋著手寫的等待迴圈、手寫的固定次數重試、沒有 detail 的複合
  斷言）；每條斷言的行首帶著距上一條的耗時與 CDP 往返，段落總結帶著該段的窗口耗盡次數 ——
  **那三個數字是「這一段為什麼跑那麼久」唯一的證據來源。**
- **一個固定次數的重試，其上界是一個沒有被寫下來的乘積** —— 而它比想像中容易算錯（漏掉被呼叫
  函式內部的等待，就會少算一個數量級）。**計數迴圈有四類，只有兩類的次數是對的尺度**；
  分類與守衛的定義域見 `docs/lessons/probes.md`。

## 工具鏈與環境的陷阱

### 腳本裡比對 git 的輸出，一律加 `--no-color`

已經咬過三次。**`-c color.ui=false` 不夠**：這台機器的 git config 設了 `color.diff = always`，而
`color.diff` 比 `color.ui` **更具體**。用**子命令自己的** `--no-color`，或 `-c color.diff=false`。

git 在這個環境會強制上色，於是 `git diff | grep '^-'` **匹配不到任何東西**（刪除行的開頭是一個
ANSI escape）。**而失效方式是最壞的那種 —— grep 回 0 個、exit 1，靜默跳過 `&&` 後面的每一步，
看起來就像「0 deletions，乾淨」。** 同源的還有 `git log --oneline | grep`、`git status | grep`、
`git grep`（另可用 `-I --no-color`）。

> **兩個判準對不上時，不要挑好聽的那個 —— 但也不要假定原因一定是顏色。** 同一個矛盾
> （`--numstat` 說 2 個刪除、`grep '^-'` 說 0 個）也可能出在 pattern：**markdown 的清單項本身
> 就以 `- ` 開頭**，於是刪除行長成 `-- **WHEN**`，把 `^-[^-]` 全部漏掉。查到底（`cat -A` 看
> 原始位元組），別停在第一個看似合理的解釋上。
>
> **原本的那一次：** 第三次是 `--numstat` 說 5 個刪除、`grep '^-'` 說 0 個 ——
> 那個矛盾就是顏色碼還在的證據。若當時採信 grep，就會宣稱「spec 同步沒有刪掉任何東西」而放行。

### 原始碼裡一個字面的 NUL 位元組，會讓 `git diff` 與 `grep` 對整個檔案瞎掉

而 `grep` 是回空 + exit 1，**連「binary file」都不說**。修過三個檔案（`data.tsx`、
`side-panel/SidePanel.tsx`、`files/dirty-buffers.tsx` 的 cache key 分隔符），**而這份 CLAUDE.md 自己
也曾命中同一個坑** —— 上一版在警告這件事的那一段裡，把 `\x00` 寫成了真的 NUL。
**寫「不要寫字面 NUL」的時候，特別容易寫出一個字面 NUL。**

**它的代價不只是難讀 diff**：`global-session` 的 design 倚賴「把 `folderId ===` grep 一遍」來清查
每一個歸屬比較點，而 `dirty-buffers.tsx` 的 5 處命中**結構性地不在結果裡**。結論碰巧不變，但**清查
技術有一個沒人發現的盲點**。分隔符選 NUL 是對的（它不可能出現在識別碼或路徑裡），錯的只是把它寫成
字面的位元組而不是 escape 序列 —— 語意完全等價。

查法：`python3 -c "print(open(f,'rb').read().count(b'\x00'))"`（**不能用 grep 查 grep 看不到的
東西**）。三道原始碼守衛不受影響 —— 它們走 `readFileSync` + AST／regex，不經 grep。

**第四例出現在 `intake-store.ts`（cache key 的分隔符），而它讓 `grep` 對整個檔案零輸出 ——
那就是發現它的方式。** 四次之後終於有守衛：`scripts/nul-byte-source.test.mjs`
（讀**原始位元組**，不經任何文字工具 —— 檢查的手段不能與被檢查的缺陷共享盲點）。
**那道守衛抓到的第一個東西是它自己** —— 我在撰寫它的對照組時往裡面寫進了兩個字面 NUL。

### 不要讓 pipe 蓋掉 exit code，也不要用 `head -N` 過濾輸出

npm 會先印幾行 `>` 開頭的腳本回顯與**空行**；`npm run typecheck 2>&1 | grep -v '^>' | head -3` 於是
只顯示那幾個空行，**真正的錯誤被擠出視窗** —— 我因此一度以為「typecheck 抓不到未定義的函式」而去
懷疑 `tsconfig`。同源：pipe 到 `tail -50` 讀 probe 的 stdout 尾巴，`tail` 自己的 exit code 覆蓋了
probe 的。**要看 exit code。**

## 反覆重演的教訓（一般形式）

這些各自在上文有具體實例。列在這裡，是因為它們**跨 change 重演過至少兩次**。

- **「補一條 scenario」與「覆蓋一條 scenario」是兩個動作。** 已經發生**四次**：`session-restore` 的
  休眠提示（spec 有 scenario、design 有交代、實作零覆蓋）、`worktree-reverse-navigation` 的「design
  寫『由單元測試承擔』而那條測試沒寫」、`panel-coordinate-per-folder`（三條缺口**已由
  `panel-coordinate-coverage-gaps` 清償**）、`global-session`（對照表宣稱了四條不存在的載體）。
  **它們全都躲過了** `openspec validate --strict`（scenario 存在且格式合法）、
  delta 與主 spec 的 header 稽核（那支腳本不看驗收），以及探針全綠（沒有人在看那條）。
  **而後兩次是在寫下前兩條教訓之後犯的 —— 所以「記得要小心」顯然不是機制。**
  **能結構性擋住它的做法已經落地**（issue #12 的處置）：`scripts/scenario-coverage.test.mjs`
  是一份 scenario → 載體的對照表，由**兩道機械守衛**釘住 —— 每一條 `#### Scenario:` 在表上恰有
  一列，且**每一個載體標籤必須真的存在於原始碼中**。它另有兩欄比「哪支探針哪條斷言」值錢：
  `greenIfAbsent`（若實作完全沒做，這條會不會照樣綠）與 `mutation`（使它變紅的那個錯誤實作）。
  **`slack-mention-intake` 填那 57 列時，守衛抓到 5 個憑印象填的標籤** —— 那正是上一次 82 列
  表裡那 4 列的形狀，而這次它在 commit 之前就紅了。
  加新 change 時要把它登記進 `COVERED_CHANGES`（第一版寫死一個名字，於是對下一個 change
  完全沉默）。而修法仍然**不是改標籤，是把載體做出來**。
  > **第五次發生在 `rail-pinned-repos`，而它的形狀是新的：對照表做了，填表的方式錯了。**
  > 那個 change 為了防這件事親手建了一張 82 列的 scenario → 載體對照表 —— 然後把 39 條既有
  > scenario 憑印象填成「既有」。事後逐條核對，**其中 4 條是假的**（一成）：兩條零覆蓋、一條
  > 歸屬寫錯、一條根本驗不了（原生對話框）。**一張沒有逐條對過的對照表，只是把「我以為有覆蓋」
  > 寫得比較整齊。** 填「既有」時要真的去把那條斷言找出來，找不到就寫「無載體」＋理由。
  > 這一輪還順帶抓到一盞**撐過完整 9/9 全綠**的假綠（單一 folder 的 `Shift+↑` 靜默置頂，而
  > 斷言只看順序）—— 抓到它的不是重跑，是逐條把 scenario 對回載體。
  > **清償那三條時學到的**：把載體做出來之後，**三條裡有兩條的第一版仍然是假綠** —— 一條的
  > 被觀察值恰好就是預設值（「退回自身」對一個從不讀落盤內容的實作照樣通過），另一條的反向
  > 斷言在結構上不可能紅（錨定的鍵是 rail 選中項，該值在動作前就已經在那裡了）。
  > **「有載體」與「載體有鑑別力」又是兩個動作**，而分開它們的仍然只有對照組。
- **替一個既有操作加上「順帶改變的第二個狀態」時，把它路徑上所有的早退條件 grep 一遍。**
  `reorder(id, toIndex)` 加上 `pinned` 之後，路徑上有**三道** `to === from` 的早退（拖曳機制、
  主行程的 store、renderer 的樂觀更新），而「跨越分界」的移動其序位**前後同值** —— 三道都會
  把它吞掉，而清單長度、順序、其他欄位全都正確，症狀只有「那個狀態沒有變」。design 當時只論證
  了第一道就宣稱成立。**一般形式：早退的條件必須涵蓋新加的那個維度，而它不會有任何型別錯誤。**
- **加一個列舉值時，把所有 `===` 比較 grep 一遍。** TypeScript 一條都不會攔（既有判斷全是
  `x === 'a' ? A : B` 這種二分寫法，多一個值只是靜默落進 `else`）。踩過兩次：`dormant`（休眠的
  session 全亮紅燈說「已結束」、快照被重複追加分隔線）、`folderId: null`（全域 session 的終端
  **永遠不是 active** ⇒ 依「休眠的 session 於首次被顯示時才 spawn」，**它永遠不會被喚醒**，而畫面上
  只是一片空白）。
  > **而「用 `null` 讓編譯器把每個消費點標紅」只對一半成立**（實測，`--strict`）：`string | null` 與
  > `string | undefined` 的 **`===` 比較合法且不報錯**，只有傳參與 Map 鍵會紅。而歸屬的消費點
  > **絕大多數是比較**。
- **一個「由測試釘住的格式假設」不如一個「使不變式無法被違反的結構」。** 實例：`global-session` 原本
  想用「保留鍵不得為合法 UUID 形狀」的測試防止碰撞（**那測的是一個實例，不是不變式** —— 而 codebase
  的註解早就寫著識別碼「不對格式設限」），改為**獨立欄位**之後碰撞**表達不出來**；`files-in-worktree`
  的 `self` / `others` **互斥分割**取代事後去重；`panel-coordinate-per-folder` 的落盤改為**逐欄位
  白名單**（`SessionStore.replace()` 原本是 `{...entry, …}` 原樣展開，於是「移除一個欄位」不等於
  「它不會再被寫進磁碟」）。**一般形式：「不接受某個東西」要由結構保證，不是由「沒有人再送它」
  保證。**
- **一個可預測答案的高頻問題不該被問。** 兩次：pty 標題的確認對話框、側欄的「跟隨/釘住」toggle。
  **優先序的裁決本身就已經是那個問題的答案**，不需要在 UI 上再問第二次。
- **core 的 optional 欄位要實測它何時被填，不要從語意推論。** 兩次方向相反：假設 `source` 不在
  （結果在，含絕對路徑，且**同一段程式碼的註解正好宣稱了相反的事**）、假設 `worktrees` 是空的
  （結果不是，於是把一個剛修好的 bug 以相反方向重新引入）。
  **換一個 core 的 API 時，要重新問一次「它回傳的東西裡有什麼」** —— 舊 API 的註解在當時是對的。
- **一個方便取得、看起來相關的量，不等於規格真正在乎的那個量。** 三個實例見
  `docs/lessons/probes.md`「別拿方便取得的量當代理判準」。
- **design 裡寫「由 X 承擔」，就要真的去做 X** —— 寫下它的時候就該同時把 X 排進 tasks。
  同源：**實作為了避免噪音而自行收窄條件時，要回頭改 spec**，不是讓兩者各自為政。
- **入口的 gate 在一個地方、取數卻無條件** —— 沒有 `openspec/` 的 folder 為一份用不到的清單走了一趟
  `#scan`（那條路上 core 會 spawn `git worktree list`）。
- **「已實作過」與「已 commit」是兩件事。** 一份紀錄寫著「程式碼可從 git 歷史取回」，而那份 spike
  **在全歷史（含 dangling commit）搜尋為空** —— 害人去找一個不存在的東西。
- **寫下一條教訓，不會讓你自動避開它。** 我在寫下「worktree ≤ 1 時 core 靜默退回非聚合」的同一個
  小時裡，為另一件事補的測試就踩了它（fixture 不是 git repo，對照組沒有變紅）。
  **唯一擋住它的是對照組。**
