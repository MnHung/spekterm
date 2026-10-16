## MODIFIED Requirements

### Requirement: agent 隨時查得到它當下的母、子、兄弟 session

每個 agent session SHALL 能於它存活期間的任何時刻，取得它**當下**的關係：它有沒有母 session、
母 session 是否存在與是否在執行、它目前存在的子 session，以及它目前存在的**兄弟**（與它有同一個
母 session 的其他 session，不含它自己）；每一個對象 SHALL 附帶它的固定名字
（見 `agent-peer-name`）、所屬的 rail 項目名稱與標籤。

**子 session 與兄弟 session 另 SHALL 附帶它的生命週期狀態（見 `handoff-completion`：已完成、進行中、
等你，或不呈現狀態 —— 後者含休眠者），以及它最新的完成結果（若有）。** 生命週期狀態改變時 SHALL
視同關係改變，agent 下一次查詢即得到新的值。 這是結果抵達母 session 的補償路徑：子 session 完成時母 session 可能不在
執行中，或子 agent 送出的訊息可能被忽略 —— 母 session 的 agent 仍查得到結果，而系統不必經手訊息。

**自我介紹只在 agent 的脈絡被建立或重建時注入**，而母 session 的子 session 是在它啟動**之後**才
長出來的，兄弟亦然。關係 SHALL NOT 只經由自我介紹提供；關係改變時（子或兄弟 session 建立、任一方不再存在、
改名、進入或離開執行中）SHALL NOT 需要重建 agent 的脈絡，agent 下一次查詢即得到新的值。

**Each child SHALL also carry the sessions it handed off, and so on at every depth** (its descendants, see
"A session records its whole chain of ancestors"), as a tree under the children. Each descendant SHALL carry the
same fields as a child (fixed name, rail item, label, whether it is running, lifecycle state, latest result), so
an agent can find, address and act on a grandchild as it can a child (see `agent-session-control`).
A descendant whose direct parent no longer exists SHALL appear under its nearest ancestor that still exists, and
SHALL be marked as having lost its direct parent. Its own relations still show that parent as closed. The parent
and the siblings SHALL NOT carry descendants.

系統 SHALL NOT 在提供給 agent 的關係中放入任何路徑欄位或 spekterm 的 session 識別碼 —— agent 需要的
只有名字。

Relations SHALL always be provided to running claude sessions: handoff has no switch (removed
2026-09-30), so there is no state in which they are withdrawn.

**本能力不經手訊息本身。** 母子之間的訊息由 agent CLI 自身的訊息功能傳遞；本能力交付的是
「對方是誰、叫什麼名字、此刻收不收得到」。**休眠的 session 沒有行程，收不到訊息** —— 關係中
SHALL 標明它不在執行中，本能力 SHALL NOT 為此喚醒它。

#### Scenario: 母 session 於啟動之後查得到新長出的子 session

- **WHEN** session P 啟動之後投遞一則交接，因而建立了 session C，其間 P 的脈絡未被重建
- **THEN** P 此時查詢自己的關係，結果中含有 C 與 C 的固定名字

#### Scenario: 子 session 查得到母 session 的名字

- **WHEN** session C 由 session P 交接而來
- **THEN** C 查詢自己的關係，結果中的母 session 為 P，並附帶 P 的固定名字

#### Scenario: 不存在的子 session 自查詢結果中消失

- **WHEN** 承「母 session 於啟動之後查得到新長出的子 session」，使用者關閉 C
- **THEN** P 此時查詢自己的關係，結果中不含 C

#### Scenario: 兄弟查得到彼此

- **WHEN** session P 先後交接出 session C1 與 C2，其間 C1 的脈絡未被重建
- **THEN** C1 此時查詢自己的關係，結果的兄弟中含有 C2 與 C2 的固定名字
- **AND** C1 的兄弟中不含 C1 自己

#### Scenario: 不存在的兄弟自查詢結果中消失

- **WHEN** 承上，使用者關閉 C2
- **THEN** C1 此時查詢自己的關係，結果的兄弟中不含 C2

#### Scenario: 母 session 不存在之後兄弟仍互相查得到

- **WHEN** 承「兄弟查得到彼此」，使用者關閉 P
- **THEN** C1 此時查詢自己的關係，母 session 標明已關閉，且兄弟中仍含有 C2

#### Scenario: 休眠的母 session 標明不在執行中

- **WHEN** 應用程式重新啟動之後，C has been woken while its parent session P is still dormant
- **THEN** C 查詢自己的關係，結果標明 P 存在但不在執行中
- **AND** P 仍為休眠

#### Scenario: 關係中沒有路徑欄位

- **WHEN** 檢視提供給 agent 的關係內容，其中各對象所屬的 folder 皆位於 workspace 之內
- **THEN** 其中沒有任何表示路徑或 spekterm session 識別碼的欄位

#### Scenario: 母 session 查得到子 session 的狀態與結果

- **WHEN** session P 的子 session C 投遞了摘要為 S 的完成報告
- **THEN** P 此時查詢自己的關係，結果中 C 標明為已完成，並附帶 S

#### Scenario: 尚未完成的子 session 沒有結果

- **WHEN** P 的子 session C 尚未投遞任何完成報告
- **THEN** P 查詢自己的關係，結果中 C 標明其狀態，且沒有結果

#### Scenario: A grandparent sees its grandchild

- **WHEN** session P handed off to C, and C then handed off to G, while P's context was not rebuilt
- **THEN** P now queries its relations, and G appears under C, with G's fixed name, rail item, label, whether it
  is running, and its state

#### Scenario: A grandchild stays in the tree after the session between them closes

- **WHEN** continuing "A grandparent sees its grandchild", the user closes C
- **THEN** P's relations no longer contain C
- **AND** G appears directly under P, marked as having lost its direct parent

#### Scenario: Siblings carry no descendants

- **WHEN** P handed off to C1 and C2, and C2 handed off to G
- **THEN** C1's relations list C2 as a sibling, and G does not appear in C1's relations

## ADDED Requirements

### Requirement: A session records its whole chain of ancestors

A session created by a handoff SHALL record the whole chain of sessions above it: its parent, its parent's
parent, and so on. The chain SHALL be taken **when the handoff is received**, as the rest of the source's snapshot
is, not when the session is created later. It SHALL be recorded before the session's process starts. A session SHALL be a **descendant** of every
session in that chain. The chain SHALL survive the closing of any session in it: closing an intermediate session
SHALL NOT make its descendants strangers to the sessions above it.

For a session recorded before chains were kept, the chain SHALL be rebuilt from the records that still exist. A
link that was already broken by a closed intermediate session SHALL stay broken.

A chain that cannot be read SHALL be ignored without losing the rest of the session's lineage. A chain SHALL NOT
make a session disappear from the rail. The chain SHALL be bounded in length, and SHALL NOT loop.

The chain SHALL NOT appear in what is provided to agents: they see fixed names only. The rail's indentation and
its source and handoff marks SHALL be unchanged by the chain: they still show only the direct parent.

#### Scenario: The chain survives an app restart and an intermediate close

- **WHEN** P handed off to C, C handed off to G, the application restarts, and the user closes C
- **THEN** G is still a descendant of P

#### Scenario: A chain survives a late acceptance

- **WHEN** C, a child of P, hands off a piece of work that falls back to pending in the inbox, the user closes C, and
  the user then accepts the item, creating G
- **THEN** G is a descendant of P

#### Scenario: A chain recorded before this change is rebuilt from existing records

- **WHEN** the session list holds P, C and G, with C's and G's lineage naming only their direct parents
- **THEN** G is a descendant of P

#### Scenario: A broken chain does not remove a session

- **WHEN** a session's recorded chain of ancestors is unreadable in the session list
- **THEN** the session appears on the rail with its direct parent intact

#### Scenario: The rail shows only the direct parent

- **WHEN** P handed off to C, and C handed off to G, all three in the same folder
- **THEN** G is indented under C on the rail, not under P
