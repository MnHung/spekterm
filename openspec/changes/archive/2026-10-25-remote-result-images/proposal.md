## Why

On the phone, a tool result that holds an image shows nothing. When the agent reads an image file (`Read`), the
transcript's result holds only an image block and no text, and the projection keeps only text, so the device
receives an empty result; a browser or MCP screenshot shows its text and loses the picture. Reading images is
how the user and the agent look at screenshots together — including the ones the user sends from the phone as
attachments, which the agent opens with `Read` — so on the phone the result the user most wants to see is the
one that is missing.

## What Changes

- A `result` entry gains `images`: one item per image block the tool result holds (media type and byte size),
  present only when there is at least one. The image's bytes are not in the entry.
- A new remote operation, `images.read`, lets a paired device read one of those images in chunks, addressed by the
  tool result's id and the image's position in `images` — **never by a path**. The bytes come from the session's
  current transcript (the image the agent was given, possibly scaled by the CLI), not from a file on disk. It is
  refused for a result the current transcript does not hold, a position past its images, a subagent's records and
  an image over the size limit; a change between chunks is reported as for `files.read`.
- `operations` lists `images.read`, so a phone tells an older desktop apart.
- The desktop's conversation view labels a result that holds images with how many it holds (it does not show the
  images: the terminal shows the agent's own summary of them).
- `docs/remote-protocol.md` documents the field, the operation, its error code and the client's obligation to
  treat the image as untrusted content.

## Capabilities

### New Capabilities

- `remote-result-images`: a paired device reads an image a tool result in the conversation holds — how it is
  addressed (by the result, never by a path), where the bytes come from, the chunking, the limit and the errors.

### Modified Capabilities

- `agent-transcript-stream`: a tool result names the images it holds (media type and size), without their bytes.
- `remote-protocol`: reading an image a tool result holds joins the operation allow-list, still without a path
  parameter, and the answer to authentication lists it.
- `agent-conversation-view`: a result holding images is labeled with their number.

## Impact

- Code: `src/main/transcript-follow.ts` (`ViewEvent`, `project()`, one shared reading of a result's image
  blocks), a new `src/main/transcript-line-index.ts` (the incremental transcript scan, moved out of
  `src/main/remote-sent-files.ts`, which keeps using it and gains a re-check of a replaced transcript), a new
  `src/main/remote-result-images.ts` (the image index and the chunked read),
  `src/main/remote-protocol.ts` (`OPERATIONS`, `RemoteHost`), `src/main/remote-host.ts`,
  `src/main/remote-frames.ts` (a new error code), `src/renderer/src/shell/terminal/ConversationView.tsx` and both
  dictionaries.
- Protocol: additive within version 1 (one field, one operation, one error code). Older phones ignore them.
- Tests: unit tests for the projection, the index and the read; a `probe:remote` section with the stub agent; a
  `probe:agent-view` assertion for the desktop label; the scenario coverage table.
- Docs: `docs/remote-protocol.md`, `docs/lessons/transcript.md` (the measured shapes), the website's remote access
  and conversation view pages in both languages, `CLAUDE.md`'s remote access paragraph and trigger table.
- The companion Android app implements the client side in its own repository and hides the CLI's
  `[Image: original …]` meta line itself.
