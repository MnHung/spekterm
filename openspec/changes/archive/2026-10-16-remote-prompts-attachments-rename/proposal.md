## Why

The maintainer used the companion Android app against spekterm and found three things it cannot do. None is a
defect: the remote protocol (`docs/remote-protocol.md`) does not offer them.

1. **Answering a choice on the phone.** When an agent raises a permission prompt or asks a question with its
   question tool (`AskUserQuestion`), the phone can only say "answer it on the desktop". `conversation.wait`
   reports the pending request as `{ tool, arg }`. That does not tell the phone what the options are or which
   keystroke picks each one. The phone could type into the terminal (`terminal.input`), but blind typing is
   dangerous: text and Enter typed into an open prompt approve it (`companion-test-fixes`, design).
2. **Attachments.** The phone cannot give an agent a photo, a screenshot or a file. No operation carries file
   contents.
3. **Renaming a session.** The desktop can rename a session, and clearing the name hands naming back
   (`terminal-sessions`). The phone cannot.

The maintainer decided the order: the desktop first, then the phone. All three protocol additions land in this
one change, so the protocol changes once. The Android app follows in its own repository.

Measuring the real agent for item 1 found **a defect that ships today**. When a background subagent asks
permission, the agent reports its turn end while the prompt is open. A background-task notice can then arrive
as a prompt submission. The wait state reads ready over an open prompt. A reply sent from the desktop's
conversation view or from the phone in that state writes text and Enter, and that approves the prompt. The
answering this change adds depends on a wait state that knows when a prompt is open, so the fix is part of
it.

## What Changes

Every addition below was designed against a real agent: CLI 2.1.300, hooks injected through `--settings`,
driven through a pty (design, "Measurements").

1. **The wait state tracks every open permission request.**
   - Each request is matched to its tool call.
   - It is closed by:
     - that call's end;
     - for a request of the agent itself, the agent's own turn end or submission;
     - for a subagent's request, the subagent's end. `SubagentStop` is added to the injected hooks.
   - While any request is open, the state is awaiting-choice.
   - Queued requests are shown in the order they arrived, which is the order the terminal shows them.
   - Each request gets an identity from the desktop.
2. **The watched conversation states the open prompt.** `conversation.wait` gains `prompt`: the first open
   request's identity, what it asks, how many are open, and whether the phone may answer it.
   - A permission prompt's terminal options are not in the agent's request, and their number varies, so the
     phone offers only "allow once" and "deny". It offers "allow once" only for tools whose prompt was
     measured to put it first. The plan approval is its own kind: the phone sees the plan and chooses "approve,
     asking before each edit", "approve with auto mode" or "deny"; the mode the agent enters is confirmed.
   - A question's options are in the request, and the phone offers them.
3. **A new operation answers one specific prompt**: `conversation.answer`. The desktop turns the answer into
   keystrokes, writes them one at a time, and never includes Enter.
   - Before every key it reads the agent's events again. It writes the key only while exactly one request is
     open, it is the one answered, and nothing else was typed into the session since that request appeared.
   - A question's answer is checked against what the agent records.
   - A denial written for the phone closes the request. For the agent's own prompt, it also leaves the agent
     ready, so the phone can reply next.
4. **Attachments.** A new operation uploads a file in chunks to a store the desktop owns
   (`<userData>/remote-attachments/<session>/`). `conversation.send` gains a list of uploaded attachments,
   and the desktop adds a sentence to the reply naming their paths.
   - The phone never names a directory, and the desktop chooses the file name.
   - Allowed: images (PNG, JPEG, GIF, WebP), PDF, and UTF-8 text.
   - Limits: 10 MiB per file, 10 files per reply.
   - Agents get a read-only permission rule for the store through the injected settings. Without it, reading
     raises a permission prompt (measured).
   - Files are kept until their session is closed, or for 30 days. Unsent ones are removed after 24 hours.
5. **A long reply is shown as the text that was sent.** The agent records a reply taken as a paste inside
   paste markers. The conversation shows the markers, and "not confirmed" never clears. Replies with
   attachments are long.
6. **A new operation renames a session**: `sessions.rename`. The desktop's interface carries it out quietly,
   with the desktop's naming rules.
7. **The authentication answer lists the operations this desktop accepts.** A client shows the new controls
   only when the desktop offers them. The protocol stays version 1: every addition is a new field, operation,
   event value or error code, which §9 already asks clients to tolerate.
8. **Two path rules are made explicit**, without changing what the code does. "Event content contains no
   absolute path" (`agent-event-bridge`, `agent-transcript-stream`) applies to the fields the system selects.
   Text written by the user, the agent or the desktop is shown as plain text. The code has always worked this
   way; a tool's identifying argument is a path on purpose.
9. **The protocol document, the website's remote-access and conversation-view pages (both languages) and the
   agent lessons are updated.**

## Capabilities

### New Capabilities

- `remote-attachments`: where a device's uploaded files are stored, what is accepted, the limits, how long
  files are kept, and how agents are allowed to read them.

### Modified Capabilities

- `agent-event-bridge`:
  - open permission requests are tracked one by one, and keep the state on awaiting-choice;
  - each request has an identity;
  - questions and recorded answers are carried by white-list;
  - the pending request is the first open one;
  - a device's denial and a subagent's end are no longer blind;
  - the path rule's scope is stated.
- `agent-transcript-stream`: a message recorded as one paste is shown as its text; the path rule's scope is
  stated.
- `remote-protocol`:
  - the operation allow-list gains renaming, uploading attachments and answering a prompt;
  - "writing files is not an operation" is narrowed to allow the desktop's own store;
  - the watched conversation states the open prompt;
  - answers are tied to one prompt;
  - the authentication answer lists the operations;
  - renaming joins the operations refused without a window.

## Impact

- **Code**:
  - `src/main/agent-events.ts` and `agent-wait.ts`: open requests, identities, questions, `SubagentStop`, a
    refresh on demand, and closing a request after a device's denial;
  - `src/main/terminal.ts`: the time of each write, and the injection contribution;
  - `src/main/ipc/terminal.ts`: removal of attachments on close;
  - `src/main/remote-protocol.ts`, `remote-host.ts` and `remote-conversation.ts`: the operations, and
    attachments on send;
  - a new `src/main/remote-answer.ts`: key plans and guards;
  - a new `src/main/remote-attachments.ts`: the store, limits and sweeps;
  - `src/main/remote-server.ts`: the operation list;
  - `src/main/transcript-follow.ts`: the paste shape;
  - `src/main/agent-protocol-copy.ts`: the attachment sentence;
  - `src/preload/index.ts` and `RemoteRequests.tsx`: the rename action;
  - `src/main/index.ts`: wiring and the startup sweep.
- **Behavior on the desktop**: over an open background-subagent prompt, the conversation view's input is now
  refused (it used to be allowed), and the session reads as waiting on a choice. That also reaches
  auto-hibernation, the close confirmation, the intake check, the handoff lifecycle and the session list.
- **Tests**: unit tests for each module; `probe:remote` and `probe:agent-view` through the stub agent, which
  gains a control file. The real agent's TUI cannot be probed. Its key behavior rests on the measurements,
  recorded in `docs/lessons/transcript.md`, and on dogfood.
- **Protocol**: version 1, additive. Old clients are unaffected.
- **Disk**: a new directory under userData, listed on the website.
- **No new dependency, no new network surface.**
- **Out of scope**: the Android app (a handoff to `spekterm-android` after archive). Answering from the
  desktop's view. Answering when several prompts are open. "Allow" for unmeasured tools, MCP tools among them.
  Free-text answers.
