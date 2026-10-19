## Context

When an inbox item is accepted — at the desktop or with `inbox.accept` — the renderer creates (or reuses) the
session and reports it (`workspace:intake:attach`). The main process then writes the context file and schedules
the prefill (`schedulePrefill`): at the session's first `ready` it writes the prompt into the agent's input box
(at once when the session is already ready — a reused one), and for a first-party body (an agent's handoff) the
submit key 500 ms later. `watchSubmission` then waits for the agent to start working (`isSubmitted`: `busy` or
`awaiting-choice`) and, when it does, tells the renderer `sent` and **settles** the item, so it leaves the inbox.
For a first-party body it shows the desktop's "pending" label only if no start is seen within `SUBMIT_CONFIRM_MS`
(10 s). `intake-prefill.ts` keeps a set of sessions whose submission is not confirmed (`unconfirmed`), read only by
hibernation (`busyReason` → `unsent`). `watchSubmission`'s subscription lives until it sees the start, and its
settle does not depend on the renderer being alive (`ipc/intake.ts`, outside the `sender.isDestroyed()` guards).

None of this knows who pressed Enter. That is the point this change builds on: if a device writes the submit key
into a session holding the filled-in prompt, everything after it — the renderer's label, the settle, the unsent
mark — already happens through the desktop's own path.

What a device lacks is (a) knowing that a session holds such a prompt, and (b) an operation that writes only the
submit key, with the checks that make it the user's Enter and nothing else. `conversation.send` is not that: it
types text first, so a phone reply into a prefilled session sends the third-party prompt with the reply appended.

Constraints carried in: the protocol stays version 1 and grows only by additions (obligation 7); a device's
operations are one allow-list that the document must match (`OPERATIONS`, `scripts/remote-protocol-doc.test.mjs`);
a device never submits into a choice (`conversation.send`'s `filled-not-submitted`, `conversation.answer`'s "no
answer contains the submit key"); third-party content reaches the agent only after a human check
(`agent-intake`, and obligation 2 for a device's accept).

## Goals / Non-Goals

**Goals:**

- A device can tell which agent session holds a filled-in prompt waiting for the user, and read its exact text and
  the inbox item it came from.
- A device can send that prompt with one operation that writes only the submit key, under checks at least as
  strict as the desktop's Enter, and whose success is followed by the same settle and mark-clearing.
- **No device reply is ever submitted together with a filled-in prompt nobody confirmed.**
- The protocol document states the client's human check before that submit.

**Non-Goals:**

- Changing the Android app (it builds against the document).
- Exposing rejected-delivery notices or routing rules to a device.
- Any change to the desktop's own Enter, its "pending" label, or the prefill timing.
- Re-sending a prompt after a restart: a filled-in prompt lives in the pty and dies with it (`agent-intake`, item 4
  of "已開好的項目只在它的本文仍需要被看時呈現於收件匣"); there is nothing to submit after one.
- Fixing `isSubmitted`'s reading of `awaiting-choice` as a submission (Risks); it is reported separately.

## Decisions

### D1 — A separate operation, not `inbox.accept { submit: true }`

The alternative folds the submit into the accept. Rejected, for three reasons, the first decisive:

1. **The accept usually answers before the prompt exists.** `inbox.accept` resolves when the renderer has created
   the session and reported it; for a new session the prompt is written later, at the agent's first `ready` — up to
   30 s later, or never (the prefill timeout returns the item to pending). A `submit: true` would therefore be a
   standing instruction the desktop carries out on its own, later, into a session the device user is not looking at,
   with no answer to say whether it happened: the automatic submission of a third-party body that `agent-intake`
   forbids, with a device's flag in front of it. (A reused session that is already ready is filled inside the
   attach, before the accept answers; that does not make a flag safer, it only removes the delay.)
2. **It merges two checks into one.** The desktop separates "read the body, choose the folder, accept" from "see
   the prompt in the input box, press Enter". A client may still show both on one screen (obligation 16 allows it),
   but the protocol should not make the second unreachable.
3. **It cannot answer "is the box holding only the prompt?"** A reused session may hold text the user typed before
   the fill, or receive keys after it. A separate operation is checked at the moment of the key, against a record
   that knows both (D4); a flag given before the fill is not.

A separate operation also serves a case accept cannot: a first-party handoff whose desktop-written submit key did
not take (measured 1/13, `docs/lessons/handoff.md` §13) falls back to "pending" — and the device can now send it.

### D2 — The fact lives on the session, not on the inbox item

`prefill` is a field of `Session` in `sessions.list` / `sessions.changed`:

```
prefill?: { id: string, text: string, intake: { adapter: string, id: string }, edited: boolean }
```

- **Why the session**: the fact is a pty fact (what sits in this session's input box), the operation addresses a
  session, and `edited` changes on keystrokes, which concern a session and never the inbox list. The inbox item
  already links the other way (`Item.sessionId`); `prefill.intake` makes the link explicit from this side, so the
  client finds the body to show (obligation 16) without guessing.
- **Present exactly while all of these hold** — one predicate, `listedPrefill(sessionId)`, shared by the field and
  the operation's first check:
  1. the session is a running agent session with a prefill record (D4);
  2. **the desktop shows its "pending" label** for it: a third-party (fill-mode) prompt from the moment it is written;
     a first-party (submit-mode) prompt only once `watchSubmission` fell back to "pending" (`SUBMIT_CONFIRM_MS`
     without a start). Before that the desktop is still waiting on its own key, and a device offering a second
     Enter would race it. The field is the device's view of that same label;
  3. the record's item is still listed for that session: the intake record is `accepted`, its `sessionId` is this
     session, and it is not settled. The desktop's "clear" settles an item without touching the pty; after it the
     client could no longer show the body, so the human check of obligation 16 is impossible and the field goes.
- `id`: a fresh random id per fill. **Why**, given that one session is filled at most once per accept
  (`schedulePrefill` has one caller, the attach, and a timed-out prefill wrote nothing): it ties the device's submit
  to the list it showed the user. A list that is stale on the phone — the item was cleared and accepted again into
  the same folder, which reuses the session and fills it anew — must not be submitted on the strength of the old
  one.
- `text`: exactly what the desktop wrote before any submit key — `encodePrefill(prompt)`. Not the body: the body is
  the item's (`inbox.list`), and the client shows both.
- `edited`: **the input box may hold more than `text`** (D4) — something was typed into the session after the fill,
  or since the agent's last turn end before it. Only the desktop can show what is there then.

**Is it safe to send `text` to a device?** It contains the context file's absolute path (under the user data
directory) and the nonce. Neither is new to a device: `terminal.watch` already streams the agent's screen, input
box included, and `conversation.send`'s `r.text` already carries desktop paths. The nonce defends the fence against
the *body's author*, who never sees the session list; a paired device has the user's power already (section 5).

### D3 — `sessions.submitPrefill`: the checks, then one key

`p`: `{ "sessionId", "prefillId" }` → `r`: `{ "outcome": "confirmed" | "sent" }`

In order, each failing check writing nothing:

| Check | Error |
|---|---|
| `sessionId` / `prefillId` are non-empty strings | `BAD_PARAMS` |
| a window exists | `NO_WINDOW` |
| the session exists and has a running process | `NOT_FOUND` |
| *inside the session's queue, from here on:* `listedPrefill` (D2) is present and its `id` is `prefillId` | `PREFILL_GONE` |
| `edited` is false | `PREFILL_EDITED` |
| after draining the agent's events now (`refreshWait`), the wait state is `ready` **and** `listedPrefill` is still the same fill | `WAIT_STATE` with `detail.state`, or `PREFILL_GONE` |

- **Only `ready`.** `awaiting-choice` would make the key pick the prompt's default (`conversation.send`'s rule);
  `busy` means the agent already started; `unknown` means the desktop cannot tell. **In practice a choice reaches a
  device as `PREFILL_GONE`**: `isSubmitted` counts `awaiting-choice` as "started", so once the choice is drained
  `watchSubmission` settles the item and removes the record. `WAIT_STATE` answers only a choice the periodic drain
  has not reached yet and `refreshWait` reveals. Both write nothing; the spec states both, and the deterministic
  carrier for `WAIT_STATE` is a unit test with injected waits.
- **Queued with the session's replies and answers** (`runQueued`), and the checks after the first three run inside
  the queued job, so a reply or answer written just before cannot slip between check and key. The re-read after
  `refreshWait` covers the drain itself removing the record.
- **The key is `\r`, written alone**, with the ordinary origin: it is a keystroke, and other paths (a device's
  prompt answers, `inTurnOf`) must see it as one. The record's baseline (D4) is moved past it at once, synchronously,
  so the device's own key does not mark the fill `edited`: if the key did not take, the same operation can be sent
  again. (The session list is debounced and computed when sent, so the instant between the write and the baseline
  move is never broadcast.)
- **Outcome**: `confirmed` when the agent starts working (`isSubmitted`) within 3 seconds; `sent` otherwise — the key
  was written and nothing else is known, and the prefill stays listed. `isSubmitted` on the wait snapshots, not the
  record's disappearance, so the answer does not depend on the order of two subscribers of one snapshot.
- **The settle is not this operation's.** The existing `watchSubmission` subscriber sees the same start and settles
  the item, tells the renderer `sent`, and removes the record — exactly what the desktop's Enter causes.

New error codes, stable strings: `PREFILL_GONE` (no such fill is listed now: sent, replaced, its item cleared, the
session ended, or never filled), `PREFILL_EDITED` (the box may hold more than the prompt; send it at the desktop),
and `PREFILL_PENDING` (D5).

### D4 — The registry becomes a record per session, and "typed" is counted, not timed

`unconfirmed: Set<string>` becomes `Map<string, PrefillRecord>`:

```
PrefillRecord { id, text, intake: { adapter, id }, seq: number, typedBefore: boolean, offered: boolean }
```

- **A per-session keystroke counter in `pty-input.ts`** (`keystrokeSeq(sessionId)`), incremented by `noteWrite`
  under exactly today's definition of a keystroke (every write except a device answer's keys and terminal reports).
  `edited` = `typedBefore || keystrokeSeq(sessionId) > record.seq`. A counter instead of wall-clock ms: a key that
  arrives in the same millisecond as the fill is still counted (the dangerous direction is missing one), a clock
  step cannot hide one, and the test's control group is deterministic.
- **Set by `fill()` right after the text write**: `seq` = the counter after the write (the write's own increment is
  the fill's, not the user's); `typedBefore` = a keystroke happened, **read before the fill's write**, at any time
  since the session's current process started (the terminal service's spawn time; unknown ⇒ any keystroke at all
  counts). This is the reused session the code itself warns about (`prefillModeFor`'s comment): text typed into the
  box before the prompt lands in front of it. **No turn boundary is used**, deliberately: `SessionStart` ends a turn
  (`inTurnOf`), so keys typed after the TUI came up but before the agent reported its start would not count; and a
  `Stop` does not empty the box either — text typed during a turn without Enter is still there after it. No event
  says "the input box is empty", so the rule is the conservative one: for a new session (a device's accept, nearly
  always) only the user's own typing before the fill counts, and a reused session that was typed into at all is
  `edited` — to be finished at the desktop. The spawn time is what excludes a previous process's keys:
  `lastKeystrokeAt` is never forgotten (`forgetInput` has no caller). `offered` = true in fill mode.
- **Moved past the desktop's own keys**: the desktop's submit key in submit mode, and a device's key
  (`notePrefillKey`), set `seq` to the counter after their write.
- **`offered` in submit mode** becomes true in `watchSubmission`'s fallback (`showPending`), the moment the desktop
  shows its label (D2.2).
- `hasUnconfirmedSubmission` keeps its meaning (any record) — hibernation's `unsent` is unchanged.
- Removed where the set entry is removed today (`watchSubmission` on a start, `forgetSubmission` on session end).
- `schedulePrefill` takes the item (`{ adapter, id }`) — `ipc/intake.ts` has it at the attach.
- **Change signal**: `onPrefillChange` fires on set, removal and `offered` becoming true. `index.ts` sends the
  session list (`remoteService.listChanged('sessions')`) on it, on every keystroke into a session that has a record
  (`onKeystroke` — today that listener only pokes an open prompt, so `edited` would otherwise reach a device only on
  the next 5-second reconcile), and on an inbox change (D2.3 reads the intake record). The wiring is a small
  exported function, so a unit test can show each signal reaching `listChanged`.

### D5 — `conversation.send` is refused while any prefill record stands

While the session has a prefill record — offered or not, edited or not — `conversation.send` answers
`PREFILL_PENDING`, with `detail.prefillId` when one is listed and `detail.edited`, and writes nothing. The check runs
three times: before anything is reserved, again at the start of the queued job, and again just before the submit
key; at the last one a record that appeared during the 500 ms delay (a reused, ready session filled meanwhile)
withholds the key and the reply is `filled-not-submitted`, as for a choice.

**Why not only while the fill is untouched**: a box that was typed into still holds the third-party prompt, which
the desktop user's keys did not approve; and `edited` rests on a heuristic (a terminal report the filter does not
know — the cursor-position answer is left out on purpose — reads as a keystroke), so a refusal that lifts on
`edited` could lift silently. The refusal is tied to the one fact that matters: an unconfirmed third-party prompt
is in the box.

**The cost**: a session whose prompt the user deleted at the desktop and never replaced keeps its record (it clears
on the agent's next start or the session's end), and the phone cannot reply to it until then. The phone still has
`terminal.input`, and hibernating with `force` (its `unsent` reason) then waking ends the record with the process.
This **changes an existing operation**: an older client gets a code it does not know and shows the message —
strictly better than submitting a body nobody approved. `terminal.input` stays ungated: raw keys, by the user's
choice, shown with the terminal they type into.

### D6 — The document, and the specs it touches

- `docs/remote-protocol.md`: §3 error table — the three codes, and `WAIT_STATE`'s meaning widened to "a reply or a
  submit"; §4 — `sessions.submitPrefill` joins the operations an older desktop lacks; §5 `sessions.list` — the
  `prefill` field; a new `### \`sessions.submitPrefill\``; `conversation.send` — the `PREFILL_PENDING` refusal;
  `inbox.accept` — rewritten: for a third-party body the prompt is filled in once the agent is ready and left unsent,
  it then appears as the session's `prefill`, and the device sends it with `sessions.submitPrefill` after obligation
  16; a first-party body is submitted by the desktop, and only if that does not take does it show as `prefill`.
- §9 new obligation **16**: submit a filled-in prompt only on the user's explicit action for that session, after
  showing — on that screen or the one just before — the full body of the item named by `prefill.intake` (from
  `inbox.list`) and `prefill.text`, both as plain text; never as part of accepting, never automatically, never from
  a notification action. Show `edited: true` as "finish at the desktop", not as a send control. On `sent`, say the
  desktop has not seen the agent start yet. The server already refuses an item that is no longer listed.
- **The duplicate "14" in §9 is not renumbered.** Two obligations carry 14 today (scheduled items, OpenSpec text),
  and other text — the Android change among it — cites them by number. The new one is 16, the next unused number.
- `remote-protocol` spec: the operation list, the session list's enumeration of fields, and the no-window list of
  refused operations each gain the new item, besides the new requirement and the reply refusal.
- **`agent-intake` is not modified.** Its rule is that a third-party prompt is submitted by the user, never by the
  system; a device's submit is the user's own action, taken through `remote-protocol`, which is where the checks and
  the client obligation live. `agent-intake` already defers the device's accept the same way (obligation 2).
- The website's remote access and inbox pages (both languages) say how a phone sends an accepted item's prompt.

## Risks / Trade-offs

- **`isSubmitted` counts `awaiting-choice` as a submission** (existing). In a reused session where a background
  subagent raises a permission prompt after the fill, the item is settled and leaves the inbox while the prompt
  still sits unsent. This change makes it visible to a device (the field goes, `PREFILL_GONE`) but does not fix
  it; it is reported as its own issue, since narrowing `isSubmitted` changes the desktop's settle too.
- **`busy` and the next `ready` in one drained batch** → the start is never seen, the item is not settled, and the
  device gets `sent` instead of `confirmed`; the record stays, and for a first-party handoff the field appears
  after 10 s. This is the existing `watchSubmission` property, the same for the desktop's Enter; a real agent's first
  turn reads the context file and takes far longer than one 400 ms drain. The probe's stub agents stay busy for a
  few seconds wherever this matters (including the handoff part, task 5.3), so they show the path, not this race.
  **D5 makes this worse**: the record then never clears, so phone replies to that session stay refused
  (`PREFILL_PENDING`) although the prompt was sent — a first-party handoff's child is the likeliest case. The escapes
  are D5's: `terminal.input`, or a forced hibernation and a wake.
- **`edited` is only as good as the terminal-report filter** (`isTerminalReport`). Found in the Android side's
  verification: a fresh third-party prompt read as edited, because CLI 2.1.303's DECRQM queries are answered by
  xterm.js into the pty (one of them after the fill), and the filter did not know DECRPM. Fixed by adding DECRPM to the
  filter, with the stub agent's `queryModes` as the probe carrier (`docs/lessons/transcript.md`, "Turn boundaries").
  A new kind of answer from a later CLI fails the same way — towards "edited", the safe direction: the phone shows
  "finish at the desktop" instead of a send control.
- **A record that never clears** blocks phone replies (D5's cost) and lists `edited: true`.
- **The key does not take** → `sent`, the prefill still listed and not `edited`; the user may send again. A second
  key into an agent that did start but reported it late lands in a busy agent's input with nothing typed. Not
  measured; recorded as the reason `sent` is not retried automatically.
- **No carrier for obligation 16** in this repository, as for obligation 2: it falls to the client.

## Migration Plan

None. The field and the operation are new; an older client ignores the field and does not have the control. The
one behavior change (D5) needs no data migration.

## Open Questions

None blocking. Whether Claude Code ignores an empty submit while busy (the `sent`-then-retry case) is unmeasured;
it does not change the design, only how a client words `sent`.
