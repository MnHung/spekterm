## Why

An agent that needs a related session which is hibernated cannot reach it: Claude Code's session messaging answers
"no agent named '…' is reachable", and the introduction tells the agent it must not wake the session itself. In
dogfood, a child agent that wanted to coordinate with its hibernated parent before touching the parent's files gave
up on the message and wrote a new handoff instead, which opened a **second** session in the parent's repo — the very
overlap it was trying to avoid. Waking a dormant session ends nothing and loses nothing, so it does not need the
narrow reach that close and hibernate have.

## What Changes

- A fourth session command, `{"kind": "wake", "target": "<name>"}`, written into the agent's own drop point under the
  same delivery rules as the other commands.
- **Its reach is the agent's relations file**: its parent, its siblings, and every session in its tree of
  descendants. Close, hibernate and rename keep their narrower reach (own session and descendants).
- It is carried out **at once, without asking the user**, by the desktop's own wake, **quietly** (no selection change,
  no focus taken). There is no turn to wait for: a dormant session has none. A running target is left as it is.
- It does not need agent event reporting.
- A wake written before the target's process last started or ended (the user woke or hibernated it in between), or
  before the application started, is dropped, as close and hibernate are.
- The introduction states the command, its reach, and how to know the woken session can be messaged (its relations
  entry turns `"running": true`, then its name appears in `ListAgents`); that a parent is not woken only to report;
  and that a wake that did not take is not repeated without asking the user. The sentence "you must not try to wake
  it yourself" goes. It stays within its current 8,500-character budget.
- A refusal's reason, to the agent and in the inbox, no longer says "a session you did not hand off" (wrong for a
  wake, whose reach includes the parent and siblings).
- A dormant session may now start on an agent's wake as well as the user's (the "starts only on an explicit wake"
  rule names it).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-session-control`: adds the wake command, its reach (the relations file) and its timing (at once, quiet,
  no confirmation); the reach rule of the other three commands is renamed to say it is theirs.
- `agent-handoff-source`: the introduction states the wake command, its reach, and when the woken session can be
  messaged.
- `session-hibernation`: the introduction no longer forbids an agent to wake a not-running relative; it points to
  the wake command.
- `session-persistence`: a dormant session starts on an explicit wake **or an agent's wake command**, never on
  display.
- `global-session`: the same for a restored global session.

## Impact

- `src/main/handoff-delivery.ts` (command kinds, parsing), `src/main/session-control.ts` (reach and carrying out),
  `src/main/handoff-intro.ts` (introduction text and its budget test).
- The renderer's existing quiet wake (`RemoteRequests.tsx`, the path a paired device's wake takes) is reused; no new
  IPC channel.
- `scripts/probe-intake.mjs` (`runSessionControl`), `scripts/scenario-coverage.test.mjs`.
- `src/main/agent-protocol-copy.ts` and the `en` / `zh-TW` dictionaries (the refusal's reason).
- Docs: `CLAUDE.md` (hibernation and session-command paragraphs), `docs/lessons/handoff.md` ("Session commands"),
  `terminal-sessions`'s Purpose, and the website's handoff and terminal docs in both languages.
