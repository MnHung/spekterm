## ADDED Requirements

### Requirement: The macOS packaging command builds only a release commit

The macOS packaging command SHALL NOT change the version. It SHALL package the version that the checked-out
commit declares, and it SHALL refuse to run unless that commit is the release commit of that version:

- the working tree has no change, untracked files included;
- the commit's subject is the release subject for the version it declares (`chore(release): <version>`);
- the commit changes exactly the files that declare the version, relative to its parent.

Every refusal SHALL state what to do instead: which commit to check out, or how to try a build that is not
a release.

A release is built on Linux first: the Linux packaging command bumps and commits the version. The macOS
artifact of that release is built afterwards from that commit. **Both platforms' artifacts of one release
therefore carry the same version.** The macOS artifact always corresponds to the release commit. The
Linux artifact corresponds to it when its build identity reports a clean working tree; the Linux command
deliberately builds from a dirty tree, and then its identity says so. No macOS build claims a version
whose source it does not have: master moves on after a bump while the declared version stays the same,
and every commit after the release commit is refused.

The macOS build SHALL install dependencies exactly as the lockfile states before building. A clean working
tree says nothing about installed dependencies, and the build identity would otherwise report a clean build
of a commit whose dependencies the artifact does not contain.

A detached checkout of a release commit is accepted. Unlike the bump, this command creates no commit that
could be lost.

#### Scenario: A commit after the release commit is refused

- **WHEN** the checked-out commit is a later commit than the release commit, and the declared version is
  unchanged
- **THEN** the command refuses, names the release commit to check out, and produces nothing

#### Scenario: An untracked file is refused

- **WHEN** the release commit is checked out and the working tree has an untracked file
- **THEN** the command refuses and produces nothing

#### Scenario: A commit that reuses the release subject but changes other files is refused

- **WHEN** the checked-out commit's subject is `chore(release): <version>`, and it also changes a file other
  than the version declarations
- **THEN** the command refuses

#### Scenario: A subject naming another version is refused

- **WHEN** the checked-out commit's subject names a version different from the one it declares
- **THEN** the command refuses

#### Scenario: A detached checkout of the release commit builds

- **WHEN** the release commit is checked out detached and the working tree is clean
- **THEN** the command proceeds, and the artifact's build identity shows that commit and a clean working tree

#### Scenario: The macOS build does not bump

- **WHEN** the macOS packaging command completes
- **THEN** the declared version is the one the release commit declared, and no commit was created

## MODIFIED Requirements

### Requirement: 每一份產物的版本由打包指令自身遞增

打包指令 SHALL 於每次執行時使宣告的版本遞增，SHALL NOT 倚賴執行者記得手動遞增 —— 「要記得做」
不是機制，而遺漏的後果正是本能力要消除的那個歧義。

This applies to the **Linux** packaging command, which is where a release begins. The macOS packaging
command does not bump: it packages a release commit the Linux command created (see "The macOS packaging
command builds only a release commit").

遞增 SHALL 發生在建置**之前**，使產物所內含的建置身分與產物本身同源。此順序的代價是：建置隨後
失敗時版本已經跳掉一格。**此代價接受** —— 版本的遞增是廉價的，而「產物與它自稱的身分同源」不是。

#### Scenario: 連續兩次打包產出不同的版本

- **WHEN** 連續執行 Linux 打包指令兩次
- **THEN** 兩次產出的產物具有不同的版本，且第二次的版本大於第一次

#### Scenario: 遞增不倚賴任何額外的人工步驟

- **WHEN** 只執行 Linux 打包指令本身，不執行任何其他指令
- **THEN** 版本已經遞增

### Requirement: 版本的遞增被提交，且該提交只含版本宣告

版本的遞增 SHALL 被提交至版控 —— 使每一個曾經出貨的版本都對得回一個 commit。這正是 dogfood
期間回報問題時真正要用的東西：一個沒有 commit 可對應的版本號，只是一個比較長的檔名。

This requirement applies to the **Linux** packaging command, where a release begins. The macOS packaging
command creates no commit (see "The macOS packaging command builds only a release commit").

該提交 SHALL **只含宣告版本的那些檔案**，SHALL NOT 一併提交工作副本中其他未提交的變更。
**帶著未提交的編輯去打包在 dogfood 期間是常態**，把它們掃進一個換版提交是資料損害 —— 而它的
失效是靜默的：提交成功、打包成功，使用者要到很久以後才會發現那些變更被混進了一個看似無關的
提交裡。

**「宣告版本的檔案」不只一個。** 版本同時記載於 package manifest 與其 lockfile，而遞增工具會
一併改寫兩者。**遺漏其中任何一個的後果不是不完整，是把 `dirty` 這個欄位徹底作廢**：未被提交的
那一份會讓隨後的建置一律判定工作副本不乾淨，於是每一份產物都被標為 dirty，而該標示從此不傳遞
任何資訊 —— 那正是下一條 requirement 要消滅的失效。此外未提交的那一份會逐次漂移，且**下一次
執行時的前置檢查看不到它**（它檢查的是另一個檔案）。

打包指令 SHALL NOT 建立 git tag。dogfood 期間每次打包一個 tag 只是噪音。

版本無法被提交時（版控不可用、處於 detached HEAD、提交被拒），指令 SHALL 明確告知，
SHALL NOT 靜默略過 —— 一個未被提交的遞增，下一次 `git checkout` 就會讓它消失，而兩份內容不同
的產物會因此宣稱同一個版本。

#### Scenario: 工作副本帶有其他未提交的變更時，它們不被提交

- **WHEN** 工作副本中存在其他未提交的變更，且執行 Linux 打包指令
- **THEN** 版本的遞增被提交，而那些變更仍然是未提交的

#### Scenario: 打包不建立 tag

- **WHEN** 執行 Linux 打包指令
- **THEN** 版控中未新增任何 tag

為了兌現「只含版本宣告」這件事，宣告版本的檔案**任何一個**在遞增之前就已帶有未提交的變更時，
打包指令 SHALL 拒絕執行並說明處置。那是唯一無法只靠提交範圍化解的情況：遞增與那些變更落在同一
個檔案裡，一次提交必然把兩者一起帶走。

#### Scenario: 無法提交時明確告知

- **WHEN** 版本的遞增無法被提交
- **THEN** 指令明確報告此事，而非靜默繼續

#### Scenario: 版本宣告檔案已被修改時拒絕打包

- **WHEN** 宣告版本的檔案在打包前就已帶有未提交的變更，且執行 Linux 打包指令
- **THEN** 指令拒絕執行並說明處置，且未遞增版本、未產生任何提交

#### Scenario: 遞增後工作副本中不留下未提交的版本宣告

- **WHEN** 於一個乾淨的工作副本執行 Linux 打包指令
- **THEN** 遞增完成後工作副本中沒有任何未提交的變更 —— 版本宣告的每一個檔案都已進入該次提交

### Requirement: 遞增的層級可由執行者指定，預設為 patch

打包指令 SHALL 預設遞增 patch 版本。執行者 SHALL 能在執行打包指令時指定遞增 minor 或 major 的層級，
使一個有意義的版本界線（例如第一個公開版本）不必靠手動改版號達成 —— 手動改版號行不通：打包指令
隨後還會再遞增一次，產物的版本會比執行者要的多一格。

This requirement applies to the **Linux** packaging command. The macOS packaging command has no level to
choose: it never bumps.

指定層級 SHALL 經由環境變數 `RELEASE_LEVEL`（`patch`、`minor`、`major`）。**不經由命令列引數**：
打包指令是一串以 `&&` 串起來的步驟，`npm run` 會把引數接在**最後一個**步驟後面，而遞增是第一個。

值不在上述三者之中時，打包指令 SHALL 在動到任何檔案之前失敗並指出可用的值 —— 一個拼錯的層級若靜默
退回 patch，執行者會拿到一個他沒有要的版本，而且那個版本已經被提交了。

#### Scenario: 未指定層級時遞增 patch

- **WHEN** 在版本為 `0.1.18` 時執行 Linux 打包指令，未指定層級
- **THEN** 版本成為 `0.1.19`

#### Scenario: 指定 minor 時遞增 minor 並把 patch 歸零

- **WHEN** 在版本為 `0.1.18` 時以 `RELEASE_LEVEL=minor` 執行 Linux 打包指令
- **THEN** 版本成為 `0.2.0`，且該遞增被提交

#### Scenario: 不認得的層級被拒絕，版本不動

- **WHEN** 以一個不在 `patch`、`minor`、`major` 之中的值執行 Linux 打包指令
- **THEN** 指令以非零結束並列出可用的值，版本宣告未被修改，也沒有新的提交
