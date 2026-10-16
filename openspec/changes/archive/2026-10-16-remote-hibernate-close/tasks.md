## 1. One definition of "not idle"

- [x] 1.1 `src/main/hibernation-policy.ts`: add `BusyReason` and `busyReason({ target, wait, unconfirmedSubmission, shell })` (design D2 table); rewrite `isEligible` as "not displayed, past the threshold, and `busyReason` is `null`"
- [x] 1.2 `hibernation-policy.test.ts`: the existing `isEligible` tests pass unchanged; add one test per `busyReason` row, and one per `null` case (an agent `ready` with no unsent prompt, an `idle` shell)

## 2. End reasons carried to watches

- [x] 2.1 Grep every `TerminalService.kill` caller to confirm the `kill` IPC is the only one, so `killed` means a close (design D5); record the result in the design if it differs
- [x] 2.2 `src/main/terminal.ts`: next to `ExitReason`, a total mapping to the protocol's end reason (`self` → `exited`, `hibernated` → `hibernated`, `killed` → `closed`; `disposed` → `exited` only for totality, commented as unreachable because `windowGone` stops watches first)
- [x] 2.3 `src/main/remote-output.ts`: `exited(sessionId, reason)` ends terminal watches with that reason; `OutputListener.ended` takes `'exited' | 'hibernated' | 'closed' | 'restarted' | 'off'`; `remote-output.test.ts` covers each reason
- [x] 2.4 `src/main/remote-protocol.ts`: the protocol session handle gains `sessionEnded(sessionId, reason)`. When the connection watches that session's conversation, it stops the watch **through `stopConversation`** (so `setWatched(key, null)` runs) and sends `conversation.ended { sessionId, reason }`. `remote-protocol.test.ts` covers watched, not watched and another session, and asserts the `setWatched(…, null)` call
- [x] 2.5 `src/main/remote-service.ts`: `sessionEnded(sessionId, reason)` forwards it to every connection; `src/main/ipc/terminal.ts`'s exit handler calls the output with the reason, and calls the service for `self` / `hibernated` / `killed` (not `disposed`) through a hook wired in `src/main/index.ts`

## 3. The operations

- [x] 3.1 `src/main/remote-frames.ts`: the `SESSION_BUSY` error code
- [x] 3.2 `src/main/remote-protocol.ts`: `HostAction` kinds `hibernate` and `close` with `force: boolean`; operations `sessions.hibernate` and `sessions.close` (`sessionId` required; `force`: `true` forces, absent / `null` / `false` do not, any other type is `BAD_PARAMS`); `remote-protocol.test.ts` covers the parameter checks
- [x] 3.3 `src/main/remote-host.ts` `perform`:
  - `NOT_FOUND` for a session with no record;
  - a hibernation of a session with no pty answers `{ sessionId }` at once;
  - without `force`, `refreshWait(sessionId)` and then the check: a running session with a `busyReason` is refused `SESSION_BUSY` with `detail: { reason }` before the interface is asked;
  - `HostDeps` gains an optional `waits` (`refresh` / `stateOf` / `unsent`) that defaults to the real `refreshWait`, `waitStateOf` and `hasUnconfirmedSubmission`, so each reason is unit-tested by injection (the terminal service's `idleFactsOf` is reached through the injected service); the module-level imports the other methods use are unchanged
- [x] 3.4 `remote-host.test.ts`:
  - each refusal reason, by injected facts;
  - the wait state is refreshed before it is read;
  - `force` skips the check;
  - a dormant hibernation is not sent to the interface;
  - a dormant close is sent without the check;
  - `NO_WINDOW` for both with no window;
  - `NOT_FOUND` for an unknown session
- [x] 3.5 `src/preload/index.ts`: `narrowRemoteAction` passes `hibernate` and `close` with their fields (without it the renderer receives `null` and the device times out, with no type error)

## 4. The interface carries them out quietly

- [x] 4.1 `terminal/sessions.tsx`: a `holdFocus` set, recorded with the `sessions` array its transition produces, and `isFocusHeld(sessionId)` on the API as a stable, ref-backed callback. The provider clears the hold in an effect with no dependency array, in the commit that renders that array (design D4)
- [x] 4.2 `terminal/sessions.tsx`: `hibernate` returns a promise of the main process's answer and takes `{ quiet }`. With `quiet` and a renderer status that has not caught up, it still sends the hibernation (without a snapshot). A quiet hibernation is recorded before the IPC is sent, and cleared when the IPC answers `{ ok: false }` and by `wake` and `close`. The hibernated-exit handler adds the session to `holdFocus` in the same update that sets it dormant
- [x] 4.3 `terminal/sessions.tsx`: `close` takes `{ quiet }`. With `quiet`, in the same update, it adds to `holdFocus` the session that becomes the item's focused session (or the item's first session, the `focusedIdFor` fallback)
- [x] 4.4 `TerminalView.tsx` and `ConversationView.tsx`: each focus effect skips its `focus()` call while `isFocusHeld(sessionId)` is true, whatever triggered it. Each view also remembers in a ref that it held focus for its current `(status, active, covered)`, and keeps holding when an evaluation repeats those values (StrictMode's second run in development, design D4). The quiet-arrival mark's consumers are unchanged
- [x] 4.5 `RemoteRequests.tsx`: `hibernate` and `close` branches:
  - `NOT_FOUND` when the renderer does not know the session;
  - `{ ok: false }` from the main process's hibernate is success for a dormant session and `NOT_FOUND` for an `exited` one;
  - reply after `close`

## 5. Protocol document and website

- [x] 5.1 `docs/remote-protocol.md`:
  - §4: the operations an older desktop lacks gain both;
  - §5: the opening sentence, plus `sessions.hibernate` and `sessions.close` entries after `sessions.rename`, with params, result, errors and the `SESSION_BUSY` reasons;
  - `terminal.ended` and `conversation.ended` carry the new reasons, whoever ended the session;
  - §3: `SESSION_BUSY`, and the `CREATE_FAILED` wording;
  - §9: the confirm-before-close / before-`force` obligation; obligation 7 extended to unknown values of a known field, and ended events read by `reason`
- [x] 5.2 `site/src/content/docs/docs/using/remote-access.md` and `site/src/content/docs/zh-tw/docs/using/remote-access.md`: what the phone can do (both languages, description included); the website build passes (`cd site && npm ci && npm run build`)
- [x] 5.3 `CLAUDE.md`, the remote-access paragraph: qualify "no focused-session change" (closing the displayed session changes the item's focused session)

## 6. Acceptance

- [x] 6.1 `scripts/probe-remote.mjs`: a section `runHibernateClose` that acts as the client. It covers:
  - `operations` lists both;
  - a shell running `sleep` is refused `SESSION_BUSY` / `job`, then hibernated with `force`, and the terminal watch ends `hibernated`;
  - the session is persisted, shown dormant, and wakes;
  - a dormant hibernation succeeds;
  - an idle stub agent hibernates without `force`, and its conversation watch ends `hibernated`;
  - a stub agent on a permission prompt (control file) is refused `choice`, then closed with `force`: absent from the list, persistence and the rail, its attachment directory removed, and both watches end `closed`;
  - a dormant session closes;
  - the displayed session hibernated, then closed, with focus in the editor, in the terminal view and in the conversation view: focus stays there and the rail selection is unchanged;
  - after a quiet close of the displayed session, selecting another rail item and then this one again focuses the replacement's terminal;
  - with automatic hibernation at a short threshold, a session hibernated while its conversation was watched, then woken and left unwatched, hibernates automatically;
  - a desktop close of a watched session ends its watches `closed`;
  - a shell's `exit` ends the terminal watch `exited`;
  - unknown ids are `NOT_FOUND`
- [x] 6.2 Each scenario's mutation: revert one at a time and confirm the matching probe assertion turns red:
  - the hold in each of the two views;
  - the provider's clearing of the hold (the reselection assertion must turn red);
  - the `busyReason` check;
  - the refresh before it (unit test);
  - the end-reason mapping;
  - `stopConversation` in `sessionEnded`;
  - the clearing of the quiet-hibernation record on `{ ok: false }`. The control: a device hibernates an already dormant session, the user wakes it and then hibernates it on the desktop while it is displayed, and its Wake button must take focus
- [x] 6.3 `scripts/scenario-coverage.test.mjs`: register `remote-hibernate-close` in `COVERED_CHANGES`. Add a row for each scenario this change adds. Scenarios copied unchanged into MODIFIED requirements keep their existing rows (the table rejects duplicates), but each one's carrier is checked again. "The answer lists the new operations" must now assert both new operations
- [x] 6.4 `npm run typecheck`, `npm run lint`, `npm test` and `npm run probe:remote` pass; `npm run probe:terminal`, `npm run probe:keyboard` and `npm run probe:agent-view` pass (the focus effects changed)
