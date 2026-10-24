## Context

A paired phone shows a watched conversation from the same events the desktop's conversation view gets
(`transcript-follow.ts` `project()`, `remote-protocol` "the same content the desktop's conversation view
shows"). A tool entry is `{ kind: "tool", uuid, at, id, name, arg }`, where `arg` is one string picked from
`file_path/path/pattern/command/url/query/description` (`identifyingArg`). The request came from the Android
session (`spekterm-android-f4c7`) on the user's report that tool calls are unreadable on the phone; the phone
side is built in its own repository from the protocol this change settles.

Measured on the maintainer's transcripts of the last two weeks (CLI 2.1.30x, 2026-10-24; method in task 1.1):

- Tool calls: Bash 28.8k, Write 1.5k, Edit 1.4k, Read 1.0k, SendMessage 0.9k, Agent 0.5k, ToolSearch 0.5k,
  Skill 0.26k, Artifact 0.18k, AskUserQuestion 0.14k, TaskStop 0.13k, WebFetch / WebSearch / Monitor ~50 each,
  SendUserFile 17, ScheduleWakeup 12, CronCreate 7, ExitPlanMode 5; `mcp__*` several hundred.
- Strings over 4,000 characters: Bash `command` 798 (heredocs), Write `content` 705, Agent `prompt` 61, Edit
  `new_string` 7, SendMessage `message` 2.
- Field types are not stable: Agent `run_in_background` is a **string** in 137 of 137 calls that set it; Monitor's
  `timeout` is a string in 5. SendMessage carries both `to`/`message` and `recipient`/`content`; `content` is a shorter cut of `message` in
  896 of 897.
- Messages from other sessions and subagents: 1,145 `user` records with a top-level `origin.kind: "peer"`
  (`isMeta: true`), and **209 `attachment` records of subtype `queued_command`, `commandMode: "prompt"`, with
  `origin.kind: "peer"`** — delivered while the agent worked, and dropped by `queuedPrompt()` today. Of those 209,
  164 have no `user` record with the same body; the 45 that match only share the subagent hand-back preamble
  (different sender, different time), so they are not duplicates.
- Peer origins come in two structural shapes: a session (`verifiedPeerPid`, `msg_id`, `from: "uds:/run/user/…sock"`,
  `name`: the sender's messaging name, e.g. `api-server-8393`) — 792; a subagent hand-back (`senderTaskId`, `from`: the
  task id, `name`: the subagent type when present, absent in 10) — 562.
- Background-task notices: 703 `user` records with `origin.kind: "task-notification"`, and 687 `attachment`
  `queued_command` records with `commandMode: "task-notification"`, also dropped today. Matching by task id and
  status, 12 notices appear in both forms; 56 repeat within the attachment form (a notice fires each time a task
  reports).
- `SendUserFile`: `input.files` is a list of **absolute** paths (0 relative of all listed), plus `caption`,
  `status`, `display`. Its result record's `toolUseResult.attachments[]` carries `path`, `size`, `media_type`,
  `isImage`. The largest file sent was a 26.9 MB `video/mp4`; one listed file of 52.3 MiB was refused by the CLI
  (`upload_error: file_too_large`, "exceeds the 30 MiB upload limit").
- Transcripts: the five largest main transcripts of the period are 48.6–111.7 MB. Besides the `assistant` record, a
  tool call's id also appears in its `user` result record and in `api-request` / `api-request-blob` records (up to
  62 lines, 3.3 MB for one id).

## Goals / Non-Goals

**Goals:**

- A phone can show what each common tool call did: the command, the edit, the message and its recipient, the
  subagent and its prompt, the skill and its arguments, the question and its options.
- A phone can tell a message from another session (and which one) or a subagent from the user's own words, and
  sees messages that arrived while the agent worked.
- A phone can open a file the agent sent to the user.
- Everything additive within protocol version 1: an older phone keeps working unchanged.

**Non-Goals:**

- The desktop's conversation view does not render `input` in this change (it gets it, as the projection is
  shared, and ignores it). It does render `origin`'s label (D4b), because D4a takes the sender out of the text.
- Unwrapping a subagent hand-back's text (D4a): it stays as recorded, preamble and indentation included.
- Tool results are unchanged (a `SendMessage` result stays the CLI's JSON text).
- No generic input for tools off the white-list, `mcp__*` included (D2).
- Reading any other file from a device.

## Decisions

### D1. `input` is a separate, white-listed field; `arg` is untouched

A tool entry becomes `{ kind: "tool", uuid, at, id, name, arg, input?, inputTruncated? }`. `arg` keeps its exact
current value, so older phones and the desktop view are unaffected. `input` is built **field by field from a
per-tool white-list** in a new module, `src/main/transcript-tool-input.ts` — never by copying the CLI's input and
deleting fields (`project()`'s boundary rule: a field the CLI adds later must not flow out by default).

| Tool | Fields |
|---|---|
| `Bash` | `command`, `description`, `run_in_background` |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `Write` | `file_path`, `content` |
| `Read` | `file_path`, `offset`, `limit` |
| `Grep` | `pattern`, `path`, `glob` |
| `Glob` | `pattern`, `path` |
| `SendMessage` | `to` (only when `recipient_kind` is `"name"`, see below), `recipient_kind`, `summary`, `message` |
| `Agent`, `Task` | `description`, `subagent_type`, `prompt`, `run_in_background` |
| `Skill` | `skill`, `args` |
| `SendUserFile` | `files`, `caption` |
| `AskUserQuestion` | `questions`: each `question`, `header`, `multiSelect`, and `options`: each `label`, `description` |
| `ToolSearch`, `WebSearch` | `query` |
| `WebFetch` | `url`, `prompt` |
| `Monitor` | `description`, `command` |
| `TaskStop` | `task_id` |
| `ScheduleWakeup` | `delaySeconds`, `reason` |
| `CronCreate` | `cron`, `prompt` |
| `Artifact` | `action`, `file_path`, `url`, `description` |
| `ExitPlanMode` | `plan` |

Value rules: a top-level field is taken when its value is a string, a finite number or a boolean, and passed
through **as that type** (the CLI writes `run_in_background` as a string; a client must accept either). `files`
is taken when every item is a string (otherwise it is left out whole, so a position in it is the position in the
record, which `files.read`'s `index` names); at most the first 20 items, more is marked truncated. `questions` is
taken as at most 4 questions with at most 8 options each (the device prompt rule's limit), every nested field by the same scalar rule; `preview` and other nested
fields are not taken. A field of any other type is left out. A tool whose white-list yields no field gets no
`input`. `Read`'s `pages`, Bash's `timeout`, `AskUserQuestion`'s `preview`, `SendMessage`'s duplicate
`recipient`/`content` are not selected: they add nothing a phone shows.

**`SendMessage.to` is selected only when it is a name.** Measured over 897 calls: a messaging name in 660
(`recipient_kind: "name"`, never absent for a name), a socket address `uds:/run/user/…/….sock` in 151
(`recipient_kind: "session"` in 145, **absent in 6**), a subagent id in 86 (`"agent"`, absent in 1). A socket
address is the location D4 does not select as `from`, and a subagent id is the internal id D4 does not select
either. So `to` is selected only when `recipient_kind` is exactly `"name"`; a call with no kind, or any other kind,
carries no `to`. `recipient_kind` is selected so a phone can still say "another session" / "a subagent". The rule
is structural (the kind field), and its failure direction is "less": the 7 calls with no kind lose `to`. (Raised by
the phone-side session's review.) **The call's result still names the socket address** (159 of 159 such results,
measured): results are the CLI's text, delivered as written (`agent-transcript-stream`'s scope), and this change
does not touch them.

### D2. Tools off the list carry no `input`

The alternative was a generic "top-level scalar fields" input for unknown tools and `mcp__*`. Rejected: an MCP
server's arguments are whatever its author chose — tokens, query strings with credentials, page scripts — and a
generic rule is the black-list `project()` forbids. Failure direction stays "the phone shows less". `arg` still
gives them their identifying string. A tool earns `input` by being added to the table, with a test.

### D3. Bounds: 4,000 characters per string, 12,000 per call, and the shortening is named

Each selected string is cut to 4,000 UTF-16 code units (not splitting a surrogate pair), and the strings of one
call together to 12,000, taken in white-list order: once the budget is spent, later strings are cut to what is
left (possibly empty). Every top-level field that lost characters, or list items, is named in
`inputTruncated: { <field>: <original length> }`, where the length is the field's original string length, or for
`files` and `questions` the original number of items when items were dropped, else the sum of its strings'
lengths. `inputTruncated` is absent when nothing was cut.

Why these numbers: they keep all but the 1.6k longest of ~36k measured calls whole; an `Edit`'s two strings fit
together. The 400-event first update grows by at most 400 × 12,000 code units: 4.8 MB of ASCII, 14.4 MB of CJK,
28.8 MB if every unit were a control character JSON-escaped as `\u00XX`. Measured over 401 transcripts' last 400
events, the growth is about 10 KB at the median and 0.2 MB at most. Tool results are already unbounded in that update, so the frame cap is not
newly at stake (it applies to what a client sends).

### D4. `origin` on not-typed user entries, from structural fields only

A `user` entry gains `origin?`:

- `{ kind: "peer", sender: "subagent", name? }` — the record's origin is `peer` and carries `senderTaskId`
  (checked first: measured, it never appears together with the session markers);
- `{ kind: "peer", sender: "session", name? }` — `peer` with `verifiedPeerPid` or `msg_id`;
- `{ kind: "peer", sender: "other", name? }` — `peer` with neither;
- `{ kind: "task-notification" }`.

`name` is the record's `origin.name` when it is a non-empty string, with control characters removed and clipped
to 80 characters: the sender's messaging name for a session (what the user sees in spekterm's relations, e.g.
`spekterm-e8d8`), the subagent type for a subagent. **`from` is not selected**: for a session it is a socket
path (`uds:/run/user/…`), a file system location (`agent-transcript-stream`), and for a subagent an internal id
the CLI asks agents not to show. Besides the kind and the name, only a session message's `body` is read, and only
as the entry's text (D4a); nothing else of the origin (`hopChain`, `verifiedPeerProcStart`, `handbackReportText`,
…) is selected. The sender kind is decided by which fields exist, not by parsing `from`
(`docs/lessons/transcript.md` §1). Other origin kinds (`human`, or one the CLI adds) give no `origin`. `meta` keeps
its current meaning and value; `origin` only adds the reason.

### D4a. A session's message is shown as the sender wrote it

The text of a message from another session is the CLI's wrapper: a lead line ("Another Claude session sent a
message:", `user` form only), `<cross-session-message from="uds:/run/user/…/….sock" from-name=… from-mode=…>`, the
message, the closing tag, and a trailing instruction paragraph (`user` form). The wrapper names the socket path D4
keeps out of `origin` (measured: every one of the session messages in both forms). The record also carries the
message itself, structurally: `origin.body` (measured 793 of 794 session messages; in every one, the text with the
body removed is one of two fixed wrappers — `user` and `attachment` form — once the socket path, `from-name`,
`from-mode` and numbers are normalized). So for an entry with `origin.sender: "session"` whose `origin.body` holds
any non-whitespace character, **the entry's `text` is `origin.body`**, as is (it is not passed through
`unwrapPaste` or `commandLine`: those restore what the user typed, and this is not that). Otherwise — a body that is
missing or only whitespace (1 of 794, CLI 2.1.310, cause unknown) — the text is as recorded, **wrapper and socket
path included**: the one place a socket path still reaches an entry, accepted because the alternative is parsing the
wrapper. No wrapper is parsed.

A subagent hand-back keeps its recorded text. Its structural `handbackReportText` (351 of 561) is the report
without the CLI's preamble, but the preamble is where the CLI writes its own warnings about the report (measured:
one hand-back carried "SECURITY WARNING: auto mode blocked this subagent's report…" before the report), and
dropping it would hide that. The wrapper's `from` there is the subagent's internal id, not a location. (Raised by
the phone-side session; the phone strips the known hand-back shapes itself.)

This changes the text only of entries that are not typed by the user, so no reply confirmation depends on it
(both clients match only entries with `meta: false` — the desktop after D5's `!meta`).

### D4b. The desktop's label names the origin

Today the desktop labels every not-typed entry "Context" and shows its text; a session's message was readable as
one because the wrapper said "Another Claude session sent a message" and `from-name="…"`. D4a removes that from the
text, so the label carries it instead: "From <name>" for a session with a name, "From another session" without
one, "From subagent <type>" / "From a subagent", "Background task" for a notice, "Context" otherwise. New
dictionary keys in `en.json` and `zh-TW.json`. The phone shows its own labels from the same fields. (Alternative
rejected: limiting D4a to the remote path — the projection is shared on purpose, `remote-protocol`'s same-content
requirement.)

### D5. Mid-turn peer messages and notices are shown, as not typed by the user

`queuedPrompt()` (renamed `queuedEntry()`; the stub agent already has an option named `queuedDelivery`) grows by two exact shapes of `attachment` / `queued_command`:

- `commandMode: "prompt"` with `origin.kind: "peer"` → a `user` entry with `meta: true` and D4's `origin`;
- `commandMode: "task-notification"` with `origin.kind: "task-notification"` → a `user` entry with `meta: true`,
  `origin: { kind: "task-notification" }`.

Text is the record's `prompt`, or D4a's body for a session's message; identity and time are the record's. The human prompt path is
unchanged. Every other `queued_command` and every other attachment subtype stays ignored — including the 12
measured `task-notification` deliveries that carry no `origin`: admitting them would decide by `commandMode` alone,
and the structural pair is what the white-list asks for. Duplicates are not
removed: the 12 notices recorded in both forms are two records, and the agent received both; a phone shows both,
as the desktop view will.

This also changes the desktop's conversation view: those deliveries now appear there, rendered as the other
not-typed entries are. That is the same-content requirement working as intended. One consequence: the desktop's
"not confirmed" match (`ConversationView.tsx`, ~L162) does not exclude `meta` entries, so a peer message whose text
equals the user's pending reply would clear it. The match gains `!meta`, as the phone's already has.

### D6. `files.read`: addressed by tool call, resolved from the current transcript, read in chunks

`p`: `{ sessionId, toolUseId, index, offset?, length?, version? }` → `r`:
`{ name, size, mediaType, version, offset, data, complete }`.

- **Address.** `toolUseId` is a `SendUserFile` tool entry's `id`, `index` the file's position in its
  `input.files`. No path parameter exists (`remote-protocol`: "No operation SHALL take a path").
- **Resolution.** The desktop reads the session's **current** transcript — the same location the follower uses
  (`lastTranscriptPathOf(sessionId) ?? transcriptPathFor(cwd, conversationId)`) — and finds the `assistant`
  record holding a `tool_use` block with that id and `name: "SendUserFile"` — `type === "assistant"` is required:
  the same id appears in result and `api-request` records. The path is `input.files[index]` as recorded,
  untruncated. It must be an absolute path; anything else is `FILE_NOT_SENT`. Records marked `isSidechain` are
  skipped, as in `project()`.
- **Scanning.** Transcripts reach 112 MB and grow while the agent works, so a cache keyed by size would miss on
  every chunk. The transcript is append-only and an `assistant` record never changes once written: the cache is
  keyed by (path, inode) and holds **every** `SendUserFile` call found (`toolUseId → files`) and the byte offset
  scanned to. A scan parses every line containing the bytes `"SendUserFile"` (then requires `type === "assistant"`),
  and records each call it finds, not only the one asked for — otherwise a lookup of a later call would move the
  offset past an earlier call it did not record, and the earlier one could never be found. A lookup that misses
  scans only the bytes after the offset, streaming (no whole-file read), and splits lines as the follower's
  `consume()` does: an unterminated tail is not parsed and the offset stays before it, since the agent may be in
  the middle of writing that line (an `api-request` line reaches 3.3 MB). The index is one per session; it
  starts over when the session's transcript path changes (`/clear`), the inode changes or the file is shorter than
  the offset, and a session no longer in the store loses its index at the next read.
- **What counts as sent.** Listed in the tool call is enough; the call's result is not consulted. A call the user
  declined lists a file the agent meant to send. This is a scope, not the boundary against a device — a device can
  already type any command into a terminal: the phone opens what the conversation shows as sent, and nothing else
  is addressable. A file sent before `/clear` (a previous transcript) is not addressable, as its entry is not in the
  conversation either.
- **Whatever the agent listed is read, credentials included (the user's decision).** A device can already read
  any file through `terminal.input`, so refusing some locations adds no protection, only a list that can never be
  complete. An earlier draft refused spekterm's data directories and the CLI's credential files; the user chose
  "the agent sends it, the phone reads it" at review. `remote-protocol`'s "reading any credential SHALL NOT be an
  operation" is amended: a file the agent sent is read whatever it holds.
- **Not watching required.** As for `attachments.put`, the device does not have to be watching the conversation:
  a download may outlive leaving the screen.
- **Reading.** `realpath` the path (following symlinks: the agent named it). `stat` the result: missing or not a regular file → `FILE_GONE` — **before opening**, because opening a
  FIFO without `O_NONBLOCK` blocks forever (measured: `fs.promises.open` on a FIFO had not returned after 1.5 s;
  each such call holds one of libuv's four pool threads, and a process with one stuck does not exit even on
  `process.exit` — measured, killed after 120 s). Open **the realpath result** with
  `O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_NOCTTY` (a swap between `realpath` and open cannot redirect it, nor make a
  tty the controlling terminal), `fstat` the descriptor: not a regular file, or a device and inode different from
  the `stat`'s → `FILE_GONE`. `ENOENT` (a dangling link), `ELOOP`, `ENOTDIR` and
  `EACCES` from any step are `FILE_GONE`; over **32 MiB** → `TOO_LARGE` with `detail.limit`. `length` is the most bytes the device wants in this chunk, an integer from 1 to 512 KiB, default 512 KiB
  (`BAD_PARAMS` otherwise): a phone on a slow link asks for less, as its uploads use 64 KiB chunks, because a request
  timeout ends its connection. Read `min(length, size − offset)` bytes at
  `offset` from the same descriptor (never more than `size` says, for files such as `/proc`'s that report 0) and
  return them base64 (≈683 KiB encoded, inside the 1 MiB frame cap). `complete` is `offset + bytes === size`.
- **Consistency.** `version` is an opaque string from the descriptor's `fstat`: device, inode, size and mtime in
  nanoseconds (the inode catches a file replaced by rename). The first answer gives it; a later chunk names it, and
  a different current version is `FILE_CHANGED` (start again from 0). `offset` beyond `size` is `BAD_PARAMS`.
  **Not detected**: an in-place rewrite of equal size within one tick of the kernel's coarse clock (measured on
  ext4: 197 of 200 back-to-back equal-size writes kept the same `mtimeNs`).
- **Naming.** `name` is the path's base name (no directory). `mediaType` from the extension through a fixed table
  (md, markdown → `text/markdown`; txt, log, yaml, yml → `text/plain`; json → `application/json`; csv →
  `text/csv`; html, htm → `text/html`; png; jpg, jpeg → `image/jpeg`; gif; webp; svg → `image/svg+xml`; pdf; mp4;
  webm; mp3 → `audio/mpeg`; zip), case-insensitive, else `application/octet-stream`. YAML is `text/plain` so a client
  shows it as text without knowing a YAML type. A phone shows Markdown, plain text and images in the app and hands the
  rest to the system.

Why 32 MiB: the CLI itself refuses to send a file over 30 MiB (measured), so every file it delivered fits; the
largest measured is 26.9 MB. A file listed but refused by the CLI (52.3 MiB, measured) gets `TOO_LARGE`. A phone
holds the whole file before handing it on. Why
the transcript and not the follower's memory: the follower keeps only events, holds `input` already shortened,
and runs only while something watches; a device may read without watching.

Errors: `NOT_FOUND` (no such session, or no running process to resolve its transcript), `NO_CONVERSATION` (a
shell), `FILE_NOT_SENT` (the current conversation has no `SendUserFile` call with that id, or no file at that
index), `FILE_GONE`, `FILE_CHANGED`, `TOO_LARGE`, `BAD_PARAMS`.

### D6a. The session list carries each agent session's messaging name

A phone shows a session by its spekterm label ("Auto-update"), not by its messaging name (`spekterm-e8d8`), both for
`SendMessage`'s `to` and for a message's `origin.name`. The two names are the same vocabulary — the name a session
is started with (`agent-peer-name`) is what other sessions address and what arrives as `from-name` / `origin.name`
— but the phone cannot map one to the other: `sessions.list`'s `Session` has `label`, not the messaging name.
So `Session` gains `peerName?`: the session record's `peerName` (`session-store`), present for a claude session
once it has one, running or dormant (the name is fixed when first needed and kept on disk). The phone shows the
label of the session whose `peerName` matches, and the raw name for a sender outside the workspace.

Alternative rejected: resolving it in the entry (a `sessionId` beside `to` / `origin.name`). The projection is
per transcript and has no view of the workspace; and an entry resolved once would keep a stale label after a
rename, while a list match stays live (`sessions.changed`). The desktop's label (D4b) keeps the messaging name in
this change: the renderer does not hold `peerName` (main-owned), and wiring it there is a separate change.

### D7. Where it lives

- `transcript-tool-input.ts`: `toolInput(name, raw) → { input, truncated } | null` (D1–D3), pure.
- `transcript-follow.ts`: `ViewEvent` gains the optional fields; `project()` calls `toolInput` and an
  `originOf(origin)` (D4), the body rule (D4a); `queuedPrompt()` becomes `queuedEntry()` (D5).
- `ConversationView.tsx`: D4b's label and D5's `!meta`.
- `remote-host.ts` `sessionList()` and `SessionView` in `remote-protocol.ts`: D6a's `peerName`.
- `remote-sent-files.ts`: `findSentFile(transcriptPath, toolUseId, index)` and `readChunk(path, offset,
  length, version)`, with injected file access for tests; `remote-host.ts` wires the session's transcript location; `remote-protocol.ts` adds `files.read` to `OPERATIONS` and `readSentFile` to the
  `RemoteHost` interface; `remote-frames.ts` adds `FILE_NOT_SENT`, `FILE_GONE` and `FILE_CHANGED` to `ERROR_CODES`.
- `docs/remote-protocol.md` §9 gains a client obligation: `input` and `origin` are agent-written text, shown as
  plain text, `files` never opened as paths; a sent file is untrusted content — Markdown rendered with raw HTML as
  text, plain text, raster images in the app; SVG and HTML handed to the system, never rendered in the app's
  WebView.

### D8. The phone is told the final shape

After the user has reviewed these artifacts, the final shape is sent to `spekterm-android-f4c7` with
SendMessage. If that session is not running, this section is where the phone side reads it. Deviations from the
shape the phone proposed: `origin` carries `sender` and `name` but **not `from`** (D4); a session's message
`text` is the sender's message without the CLI's wrapper, a hand-back's is as recorded (D4a); `files.read` takes an
optional `length` (D6); `sessions.list`'s `Session` carries `peerName` (D6a); `SendMessage`'s `to` is
selected only for a named recipient, and `recipient_kind` is added (D1); `files` is left out whole when an item is
not a string; options are capped at 8 (D1); truncation is reported
per field with the original length (`inputTruncated`); the operation is addressed by `toolUseId` + `index`, not
by path (D6); tools off the list, `mcp__*` included, carry no `input` (D2).

## Risks / Trade-offs

- [The CLI renames a tool's fields] → the field silently disappears from `input` (white-list failure direction);
  `arg` still shows the identifying string. Re-measure on a CLI upgrade (task 1.1's script).
- [A peer-origin shape the CLI adds later] → `sender: "other"`, still marked not typed.
- [History grows with long `Write`/`Bash` inputs] → bounded by D3; results were already unbounded.
- [A sent file is changed by the agent after sending] → the phone gets the current content, not the sent one;
  `FILE_CHANGED` only protects a single download. The CLI keeps no copy we could read.
- [Reading a path the agent chose, credentials included] → only paths the conversation lists as sent; a device
  could already read any file through `terminal.input`, so no new power. An agent led by injected content to send
  a secret sends it to the user's own phone.
- [A device asks for many FIFOs or huge transcripts] → `stat` before open; incremental, streamed scans.
- [Notices shown twice in 12 of ~1.4k cases] → shown as recorded; the agent did receive both.

## Open Questions

- None blocking. The bounds (D3), and the file limit (D6) are choices the user
  may adjust at review.
- Resolved: the Android client's WebSocket library sets no cap on a received message (the phone side checked:
  OkHttp has none and its client adds none), so a several-MB first update (D3) is received.
