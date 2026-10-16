## Why

An agent running in spekterm cannot act on spekterm itself. When the user tells it "close this session" or
"hibernate the handoffs you finished", the agent can only answer that it has no way to do so, and the user
reaches for the mouse. The pieces already exist: the agent writes to its own drop point (handoffs, completion
reports), and the desktop's hibernate, close and rename can be carried out quietly on request (built for paired
devices in `remote-hibernate-close`). What is missing is a way for the agent to ask.

## What Changes

- An agent can ask spekterm to **close**, **hibernate** or **rename** a session by writing a command to its own
  drop point — a third kind of delivery next to a handoff and a completion report.
- A command may target **the agent's own session** or **any session descended from it by handoff** — the
  sessions it handed off, the ones those handed off, and so on — by the name listed in its relations file. Any
  other session (its parent, its siblings, an unrelated session) is refused, and the refusal is visible to the user
  the way a failed handoff is.
- **The relations file lists descendants, not only children.** Today an agent sees its parent, children and
  siblings; a grandchild is invisible to it, so it could neither find nor address one. Each child entry gains the
  sessions it handed off, recursively, with the same fields (name, repo, title, running, state, summary).
- **A descendant stays reachable when a session between them closes.** If P hands off to C and C to G, closing C
  must not make G a stranger to P. Lineage today records only the direct parent, which is gone once C's record
  is removed; the chain of ancestors is recorded when the handoff is received, so the link survives.
- **A command on the agent's own session waits for the end of its current turn.** The agent writes the command
  while it is still answering; carrying it out at once would cut off that answer. The same rule applies to a
  descendant: spekterm does not end its work in the middle of a turn. Typing into the target while the command
  waits cancels it: the user has taken that session back.
- Every action runs through the desktop's own path for it (the one the session tab's menu uses), quietly: no
  change to the rail selection, the focused session, or keyboard focus — the same rule paired devices follow.
- The agent's introduction (injected at session start) states the commands, their targets, and their limits.
  As with handoffs, the agent is not told whether a command was carried out; the introduction says so.

## Capabilities

### New Capabilities

- `agent-session-control`: commands an agent writes to its drop point to close, hibernate or rename its own
  session or a descendant session; who may target what; when a command is carried out; what a refused or unknown
  command does.

### Modified Capabilities

- `agent-handoff-source`: the introduction an agent receives at session start also states the session commands
  and their constraints, from the same constants the judgement uses.
- `session-lineage`: the relations an agent can read include all its descendants, not only its children; a
  session created by handoff records its whole chain of ancestors, so a descendant stays one after an intermediate
  session closes. The rail's indentation and the "← source" / "→ N" marks are unchanged.

## Impact

- Session records: the lineage written before spawn gains the ancestor chain (`session-store.ts`); records
  written before this change have only the direct parent, and their chain is rebuilt from the records that still
  exist (a link already broken by a closed intermediate stays broken).
- Relations file (`handoff-relations.ts`): children carry their own descendants.
- Main process: the drop point's delivery dispatch (`handoff-service.ts`, `handoff-delivery.ts`), the
  introduction (`handoff-intro.ts`), a new module that parses commands, resolves targets against the lineage, and
  defers them to the end of the target's turn (using the agent wait state, `agent-wait.ts`).
- The request channel to the window (`workspace:remote:request`, `RemoteRequests.tsx`): commands reuse its
  hibernate, close and rename actions instead of adding a second path. The preload already passes them.
- The agent event fold (`agent-events.ts`, `agent-wait.ts`) gains an "at rest" flag: `ready` alone does not mean a
  turn has ended.
- Failure visibility: refusals go through the existing intake rejection path (notification and inbox trace); the
  notification's text distinguishes a session command from a handoff.
- Website docs (both languages): the handoff page gains the agent's session commands.
- Turn tracking (`agent-events.ts`, `agent-wait.ts`, `pty-input.ts`): a turn starts with a submission or a write
  into the pty, and ends only at the agent's own turn end.
- A per-window gate on requests until the window has restored its sessions (`ipc/terminal.ts`), and a process-wide
  record of each session's last process start and end, so a command never outlives the user's own later action on
  its target.
- The intake source passes the read's file stat to deliveries (`intake-source.ts`).
- Notifications (`intake-notify.ts`): a failed session command is named as such.
- No new dependency, no change to the remote protocol's operations.
