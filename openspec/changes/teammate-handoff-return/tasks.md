## 1. The Sent list (main process)

- [ ] 1.1 `src/main/teammate-sent.ts`: the store `<userData>/team-sent.json` (D1: versioned, cursors per membership,
  synchronous whole-file mutations over current memory, damaged file set aside and named); unit tests for load, save,
  damage and the 90-day prune
- [ ] 1.2 The sync loop (D2): on entering `connected` with `handoff.sync` in `operations()`, page from the cursor (0
  while `resetInProgress`) until `more: false`; one write per page (records with the cursor, also for an empty page);
  per-id rule and cursor raised outside a reset; during a reset (answer flag or stored flag) records replace whatever
  their seq and the cursor is set to the page's last seq; unknown-to-server marked at `more: false` and cleared by a
  later record; `INTERNAL` backoff; nothing requested without the operation; unit tests for each, including a crash
  between pages, a reset page with lower seqs, and an interrupted reset finished by the flag (controls: cursor written
  before records ⇒ the crash test loses a record; keep the per-id rule during a reset ⇒ the lower-seq test is red)
- [ ] 1.3 `handoff.status` events applied with the per-id rule; `src/main/team-outcome.ts` names close 1011 with reason
  `SERVER_ERROR` and keeps the backoff retry (`scripts/team-outcome-exhaustive.test.mjs` and `team-outcome.test.ts`
  green); unit test: after a 1011 close the next `connected` syncs from the stored cursor
- [ ] 1.4 `TeammateOutbox.#apply` (`src/main/teammate-outbox.ts`) on `ok` calls the synchronous `recordSend` (title,
  `sourceSessionId`, `clientId`, `sentFrom`, the answer's `status` and `seq`) before the outgoing write; the answer's
  `seq` never becomes the sync cursor; merge by id, else `clientId`, keeping local fields in both orders; unit tests:
  `recordSend` first then status record, status record first then `recordSend`, a resend answered done notifies once;
  control: outgoing write first ⇒ a crash test loses the title
- [ ] 1.5 Notifications (D5): a `sent-status` kind in `src/main/intake-notify.ts`; only for `sentFrom` =
  `membership.device.id`, done / declined / expired, not during a reset, and a stored copy with another status or
  `reports` or, without one, a `clientId` still in the outgoing store; text reduced
  with `reduceForNotification`; a Sent-only batch opens the Sent tab (`openInbox`'s tab union in `ipc/intake.ts` gains
  `'sent'`); unit tests (controls: drop the `sentFrom` test ⇒ red; notify without a stored copy ⇒ the upgrade test
  notifies; notify during a reset ⇒ the restored-older-state test notifies)

## 2. The sending agent's view

- [ ] 2.1 `src/main/handoff-relations.ts`: `teammateHandoffs` in `RelationsWorld` and the sending session's relations
  file (handle, title, status, `changedAt`, `recipientLeft`), no text or display name; built in
  `currentRelationsWorld` (`src/main/ipc/terminal.ts`); `refreshRelations` on every Sent store change; unit tests (a
  done record with a report: its text absent from the file; another device's record attributed to no session)
- [ ] 2.2 `src/main/teammates-file.ts`: one rule sentence explaining `teammateHandoffs`; the rules-from-constants test
  and `scripts/handoff-intro-source.test.mjs` green

## 3. The link and the reports (main process)

- [ ] 3.1 `src/main/teammate-inbox.ts`: `answered: true`, `answeredAt` and `deviceId` on an entry whose
  `handoff.received` was answered `{}` (kept through `shown`); answered `shown` entries kept 90 days past `answeredAt`; a
  `reportable(handoffId)` query (answered, current membership and device, `handoff.update` listed); unit tests for the
  three shown-without-answer paths (`HANDOFF_UNKNOWN`, no `handoff.received`, `possiblyElsewhere`) being not reportable
- [ ] 3.2 The link (D7): `src/main/handoff-ticket.ts` — `ticketFor` issues for pending reportable `teammate` records
  (today gated on `verified.source`), `TicketResolution.lineage` optional and `teammate?: { handoffId }`; the resolver in
  `src/main/index.ts` (`configureTicketLineage`); `src/main/session-create.ts` (`addProvisional`) and
  `src/main/ipc/terminal.ts` put `teammateHandoff` on the provisional record; `src/main/session-store.ts` makes it a
  main-owned field kept by `replace()` and on load; the report entry created at spawn; unit tests (link before spawn;
  no ticket ⇒ no link; not reportable ⇒ no ticket; restart keeps it)
- [ ] 3.3 `src/main/teammate-return.ts`: the store `<userData>/team-return.json` and the serial per-handoff sender (D8):
  `attempted` before the socket write, resend of the head after a lost answer or restart, collapsing of unattempted
  reports, every row of the answer table (re-acknowledgement once per report; `UNKNOWN_OPERATION` stops), `final`
  after an answered decline, the sweep of every entry of another stamp, the stop's trace and notification through
  `FailureContext.subject: 'teammate-report'`, `connected` and 30 s tick triggers, the prune; unit tests one per row and
  rule (control: send the next report before the answer ⇒ the ordering test is red)
- [ ] 3.4 `src/main/ipc/intake.ts`: `taken` queued at `watchSubmission`'s `onSubmitted` for a linked teammate record,
  nothing at `onFilled` or `onTimeout`; tests for the three
- [ ] 3.5 `src/main/handoff-completion.ts` / `src/main/handoff-service.ts`: a linked session's report → normalize,
  `toWellFormed`, length, non-white-space → `done` queued, receipt `accepted`, notification focusing the session
  without a sheet (`onReported` with that flag); stopped, final or missing entry → refused with
  `TEAMMATE_REPORT_STOPPED`, nothing sent; no lifecycle state set; unit tests (lone surrogate; stopped; final; the
  once-per-file identity)
- [ ] 3.6 Codes and copy (D12): `TEAMMATE_REPORT_STOPPED`, `TEAMMATE_REPORT_NOT_SENT` in `IntakeRejection`,
  `isPermanentRejection`, `receiptReason`, `agent-protocol-copy.ts` and `intake.rejectReason`; the `'teammate-report'`
  subject's notification copy; `en.json` / `zh-TW.json`; `npm test` (dictionary completeness, copy language) green

## 4. The introduction

- [ ] 4.1 `src/main/handoff-intro.ts`: `reportable: 'lineage' | 'teammate'` and the teammate variant (D11: no parent,
  details where the teammate can reach them, step 2 replaced); `peerLines`' parent sentence qualified; derived at
  spawn in `src/main/ipc/terminal.ts` and in `src/main/index.ts`'s two `reportableOf` lambdas, passed through
  `src/main/handoff-injection.ts`; `'teammate'` only while the report entry is neither stopped nor final, and a stop or
  an answered decline calls `refreshIntros`; `handoff-intro.test.ts`'s budget fixture uses `'lineage'`; unit tests: the variant's
  content, no parent sentence, not longer than the lineage variant, the 8,500 budget green with the re-measured length
  recorded in the test's comment

## 5. Declining and the Sent tab (renderer + IPC)

- [ ] 5.1 IPC (`src/main/ipc/intake.ts`, `src/preload/index.ts`): Decline handler (reportable check, reason through
  `teammateText`, ≤ 500, `dismissIntake`, `declined` queued); the desktop's inbox list response marks which teammate
  items are reportable, **outside `listView`** (`src/main/remote-host.ts` spreads `listView`'s items to the phone, and
  the remote protocol has no such field); a unit test that the phone's item has no such field; a separate Sent list call with the narrowed records and the "not offered" state; unit tests for the
  handler's refusals and the narrowing
- [ ] 5.2 Renderer (`src/renderer/src/shell/intake/IntakeOverlay.tsx`, `intake-state.tsx`): Decline… on reportable
  pending `teammate` items with the reason field and live count; the Sent tab with the spec's rows (no-title label,
  recipient left, status and age, plain-text text with length, report number and Copy, unknown-to-server, not
  offered); dictionary strings in both languages; `npm run typecheck`, `npm run lint`, `npm test` green

## 6. Probes

- [ ] 6.1 `scripts/lib/stub-team-server.mjs`: `handoff.update`, `handoff.sync` (paging, `reset`), `handoff.status`
  events, a scripted 1011, and an operations list without `handoff.update`, each request recorded when its frame
  arrives
- [ ] 6.2 `probe:team` sections: the Sent tab after a sync and after an event; a notification on the sending profile
  only; Decline with a reason reaching the stub; `taken` after the stub agent starts working and `done` after its
  report; a stop leaving a trace; 1011 then resync; no Decline without `handoff.update`; the cross-process assertion is
  the stub's recorded report text against the summary the stub agent wrote; control groups in
  `scripts/team-control-groups.mjs` for the `sentFrom` test and the report order
- [ ] 6.3 `scripts/scenario-coverage.test.mjs`: register `teammate-handoff-return` in `COVERED_CHANGES` and map every
  scenario of this change to its carrier (unit test or probe assertion), with `greenIfAbsent` and `mutation`;
  `npm test` green
- [ ] 6.4 Run `probe:intake` and `probe:agent-view` for regressions (receipts, inbox rows, prefill, intro)

## 7. Docs

- [ ] 7.1 Website: Teams and handoffs pages (the Sent list, declining, reporting back) and the data-and-network page
  (reasons and reports 30 days, records 90 days) in `site/src/content/docs/` and `zh-tw/`;
  `scripts/network-surface.test.mjs` green; `(cd site && npm ci && npm run build)` green
- [ ] 7.2 `docs/lessons/team.md` (what failed silently while building this), `CLAUDE.md` 現況 (Teams: the way back)

## 8. Verification

- [ ] 8.1 `npm test`, `npm run typecheck`, `npm run lint` green
- [ ] 8.2 `npm run probe:team` complete and green; `npm run test:e2e` before archiving
- [ ] 8.3 Dogfood with two spekterm profiles and a local spekterm-server 0.3.1: A's agent hands to B → A confirms →
  B's inbox → B accepts and sends the prompt (A sees delivered, then taken) → B's agent reports (A sees done with the
  report and one notification on A only; A's agent's relations file shows done without the text; B is notified and
  focused on the session) → a second handoff declined with a reason (A notified, reason in the Sent list); also: A's
  second device syncs the list without titles and without notifying
