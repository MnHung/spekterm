## Why

The user drives agents from the companion phone app (`spekterm-android`) while away from the desk, and three things the
desktop knows never reach the other side of that connection:

1. **The agent does not know a reply came from the phone.** It answers a phone reply as it answers a prompt typed at
   the desktop — wide tables, long code blocks, long absolute paths — and the user reads that on a small screen. The
   user decided every reply sent from a device is marked automatically, with no "I am away" switch, and that the phone
   app does not change for it.
2. **The phone cannot see a session's model and usage.** The desktop's status bar shows the model, effort, context
   used, cost and rate limits the agent reports (`claude-status-bridge`); the remote protocol sends none of it.
3. **The phone cannot tell which skills a session can run**, so the user cannot use them from the phone, and nothing
   says whether `/skill-name args` sent as a reply even works there.

The phone side of 2 and 3 waits on the protocol; the phone's own work (message times, the background list) is done in
that repository.

## What Changes

- **A prompt submitted from a device carries a note for the agent** that the user sent it from their phone and reads
  the answer there. It reaches the agent as hook context of that one prompt (`UserPromptSubmit`, injected through the
  same `--settings` seam), **not as text appended to the message**: the recorded message, both conversation views,
  `r.text` and the client's "not confirmed" matching (obligation 9) stay as they are. Marked: a `conversation.send`
  reply whose submit key was written, and `sessions.submitPrefill`. Not marked: a prompt typed at the desktop,
  including the next one after a phone reply — except within 10 s of a note no submission took (design A2). One-shot and short-lived (armed right before the device's submit key,
  lapses after 10 seconds).
- **A watched conversation carries the agent's reported model and usage**: a new event `conversation.status` with the
  model's display name, effort, context used (percent and window size), the session's cost, and the five-hour and
  seven-day rate limits with their reset times — field by field from the status bridge's payload, absent when the
  agent did not report it, and nothing path-like. Sent when a watch starts and when a value changes, checked every 2
  seconds; never through `sessions.changed`.
- **A watched conversation carries the skills its agent can invoke**: a new event `conversation.skills` with each
  skill's name and description, from the agent's own listing in its transcript (`skill_listing` records), or `null`
  when the transcript followed holds none yet. Built-in CLI commands (`/clear`, `/compact`) are not listed.
- **A slash command is shown as the line the user typed**: the conversation projection restores the agent's recorded
  command line (`<command-name>` / `<command-args>`, in either order) to `/name args`, so the desktop and phone views
  stop showing markers for the command itself, and a device reply starting with `/` is written in that same form, so it
  matches its `r.text`. A built-in command's separate output record (`<local-command-stdout>`) is unchanged.
- **The skill listing's later records are measured before they are read**: local transcripts hold both small updates
  and near-complete re-listings that leave out a removed skill, so the rule for them is chosen from what the agent
  does (design C2).
- **Sending `/skill args` from a device is measured with a real agent** (the input box's command completion versus the
  submit key written 500 ms later) and the result written into the protocol document — as working, or with the rule
  the desktop then applies.
- The measurements need a real agent with injected hooks, which the planning session's permission mode refused: the
  user approves or runs them.
- `docs/remote-protocol.md`: the two events, the note, the slash-command line; protocol version stays 1 (new events
  and fields only, obligation 7).
- The agent CLI behavior each part rests on is **measured first**, before code depends on it (design D0).

Not in scope: the phone app (it builds against the document); a manual "away" switch; marking raw `terminal.input`;
built-in CLI commands in the skill list; usage in `sessions.list`; hiding `monitor` background tasks on the desktop
(the desktop lists no background tasks at all, so there is nothing to hide).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-protocol`: a device's prompt tells the agent it came from the phone; the watched conversation carries the
  agent's reported model and usage, and the skills it can invoke; the document describes the slash-command line.
- `agent-transcript-stream`: a recorded slash command is shown as the line the user typed.

`claude-status-bridge` keeps its requirements: a device reads the payload it already writes, through the same reader.

## Impact

- New: `src/main/agent-origin.ts` (the note's hook and mark), `src/main/remote-agent-status.ts` (the usage view and its
  poll), `src/main/transcript-skills.ts` (the skill listing).
- Changed: `agent-protocol-copy.ts` (the note), `agent-status.ts` (window size), `terminal.ts` (one more injection
  contributor), `remote-conversation.ts` / `remote-host.ts` (arming; the two events), `remote-protocol.ts`
  (`ConversationSink`), `transcript-follow.ts` / `transcript-follow-service.ts` (slash restore; the listing),
  `conversation-follow.ts`.
- Probes: `probe:remote` (note, both events, the slash line), `probe:agent-view` (the slash line on the desktop); the
  stub agent writes a skill listing and a slash-command record.
- Docs: `docs/remote-protocol.md`, `docs/lessons/transcript.md` (the measurements and the silent-failure rules), the website's
  remote access and conversation pages in both languages, `CLAUDE.md` (the remote access paragraph and the lessons
  trigger table), `scripts/scenario-coverage.test.mjs`.
- No new dependency, no protocol version change. A desktop release follows, then a handoff to `spekterm-android`.
