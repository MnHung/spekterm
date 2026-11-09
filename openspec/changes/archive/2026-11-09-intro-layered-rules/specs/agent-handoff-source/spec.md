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
- **that a handoff may repeat** (see `recurring-handoff`): the field and its end field, that it is read in the
  desktop's time zone and the name of that zone, that the user approves it before anything opens, that it opens only
  while spekterm runs and times missed while spekterm was closed run once at the next start, and **that the agent
  must read the repeating rules file before writing one**, with its location. That file states every rule that
  refuses a repeating handoff — the accepted cron syntax, that the minute must be a single value, what is not
  accepted (seconds, macros, `L`, `W`, `#`, `?`), that a schedule with no time within the search bound is refused,
  that `at` with it is the start and `until` its end with the format and bound rules that apply to them — and that
  each time opens a new session until the user stops it. **A field that is refused when present without `repeat`
  (such as `until`) SHALL NOT be offered in the introduction's general shape of a handoff**: an agent that does not
  mean to repeat would not read the repeating rules file, and the rule that refuses that field alone would go
  unstated;
- **while the user holds a team membership with the Team feature on** (see `team-membership`), **that a handoff may
  go to a person on the team** with the `to` field in place of `target`, that the user confirms it on the desktop
  before anything leaves, and **that the agent must read the teammates file before writing one**, with its location.
  That file (see `teammate-handoff`) states every rule that refuses or holds a teammate handoff and lists the
  teammates; **those rules count as stated** for the rule below, because the introduction directs the agent to read
  them before the only action they constrain. The teammates themselves SHALL NOT be listed in the introduction: the
  list grows with the team, and display names are text each teammate chose. Without a membership, or with the
  feature off, the paragraph SHALL be absent, and introductions SHALL be rewritten when either changes;
- **它自己的固定名字**（見 `agent-peer-name`），以及**如何取得它當下的母、子、兄弟 session**
  （見 `session-lineage`）—— 含對方的名字、對方此刻是否在執行，以及聯絡對方用的是 agent CLI
  自身的訊息功能、以對方的名字定址。 The meaning of the relations file's fields is stated in the file itself
  (see `session-lineage`), not in the introduction;
- **that a session can be closed, hibernated, renamed, or woken from dormancy by a command** (see "The
  introduction states the session commands").

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

**The introduction SHALL stay within a size budget**: 7,000 characters and at most as many lines as the line limit below,
for a workspace of 30 folders, with outbox, relations, receipts, teammates-file and rules-file paths of the length
a real user data directory gives, for a session created by a handoff while the user is on a team (the longest variant), checked
by a test with a fixed time zone, since the zone's name is part of the text. (It was 8,500 before
`intro-layered-rules`, against a measured 8,474 in the zone Asia/Taipei; moving the rules of rarer actions
into rules files left room under a lower budget.) Past the CLI's threshold (see "The threshold the introduction's
limits sit under is measured, recorded and checked at release") the agent keeps only the opening — the repo list,
the receipts and every later section are gone at once, and the agent does not know what it was not told. The CLI's
binary also carries an 8,000-character / 200-line cut for injected context that did not apply when measured; **the
introduction's limits SHALL stay below that cut too**, so that a CLI update that turns it on loses nothing.

**A workspace larger than the test's fixture SHALL NOT push the introduction past a hard limit**: 7,900
characters and 190 lines, both inclusive and both below the CLI's latent cut. When the full introduction would exceed either, the list SHALL be cut to the repos that fit, in the
workspace's order, and SHALL state how many repos were left out. Losing the end of the list is a smaller loss
than losing every rule.

**告知失敗 SHALL 降級為「沒有自我介紹」**，SHALL NOT 使 session 無法建立。

**「所有會導致拒絕的約束」SHALL 與實際生效的判定同源，SHALL NOT 為一份另行撰寫的清單。**
**一個未被告知的約束仍是一條死路**: the receipt (`handoff-receipt`) tells the agent about a refusal only
after the fact, so an unstated constraint still costs a refused delivery, and an agent that has ended by then
never reads the receipt. 它會照著自己手上那份說明去寫，被拒絕，然後回報自己已經交出去了。而一份手寫的、宣稱自己完整的清單與實際判定分屬兩處時，
它們會在某一次調整之後分岔，**而分岔不會讓任何東西變紅** —— 這與把可交接對象的清單做成快照
而非取當下值，是同一個失效方式。

**A constraint counts as stated when it is in the introduction, or in a rules file whose location the
introduction gives together with the instruction to read it before the only action the constraint applies to** —
the teammates file, the schedules file, the repeating rules file and the commands rules file. A rules file's
limits SHALL be derived from the constants the check uses, as the introduction's are. A rules file SHALL NOT be
inside an outbox, where it would be read as a delivery. What this gives up: an agent that skips the file meets the
rule in a receipt, after the fact; a refusal under a rules file's rule SHALL therefore name that file (see
`handoff-receipt`).

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

- **WHEN** the introduction is built for a workspace of 30 folders under three directories, with real-length paths, for a session created by a handoff while the user is on a team
- **THEN** it has at most 7,000 characters and at most 190 lines

#### Scenario: A very large workspace keeps every rule and cuts the list

- **WHEN** the introduction is built for a workspace whose full list would take it past the hard limit
- **THEN** it is within the hard limit of characters and of lines, it still states every constraint, and it states how many repos were left out of the list

#### Scenario: A workspace with many short repo names is cut by lines

- **WHEN** the introduction is built for a workspace of 300 folders whose names are three characters long
- **THEN** it has at most 190 lines, every rule is still present, and it states how many repos were left out

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
- **THEN** it states the `repeat` field, the desktop's time zone by name, that the user approves a repeating handoff before it opens, that missed times run once at the next start, and the location of the repeating rules file with the instruction to read it before writing one
- **AND** it does not state the cron syntax, and its general shape of a handoff does not list `until`

#### Scenario: The repeating rules file states every rule that refuses a repeating handoff

- **WHEN** the repeating rules file is examined
- **THEN** it states the five cron fields, that the minute must be a single value, what is not accepted, the search bound in years, and the rules for `until`, including that `until` without `repeat` is refused

#### Scenario: The repeating rules file's year bound is the one applied

- **WHEN** the repeating rules file states the search bound as N years
- **THEN** the bound the schedule search applies is N years, and changing the constant changes the file without editing its text

#### Scenario: A rules file is not read as a delivery

- **WHEN** the rules files are written
- **THEN** none of them is inside any outbox, and no receipt is written for any of them

#### Scenario: The stated time zone is the one the schedule is read in

- **WHEN** the desktop's time zone is Asia/Taipei and an agent proposes `0 21 * * 3`
- **THEN** the introduction names Asia/Taipei, and the proposal's next times are Wednesdays at 21:00 Taipei time

#### Scenario: The teammate paragraph appears only on a team

- **WHEN** the introduction is built once while the user holds no team membership and once while they hold one
- **THEN** only the second states the `to` field and the teammates file's location, and neither lists a teammate's
  display name

#### Scenario: The introduction's size does not grow with the team

- **WHEN** the introduction is built for the same workspace while the team has 2 members and while it has 60
- **THEN** the two introductions have the same length

### Requirement: The introduction states the session commands

The introduction every agent session receives (see "agent 於 session 啟動時被告知 spekterm 的存在、可交接的對象與投遞方式")
SHALL also tell the agent that it can act on sessions with commands (see `agent-session-control`). This applies to
**every agent session**, not only one created by a handoff: every agent can act on its own session. The
introduction SHALL state:

- the shape of each of the four commands (close, hibernate, rename, wake), and that a wake starts a dormant session;
- that an omitted target means the agent's own session;
- **that the agent must read the commands rules file before writing a command**, with its location.

The commands rules file SHALL state, and the introduction SHALL NOT repeat:

- that any other target is named by a fixed name from the agent's relations file; that close, hibernate and rename
  may target only a session in its own tree of descendants; and that a wake may target any session the relations file
  lists — its parent, its siblings and its descendants;
- that a wake is carried out at once, without asking the user; how to tell when the woken session can be
  messaged: its relations entry turns running, and its name then appears among the sessions Claude Code's messaging
  can reach; that a parent is not to be woken only to deliver a completion report, which needs no running parent;
  and that a target still not running a while after an accepted wake was put back to sleep, so the user is to be
  asked before it is woken again;
- that close and hibernate take effect when the target's current turn ends, and that anything typed into the
  target before then cancels the command;
- that a close of its own session is not carried out but offered to the user, who closes it or keeps it;
- that a rename takes effect at once and changes no fixed name;
- **every constraint that makes a command refused**: the rename name's length limit, and that close and hibernate
  of a running session need the agent's events to be on;
- that its receipt (`handoff-receipt`) states whether the command was accepted, not whether it was carried
  out, and that a descendant's outcome shows in its relations file.

**Those rules count as stated** for the rule that every constraint that refuses a delivery is stated, because the
introduction directs the agent to the file before the only action they constrain.

The relations file SHALL describe its own shape as it is (see `session-lineage`): children nest their own
descendants at every depth, and a descendant whose direct parent no longer exists is marked so. An agent that is not
told where its grandchildren are listed cannot address them.

The limits SHALL be derived from the constants the judgement uses, as the handoff limits are. A receipt tells
the agent of a refusal only after the fact, so an unstated constraint still costs a refused command.

#### Scenario: A session not created by a handoff is told the commands

- **WHEN** the user opens a new agent session in a folder, with no handoff involved
- **THEN** the introduction it receives states the four session commands, that an omitted target means its own
  session, and the location of the commands rules file with the instruction to read it before writing a command

#### Scenario: The commands rules file is not repeated in the introduction

- **WHEN** an agent session receives its introduction
- **THEN** the introduction does not state the rename name's length limit, when close and hibernate take effect, or
  what a command's receipt means

#### Scenario: The stated name limit is the one applied

- **WHEN** the commands rules file states the rename name's length limit as N
- **THEN** a rename command whose name has N characters is carried out, and one with N + 1 characters is refused

#### Scenario: The introduction describes the descendant tree

- **WHEN** an agent session receives its introduction and reads the relations file it points to
- **THEN** the relations file states that each child lists the sessions it handed off, and what the mark for a direct parent
  that no longer exists means

#### Scenario: The introduction states that there is no reply

- **WHEN** an agent session receives its introduction and reads the commands rules file it points to
- **THEN** the file states that a command's receipt says whether it was accepted, not whether it was carried out, and that
  the relations file shows a descendant's outcome

#### Scenario: The introduction states how to reach a dormant relative

- **WHEN** an agent session receives its introduction and reads the commands rules file it points to
- **THEN** the file states the wake command, that it may target the parent, siblings and descendants, that it is carried
  out at once without asking the user, and that the woken session can be messaged once its relations entry is
  running and its name is reachable
- **AND** the file states that a parent is not to be woken only to report, and that a wake that did not take is not to be
  repeated without asking the user

## ADDED Requirements

### Requirement: The threshold the introduction's limits sit under is measured, recorded and checked at release

The CLI's handling of injected context SHALL be measured by a script, never only remembered. The script SHALL
inject, the way spekterm injects the introduction, a context of each of these shapes with a random marker at its
very start and another at its very end, with the agent's tools off so that it can only report what reached its
context, and record, as a character count, a line count and a result, whether the end marker reached the agent:

- a positive control of 200 characters on one line;
- the introduction's budget and its hard limit in characters, on few lines, and its line limit in short lines;
- the far side of the CLI's latent cut: 8,001 characters on few lines, and 201 short lines;
- 10,000 characters, and 10,001 characters as a negative control.

Each case SHALL be asked more than once before it counts as cut, because the model can leave a marker out of its
reply: an end marker in any reply means whole, and a start marker in some reply with no end marker in any means cut.
**A case where neither marker came back in any attempt, or the CLI exited with an error, SHALL fail the run**: an API or network failure is not a cut, and counting it as one could
hide the negative control. **A run whose positive control does not arrive whole, or whose negative control does,
SHALL fail without recording**: the first means the injection did not happen, the second that the threshold moved.
A moved threshold SHALL be reported as such, with the instruction to extend the measured sizes; the release stays
refused until a new record exists, because surfacing that move is what the check is for. Cases measured only to
learn something (such as whether two hooks are counted together) SHALL be recorded apart from these and SHALL NOT
take part in the test below.

The result SHALL be recorded in the repository together with the CLI version and the date. A test SHALL fail
unless the record holds the budget, hard limit and line limit cases, and every recorded case within both the hard
limit's characters and the line limit's lines reached the agent whole. A case beyond either limit may be cut: the
latent cut turning on (201 lines cut) therefore keeps the test green, and a threshold that fell to or below either
limit turns it red.

**Releasing the Linux build SHALL be refused when the installed agent CLI's version differs from the recorded one,
when no agent CLI is found, or when the record has uncommitted changes**, before the version is bumped, naming the
versions and the command that re-measures. The measurement needs the network and costs money, so it SHALL NOT be
part of the unit tests or the acceptance probes, and it SHALL NOT leave a conversation transcript where the app's
conversation insights read.

> **Coverage gap:** the script measures in non-interactive mode. Interactive mode matched it at every size when last
> measured by hand (CLI 2.1.303); a CLI where they differ would not be detected.

#### Scenario: A record without the hard limit fails

- **WHEN** the recorded measurement has no result for the introduction's hard limit
- **THEN** the threshold test fails

#### Scenario: A record where the hard limit was replaced fails

- **WHEN** the recorded measurement shows the hard limit's size replaced by a preview
- **THEN** the threshold test fails

#### Scenario: The latent line cut turning on keeps the record valid

- **WHEN** the recorded measurement shows 201 short lines cut and every case within both limits whole
- **THEN** the threshold test passes

#### Scenario: A release with a different CLI is refused before the bump

- **WHEN** the installed agent CLI's version is not the recorded one and the Linux release command is run
- **THEN** it stops before bumping the version, names both versions and the command that re-measures, and no commit is created

#### Scenario: A measurement whose negative control arrives whole is not recorded

- **WHEN** the measurement script runs and the 10,001-character context reaches the agent whole
- **THEN** the script fails, says the threshold moved, and the record is not changed

#### Scenario: A measurement whose positive control is replaced is not recorded

- **WHEN** the measurement script runs and the 200-character context does not reach the agent
- **THEN** the script fails and the record is not changed

#### Scenario: A failed CLI call is not counted as a cut

- **WHEN** the measurement script runs and the CLI exits with an error, or returns neither marker, for the 10,001-character case
- **THEN** the script fails and the record is not changed

#### Scenario: An informational case does not affect the test

- **WHEN** the record's informational two-hook case is marked cut
- **THEN** the threshold test passes
