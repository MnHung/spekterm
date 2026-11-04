## Context

See proposal.md for why. This change builds on `teammate-handoff` (archived as
`openspec/changes/archive/2026-11-04-teammate-handoff/`, code in cb1f2c6; its design D3, D5 and D9 are the base,
re-checked against the archived form on 2026-11-04 with no difference that affects this design) and on spekterm-server 0.3.1's protocol v1 draft (`docs/protocol.md`: §3 error and
close codes, §5 `handoff.update` / `handoff.sync`, §10 `handoff.status` and StatusRecord, §12 statuses and the client
rules) and its `handoff-return` design (D1 report state machine, D3–D6 change feed, D9 titles, D10 the sender's
agent, D11 notifications, D12 removals). **Three clarifications this design relies on were made at its
request and are in spekterm-server commit 3807d44 (0.3.1)**: receiving rule 4's wording ("once a session … has actually
started", "`taken` is optional"), sending rules 2–3 under a reset (records replace whatever their `seq`, the cursor
is set, not raised), and `seq` in `handoff.send`'s answer (store the sent handoff under it; never use it as the sync
cursor).

What exists on the spekterm side:

- **Sending** (`teammate-outbox.ts`): `<userData>/team-outgoing.json`, one serial queue, synchronous whole-file
  writes (file, then memory), items stamped with the membership (`server`, `memberId`). `#apply` (synchronous)
  treats any `ok` as sent, records `handoffId`, writes the agent's `sent` receipt and **removes the item** (unless the
  recipient has no device). It never reads `r.handoff.status`. After removal nothing local remembers the title.
- **Receiving** (`teammate-inbox.ts`): `<userData>/team-incoming.json` with `stored → acked → shown | gone`; a
  `shown` entry keeps only id, state and membership stamp, and is pruned a day after `expiresAt`. An entry reaches
  `shown` by an answered acknowledgement, but also without one: `HANDOFF_UNKNOWN`, a server without
  `handoff.received`, and the credential-discard sweep (`possiblyElsewhere`). The inbox item's id is `teammate:` + the
  server id with `_` mapped to `.` (`teammateIntakeId`, reversible).
- **Accepting** (`ipc/intake.ts`): `accept` → the renderer creates the session → `attach` writes the context file and
  schedules the prefill; `onFilled` when the agent first becomes ready and the prompt is written; then
  `watchSubmission`'s `onSubmitted` when the agent starts working (the user sent the prompt), which settles the item;
  `onTimeout` puts the record back to `pending` (a later accept reuses that session). A phone's accept goes through the
  same `attach`.
- **Spawn tickets** (`handoff-ticket.ts`): a single-use ticket issued by the main process at accept, consumed at
  spawn (`lineageFromTicket`, called from `ipc/terminal.ts`), resolved by the resolver `index.ts` installs with
  `configureTicketLineage`; the result is put on the provisional session record (`session-create.ts`,
  `addProvisional`) **before the process spawns**. `ticketFor` issues only for records with `verified.source`;
  `TicketResolution.lineage` is required.
- **Completion reports** (`handoff-completion.ts`, `handoff-service.ts#deliverReport`): `parseReport` normalizes,
  rejects empty and over `MAX_REPORT_LENGTH` (4,000); `acceptReport` answers `not-handoff` for a session without
  lineage; an adopted report calls `onReported`, which notifies and opens the session's handoff sheet.
- **The introduction** (`handoff-intro.ts`): `reportable` adds `reportLines()`; it is derived as `lineage !==
  undefined` at spawn (`ipc/terminal.ts`) and in the two `reportableOf` lambdas of `index.ts`, and passed through
  `handoff-injection.ts`. The budget test's longest variant (a reportable session on a team) measures 8,272 of 8,500.
- **Relations** (`handoff-relations.ts`): one trigger, `refreshRelations(world)`; the world is built by
  `currentRelationsWorld` (`ipc/terminal.ts`).
- **The connection** (`team-service.ts`, `team-outcome.ts`): `connected` is entered after every successful `hello`
  and `join`, after the operations were adopted; `request` answers an operation the server did not list with a local
  `UNKNOWN_OPERATION`; a 1011 close falls into "any other close ⇒ backoff and reconnect". `team.json` holds
  `membership.device.id`.

## Goals / Non-Goals

**Goals:**

- Every device of the sender shows the current status of every handoff the member sent, across disconnects,
  restarts, lost answers and a server restored from a backup; the sending device is told once when one ends.
- The recipient's spekterm reports `taken`, `declined` and `done` exactly as protocol §12's receiving rules require,
  and the user sees when reports for a handoff were not delivered.
- The sending agent learns the status; no teammate-written text enters any agent's context on spekterm's own
  initiative.
- With a server that does not offer the way back (0.2.x), nothing pretends it exists.

**Non-Goals:**

- Declining a handoff that was already taken (the server allows `taken → declined`; spekterm offers Decline only on
  the pending inbox item). A later change can add it to a linked session.
- Decline or the Sent list on a paired phone (no new remote operation). A phone's Ignore stays an ignore.
- The rail's lifecycle states (working / waiting / done) for a session opened from a teammate's handoff: it has no
  parent on this machine to show them to.
- Removing records from the Sent list by hand; editing or resending a sent handoff; presence (M3).
- Telling the receiving agent anything the sender does later.

## Decisions

### D1. Two new stores

Both follow `team-outgoing.json`'s rules: versioned, written whole and **synchronously** (file, then memory), a
damaged file set aside and read as empty with the tab saying so. **Every mutation is a synchronous function over
the current memory**; only the network loops (sync paging, the report sender) are serialized by a queue, and they
apply each answer through those synchronous mutations. So a mutation called from another store's synchronous code
(D3) completes before that code continues.

```
<userData>/team-sent.json
{ version: 1,
  cursors: [{ membership: { server, memberId }, lastSeq: number, resetInProgress?: true }],
  records: [{ membership, id, clientId, seq,           // seq from the send's answer or the latest record
              to: { id?, handle, displayName, removed }, sentFrom, status,
              sentAt, expiresAt, changedAt?, deliveredAt?, reports?, text?: string,
              title?: string, sourceSessionId?: string, // only for handoffs this device sent
              unknownToServer?: true }] }

<userData>/team-return.json
{ version: 1,
  entries: [{ stamp: { server, memberId, deviceId }, handoffId, sessionId?, title, senderName,
              queue: [{ status: 'taken' | 'declined' | 'done', text?: string, attempted?: true, reacked?: true }],
              last?: { status, text? },               // the last report the server answered
              final?: true,                           // declined was answered: nothing more is sent
              stopped?: { code, unsent: number },
              retryAt?, retries?, touchedAt }] }
```

**Alternative rejected: extending `team-outgoing.json` and `team-incoming.json`.** A sent item is removed from the
outgoing store on purpose (its tab lists what needs the user), and an incoming entry is stripped to its id once shown
(the inbox owns the content); the Sent list and the report queue have other lifetimes and other readers.

### D2. Synchronizing the Sent list (sending rules 1–3)

On every entry into `connected`, when `operations()` lists `handoff.sync`: page `handoff.sync { after }` with
`after` = the current membership's `lastSeq`, or 0 when `resetInProgress`, until `more: false`. Without
`handoff.sync` in `operations()` nothing is requested and the Sent tab says the server does not offer it.

- **One write per page**: the page's records and the new cursor in the same synchronous whole-file write — a record
  is durable no later than its sequence number (rule 2). An empty page still writes the cursor.
- **Per-id rule, outside a reset**: a record whose `seq` is not greater than the stored one for that `id` is
  ignored (a page and an event can carry the same record); `lastSeq` becomes the greater of itself and the page's last
  `seq`.
- **During a reset** (from the answer with `reset: true`, or every page of a sync started from 0 because
  `resetInProgress` was set): the server's counter went back (restored from an older backup), so stored sequence
  numbers are not comparable with the server's. Each record **replaces** the stored one with the same id whatever its
  `seq`, and the cursor is **set** to the page's last `seq` (not raised). `resetInProgress` is written before the
  first reset page's records; the ids received since the reset began are collected in memory; at `more: false` every
  stored record of this membership not received is marked `unknownToServer` and `resetInProgress` is cleared. If
  paging is interrupted, the flag stays and the next sync starts from 0 and is a reset by the flag, though that answer
  says `reset: false`. A record received later for an id marked `unknownToServer` clears the mark. This is
  sending rules 2 and 3 as protocol.md states them since 3807d44 (added at this change's request).
- **Events**: `handoff.status` arrives only after a `more: false` answer; each is applied with the per-id rule and
  raises `lastSeq`.
- **Errors**: an error answer stops this round; `INTERNAL` retries with the outbox's backoff (5 s doubling, 5 min
  cap); a timeout ends the connection (the connection's rule), and the next `connected` syncs again. A **1011** close
  reconnects with backoff and the next `connected` syncs from the stored cursor; `team-outcome.ts` names 1011
  explicitly (as every close code the protocol names), with the reason `SERVER_ERROR`, keeping its retry.
- **Cursors per membership**: the feed is per member, so leaving and rejoining the same member resumes from that
  member's cursor and keeps the titles; another team or member starts at 0. Records of another membership are not
  shown and are pruned by D4's retention.

### D3. Linking this device's own sends (rule 4)

`TeammateOutbox.#apply` on `ok` calls `sent.recordSend({ membership, clientId, handoffId, to, recipientName,
title, sourceSessionId, status: r.handoff.status, sentAt, expiresAt, sentFrom: membership.device.id })` — a
synchronous write (D1) — **before** it writes the outgoing store without the item. The other order loses the title
for good on a crash in between.

- **The answer's `seq`**: the send is stored under `r.handoff.seq` (protocol §5): a record or event with the same or
  a lower `seq` adds nothing. It is never written as the sync cursor (other handoffs may have changed in between).
- **Merge**: by `id`, else by `clientId` within the membership. A server record replacing the local one keeps the
  local `title` and `sourceSessionId`; `recordSend` arriving after a server record with a higher `seq` (a status event
  can be applied before `#apply` runs, since `#apply` waits in the outbox queue) adds `title` and `sourceSessionId` and
  keeps the record's fields.
- **A resend's answer may already be final** (a lost answer, resent after the handoff was done, declined or expired):
  `recordSend` goes through D5's comparison like a record, so that answer notifies when it is the first time this
  device learns that status.
- A server record with neither match — another device, or this one before joining again — has no title.
- The `handoff.send` answer's `status` is read now (the M1 gap: a resend answered `expired` was reported as `sent`):
  the Sent record shows it; the agent's receipt stays `sent` (the handoff did reach the server).

### D4. The Sent tab

- **Its own list call**: the Sent tab asks for the current membership's records through a new IPC call when it is
  shown and whenever the inbox's "changed" signal fires; the inbox list (which every change broadcasts, and which
  carries up to 4,000-character texts here) does not carry them. Narrowed: no `clientId`, no `sentFrom`, no stamp.
  Newest change first.
- **Row**: title or a fixed "no title — sent from another device or before joining again" label; recipient handle and
  display name, with "no longer on the team" when `to.removed`; status and how long since `changedAt`; sent time; for
  a declined handoff with a reason and a done one, the text through the inbox's plain-text body component
  (third-party text), its length, "report N" when `reports` > 1, and Copy; "no longer on the server" when
  `unknownToServer`.
- **Retention**: a record is pruned 90 days after its last change (the server's period; rule 7 allows longer, and
  nothing needs it). Its text stays as long as the record, also after the server deleted its copy at 30 days.
- **Badge**: unchanged. The Sent list holds no work for the user; the notification is the attention signal.

### D5. Notifications (rule 5)

When a record is applied (page, event, or a send's answer through `recordSend`), its `sentFrom` equals
`membership.device.id`, its status is `done`, `declined` or `expired`, it is **not applied during a reset**, and
**either a stored copy exists whose status or `reports` differs, or there is no stored copy and the record's
`clientId` belongs to an item in the outgoing store** (a send of this device still waiting for its answer), spekterm
pushes a `sent-status` item into `intake-notify.ts`. The coalescing window is the inbox's; a batch made only of Sent items
opens the Sent tab, a mixed batch opens the inbox.

- **Why "a stored copy exists"**: every handoff this device sends gets a local record at its answer (D3), so its later
  changes find one; before the answer, the outgoing item stands for it. A record of this device's own with neither
  appears only after upgrading from a client without the Sent list or after the store was damaged — and notifying
  there would replay old results. No "first sync" state is needed.
- **Not during a reset**: a restored server can hand back an older state (a done with 2 reports where 3 were stored);
  that is a correction, not news.
- **No flood**: a reinstall gives the device a new id, so old records do not match `sentFrom`; a reset re-delivers
  records whose copy is the same. A newer `done` report notifies again (bounded by the server's 10 reports).
- **Text**: fixed copy per status, the local title when there is one, otherwise the recipient's display name; for
  `done` and `declined` with a reason, the beginning of the text. Every non-fixed field goes through
  `reduceForNotification` (`docs/lessons/intake.md` §7). PRD §6.4 asks for "a notification with the summary".
- **Other devices** of the member update their list without notifying.

### D6. The sending agent sees the status (PRD §13.1, server D10)

`RelationsWorld` gains `teammateHandoffs: ReadonlyMap<sessionId, TeammateHandoffView[]>`, built in
`currentRelationsWorld` (`ipc/terminal.ts`) from the current membership's Sent records that carry a
`sourceSessionId`. The sending session's relations file gains:

```
"teammateHandoffs": [{ "to": "sam", "title": "<the sender's own title>", "status": "taken",
                       "changedAt": "<ISO>", "recipientLeft"?: true }]
```

- **No text, no display name**: the report and the reason are the teammate's or their agent's (third-party to this
  agent); a display name is the teammate's own choice. Handle and title are the user's side's.
- **Every status** as the server states it (`pending` and `delivered` as well as the four PRD §13.1 names):
  "delivered for three days" tells the agent the teammate has not started.
- **Where it is explained**: the teammates file's `rules` (the introduction already points to it, `teammate-handoff`
  D8; the field appears only with a membership, when that file exists) gains one sentence. The introduction does not
  grow.
- **When it is written**: `refreshRelations` runs on every Sent store change, through the single trigger.

### D7. A session opened from a teammate's handoff is linked to it, before it spawns

`ticketFor` also issues a ticket for a pending record of adapter `teammate` **that is reportable**: its incoming entry
was answered `{}` (D8), under the current membership **and device**, and the server lists `handoff.update`.
`TicketResolution` becomes `{ lineage?, briefBody?, teammate?: { handoffId } }` (lineage optional; its consumers
check it), the resolver in `index.ts` fills `teammate` from the intake id, and the spawn puts it on the provisional
record as a new **main-owned** session field `teammateHandoff: { handoffId }` (`MainOwnedField`; kept by
`SessionStore.replace()`'s field-by-field whitelist and on load), persisted in `sessions.json` beside `lineage`.

- **Why the ticket**: the introduction is read at `SessionStart`, which runs before `attach`; and `attach`'s session
  id comes from the renderer unchecked (the reason tickets exist, `session-lineage`).
- **Why not lineage**: lineage means a parent session on this machine — rail nesting, relations `parent`, the
  completion lifecycle. `relationsOf` keeps `parent: null` for a linked session.
- **A reused session** (an accept after a prefill timeout) keeps the link it got at spawn.
- **The report entry** in `team-return.json` is created at spawn with `sessionId`, the title and the sender's display
  name (for the trace), and the stamp of D8.
- **An item that is not reportable** is accepted as today, without a link: its session's introduction has no report
  paragraph and a report from it is refused as not from a handoff, which is the truth.

### D8. Reporting back (receiving rules 1–5)

**Who may report.** `TeammateInbox` keeps two more facts on an entry: `answered: true` when `handoff.received` was
answered `{}` (rule 1), `answeredAt`, and the device id it was answered under; `shown` entries with `answered` are
kept 90 days past `answeredAt` instead of a day past `expiresAt`, since a delivered handoff does not expire and may be reported on
for as long as the server keeps it. The report stamp is `{ server, memberId, deviceId }` from that entry. Only entries
whose stamp equals the current membership and device are sent; joining again as the same member gets a new device id
and the server would answer `HANDOFF_DELIVERED_ELSEWHERE`, so the stamp says so first.

| Report | When it is queued |
|---|---|
| `taken` | at `watchSubmission`'s `onSubmitted` for a linked `teammate` record — the agent started working on the handoff, after the user sent the filled prompt (PRD §6.3: "Sam presses Enter … Alex's status turns to taken"). Not at Accept, not at `attach`, not at `onFilled` (the agent becoming ready is automatic; nothing the user decided). A prefill timeout queues nothing. |
| `declined` | when the user declines the inbox item (D9). |
| `done` | when the linked session's agent delivers a completion report that is adopted (D10). |

Reports of one handoff are sent **one at a time, in order**, each after the previous one was answered.

- **Lost answers**: `attempted` is written before the request reaches the socket; an entry whose head is `attempted`
  resends **the same report** before anything later, after a timeout, a lost connection or a restart. The server
  answers a repeat with `{status}` and changes nothing.
- **Collapsing** (only reports never attempted): a newer unattempted `done` replaces an older unattempted one (the
  server keeps only the latest, and each counts toward its 10); an unattempted `taken` is dropped when a `done` or
  `declined` is queued behind it (`taken` is optional, rule 4).
- **Triggers**: at once when connected; otherwise on `connected` and a 30-second tick (as the outbox), skipping a
  future `retryAt`.

| Answer | Entry |
|---|---|
| `{status}` | head removed, `last` = it; `final` after a `declined`; a returned status other than the one sent is kept as the server's |
| `HANDOFF_NOT_DELIVERED` | first time for this report: `handoff.received` sent again; on `{}` the same report is resent; on an error, that error's row. Again for the same report: treated as `INTERNAL` |
| `INTERNAL`, unknown code | `retryAt` = backoff (5 s doubling, 5 min cap), `attempted` kept |
| timeout, connection lost | `attempted` kept; resent on the next `connected` |
| `HANDOFF_FINISHED`, `HANDOFF_EXPIRED`, `HANDOFF_DELIVERED_ELSEWHERE`, `HANDOFF_UNKNOWN`, `TOO_MANY_REPORTS`, `BAD_PARAMS`, `UNKNOWN_OPERATION` | **stopped** with the code and the number of unsent reports; queue emptied |
| `AUTH_FAILED` | nothing recorded; the credential is discarded next (the sweep below) |

- **`UNKNOWN_OPERATION` stops**: it is what `TeamService.request` answers locally when the server does not list
  `handoff.update` (a downgraded server); retrying it would never end.
- **Membership sweep**: at start, on every `membership()` change and on `onCredentialDiscarded`, **every** entry whose
  stamp is not the current membership and device is stopped with `TEAM_UNAVAILABLE`, its queue emptied, whether or
  not reports were queued; a report made later for a stopped entry is refused at once (D10).
- **After `declined` is answered** the entry is `final`: a later report from a session linked to it (an accept that
  timed out, then Decline) is refused at once, not sent to meet `HANDOFF_FINISHED`.
- **Stopped is visible**: an entry that stops with unsent reports leaves one inbox trace and a notification through the
  failure path, with a new `FailureContext.subject: 'teammate-report'` (the precedent is the session commands'
  `'command'`) whose copy says that reports for "<title>" did not reach <sender>, the code's reason as detail; title and
  sender name are third-party text and are reduced before the notification. The trace's label is the title. A stop with
  nothing unsent (a resend of the last report refused) is silent. **Measured in `probe:team`**: the report that hits
  `TOO_MANY_REPORTS` was announced as a completion when it was adopted, a moment before, so the two notifications
  usually share the coalescing window and the user gets the coalesced one, which opens the inbox; the trace there
  names the handoff. The named notification is what a stop alone in its window shows (unit-tested).
- **Pruning**: an entry is removed 90 days after `touchedAt` (its last report, answer or stop), or when its session no
  longer exists and its queue is empty.

### D9. Declining

A pending inbox item of adapter `teammate` offers **Decline…** beside Ignore when it is reportable (D7's test). It
opens a reason field (plain text, optional, a live count against 500) and a Decline button. The main process:

1. reads the reason as `teammateText(reason)` and refuses it over 500 UTF-16 code units — normalization removes
   characters (tabs, C0 controls, zero-width characters), so the renderer's count of the raw text is never below the
   sent length, and the main process's check is the authoritative one;
2. dismisses the item through `dismissIntake` (the same path as Ignore);
3. queues `declined` with the reason (absent when empty), creating the report entry if the item was never accepted.

Ignore sends nothing (PRD §13.1). A record already accepted is not pending and offers no Decline (Non-Goals).

### D10. The linked session's completion report

`acceptReport` answers for a session with `teammateHandoff`:

- the summary is `parseReport`'s, then `toWellFormed()`, then the length and non-white-space checks (protocol §12
  rule 2's order in one place; `toWellFormed` keeps the length);
- the same once-per-file identity as today (the watcher-then-scan double read);
- the entry stopped, `final`, or missing ⇒ `teammate-stopped`, which `#deliverReport` refuses with
  `TEAMMATE_REPORT_STOPPED`;
- otherwise `done` is queued and the receipt is `accepted`.

**The receiving user is notified too**, as for any adopted report (`handoff-completion`): the notification names the
handoff's title and the summary; activating it focuses the linked session (there is no handoff sheet to open: the
brief is written only for a first-party body). The completion lifecycle is not set (Non-Goals), so `onReported` is
called with a flag that skips the sheet.

### D11. The teammate variant of the report paragraph

`IntroInput.reportable` becomes `'lineage' | 'teammate' | undefined`; it is derived at spawn in `ipc/terminal.ts` and in
`index.ts`'s two `reportableOf` lambdas, passed through `handoff-injection.ts`: `'lineage'` with a lineage, `'teammate'`
with a `teammateHandoff` whose report entry is neither stopped nor `final`. A stop or an answered decline calls
`refreshIntros`, so the next `SessionStart` (resume, compaction, clear) no longer promises the teammate a report; the
running agent learns it from the refusal of its next report.
The teammate variant:

- opens with "This session was opened by a teammate's handoff. Each time you finish something it or the user asked of
  you, report it:" — no parent;
- keeps the format line and the limit;
- replaces "put details in a file in this repo" with a pointer the teammate can reach (a pushed branch, a pull request,
  an issue), since they cannot see this machine's files;
- replaces step 2 (relations file, SendMessage) with: each report is sent to that teammate through the team server and
  is the only thing they receive from this session.

`peerLines`' "If this session was opened by a handoff, it has a parent." becomes "… by a handoff from another session
here, …" (it is in the longest variant: the budget is re-measured). **The teammate variant is not longer than the
lineage variant**, so the longest variant stays the lineage one; a unit test compares the two.

### D12. Codes and copy

- `IntakeRejection` gains `TEAMMATE_REPORT_STOPPED` (permanent) and `TEAMMATE_REPORT_NOT_SENT` (the trace's code;
  permanent), in the exhaustive `isPermanentRejection`, `receiptReason` and `intake.rejectReason` in both
  dictionaries; `FailureContext.subject` gains `'teammate-report'` with its notification copy.
- Agent-facing reasons stay in `agent-protocol-copy.ts` (English, not in the dictionary).
- Notification and Sent-tab copy goes in `en.json` / `zh-TW.json`.

### D13. Acceptance

- **Unit tests**: the sync loop (pages until `more: false`; one write per page; per-id rule; a reset page with lower
  seqs replaces and sets the cursor; an interrupted reset finished by the flag; unknown-to-server marked and cleared;
  cursors per membership); `recordSend` before the outgoing write (control: the other order loses the title in a crash
  test), both merge orders; notifications only for `sentFrom` = self with a differing stored copy (controls: drop the
  `sentFrom` test ⇒ red; drop "stored copy exists" ⇒ the upgrade test notifies); relations carry status and no text;
  the link written before spawn and only for reportable items; `taken` at `onSubmitted`, not at `onFilled` or timeout;
  the report queue's order, resend-after-loss, collapsing, every row of the answer table, the sweep, `final`, the
  stop's trace; Decline's text path and limit; the teammate intro variant not longer than the lineage one.
- **`probe:team`**: against the stub server (which records each request when the frame arrives,
  `docs/lessons/team.md` §8): the Sent tab after a sync and after an event; a notification on the sending profile only;
  Decline with a reason reaching the stub; `taken` after the stub agent starts working and `done` after its report; a
  stop leaving a trace; a 1011 followed by a resync; a server without `handoff.update` offers no Decline.
- **A full round trip through a real spekterm-server 0.3.1** is a dogfood task.

## Risks / Trade-offs

- **`taken` waits for the user to send the prompt** → a user who accepts and never sends shows as `delivered`, which
  is true: nothing started. The wait for the send lives in memory (`watchSubmission`): a restart between the fill and
  the send loses `taken` for that handoff, which rule 4 allows (`done` or `declined` may follow `delivered`).
- **Reports can be lost to a stop** (`TOO_MANY_REPORTS`, a revoked device) → a trace and a notification say so, and the
  agent's next report is refused with a reason; the work itself is on the recipient's machine.
- **The Sent list is not on the phone** → the notification and the desktop list are where the user learns of it.
- **A notification carries the beginning of a teammate's report** → reduced like every third-party field; PRD §6.4 asks
  for it.
- **The ticket now carries a teammate link** → the same single-use, main-issued mechanism; a renderer cannot link an
  arbitrary session to a handoff.
- **Restored server, client behind `latest` again** → no reset is signalled and changes in between are missed (server
  design Risks); nothing a client can detect.

## Migration Plan

New files only (`team-sent.json`, `team-return.json`); `team-incoming.json` entries gain optional `answered`,
`answeredAt` and `deviceId` (`teammate-handoff` has not been released, so no user has entries without them; one that
lacks them reads as not reportable); `sessions.json` gains an optional main-owned field that an older spekterm drops on
its next write (the link is lost, so that session's reports are refused as not a handoff — acceptable for a downgrade).
The first sync after upgrading fills the list without titles for earlier handoffs and, by D5, notifies nothing.

## Decided by the user (2026-11-03)

Reviewed and kept as written: `taken` when the user sends the filled prompt (D8); the recipient notified of the
linked session's report, focused on the session (D10); the beginning of a teammate's report in the sender's
notification (D5); Decline only on the pending inbox item, not after the handoff was taken, and not on a phone
(Non-Goals). If the introduction's re-measured length passes its budget (D11), that is brought back to the user, not
paid for by shortening existing text.

## Open Questions

- None. The protocol points raised in review are stated by spekterm-server's protocol document as of 3807d44
  (Context).
