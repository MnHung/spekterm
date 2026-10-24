## Why

On the phone, an agent's tool calls say almost nothing: a tool entry carries only the tool's name and one
identifying string (`identifyingArg`), so a `SendMessage` shows no recipient or message, an `Edit` shows a path
but not the change, a `Skill` shows nothing at all, and a file the agent sent with `SendUserFile` cannot be
opened. Messages from other sessions are worse: one that arrives while the agent works is not shown at all
(measured: 209 such deliveries in two weeks), and one that arrives between turns shows as an anonymous context
entry. spekterm's handoffs and its mother/child sessions talk through exactly these messages, so on the phone
the most important part of the conversation is the least readable.

## What Changes

- A tool entry gains `input`: the tool's arguments, **selected field by field per tool from a white-list**,
  strings shortened to a bound and the shortening named (`inputTruncated`, field → original length). Tools not on
  the list carry no `input`. `arg` stays exactly as it is. A `SendMessage` recipient is selected only when it is
  a name (otherwise it is a socket path or an internal id), with the kind of recipient alongside.
- A `user` entry that the user did not type gains `origin` when the record names one: a message from another
  session or from a subagent (with the sender's name when the record gives one), or a background-task notice.
  The sender's address (`from`, a socket path for sessions) is not selected.
- A message from another session is shown as the sender wrote it (the record's own message field), not inside the
  agent's wrapper, which names the sender's socket path; the desktop labels it with the sender instead.
- The conversation shows two mid-turn deliveries it drops today: a message from another session and a
  background-task notice that arrived while the agent worked. They are shown as not typed by the user, with
  their `origin`.
- A new remote operation, `files.read`, lets a paired device read a file the agent sent to the user with
  `SendUserFile` — whatever it holds, credentials included — in chunks, addressed by the tool call and the file's position in it — **never by a path**. It is
  refused for anything the session's current transcript does not list as sent, for a path that is not a regular file, for a file over 32 MiB, for a file
  that is gone, and for a file that changes between chunks. The answer names the file and its media type.
- `sessions.list`'s `Session` carries the agent session's messaging name (`peerName`), so a phone can show a
  sender's or recipient's spekterm label instead of its messaging name.
- `docs/remote-protocol.md` documents the new fields, the operation, its error codes and the client's obligation
  to treat all of it as untrusted content; `operations` lists it.
- The desktop's "not confirmed" match ignores not-typed entries, as the phone's already does.

## Capabilities

### New Capabilities

- `remote-sent-files`: a paired device reads a file the agent sent to the user — which files are readable, how
  they are addressed, the chunking, the limits and the errors.

### Modified Capabilities

- `agent-transcript-stream`: tool entries carry a white-listed, bounded `input`; not-typed user entries carry
  their `origin`; mid-turn messages from other sessions and mid-turn background-task notices are shown, as not
  typed by the user; the "no file system location" scope names the tool input as agent-written text and the
  sender's address as a location that is not selected.
- `remote-protocol`: reading a file the agent sent to the user joins the operation allow-list, still without a
  path parameter; the session list carries each agent session's messaging name.
- `agent-conversation-view`: a not-typed message is labeled with its origin (another session by name, a subagent,
  a background-task notice), since a session's message no longer carries the agent's wrapper that named the
  sender.

## Impact

- Code: `src/main/transcript-follow.ts` (`ViewEvent`, `project()`), a new `src/main/transcript-tool-input.ts`
  (the per-tool white-list and bounds), a new `src/main/remote-sent-files.ts` (resolution and chunked read),
  `src/main/remote-protocol.ts` (`OPERATIONS`), `src/main/remote-host.ts` (resolving the session's transcript).
- The desktop's conversation view receives the same new fields and the newly shown deliveries (they share the
  projection); it labels not-typed entries by `origin` (new dictionary keys, both languages) and ignores `input`.
- Protocol: additive within version 1 (new fields, one operation, new error codes). Older phones ignore them.
- Tests: unit tests for the projection, the white-list and the read; a `probe:remote` section with the stub
  agent; the scenario coverage table.
- Docs: `docs/remote-protocol.md`, `docs/lessons/transcript.md`, the website's remote access page in both
  languages.
- The companion Android app implements the client side in its own repository from the final protocol.
