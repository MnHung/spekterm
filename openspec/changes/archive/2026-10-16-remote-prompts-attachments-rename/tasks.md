## 1. Open permission requests (agent events)

- [x] 1.1 `agent-events.ts`:
  - add `SubagentStop` to `HOOKED_EVENTS`;
  - `parseEvent` keeps `tool_use_id`, a hash of `tool_input` (not the input), the event file's timestamp
    (passed in by `drainEvents`), `SessionStart`'s `source`, `Stop`'s `background_tasks` (ids and status
    only), and `questions` and `answers` for `AskUserQuestion` by D2's white-list and clipping;
  - update the hook table and the boundary note in the module comment.
- [x] 1.2 `agent-events.ts`: `drainEvents` holds the base state, the unmatched tool starts and the open
      requests, and applies D1's table:
  - a new id per request (id source injectable), matched to the latest unmatched start of the same agent,
    tool and input hash, with that start's `at`;
  - removal by `tool_use_id`; by the agent's own `Stop`/`StopFailure`/`UserPromptSubmit` (its own requests
    and starts); by the agent's own `Stop` for subagents not listed as running; by `SubagentStop`; by
    `SessionStart` unless `source` is `compact`;
  - the base state excludes `PermissionRequest` and `SubagentStop`;
  - the reported state is awaiting-choice while any request is open;
  - `pending` is the first open request;
  - every return path returns what it holds.
- [x] 1.3 `agent-wait.ts`:
  - `WaitSnapshot`, `foldDrain` and the per-session store carry the base state and the open requests;
  - add `openRequestsOf(sessionId)`, `refreshWait(sessionId)` and `dismissRequest(sessionId, id, own)`
    (D3, D4);
  - `clearWait` clears them, and `forgetRequests` clears the requests and the state on every pty exit
    (`ipc/terminal.ts`).
- [x] 1.4 Unit tests (`agent-events.test.ts`, `agent-wait.test.ts`), event sequences copied from the
      measurements:
  - one prompt answered;
  - one dismissed, then a submission;
  - a retried call after two parallel starts were dismissed (it gets the new start's id);
  - two parallel requests;
  - two parallel starts, only the second requested, the first finishing (the request stays open);
  - two background subagents with `Stop` and a notice submission between;
  - a subagent dismissed (`SubagentStop`);
  - a subagent request closed by a `Stop` that does not list it as running;
  - a helper's `SubagentStop` after `Stop` (state stays ready);
  - `SessionStart` with `source` `compact` keeps the requests, while `startup`, `resume` and `clear` remove
    them;
  - an unmatched request;
  - identities kept across `Notification` and empty drains, and new per request;
  - question and answers parsing, clipping, and malformed cases;
  - `refreshWait` drains once, and its batch reaches subscribers and observers;
  - `dismissRequest` for the agent's own prompt (ready) and a subagent's (state unchanged).

  Control: revert each row of D1 and confirm its case goes red. The subagent sequences must go red with the
  old rule (clear on any `Stop`/`UserPromptSubmit`). The parallel sequence must go red when matching ignores
  the input.

## 2. Answering a prompt

- [x] 2.1 `terminal.ts`: `write(sessionId, data, origin?)` reports every write to a new `pty-input.ts`, which
      records the wall-clock time of every keystroke (D3: not an answer's own keys, not a focus or mouse
      report) and exposes `lastKeystrokeAt(sessionId)` for the answer checks.
- [x] 2.2 New `src/main/remote-answer.ts`:
  - the key plan for each row of D3's table;
  - `canAllow` with the measured tool list;
  - answerability (count, desktop input, question size);
  - selection validation and the refusal codes;
  - writing one key at a time, 250 ms apart (Tab past a several-choice question), with `refreshWait` and the
    five checks before each key, setting `answeredAt` on the first key;
  - outcomes `sent`, `partial`, `confirmed`, `mismatch` (waiting up to 3 s for the recorded answers);
  - `dismissRequest` after a `deny`.

  The module comment cites the measurements and points to the lesson.
- [x] 2.3 `remote-conversation.ts`: answers share the per-session queue with replies, and the `WAIT_STATE`
      message names `conversation.answer`.
- [x] 2.4 `remote-protocol.ts` and `remote-host.ts`:
  - `conversation.answer`;
  - the relay sends `prompt` in `conversation.wait` (D5), computed from the open requests and
    `lastInputAt`;
  - `ConversationSink.wait` carries what it needs.
- [x] 2.5 `remote-frames.ts`: the error codes `PROMPT_GONE`, `NOT_ANSWERABLE`, `TOO_LARGE`, `TOO_MANY`,
      `UNSUPPORTED_TYPE`.
- [x] 2.6 `remote-answer.test.ts`:
  - each key plan (one single-choice question; several questions; a final several-choice question; allow;
    deny; decline);
  - no plan contains `\r`;
  - pacing;
  - each of the five checks failing before the first key (`PROMPT_GONE`) and before a later key
    (`partial`);
  - a second answer after an allow, while the tool runs, is refused;
  - `confirmed`, `mismatch`, and `sent` when no answers arrive;
  - `canAllow` false for `ExitPlanMode` and an unmeasured tool;
  - the plan keys (with and without a plan), `approve-auto` refused without a plan, and `confirmed` /
    `mismatch` from `permission_mode`;
  - each refusal;
  - an answer queued behind a reply;
  - a deny leaving the agent ready.

  Control: drop each check in turn and confirm its case goes red.
- [x] 2.7 `terminal.test.ts`: a keystroke records its time; an answer's write, a focus report and a mouse report
      do not.
- [x] 2.8 `conversation-follow.ts`: send a wait update when the prompt, `open` or `answerable` changes, and
      push one on the first keystroke after a request and after `dismissRequest` (D5). `agent-events.ts`:
      `choiceRaised` holds one entry per request in the batch, and `remote-attention` raises one `choice`
      event each. Unit tests for both.

## 3. Attachments

- [x] 3.1 New `src/main/remote-attachments.ts` (Electron-free, root injectable):
  - chunked put with offset checks;
  - D6's limits;
  - signature and UTF-8 checks;
  - name cleaning and the `.txt` rule;
  - mode 0600;
  - the `path.relative` containment check;
  - `pending/` and `sent/`, with `.partial` then rename;
  - reserving attachments for a send (complete, same session, unsent), moving them to `sent/` just before the
    text is written, and releasing the reservation if the reply fails first;
  - the sweeps (unsent after 24 h; startup: unknown sessions and files older than 30 days);
  - removal of a session's directory.
- [x] 3.2 `remote-protocol.ts` and `remote-host.ts`: `attachments.put`; `conversation.send` takes
      `attachments` (at most 10). Text may be empty with attachments, and the answer carries `text`. The
      parameter checks accept an empty string where D6 and D8 allow it.
- [x] 3.3 `agent-protocol-copy.ts`: the attachment sentence (paths in backticks inside the sentence; singular
      and plural). `remote-conversation.ts` appends it.
- [x] 3.4 Wiring:
  - `remote-attachments.ts` exports `prepareAttachmentAccess(enabled)` (a `Read(/<root>/**)` allow rule), and
    `terminal.ts` adds it to `composeInjection` with the agent-events preference;
  - `ipc/terminal.ts`'s `kill` handler removes the session's directory, for a live and a dormant session;
  - `index.ts` configures the root and runs the startup sweep against the session store;
  - `remote-server.ts`'s frame-cap comment is updated.
- [x] 3.5 Unit tests:
  - `remote-attachments.test.ts`: every check of 3.1, including:
    - `../../.bashrc`;
    - an ELF named `photo.png`;
    - text named `photo.png`;
    - 11 MiB;
    - an out-of-order chunk;
    - the eleventh unsent attachment;
    - the per-session total;
    - two sends naming one;
    - a failed send releasing it;
    - the sweeps;
    - a shell session refused;
    - hibernation keeping the directory;
  - `remote-conversation.test.ts`: the sentence, empty text, `text` in the answer, unknown, already sent,
    another session's, more than ten;
  - `agent-injection.test.ts`: the read rule composes with the hook contributions, and is absent when
    disabled.

  Control: drop the content check, the containment check and the sent marker in turn, and confirm red.

## 4. Paste, rename and the operation list

- [x] 4.1 `transcript-follow.ts`: a string user record that is exactly one paste (D7's shape) is projected as
      the pasted text. `transcript-follow.test.ts`:
  - the measured shape;
  - a mismatched closing id;
  - a paste after typed text, left as is;
  - a message with an absolute path delivered as written.

  `agent-events.test.ts`: an option label with a path is kept as written.
- [x] 4.2 `remote-protocol.ts`: `sessions.rename` (clean, clip to 200, empty allowed) →
      `perform({ kind: 'rename' })`. `HostAction` gains it; `remote-host.ts` passes it through with
      `NO_WINDOW`.
- [x] 4.3 `src/preload/index.ts`: `narrowRemoteAction` accepts `rename`.
      `src/renderer/src/shell/remote/RemoteRequests.tsx` calls `api.rename`, with `NOT_FOUND` for an unknown
      session.
- [x] 4.4 `remote-server.ts`: `hello` and `pair` answers carry `operations` (from `operationNames()`, without
      `hello` and `pair`).
- [x] 4.5 Unit tests: rename cleaning, empty name, and `NO_WINDOW` (`remote-protocol.test.ts`,
      `remote-host.test.ts`); `operations` in both answers (`remote-server.test.ts`).

## 5. Probes

- [x] 5.1 `scripts/lib/stub-agent.mjs`:
  - `firej <event> <json>`: a probe's command (the stub's existing control files) reports a hook event with
    any payload (`tool_input`, `agent_id`, `tool_use_id`, `background_tasks`). `probe:remote` writes event
    files directly (`fireEvent`, now named by wall-clock nanoseconds like the real hook's);
  - the per-session byte and block receipts already log every byte;
  - `pasteWrap`: a long input line recorded inside the measured paste markers.
- [x] 5.2 `scripts/probe-remote.mjs`, new sections:
  - **rename**:
    - rename from the phone: the rail label changes, the rail selection and the focused terminal do not,
      and the name survives a restart;
    - an empty name hands naming back;
    - with no window, rename is refused (unit level, `remote-protocol.test.ts`, as the existing no-window
      carrier: closing the window quits the app on Linux).
  - **attachments**:
    - a two-chunk upload, then send: the stub receives the sentence, and the named path holds the bytes;
    - an unsupported upload is refused;
    - an attachment cannot be sent twice;
    - closing the session, live or dormant, removes its directory.
  - **answer**:
    - `conversation.wait` carries the prompt for a command, for a question, and for a plan approval (its text
      and choices, no allow); `approve` reaches the stub as `2` and is confirmed when the stub reports
      `permission_mode: "default"`;
    - two open requests are not answerable, and an answer is refused;
    - a key typed on the desktop makes the prompt unanswerable;
    - `deny` reaches the stub as Esc, and a following reply is accepted;
    - a question answer reaches it as the planned keys with no `\r`, and is confirmed when the stub reports
      the answers;
    - after the stub reports another tool's `PreToolUse` and `PermissionRequest`, the old id is refused as
      gone;
    - another permission request reported between keys gives `partial`.
  - **operations** in the authentication answer.
- [x] 5.3 `scripts/probe-agent-view.mjs`:
  - a background subagent's open request keeps the conversation view's input refused across the agent's
    `Stop` and a notice submission;
  - a long reply recorded as a paste clears "not confirmed".
- [x] 5.4 `scripts/scenario-coverage.test.mjs`: add the change to `COVERED_CHANGES` and register every
      scenario with its carrier, `greenIfAbsent` and mutation. Check each probe assertion against its
      mutation once.

## 6. Documents

- [x] 6.1 `docs/remote-protocol.md`:
  - §2: that a frame over 1 MiB closes the connection;
  - §3 error codes;
  - §4 `operations`;
  - §5:
    - `sessions.rename`;
    - `attachments.put`;
    - `conversation.send`'s `attachments` and `text`;
    - `conversation.wait`'s `prompt`;
    - `conversation.answer`: keys, the checks, the outcomes, after a deny, and the case of a prompt dismissed
      with no key;
    - `terminal.input`'s note;
    - the "Everything else" sentence;
  - §9: show controls by `operations`; match a reply against `text`; convert HEIC before upload.
- [x] 6.2 `docs/lessons/transcript.md`: a section with this change's measurements:
  - prompt options per tool, the two plan prompts (with and without a plan), and `permission_mode` after a
    plan answer;
  - digit and Esc behavior, and question keys;
  - pacing;
  - `PreToolUse` awaited, `PermissionRequest` not;
  - queued prompts;
  - subagent and background events: `Stop` and notice submissions over an open prompt, the agent's own
    included; `SubagentStop`; `background_tasks`;
  - `SessionStart` `source`;
  - parallel starts' timing;
  - the read rule, and the merge;
  - paste-to-image, and the paste markers;
  - "re-measure after a CLI upgrade".
- [x] 6.3 Website, English and Traditional Chinese:
  - `docs/using/remote-access.md`: answering prompts and questions, attaching files, renaming, and that the
    phone writes files only into the attachment store;
  - `docs/using/conversation-view.md`:
    - "What it needs from Claude Code" gains the read rule;
    - the input is refused while any permission prompt is open, a background agent's included, until a key
      dismisses it;
  - `docs/reference/data-and-network.md`: the attachment store in "Where your data is stored".
- [x] 6.4 `CLAUDE.md`, the remote access paragraph: one line on answers (keys checked before each key, never
      Enter, only one open prompt) and attachments (desktop-owned store, read rule).

## 7. Verification

- [x] 7.1 `npm run typecheck`, `npm run lint`, `npm test`.
- [x] 7.2 Probes:
  - `npm run probe:remote` and `npm run probe:agent-view`;
  - `npm run probe:terminal` (it checks the injected settings);
  - `npm run probe:intake` with its control groups (the stub and the wait state changed).
