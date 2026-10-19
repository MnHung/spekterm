## Why

A change often takes days to finish: the last tasks wait on a deploy, on data piling up, on a review. The
session that knows what is left cannot stay open that long, and nothing in spekterm can start work later — a
handoff opens its session the moment it arrives. A handoff with a time on it closes that gap: "now" is
today's handoff, a later time is the same handoff, waiting.

Scheduling also sharpens a gap the handoff source already documents: **an agent never learns what became of
its delivery** (`agent-handoff-source`, "agent 得不到投遞結果的回饋"). A rejected handoff looks exactly like
an accepted one to its author. With a schedule in the payload there is one more way to be refused (a time
that does not parse), and the agent writing it is usually about to be closed — so it must learn the outcome
before its session ends, not days later.

## What Changes

- A handoff may carry `"at"`: an ISO 8601 time with an explicit offset. Absent, or not later than now, the
  handoff behaves exactly as today. Later than now, the handoff is ingested, validated and resolved at once,
  but its session is opened only when the time comes.
- **A scheduled handoff whose time passed while the app was closed opens at the next start**, once the
  window has restored its sessions (the user's ruling: start directly, no confirmation).
- **The due handoff always opens a new session** (the user's ruling), as today's handoff does. Its agent is
  told when it was scheduled for and when it actually started.
- **Every handoff — scheduled or not — is opened by one owner that waits for a window able to receive it, and
  opens each handoff automatically at most once, ever.** Today a handoff read before the window listens loses
  its open request; and without "at most once", a handoff whose prefill timed out would reopen at every start.
- Scheduled handoffs are visible and controllable in the inbox: a separate section with the time, target and
  full body; **Run now** and **Cancel**. They do not count in the activity bar's badge and raise no
  notification when scheduled; they notify when they open, as an arriving handoff does today. They count
  toward the inbox's limit on pending items.
- **Delivery receipts**: for every file spekterm reads from an agent's outbox (handoff, report, session
  command), it writes a receipt under the same name in a receipts directory beside the outbox: accepted,
  scheduled (with the time), duplicate, rejected (with the code and a reason), or held (not processed yet,
  will be retried). The introduction tells the agent where to read it. This replaces the documented "no
  feedback" gap; it does not tell the agent whether the target session *finished* — that stays with reports.
- **The introduction gets shorter first**: the repo list is grouped by parent directory (on a 29-repo workspace
  1,963 → ~700 characters), every constraint gets an assertion before the wording is tightened, a test holds it
  within a size budget, and a run-time limit cuts the list of a very large workspace. Measured: past ~10,000
  characters Claude Code replaces the whole introduction with a 2,000-character preview and a file pointer.
- **Remote protocol**: an inbox item gains `scheduledAt`. A client shows scheduled items apart, `inbox.accept`
  on one runs it now and `inbox.ignore` cancels it. The `intake` attention event for a scheduled handoff is
  raised when it opens, not when it is scheduled. Protocol version 1 grows only by a field; the protocol
  document and its client obligations are updated for the Android app.

## Capabilities

### New Capabilities

- `scheduled-handoff`: a handoff with a future time — parsing and bounds, waiting across restarts, opening
  when due (including when overdue at start), Run now / Cancel, what the opened session is told.
- `handoff-receipt`: the receipt spekterm writes for each outbox file it reads — location, statuses, atomic
  writing, lifetime and bounds.

### Modified Capabilities

- `agent-handoff-source`: the introduction states `at` and the receipts; the "no feedback" requirement is
  removed in favour of `handoff-receipt`; "到達即建立 session" gains the scheduled exception and "on arrival"
  now means "once a window can receive it"; the session-command introduction states what a receipt says.
- `agent-session-control`: a refused command's receipt states the refusal (the requirement that said the agent
  is not told is renamed and rewritten); what became of an accepted command is still not told.
- `handoff-completion`: the reason given for deriving the stated limits no longer claims there is no reply.
- `agent-intake`: the badge does not count a scheduled handoff that is not due; the arrival notification of a
  scheduled handoff is raised when it opens.
- `remote-protocol`: scheduled items in the inbox list, run now and cancel from a device.
- `remote-notifications`: the `intake` attention event of a scheduled handoff is raised when it opens.

## Impact

- Main process: `handoff-delivery.ts` (parse `at`, id digest), `handoff-service.ts` (no direct auto-accept,
  receipts for every outcome), a new opener module (due check, window-gated firing, at-most-once),
  `handoff-outbox.ts` (receipts directory, cleanup), `handoff-intro.ts` (new text, derived limits),
  `intake-schema.ts` / `intake-store.ts` (`scheduledAt` on the verified fields), `intake-projection.ts`
  (scheduled in the view, excluded from the badge), `intake-notify` and `remote-attention` wiring (arrival at
  fire), `intake-context.ts` / `agent-protocol-copy.ts` (the schedule line), `intake-rejection.ts` (a new
  code), `ipc/intake.ts` and `handoff-ticket.ts` (`firedAt`), `restore-gate.ts`, `remote-protocol.ts` /
  `remote-host.ts` (field only).
- Renderer: the inbox overlay's scheduled section with Run now / Cancel; dictionaries (`en`, `zh-TW`).
- Docs: `docs/remote-protocol.md`, `docs/lessons/handoff.md`, `docs/PRD.md`, CLAUDE.md's handoff paragraph,
  the website's handoff, inbox and remote-access pages in both languages.
- Tests: unit tests for parsing, scheduling, receipts; `probe:intake` sections; `probe:remote` for the field;
  `scripts/scenario-coverage.test.mjs` registration; `scripts/handoff-intro-source.test.mjs` for the new
  constants.
- The Android app (`spekterm-android`, its own repository) needs a follow-up to show scheduled items; until
  then an older client shows them as ordinary pending items, and accepting one runs it now.
- No new dependency.
