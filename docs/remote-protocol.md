# spekterm remote protocol, version 1

The contract between spekterm's remote access listener and a companion client such as the Android app. It is
written so a client can be built from it alone. `scripts/remote-protocol-doc.test.mjs` fails when the
operations listed here and the ones the server accepts differ.

Remote access is off by default. While the user has it on, spekterm listens on a TCP port (default 47615) on
every network interface. The client connects directly — over the same LAN, Tailscale, or a router port forward.
**Nothing sits in between, and spekterm makes no connection of its own**: a client learns of events only while
it is connected.

## 1. Pairing link

The desktop's remote access dialog shows a QR code and the same link as text:

```
spekterm://pair?v=1&a=<addresses>&p=<port>&fp=<fingerprint>&c=<code>&n=<name>
```

| Field | Meaning |
|---|---|
| `v` | Link version, `1`. |
| `a` | Comma-separated addresses at which the desktop may be reached: its non-loopback interface addresses (IPv4 first, then global IPv6) and, if the user entered one, an additional address such as a Tailscale or DDNS name. URL-encoded (a comma arrives as `%2C` until decoded). |
| `p` | The port. |
| `fp` | SHA-256 of the desktop's certificate (DER), as 64 hex digits, no separators. |
| `c` | The pairing code: 26 characters of RFC 4648 base32. Valid once, for five minutes, and only while the desktop's pairing view is open. Case-insensitive. |
| `n` | The desktop's host name, for display. |

Try the addresses in order until one connects. Keep all of them with the pairing: the reachable one changes
as the phone moves between networks. After pairing, the desktop sends its current list on every connection
(section 4) and whenever it changes while you are connected (section 6). Keep that latest list too, and try
it first: it is how a desktop whose address changed stays reachable without pairing again.

## 2. Transport and certificate pinning

- **WebSocket over TLS**: `wss://<address>:<port>/v1`. TLS 1.2 or later. Any other path is refused.
- The certificate is **self-signed** (ECDSA P-256, `CN=spekterm`, no extensions, no SAN). It never changes
  until the user resets remote access.
- **Trust exactly the pinned certificate**: the leaf's SHA-256 over its DER must equal `fp`. Nothing else is
  trusted — no CA, no host name.
- **On Android with OkHttp, check the pin in both the `X509TrustManager` and the `HostnameVerifier`.** The
  default verifier fails a certificate with no SAN for every address; an "accept everything" verifier is the
  pattern Google Play's security scanning flags. Make both compare the leaf to the pin and reject otherwise.
- Do not send anything — above all the credential or the pairing code — before the pin is checked.
- Frames are UTF-8 JSON text. A frame over 1 MiB closes the connection, with no error answer. The desktop keeps
  its answers to the `openspec.*` operations within the same 1 MiB (section 5); other answers, such as a
  `conversation.watch` history, are not bounded by it.
  permessage-deflate is offered.

## 3. Frames

| Direction | Shape |
|---|---|
| client → server | `{ "t": "req", "id": <number or string>, "m": "<operation>", "p": { … } }` |
| server → client, answer | `{ "t": "res", "id": <same id>, "ok": true, "r": <result> }` |
| | `{ "t": "res", "id": <same id>, "ok": false, "e": { "code": "<CODE>", "message": "<text>", "detail": { … }? } }` |
| server → client, event | `{ "t": "evt", "k": "<kind>", "d": <data> }` |

`id` is chosen by the client and echoed. Answers may arrive out of order. A malformed frame is answered with
`BAD_FRAME` (and `id: null` when no id could be read).

### Error codes

Stable strings; branch on them, show `message` only as a detail.

| Code | Meaning |
|---|---|
| `BAD_FRAME` | Not a request frame. Before authentication the connection is then closed. |
| `BAD_PARAMS` | A parameter is missing or has the wrong type. |
| `UNKNOWN_OPERATION` | Not an operation of this protocol. Nothing happened; the connection stays open. |
| `UNSUPPORTED_VERSION` | None of the offered versions is supported. `detail.supported` lists the server's. |
| `NOT_AUTHENTICATED` | An operation before `hello` or `pair`. |
| `AUTH_FAILED` | Unknown device or wrong credential. |
| `PAIRING_FAILED` | The pairing code is not valid (used, expired, or its view closed). |
| `THROTTLED` | Too many failed attempts from this address; refused for 60 seconds. |
| `TOO_MANY_CONNECTIONS` | The authenticated-connection cap (16) is reached. |
| `NOT_FOUND` | No such session, item, change, spec, or folder — or no running process for it. |
| `NO_WINDOW` | The desktop has no window (macOS after closing it); session actions cannot be carried out. |
| `NO_CONVERSATION` | The session has no conversation (a shell). |
| `NOT_WATCHING` | A reply to a conversation this connection is not watching. |
| `WAIT_STATE` | The agent cannot take a reply now; `detail.state` is the wait state. |
| `FOLDER_REQUIRED` | Accepting an inbox item needs the folder the user chose. |
| `CREATE_FAILED` | The desktop could not carry out a session action (create, wake, hibernate, close); `message` says why. |
| `TIMEOUT` | The desktop's interface did not answer within 15 seconds. |
| `PROMPT_GONE` | The prompt an answer names is not the one a device may answer now (section 5, `conversation.answer`). `detail.open` is the number of open requests. |
| `NOT_ANSWERABLE` | The decision does not fit the prompt, or that answer is not offered to a device. |
| `TOO_LARGE` | An attachment, a chunk or a session's stored attachments would exceed a limit, or an OpenSpec answer would exceed the frame cap (section 5); `detail.limit` is the limit in bytes. |
| `TOO_MANY` | A session already holds the most attachments not sent yet (`detail.limit`). |
| `UNSUPPORTED_TYPE` | An uploaded file is not an image (PNG, JPEG, GIF, WebP), a PDF or UTF-8 text. |
| `SESSION_BUSY` | Hibernating or closing a session that is not idle, without `force`. Nothing happened. `detail.reason` says why (section 5, `sessions.hibernate`). |
| `INTERNAL` | Anything else. |

### Close codes

| Code | When |
|---|---|
| 4001 | No authentication within 10 seconds of the handshake. |
| 4003 | Refused (after a failed `hello`/`pair`, a frame before authentication, or a bad version), one second after the answer. |
| 4004 | The device was revoked (or remote access reset). Do not reconnect with that credential; pair again. |
| 4005 | Remote access was turned off. |
| 4029 | Too many connections. |
| 4030 | Throttled. |

## 4. Authentication and version negotiation

The first frame must be `hello` or `pair`, within **10 seconds** of the TLS handshake. Silence counts as a
failed attempt. Ten failures from one address within 60 seconds refuse that address for 60 seconds; other
addresses are unaffected. A refused connection is closed one second after the answer.

Both carry `protocol`: the versions the client supports, e.g. `[1]`. The answer's `r.protocol` is the one
chosen. This document is version 1.

### `hello`

`p`: `{ "protocol": [1], "deviceId": "…", "deviceSecret": "…" }` → `r`: `{ "protocol": 1, "server": { "name", "version" }, "addresses": [string], "operations": [string] }`

`addresses`: where the desktop may be reached now, built the same way as the pairing link's `a` list (its
non-loopback interface addresses, IPv4 first, then IPv6 other than link-local, then the user's additional
address if set). It is sent only in the answer to a successful `hello` or `pair`, never to a connection that
has not authenticated.

`operations`: the operations this desktop accepts, other than `hello` and `pair`. Show a control only when its
operation is listed: an older desktop does not have `sessions.rename`, `sessions.hibernate`, `sessions.close`,
`attachments.put`, `conversation.answer` or `openspec.watch`, and answers them `UNKNOWN_OPERATION`. Protocol version 1 grows only by new fields,
operations, event values and error codes (section 9, obligation 7).

### `pair`

`p`: `{ "protocol": [1], "code": "<c from the link>", "deviceName": "…", "deviceModel": "…" }`
→ `r`: `{ "protocol": 1, "server": { … }, "addresses": [string], "operations": [string], "deviceId": "…", "deviceSecret": "…" }`

The credential is given **once**; spekterm keeps only its SHA-256. Store it in the platform's protected
storage. The pairing connection is authenticated as the new device and may continue with operations. Names
and models are clipped to 64 characters and control characters removed.

## 5. Operations

A paired device has the user's power over agents: it can type into any session, hibernate or close one, and answer
an agent's offer to close its own session.
Everything else — files outside OpenSpec, settings, Slack, credentials, resizing a terminal — is not an
operation. The one file a device writes is an attachment, and only into the desktop's own attachment store,
under a name the desktop chooses (`attachments.put`). No operation takes a path or a directory.

### `sessions.list`

`p`: `{}` → `r`: `{ "window": bool, "folders": [Folder], "sessions": [Session] }`

- `Folder`: `{ id, name, branch: string|null, pinned: bool, hasOpenSpec: bool }`, in rail order.
- `Session`: `{ id, folderId: string|null (null = the global item), target: "claude"|"shell", label, running: bool, wait?, lifecycle?, lineage?, closeOffered? }`
  - `wait` (agent sessions): `"ready"` (waiting for input), `"busy"`, `"awaiting-choice"` (a permission prompt), `"unknown"`.
  - `lifecycle` (handoff-created sessions): `"working"`, `"waiting"`, `"done"`, `"idle"`.
  - `lineage`: `{ parentId, title? }`.
  - `closeOffered: true` (a running agent session only; absent otherwise): the session's agent asked to close its own
    session and the user has not answered. The desktop shows "The agent asked to close this session" with Close and
    Keep, and nothing closes on its own. It goes when the user keeps the session (on the desktop or with
    `sessions.keep`), types into it, or the session's process ends for any reason; a woken session never brings an
    old offer back. Answer it with `sessions.close` or `sessions.keep` (section 9, obligation 13).
- With no window, `window` is `false` and `sessions` is empty.
- Changes arrive as `sessions.changed` events carrying the whole list.

### `sessions.create`

`p`: `{ "folderId": "…" | null, "target": "claude"|"shell" }` → `r`: `{ "sessionId" }`

Carried out by the desktop's interface, as if the user had done it there (persisted, restored after a
restart). **It never takes the desktop**: no selection change, no change of what is displayed, no keyboard
focus. Errors: `NO_WINDOW`, `CREATE_FAILED`, `TIMEOUT`.

### `sessions.wake`

`p`: `{ "sessionId" }` → `r`: `{ "sessionId" }`. Starts a dormant session, quietly as above. A running session
answers at once. Errors: `NOT_FOUND`, `NO_WINDOW`, `CREATE_FAILED`, `TIMEOUT`.

### `sessions.rename`

`p`: `{ "sessionId", "name" }` → `r`: `{ "sessionId" }`. The desktop's own rename, quietly (no selection, focus
or display change). Control characters (newlines included) are removed and the name is clipped to 200
characters; the desktop then trims it. **An empty name hands naming back**: the label follows the agent's title
again (or a handoff's title, or the local label). A dormant session can be renamed. The new label arrives in
`sessions.changed`. Errors: `NOT_FOUND`, `NO_WINDOW`, `TIMEOUT`, `BAD_PARAMS` (no `name`).

### `sessions.hibernate`

`p`: `{ "sessionId", "force"? }` → `r`: `{ "sessionId" }`. The desktop's own hibernation, quietly (no selection,
focus or display change): the process ends, and the session stays where it is, dormant, persisted, and
wakeable with `sessions.wake`. A shell's screen is kept; attachments are kept. A dormant session answers at
once, with no effect. The session list then shows `running: false`, and watches of the session end
(`conversation.ended` and `terminal.ended`, reason `"hibernated"`).

**A session that is not idle is refused** with `SESSION_BUSY` unless `force` is `true` (absent, `null` and
`false` do not force). `detail.reason`:

| `reason` | Session | Meaning |
|---|---|---|
| `working` | agent | The agent is working. |
| `choice` | agent | The agent waits on a choice (a permission prompt, a question, a plan approval). |
| `unsent` | agent | A filled-in prompt has not been confirmed sent yet. |
| `job` | shell | A command is running (or the shell replaced itself with another program). |
| `unknown` | either | The desktop cannot tell (agent events off; on macOS, every shell). |

The desktop's own hibernate and close never ask; a device must (section 9, obligation 12). Errors:
`SESSION_BUSY`, `NOT_FOUND`, `NO_WINDOW`, `TIMEOUT`, `CREATE_FAILED`, `BAD_PARAMS`.

### `sessions.close`

`p`: `{ "sessionId", "force"? }` → `r`: `{ "sessionId" }`. The desktop's own close, quietly: the session leaves
the workspace and is not restored, its attachments are removed, and a handoff-created session ends as one
closed on the desktop does (it leaves `handoffs.list`; its relatives see it closed). If the desktop displays it,
it displays the item's next session instead, without taking keyboard focus. A dormant session is closed with
no further check. The session then leaves the session list, and watches of it end (reason `"closed"`).

A session that is not idle is refused with `SESSION_BUSY`, as for `sessions.hibernate`, unless `force` is
`true`. That holds for a session marked `closeOffered` too: it has just finished its turn, so it is usually idle,
but not always. Errors: `SESSION_BUSY`, `NOT_FOUND`, `NO_WINDOW`, `TIMEOUT`, `CREATE_FAILED`, `BAD_PARAMS`.

### `sessions.keep`

`p`: `{ "sessionId" }` → `r`: `{ "sessionId" }`. Keeps a session whose agent offered to close it (`closeOffered`):
the offer is withdrawn, the desktop stops showing it, and the session keeps running, as the desktop's Keep does.
Quietly, as every session operation. A session with no offer answers with no effect. The mark leaves the list in
`sessions.changed`. Errors: `NOT_FOUND`, `NO_WINDOW`, `TIMEOUT`, `CREATE_FAILED`, `BAD_PARAMS` (no `sessionId`).

### `conversation.watch`

`p`: `{ "sessionId", "afterUuid"? }` → `r`: `{ "sessionId" }`, then events:

- `conversation.update`: `{ sessionId, status: "attaching"|"ok"|"unavailable", events: [Entry], truncated: bool, reset: bool }`
  - `reset: true` — replace what you hold with `events`. `false` — append.
  - `truncated: true` — older entries were not loaded.
- `conversation.wait`: `{ sessionId, state, pending: { tool, arg }|null, prompt: Prompt|null }` — whether a reply
  can be sent, and the open prompt. Sent when any of it changes, also with no agent event (the prompt was
  answered, or typed into on the desktop).

`Prompt` is the first open permission request (queued prompts are shown in the order they were raised), or
`null` when none is open:

- `{ id, kind: "permission", tool, arg, canAllow, answerable, open }` — `canAllow` is true only for `Bash`,
  `Edit`, `Write`, `Read` and `WebFetch`, whose prompt puts a one-time "Yes" first;
- `{ id, kind: "question", questions: [{ question, header, multiSelect, options: [{ label, description }] }], answerable, open }`
  — the agent's question tool;
- `{ id, kind: "plan", plan: string|null, choices, answerable, open }` — the plan approval. `plan` is the plan
  text when the agent wrote one; `choices` is `["approve", "approve-auto", "deny"]` with a plan,
  `["approve", "deny"]` without.

`id` is the desktop's identity for the request. `open` is the number of open requests. `answerable` is true only
while exactly one request is open, nothing was typed into the session since it was raised, its agent reported
no other tool activity since, and no answer was written to it yet; for a question, also when it has one to four
questions of one to eight options. Show the question, option and plan text as plain text: it is the agent's
own, and may contain paths.
- `conversation.ended`: `{ sessionId, reason }` — the watch is over. `"window"`: the desktop's interface
  reloaded or closed. `"exited"`: the agent's process ended on its own. `"hibernated"` / `"closed"`: the
  session was hibernated or closed, by a device or at the desktop. Branch on `reason`; after `"hibernated"`,
  `sessions.wake` and watch again with `afterUuid`.

`Entry` is one of: `{ kind: "user", uuid, at, text, meta }`, `{ kind: "text", uuid, at, text }`,
`{ kind: "thinking", uuid, at, text }`, `{ kind: "tool", uuid, at, id, name, arg }`,
`{ kind: "result", uuid, at, id, text, error }`.

A `user` entry is something the agent received as a user message. `meta: false` means the user typed it,
including a message typed while the agent was working, which appears where the agent took it in. `meta: true`
means the agent says the user did not type it: a skill's text, a message from another session, a
background-task notice, a compacted conversation's summary. Show those as context, not as the user's words.
Entries arrive in the order the agent recorded them; `at` is not an ordering key.

One connection watches at most one conversation; watching another ends the previous one. Errors:
`NOT_FOUND` (no such session, or not running), `NO_CONVERSATION` (a shell).

### `conversation.unwatch`

`p`: `{}` → `r`: `{}`.

### `conversation.send`

`p`: `{ "sessionId", "text", "attachments"?: [attachmentId] }` → `r`: `{ "outcome": "submitted" | "filled-not-submitted", "text" }`

- Only for the watched conversation (`NOT_WATCHING`), only while `wait` is `ready` or `busy` (`WAIT_STATE`
  otherwise — answer a prompt with `conversation.answer`).
- `attachments`: up to 10 complete, unsent attachments of that session (`BAD_PARAMS` beyond; `NOT_FOUND` for
  one that is not complete, not that session's, or already sent — nothing is written). `text` may then be
  empty. The desktop appends one sentence naming each file's full path, inside the sentence, in backticks:
  ``(The user attached 1 file from their phone; read it with the Read tool: `/…/sent/…-photo.jpg`)``.
  The agent reads them with its Read tool, without a permission prompt.
- `r.text` is exactly what was written before the submit key. Match the conversation entry against it to clear
  your "not confirmed" state. An attachment counts as sent once the text is written, also for
  `filled-not-submitted`.
- Control characters other than newline are removed.
- The text is written, then the submit key **500 ms later**. Just before the submit key the wait state is read
  again: if the agent began waiting on a choice meanwhile, the key is withheld and the outcome is
  `filled-not-submitted` — the text sits in the agent's input, unsent, and is **never** submitted later. Tell
  the user.
- Replies to one session are written one at a time.

### `conversation.answer`

`p`: `{ "sessionId", "promptId", "decision", "selections"? }` → `r`: `{ "outcome": "sent" | "partial" | "confirmed" | "mismatch" }`

Answers the watched conversation's open prompt (`NOT_WATCHING` otherwise). `promptId` is `Prompt.id`.

| `decision` | For | Keys the desktop writes |
|---|---|---|
| `allow` | a permission prompt with `canAllow` | `1` (the one-time "Yes") |
| `deny` | any prompt | Esc: the prompt is dismissed (a question declined; a plan approval leaves the agent in plan mode) |
| `answer` | a question with `answerable`, with `selections` | per question: a single choice → its digit; several choices → each digit, then Tab; then `1` on the review, unless it is one single-choice question |
| `approve` | a plan approval | `2` ("Yes, manually approve edits"), or `1` ("Yes, and switch to default") without a plan |
| `approve-auto` | a plan approval with a plan | `1` ("Yes, and use auto mode") |

- `selections`: one entry per question, as option indexes from 0: exactly one for a single-choice question,
  one or more distinct ones for a several-choice question. Anything else is `BAD_PARAMS`; a decision that does
  not fit the prompt is `NOT_ANSWERABLE`.
- **No answer contains the submit key**, and the keys are written one at a time, 250 ms apart. Before every key
  the desktop reads the agent's events again and writes the key only while the prompt is still answerable (see
  `Prompt.answerable`). If the first key is withheld, the answer is refused `PROMPT_GONE`; if a later one is,
  the rest are withheld and the outcome is `partial`.
- **Outcomes**: `sent` — every key was written, and that is all it says. `confirmed` / `mismatch` — for a
  question, the answers the agent recorded, and for a plan approval, the permission mode it entered next, match
  or differ from the choice (checked for up to 3 seconds; otherwise `sent`). `partial` — see above.
- After a `deny`, the request is closed; for the agent's own prompt the wait state becomes `ready`, so a reply
  can follow.
- **A prompt dismissed without a key** (for example by the agent itself) can still look open. An answer then
  types into the agent's input box: a digit stays there unsent, and Esc interrupts a working agent. Nothing is
  ever submitted.
- Answers and replies to one session are written one at a time.

### `attachments.put`

`p`: `{ "sessionId", "name", "size", "offset", "data", "attachmentId"? }` → `r`: `{ "attachmentId", "received", "complete" }`

Uploads a file for an agent session in chunks (`NOT_FOUND`, `NO_CONVERSATION` for a shell). Watching the
session is not required.

- `data` is base64, at most 512 KiB once decoded per chunk. The first chunk has `offset: 0` and no
  `attachmentId`, and fixes `size`; later chunks name the `attachmentId` and start exactly at `received`
  (`BAD_PARAMS` with `detail.received` otherwise).
- When `received` reaches `size`, the content is checked: a PNG, JPEG, GIF, WebP or PDF signature, or UTF-8 text
  with no NUL. Anything else is `UNSUPPORTED_TYPE`, and the upload is removed. HEIC is not accepted: convert it
  first.
- `name` is only a hint: the desktop keeps letters, digits, `.`, `-` and `_` (80 at most), prefixes an id, and
  sets the extension the content implies.
- Limits: 10 MiB per file (`TOO_LARGE`), 200 MiB stored per session (`TOO_LARGE`), 10 attachments not sent yet
  per session, uploads in progress included (`TOO_MANY`).
- Unsent attachments are removed after 24 hours, and an upload in progress does not survive the desktop
  quitting. Sent ones are kept until the session is closed, or 30 days.

### `terminal.watch`

`p`: `{ "sessionId", "from"?: { "gen", "offset" } }` →
`r`: `{ sessionId, gen, offset, data, cols, rows, complete: bool, replacing: bool }`, then events:

- `terminal.data`: `{ sessionId, gen, offset, data }` — `offset` is the position just past `data`.
- `terminal.size`: `{ sessionId, cols, rows }` — the desktop resized the terminal.
- `terminal.ended`: `{ sessionId, reason: "exited"|"hibernated"|"closed"|"restarted"|"off"|"window" }` — watch
  again to continue (after `"restarted"` a new process serves the session). `"exited"` is a process that ended
  on its own; `"hibernated"` and `"closed"` say the session was hibernated or closed, whoever did it.

`data` is raw terminal output (escape sequences included) as a string. Render it in a terminal emulator **at
`cols` × `rows`** — the desktop's size; a client never resizes. One connection watches at most one terminal.

### `terminal.unwatch`

`p`: `{}` → `r`: `{}`.

### `terminal.input`

`p`: `{ "sessionId", "data" }` → `r`: `{}`. Written to the session's terminal as typed (`"\r"` is Enter). At most
64 KiB per call. Error: `NOT_FOUND` (no running process). Prefer `conversation.answer` for a prompt: typed
input makes the open prompt unanswerable from a device, and text with Enter typed into a prompt approves it.

### `inbox.list`

`p`: `{}` → `r`: `{ "items": [Item] }`, the desktop's inbox: `{ id, adapter, state, originKind, originId,
originLabel, title, actor, body, bodyLength, receivedAt, occurredAt, sessionId?, folderId?, unresolved? }`.
`folderId` is the folder routing suggests; `unresolved` says why there is none. Changes arrive as
`inbox.changed` events with the whole list.

### `inbox.accept`

`p`: `{ "adapter", "id", "folderId" }` → `r`: `{ "sessionId" }`

The desktop's accept: it reuses the session an earlier accept of the item left in that folder, or creates one
there (quietly), and fills in the item's first prompt — unsent for a third-party body. Errors:
`FOLDER_REQUIRED`, `NOT_FOUND`, `CREATE_FAILED`, `NO_WINDOW`, `TIMEOUT`. A failure leaves the item pending.

### `inbox.ignore`

`p`: `{ "adapter", "id" }` → `r`: `{}`. The desktop's ignore.

### `handoffs.list`

`p`: `{}` → `r`: `[{ sessionId, state, summary?, reportedAt? }]` for every handoff-created session. Changes
arrive as `handoffs.changed` events with the whole list.

### `handoffs.brief`

`p`: `{ "sessionId" }` → `r`: `{ body?, report?: { summary, reportedAt } }`. Error: `NOT_FOUND`.

### OpenSpec

Five read-only operations browse a folder's OpenSpec as the desktop's side panel shows it. No operation changes
OpenSpec content. A folder without OpenSpec answers empty lists.

**Which desktop you are talking to.** A desktop that lists `openspec.watch` in `operations` sends the results
exactly as described here: these fields and no others, artifacts in display order, answers within 1 MiB, and
`openspec.changed` events. An older desktop that has the four reads but not `openspec.watch` sends the same fields
under the same names plus others of its own (ignore them, obligation 7), artifacts in the order it found them, and
no events; the same parser reads both. Offer live refresh only when `openspec.watch` is listed, and a manual
refresh always.

**Content is the repository's text**, untrusted — see obligation 14.

**Shapes.**

- `Change`: `{ slug, status: "active"|"archived", description, createdDate: string|null, archivedDate: string|null,
  timestamp: string|null, hasProposal, hasDesign, hasSpecs, hasTasks: bool, taskStats: { total, completed }|null,
  worktree?: Worktree }`.
  - `description` is the slug made readable (`add-thing` → `add thing`), not a sentence from the change.
  - `createdDate` is the `created:` value of the change's own `.openspec.yaml`, or `null`: the start date, where
    there is one.
  - `archivedDate` is the date prefix of an archived change's slug.
  - `timestamp` (ISO 8601 with offset) is the time of the **first** commit that touched the change's directory.
    For an archived change that is **the commit that archived it**, not when the change began. It is `null` for a
    change with no commit yet, and for one first committed after the desktop first read that working tree; it does
    not change while the desktop runs. Do not show it as "last modified" or "created".
- `Worktree`: `{ branch: string|null, isMain: bool }` — the working tree of the folder's repository a change (or a
  spec) is read from. Present only when the repository has more than one working tree. `branch` is `null` on a
  detached HEAD. The desktop labels only changes that are not in the main working tree.
- `Artifact`: `{ id, title, kind, … }` by `kind`:
  - `"markdown"`: `content`, the file's text (markdown);
  - `"data"`: `content`, the file's text (YAML or JSON); `title` is the file name;
  - `"tasks"`: `tasks: { total, completed, sections: [{ title, tasks: [{ text, completed: bool }] }] }`. A task's
    `text` is markdown and may span several lines (continuation lines are folded in). The raw file is not sent;
  - `"specs"`: `specs: [{ topic, content }]`, one delta spec per capability the change touches.
  Accept a `kind` you do not know (obligation 7): show its `title`.
- **Left out** — when an answer would exceed 1 MiB, the desktop leaves out content, the largest piece first, until it
  fits: an artifact's `content` or `tasks`, a delta's `content`, or a spec's `content` is then absent and
  `omitted: { bytes }` stands in its place (`bytes`: its size as serialized JSON). Everything else is as it would
  have been. Show such a piece as too large for the phone, with its size. If the answer cannot fit even then, it is
  `TOO_LARGE`.

### `openspec.changes`

`p`: `{ "folderId" }` → `r`: `{ "active": [Change], "archived": [Change] }` — the changes the side panel lists,
including those in other working trees of the folder's repository, each slug once. Each list is sorted by one key,
`timestamp` or else the slug's date, newest first, compared as text; changes with neither (an active change not yet
committed) come last. A list over 1 MiB is `TOO_LARGE`. Errors: `NOT_FOUND` (no such folder).

### `openspec.change`

`p`: `{ "folderId", "slug" }` → `r`: `{ slug, status, createdDate, archivedDate, worktree?, artifacts: [Artifact] }`,
artifacts in the order the side panel shows them. A change is addressed by folder and slug alone, wherever it lives.
An unknown folder, or a slug that is not in the folder's scan, is `NOT_FOUND`. A file that cannot be read is
`INTERNAL`.

### `openspec.specs`

`p`: `{ "folderId" }` → `r`: `[{ topic, relatedChangeCount }]`, the folder's main specs, sorted by topic.
`relatedChangeCount` is the length of the spec's `history`. A list over 1 MiB is `TOO_LARGE`. Errors: `NOT_FOUND`
(no such folder).

### `openspec.spec`

`p`: `{ "folderId", "topic" }` → `r`: `{ topic, content, history: [{ slug, status, description, date, timestamp }],
origin?: Worktree }`. `history` lists the changes that touched the spec; each `slug` can be read with
`openspec.change`. `date` is the slug's date prefix, `timestamp` as in `Change`. A spec is always read from the main
working tree; `origin` says so when the repository has more than one (a worktree may hold a newer copy). An unknown
folder or topic is `NOT_FOUND`.

### `openspec.watch`

`p`: `{ "folderId"? }` → `r`: `{}`. Watches one folder's OpenSpec: from then on, when it changes on disk — in any
working tree of its repository, such as an agent writing a `tasks.md` — this connection receives the event
`openspec.changed` with `d`: `{ "folderId" }`. It carries no content: read again what you show.

- One folder per connection. Watching another replaces the watch; `folderId` absent or `null` stops it; any other
  non-string is `BAD_PARAMS`. An unknown folder is `NOT_FOUND`, and the previous watch stays. The watch ends with
  the connection; watch again after reconnecting.
- The answer comes once the desktop has started watching every working tree of the folder. **Watch, then read**: a
  change between a read and a later watch is not announced.
- At most one event per folder per second; every change is followed by one within about a second. Read again on
  every event: a working tree created later is watched from the next read.
- A folder removed from the workspace sends no further event.

### `attention.watch`

`p`: `{ "after"?: { "epoch", "seq" } }` → `r`: `{ "events": [Attention], "complete": bool }`, then
`attention` events, one `Attention` each.

See section 7. Watching again on the same connection replaces the earlier watch.

## 6. List events

These events reach **every** authenticated connection, without subscribing, and always carry the complete
current value, never a difference:

- `sessions.changed`, `inbox.changed` and `handoffs.changed` carry the shape of the matching operation's
  result. On reconnecting, call those operations again.
- `addresses.changed`: `{ "addresses": [string] }`, the same list as in the `hello` answer, sent when it changes
  while you are connected (checked every few seconds). There is no operation for it: on reconnecting, the
  `hello` answer carries the current list.

## 7. Attention events and resuming

An `Attention` is `{ pos: { epoch, seq }, kind, at, sessionId?, intake?: { adapter, id }, folderName?,
title, summary?, tool?, suppressed }`:

| `kind` | When |
|---|---|
| `waiting` | An agent finished its turn and waits for input. |
| `choice` | An agent asks for a choice (a permission prompt); `tool` names the tool. Each prompt raises one. |
| `handoff-done` | A handoff-created session reported completion; `summary` is the report. |
| `intake` | A new inbox item arrived (a handoff's arrival included). |

- `title`, `summary` and `tool` are already **reduced** the way the desktop reduces text for its own
  notifications: URL-shaped text replaced by a placeholder in the desktop's interface language, `<`, `>` and `&`
  removed, clipped to 80 characters. `folderName` is clipped, not reduced. Reduce nothing further.
- `suppressed: true` — the user is looking at that session on the desktop right now. Update state; **do not
  notify**.
- **An agent's offer to close its own session raises no event of its own.** It follows the end of the agent's turn,
  which raises `waiting`; the offer itself arrives in `sessions.changed` (`closeOffered`). One exception: a turn that
  ends in an API error raises no `waiting`, so an offer after it is seen only in the session list.

**The desktop remembers**, while remote access is on, every attention event of the last 24 hours, up to the
200 most recent. A position names the event and the *span* the desktop has held events without interruption;
the span ends when remote access is turned off or reset, or the app quits.

Keep the `pos` of the last event you received and pass it as `after` when you watch again:

- `complete: true` — `events` are exactly what you missed, in order.
- `complete: false` — you may have missed some (the desktop restarted, remote access was off or reset, you
  were away for more than 24 hours or 200 events, or you named no position). `events` are all it holds.

Then new events follow as they occur, none lost or repeated in between. **Notify for live events and for the
events of a complete answer. Summarize the events of an incomplete answer** (a fresh pairing receives up to
200) instead of raising one notification each.

## 8. Liveness

The server pings every 20 seconds (WebSocket ping frames) and closes a connection that missed two. A client
should answer pings (WebSocket libraries do) and reconnect when the connection drops. Until the server notices
a dead connection — at most 60 seconds — events sent to it are lost to the client; resuming the attention
stream recovers them.

**A client is told of events only while it is connected.** To notify in the background, keep the connection
open (on Android, a foreground service), and reconnect with backoff when the network changes.

## 9. Client obligations

1. **Pin the certificate** in both the trust manager and the host name verifier (section 2).
2. **Show an inbox item's full body as plain text before offering to accept it.** That is the human check
   spekterm places before acceptance, and this repository cannot enforce it for a client. Do not render the
   body as markup.
3. **Render the terminal at the stream's `cols` × `rows`.** Never assume a size of your own.
4. **Do not notify for a suppressed attention event**, and summarize an incomplete attention answer.
5. **Reduce nothing further** in attention text: the desktop already did, and doing it twice mangles it.
6. **Store the device credential in protected storage**; forget it on close code 4004.
7. **Ignore what you do not know.** A field you do not recognize, in any frame, an event kind you do not
   recognize, and a value of a known field that you do not recognize (a new `reason`, say), are not errors.
   New fields, events and values are added within a protocol version.
8. **Show a control only when its operation is in `operations`** (section 4).
9. **Match a reply's entry against `conversation.send`'s `r.text`**, not against what was typed: the desktop
   adds the attachment sentence.
10. **Answer prompts with `conversation.answer`, never by typing digits** into the terminal, and show the
    prompt's text as plain text.
11. **Keep the pairing link's addresses and the latest list received** (sections 1, 4 and 6), and try the
   latest first. Do not replace the stored list outright: a laptop moves between networks, so the address it
   has now is not the only one it will have.
12. **Confirm with the user before `sessions.close`, and before any request with `force: true`.** Send
    `sessions.hibernate` and `sessions.close` without `force` first; on `SESSION_BUSY`, show `detail.reason` in
    the confirmation and send again with `force` only if the user agrees. Never force on the first attempt.
13. **Offer Close and Keep for a session marked `closeOffered`**, wherever you show that session: Close as
    `sessions.close`, Keep as `sessions.keep` (shown only when `sessions.keep` is in `operations`). Choosing Close
    there is the confirmation obligation 12 asks for; a `SESSION_BUSY` answer still goes through obligation 12.
14. **Treat OpenSpec text as untrusted** — artifact, delta and spec `content`, task `text` and section `title` are the
    repository's text. Render markdown with raw HTML shown as text, never interpreted. A relative link or image
    reference resolves to nothing (the desktop shows a relative link as text). Open an `http(s)` link only when the
    user taps it, outside the app. Do not load remote images automatically. Show a `data` artifact as plain
    monospace text.
