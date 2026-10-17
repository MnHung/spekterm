## Why

`agent-session-control` lets an agent close its own session, but only as an **offer** (its design D12): when the
agent's turn ends, the desktop's terminal view and conversation view show "The agent asked to close this
session" with Close and Keep, and nothing closes until the user chooses Close. A paired phone does not see the
offer. Its session list shows the session running, with nothing to answer. D12 recorded this as a gap for the
companion app (`spekterm-android`), but the phone cannot close it on its own: the remote protocol does not carry
the offer. The desktop has to carry it first.

Reading the paths this would reuse turned up three things that are fine for the desktop alone and wrong once the
offer leaves it:

1. **The main process never hears the desktop's Keep.** Keep clears the offer in the interface only (D12 says so
   explicitly), so the main process's record of offered sessions keeps the session until a keystroke or the
   process ends. A list read from that record would show an offer the user already declined.
2. **The main process's record outlives the session's process.** It is cleared when the process ends only for
   sessions with a *waiting* command (`index.ts` calls `processEnded` for `pendingTargets()` only). An offered
   session that is then hibernated on the desktop stays recorded as offered. Woken later, a list read from that
   record would show the old offer on a session whose agent asked nothing.
3. **Nothing tells devices when an offer appears or goes.** `sessions.changed` is sent when a pty starts or ends,
   when the session store changes, and when a wait state changes. None of these happens when an offer is made or
   withdrawn. The phone would see the offer only when the list's periodic recomputation (every 5 seconds while a
   device is connected) notices it: up to five seconds late, for a card the desktop shows at once.

## What Changes

1. **The session list carries the offer.** Each `Session` in `sessions.list` and `sessions.changed` gains
   `closeOffered: true` while its agent's close of itself is offered; the field is absent otherwise. The main
   process's record of offers is the source, so the desktop and every device read the same fact.
2. **New operation `sessions.keep`** `{ sessionId }` → `{ sessionId }`. It withdraws the offer, with the same
   effect as Keep on the desktop: the desktop's card goes too, and the session keeps running. A session with no
   offer answers with no effect (the state asked for holds, as `sessions.hibernate` does for a dormant
   session). Errors: `NOT_FOUND`, `NO_WINDOW`, `TIMEOUT`, `CREATE_FAILED` (an unexpected failure in the
   interface), `BAD_PARAMS`.
3. **The phone's Close is the existing `sessions.close`**, unchanged. It keeps its idle check: an offered
   session is usually idle (its turn ended), but `in a turn` is not the wait state (`docs/lessons/handoff.md`),
   so a stray subagent event or an open prompt can still make it `SESSION_BUSY`. The phone then follows
   obligation 12 as for any close. Tapping Close on the offer is the user's confirmation for obligation 12.
4. **The offer has one owner, the main process.**
   - The desktop's Keep goes through the main process, which clears its record and tells the interface. The
     interface still clears its card at once, so the desktop does not wait on the round trip.
   - An offer ends with any start or end of the session's process, for every offered session, not only for sessions
     with a waiting command. It is decided by the time of the offer against the session's last process change, so
     no wiring has to remember to clear it.
   - A failed request about an offered session (a parent's rename of it that times out, say) no longer drops its
     offer; only a failed request to show the offer does.
   - Every change to an offer (made, withdrawn by keystroke or by Keep on either side, ended with the process) sends
     `sessions.changed`.
5. **No new attention event.** The turn end that leads to an offer normally already raises a `waiting` attention
   event, unless the user is looking at that session. A second event would notify twice for one
   moment, and a background phone opened by the `waiting` notification fetches the list, which shows the offer.
   The spec states this reason, and the case where it does not hold (a turn that ends in an API error raises no
   `waiting`).
6. **The protocol document and the website's remote-access and handoffs pages (both languages) are updated**: the `Session`
   field, the `sessions.keep` entry, and a client obligation to show Close and Keep on an offered session (Close
   as `sessions.close`, Keep as `sessions.keep`). The protocol stays **version 1**: a new optional field and a
   new operation. An older phone ignores the field (obligation 7) and never shows Keep (obligation 8).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-protocol`: the session list carries the offer; the allow-list gains `sessions.keep`, which withdraws it
  through the desktop's own Keep; `sessions.keep` joins the operations refused without a window; the
  authentication answer's scenario names it.
- `agent-session-control`: the offer is withdrawn by Keep on the desktop **or** from a paired device; the
  record of an offer ends with the session's process whatever ended it; a change to an offer is announced to
  paired devices.
- `remote-notifications`: an offered close raises no attention event of its own, and the requirement says why.

## Impact

- **Code**:
  - `src/main/session-control.ts`: a public withdraw, offers timed against process changes, a change listener,
    a failed request dropping only its own offer;
  - `src/main/remote-protocol.ts` and `remote-host.ts`: the `closeOffered` field and `sessions.keep`;
  - `src/main/index.ts`: wiring (`listChanged` on an offer change, the host's and the Keep message's access to
    `SessionControl`);
  - an IPC channel from the interface's Keep to the main process (`src/main/ipc/handoff.ts`, `src/preload/index.ts`),
    and `probe:shell`'s list of what the `handoff` namespace exposes;
  - `src/renderer/src/shell/terminal/` (`TerminalView.tsx`, `ConversationView.tsx` or `sessions.tsx`): Keep
    goes through the main process.
- **Behavior on the desktop**: none visible. Keep clears the card as before. The website's handoffs page and
  remote-access page (both languages) say the phone can answer the offer.
- **Tests**: unit tests for `SessionControl` and the protocol/host; `probe:shell`'s preload allow-list; a
  `probe:remote` section acting as the
  phone (the field appears, `sessions.keep` withdraws it on both sides, `sessions.close` closes it); a
  `scripts/scenario-coverage.test.mjs` entry.
- **Protocol**: version 1, additive.
- **No new dependency, no new network surface, no new disk location.**
- **Out of scope**: the Android app (a handoff to `spekterm-android` after this change is archived). A prompt
  that reaches the agent with no keystroke (Claude Code's local messaging) starts a turn without withdrawing the
  offer; that is the desktop's behavior today too, and a phone's Close then meets `SESSION_BUSY`.
