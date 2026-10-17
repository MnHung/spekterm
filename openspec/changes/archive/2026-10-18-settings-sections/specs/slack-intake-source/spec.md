## RENAMED Requirements

- FROM: `### Requirement: 連線設定為資料，且其編輯入口不寄居於終端偏好`
- TO: `### Requirement: 連線設定為資料，存於本能力自己的位置，且於 Settings 的 Integrations 區段編輯`

## MODIFIED Requirements

### Requirement: 連線設定為資料，存於本能力自己的位置，且於 Settings 的 Integrations 區段編輯

連線所需的設定（憑證、回看範圍、服務端點）SHALL 為使用者可編輯的**資料**，
SHALL NOT 為程式碼中的常數，SHALL NOT 需要重新安裝應用程式。

**但「要偵測誰被提及」與「連到哪個工作區」SHALL 自憑證推導，SHALL NOT 為使用者可編輯的設定。**
兩者 MAY 被快取以供呈現，而快取 SHALL NOT 有面向 renderer 的寫入通道。

理由是**失效模式**，不是便利：一個由使用者填寫的「要偵測誰」填錯了，症狀是**什麼都不會發生**
—— 與「沒有人提及我」、與「連線已失效」在畫面上完全相同，而這條能力的每一種失效本來就都長
那個樣子（見「連線與授權的失效對使用者可見」）。再加一個同樣形狀的失效源，等於把那條
requirement 的價值抵消掉一部分。自憑證推導則**表達不出來填錯** —— 憑證能看到的就是它擁有者
看到的東西，而推導出的身分就是那個擁有者。

本條的用意（不是常數、不需重新安裝）因此完全保留：推導比設定更強地滿足它。

設定 SHALL 落於本能力自己的持久化位置，SHALL NOT 與終端偏好共用同一份檔案或同一個物件
（理由與 `intake-routing` 對規則的同形條款一致：該檔案的寫入路徑自空物件重建其內容，
寄居其中的欄位倚賴每一個寫入者記得保留它）。憑證另受 `secret-scope` 約束。

The editing interface SHALL be the Integrations section of Settings (see `terminal-preferences`), and the
inbox SHALL NOT have its own copy of it. Where it is edited and where it is stored are separate questions: the
storage rule above stands unchanged.

- A token SHALL be stored only through its own save control, never when focus leaves the field, so that a partly
  pasted secret is never stored. The section SHALL say so next to the field.
- A token SHALL also be stored on Enter.
- The look-back window and the endpoint SHALL apply when the user presses Enter or leaves the field, and SHALL
  show a failure to apply next to the field (the save rule of `terminal-preferences`).
- The endpoint field is a draft: leaving it empty SHALL change nothing, and the endpoint SHALL return to the
  default only through its own reset control.
- An endpoint the user enters that is not an acceptable `https:` address SHALL be refused and shown as refused,
  and the stored endpoint SHALL stay as it was. An edit SHALL NOT silently turn into the default. A stored value
  that fails the check when it is read back is a different case: it still means the default.
- While no routing fallback folder is set (see `intake-routing`), the section SHALL say that mentions will
  arrive with no folder to open in, and SHALL offer a control that opens the inbox's routing rules. While a
  fallback is set, it SHALL NOT say so.

**Why it moved**: the inbox held these knobs in a tab beside its content, and each knob there followed its
own save model. The previous reason for keeping them out of the preferences dialog was that its content was
enumerated as terminal preferences. That dialog is now the application's single place for settings.

#### Scenario: 設定跨重啟保留

- **WHEN** 使用者經編輯介面設定連線，應用程式其後重新啟動
- **THEN** 該設定仍然生效

#### Scenario: 變更終端偏好不影響本能力的設定

- **WHEN** 本能力的設定已完成，使用者其後變更終端字型設定
- **THEN** 本能力的設定未改變

#### Scenario: 身分沒有面向使用者的編輯入口

- **WHEN** 檢視本能力的編輯介面與其 IPC 介面
- **THEN** 其中沒有設定「要偵測誰」或「哪個工作區」的通道
- **AND** 憑證設定完成後，介面呈現自該憑證推導出的身分

#### Scenario: The connection is edited in Settings, not the inbox

- **WHEN** the user opens the inbox
- **THEN** it has no Slack settings; Settings' Integrations section has them

#### Scenario: A token is not stored when the field is left

- **WHEN** the user pastes into a token field and moves focus away without using its save control
- **THEN** no token is stored

#### Scenario: The look-back window applies once

- **WHEN** the user types a two-digit look-back window and leaves the field
- **THEN** the stored value is that number, and no single-digit value was stored while typing

#### Scenario: An invalid endpoint is refused and the stored one stays

- **WHEN** a custom endpoint is stored and the user enters an `http:` address and presses Enter
- **THEN** the section shows that it was refused, and the stored endpoint is still the custom one

#### Scenario: An empty endpoint draft changes nothing

- **WHEN** a custom endpoint is stored and the user moves focus into the empty endpoint field and out again
- **THEN** the stored endpoint is still the custom one

#### Scenario: The fallback hint follows the fallback

- **WHEN** no routing fallback folder is set and the user shows the Integrations section
- **THEN** it says that mentions arrive with no folder to open in, and its control opens the inbox's routing rules
- **AND WHEN** a fallback folder is then set
- **THEN** the section no longer says so

## ADDED Requirements

### Requirement: The inbox says when Slack is not working

While the Slack connection is set up and not working (an invalid credential, missing permissions, a connection
failure, or a wait the service asked for), the inbox SHALL show one line stating that, as the Integrations section
of Settings states it. The line SHALL offer a control that closes the inbox and opens Settings on that section. While the connection
works, or was never set up, the inbox SHALL NOT mention Slack.

**Why**: from the outside, every failure of this capability looks the same as nobody mentioning the user: an empty
inbox (see "連線與授權的失效對使用者可見，且與「沒有人提及你」可區分"). The user looks at the inbox, not at
Settings, so the inbox is where the difference must be visible.

#### Scenario: A broken connection is stated in the inbox

- **WHEN** the Slack credential is no longer valid and the user opens the inbox
- **THEN** the inbox states that Slack is not working, and its control opens Settings on Integrations

#### Scenario: A working or absent connection is not mentioned

- **WHEN** Slack was never set up, or works, and the user opens the inbox
- **THEN** the inbox does not mention Slack
