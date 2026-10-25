## Context

See proposal.md for why. The facts the approach rests on, measured on this machine's main transcripts (97 files;
image results recorded by CLI 2.1.258–2.1.310). Counts are of `user` records only — the `api-request-blob` copies
(below) are excluded:

- **Where images are.** A tool result's `content` is a list; an image is `{ type: "image", source: { type:
  "base64", media_type, data } }` — that exact shape for all 2,357 images, `data` canonical base64 every time.
  `media_type` was `image/png` (1,223) or `image/jpeg` (1,134). A `Read` of an image yields `[image]` alone; a
  Chrome screenshot `[text, text, image]`. 1–4 images per result (2,256 of 2,301 had one). None was on an error
  result. A record holds at most one `tool_result`.
- **Sizes.** base64 length: `Read` median 159,404, max 681,868 (≈ 512 KiB decoded); Chrome median 52,152, max
  682,088. The line holding such a result: median 166 KB, max 1.4 MB.
- **The same image twice in one line.** `Read`'s record also carries `toolUseResult.file.base64`, with
  `dimensions`. It is Read-specific; an MCP tool's `toolUseResult` is a list of blocks.
- **A decoy.** `api-request-blob` records (430) hold the same `tool_use_id` with the same image blocks, in the
  same `message.content[]` shape; **297 of them come after the `user` record, 133 before**. Among `user` records
  no `tool_use_id` appeared twice (25,460 ids).
- **The CLI's meta line.** After an image the CLI writes an `isMeta` user record `[Image: original 1080x2400,
  displayed at 900x2000. Multiply coordinates by 1.20 …]` (320 seen). It is a separate record, not part of the
  result.
- **Subagents.** Their records live in `subagents/` files, never in the main transcript.
- **What exists.** `project()` turns a `tool_result` into `{ kind: "result", text, error }`; `resultText()` keeps
  only `text` blocks, so an image-only result has `text: ""`. The view events reach a device unchanged
  (`conversation.update`), as they reach the desktop's view. `files.read` (`remote-sent-files.ts`) already solves
  "find a record in a growing transcript by a tool id" with `SentFileIndex` and "send bytes in chunks with a
  version" with `readChunk`. **`SentFileIndex.find()` does not re-check the file on a cache hit**: after the
  transcript is replaced, an id cached from the old one is still answered (its tests only look up the new id).

## Goals / Non-Goals

**Goals:**

- A device knows, from the conversation alone, that a result holds images, how many, their media types and sizes.
- A device fetches any one of them without a path and without watching.
- The position a device names is the same image the entry listed, by construction.

**Non-Goals:**

- **Images in the user's own messages.** An image pasted into the CLI is recorded as a `user` record whose content
  is a list (`[text, image]`; 80 seen). `project()` drops such a record entirely today — its text too — on the
  desktop and on the phone. That is a separate defect (it loses typed text, not only an image); it is filed as an
  issue, not fixed here.
- Showing images in the desktop's conversation view. The terminal (the default view) shows the agent's own
  summary of them; showing bytes in the renderer would need a new IPC path and a CSP change.
- Image dimensions in the entry. The block has none; the device learns them when it decodes.
- Hiding the CLI's `[Image: original …]` line. Recognizing it means matching the CLI's English sentence; the phone
  hides it as its own presentation choice, and the desktop keeps showing it as a not-typed entry.
- Subagents' images (their records are not in the main transcript; the conversation does not show subagents).

## Decisions

### D1. One reading of a record's images, shared by the entry, the index and the read

`resultImagesOf(record)` in `transcript-follow.ts` returns, for a `type === "user"` record that is not
`isSidechain` and whose `message.content` is a list, each `tool_result` block's `{ toolUseId, images }`, where
`images` are its counted image blocks in order: `type === "image"`, `source.type === "base64"`,
`source.media_type` one of `image/png`, `image/jpeg`, `image/gif`, `image/webp` (the image types the API accepts),
`source.data` a string of **canonical base64** (`/^[A-Za-z0-9+/]*={0,2}$/`, length a multiple of 4). Every other
block — text, a `document`, a `tool_reference`, an image with a URL source, another media type, or line-wrapped or
otherwise non-canonical data — is not counted.

`project()` sets the entry's `images: [{ mediaType, size }]` from it, the index records the results it returns,
and the read picks the image at `index` of the same list. **Separate walks would drift**: a record or block one
side counts and the other does not shifts positions, and the device downloads the wrong picture with no error.
Sharing the record walk (not only the block filter) makes that unrepresentable.

`size` is `Buffer.byteLength(data, "base64")`, computed from the length without decoding every image the
projection sees. **For canonical base64 that is the decoded length by construction**; for wrapped or
non-canonical data it is not (`byteLength` counts the newlines: 101 vs 100 for 76-column lines), which is why
such data is not counted. All 2,357 measured images are canonical.

*Alternatives:* a count only (the phone could not choose a decoder or show a size before fetching); per-image
dimensions (needs header parsing per format; see Non-Goals); a block filter shared but record walks separate (the
reviewer's case: a record-level difference would still drift unseen).

### D2. `text` stays as it is

An image-only result keeps `text: ""`. No placeholder text is synthesized: a client renders from `images`, and an
older client keeps showing what it shows today rather than a desktop-invented sentence in the result's text.

### D3. The bytes come from the transcript's tool result, not from disk or `toolUseResult`

- They are what the agent was given (the CLI may have scaled the image: "displayed at 900x2000").
- They exist when the file was deleted, and for a screenshot that never was a file.
- Nothing is addressed by path, so this operation cannot be used to read an arbitrary file through a `Read` call.
- `toolUseResult.file.base64` is rejected: it exists only for `Read`, and an MCP tool's `toolUseResult` has another
  shape. The tool result's `content` is the API content, the same for every tool.

### D4. An index of locations, on a scanner shared with `files.read`

`SentFileIndex`'s incremental scan — the offset kept before an unterminated tail, a reset on a new path, a new
inode or a shorter file, every match recorded (not only the asked one) — moves into a generic
`TranscriptLineIndex` (`src/main/transcript-line-index.ts`): a needle, and a handler given each complete line
containing it with **the line's byte offset**. Two fixes come with the move, for both users:

- **Every lookup `stat`s the transcript first**, hit or miss, and resets on a new inode or a shorter file. Today a
  hit is answered from the cache without looking (Context), so an id from a replaced transcript is still found;
  for images a stale `{ offset, length }` would read bytes of the new file.
- **A recorded location that no longer holds the id** (the line at that offset does not parse, or
  `resultImagesOf()` of it has no such id) **resets the index and scans once from 0** before answering `NO_IMAGE`.

`SentFileIndex` becomes a user of it; its existing tests stay and guard the move, plus one new test for the
stale-hit fix (an id of the replaced transcript → `FILE_NOT_SENT`).

`ResultImageIndex` uses it with the needle `"image"`: for each candidate line it parses the record and records
every `resultImagesOf()` result with at least one image as `tool_use_id → { offset, length }` of the line.
**It stores where the line is, not the images** — a session with dozens of screenshots would otherwise hold tens
of MB.

The needle is a third filter beside the record walk and the block filter, so it must never miss a counted image:
`"image"` is the JSON string token of the block's `type`, independent of spacing (`"type": "image"` matches), not
escaped by `JSON.stringify` (letters are never escaped), and absent from base64 (no `"`). A text result quoting
the word is written `\"image\"` and does not match. Its gain is modest — measured, it selects 2,739 lines
(794 MB) against 26,959 (875 MB) for `"tool_result"`, because image lines are most of the bytes — and the
largest transcript (187 MB) is scanned in 648 ms the first time. It is kept because it costs nothing and skips
parsing the many small text results.

A read: look up the location (scanning only what was appended on a miss), refuse a line longer than 32 MiB as
`TOO_LARGE` before reading it, read that one line by position, parse it, take `resultImagesOf()`'s entry for the
id (else the reset-and-rescan above, then `NO_IMAGE`), take `images[index]` (`NO_IMAGE` past the end), check the
limit (D6) on `byteLength` **before decoding**, decode.

*Alternatives:* parsing every line containing `"tool_result"` (about the same bytes, ten times the lines);
keeping the decoded bytes (memory, above); scanning from the start on every read (a 100 MB transcript per chunk).

### D5. Chunks, version and errors as `files.read`

`images.read` `{ sessionId, toolUseId, index, offset?, length?, version? }` →
`{ size, mediaType, version, offset, data, complete }`. `length` 1..512 KiB (default 512 KiB), `offset` default 0,
`offset` past `size` → `BAD_PARAMS`, `complete` when the chunk reaches `size`. No `name`: an image in a result has
none.

`version` is the first 16 hex digits of the SHA-256 of the decoded bytes. A recorded line does not change and
`/clear` moves to another path, so a different version only happens when the transcript file was replaced and the
new one holds another image under that id and position. It is answered **`FILE_CHANGED`**, reused rather than a new
code: the client's handling is the same ("start again from 0") and its chunk loop for `files.read` works
unchanged. It guards replacement only.

Errors: `NOT_FOUND` (no session, or its agent is not running), `NO_CONVERSATION` (a shell), **`NO_IMAGE`** (new:
the current transcript has no result with that id holding an image at that position — another id, a result
without images, a position past them, a subagent record, an earlier transcript, a line not yet complete),
`FILE_CHANGED`, `TOO_LARGE`, `BAD_PARAMS`. A device does not need to watch.

The session's transcript is resolved as `readSentFile` does (`lastTranscriptPathOf ?? transcriptPathFor`), and the
session's index is dropped when the session is gone, beside the sent-file indexes.

### D6. The limit is 8 MiB decoded

Measured images are at most ≈ 512 KiB, so 8 MiB leaves an order of magnitude and is never met by the images seen;
it bounds what a malformed or future record makes the desktop decode and hold. It is checked on the length before
decoding; over it → `TOO_LARGE` with `detail.limit`, no data. The 32 MiB line bound (D4) is checked before the
line is read; it is a guard, not a limit a client plans around (measured lines reach 2.9 MB), so it answers
`TOO_LARGE` with the same `detail.limit` (the image limit) and the protocol document names only the image limit.

### D7. The desktop labels the count

The result line's summary appends the count: "Result · 2 images", "Result (failed) · 1 image"
(`conversation.resultImages`, `_one`/`_other` in `en`, `_other` in `zh-TW`). The expanded `<pre>` stays the text.

### D8. Client obligation

`docs/remote-protocol.md` §9 gains: an image's bytes are untrusted content — decode only the four listed raster
types with the platform's image decoder, show a decoding failure as "cannot display", and never pass the bytes to
a WebView or another app as a document.

## Risks / Trade-offs

- [The CLI changes the image block's shape, adds a media type, or wraps base64] → nothing is counted; results show
  as today (the white-list's failure direction). `docs/lessons/transcript.md` describes the measurement for
  re-measuring on a CLI upgrade.
- [A read re-reads and re-parses a line of up to ≈ 1.4 MB per chunk] → most images fit one chunk (median ≈ 120 KiB
  decoded); the cost is one `pread` and one `JSON.parse`, not a scan.
- [Moving the scanner could break `files.read` silently] → its unit tests are unchanged and must pass, and the
  probe's `runToolDetail` still reads a sent file. The stat-on-every-lookup fix changes `files.read` behavior for
  a replaced transcript only, in the direction its spec already states.
- [The CLI rewrites a result under the same id in a new transcript on resume or fork] → not measured (no id
  repeats among 25,460); the index reads the current transcript only, so the answer is that transcript's image.

## Migration Plan

Additive within protocol version 1. A phone shows images only when `operations` lists `images.read`, and asks the
user to update the desktop otherwise. The release number is told to the companion app's session after the
release.
