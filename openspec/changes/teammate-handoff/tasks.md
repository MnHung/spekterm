## 1. Payload and inbox schema (main process)

- [ ] 1.1 `src/main/handoff-delivery.ts`: `parseHandoffPayload` reads `to`; `to` with `target`, `to` with `at` /
  `repeat` / `until`, and a non-string or empty `to` refused per spec; unit tests, one per shape
- [ ] 1.2 `src/main/intake-schema.ts`: `targetFolderId` optional in `DeliveryProvenance` (the spread line in
  `parseIntake` unchanged); `handoffBodyLimit` in provenance and persisted in `verified`; `parseIntake` takes the
  limit from `firstPartyBody || handoffBodyLimit`; `src/main/intake-store.ts` keeps it on load only when `true`;
  unit tests: a teammate-shaped provenance gets 20,000, no `firstPartyBody`, and the third-party prompt in fill mode;
  control: make `ipc/intake.ts`'s prompt choice read `handoffBodyLimit` ⇒ red
- [ ] 1.3 `MAX_TEAMMATE_BODY_LENGTH` = min(`MAX_FIRST_PARTY_BODY_LENGTH`, the server's 20,000) beside the other limits
- [ ] 1.4 New intake codes `TEAM_UNAVAILABLE`, `TEAMMATE_NOT_FOUND`, `TEAMMATE_IS_SELF`, `OUTGOING_FULL`,
  `SEND_UNCERTAIN`, `TEAMMATE_UNREADABLE` in `IntakeRejection`, the exhaustive `isPermanentRejection` (temporary:
  `TEAM_UNAVAILABLE`, `OUTGOING_FULL`, `TEAMMATE_UNREADABLE`), `receiptReason`, and `intake.rejectReason` in
  `en.json` / `zh-TW.json`; `OUTGOING_FULL` not consumed
- [ ] 1.5 `src/main/intake-source.ts`: the periodic re-read hands an `OUTGOING_FULL` file over again once the outgoing
  store has room, as it does `CAPACITY` with `hasRoom()`; unit test with the default interval

## 2. Sending (main process)

- [ ] 2.1 `src/main/teammate-outbox.ts`: `read(...)` with the checks of D2 in order (team, recipient with the
  rate-limited 3 s refetch and the list's handle, text normalized + well-formed + lengths, duplicates, the bound of
  20); the store of D3 (versioned, membership stamp, synchronous whole-file writes, one serial queue for every
  mutation, damaged file set aside and named in the tab)
- [ ] 2.2 `src/main/handoff-service.ts`: branch a `to` delivery to `TeammateOutbox.read` before scheduling and target
  resolution; its outcome feeds the existing receipt and failure-notification path
- [ ] 2.3 Send (D5): Send records `confirmed`; `attempted` written before the socket write; sends one at a time,
  skipping a future `retryAt`, on Send, on `connected`, and on a 30 s wall-clock tick; the answer table; `noDevice`;
  on `onCredentialDiscarded`, and as a sweep at every start and `membership()` change, items whose stamp is not the
  current membership refused `TEAM_UNAVAILABLE` or `SEND_UNCERTAIN` per spec; swept items not counted in the bound
- [ ] 2.4 Receipts (D6): the new statuses and `held` codes, the `TeammateReceiptCode` union with its own exhaustive
  reasons in `agent-protocol-copy.ts` and permanence for server codes; `ref` in teammate receipts; `rewriteReceipt`
  that writes only when the receipts directory exists and the current file's `ref` is this item's
- [ ] 2.5 Unit tests: each check, its order and code; one stored value is shown and sent; `attempted` before the write
  (control: after ⇒ a restart test sends a new `clientId`); a lost answer resends the same `clientId`; `RATE_LIMITED`
  waits across a restart and restores Discard; `INTERNAL` retries after a backoff without blocking a later item;
  each refusal code; Discard queued before "attempted" sends nothing (control: async write ⇒ red); leave A / join B
  sends nothing to B's same handle; a stale-stamp item left by an interrupted discard is refused at the next start; `SEND_UNCERTAIN` after a lost answer and a revocation; duplicates; a dormant
  session's receipt is rewritten and an ended session's directory is not recreated; a reused file name keeps the
  other delivery's receipt; the bound holds the file

## 3. Teammates file and introduction

- [ ] 3.1 Re-measure the `additionalContext` threshold with the CLI in use (9,000 / 10,000 / 10,001 characters and
  the 8,000 / 200-line cut, as `docs/lessons/handoff.md` §16 did) and update §16 with the version; if a cut at 8,000
  applies, stop this group and bring the budget back to the user
- [ ] 3.2 `src/main/teammates-file.ts`: `<userData>/handoff/teammates.json` per D8 — the rules text with every number
  from the constants in effect, `you`, `connected`, `fetchedAt`, teammates with handles and normalized one-line
  display names — whole-file, rewritten on members and connection changes, removed when the membership is discarded
  or the feature is off; unit tests: no device id, secret or server address; a body one over the stated limit is
  refused; the source guard of `scripts/handoff-intro-source.test.mjs` extended to this file's numbers
- [ ] 3.3 `src/main/handoff-intro.ts`: the paragraph of D8 only with a membership and the feature on; the receipt
  status list gains `awaiting-confirmation`, `sent`, `discarded`, and its `held` line becomes "not finished yet; the
  reason says what happens next" (a deletion test for it); the team input passed at every write point
  (`handoff-injection.ts`'s two and `refreshIntros` in `index.ts`), and `refreshIntros` run when the membership or the
  feature changes
- [ ] 3.4 `handoff-intro.test.ts`: a deletion test per new sentence; the paragraph absent without a membership and with
  the feature off; the same length for 2 and 60 members; the budget at 8,500 for 30 folders, a handed-off session, on
  a team (print the margin); no display name in the introduction

## 4. Receiving (main process)

- [ ] 4.1 `src/main/teammate-inbox.ts`: the hidden store `<userData>/team-incoming.json` (with the membership stamp)
  and the state machine of D9 — one acknowledgement in flight per id; `{}` to a non-stored entry changes nothing;
  `deliver` results mapped; `acked` entries delivered at start, on `connected` and on the 30 s tick, with or without a
  connection; in-memory offers dropped when their connection ends; pruning a day after `expiresAt`
- [ ] 4.2 The inbox item (D10), and the `possiblyElsewhere` mark (provenance, kept in `verified` only when `true`,
  shown on the row): id mapping and its rule; unreadable offers (id, `enc`, handle rule) not stored, not
  acknowledged, one `TEAMMATE_UNREADABLE` trace per id; normalized `from`; the provenance of D10; built from the
  stored entry only
- [ ] 4.3 Unit tests, one per arrow of D9: stored before acknowledged (control: acknowledge first ⇒ red); not in the
  inbox until `{}`; a repeat acknowledged and not shown; a reconnect re-acknowledges without a second acknowledgement
  in flight; elsewhere / expired never shown; unknown shown; no `handoff.received` operation shows; a discarded
  credential shows `stored` entries marked possibly elsewhere and keeps `acked`; a full inbox neither stores nor acknowledges, then does both; an
  `acked` entry left by a crash reaches the inbox at the next start without a connection; an unreadable offer leaves
  one trace and no acknowledgement; a later event with a changed display name does not change the item
- [ ] 4.4 Wire `TeammateOutbox`, `TeammateInbox` and `teammates-file` to the team service (`onEvent`, `onState`,
  `onMembers`, `operations()`, `request`, `onCredentialDiscarded`) and the intake service in `src/main/index.ts`

## 5. IPC and renderer

- [ ] 5.1 `ipc/intake.ts` + preload: the inbox snapshot carries the outgoing items (narrowed: no `clientId`, no stamp)
  and `outgoingWaiting` from the same call; Send, Discard, Dismiss handlers; the outgoing store's changes emit the
  inbox's changed signal
- [ ] 5.2 `IntakeOverlay.tsx`: the Outgoing tab (fixed label, count in its text), rows per D7 with the inbox's
  plain-text body component and length; states and reasons; Send / Discard / Dismiss
- [ ] 5.3 Activity bar badge = pending + `outgoingWaiting` from one snapshot; the teammate label and sender shown on
  inbox rows only for adapter `teammate`
- [ ] 5.4 `intake-notify.ts`: an outgoing arrival kind; a batch of only outgoing arrivals opens the Outgoing tab, a
  mixed batch opens the inbox; text reduced
- [ ] 5.5 Dictionary strings in both languages (tab, states, reasons, notification, source label, the unreadable
  trace); `aria-label`s from the dictionary

## 6. Probe

- [ ] 6.1 `scripts/lib/stub-team-server.mjs`: record `handoff.send` requests and answer with scripted outcomes (ok,
  duplicate, `RATE_LIMITED`, `INTERNAL`, refusals, a dropped answer); send `handoff.incoming` (including unreadable
  ones), withhold or answer `handoff.received` with scripted outcomes; record acknowledgements
- [ ] 6.2 `probe:team` sending sections: a stub agent writes a `to` handoff → Outgoing tab, badge, notification
  activation → Send → the recorded request's body equals the tab's `textContent`; receipts read from disk at each
  step; lost answer resent with the same `clientId`; rate limit then Discard; discard; refusal; refusals before asking
  (unknown handle, no team, feature off)
- [ ] 6.3 `probe:team` receiving sections: hidden while the acknowledgement is unanswered, shown after `{}` with the
  server's sender; repeat; elsewhere; unknown; an unreadable offer's trace; revocation shows a stored entry with its mark; a
  shared drop point file declaring `origin.kind` `teammate` is not shown as a teammate's; accept into a chosen folder
  fills and does not send the first prompt
- [ ] 6.4 Control groups for the key assertions (acknowledge before storing; send before confirming; a new `clientId`
  on resend; prompt tied to the limit flag; label from the origin kind)
- [ ] 6.5 Run `probe:intake` and `probe:agent-view` for regressions (receipts, badge, inbox rows, prefill)

## 7. Docs

- [ ] 7.1 Website, both languages: the handoffs page (handing to a teammate, the Outgoing tab, receipts) and the Teams
  page (receiving, the 20,000 limit); the data-and-network page's team paragraph names handoffs (title and body,
  kept by the server until delivered or expired) among what passes through and what the server keeps
- [ ] 7.2 `CLAUDE.md` 現況 (teammate handoffs, the receipt status list), `docs/lessons/team.md` (anything that failed
  silently), `docs/PRD.md` Phase 7 note
- [ ] 7.3 `docs/lessons/handoff.md` §16: the budget sentence (8,000 → 8,500, why, and the re-measurement of 3.1)

## 8. Verification

- [ ] 8.1 Register `teammate-handoff` in `scripts/scenario-coverage.test.mjs`'s `COVERED_CHANGES` and fill one row per
  scenario (carrier looked up, `greenIfAbsent`, `mutation`)
- [ ] 8.2 `npm run typecheck`, `npm run lint`, `npm test` green
- [ ] 8.3 `npm run probe:team` complete and green; `npm run test:e2e` before archiving
- [ ] 8.4 Dogfood with two spekterm profiles and a local spekterm-server 0.2.1 (with `protocol-clarifications`): A's agent hands to B → A confirms →
  B's inbox shows it within seconds while open, and at its next start while closed → B accepts into a chosen folder
  and gets the filled prompt; with B's other device offline, an acknowledgement cut before it was sent shows once on
  B; a revoked B stops reconnecting and shows what it never had confirmed, marked
