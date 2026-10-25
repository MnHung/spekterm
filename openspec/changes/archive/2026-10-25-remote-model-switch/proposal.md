## Why

The phone cannot change an agent's model. Sending `/model <name>` through `conversation.send` does reach the
agent, but when the conversation has content and the prompt cache is warm, the CLI opens a confirmation box in
the terminal ("Switch model? This conversation is cached for the current model…"). The box is not a hook event,
so the wait state stays `ready` or `busy`: the phone cannot see it or answer it. Worse, while it is open the
next reply's submit key presses its "Yes" — that reply is lost and the user has confirmed a switch they never
saw. (Measured by the phone's author on CLI 2.1.310; the same happens while the agent works.)

The CLI documents a `PreModelSwitch` hook whose `allow` decision skips exactly this box. spekterm already
injects hooks per session and already arms one-shot marks for a device's prompt (`agent-origin.ts`). The same
mechanism can let a switch the phone asked for through, and only that one.

## What Changes

- A new remote operation `conversation.setModel` (`sessionId`, `model`): writes `/model <model>` into the watched
  conversation exactly as `conversation.send` writes a reply (same gates, errors, queue, re-checks, outcomes),
  and answers `{ outcome, text }`.
- Immediately before the submit key of a `/model <name>` reply — from `conversation.setModel` **or** from
  `conversation.send` — the desktop arms a one-shot, time-limited mark in the session's own file. A
  `PreModelSwitch` hook injected into the agent session takes the mark and answers `allow` only when the switch
  is a command whose requested name equals the armed one; in every other case it prints nothing and the CLI
  behaves as it does today (a switch the user makes at the desktop still asks).
- `conversation.setModel` joins `operations`; a client shows the control only when it is listed.
- `docs/remote-protocol.md` documents the operation, the arming (including for a hand-typed `/model x`), what a
  client can and cannot observe (no dialog signal; the change shows as `conversation.status`'s model), and
  corrects the line that says a command sent while the agent works "runs after its turn" — built-in `/model` and
  `/effort` run at once (measured).
- `/effort` is not touched.

## Capabilities

### New Capabilities

- `agent-model-switch`: the armed, one-shot permission for a model switch a device asked for, and the injected
  hook that honours it.

### Modified Capabilities

- `remote-protocol`: the operation allow-list gains `conversation.setModel`; a reply that is exactly a one-name
  `/model` command arms the switch permission.

## Impact

- `src/main/agent-model-switch.ts` (new, beside `agent-origin.ts`), configured in `index.ts` beside
  `configureAgentOrigin`, wired into `terminal.ts` where `prepareOriginInjection` is, and into
  `remote-conversation.ts`'s `sendReply`; `remote-protocol.ts`, `remote-host.ts` (the `armModel` dependency);
  `scripts/lib/stub-agent.mjs`; `docs/remote-protocol.md`, `docs/lessons/transcript.md`, `CLAUDE.md`, website remote-access
  docs in both languages.
- No new dependency, no network, no change to the renderer. The mark lives under `<userData>`, like the origin mark.
- The change depends on a CLI behavior that is documented but was **not measured** when this was written (D1);
  the first task measures it and the change stops there if it does not hold.
