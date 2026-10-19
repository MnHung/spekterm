## Context

See proposal.md for why. The current path, in the order a handoff takes it:

- `IntakeSource` (depth 1 under `<userData>/handoff/outbox/`) reads a file, calls `HandoffService.deliverFile`,
  and removes the file when the outcome says `consume`. Oversize files are refused inside `IntakeSource` before
  `deliverFile` is called. A periodic re-read every 30 s backs up the watcher (`intake-periodic-rescan`).
- `deliverFile` sorts the file by `kind` (handoff, report, command), resolves the target, checks agent events,
  and calls `IntakeService.deliver`, which validates, deduplicates (`(adapter, id)`, id = source session +
  digest of target/title/body), archives, adds a **pending** record and emits **arrival** (OS notification via
  `IntakeNotifier`, `intake` attention via `RemoteAttention`). `deliverFile` then calls `requestAutoAccept`.
- `requestAutoAccept` sends `intake:autoAccept` to every renderer that has listed the inbox (`senders` in
  `ipc/intake.ts`); `IntakeAutoAccept.tsx` creates the session with a main-issued ticket and attaches it, which
  turns the record **accepted**. **If no renderer is listening the message is lost** and the record stays
  pending. A prefill that times out turns the record back to pending with its `sessionId` kept
  (`ipc/intake.ts`), and a later accept reuses that session.
- The session's first prompt points at a context file whose header is system-composed and whose fenced body is
  the agent's text (`intake-context.ts`).

Constraints that shape the approach:

- `IntakeStore` whitelists states on load and drops a record with an unknown one (`intake-store.ts`, the
  `settledAt` comment); a new state would delete scheduled records on a rollback, dedupe keys included. The
  verified fields are not whitelisted one by one (`isContent` checks only the required ones).
- `setTimeout` caps at 2^31−1 ms (≈ 24.8 days, below the 30-day bound) and fires immediately past it; on Linux
  its clock is not expected to advance during suspend (not measured; the design does not depend on it).
- The renderer's restore **merges** sessions into its list (`sessions.tsx`), so a session created before the
  restore is not lost. The reason to wait for the window is the lost `intake:autoAccept` above.
- Everything committed is English; agent-facing text lives outside the dictionaries (`agent-protocol-copy.ts`).

## Goals / Non-Goals

**Goals:**

- One record per scheduled handoff, persisted through the existing inbox store, opened through the existing
  auto-accept path.
- One owner for "open this handoff now" that waits for a window that can receive it and opens each handoff at
  most once, ever.
- Every outbox file gets a receipt through one hook, so the five statuses cannot drift between code paths.
- The remote protocol carries the schedule as a field only.

**Non-Goals:**

- Waking or resuming an existing session at the time (the user chose a new session).
- Starting spekterm, or running anything, while the app is closed. No OS scheduler, no daemon.
- Recurring schedules. An agent that wants "check again tomorrow" schedules one more handoff.
- Telling the source agent later what became of a scheduled handoff (opened, cancelled). The receipt is the
  read-time outcome; the relations file shows the child once it exists.
- Listing scheduled handoffs in the source's relations file.

## Decisions

### D1. Four optional fields; no new state

- `scheduledAt` (epoch ms) in `IntakeVerified`, set by the handoff adapter through `DeliveryProvenance` (as
  `firstPartyBody` and `source` are), **only when `at` is later than the read time**. Shown to the user and to
  devices; part of the id digest.
- `targetText` in `IntakeVerified`: the target string the agent wrote, normalized as authored text. Re-resolved
  when the handoff opens (a folder removed and added back gets a new id, `workspace-store.ts`) and quoted in a
  fire-time failure trace.
- `opensAt` and `firedAt` (epoch ms) in the record's key half, beside `settledAt`. `opensAt` is set on every
  handoff record created by this version: `scheduledAt`, or the read time. `firedAt` is set the moment an
  automatic opening is attempted or the user accepts the record. The opener (D3) picks records with `opensAt`
  present, `opensAt <= now`, `firedAt` absent and state `pending`.

A record without `opensAt` — every handoff pending before this version, most often one whose prefill timed out
— is never opened automatically. On load each field is kept only when it has its type (a finite number, a
string); otherwise it is dropped, and a record that loses `opensAt` is an ordinary pending item.

"Scheduled" in every view is `state === 'pending' && scheduledAt !== undefined && firedAt === undefined`. No
view compares `scheduledAt` with the clock: the decision was made once, at read time (spec: "decided once").

*Alternatives.* A new `scheduled` state: rejected, a rollback would drop the records. A separate store:
rejected, it would duplicate dedupe, archive, lineage and the inbox listing. An in-memory "attempted" set (the
first draft): rejected in review — a record pending again after a prefill timeout was reopened, and announced
again, at every start. *Rollback cost:* an older version keeps the fields without reading them; a waiting
handoff shows as an ordinary pending item and is not opened automatically.

### D2. Everything is checked at read time, with one reading of the clock

`deliverFile` takes `now` once. `parseScheduledAt(at, now)` (in `handoff-delivery.ts`) returns "absent",
"scheduled at t" or a refusal: a regex for the extended form with a mandatory `Z|±HH:MM`, component checks
(month 1–12, day within the month with leap years, hour 0–23, minute and second 0–59), then `Date.parse`.
Measured on Node 22.22.0: `Date.parse` accepts `2026-02-30T10:00:00+08:00` (rolls to 2 March), `…T24:00:00Z`,
an offset-less time as local time, `+0800`, and a space separator — so the regex and the component check carry
the strictness. Refusals take a new permanent code `SCHEDULE_INVALID` with a detail naming the rule. The bound
is `MAX_SCHEDULE_AHEAD_DAYS = 30`. The id digest includes `scheduledAt` only when present, so every existing
handoff id is unchanged.

The checks that can change in between — the target still resolving, agent events on — run again when the
handoff opens (D3).

### D3. `HandoffOpener` owns every automatic opening

New `src/main/handoff-opener.ts`. `deliverFile` no longer calls `requestAutoAccept`; after `deliver` succeeds
it calls `opener.tick()`. The opener:

- `tick()`: if no window can receive (below), return. Otherwise, for each pending handoff record with
  `opensAt <= Date.now()` and no `firedAt`, oldest `opensAt` first: write `firedAt` (persisted **before**
  anything else, so a crash cannot reopen it), re-check (re-resolve `targetText` with `resolveTarget` against
  the current candidates → else `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` reject + `reportFailure`; agent events
  on → else `PREFILL_UNAVAILABLE` reject), then `requestAutoAccept(adapter, id, folderId)`, then
  `service.announceArrival(record)` for a record that has `scheduledAt` (D4), then `notifyIntakeChanged()`.
- Runs: after each delivery, every 30 s (`setInterval`, not a timer per record — overflow and suspend), when a
  window's restore gate opens, **when a `webContents` first becomes an inbox sender** (the two conditions of
  "can receive" come in either order; ticking on only one of them can leave a due handoff waiting up to 30 s),
  and on `powerMonitor` `resume`.
- **"A window can receive"** = some `webContents` is both in `ipc/intake.ts`'s `senders` and has its restore
  gate open. `ipc/intake.ts` exposes `receivers(): number[]` (live sender ids); `restore-gate.ts` exposes
  `isRestored(id)`. Tying both to one window matters only on macOS, where two windows can exist.
- `runNow(adapter, id)`: the desktop's Run now. Sets `firedAt` and fires that record now, whatever its
  `opensAt`.
- **Every accept also sets `firedAt`, persisted.** `IntakeStore.markFired(adapter, id, at)` sets it and saves
  at once; the callers that issue a handoff ticket (`ipc/intake.ts`'s auto-accept and accept handlers) call it.
  Saving at once matters for an accept whose session creation then fails: no `attach` follows, so nothing else
  would save the record, and after a restart the opener would open a handoff the user had accepted.
- **One live ticket per record.** The accept path does not issue a second ticket for a handoff record that
  still holds an unexpired one (`TicketStore` looked up by `(adapter, id)`). This closes the race in both
  directions: the opener checks `firedAt`, and an accept between the opener's request and the renderer's
  `attach` finds the opener's ticket. It is not `firedAt` that blocks the accept: a record pending again after a
  prefill timeout must still be accepted, reusing its session.

Precision is "within 30 s plus the time to create a session"; the spec bounds session creation at one minute
and leaves the prompt to the existing rules.

*Alternative:* keep the immediate path as it is and gate only scheduled handoffs. Rejected: a scheduled
handoff that falls due while the app is closed and a plain handoff written while the app is closed reach the
start in the same state, and the plain one has the lost-message problem too (spec: "A handoff read before the
window restored opens after it"). One owner closes both. This changes the immediate path, which is why the
`agent-handoff-source` delta states "on arrival" means "once a window can receive it".

### D4. Arrival is announced once, decided by the record, not the clock

`IntakeService.deliver` keeps emitting arrival as the single point after a record is added. The two arrival
listeners in `index.ts` (`notifier.arrived`, `remoteAttention.onIntake`) are registered through one helper
that skips a record with `scheduledAt` and no `firedAt` — a scheduled handoff at the moment it is scheduled.
`announceArrival(record)` emits to the same listeners **unguarded**; the opener calls it after setting
`firedAt`. An unscheduled handoff is announced by `deliver` as today; it is not announced again when it opens.
A third arrival listener added later goes through the same helper.

### D5. Overdue at start is an ordinary tick

The outbox scan ingests new files, the store already holds waiting records, and the first tick after a window
can receive opens every due record. No confirmation (the user's ruling). Lateness reaches the agent through
the context line (D6).

### D6. The opened session is told both times in the context header

`buildContext` takes an optional `{ scheduledAt, startedAt }`, rendered in `contextHeader` outside the fence
as ISO 8601 with the desktop's offset: `This handoff was scheduled for <t1>. It started at <t2>.` The copy lives
in `agent-protocol-copy.ts`. The fence and its body are unchanged, so the cross-process equality assertion of
`probe:intake` still holds.

### D7. The inbox lists scheduled handoffs in their own section

`intake-projection.ts` adds `scheduledAt` to `IntakeView` for a scheduled record (D1's definition — pending
only, so an accepted record whose `scheduledAt` is still in the future does not carry it). The badge count
filters scheduled items out of the same list the overlay renders (one evaluation). `IntakeOverlay.tsx` renders
a "Scheduled" section above the pending items, earliest first: time (`locale.ts`), source, target folder, full
body as plain text, **Run now** (`intake:runNow` → `HandoffOpener.runNow`) and **Cancel** (the existing
ignore). Dictionary keys in `en.json` and `zh-TW.json`; `aria-label`s from the dictionary.

Scheduled items count toward `MAX_PENDING` (200), as every pending record does; the spec states it. A
separate limit would be a second capacity rule for one store.

### D8. Receipts: one hook in `IntakeSource`, one writer

- `IntakeSource` gains `onOutcome?(file, outcome)`, called **before** `#remove` on every path: after
  `deliver`, on the oversize path (outcome from `rejectOversize`), and on a thrown delivery. The hook is
  awaited, and **its own failure is caught and logged; processing continues** (spec exception).
- `handoff-receipt.ts` maps to a status with its own type (`ReceiptStatus`, not `IntakeRejection`):
  - `ok` with a record carrying `scheduledAt` → `scheduled` (`at`, ISO 8601 UTC); other `ok` → `accepted`;
  - `DUPLICATE` with `notify: false`, and a report whose `acceptReport` answered `duplicate` → `duplicate`
    (`#deliverReport` returns that decision in the outcome so the mapping can see it);
  - `consume: false` → `held`; a thrown delivery → `held` with the receipt-only code `READ_FAILED`;
  - otherwise `rejected`, with `permanent` from `isPermanentRejection({ code, notify })`.
  The reason is a fixed English sentence per code from `agent-protocol-copy.ts`; temporary refusals and held
  receipts say what has to change or when the file is read again. Fields: `file`, `status`, `writtenAt`, and
  `code`, `reason`, `permanent`, `at` where they apply. No delivery text.
- Location: `<userData>/handoff/receipts/<sessionId>/<file name>`, a sibling of `outbox/`, `intro/` and
  `relations/`. Not in the outbox itself, where a `.json` receipt would be read as a delivery. Written to a
  dot-prefixed temporary name and renamed. A `held` receipt is rewritten only when its status or code
  changes, so the 30 s re-read does not churn it.
- Bound: after each write, keep the 100 newest by mtime among regular files (`lstat`, no symlink followed); a
  receipts path that is not a directory is replaced, as `prepareOutbox` does. `clearOutbox` removes it.
- The path reaches the agent from `introText`, derived inside it from the session id as the outbox path is, so
  `refreshIntros` cannot leave it out; and from `SPEKTERM_HANDOFF_RECEIPTS`. The introduction tells the agent to
  give each delivery a new file name: a receipt for a reused name may be the previous file's until the new one
  is read.

### D9. Remote: one field, the document, and a client obligation

`listView` already feeds `inbox.list`, so `scheduledAt` reaches devices without a new operation;
`inbox.accept` and `inbox.ignore` already have the right effects (accept = open now in the named folder, which
also sets `firedAt` through the ticket; ignore = cancel). Writing `firedAt` changes the store and so sends
`inbox.changed`. `docs/remote-protocol.md` §5 `inbox.list` gains the field, §7 notes that a scheduled
handoff's `intake` event comes when it opens, §9 gains an obligation (show scheduled items apart with their
time, do not notify while they wait). No change to `OPERATIONS`. An older client that does not know the field
sees a pending item whose `folderId` is the resolved target, so its accept works and runs it now. The Android
app is a separate follow-up in its own repository.

### D10. The introduction is made shorter before it is made longer

Measured on the maintainer's sessions (29 folders): 6,622 characters for a session the user opened, **7,458 for
one created by a handoff** (the longest variant, with the completion-report paragraph) — delivery rules 1,286,
repo list 1,963, outcome 544, relations 1,405, session commands 1,422, completion ~840. This change adds
scheduling and receipts (~1,300), which alone would take the longest variant to ~8,750.

**The limit that matters is measured, not assumed** (`docs/PRD.md` already noted "1 萬字, then a file and a 2,000
preview"; the reviewer reproduced it with Claude Code 2.1.303 in `-p` mode, injected the way spekterm injects):
9,512 characters arrived whole; 12,094 were replaced by `Output too large … saved to: <file>` and a preview of the
first ~2 KB; 260 short lines arrived whole, so there is no line limit in that mode. The threshold is counted in
string length, not bytes. The failure is not "the last paragraph is lost" but "everything after the opening is
lost". Bisected in task 7.6: 10,000 characters arrive whole and 10,001 are replaced, in `-p` and interactive mode
alike (`docs/lessons/handoff.md` §16).

- **Group the repo list by parent directory** (spec). Recomputed on the real list: 1,963 → ~700 characters
  (directory lines indented two spaces, names four), one name per line (a comma-separated line would be shorter
  but a folder name can contain a comma). Lossless today because `workspace-store.ts` sets `name` to
  `path.basename(path)`; to keep it lossless if a display name is ever added, `introText` derives the listed name
  from the path itself. The introduction states that a path is directory + `/` + name — with two repos of one
  name, the path is the only target that resolves (`handoff-target.ts`). A folder at `/` has an empty basename;
  it is listed by its path instead.
- **Assert every constraint before tightening any wording.** Today about half of them have no assertion (the
  `.json` suffix, the atomic write, "a half-written file is rejected", exact case-insensitive matching, "partial or
  fuzzy matches are rejected", who a command may target, the rename rules, "hibernate keeps it", "report again
  after each…"). Rewriting unasserted text can drop a rule with nothing turning red — the dead end lessons §9
  records. So the assertions come first, each with its control group (delete the sentence, see red), on the
  current wording; then the wording is tightened.
- **A budget test**: 8,000 characters for a fixture of 30 folders under three directories, names averaging 16
  characters, outbox / relations / receipts paths shaped like a real user data directory (~77 characters), the
  handoff-created variant. Its control group is padding of a fixed length added to the text, not the flat list
  (after tightening, the flat list may fit too). The test prints the length and the margin, so the next change
  that adds a paragraph sees what is left.
- **A hard limit at run time** (9,000 characters, below the measured 9,512): a fixture protects 30 folders, not a
  user's 150. When the full introduction would exceed it, the list keeps the repos that fit in workspace order
  and says how many were left out. Every rule stays: losing the list's tail costs some targets; crossing the
  threshold costs all of it.
- **Rejected: move details to a file the agent reads on demand.** An agent that does not read it writes a
  delivery against constraints it was never told — the dead end `docs/lessons/handoff.md` §9 records. Receipts
  would tell it afterwards, but a refused handoff from an agent about to close is still lost work.

## Risks / Trade-offs

- [The app is closed at the time] → opens at the next start (D5); the introduction and the docs say a
  scheduled handoff runs only while spekterm runs.
- [A handoff opens much later than meant, e.g. after a week away] → the user ruled to open it; the context
  line states both times so the agent can judge.
- [Unattended submission fails] → the known 1-in-13 case where the submit key does not take (lessons §13)
  matters more when nobody watches: the session is created but does not start. The existing fallback shows the
  prompt as waiting to be sent, and the session's status dot shows it waiting; nothing more is added.
- [No window ever receives (renderer crash)] → the opener does nothing and sets no `firedAt`; it opens when a
  window can receive.
- [An agent reuses a file name] → a receipt may be stale until the new file is read; the introduction tells it
  to use new names. Not enforced.
- [Clock changes] → due-ness is wall-clock against an absolute instant; time zone changes do not matter.
- [Many overdue handoffs at start] → all open; notifications merge as arrivals do today.
- [The introduction grows] → the longest variant is 7,458 characters with 29 folders today and gains ~1,300;
  grouping and tightening pay for it (D10), the budget test holds it, and the run-time hard limit protects a
  large workspace. Task 7.6 measured the threshold at exactly 10,000 characters in both modes, so the hard
  limit stays at 9,000.
- [The intro guard matches substrings] → `handoff-intro-source.test.mjs` flags any `30` once the bound is
  added, so the introduction's example times avoid it.

## Migration Plan

No data migration: the new fields are optional and absent on every existing record, and their absence means
"behave as before" (D1). Rollback: an older version keeps the fields without reading them and shows waiting
handoffs as pending items; receipts directories are left behind and removed by nothing (harmless, small).
