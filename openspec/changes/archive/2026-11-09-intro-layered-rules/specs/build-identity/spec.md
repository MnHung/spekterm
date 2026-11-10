## MODIFIED Requirements

### Requirement: 每一份產物的版本由打包指令自身遞增

打包指令 SHALL 於每次執行時使宣告的版本遞增，SHALL NOT 倚賴執行者記得手動遞增 —— 「要記得做」
不是機制，而遺漏的後果正是本能力要消除的那個歧義。

This applies to the **Linux** packaging command, which is where a release begins. The macOS packaging
command does not bump: it packages a release commit the Linux command created (see "The macOS packaging
command builds only a release commit").

**A release precondition that refuses before the bump is not a manual bump step**: the Linux packaging command
refuses, before bumping, when the version files are already modified, and when the installed agent CLI is not the
one the introduction's threshold was last measured with (see `agent-handoff-source`). A refusal bumps nothing,
commits nothing and builds nothing, and says what to do; once its condition is met, running the command alone bumps
the version again.

遞增 SHALL 發生在建置**之前**，使產物所內含的建置身分與產物本身同源。此順序的代價是：建置隨後
失敗時版本已經跳掉一格。**此代價接受** —— 版本的遞增是廉價的，而「產物與它自稱的身分同源」不是。

#### Scenario: 連續兩次打包產出不同的版本

- **WHEN** 連續執行 Linux 打包指令兩次，且每次它的前置條件都成立
- **THEN** 兩次產出的產物具有不同的版本，且第二次的版本大於第一次

#### Scenario: 遞增不倚賴任何額外的人工步驟

- **WHEN** 只執行 Linux 打包指令本身，不執行任何其他指令，且它的前置條件都成立
- **THEN** 版本已經遞增

#### Scenario: A refused precondition bumps nothing

- **WHEN** the Linux packaging command is run while the installed agent CLI differs from the recorded measurement
- **THEN** the declared version is unchanged, no commit is created, and nothing is built
