## 1. Conversation projection

- [x] 1.1 `transcript-follow.ts`: project a `queued_command` attachment as a user entry under D1's rule
      (human prompt only, text verbatim, the record's uuid and timestamp). Every other attachment yields
      nothing.
- [x] 1.2 `transcript-follow.ts`: compute a user record's `meta` with D3's rule (`isMeta`, system prompt
      source, non-human origin, compaction summary).
- [x] 1.3 `transcript-follow.test.ts` cases, built from the measured shapes:
  - a human mid-turn prompt is shown verbatim, including leading and trailing spaces;
  - task-notification, peer, missing-origin, non-string-prompt and other-subtype attachments are not shown;
  - a task-notification `user` record is meta;
  - a compaction summary is meta;
  - a typed prompt is not meta;
  - a slash-command record without origin fields is not meta.

  Control: revert each rule and confirm its case goes red.

## 2. Wait state

- [x] 2.1 `agent-events.ts`: add `UserPromptSubmit`, `PostToolUseFailure` and `StopFailure` to `HOOKED_EVENTS`.
      Map the first two to `busy` and `StopFailure` to `ready` in `nextWaitState`; `turnEnded` stays `Stop`
      only. `parseEvent` keeps `agent_id`, and a `StopFailure` carrying one maps to `unknown`. Update the hook table in the module comment.
- [x] 2.2 `agent-events.ts`: `drainEvents` takes the held pending request and carries it per D4. Every return
      path returns it, including the early returns for a missing or unreadable directory.
- [x] 2.3 `agent-wait.ts`: `tick` passes `pendingRequestOf(sessionId)`, and `foldDrain` stores what it is
      given.
- [x] 2.4 Unit tests:
  - the three new mappings, `StopFailure` not setting `turnEnded`, and a subagent's `StopFailure` (with
    `agent_id`) during awaiting-choice giving `unknown`;
  - the injection names `UserPromptSubmit`, `PostToolUseFailure` and `StopFailure` literally (not compared
    with `HOOKED_EVENTS`). Control: drop any one from `HOOKED_EVENTS` and confirm red;
  - `EVENT_COMMAND` writes nothing to stdout;
  - awaiting-choice followed by `UserPromptSubmit` is busy (recovery from a denied prompt);
  - `PermissionRequest` and `Notification` in separate drains, with an empty drain between them, keep the
    tool and argument;
  - the same pair in one batch keeps them;
  - a missing event directory keeps them;
  - a following `PermissionRequest` for another tool replaces them;
  - leaving awaiting-choice clears them;
  - `pendingRequestOf` after an empty tick still names the tool.

  Control: revert D4 and confirm red.

## 3. Remote addresses

- [x] 3.1 `remote-service.ts`: one `currentAddresses()` (interfaces + additional address) used by `state()`,
      the server's answers, and change detection. The interface reader is injectable for tests.
- [x] 3.2 `remote-server.ts`: an `addresses` option. `#authenticate` puts `addresses` in the `hello` and
      `pair` answers.
- [x] 3.3 `remote-service.ts`: on the reconcile tick, and right after `setAdditionalAddress`, send
      `addresses.changed` `{ addresses }` to every authenticated connection when the list differs from the
      last one sent. The baseline is set when the first device connects.
- [x] 3.4 Unit tests:
  - both answers carry the list, ending with the additional address;
  - a refused connection's frames carry no addresses;
  - an open socket that has not authenticated receives no frame when the list changes, while an
    authenticated one receives exactly one event;
  - an unchanged list sends no event;
  - an additional-address change sends one at once.

  Controls: drop the field and confirm red; broadcast to every socket and confirm red.

## 4. Stub agent and probes

- [x] 4.1 `scripts/lib/stub-agent.mjs`:
  - report `UserPromptSubmit` on every input line, as the real agent does;
  - new option `answerSeconds`: wait that long after the submission, then write the answer and report
    `Stop`, with no tool events;
  - new option `queuedDelivery`: for an input line, write a human `queued_command` attachment instead of
    the `user` record.
- [x] 4.2 `probe-agent-view.mjs`: a section where a text-only answer shows busy, then not busy. Control:
      remove `UserPromptSubmit` from `HOOKED_EVENTS` and confirm red.
- [x] 4.3 `probe-agent-view.mjs`, with stub `queuedDelivery`, plus a task-notification `user` record in the
      stub's transcript. Assert:
  - the sent text shows as the user's message and its "not confirmed" label clears;
  - the notice shows as context.

  Controls: revert 1.1 and confirm red; revert 1.2 and confirm red.
- [x] 4.4 `probe-remote.mjs`: seed an additional address and assert that the `hello` answer's `addresses`
      ends with it.
- [x] 4.5 Run every user of the stub in full, because 4.1 changes the stub they share:
  - `probe:agent-view`;
  - `probe:intake`, including the intake control groups that depend on busy;
  - `probe:remote`;
  - `capture:screenshots`.

## 5. Documentation

- [x] 5.1 `docs/remote-protocol.md`:
  - §1: keep the latest list along with the link's;
  - §4: `addresses` in both answers;
  - §5: define the entry's `meta`;
  - §6: rewrite the list-event rule to cover `addresses.changed` (an object, no matching operation);
  - §9: ignore unknown fields and event kinds; which addresses to keep and try first.
- [x] 5.2 `docs/lessons/transcript.md`:
  - the mid-turn record shape;
  - the origin fields and what each value means;
  - the hook timing table from design.md, including the denial, interruption, question-tool and stray
    subagent rows;
  - the "text + Enter answers an open prompt" measurement, and the instruction to re-measure
    `UserPromptSubmit` during a prompt on a CLI upgrade;
  - why `EVENT_COMMAND` must print nothing.
- [x] 5.3 Lessons and comments that say no submission event is injected:
  - `src/main/intake-prefill.ts` (the `isSubmitted` comment);
  - `docs/lessons/intake.md` (the "submitted has no event" section and its stub note);
  - `docs/lessons/handoff.md` §12.5.
- [x] 5.4 Code comments that describe the old behavior: `agent-events.ts`'s hook table and pending comment,
      and `transcript-follow.ts`'s white-list comment.
- [x] 5.5 Website, both languages:
  - `conversation-view.md`: say that sending is accepted while the agent works, matching
    `agent-input-bridge`; the page today says it is not. Also say that a message sent mid-turn appears in
    the conversation;
  - `remote-access.md`: the phone picks up the desktop's current addresses whenever it connects by any
    route.

## 6. Coverage and checks

- [x] 6.1 `scripts/scenario-coverage.test.mjs`: register `companion-test-fixes` in `COVERED_CHANGES`. Add a
      row per scenario with its carrier, `greenIfAbsent`, and its mutation.
- [x] 6.2 `npm run typecheck`, `npm run lint`, `npm test`.
