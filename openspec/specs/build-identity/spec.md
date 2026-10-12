## Purpose

「我手上跑的這份，是不是剛才那次打包的產物？」—— 這個問題的完整答案。它涵蓋版本的逐次遞增、
建置身分（版本／建置時刻／commit／工作副本是否乾淨）的產生與固定，以及這個身分在**產物檔名**
與**執行中的 app**兩處被說出來且彼此一致。

這條能力之所以獨立存在，是因為它要防的失效**看起來完全不像失效**：換版後行為沒變時，「修正沒
生效」與「根本還在跑舊的」在畫面上一模一樣，而後者會讓人去改一份已經是對的程式碼。產品身分中
**凍結**的那一半（`productName`、`appId`、userData 路徑）由 `app-identity` 規範；本能力管的是
**逐次改變**的那一半，兩者不重疊。

## Requirements

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

### Requirement: 產物的檔名帶有該次打包的版本

打包產物的檔名 SHALL 含該次打包的版本，使檔案系統上並存的多份產物可以在**不執行它們**的前提下
區分 —— 這是「這個檔案是哪一版」的答案。

#### Scenario: 檔名含當次的版本

- **WHEN** 執行打包指令後檢視產物的檔名
- **THEN** 其中含有該次打包所宣告的版本

### Requirement: 執行中的應用程式說得出自己的建置身分

應用程式 SHALL 提供一處使用者可及的介面，呈現其**建置身分**：版本、建置時刻、產出該建置的
commit，以及**建置當時工作副本是否帶有未提交的變更**。

該介面 SHALL 為活動列 Settings 入口所開啟的設定介面之內的一段。**SHALL NOT 呈現於狀態列** ——
`status-bar` 明文「SHALL NOT 呈現應用程式版本號這類恆為同一個值的欄位」，而本能力不推翻該裁決：
「我跑的是哪一版」是偶發的問題，不值得在一條恆常可見的單行狀態列上永久佔一格。

**此處呈現的版本 SHALL 與產物檔名所帶的版本相同。** 兩者各自正確但彼此不同時，使用者依然無法
確認手上跑的是不是剛才那份產物 —— 那等於沒有回答任何問題。

#### Scenario: 設定介面呈現建置身分

- **WHEN** 使用者開啟設定介面
- **THEN** 其中呈現版本、建置時刻與產出該建置的 commit

#### Scenario: 呈現的版本與產物檔名的版本相同

- **WHEN** 啟動一份打包產物並讀取其設定介面所呈現的版本
- **THEN** 該版本與該產物檔名所帶的版本相同

### Requirement: 工作副本不乾淨時，建置身分明確標示之

建置當時工作副本除版本遞增本身之外仍帶有未提交的變更時，建置身分 SHALL 明確標示這件事。

理由不是完整性而是**正確性**：那份產物**不對應任何 commit**，其 commit 欄位指向的是最近一次
提交，而非實際被建置的原始碼。缺少標示時，那個 commit 值是一個**看起來完全正常的錯誤答案** ——
它會讓人去 checkout 一個與手上產物不同的狀態，然後對著它找一個不在那裡的差異。

#### Scenario: 帶著未提交的變更建置時被標示

- **WHEN** 工作副本帶有未提交的變更（版本宣告以外），並產生建置身分
- **THEN** 該身分標示工作副本不乾淨

#### Scenario: 工作副本乾淨時不標示

- **WHEN** 工作副本除版本遞增本身之外沒有未提交的變更，並產生建置身分
- **THEN** 該身分不標示不乾淨

### Requirement: 建置身分於建置當下固定，不隨執行環境改變

建置身分 SHALL 於建置當下決定並固定於產物之中。同一份產物 SHALL NOT 因執行時所處的環境
（當下的工作副本狀態、是否位於版控之下、啟動時刻）而呈現不同的建置身分。

此條防的是一個具體且合理的錯誤實作：於執行時去問 git。那在開發者自己的機器上看起來完全正常
—— 而**產物本來就該能脫離 repo 執行**（`desktop-packaging` 已明訂），到了那裡它沒有 git 可問，
建置身分會靜默地退化或落空。

#### Scenario: 產物脫離 repo 執行時建置身分仍完整

- **WHEN** 將產物複製到版控之外的目錄並執行，讀取其設定介面所呈現的建置身分
- **THEN** 版本、建置時刻與 commit 皆完整呈現，與在 repo 之內執行時相同

### Requirement: 開發模式呈現明確標示為開發的身分

開發模式沒有「打包時刻」可言。此時應用程式 SHALL 呈現一個**明確標示為開發模式**的建置身分，
SHALL NOT 呈現一個看起來像打包產物的值 —— 例如把行程啟動時刻冒充為建置時刻。

一個看起來像產物、實則來自 dev 的身分，會讓「我剛才是不是啟動錯東西了」這個問題也失去答案，
而那正是本能力要消除的那一族歧義。

#### Scenario: 開發模式的身分可與打包產物區分

- **WHEN** 以開發模式啟動並開啟設定介面
- **THEN** 其中呈現的建置身分明確標示為開發模式

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
