# agent-handoff-source Specification

## Purpose

讓 session 裡的 agent 能把工作交接給 workspace 中的另一個 repo：spekterm 主動告訴它自己的存在、
可交接的對象與投遞方式，它投遞之後，目標 repo 直接出現一個 context 備妥、第一則 prompt 已填好的
agent session。

**本能力是收件匣的一個 producer，不是收件匣的一部分** —— 與 `slack-intake-source` 同一個分界：
驗證、去重、context 檔、預填、通知一律沿用 `agent-intake` 與 `intake-routing`，本能力只負責
「一則交接如何產生、它的來源與目標如何被決定」。

**本能力 SHALL NOT 被宣稱為一道安全邊界。** agent 經 pty 執行，它能寫入的位置不受本能力約束
（終端的 cwd 邊界本來就不是沙箱），**且它算得出所有投遞落點的位置** —— 執行環境已經把
使用者資料目錄交給它了。本能力保證的是**投遞的內容不得自行決定它落在哪個 repo**，那維護的是
收件匣「可驗證／第三方撰寫」型別分類的誠實性，不是防禦一個惡意的 agent。

## Requirements

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
- **that a handoff may repeat** (see `recurring-handoff`): the field, the accepted cron syntax, that it is read
  in the desktop's time zone and the name of that zone, that `at` with it is the start and `until` its end
  (with the format and bound rules that apply to them), that the minute
  must be a single value, what is not accepted (seconds, macros, `L`, `W`, `#`, `?`) and that a schedule with no
  time within the search bound is refused, that the user approves it before anything opens, that each time opens a new session
  until the user stops it, and that times missed while spekterm was closed run once at the next start;
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

#### Scenario: The introduction states the repeat field and the user's approval

- **WHEN** the text injected into an agent's context is examined
- **THEN** it states the `repeat` field with its five cron fields, the desktop's time zone by name, that the minute must be a single value, that the user approves a repeating handoff before it opens, and that missed times run once at the next start

#### Scenario: The stated time zone is the one the schedule is read in

- **WHEN** the desktop's time zone is Asia/Taipei and an agent proposes `0 21 * * 3`
- **THEN** the introduction names Asia/Taipei, and the proposal's next times are Wednesdays at 21:00 Taipei time

### Requirement: 投遞落點為每個 session 各一，且來源身分由落點推導而非投遞內容

系統 SHALL 為每個 agent session 提供一個**專屬的投遞落點**，並把它的位置告知該 session。

一則交接的**來源** SHALL 由「它落在哪一個 session 的落點」推導，SHALL NOT 採信投遞內容中任何
自稱來源的欄位，**亦 SHALL NOT 以落點之內的任何檔案為依據** —— agent 對自己的落點有寫入權，
落點裡的檔案不比投遞內容可信。

**落點的識別是 agent 被告知的，不是它在投遞內容裡宣告的。** 這條推導擋掉的是「payload 自稱來源」
這一種，**它不擋「agent 直接寫進另一個 session 的落點」** —— 落點的根位置可由已告知的環境推算
而得，而 agent 有完整的檔案系統寫入權。本能力**不防禦**這件事（見 Purpose），任何倚賴「來源
不可偽造」的下游設計皆不成立。

投遞內容中若出現自稱來源的欄位，SHALL 被丟棄，SHALL NOT 影響解析結果。

**落點於其 session 結束時清除，而清除之前 SHALL 先處理完落點中既有的項目** —— 否則一則已經
投遞、尚未被讀到的交接會隨 session 的結束而消失，**而投遞端與使用者兩邊都不會知道**。

來源 session 已結束時，其交接 SHALL 仍可被處理；來源於呈現上 SHALL 標示為已結束，
SHALL NOT 因此拒絕建立 session。

#### Scenario: 來源取自落點而非投遞內容

- **WHEN** 一則交接投遞於 folder A 的 session 落點，而其內容中含有自稱來源為 folder B 的欄位
- **THEN** 該則交接於收件匣中呈現的來源為 folder A

#### Scenario: 全域 session 亦可交接

- **WHEN** 一則交接投遞於全域 session 的落點
- **THEN** 該則交接正常被處理，且其來源呈現為全域 session

#### Scenario: 落點中尚未處理的項目於 session 結束時仍被處理

- **WHEN** 一則交接投遞於某個 session 的落點，而該 session 在它被讀取之前結束
- **THEN** 該則交接仍被處理

#### Scenario: 落點隨 session 結束而清除

- **WHEN** 一個 agent session 結束且其落點中的項目均已處理
- **THEN** 該 session 的投遞落點不再存在

### Requirement: 落點的偵測不因它被重新準備而失效

一個 session 的投遞落點**被重新準備之後**，其後寫入該落點的投遞 SHALL 仍被偵測。

「重新準備」指落點於其 session 每次啟動時被清為空的那個動作，**含應用程式啟動時還原一個既有
session 的情形** —— 而那是本應用程式最常見的狀態：大多數 session 都是被還原的，不是新建的。

**偵測 SHALL NOT 倚賴下一次應用程式啟動。** 既有的啟動掃描是為「應用程式關著的時候投遞」而
存在的補償路徑，它撿得到這些投遞，但那意味著使用者必須重啟一次才收得到一則在他眼前發生的
交接 —— 本條 SHALL NOT 以該掃描視為滿足。

**本條 SHALL NOT 由時序保證。** 偵測的成立 SHALL NOT 取決於落點的準備動作內部經過多少時間、
也 SHALL NOT 取決於系統當下的負載。一個「準備得夠慢就會成立」的實作**不滿足本條**：它的失效
是靜默的，而且會隨機器忙碌程度而來去。

**落點的重新準備 SHALL NOT 移除落點中尚未被消費的投遞。** 一則已經寫入、尚未被讀到的交接
在它的 session 重新啟動時被銷毀，與本條要修正的失效是同一種傷害：**投遞端與使用者兩邊都不會
知道**。這與既有的「落點於其 session 結束時清除，而清除之前 SHALL 先處理完落點中既有的項目」
是同一個態度 —— 一份 spec 不能在關 session 時小心翼翼、在開 session 時直接丟掉。

**本條的載體 SHALL 在「落點曾被重新準備」的情境下驗，SHALL NOT 僅以新建的落點驗。**
新建的落點是唯一不受此失效影響的情形，於是只在那一側撰寫的載體**必定全綠** —— 這條缺陷正是
這樣躲過了整個能力的驗收。這與「拖曳排序的驗收必須用至少三個項目」是同一種紀律：
驗收的情境本身就是規格的一部分。

> **這條缺陷已經以最壞的形式發生過。** 兩則合法的交接被寫進一個被還原的 session 的落點，
> 通過所有驗證，目標 repo 什麼都沒發生，而來源 agent 回報它已經交接出去了 —— 使用者由
> 「那兩個 repo 沒有動靜」才得知。失敗的可見性條款對它完全沉默：那條管的是**被拒絕**的投遞，
> 而這裡的投遞從頭到尾沒有被讀到過。

#### Scenario: 落點被重新準備之後寫入的投遞仍被偵測

- **WHEN** 一個 session 的落點已在被偵測的狀態下，該落點其後被重新準備
- **AND** 一則合法的交接寫入該落點
- **THEN** 該則交接被處理，且其目標 folder 中建立對應的 session

#### Scenario: 偵測不倚賴應用程式重新啟動

- **WHEN** 承上
- **THEN** 該則交接在應用程式未重新啟動的情況下即被處理

#### Scenario: 被還原的 session 仍可交接

- **WHEN** 應用程式啟動時還原了一個既有的 session
- **AND** 一則合法的交接寫入該 session 的落點
- **THEN** 該則交接被處理，且其目標 folder 中建立對應的 session

#### Scenario: 重新準備不移除落點中未被消費的項目

- **WHEN** 某個 session 的落點中有一份未被消費的投遞，該落點其後被重新準備
- **THEN** 該投遞仍存在於該落點中，且其後仍可被處理

### Requirement: 交接的識別碼由來源與投遞內容推導，同一份內容重複投遞只得到一則

一則交接的識別碼 SHALL 由「來源 session 的識別 ＋ **投遞內容的摘要**」推導，SHALL NOT 由投遞
內容中的某個欄位指定，SHALL NOT 由投遞檔的名稱推導，亦 SHALL NOT 於接收時隨機產生。

- **由欄位指定或由檔名推導 ⇒ 唯一性由 agent 負責，而它沒有依據可循。** 兩者是同一件事：檔名
  同樣由 agent 挑選。同一個 session 兩次交接若用了同一個檔名，第二則會成為重複而被丟棄或拒絕，
  **而 agent 已經回報它交接出去了**。
- **於接收時隨機產生 ⇒** 落點的「先建立監看、再掃描」會使同一份投遞讀到兩次而成為**兩則**交接，
  於是**開出兩個 session** —— 既有的去重完全看不見它。

由內容摘要推導同時滿足兩端：同一份內容投幾次都是一則（重送冪等），內容不同則識別碼自然不同。

#### Scenario: 同一份投遞被讀取兩次只產生一則交接

- **WHEN** 同一個投遞檔在監看與掃描兩條路徑上各被讀取一次
- **THEN** 收件匣中只出現一則對應的交接
- **AND** 只有一個 session 因它而建立

#### Scenario: 同一個 session 兩份不同內容的投遞是兩則交接

- **WHEN** 同一個 session 先後投遞兩份內容不同的交接，且兩者使用同一個檔名
- **THEN** 收件匣中出現兩則交接
- **AND** 兩個 session 因它們而建立

### Requirement: 目標以告知 agent 的那份清單查表解析，完整相等，歧義與查無皆拒絕

系統 SHALL 把投遞中的目標解析為一個 workspace folder，作法 SHALL 為在**告知 agent 的那份清單
所取自的同一個來源**中查表：先比對 folder 的顯示名稱（不分大小寫、**完整相等**），再比對其
絕對路徑。

- 命中恰一個 ⇒ 採用。
- **命中多於一個 ⇒ 拒絕**，並列出候選。
- **零命中 ⇒ 拒絕。**

**SHALL NOT 以模糊比對、前綴比對或最接近者取代完整相等。** 這條路徑上沒有使用者在看，一個
「猜得很有把握」的結果會讓 session 開在他沒有指名的 repo 裡，而他不會知道。

**顯示名稱可能重複**（它取自路徑的最後一段），因此以絕對路徑為目標 SHALL 是一條可用的脫困
路徑，且該形式 SHALL 出現在告知 agent 的內容中 —— 否則歧義是一個 agent 無從化解的死路。

目標等於來源是合法的，SHALL 正常處理。

#### Scenario: 以名稱完整相等命中

- **WHEN** workspace 中有名為 `billservice` 的 folder，一則交接的目標為 `BillService`
- **THEN** 解析結果為該 folder

#### Scenario: 名稱僅為前綴時不命中

- **WHEN** workspace 中有名為 `billservice` 的 folder，一則交接的目標為 `bill`
- **THEN** 該則交接被拒絕，且不建立任何 session

#### Scenario: 兩個同名的 folder 使解析拒絕

- **WHEN** workspace 中有兩個顯示名稱相同的 folder，一則交接以該名稱為目標
- **THEN** 該則交接被拒絕，其說明列出兩個候選
- **AND** 不建立任何 session

#### Scenario: 以絕對路徑化解歧義

- **WHEN** 承上，其後一則交接以其中一個 folder 的絕對路徑為目標
- **THEN** 解析結果為該 folder

#### Scenario: 目標等於來源

- **WHEN** 一則交接的目標與其來源為同一個 folder
- **THEN** 該 folder 中建立一個新的 agent session

### Requirement: 已解析的目標不得經投遞內容表達，亦不得經共用的投遞落點傳遞

一則已由接收端解析出目標的交接，其目標 SHALL 以**投遞內容表達不出來的方式**傳遞給收件匣。

**理由是承重的**：共用的投遞落點明文供**應用程式之外**的 producer 使用，且其內容不受信任
（見 `agent-intake`）。目標若是投遞 JSON 的一個欄位，那麼**任何**放進該落點的檔案都能繞過
routing 自行選擇 folder —— 一道為「投遞者不得選擇他落在哪個工作目錄」而存在的機制就此失效，
而失效是靜默的。

本能力的投遞落點與共用的投遞落點 SHALL 為不同的位置，且本能力的投遞內容中即使出現目標欄位
亦 SHALL 不被採信。

#### Scenario: 共用落點中的檔案無法自行指定 folder

- **WHEN** 一份投遞直接放進共用的投遞落點，其中含有指定目標 folder 的欄位
- **THEN** 該欄位不影響解析結果，該則 intake 仍依 routing 規則解析

### Requirement: 本能力的投遞落點沿用共用落點既有的保護

本能力的投遞落點 SHALL 提供與共用投遞落點**相同的**保護，SHALL NOT 各自實作一份：

- 讀取之前先以**檔案大小上限**拒絕；
- 只採納特定副檔名的項目；
- **以點開頭的檔名一律跳過，且不消費它** —— 那是「還沒寫完」的慣例。只看副檔名是不夠的：
  producer 依指示「先寫暫存檔再改名」時，它挑的暫存檔名很可能**仍以該副檔名結尾**
  （實測：agent 取的是 `.tmp-<x>.json`）。於是一份寫到一半的檔案會被當成正式投遞讀走，
  而它若恰好解析成功就會**被消費掉** —— 與 producer 的改名互相競爭，結果不可預測。
  **這道跳過 SHALL NOT 倚賴 producer 照著指示做**：告知 agent 的內容仍會說明暫存檔名的限制，
  但一個依賴對方守規矩的協定不是協定；
- **解析失敗的項目不被消費**（不移走、不刪除、不改名），補寫完整之後仍被採納；
- 一份無法解析的項目 SHALL NOT 使其後的項目無法被處理；
- 投遞的處理 SHALL NOT 阻塞主行程。

**本文的長度上限沿用共用落點的機制，但適用的是「非第三方撰寫」那一個** —— 見 `agent-intake`
的「使用者在接受之前看得到本文全文」。

> **本條原本寫的是「一律沿用，SHALL NOT 因為投遞者是自己的 agent 而放寬」，理由是
> 「那個上限是人類閘門有效性的旋鈕，而交接仍然會被人讀」。那個理由不成立。**
>
> 人類閘門的旋鈕保護的是「使用者要逐字讀完**才能按下接受**」—— 而交接到達即建立 session，
> **沒有那道閘**。使用者確實會讀它，但他讀的是一件他兩秒前才交辦的工作，讀不讀得完不構成
> 一道保護。以那個數字擋下的是一份工作交接包本來就該有的長度，**而投遞者收不到任何回饋**。
>
> **上限沒有被拿掉，依據被換掉了**：換成「接手的 agent 必須能一次讀完交付的整份內容」，
> 而那個依據的失效方向與原本相反 —— 調大不是讓人比較累，是讓交付靜默地只到一半。
> 實測見 `docs/lessons/handoff.md` 第八節。

**落點的結構與共用落點不同**（本能力的落點是每個 session 一層，共用落點是扁平的），因此
「沿用」SHALL 落在共用的實作上而非各自複製，且該實作 SHALL 能同時服務兩種結構。

#### Scenario: 寫到一半的投遞補完之後仍被採納

- **WHEN** 一份內容不完整的投遞出現在某個 session 的落點
- **THEN** 收件匣中沒有對應的交接，且該項目仍原封留在落點中
- **AND** 同一份項目其後被補寫完整時，對應的交接出現於收件匣

#### Scenario: 無法解析的項目不阻斷其後的項目

- **WHEN** 一份無法解析的投遞先被處理，其後同一個落點出現一份合法的交接
- **THEN** 合法的那一則正常被處理

#### Scenario: 超過檔案大小上限的投遞不被解析

- **WHEN** 某個 session 的落點中出現一份超過檔案大小上限的項目
- **THEN** 該項目不被解析，且收件匣中不出現對應的交接

#### Scenario: 本文超過長度上限的交接被拒絕

- **WHEN** 一份交接投遞的本文超過**非第三方撰寫的本文所適用的**長度上限
- **THEN** 該份投遞被拒絕，且不建立任何 session

#### Scenario: 本文未超過其適用的上限時不因第三方的上限被拒

- **WHEN** 一份交接投遞的本文超過第三方撰寫的本文所適用的上限，但未超過它自己適用的上限
- **THEN** 該份投遞正常被處理，且建立對應的 session

### Requirement: 預填不可能發生時不建立 session

事件回報未啟用時，一則到達的交接 SHALL **不建立 session**，SHALL 改為可見地說明預填不會發生
（`agent-intake` 的「已知可事先偵測的成因 SHALL 於建立 session 之前告知」）。

**這是本能力唯一一處「不開 session」比「開了但沒有 prompt」好的地方。** 預填等不到就緒時，
既有條款要求該項目回到可重新處理的狀態 —— 而事件回報關閉是一個**恆定**的成因，於是那條路徑
會變成「建 session → 等到逾時 → 退回 → 再處理 → 又建一個」的常態迴圈。事先偵測得到的成因
就該事先擋下。

#### Scenario: 事件回報關閉時交接不建立 session

- **WHEN** 事件回報偏好已關閉，一則合法的交接到達
- **THEN** session 的總數與到達之前相同
- **AND** 系統可見地說明預填不會發生

### Requirement: 交接的失敗對使用者可見

交接路徑上**重送必然同樣失敗**的失敗 SHALL 以使用者看得到的方式呈現：SHALL 發出通知、
SHALL 於收件匣中留下一則可見的項目，且該項目 SHALL 在應用程式重新啟動之後仍然存在。
**僅寫入診斷輸出 SHALL NOT 視為滿足本條。**

**適用範圍 SHALL 由該判準決定，SHALL NOT 由一份列舉決定。** 目標查無、目標歧義、目標 folder
已不在 workspace 都在其中，但**它們不是全部** —— 本文過長、投遞過大、識別碼不合法或缺漏、
欄位型別不符同樣重送必敗，同樣適用本條。以列舉撰寫的版本已經漏過一次：一則本文過長的交接被
消費、無通知、無痕跡，而使用者由「目標 repo 沒有開出 session」才得知，來源 agent 至今仍認為
自己交接出去了。**漏掉的那幾種恰好是由共用的攝入路徑算出來的那些**，而那條內部界線對使用者
毫無意義。

**「預填不可能發生」不在本條之內。** 它取決於 agent 的事件回報是否被開啟，而那是一個**使用者
可以打開的偏好** —— 照本條的判準（見 `agent-intake`），它與「收件匣已滿」同類：使用者改變
設定之後，同一份投遞就會成功。對一件已經不再成立的事持續提醒他，與不提醒同樣沒有用處。

**「預填等不到就緒」也不在本條之內，且它根本不是一次拒絕。** 那則交接已經建立了 session，
它回到**待處理**而非被拒絕（見下方 scenario）—— 使用者可以再次處理它，因此它既不是永久性的，
也不需要一則跨重啟的痕跡。再次處理時使用者若改選了 folder，session 建立於改選的 folder、
原 session 不被關閉（見 `agent-intake`「第一則 prompt 不早於 agent 就緒寫入，第三方本文不代為送出」）。

**這一條在本能力比在其他 producer 更重**：接受那個環節已經沒有人在看，少了它，一次失敗的交接
與「什麼都沒發生」在畫面上完全相同 —— 而使用者會以為工作已經交出去了。這是既有「被拒絕的投遞
SHALL NOT 發出作業系統通知」的例外，其界線見 `agent-intake`。

**狀態改變後可能成功的失敗不在本條之內**（尚未被消費的解析失敗、收件匣已滿）—— 那類項目會在
每次補寫或重試時再次被讀到，逐次通知沒有上界。它們只走收件匣之內的彙整呈現，且不落盤。

面向使用者的失敗說明 SHALL 有界，同一來源的重複失敗 SHALL 合併。

**通知與收件匣中的項目是兩件必須分別成立的事。** 其中一項有實作而另一項沒有時，本條**不**視為
滿足 —— 使用者不會無緣無故去打開收件匣，而一則沒有落點的通知說不出發生了什麼。此處的兩半
曾經只有一半成立，而驗收全綠。

#### Scenario: 目標查無時使用者看得到

- **WHEN** 一則交接的目標不存在於 workspace
- **THEN** 系統發出通知，且收件匣中出現一則說明該失敗的項目
- **AND** 不建立任何 session

#### Scenario: 共用攝入路徑上的永久性失敗同樣可見

- **WHEN** 一則交接因投遞過大而被拒絕
- **THEN** 系統發出通知，且收件匣中出現一則說明該失敗的項目
- **AND** 不建立任何 session

#### Scenario: 本文過長的交接其失敗可見

- **WHEN** 一則交接的本文超過 first-party 適用的長度上限
- **THEN** 系統發出通知，且收件匣中出現一則說明該失敗的項目
- **AND** 不建立任何 session

#### Scenario: 預填不可能發生時不發出通知

- **WHEN** 一則交接因 agent 的事件回報被關閉而未建立 session
- **THEN** 不發出作業系統通知

#### Scenario: 失敗的呈現活過重新啟動

- **WHEN** 一則交接因永久性的原因失敗，使用者未清除該呈現，其後應用程式重新啟動
- **THEN** 收件匣中仍然呈現該次失敗

#### Scenario: 暫時性失敗不發出通知

- **WHEN** 一份交接的投遞尚未寫完而無法解析
- **THEN** 不發出任何作業系統通知，且該投遞未被消費

#### Scenario: 預填等不到就緒時該則交接回到可重新處理的狀態

- **WHEN** 一則交接建立了 session，但預填等不到 agent 就緒
- **THEN** 系統可見地說明，且該則交接成為待處理，使用者可再次處理它
- **AND** 使用者未改選 folder 而再次處理它時，不建立第二個 session

### Requirement: 由交接建立的 session，其通知聚焦該 session 而非開啟收件匣

一則已直接建立 session 的交接，其通知被觸發時，系統 SHALL 把主視窗帶到前景並**聚焦該交接所
建立的 session**，SHALL NOT 打開收件匣。

一則已接受的交接在收件匣中沒有任何待辦動作；把使用者送去收件匣，等於要他再點一次才到得了他
真正要去的地方。**失敗的項目不適用本條** —— 那些仍是待處理，其通知沿用既有行為；**一則合併後
涵蓋待處理項的通知亦不適用本條**（見 `agent-intake`）。

該 session 已不存在時（使用者已關閉它），觸發通知 SHALL 為無操作，SHALL NOT 重建它、
SHALL NOT 改為打開收件匣。

#### Scenario: 觸發通知後焦點位於新建立的 session

- **WHEN** 一則交接直接建立了 folder B 的 session，使用者觸發其通知
- **THEN** 主視窗位於前景，且焦點位於該 session
- **AND** 收件匣未被開啟

#### Scenario: 該 session 已被關閉時觸發通知為無操作

- **WHEN** 承上，使用者先關閉了該 session 再觸發通知
- **THEN** 不建立任何 session
- **AND** 收件匣未被開啟

### Requirement: Handoff is always available, and independent of the other features injected through the same seam

This capability SHALL NOT be switchable: it is a core capability of the application and is always
active — its introduction is injected, its outboxes are prepared, and deliveries in them are
processed. (Until 2026-09-30 a switch existed as a preference field that no settings screen showed;
it was removed because users could not reach it and handoff is not meant to be turned off.)

Turning off another feature injected through the same seam SHALL NOT disable this capability. With
the event bridge turned off, handoffs are still read, and each takes the **visible** rejection
described in "預填不可能發生時不建立 session" — a visible rejection, not a silent failure.

A preferences file written by an earlier version that still contains the removed switch SHALL load
normally, and the switch's value SHALL have no effect.

#### Scenario: A handoff is processed with the event bridge turned off

- **WHEN** the event bridge is turned off, and an agent session writes a valid handoff to its outbox
- **THEN** the handoff is read and rejected visibly because the prefill cannot happen, rather than
  being ignored

#### Scenario: A preferences file with the removed switch still loads

- **WHEN** the preferences file contains the removed handoff switch set to off
- **THEN** the application loads its other preferences, and handoffs are still processed

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

### Requirement: A handoff the watcher never reported is still delivered

A handoff written into a session's outbox SHALL be delivered — its target session created, as for
any handoff — even if the file watcher never reports it, without an application restart and within
one minute of being written. This is the per-session case of the shared drop-point requirement
"Detection of a delivery does not depend on the watcher having reported it" in `agent-intake`, and
it is stated here because this is where it went wrong: a valid handoff sat unread in a session's
outbox because that outbox was the only one the watcher was not watching, and only a restart picked
it up.

**It SHALL hold for a session created after the application started as well as for a restored
one** — the outbox that was missed belonged to a session created that day.

**A permanently rejected handoff that the application cannot remove from the outbox SHALL be
notified once**, not once per re-read.

#### Scenario: A handoff the watcher never reported creates its session

- **WHEN** the handoff outboxes' watcher reports no events
- **AND** a session created after the application started writes a valid handoff to its outbox
- **THEN** within one minute a session is created in the target folder, without the application
  being restarted

#### Scenario: A restored session's handoff the watcher never reported creates its session

- **WHEN** the application restored a session at startup, and the handoff outboxes' watcher reports
  no events
- **AND** that session writes a valid handoff to its outbox
- **THEN** within one minute a session is created in the target folder, without the application
  being restarted

#### Scenario: A rejected handoff that cannot be removed is notified once

- **WHEN** a session writes a handoff whose target matches no folder, and the application cannot
  remove the file from the outbox
- **AND** the outbox is re-read several times afterwards
- **THEN** exactly one notification about that rejection is issued, and its rejection trace shows a
  single occurrence

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
