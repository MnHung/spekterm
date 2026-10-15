## Context

See proposal.md for the problems. The code involved:

- **Conversation projection** (`src/main/transcript-follow.ts`, `project()`): one transcript record in, zero
  or more view events out. Record types are a white-list (`user`, `assistant`). A string-content `user`
  record becomes `{ kind: 'user', meta: r.isMeta === true }`. Events reach the renderer and the remote stream
  unchanged and in file order. `sortKey()` exists but nothing in the view sorts by it.
- **Wait state** (`src/main/agent-events.ts`, `src/main/agent-wait.ts`): hooks write one file per event. The
  hooks are listed in `HOOKED_EVENTS`, and `composeInjection` registers them with matcher `''`. A single
  drainer per session reads the event directory every 400 ms (`drainEvents`), maps each event with
  `nextWaitState`, and computes `pending` from the last event. `foldDrain` stores the result per session.
  `pendingRequestOf()` serves a view that opens later. The conversation view (desktop) and
  `conversation.wait` (remote) both receive `{ state, pending }`.
- **Remote answers** (`src/main/remote-server.ts` `#authenticate`): `{ protocol, server, ...extra }`.
  `RemoteService.state()` already builds the address list for the pairing link: `reachableAddresses()`
  plus the additional address. While a device is connected, a 5 s reconcile timer recomputes the session
  list and sends `sessions.changed` only when it differs.

### Measurements this design relies on

CLI 2.1.300, hooks injected through `--settings` with matcher `''`, driven through a pty. Times are seconds
from launch, one run each unless noted.

| Action | Hook events that followed |
|---|---|
| prompt submitted, text-only answer | `UserPromptSubmit` (+0.6), `Stop` (+4.0) |
| `!echo hi` | `Stop` only |
| `/cost` | none |
| `/clear` | `SessionEnd`, `SessionStart` (no `UserPromptSubmit`) |
| message typed while a tool runs | `UserPromptSubmit` at once, mid-turn |
| message typed during a text-only answer | `UserPromptSubmit` at once; then `Stop`, a second turn, `Stop` 1.8 s later |
| tool needing permission | `PreToolUse`, `PermissionRequest` (+0.2), `Notification`/`permission_prompt` (+6.0 in all five prompts) with no `tool_name` |
| prompt approved, tool fails | `PostToolUseFailure` (not `PostToolUse`), then `Stop` |
| agent service unreachable | `UserPromptSubmit`; after ten retries (+175 s) `StopFailure` (`error: server_error`), no `Stop`; `Notification`/`idle_prompt` 60 s later |
| prompt dismissed with Esc, or answered "No" | nothing in 70 s ("No" shows "Interrupted", like Esc) |
| text-only answer interrupted with Esc | nothing in 70 s |
| question tool (`AskUserQuestion`) | `PreToolUse`, `PermissionRequest`; text + Enter typed into it answered it (`PostToolUse`), no `UserPromptSubmit` |
| after a turn ended (once in five runs) | a `PreToolUse` carrying `agent_id` (a subagent's no-op `true`), with nothing after it |
| text + Enter typed into an open prompt | the prompt was approved (the tool ran); no `UserPromptSubmit` |

What the transcripts record (the experiment's own records, plus a survey of the maintainer's local transcripts):

- A message typed while a tool runs is recorded as
  `{"type":"attachment","uuid","timestamp","attachment":{"type":"queued_command","prompt","source_uuid","delivery_id","commandMode":"prompt","origin":{"kind":"human"}}}`.
  It is written to the file when the agent absorbs the message, after the tool result it rode in with. Its
  timestamp is the submission time. `queue-operation` records accompany it. No `user` record is written.
- A message typed during a text-only answer is an ordinary `user` record with `promptSource: "queued"`.
- About 1,340 local `queued_command` attachments (the count grows as the maintainer works):
  - about 950 have `commandMode: "task-notification"`, and about 130 are `"prompt"` from a human
    (`origin.kind: "human"`);
  - the rest are `"prompt"` from other origins: other sessions (`origin.kind: "peer"`) and one
    `"auto-continuation"`;
  - every `prompt` is a string;
  - none has a `source_uuid` equal to any `user` record's `uuid`.
- String-content `user` records not flagged `isMeta`:
  - typed prompts carry `origin.kind: "human"` and a `promptSource` of `typed`, `queued` or
    `suggestion_accepted`;
  - task notifications carry `promptSource: "system"` and an `origin` whose kind is not `"human"` (1,001
    records). The older ones without an `origin` are flagged `isMeta` already;
  - compaction summaries carry `isCompactSummary: true` and nothing else (72 records);
  - slash commands and `!` input carry neither field.

## Goals / Non-Goals

**Goals:**

- the conversation (desktop and remote) shows every prompt the user typed as the user's, and no longer shows
  task notices or compaction summaries as the user's. Not all of it: `!` command output and local command
  output (`<bash-stdout>`, `<local-command-stdout>`) carry no marker and still show as the user's. That is
  unchanged and out of scope;
- the wait state is busy whenever the agent is producing an answer, and awaiting-choice never outlives a
  choice that the agent reports ending;
- a connected phone always holds the desktop's current addresses.

**Non-Goals:**

- Inferring a denial or an interruption from anything but hook events (spec: stated gaps). The transcript
  does record an interruption, but the wait state is derived from events for every running session, and the
  transcript is followed only while a view watches it. Mixing the two sources is a separate change.
- Ignoring subagent tool events (`agent_id`). A subagent's permission request and the tool event that ends
  it must keep counting, so a filter needs its own design.
- Changing insights (`transcript-extract.ts`). It already drops task-notification markup by text and counts
  compaction summaries separately. It does not count mid-turn messages; that is a separate gap, to be
  turned into an issue at archive time.
- Any change to the Android repository.

## Decisions

### D1. Project `queued_command` only when it is a human prompt

`project()` accepts `type: "attachment"` only when `attachment.type === "queued_command"`,
`commandMode === "prompt"`, `origin.kind === "human"` and `prompt` is a non-blank string. Such a record yields
`{ kind: 'user', uuid: record.uuid, at: record.timestamp, text: prompt, meta: false }`. Every other
attachment yields nothing.

- **The text is not trimmed or rewritten.** The phone and the desktop's "not confirmed yet" label both match
  the entry's text against what was sent. The sent text already went through `encodeInput`'s cleaning, and
  the agent records exactly that.
- **A missing `origin` means not shown.** It is the white-list's failure direction: show less rather than
  show wrong. A peer message or a notice without an origin would otherwise surface as the user's words.
  Every prompt-mode record surveyed has an origin.
- **File order, not timestamp order.** The record sits where the agent absorbed the message, right before
  the answer that addresses it. Sorting by its timestamp would put it among the tool results it interrupted.
  The view and the remote stream both keep file order, so nothing changes there.
- **A non-string `prompt` is not shown.** None was found. A pasted image could make one, and the
  conservative direction is to omit it.
- **A mid-turn notice or peer message is hidden, not shown as context.** When the same kinds of message
  arrive while the agent is idle, they are `user` records and show as context. The difference is accepted:
  the attachment carries the text that was injected into the agent's turn. Showing it means a second
  projection with its own rules for what is safe to render, for content the user did not write and is not
  waiting on. The white-list's direction applies: show less.

Alternative: project `queue-operation` `enqueue` records. Rejected: they have no `uuid`, which remote resume
needs (`afterUuid`). They also include messages that were later removed without being delivered.

### D2. No de-duplication

Over about 1,340 attachments, no `queued_command` delivery was also written as a `user` record: no `source_uuid`
matches a `user` uuid, and the experiment's text-only case wrote only the `user` record. A de-duplicator
would need state across records, which `project()` deliberately does not have, to guard a case that has
never been observed. If a future CLI writes both, the symptom is visible: a message shown twice. That is
safer than the alternative: keying on text would also drop a genuinely repeated message such as "continue".

### D3. The meta rule reads origin fields, and only adds markers

For a string-content `user` record, `meta` is true if any of these holds:

- `isMeta === true`;
- `promptSource === "system"`;
- `origin` is an object whose `kind` is a string other than `"human"`;
- `isCompactSummary === true`.

The rule only adds reasons to mark a record. A record with none of the fields keeps today's verdict, so
older CLI versions and slash commands are unaffected.

Alternative: treat anything without `origin.kind === "human"` as meta. Rejected: slash commands and `!`
input carry no origin and are typed by the user.

### D4. The pending request is carried in `drainEvents`, not patched in `foldDrain`

`drainEvents(sessionId, current, currentPending)` starts from the held request when the current state is
awaiting-choice. Per event:

- if the new state is awaiting-choice and the event names a tool, it replaces the request;
- if the new state is awaiting-choice and the event names no tool, the request is kept. When nothing is held,
  it becomes `{ tool: '', arg: null }` as today;
- any other state clears it.

Every return path returns the held request, not `null`: the empty drain, and the two early returns for a
missing or unreadable event directory. `foldDrain` stores what it is given. `agent-wait.ts`'s `tick` passes
`pendingRequestOf(sessionId)`.

Doing it in `foldDrain` alone would miss the same-batch case: `PermissionRequest` and its `Notification` in
one drain still end with an empty tool. Keeping the rule where events are read means one place decides it.

### D5. `UserPromptSubmit` and `PostToolUseFailure` map to busy, `StopFailure` to ready

All three are added to `HOOKED_EVENTS` and to `nextWaitState`. None reads the current state; that is the
function's existing rule.

- **`StopFailure` is ready, but not a turn completion.** The agent has stopped and waits for input, so
  `ready` is right. `DrainResult.turnEnded` stays tied to `Stop` alone, which leaves the remote attention
  events (`remote-notifications`) as specified. Whether a failed turn should notify the phone is a
  notification question, outside this change.
- **A subagent's `StopFailure` is unknown.** Subagent hook events share the stream (the stray `PreToolUse`
  above carried `agent_id`). Whether a subagent reports `StopFailure` was not measured; the one measured
  carried no `agent_id`. A subagent's failure could arrive while the agent waits on a choice, and ready there
  would allow sending into the prompt. So `parseEvent` also keeps `agent_id` (an identifier, not a path), and
  `StopFailure` with an `agent_id` maps to unknown, which refuses sending. Other events keep ignoring
  `agent_id`, as before.

- **`UserPromptSubmit` while awaiting-choice.** The measurements show the agent does not report a submission
  while a prompt is open: the keys go to the prompt. A phone cannot send then either (`agent-input-bridge`).
  So a submission is a real prompt, and busy is right. It is also the only way out of the Esc blind spot.
- **The hook command's stdout stays empty.** The agent adds a `UserPromptSubmit` hook's stdout to the
  prompt. `EVENT_COMMAND` prints nothing today, and a unit test now pins that. An `echo` added to it later
  would otherwise ride along with every prompt.
- **Downstream of busy.** `UserPromptSubmit` makes busy appear in more places: at the start of every turn,
  and after an interruption (proposal item 4). Busy is read by:
  - the input bridge (it allows sending);
  - auto-hibernation (it hibernates only `ready`);
  - the close confirmation (it counts working agents);
  - the intake and handoff submission check (`isSubmitted`, which now also sees a submission that uses no
    tool, as `docs/lessons/intake.md` said it should);
  - the handoff lifecycle;
  - the phone's session list.

  None of these changes its rule.
- **Matcher `''`.** `UserPromptSubmit` ignores matchers. The injection shape stays uniform, and the
  experiment ran with exactly this shape.
- **The stub agent reports `UserPromptSubmit` on every input line, as the real one does.** It is not an
  option. A probe that never sees the event cannot show it was injected. The stub is shared by
  `probe:agent-view`, `probe:intake`, `probe:remote` and `capture:screenshots`, so all four run after the
  change, along with the intake control groups that depend on busy.
- **New stub options:**
  - `answerSeconds`: after the submission, wait that long before writing the answer and reporting `Stop`,
    with no tool events. That is the text-only answer.
  - `queuedDelivery`: for an input line, write a `queued_command` attachment *instead of* the `user`
    record. Writing both would let the `user` record clear "not confirmed" by itself, and the probe would
    stay green with D1 reverted.

### D6. Addresses: one builder, answered on authentication, compared on the existing reconcile tick

- A single `currentAddresses()` in `RemoteService`, the one `state()` already inlines, feeds the pairing link
  and the answers. `RemoteServer` gains an `addresses: () => string[]` option. `#authenticate` adds
  `addresses` to both answers. The interface reader is injectable for tests.
- Change detection rides the reconcile interval, which runs only while a device is connected: every 5 s,
  compare with the last list sent and send `addresses.changed` `{ addresses }` to every authenticated
  connection when it differs. `setAdditionalAddress` checks at once. The baseline is taken when the first
  device connects; each later connection gets the current list in its answer anyway.
- **The event's name follows §6** (`<thing>.changed`, the complete value, no subscription), but its payload
  is an object `{ addresses }`, and there is no matching operation to call on reconnect: the answer carries
  the list. §6's wording ("the complete list, the shape of the matching operation's result") is rewritten to
  cover both kinds instead of gaining a line it contradicts.
- **Additive means clients ignore what they do not know.** The Android app does: its frame decoder ignores
  unknown keys, and its event dispatch has no catch-all. The document does not say so yet, and §9 gains that
  obligation. Without it, "additive, still version 1" is a promise about one client.
- **`meta` gets defined in the document.** The entry shape in §5 lists `meta` without saying what it means,
  and this change widens it (task notices, compaction summaries). One sentence: `true` when the agent says
  the user did not type it.
- **The protocol document's client advice**: keep the pairing link's list and the latest list received, and
  try the latest first. A laptop moves between networks, and the address it has now is not the only one it
  will have. That advice goes in §1 and §9. Replacing outright would lose the home address while at the
  office.

Alternatives:

- **An `addresses` operation.** Rejected: the answer and the event already deliver it, and an extra operation
  widens the allow-list for nothing.
- **A separate interface-poll timer.** Rejected: a second timer with the same lifetime as the reconcile one.

`remote-protocol-doc.test.mjs` stays on operations. Events are built from a template (`${kind}.changed`), so
a source scan would be a regex over code, which is guessing. `probe:remote` asserts the answer field, and the
document is reviewed by hand.

### D7. Test carriers

- **Unit tests** (`transcript-follow.test.ts`, `agent-events.test.ts`, `agent-wait.test.ts`,
  `remote-server.test.ts`, `remote-service.test.ts`), with fixtures copied from the measured record shapes,
  paths replaced:
  - projection;
  - meta;
  - the event mapping;
  - **the injected hooks, named literally**: `UserPromptSubmit` and `PostToolUseFailure` appear in the
    injection. The existing test compares the injection with `HOOKED_EVENTS` itself, so it stays green when
    an event is dropped from the list. For `PostToolUseFailure` this is the only carrier that turns red when
    the event is not injected;
  - `EVENT_COMMAND` writes nothing to stdout;
  - pending carry: `PermissionRequest` and `Notification` in separate drains, an empty drain between them,
    the same batch, and the early-return paths;
  - answers and the change event, with an injected address source. The broadcast case uses one
    authenticated socket and one socket that has not sent `hello` yet. The second must receive no frame;
    a refused socket closes before any change could happen, so it cannot tell the two wrong
    implementations apart.
- **`probe:agent-view`**:
  - the text-only busy indicator (stub `answerSeconds`). The busy probe today uses `PreToolUse`, so it never
    covered the text-only case;
  - a mid-turn delivery (stub `queuedDelivery`, no `user` record), shown as the user's message and clearing
    "not confirmed";
  - a task-notification record shown as not the user's.
- **`probe:remote`**: `addresses` on the `hello` answer ends with the seeded additional address.
- Each scenario is registered in `scenario-coverage.test.mjs`, with the mutation that turns it red. Each probe
  assertion is checked against its mutation once.

## Risks / Trade-offs

- [A future CLI renames `queued_command`, `commandMode` or `origin`] → mid-turn messages vanish again. That
  is the white-list's failure direction: silent but harmless. `docs/lessons/transcript.md` records the shapes
  so the next person knows where to look.
- [A future CLI reports `UserPromptSubmit` while a prompt is open] → the state would leave awaiting-choice
  and allow sending into the prompt. The measurement in the table above is the only defense. It is recorded
  in the lessons file next to the injection rule, with the instruction to re-measure on a CLI upgrade that
  touches hooks.
- [Rotating IPv6 temporary addresses] → `addresses.changed` fires when they rotate, about daily. The event is
  small and idempotent, so this is accepted.
- [The address list cannot help when no path reaches the desktop] → stated in the protocol document and the
  website. The phone learns the new list on its next connection over any route: Tailscale, the additional
  address, or the old address if it comes back.
- [The stub now reports `UserPromptSubmit` on every line] → a section that asserts a state right after a
  send may see busy before ready. The intake submission check may also now settle where it never did. Every
  user of the stub runs once after the change (`probe:agent-view`, `probe:intake` with its control groups,
  `probe:remote`, `capture:screenshots`). The lessons that say the default stub never leaves ready are
  updated.
- [An interrupted turn reads busy] → accepted, see the proposal (item 4) and the spec's known gaps.
