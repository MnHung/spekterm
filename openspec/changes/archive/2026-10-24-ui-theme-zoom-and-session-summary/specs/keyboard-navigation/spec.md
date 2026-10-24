## MODIFIED Requirements

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
