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
as the phone moves between networks.

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
- Frames are UTF-8 JSON text. A frame over 1 MiB closes the connection. permessage-deflate is offered.

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
| `CREATE_FAILED` | The desktop could not create or wake the session; `message` says why. |
| `TIMEOUT` | The desktop's interface did not answer within 15 seconds. |
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

`p`: `{ "protocol": [1], "deviceId": "…", "deviceSecret": "…" }` → `r`: `{ "protocol": 1, "server": { "name", "version" } }`

### `pair`

`p`: `{ "protocol": [1], "code": "<c from the link>", "deviceName": "…", "deviceModel": "…" }`
→ `r`: `{ "protocol": 1, "server": { … }, "deviceId": "…", "deviceSecret": "…" }`

The credential is given **once**; spekterm keeps only its SHA-256. Store it in the platform's protected
storage. The pairing connection is authenticated as the new device and may continue with operations. Names
and models are clipped to 64 characters and control characters removed.

## 5. Operations

A paired device has the user's power over agents: it can type into any session. Everything else — files
outside OpenSpec, settings, Slack, credentials, closing or hibernating sessions, resizing a terminal — is not
an operation.

### `sessions.list`

`p`: `{}` → `r`: `{ "window": bool, "folders": [Folder], "sessions": [Session] }`

- `Folder`: `{ id, name, branch: string|null, pinned: bool, hasOpenSpec: bool }`, in rail order.
- `Session`: `{ id, folderId: string|null (null = the global item), target: "claude"|"shell", label, running: bool, wait?, lifecycle?, lineage? }`
  - `wait` (agent sessions): `"ready"` (waiting for input), `"busy"`, `"awaiting-choice"` (a permission prompt), `"unknown"`.
  - `lifecycle` (handoff-created sessions): `"working"`, `"waiting"`, `"done"`, `"idle"`.
  - `lineage`: `{ parentId, title? }`.
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

### `conversation.watch`

`p`: `{ "sessionId", "afterUuid"? }` → `r`: `{ "sessionId" }`, then events:

- `conversation.update`: `{ sessionId, status: "attaching"|"ok"|"unavailable", events: [Entry], truncated: bool, reset: bool }`
  - `reset: true` — replace what you hold with `events`. `false` — append.
  - `truncated: true` — older entries were not loaded.
- `conversation.wait`: `{ sessionId, state, pending: { tool, arg }|null }` — whether a reply can be sent.
- `conversation.ended`: `{ sessionId, reason: "window" }` — the desktop's interface reloaded or closed.

`Entry` is one of: `{ kind: "user", uuid, at, text, meta }`, `{ kind: "text", uuid, at, text }`,
`{ kind: "thinking", uuid, at, text }`, `{ kind: "tool", uuid, at, id, name, arg }`,
`{ kind: "result", uuid, at, id, text, error }`.

One connection watches at most one conversation; watching another ends the previous one. Errors:
`NOT_FOUND` (no such session, or not running), `NO_CONVERSATION` (a shell).

### `conversation.unwatch`

`p`: `{}` → `r`: `{}`.

### `conversation.send`

`p`: `{ "sessionId", "text" }` → `r`: `{ "outcome": "submitted" | "filled-not-submitted" }`

- Only for the watched conversation (`NOT_WATCHING`), only while `wait` is `ready` or `busy` (`WAIT_STATE`
  otherwise — answer a permission prompt with `terminal.input`).
- Control characters other than newline are removed.
- The text is written, then the submit key **500 ms later**. Just before the submit key the wait state is read
  again: if the agent began waiting on a choice meanwhile, the key is withheld and the outcome is
  `filled-not-submitted` — the text sits in the agent's input, unsent, and is **never** submitted later. Tell
  the user.
- Replies to one session are written one at a time.

### `terminal.watch`

`p`: `{ "sessionId", "from"?: { "gen", "offset" } }` →
`r`: `{ sessionId, gen, offset, data, cols, rows, complete: bool, replacing: bool }`, then events:

- `terminal.data`: `{ sessionId, gen, offset, data }` — `offset` is the position just past `data`.
- `terminal.size`: `{ sessionId, cols, rows }` — the desktop resized the terminal.
- `terminal.ended`: `{ sessionId, reason: "exited"|"restarted"|"off"|"window" }` — watch again to continue
  (after `"restarted"` a new process serves the session).

`data` is raw terminal output (escape sequences included) as a string. Render it in a terminal emulator **at
`cols` × `rows`** — the desktop's size; a client never resizes. One connection watches at most one terminal.

### `terminal.unwatch`

`p`: `{}` → `r`: `{}`.

### `terminal.input`

`p`: `{ "sessionId", "data" }` → `r`: `{}`. Written to the session's terminal as typed (`"\r"` is Enter). This
is how a permission prompt is answered. At most 64 KiB per call. Error: `NOT_FOUND` (no running process).

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

### `openspec.changes`

`p`: `{ "folderId" }` → `r`: the folder's changes, as the side panel lists them (`{ active, archived, … }`).

### `openspec.change`

`p`: `{ "folderId", "slug" }` → `r`: the change with its artifacts and their content. A slug that is not in
the folder's scan is `NOT_FOUND`.

### `openspec.specs`

`p`: `{ "folderId" }` → `r`: the folder's specs.

### `openspec.spec`

`p`: `{ "folderId", "topic" }` → `r`: the spec with its content. Read-only: no operation changes OpenSpec
content.

### `attention.watch`

`p`: `{ "after"?: { "epoch", "seq" } }` → `r`: `{ "events": [Attention], "complete": bool }`, then
`attention` events, one `Attention` each.

See section 7. Watching again on the same connection replaces the earlier watch.

## 6. List events

`sessions.changed`, `inbox.changed` and `handoffs.changed` reach **every** authenticated connection, without
subscribing, each carrying the complete list (the shape of the matching operation's result). On reconnecting,
call the list operations again.

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
