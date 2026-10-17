## 1. One record of offers (`SessionControl`)

- [x] 1.1 In `src/main/session-control.ts`, keep `#offered` as session → time of the offer; route every removal
  (keystroke, failed `offer-close`) through one private method; add the `offersChanged` dependency, called only on a
  real change (an offer added that was not there, an offer removed that was there); add `withdraw(sessionId): boolean`,
  which does not contact the window (D1). Verify with unit tests in `session-control.test.ts`: add, keystroke, failed
  `offer-close` and `withdraw` each call `offersChanged` exactly once; a second self-close of an offered session, a
  keystroke or `withdraw` on an unoffered session, and `processEnded` on a pending-but-unoffered target call it never;
  `withdraw` sends nothing to the window. Remove the `#offered.delete` from `processEnded` (D3 covers a process end);
  verify `processEnded` on an offered session with a pending command neither removes the offer nor announces.
- [x] 1.2 Make `isOffered` false once `runs.lastProcessChangeAt(sessionId)` is later than the offer's time, dropping
  the stale entry **without announcing** (the existing `onPtyChange` announcement covers a process end) (D3). A stale
  entry counts as absent everywhere: `withdraw` returns `false` and announces nothing; a new self-close stores a fresh
  time and announces. Verify with unit tests: an offer, then a recorded process end, is no longer offered; an offer,
  then a recorded start (a wake, with no end recorded), is no longer offered; a process change before the offer does
  not end it; reading a stale entry does not call `offersChanged`; `withdraw` of a stale entry returns `false`; a
  self-close after a stale entry calls `offersChanged` once.
- [x] 1.3 In `#carryOut`, remove the offer on a failed request only when that request was the `offer-close` (D1).
  Verify with a unit test: a failed rename and a failed hibernate of an offered session keep the offer and do not call
  `offersChanged`; a failed `offer-close` removes it and calls it once.
- [x] 1.4 In `src/main/index.ts`, wire `offersChanged` to `remoteService.listChanged('sessions')`. Verify by the probe
  in 4.1 (the late-read offer appears), whose control group without this wiring is red.

## 2. The protocol (`remote-protocol.ts`, `remote-host.ts`)

- [x] 2.1 Add `closeOffered?: true` to `SessionView`, set by `sessionList()` only when the host's `offered(sessionId)`
  is true **and** the session is live (D5). Verify with `remote-host.test.ts`: an offered running session carries the
  field; an offered session that is not live and an unoffered one do not.
- [x] 2.2 Add `keep(sessionId)` to `RemoteHost` and `OPERATIONS['sessions.keep']` (`sessionId` required): no window →
  `NO_WINDOW`; no record → `NOT_FOUND`; otherwise `withdraw` in the main process, then **always** request
  `{ kind: 'withdraw-close' }` from the window, its failure mapped as `perform` maps it (D2). Verify with
  `remote-host.test.ts` / `remote-protocol.test.ts`: each outcome, the window asked even when there was no offer,
  `BAD_PARAMS` without `sessionId`, and `sessions.keep` in the no-window test (refused with `NO_WINDOW`). Update the
  existing fakes and constructions of `RemoteHost` / `HostDeps` that typecheck flags.
- [x] 2.3 In `index.ts`, pass `offered` and `keep` to `createRemoteHost` as direct closures over the `SessionControl`
  built later in `whenReady` (D2, no holder). Verify by `npm run typecheck` and the probe in 4.1.

## 3. The desktop's Keep reaches the main process

- [x] 3.1 Add the `workspace:handoff:keepCloseOffer` message: a handler in `src/main/ipc/handoff.ts`, registered from
  `index.ts` after `SessionControl` is built, string-checked, calling `withdraw` without contacting the window; and
  `window.workspace.handoff.keepCloseOffer(sessionId)` in `src/preload/index.ts` (D4). Add `keepCloseOffer` to
  `scripts/probe-shell.mjs`'s `handoff` allow-list and rewrite its rationale comment (the namespace's first member that
  changes state, and why it stays within the boundary). Verify by `npm run probe:shell` green, and the probe in 4.1.
- [x] 3.2 Make the card's Keep in `TerminalView.tsx` and `ConversationView.tsx` clear the card as today **and** send
  the message (one helper, so the two views cannot drift). Verify by the probe in 4.1 (the desktop's Keep clears the
  device's mark) and the existing `probe:intake` offer section still passing.

## 4. Acceptance

- [x] 4.1 Add a `probe:remote` section `runCloseOffer` acting as the phone, reusing `probe:intake`'s self-close
  pattern (`stub.control.stage({ kind: 'close' })`, `commit`, `Stop`), and add it to the probe's `SECTIONS`. Each
  assertion reads a `sessions.changed` **event** received after the action, not a fresh `sessions.list`:
  - **the late-read appearance**, placed before any step that types into S: `fire UserPromptSubmit`,
    `fire PreToolUse`, stage, `sleep 1`, `fire Stop` (a turn start, so the Stop changes the wait state and sends a
    list), wait for the event in which S is `wait: "ready"` and unmarked, then `commit` and expect an event in which S
    is marked and running **within 700 ms**, three times. The command is delivered at rest and offered at once, with
    no wait-state change; the list's 5 s reconcile still delivers the mark without `offersChanged`, only later
    (measured ~160 ms with it, 1.4–2.1 s without), so the bound is what makes this the one assertion only
    `offersChanged` keeps green;
  - the usual appearance (command inside the turn) also marks S;
  - `sessions.keep` clears the mark and the desktop's card;
  - the desktop's Keep clears the mark;
  - typing into S clears the mark;
  - `sessions.keep` on an unoffered session succeeds with no change;
  - an offered S hibernated on the desktop and woken: wait for a post-wake event in which S is `running: true`, and
    assert that event is unmarked (a positive wait, so "no event" cannot pass);
  - `sessions.close` without `force` on an offered, waiting S succeeds and removes it;
  - for one offered turn, the attention stream holds exactly one `waiting` event for S and no other event for S.

  Add `sessions.keep` to the authentication-answer assertion in `runRename`, keeping its label. Verify with
  `PROBE_ONLY=runCloseOffer npm run probe:remote` green, then three control groups, each red at its named
  assertion: no `offersChanged` wiring (the late-read appearance), no desktop Keep message (the desktop's Keep),
  `isOffered` without the process-change test (hibernated and woken). D5's live test is covered at unit level (2.1).
- [x] 4.2 Register `remote-close-offer` in `COVERED_CHANGES` of `scripts/scenario-coverage.test.mjs` and add a row for
  each **new** scenario of this change's deltas (the scenarios re-listed under MODIFIED requirements already have
  rows; a second row fails the table's duplicate guard). Each row names its real carrier, `greenIfAbsent` and
  `mutation`; "An offered close notifies once" and "Closing an offered session from a device closes it" are green
  without the change, which their rows say. Review the existing rows whose meaning changed: "The answer lists the new
  operations" (its note and carrier label after 4.1) and "Keeping the session withdraws the offer". Verify with
  `npm test`.

## 5. Documentation

- [x] 5.1 Update `docs/remote-protocol.md`: `closeOffered` in `Session` (§5 `sessions.list`); a `sessions.keep` entry
  (parameters, result, no-offer behavior, errors `NOT_FOUND`, `NO_WINDOW`, `TIMEOUT`, `CREATE_FAILED`, `BAD_PARAMS`);
  the §5 opening; a sentence in §7 that an offer raises no attention event of its own, and the API-error gap; a §9
  client obligation (offer Close and Keep for a marked session; Close there is the confirmation obligation 12 asks
  for). Verify with `npm test` (`scripts/remote-protocol-doc.test.mjs`).
- [x] 5.2 Update the website in both languages: `site/src/content/docs/docs/using/remote-access.md` (the description
  and the "Hibernating and closing from the phone" section) and `site/src/content/docs/docs/using/handoffs.md` (the
  offer bullet), with their `zh-tw` twins: a paired phone sees the offer and can answer it. Verify with
  `(cd site && npm ci && npm run build)`.
- [x] 5.3 Update `CLAUDE.md` ("Remote access": a device's requests include keep; the handoff bullet: a paired device
  sees and answers the offer) and `docs/lessons/handoff.md` ("An agent's close of its own session is offered, not
  carried out": the main process owns the offer; the desktop's Keep must reach it; an offer is timed against process
  changes, and why wiring was not enough; a failed request drops only its own offer). Verify by reading both passages
  against design D1–D5.

## 6. Checks

- [x] 6.1 Run `npm run typecheck`, `npm run lint` and `npm test`; all green.
- [x] 6.2 Run `npm run probe:remote`, `npm run probe:intake` and `npm run probe:shell` in full; green apart from the
  known intermittent `runListener` failure (#84).
