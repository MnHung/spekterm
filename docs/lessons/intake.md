# 收件匣（`agent-intake` / `intake-routing`）的教訓

> 這一份的定位與 `CLAUDE.md` 相同 —— 「不知道就會踩、而且失敗是靜默的」。
> 觸發條件夠明確（動到 `src/main/intake-*`、`ipc/intake.ts`、`probe-intake.mjs`、
> 或共用的替身 agent），所以搬出來讓它不必每個 session 都佔位。

## 一、呈現給人看的文字與交給 agent 的文字，必須是**同一個值**

這條管線的人類閘門有兩半：**使用者按下送出**，以及**他看到的就是 agent 會讀到的那一份**。
第二半最自然的失效方式不是實作錯誤，而是**兩端各自取值** —— 中間任何一邊多做一次轉換
（最典型的是「在呈現層剝除不可列印字元」），兩份文字就差在一組看不見的字元上。

處置是三層，缺一不可：

1. **正規化在攝入發生一次**（`intake-schema.normalizeAuthored`），其結果即該字串唯一的表示。
2. **本文只能經 `bodyOf()` 取得**，由 `scripts/intake-context-source.test.mjs` 釘住。
3. **載體必須跨行程**：`probe-intake` 從畫面上那一列讀 `textContent`（**不是 `innerText`** ——
   它會套用 `text-transform` 並壓縮空白），從磁碟讀 context 檔，兩者比對**相等**。

> **主行程裡的單元測試看不見這件事** —— 呈現那一端根本不在場。一個比對兩個純函式的測試
> 完全符合「兩者各自從其真實來源取值」的字面，而它證明的只是「兩個函式對同一個輸入同意」。

## 二、`createWatcher` 的 `ignoreInitial` 與 `ready` 之間有一個會**永久遺漏**的窗口

`ignoreInitial: true` 寫死在 `watcher.ts` 且不可覆寫，所以「app 關著時投遞」的東西只有
**啟動掃描**看得到。但光加掃描還不夠：

**chokidar 在 `ready` 之前看到的檔案一律視為「初始」**，而 `ignoreInitial` 把它們全部吞掉。
於是一份在「建立監看」與「掃描」之間抵達的投遞**兩邊都收不到** —— 監看當它是初始、掃描還沒
跑到那裡。正確的順序是**建立監看 → 等 `ready` → 掃描**。

同一個模組還要**同時訂閱 `add` 與 `change`**：「寫到一半的項目補完之後仍被採納」倚賴它，
而補寫發生在同一個路徑上、不會再產生一次 `add`。

## 三、`SessionStart` 的時序（實測，2026-09-11、CLI 2.1.267）

完整數字見 `docs/lessons/transcript.md`。結論：

- `SessionStart` 恆**晚於** TUI 進入 alt-screen 約 200–300ms，也晚於 TUI 啟動時的輸入丟棄窗口。
  以它為閘重複 5 次，5 次全部落進輸入框 ⇒ **它是可用的閘，不需要第二個條件**。
- **失效的是一個窄帶，不是「越早越糟」**：300ms 寫入會成功（login shell 不讀 stdin，位元組留在
  tty 緩衝區），1000ms 寫入會被吞掉，1150ms 之後一律成功。
- **備選訊號的集合是空的**：`Notification` / `idle_prompt` 在閒置的 9 秒與 25 秒內一次都沒觸發。

## 四、替身 agent：**逐位元組**收據，而且讀取迴圈必須在前景

預填**刻意不附送出字元**，而 pty 預設是 canonical 模式 —— 只等行的收據永遠是空的，
**對正確實作與錯誤實作一樣**。因此替身要 `stty -icanon` 之後逐位元組讀，並**自行組行**
（每組成一行才補紀錄與 fire 事件）。

兩個實作時踩過的坑，兩個都讓「就緒之前不寫入」變成一盞永遠亮綠的燈：

- **不能把 `while read line` 換成 `exec cat`** —— `exec` 接管行程，補紀錄與 fire 全停，
  而紅的會是**產品那側**的斷言。
- **讀取迴圈不能丟到背景再 `wait`** —— `dd` 一次空讀就 `break`，迴圈結束、`wait` 返回、
  **替身整個退出**，pty 隨之死亡。而且它必須在「就緒延遲」**之前**就開始讀，否則提早寫入的
  位元組只是躺在 tty 緩衝區裡等它來讀 —— **收據記的是「替身何時讀」，不是「產品何時寫」**。

> **對照組沒有變紅時，第一個要問的是「觀測管道還活著嗎」，不是「這條斷言沒有鑑別力」。**
> 本 change 差點據此把一條有效的斷言降級成「留著當回歸」。

## 五、缺口表逐條記錄取捨，**不記錄取捨之間的交互**

`design.md` 的「刻意的缺口」有十列，每一列都有理由。但已知的一條鏈是：
無速率上限 ⇒ 拒絕不計入任何上限 ⇒ 本文可卡在長度上限之下 —— 三者會**同時磨掉**本能力僅有的
兩道人類防線（讀本文、注意到那則拒絕）。

斷鏈的約束是「面向使用者的拒絕與警示 SHALL 有界」。**放寬任何一格之前，先回去看那一段。**

## 六、幾條零碎但會咬人的

- **識別碼的字元集是 ASCII-only**，於是「NFC/NFD 兩個識別碼撞同一個檔案」結構上不可達 ——
  規則仍完整寫著，因為字元集日後放寬時它會回來，**而那時不會有東西提醒你**。
- **落盤檔名用 hex 可逆編碼，不用雜湊截斷**：識別碼是投遞者挑的，對截斷過的雜湊找碰撞是可行的
  —— 那會把「兩個相異識別碼撞同一個檔案」原封不動地重新打開。
- **保存不可用 `rename` 搬投遞檔**：rename 不經 `open`，`O_NOFOLLOW` 一個位元組都碰不到。
  而 leaf 與中間目錄兩條 symlink 斷言**各配一個 mutation**：`rename(2)` 不跟隨最後一段，
  所以它只會讓中間目錄那條變紅。
- **拒絕分永久性與暫時性**：永久性被消費（否則每次啟動重播一次），暫時性（達到總量上限）
  原封留著等重試（刪掉它就是銷毀一件只是「現在太多了」的真實工作項目）。
- **內容相同的重複要靜默**：系統自己就會製造它（先監看後掃描刻意的雙重讀取）。做成可見的拒絕
  等於每次啟動對使用者報告一件他沒做過的事，而那個通道正是識別碼搶佔唯一的警訊。
- **「將開在哪個 folder」呈現的是名字，而斷言必須釘名字。** 第一版把主行程投影裡的
  `folderId` 直接餵進文案 —— 畫面上是 `Opens in ecca70e2-021f-468c-…`，那對使用者不構成
  資訊。**而 probe 當時釘的正是識別碼**，於是它全綠地通過了這個缺陷；改成顯示名字之後，
  原本那條否定斷言（「不含 fallback 的 id」）會變成**恆真**。名字住在 renderer
  （主行程刻意只送識別碼 —— 送路徑會破壞邊界語彙），所以 overlay 要自己查 folder 清單。
  這是「一個方便取得、看起來相關的量，不等於規格真正在乎的那個量」的又一例：
  **斷言釘的東西要與使用者讀到的東西是同一個。**

- **標題不一定在畫面上。** 它與本文重複時不另外呈現（`intake-inbox-usability`），於是探針
  「取那一列的第一個 span 當標題」會取到發話者。**以那一列的無障礙標籤取標題**
  （`intake.itemLabel` / `intake.openedItemLabel`）—— 它恆帶著標題。
- **清單型控制項讓整列的 `textContent` 含每一個選項。** 「將開在哪個 folder」改成下拉選單之後
  （`intake-inbox-usability`），`runRouting` 的「整列含第二個 folder 的名字」「整列不含第一個的
  名字」兩條的真假只取決於選項的排列順序 —— 與產品的行為無關。**斷言改讀被選中的那一項**
  （`select.selectedOptions[0].textContent`），那才是使用者讀到的東西。同一個原因讓 spec 裡
  「不可解析者不呈現任何 folder 名稱」照字面恆為假，改寫成「沒有被選定的 folder」。

## 七、作業系統通知 —— 它不是一個被動的純文字平面（實測，2026-09-14）

環境：Ubuntu GNOME Shell 3.36.9 / X11、Electron 43。**每一條都標明是實測還是讀原始碼得到的。**

### 能力宣告守不到真正的失效

**（實測）`Notification.isSupported()` 在三種環境下全部回 `true`**：真實 session bus、私有 bus
且**完全沒有任何 notification daemon**、`DBUS_SESSION_BUS_ADDRESS` 指向不存在的 socket。
後兩者通知一則都沒出現，而且 `show()` 不拋錯、`failed` 不觸發 —— **完全靜默**。
它實際上只反映「libnotify 裝了沒有」。

於是「不支援就降級」這條寫成 `isSupported()` 的判準是**守錯東西**：真正會發生的失效
（桌面沒有通知服務 —— 純 WM、遠端 session、daemon 崩了）偵測不到。要偵測只能主動查
`org.freedesktop.Notifications` 的 name owner，那是新的依賴與新的邊界。**已裁決不做，寫成缺口。**

**（實測）觸發能不能發生，取決於服務有沒有宣告 `actions`。** 同一支替身 daemon，只把
`GetCapabilities` 的回傳拿掉 `actions`，Electron 就不再附上 `["default","View"]`，
`ActionInvoked` 送過去也不會進到回呼。本機宣告了 —— **那是本機的事實，不是 Linux 的事實。**

### 通知物件被回收之後，點擊永遠不會觸發 —— 而通知還亮著

**（實測，決定性）** 丟掉 `Notification` 的參考並觸發 GC 之後，daemon 發出的 `ActionInvoked`
**不會**進到回呼；而且物件被回收時**不送 `CloseNotification`**。

> 通知**還在使用者的桌面上**，他點下去，什麼事都不會發生。沒有錯誤、沒有 log、沒有紅燈。

而最自然的寫法正是會踩到它的那一種：`new Notification(...).show()` —— 參考當場就掉了。
處置是**持有到 `close` / `failed`**；實測 GNOME 約 1 秒後就送 `NotificationClosed(reason=expired)`，
所以那個集合幾乎恆為空，成本是零。**仍要給它上界**（某些 daemon 的 `close` 可能不來）。

### 通知的內文會被當成標記語言解析，而且 URL 會變成可點的連結

**（實測）Electron 送出前一個字元都不轉義** —— body/title 原封進 `Notify`。
**（實測）本機 `GetCapabilities()` 回 `['actions','body','body-markup','icon-static','persistence','sound']`** ——
`body-markup` 有，依 FDO 規格 daemon 就會把 body 當 markup 解析。

**（讀原始碼，gnome-shell 3.36 的 `messageList.js`）**：

- `_fixMarkup(text, allowMarkup)` 對 body 以 `allowMarkup = true` 呼叫，**放行 `<b>` / `<i>` / `<u>`**；
  title 以 `false` 呼叫（全部轉義，安全）。
- 同一個檔案的 `URLHighlighter` 對 body 做 URL 比對並把命中處變成**可點的連結**，而且
  `vfunc_button_press_event` **攔下那次點擊不往下傳** —— 也就是點在那一塊上**不會**觸發
  應用程式自己註冊的效果，會開投遞者指定的網址。它的 regexp 連 `www.` 與裸網域都吃。

後者直接違反本能力對收件匣的既有禁令（不產生可點選的連結、不載入遠端資源 —— 一個遠端存取
就是投遞者的回條）。而 Slack 訊息裡 URL 到處都是：**這不是對抗路徑，是日常路徑。**

**處置是縮減，不是轉義。** 轉義只對**宣告** markup 的服務正確；對不宣告的服務，轉義後的字面
（`&amp;`）會直接顯示給使用者看 —— 而 Electron **沒有**把服務的能力宣告暴露出來，我們無從分支。
一個只對某一類桌面正確的處置，不比沒有處置好多少。

> **而「正規化只做一次」不是拒絕縮減的理由。** 正規化的產出是**那個值**；縮減的產出是
> **為了某個目的地而失真的呈現** —— 與呈現層把同一個值交給會自動轉義的渲染器是同一類動作。
> 把兩者混為一談，會寫出「此處不做任何字元過濾」這種**主動禁止防護**的條文（本 change 的
> 第一版就是）。

### 長度：沒有任何外部訊號會告訴你超了

**（實測）5013 字元的 body 原封送上 D-Bus，Electron 不截短、不報錯、`failed` 不觸發。**
截短與否是 daemon 的事（視覺上折行或截斷）。**上限只能由我們自己定。**

### 桌面身分要顯式設定，否則通知拿到 Electron 的圖示

**（實測）`app.setName('Spekterm')` 之後 `app_name` 正確，但 `desktop-entry` 提示仍是
`electron`** —— GNOME 用它去找 `.desktop` 決定圖示與歸類，而安裝的是 `spekterm.desktop`。
**`app.setDesktopName('spekterm.desktop')` 之後提示變成 `spekterm`**，對上了
（Electron 43 仍有這個 API）。

### 把計數併進活動列入口的無障礙標籤，會靜默掏空既有驗收

在本 repo 中那個標籤同時是驗收定位元素的手段。併進去之後既有指名該入口的每一條斷言
**選不到元素** —— 徵狀是求值得空值，不是斷言失敗。計數要放在**按鈕之內的獨立元素**上，
而且那個元素**需要自己的 role** 才會被輔助技術朗讀（`role="button"` 的後代在無障礙樹中是
呈現性的，巢狀元素上的標籤不會被讀出來 —— 「分成兩個元素就同時滿足無障礙」是錯的）。

### 合併要用固定窗口，不能用 debounce

debounce（每次到達都把計時器往後推）在**穩定滴入**時永遠不會到期 —— 越是有事情發生，
越沒有通知。而它與固定窗口在「單則到達」與「一次批次」兩種情況下的結果**完全相同**，
所以只驗那兩種等於沒驗。判準要落在 **0 與非 0 之間**。

### `DeliverOutcome.notify` 的語意與「要不要發通知」恰好相反

它是「這則**拒絕**要不要讓使用者看到」—— 成功路徑上恆為 `false`。照字面接上去，會變成
每一次拒絕跳一則桌面通知、每一則真正進來的都不跳。`deliver()` 有**六條**非成功的返回路徑，
接到 `notify` 會讓其中四條發出通知。

## 八、實作這條通知管線時，對照組抓到的三件事

三件都不是「規格沒寫」，是**已經寫了斷言、而那條斷言證明不了它自稱在證明的事**。

### 對照組的執行器本身是一盞假綠

`intake-control-groups.mjs` 最初寫死只跑 `probe:intake`，而多數 mutation 指名的斷言住在
`npm test`。移植 `slack-control-groups.mjs` 的 `command: 'test'` 分支之後，**反向檢查**
（指名一條**不該**變紅的測試）竟然也回報「如預期變紅」——

判定是 `output.includes(expectRed) && /^not ok/m.test(output)`，而 node:test 的 TAP
**把通過的子測試名也印出來**，`/^not ok/m` 又只匹配得到最外層那一行（它是**檔案**層級的、
不帶測試名）。兩者相乘：**只要檔案裡有任何一條紅，指名任何一條測試都會被判成通過。**

正確的判準是整行比對 `^\s*not ok \d+ - <名稱>$`。兩支腳本都修了；slack 那五個 test 級
對照組重跑之後**確實都變紅**，那邊本來就是實的，只是舊判定證明不了。

> **一般形式**：對照組是擋假綠的東西，而它自己也需要一次反向檢查。
> 「指名一條不該變紅的斷言，確認它被判為沒變紅」——**兩個方向都要跑**。

### 一個跨兩個檔案的缺陷，單點替換表達不出來

「收件匣變動不把焦點搶回關閉鈕」的第一版 mutation 是把 overlay 那個聚焦 effect 的依賴改回
`close`。它**紅不起來** —— 因為修法有兩處（effect 的依賴陣列，以及父層把回呼改成穩定的
identity），任一處單獨還原都不足以重現。

這不是假綠（斷言是對的），但那個 mutation 證明不了東西。處置是換一個**等價而單點**的形狀
（把一次性的聚焦綁到一個會變的值上）。**「有 mutation」與「那個 mutation 重現得了缺陷」
又是兩個動作。**

### `deliver()` 的重複檢查與記錄之間隔著一個 await

探針抓到的：計數說 10、合併的通知說 **11**。檔案 adapter 刻意做「先建立監看、再掃描落點」的
雙重讀取，於是同一份投遞的兩次 `deliver()` 可以**都**通過重複檢查，然後各自往下走。
`store.add` 以主鍵覆寫，所以收件匣裡仍然只有一筆 —— **但到達發出了兩次**。

修法是在 `await` 之後**再檢查一次**，並且**與 await 之前同樣分流**（同內容靜默、不同內容
是可見的識別碼搶佔）。只擋同內容是不夠的：一次搶佔賽進來時，後到的那一份會覆寫紀錄並再發
一次到達。

> 這個缺陷在單元測試裡看不到（那裡的兩次 `deliver` 是循序的），在畫面上也看不到
> （收件匣是對的）。**它只在「兩個由同一份狀態推導出來的數字」被並排呈現時才現形**
> —— 而那正是這個 change 做的事。

## 拒絕分「永久」與「暫時」，而判準不是它發生在哪一層

一則交接因 `body` 過長被拒絕、被消費、沒有通知、沒有留下痕跡，而 agent 回報它已經交出去了
（2026-09-21）。根因不是漏掉一個 if，是**分流的判準錯了**。

當時的實作依「這個失敗由誰算出來」分流：`handoff-service` 自己算出的五種（目標查無、目標歧義、
目標已不在、預填不可能、預填逾時）會發通知，共用攝入路徑算出的（本文過長、投遞過大、識別碼
不合法…）不會。**那條界線是系統的內部結構，對使用者毫無意義** —— 對他而言唯一有意義的分類是
「這件事還有沒有救」。

判準因此改為：**同一份投遞、在使用者不改變任何設定的情況下重送，會不會有不同結果。**

| | 代碼 |
|---|---|
| **永久** | `TOO_LONG`、`TOO_LARGE`、`INVALID_ID`、`MISSING_ID`、`FIELD_TYPE`、`TARGET_NOT_FOUND`、`TARGET_AMBIGUOUS` |
| **暫時** | `MALFORMED`、`CAPACITY`、`PREFILL_UNAVAILABLE` |
| **看 outcome 而非 code** | `DUPLICATE` |

四件承重的事：

- **「在使用者不改變任何設定的情況下」是判準的一半。** 少了它，`PREFILL_UNAVAILABLE`
  （事件回報被關閉）會被判成永久 —— 而使用者把那個開關打開之後，系統仍在提醒他一件已經不再
  成立的事。它與 `CAPACITY` 同類，**即使兩者的 `consume` 在程式碼裡是相反的**。
- **定義域是一次投遞的結果，不是拒絕的代碼。** `DUPLICATE` 一個代碼承載兩種行為：內容相同是
  正常重送（靜默），內容不同是識別碼搶佔（必須讓使用者知道）。以代碼為定義域分辨不出它們。
- **這個判準不決定 `consume`。** 兩者獨立：一份放錯位置的投遞是暫時性失敗，但仍然必須被消費，
  否則它每次掃描都再被讀一遍。綁在一起的實作會把那條路改壞，而沒有任何東西會紅。
- **實作是 exhaustive switch，且有一道守衛擋 `default`**（`scripts/rejection-exhaustive.test.mjs`）。
  加一行 `default: return false` 會把它的全部價值拿掉，而不會有任何東西變紅。
  > 需要這道紀律的證據就在手邊：本 change 的 design 第一版用來**論證它必要性**的那張分類表，
  > 自己漏掉了 `MISSING_ID`。

### 通知的接線在 `IntakeSource`，不在 adapter 的 `deliver`

`TOO_LARGE` 在 `readBounded` 就被擋下並消費掉，**它永遠不會走到 `deliver`**。把接線放在
`HandoffService.deliverFile` 裡，那一種就結構上通知不出來 —— 而 spec 有一條 scenario 明文
要求它可見。`IntakeSource` 是兩條拒絕路徑**唯一都經過**的地方，而且它持有 `#adapter`，
判得出這個落點適不適用「交接的拒絕發通知」那條例外。

## 痕跡不做成 `IntakeRecord`，但**必須**落盤

「交接的失敗對使用者可見」有兩半：發通知、在收件匣留下一則可見的項目。**兩半都要成立** ——
使用者不會無緣無故去打開收件匣，而一則沒有落點的通知說不出發生了什麼。

- **否決「失敗成為 `state: 'failed'` 的 record」**：`IntakeRecord` 帶著待處理的語意 ——
  進 `pendingCount()`（活動列的計數標示）、進保留期、進去重。一則使用者**無法處理**的失敗
  放進那條管線，等於在收件匣裡放一件永遠做不完的事。
- **但它必須跨重啟。** 一則只活在行程記憶體中的警示，其可見性取決於使用者在關掉應用程式之前
  剛好打開過收件匣 —— 而促使他去打開收件匣的那個訊號（通知）正是同一條路徑上的東西。
  兩者同時只在一次執行之內有效時，「可見」在實際使用中等於「不可見」。
- **落盤不得 bump `INTAKE_VERSION`。** loader 是 `version !== INTAKE_VERSION ⇒ return null`，
  遞增一次就把使用者收件匣裡的每一則都丟掉。新欄位一律以 optional 加入。
  反向也成立：舊版讀到多一個區段時，逐欄位白名單原樣丟棄它而 `entries` 一則不少。
- **上界的額度以來源分配。** 痕跡由所有 producer 共用，而第三方來源的格式錯誤可以是高頻的 ——
  交接的失敗被擠進溢位桶之後，這個能力的主要目的就在真實使用中失效了。
  > **這一條是在填 scenario 對照表時才發現沒有載體的**：實作做了，測試沒寫。

### 呈現「N 則投遞被拒絕」等於沒有呈現

此前收件匣對拒絕只有一行彙整與一顆「全部清除」。一個計數器回答不了「哪一則」「為什麼」
「我要怎麼辦」中的任何一個，而使用者對一則他自己交辦的工作正是要問這三件事。
使用者的原話是：「收件匣沒看到剛剛的那份交接資料。」

**而說明原因的文案早就寫好了** —— `intake.rejectReason` 有 11 條，含
`TOO_LONG: 'too long to review'`，**在整個 repo 裡沒有任何消費者**。字典完整性的守衛只驗兩份
字典的 key 對齊，不驗 key 有沒有被接上，所以這完全靜默。

清除也改為逐則：一次清光會讓使用者為了清掉一則第三方投遞的格式錯誤，順手清掉一則他還沒處理
的交接失敗。

### 一個仍然開著的缺口

`IntakeStore.expireContent()`（內容過期，保留去重鍵）**沒有任何 production 呼叫端**。
spec 只承諾「內容 SHALL **可**過期」，所以它不算違規 —— 但實務後果是已接受的交接本文永久
留在 `intake.json` 裡累積。本文上限放寬之後這件事的份量變大了；量測顯示在可預見的量級上仍然
無感（250,000 字元 × 10 則 ＝ 3.6 MB，落盤 13 ms）。

## 「已送出」沒有事件，而判定的後果從暫時變成了持久

`intake-inbox-usability` 讓已開好的項目在 prompt 送出之後離開收件匣（落盤 `settledAt`）。
「使用者按下 Enter」發生在 pty 之內。~~注入的 hooks 不含 `UserPromptSubmit`~~ —— **since
`companion-test-fixes` they do**, and a submission sets the wait state to busy at once. The check below
did not change: it still reads busy / awaiting-choice, and now also sees a submission that uses no tool.

- **此前的判定是「不再是 ready」**，那把落回 `unknown` 的事件（不認得種類的 `Notification`、
  `SessionEnd`、不認得的事件）一併當成送出。那在過去只撤掉一個暫時的「待送出」標示；
  **落盤之後，一次誤判就把交接的本文從它唯一的呈現位置永久移除**，而且沒有復原的入口。
  判定因此收窄為 `busy` / `awaiting-choice`（`intake-prefill.ts` 的 `isSubmitted`），
  **標示與了結共用這一個判定** —— 兩處各自判斷的話，標示消失而項目還在（或反之）。
- **代價（已由 `UserPromptSubmit` 清償）**：送出之後 agent 若一個工具都沒用就回答完，此前不會被判為送出。
  Now the submission event makes it busy before any tool. The check was not loosened; the missing
  event was added, as this note said it should be.
- **替身要 `busySeconds` 才走得到這條路** —— still true, for a different reason. The stub now reports
  `UserPromptSubmit` for every line, but then `Stop` within milliseconds, and the two almost always land in
  one drain (busy → ready folds to ready). A probe that needs "submitted" must hold busy with `busySeconds`
  (or `answerSeconds`), not rely on the default stub.

## 移除一個 folder 不會關閉它的 session

實測查證（`folders:remove` 與 renderer 都不修剪）：folder 被移出 workspace 之後，它的 session 仍在
renderer 的 session 清單裡，只是**沒有 rail 入口**。已開好那一段若只問「session 還在不在」，
那一則會永遠留著 —— 使用者沒有任何地方可以關掉它。篩選因此同時要求 session 所在的 folder
仍在 workspace 中。**這個行為本身（孤兒 session）不在收件匣的範圍內**（已轉為 issue #51），碰到時不要以為是
收件匣的缺陷。

## 到達時間不是發生時間 —— 回補讓兩者分家（dogfood 踩到）

第一版收件匣以相對的**到達**時間呈現每一則，dogfood 當場看到：昨天的 Slack 提及寫著「剛剛」。
它們是應用程式啟動時一次回補進來的 —— 回補是 `slack-intake-source` 的主幹，**於是「到達」與
「發生」在這個 app 裡常態性地不同**，而一整批回補的項目到達時間幾乎相同，依它排序等於沒有排序。

處置是投遞格式的選填欄位 `occurredAt`（`intake-inbox-usability`）。三件承重的事：

- **它歸在第三方撰寫的那一組。** Slack adapter 是經共用落點投遞的 producer，它寫的東西與外部
  producer 同樣不受信任。所以它只用於呈現與排序，不作任何判斷依據，**不進去重摘要**
  （見 `docs/lessons/slack.md` 第二節：摘要裡每多一個會變的欄位，就多一種假的識別碼搶佔）。
- **有效時間不得晚於到達時間。** 不夾住的話，任何一份投遞宣告一個未來的時刻就能把自己釘在
  最上面。說得比較早只會讓自己排得比較後面，那不是投遞者想要的方向，所以只夾一邊。
- **只收帶時區的 ISO 8601。** `Date.parse` 接受的格式由實作定義，而不帶時區的時刻會被當成
  **本機時間** —— 同一份投遞在不同時區的機器上呈現成不同的時刻，卻沒有任何錯誤。

**已經收進來的項目不回填。** 從 Slack 的識別碼（`slack:<team>:<channel>:<ts>`）反推是做得到的，
但那會讓收件匣依賴一個單一來源的識別碼格式 —— 而識別碼同樣是 producer 挑的。

## 預填的 prompt 活不過 pty —— 「已開好」要在啟動時了結（dogfood 踩到）

`intake-inbox-usability` 的第一版讓已開好的項目在「送出／手動清除／session 不存在」時離開收件匣。
dogfood 看到的是改版前接受的那幾則一直不消失：它們的 session 被還原了、沒有「已送出」的紀錄。
**而根因比「清舊資料」更一般**：預先填入的 prompt 住在 pty 的輸入處，pty 活不過應用程式 ——
重開之後被還原的 session 裡已經沒有那一則 prompt 可以送出，「送出之前看得到本文」的理由不在了。

- 啟動時一次了結（`IntakeStore.settleOpened()`），**必須在任何來源開始投遞之前** ——
  晚了的話，一則在啟動瞬間到達即接受的交接會被一起了結。
- **連帶：探針不能再把已接受的項目種進落盤檔來測已開好那一段**（它們一啟動就被了結）。
  `runOpenedLifecycle` 因此改成在同一次執行中接受產生，並以同一個 profile 重開一次驗結尾。

## The drop point has three readers, and the third must not repeat what the first two showed

A drop point is read by the startup scan, by the watcher's `add` / `change` events, and — since
`intake-periodic-rescan` — by a re-read every 30 s that does not depend on the watcher at all (the
watcher once missed an outbox silently; see `docs/lessons/handoff.md` §15).

**Re-reading is not free for every file left in the drop point.** A file left behind after a
*visible* outcome would repeat it on every tick: a full-inbox (`CAPACITY`) trace would count again
("repeated 120 times" in an hour), and a file the app decided to consume but could not remove would
repeat its whole outcome — on the handoff path, an OS notification. So `IntakeSource` records, per
path, the `(mtimeMs, size)` a file had **when it was read** (the `stat` `readBounded` already takes;
a second `stat` afterwards could record a version that was never handled), and the periodic re-read
skips a recorded file while it is unchanged. Recorded:

- a visible outcome that left the file (today only `CAPACITY`);
- a `deliver` that **threw**. An in-process retry is not safe: the store changes memory before it
  saves, and report adoption records the delivery before its effects, so a retry can meet its own
  half-applied first attempt and be taken for a same-content duplicate — consumed silently, never
  arriving. Before the re-read existed, the retry happened at the next start, with clean memory; the
  record keeps it that way;
- a removal that failed (the `rm` is caught now; before, it rejected `start()`).

**Not recorded**: files left with nothing visible (unparseable). Reading them again is free, and it is
what lets a half-written file be picked up once complete.

**The one exception**: a `CAPACITY` file is handed over again once `IntakeService.hasRoom()` — the
spec always promised that retry, and until the re-read nothing in production delivered it (the unit
test that "carried" it called `scan()` by hand).

Only the periodic re-read consults the record; the startup scan, `endSession`'s scan and watcher
events handle whatever they see. And `scan()` now **waits** for a file already being handled instead
of skipping it: `endSession` scans and then deletes the outbox, and skipping a file the re-read was
in the middle of would delete it under the re-read.
