# keyboard-navigation Specification

## Purpose

以鍵盤在 workspace 之內**導航**與**排序** —— 於當前 **rail 項目**的 session 之間切換、於 rail
項目之間切換、開啟建立 session 的入口（並使該入口可完全以鍵盤完成選擇），以及調整 repo 與
session 的順序。

**作用域是「rail 上的項目」，不是「repo」**（`global-session` 起）：rail 的第一列是一個不隸屬
任何 workspace folder 的全域項目，而四顆 session 快捷鍵在它上面同樣生效。**只有 `Shift+↑↓`
（repo 排序）例外** —— 全域項目不是 workspace 的成員，沒有順序可言。

選取或焦點改變時，目標 SHALL 被捲進它所在的每一個捲動容器 —— **切過去了卻看不到，等於這次導航
沒有完成**。

這些快捷鍵的成立條件是「**終端幾乎永遠持有焦點**」：攔截必須早於 xterm 將按鍵寫入 pty，且被
攔截的按鍵不得抵達 pty；對話框或選單正在等待使用者裁決時，一律讓位。

**排序快捷鍵有一條導航快捷鍵沒有的例外**：`Shift+arrow` 就是文字選取鍵，因此它在**可編輯文字**
持有焦點時完全讓路（而導航快捷鍵在編輯器裡仍然生效）。兩者的差別必須在各自的 requirement 裡寫明，
否則規格自相矛盾。

## Requirements

### Requirement: 以鍵盤在當前 repo 的 session 之間切換

系統 SHALL 提供快捷鍵，於**當前選中的 rail 項目內**將 focused session 切換至下一個或上一個：

- `Ctrl+Tab` —— 下一個 session
- `Ctrl+Shift+Tab` —— 上一個 session

**作用域為 rail 上選中的項目，涵蓋全域項目**（見 `global-session`）—— 全域 session 與各 folder 的
session 分屬不同的分頁列，切換 SHALL NOT 跨越項目。

順序 SHALL 為**分頁列上的位置序**（即使用者拖曳排出來的順序），SHALL NOT 為「最近使用順序」——
位置序是使用者自己決定的，只有它可預測。

到達末端時 SHALL 循環（最後一個的下一個是第一個，反之亦然）。

當前項目沒有 session、只有一個 session、或沒有選中任何 rail 項目時，這兩個快捷鍵 SHALL 為無操作，
且 SHALL NOT 產生錯誤。

**Focus inside the OpenSpec change view is an exception** (see `openspec-panel`, "`Ctrl+Tab`
switches artifacts while focus is in the change view"): there these two shortcuts switch the change's
artifacts and SHALL NOT switch the focused session. The exception is decided by where focus is, the
same model as `Ctrl+P` — with focus in the terminal, the editor, or anywhere else, they switch
sessions as above.

#### Scenario: 切換至下一個 session

- **WHEN** 當前項目有多個 session，使用者按下 `Ctrl+Tab`
- **THEN** focused session 變為分頁列上的下一個 session，終端顯示其內容

#### Scenario: 切換至上一個 session

- **WHEN** 當前項目有多個 session，使用者按下 `Ctrl+Shift+Tab`
- **THEN** focused session 變為分頁列上的上一個 session

#### Scenario: 於全域項目內切換 session

- **WHEN** 選中的是全域項目且它有多個 session，使用者按下 `Ctrl+Tab`
- **THEN** focused session 變為全域項目分頁列上的下一個 session，且不切換至任何 folder 的 session

#### Scenario: 於末端循環

- **WHEN** focused session 為分頁列上的最後一個，使用者按下 `Ctrl+Tab`
- **THEN** focused session 變為分頁列上的第一個

#### Scenario: 順序依分頁位置，不依使用順序

- **WHEN** 使用者先聚焦第三個分頁、再聚焦第一個分頁，然後按下 `Ctrl+Tab`
- **THEN** focused session 變為**第二個**分頁（位置序的下一個），而非第三個（最近使用的那個）

#### Scenario: 只有一個 session 時為無操作

- **WHEN** 當前項目只有一個 session，使用者按下 `Ctrl+Tab`
- **THEN** focused session 不變，且應用程式不產生錯誤

#### Scenario: Ctrl+Tab in the change view does not switch sessions

- **WHEN** the current item has several sessions, focus is inside the OpenSpec change view, and the
  user presses `Ctrl+Tab`
- **THEN** the focused session does not change

### Requirement: 以鍵盤在 repo 之間切換

系統 SHALL 提供快捷鍵，將當前選中的 rail 項目切換至 rail 上的下一個或上一個：

- `Ctrl+↓` —— 下一個項目
- `Ctrl+↑` —— 上一個項目

順序 SHALL 為 **rail 上的呈現順序**，且該順序 SHALL 涵蓋**全域項目**（見 `global-session`：它恆為
rail 的第一個項目）。到達末端時 SHALL 循環 —— 於是自最後一個 folder 按 `Ctrl+↓` 會回到全域項目。

rail 上只有一個項目時（workspace 尚未加入任何 folder，rail 僅有全域項目），這兩個快捷鍵 SHALL 為
無操作，且 SHALL NOT 產生錯誤。

**沒有選中任何項目時**（冷啟動的預設狀態，見 `global-session`），這兩個快捷鍵 SHALL 選中 rail 上的
第一個項目，SHALL NOT 為無操作 —— 否則使用者必須先動一次滑鼠才能開始用鍵盤。

#### Scenario: 切換至下一個項目

- **WHEN** rail 上有多個項目，使用者按下 `Ctrl+↓`
- **THEN** 當前選中的項目變為 rail 上的下一個，主舞台與 side panel 皆隨之呈現該項目

#### Scenario: 切換至上一個項目

- **WHEN** rail 上有多個項目，使用者按下 `Ctrl+↑`
- **THEN** 當前選中的項目變為 rail 上的上一個

#### Scenario: 自第一個 folder 往上切換即抵達全域項目

- **WHEN** 當前選中的是 rail 上的第一個 folder，使用者按下 `Ctrl+↑`
- **THEN** 當前選中的項目變為全域項目

#### Scenario: 於末端循環回到全域項目

- **WHEN** 當前選中的是 rail 上的最後一個 folder，使用者按下 `Ctrl+↓`
- **THEN** 當前選中的項目變為全域項目（rail 上的第一個項目）

#### Scenario: 尚未選中任何項目時選中第一個

- **WHEN** 應用程式剛啟動、尚未選中任何 rail 項目，使用者按下 `Ctrl+↓`
- **THEN** 全域項目（rail 上的第一個項目）成為選中的項目

#### Scenario: rail 只有全域項目時為無操作

- **WHEN** workspace 尚未加入任何 folder 且全域項目已被選中，使用者按下 `Ctrl+↓`
- **THEN** 當前選中的項目不變，且應用程式不產生錯誤

### Requirement: 以鍵盤開啟建立 session 的入口

系統 SHALL 提供快捷鍵 `Ctrl+T`，開啟**當前選中之 rail 項目**的建立 session 入口（spawn 選單），
其行為 SHALL 與以滑鼠觸發該入口相同 —— 包含選單的錨定位置。**作用域涵蓋全域項目**（見
`global-session`）。

當前沒有選中任何 rail 項目時，`Ctrl+T` SHALL 為無操作，且 SHALL NOT 產生錯誤。

**`Ctrl+T` 在 pty 內是 `transpose-chars`**（zsh 與 bash readline 的預設綁定，實測），
攔截它即從 pty 內的程式手上沒收該鍵。此取捨見 design D8。

其實作為「**找到既有的建立入口並觸發它**」（那正是「錨定位置與滑鼠相同」得以成立的原因），
而該入口以其 `aria-label` 定位 —— **該文案 SHALL 取自字典，SHALL NOT 硬編**（見
`ui-localization` 的「以文案定位介面元素的程式碼自字典取得該文案」）。`aria-label` 在此同時是
選擇器：硬編它，一次文案改動就會**靜默地**廢掉這顆快捷鍵 —— 字串比對不會使型別檢查失敗，
也不會有任何紅燈。**全域項目的建立入口 SHALL 可被同一條路徑定位**，SHALL NOT 因它不是 folder
而需要第二套選擇器。

#### Scenario: 以 Ctrl+T 開啟 spawn 選單

- **WHEN** 當前有選中的 rail 項目，使用者按下 `Ctrl+T`
- **THEN** spawn 選單開啟，且其位置與以滑鼠觸發建立入口時相同

#### Scenario: 於全域項目開啟 spawn 選單

- **WHEN** 選中的是全域項目，使用者按下 `Ctrl+T`
- **THEN** spawn 選單開啟，選擇一個目標後於全域項目建立 session

#### Scenario: 沒有選中任何項目時為無操作

- **WHEN** 沒有選中任何 rail 項目，使用者按下 `Ctrl+T`
- **THEN** 不開啟任何選單，且應用程式不產生錯誤

#### Scenario: 定位建立入口的文案取自字典

- **WHEN** 檢視 `Ctrl+T` 用以定位建立入口的 `aria-label` 文案
- **THEN** 該文案取自字典，而非硬編於程式碼

### Requirement: spawn 選單可完全以鍵盤操作

以快捷鍵叫出的選單，SHALL 能完全以鍵盤完成選擇 —— **否則按完仍須摸滑鼠，快捷鍵等於沒做**。

選單開啟時，焦點 SHALL 落在第一個選項。`↓` / `↑` SHALL 於選項之間移動並循環，
`Enter` SHALL 觸發當前選項，`Esc` SHALL 關閉選單。

選單的兩個選項於介面上的標籤為 **Run claude** 與 **Login shell**（UI 的文案為英文，
見 `ui-localization`）。

#### Scenario: 選單開啟時焦點落在第一個選項

- **WHEN** 使用者以 `Ctrl+T` 開啟 spawn 選單
- **THEN** 焦點位於選單的第一個選項

#### Scenario: 以方向鍵於選項間移動並循環

- **WHEN** 焦點位於選單的最後一個選項，使用者按下 `↓`
- **THEN** 焦點移至第一個選項

#### Scenario: 以 Enter 觸發當前選項

- **WHEN** 使用者以方向鍵將焦點移至 **Login shell** 並按下 `Enter`
- **THEN** 建立一個 login shell 的 session，且選單關閉

### Requirement: 終端持有焦點時快捷鍵仍生效，且該按鍵不得抵達 pty

終端幾乎永遠持有焦點 —— 那是這個應用程式的常態。**導航與排序**快捷鍵皆 SHALL 在終端持有焦點時仍然生效。

因此攔截 SHALL 早於 xterm 將按鍵寫入 pty。被攔截的按鍵 SHALL NOT 抵達 pty ——
否則跑在裡面的 agent 會收到一串它沒有預期的控制序列。

**`Ctrl+C` SHALL NOT 被本能力挪用**，它必須維持中斷訊號（既有要求）。

**本要求的作用域限於本能力的快捷鍵（導航與排序），SHALL NOT 被讀作對整個應用程式的通則。**
side panel 的檔案快速開啟入口（見 `quick-open`）是**第三組**快捷鍵，其作用域與本條相反 ——
它在終端持有焦點時**讓路給 pty，且該按鍵必須抵達 pty**，因為 `claude` 以它顯示 previous history。

本條原本的措辭（作用域為「導航與排序」）已足以排除第三組，兩者並不互相矛盾；此處明寫，是因為
本能力的規格反覆以「導航 vs 排序」的**兩組對照**解釋各種焦點情形，而那個形式會讓讀者把它讀成一份
窮舉表 —— 進而把「終端裡仍然生效」誤推到第三組身上。**新增任何一組快捷鍵時，都必須回到此處寫明
它落在哪一邊。**

**`Ctrl+Tab` / `Ctrl+Shift+Tab` with focus inside the OpenSpec change view** switch the change's
artifacts instead of sessions (see `openspec-panel`). That exception is decided by focus and does
not touch this requirement: with focus in the terminal they switch sessions and do not reach the pty.

**`Ctrl+Shift+M` (maximize / restore the side panel) is on the navigation side**: it SHALL take
effect with focus in the terminal, and the key SHALL NOT reach the pty (see "`Ctrl+Shift+M`
maximizes and restores the side panel").

**The zoom keys (`Ctrl+=`, `Ctrl++`, `Ctrl+-`, `Ctrl+0`; see `ui-appearance`) are a fifth group, owned by
`ui-appearance`.** Their scope: they SHALL take effect with focus in the terminal and in the editor, and while a
dialog or a menu is open, and the keys SHALL NOT reach the pty. xterm sends no byte for `Ctrl+=`, `Ctrl+-` or
`Ctrl+0`, so taking them costs a program in the pty nothing; `Ctrl+Shift+-` (`^_`) is not one of them and keeps
reaching the pty.

#### Scenario: 終端持有焦點時切換 session

- **WHEN** 使用者的焦點在終端中，按下 `Ctrl+Tab`
- **THEN** focused session 切換至下一個 session

#### Scenario: 終端持有焦點時調整順序

- **WHEN** 使用者的焦點在終端中，按下 `Shift+↓` 或 `Shift+→`
- **THEN** 對應的 repo 或 session 於其清單中往下／往右移動一格

#### Scenario: 被攔截的按鍵不寫入 pty

- **WHEN** 使用者的焦點在終端中，按下 `Ctrl+Tab`、`Ctrl+↑`／`Ctrl+↓`，或 `Shift+↑`／`Shift+↓`／`Shift+←`／`Shift+→`
- **THEN** pty **未**收到任何對應的位元組（終端中沒有出現該按鍵的字元或控制序列）

#### Scenario: The zoom keys do not reach the pty

- **WHEN** focus is in the terminal and the user presses `Ctrl+=`, `Ctrl+-` and `Ctrl+0`
- **THEN** the zoom changes and the pty receives no bytes for any of them

### Requirement: 編輯器持有焦點時快捷鍵仍生效

**導航**快捷鍵 SHALL 在 side panel 的編輯器持有焦點時仍然生效。編輯器會吃掉按鍵 —— 既有的存檔快捷鍵正是必須註冊於編輯器內部才攔得到，外層的監聽攔不到它。

**排序快捷鍵不在此列** —— 它們於可編輯文字持有焦點時 SHALL NOT 生效（見「排序快捷鍵於可編輯文字持有焦點時不生效」）。`Shift+arrow` 就是文字選取鍵，攔下它會使編輯器裡的選取整個消失；而 `Ctrl+Tab` 在編輯器裡沒有這種代價。**兩組快捷鍵在這一點上的行為是不同的，此處與該例外必須各自寫明它作用於哪一組**，否則規格自相矛盾。

**side panel 的檔案快速開啟入口（見 `quick-open`）於編輯器持有焦點時亦 SHALL 生效** —— 編輯器
位於 side panel 之內，而該能力的作用域正是「焦點在 side panel 之內」。此處列出的三組快捷鍵
**不是**一份窮舉的對照表可以推論的：導航與 quick open 在編輯器裡都生效但理由不同（前者是本能力
刻意的要求，後者是其作用域的推論），而排序讓路。**新增任何一組快捷鍵時，都必須回到此處寫明它
落在哪一邊。**

**The OpenSpec change view is a fourth case, and the editor is not in it.** With focus inside the
change view, `Ctrl+Tab` / `Ctrl+Shift+Tab` switch the change's artifacts (see `openspec-panel`); the
editor belongs to the Files identity, so with focus in the editor they keep switching sessions as
above.

**`Ctrl+Shift+H` (hibernate the current session) is on the navigation side**: it SHALL take effect with focus
in the editor. It is a session command, like `Ctrl+Shift+W`, not a text-editing key, so it has none of the
reordering shortcuts' cost.

**`Ctrl+Shift+M` (maximize / restore the side panel) is on the navigation side** as well: it SHALL
take effect with focus in the editor. It is a layout command with no text-editing meaning, so it has
none of the reordering shortcuts' cost.

The zoom keys take effect with focus in the editor too (see `ui-appearance`), taken before the editor sees them,
as `Ctrl+Tab` is.

#### Scenario: 編輯器持有焦點時切換 session

- **WHEN** 使用者的焦點在 side panel 的編輯器中，按下 `Ctrl+Tab`
- **THEN** focused session 切換至下一個 session

#### Scenario: 編輯器持有焦點時排序快捷鍵讓路

- **WHEN** 使用者的焦點在 side panel 的編輯器中，按下 `Shift+→`
- **THEN** 編輯器選取了一個字元，且未觸發任何排序

#### Scenario: Ctrl+Shift+H takes effect with focus in the editor

- **WHEN** focus is in the side panel's editor, the focused session is running, and the user presses
  `Ctrl+Shift+H`
- **THEN** that session is hibernated

### Requirement: 對話框或選單開啟時導航快捷鍵不生效

本能力的快捷鍵（**導航與排序**）SHALL NOT 於任一對話框或選單開啟期間生效。對話框（session 命名、檔案操作的命名與刪除確認、收件匣與對話計量的全視窗 overlay、Settings、未存變更的提示）與選單（spawn 選單、右鍵選單）正在等待使用者的裁決 —— 否則使用者會在回答問題的同時把畫面切走或把清單重排，而選單的方向鍵導覽也會被搶走。

判定 SHALL 以對話框與選單的無障礙角色（`dialog` / `menu`）之存在為準，**SHALL NOT 逐一列舉特定的對話框** —— 任何遵守該慣例的新對話框皆自動被尊重。此規則的失效模式因此不是判定邏輯出錯，而是**某個對話框漏了該角色標記，於是靜默地不被尊重**；驗收 SHALL 因此以**多種不同的對話框**各驗一次，而非只驗一種。

> 對話框裡的輸入框同時也是可編輯文字元素 —— 排序快捷鍵因此有**兩道**讓路的理由（本條與「排序快捷鍵於可編輯文字持有焦點時不生效」）。這是刻意的冗餘：對話框裡沒有輸入框的情況（刪除確認、全視窗 overlay）只有本條擋得住。

**The zoom keys are the exception** (see `ui-appearance`): they take effect while a dialog or a menu is open,
because zooming neither moves focus nor answers anything, and the dialog stays open.

The maximized side panel, including its Graph and Timeline views, is **not** a dialog: the shortcuts
work while it is shown.

#### Scenario: 命名對話框開啟時按下導航快捷鍵

- **WHEN** session 的命名對話框開啟中，使用者按下 `Ctrl+Tab`
- **THEN** focused session 不變，對話框維持開啟

#### Scenario: 全視窗 overlay 開啟時按下導航快捷鍵

- **WHEN** the inbox's full-window overlay is open and the user presses the shortcut that switches
  repos
- **THEN** the selected folder is unchanged and the overlay stays open

#### Scenario: 選單開啟時按下導航快捷鍵

- **WHEN** spawn 選單開啟中，使用者按下 `Ctrl+Tab`
- **THEN** focused session 不變，選單維持開啟

#### Scenario: 對話框開啟時按下排序快捷鍵

- **WHEN** session 的命名對話框開啟中，使用者按下 `Shift+↓`
- **THEN** rail 的順序不變，對話框維持開啟，且該按鍵照常抵達對話框的輸入框（選取行為不受影響）

#### Scenario: The zoom keys work while a dialog is open

- **WHEN** the session naming dialog is open and the user presses `Ctrl+=`
- **THEN** the zoom grows one step and the dialog stays open with its input unchanged

### Requirement: 以鍵盤調整 repo 的順序

系統 SHALL 提供快捷鍵，將**當前選中的 repo** 於 rail 上往上或往下移動一格：

- `Shift+↑` —— 往上移動一格
- `Shift+↓` —— 往下移動一格

移動後該 repo SHALL 仍為選中的 repo —— 選中的是那個 repo，不是那個位置。新的順序 SHALL 持久化
（見 `workspace-folders` 的「folder 的順序由使用者決定」）。

**置頂段與其餘 folder 之間的分界本身算一格。** 選中的 repo 位於分界的相鄰位置時，往分界方向的
一格 SHALL 使它跨越分界並改變其置頂狀態（見 `rail-pinning` 的「使項目跨越分界的移動即改變其
置頂狀態」），而它在 rail 上的位置**幾乎不動** —— 改變的是它的置頂狀態與分界的位置。這一格
SHALL NOT 被跳過：跳過它會使「剛被取消置頂、位於其餘段第一個」這個狀態**以鍵盤永遠到不了**，
而那正是取消置頂之後的落點。

**順序的位置 SHALL 以 folder 清單為基準計算，SHALL NOT 以 rail 上的列位置計算。** rail 比 folder
清單多了全域項目那一列，兩者的索引相差一位。以列位置計算的具體失效是兩個方向都錯：**`Shift+↑`
會使第二個 folder 算出等於它自身的目標位置而靜默無操作**；**`Shift+↓` 會使第一個 folder 多跳
一格**。兩者在 workspace 只有兩個 folder 時都看不出來 —— 夾制會把越界的目標拉回末端，結果與正確
實作相同。

**到達端點時 SHALL NOT 循環**，該按鍵 SHALL 為無操作。這與導航快捷鍵的「到達末端時循環」**刻意
不同**：導航是巡覽，越過末端繞回開頭什麼都沒被改變；排序是**改變資料**，越過末端繞回開頭意味著
「把第一名丟到最後一名」—— 那是使用者按過頭時最不想發生的事，且要再按 N-1 次才回得來。

**當前選中的項目為全域項目時，這兩個快捷鍵 SHALL 為無操作**（見 `global-session`：它不是
workspace 的成員，沒有順序可言，其置頂狀態亦不可取消）。SHALL NOT 將它與第一個 folder 交換位置，
亦 SHALL NOT 移動它而不持久化 —— 兩者都會讓使用者看見一個隨後自行復原的位移。

沒有選中的項目時，這兩個快捷鍵 SHALL 為無操作，且 SHALL NOT 產生錯誤。

**workspace 只有一個 folder 時，SHALL 僅在該次移動不跨越分界時為無操作。** 此處原本無條件寫成
「只有一個 folder 時為無操作」；分界算一格之後，唯一的那個 folder **永遠**與分界相鄰 ——
未置頂時 `Shift+↑` SHALL 置頂它，置頂時 `Shift+↓` SHALL 取消置頂。**這個矛盾用既有的
scenario 抓不到**：那條 scenario 只斷言「順序不變」，而在兩種讀法之下順序都不變。

**`Shift+arrow` 在 pty 內送得出去**（`CSI 1;2A`–`D`），攔截它即從 pty 內的程式手上沒收該鍵。實測
zsh 與 bash 皆未綁定；**已知的犧牲者是 `claude` 自己的 agents view**。此取捨見 design D1 ——
**該裁決有前提**（claude 的 `Shift+↑↓` 不是常用路徑），前提若不再成立，退路是 `Ctrl+Shift+arrow`。

#### Scenario: 將選中的 repo 往下移動一格

- **WHEN** workspace 有三個以上的 folder 且皆未置頂，使用者按下 `Shift+↓`
- **THEN** 選中的 repo 於 rail 上與其下方的 repo 交換位置

#### Scenario: 到達端點時不循環

- **WHEN** 選中的是**置頂段的第一個** repo，使用者按下 `Shift+↑`
- **THEN** rail 的順序不變、該 repo 仍在第一個位置（**不**繞至最後一個），**且其置頂狀態不變**
- **AND** 對稱地，選中最後一個未置頂的 repo 並按下 `Shift+↓` 時亦然

> 此處原本以「rail 上的第一個 repo」表述，且只斷言順序不變。分界算一格之後，若該 repo **未
> 置頂**，`Shift+↑` 會**置頂它** —— 而「順序不變」字面上仍為真，於是斷言保持綠燈，**fixture 的
> 置頂狀態卻已被改掉**，該段落其後每一條斷言都建立在被污染的狀態上。端點因此必須指明是**置頂段
> 的**第一個，並一併斷言置頂狀態。

#### Scenario: 移動後仍為選中的 repo

- **WHEN** 使用者以 `Shift+↓` 移動當前選中的 repo
- **THEN** 該 repo 於新位置仍為選中，主舞台呈現的仍是它

#### Scenario: 只有一個 folder 且不跨界時為無操作

- **WHEN** workspace 只有一個 folder 且它未置頂，使用者按下 `Shift+↓`
- **THEN** 順序不變、它仍未置頂，且應用程式不產生錯誤

#### Scenario: 只有一個 folder 時仍可跨界

- **WHEN** workspace 只有一個 folder 且它未置頂，使用者按下 `Shift+↑`
- **THEN** 該 folder 成為置頂，且此變更已持久化

#### Scenario: 選中全域項目時為無操作

- **WHEN** 使用者選中全域項目並按下 `Shift+↓`
- **THEN** rail 的順序不變，全域項目仍在第一個位置，且應用程式不產生錯誤

#### Scenario: 第一個 folder 仍可往下移動一格

- **WHEN** workspace 有三個以上的 folder，使用者選中第一個 folder 並按下 `Shift+↓`
- **THEN** 該 folder 與第二個 folder 交換位置 —— 恰好一格，不因全域項目佔據 rail 首位而多跳

#### Scenario: 第二個 folder 仍可往上移動一格

- **WHEN** workspace 有三個以上的 folder，使用者選中第二個 folder 並按下 `Shift+↑`
- **THEN** 該 folder 與第一個 folder 交換位置 —— 不因索引偏移而靜默無操作

#### Scenario: 往下跨越分界即取消置頂

- **WHEN** 選中的是置頂段的最後一個 repo，使用者按下 `Shift+↓`
- **THEN** 該 repo 不再置頂，成為其餘段的第一個，且此變更已持久化

#### Scenario: 往上跨越分界即置頂

- **WHEN** 選中的是其餘段的第一個 repo，使用者按下 `Shift+↑`
- **THEN** 該 repo 成為置頂，位於置頂段的末端，且此變更已持久化

### Requirement: 以鍵盤調整 session 的順序

系統 SHALL 提供快捷鍵，將**當前選中之 rail 項目的 focused session** 於分頁列上往左或往右移動一格：

- `Shift+←` —— 往左移動一格
- `Shift+→` —— 往右移動一格

**作用域涵蓋全域項目**（見 `global-session`）。順序 SHALL 為分頁列上的位置序，且 **rail 的 session
子列 SHALL 隨之呈現相同的新順序** —— 兩個視圖共用同一個順序（見 `workspace-layout`）。移動後該
session SHALL 仍為 focused。

**到達端點時 SHALL NOT 循環**，該按鍵 SHALL 為無操作（理由同上一條）。

沒有選中任何 rail 項目、當前項目沒有 session、或只有一個 session 時，SHALL 為無操作，且 SHALL NOT
產生錯誤。

#### Scenario: 將 focused session 往右移動一格

- **WHEN** 當前項目有多個 session，使用者按下 `Shift+→`
- **THEN** focused session 於分頁列上與其右方的分頁交換位置

#### Scenario: 於全域項目調整 session 順序

- **WHEN** 選中的是全域項目且它有多個 session，使用者按下 `Shift+→`
- **THEN** 該 session 於全域項目的分頁列上與其右方的分頁交換位置

#### Scenario: rail 的 session 子列呈現相同的新順序

- **WHEN** 使用者以 `Shift+→` 移動 focused session
- **THEN** rail 的 session 子列以相同的新順序呈現該項目的 session

#### Scenario: 到達端點時不循環

- **WHEN** focused session 為分頁列上的最後一個，使用者按下 `Shift+→`
- **THEN** 分頁列的順序不變（**不**繞至第一個）

#### Scenario: 只有一個 session 時為無操作

- **WHEN** 當前項目只有一個 session，使用者按下 `Shift+←`
- **THEN** 順序不變，且應用程式不產生錯誤

### Requirement: 排序快捷鍵於可編輯文字持有焦點時不生效

焦點落在可編輯文字元素（輸入框、文字區、`contenteditable`、side panel 的編輯器）上時，排序快捷鍵 SHALL NOT 生效，且該按鍵 SHALL 照常抵達該元素 —— `Shift+arrow` **就是文字選取鍵**，選取行為必須完全不受影響。

**終端 SHALL NOT 被視為可編輯文字元素**，即使其輸入路徑在實作上是一個隱形的文字區。終端是這個
應用程式的常態焦點，排序快捷鍵在它上面 SHALL 生效（見「終端持有焦點時快捷鍵仍生效」）。

因此判定 SHALL NOT 以「焦點元素是不是一個文字區」為準 —— 編輯器與終端的輸入路徑**都是**文字區，
那樣的判定會使排序快捷鍵在終端上（也就是絕大多數時間）**靜默失效**。

**此例外僅限排序快捷鍵**；導航快捷鍵不受此限（見「編輯器持有焦點時快捷鍵仍生效」）。

此規則有**兩個相反的失效方向**，驗收 SHALL 對兩者各驗一次 —— 只驗一邊等於沒驗：

- 判定過寬（把終端也當成可編輯文字）→ 快捷鍵在終端上失效。
- 判定過窄（漏掉這個例外）→ 編輯器裡的文字選取消失。

#### Scenario: 編輯器持有焦點時的 Shift+arrow 仍是文字選取

- **WHEN** 使用者的焦點在 side panel 的編輯器中，按下 `Shift+→`
- **THEN** 編輯器選取了一個字元，且 repo 與 session 的順序皆不變

#### Scenario: 終端持有焦點時排序快捷鍵仍生效

- **WHEN** 使用者的焦點在終端中，按下 `Shift+↓`
- **THEN** 選中的 repo 於 rail 上往下移動一格

### Requirement: 以鍵盤關閉當前 session

系統 SHALL 提供快捷鍵 `Ctrl+Shift+W`，關閉當前 focused 的 session。當前沒有選中任何 rail 項目、
或該項目沒有任何 session 時，`Ctrl+Shift+W` SHALL 為無操作，且 SHALL NOT 產生錯誤。
**作用域涵蓋全域項目**（見 `global-session`）。

**鍵位選 `Ctrl+Shift+W` 而非 `Ctrl+W`**：後者在 zsh 是 `backward-kill-word`、bash 是
`unix-word-rubout`（終端裡的高頻刪字鍵，實測），攔截它即從 pty 內的程式手上沒收該鍵；而它沒有
`Ctrl+T` 的「GNOME Terminal 早已把它拿去開新分頁」豁免。`Ctrl+Shift+<字母>` 在終端協定裡編碼
不出來，pty 內收不到，代價為零（同複製貼上用 `Ctrl+Shift+C/V` 的理由，見 design D1）。

攔截於 window 的 capture 階段（同既有快捷鍵，早於 xterm 與 Monaco），被攔下的 `Ctrl+Shift+W`
SHALL NOT 抵達 pty。對話框或 overlay 開啟時 SHALL 不生效 —— 沿用 `[role="dialog"]` 的存在判定
（未存變更對話框開著時按它，不該把 session 關掉）。

#### Scenario: 以 Ctrl+Shift+W 關閉當前 session

- **WHEN** 當前有 focused 的 session，使用者按下 `Ctrl+Shift+W`
- **THEN** 該 session 被關閉，且該按鍵不抵達 pty

#### Scenario: 於全域項目關閉 session

- **WHEN** 選中的是全域項目且它有 focused 的 session，使用者按下 `Ctrl+Shift+W`
- **THEN** 該全域 session 被關閉

#### Scenario: 終端持有焦點時仍能關閉 session

- **WHEN** 終端持有焦點，使用者按下 `Ctrl+Shift+W`
- **THEN** 當前 session 被關閉，且該按鍵不抵達 pty

#### Scenario: 沒有 session 時為無操作

- **WHEN** 當前沒有選中任何 rail 項目，或該項目沒有任何 session，使用者按下 `Ctrl+Shift+W`
- **THEN** 不關閉任何東西，且應用程式不產生錯誤

#### Scenario: 對話框開啟時不生效

- **WHEN** 一個對話框（例如未存變更確認）開啟時，使用者按下 `Ctrl+Shift+W`
- **THEN** 不關閉任何 session

### Requirement: 選取或焦點改變時目標捲入可視範圍

以鍵盤改變選取、焦點或順序時，目標 SHALL 於其所在的**每一個**捲動容器內可見。切過去了卻看不到，
等於這次導航沒有完成 —— 使用者會判定該快捷鍵壞了，而畫面上確實沒有任何事情發生。

**本要求以不變式表述，不以按鍵清單表述。** 涵蓋範圍至少包含：

| 觸發 | 目標 | 需捲動的容器 |
|---|---|---|
| `Ctrl+↑↓` | 選中的 rail 項目 | rail（縱向） |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | focused session | 分頁列（橫向）**與** rail（縱向 —— 未置頂項目的 session 子列位於 rail 的捲動容器內；置頂項目的子列不隨捲動移開，恆常可見） |
| `Shift+↑↓` | 被移動的 rail 項目 | rail（縱向） |
| `Shift+←→` | 被移動的 session | 分頁列（橫向）與 rail（縱向） |
| `Ctrl+Shift+W` | 關閉後承接焦點的 session | 分頁列（橫向）與 rail（縱向） |
| `Ctrl+T` 建立的新 session | 該 session | 分頁列（橫向）與 rail（縱向） |

**順序改變是與選取、焦點並列的獨立觸發。** 以 `Shift+↑↓` 移動選中的 rail 項目時，選取與焦點
**皆未改變** —— 只有位置變了，而該項目仍 SHALL 被捲入可視範圍。一個只在選取或焦點改變時才捲動
的實作，對這一列的失效是靜默的。

**「可見」SHALL 指未被任何覆蓋於捲動容器之上的元素遮擋，SHALL NOT 僅指幾何上落在容器的視口
之內。** 一個把目標貼齊視口上緣的捲動，若該處被一個固定於頂端的元素覆蓋，則**捲動確實發生了、
目標確實落在視口的座標範圍內、而使用者什麼都沒看到**。

**rail 的置頂段 SHALL NOT 覆蓋於其捲動容器的視口之上**（見 `rail-pinning` 的「置頂段不隨 rail
捲動」）—— 本條 SHALL 由**結構**滿足，SHALL NOT 由「捲動時額外避讓一段距離」的機制滿足。避讓
機制要正確，兩件事都得對：其一，避讓的量 SHALL 取自**當下量得的**尺寸（該區域隨置頂項目的增減
與 session 子列的展開而變，一個寫死的常數必然錯）；其二，避讓 SHALL **只**施加於該區域**之外**
的目標 —— 置頂段自身的目標恆常完整可見，對它們施加同樣的避讓會使瀏覽器為了滿足一個它永遠無法
滿足的條件而捲動（該段不隨捲動移動），淨結果是畫面無故跳回頂端，而那違反下述「目標已完整可見時
SHALL NOT 捲動」。把置頂段放在捲動容器之外，這兩件事都不必做對。

**唯一的例外是使用者直接操作該容器內元素所造成的改變** —— 他點得到的東西本來就在該容器的視野裡，
為它捲動只會讓畫面跳。**此例外僅及於被直接操作的那一個容器**：點選 rail 的 session 子列會使
**分頁列**的 focused 分頁改變，而那個分頁可能在橫向視野之外 —— 該容器 SHALL 捲動。

**目標已完整可見時 SHALL NOT 捲動。** 每次按鍵都把目標拉到容器正中，會讓使用者連按時畫面持續跳動。

**選取、焦點與順序皆未改變時 SHALL NOT 捲動。** 上一條管的是捲動的**幅度**，這一條管的是**時機**
—— 兩者不可互相取代。與導航無關的狀態更新（session 標題更新、狀態轉為已結束、以及任何不改變
目標位置的重繪）SHALL NOT 觸發捲動：使用者手動捲到的位置是他的意圖，而背景中運作的 session
持續產生這類更新，一次都不能拿來搶走捲動位置。

**呈現元件的重新掛載亦不構成「改變」。** 同一個捲動容器內可能有一個以上的捲動目標（rail 同時
持有「選中的項目標題列」與「focused session 的子列」）—— 若掛載也算一次改變，重排時後執行的
那一個就會蓋掉前一個剛完成的捲動，使用者看到的是畫面停在他沒有操作的地方。

捲動 SHALL 於 DOM 反映新狀態**之後**執行。順序改變後元素的位置隨之改變，在同一輪更新中量測會得到
舊位置；而該副作用 SHALL NOT 置於 state 的 updater 之中。

**驗收 SHALL 在項目數確實超出容器可視範圍的情況下進行。** 內容未超出時捲動容器不會捲動，於是
「目標可見」這個斷言**恆為真** —— 一個在此條件下取得的綠燈，證明不了任何事。

**遮擋的驗收 SHALL 以幾何關係斷言**（目標的上緣不低於覆蓋區域的下緣），SHALL NOT 僅斷言「目標
落在捲動容器的視口之內」—— 後者對一個被覆蓋區域**完全蓋住**的目標照樣通過，而那正是這一條要防的
失效。

**「SHALL NOT 捲動」的驗收 SHALL 先確立目標當下並不完整可見。** 目標若已完整可見，捲動位置本來
就不會變（見上面「目標已完整可見時 SHALL NOT 捲動」），於是斷言對正確與錯誤的實作**一樣通過**。
這是本要求最可能的假綠來源。

**驗收「目標被捲入可視範圍」時 SHALL 先確認除了待測的實作之外沒有別的東西會捲它。** 瀏覽器的
scroll anchoring 會在**視野上方**的內容變動時自動補償捲動位置，那足以讓目標恰好變得可見 ——
於是一個完全不捲的實作照樣通過。造出「變動發生在視野下方」的條件，anchoring 就不介入。

**「SHALL NOT 捲動」的驗收 SHALL 一併確立那個本該被忽略的更新確實發生了。** 「捲動位置不變」是
相對判定 —— **觸發它的那個機制整個沒有發生時，它照樣是綠的**。驗收因此必須同時斷言該更新已反映
於畫面（例如該 session 的狀態呈現確實由運作中轉為已結束），否則這條斷言證明的是「什麼都沒發生」，
而不是「發生了而畫面沒有被搶走」。

#### Scenario: 切換至視野外的 rail 項目時捲入視野

- **WHEN** rail 的項目數超出其可視範圍，使用者以 `Ctrl+↓` 連續切換至一個當下不可見的項目
- **THEN** 該項目被捲入 rail 的可視範圍，且完整可見

#### Scenario: 捲入視野的目標不被置頂段遮擋

- **WHEN** rail 的項目數超出其可視範圍且 rail 已向下捲動，使用者以 `Ctrl+↑` 切換至其餘段中
  **緊接於分界之下**的那個 repo
- **THEN** 該 repo 的標題列完整可見，且其上緣不低於置頂段的下緣 —— 它沒有被捲到置頂段的底下

#### Scenario: 置頂段內的目標不觸發捲動

- **WHEN** rail 的項目數超出其可視範圍且 rail 已向下捲動，使用者以 `Ctrl+↑` 切換至一個**置頂的**
  repo（它恆常完整可見）
- **THEN** rail 的捲動位置不變 —— 不因避讓機制而跳回頂端

#### Scenario: 切換至全域項目時其餘段不被捲動

- **WHEN** rail 的其餘段已向下捲動，使用者以 `Ctrl+↑` 自第一個未置頂 folder 切換至全域項目
- **THEN** 全域項目可見（它位於捲動容器之外，恆常如此），**且其餘段的捲動位置不變**

> 此處原本為「循環至頂端的項目時**捲回頂部**」。置頂段移出捲動容器之後，全域項目恆常可見，
> 原本的 THEN **恆為真**，且「捲回頂部」與本要求新增的「置頂段內的目標不觸發捲動」直接牴觸。
> 改以「不捲動」表述，它才重新具備鑑別力。

#### Scenario: 切換至視野外的 session 時分頁列橫向捲動

- **WHEN** 當前項目的 session 數使分頁列超出其寬度，使用者以 `Ctrl+Tab` 切換至一個當下不可見的分頁
- **THEN** 該分頁被捲入分頁列的可視範圍

#### Scenario: 切換 session 時其 rail 子列亦捲入視野

- **WHEN** rail 的其餘段超出其可視範圍，使用者以 `Ctrl+Tab` 切換至一個**未置頂** repo 底下、
  其 rail 子列不可見的 session
- **THEN** 該 session 的 rail 子列被捲入其餘段的可視範圍

> 限定為「未置頂 repo 底下的 session」：置頂 repo 的子列位於捲動容器之外、恆常可見，對它們而言
> 這條 THEN 恆為真，證明不了任何事。

#### Scenario: 移動 rail 項目後它仍可見

- **WHEN** rail 的項目數超出其可視範圍、選中的項目當下落在視野之外，使用者以 `Shift+↑↓` 移動它
- **THEN** 該項目被捲入可視範圍

#### Scenario: 移動 session 後它仍可見

- **WHEN** 分頁列超出其寬度、focused session 的分頁當下落在視野之外，使用者以 `Shift+←→` 移動它
- **THEN** 該分頁被捲入分頁列的可視範圍

#### Scenario: 目標已完整可見時不捲動

- **WHEN** 目標項目在按鍵之前即已完整可見
- **THEN** 捲動容器的捲動位置不變

#### Scenario: 以滑鼠選取部分可見的項目時不捲動

- **WHEN** 使用者以滑鼠點選 rail 上一個**部分超出可視範圍**的項目（例如下緣被裁掉一半）
- **THEN** rail 的捲動位置不變 —— 使用者的直接操作不觸發捲動

#### Scenario: 點選 rail 子列時分頁列仍捲動

- **WHEN** 分頁列超出其寬度，使用者以滑鼠點選 rail 上一個其分頁不可見的 session 子列
- **THEN** 該分頁被捲入分頁列的可視範圍 —— 例外僅及於被直接操作的那一個容器

#### Scenario: 背景 session 的狀態更新不搶走 rail 的捲動位置

- **WHEN** rail 超出其可視範圍，使用者已手動捲動它使 focused session 的 rail 子列**不完整可見**，
  此時一個 session 結束（其狀態呈現確實由運作中轉為已結束），而選取、焦點與順序皆未改變
- **THEN** rail 的捲動位置不變

#### Scenario: 背景 session 的狀態更新不搶走分頁列的捲動位置

- **WHEN** 分頁列超出其寬度，使用者已手動捲動它使 focused session 的分頁**不完整可見**，此時一個
  session 結束（其狀態呈現確實由運作中轉為已結束），而選取、焦點與順序皆未改變
- **THEN** 分頁列的捲動位置不變

### Requirement: Hibernate the current session from the keyboard

The system SHALL provide the shortcut `Ctrl+Shift+H` to hibernate the focused session of the selected rail
item (see `session-hibernation`). **The scope includes the global item** (see `global-session`).

It SHALL be a no-op, and SHALL NOT produce an error, when no rail item is selected, when the item has no
session, or when the focused session is dormant or exited.

**Why `Ctrl+Shift+H`**: a `Ctrl+Shift+<letter>` chord cannot be encoded in the terminal protocol, so the pty
loses nothing (the same reasoning as `Ctrl+Shift+W`).

It is intercepted at the window's capture phase like the other shortcuts, and the intercepted key SHALL NOT
reach the pty. It SHALL NOT take effect while a dialog or menu is open (the existing `[role="dialog"]` /
`[role="menu"]` rule).

#### Scenario: Ctrl+Shift+H hibernates the current session

- **WHEN** the terminal has focus, the focused session is running, and the user presses `Ctrl+Shift+H`
- **THEN** that session is hibernated, and the key does not reach the pty

#### Scenario: Hibernating a global session

- **WHEN** the global item is selected, its focused session is running, and the user presses `Ctrl+Shift+H`
- **THEN** that global session is hibernated

#### Scenario: No-op without a running session

- **WHEN** no rail item is selected, or the item has no session, or its focused session is dormant or
  exited, and the user presses `Ctrl+Shift+H`
- **THEN** nothing is hibernated and the application produces no error

#### Scenario: Suppressed while a dialog is open

- **WHEN** a dialog is open — the session-rename dialog, a Files dialog, or the Settings dialog — and the user
  presses `Ctrl+Shift+H`
- **THEN** no session is hibernated

### Requirement: `Ctrl+Shift+M` maximizes and restores the side panel

The system SHALL provide `Ctrl+Shift+M`, which maximizes the side panel when it is not maximized and
restores it when it is (see `workspace-layout`, "The side panel can be maximized over the main
stage"). It SHALL work wherever focus is — the terminal, the editor, the rest of the side panel —
and with no rail item selected. While a dialog or a menu is open it SHALL do nothing, using the same
`[role="dialog"]` / `[role="menu"]` check as every other shortcut.

It is intercepted in the window's capture phase like the other shortcuts, and the key SHALL NOT
reach the pty. `Ctrl+Shift+<letter>` cannot be encoded in the terminal protocol, so taking it costs
nothing inside the pty (the reason `Ctrl+Shift+W` and `Ctrl+Shift+H` were chosen).

#### Scenario: Ctrl+Shift+M from the terminal maximizes the side panel

- **WHEN** focus is in the terminal and the user presses `Ctrl+Shift+M`
- **THEN** the side panel is maximized and the key does not reach the pty

#### Scenario: Ctrl+Shift+M restores

- **WHEN** the side panel is maximized, focus is in its editor, and the user presses `Ctrl+Shift+M`
- **THEN** the side panel is restored and the editor's content is unchanged

#### Scenario: Ctrl+Shift+M does nothing while a dialog is open

- **WHEN** the session-rename dialog is open and the user presses `Ctrl+Shift+M`
- **THEN** the side panel's state is unchanged and the dialog stays open
