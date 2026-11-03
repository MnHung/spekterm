## MODIFIED Requirements

### Requirement: 使用者在接受之前看得到本文全文，且本文以純文字呈現

**待處理的** intake SHALL 在使用者接受它之前呈現**本文全文**。

**這是這條管線唯一的人類閘門能否成立的前提。** 少了它，使用者按下送出所依據的全部資訊是標題、
發起者與來源標籤，而**這三者皆為第三方逐字撰寫**：一則標題寫著「README 的錯字（小事）」、
本文夾帶指示的投遞，在介面上與一則真實的請求無法區分。

**該人類閘門的作用域即「本文為第三方逐字撰寫」。** 本文非第三方撰寫的投遞（由使用者自己 session
裡的 agent 撰寫、且由他當下的交辦觸發，見 `agent-handoff-source`）SHALL 得於到達時直接建立
session，**不停留於待處理狀態等待接受**。要使用者為一件他兩秒前才交辦的事再同意一次，是在問一個
可預測答案的高頻問題。

**放寬的有兩件事：「等使用者按一下」，以及隨它而來的長度上限。** 純文字呈現、攝入時的正規化、
交付內容與呈現內容逐字元相等、界線的 nonce —— **一律不放寬**，理由與第三方投遞完全相同：
agent 撰寫的本文仍可能被它讀過的內容塑形（它可能剛讀完一則 intake、一個 issue、一份不受信任的
repo 檔案）。**被移除的是人類閘門與隨它而來的預算，不是標示。**

**第三方逐字撰寫的本文超過可呈現的長度時，該份投遞 SHALL 於投遞階段即被拒絕**，SHALL NOT 以
截斷呈現。截斷點由投遞者決定，於是他可以把指示放在被截掉的那一段；拒絕使「呈現的內容等於交付
的內容」成為一條**沒有例外**的性質。

**該長度上限 SHALL 訂在「一個人會實際讀完」的量級**，SHALL NOT 訂在某個技術極限 ——
它是這道人類閘門有效性的**唯一旋鈕**，而把它調大以「少拒絕一些」不會讓任何東西變紅。

**而本文非第三方撰寫時，SHALL 適用一個依據不同的上限。** 上一段那個上限的**全部依據**是
使用者要逐字讀完才能按下接受，而這條路徑上沒有那道閘 —— 一個為閱讀預算而訂的數字，落在一條
沒有閱讀預算要保護的路徑上，擋掉的是一份工作交接包本來就該有的長度（背景、查證過的數字、
要讀的檔案、紀律），**而投遞者收不到任何回饋，它連自己被擋了都不會知道**。

**但「因此不設上限」SHALL NOT 被採納。** 交付給 agent 的內容置於一份檔案之中，由它自行讀取
（見「prompt 完全由系統組成……」），而本文大到讓它一次讀不完時，**收尾界線永遠不進脈絡** ——
「界線之外的不算數」靜默失效，接手的 agent 得到的是半份工作，而它不會知道自己只讀到一半。
**那正是本能力要消滅的失效形狀換一個位置重現。**

因此 first-party 本文的長度上限 SHALL 以「**接手的 agent 能否一次讀完交付的整份內容**」為
依據。該依據的性質與人類閘門那個相反：**把它調大不是讓人比較累，是讓交付靜默地只到一半。**

**該上限的值 SHALL 由實測得出，且實測所用的 agent 版本 SHALL 被記載** —— 它取決於 agent
讀取檔案的行為，那是 agent 的行為而非本系統的行為（與本能力對注入機制的要求同一條紀律）。
取值 SHALL 保守地低於實測門檻。

**系統資源的消耗 SHALL NOT 作為該上限的依據。** 已量測：可預見量級上的落盤與跨行程傳輸
皆在毫秒級。以資源為依據會讓這個上限看起來可以「等硬體變快再調大」，而那與真正的失效模式無關。

**A teammate's handoff (`teammate-handoff`) is the one item that passes the acceptance gate with the
first-party limit.** Its body was written by another person's agent, so to the recipient it is third-party text:
the gate, the full body before accepting, the folder the user confirms, normalization, plain-text rendering and the
first prompt filled in but not sent all apply. **Its length limit SHALL be the same-machine handoff's**
(the first-party value above), not the third-party one, as decided in spekterm-server's PRD (§7.2, §13.1,
2026-11-03): a handoff is the same kind of thing whether it crosses a repository or a person, so the sending agent
works with one limit, and a body that fits on one machine is never refused for going to a teammate. **The cost is
stated, not hidden**: the recipient may have a longer text to read before accepting, which weakens the reading
budget this requirement calls the gate's only knob — for this source only. The third-party limit for every other
source SHALL NOT change. The two choices — which prompt, which limit — SHALL be carried as two separate facts of the
item, so that one cannot change with the other.

**分流的是「套哪一個」，不是「怎麼量」** —— 長度的尺度對兩類本文 SHALL 相同。兩種尺度並存
會使邊界上的一次拒絕無法向任何人解釋。

呈現 SHALL 附上本文的長度，使「這則很長」本身是一個看得見的訊號；**該訊號 SHALL 涵蓋不經
接受即建立 session 的項目** —— 那正是長本文實際落腳的地方。

**本文全文的呈現 SHALL NOT 截斷**，無論該項目待處理或已接受。已接受的交接其本文只在一處
呈現，而「按下送出」是那條路徑上唯一的閘 —— 截斷它等同讓使用者在看不到全文的情況下送出。
長本文 SHALL 以可捲動的方式呈現。

**本文 SHALL 以純文字呈現**：SHALL NOT 套用任何標記語言的渲染、SHALL NOT 載入任何遠端資源、
SHALL NOT 產生可點選的連結。（不可列印字元的移除發生在**攝入**，見上一條 requirement ——
在呈現層做會使交付的那一份與它不同。）**本條涵蓋已接受的項目**：直接建立 session 的交接同樣
會被使用者讀到，其呈現不因為沒有經過接受而放寬。

這是本應用程式**第一次把第三方逐字撰寫的文字渲染進自己的介面** —— 既有那些「渲染不受信任
markdown」的紀律，其作用域是使用者自己 repo 裡的檔案，不涵蓋此處；而一個遠端圖片會讓投遞者
在使用者只是掃一眼收件匣的那一刻得到回條。

#### Scenario: 待處理的 intake 呈現本文全文

- **WHEN** 一則待處理的 intake 被檢視
- **THEN** 其本文的完整內容被呈現

#### Scenario: 本文中的標記語法以字面文字呈現

- **WHEN** 一則 intake 的本文含有標記語言的語法（例如圖片與連結的寫法）
- **THEN** 該語法以字面文字呈現，且畫面上不存在對應的圖片元素或可點選的連結

#### Scenario: 本文過長的投遞在投遞階段被拒絕

- **WHEN** 一份**本文為第三方逐字撰寫**的投遞，其本文超過可呈現的長度上限
- **THEN** 該份投遞被拒絕，收件匣中不出現該則 intake

#### Scenario: 本文非第三方撰寫者不經接受即建立 session

- **WHEN** 一則本文非第三方撰寫的投遞到達，且其目標已由接收端解析出
- **THEN** 對應的 session 被建立，而使用者未執行任何接受動作

#### Scenario: 不經接受者其本文仍以純文字呈現且仍受長度上限約束

- **WHEN** 一則不經接受即建立 session 的交接，其本文含有標記語言的語法
- **THEN** 該語法以字面文字呈現，且畫面上不存在對應的圖片元素或可點選的連結
- **AND** 其**投遞**超過大小上限時，該份投遞於投遞階段即被拒絕
  （**該上限自本 change 起是這類本文唯一適用的長度約束** —— 第三方本文適用的上限不再套用，
  見本 requirement 正文）

#### Scenario: 本文非第三方撰寫者不受本文長度上限約束

- **WHEN** 一份本文非第三方撰寫的投遞，其本文長度超過第三方本文適用的上限，
  但未超過 first-party 適用的上限
- **THEN** 該份投遞正常進入收件匣，其本文未被截斷
- **AND** 對應的 session 被建立

#### Scenario: first-party 本文超過其依據所定的上限時被拒絕

- **WHEN** 一份本文非第三方撰寫的投遞，其本文超過 first-party 適用的長度上限
- **THEN** 該份投遞被拒絕，且該次拒絕對使用者可見

#### Scenario: 已接受項目的長本文全文不截斷

- **WHEN** 一則不經接受即建立 session 的交接，其本文遠長於一個畫面可容納的量
- **THEN** 其本文的呈現與交給 agent 的內容逐字元相同
- **AND** 該呈現附有本文的長度

#### Scenario: A teammate's long body passes the gate whole

- **WHEN** a teammate's handoff arrives with a body longer than the third-party limit and within the handoff limit
- **THEN** it waits in the inbox as a pending item with its whole body and its length shown, and no session is
  created until the user accepts it

#### Scenario: Other third-party sources keep their limit

- **WHEN** a delivery in the shared drop point has a body longer than the third-party limit and within the handoff
  limit
- **THEN** it is refused as too long

### Requirement: 未處理的項目數在不打開收件匣的情況下可見

收件匣 SHALL 於活動列的入口上呈現目前待處理的項目數。該數與使用者打開收件匣後看到的待處理項目
**SHALL 出自同一次求值** —— 不是兩處各自判斷什麼算「待處理」。

沒有待處理項目時 SHALL NOT 呈現任何計數標示（**SHALL NOT 呈現 `0`，也 SHALL NOT 留下佔位**）。
一個恆常存在的標示不構成提示。

該數 SHALL 於收件匣**從未被打開過**的情況下同樣正確，並 SHALL 於項目被接受或忽略之後隨即反映。
被接受的項目其預填逾時而退回待處理時，該數 SHALL 隨之回復。它 SHALL 跨應用程式重啟保留。

routing 解析不出目標 folder 的項目 SHALL 計入 —— 它仍然是一件待處理的事，而它恰恰更需要注意。

**A scheduled handoff that has not been opened yet SHALL NOT count** (`scheduled-handoff`): nothing about it
waits for the user, and a badge that counts it would stay lit for days. Once its one automatic opening has been
attempted and it is still pending, it is an ordinary pending item and SHALL count. The count and the inbox SHALL still come from one evaluation:
the inbox lists scheduled handoffs apart from the pending items the count describes.

**A teammate handoff waiting for the user to send or discard it SHALL count** (`teammate-handoff`): it waits for
the user as a pending item does, and it may wait while its agent has ended. A confirmed one that waits only for the
connection or a rate limit SHALL NOT count: nothing about it waits for the user. The count and the inbox SHALL still
come from one evaluation: the Outgoing tab lists exactly the waiting teammate handoffs the count includes.

**被拒絕的投遞其彙整計數 SHALL NOT 計入本標示** —— 兩者是不同的東西，其可見性仍由收件匣之內
的彙整呈現承擔（見「投遞以檔案落點為契約，且落點的內容是不受信任的」）。

> **「出自同一次求值」是行為條款，不是措辭。** 若計數與收件匣內容各自判斷什麼算「待處理」，
> 兩份定義可以無聲地分岔，而症狀是「標示說三件、打開只有兩件」—— 沒有任何一邊會失敗。
>
> **缺口：拒絕在收件匣之外自此完全看不見。** 一次識別碼搶佔的畫面呈現是「沒有計數標示、
> 桌面安靜」，與什麼都沒發生一模一樣。此前那道警示倚賴「使用者會定期打開收件匣看一眼」，
> 而本能力正是把那個習慣換掉的東西。這是一條**已裁決的取捨**，不是疏漏；它與
> `docs/lessons/intake.md` 第五節那條「取捨之間的交互」屬於同一條鏈，放寬任何一格之前要回去看。

#### Scenario: 從未打開過收件匣時仍呈現計數

- **GIVEN** 應用程式啟動後使用者未曾開啟收件匣
- **WHEN** 一則 intake 進入收件匣
- **THEN** 活動列的收件匣入口上呈現計數 `1`

#### Scenario: 計數與收件匣內的待處理項目一致

- **GIVEN** 收件匣中有三則待處理項目
- **WHEN** 使用者檢視活動列的收件匣入口，再打開收件匣
- **THEN** 入口上的計數為 `3`，且收件匣中呈現的待處理項目恰為三則

#### Scenario: 處理掉一則之後計數隨即減少

- **GIVEN** 收件匣中有三則待處理項目
- **WHEN** 使用者忽略其中一則
- **THEN** 計數變為 `2`

#### Scenario: 沒有待處理項目時不呈現計數標示

- **GIVEN** 收件匣中所有項目都已被接受或忽略
- **WHEN** 使用者檢視活動列的收件匣入口
- **THEN** 該入口上不存在任何計數標示

#### Scenario: 計數跨重啟保留

- **GIVEN** 收件匣中有兩則待處理項目
- **WHEN** 應用程式重新啟動
- **THEN** 活動列的收件匣入口上呈現計數 `2`

#### Scenario: 解析不出目標 folder 的項目仍計入

- **GIVEN** 一則 intake 的 routing 解析不出任何 folder
- **WHEN** 使用者檢視活動列的收件匣入口
- **THEN** 該則項目計入其中

#### Scenario: 只有被拒絕的投遞時不呈現計數標示

- **GIVEN** 沒有任何待處理項目，但有數則投遞被拒絕
- **WHEN** 使用者檢視活動列的收件匣入口
- **THEN** 該入口上不存在任何計數標示
- **AND** 打開收件匣後，那些拒絕以彙整的形式呈現

#### Scenario: A scheduled handoff that is not due is not counted

- **GIVEN** the inbox has one pending item and one handoff scheduled for tomorrow
- **WHEN** the user looks at the activity bar's inbox entry
- **THEN** the count is `1`

#### Scenario: A due handoff that did not open is counted

- **GIVEN** a scheduled handoff whose time came but whose session could not be created
- **WHEN** the user looks at the activity bar's inbox entry
- **THEN** that handoff is counted

#### Scenario: A teammate handoff waiting for confirmation counts

- **GIVEN** the inbox has one pending item
- **WHEN** an agent writes a valid teammate handoff
- **THEN** the activity bar's inbox entry shows `2`, and after the user presses Send on it, `1`
