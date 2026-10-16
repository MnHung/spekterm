## Context

See proposal.md for the three requests. The code involved:

- **Wait state** (`agent-events.ts`, `agent-wait.ts`).
  - Hooks write one file per event, named by a nanosecond timestamp.
  - A single drainer per running agent session reads them every 400 ms (`drainEvents` → `foldDrain`).
    Observers and subscribers see each batch.
  - `nextWaitState` maps each event to a state without reading the current one.
  - While the state is awaiting-choice, `pending: { tool, arg }` is carried across drains
    (`companion-test-fixes` D4).
  - `parseEvent` keeps fields by white-list.
- **Remote conversation** (`remote-protocol.ts`, `remote-conversation.ts`, `remote-host.ts`).
  - `conversation.watch` relays `wait(state, pending)` as `conversation.wait`.
  - `conversation.send` has a per-session queue and the `ready | busy` gate. It writes the submit key
    500 ms after the text, with a re-check.
  - `terminal.input` writes raw data.
- **pty writes** all go through `TerminalService.write`:
  - the desktop's keyboard (`ipc/terminal.ts`);
  - remote `terminal.input` and replies;
  - intake and handoff prefill.
- **Remote session actions** (`remote-host.perform` → `RendererRequests` → `RemoteRequests.tsx`). The
  renderer carries out create, wake and accept quietly, and the preload narrows each action's shape.
- **Rename on the desktop** (`sessions.tsx` `rename`). It trims the name; an empty name clears
  `customTitle`. The label then follows `preferredTitle` (`shared/lineage/label.ts`): the agent's title, or a
  handoff's title, or the local label (`terminal-sessions`). The session store persists `customTitle`, and its
  subscription pushes `sessions.changed` after its 500 ms debounce.
- **Injection** (`agent-injection.ts` `composeInjection`). One `--settings` file is shared by every agent
  session. Contributions add settings keys (each key from one contributor only), hook commands and
  environment variables. If any contribution is non-null, `--settings` is passed.
- **Closing a session**:
  - `ipc/terminal.ts` `kill` calls `TerminalService.kill`;
  - for a session with no pty (dormant), it clears the drop points itself;
  - then `sessions.remove`.
- **Frames** are at most 1 MiB (`docs/remote-protocol.md` §2). Over that, the connection is closed.

### Measurements this design relies on

CLI 2.1.300 driven through a pty, with every hook dumping its full payload. `--setting-sources project` was
used where the maintainer's own settings would answer the question (they allow reads under the home directory
and `/tmp`). Each row was run once unless noted. The harness is not part of the change.

**Permission prompts, one at a time**

| Observation | Result |
|---|---|
| `PermissionRequest` payload | `tool_name`, `tool_input`, `permission_suggestions`, `agent_id` for a subagent, `prompt_id` (the turn's, shared by every event of the turn). **No `tool_use_id`**, and **not the options the terminal shows** |
| options shown, Bash | `1. Yes` / `2. Yes, and always allow access to <dir>…` / `3. Yes, and switch to auto mode` / `4. No`. The third is not in the payload |
| options shown, Write and Edit | `1. Yes` / `2. Yes, and switch to accept edits…` / `3. No` |
| options shown, WebFetch | `1. Yes` / `2. Yes, and don't ask again for <host>` / `3. No, and tell Claude…` |
| options shown, Read outside the working directories | `1. Yes` / `2. Yes, allow reading from <dir> during this session` / `3. No` |
| options shown, plan approval (`ExitPlanMode` with a plan in `tool_input.plan`) | `1. Yes, and use auto mode` / `2. Yes, manually approve edits` / `3. Tell Claude what to change` (to be typed). The same with and without the maintainer's settings |
| options shown, `ExitPlanMode` with an empty `tool_input` (no plan written) | another prompt: "Exit plan mode?" `1. Yes, and switch to default (ask each time) for this session` / `2. No` |
| key `2` on the plan approval | approved; the next events carry `permission_mode: "default"`, and the next edit asks permission |
| key `1` on the plan approval | approved; the next events carry `permission_mode: "auto"`, and the edit ran without asking |
| key `1` on "Exit plan mode?" | left plan mode; the next events carry `permission_mode: "default"` |
| key `1` (no Enter) on a Bash prompt | picks "Yes" at once; the tool runs; `PostToolUse` |
| `Esc` on Bash, Write, Edit, WebFetch and Read prompts of the agent itself | "Interrupted · What should Claude do instead?", the turn ends; **no event** |
| `Esc` on a question | "User declined to answer questions", the turn ends; no event |
| `Esc` on the plan approval | still in plan mode, nothing executed |
| a `PermissionRequest` hook that sleeps 8 s | the prompt is on screen while the hook still runs: **the hook does not hold the prompt back** |
| a `PreToolUse` hook that sleeps 4 s | the request and the prompt come 4 s later: **the agent waits for `PreToolUse` before it shows a prompt** |
| a `PostToolUse` hook that sleeps 4 s, then a second tool | the second `PreToolUse` comes after the 4 s |

**Several prompts at once**

| Observation | Result |
|---|---|
| two parallel Read calls, both outside the working directories | `PreToolUse` a, `PermissionRequest` a, `PreToolUse` b, `PermissionRequest` b, **all before any answer**. The screen shows a. `1` approves a (`PostToolUse` a), then b is shown; `1` approves b |
| two parallel Bash calls | only the first is requested; `Esc` interrupts both ("Interrupted" on each), no event |
| two background subagents, each running Bash | both requests (each with its `agent_id`) before any answer. The prompt reads "from the general-purpose agent · 1 of 2", in arrival order. **The agent itself reports `Stop`** while both prompts are open |
| the same, answering the first with `1` | `PostToolUse` (with that `tool_use_id`), then a `UserPromptSubmit` whose prompt is a `<task-notification>` and a `Stop`, **while the second prompt is still open**; then "2 of 2" |
| the same, answering the first with `Esc` | that subagent ends: `SubagentStop` with its `agent_id`. Then the `<task-notification>` submission and `Stop` follow, and "2 of 2" stays open |
| `SubagentStop` | also reported for the agent's own helper agents (`agent_type: ""`) that raised no prompt |
| the agent's own Bash prompt open, a background subagent already finished | **no event for 20 s** while the prompt was on screen. The `<task-notification>` submission and a `Stop` came only after Esc dismissed the prompt (0.16 s later): the notice waits for the agent's own prompt |
| `Stop` payload | `background_tasks: [{ id, type: "subagent", status: "running" }]`, the `id` equal to the subagent's `agent_id` |
| a subagent asked to run "in the foreground", its prompt dismissed with Esc | the agent had started it in the background anyway; `SubagentStop` for it followed. A truly foreground subagent's dismissal is not measured |
| two parallel Read calls (no prompt) | their `PreToolUse` events 1.5 ms apart, before either finished |
| `SessionStart` payload | `source` (`startup` measured) |
| `UserPromptSubmit` payload | `prompt`, `prompt_id`, `permission_mode`. Nothing tells a typed prompt from a system notice except the prompt text |

**The question tool (`AskUserQuestion`)**

| Observation | Result |
|---|---|
| payload | `tool_input.questions[]`: `{ question, header, options: [{ label, description }], multiSelect }`. `PostToolUse` adds `tool_input.answers: { <question>: "<label>[, <label>…]" }`, the labels in option order |
| screen | per question, the options numbered from 1, then "Type something", then "Chat about this". With several questions, a tab row and a final "Submit" tab |
| one single-choice question, key `2` | picks option 2 and submits at once; `PostToolUse` |
| several questions, a single-choice digit | picks it and moves on. After the last question, "Review your answers" opens with `1. Submit answers` / `2. Cancel`; `1` submits |
| a multiple-choice question, digits | each digit toggles its option. **Enter toggles the option under the cursor**, so Enter is never part of an answer |
| a multiple-choice question, Tab or → | moves to the next question, or to the review after the last one. Two several-choice questions answered with 250 ms gaps: correct with Tab and with → |
| every key in one write (`2113\t1`) | **answered wrongly**: only part of it took effect |
| the same keys 100 ms apart, and 250 ms apart | answered correctly, both |
| keys `1`, →, Tab when no prompt is open | `1` sits in the input box; → and Tab show nothing; nothing is submitted |
| Esc when no prompt is open | empty input box: nothing. With text: "Esc again to clear" is shown and the text kept, also after a second Esc 1 s later |

**Attachments**

| Observation | Result |
|---|---|
| asking to read a file under the home directory, no extra settings | `PermissionRequest Read` |
| the same with `permissions.allow: ["Read(/<dir>/**)"]` in `--settings` | no prompt; read |
| the same with `permissions.additionalDirectories: [<dir>]` | no prompt; read. Not chosen, see D6 |
| a PNG named in the prompt (inside a sentence) | the agent read it with the Read tool and named its color |
| an 8.7 MB PNG | read (the tool took 3 s) and described |
| `additionalDirectories` from a project settings file and from `--settings` | both apply: the setting is merged |
| the user's settings (`defaultMode: auto`) plus `--settings` with `permissions` | still auto mode: the object is merged, not replaced |
| a long reply (taken as a paste) with an image path **on a line of its own** | the input box shows `[Image #1][Pasted text #2]`. The user record becomes a list of a text block and an image block, and the path is removed from the text |
| the same with the path **inside a sentence, in backticks** | not converted. The record is a string, and the agent used Read |
| any reply taken as a paste | recorded as `\n\n<pasted_content id="55b5">\n<the text>\n</pasted_content id="55b5">\n` |

## Goals / Non-Goals

**Goals:**

- The wait state stays awaiting-choice while any permission prompt is open, background subagents' prompts
  included. This fixes a defect in what ships today: with a subagent's prompt open, the state reads ready, and
  a reply's text and Enter approve that prompt.
- A phone can answer a permission prompt ("allow once" or "deny") or a question (its listed options) of the
  conversation it watches. An answer never lands in a prompt other than the one the phone was shown.
- A phone can attach images, PDFs and text files to a reply, and the agent can read them without a prompt.
- A long reply is shown and confirmed as the text that was sent.
- A phone can rename a session with the desktop's rules.
- A client can tell which of these the desktop supports.

**Non-Goals:**

- Answering from the desktop's conversation view. The desktop has the terminal, and `agent-input-bridge`'s
  "no answering in this view" stays.
- Answering when more than one prompt is open. The phone sees the first and the count, and the user answers
  on the desktop.
- "Allow" for tools whose prompt was not measured (MCP tools, `NotebookEdit`, and others), and the "always
  allow" options.
- The plan approval's "Tell Claude what to change", which needs typed text.
- Free-text answers to a question ("Type something"), and "Chat about this".
- Unwrapping a paste that is only part of a message. Only a message that is one paste was measured.
- Any change to the Android repository.

## Decisions

### D1. The wait state tracks every open permission request

`drainEvents` keeps two values per session: a **base state** and an ordered list of **open requests**
`{ id, toolUseId, agentId, tool, arg, questions, at, answeredAt }`. It also keeps the unmatched `PreToolUse`
events per agent: `{ toolUseId, tool, inputHash, at }`.

| Event | Effect |
|---|---|
| `PreToolUse` | adds an unmatched tool start for its `agent_id` (none = the agent itself), with a hash of its `tool_input` |
| `PermissionRequest` | appends a request with a new `id`. It is matched to the **latest unmatched tool start of the same agent with the same tool name and input hash**, taking that start's `tool_use_id` and its `at` (the start's file timestamp, which is earlier than the prompt). With no match, it has no `tool_use_id`, and `at` is its own file's timestamp |
| `PostToolUse`, `PostToolUseFailure` | removes the request and the start with that `tool_use_id` |
| `Stop`, `StopFailure`, `UserPromptSubmit` from the agent itself | remove the agent's own requests and its unmatched starts |
| `Stop` from the agent itself | also removes the requests and starts of subagents not listed as running in its `background_tasks` |
| `SubagentStop` | removes that agent's requests and starts |
| `SessionStart` with `source` other than `compact` | removes all |

`dismissRequest` (D3) removes one request. For a request of the agent itself, it also removes the agent's
unmatched starts. When the session's process ends, for any reason, the open requests and the state are
cleared (`forgetRequests`); the last transcript location is kept. Hibernation still runs the full
`clearWait`.

**The reported state** is awaiting-choice while any request is open. Otherwise it is the base state.

- **The base state** is what `nextWaitState` returned for the last event other than `PermissionRequest` and
  `SubagentStop`. While nothing is open, a `PermissionRequest` gives awaiting-choice through the list, not
  through the base.
- A `Notification`/`permission_prompt` with nothing open still gives awaiting-choice with an empty pending
  request, as today. It is a base state, cleared by the next base event.
- `pending` is the first open request's tool and argument, which is what the terminal shows first
  (measured: queued prompts are shown in arrival order).
- `agent-wait.ts` holds all of it per session and passes it back into each drain.

**Why each row**:

- **Matching by tool and input, not by order.** Two parallel calls' tool starts can arrive 1.5 ms apart,
  before either request. If the second call needs no permission, its `PostToolUse` must not close the first
  call's request. A request carries the same `tool_name` and `tool_input` as its start, and all 33 measured
  requests matched. Only a hash of the input is kept, so no path is held.
- **The latest match, and stale starts dropped.** A start can be left unmatched:
  - two parallel Bash calls dismissed with Esc leave the second start behind, with no event (measured);
  - a helper agent's start after the turn ended had no end (measured).

  An agent that then retries the same call must not inherit the old start's id.
- **The agent's own turn events close its own requests.** The agent cannot end a turn or start one while its
  own prompt is open. Measured: a background subagent finished before its parent's prompt appeared, and
  produced no event for the 20 s the prompt was on screen. Its notice submission and the parent's `Stop` came
  right after the prompt was dismissed. A prompt dismissed in the terminal reports nothing, so the next turn
  event is the existing recovery (`agent-event-bridge`, known blind spot).
- **A subagent's prompt is not the agent's.** While a background subagent's prompt is open, the agent ends
  its turn and a notice submission arrives (measured twice). Today the state machine clears every request on
  those events, which is what makes the state read ready over that prompt. So those events close only the
  agent's own requests.
- **`SubagentStop` closes that subagent's prompts.**
  - A subagent whose prompt is dismissed ends and reports it (measured, background subagents).
  - It is added to `HOOKED_EVENTS`.
  - For helper agents that raised no prompt, it closes nothing.
  - It must not move the base state: a helper's `SubagentStop` arrived after the agent's `Stop` (measured).
- **The agent's `Stop` lists its running background tasks** (`background_tasks: [{ id, type, status }]`, where
  `id` equals the subagent's `agent_id`, measured).
  - A subagent request whose agent is not listed as running cannot still be on screen.
  - This closes a subagent prompt whose `SubagentStop` never came, for example a foreground subagent
    interrupted with the turn.
  - The foreground case was not measured: the agent ran the requested "foreground" subagent in the
    background.
- **`PreToolUse` no longer clears a held request.** With parallel calls, the second call's start arrives while
  the first prompt is open (measured).
- **`SessionStart` clears all requests, except on compaction.** A new, resumed or cleared conversation is a
  new process or a new transcript, so no earlier prompt can be on screen. Compaction can happen in a turn
  that runs while a subagent's prompt is open (not measured). Clearing there would read ready over the
  prompt.

This replaces the "pending is carried" rule of `companion-test-fixes` D4. For a single prompt the effect is
the same. It also fixes a defect that ships today: the state reads ready over a background subagent's
prompt.

### D2. Questions are parsed by white-list, and answerability is decided once

For `tool_name === 'AskUserQuestion'`, `parseEvent` reads `tool_input.questions`:

- each question becomes `{ question, header, multiSelect, options: [{ label, description }] }`;
- strings are clipped (question and description 1,000 characters, header 100, label 300);
- a malformed question (no string question, `options` not an array, an option without a string label) makes
  `questions` null.

From `PostToolUse` of the same tool it reads `tool_input.answers`: a map of string to string, clipped, used
only to confirm an answer (D3).

For `tool_name === 'ExitPlanMode'` it reads `tool_input.plan`: a string, clipped to 20,000 characters, or
null when absent or empty. It is the agent's own prose, the same class as a question's text, so the phone
can read the plan before approving it. `planFilePath` is not kept. Every event's `permission_mode` is kept, to
confirm a plan answer (D3).

**Answerable** means 1 to 4 questions, each with 1 to 8 options. The digits 1 to 8 then always name listed
options, and nothing reaches "Type something" or "Chat about this".

### D3. Answers are keystrokes, guarded by identity, by count and by the desktop's own input

`conversation.answer { sessionId, promptId, decision, selections? }`:

| Prompt | `decision` | Keys |
|---|---|---|
| permission, `canAllow` | `allow` | `1` |
| permission | `deny` | Esc |
| question, `answerable` | `answer`, with `selections` | per question: a single choice → its digit; a multiple choice → each chosen digit in ascending order, then Tab. Then `1` on the review, unless the prompt is a single single-choice question |
| question | `deny` | Esc |
| plan, with a plan | `approve` | `2` ("Yes, manually approve edits"); expects `permission_mode` `default` |
| plan, with a plan | `approve-auto` | `1` ("Yes, and use auto mode"); expects `auto` |
| plan, with no plan | `approve` | `1` ("Yes, and switch to default"); expects `default` |
| plan | `deny` | Esc: the plan is rejected, and the agent stays in plan mode |

- **`canAllow`** is true only for the measured tools: `Bash`, `Edit`, `Write`, `Read`, `WebFetch`. Their first
  option is a one-time "Yes". It is false for everything else.
- **The plan approval is its own kind** (`ExitPlanMode`), never `allow`. Its first option starts auto mode,
  so the phone names each approval explicitly. Whether a plan is present decides which prompt the terminal
  shows, and `tool_input` says that.
  - "Tell Claude what to change" needs typed text, so it is not offered. The phone denies instead: the agent
    is then ready, and the user replies with what to change.
  - **Confirmation**: the desktop waits up to 3 s for the request's `PostToolUse` and compares its
    `permission_mode` with the expected one, giving `confirmed` or `mismatch`. A `mismatch` after
    `approve-auto` is the case where the options differ from the measured ones, for example an account where
    auto mode is not offered.
- **Selections**: one entry per question, as option indexes.
  - A single-choice question takes exactly one index.
  - A multiple-choice question takes one or more distinct indexes.
  - Anything else is `BAD_PARAMS`.
  - A decision that does not fit the prompt is `NOT_ANSWERABLE`: `answer` on anything but an answerable
    question, `allow` where `canAllow` is false, and `approve` / `approve-auto` on anything but a plan.
    `approve-auto` is also refused when no plan is present.
- **Keys** are written one at a time, 250 ms apart. Measured: one write fails, while 100 ms and 250 ms gaps
  both work. Tab leaves a several-choice question; measured at 250 ms after a final and a non-final one.
- **Before every key** (`refreshWait`, D4), the key is written only if:
  1. exactly one request is open;
  2. its id is `promptId`;
  3. no keystroke was written to the session since that request's `at`;
  4. the request's agent reported no tool start or finish since its `at`, other than the request's own;
  5. no earlier answer was written to that request (its `answeredAt` is unset), except by this answer.

  A **keystroke** is any write to the session except a device answer's own keys and the terminal's focus
  reports (`ESC [ I`, `ESC [ O`, which the agent turns on) and mouse reports (`ESC [ M …`, `ESC [ < … M/m`,
  excluded in case an agent turns them on). That includes the keyboard, remote `terminal.input`, replies, and
  the desktop's own prefills. `TerminalService.write` records its wall-clock time, the same clock as the event
  files' timestamps.

  Writing the first key sets the request's `answeredAt`. So an allowed request whose tool runs for minutes is
  no longer answerable, a second tap is refused, and so is a reconnect that resends.

  If the first key is refused, the answer is `PROMPT_GONE` (detail: the state and the number of open
  requests). If a later key is refused, the rest are withheld and the outcome is `partial`.
- **Outcomes**:
  - `sent` — every key was written;
  - `partial` — some keys were withheld;
  - `confirmed` / `mismatch` — for a question, the desktop waits up to 3 s for its `PostToolUse` and compares
    the recorded answers with the chosen labels. With no `PostToolUse` in time, the outcome is `sent`.
- **After a `deny`** the desktop removes that request itself, and if it was the agent's own, sets the base
  state to ready. It wrote the Esc, and checks 1–5 had just passed. Esc on the agent's own prompt ended the
  turn every time it was measured (Bash, Write, Edit, WebFetch, Read, a question, the plan approval, two
  queued Bash calls). Without this the phone would be stuck: the state would stay awaiting-choice, and
  `conversation.send` would refuse. A subagent's request is also removed, and its `SubagentStop` follows
  (measured). The base state is left as it was.
- **`sent` means only that the keys were written.** The protocol document says so.
- **Answers share the session's reply queue** (`remote-conversation.ts`), and only the watched conversation
  is answered (`NOT_WATCHING`).

**Why the five conditions are enough.**

- **(1) and (2) guard against a prompt that replaced the one being answered.**
  - **One after another**: the agent waits for `PostToolUse` before the next tool starts, and for
    `PreToolUse` before it shows a prompt (both measured with slow hooks). So once the old prompt is answered
    and before a new one shows, `refreshWait` finds the old request closed. Either nothing is open (refused),
    or the new request with a new id is open (refused).
  - **Queued** (parallel calls, subagents): each request is reported before its own prompt is shown, and
    queued prompts are shown in arrival order (measured). So a request that queues behind the open one makes
    two open, and the answer is refused. A new request can join while another prompt is already shown
    (a background subagent, measured). The window is the time its hook file takes to land, a few
    milliseconds, against an answer's single key. See Risks.
  - **(4)** covers a request whose prompt went away without an event that closes it. An example is a parallel
    call that needed no permission, starting and finishing next to it. Any further tool event of the same
    agent refuses the answer, which is the safe direction.
  - **The `PermissionRequest` file itself** may land a little after its prompt shows, because that hook runs
    alongside the prompt. It does not matter: until it lands, the new prompt has no request, and nothing
    matches the old id.
- **(3) guards against the desktop's hands.**
  - A prompt answered on the desktop reports nothing until its tool ends. That can take a long time, and a
    dialog that does not go through `PreToolUse` could appear meanwhile (a sandbox network prompt, an MCP
    elicitation, neither measured).
  - A prompt dismissed on the desktop reports nothing at all.
  - A question half-answered on the desktop would misalign the keys.

  Every one of those involves a keystroke on the desktop after the prompt appeared. A request is answerable
  only if none came after its `at`: the matched tool start's file timestamp, which is earlier than the prompt.
- **(5) guards against the phone's own second answer.** An allowed tool can run for minutes before its
  `PostToolUse` closes the request. A `partial` answer leaves a question half-answered.
- **What remains.**
  - A prompt dismissed by something other than a key, such as an agent that times the prompt out or a
    session restarted around it, with no further tool event. The request stays open. An answer to it writes
    a digit, Esc or Tab where no prompt is.
    - In the input box, measured: none of them submits, and no answer contains Enter. A `1` stays in the box,
      in front of the next message.
    - If the agent is working, Esc interrupts it. That is not measured, and is inferred from the screen's
      "esc to interrupt".

    The protocol document states both.
  - A key pressed on the desktop in the same 250 ms gap as a phone key is not seen until the next key's check.

### Alternatives considered for D1 and D3

- **The `PermissionRequest` hook returns the decision.** Claude Code lets this hook answer `allow`/`deny`,
  with `updatedInput` carrying a question's answers. The answer would be tied to the request by construction,
  and no keys would be needed. Rejected:
  - The hook would have to run until the phone answers, while the prompt is also on screen (measured: the
    hook does not hold the prompt back). What happens when the desktop answers first is unmeasured.
  - The experiment that would measure it, a hook returning `allow`, was blocked by the measuring session's
    own auto-mode classifier.
  - Neither path is a security boundary against the agent. The agent has a shell and can write both the
    event directory (its location is in its environment) and any decision file. A forged event can make the
    phone show something false, and a forged decision can approve. The keystroke path at least never approves
    without a person pressing something.
- **Send the phone the digits and let it type them with `terminal.input`.** Rejected: that is the blind
  typing the request names, without any of the checks.
- **Answer the first of several open prompts.** Rejected for now. Arrival order was measured twice, and the
  conservative rule (exactly one) still covers the common case.
- **Tell a typed submission from a notice by its text** (`<task-notification>`). Rejected: it is a guess
  about content. Peer messages from other sessions could arrive the same way, and the failure direction is
  approving a prompt.

### D4. `refreshWait` drains on demand through the single drainer

`agent-wait.ts` gains `refreshWait(sessionId): WaitSnapshot`. It runs the same `tick` the timer runs, so
subscribers and observers see the batch as usual and nothing is drained twice. A session with no timer entry
(not running) returns the stored state. `dismissRequest(sessionId, id, own)` applies D3's removal after a
deny, and its new snapshot goes to subscribers and observers the same way.

### D5. The phone learns the prompt through `conversation.wait`

`conversation.wait` gains `prompt`:

- `null`, or
- `{ id, kind: "permission", tool, arg, canAllow, answerable, open }`, or
- `{ id, kind: "question", questions, answerable, open }`, or
- `{ id, kind: "plan", plan, choices, answerable, open }`: `plan` is the plan text or null. `choices` is
  `["approve", "approve-auto", "deny"]` with a plan, and `["approve", "deny"]` without one.

`open` is the number of open requests. `answerable` is false when D3's checks 1, 3, 4 or 5 fail, and for a
question that is not answerable by D2. `prompt` describes the first open request. `pending` stays as it is.

**The update is sent when what it says changes**, not only when a drain finds events. `conversation-follow.ts`
today skips a tick with no events and an unchanged state. It now also compares `prompt` (id, `open`,
`answerable`). The first keystroke after a request's `at` triggers an update by itself, because no drain
would. The same holds after `dismissRequest`.

**Attention events**: `choiceRaised` becomes one entry per request in the batch, so two requests in one
drain raise two `choice` events (`remote-notifications` already says each prompt raises one). Today only
the last one raises an event.

### D6. Attachments: a desktop-owned store, chunked upload, a sentence in the reply

**Operation** `attachments.put`:

```
p: { sessionId, name, size, offset, data, attachmentId? }
r: { attachmentId, received, complete }
```

- **`data`** is base64. A chunk is at most 512 KiB once decoded, which base64 makes 699,052 characters,
  under the 1 MiB frame cap.
- **The first chunk** has `offset: 0` and no `attachmentId`, and creates the upload. Later chunks name the
  id and must start exactly at `received`, otherwise `BAD_PARAMS` with `detail.received`. `size` is fixed by
  the first chunk.
- **Completion**: when `received === size`, the content is checked (below) and the upload becomes an
  attachment.
- **The session** must exist and be an agent session (`NOT_FOUND`, `NO_CONVERSATION`). Watching it is not
  required.
- **Concurrency**: chunks of one upload are applied in order with synchronous writes. A second chunk at the
  same offset finds `received` moved, and gets `BAD_PARAMS`.

**Accepted content** is decided by the bytes:

- PNG, JPEG, GIF, WebP and PDF by their signature;
- otherwise UTF-8 text with no NUL;
- anything else is `UNSUPPORTED_TYPE`, and the upload is removed.

HEIC is not accepted. The phone converts it, which Android does natively.

**The file name**:

- The desktop chooses it: `<attachmentId>-<name>`.
- The name is the phone's basename, with characters outside `[A-Za-z0-9._-]` replaced by `_`, leading dots
  removed, and clipped to 80 characters. An empty result becomes `attachment`.
- An image or PDF gets the extension its signature implies.
- Text whose name has no extension, or the extension of an image or a PDF, gets `.txt` appended. This keeps
  Read from decoding it as an image.
- Files are written with mode 0600.
- The joined path is checked with `path.relative` against the directory (the repository's boundary idiom).

**Limits**:

- 10 MiB per file;
- 10 attachments per reply (`BAD_PARAMS` beyond);
- 200 MiB stored per session;
- 10 not yet sent per session, uploads in progress included.

Exceeding a size limit is `TOO_LARGE` with `detail.limit`. Too many not yet sent is `TOO_MANY`.

**Storage**: `<userData>/remote-attachments/<sessionId>/`.

- An upload in progress is `pending/<attachmentId>.partial`.
- A complete one is `pending/<attachmentId>-<name>`.
- A sent one is moved to `sent/` before its reply's text is written.

So whether an attachment was sent is on disk and survives a restart. The main process is the only writer.
The phone never sends a path, and the operation has no parameter that could carry one.

**Sending**: `conversation.send` gains `attachments?: [attachmentId]`.

- Each must be in `pending/` (complete), of that session. Otherwise `NOT_FOUND`, and nothing is written.
- They are reserved when the reply is accepted, so a second reply naming one fails at once. They are moved
  to `sent/` immediately before the text is written. If the reply fails before that (`WAIT_STATE` on the
  re-check, `NOT_FOUND`), the reservation is released and they stay in `pending/`. A
  `filled-not-submitted` reply counts as sent: the text and the paths are in the agent's input box, and a
  second send would duplicate them.
- `text` may be empty when attachments are present.
- The desktop appends a sentence, from `agent-protocol-copy.ts` (English, not in the dictionary):
  ``(The user attached N file(s) from their phone; read them with the Read tool: `<path>`, `<path>`)``.
- The paths are inside the sentence, in backticks. Measured: a path on a line of its own, in a reply taken
  as a paste, becomes an inline image, and the record becomes a list the projection does not show.
- The answer gains `text`: exactly what was written before the submit key.

**Read access**: a fourth injection contribution, `prepareAttachmentAccess(enabled)`, contributes
`permissions: { allow: ["Read(/<userData>/remote-attachments/**)"] }`.

- **A read rule, not `additionalDirectories`.** An additional directory is a working directory. In
  accept-edits mode, writes there would be accepted too, other sessions' attachments included. The rule only
  allows reading, and it removed the prompt (measured).
- **The whole store**, because the settings file is shared by every session.
- **Every agent runs as the same user** and can already ask to read there. This removes the prompt; it does
  not widen what the user can reach.
- **It merges** with the user's own `permissions` (measured for `additionalDirectories` and the default mode;
  the allow list is an array of the same kind).
- **Only when the event bridge is enabled** (`enabled` = the agent-events preference). Without events the
  wait state is unknown and a reply is refused anyway. Contributing it unconditionally would also pass
  `--settings` to users who turned every injection off.

**Retention**:

- A session's directory is removed when the session is closed: in `ipc/terminal.ts`'s `kill` handler, for a
  live and a dormant session alike, next to `sessions.remove`. It is kept while the session is dormant.
- Two other paths remove a session without that handler: a folder removed while its sessions are restored,
  and a shell whose process ends. An agent session's attachments there are removed by the next startup's
  sweep.
- At startup, directories of sessions not in the session store are removed, and so are files older than
  30 days.
- Attachments not yet sent are removed after 24 hours: at startup, and whenever their session receives a
  `put`.
- An upload still in progress at a quit is removed at startup: its progress is held in memory, so it cannot
  continue. The phone uploads it again.

**Alternatives**:

- **One frame per file.** Rejected: the frame cap would limit a file to about 700 KiB, below an ordinary
  phone photo or PDF.
- **Inside the session's working directory.** Rejected: it puts files into the user's repository.
- **Image paste** (paths on their own line, converted to inline images). Rejected: it depends on the reply
  being taken as a paste, and its record shape is not projected.
- **`additionalDirectories`.** Rejected for the write scope above.

### D7. A reply recorded as one paste is shown as its text

When a user record's string content is exactly one paste, it is shown as the pasted text. That means: optional
leading newlines, `<pasted_content id="X">`, a newline, the text, a newline, `</pasted_content id="X">` with
the same `X`, and an optional newline (measured shape). A paste that is only part of a message is shown as
recorded. This lets the phone's and the desktop's "not confirmed" match a long reply. Replies with
attachments are long, so it matters here.

### D8. Rename is a renderer action like create and wake

- `sessions.rename { sessionId, name }` → `{ sessionId }`. `name` is a string and may be empty (the
  parameter check is not `str()`, which refuses empty strings).
- Control characters are removed, newlines included, and the name is clipped to 200 characters. The
  renderer's `rename` trims it, and an empty name clears the session's name, so the label follows
  `terminal-sessions`' order again.
- `HostAction` gains `{ kind: 'rename', sessionId, name }`. The preload narrows it, and `RemoteRequests` calls
  `api.rename`, which touches neither selection nor focus. An unknown session is `NOT_FOUND`.
- A dormant session can be renamed.
- Errors: `NO_WINDOW`, `TIMEOUT`, `NOT_FOUND`, `BAD_PARAMS`.

### D9. The authentication answer lists operations; the version stays 1

- `hello` and `pair` answers gain `operations: string[]`: `operationNames()` without `hello` and `pair`.
- New error codes: `PROMPT_GONE`, `NOT_ANSWERABLE`, `TOO_LARGE`, `TOO_MANY`, `UNSUPPORTED_TYPE`.
- `remote-server.ts`'s comment on the frame cap ("parameters never come close") is updated: a chunk is now
  sized against it.

### D10. Two existing path rules are made explicit about prose

`agent-event-bridge` ("event content … no absolute paths") and `agent-transcript-stream` ("events … contain no
absolute path") are written as absolute. The code has always applied them to fields: it builds every event by
white-list and keeps a tool's identifying argument, which is often a path, as plain, non-navigable text.
This change adds two kinds of prose that can hold a path:

- a question's text and options, written by the agent;
- the attachment sentence, written by the desktop into the user's message.

Both requirements are modified to say what they always meant: no field the system adds carries a location,
and prose written by the user, the agent or the desktop is shown as plain text that cannot be navigated. The
existing scenarios are kept.

### D11. Test carriers

- **Unit tests**:
  - `agent-events.test.ts`: every row of D1's table, as event sequences copied from the measurements:
    - one prompt answered;
    - one prompt dismissed, then a submission;
    - two parallel requests;
    - two subagents with a `Stop` and a notice submission between;
    - a subagent dismissed (`SubagentStop`);
    - a helper's `SubagentStop`;
    - question parsing and answers parsing;
  - `agent-wait.test.ts`: `refreshWait`, and `dismissRequest`;
  - a new `remote-answer.test.ts`: each key plan; pacing; each guard (identity, count, desktop input) for
    the first key and a later key; `confirmed` / `mismatch` / `sent`; `canAllow`; each refusal;
  - a new `remote-attachments.test.ts`: chunks, limits, signatures, text, names, containment, `pending` and
    `sent`, the sweeps;
  - `terminal.test.ts`: writes record their time except an answer's own;
  - `remote-conversation.test.ts`: send with attachments;
  - `transcript-follow.test.ts`: the paste shape, and a partial paste left as is;
  - `remote-protocol.test.ts`, `remote-server.test.ts`, `agent-injection.test.ts`.
- **`probe:remote`**, through the stub agent:
  - rename;
  - upload and send;
  - answers (a deny, a question, a gone prompt, two open requests, the desktop typing first);
  - `operations`.

  The stub gains a **control file**. It polls it, and the probe writes it, to have the stub report a given
  sequence of hook events (with `tool_input`, `agent_id` and `tool_use_id`). The stub also logs every byte it
  receives.
- **`probe:agent-view`**: a background subagent's open request keeps the conversation view's input refused
  across the agent's `Stop` (the shipped defect).
- **The real agent's TUI cannot be probed**: the stub has no prompt UI. The key plans and event orders rest
  on the measurements above, recorded in `docs/lessons/transcript.md` with "re-measure after a CLI upgrade".
  Dogfood on the phone confirms them.
- Each scenario is registered in `scenario-coverage.test.mjs` with its mutation.

## Risks / Trade-offs

- **[A CLI upgrade renumbers an option or changes the review]** → a wrong option is picked. A question's
  answer is confirmed against the recorded answers (`mismatch`). For "allow", only tools seen to put a
  one-time "Yes" first are allowed. The lesson says to re-measure.
- **[A CLI upgrade stops waiting for `PreToolUse`, or shows queued prompts in another order]** → the identity
  check could miss a replacement. "Exactly one open request" does not depend on the order. The lesson
  records both properties.
- **[A request joins the queue in the instant a phone key is written]** → the request's hook file lands a few
  milliseconds after its own prompt is queued (measured: the hook runs alongside the prompt). The key goes to
  the open prompt, which is still the one shown, because queued prompts are shown in arrival order. Only an
  agent that shows a new prompt ahead of an open one would misdirect it, and none was seen.
- **[A CLI upgrade sends the agent's own turn events while its own prompt is open]** → today a background
  notice waits for the prompt (measured). If that changes, the own-request rule reads ready over the prompt.
  The lesson records it as a property to re-measure.
- **[A CLI upgrade reports a background subagent's prompt without `agent_id`]** → its prompt would be cleared
  by the agent's own `Stop`, as today. The lesson records it.
- **[A subagent prompt dismissed by a key the desktop never saw]** → it is cleared by `SubagentStop` when the
  subagent ends; until then the state stays awaiting-choice, which refuses sending.
- **[The agent's own prompt dismissed on the desktop]** → the state stays awaiting-choice until the next
  submission, as today. The desktop's key makes the request unanswerable from the phone.
- **[The store grows]** → bounded by the per-session limit, the close-time removal and the sweeps.
- **[A device can now write files on the desktop]** → only into the store, under names the desktop chooses,
  of the accepted kinds, within the limits. The protocol document and the website say so.
- **[The wait-state change reaches every consumer of awaiting-choice]** → auto-hibernation (it hibernates only
  ready), the close confirmation, the intake submission check, the handoff lifecycle and the phone's session
  list. Each now sees awaiting-choice where it saw ready or busy over an open subagent prompt. That is the
  truth, and none changes its rule. `probe:intake` with its control groups and `probe:agent-view` run after
  the change.
