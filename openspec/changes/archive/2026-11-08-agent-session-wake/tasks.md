## 1. The wake command

- [x] 1.1 Add `wake` to `CommandKind` / `COMMAND_KINDS` and `parseCommand` (`src/main/handoff-delivery.ts`): only `target` is read, a non-string or empty target is `FIELD_TYPE`, other fields have no effect; `handoff-command.test.ts` covers each case
- [x] 1.2 Add `relativeNames(sourceId)` to `SessionControlDeps` and wire it in `src/main/index.ts` from `relationsOf(sourceId, currentRelationsWorld(...))` (parent name, sibling names, every name in the `children` tree) (design D1); a unit test of the flattening covers a nested grandchild, a `parentGone` descendant, and a closed parent (no name)
- [x] 1.3 Judge a wake in `SessionControl.deliver` (design D2, D4): own/omitted target → accepted no-op; source gone → dropped; name not in `relativeNames` but existing → `CONTROL_NOT_ALLOWED`; unknown name → `CONTROL_TARGET_NOT_FOUND`; stale → dropped; running → accepted no-op; otherwise carried out at once with no turn wait and no agent-events check. Replace the `ending` cast with a real narrowing; `npm run typecheck` green
- [x] 1.4 Carry a wake out in `#carryOut` as `{ kind: 'wake', sessionId }`, re-checking existence, staleness and "not running" after the gate; no `expectCommandEnd`, and a failed wake does **not** call `cancelCommandEnd`; a failure goes through `#fail` (`CONTROL_FAILED` / `CONTROL_NO_WINDOW`)
- [x] 1.5 Unit tests in `session-control.test.ts`: parent, sibling (parent closed too), grandchild through a closed intermediate are woken; a sibling's child and an unrelated session are refused; unknown name refused; running target and own session request nothing; agent events off still wakes; stale (process change after mtime, run start after mtime) dropped; a failed wake leaves another command's expected end in place; control groups: a `relativeNames` that returns only descendants turns the parent and sibling cases red, and calling `cancelCommandEnd` on a failed wake turns that case red
- [x] 1.6 Confirm `handoff-service.ts` routes `wake` to `control` (`isCommandKind`) and each outcome's receipt (accepted / rejected with code and permanence) in `handoff-receipt.test.ts` or the service test
- [x] 1.7 Rewrite the `CONTROL_NOT_ALLOWED` reason in `src/main/agent-protocol-copy.ts` and the inbox trace text in `en.json` / `zh-TW.json` as one neutral sentence naming both reaches (design D2); `npm test` (dictionary completeness, copy guards) green

## 2. Introduction

- [x] 2.1 Rewrite `commandLines` and the not-running sentence in `peerLines` (`src/main/handoff-intro.ts`) from design D6's draft: four commands, the two reaches, wake at once without confirmation, "running" then `ListAgents`, not waking a parent only to report, asking the user before repeating a wake that did not take; the "must not try to wake" and "until the user wakes it" sentences go; the `hasRelations === false` variant stays consistent
- [x] 2.2 Update `handoff-intro.test.ts`: replace the "must not try to wake" assertion and the `/parent,\s+(your )?siblings and any other session are refused/` assertion with ones for the new reach sentence; add assertions for the wake shape, the reachability hint, the report sentence and the repeat sentence; the 30-folder budget test stays within 8,500 (no raise); `scripts/handoff-intro-source.test.mjs` green

## 3. Acceptance

- [x] 3.1 Extend `runSessionControl` in `scripts/probe-intake.mjs`: with keyboard focus placed in the side panel's editor, the user hibernates P, the agent in C writes a wake for P → P's pty runs (`/proc`), `sessions.json` keeps P, selection, displayed session and focus unchanged, C's relations file lists P running; a wake for an unrelated session is refused with a notification naming a session command; `PROBE_ONLY` on the section green, and a control group (skipping the carry-out) turns the wake assertion red
- [x] 3.2 Register `agent-session-wake` in `COVERED_CHANGES` and add a row for each new and modified scenario in `scripts/scenario-coverage.test.mjs`, each carrier a real assertion found in the source; D5's restart-pending and canary-held cases are noted as resting on the existing `waking` dedupe and `launch-start` skip carriers, named; `npm test` green
- [x] 3.3 Run `npm run typecheck`, `npm run lint` and `npm test`, all green; then `npm run probe:intake` in full, green

## 4. Docs

- [x] 4.1 Update `CLAUDE.md`: the Hibernation paragraph ("every dormant session starts only on an explicit Wake" gains the agent's wake) and the session-commands paragraph (wake, its wider reach, no confirmation)
- [x] 4.2 Update `docs/lessons/handoff.md` "Session commands": the wake's reach is the relations file's own output (D1, and why a shared predicate was rejected), the failed-wake `cancelCommandEnd` trap, and D4's staleness consequence
- [x] 4.3 Update `openspec/specs/agent-session-control/spec.md`'s Purpose (waking a related session) and `openspec/specs/terminal-sessions/spec.md`'s Purpose ("starts one only when the user explicitly wakes it")
- [x] 4.4 Update code comments that state only the user wakes a dormant session (`sessions.tsx`, `RemoteRequests.tsx`, `session-control.ts` header); `npm run lint` green
- [x] 4.5 Update the website in both languages: `site/src/content/docs/docs/using/handoffs.md` (the "told not to wake sessions themselves" sentence, the session-command section) and `terminals-and-sessions.md` ("until you press Wake"), with their `zh-tw/` twins; `(cd site && npm ci && npm run build)` green

## 5. Dogfood

- [x] 5.1 Not done in this change (the user's decision: no dedicated test run), moved to issue #105: a child agent wakes its hibernated parent in the installed app and messages it
- [x] 5.2 Not done in this change, moved to issue #105: measure when a woken session can be messaged, and strengthen the introduction if needed
