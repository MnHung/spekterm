## Why

The status dot beside every session, on its rail row and on its tab, says only whether the process is alive,
hibernated or ended. It does not say whether an agent is still working or is waiting for the user. To find the agent
that stopped, the user has to open each session in turn. The desktop already knows the answer: the injected hooks
report each agent session's wait state to the main process (`agent-event-bridge`). The paired phone already shows that
state as "Working", "Waiting for you" and "Asks for a choice". Only the desktop's own rail and tabs do not.

The approved mockup (`docs/workspace-mockup.html`) has always drawn these states: a green `running` dot, a pulsing
amber `waiting` dot, and a folder row that carries the state of its most urgent session. `session-badge.tsx` records
them as deferred to "a later phase".

## What Changes

- The main process derives an **attention state** for every running agent session and pushes the whole list to the
  renderer. Today the wait state reaches the renderer only for the one session whose conversation view is open.
- An agent session's status dot shows one of five states:
  - **asks for a choice**: a permission prompt or question that the user has not answered;
  - **waiting for you**: the agent finished its turn and no one has looked at the session since;
  - **working**: a turn is in progress;
  - **idle**: the turn ended and someone has already looked at the session;
  - **running**: the state is unknown, which shows as today's green dot.

  Shell, hibernated and ended sessions keep the dots they have today.
- "Looked at" means one of two things: the session was displayed in the focused desktop window, or its conversation
  was open on a paired phone. Without this rule, every agent sitting at its prompt would pulse forever, and the signal
  would carry nothing. The **main process owns the seen mark**, so the desktop and the phone read the same answer, and
  looking on either one clears it on both. Agents that are started or resumed are not marked as waiting.
- Three blind spots of the agent's event reporting are handled rather than shown wrong:
  - a background subagent's tool start that arrives after the turn ended does not count as "working";
  - a prompt the user denied at the desktop is read from the keystroke, because the agent reports nothing for a
    denial;
  - an interrupted turn (Esc) reports nothing at all and stays "working" until the next prompt. This one is accepted.
- A folder row on the rail, and the global item's row, carries one dot for its most urgent session. The order is:
  waiting, ended with an error, working, running, idle, hibernated or ended. A collapsed folder therefore still tells
  the user that something inside it needs them.
- The tooltips state the attention state in words, from the dictionary, in both languages.
- **A handoff's "Waiting for you" follows the same seen mark.** Today it means "the agent stopped", which would
  contradict an idle dot beside it once the user has read the child. After this change, a child the user has looked at
  shows no lifecycle state until it works again or reports done. Agents reading the relations file see `idle` for
  that child.
- The remote protocol's `Session` gains `seen`. It is always present while `wait` is `ready` and absent otherwise, so
  the phone can apply the same rule. The phone's side is part of spekterm-android's `session-relations` change. A
  phone talking to an older desktop (no `seen`) keeps treating `ready` as waiting.

**For review:**

- **Idle deviates from the mockup.** The mockup's idle dot is grey, but grey is already this app's hibernated dot. This
  change draws idle as a hollow green ring ("alive, resting").
- **The handoff lifecycle now follows the seen mark**, as described above.

## Capabilities

### New Capabilities

- `session-wait-indicator`: covers
  - what an agent session's status dot shows, and how each state is derived, including the three blind spots;
  - the seen mark: owned by the main process, fed by the focused desktop display and by a device's conversation
    watch, and never persisted;
  - the complete projection of every running agent session to the renderer;
  - the rail item's most-urgent dot.

### Modified Capabilities

- `remote-protocol`: `Session` gains `seen`. A conversation watch counts as looking; a terminal watch does not.
- `handoff-completion`: "waiting" requires an unanswered choice or an unseen turn end; a ready child that the user has
  seen presents no state.

## Impact

- Main process:
  - new modules: `src/main/wait-seen.ts` (the mark), `src/main/looked-at.ts` (who is looking), and
    `src/main/ipc/wait.ts` (the projection and its push), fed by the existing `observeWaits`;
  - `hibernation.ts` gains a conversation-only watch read;
  - `remote-host.ts` adds `seen`;
  - `handoff-lifecycle-view.ts` and `src/shared/lineage/lifecycle.ts` read the seen mark;
  - `agent-events.ts` / `agent-wait.ts` gain a `sessionStarted` batch flag (a wake or `/clear` is not a turn end).

  There is no new hook, and what the agent reports does not change.
- Shared: `src/shared/wait/attention.ts`, holding the derivation and the ranking.
- Renderer:
  - `session-badge.tsx` (`StatusDot`, `statusTitle`);
  - `WorkspaceRail.tsx` (the rail item dot and the row title) and `SessionTabs.tsx`;
  - a new `WaitProvider`.
- Preload: a `wait` namespace (also added to `probe:shell`'s allow-list).
- Dictionaries: new strings in `en.json` and `zh-TW.json`.
- Protocol document: `docs/remote-protocol.md` documents `seen`.
- Tests:
  - unit tests for each new module;
  - new sections in `probe:agent-view` and `probe:remote`;
  - a stub-agent option to start without a turn end;
  - scenario-coverage rows.
- Documentation:
  - website docs in both languages (sessions and handoffs);
  - `docs/lessons/transcript.md` (the blind spots);
  - `CLAUDE.md`.
