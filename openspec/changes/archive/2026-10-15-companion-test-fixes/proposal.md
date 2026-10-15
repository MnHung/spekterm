## Why

The Android companion app was tested against spekterm on 2026-10-14/15 (Claude Code CLI 2.1.300). The
testing found five problems on spekterm's side.

Four are defects in how spekterm reads an agent. None is phone-specific: the desktop's conversation view and
wait state show each one. Each makes the conversation view or the wait state say something untrue, and the
phone and the desktop act on both:

1. **A message typed while the agent runs tools never appears in the conversation.** The agent receives and
   answers it, but the conversation shows the answer with no question.
2. **A permission prompt loses its tool.** The view first says which tool is asking, then a bare "asks for a
   choice".
3. **Background-task completion notices appear as the user's own message**, with their raw markup.
4. **An agent writing a text-only answer is shown as ready for input**, not busy. The existing scenario
   "busy while the agent has not reported idle after the user sent a message" (`agent-conversation-view`) is
   not met.

Verifying them against a real agent found two more gaps in the same state machine (items 5 and 6 below).

The fifth problem is in the remote protocol. **A paired phone never learns the desktop's new addresses.**
It knows them only from the pairing link (`docs/remote-protocol.md` §1). The `hello` answer (§4) carries only
the protocol version and the server's name and version. On 2026-10-15 the desktop's LAN address changed under
an existing pairing, after a DHCP change. The phone could not reach it directly, and connected again only
over Tailscale. The user's remedies today are to pair again, reserve the address in the router, or enter a
stable extra address on the desktop. Each one works around something spekterm could simply tell the phone.

## What Changes

Items 1 to 6 were checked against the code and a real agent. The agent ran on CLI 2.1.300, with hooks
injected through `--settings`, driven through a pty. Local transcripts were surveyed for record shapes.

1. **A message delivered mid-turn becomes a user entry.** The CLI records a message typed while tools run as
   an `attachment` record of subtype `queued_command`, not as a `user` record. The conversation follower
   projects that subtype as a user entry, text verbatim, with the record's own id and time.
   - Only a human prompt counts. The same subtype also carries background-task notices
     (`commandMode: "task-notification"`) and messages from other sessions (`origin.kind: "peer"`).
   - Record types stay a white-list: one record subtype is added, not the `attachment` type as a whole.
   - A message typed during a text-only answer is still an ordinary `user` record
     (`promptSource: "queued"`), and it already shows.
   - Across about 1,340 local `queued_command` records, no delivery was also written as a `user` record.
2. **A pending choice keeps its tool until the choice ends.** It has two causes.
   - The finding named one: the permission prompt's `Notification` arrives about 6 s after
     `PermissionRequest` (6.0 s in all five measured prompts) and names no tool. Today it replaces the held request
     with an empty one.
   - The second cause was not in the finding: every drain that reads no events also resets the held request
     to none. Drains run every 400 ms, so a conversation view opened while a prompt is up never shows the
     tool.

   The fix: while the state stays awaiting-choice, an event that names no tool, or no event at all, keeps the
   held request.
3. **System-originated user records are not the user's.** Today a user record is marked as not typed by the
   user only when it says so (`isMeta`). It is now also marked when it says it came from the system
   (`promptSource: "system"`) or from a non-human origin (`origin.kind` present and not `"human"`).
   - Locally, all 1,001 task-notification records not flagged `isMeta` carry `promptSource: "system"`.
   - Every typed prompt carries `origin.kind: "human"`, with `promptSource` `typed`, `queued` or
     `suggestion_accepted`.
   - Records with neither field keep today's rule: older CLI versions, slash commands and `!` input.
   - Found while surveying: the summary the CLI writes when it compacts a conversation is a `user` record
     with `isCompactSummary: true` and no other flag (72 records locally). Today it too shows under "You".
     It is marked the same way.
4. **Submitting a prompt makes the agent busy.** spekterm injects the `UserPromptSubmit` hook and maps it to
   busy. Measured:
   - it fires at submission, including mid-turn and during a text-only answer;
   - it does not fire for `!` commands, `/cost` or `/clear`, so no local command leaves the state stuck on
     busy;
   - text typed into an open permission prompt does not fire it either (the text plus Enter answers the
     prompt), so it cannot move the state out of awaiting-choice while a prompt is open.

   **Known remaining gaps:**
   - A message queued during a text-only answer fires its hook at submission. When the first answer ends,
     the state reads ready until the agent starts answering the queued message (measured 1.8 s).
   - **An interrupted turn stays busy.** Interrupting with Esc sends no event (measured: none in 70 s). Today
     an interrupted text-only answer happens to read ready, because nothing ever set busy. After this change
     it reads busy until the next event, usually the next prompt. An interrupted turn that used tools already
     behaves this way. Busy still allows sending, so no reply is blocked. But an interrupted session is not
     hibernated automatically, and the close confirmation, the handoff state and the phone's session list all
     show it as working. That is accepted: answers are far more common than interruptions, and today every
     text-only answer shows the wrong state.
   - A subagent's tool event can arrive after the turn ended (seen once in five runs: a `PreToolUse` with an
     `agent_id` after `Stop`). The state then reads busy until the next event. This is not changed: a
     subagent's permission request must still count as awaiting-choice.
5. **A failed tool leaves the choice state** (found while verifying). An approved tool that fails sends
   `PostToolUseFailure`, not `PostToolUse`. The state then stays awaiting-choice until the turn ends, and a
   reply cannot be sent meanwhile. spekterm injects `PostToolUseFailure` and maps it to busy. Likewise, a
   turn whose requests keep failing ends with `StopFailure`, not `Stop` (measured: after ten retries, about
   three minutes). spekterm injects it and maps it to ready.
6. **Not fixed, recorded: denying a prompt sends no event at all** (found while verifying), by Esc or by
   choosing "No".
   - In 70 s nothing arrived: no `Stop`, no idle notification.
   - The state stays awaiting-choice until the next submitted prompt.
   - With item 4, typing in the terminal recovers it. A phone cannot, because sending is refused while
     awaiting-choice.
   - Hooks offer nothing to observe the denial, so the gap goes into the spec as a known limitation.
7. **An authenticated connection learns the desktop's current addresses.**
   - The `hello` answer carries `addresses`, built the same way as the pairing link's `a` list:
     non-loopback interface addresses, IPv4 first, then non-link-local IPv6, then the user's additional address if
     one is set.
   - The `pair` answer carries it too, because a pairing connection is also authenticated.
   - When the list changes while a device is connected, every authenticated connection receives an
     `addresses.changed` event with the whole list, like the existing list events (§6). Node has no
     network-change event, so a change is detected by polling the interfaces. The interval is a design
     decision.
   - **Additive, so the protocol stays version 1.** A client that ignores the new field and event behaves as
     today. The protocol document states the field, the event, and that the client keeps the list with the
     pairing, as it keeps the link's list.
   - **It is safe because it follows authentication.** Only a connection that has authenticated receives
     the addresses, so an unauthenticated connection learns nothing new. The certificate pin is unchanged,
     so a new address cannot make the phone trust another machine.

Considered and not changed: a background command produces two "waiting" attention events. The first comes
when the agent ends its turn after starting the command, the second when it answers the completion notice.
The first is not premature: the agent is waiting for input then.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-transcript-stream`: the record white-list gains the mid-turn user message, a subtype of one more
  record type. Whether a record was typed by the user is decided from its origin fields as well as `isMeta`.
- `agent-event-bridge`:
  - the injected events gain prompt submission and tool failure (busy) and a failed turn (ready);
  - a pending choice keeps its tool while the state stays awaiting-choice;
  - the denial and interruption gaps are stated.
- `remote-protocol`: the `hello` and `pair` answers carry the current addresses. A list event announces a
  change, and the protocol document states both.

## Impact

- **Main process:**
  - `transcript-follow.ts`: projection of `queued_command` and the meta rule;
  - `agent-events.ts`: `HOOKED_EVENTS` and `nextWaitState`;
  - `agent-wait.ts` (`foldDrain`): keeping the pending request;
  - `remote-service.ts`: `reachableAddresses()` and the additional address are already combined for the
    pairing link. The same list feeds the answers, and a change detector compares it over time;
  - `remote-server.ts` / `remote-protocol.ts`: the answer shape and the event.
- **Unchanged:**
  - the renderer's conversation view, which already labels meta entries;
  - the existing frame shapes of the remote protocol. Item 7 only adds a field and an event;
  - insights (`transcript-extract.ts`), which already strips task-notification markup by text. That it does
    not count mid-turn messages is noted in the design as a separate gap.
- **Tests:**
  - unit tests:
    - the projection, with fixtures shaped like the measured records;
    - the meta rule;
    - `PermissionRequest` and `Notification` landing in separate drains, with an empty drain between them;
    - the address answer and change detection;
  - the stub agent and `probe:agent-view` gain the new hook events where a scenario needs a carrier;
  - `probe:remote` asserts the address field on `hello`;
  - `scenario-coverage.test.mjs` registers the change. Whether `remote-protocol-doc.test.mjs` should also
    cover events (today it checks only operations) is a design question.
- **Docs:**
  - `docs/remote-protocol.md`: §4 (the answers) and §6 (the event);
  - `docs/lessons/transcript.md`: the new record shapes and the hook measurements;
  - the website's conversation-view and remote access pages in both languages, where they describe the busy
    state or re-pairing after an address change.
- **Android:** adopting the address field and event, and dropping the workaround for item 2, belong to the
  Android app's own later change. That repository is not touched here. The final wire shape and protocol doc
  sections go into the completion report.
