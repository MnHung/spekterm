# terminal-preferences Specification

## Purpose

終端的字型是**使用者的**，不是本應用程式寫死的。

這條能力的存在，是因為它的反面已經發生過：終端的 fontFamily 首選一個**這台機器不存在、本專案也
沒打包**的特定字型，於是靜默落到系統預設等寬字 —— 字型從此與宣告不符，而沒有任何東西會抓到。
預設 SHALL 是「系統的等寬字型」（開箱即正常），特定字型則交由使用者自己設定。

字型不只是外觀：**字型大小與行高都會改變 cell 尺寸**，於是它們同時是 pty 行列數的輸入 —— 改了而
不重新量測，終端的內容會與實際視窗錯位。**行高還牽動框線**，但那條的成立範圍很窄，容易被讀成比
實際更強的宣稱：終端的框線在**倚賴字型 glyph 的降級路徑**下才靠 glyph 拼接（glyph 僅約 1em 高，
行高大於 1 時上下列之間留縫）；GPU 加速啟用時，框線依 cell 邊界程式化繪製、**與行高無關**（見
`terminal-sessions`）。**預設行高之所以仍以「框線相接」為準，是因為降級路徑是真實可達的**，
不是因為它對所有路徑都成立 —— 詳見「終端字型可由使用者設定」。

**GPU 加速本身也是一項偏好**（見「使用者可關閉終端的 GPU 加速」）：它是自動降級擋不住的那一格的
逃生口 —— 「資源取不到」自動退回，但「取得了、卻畫錯」只有使用者看得出來。

此能力亦是本應用程式第一塊**偏好落盤**的基礎（在此之前只有 workspace 與 session 兩個 store）。

## Requirements

### Requirement: 終端字型可由使用者設定

使用者 SHALL 能設定終端的**字型 family**、**字型大小**與**行高**。

- 未設定 family 時，終端 SHALL 採用系統的等寬字型（一個真實存在的字型），SHALL NOT 採用某個未安裝的特定字型名。
- 未設定大小時，終端 SHALL 採用字級尺度推導的預設值（見 `typography-scale`）。
- 未設定行高時，終端 SHALL 採用預設行高。**預設行高 SHALL 使框線於「倚賴字型 glyph 的降級路徑」下亦得以相接** —— 該路徑的框線靠 glyph 拼接，而 glyph 僅約 1em 高，行高大於 1 時上下列的框線之間會留縫。程式化繪製啟用時框線依 cell 邊界繪製、**與行高無關**（見 `terminal-sessions`），但**降級路徑是真實可達的**（渲染資源取不到、驅動有缺陷、或使用者自行關閉 GPU 加速）—— 而落到降級路徑的使用者，正是最沒有能力自救的一群。因此預設值 SHALL 以降級路徑為準，SHALL NOT 因程式化繪製解除了行高的約束而放寬。
- 使用者 SHALL 仍能設定大於預設的行高；其代價（降級路徑下框線留縫）由使用者承擔。
- 設定 SHALL 即時套用於所有已掛載的終端，SHALL NOT 需要重啟。
- 字型大小與行高改變都會改變 cell 尺寸，因此套用時 SHALL 一併把更新後的行列數告知 pty。

#### Scenario: 設定字型 family

- **WHEN** 使用者設定終端字型 family
- **THEN** 終端以該字型呈現

#### Scenario: 設定字型大小並同步 pty

- **WHEN** 使用者設定終端字型大小
- **THEN** 終端以該大小呈現，且 pty 收到更新後的行列數

#### Scenario: 設定行高並同步 pty

- **WHEN** 使用者設定終端行高
- **THEN** 終端以該行高呈現，且 pty 收到更新後的行列數

#### Scenario: 預設行高使框線於降級路徑下亦相接

- **WHEN** 使用者未設定行高，終端於倚賴字型 glyph 的降級路徑下呈現含框線的輸出
- **THEN** 上下列的框線相接，SHALL NOT 因行高而留下縫隙

#### Scenario: 未設定時採用系統等寬字

- **WHEN** 使用者從未設定終端字型 family
- **THEN** 終端以系統等寬字呈現，而非某個未安裝的特定字型（於缺字時回退為破碎的呈現）

#### Scenario: 回到預設

- **WHEN** 使用者清除終端字型設定
- **THEN** family 回到系統等寬字、大小回到字級尺度推導的預設值

### Requirement: 使用者可關閉終端的 GPU 加速

終端的字格渲染**預設 SHALL 使用 GPU 加速**（即 `terminal-sessions` 的程式化繪製路徑）。使用者 SHALL 能關閉它，使終端退回倚賴字型 glyph 的渲染路徑。

**這個開關補的是自動降級擋不住的那一格。** 終端已有自動降級：渲染資源取不到、或於執行期失效時自動退回（見 `terminal-sessions`）。但自動降級只擋得住「**取不到**」—— 擋不住「**取得了，但驅動有缺陷而畫出錯誤的內容**」。後者不觸發任何可觀察的事件，**只有使用者看得出來**，因此也只有使用者關得掉。

- 此偏好 SHALL 與其餘終端偏好一併持久化，並具同等的損毀韌性（見「終端字型偏好持久化並具損毀韌性」）。
- 設定 SHALL 即時套用於所有已掛載的終端，SHALL NOT 需要重啟。
- 關閉後 SHALL NOT 遺失終端既有的內容。

#### Scenario: 預設啟用 GPU 加速

- **WHEN** 使用者從未設定 GPU 加速偏好
- **THEN** 顯示中的終端以程式化繪製的渲染路徑呈現

#### Scenario: 關閉 GPU 加速

- **WHEN** 使用者關閉 GPU 加速
- **THEN** 終端改以倚賴字型 glyph 的路徑呈現，且既有內容仍在

#### Scenario: GPU 加速偏好於重啟後套用

- **WHEN** 使用者關閉 GPU 加速並重新啟動應用程式
- **THEN** 終端仍以倚賴字型 glyph 的路徑呈現

### Requirement: 終端字型偏好持久化並具損毀韌性

終端字型偏好 SHALL 持久化，並於重啟後套用。偏好設定檔的**損毀 SHALL NOT 阻止應用程式啟動** —— 無法信任的內容時，SHALL 以預設偏好啟動（比照 workspace 與 session 設定的損毀隔離）。

寫入的偏好值 SHALL 經驗證：字型大小與行高 SHALL 夾制於各自的合理範圍，字型 family SHALL 為長度受限、不含控制字元的字串；不合法的值 SHALL 被拒絕或夾制，SHALL NOT 原樣寫入。

#### Scenario: 重啟後套用

- **WHEN** 使用者設定終端字型並重新啟動應用程式
- **THEN** 終端仍以該設定呈現

#### Scenario: 偏好設定檔損毀不阻止啟動

- **WHEN** 偏好設定檔的內容損毀，使用者啟動應用程式
- **THEN** 應用程式以預設偏好正常啟動，SHALL NOT 崩潰或無法開啟

#### Scenario: 不合法的偏好值被拒絕

- **WHEN** 嘗試寫入超出合理範圍的字型大小
- **THEN** 該值被拒絕或夾制於範圍內，SHALL NOT 原樣持久化

### Requirement: 偏好設定介面

活動列的 Settings 入口 SHALL 開啟一個編輯終端偏好的介面，提供：

- **UI 語言的選取**：SHALL 以清單呈現受支援的語言（見 `ui-localization`），選取後立即生效。
- **字型 family 的選取**：SHALL 以**下拉選單**呈現系統可列舉的等寬字型（使用者從清單挑選，而非硬記字型名），並含一個「系統預設」選項（＝清除 family）。系統無法列舉字型的平台上，下拉 SHALL 至少提供「系統預設」與當前已設定的字型。
- **字型大小**與**行高**的輸入。
- **GPU 加速**的開關。
- **回到預設**的方式。
- **即時預覽**：SHALL 以當下選取的 family 與大小呈現一段範例文字（a typed size or line height is previewed before it applies; a chosen family applies and is previewed at once）。**該範例 SHALL NOT 含 block element 或 box-drawing 字元** —— 那些字元在終端是依 cell 邊界程式化繪製的、**不經字型**（見 `terminal-sessions`），而預覽是**字型**的呈現。納入它們，預覽會顯示**終端不會有的縫隙**，使用者將據此去調整一個並不存在的問題。預覽的職責是「這個字型長什麼樣」，範例 SHALL 聚焦於足以判別字型的字符（字母、數字、易混淆字符）。
- **應用程式的建置身分**：一段**唯讀**的區段，其內容由 `build-identity` 規範。它不是一項偏好
  —— 納入此介面是因為這裡已經是「關於這個 app 的設定」唯一的入口，而為一個偶發的問題另開一個
  入口不划算。既有的 agent 狀態橋接開關已經是同一種擴張（它也不是終端字型），本條只是把這個
  介面實際承擔的範圍寫進條文。

此介面的標題 SHALL 反映其實際涵蓋的範圍。**它已不只是終端的偏好** —— 一個標題寫著「終端」而
內含應用程式建置身分的對話框，會讓使用者在找版本資訊時不會打開它。

此介面 SHALL 以對話框角色（`role="dialog"`）呈現 —— 於是導航快捷鍵於其開啟時自動被抑制（見 `keyboard-navigation`），不必另行註冊。

The interface SHALL be organized in sections, listed beside the content, with one section shown at a time:

- **General**: the UI language.
- **Terminal**: font family, font size and line height, with the preview directly after them, and GPU
  acceleration.
- **Agents & sessions**: agent status reporting, automatic hibernation, and the agent session view (see
  `agent-conversation-view`).
- **Integrations**: the Slack connection (see `slack-intake-source`).
- **Remote access**: see "Settings holds the remote access controls".
- **About**: the build identity.

The interface SHALL keep the same size whichever section is shown, SHALL show its title, and SHALL offer a
visible control that closes it in addition to Esc. Opening it from the activity bar SHALL show the section
shown last in this run of the application, or General the first time.

Opening the inbox or the conversation metrics, by any route (the activity bar, a notification, a control in
Settings), SHALL close Settings first. Opening Settings from the inbox SHALL close the inbox first. Two modal
layers then never compete for focus or for Esc.

Scenarios in this and other capabilities that say the user "opens Settings" and sees something mean that
Settings shows the section holding it.

**Why sections**: the interface outgrew a single column. Unrelated knobs sat in one unlabelled list, and the
preview was separated from the font fields it previews by three unrelated settings.

#### Scenario: 介面涵蓋終端偏好以外的區段

- **WHEN** 使用者觸發活動列的 Settings 入口
- **THEN** 介面中除終端偏好之外，另有一段唯讀的應用程式建置身分，且介面標題不將自身侷限於終端

#### Scenario: 開啟終端偏好設定介面

- **WHEN** 使用者觸發活動列的 Settings 入口
- **THEN** 出現一個可選取 UI 語言、選取終端字型 family、輸入字型大小與行高、開關 GPU 加速、回到預設、並含即時預覽的介面

#### Scenario: 字型 family 自系統的等寬字型清單選取

- **WHEN** 系統可列舉等寬字型，使用者開啟終端偏好設定介面
- **THEN** 字型 family 的下拉選單以系統的等寬字型為選項（外加「系統預設」）

#### Scenario: 預覽隨選取即時更新

- **WHEN** 使用者於設定介面改變字型 family 或大小
- **THEN** 範例文字即時以新的 family 與大小呈現

#### Scenario: 預覽不含框線字元

- **WHEN** 使用者開啟終端偏好設定介面
- **THEN** 預覽的範例文字不含 block element 或 box-drawing 字元

#### Scenario: 設定介面開啟時抑制導航快捷鍵

- **WHEN** 終端偏好設定介面開啟，使用者按下導航快捷鍵
- **THEN** 該快捷鍵不生效（介面以對話框角色呈現，落入既有的抑制規則）

#### Scenario: Settings lists its sections

- **WHEN** the user opens Settings
- **THEN** it lists General, Terminal, Agents & sessions, Integrations, Remote access and About, and shows one of them

#### Scenario: The preview follows the font fields

- **WHEN** the user shows the Terminal section
- **THEN** the preview comes directly after the font family, size and line height, before any other setting

#### Scenario: Switching sections keeps the size

- **WHEN** the user switches from one section to another
- **THEN** the interface's width and height do not change

#### Scenario: Opening the inbox closes Settings

- **WHEN** Settings is open and the user triggers an inbox notification
- **THEN** the inbox is open and Settings is not

#### Scenario: Opening Settings from the inbox closes the inbox

- **WHEN** the inbox shows the Slack status line and the user activates its control
- **THEN** Settings is open on Integrations and the inbox is not

#### Scenario: Settings reopens on the last section

- **WHEN** the user shows the Terminal section, closes Settings and opens it again
- **THEN** the Terminal section is shown

### Requirement: 偏好包含是否啟用 agent 狀態橋接

偏好 SHALL 包含一個開關，決定是否啟用 agent 的狀態橋接（見 `claude-status-bridge`），
預設為**啟用**。它 SHALL 與既有的終端字型偏好同存於同一份偏好檔、同一個設定對話框。

設定介面 SHALL 說明此開關只影響其後建立或重建的 session。

**此開關 SHALL NOT 因為其他偏好被變更而遺失。** 偏好的部分更新路徑（例如只變更字型）
會自空物件重建其內容，未被明確保留的欄位於該次儲存中被抹除 —— 症狀是「使用者關掉它、
接著調一次字級，它就自己開回來了」，而那正是他關掉它的原因。

**本 requirement 的驗收 SHALL 具備鑑別力，且 SHALL 涵蓋兩個相異的失效方向**：

- **讀不回來** —— 驗收 SHALL **跨一次重新載入**。僅驗證設定當下的回傳值 SHALL NOT 視為滿足
  本條：漏在讀入白名單中的欄位寫得進磁碟卻讀不回來，而那樣的驗收照樣全綠。
- **被其他更新抹掉** —— 驗收 SHALL 涵蓋「變更其他偏好之後此開關仍在」。

**這兩條驗收此前不存在，而本規格的跨重啟條款自訂立起即未被實作滿足** —— 一條有 scenario、
零驗收載體的條文與一條不存在的條文，在每一輪全綠的驗收中無法區分。

#### Scenario: 設定對話框提供該開關

- **WHEN** 使用者開啟終端偏好設定
- **THEN** 對話框呈現「啟用 agent 狀態橋接」的開關
- **AND** 其預設為啟用
- **AND** 介面說明它只影響其後建立或重建的 session

#### Scenario: 切換後跨重啟保留

- **WHEN** 使用者關閉該開關並重新啟動應用程式
- **THEN** 該開關仍為關閉

#### Scenario: 變更字型不影響該開關

- **WHEN** 使用者關閉該開關，其後變更終端字型
- **THEN** 該開關仍為關閉

#### Scenario: 自讀入路徑移除該欄位即失敗

- **WHEN** 該欄位自偏好的讀入路徑中被移除
- **THEN** 驗收失敗

### Requirement: 偏好送往 renderer 時為逐欄位投影

偏好經 IPC 送往 renderer 時 SHALL 以**逐欄位的白名單**投影，SHALL NOT 原樣轉手持有偏好的
物件。未設定的欄位 SHALL 於投影中省略（此語意既有，不得因本條而改變）。

**原樣轉手的失效方式是零徵狀的**：日後加進該物件的任何欄位 —— 包含機密 —— 都會**零改動、
零紅燈**地送到 renderer。而 renderer 渲染不受信任的內容，它不該持有它不需要的東西。
這與「不接受某個東西要由結構保證，不是由沒有人再送它保證」是同一條：
一道白名單讓「把新欄位送出去」需要一個明確的動作。

投影的欄位清單 SHALL 由下一條 requirement 所述的單一來源推導，SHALL NOT 為一份獨立維護的
清單 —— 否則本條只是把既有的兩處白名單增為三處。

**持久化的偏好分為數個群組時，投影 SHALL 涵蓋其每一個群組，且每一個群組 SHALL 各自經過
白名單。** 新增一個群組而讓它繞過投影（原樣轉手該群組、或於投影之外另闢一條回傳路徑），
其失效方式與原樣轉手整個物件完全相同 —— **而既有的守衛只看得見既有的那一個群組**。

**本 requirement SHALL 有一道原始碼守衛**，確保該 IPC 處理常式不再原樣轉手，
且該守衛 SHALL 經對照組驗證。

**該守衛所依據的「回傳整份偏好的方法」清單 SHALL 由反向檢查維持**：持有偏好的模組中
**每一個**回傳整份偏好的方法，都 SHALL 出現在該清單上。少了反向檢查，清單只是一份手寫的
名單 —— **新增一個 setter 而忘了登記，它就成為一條沒有白名單的出口，而守衛照樣全綠**。
這與本規格「偏好欄位的白名單由單一來源推導」所取代的那條失效紀律是同一個形狀。

#### Scenario: 未設定的欄位不出現於投影

- **WHEN** 使用者未設定字型 family，renderer 取得偏好
- **THEN** 所取得的內容中不含 family 欄位（而非含有一個空值）

#### Scenario: 不在白名單中的欄位不被送出

- **WHEN** 主行程持有的偏好物件中存在一個未列入投影白名單的欄位
- **THEN** renderer 取得的內容中不含該欄位

#### Scenario: 改回原樣轉手即失敗

- **WHEN** 該 IPC 處理常式改回原樣轉手整個偏好物件
- **THEN** 驗收失敗

#### Scenario: 未登記的回傳整份偏好的方法使守衛失敗

- **WHEN** 持有偏好的模組中新增一個回傳整份偏好的方法，而它未出現在守衛的清單上
- **THEN** 守衛以非零碼結束

#### Scenario: 新增的群組同樣經過白名單

- **WHEN** 持久化的偏好中某一群組內存在一個未列入該群組投影白名單的欄位
- **THEN** renderer 取得的內容中不含該欄位

### Requirement: 偏好欄位的白名單由單一來源推導

偏好欄位在三條路徑上的判定 —— **自磁碟讀入**、**於部分更新時保留**、**送往 renderer** ——
SHALL 自**單一的欄位來源**推導。新增一個偏好欄位而未於該來源中補齊其判定，
SHALL 導致**型別檢查失敗**。

**這一條取代的是一條已經失效過的紀律。** 那三處此前是三份各自維護的清單，而型別檢查對它們
零感知：漏在讀入清單中的欄位寫得進磁碟卻讀不回來，漏在保留清單中的欄位會在使用者改一次字型
時被抹掉。**兩種失效都沒有任何東西會變紅，而其中一條已經實際發生**（見本規格「偏好包含是否
啟用 agent 狀態橋接」一條的驗收）。

每個欄位 SHALL 就三條路徑各自作答，且 SHALL NOT 有預設答案 —— 特別是「要不要送往 renderer」：
一個沉默的預設會讓下一個機密欄位靜默地流出去，而那正是前一條 requirement 所防的事。

**收斂 SHALL NOT 弱化既有的逐欄位型別繫結。** 目前各欄位的清理器回傳型別彼此不同且直接指派
給具名欄位，於是型別檢查釘得住「哪個清理器配哪個欄位」。若單一來源把清理器的型別統一成
一個不分欄位的形狀，**把清理器接到錯的欄位上就不再是型別錯誤** —— 那是用一個新的靜默失效
（表是單一來源，但每一格接錯無人知）換掉舊的靜默失效（三處各自為政），在本 codebase 是退步。
單一來源的型別 SHALL 使每個欄位的清理器與該欄位的值型別相繫。

**本 requirement 的驗收 SHALL 具備鑑別力，且 SHALL 涵蓋三個相異的違反方式** ——
漏掉欄位、漏答一條路徑、清理器接到錯的欄位。少了它們，一個「寫成了單一來源、但三條路徑
其實仍各自為政」或「表對了但每格接錯」的實作會照樣通過。

**持久化的偏好分為數個群組時，每一個群組 SHALL 各有其單一來源，且每一個來源 SHALL 各自維持
上述的逐欄位型別繫結。** 為了容納一個新群組而把數個群組併入一個不分群組的形狀，其代價正是
本條所禁止的那件事：繫結一旦鬆開，清理器接到錯的欄位上就不再是型別錯誤。

#### Scenario: 漏掉欄位即編譯失敗

- **WHEN** 偏好的型別中存在一個欄位，而該欄位未於單一來源中列出
- **THEN** 型別檢查失敗

#### Scenario: 新增欄位必須就三條路徑作答

- **WHEN** 於單一來源中新增一個欄位而未指明它是否送往 renderer
- **THEN** 型別檢查失敗

#### Scenario: 清理器接到錯的欄位即編譯失敗

- **WHEN** 於單一來源中把某欄位的清理器換成另一個值型別不同的清理器
- **THEN** 型別檢查失敗

#### Scenario: 新增群組中漏掉欄位同樣編譯失敗

- **WHEN** 某群組的型別中存在一個欄位，而該欄位未於該群組的單一來源中列出
- **THEN** 型別檢查失敗

### Requirement: 偏好包含 UI 語言，且其落盤不改變既有偏好的相容性

持久化的偏好 SHALL 涵蓋 UI 語言（其行為由 `ui-localization` 規範）。

**該欄位的加入 SHALL NOT 遞增偏好檔的結構版本。** 版本不符時整檔會被隔離並以預設啟動 ——
一次遞增等於**每個使用者既有的設定歸零**。不含該欄位的既有偏好檔 SHALL 照常讀入，
其餘欄位 SHALL 原封保留。

語言 SHALL NOT 落在終端偏好的群組之內 —— 它不是終端的偏好，而群組名一旦說謊，
下一個非終端的偏好會沿著同一條路再塞一個。

#### Scenario: 語言偏好跨重啟保留

- **WHEN** 使用者選擇一種語言後結束並重新啟動 app
- **THEN** app 以該語言啟動

#### Scenario: 不含語言欄位的既有偏好檔照常讀入

- **WHEN** 偏好檔為本能力擴充之前的內容（含字型與開關，不含語言）
- **THEN** 其既有欄位全部生效，且未被隔離

#### Scenario: 改變語言不影響其他偏好

- **WHEN** 使用者已設定字型與各項開關，隨後改變 UI 語言
- **THEN** 字型與各項開關的值不變

### Requirement: Preferences include automatic hibernation

The preferences SHALL include whether idle sessions hibernate automatically and after how long (see
`session-hibernation`). The default SHALL be **enabled, after 24 hours**.

The Settings interface SHALL offer this as a single choice among: off, 4 hours, 24 hours, 3 days, and 7 days.
A change SHALL take effect without restarting the application.

The persisted value SHALL accept any whole number of seconds, not only the offered choices, with zero meaning
off; a value that is missing, negative, not a whole number, or unreadable SHALL fall back to the default
without affecting the other preferences (the existing corruption-resilience rule of this capability). Turning
it off SHALL be persisted as off, not as a missing value — a missing value means the default, which is on. A
stored value that is not one of the offered choices SHALL be shown as that value, not replaced by the nearest
choice.

**Why any value is accepted**: acceptance needs a threshold of seconds, and a value written into the
preferences is data the product already reads — not a branch the product carries for tests.

#### Scenario: Default is 24 hours

- **WHEN** the preferences contain no automatic-hibernation value and the user opens Settings
- **THEN** automatic hibernation is shown as enabled after 24 hours

#### Scenario: Turning it off persists

- **WHEN** the user turns automatic hibernation off, closes the application and reopens it
- **THEN** automatic hibernation is off

#### Scenario: A change applies without restart

- **WHEN** the stored threshold is a few seconds, the user turns automatic hibernation off in Settings, and an
  idle session that is not displayed then passes that threshold
- **THEN** it is still running, and the application was not restarted

#### Scenario: A value outside the choices is shown as itself

- **WHEN** the stored threshold is not one of the offered choices and the user opens Settings
- **THEN** Settings shows that threshold, not one of the offered choices

#### Scenario: An invalid value falls back to the default

- **WHEN** the persisted automatic-hibernation value is negative or not a number
- **THEN** automatic hibernation is enabled after 24 hours, and the other preferences are unaffected

### Requirement: Settings holds the remote access controls

The Settings interface SHALL contain a remote access section. It SHALL state one of the following:

- that remote access is off;
- that it is on, with the number of paired devices and how many of them are connected;
- that it failed to start, with the cause (see `remote-access`).

The section SHALL hold the remote access controls themselves (see `remote-access`), after that statement: the
switch with the statement of what a paired device can do, the port and additional address, the certificate
fingerprint, pairing, the paired devices with revoking, and reset. It SHALL NOT open another dialog for them.

While remote access is on and its listener failed to start, Settings' list of sections SHALL mark Remote access,
so the failure is visible without opening that section.

**Why in place**: the controls used to sit in a dialog opened on top of Settings, so the user went through two
dialogs to reach one switch.

#### Scenario: The section states that remote access is off

- **WHEN** remote access was never turned on and the user opens Settings
- **THEN** the remote access section states that remote access is off

#### Scenario: The section counts devices

- **WHEN** remote access is on with two paired devices, one of them connected, and the user opens Settings
- **THEN** the remote access section states that it is on, with two devices and one connected

#### Scenario: A listen failure marks the section in the list

- **WHEN** remote access is on, its port is held by another process, and the user opens Settings on another section
- **THEN** the list of sections marks Remote access

#### Scenario: The section holds the switch

- **WHEN** the user shows the remote access section
- **THEN** it shows the remote access switch, and no other dialog is open

### Requirement: A change in Settings applies when it is made

Settings SHALL NOT have a Save or a Cancel control. A change SHALL apply as follows:

- **A choice** (a list, a switch, an option) SHALL apply when it is made.
- **A typed value** SHALL apply when the user presses Enter or leaves the field, and only if it differs from
  the stored value.
  - The preview SHALL follow the typed value before it applies.
  - Once the value applies, the field SHALL show the value that was applied, which can differ from the typed
    one when it was clamped.
  - Esc in a field holding a value that has not applied SHALL restore the stored value and SHALL NOT close
    Settings. Esc while a confirmation is open SHALL cancel the confirmation and SHALL NOT close Settings.
    Esc otherwise SHALL close Settings.
  - Text that a number field cannot parse SHALL be rejected, with the stored value shown again. It SHALL NOT be
    taken as an empty field, which means the default.
  - A choice SHALL NOT apply a typed value that has not applied: choosing a font family keeps the stored size
    and line height.
- **Two exceptions, stated next to the fields they concern**, apply only through their own control or Enter,
  never when focus leaves the field:
  - a Slack token, so that a partly pasted secret is never stored (see `slack-intake-source`);
  - the remote access port, because a port change restarts the listener and drops connected devices (see
    `remote-access`).

A change to the preferences or to the Slack settings, including a token, that fails to apply SHALL be shown next
to its field, in the user's language, and the field SHALL show the stored value again. Settings SHALL stay open.
**Nothing of a failed change SHALL remain**: the values the application reports, and every later write, SHALL
be as if the change had not been made.

**Known gap: the remote access settings.** Their store logs a failed write and reports success, and the reset path
shares that write. Changing it is out of this change's scope and is tracked as issue #88.

Changes SHALL apply in the order they are made, and **each SHALL be applied over the result of the ones before
it**: after two changes, the stored and the shown preferences SHALL both reflect both. This holds in particular
for the font family, size and line height, which are stored together.

**Why**: before this, the language applied at once and every other field waited for Save, so the user could
not tell what had applied. Save also closed the interface before the writes returned, so a failed write
was never shown.

#### Scenario: A choice applies at once

- **WHEN** the user turns GPU acceleration off in Settings, without any other action
- **THEN** the stored preference has GPU acceleration off, and Settings is still open

#### Scenario: A typed value applies when the field is left

- **WHEN** the user types a font size and moves focus to another field
- **THEN** the terminal uses that font size

#### Scenario: A typed value does not apply while it is being typed

- **WHEN** the user has typed a font size and focus is still in the field
- **THEN** the stored font size is unchanged, and the preview shows the typed size

#### Scenario: Esc restores a field that has not applied

- **WHEN** the user types a font size and presses Esc while focus is still in the field
- **THEN** the field shows the stored font size, nothing was written, and Settings is still open

#### Scenario: A clamped value is shown as applied

- **WHEN** the user types a font size above the allowed maximum and presses Enter
- **THEN** the field shows the maximum

#### Scenario: Two quick font changes both persist

- **WHEN** the user applies a font size and, before that write returns, chooses another font family
- **THEN** Settings and the terminal show both the new size and the new family, and so does the stored preference after a reload

#### Scenario: Unparseable text in a number field is rejected

- **WHEN** a font size is stored and the user types text the size field cannot parse, then leaves the field
- **THEN** the stored font size is unchanged, and the field shows it

#### Scenario: Choosing a family does not apply a typed size

- **WHEN** the user types a font size without applying it and then chooses another font family
- **THEN** the stored font size is unchanged

#### Scenario: A failed write is shown and leaves nothing behind

- **WHEN** a change fails to apply because the preferences cannot be written, and the user then changes another setting that can be written
- **THEN** Settings stayed open with a message next to the first field, which showed the stored value
- **AND** the first change is not in the stored preferences or in those the application reports

### Requirement: Each section restores its own defaults after a confirmation

The Terminal section and the Agents & sessions section SHALL each offer to restore their own settings to
their defaults:

- Terminal: font family, font size, line height and GPU acceleration.
- Agents & sessions: agent status reporting, automatic hibernation and the agent session view.

Restoring SHALL first ask for confirmation in place, and SHALL change nothing if the user declines or presses
Esc. It SHALL
NOT change the settings of any other section.

The General section SHALL NOT offer it: restoring the language to the default would leave a reader of
another language in an interface they cannot read. Integrations and Remote access have their own resets.

#### Scenario: Restoring the terminal section leaves the others

- **WHEN** the user has changed the font size and turned agent status reporting off, then restores the
  Terminal section's defaults and confirms
- **THEN** the font size is the default and agent status reporting is still off

#### Scenario: Declining changes nothing

- **WHEN** the user asks to restore the Terminal section's defaults and then declines
- **THEN** the font settings are unchanged

#### Scenario: The language is not restored

- **WHEN** the user has chosen a language other than English and restores both sections' defaults
- **THEN** the language is unchanged
