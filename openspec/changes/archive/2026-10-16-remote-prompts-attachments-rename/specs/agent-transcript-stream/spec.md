## MODIFIED Requirements

### Requirement: 送往呈現層的事件不含檔案系統位置

送往呈現層的事件 SHALL 以 session 識別碼定址，SHALL NOT 含有任何絕對路徑 —— 包含來源紀錄
自身記載的工作目錄。

呈現層需要指涉檔案時（例如 agent 讀寫過的檔案），該指涉 SHALL 為 workspace 既有的位置詞彙，
翻譯不出來時 SHALL 呈現為不可導覽的純文字。

**Scope.** "Contains no absolute path" applies to the fields the system selects from a record: the record's
working directory and other locations SHALL NOT be selected. Text written by the user, by the agent, or by
the desktop on the user's behalf is delivered as written and SHALL be presented as plain, non-navigable text.
Examples are a message, an answer, a tool's identifying argument, and the sentence naming a device's
attachments (`remote-attachments`). It SHALL NOT be rewritten to remove paths.

#### Scenario: 事件不含絕對路徑

- **WHEN** the presentation layer receives any content event
- **THEN** it carries no working directory or other location taken from the record's own fields

#### Scenario: A path in a message is shown as plain text

- **WHEN** the user's message contains an absolute file path
- **THEN** the message event carries the path as written

## ADDED Requirements

### Requirement: A message recorded as one paste is shown as the pasted text

When the agent records a user message whose whole content is one paste in its paste markers, the conversation
SHALL show the pasted text without the markers. The markers are an opening marker with an identifier, the
text, and a closing marker with the same identifier, with only line breaks around them. A message that holds
a paste among other text SHALL be shown as recorded.

**Reason**: measured (CLI 2.1.300), a reply long enough for the agent to take it as a paste is recorded
inside paste markers. The conversation then showed the markers, and "not confirmed" never cleared, because
the entry did not match the text that was sent. Replies that carry attachments are long.

#### Scenario: A long reply is shown and confirmed as sent

- **WHEN** a long reply is sent and the agent records it inside paste markers
- **THEN** the conversation shows the reply's text without markers, and the reply is no longer marked as not confirmed

#### Scenario: A paste among typed text is shown as recorded

- **WHEN** a user message holds typed text followed by a paste in its markers
- **THEN** the message is shown as recorded, markers included
