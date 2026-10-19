## Why

A paired device can accept an inbox item (`inbox.accept`), and for a third-party body the desktop then fills in
the item's first prompt **and leaves it unsent**: the user's own submit is the one human check `agent-intake`
places between someone else's text and the agent. At the desktop that check is pressing Enter on a prompt the
user can see. From a device it cannot be done at all:

1. **No operation submits the filled-in prompt.** `conversation.send` types its text into the same input box and
   then presses the submit key, so a reply from the phone is sent *together with* the third-party prompt, which
   the phone user never saw.
2. **A device cannot see that a session holds a filled-in prompt.** Only `SESSION_BUSY`'s `reason: "unsent"`
   (hibernate / close) hints at it.

So accepting a Slack mention on the phone either sends the user to the desktop to press Enter, or makes them
reply blind. The companion app's inbox change (`spekterm-android`) is waiting on this protocol gap; the user
decided not to ship a half version there first.

## What Changes

- **The session list says which agent session holds a filled-in prompt waiting for the user**: a new optional
  `prefill` field on `Session` in `sessions.list` / `sessions.changed` — present exactly while the desktop shows
  that session's "not sent" label and the item is still in the inbox — with the prompt's exact text, the inbox item
  it came from, an identity for this fill, and whether the input box may hold more than the prompt (`edited`:
  typed into after the fill, or just before it).
- **A new operation, `sessions.submitPrefill`, writes only the submit key**, so the prompt the desktop filled in
  is sent exactly as the desktop's Enter would send it: the existing "submitted" path then settles the inbox item
  and clears the unsent mark. It is refused — and writes nothing — when no such fill is listed (or it is not the one
  named), when the fill is `edited`, when the agent is not waiting for input (above all when it waits on a choice),
  and with no window.
- **`conversation.send` is refused while a session holds any filled-in prompt whose submission the desktop has
  not seen** (a new error code), edited or not, and the check is repeated before the reply's submit key — so a
  phone reply can never carry an unconfirmed third-party prompt along with it.
- `docs/remote-protocol.md`: the field, the operation, three new error codes, `inbox.accept` rewritten to say how a
  device sends the prompt it left unsent, and a new client obligation: **submit only on the user's explicit action,
  after showing the item's full body and the prompt text as plain text** — the last human check before
  third-party content reaches the agent.
- Protocol version stays 1: a new field, operation and error codes. The one change to existing behavior is the
  `conversation.send` refusal, which an older client sees as an error code it does not know (design D5). An older
  desktop lacks the operation (it is not in `operations`), so a client shows the control only where it is listed.

Not in scope: the Android repository (it builds against the document), exposing the inbox's rejected-delivery
notices or routing rules to a device, and `inbox.accept` submitting by itself (design D1 says why not).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-protocol`: the operation list gains submitting a session's filled-in prompt; the session list carries
  the filled-in prompt; replying is refused while one stands; the no-window refusal covers the new operation; a
  device's inbox accept is followed by an explicit submit, and the document carries the client obligation for it.

`agent-intake` is not modified: a device's submit is the user's own action, taken through `remote-protocol`
(design D6).

## Impact

- `src/main/pty-input.ts` — a per-session keystroke counter.
- `src/main/intake-prefill.ts` — the unconfirmed-submission registry becomes a record per session (text, fill id,
  item, the keystroke count after the desktop's last write, whether text was typed before the fill, whether the
  desktop shows it as pending), with a change signal.
- `src/main/ipc/intake.ts` — passes the item to the prefill.
- `src/main/remote-host.ts`, `src/main/remote-protocol.ts`, `src/main/remote-frames.ts`,
  `src/main/remote-conversation.ts` — the field, the operation, the error codes, the reply refusal.
- `src/main/index.ts` — the session list is re-sent when a prefill appears, is offered, goes, is typed over, or its
  item changes.
- `docs/remote-protocol.md`; `scripts/probe-remote.mjs`; `scripts/scenario-coverage.test.mjs`; the website's remote
  access and inbox pages in both languages.
- No new dependency, no renderer change, no change to what the desktop does when the user presses Enter.
