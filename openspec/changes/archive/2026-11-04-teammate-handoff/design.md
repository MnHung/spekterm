## Context

See proposal.md for why. This change builds on `team-membership` (the connection; `request(op, params)` gated by the
server's operations; `onEvent(kind)`; `onState` for entering and leaving `connected`; `onMembers`; `operations()`;
`onCredentialDiscarded`; the kept members list) and on the existing handoff and inbox machinery:

- **The outbox** (`handoff-service.ts` → `deliverFile`): a file is classified by `outboxKindOf` (handoff, report,
  command), parsed (`parseHandoffPayload` reads only `target`, `title`, `body`, `at`, `repeat`, `until`), its target
  resolved against the folders (`resolveTarget`), then delivered to the inbox with a provenance only the receiver can
  compute. Every file read gets a receipt before it is removed (`handoff-receipt.ts`, `IntakeSource.onOutcome`).
  A session's receipts directory is removed only when the session is killed (`clearOutbox` via `endHandoffSession`;
  hibernation leaves it). `liveSessions()` holds only sessions spawned in this run.
- **The inbox** (`intake-service.ts` → `deliver`, `intake-schema.ts` → `parseIntake`): normalization once at
  ingestion, `bodyOf()` as the only accessor, `firstPartyBody` choosing **both** the body limit (20,000 instead of
  4,000) **and** the first prompt. Without a provenance (the shared drop point, adapter `file`), `originKind`,
  `originId` and `actor` are taken from the payload.
- **The introduction** (`handoff-intro.ts`): numbers derived from live constants (guarded by
  `scripts/handoff-intro-source.test.mjs`), a budget test at 8,000 — **the 30-folder variant measures 7,882 today, a
  margin of 118** — and a hard limit of 9,000 that cuts the repo list, never the rules. It is written at spawn
  (`handoff-injection.ts`, two places) and rewritten by `refreshIntros` (`index.ts`).
- **The notification** (`intake-notify.ts`): arrivals in one window coalesce into one notification, which opens the
  inbox.
- **The protocol** (spekterm-server `docs/protocol.md` v1): `handoff.send` with `clientId` (§5), `handoff.incoming`
  (§10), the receiving rules (§11). Server facts used below (read in spekterm-server 0.2.0; 0.2.1 with `protocol-clarifications` is the version this targets): a resend is recognised by
  (sender member, `clientId`) before the rate limit is checked; handoff ids are `h_` + 32 hex today; when a
  connection closes, its leased handoffs are offered to the member's next connection at once.

## Goals / Non-Goals

**Goals:**

- An agent hands work to a teammate; the user sees and confirms exactly what is sent and to whom; the agent learns
  what became of it.
- A teammate's handoff reaches exactly one of the recipient's devices, once, and becomes an inbox item through the
  existing gate.
- The introduction does not grow with the team, and nothing a teammate wrote enters it.

**Non-Goals:**

- The sender's Sent list and statuses (delivered / taken / done), the completion report back, decline — server M2.
- Presence — M3. Push notifications — not in server v1.
- Confirming or seeing outgoing handoffs from a paired phone (PRD: "on the desktop"). An incoming one is an ordinary
  inbox item, which a phone sees and accepts as any other.
- Editing a handoff before sending it, scheduling or repeating one.
- Telling the receiving agent who sent the work outside the fence: the sender's display name is third-party text.

## Decisions

### D1. `to` is its own field, not a form of `target`

`"to": "<handle>"`, refused with `target`, refused with `at` / `repeat` / `until`. **Alternative rejected: a prefix
in `target` (`"@sam"`)**: a folder can be named `@sam`, so the meaning would rest on a format test; the repo's rule is
that "not accepting something" is guaranteed by structure. `resolveTarget` stays untouched.

`parseHandoffPayload` gains `to` and its shape rules (D2's first step). `deliverFile` branches on `to` **before**
`parseScheduledAt` / `resolveTarget` and hands the delivery to `TeammateOutbox.read(...)`, which returns a
`DeliverOutcome` (consume, notify, code) plus an `awaiting` / `duplicate` result for the receipt.

### D2. The order of the checks, and their classification

1. **Shape** (`parseHandoffPayload`): `to` with `target`, `to` with scheduling fields, `to` not a non-empty string —
   `FIELD_TYPE` / `SCHEDULE_INVALID` with the rule, permanent.
2. **Team**: a membership and the feature on — else `TEAM_UNAVAILABLE`, temporary.
3. **Recipient**: trimmed, lowercased, looked up in the kept members; when connected and not found,
   `refreshMembers({ maxWaitMs: 3000 })` (the team service throttles it to once a minute and keeps the list, so the
   teammates file follows) (this runs on the drop point's read path, which handles one file at a time).
   Not found — `TEAMMATE_NOT_FOUND`, permanent (as `TARGET_NOT_FOUND`); the user's own — `TEAMMATE_IS_SELF`,
   permanent. **The member's handle from the list** is recorded, shown and sent: the server lowercases `to` but does
   not trim it.
4. **Text**: `normalizeAuthored`, then `toWellFormed()` (the server refuses lone surrogates; `normalizeAuthored`
   passes them through). Title over 200 or body over `MAX_TEAMMATE_BODY_LENGTH` — `TOO_LONG`, permanent.
   `MAX_TEAMMATE_BODY_LENGTH = min(MAX_FIRST_PARTY_BODY_LENGTH, SERVER_BODY_LIMIT)` with `SERVER_BODY_LIMIT = 20_000`
   from protocol §5: the first-party limit is re-measured on CLI upgrades, and the server's is fixed.
5. **Duplicate** (D4) — `duplicate`, consumed.
6. **Bound**: 20 waiting — `OUTGOING_FULL`, **not consumed** (the `CAPACITY` precedent): the drop point's periodic
   re-read hands it over again once the outgoing store has room, as it does `CAPACITY` with `hasRoom()`.

The new codes join `IntakeRejection`, the exhaustive `isPermanentRejection`, `receiptReason` and the dictionary's
`rejectReason`. A refusal here is a handoff failure: it notifies and leaves a trace.

### D3. The outgoing store and its single queue

`<userData>/team-outgoing.json`:

```
{ version: 1, items: [{ id, clientId, membership: { server, memberId }, source: { sessionId, label },
  receipt: { sessionId, file }, to, recipientName, title, body, readAt,
  state: 'awaiting' | 'confirmed' | 'sent' | 'refused',
  attempted?: true, retryAt?, retries?, refusal?: { code }, noDevice?: true }] }
```

- `clientId`: 22 characters of base64url from 16 random bytes (protocol: 1–64 of `[A-Za-z0-9_-]`).
- **`membership`** is the server address and member id the item was read under. Only items whose stamp equals the
  current membership are offered for sending; on `onCredentialDiscarded`, every item of that stamp is refused as the
  spec says (`TEAM_UNAVAILABLE` for `awaiting` and never-attempted `confirmed`; `SEND_UNCERTAIN`, permanent, for
  `attempted`). Without the stamp, leaving team A and joining team B would let a waiting handoff to A's `sam` go to
  B's `sam`, under A's display name; and a lost send resent under B's `clientId` space could arrive twice. The same
  refusal also runs **as a sweep** at every start and on every `membership()` change, for every item whose stamp is
  not the current membership: an interrupted discard or a set-aside `team.json` never fires `onCredentialDiscarded`,
  and its items would otherwise vanish from the tab (which lists only the current membership's) with their receipts
  stuck at `awaiting-confirmation`. Swept items do not count toward the bound of 20.
- **`attempted`** is written before the request reaches the socket, and cleared by an answer that proves the server
  did not store it (`RATE_LIMITED`, a refusal). While set, Discard is not offered and a restart resends with the same
  `clientId`.
- **One queue**: every mutation — read, Send, Discard, Dismiss, recording `attempted`, applying an answer — runs
  through one serial queue, and each write is synchronous (file, then memory). A Discard queued before "record
  attempted" removes the item, and the send step finds nothing to send; one queued after it finds `attempted` and is
  refused. That is the spec's "Discard sends nothing".
- `sent` items without `noDevice` are removed after their receipt step; `refused` and `noDevice` items stay until
  Dismiss; a discarded item is removed.
- A damaged file is set aside and read as empty, the Outgoing tab saying so and that unconfirmed or unanswered sends
  in it are lost.

### D4. Duplicates

`sha256(sourceSessionId, recipient handle, title, body)` over `awaiting` and `confirmed` items of the current
membership. The watcher-then-scan double read already delivers the same file twice; a second identical file from the
same session is the agent retrying. After the first is sent, the same content again is a new handoff.

### D5. Sending

The queue sends confirmed items of the current membership one at a time, oldest first, **skipping any whose
`retryAt` is in the future**, when: the user presses Send while connected; `onState` enters `connected`; a 30-second
wall-clock tick (no per-item timer: `setTimeout` overflows and sleeps, `docs/lessons/handoff.md` §17).

| Answer | Store | Receipt |
|---|---|---|
| `ok` | `sent` (`noDevice` when `recipient.deviceCount` is 0) | `sent` + handle + server id (+ no-device reason) |
| `RATE_LIMITED` | `retryAt` = `detail.retryAt`, `attempted` cleared | `held` `RATE_LIMITED` + `at` |
| `INTERNAL`, timeout | `retryAt` = backoff (5 s ×2, cap 5 min), `attempted` kept | `held` `RETRYING` |
| connection lost before the answer | `attempted` kept, resent on the next `connected` | `held` `NOT_CONNECTED` |
| `RECIPIENT_UNKNOWN`, `RECIPIENT_IS_SELF`, `BAD_PARAMS`, `HANDOFF_ID_REUSED` | `refused`, `attempted` cleared | `rejected`, permanent |
| not connected when confirmed | `confirmed` | `held` `NOT_CONNECTED` |

`HANDOFF_ID_REUSED` should be unreachable (one `clientId`, one text); it is refused rather than retried under a new
`clientId`, which could store a second handoff.

### D6. Receipts after reading

`handoff-receipt.ts` gains `awaiting-confirmation`, `sent`, `discarded`, server codes on `rejected` (with their own
permanence table, D5 — they are not `IntakeRejection`s), and `held` codes `NOT_CONNECTED`, `RATE_LIMITED`,
`RETRYING`, `OUTGOING_FULL`, each with an English reason in `agent-protocol-copy.ts` (a `TeammateReceiptCode` union,
its own exhaustive switch).

- **Where**: a rewrite goes through a new `rewriteReceipt` that **does not create the directory**: it writes only when
  `receiptsDir(sessionId)` exists. That is the right test of "the session has not ended": a dormant session, or one
  restored and not yet started, keeps its directory, while `liveSessions()` would skip them and leave the agent a
  stale `awaiting-confirmation` when it wakes. An ended session's directory is gone and is not recreated.
- **Whose**: a teammate receipt carries `ref` (the outgoing item's id). A rewrite first reads the file and writes only
  when its `ref` is this item's: an agent that reused the file name after the first was consumed has a different
  delivery's receipt there.
- A receipt step that cannot be written changes nothing about the item: the Outgoing tab is the user's record. That
  includes a receipt file that is gone (trimmed past `MAX_RECEIPTS`, or deleted by the agent): with no `ref` to match,
  it is not written again.

### D7. Outgoing tab, badge, notification — one snapshot

- **Snapshot**: the inbox snapshot (`ipc/intake.ts`'s list) carries the outgoing items of the current membership in a
  narrowed shape (no `clientId`, no membership stamp) and `outgoingWaiting`, computed in the same call as the pending
  items; the outgoing store's changes emit the inbox's existing "changed" signal, so the renderer re-lists. The badge
  is pending + `outgoingWaiting` from that one snapshot, and the tab lists the same items. Send, Discard and Dismiss
  are new inbox IPC handlers.
- **Tab**: `IntakeOverlay` gains `outgoing` beside `schedules`, named by a fixed label (its visible text carries the
  count). Rows: recipient (handle, display name kept at read), source label, title, the inbox's plain-text body
  component with length, Send / Discard; confirmed rows' state (waiting for the connection, sending, retrying,
  rate-limited until a time); refused and no-device rows with reason and Dismiss.
- **Notification**: a new arrival kind in `intake-notify.ts`. A batch made only of outgoing arrivals opens the
  Outgoing tab; a mixed batch opens the inbox (its existing coalesced behavior). Text: fixed copy plus the
  recipient's display name, reduced like any third-party field.

### D8. The introduction points to the teammates file, which holds the rules and the list

**Measured during review** (the 30-folder fixture): a paragraph stating every teammate rule in the introduction cost
595 characters and the receipt status line 324 more — 8,802 in all, past an 8,500 budget. So the introduction carries
only what makes the agent go to the file, and the file carries the rules:

> Teammates: you can also hand work to a person on your team. Use "to": "<handle>" instead of "target"; the user
> confirms it on the desktop before anything is sent. Before writing one, read <teammates file> — it lists the
> teammates and states the rules.

(285 characters with a real path, measured in the second review), plus the receipt status list rewritten: three new
statuses, and `held` restated as "not finished yet; the reason says what happens next" (the current line, "the file
stays and is read again", is false for a confirmed handoff waiting to be sent) — about 150 characters. The teammates file (`<userData>/handoff/teammates.json`, outside the outbox as the
relations file is) is written by `teammates-file.ts`:

```
{ "rules": "<the full teammate rules: to vs target, no at/repeat/until, handle case-insensitive and not your own,
             title ≤ N, body ≤ M, at most K waiting (more are held), the desktop confirmation, the receipt statuses
             awaiting-confirmation → sent | discarded | rejected, held NOT_CONNECTED / RATE_LIMITED / RETRYING /
             OUTGOING_FULL, describe what is needed and why from your side — their agent works in its own checkout>",
  "you": "<handle>", "connected": bool, "fetchedAt": "<ISO>",
  "teammates": [ { "handle": "sam", "name": "Sam Lee" } ] }
```

Numbers come from the constants in effect, guarded like the introduction's. **The spec counts these rules as stated**
because the introduction directs the agent to read them before the only action they constrain; the rule "every
constraint is stated" exists so an agent is never refused by a rule it could not know, and that holds.

- **Trust**: display names are each teammate's choice. In a file the agent reads they are data; in
  `additionalContext` they would sit beside spekterm's own rules.
- **Budget**: about 7,882 + 285 + 150 ≈ 8,320 for the longest variant; the budget becomes 8,500. The hard limit (9,000) and
  the CLI threshold (10,000) are unchanged, so the margin from budget to threshold shrinks from 2,000 to 1,500.
  **Task 3.1 re-measures the threshold with the current CLI first** (`docs/lessons/handoff.md` §16 was measured with
  2.1.303; this machine runs 2.1.317): the binary also carries an 8,000-character / 200-line cut that did not apply
  then. If it applies now, the budget cannot rise, and the teammate paragraph must be paid for by shortening existing
  text — a decision brought back to the user, not made in apply.
- **When**: the paragraph and the file exist only with a membership **and** the feature on (with it off every teammate
  handoff is refused). Every intro write point takes the team input: `handoff-injection.ts`'s two and
  `refreshIntros` in `index.ts`, which also runs when the membership or the feature changes.

**Alternative rejected: shortening existing text to fit under 8,000** — each sentence there has its own deletion test,
and squeezing them is how a constraint stops being stated.

### D9. Receiving: a hidden store in front of the inbox

`TeammateInbox` keeps `<userData>/team-incoming.json`: one entry per server handoff id,
`state: 'stored' | 'acked' | 'shown' | 'gone'`, the event's `from`, the team name at arrival, `title`, `body`,
`sentAt`, `expiresAt`, and the membership stamp. The inbox never sees a `stored` entry: that is the protocol's
"hidden".

```
incoming(e):  unreadable (D10)           → trace once per id; do not store, do not acknowledge
              known id                   → acknowledge again unless one is in flight (rule 2); show nothing
              !intake.hasRoom()          → keep in memory for this connection (rule 7)
              else                       → write 'stored' (file first) → handoff.received
answer {} to a 'stored' entry → 'acked' → deliver into the inbox → 'shown' (content removed)
answer {} to anything else    → nothing
DELIVERED_ELSEWHERE, EXPIRED  → 'gone' (content removed; rule 4)
UNKNOWN                       → deliver → 'shown' (rule 5)
connected                     → acknowledge every 'stored' with none in flight (rule 3)
operations lack received      → deliver every 'stored' (rule 5)
credential discarded          → deliver every 'stored' marked `possiblyElsewhere` (rule 6, as changed upstream); keep 'acked'
start, connected, 30 s tick   → deliver every 'acked' while the inbox has room; store and acknowledge what memory holds
connection ends               → drop memory (the server offers it again)
```

`deliver` results: success or a same-content `DUPLICATE` → `shown`; `CAPACITY` → stays `acked`; a permanent refusal
→ `shown` (its trace in the inbox is the visible outcome; the entry must not loop). `shown` and `gone` entries keep
the id and state only, pruned a day after `expiresAt`; the inbox's own record (kept forever) recognises a later repeat.

**The inbox item is built from the stored entry**, never from a later event: a repeat with a changed display name
would otherwise change the digest and raise a false "identifier taken" warning.

**Rule 6 as changed upstream** (spekterm-server `protocol-clarifications`): a `stored` entry whose acknowledgement
reached the server with its answer lost is, to the server, delivered to this device; deleting it on a revocation
would lose it. So it is shown with a mark — `possiblyElsewhere: true` in provenance, persisted in `verified` like
`handoffBodyLimit`, rendered as a line on the row ("may also have reached your other device"). Shown after the
membership is gone, it is still built from the stored entry (which keeps the team name).

### D10. The inbox item, and the two facts `firstPartyBody` used to carry together

`service.deliver(contents, 'teammate', provenance)`:

- `contents`: `{ id, title, body, actor: from.displayName }`;
- `provenance`: `origin { kind: 'teammate', id: from.handle, label: teamName }`, **no `targetFolderId`** (optional in
  the type; the `...(provenance ? { targetFolderId } : {})` line in `parseIntake` stays as it is, so
  `scripts/intake-control-groups.mjs`'s `handoff-payload-target` still matches), `handoffBodyLimit: true`, no
  `firstPartyBody`, no `autoOpen`.

`parseIntake` takes the limit from `firstPartyBody || handoffBodyLimit` and **persists `handoffBodyLimit` in
`verified`** (an optional field, kept on load only when it is `true`, as `withSafeSchedule` keeps the schedule's
fields only with their types), so the item carries both facts and a control that ties the
prompt to the limit flag (`ipc/intake.ts` reads `verified.firstPartyBody`) is writable.

**Teammate presentation follows the adapter.** The renderer shows the teammate label and sender only for adapter
`teammate`: a file in the shared drop point (adapter `file`) can declare `origin.kind: "teammate"`.

**The intake id** is `teammate:` + the server's id with `_` mapped to `.` — reversible (`.` is not in the server's
set, `_` not in the inbox's), 73 bytes at most, accepted only for 1–64 of `[A-Za-z0-9_-]` not starting with `-`.
Ids are case-sensitive, and so is the mapping (the inbox's id set keeps case and its file stem is hex).

**Unreadable offers** — an id outside that rule, `payload.enc` other than `"none"`, a `from.handle` that breaks the
protocol's handle rule — are not stored or acknowledged, and leave one inbox trace per id (`TEAMMATE_UNREADABLE`,
temporary: a newer spekterm may read it). Not acknowledging keeps the handoff with the server, which offers it to the
member's other device when this connection ends; the trace keeps it from being silent for a member with one device.
spekterm-server's `protocol-clarifications` (0.2.1) states ids as 1–64 of `[A-Za-z0-9_-]`, case-sensitive, not
starting with `-`; the check stays as a defence
against a server that breaks it.

### D11. Acceptance

- **Unit tests**: the payload shapes; each check, its order and classification; the store's queue (Discard before and
  after "attempted"); the membership stamp (leave A, join B); the answer table, including `INTERNAL` not blocking
  later items and `RATE_LIMITED` restoring Discard; receipts per step, `ref`, and no directory recreated; the
  receiving state machine, one case per arrow of D9; the item's fields and the adapter-based label; the
  limit/prompt split with its control; the introduction's paragraph, its absence (no membership, feature off), the
  same length for 2 and 60 members, the 8,500 budget; the teammates file's rules derived from constants.
- **`probe:team`** gains sending and receiving sections against the stub team server (task 6); the cross-process
  assertion is the recorded request's body against the Outgoing tab's `textContent`.
- **Two real spekterms through a real spekterm-server** is a dogfood task. **Coverage gap, stated**: the two cases
  that hinge on the moment between storing an offer and sending its acknowledgement (the connection cut there; the
  device revoked there, which must show the entry marked) cannot be produced by hand against a real server — it is a
  few milliseconds inside the client, and the TLS connection cannot be intercepted. They are carried by
  `probe:team`'s stand-in server (which can withhold an acknowledgement's answer and then cut or revoke) and by the
  unit tests, with the control group `acknowledge-before-storing`. The dogfood runs their nearest real-server
  versions: an offer leased to a connection that cannot answer is offered again at the next connection, and a
  revoked device stops reconnecting.

## Risks / Trade-offs

- **The CLI's latent 8,000 / 200-line cut** → re-measured before the budget rises (D8); if it applies, this change
  stops and the user decides how to pay for the paragraph.
- **The rules live in a file the agent may not read** → the introduction says to read it before writing one; an agent
  that does not is refused with a receipt and a visible failure, and nothing is sent without the user anyway.
- **Display names reach the agent as data** (the teammates file) → normalized, one line each, 64 code points at most
  (server rule).
- **A longer text to read before accepting** (20,000 instead of 4,000) for this one source → decided upstream, stated
  in the modified requirement.
- **The badge counts something that is not an inbox item** → one snapshot; a paired phone's inbox count does not
  include it.
- **An agent can make the user confirm many handoffs** → 20 waiting, the rest held; the server's per-member rate
  limit bounds what is sent.
- **Rule 6 now shows rather than drops** (upstream change) → a handoff may appear on two devices of the same member
  after a revocation; the mark says so.
- **This change depends on spekterm-server's `protocol-clarifications`** (the id rule, rule 6); if it lands
  differently, D9 and D10 change.
- **Upstream items** were sent to spekterm-server's session, which is changing them in `protocol-clarifications`
  (ids, rule 6, and its PRD §10 now saying the introduction points to a teammates file).

## Migration Plan

New files only; the introduction changes only for users on a team with the feature on. An older spekterm ignores
`team-outgoing.json`, `team-incoming.json` and `handoff/teammates.json`, and carries the unknown `handoffBodyLimit` field in
`intake.json` through unread (`withSafeSchedule` spreads the rest of `verified`), which changes nothing it does.

## Open Questions

- None beyond D8's measurement, which decides whether the budget can rise.
