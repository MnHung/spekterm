## MODIFIED Requirements

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

- **General**: the UI language, the theme and the interface zoom (see `ui-appearance`).
- **Terminal**: font family, font size and line height, with the preview directly after them, and GPU
  acceleration.
- **Agents & sessions**: agent status reporting, automatic hibernation, and the agent session view (see
  `agent-conversation-view`).
- **Integrations**: the Slack connection (see `slack-intake-source`).
- **Team**: being on a spekterm-server team (see `team-membership`).
- **Remote access**: see "Settings holds the remote access controls".
- **About**: the build identity and, in a packaged build (or one a probe gave an update feed), the update
  status, its controls and the automatic update check setting (see `app-update`).

The interface SHALL keep the same size whichever section is shown, SHALL show its title, and SHALL offer a
visible control that closes it in addition to Esc. Opening it from the activity bar SHALL show the section
shown last in this run of the application, or General the first time.

Opening the inbox or the conversation metrics, by any route (the activity bar, a notification, a control in
Settings), SHALL close Settings first. Opening Settings from the inbox, from an update notification, or from a team notification (`team-membership`),
SHALL close the inbox first. Two modal
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

#### Scenario: General holds the language, the theme and the zoom

- **WHEN** the user shows the General section
- **THEN** it offers the UI language, the theme (System, Light, Dark) and the interface zoom

#### Scenario: Settings lists its sections

- **WHEN** the user opens Settings
- **THEN** it lists General, Terminal, Agents & sessions, Integrations, Team, Remote access and About, and shows one of them

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

#### Scenario: Opening Settings from an update notification closes the inbox

- **WHEN** the inbox is open and the user activates an update notification
- **THEN** Settings is open on About and the inbox is not


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
- **Three exceptions, stated next to the fields they concern**, apply only through their own control or Enter,
  never when focus leaves the field:
  - a Slack token, so that a partly pasted secret is never stored (see `slack-intake-source`);
  - the remote access port, because a port change restarts the listener and drops connected devices (see
    `remote-access`);
  - a team invite link, which connects to the server it names and, on joining, redeems a single-use invite (see
    `team-membership`): it is inspected and joined only through their own controls.

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

#### Scenario: A pasted invite link does nothing until the user asks

- **WHEN** the user pastes an invite link into the Team section and moves focus to another field
- **THEN** no connection to the team server has been made
