## Context

Three gaps between the desktop and a paired device (`docs/remote-protocol.md`), one change because they share the
watched conversation, the protocol document and the measurements against a real agent.

**The reply path.** A device reply (`conversation.send`) is written by `sendReply` (`remote-conversation.ts`): the
cleaned text (plus the attachment sentence), then, `SUBMIT_KEY_DELAY_MS` later and after the wait state and the
prefill check are read again, the submit key. `sessions.submitPrefill` (`remote-host.ts`) writes the submit key alone.
Both run in the session's queue (`runQueued`). `r.text` is exactly what was written before the key, and a client
matches the conversation entry against it to clear "not confirmed" (obligation 9).

**The injection seam.** The agent's settings come from one `--settings` file composed by `composeInjection`: each
contributor hands in hook commands per event, the composer concatenates them, and the CLI runs every command of an
event (`docs/lessons/handoff.md` §1). The event bridge hooks `UserPromptSubmit`, and its command **must print
nothing**, because the agent adds a `UserPromptSubmit` hook's stdout to what it receives (`agent-events.ts`). Part A
uses that on purpose. Local transcripts record hook context as `attachment` records of subtype
`hook_additional_context` (about 690, for `SessionStart`, `PreToolUse`, `PostToolUse`), apart from the user record;
the conversation projection admits only `queued_command` attachments, so they are not shown. No local transcript has a
printing `UserPromptSubmit` hook: that shape is not measured yet.

**The status payload.** The status bridge (`agent-status.ts`) injects a `statusLine` command that writes the agent's
payload atomically to `<userData>/agent-status/<sessionId>.json`; `readAgentStatus` projects it field by field, and
`SessionStatusService` polls it every 2 s for the focused session only. The payload is absent when the preference is
off, when the user's own status line cannot be chained, and until the agent first reports.

**The skill listing.** The agent writes what it was told it can invoke into its transcript as `attachment` records of
subtype `skill_listing` (about 1,470 across all local projects, subagent files included; CLI 2.1.235–2.1.304):
`{ type, content: "- name: description\n…", skillCount, isInitial, names: [string] }` (`digests` in 3 records only).
56 of 56 recent transcripts of this repository hold one with `isInitial: true` (58 names, plugin skills such as
`anthropic-skills:docx` included). **Records with `isInitial: false` are not all small additions** (157 across all
projects): most are a few names, about 40 of them changing the description of a skill already listed (often right
after an edit of a file, plausibly its `SKILL.md`), but **8 are an almost complete re-listing (48–58 names) that
leaves out 1–2 names listed before** — so a removal is expressed, and `skillCount` always equals the length of
`names`, so it cannot tell a delta from a full list. About 360 names appear in `content` as a bare `- name` line with
no description. Built-in CLI commands, and skills only the user may invoke, are not in it.

**Slash commands in the transcript.** The agent records a slash command as a `user` record holding the command's
markers (`<command-message>`, `<command-name>/name</command-name>`, `<command-args>…</command-args>`), with no meta
marker (`docs/lessons/transcript.md` §7 and "Who typed it"). **The order of the markers varies**: of 188 local records,
143 start with `<command-message>` (skills; `origin.kind: "human"`), 45 with `<command-name>` (built-ins such as
`/compact`, `/model`, `/clear`; no origin), 43 of which are followed by a `user` record holding
`<local-command-stdout>`. Insights restores the command line to `/name args` (`transcript-extract.ts`); the
conversation projection does not, so both views show the markers and a device reply `/name args` never matches its
entry.

## Goals / Non-Goals

**Goals:**

- The agent knows, for each prompt a device submitted, that the user reads the answer on the phone; the recorded
  message, both conversation views, the terminal and `r.text` do not change; a desktop prompt is marked only inside
  the short window A2 accepts.
- A client watching a conversation can show the agent's model, effort, context, cost and rate limits as the desktop's
  status bar does, without making the session list noisier.
- A client can list the skills the watched agent can invoke, and knows whether and how `/skill args` sent as a reply
  works.
- Every failure degrades to "not shown" or "not marked", never to a blocked, altered or wrong prompt.

**Non-Goals:**

- A manual "away" switch; marking `terminal.input` or `conversation.answer`.
- Usage per session in `sessions.list`; usage of a session nobody watches.
- Built-in CLI commands, or skills the agent cannot invoke itself, in the list; a scan of skill directories.
- The phone app; hiding `monitor` background tasks on the desktop (the desktop does not list background tasks).

## Decisions

### D0. Measure the agent first

Before code depends on it, with a real `claude` in a pty driven the way spekterm drives it (text, then the submit key
500 ms later), current CLI, hooks injected through `--settings`. Results, CLI version and re-measurement steps go into
`docs/lessons/transcript.md`.

- **A (note).** A `UserPromptSubmit` hook printing a `hookSpecificOutput` JSON (`hookEventName: "UserPromptSubmit"`,
  a unique `additionalContext`): (1) the context reaches the agent; (2) the transcript records it apart from the user
  record, whose text is exactly what was typed; (3) a submission while the agent works runs the hook and the context
  arrives with the queued message; (4) a command that prints nothing and exits 0 leaves the prompt untouched; (5) what
  the terminal shows; (6) whether a slash command submission runs the hook.
- **C (slash commands).** Sent as a device reply: `/name args`, `/name` alone, a name that is a prefix of another
  listed name, a plugin name with a colon, a name that is not a command, `/name args` while the agent works (queued,
  refused, or a `queued_command`?), arguments long enough to be taken as a paste, and arguments with several spaces
  after the name, trailing spaces, `<`, `&` and a newline. For each: which command ran (or what the input box held
  after the key), and the record written — above all whether the recorded arguments are exactly what was written.
- **C (skill listing).** When the first `skill_listing` is written in a fresh session (before or with the first
  prompt), and after `/clear`, `/compact` and a resume; and **what writes a record with `isInitial: false`**: adding a
  skill, removing one, editing a `SKILL.md`, enabling or disabling a plugin — and whether a removal is written as a
  full re-listing.
- **B** needs no new measurement: the payload's fields are already read (and `context_window.context_window_size` is
  in it, `agent-status.ts`).

These need a real agent with injected hooks, which the planning session's permission mode refused to run: **the user
approves or runs them**; a stub agent is no substitute.

**Gates.**

- **A.** Part A goes on only if (1) the context reaches the agent, (2) the transcript records it **in a shape the
  conversation projection does not show** — an `attachment` such as `hook_additional_context`, not merely "a record
  apart from the user's message": a separate `user` record with string content would be shown by `project()` (as
  meta) in both views under every phone reply — and (5) the terminal's default screen (not its transcript mode) does not show it. If (2) yields a separate
  `user` record, part A goes on only with a task that excludes that record from the projection by its structural
  fields (never by its text), with a control group. Otherwise part A goes back to the user; the fallback is a sentence
  appended to the message (the attachment sentence's precedent: visible in both views and counted in insights,
  `r.text` still exact), **never appended to a reply starting with `/` or `!`**, whose arguments or command it would
  change.
- **C, sending.** If the submit key can run another command than the one written, or the recorded arguments differ
  from the written ones, C5's rule is chosen from the measured behavior and the design amended before 5.4.
- **C, listing.** C2's rule for `isInitial: false` is chosen from the measurement before 4.1 (C2 lists the
  candidates).

### Part A — the note

**A1. Hook context, not an appended sentence.** Appending needs no CLI behavior, but puts text the user did not type
into the user's message: both views show it under every phone reply, insights count it as the user's words. Hook
context is the CLI's channel for "context about this prompt", recorded apart from it. Its cost is a dependency on CLI
behavior, which D0 measures and which degrades to "no mark".

**A2. A one-shot, short-lived mark per session.** The hook command is the same for every prompt, so the desktop arms
a mark the hook takes:

- `SPEKTERM_ORIGIN_FILE` = `<userData>/agent-origin/<sessionId>`, in the session's pty environment. At spawn the
  directory is created and a stale mark removed; at the session's end the mark is removed beside `clearAgentStatus`.
- **Arming**: immediately before the submit key — in `sendReply` after its last re-checks, in `submitPrefill` after
  its last check — an atomic write (temporary name, rename) of a deadline, epoch seconds, `now + 10`.
- **Taking**: the hook renames the mark to a name of its own (`mv` is atomic: at most one submission takes it), reads
  the deadline, removes it, and prints the note only if the deadline has not passed.
- **Not taken** (a key that did not take, a submission the CLI does not report): the mark lapses after 10 s. Within
  that window a desktop prompt would be marked — accepted, the user just used the phone.
- **Another submission can take it first**: a background task's notice is reported as a prompt submission
  (`agent-event-bridge`), and one arriving between the key and the reply's own submission takes the mark — the note
  then rides with the notice and the reply goes unmarked. Accepted: a window of milliseconds, and the wrong note says
  only where the user reads.
- A withheld submit key (`filled-not-submitted`) never arms: arming is the last step before the key. Two device
  replies to one session are at least 500 ms apart and the hook runs at submission, so the first takes its mark
  before the second arms; if not, one prompt goes unmarked, never a desktop one marked.
- An arm that fails is no mark; the reply goes on. `armOrigin` returns `false` rather than throwing, and `sendReply`
  also wraps the call, because the text is already written when it runs: a throw there would fail a reply whose text
  sits in the input box.
- `clearOrigin` removes `<sessionId>` and every `<sessionId>.*` (a hook killed between its `mv` and its `rm` leaves
  one).

Rejected: matching the prompt text in the hook (its input is JSON; parsing it in `sh` without a JSON tool is fragile);
a mark with no deadline (a key that did not take would mark the next desktop prompt, however much later).

**A3. The hook command.**

```
cat >/dev/null; if [ -n "$SPEKTERM_ORIGIN_FILE" ] && mv "$SPEKTERM_ORIGIN_FILE" "$SPEKTERM_ORIGIN_FILE.$$" 2>/dev/null; then d=$(cat "$SPEKTERM_ORIGIN_FILE.$$" 2>/dev/null); rm -f "$SPEKTERM_ORIGIN_FILE.$$"; if [ "$(date +%s)" -le "${d:-0}" ] 2>/dev/null; then printf %s '<note JSON>'; fi; fi; exit 0
```

- **Always exit 0**: a `UserPromptSubmit` hook exiting 2 blocks the user's prompt; another non-zero exit shows an
  error. An unreadable mark is "no mark".
- Prints nothing without a mark, keeping the event bridge's rule for every other prompt.
- The whole `if…fi` is one element: split across `; `-joined elements it is a syntax error that fails on every run,
  silently (`docs/lessons/transcript.md`). Unit tests run it with `sh -c`, as `EVENT_COMMAND`'s do.
- The note JSON is embedded with `shellQuote`; no second file.

**A4. Its own contribution, only with agent events.** `prepareOriginInjection(sessionId, enabled)` in
`src/main/agent-origin.ts` returns `{ settings: {}, hooks: { UserPromptSubmit: [ORIGIN_COMMAND] }, env }`, composed
after the event bridge (`terminal.ts`'s comment on order keeps the bridge's control group meaningful). `enabled` is the
agent-events preference, as for `prepareAttachmentAccess`: without events a device cannot reply at all. No preference
of its own.

**A5. The note**, in `agent-protocol-copy.ts` (agent protocol copy: English, not in the dictionary):

> The user sent this message from their phone (the spekterm companion app) and will read your reply there. Keep it
> short and easy to read on a small screen: lead with the answer, and avoid wide tables, long code blocks and long
> paths unless asked.

It says where the user reads, not that they are away, and it is per prompt: the next desktop prompt carries nothing.

### Part B — model and usage

**B1. An event of the watched conversation, not a session list field.** `sessions.changed` carries the whole list to
every connection; context and cost change with every API call, so a list field would resend the list to every device
several times a turn, and the desktop would have to poll every running session's payload to notice. The desktop's
status bar already settled the same trade-off: one session, the one being looked at. A connection watches at most one
conversation, and that is the screen where the phone shows it. Cost: the phone's session list cannot show usage per
session; a later field can add it if wanted.

**B2. Shape**, built field by field from `readAgentStatus` (white-list, as `remote-openspec.ts` does), every field
optional:

```
conversation.status: { sessionId, model?: string, effort?: string,
  context?: { percent?: number, size?: number },
  costUsd?: number,
  rateLimits?: { fiveHour?: { percent: number, resetsAt?: number }, sevenDay?: { … } } }
```

- `model` is the display name; `effort` the agent's effort level; `context.percent` 0–100 as the agent computed it
  (or `total_input_tokens / context_window_size`, as the status bar does); `context.size` the window size in tokens
  (`AgentStatus` gains `contextSize` from `context_window.context_window_size`); `costUsd` the session's cost as the
  agent reports it; `resetsAt` in **epoch milliseconds** (the payload's seconds × 1000), as `scheduledAt`, and absent
  when the payload's value is not positive (the status bar treats `<= 0` as absent: a client would show 1970).
- An object is present only with at least one field; a rate-limit window only with its `percent`.
- Rate limits belong to the account, not the session: they are the values this session's agent last reported.
- Not sent: `cwd`, `transcript_path`, `scratchpad_dir`, `session_id`, `session_name`, any path, `version`, output
  style, lines added/removed, `thinking`.
- Text values (model, effort) have control characters removed and are clipped to 80 characters; numbers must be
  finite.

**B3. Delivery.** When the watch starts — at the same moment as the first `conversation.update` and
`conversation.wait`, which `followConversation` sends synchronously, before the answer frame — one
`conversation.status` with what is known (possibly `{ sessionId }` alone: nothing reported); then, every 2 s while the
watch lasts, a new one whenever the encoded view differs from the last one sent on that watch. A payload that cannot
be read (a new session before its first report) is "nothing reported", and the poll goes on: **it stops only with the
watch**, which ends with the session's process. The poll is per watch (at most 16 connections, one small file read
each every 2 s).

### Part C — skills and slash commands

**C1. The agent's own listing, from the transcript.** Alternatives:

| Source | Covers | Fails how |
|---|---|---|
| `skill_listing` in the transcript | exactly what the agent can invoke: user, repo and plugin skills, as the CLI resolved them | an internal format: a change makes the list absent (never wrong, white-list parse); none before the transcript has one |
| scanning `~/.claude/skills`, `.claude/skills`, plugin directories | skills on disk, before any message | reimplements the CLI's resolution (enabled plugins, settings, policies, invocation flags): drifts, and lists what the agent cannot run |
| both | — | two answers to reconcile, for a short window at a session's start |

Chosen: the transcript. A wrong list is worse than a late one, and the follow already reads the file. The window
before the first listing (D0 measures when it is written) shows no list.

**C2. Parsing** (`src/main/transcript-skills.ts`), by white-list:

- Only `type: "attachment"`, `attachment.type: "skill_listing"`, `names` an array of non-empty strings; anything else
  is ignored. The fold reads the object `projectLine` already parsed (one `JSON.parse` per line, not two).
- `isInitial: true` replaces the list; **`isInitial: false` adds its skills or updates them in place**, keeping
  first-seen order. Measured (D0, `docs/lessons/transcript.md`): an added skill or an edited description is written as
  a small `isInitial: false` record naming only those; **a removal writes nothing** — the agent is not told, and the
  removed skill stays in what it was told until the next full listing (`/clear` then a prompt, `/compact`, a
  resume). So the union is exactly what the agent was told it can invoke. Rejected: replacing on every record (a
  one-skill record would shrink the list to one). The few near-complete `isInitial: false` re-listings in local data
  that leave out a name are read as additions: the removed name stays listed, as it stays in the agent's context —
  the protocol document says so.
- A description is the text after `- <name>: ` on its line in `content`, up to the next listed name's line. A bare
  `- <name>` line (no colon; about 360 local names) has no description and still bounds the previous one. Control
  characters and runs of whitespace become one space, clipped to 300 characters; `null` when not found.
- State per follow: reset with the follow's state (`relocate`, a shrunk file), so a `/clear` to a new transcript shows
  no list until that transcript has one.

**C3. Delivery.** A `skills` callback beside the follow's `update`: `conversation.skills`
`{ sessionId, skills: [{ name, description }] | null }`, sent after the follow's first read and whenever the list
changes (by value), `null` meaning "no listing in the transcript followed now". The desktop's renderer does not
subscribe to it.

**C4. A slash command is shown as typed.** In `project()`, a `user` record whose string content is **only** command
markers — `<command-name>` once, optional `<command-message>` and `<command-args>`, **in any order**, whitespace between
— becomes a user entry with text `/name` or `/name args` (args trimmed), `meta` as today. Only `<command-name>` and
`<command-args>` are read (`<command-message>` always repeats the name, 188 of 188 locally). Any other content is shown
as recorded (the paste rule's shape: whole message only). The expanded skill body that follows is already a meta
record. **A built-in command's `<local-command-stdout>` record is not changed** and still shows its markers: only the
command line is restored (a known gap, out of scope).

**C5. Sending `/skill args` from a device.** Measured (D0): the submit key runs the command written — a name that
is a prefix of another is not swapped by the completion list — and the CLI records the arguments verbatim except for
trimming both ends. So the desktop — not the client — writes a reply whose cleaned text starts with `/` trimmed, with
the run of whitespace after the name made one space, and `r.text` is then the line C4 shows. Nothing else changes in
`conversation.send`. The protocol document states: a command sent while the agent works runs after its turn; an
unknown command is answered by the CLI locally and reaches neither the agent nor the conversation (the reply stays
"not confirmed"); a command whose text is long enough to be taken as a paste (about 2,000 characters measured) is
not run, and arrives as a plain message (bisected later: more than 800 characters, counted in characters, newlines
not counted extra); built-in commands and skills only the user may invoke are not listed.

### D6. The protocol document

- `conversation.send` and `sessions.submitPrefill`: the desktop tells the agent, outside the message, that it came from
  the user's phone; `r.text` and the recorded message do not include it; a client does nothing for it.
- `conversation.watch`: the two new events with their shapes and semantics (B2, B3, C3), each absent from older
  desktops (no `operations` entry: an event the client never receives shows nothing), as list items of that section,
  **never as `###` headings** (`remote-protocol-doc.test.mjs` reads those as operations). The section's "→ `r`, then
  events" is corrected: the first events arrive before the answer.
- `Entry`: a slash command's `user` entry is the typed line; C5's outcome; obligation 15 extended to skill
  descriptions (plain text).

## Risks / Trade-offs

- [The CLI changes `UserPromptSubmit` output handling, or the `skill_listing` shape] → no mark / no list, silently.
  D0's steps are written into `docs/lessons/transcript.md` as the re-measurement for a CLI upgrade.
- [The note is invisible to the user] → the user chose automatic marking; the protocol document and the website say it
  happens.
- [A slash command or `!` input from a device is not reported as a submission] → its mark lapses unused; a desktop
  prompt within 10 s would be marked. Accepted.
- [The `isInitial: false` rule is not known yet] → gated on D0 (C2); the chosen rule's failure is documented.
- [A per-watch 2 s poll] → bounded by the 16-connection cap; nothing runs without a watch.
- [Rate limits shown as the session's] → documented as the account's, last reported by this session's agent.
- [The skill list lags a session's start] → shown as "no list", never as an empty list.

## Migration Plan

None. Sessions started before the upgrade have no origin hook (replies unmarked) until restarted or woken; the usage
and skill events need nothing from the session.
