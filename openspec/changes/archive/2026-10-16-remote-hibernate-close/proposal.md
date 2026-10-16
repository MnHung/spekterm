## Why

The companion Android app gives every listed session a menu, opened by a long press on its row or by "⋮" on
the session's screen. Today the menu holds one action, "Rename" (`sessions.rename`). The maintainer wants it to
hold three: **rename, hibernate, close**. The desktop has all three. The remote protocol offers only rename:
`docs/remote-protocol.md` §5 says closing or hibernating sessions is not offered to a paired device. The phone
side follows in its own repository (`spekterm-android`) once the desktop offers both operations.

Reading the paths these operations would reuse turned up three things the protocol leaves undefined or gets
wrong today, whoever ends a session:

1. **A watched conversation is never told that its session ended.** When the session is closed, hibernated or
   exits on its own, the phone's conversation watch keeps following a session that no longer runs. Only a
   window reload ends it (`conversation.ended`, reason `window`).
2. **A watched terminal is told `exited` for everything.** A close, a hibernation and a process that exited on
   its own all arrive as `terminal.ended { reason: "exited" }`. So the phone cannot tell "dormant, wake it"
   from "gone".
3. **Hibernating or closing the displayed session would take the desktop's keyboard focus.** The terminal view
   focuses its Wake button when its session becomes dormant. It also focuses a terminal that becomes displayed
   because the displayed session was closed. Both are right when the user did it at the desktop. From a phone
   they move focus away from whatever the user is typing into there, which breaks the protocol's "never takes
   the desktop" rule.

## What Changes

1. **New operation `sessions.hibernate`** `{ sessionId, force? }` → `{ sessionId }`. It runs the desktop's own
   hibernation: the process ends, and the session stays dormant, persisted, and wakeable with `sessions.wake`.
   A dormant session answers at once, with no effect.
2. **New operation `sessions.close`** `{ sessionId, force? }` → `{ sessionId }`. It runs the desktop's own close:
   the session leaves the workspace and its persistence, its attachments are removed, and a handoff-created
   session ends as one closed on the desktop does. A dormant session is closed with no further check.
3. **A session that is not idle is refused unless the device forces it.** The new error `SESSION_BUSY` carries
   `detail.reason`:
   - `working`: the agent is working;
   - `choice`: the agent waits on a choice;
   - `unsent`: a filled-in prompt is not yet confirmed;
   - `job`: the shell runs a command;
   - `unknown`: idleness cannot be established.

   The test is the same one automatic hibernation uses, minus the displayed and idle-time conditions. It moves
   into one shared function so the two cannot drift. With `force: true` the operation proceeds, as the
   desktop's own manual action always does. The phone shows the reason and asks before forcing. The desktop's
   own manual hibernate and close are unchanged: they never ask.
4. **Both are carried out quietly.** They do not change the rail selection. They do not take keyboard focus,
   and that includes the Wake button of a session hibernated while displayed and the session displayed in
   place of a closed one. This uses a new hold on focus that lasts exactly one render commit. The existing
   quiet-arrival mark can linger, so it is not used. Closing the displayed session still changes what the desktop displays; nothing else
   can be shown in its place.
5. **Watches end with the reason, whoever ended the session.**
   - `terminal.ended.reason` gains `hibernated` and `closed`. `exited` now means only a process that exited on
     its own.
   - `conversation.ended.reason` gains `exited`, `hibernated` and `closed`.

   This applies to an end caused by the user at the desktop or by the process itself, not only to one a
   device requested. Automatic hibernation never takes a watched session. A conversation watch that ends also
   clears its "displayed" report, so a session hibernated while watched hibernates automatically again once
   woken.
6. **Both are listed in `operations`**, with errors `NOT_FOUND`, `NO_WINDOW`, `TIMEOUT`, `SESSION_BUSY`,
   `BAD_PARAMS` and `CREATE_FAILED` (an unexpected failure in the interface). Both
   are refused without a window, like the other session operations. The result reaches clients through
   `sessions.changed`.
7. **The protocol document and the website's remote-access page (both languages) are updated.** In the
   document: the §5 opening, two operation entries, the new error code, the new reasons, a client obligation
   to confirm before forcing or closing, and obligation 7 extended to new values of known fields (the released
   phone reads every `conversation.ended` as "no window"). The protocol stays **version 1**: all of it is new
   operations, an error code and event values.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-protocol`:
  - the operation allow-list gains hibernating and closing;
  - a device's hibernation and close follow the desktop's paths, quietly;
  - a session that is not idle is refused unless forced;
  - watches end with the reason the session ended;
  - hibernating and closing join the operations refused without a window;
  - the authentication answer's scenario names the new operations.
- `session-hibernation`: a paired device can request a hibernation; a device's request that does not insist
  is refused for a session that is not idle. The test for "not idle" is defined once, for automatic
  hibernation and a device's request alike.

## Impact

- **Code**:
  - `src/main/hibernation-policy.ts`: the shared "why this session is not idle" function;
  - `src/main/remote-protocol.ts` and `remote-host.ts`: the operations, the busy check and the host actions;
  - `src/main/remote-frames.ts`: `SESSION_BUSY`;
  - `src/main/remote-output.ts`, `remote-service.ts`, `ipc/terminal.ts` and `index.ts`: the end reason of a
    session, carried to watches;
  - `src/preload/index.ts`: `narrowRemoteAction` passes the two kinds;
  - `src/renderer/src/shell/remote/RemoteRequests.tsx`, `terminal/sessions.tsx` and `TerminalView.tsx`: the
    quiet hibernate and close.
- **Behavior on the desktop**: none for the desktop's own actions. A phone watching a session now learns that
  the session was closed or hibernated on the desktop.
- **Tests**:
  - unit tests for the policy function, the protocol, the host and the output reasons;
  - a `probe:remote` section that acts as the client;
  - a `scripts/scenario-coverage.test.mjs` entry.
- **Protocol**: version 1, additive. An older phone never shows the controls (obligation 8), and it ignores
  reasons it does not know.
- **No new dependency, no new network surface, no new disk location.**
- **Out of scope**: the Android app (a handoff to `spekterm-android` after this change is applied). Closing
  several sessions at once. "Close completed handoffs" from a device.
