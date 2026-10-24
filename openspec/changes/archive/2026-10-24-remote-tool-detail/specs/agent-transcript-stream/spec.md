## MODIFIED Requirements

### Requirement: 送往呈現層的事件不含檔案系統位置

送往呈現層的事件 SHALL 以 session 識別碼定址，SHALL NOT 含有任何絕對路徑 —— 包含來源紀錄
自身記載的工作目錄。

呈現層需要指涉檔案時（例如 agent 讀寫過的檔案），該指涉 SHALL 為 workspace 既有的位置詞彙，
翻譯不出來時 SHALL 呈現為不可導覽的純文字。

**Scope.** "Contains no absolute path" applies to the fields the system selects from a record: the record's
working directory and other locations SHALL NOT be selected. That includes the address a message from another
session names as its sender, which is a socket path. Text written by the user, by the agent, or by the desktop on
the user's behalf is delivered as written and SHALL be presented as plain, non-navigable text. Examples are a
message, an answer, a tool's identifying argument, the selected input of a tool call (a command, an edited file's
path, a message to another session), and the sentence naming a device's attachments (`remote-attachments`). It
SHALL NOT be rewritten to remove paths.

#### Scenario: 事件不含絕對路徑

- **WHEN** the presentation layer receives any content event
- **THEN** it carries no working directory or other location taken from the record's own fields

#### Scenario: A path in a message is shown as plain text

- **WHEN** the user's message contains an absolute file path
- **THEN** the message event carries the path as written

#### Scenario: The sender's socket address is not selected

- **WHEN** the transcript holds a message from another session whose origin names the sender by a socket path and holds the sender's message
- **THEN** the message event carries the sender's name and kind, and no part of that socket path

#### Scenario: A recipient addressed by socket is not selected

- **WHEN** the agent sends a message to another session addressed by a socket path, whether or not the record states the kind of recipient
- **THEN** the tool call event's selected input carries no recipient and no part of that socket path
- **AND** it carries the summary and the message, and the kind of recipient when the record states it

### Requirement: A message the user typed while the agent worked is presented as the user's message

A message the user submits while the agent is running tools is recorded by the agent as a different record
type from an ordinary user message (measured, CLI 2.1.300: an `attachment` record of subtype
`queued_command`). The follower SHALL present such a record as a user message when, and only when, the record
says it is a prompt typed by a human.

That same subtype also carries messages from other sessions and background-task notices. A delivery the record
marks as a prompt from another session or a subagent, and a delivery the record marks as a background-task
notice, SHALL be presented as user messages **marked as not typed by the user**, carrying their origin (see "A
user message the user did not type names where it came from"). Neither SHALL be presented as the user's message.

The presented text SHALL be the text the record delivered, unchanged, except that a message from another session
is presented as the sender's message (see "A user message the user did not type names where it came from"). A
client confirms that its message arrived by matching that text. The message SHALL be identified by the record's own identifier and time, and SHALL appear
where the record appears in the transcript.

This extends the record white-list by one subtype of one more record type, in these three shapes. Every other
record of that type, and every other delivery of that subtype, SHALL remain ignored.

#### Scenario: A message typed during a tool run appears

- **WHEN** the user submits a message while the agent is running a tool, and the agent records it as a mid-turn delivery
- **THEN** the conversation shows that message as the user's, with exactly the submitted text

#### Scenario: Other deliveries of the same record type are not the user's

- **WHEN** the transcript holds a mid-turn delivery that is a background-task notice, and another that is a message from another session
- **THEN** neither is shown as the user's message

#### Scenario: A message from another session that arrived mid-turn is shown

- **WHEN** another session sends this session a message while its agent is running a tool, and the agent records it as a mid-turn delivery
- **THEN** the conversation shows that message, with the sender's message as its text, marked as not typed by the user and as coming from that session

#### Scenario: A background-task notice that arrived mid-turn is shown

- **WHEN** the agent records a background-task notice as a mid-turn delivery
- **THEN** the conversation shows it, marked as not typed by the user and as a background-task notice

#### Scenario: Other records of that type stay ignored

- **WHEN** the transcript holds a record of the same type with any other subtype, or a mid-turn delivery of any other kind
- **THEN** it is not shown, and no error is shown

## ADDED Requirements

### Requirement: A tool call carries its selected input, within bounds, and says what was shortened

A tool call event SHALL keep its single identifying argument unchanged, and SHALL additionally carry the tool's
input as **selected field by field from a per-tool list**: for each listed tool, only the named fields, and only
when the value is a string, a number, a boolean, or for a listed list field its listed items. The list names at
least the shell command and its description; an edit's file, old text, new text and replace-all flag; a
written file and its content; a read's file and range; a message to another session's kind of recipient, its summary and message, and its recipient
only when the record says the recipient is named (a recipient addressed otherwise is a socket path or an internal
identifier); a subagent's description, type, prompt and background flag; a skill's name and arguments; the files
sent to the user and their caption; a question's text, header, multi-select flag and options' labels and
descriptions. A tool not on the list, an MCP tool included, SHALL carry no selected input. The input SHALL NOT be
built by copying the recorded input and removing fields.

Each selected string SHALL be at most 4,000 characters, and one call's selected strings together at most 12,000.
A field that was shortened, or lost list items, SHALL be named together with its original length or item count.
Nothing shortened SHALL be reported as shortened.

**Reason**: the identifying argument alone tells a phone almost nothing about a message to another session, an
edit, a subagent or a skill. The record's input also holds fields the agent adds over time, and a copy would let
them through.

#### Scenario: A message to another session shows its recipient and text

- **WHEN** the agent calls its tool to send a message to another session addressed by name
- **THEN** the tool call event carries the recipient, the kind of recipient, the summary and the message as recorded, and the identifying argument as before

#### Scenario: An edit shows the change

- **WHEN** the agent edits a file
- **THEN** the tool call event carries the file's path, the old text, the new text and the replace-all flag

#### Scenario: A field the agent adds is not passed on

- **WHEN** a listed tool's recorded input holds a field that is not on that tool's list
- **THEN** the tool call event does not carry that field

#### Scenario: An MCP tool carries no selected input

- **WHEN** the agent calls an MCP tool
- **THEN** the tool call event carries its name and identifying argument, and no selected input

#### Scenario: A long written file is shortened and says so

- **WHEN** the agent writes a file whose content is longer than 4,000 characters
- **THEN** the tool call event carries the first 4,000 characters of the content and names the content as shortened, with its original length

#### Scenario: A short call is not marked shortened

- **WHEN** every selected string of a tool call is within the bounds
- **THEN** the tool call event names nothing as shortened

### Requirement: A user message the user did not type names where it came from

A user message marked as not typed by the user SHALL carry its origin when the record names one in a form the
system knows:

- a message from another session: its kind, and the sending session's name when the record gives one;
- a message from a subagent this session delegated to: its kind, and the subagent's type when the record gives
  one;
- a message from another sender the record calls a peer: its kind, and its name when given;
- a background-task notice: its kind.

The kind SHALL be decided by which fields the record's origin holds, not by the form of the sender's address. A
name SHALL have control characters removed and be at most 80 characters. Only the kind and the name SHALL be
selected from the origin, and a session's message (below) only as the text. An origin of any other kind SHALL add
nothing. Whether the message is marked as not typed by the user SHALL be decided as before.

A message from another session whose origin holds the sender's message as its own field SHALL be presented with
that field as its text, as held there, without the agent's wrapper around it (the wrapper names the sender's socket
address). No wrapper SHALL be parsed to obtain it; when the field is missing or holds only whitespace, the text is
presented as recorded. A subagent's report SHALL be presented as recorded, so that whatever the agent wrote before
the report, a warning included, stays visible.

#### Scenario: A message from another session names its sender

- **WHEN** the transcript holds a message another session sent, whose origin names that session
- **THEN** the message is marked as not typed by the user and carries that it came from a session, with that session's name

#### Scenario: A session's message is shown without the agent's wrapper

- **WHEN** the transcript holds a message from another session, recorded inside the agent's wrapper that names the sender's socket address, with the message also held in the origin's own field
- **THEN** the entry's text is that message, and no part of the socket address

#### Scenario: A subagent's report names the subagent type

- **WHEN** the transcript holds a subagent's report delivered to this session, whose origin names the subagent's type
- **THEN** the message carries that it came from a subagent, with that type

#### Scenario: A background-task notice is named as one

- **WHEN** the transcript holds a background-task notice the agent recorded as a user message
- **THEN** the message carries that it is a background-task notice

#### Scenario: A typed message carries no origin

- **WHEN** the transcript holds a message the user typed, whose origin is human
- **THEN** the message carries no origin
