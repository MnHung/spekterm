# rail-pinning Specification

## Purpose

rail 上的項目可被**置頂** —— 置頂的項目集中於一個**不隨 rail 捲動**的段落，恆常可見。

**這是置頂之於「把 repo 拖到最上面」的全部增量價值**：順序早已可由使用者決定（見
`workspace-folders` 的「folder 的順序由使用者決定」），捲動時不被捲走則否。workspace 的 folder
一多，rail 就會超出視窗，而使用者真正每天在用的那幾個 repo 會跟著被捲出視野。

置頂段與其餘之間有一條明確的**分界**，而那條分界同時是一個**手勢的目標**：任何使項目跨越它的
移動（拖曳、鍵盤排序）就是切換置頂狀態本身 —— 使用者眼中「把它拖到線的上面」與「把它置頂」是
同一個動作。

「置頂的 folder 恆佔清單前綴」這條不變式由**資料的結構**擔保（見 `workspace-folders`），而不是
由「沒有人再送出那種順序」擔保 —— 於是 rail 的呈現順序與 folder 清單的順序恆為同一件事，清單
不需要第二種順序。

## Requirements

### Requirement: rail 的項目可被置頂，置頂的項目恆位於未置頂的項目之前

每一個 workspace folder SHALL 具備一個**置頂**（pinned）狀態，可由使用者切換。

rail SHALL 呈現為兩段 —— **置頂段**與**其餘** —— 兩段之間 SHALL 有明確的視覺分隔。置頂的
folder SHALL 恆位於未置頂的 folder 之前。**「一個置頂的 folder 夾在未置頂的 folder 之間」
SHALL 表達不出來**，而不僅是「不會發生」：這條不變式 SHALL 由資料的結構擔保（見
`workspace-folders` 的「folder 的順序由使用者決定」），SHALL NOT 僅由「沒有人再送出那種順序」
擔保。

**兩段各自之內的順序 SHALL 仍完全由使用者決定** —— 置頂不是一種排序規則，它只決定一個 folder
落在分界的哪一側。

置頂狀態 SHALL 是 workspace 的持久狀態（見 `workspace-folders`），SHALL NOT 只是 rail 的一次性
呈現。

#### Scenario: 置頂一個位於清單中段的 folder

- **WHEN** workspace 有三個以上的 folder，使用者將其中位於中段的一個置頂
- **THEN** 它移至置頂段，位於所有未置頂的 folder 之前

#### Scenario: 兩段之間有視覺分隔

- **WHEN** 使用者檢視 rail
- **THEN** 置頂段與其餘 folder 之間呈現一條明確的視覺分隔

#### Scenario: 未置頂的 folder 無法被排到置頂的 folder 之前

- **WHEN** 使用者嘗試把一個未置頂的 folder 移到某個置頂的 folder 之前
- **THEN** 結果是該 folder **被置頂**，而不是產生一份「未置頂者在置頂者之前」的順序

#### Scenario: 置頂狀態跨重啟存活

- **WHEN** 使用者置頂數個 folder 後重新啟動應用程式
- **THEN** 同樣的 folder 仍為置頂，且兩段各自的順序與重啟前一致

### Requirement: 置頂段不隨 rail 捲動

rail 是一個捲動容器。**置頂段 SHALL 於任何捲動位置保持可見** —— 這是置頂之於「把 repo 拖到
最上面」的全部增量價值：順序早已可由使用者決定，捲動時不被捲走則否。

置頂段 SHALL 涵蓋全域項目、所有置頂的 folder，以及它們**展開中的 session 子列** —— 一個看得到
名稱卻點不到 session 的置頂 repo，並未達成本要求的目的。

兩段之間的視覺分隔 SHALL 於任何捲動位置可見，且 SHALL NOT 隨任一段的內部捲動而移出視野
—— 它是「拖過這條線就改變置頂狀態」的目標，一個會捲走的分界使那個手勢失去參照。

**可置頂的 repo 數量 SHALL NOT 被限制。** 但 **rail SHALL 保證其餘段維持一個可用的最小高度**：
置頂段連同其展開的 session 子列高到足以佔滿 rail 時，SHALL 由**置頂段自身**吸收（其內容仍
SHALL 全部可達），SHALL NOT 使其餘段的可視高度歸零。

**後者不是「置頂太多」才會遇到的情況** —— 全域項目恆為置頂段的成員且其置頂狀態不可取消（見
`global-session`），因此**一個 repo 都沒有被置頂時**，光是它展開數個 session 就足以觸發。
未置頂的 folder 今日只是被捲出視野、捲回來就在；讓它們變成不可達，是比現狀更差的行為。

**本要求的驗收 SHALL 在 rail 的內容確實超出其可視範圍的情況下進行。** 內容未超出時捲動容器不會
捲動，於是「置頂段仍可見」這個斷言**恆為真** —— 一個在此條件下取得的綠燈證明不了任何事。驗收
SHALL 先確立該容器確實可捲動，再斷言其餘的事。

#### Scenario: 捲到底部後置頂段仍完整可見

- **WHEN** rail 的內容超出其可視範圍，使用者將 rail 捲至底部
- **THEN** 置頂段與其下緣的視覺分隔仍完整可見於 rail 的頂部

#### Scenario: 置頂 repo 的 session 子列一併留在視野

- **WHEN** rail 的內容超出其可視範圍，一個置頂的 repo 正展開著它的 session 子列，使用者將 rail
  捲至底部
- **THEN** 該 repo 的 session 子列仍可見，且可被點選

#### Scenario: 置頂段撐滿時其餘段仍可用

- **WHEN** 一個 repo 都沒有被置頂，而全域項目展開的 session 子列多到足以佔滿整個 rail
- **THEN** 其餘段仍保有可用的高度並可捲動，未置頂的 folder 仍到得了；置頂段自身於內部捲動，
  其內容亦全部可達

#### Scenario: 未置頂的 folder 會被捲出視野

- **WHEN** rail 的內容超出其可視範圍，使用者將 rail 捲至底部
- **THEN** 排在最前面的未置頂 folder 已不在視野內 —— 兩段的行為確實不同，而不是內容根本沒有
  超出

### Requirement: 使項目跨越分界的移動即改變其置頂狀態

任何使 folder **跨越兩段之間分界**的移動（以滑鼠拖曳、以鍵盤排序）SHALL 同時改變它的置頂狀態，
SHALL NOT 只改變它的位置。使用者眼中「把它拖到線的上面」與「把它置頂」是同一個動作。

**分界的兩側 SHALL 各自是一個到得了的落點**：置頂段的**最後一格**與其餘段的**第一格**。兩者
SHALL 各自呈現插入指示線，且指示線所示之處 SHALL 與放開後的結果一致（見 `workspace-layout` 的
「拖曳的落點與插入指示線一致」）。

**這兩條指示線 SHALL 在視覺上彼此可辨，且 SHALL 可與分界本身區別。** 兩個落點在幾何上僅相距
數個像素，而其中一條會畫在一條本來就存在的分界線上 —— 兩者若無法區別，使用者在放開之前無從
知道會得到哪一個結果，「落點與指示線一致」這條要求對他而言就不成立。

**落點 SHALL 對應指標實際指向的那一列。** rail 有一個以上的捲動區域，各自獨立裁切；一列被裁切
而不可見時，SHALL NOT 成為命中的結果。以未裁切的幾何比對會使「指標明明停在一個看得見的未置頂
列上」卻命中一個**看不見的置頂列** —— 症狀是一個使用者根本沒有碰過的 repo 被移動並置頂。

**一次「只改變置頂狀態、而未改變它在 folder 清單中之序位」的移動 SHALL 仍被提交。** 把置頂段的
最後一個 folder 移到分界之下時，它在 folder 清單裡的序位**前後同值** —— 若以該序位判定「有沒有
移動」，這次移動會被判為無操作而**靜默丟失**（畫面上就是「拖了半天它沒有被取消置頂」）。判定
SHALL 以**含分界在內的列位置**為準。

#### Scenario: 落點不會命中被裁切的列

- **WHEN** 置頂段的內容多到它自身出現內部捲動（部分置頂列因而不可見），使用者將一個 repo 拖到
  一個**看得見的**未置頂列上並放開
- **THEN** 它落在該列所指示之處，且**沒有任何不可見的列**被當成落點

#### Scenario: 分界兩側的指示線可辨

- **WHEN** 使用者將一個 repo 依序拖至分界之上與分界之下
- **THEN** 兩處呈現的插入指示線彼此可辨，且皆可與分界本身區別

#### Scenario: 把未置頂的 repo 拖到分界之上

- **WHEN** 使用者將一個未置頂的 repo 拖曳至分界之上並放開
- **THEN** 該 repo 成為置頂，並落在置頂段中指示線所示之處

#### Scenario: 把置頂段最後一個 repo 拖到分界之下

- **WHEN** 使用者將置頂段的最後一個 repo 拖曳至分界之下、其餘段第一個 repo 之前並放開
- **THEN** 該 repo 不再置頂，且成為其餘段的第一個 —— 這次拖曳**不**被當作無操作

#### Scenario: 跨界拖曳後順序與置頂狀態一併落盤

- **WHEN** 使用者以跨界拖曳改變一個 repo 的置頂狀態後重新啟動應用程式
- **THEN** 該 repo 仍為新的置頂狀態，且位於新的位置

### Requirement: 置頂狀態有兩個操作入口，且兩者各自需驗收

rail 上每一個 folder 的標題列 SHALL 提供一個切換置頂狀態的控制項。

folder 的標題列 SHALL 另提供**右鍵選單**，其中含切換置頂與移除該 folder。該選單 SHALL 可完全
以鍵盤操作（焦點落在第一項、方向鍵循環、`Enter` 觸發）—— 一個只能用滑鼠點的選單等於沒有做這個
入口。

於 folder 的標題列按下**右鍵** SHALL NOT 啟動拖曳排序。

**兩個入口 SHALL 各自有其驗收，SHALL NOT 以其中一個的通過推論另一個。** 它們是兩條獨立的
程式路徑。

#### Scenario: 以控制項切換置頂

- **WHEN** 使用者觸發一個未置頂 folder 標題列上的置頂控制項
- **THEN** 該 folder 成為置頂並移入置頂段

#### Scenario: 以右鍵選單切換置頂

- **WHEN** 使用者於一個未置頂 folder 的標題列按下右鍵並選擇置頂
- **THEN** 該 folder 成為置頂並移入置頂段

#### Scenario: 右鍵選單可完全以鍵盤操作

- **WHEN** 使用者於 folder 的標題列開啟右鍵選單
- **THEN** 焦點落在第一個項目，方向鍵可於項目間循環，`Enter` 觸發選中的項目

#### Scenario: 右鍵不啟動拖曳

- **WHEN** 使用者於一個 folder 的標題列按下右鍵並移動指標
- **THEN** rail 的順序不變，且不呈現任何插入指示線

### Requirement: 切換置頂狀態時的落點為跨越分界的最小移動

以入口（控制項或右鍵選單）切換置頂狀態時，該 folder 的新位置 SHALL 為跨越分界的**最小移動**：

- 置頂 → 移至**置頂段的末端**
- 取消置頂 → 移至**其餘段的首端**

取消置頂 SHALL NOT 使該 folder 回到它先前於其餘段中的相對位置 —— 該位置在置頂期間並未被保存
（見 design D1）。本規則明訂於此，使兩種期待不會並存。

#### Scenario: 置頂落在置頂段末端

- **WHEN** 已有兩個置頂的 folder，使用者置頂第三個
- **THEN** 它成為置頂段的最後一個，既有兩者的相對順序不變

#### Scenario: 取消置頂落在其餘段首端

- **WHEN** 使用者取消一個 folder 的置頂
- **THEN** 它成為其餘段的第一個，其餘 folder 的相對順序不變

### Requirement: 置頂的指示恆常呈現，未置頂的入口只在指標懸停或焦點位於該列時呈現

置頂控制項的可見性 SHALL 依它當下扮演的角色而定：

- **置頂的項目 SHALL 恆常呈現該控制項** —— 它同時是狀態指示與取消置頂的入口。使用者要能不必
  對照分界的位置就看出哪些項目是置頂的，也要能知道這一列可以被取消置頂。
- **未置頂的項目 SHALL 只在指標懸停於該列時呈現它** —— 它此時只是一個入口，與同列既有的其他
  懸停控制項同一族。

The row's hover controls (an unpinned pin, new session, remove) SHALL also be shown while keyboard focus
is inside the row, so a keyboard user never tabs onto a control that cannot be seen. Focus that a pointer
click leaves on the row SHALL NOT show them. While they are not shown they SHALL NOT narrow the folder's
name: invisible controls that kept their place left the name a few characters wide in a rail with room to
spare. While they are shown they MAY cover the end of the row (the session count, the state dot).

#### Scenario: Keyboard focus in the row shows its controls

- **WHEN** keyboard focus moves into an unpinned folder row and the pointer is elsewhere
- **THEN** the row shows its pin, new-session and remove controls

#### Scenario: Hidden controls do not narrow the name

- **WHEN** the pointer is not on an unpinned folder row and keyboard focus is not in it
- **THEN** the space for the folder's name reaches under where its hidden controls are

#### Scenario: 置頂的列在未懸停時仍呈現指示

- **WHEN** 指標不在某個**置頂**的 folder 列上
- **THEN** 該列仍呈現置頂的指示

#### Scenario: 未置頂的列在未懸停時不呈現控制項

- **WHEN** 指標不在某個**未置頂**的 folder 列上
- **THEN** 該列不呈現置頂控制項
