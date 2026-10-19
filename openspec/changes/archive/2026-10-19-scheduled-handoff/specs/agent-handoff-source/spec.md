## MODIFIED Requirements

### Requirement: agent 於 session 啟動時被告知 spekterm 的存在、可交接的對象與投遞方式

系統 SHALL 於 agent session 啟動時，經**既有的注入接縫**把下列內容放進該 agent 的脈絡：

- 它正執行於 spekterm 之中；
- **目前可交接的對象清單**（名稱與位置）；
- 投遞的位置與格式，含目標欄位可接受名稱或位置兩種形式；
- **所有會使一則投遞被拒絕的約束**，而不只是其中一部分 —— 含本文的長度上限、
  標題的長度上限，以及整份投遞的大小上限，and the scheduling bound and time format;
- 一則交接**可能失敗** —— 以及使用者會在何處看到那次失敗；
- **where it reads the receipt for each file it writes** (see `handoff-receipt`), the statuses a receipt can
  state, and that a file gone from its outbox means its receipt exists;
- **that a handoff may name the time its session opens** (see `scheduled-handoff`): the field, its format with
  the required offset, the scheduling bound, that a time not later than now opens at once, and that a
  scheduled handoff opens only while spekterm runs (at the next start when its time passed while it was
  closed);
- **它自己的固定名字**（見 `agent-peer-name`），以及**如何取得它當下的母、子、兄弟 session**
  （見 `session-lineage`）—— 含對方的名字、對方此刻是否在執行，以及聯絡對方用的是 agent CLI
  自身的訊息功能、以對方的名字定址。

使用者的 repo SHALL NOT 需要為此加入任何檔案或設定 —— 少了這一條，本能力等同一份要求每個 repo
各自抄寫一次的文件。

**母子關係 SHALL NOT 只以快照的形式出現在該內容中。** 該內容只在注入時進入 agent 的脈絡，而子
session 是在注入**之後**才長出來的 —— 該內容 SHALL 告訴 agent 去哪裡取得當下的關係。

**該內容 SHALL 於每次注入時取當下的值**，SHALL NOT 在 session 建立的那一刻固定。可交接的對象
是 workspace 的 folder 清單，**它在 session 存活期間會變**；而注入會在 agent 的脈絡被重建時
（續接、壓縮、清除）再次發生，那正是清單重新取值的時機。

**agent 手上的清單是一份快照，不是一條不變式。** 它與查表的定義域只在注入的那一刻相等；其後
清單可能縮小，因此**零命中是一個可達的正常結果**，不是異常。任何「agent 只會送出解得開的目標」
的推論皆不成立。

**The list SHALL be grouped by parent directory**: each directory once, then the names of the repos in it, one
per line. The introduction SHALL state that a repo's absolute path is its directory joined with its name: when
two repos share a name, that path is the only target that resolves, and the agent must be able to build it. The
listed name SHALL be derived from the path (its last segment) where the introduction is built, not taken as a
separate value, so that the grouping cannot drift from the paths. The directory prefix is then not repeated per
repo — in a workspace of 29 repos the flat list was 1,963 characters of the longest introduction's 7,458, and it
grows with every folder added.

**The introduction SHALL stay within a size budget**: 8,000 characters for a workspace of 30 folders, with
outbox, relations and receipts paths of the length a real user data directory gives, for a session created by a
handoff (the longest variant), checked by a test. Measured with Claude Code 2.1.303, in `-p` and interactive
mode alike: an injected context of 10,000 characters reached the agent whole; one of 10,001 characters was
replaced by a pointer to a file and a preview of about its first 2,000 characters. Past that threshold the agent keeps only the opening — the repo
list, the receipts and every later section are gone at once, and the agent does not know what it was not told.
The budget is the margin below that threshold.

**A workspace larger than the test's fixture SHALL NOT push the introduction past a hard limit below that
threshold**: when the full introduction would exceed it, the list SHALL be cut to the repos that fit, in the
workspace's order, and SHALL state how many repos were left out. Losing the end of the list is a smaller loss
than losing every rule.

**告知失敗 SHALL 降級為「沒有自我介紹」**，SHALL NOT 使 session 無法建立。

**「所有會導致拒絕的約束」SHALL 與實際生效的判定同源，SHALL NOT 為一份另行撰寫的清單。**
**一個未被告知的約束仍是一條死路**: the receipt (`handoff-receipt`) tells the agent about a refusal only
after the fact, so an unstated constraint still costs a refused delivery, and an agent that has ended by then
never reads the receipt. 它會照著自己手上那份說明去寫，被拒絕，然後回報自己已經交出去了。而一份手寫的、宣稱自己完整的清單與實際判定分屬兩處時，
它們會在某一次調整之後分岔，**而分岔不會讓任何東西變紅** —— 這與把可交接對象的清單做成快照
而非取當下值，是同一個失效方式。

**這條已經以最壞的形式發生過**：長度上限從未被告知，一則超過它的交接被消費、沒有留下痕跡，
而來源 agent 回報「已寫出」。

**告知內容 SHALL NOT 以使用者介面的語言呈現。** 它的讀者是 agent 而非使用者，且它承載的措辭
其效力沒有任何載體能驗（與寫給 agent 執行的指令同一側）。

> **覆蓋缺口：「agent 真的把這段內容讀進去了」沒有自動化載體。** 可驗的是系統產生的那份內容
> 正確、注入的設定形狀正確、以及替身 agent 依設定執行了該命令；**「真實的 agent 依此改變了
> 行為」由 dogfood 認定**。理由與 `agent-transcript-stream` 的真實委派同源：要網路、會花錢、
> 回覆不可重現。
>
> **這條缺口比它看起來更大**：整個能力的第一步押在「注入的內容確實進入 agent 的脈絡」這個
> 機制上，而該機制是 agent CLI 的行為，不是本應用程式的行為 —— 它 SHALL 於實作前以真實
> agent 實測，且實測結論與所用的版本 SHALL 被記載。

#### Scenario: 新建的 agent session 脈絡中含有可交接對象的清單

- **WHEN** workspace 中有三個 folder，使用者建立一個 agent session
- **THEN** 注入該 session 的內容中含有該三個 folder 各自的名稱

#### Scenario: The list gives every repo's location without repeating its directory

- **WHEN** the workspace has three folders under one directory and one under another, and one folder in each directory has the same name
- **THEN** the introduction names each of the two directories once on its own line, states how a repo's absolute path is formed, and each folder's absolute path built that way from the text resolves to that folder

#### Scenario: The introduction stays within its budget

- **WHEN** the introduction is built for a workspace of 30 folders under three directories, with real-length paths, for a session created by a handoff
- **THEN** it has at most 8,000 characters

#### Scenario: A very large workspace keeps every rule and cuts the list

- **WHEN** the introduction is built for a workspace whose full list would take it past the hard limit
- **THEN** it is within the hard limit, it still states every constraint, and it states how many repos were left out of the list

#### Scenario: 清單取當下的值而非建立當時的值

- **WHEN** 一個 agent session 建立之後，使用者才把第四個 folder 加入 workspace
- **AND** 該 session 的脈絡其後被重建
- **THEN** 注入的內容中含有第四個 folder 的名稱

#### Scenario: 告知不成立時 session 照常建立

- **WHEN** 自我介紹的內容無法供應
- **THEN** 該 agent session 仍然建立且可正常使用

#### Scenario: 告知的內容涵蓋所有會導致拒絕的長度與大小約束

- **WHEN** 檢視注入 agent 脈絡的內容
- **THEN** 其中說明了本文的長度上限、標題的長度上限，以及整份投遞的大小上限

#### Scenario: 告知的約束與實際生效的判定同源

- **WHEN** 實際生效的投遞大小上限被調整
- **THEN** 注入的內容所述的值隨之改變，無需另行編輯該段文字

#### Scenario: 告知的內容說明失敗是可達的結果

- **WHEN** 檢視注入 agent 脈絡的內容
- **THEN** 其中說明一則交接可能被拒絕、該次失敗呈現於收件匣，and where the agent reads the receipt that states the refusal

#### Scenario: 告知的內容含有自己的名字與取得關係的方式

- **WHEN** 檢視注入一個 claude session 的內容
- **THEN** 其中含有該 session 的固定名字，並說明如何取得它當下的母 session 與子 session，以及以對方的名字聯絡對方

#### Scenario: 由交接建立的 session 於第一次注入時即查得到母 session

- **WHEN** session C 由 session P 交接而來，C 的 agent 於它第一次被注入之後立即查詢自己的關係
- **THEN** 結果中的母 session 為 P

#### Scenario: The introduction states the scheduling field and its bound

- **WHEN** the text injected into an agent's context is examined
- **THEN** it states the `at` field, that the time needs an explicit offset, and the scheduling bound in days

#### Scenario: The stated scheduling bound is the one applied

- **WHEN** the introduction states the scheduling bound as N days
- **THEN** a handoff scheduled N days minus one minute ahead is scheduled, and one scheduled N days plus one minute ahead is refused

### Requirement: 交接於到達時直接建立 session 並送出第一則 prompt，不經使用者接受

一則通過驗證且解析出目標的交接 SHALL 於**到達時**直接建立 session，SHALL NOT 停留於待處理
狀態等待使用者接受。

**Exception: a handoff whose `at` names a time later than its arrival** opens when that time comes, through
this same path, and waits until then as a scheduled item (`scheduled-handoff`). Everything this requirement
says about the opened session applies to it at that moment.

"On arrival" means as soon as a window that has restored its sessions can receive the request: a handoff read
before that — at start, from an outbox written while the application was closed — opens once such a window
exists, and every handoff is opened automatically at most once (`scheduled-handoff`).

該 session SHALL 經**與使用者手動接受時相同的路徑**建立，於是 context 檔的產生、prompt 的寫入時機、
session 清單與持久化一律相同。該則交接 SHALL 記為已接受並記錄它建立的 session 識別碼。

**第一則 prompt SHALL 被填入並送出**，不等使用者（`agent-intake` 的「第一則 prompt 不早於 agent
就緒寫入，第三方本文不代為送出」）。交接的本文是使用者自己的 session 中的 agent 撰寫、由他當下的
交辦觸發 —— 「填好而不送出」在這裡沒有擋下任何他沒同意過的事，只讓每一則交接多一趟切換。
**「不會有 agent 在使用者沒看著的時候自己跑起來」不再是本能力的保證**；使用者看得到它的方式是
rail、通知與交接單（`handoff-brief`）。

**系統 SHALL NOT 把焦點切換到新建立的 session。** 使用者在來源 session 交辦之後，那邊的 agent
通常仍在收尾；未經他的動作而改變焦點是在打斷他。

#### Scenario: 交接到達即建立 session

- **WHEN** 一則合法的交接投遞於某個 session 的落點，目標為 folder B
- **THEN** folder B 中出現一個新的 agent session，而使用者未執行任何接受動作
- **AND** 該則交接於收件匣中的狀態為已接受

#### Scenario: prompt 填入並送出

- **WHEN** 承上，該新 session 的等待狀態首次成為就緒
- **THEN** 送往該 session 的內容含第一則 prompt，其後以另一次寫入、隔開一段間隔送出字元
- **AND** 使用者未於該 session 執行任何動作

#### Scenario: 焦點不被切走

- **GIVEN** 使用者的焦點位於來源 session
- **WHEN** 一則交接到達並建立了新的 session
- **THEN** 焦點仍位於來源 session
- **AND** rail 上選中的項目未改變

#### Scenario: A handoff with a future time does not open on arrival

- **WHEN** a valid handoff with `at` set to tomorrow is written into a session's outbox, targeting folder B
- **THEN** folder B gets no new session, and the handoff is listed in the inbox as scheduled

### Requirement: The introduction states the session commands

The introduction every agent session receives (see "agent 於 session 啟動時被告知 spekterm 的存在、可交接的對象與投遞方式")
SHALL also state the session commands (see `agent-session-control`). This applies to **every agent session**, not
only one created by a handoff: every agent can act on its own session. It SHALL state:

- the shape of each of the three commands (close, hibernate, rename);
- that an omitted target means the agent's own session;
- that any other target is named by a fixed name from the agent's relations file, and only a session in its own
  tree of descendants may be targeted;
- that close and hibernate take effect when the target's current turn ends, and that anything typed into the
  target before then cancels the command;
- that a close of its own session is not carried out but offered to the user, who closes it or keeps it;
- that a rename takes effect at once and changes no fixed name;
- **every constraint that makes a command refused**: the rename name's length limit, and that close and hibernate
  of a running session need the agent's events to be on;
- that its receipt (`handoff-receipt`) states whether the command was accepted, not whether it was carried
  out, and that a descendant's outcome shows in its relations file.

The part of the introduction that describes the relations file SHALL describe its shape as it is (see
`session-lineage`): children nest their own descendants at every depth, and a descendant whose direct parent no
longer exists is marked so. An agent that is not told where its grandchildren are listed cannot address them.

The limits SHALL be derived from the constants the judgement uses, as the handoff limits are. A receipt tells
the agent of a refusal only after the fact, so an unstated constraint still costs a refused command.

#### Scenario: A session not created by a handoff is told the commands

- **WHEN** the user opens a new agent session in a folder, with no handoff involved
- **THEN** the introduction it receives states the three session commands and that an omitted target means its own
  session

#### Scenario: The stated name limit is the one applied

- **WHEN** the introduction states the rename name's length limit as N
- **THEN** a rename command whose name has N characters is carried out, and one with N + 1 characters is refused

#### Scenario: The introduction describes the descendant tree

- **WHEN** an agent session receives its introduction
- **THEN** the introduction states that each child in the relations file lists the sessions it handed off, and what
  the mark for a direct parent that no longer exists means

#### Scenario: The introduction states that there is no reply

- **WHEN** an agent session receives its introduction
- **THEN** the introduction states that a command's receipt says whether it was accepted, not whether it was
  carried out, and that its relations file shows a descendant's outcome

## REMOVED Requirements

### Requirement: agent 得不到投遞結果的回饋，此缺口須被記載而非被宣稱不存在

**Reason**: The gap is closed. spekterm now writes a receipt for every file it reads from an outbox
(`handoff-receipt`), so the agent learns whether a delivery was accepted, scheduled, a duplicate, refused or
held. The two rules this requirement also carried move with it: nothing is written into the source session's
terminal about an outcome, and a dot-prefixed file is not read (both restated in `handoff-receipt`).

**Migration**: Read `handoff-receipt`. A completion report (`handoff-completion`) is still not a delivery
receipt: it states the child's work, the receipt states what spekterm did with the file.
